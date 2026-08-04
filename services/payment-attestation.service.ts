import { and, desc, eq, ilike, inArray } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { getDb } from "@/db";
import { bankHoursEntries, doctors, interventionBaseDeactivations, interventionOccupancies, paymentAttestationSlotEntries, paymentAttestationSlots, regulationOccupancies, regulationPostDeactivations, users, type paymentAttestationSlotStatusEnum } from "@/db/schema";
import { syncInterventionBankHours, syncRegulationBankHours } from "@/modules/bank-hours/service";
import { listDoctorSearchTerms, mergeDoctorDirectoryMetadata } from "@/modules/doctors/directory";
import { normalizeDoctorName } from "@/modules/doctors/importer";
import { getPaymentAllocationBoard, type PaymentAllocationBoard, type PaymentAllocationRow } from "@/services/board.service";

type Executor = any;

interface DoctorPaymentMetadata {
    preferredOperationalRole?: unknown;
    paymentProfile?: {
        isSpecialist?: unknown;
    };
    employmentType?: unknown;
}

export type PaymentAttestationSlotLifecycleStatus = "preview" | "draft" | "approved";

export interface PaymentAttestationEntrySnapshot {
    id: string | null;
    slotId: string | null;
    domain: PaymentAllocationRow["domain"];
    targetCode: string;
    targetLabel: string;
    sortOrder: number;
    defaultRole: string | null;
    disabledAt: string | null;
    disabledReason: string | null;
    disabledDuringShift: boolean;
    disabledEntireShift: boolean;
    occupancyId: string | null;
    doctorId: string | null;
    doctorName: string | null;
    displayName: string | null;
    startedAt: string | null;
    endedAt: string | null;
    actualEndedAt: string | null;
    scheduledStartAt: string | null;
    scheduledEndAt: string | null;
    shiftLabel: "SD" | "SN" | "P" | null;
    roleLabel: string | null;
    ramalLabel: string | null;
    source: string | null;
    candidateCount: number;
    paymentStatus: PaymentAllocationRow["paymentStatus"];
    issues: string[];
    arrivalDelayMinutes: number | null;
    overtimeMinutes: number | null;
    creditedOvertimeMinutes: number | null;
    balanceMinutes: number | null;
    ruleCode: string | null;
    bankHoursExplanation: string | null;
}

export interface PaymentAttestationSlotSummary {
    totalTargets: number;
    readyCount: number;
    needsReviewCount: number;
    unassignedCount: number;
    disabledCount: number;
    doctorCount: number;
}

export interface PaymentAttestationSlotRecord {
    id: string | null;
    operationalDate: string;
    shiftLabel: "SD" | "SN";
    startedAt: string;
    endedAt: string;
    snapshotGeneratedAt: string;
    status: PaymentAttestationSlotLifecycleStatus;
    summary: PaymentAttestationSlotSummary;
    lastRefreshedByUserId: string | null;
    lastRefreshedByEmail: string | null;
    approvedByUserId: string | null;
    approvedByEmail: string | null;
    approvedAt: string | null;
    entries: PaymentAttestationEntrySnapshot[];
    canApprove: boolean;
    isPersisted: boolean;
}

export interface PaymentAttestationRecentSlot {
    id: string;
    operationalDate: string;
    shiftLabel: "SD" | "SN";
    startedAt: string;
    status: Extract<PaymentAttestationSlotLifecycleStatus, "draft" | "approved">;
    readyCount: number;
    needsReviewCount: number;
    unassignedCount: number;
    disabledCount: number;
    approvedAt: string | null;
}

export interface PaymentAttestationSlotView {
    slot: PaymentAttestationSlotRecord;
    recentSlots: PaymentAttestationRecentSlot[];
}

function toIso(value: Date | string | null | undefined) {
    if (!value) {
        return null;
    }

    return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function compareEntryOrder(left: PaymentAttestationEntrySnapshot, right: PaymentAttestationEntrySnapshot) {
    const leftDomainRank = left.domain === "regulation" ? 0 : 1;
    const rightDomainRank = right.domain === "regulation" ? 0 : 1;
    if (leftDomainRank !== rightDomainRank) {
        return leftDomainRank - rightDomainRank;
    }

    if (left.sortOrder !== right.sortOrder) {
        return left.sortOrder - right.sortOrder;
    }

    return left.targetCode.localeCompare(right.targetCode, "pt-BR");
}

function normalizeDoctorPaymentMetadata(value: unknown): DoctorPaymentMetadata {
    if (!value || typeof value !== "object") {
        return {};
    }

    return value as DoctorPaymentMetadata;
}

function resolveDoctorPaymentProfileFromMetadata(metadata: unknown) {
    const normalized = normalizeDoctorPaymentMetadata(metadata);
    const preferredRole = String(normalized.preferredOperationalRole ?? "").trim().toUpperCase();
    if (preferredRole === "PSIQ") {
        return "psychiatry" as const;
    }

    if (preferredRole === "PIAM") {
        return "specialist" as const;
    }

    if (normalized.paymentProfile?.isSpecialist === true) {
        return "specialist" as const;
    }

    return "generalist" as const;
}

function resolveDoctorEmploymentTypeFromMetadata(metadata: unknown) {
    const normalized = normalizeDoctorPaymentMetadata(metadata);
    const raw = String(normalized.employmentType ?? "").trim().toLowerCase();
    if (raw === "estatutario" || raw === "estatutário" || raw === "reda") {
        return "estatutario" as const;
    }

    return "pj" as const;
}

function buildSummary(entries: PaymentAttestationEntrySnapshot[]): PaymentAttestationSlotSummary {
    const payable = entries.filter((entry) => !entry.disabledEntireShift);
    const readyRows = payable.filter((entry) => entry.paymentStatus === "ready_for_payment");
    const doctorCount = new Set(readyRows.filter((entry) => entry.doctorId).map((entry) => entry.doctorId as string)).size;

    return {
        totalTargets: payable.length,
        readyCount: readyRows.length,
        needsReviewCount: payable.filter((entry) => entry.paymentStatus === "needs_review").length,
        unassignedCount: payable.filter((entry) => !entry.occupancyId).length,
        disabledCount: entries.filter((entry) => entry.disabledEntireShift).length,
        doctorCount,
    };
}

export function buildPaymentAttestationPreview(board: PaymentAllocationBoard): PaymentAttestationSlotRecord {
    const entries = [...board.regulation, ...board.intervention]
        .map((row): PaymentAttestationEntrySnapshot => ({
            id: null,
            slotId: null,
            domain: row.domain,
            targetCode: row.targetCode,
            targetLabel: row.targetLabel,
            sortOrder: row.sortOrder,
            defaultRole: row.defaultRole,
            disabledAt: row.disabledAt ?? null,
            disabledReason: row.disabledReason ?? null,
            disabledDuringShift: Boolean(row.disabledDuringShift),
            disabledEntireShift: Boolean(row.disabledEntireShift),
            occupancyId: row.occupancyId,
            doctorId: row.doctorId,
            doctorName: row.doctorName,
            displayName: row.displayName,
            startedAt: row.startedAt,
            endedAt: row.endedAt,
            actualEndedAt: row.actualEndedAt,
            scheduledStartAt: row.scheduledStartAt,
            scheduledEndAt: row.scheduledEndAt,
            shiftLabel: row.shiftLabel,
            roleLabel: row.roleLabel,
            ramalLabel: row.ramalLabel,
            source: row.source,
            candidateCount: row.candidateCount,
            paymentStatus: row.paymentStatus,
            issues: [...row.issues],
            arrivalDelayMinutes: row.arrivalDelayMinutes,
            overtimeMinutes: row.overtimeMinutes,
            creditedOvertimeMinutes: row.creditedOvertimeMinutes,
            balanceMinutes: row.balanceMinutes,
            ruleCode: row.ruleCode,
            bankHoursExplanation: row.bankHoursExplanation,
        }))
        .sort(compareEntryOrder);
    const summary = buildSummary(entries);

    return {
        id: null,
        operationalDate: board.operationalDate,
        shiftLabel: board.shiftLabel,
        startedAt: board.startedAt,
        endedAt: board.endedAt,
        snapshotGeneratedAt: board.generatedAt,
        status: "preview",
        summary,
        lastRefreshedByUserId: null,
        lastRefreshedByEmail: null,
        approvedByUserId: null,
        approvedByEmail: null,
        approvedAt: null,
        entries,
        canApprove: summary.needsReviewCount === 0,
        isPersisted: false,
    };
}

async function resolveUserEmails(db: Executor, userIds: string[]): Promise<Map<string, string | null>> {
    const uniqueIds = [...new Set(userIds.filter(Boolean))];
    if (uniqueIds.length === 0) {
        return new Map<string, string | null>();
    }

    const rows = await db.select({ id: users.id, email: users.email })
        .from(users)
        .where(inArray(users.id, uniqueIds));

    return new Map(rows.map((row: { id: string; email: string | null }) => [row.id, row.email ?? null]));
}

async function findPersistedSlot(db: Executor, operationalDate: string, shiftLabel: "SD" | "SN") {
    const [slot] = await db.select().from(paymentAttestationSlots)
        .where(and(
            eq(paymentAttestationSlots.operationalDate, new Date(operationalDate)),
            eq(paymentAttestationSlots.shiftLabel, shiftLabel),
        ))
        .limit(1);

    return slot ?? null;
}

async function loadPersistedSlotRecord(db: Executor, operationalDate: string, shiftLabel: "SD" | "SN"): Promise<PaymentAttestationSlotRecord | null> {
    const slot = await findPersistedSlot(db, operationalDate, shiftLabel);
    if (!slot) {
        return null;
    }

    const entryRows = await db.select().from(paymentAttestationSlotEntries)
        .where(eq(paymentAttestationSlotEntries.slotId, slot.id));
    const emailByUserId = await resolveUserEmails(db, [slot.lastRefreshedByUserId, slot.approvedByUserId].filter(Boolean) as string[]);
    const entries = (entryRows as Array<typeof paymentAttestationSlotEntries.$inferSelect>).map((entry) => ({
        id: entry.id,
        slotId: entry.slotId,
        domain: entry.domain === "regulation" ? "regulation" : "intervention",
        targetCode: entry.targetCode,
        targetLabel: entry.targetLabel,
        sortOrder: entry.sortOrder,
        defaultRole: entry.defaultRole,
        disabledAt: toIso(entry.disabledAt),
        disabledReason: entry.disabledReason,
        disabledDuringShift: entry.disabledDuringShift,
        disabledEntireShift: entry.disabledEntireShift,
        occupancyId: entry.occupancyId,
        doctorId: entry.doctorId,
        doctorName: entry.doctorName,
        displayName: entry.displayName,
        startedAt: toIso(entry.startedAt),
        endedAt: toIso(entry.endedAt),
        actualEndedAt: toIso(entry.actualEndedAt),
        scheduledStartAt: toIso(entry.scheduledStartAt),
        scheduledEndAt: toIso(entry.scheduledEndAt),
        shiftLabel: entry.shiftLabel === "SD" || entry.shiftLabel === "SN" || entry.shiftLabel === "P" ? entry.shiftLabel : null,
        roleLabel: entry.roleLabel,
        ramalLabel: entry.ramalLabel,
        source: entry.source,
        candidateCount: entry.candidateCount,
        paymentStatus: entry.paymentStatus === "ready_for_payment" ? "ready_for_payment" : "needs_review",
        issues: Array.isArray(entry.issues) ? entry.issues.filter((issue): issue is string => typeof issue === "string") : [],
        arrivalDelayMinutes: entry.arrivalDelayMinutes,
        overtimeMinutes: entry.overtimeMinutes,
        creditedOvertimeMinutes: entry.creditedOvertimeMinutes,
        balanceMinutes: entry.balanceMinutes,
        ruleCode: entry.ruleCode,
        bankHoursExplanation: entry.bankHoursExplanation,
    } satisfies PaymentAttestationEntrySnapshot)).sort(compareEntryOrder);
    const summary = {
        totalTargets: slot.totalTargets,
        readyCount: slot.readyCount,
        needsReviewCount: slot.needsReviewCount,
        unassignedCount: slot.unassignedCount,
        disabledCount: slot.disabledCount,
        doctorCount: buildSummary(entries).doctorCount,
    } satisfies PaymentAttestationSlotSummary;

    return {
        id: slot.id,
        operationalDate: toIso(slot.operationalDate) as string,
        shiftLabel: slot.shiftLabel === "SN" ? "SN" : "SD",
        startedAt: toIso(slot.startedAt) as string,
        endedAt: toIso(slot.endedAt) as string,
        snapshotGeneratedAt: toIso(slot.snapshotGeneratedAt) as string,
        status: slot.status as PaymentAttestationSlotLifecycleStatus,
        summary,
        lastRefreshedByUserId: slot.lastRefreshedByUserId,
        lastRefreshedByEmail: slot.lastRefreshedByUserId ? emailByUserId.get(slot.lastRefreshedByUserId) ?? null : null,
        approvedByUserId: slot.approvedByUserId,
        approvedByEmail: slot.approvedByUserId ? emailByUserId.get(slot.approvedByUserId) ?? null : null,
        approvedAt: toIso(slot.approvedAt),
        entries,
        canApprove: slot.status !== "approved" && summary.needsReviewCount === 0,
        isPersisted: true,
    };
}

export async function listRecentPaymentAttestationSlots(limit = 14): Promise<PaymentAttestationRecentSlot[]> {
    const rows = await getDb().select().from(paymentAttestationSlots)
        .orderBy(desc(paymentAttestationSlots.startedAt), desc(paymentAttestationSlots.createdAt))
        .limit(limit);

    return (rows as Array<typeof paymentAttestationSlots.$inferSelect>).map((row) => ({
        id: row.id,
        operationalDate: toIso(row.operationalDate) as string,
        shiftLabel: row.shiftLabel === "SN" ? "SN" : "SD",
        startedAt: toIso(row.startedAt) as string,
        status: row.status as Extract<PaymentAttestationSlotLifecycleStatus, "draft" | "approved">,
        readyCount: row.readyCount,
        needsReviewCount: row.needsReviewCount,
        unassignedCount: row.unassignedCount,
        disabledCount: row.disabledCount,
        approvedAt: toIso(row.approvedAt),
    }));
}

export async function getPaymentAttestationSlotView(params?: {
    operationalDate?: string | null;
    shiftLabel?: "SD" | "SN" | null;
    limit?: number;
}) : Promise<PaymentAttestationSlotView> {
    const board = await getPaymentAllocationBoard({
        operationalDate: params?.operationalDate ?? null,
        shiftLabel: params?.shiftLabel ?? null,
    });
    const db = getDb();
    const persisted = await loadPersistedSlotRecord(db, board.operationalDate, board.shiftLabel);
    const recentSlots = await listRecentPaymentAttestationSlots(params?.limit ?? 14);

    return {
        slot: persisted ?? buildPaymentAttestationPreview(board),
        recentSlots,
    };
}

async function savePreviewAsDraft(db: Executor, preview: PaymentAttestationSlotRecord, actorUserId: string) {
    const existing = await findPersistedSlot(db, preview.operationalDate, preview.shiftLabel);
    if (existing?.status === "approved") {
        throw new Error("Este fechamento já foi aprovado. Reabra o slot antes de atualizar o snapshot.");
    }

    const [slot] = existing
        ? await db.update(paymentAttestationSlots)
            .set({
                startedAt: new Date(preview.startedAt),
                endedAt: new Date(preview.endedAt),
                snapshotGeneratedAt: new Date(preview.snapshotGeneratedAt),
                status: "draft",
                totalTargets: preview.summary.totalTargets,
                readyCount: preview.summary.readyCount,
                needsReviewCount: preview.summary.needsReviewCount,
                unassignedCount: preview.summary.unassignedCount,
                disabledCount: preview.summary.disabledCount,
                lastRefreshedByUserId: actorUserId,
                approvedByUserId: null,
                approvedAt: null,
                updatedAt: new Date(),
            })
            .where(eq(paymentAttestationSlots.id, existing.id))
            .returning()
        : await db.insert(paymentAttestationSlots)
            .values({
                operationalDate: new Date(preview.operationalDate),
                shiftLabel: preview.shiftLabel,
                startedAt: new Date(preview.startedAt),
                endedAt: new Date(preview.endedAt),
                snapshotGeneratedAt: new Date(preview.snapshotGeneratedAt),
                status: "draft",
                totalTargets: preview.summary.totalTargets,
                readyCount: preview.summary.readyCount,
                needsReviewCount: preview.summary.needsReviewCount,
                unassignedCount: preview.summary.unassignedCount,
                disabledCount: preview.summary.disabledCount,
                lastRefreshedByUserId: actorUserId,
                approvedByUserId: null,
                approvedAt: null,
            })
            .returning();

    await db.delete(paymentAttestationSlotEntries).where(eq(paymentAttestationSlotEntries.slotId, slot.id));

    if (preview.entries.length > 0) {
        await db.insert(paymentAttestationSlotEntries).values(preview.entries.map((entry) => ({
            slotId: slot.id,
            domain: entry.domain,
            targetCode: entry.targetCode,
            targetLabel: entry.targetLabel,
            sortOrder: entry.sortOrder,
            defaultRole: entry.defaultRole,
            disabledAt: entry.disabledAt ? new Date(entry.disabledAt) : null,
            disabledReason: entry.disabledReason,
            disabledDuringShift: entry.disabledDuringShift,
            disabledEntireShift: entry.disabledEntireShift,
            occupancyId: entry.occupancyId,
            doctorId: entry.doctorId,
            doctorName: entry.doctorName,
            displayName: entry.displayName,
            startedAt: entry.startedAt ? new Date(entry.startedAt) : null,
            endedAt: entry.endedAt ? new Date(entry.endedAt) : null,
            actualEndedAt: entry.actualEndedAt ? new Date(entry.actualEndedAt) : null,
            scheduledStartAt: entry.scheduledStartAt ? new Date(entry.scheduledStartAt) : null,
            scheduledEndAt: entry.scheduledEndAt ? new Date(entry.scheduledEndAt) : null,
            shiftLabel: entry.shiftLabel,
            roleLabel: entry.roleLabel,
            ramalLabel: entry.ramalLabel,
            source: entry.source === "manual" || entry.source === "telegram" || entry.source === "import" || entry.source === "admin_correction" ? entry.source : null,
            candidateCount: entry.candidateCount,
            paymentStatus: entry.paymentStatus,
            issues: entry.issues,
            arrivalDelayMinutes: entry.arrivalDelayMinutes,
            overtimeMinutes: entry.overtimeMinutes,
            creditedOvertimeMinutes: entry.creditedOvertimeMinutes,
            balanceMinutes: entry.balanceMinutes,
            ruleCode: entry.ruleCode,
            bankHoursExplanation: entry.bankHoursExplanation,
        })));
    }

    return loadPersistedSlotRecord(db, preview.operationalDate, preview.shiftLabel);
}

export async function refreshPaymentAttestationSlot(params: {
    operationalDate?: string | null;
    shiftLabel?: "SD" | "SN" | null;
    actorUserId: string;
}) {
    const board = await getPaymentAllocationBoard({
        operationalDate: params.operationalDate ?? null,
        shiftLabel: params.shiftLabel ?? null,
    });
    const preview = buildPaymentAttestationPreview(board);
    const db = getDb();

    const saved = await db.transaction(async (tx) => savePreviewAsDraft(tx, preview, params.actorUserId));
    if (!saved) {
        throw new Error("Nao foi possivel persistir o snapshot do fechamento.");
    }

    return saved;
}

export async function approvePaymentAttestationSlot(params: {
    operationalDate?: string | null;
    shiftLabel?: "SD" | "SN" | null;
    actorUserId: string;
}) {
    const board = await getPaymentAllocationBoard({
        operationalDate: params.operationalDate ?? null,
        shiftLabel: params.shiftLabel ?? null,
    });
    const db = getDb();
    let slot = await loadPersistedSlotRecord(db, board.operationalDate, board.shiftLabel);
    if (!slot) {
        slot = await refreshPaymentAttestationSlot({
            operationalDate: board.operationalDate,
            shiftLabel: board.shiftLabel,
            actorUserId: params.actorUserId,
        });
    }

    if (slot.status === "approved") {
        return slot;
    }

    if (slot.summary.needsReviewCount > 0) {
        throw new Error("Este fechamento ainda tem pendencias. Corrija os alvos em revisao antes de aprovar.");
    }

    await db.update(paymentAttestationSlots)
        .set({
            status: "approved",
            approvedByUserId: params.actorUserId,
            approvedAt: new Date(),
            updatedAt: new Date(),
        })
        .where(eq(paymentAttestationSlots.id, slot.id as string));

    const approved = await loadPersistedSlotRecord(db, board.operationalDate, board.shiftLabel);
    if (!approved) {
        throw new Error("Nao foi possivel recarregar o fechamento aprovado.");
    }

    return approved;
}

export async function reopenPaymentAttestationSlot(params: {
    operationalDate?: string | null;
    shiftLabel?: "SD" | "SN" | null;
}) {
    const board = await getPaymentAllocationBoard({
        operationalDate: params.operationalDate ?? null,
        shiftLabel: params.shiftLabel ?? null,
    });
    const db = getDb();
    const slot = await loadPersistedSlotRecord(db, board.operationalDate, board.shiftLabel);
    if (!slot?.id || slot.status !== "approved") {
        throw new Error("Nao existe fechamento aprovado para reabrir neste slot.");
    }

    await db.update(paymentAttestationSlots)
        .set({
            status: "draft",
            approvedByUserId: null,
            approvedAt: null,
            updatedAt: new Date(),
        })
        .where(eq(paymentAttestationSlots.id, slot.id));

    const reopened = await loadPersistedSlotRecord(db, board.operationalDate, board.shiftLabel);
    if (!reopened) {
        throw new Error("Nao foi possivel recarregar o fechamento reaberto.");
    }

    return reopened;
}

function scoreDoctorMatch(lookup: string, doctor: {
    fullName: string;
    displayName: string | null;
    normalizedName: string;
    metadata: unknown;
}) {
    const normalizedLookup = normalizeDoctorName(lookup);
    if (!normalizedLookup) {
        return -1;
    }

    const tokens = normalizedLookup.split(/\s+/).filter(Boolean);
    const terms = listDoctorSearchTerms(doctor)
        .map((term) => normalizeDoctorName(term))
        .filter((term): term is string => Boolean(term));

    const exact = terms.includes(normalizedLookup) || normalizedLookup === doctor.normalizedName;
    const tokenHits = terms.reduce((best, term) => {
        const hits = tokens.filter((token) => term.includes(token)).length;
        return Math.max(best, hits);
    }, 0);

    if (exact) {
        return 100 + tokenHits;
    }

    if (tokenHits === tokens.length && tokenHits > 0) {
        return 10 + tokenHits;
    }

    return -1;
}

async function resolveDoctorForManualCorrection(lookup: string) {
    const normalizedLookup = normalizeDoctorName(lookup);
    if (!normalizedLookup) {
        throw new Error("Nome do medico invalido para correção manual.");
    }

    const candidates = await getDb().query.doctors.findMany({
        where: eq(doctors.isActive, true),
        columns: {
            id: true,
            fullName: true,
            displayName: true,
            normalizedName: true,
            metadata: true,
        },
    });

    const ranked = candidates
        .map((doctor) => ({ doctor, score: scoreDoctorMatch(lookup, doctor) }))
        .filter((item) => item.score >= 0)
        .sort((left, right) => right.score - left.score || left.doctor.fullName.localeCompare(right.doctor.fullName, "pt-BR"));

    if (ranked.length === 0) {
        throw new Error(`Nenhum medico ativo encontrado para \"${lookup}\".`);
    }

    const topScore = ranked[0]?.score ?? -1;
    const top = ranked.filter((item) => item.score === topScore);
    if (top.length > 1) {
        const options = top.slice(0, 5).map((item) => item.doctor.fullName).join(", ");
        throw new Error(`Nome ambiguo. Escolha mais específica. Candidatos: ${options}.`);
    }

    return ranked[0]!.doctor;
}

export async function applyManualPaymentAttestationCorrection(params: {
    operationalDate: string;
    shiftLabel: "SD" | "SN";
    domain: "regulation" | "intervention";
    targetCode: string;
    doctorName: string;
    actorUserId: string;
}) {
    const date = params.operationalDate.trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        throw new Error("Data operacional invalida.");
    }

    const targetCode = params.targetCode.trim().toUpperCase();
    const manualDoctorName = params.doctorName.trim();
    if (!targetCode) {
        throw new Error("Target invalido para correção manual.");
    }

    if (manualDoctorName.length < 3) {
        throw new Error("Informe pelo menos 3 caracteres no nome do medico.");
    }

    const doctor = await resolveDoctorForManualCorrection(manualDoctorName);
    const board = await getPaymentAllocationBoard({
        operationalDate: date,
        shiftLabel: params.shiftLabel,
    });
    const db = getDb();

    const persisted = await loadPersistedSlotRecord(db, board.operationalDate, board.shiftLabel);
    const slot = persisted
        ?? await refreshPaymentAttestationSlot({
            operationalDate: date,
            shiftLabel: params.shiftLabel,
            actorUserId: params.actorUserId,
        });

    if (!slot.id) {
        throw new Error("Nao foi possivel criar snapshot para aplicar correção manual.");
    }
    const slotId = slot.id;

    if (slot.status === "approved") {
        throw new Error("Este fechamento esta aprovado. Reabra o slot antes de aplicar correções manuais.");
    }

    const currentEntry = slot.entries.find((entry) => entry.domain === params.domain && entry.targetCode === targetCode);
    if (!currentEntry) {
        throw new Error(`Alvo ${targetCode} nao encontrado no snapshot deste slot.`);
    }

    // Find postId/baseId from the payment allocation board so we can create a real occupancy
    const boardRow = [...board.regulation, ...board.intervention].find(
        (row) => row.domain === params.domain && row.targetCode === targetCode,
    );
    const targetId = boardRow?.targetId ? Number(boardRow.targetId) : null;

    const shiftStart = new Date(board.startedAt);
    const shiftEnd = new Date(board.endedAt);
    const newOccupancyId = randomUUID();
    const newContinuityGroupId = randomUUID();

    const manualDisableNotePrefix = `Desativacao manual via fechamento de pagamento (${targetCode} ${slot.shiftLabel} ${slot.operationalDate.slice(0, 10)})`;

    await db.transaction(async (tx) => {
        // Apaga desativacoes manuais previas para o mesmo slot — o admin acabou de
        // afirmar que ha um medico aqui, entao a desativacao foi um erro de fluxo.
        // Apenas removemos os registros criados pela mesma UI (mesmo target+turno+data
        // no notes). Outras fontes (telegram /desativar) sao preservadas.
        if (targetId) {
            if (params.domain === "regulation") {
                await tx.delete(regulationPostDeactivations)
                    .where(and(
                        eq(regulationPostDeactivations.postId, targetId),
                        ilike(regulationPostDeactivations.notes, `${manualDisableNotePrefix}%`),
                    ));
            } else {
                await tx.delete(interventionBaseDeactivations)
                    .where(and(
                        eq(interventionBaseDeactivations.baseId, targetId),
                        ilike(interventionBaseDeactivations.notes, `${manualDisableNotePrefix}%`),
                    ));
            }
        }

        // Idempotencia: cada manual_assign no fechamento eh autoritativo. Apaga
        // qualquer ocupacao admin_correction/manual previa para o mesmo (target, slot)
        // — independente do medico — antes de criar a nova. Sem isso, multiplos cliques
        // (ou substituicao de medico) viram duplicatas no banco.
        if (targetId) {
            if (params.domain === "regulation") {
                const priorRows = await tx.select({ id: regulationOccupancies.id })
                    .from(regulationOccupancies)
                    .where(and(
                        eq(regulationOccupancies.postId, targetId),
                        eq(regulationOccupancies.startedAt, shiftStart),
                        eq(regulationOccupancies.shiftLabel, params.shiftLabel),
                        inArray(regulationOccupancies.source, ["admin_correction", "manual"]),
                    ));
                const priorIds = priorRows.map((row: { id: string }) => row.id);
                if (priorIds.length > 0) {
                    await tx.delete(bankHoursEntries)
                        .where(inArray(bankHoursEntries.regulationOccupancyId, priorIds));
                    await tx.delete(regulationOccupancies)
                        .where(inArray(regulationOccupancies.id, priorIds));
                }
            } else {
                const priorRows = await tx.select({ id: interventionOccupancies.id })
                    .from(interventionOccupancies)
                    .where(and(
                        eq(interventionOccupancies.baseId, targetId),
                        eq(interventionOccupancies.startedAt, shiftStart),
                        eq(interventionOccupancies.shiftLabel, params.shiftLabel),
                        inArray(interventionOccupancies.source, ["admin_correction", "manual"]),
                    ));
                const priorIds = priorRows.map((row: { id: string }) => row.id);
                if (priorIds.length > 0) {
                    await tx.delete(bankHoursEntries)
                        .where(inArray(bankHoursEntries.interventionOccupancyId, priorIds));
                    await tx.delete(interventionOccupancies)
                        .where(inArray(interventionOccupancies.id, priorIds));
                }
            }
        }

        // Create a real occupancy record (backfill) so bank hours are computed correctly
        if (targetId) {
            if (params.domain === "regulation") {
                await tx.insert(regulationOccupancies).values({
                    id: newOccupancyId,
                    doctorId: doctor.id,
                    postId: targetId,
                    continuityGroupId: newContinuityGroupId,
                    startedAt: shiftStart,
                    boardStartedAt: shiftStart,
                    endedAt: shiftEnd,
                    actualEndedAt: shiftEnd,
                    scheduledStartAt: shiftStart,
                    scheduledEndAt: shiftEnd,
                    shiftLabel: params.shiftLabel,
                    source: "admin_correction",
                    notes: `Correcao retroativa via fechamento de pagamento: ${targetCode} → ${doctor.fullName}`,
                    createdByUserId: params.actorUserId,
                });
                await syncRegulationBankHours(tx, newOccupancyId);
            } else {
                await tx.insert(interventionOccupancies).values({
                    id: newOccupancyId,
                    doctorId: doctor.id,
                    baseId: targetId,
                    continuityGroupId: newContinuityGroupId,
                    startedAt: shiftStart,
                    boardStartedAt: shiftStart,
                    endedAt: shiftEnd,
                    actualEndedAt: shiftEnd,
                    scheduledStartAt: shiftStart,
                    scheduledEndAt: shiftEnd,
                    shiftLabel: params.shiftLabel,
                    source: "admin_correction",
                    notes: `Correcao retroativa via fechamento de pagamento: ${targetCode} → ${doctor.fullName}`,
                    createdByUserId: params.actorUserId,
                });
                await syncInterventionBankHours(tx, newOccupancyId);
            }
        }

        await tx.update(paymentAttestationSlotEntries)
            .set({
                disabledAt: null,
                disabledReason: null,
                disabledDuringShift: false,
                disabledEntireShift: false,
                occupancyId: targetId ? newOccupancyId : (currentEntry.occupancyId ?? randomUUID()),
                doctorId: doctor.id,
                doctorName: doctor.fullName,
                displayName: doctor.displayName,
                startedAt: shiftStart,
                endedAt: shiftEnd,
                actualEndedAt: shiftEnd,
                scheduledStartAt: shiftStart,
                scheduledEndAt: shiftEnd,
                shiftLabel: slot.shiftLabel,
                source: "admin_correction",
                paymentStatus: "ready_for_payment",
                candidateCount: Math.max(currentEntry.candidateCount, 1),
                issues: [`Correcao manual: ${params.domain === "regulation" ? "ramal" : "base"} ${targetCode} atribuida para ${doctor.fullName}.`],
            })
            .where(and(
                eq(paymentAttestationSlotEntries.slotId, slotId),
                eq(paymentAttestationSlotEntries.domain, params.domain),
                eq(paymentAttestationSlotEntries.targetCode, targetCode),
            ));

        const updatedRows = await tx.select().from(paymentAttestationSlotEntries)
            .where(eq(paymentAttestationSlotEntries.slotId, slotId));

        const updatedEntries = (updatedRows as Array<typeof paymentAttestationSlotEntries.$inferSelect>).map((entry) => ({
            id: entry.id,
            slotId: entry.slotId,
            domain: entry.domain === "regulation" ? "regulation" : "intervention",
            targetCode: entry.targetCode,
            targetLabel: entry.targetLabel,
            sortOrder: entry.sortOrder,
            defaultRole: entry.defaultRole,
            disabledAt: toIso(entry.disabledAt),
            disabledReason: entry.disabledReason,
            disabledDuringShift: entry.disabledDuringShift,
            disabledEntireShift: entry.disabledEntireShift,
            occupancyId: entry.occupancyId,
            doctorId: entry.doctorId,
            doctorName: entry.doctorName,
            displayName: entry.displayName,
            startedAt: toIso(entry.startedAt),
            endedAt: toIso(entry.endedAt),
            actualEndedAt: toIso(entry.actualEndedAt),
            scheduledStartAt: toIso(entry.scheduledStartAt),
            scheduledEndAt: toIso(entry.scheduledEndAt),
            shiftLabel: entry.shiftLabel === "SD" || entry.shiftLabel === "SN" || entry.shiftLabel === "P" ? entry.shiftLabel : null,
            roleLabel: entry.roleLabel,
            ramalLabel: entry.ramalLabel,
            source: entry.source,
            candidateCount: entry.candidateCount,
            paymentStatus: entry.paymentStatus === "ready_for_payment" ? "ready_for_payment" : "needs_review",
            issues: Array.isArray(entry.issues) ? entry.issues.filter((issue): issue is string => typeof issue === "string") : [],
            arrivalDelayMinutes: entry.arrivalDelayMinutes,
            overtimeMinutes: entry.overtimeMinutes,
            creditedOvertimeMinutes: entry.creditedOvertimeMinutes,
            balanceMinutes: entry.balanceMinutes,
            ruleCode: entry.ruleCode,
            bankHoursExplanation: entry.bankHoursExplanation,
        } satisfies PaymentAttestationEntrySnapshot));

        const summary = buildSummary(updatedEntries);
        await tx.update(paymentAttestationSlots)
            .set({
                totalTargets: summary.totalTargets,
                readyCount: summary.readyCount,
                needsReviewCount: summary.needsReviewCount,
                unassignedCount: summary.unassignedCount,
                disabledCount: summary.disabledCount,
                lastRefreshedByUserId: params.actorUserId,
                updatedAt: new Date(),
            })
                .where(eq(paymentAttestationSlots.id, slotId));
    });

    const updated = await loadPersistedSlotRecord(db, slot.operationalDate, slot.shiftLabel);
    if (!updated) {
        throw new Error("Nao foi possivel recarregar o fechamento apos correção manual.");
    }

    return updated;
}

export async function applyManualDisableCorrection(params: {
    operationalDate: string;
    shiftLabel: "SD" | "SN";
    domain: "regulation" | "intervention";
    targetCode: string;
    disabledReason: string;
    actorUserId: string;
}) {
    const date = params.operationalDate.trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        throw new Error("Data operacional invalida.");
    }

    const targetCode = params.targetCode.trim().toUpperCase();
    if (!targetCode) {
        throw new Error("Target invalido para desativação manual.");
    }

    const reason = params.disabledReason.trim();
    if (reason.length < 3) {
        throw new Error("Informe motivo da desativação (minimo 3 caracteres).");
    }

    const board = await getPaymentAllocationBoard({
        operationalDate: date,
        shiftLabel: params.shiftLabel,
    });
    const db = getDb();

    const persisted = await loadPersistedSlotRecord(db, board.operationalDate, board.shiftLabel);
    const slot = persisted
        ?? await refreshPaymentAttestationSlot({
            operationalDate: date,
            shiftLabel: params.shiftLabel,
            actorUserId: params.actorUserId,
        });

    if (!slot.id) {
        throw new Error("Nao foi possivel criar snapshot para aplicar desativação manual.");
    }
    const slotId = slot.id;

    if (slot.status === "approved") {
        throw new Error("Este fechamento esta aprovado. Reabra o slot antes de aplicar correções manuais.");
    }

    const currentEntry = slot.entries.find((entry) => entry.domain === params.domain && entry.targetCode === targetCode);
    if (!currentEntry) {
        throw new Error(`Alvo ${targetCode} nao encontrado no snapshot deste slot.`);
    }

    const boardRow = [...board.regulation, ...board.intervention].find(
        (row) => row.domain === params.domain && row.targetCode === targetCode,
    );
    const targetId = boardRow?.targetId ? Number(boardRow.targetId) : null;
    const shiftStart = new Date(board.startedAt);
    const shiftEnd = new Date(board.endedAt);

    const now = new Date();
    const manualDisableNotePrefix = `Desativacao manual via fechamento de pagamento (${targetCode} ${slot.shiftLabel} ${slot.operationalDate.slice(0, 10)})`;
    await db.transaction(async (tx) => {
        if (targetId) {
            // Idempotencia: substitui qualquer desativacao manual previa para o mesmo
            // (target, turno, data) por uma unica entrada nova. Multiplos cliques nao
            // viram entradas duplicadas. Outras fontes (telegram /desativar) sao mantidas.
            if (params.domain === "regulation") {
                await tx.delete(regulationPostDeactivations)
                    .where(and(
                        eq(regulationPostDeactivations.postId, targetId),
                        ilike(regulationPostDeactivations.notes, `${manualDisableNotePrefix}%`),
                    ));
                await tx.insert(regulationPostDeactivations).values({
                    postId: targetId,
                    deactivatedAt: shiftStart,
                    reactivatedAt: shiftEnd,
                    notes: `${manualDisableNotePrefix}: ${reason}`,
                    createdByUserId: params.actorUserId,
                    updatedByUserId: params.actorUserId,
                });
            } else {
                await tx.delete(interventionBaseDeactivations)
                    .where(and(
                        eq(interventionBaseDeactivations.baseId, targetId),
                        ilike(interventionBaseDeactivations.notes, `${manualDisableNotePrefix}%`),
                    ));
                await tx.insert(interventionBaseDeactivations).values({
                    baseId: targetId,
                    deactivatedAt: shiftStart,
                    reactivatedAt: shiftEnd,
                    notes: `${manualDisableNotePrefix}: ${reason}`,
                    createdByUserId: params.actorUserId,
                    updatedByUserId: params.actorUserId,
                });
            }
        }

        await tx.update(paymentAttestationSlotEntries)
            .set({
                disabledAt: now,
                disabledReason: reason,
                disabledDuringShift: true,
                disabledEntireShift: true,
                occupancyId: null,
                doctorId: null,
                doctorName: null,
                displayName: null,
                source: "admin_correction",
                paymentStatus: "needs_review",
                issues: [`Desativacao manual: ${params.domain === "regulation" ? "ramal" : "base"} ${targetCode} marcada como desativada. Motivo: ${reason}`],
            })
            .where(and(
                eq(paymentAttestationSlotEntries.slotId, slotId),
                eq(paymentAttestationSlotEntries.domain, params.domain),
                eq(paymentAttestationSlotEntries.targetCode, targetCode),
            ));

        const updatedRows = await tx.select().from(paymentAttestationSlotEntries)
            .where(eq(paymentAttestationSlotEntries.slotId, slotId));

        const updatedEntries = (updatedRows as Array<typeof paymentAttestationSlotEntries.$inferSelect>).map((entry) => ({
            id: entry.id,
            slotId: entry.slotId,
            domain: entry.domain === "regulation" ? "regulation" : "intervention",
            targetCode: entry.targetCode,
            targetLabel: entry.targetLabel,
            sortOrder: entry.sortOrder,
            defaultRole: entry.defaultRole,
            disabledAt: toIso(entry.disabledAt),
            disabledReason: entry.disabledReason,
            disabledDuringShift: entry.disabledDuringShift,
            disabledEntireShift: entry.disabledEntireShift,
            occupancyId: entry.occupancyId,
            doctorId: entry.doctorId,
            doctorName: entry.doctorName,
            displayName: entry.displayName,
            startedAt: toIso(entry.startedAt),
            endedAt: toIso(entry.endedAt),
            actualEndedAt: toIso(entry.actualEndedAt),
            scheduledStartAt: toIso(entry.scheduledStartAt),
            scheduledEndAt: toIso(entry.scheduledEndAt),
            shiftLabel: entry.shiftLabel === "SD" || entry.shiftLabel === "SN" || entry.shiftLabel === "P" ? entry.shiftLabel : null,
            roleLabel: entry.roleLabel,
            ramalLabel: entry.ramalLabel,
            source: entry.source,
            candidateCount: entry.candidateCount,
            paymentStatus: entry.paymentStatus === "ready_for_payment" ? "ready_for_payment" : "needs_review",
            issues: Array.isArray(entry.issues) ? entry.issues.filter((issue): issue is string => typeof issue === "string") : [],
            arrivalDelayMinutes: entry.arrivalDelayMinutes,
            overtimeMinutes: entry.overtimeMinutes,
            creditedOvertimeMinutes: entry.creditedOvertimeMinutes,
            balanceMinutes: entry.balanceMinutes,
            ruleCode: entry.ruleCode,
            bankHoursExplanation: entry.bankHoursExplanation,
        } satisfies PaymentAttestationEntrySnapshot));

        const summary = buildSummary(updatedEntries);
        await tx.update(paymentAttestationSlots)
            .set({
                totalTargets: summary.totalTargets,
                readyCount: summary.readyCount,
                needsReviewCount: summary.needsReviewCount,
                unassignedCount: summary.unassignedCount,
                disabledCount: summary.disabledCount,
                lastRefreshedByUserId: params.actorUserId,
                updatedAt: new Date(),
            })
            .where(eq(paymentAttestationSlots.id, slotId));
    });

    const updated = await loadPersistedSlotRecord(db, slot.operationalDate, slot.shiftLabel);
    if (!updated) {
        throw new Error("Nao foi possivel recarregar o fechamento apos desativação manual.");
    }

    return updated;
}

export async function applyManualRemoveAssignment(params: {
    operationalDate: string;
    shiftLabel: "SD" | "SN";
    domain: "regulation" | "intervention";
    targetCode: string;
    occupancyId?: string | null;
    actorUserId: string;
}) {
    const date = params.operationalDate.trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        throw new Error("Data operacional invalida.");
    }

    const targetCode = params.targetCode.trim().toUpperCase();
    if (!targetCode) {
        throw new Error("Target invalido para remocao.");
    }

    const board = await getPaymentAllocationBoard({
        operationalDate: date,
        shiftLabel: params.shiftLabel,
    });
    const boardRow = [...board.regulation, ...board.intervention].find(
        (row) => row.domain === params.domain && row.targetCode === targetCode,
    );
    if (!boardRow || !boardRow.occupancyId) {
        throw new Error(`Nenhuma alocação ativa para ${targetCode} ${params.shiftLabel} em ${date}.`);
    }

    const occupancyIdToRemove = params.occupancyId ?? boardRow.occupancyId;
    if (params.occupancyId && params.occupancyId !== boardRow.occupancyId) {
        // The board may have shifted between the user's click and this call; trust the
        // boardRow as the current source of truth.
    }

    const slotStart = new Date(board.startedAt);
    const db = getDb();

    /**
     * Remover UM slot não pode apagar os outros que a mesma ocupação cobre.
     *
     * Antes, a remoção zerava a ocupação (endedAt = actualEndedAt = startedAt) para
     * garantir que o plantão não fosse recapturado em outro turno. Numa ocupação de
     * 24h que cobre SD e SN, remover o SN levava o SD junto — plantão real sumindo do
     * pagamento (caso Uenderson 05/07/2026 1363: fez 07:03→19:13, e ao remover o SN
     * fantasma perdeu o SD que trabalhou).
     *
     * Quando o médico trabalhou ANTES do slot removido, a ocupação é recortada até o
     * início desse slot: os turnos anteriores continuam pagos e o slot removido deixa
     * de ser coberto. Só quando não sobra nada antes do slot é que a ocupação é zerada,
     * como antes.
     */
    function resolveRemovalEnd(existing: { startedAt: Date; endedAt: Date | null; actualEndedAt: Date | null }) {
        const workedBeforeSlot = existing.startedAt.getTime() < slotStart.getTime();
        if (!workedBeforeSlot) {
            return { endedAt: existing.startedAt, actualEndedAt: existing.startedAt, clearedWholeOccupancy: true };
        }

        const effectiveEnd = existing.actualEndedAt ?? existing.endedAt;
        const trimmedEnd = effectiveEnd && effectiveEnd.getTime() < slotStart.getTime()
            ? effectiveEnd
            : slotStart;
        return { endedAt: trimmedEnd, actualEndedAt: trimmedEnd, clearedWholeOccupancy: false };
    }

    await db.transaction(async (tx) => {
        if (params.domain === "regulation") {
            const [existing] = await tx.select().from(regulationOccupancies)
                .where(eq(regulationOccupancies.id, occupancyIdToRemove))
                .limit(1);
            if (!existing) {
                throw new Error("Ocupação não encontrada para remoção.");
            }
            if (existing.source === "admin_correction" || existing.source === "manual") {
                await tx.delete(bankHoursEntries)
                    .where(eq(bankHoursEntries.regulationOccupancyId, existing.id));
                await tx.delete(regulationOccupancies)
                    .where(eq(regulationOccupancies.id, existing.id));
            } else {
                const removal = resolveRemovalEnd(existing);
                await tx.update(regulationOccupancies)
                    .set({
                        endedAt: removal.endedAt,
                        actualEndedAt: removal.actualEndedAt,
                        scheduledEndAt: removal.clearedWholeOccupancy ? existing.scheduledEndAt : slotStart,
                        notes: `${existing.notes ?? ""}\n[chefia] Remocao via fechamento de pagamento (${slotStart.toISOString()})`.trim(),
                        updatedByUserId: params.actorUserId,
                        updatedAt: new Date(),
                    })
                    .where(eq(regulationOccupancies.id, existing.id));
                await syncRegulationBankHours(tx, existing.id);
            }
        } else {
            const [existing] = await tx.select().from(interventionOccupancies)
                .where(eq(interventionOccupancies.id, occupancyIdToRemove))
                .limit(1);
            if (!existing) {
                throw new Error("Ocupação não encontrada para remoção.");
            }
            if (existing.source === "admin_correction" || existing.source === "manual") {
                await tx.delete(bankHoursEntries)
                    .where(eq(bankHoursEntries.interventionOccupancyId, existing.id));
                await tx.delete(interventionOccupancies)
                    .where(eq(interventionOccupancies.id, existing.id));
            } else {
                const removal = resolveRemovalEnd(existing);
                await tx.update(interventionOccupancies)
                    .set({
                        endedAt: removal.endedAt,
                        actualEndedAt: removal.actualEndedAt,
                        scheduledEndAt: removal.clearedWholeOccupancy ? existing.scheduledEndAt : slotStart,
                        notes: `${existing.notes ?? ""}\n[chefia] Remocao via fechamento de pagamento (${slotStart.toISOString()})`.trim(),
                        updatedByUserId: params.actorUserId,
                        updatedAt: new Date(),
                    })
                    .where(eq(interventionOccupancies.id, existing.id));
                await syncInterventionBankHours(tx, existing.id);
            }
        }
    });

    return {
        operationalDate: board.operationalDate,
        shiftLabel: board.shiftLabel,
        domain: params.domain,
        targetCode,
        removedOccupancyId: occupancyIdToRemove,
    };
}

/**
 * Aplica as flags de perfil de pagamento sobre o metadata do médico.
 *
 * Especialista é flag própria do pagamento (`paymentProfile.isSpecialist`).
 * Psiquiatra NÃO tem flag própria: é o mesmo `preferredOperationalRole=PSIQ`
 * que o `/psiq` do bot grava — marcar aqui é marcar lá (função na chegada,
 * refeição fixa, tabela de psiquiatria). Desmarcar só apaga o papel quando ele
 * é de fato PSIQ, para não derrubar um PIAM/CP por engano.
 *
 * Pura de propósito: é o miolo testável de setDoctorPaymentProfileFlags.
 */
export function applyDoctorPaymentProfileFlags(
    metadata: unknown,
    flags: { isSpecialist?: boolean; isPsychiatry?: boolean },
): DoctorPaymentMetadata {
    const current = normalizeDoctorPaymentMetadata(metadata);
    let updated: DoctorPaymentMetadata = { ...current };

    if (flags.isSpecialist !== undefined) {
        updated = {
            ...updated,
            paymentProfile: {
                ...(current.paymentProfile ?? {}),
                isSpecialist: flags.isSpecialist,
            },
        };
    }

    if (flags.isPsychiatry !== undefined) {
        const currentRole = String(current.preferredOperationalRole ?? "").trim().toUpperCase();
        if (flags.isPsychiatry) {
            updated = mergeDoctorDirectoryMetadata(updated, { preferredOperationalRole: "PSIQ" }) as DoctorPaymentMetadata;
        } else if (currentRole === "PSIQ") {
            updated = mergeDoctorDirectoryMetadata(updated, { preferredOperationalRole: null }) as DoctorPaymentMetadata;
        }
    }

    return updated;
}

export async function setDoctorPaymentProfileFlags(params: {
    doctorId: string;
    isSpecialist?: boolean;
    isPsychiatry?: boolean;
}) {
    const [doctor] = await getDb().select({
        id: doctors.id,
        fullName: doctors.fullName,
        metadata: doctors.metadata,
    }).from(doctors)
        .where(eq(doctors.id, params.doctorId))
        .limit(1);

    if (!doctor) {
        throw new Error("Medico nao encontrado para atualizar perfil de pagamento.");
    }

    const updatedMetadata = applyDoctorPaymentProfileFlags(doctor.metadata, {
        isSpecialist: params.isSpecialist,
        isPsychiatry: params.isPsychiatry,
    });

    await getDb().update(doctors)
        .set({
            metadata: updatedMetadata,
            updatedAt: new Date(),
        })
        .where(eq(doctors.id, params.doctorId));

    const paymentProfile = resolveDoctorPaymentProfileFromMetadata(updatedMetadata);
    return {
        id: doctor.id,
        fullName: doctor.fullName,
        isSpecialist: updatedMetadata.paymentProfile?.isSpecialist === true,
        isPsychiatry: paymentProfile === "psychiatry",
        paymentProfile,
    };
}

export async function setDoctorEmploymentType(params: {
    doctorId: string;
    employmentType: "pj" | "estatutario";
}) {
    const [doctor] = await getDb().select({
        id: doctors.id,
        fullName: doctors.fullName,
        metadata: doctors.metadata,
    }).from(doctors)
        .where(eq(doctors.id, params.doctorId))
        .limit(1);

    if (!doctor) {
        throw new Error("Medico nao encontrado para atualizar vinculo empregaticio.");
    }

    const current = normalizeDoctorPaymentMetadata(doctor.metadata);
    const updatedMetadata: DoctorPaymentMetadata = {
        ...current,
        employmentType: params.employmentType,
    };

    await getDb().update(doctors)
        .set({
            metadata: updatedMetadata,
            updatedAt: new Date(),
        })
        .where(eq(doctors.id, params.doctorId));

    return {
        id: doctor.id,
        fullName: doctor.fullName,
        employmentType: resolveDoctorEmploymentTypeFromMetadata(updatedMetadata),
    };
}
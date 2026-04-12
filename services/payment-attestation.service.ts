import { and, desc, eq, inArray } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { getDb } from "@/db";
import { doctors, paymentAttestationSlotEntries, paymentAttestationSlots, users, type paymentAttestationSlotStatusEnum } from "@/db/schema";
import { listDoctorSearchTerms } from "@/modules/doctors/directory";
import { normalizeDoctorName } from "@/modules/doctors/importer";
import { getPaymentAllocationBoard, type PaymentAllocationBoard, type PaymentAllocationRow } from "@/services/board.service";

type Executor = any;

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

    await db.transaction(async (tx) => {
        await tx.update(paymentAttestationSlotEntries)
            .set({
                disabledAt: null,
                disabledReason: null,
                disabledDuringShift: false,
                disabledEntireShift: false,
                occupancyId: currentEntry.occupancyId ?? randomUUID(),
                doctorId: doctor.id,
                doctorName: doctor.fullName,
                displayName: doctor.displayName,
                startedAt: currentEntry.startedAt ? new Date(currentEntry.startedAt) : new Date(slot.startedAt),
                endedAt: currentEntry.endedAt ? new Date(currentEntry.endedAt) : new Date(slot.endedAt),
                actualEndedAt: currentEntry.actualEndedAt ? new Date(currentEntry.actualEndedAt) : new Date(slot.endedAt),
                scheduledStartAt: currentEntry.scheduledStartAt ? new Date(currentEntry.scheduledStartAt) : new Date(slot.startedAt),
                scheduledEndAt: currentEntry.scheduledEndAt ? new Date(currentEntry.scheduledEndAt) : new Date(slot.endedAt),
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

    const updated = await loadPersistedSlotRecord(db, slot.operationalDate.slice(0, 10), slot.shiftLabel);
    if (!updated) {
        throw new Error("Nao foi possivel recarregar o fechamento apos correção manual.");
    }

    return updated;
}
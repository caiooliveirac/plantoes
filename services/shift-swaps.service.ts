import { and, asc, eq, gte, inArray, lt, or } from "drizzle-orm";
import { getDb } from "@/db";
import {
    doctors,
    interventionBases,
    interventionOccupancies,
    regulationOccupancies,
    regulationPosts,
    scheduledShifts,
    shiftSwaps,
} from "@/db/schema";
import {
    type CoverageShift,
    type CoverageSwap,
    type ShiftCoverage,
    resolveShiftCoverages,
} from "@/modules/shift-swaps/coverage";

export type SwapTransitionAction = "accept" | "approve" | "reject" | "cancel";

type ScheduledShiftRow = typeof scheduledShifts.$inferSelect;
type ShiftSwapRow = typeof shiftSwaps.$inferSelect;

function toCoverageShift(row: ScheduledShiftRow): CoverageShift {
    return {
        id: row.id,
        domain: row.domain as CoverageShift["domain"],
        postId: row.postId,
        baseId: row.baseId,
        doctorId: row.doctorId,
        roleLabel: row.roleLabel,
    };
}

function toCoverageSwap(row: ShiftSwapRow): CoverageSwap {
    return {
        id: row.id,
        shiftId: row.shiftId,
        swapType: row.swapType,
        fromDoctorId: row.fromDoctorId,
        toDoctorId: row.toDoctorId,
        counterpartShiftId: row.counterpartShiftId,
        toPostId: row.toPostId,
        toBaseId: row.toBaseId,
        toRoleLabel: row.toRoleLabel,
        status: row.status,
        approvedAt: row.approvedAt,
    };
}

/** Carrega as linhagens (shifts + swaps aprovados que as tocam) e resolve. */
async function loadCoveragesForShifts(shiftRows: ScheduledShiftRow[]): Promise<Map<string, ShiftCoverage>> {
    if (shiftRows.length === 0) {
        return new Map();
    }
    const db = getDb();
    const shiftIds = shiftRows.map((row) => row.id);
    const swapRows = await db.select().from(shiftSwaps).where(or(
        inArray(shiftSwaps.shiftId, shiftIds),
        inArray(shiftSwaps.counterpartShiftId, shiftIds),
    ));

    // Contrapartes fora do conjunto inicial entram no universo para o mutual/
    // base_change resolver os dois lados.
    const knownIds = new Set(shiftIds);
    const missingIds = swapRows
        .flatMap((row) => [row.shiftId, row.counterpartShiftId])
        .filter((id): id is string => Boolean(id) && !knownIds.has(id!));

    let universe = shiftRows;
    if (missingIds.length > 0) {
        const extra = await db.select().from(scheduledShifts).where(inArray(scheduledShifts.id, [...new Set(missingIds)]));
        universe = [...shiftRows, ...extra];
    }

    return resolveShiftCoverages(universe.map(toCoverageShift), swapRows.map(toCoverageSwap));
}

/** Dono efetivo de um plantão previsto: quem está "por" o escalado original. */
export async function effectiveShiftOwner(shiftId: string): Promise<ShiftCoverage> {
    const db = getDb();
    const shift = await db.query.scheduledShifts.findFirst({ where: eq(scheduledShifts.id, shiftId) });
    if (!shift) {
        throw new Error("Plantão previsto não encontrado.");
    }
    const coverages = await loadCoveragesForShifts([shift]);
    return coverages.get(shiftId)!;
}

export async function createSwap(params: {
    shiftId: string;
    swapType: ShiftSwapRow["swapType"];
    toDoctorId: string;
    counterpartShiftId?: string | null;
    toPostId?: number | null;
    toBaseId?: number | null;
    toRoleLabel?: string | null;
    notes?: string | null;
    actorDoctorId: string;
    actorUserId: string;
}) {
    const db = getDb();
    const coverage = await effectiveShiftOwner(params.shiftId);

    // Só o dono efetivo atual da linhagem pode oferecer a troca.
    if (coverage.effectiveDoctorId !== params.actorDoctorId) {
        throw new Error("Só o dono efetivo atual do plantão pode propor a troca.");
    }
    if (params.swapType === "mutual" && !params.counterpartShiftId) {
        throw new Error("Troca mútua exige o plantão da contraparte.");
    }

    const openSwap = await db.query.shiftSwaps.findFirst({
        where: and(
            eq(shiftSwaps.shiftId, params.shiftId),
            inArray(shiftSwaps.status, ["offered", "accepted"]),
        ),
    });
    if (openSwap) {
        throw new Error("Já existe uma troca em andamento para este plantão.");
    }

    const [created] = await db.insert(shiftSwaps).values({
        shiftId: params.shiftId,
        swapType: params.swapType,
        fromDoctorId: params.actorDoctorId,
        toDoctorId: params.toDoctorId,
        counterpartShiftId: params.counterpartShiftId ?? null,
        toPostId: params.toPostId ?? null,
        toBaseId: params.toBaseId ?? null,
        toRoleLabel: params.toRoleLabel ?? null,
        notes: params.notes ?? null,
        createdByUserId: params.actorUserId,
    }).returning();

    return created;
}

const TRANSITIONS: Record<SwapTransitionAction, { from: ShiftSwapRow["status"][]; to: ShiftSwapRow["status"] }> = {
    accept: { from: ["offered"], to: "accepted" },
    approve: { from: ["accepted"], to: "approved" },
    reject: { from: ["offered", "accepted"], to: "rejected" },
    cancel: { from: ["offered", "accepted"], to: "cancelled" },
};

export async function transitionSwap(params: {
    swapId: string;
    action: SwapTransitionAction;
    actorUserId: string;
    actorDoctorId: string | null;
    actorIsChief: boolean;
}) {
    const db = getDb();
    const swap = await db.query.shiftSwaps.findFirst({ where: eq(shiftSwaps.id, params.swapId) });
    if (!swap) {
        throw new Error("Troca não encontrada.");
    }

    const transition = TRANSITIONS[params.action];
    if (!transition.from.includes(swap.status)) {
        throw new Error(`Transição inválida: ${swap.status} → ${params.action}.`);
    }

    if (params.action === "accept" && swap.toDoctorId !== params.actorDoctorId) {
        throw new Error("Só o médico destinatário pode aceitar a troca.");
    }
    if (params.action === "approve" && !params.actorIsChief) {
        throw new Error("Só chefe de plantão ou admin aprova trocas.");
    }
    if (params.action === "cancel" && swap.fromDoctorId !== params.actorDoctorId && !params.actorIsChief) {
        throw new Error("Só quem propôs (ou a chefia) pode cancelar a troca.");
    }
    if (params.action === "reject" && swap.toDoctorId !== params.actorDoctorId && !params.actorIsChief) {
        throw new Error("Só o destinatário (ou a chefia) pode recusar a troca.");
    }

    const now = new Date();
    const [updated] = await db.update(shiftSwaps)
        .set({
            status: transition.to,
            acceptedAt: params.action === "accept" ? now : swap.acceptedAt,
            approvedAt: params.action === "approve" ? now : swap.approvedAt,
            rejectedAt: params.action === "reject" ? now : swap.rejectedAt,
            cancelledAt: params.action === "cancel" ? now : swap.cancelledAt,
            approvedByUserId: params.action === "approve" ? params.actorUserId : swap.approvedByUserId,
            updatedAt: now,
        })
        .where(eq(shiftSwaps.id, params.swapId))
        .returning();

    return updated;
}

export async function listSwapsForActor(params: { doctorId: string | null; isChief: boolean }) {
    const db = getDb();
    const rows = params.isChief
        ? await db.select().from(shiftSwaps).orderBy(asc(shiftSwaps.offeredAt))
        : params.doctorId
            ? await db.select().from(shiftSwaps).where(or(
                eq(shiftSwaps.fromDoctorId, params.doctorId),
                eq(shiftSwaps.toDoctorId, params.doctorId),
            )).orderBy(asc(shiftSwaps.offeredAt))
            : [];

    const shiftIds = [...new Set(rows.flatMap((row) => [row.shiftId, row.counterpartShiftId]).filter(Boolean))] as string[];
    const doctorIds = [...new Set(rows.flatMap((row) => [row.fromDoctorId, row.toDoctorId]))];

    const [shiftRows, doctorRows] = await Promise.all([
        shiftIds.length ? db.select().from(scheduledShifts).where(inArray(scheduledShifts.id, shiftIds)) : Promise.resolve([]),
        doctorIds.length ? db.select().from(doctors).where(inArray(doctors.id, doctorIds)) : Promise.resolve([]),
    ]);

    const shiftIndex = new Map(shiftRows.map((row) => [row.id, row]));
    const doctorIndex = new Map(doctorRows.map((row) => [row.id, row.displayName ?? row.fullName]));

    return rows.map((row) => ({
        ...row,
        shift: shiftIndex.get(row.shiftId) ?? null,
        counterpartShift: row.counterpartShiftId ? shiftIndex.get(row.counterpartShiftId) ?? null : null,
        fromDoctorName: doctorIndex.get(row.fromDoctorId) ?? "?",
        toDoctorName: doctorIndex.get(row.toDoctorId) ?? "?",
    }));
}

export interface CoverageReportRow {
    shiftId: string;
    domain: string;
    targetLabel: string;
    shiftLabel: string;
    originalDoctorId: string;
    originalDoctorName: string;
    effectiveDoctorId: string;
    effectiveDoctorName: string;
    effectiveTargetLabel: string;
    /** "Victor está por Ana" quando efetivo != original. */
    coveredBySwap: boolean;
    swapChainLength: number;
    presence: "presente" | "ausente";
    presenceTargetMatches: boolean | null;
    checkinAt: string | null;
}

/**
 * Relatório de cobertura do dia: junta escala resolvida (linhagens + trocas
 * aprovadas) com os check-ins reais (occupancies do robô). O casamento com a
 * presença é por MÉDICO EFETIVO + janela do turno — nunca por local, porque o
 * local real pode divergir do previsto para a linhagem.
 */
export async function getCoverageReport(operationalDate: string): Promise<CoverageReportRow[]> {
    const db = getDb();
    const shiftRows = await db.select().from(scheduledShifts).where(and(
        eq(scheduledShifts.operationalDate, operationalDate),
        eq(scheduledShifts.status, "planned"),
    ));

    if (shiftRows.length === 0) {
        return [];
    }

    const coverages = await loadCoveragesForShifts(shiftRows);

    const windowStart = new Date(Math.min(...shiftRows.map((row) => row.scheduledStartAt.getTime())) - 3 * 3600000);
    const windowEnd = new Date(Math.max(...shiftRows.map((row) => row.scheduledEndAt.getTime())));
    const effectiveDoctorIds = [...new Set(shiftRows.map((row) => coverages.get(row.id)!.effectiveDoctorId))];

    const [regRows, intRows, doctorRows, postRows, baseRows] = await Promise.all([
        db.select().from(regulationOccupancies).where(and(
            inArray(regulationOccupancies.doctorId, effectiveDoctorIds),
            gte(regulationOccupancies.startedAt, windowStart),
            lt(regulationOccupancies.startedAt, windowEnd),
        )),
        db.select().from(interventionOccupancies).where(and(
            inArray(interventionOccupancies.doctorId, effectiveDoctorIds),
            gte(interventionOccupancies.startedAt, windowStart),
            lt(interventionOccupancies.startedAt, windowEnd),
        )),
        db.select().from(doctors),
        db.select().from(regulationPosts),
        db.select().from(interventionBases),
    ]);

    const doctorNames = new Map(doctorRows.map((row) => [row.id, row.displayName ?? row.fullName]));
    const postLabels = new Map(postRows.map((row) => [row.id, row.label]));
    const baseLabels = new Map(baseRows.map((row) => [row.id, row.label]));

    const checkinsByDoctor = new Map<string, { startedAt: Date; postId: number | null; baseId: number | null }[]>();
    for (const row of regRows) {
        const list = checkinsByDoctor.get(row.doctorId) ?? [];
        list.push({ startedAt: row.startedAt, postId: row.postId, baseId: null });
        checkinsByDoctor.set(row.doctorId, list);
    }
    for (const row of intRows) {
        const list = checkinsByDoctor.get(row.doctorId) ?? [];
        list.push({ startedAt: row.startedAt, postId: null, baseId: row.baseId });
        checkinsByDoctor.set(row.doctorId, list);
    }

    function targetLabel(domain: string, postId: number | null, baseId: number | null) {
        if (postId != null) return postLabels.get(postId) ?? `ramal ${postId}`;
        if (baseId != null) return baseLabels.get(baseId) ?? `base ${baseId}`;
        return domain;
    }

    return shiftRows
        .map((row): CoverageReportRow => {
            const coverage = coverages.get(row.id)!;
            const checkins = (checkinsByDoctor.get(coverage.effectiveDoctorId) ?? []).filter((entry) =>
                entry.startedAt >= new Date(row.scheduledStartAt.getTime() - 3 * 3600000)
                && entry.startedAt < row.scheduledEndAt,
            );
            const checkin = checkins[0] ?? null;

            return {
                shiftId: row.id,
                domain: row.domain,
                targetLabel: targetLabel(row.domain, row.postId, row.baseId),
                shiftLabel: row.shiftLabel,
                originalDoctorId: coverage.originalDoctorId,
                originalDoctorName: doctorNames.get(coverage.originalDoctorId) ?? "?",
                effectiveDoctorId: coverage.effectiveDoctorId,
                effectiveDoctorName: doctorNames.get(coverage.effectiveDoctorId) ?? "?",
                effectiveTargetLabel: targetLabel(
                    coverage.effectiveTarget.domain,
                    coverage.effectiveTarget.postId,
                    coverage.effectiveTarget.baseId,
                ),
                coveredBySwap: coverage.effectiveDoctorId !== coverage.originalDoctorId,
                swapChainLength: coverage.chain.length,
                presence: checkin ? "presente" : "ausente",
                presenceTargetMatches: checkin
                    ? (checkin.postId != null && checkin.postId === coverage.effectiveTarget.postId)
                        || (checkin.baseId != null && checkin.baseId === coverage.effectiveTarget.baseId)
                    : null,
                checkinAt: checkin ? checkin.startedAt.toISOString() : null,
            };
        })
        .sort((left, right) => left.targetLabel.localeCompare(right.targetLabel, "pt-BR"));
}

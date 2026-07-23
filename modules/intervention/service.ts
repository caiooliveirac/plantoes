import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, isNull, isNotNull, lte, ne } from "drizzle-orm";
import { getDb } from "@/db";
import { doctors, interventionBaseDeactivations, interventionBases, interventionOccupancies, regulationOccupancies } from "@/db/schema";
import { extractDoctorPreferredOperationalRole } from "@/modules/doctors/directory";
import { publishBoardUpdate } from "@/lib/board-live";
import { syncInterventionBankHours, syncRegulationBankHours } from "@/modules/bank-hours/service";
import { applyOperationalRoleShiftPolicy } from "@/modules/operational/roles";
import { resolveArrivalShiftLabel, resolveOperationalShiftWindow } from "@/modules/operational/board-rules";
import { inferInterventionCoverageWindow, inferOperationalScheduledStartAt, resolveInterventionContinuationScheduledEndAt } from "@/modules/operational/rules";

type Executor = any;
const AUTO_CONTINUITY_RECENT_CLOSED_WINDOW_MS = 2 * 60 * 60 * 1000;
const MIN_SAFE_OCCUPANCY_DURATION_MS = 60 * 1000;

/**
 * Remanejamento herda continuity_group_id do plantão aberto em outra base só quando a
 * chegada nova cai na mesma janela operacional do plantão anterior. Plantão antigo aberto
 * em outro turno (médico esqueceu de avisar saída há horas) não fundirá grupos.
 */
export function shouldInheritContinuityFromOtherBaseOccupancy(params: {
    otherBaseStartedAt: Date;
    eventAt: Date;
}) {
    const otherWindowStart = resolveOperationalShiftWindow(params.otherBaseStartedAt).startedAt.getTime();
    const eventWindowStart = resolveOperationalShiftWindow(params.eventAt).startedAt.getTime();
    return otherWindowStart === eventWindowStart;
}

export interface StartInterventionOccupancyInput {
    doctorId: string;
    baseId: number;
    continuityGroupId?: string | null;
    previousOccupancyId?: string | null;
    isContinuityEntry?: boolean;
    isShadow?: boolean | null;
    startedAt: Date;
    boardStartedAt?: Date | null;
    scheduledStartAt?: Date | null;
    scheduledEndAt?: Date | null;
    shiftLabel?: string | null;
    roleLabel?: string | null;
    source: "manual" | "telegram" | "import" | "admin_correction";
    notes?: string | null;
    createdByUserId?: string | null;
}

export interface DeactivateInterventionBaseInput {
    baseId: number;
    deactivatedAt: Date;
    notes?: string | null;
    createdByUserId?: string | null;
}

export interface ReactivateInterventionBaseInput {
    baseId: number;
    reactivatedAt?: Date | null;
    updatedByUserId?: string | null;
}

export function resolveHistoricalInterventionAdminCorrectionEndAt(params: {
    source: StartInterventionOccupancyInput["source"];
    startedAt: Date;
    inferredScheduledEndAt: Date | null;
    now: Date;
}) {
    if (params.source !== "admin_correction") {
        return null;
    }

    if (!params.inferredScheduledEndAt) {
        return null;
    }

    if (params.inferredScheduledEndAt.getTime() > params.now.getTime()) {
        return null;
    }

    if (params.inferredScheduledEndAt.getTime() <= params.startedAt.getTime()) {
        return null;
    }

    return params.inferredScheduledEndAt;
}

export function resolveContinuationBoardStartedAt(params: {
    startedAt: Date;
    boardStartedAt?: Date | null;
    continuedAt: Date;
}) {
    // Always preserve the earliest boardStartedAt. When a doctor continues across
    // shifts (SD→SN, P→SN), the board must reflect their original arrival time so
    // that operational priority correctly shows who has been present longer.
    return params.boardStartedAt ?? params.startedAt;
}

export function resolveExistingInterventionBoardAnchor(params: {
    startedAt: Date;
    boardStartedAt?: Date | null;
}) {
    return params.boardStartedAt ?? params.startedAt;
}

export function resolveSameDoctorBoardStartedAt(params: {
    existingStartedAt: Date;
    existingBoardStartedAt?: Date | null;
    effectiveBoardStartedAt?: Date | null;
    currentShiftStart: Date;
}) {
    // Shadow occupancies intentionally keep boardStartedAt=null so they never contend
    // for the unique active board-carrier slot on the base.
    if (!params.existingBoardStartedAt) {
        return null;
    }

    // Telegram shadow flows can preserve a null board anchor; in that case keep the
    // current carrier anchor instead of crashing on getTime().
    if (!params.effectiveBoardStartedAt) {
        return resolveExistingInterventionBoardAnchor({
            startedAt: params.existingStartedAt,
            boardStartedAt: params.existingBoardStartedAt,
        });
    }

    const PRE_SHIFT_TOLERANCE_MS = 60 * 60 * 1000;
    const existingBoardAnchor = resolveExistingInterventionBoardAnchor({
        startedAt: params.existingStartedAt,
        boardStartedAt: params.existingBoardStartedAt,
    });
    const existingAnchorIsStale = existingBoardAnchor.getTime() < (params.currentShiftStart.getTime() - PRE_SHIFT_TOLERANCE_MS);

    if (existingAnchorIsStale || params.effectiveBoardStartedAt.getTime() < existingBoardAnchor.getTime()) {
        return params.effectiveBoardStartedAt;
    }

    return existingBoardAnchor;
}

export function shouldReuseImplicitContinuitySource(referenceAt: Date, sourceEndedAt?: Date | null) {
    if (!sourceEndedAt) {
        return true;
    }

    return Math.abs(referenceAt.getTime() - sourceEndedAt.getTime()) <= AUTO_CONTINUITY_RECENT_CLOSED_WINDOW_MS;
}

function clampOccupancyEndAt(startedAt: Date, endedAt: Date) {
    return endedAt.getTime() < startedAt.getTime() ? startedAt : endedAt;
}

export function resolveSafeInterventionHandoffAt(params: {
    sourceStartedAt: Date;
    requestedAt: Date;
}) {
    const handoffAt = params.requestedAt.getTime() >= params.sourceStartedAt.getTime()
        ? params.requestedAt
        : params.sourceStartedAt;

    return handoffAt.getTime() - params.sourceStartedAt.getTime() >= MIN_SAFE_OCCUPANCY_DURATION_MS
        ? handoffAt
        : null;
}

export function resolveInterventionBaseDeactivationExpiresAt(deactivatedAt: Date) {
    return new Date("9999-12-31T23:59:59.999Z");
}

export function isInterventionBaseDeactivationActive(params: {
    deactivatedAt: Date;
    reactivatedAt?: Date | null;
    referenceAt: Date;
}) {
    if (params.referenceAt.getTime() < params.deactivatedAt.getTime()) {
        return false;
    }

    return !params.reactivatedAt || params.referenceAt.getTime() < params.reactivatedAt.getTime();
}

export function resolveInterventionOccupancyActivationReferenceAt(params: {
    startedAt: Date;
    scheduledStartAt?: Date | null;
}) {
    if (!params.scheduledStartAt) {
        return params.startedAt;
    }

    return params.scheduledStartAt.getTime() > params.startedAt.getTime()
        ? params.scheduledStartAt
        : params.startedAt;
}

function normalizeInterventionOperationalNotes(value: string | null | undefined) {
    return (value ?? "")
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .toUpperCase();
}

export function isInterventionShadowOccupancyNotes(notes: string | null | undefined) {
    const normalized = normalizeInterventionOperationalNotes(notes);
    return normalized.includes("[TELEGRAM SOMBRA]") || /\bSOMBRA\b/.test(normalized);
}

// Espelha o domínio de regulação: ocupação "deslocada" numa tomada confirmada
// permanece ativa fora do quadro (board_started_at nulo) com a chegada preservada.
export const INTERVENTION_DISPLACED_NOTE_MARKER = "[DESLOCADO]";

export function isInterventionDisplacedOccupancyNotes(notes: string | null | undefined) {
    return normalizeInterventionOperationalNotes(notes).includes(INTERVENTION_DISPLACED_NOTE_MARKER);
}

export function resolveStaleShadowInterventionEndedAt(params: {
    notes: string | null | undefined;
    scheduledEndAt?: Date | null;
    endedAt?: Date | null;
    referenceAt: Date;
}) {
    if (params.endedAt || !params.scheduledEndAt) {
        return null;
    }

    if (!isInterventionShadowOccupancyNotes(params.notes)) {
        return null;
    }

    if (params.referenceAt.getTime() < params.scheduledEndAt.getTime()) {
        return null;
    }

    return params.scheduledEndAt;
}

// Base diurna (day_only): fecha QUALQUER ocupação aberta (titular ou sombra) assim
// que o horário programado (07-19) termina — diferente de resolveStaleShadowInterventionEndedAt,
// que só fecha sombra. É isso que garante que a base some do painel à noite e nunca
// chegue a ser continuada (continueInterventionOccupancy exige !endedAt).
export function resolveDayOnlyBaseAutoCloseEndedAt(params: {
    dayOnly: boolean;
    scheduledEndAt?: Date | null;
    endedAt?: Date | null;
    referenceAt: Date;
}) {
    if (!params.dayOnly || params.endedAt || !params.scheduledEndAt) {
        return null;
    }

    if (params.referenceAt.getTime() < params.scheduledEndAt.getTime()) {
        return null;
    }

    return params.scheduledEndAt;
}

export function shouldCloseInterventionBoardCarrierOnArrival(params: {
    currentCarrierDoctorId: string;
    arrivingDoctorId: string;
    currentCarrierNotes: string | null | undefined;
}) {
    if (params.currentCarrierDoctorId === params.arrivingDoctorId) {
        return false;
    }

    if (isInterventionDisplacedOccupancyNotes(params.currentCarrierNotes)) {
        return false;
    }

    return !isInterventionShadowOccupancyNotes(params.currentCarrierNotes);
}

// Desloca o portador da base numa tomada confirmada: tira o board sem fechar,
// preservando a chegada. Mantém ativo fora do quadro até redeclarar nova posição.
export async function displaceInterventionOccupant(
    occupancyId: string,
    input: { displacedAt: Date; takenByDoctorName?: string | null },
    updatedByUserId?: string | null,
) {
    const db = getDb();
    const updated = await db.transaction(async (tx) => {
        const existing = await tx.query.interventionOccupancies.findFirst({
            where: eq(interventionOccupancies.id, occupancyId),
        });
        if (!existing) {
            throw new Error("Intervention occupancy not found.");
        }
        if (existing.endedAt) {
            throw new Error("Only active intervention occupancies can be displaced.");
        }
        if (isInterventionDisplacedOccupancyNotes(existing.notes)) {
            return existing;
        }

        const stamp = input.displacedAt.toISOString();
        const by = input.takenByDoctorName ? ` por ${input.takenByDoctorName}` : "";
        const marker = `${INTERVENTION_DISPLACED_NOTE_MARKER} ${stamp}${by}`.trim();
        const nextNotes = existing.notes ? `${existing.notes}\n${marker}` : marker;

        const [row] = await tx.update(interventionOccupancies)
            .set({
                boardStartedAt: null,
                notes: nextNotes,
                updatedByUserId: updatedByUserId ?? null,
                updatedAt: new Date(),
            })
            .where(eq(interventionOccupancies.id, occupancyId))
            .returning();
        return row;
    });

    publishBoardUpdate(`intervention:displace:${updated.baseId}`);
    return updated;
}

export function resolveInterventionArrivalBoardPolicy(params: {
    source: StartInterventionOccupancyInput["source"];
    isShadow?: boolean | null;
    hasCurrentBoardCarrier: boolean;
}) {
    return {
        shouldTakeBoardImmediately: params.source !== "import"
            && (!params.isShadow || !params.hasCurrentBoardCarrier),
    };
}

async function closeExpiredInterventionBaseDeactivation(tx: Executor, params: {
    deactivationId: string;
    expiredAt: Date;
    updatedByUserId?: string | null;
}) {
    return;
}

async function findActiveInterventionBaseDeactivation(tx: Executor, params: {
    baseId: number;
    referenceAt: Date;
    updatedByUserId?: string | null;
}) {
    const openDeactivation = await tx.query.interventionBaseDeactivations.findFirst({
        where: and(
            eq(interventionBaseDeactivations.baseId, params.baseId),
            isNull(interventionBaseDeactivations.reactivatedAt),
            lte(interventionBaseDeactivations.deactivatedAt, params.referenceAt),
        ),
        orderBy: [desc(interventionBaseDeactivations.deactivatedAt)],
    });

    if (!openDeactivation) {
        return null;
    }

    return openDeactivation;
}

export async function expireInterventionBaseDeactivations(referenceAt: Date, updatedByUserId?: string | null) {
    return 0;
}

async function assertInterventionBaseExists(baseId: number) {
    const db = getDb();
    const base = await db.query.interventionBases.findFirst({
        where: eq(interventionBases.id, baseId),
    });

    if (!base) {
        throw new Error("Intervention base not found.");
    }

    return base;
}

export async function startInterventionOccupancy(input: StartInterventionOccupancyInput) {
    const db = getDb();
    const now = new Date();
    let autoReactivated = false;
    let closedPreviousBaseId: number | null = null;
    await expireStaleShadowInterventionOccupancies(input.startedAt, input.createdByUserId ?? null);
    const created = await db.transaction(async (tx) => {
        const doctor = await tx.query.doctors.findFirst({
            where: eq(doctors.id, input.doctorId),
            columns: { metadata: true },
        });
        const defaultDoctorRoleLabel = input.roleLabel ?? extractDoctorPreferredOperationalRole(doctor?.metadata);

        let resolvedContinuityGroupId = input.continuityGroupId ?? null;
        if (!resolvedContinuityGroupId && input.previousOccupancyId) {
            const previous = await tx.query.interventionOccupancies.findFirst({
                where: eq(interventionOccupancies.id, input.previousOccupancyId),
                columns: { continuityGroupId: true },
            });
            if (!previous) {
                const previousReg = await tx.query.regulationOccupancies.findFirst({
                    where: eq(regulationOccupancies.id, input.previousOccupancyId),
                    columns: { continuityGroupId: true },
                });
                resolvedContinuityGroupId = previousReg?.continuityGroupId ?? null;
            } else {
                resolvedContinuityGroupId = previous.continuityGroupId ?? null;
            }
        }

        // Step 2: auto-resolve for continuity entries — find doctor's most recent occupancy
        if (input.isContinuityEntry && !resolvedContinuityGroupId) {
            const latestInt = await tx.query.interventionOccupancies.findFirst({
                where: eq(interventionOccupancies.doctorId, input.doctorId),
                orderBy: [desc(interventionOccupancies.startedAt)],
                columns: { continuityGroupId: true, boardStartedAt: true, startedAt: true, endedAt: true },
            });
            const latestReg = await tx.query.regulationOccupancies.findFirst({
                where: eq(regulationOccupancies.doctorId, input.doctorId),
                orderBy: [desc(regulationOccupancies.startedAt)],
                columns: { continuityGroupId: true, boardStartedAt: true, startedAt: true, endedAt: true },
            });
            const latest = latestInt && latestReg
                ? (latestInt.startedAt.getTime() >= latestReg.startedAt.getTime() ? latestInt : latestReg)
                : (latestInt ?? latestReg);
            if (latest && shouldReuseImplicitContinuitySource(input.startedAt, latest.endedAt ?? null)) {
                resolvedContinuityGroupId = latest.continuityGroupId;
            }
        }

        // Step 3: walk the continuity chain to find the earliest boardStartedAt
        let resolvedBoardStartedAt: Date | null = input.boardStartedAt ?? null;
        if (input.isContinuityEntry && resolvedContinuityGroupId && !input.boardStartedAt) {
            const earliestInt = await tx.query.interventionOccupancies.findFirst({
                where: and(
                    eq(interventionOccupancies.doctorId, input.doctorId),
                    eq(interventionOccupancies.continuityGroupId, resolvedContinuityGroupId),
                ),
                orderBy: [asc(interventionOccupancies.boardStartedAt)],
                columns: { boardStartedAt: true, startedAt: true },
            });
            const earliestReg = await tx.query.regulationOccupancies.findFirst({
                where: and(
                    eq(regulationOccupancies.doctorId, input.doctorId),
                    eq(regulationOccupancies.continuityGroupId, resolvedContinuityGroupId),
                ),
                orderBy: [asc(regulationOccupancies.boardStartedAt)],
                columns: { boardStartedAt: true, startedAt: true },
            });
            const candidates = [earliestInt, earliestReg].filter(Boolean) as { boardStartedAt: Date; startedAt: Date }[];
            if (candidates.length > 0) {
                const earliest = candidates.reduce((best, current) => {
                    const bestTime = (best.boardStartedAt ?? best.startedAt).getTime();
                    const curTime = (current.boardStartedAt ?? current.startedAt).getTime();
                    return curTime < bestTime ? current : best;
                });
                resolvedBoardStartedAt = earliest.boardStartedAt ?? earliest.startedAt;
            }
        }

        const effectiveBoardStartedAt = resolvedBoardStartedAt ?? input.startedAt;

        const windowReferenceAt = effectiveBoardStartedAt.getTime() > input.startedAt.getTime()
            ? effectiveBoardStartedAt
            : input.startedAt;
        const normalizedShiftLabel = input.shiftLabel ?? resolveArrivalShiftLabel(windowReferenceAt);
        const { scheduledStartAt: inferredScheduledStartAt, scheduledEndAt: inferredScheduledEndAt } = inferInterventionCoverageWindow({
            startedAt: windowReferenceAt,
            shiftLabel: normalizedShiftLabel,
            explicitScheduledStartAt: input.scheduledStartAt ?? null,
            explicitScheduledEndAt: input.scheduledEndAt ?? null,
        });
        const historicalCorrectionEndAt = resolveHistoricalInterventionAdminCorrectionEndAt({
            source: input.source,
            startedAt: input.startedAt,
            inferredScheduledEndAt,
            now,
        });
        const activationReferenceAt = resolveInterventionOccupancyActivationReferenceAt({
            startedAt: input.startedAt,
            scheduledStartAt: inferredScheduledStartAt,
        });
        const activeDeactivation = await findActiveInterventionBaseDeactivation(tx, {
            baseId: input.baseId,
            referenceAt: activationReferenceAt,
            updatedByUserId: input.createdByUserId ?? null,
        });

        if (activeDeactivation) {
            // Auto-reactivate: doctor arrival implicitly reactivates the base.
            // Fecha TODAS as janelas de desativação já vigentes e ainda abertas (não só a
            // mais recente): janelas sobrepostas antigas ficavam órfãs (reactivated_at NULL)
            // e faziam a base parecer "desativada" para o remanejamento mesmo com is_active
            // true e médico em plantão. Janelas futuras (deactivatedAt > referência) são
            // preservadas.
            await tx.update(interventionBaseDeactivations)
                .set({
                    reactivatedAt: input.startedAt,
                    updatedByUserId: input.createdByUserId ?? null,
                    updatedAt: new Date(),
                })
                .where(and(
                    eq(interventionBaseDeactivations.baseId, input.baseId),
                    isNull(interventionBaseDeactivations.reactivatedAt),
                    lte(interventionBaseDeactivations.deactivatedAt, activationReferenceAt),
                ));
            autoReactivated = true;
        }
        const existingSameDoctor = await tx.query.interventionOccupancies.findFirst({
            where: and(
                eq(interventionOccupancies.baseId, input.baseId),
                eq(interventionOccupancies.doctorId, input.doctorId),
                isNull(interventionOccupancies.endedAt),
            ),
            orderBy: [desc(interventionOccupancies.boardStartedAt), desc(interventionOccupancies.startedAt)],
        });

        // Same doctor on same base: update in place instead of close+create.
        if (existingSameDoctor) {
            // Preserve the earliest boardStartedAt — but only if it belongs to the current
            // operational shift context. A stale anchor from a past shift would cause the
            // occupancy to be invisible on the board (board-rules visibility check would expire it).
            const currentShiftStart = resolveOperationalShiftWindow(input.startedAt).startedAt;
            const keptBoardStartedAt = resolveSameDoctorBoardStartedAt({
                existingStartedAt: existingSameDoctor.startedAt,
                existingBoardStartedAt: existingSameDoctor.boardStartedAt,
                effectiveBoardStartedAt,
                currentShiftStart,
            });

            const keptContinuityGroupId = resolvedContinuityGroupId ?? existingSameDoctor.continuityGroupId;

            // F2 safety: never allow started_at to advance forward past the existing value.
            const keptStartedAt = input.startedAt.getTime() < existingSameDoctor.startedAt.getTime()
                ? input.startedAt
                : existingSameDoctor.startedAt;

            const windowRef = keptBoardStartedAt && keptBoardStartedAt.getTime() > keptStartedAt.getTime()
                ? keptBoardStartedAt : keptStartedAt;
            const {
                baseShiftLabel: recalcBaseShiftLabel,
                scheduledStartAt: recalcStart,
                scheduledEndAt: recalcEnd,
            } = inferInterventionCoverageWindow({
                startedAt: windowRef,
                shiftLabel: input.shiftLabel ?? existingSameDoctor.shiftLabel,
                explicitScheduledStartAt: null,
                explicitScheduledEndAt: null,
            });
            const requestedRoleLabel = input.roleLabel !== undefined ? input.roleLabel : existingSameDoctor.roleLabel;
            const nextRoleLabel = applyOperationalRoleShiftPolicy({
                shiftLabel: recalcBaseShiftLabel,
                roleLabel: requestedRoleLabel,
            });

            const [updated] = await tx.update(interventionOccupancies)
                .set({
                    startedAt: keptStartedAt,
                    boardStartedAt: keptBoardStartedAt,
                    continuityGroupId: keptContinuityGroupId,
                    scheduledStartAt: recalcStart,
                    scheduledEndAt: recalcEnd,
                    shiftLabel: input.shiftLabel ?? existingSameDoctor.shiftLabel,
                    roleLabel: nextRoleLabel,
                    notes: input.notes ? `${existingSameDoctor.notes ?? ""}\n${input.notes}`.trim() : existingSameDoctor.notes,
                    updatedByUserId: input.createdByUserId ?? null,
                    updatedAt: new Date(),
                })
                .where(eq(interventionOccupancies.id, existingSameDoctor.id))
                .returning();

            await syncInterventionBankHours(tx, existingSameDoctor.id);
            return updated;
        }

        const otherBaseOccupancy = await tx.query.interventionOccupancies.findFirst({
            where: and(
                eq(interventionOccupancies.doctorId, input.doctorId),
                ne(interventionOccupancies.baseId, input.baseId),
                isNull(interventionOccupancies.endedAt),
            ),
            orderBy: [desc(interventionOccupancies.startedAt)],
        });

        const shouldPreserveDoctorCurrentOtherBase = Boolean(
            historicalCorrectionEndAt
            && otherBaseOccupancy
            && input.startedAt.getTime() < otherBaseOccupancy.startedAt.getTime(),
        );

        if (otherBaseOccupancy && !shouldPreserveDoctorCurrentOtherBase) {
            const otherCloseAt = resolveSafeInterventionHandoffAt({
                sourceStartedAt: otherBaseOccupancy.startedAt,
                requestedAt: input.startedAt,
            });

            if (otherCloseAt) {
                await tx.update(interventionOccupancies)
                    .set({
                        endedAt: otherCloseAt,
                        actualEndedAt: otherCloseAt,
                        updatedByUserId: input.createdByUserId ?? null,
                        updatedAt: new Date(),
                    })
                    .where(eq(interventionOccupancies.id, otherBaseOccupancy.id));

                if (otherBaseOccupancy.boardStartedAt) {
                    const replacement = await tx.query.interventionOccupancies.findFirst({
                        where: and(
                            eq(interventionOccupancies.baseId, otherBaseOccupancy.baseId),
                            isNull(interventionOccupancies.boardStartedAt),
                            isNull(interventionOccupancies.endedAt),
                        ),
                        orderBy: [asc(interventionOccupancies.startedAt)],
                    });

                    if (replacement && replacement.startedAt.getTime() <= otherCloseAt.getTime()) {
                        await tx.update(interventionOccupancies)
                            .set({
                                boardStartedAt: otherCloseAt,
                                updatedByUserId: input.createdByUserId ?? null,
                                updatedAt: new Date(),
                            })
                            .where(eq(interventionOccupancies.id, replacement.id));
                    }
                }

                await syncInterventionBankHours(tx, otherBaseOccupancy.id);
                closedPreviousBaseId = otherBaseOccupancy.baseId;
            }

            if (!resolvedContinuityGroupId && shouldInheritContinuityFromOtherBaseOccupancy({
                otherBaseStartedAt: otherBaseOccupancy.startedAt,
                eventAt: input.startedAt,
            })) {
                resolvedContinuityGroupId = otherBaseOccupancy.continuityGroupId;
            }
        }

        // Cross-domain cleanup: close open regulation occupancy when doctor moves to an intervention base.
        // Symmetric counterpart to the same guard in startRegulationOccupancy.
        const otherRegulationOccupancy = await tx.query.regulationOccupancies.findFirst({
            where: and(
                eq(regulationOccupancies.doctorId, input.doctorId),
                isNull(regulationOccupancies.endedAt),
            ),
            orderBy: [desc(regulationOccupancies.startedAt)],
        });
        const shouldPreserveCrossRegulation = Boolean(
            historicalCorrectionEndAt
            && otherRegulationOccupancy
            && input.startedAt.getTime() < otherRegulationOccupancy.startedAt.getTime(),
        );
        if (otherRegulationOccupancy && !shouldPreserveCrossRegulation) {
            const crossCloseMs = input.startedAt.getTime() - otherRegulationOccupancy.startedAt.getTime();
            if (crossCloseMs >= 60_000) {
                await tx.update(regulationOccupancies)
                    .set({
                        endedAt: input.startedAt,
                        actualEndedAt: otherRegulationOccupancy.actualEndedAt ?? input.startedAt,
                        updatedByUserId: input.createdByUserId ?? null,
                        updatedAt: new Date(),
                    })
                    .where(eq(regulationOccupancies.id, otherRegulationOccupancy.id));
                await syncRegulationBankHours(tx, otherRegulationOccupancy.id);
            }
        }

        const currentBoardCarrier = await tx.query.interventionOccupancies.findFirst({
            where: and(
                eq(interventionOccupancies.baseId, input.baseId),
                isNotNull(interventionOccupancies.boardStartedAt),
                isNull(interventionOccupancies.endedAt),
            ),
            orderBy: [desc(interventionOccupancies.boardStartedAt), desc(interventionOccupancies.startedAt)],
        });
        const { shouldTakeBoardImmediately } = resolveInterventionArrivalBoardPolicy({
            source: input.source,
            isShadow: input.isShadow ?? false,
            hasCurrentBoardCarrier: Boolean(currentBoardCarrier),
        });

        const shouldPreserveCurrentBoardCarrier = Boolean(
            historicalCorrectionEndAt
            && currentBoardCarrier
            && input.startedAt.getTime() < currentBoardCarrier.startedAt.getTime(),
        );

        if (shouldTakeBoardImmediately && currentBoardCarrier && !shouldPreserveCurrentBoardCarrier) {
            const shouldCloseCurrentBoardCarrier = shouldCloseInterventionBoardCarrierOnArrival({
                currentCarrierDoctorId: currentBoardCarrier.doctorId,
                arrivingDoctorId: input.doctorId,
                currentCarrierNotes: currentBoardCarrier.notes,
            });
            const takeoverAt = resolveSafeInterventionHandoffAt({
                sourceStartedAt: currentBoardCarrier.startedAt,
                requestedAt: input.startedAt,
            });

            // P2: guard against zero-duration occupancies caused by retroactive or duplicate arrivals.
            if (!takeoverAt && shouldCloseCurrentBoardCarrier) {
                throw new Error("arrival_conflicts_with_active_occupancy");
            }

            if (takeoverAt && shouldCloseCurrentBoardCarrier) {
                await tx.update(interventionOccupancies)
                    .set({
                        endedAt: takeoverAt,
                        actualEndedAt: takeoverAt,
                        updatedByUserId: input.createdByUserId ?? null,
                        updatedAt: new Date(),
                    })
                    .where(eq(interventionOccupancies.id, currentBoardCarrier.id));

                await syncInterventionBankHours(tx, currentBoardCarrier.id);
            }
        }

        const [created] = await tx.insert(interventionOccupancies).values({
            doctorId: input.doctorId,
            baseId: input.baseId,
            continuityGroupId: resolvedContinuityGroupId ?? randomUUID(),
            scheduledStartAt: inferredScheduledStartAt,
            scheduledEndAt: inferredScheduledEndAt,
            startedAt: input.startedAt,
            boardStartedAt: shouldTakeBoardImmediately && !currentBoardCarrier ? effectiveBoardStartedAt : null,
            shiftLabel: normalizedShiftLabel,
            roleLabel: applyOperationalRoleShiftPolicy({
                shiftLabel: normalizedShiftLabel === "SD" || normalizedShiftLabel === "SN" || normalizedShiftLabel === "P"
                    ? normalizedShiftLabel
                    : null,
                roleLabel: defaultDoctorRoleLabel,
            }),
            source: input.source,
            notes: input.notes ?? null,
            endedAt: historicalCorrectionEndAt,
            actualEndedAt: historicalCorrectionEndAt,
            createdByUserId: input.createdByUserId ?? null,
            updatedByUserId: input.createdByUserId ?? null,
        }).returning();

        if (shouldTakeBoardImmediately && !historicalCorrectionEndAt) {
            await tx.update(interventionOccupancies)
                .set({
                    boardStartedAt: null,
                    updatedByUserId: input.createdByUserId ?? null,
                    updatedAt: new Date(),
                })
                .where(and(
                    eq(interventionOccupancies.baseId, input.baseId),
                    isNull(interventionOccupancies.endedAt),
                ));

            await tx.update(interventionOccupancies)
                .set({
                    boardStartedAt: input.boardStartedAt ?? input.startedAt,
                    updatedByUserId: input.createdByUserId ?? null,
                    updatedAt: new Date(),
                })
                .where(eq(interventionOccupancies.id, created.id));
        }

        if (historicalCorrectionEndAt) {
            await syncInterventionBankHours(tx, created.id);
        }

        return created;
    });

    publishBoardUpdate(`intervention:start:${input.baseId}`);
    if (closedPreviousBaseId) {
        publishBoardUpdate(`intervention:end:${closedPreviousBaseId}`);
    }
    if (autoReactivated) {
        publishBoardUpdate(`intervention:reactivate:${input.baseId}`);
    }
    return { ...created, autoReactivated };
}

export async function deactivateInterventionBase(input: DeactivateInterventionBaseInput) {
    await assertInterventionBaseExists(input.baseId);

    const db = getDb();
    const result = await db.transaction(async (tx) => {
        const activeDeactivation = await findActiveInterventionBaseDeactivation(tx, {
            baseId: input.baseId,
            referenceAt: input.deactivatedAt,
            updatedByUserId: input.createdByUserId ?? null,
        });

        if (activeDeactivation) {
            throw new Error("Esta base já está desativada.");
        }

        const openOccupancies = await tx.query.interventionOccupancies.findMany({
            where: and(
                eq(interventionOccupancies.baseId, input.baseId),
                isNull(interventionOccupancies.endedAt),
            ),
            orderBy: [asc(interventionOccupancies.startedAt)],
        });

        const [created] = await tx.insert(interventionBaseDeactivations).values({
            baseId: input.baseId,
            deactivatedAt: input.deactivatedAt,
            notes: input.notes ?? null,
            createdByUserId: input.createdByUserId ?? null,
            updatedByUserId: input.createdByUserId ?? null,
        }).returning();

        const closedOccupancyIds: string[] = [];
        for (const occupancy of openOccupancies) {
            const endedAt = clampOccupancyEndAt(occupancy.startedAt, input.deactivatedAt);

            await tx.update(interventionOccupancies)
                .set({
                    endedAt,
                    actualEndedAt: endedAt,
                    updatedByUserId: input.createdByUserId ?? null,
                    updatedAt: new Date(),
                })
                .where(eq(interventionOccupancies.id, occupancy.id));

            await syncInterventionBankHours(tx, occupancy.id);
            closedOccupancyIds.push(occupancy.id);
        }

        return {
            state: created,
            closedOccupancyIds,
        };
    });

    publishBoardUpdate(`intervention:deactivate:${input.baseId}`);
    return result;
}

export async function endInterventionOccupancy(
    id: string,
    input: { endedAt: Date; actualEndedAt?: Date | null; chiefConfirmed?: boolean; handoffClosure?: boolean },
    updatedByUserId?: string | null,
) {
    const db = getDb();
    const updated = await db.transaction(async (tx) => {
        const existing = await tx.query.interventionOccupancies.findFirst({
            where: eq(interventionOccupancies.id, id),
        });

        if (!existing) {
            throw new Error("Intervention occupancy not found.");
        }

        // Fechamento por rendição: grava só endedAt e deixa actualEndedAt nulo, para que o banco
        // feche autoritativamente no horário do handoff sem cair na fila de confirmação do chefe.
        // Um aviso de saída tardia posterior (ocorrência) preenche actualEndedAt e aí sim exige confirmação.
        const actualEndedAt = input.handoffClosure ? null : (input.actualEndedAt ?? input.endedAt);
        if (actualEndedAt && actualEndedAt.getTime() < existing.startedAt.getTime()) {
            throw new Error("Actual end cannot be before the recorded arrival.");
        }

        const now = new Date();
        const departureConfirmedAt = input.chiefConfirmed ? now : existing.departureConfirmedAt;
        const departureConfirmedByUserId = input.chiefConfirmed
            ? (updatedByUserId ?? null)
            : existing.departureConfirmedByUserId;

        const [updated] = await tx
            .update(interventionOccupancies)
            .set({
                endedAt: input.endedAt,
                actualEndedAt,
                updatedByUserId: updatedByUserId ?? null,
                updatedAt: now,
                departureConfirmedAt,
                departureConfirmedByUserId,
            })
            .where(eq(interventionOccupancies.id, id))
            .returning();

        const replacement = await tx.query.interventionOccupancies.findFirst({
            where: and(
                eq(interventionOccupancies.baseId, existing.baseId),
                isNull(interventionOccupancies.boardStartedAt),
                isNull(interventionOccupancies.endedAt),
            ),
            orderBy: [asc(interventionOccupancies.startedAt)],
        });

        if (replacement && replacement.startedAt.getTime() <= input.endedAt.getTime()) {
            await tx.update(interventionOccupancies)
                .set({
                    boardStartedAt: input.endedAt,
                    updatedByUserId: updatedByUserId ?? null,
                    updatedAt: new Date(),
                })
                .where(eq(interventionOccupancies.id, replacement.id));
        }

        await syncInterventionBankHours(tx, id);
        return updated;
    });

    publishBoardUpdate(`intervention:end:${id}`);
    return updated;
}

export async function expireStaleShadowInterventionOccupancies(referenceAt: Date, updatedByUserId?: string | null) {
    const db = getDb();
    const [openOccupancies, dayOnlyBaseRows] = await Promise.all([
        db.query.interventionOccupancies.findMany({
            where: isNull(interventionOccupancies.endedAt),
            orderBy: [asc(interventionOccupancies.scheduledEndAt), asc(interventionOccupancies.startedAt)],
        }),
        db.query.interventionBases.findMany({
            where: eq(interventionBases.dayOnly, true),
            columns: { id: true },
        }),
    ]);
    const dayOnlyBaseIds = new Set(dayOnlyBaseRows.map((row) => row.id));

    let expiredCount = 0;
    for (const occupancy of openOccupancies) {
        const endedAt = resolveStaleShadowInterventionEndedAt({
            notes: occupancy.notes,
            scheduledEndAt: occupancy.scheduledEndAt,
            endedAt: occupancy.endedAt,
            referenceAt,
        }) ?? resolveDayOnlyBaseAutoCloseEndedAt({
            dayOnly: dayOnlyBaseIds.has(occupancy.baseId),
            scheduledEndAt: occupancy.scheduledEndAt,
            endedAt: occupancy.endedAt,
            referenceAt,
        });

        if (!endedAt) {
            continue;
        }

        // Stale shadow cleanup is system-initiated; no verbalized late departure
        // to audit. Auto-confirm so credit flows without a chief review queue
        // backlogged with stale entries.
        await endInterventionOccupancy(occupancy.id, {
            endedAt,
            actualEndedAt: endedAt,
            chiefConfirmed: true,
        }, updatedByUserId ?? null);
        expiredCount += 1;
    }

    return expiredCount;
}

export async function continueInterventionOccupancy(
    id: string,
    input?: { notes?: string | null; continuedAt?: Date | null },
    updatedByUserId?: string | null,
) {
    const db = getDb();
    const updated = await db.transaction(async (tx) => {
        const existing = await tx.query.interventionOccupancies.findFirst({
            where: eq(interventionOccupancies.id, id),
        });

        if (!existing) {
            throw new Error("Intervention occupancy not found.");
        }

        if (existing.endedAt) {
            throw new Error("Only active intervention occupancies can be continued.");
        }

        const base = await tx.query.interventionBases.findFirst({
            where: eq(interventionBases.id, existing.baseId),
            columns: { dayOnly: true },
        });
        if (base?.dayOnly) {
            throw new Error("Base diurna não gera plantão contínuo (P); a chegada seguinte deve ser um novo plantão SD.");
        }

        const nextNotes = input?.notes?.trim()
            ? input.notes.trim()
            : existing.notes;
        const baseShiftLabel = existing.shiftLabel && existing.shiftLabel !== "P"
            ? existing.shiftLabel
            : resolveOperationalShiftWindow(existing.startedAt).shiftLabel;
        const inferredScheduledStartAt = existing.scheduledStartAt
            ?? inferOperationalScheduledStartAt(existing.startedAt, baseShiftLabel, null);
        const continuationAt = input?.continuedAt ?? new Date();
        const nextScheduledEndAt = resolveInterventionContinuationScheduledEndAt({
            existingScheduledEndAt: existing.scheduledEndAt,
            continuationAt,
        });
        const nextBoardStartedAt = resolveContinuationBoardStartedAt({
            startedAt: existing.startedAt,
            boardStartedAt: existing.boardStartedAt,
            continuedAt: continuationAt,
        });

        const [updated] = await tx
            .update(interventionOccupancies)
            .set({
                boardStartedAt: nextBoardStartedAt,
                shiftLabel: "P",
                scheduledStartAt: inferredScheduledStartAt,
                scheduledEndAt: nextScheduledEndAt,
                notes: nextNotes ?? null,
                updatedByUserId: updatedByUserId ?? null,
                updatedAt: new Date(),
            })
            .where(eq(interventionOccupancies.id, id))
            .returning();

        await syncInterventionBankHours(tx, id);
        return updated;
    });

    publishBoardUpdate(`intervention:continue:${id}`);
    return updated;
}

export async function reactivateInterventionBase(input: ReactivateInterventionBaseInput) {
    await assertInterventionBaseExists(input.baseId);

    const db = getDb();
    const result = await db.transaction(async (tx) => {
        const reactivatedAt = input.reactivatedAt ?? new Date();
        const activeDeactivation = await findActiveInterventionBaseDeactivation(tx, {
            baseId: input.baseId,
            referenceAt: reactivatedAt,
            updatedByUserId: input.updatedByUserId ?? null,
        });

        if (!activeDeactivation) {
            throw new Error("Esta base não está desativada.");
        }

        if (reactivatedAt.getTime() < activeDeactivation.deactivatedAt.getTime()) {
            throw new Error("A reativação não pode ser anterior à desativação.");
        }

        const [updated] = await tx.update(interventionBaseDeactivations)
            .set({
                reactivatedAt,
                updatedByUserId: input.updatedByUserId ?? null,
                updatedAt: new Date(),
            })
            .where(eq(interventionBaseDeactivations.id, activeDeactivation.id))
            .returning();

        return updated;
    });

    publishBoardUpdate(`intervention:reactivate:${input.baseId}`);
    return result;
}

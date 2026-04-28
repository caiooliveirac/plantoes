import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, isNull, isNotNull, lte, ne } from "drizzle-orm";
import { getDb } from "@/db";
import { doctors, interventionBaseDeactivations, interventionBases, interventionOccupancies, regulationOccupancies } from "@/db/schema";
import { extractDoctorPreferredOperationalRole } from "@/modules/doctors/directory";
import { publishBoardUpdate } from "@/lib/board-live";
import { syncInterventionBankHours } from "@/modules/bank-hours/service";
import { resolveArrivalShiftLabel, resolveOperationalShiftWindow } from "@/modules/operational/board-rules";
import { inferInterventionCoverageWindow, inferOperationalScheduledStartAt } from "@/modules/operational/rules";

type Executor = any;
const AUTO_CONTINUITY_RECENT_CLOSED_WINDOW_MS = 2 * 60 * 60 * 1000;
const MIN_SAFE_OCCUPANCY_DURATION_MS = 60 * 1000;

export interface StartInterventionOccupancyInput {
    doctorId: string;
    baseId: number;
    continuityGroupId?: string | null;
    previousOccupancyId?: string | null;
    isContinuityEntry?: boolean;
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
            // Auto-reactivate: doctor arrival implicitly reactivates the base
            await tx.update(interventionBaseDeactivations)
                .set({
                    reactivatedAt: input.startedAt,
                    updatedByUserId: input.createdByUserId ?? null,
                    updatedAt: new Date(),
                })
                .where(eq(interventionBaseDeactivations.id, activeDeactivation.id));
            autoReactivated = true;
        }
        const existing = await tx.query.interventionOccupancies.findFirst({
            where: and(
                eq(interventionOccupancies.baseId, input.baseId),
                isNull(interventionOccupancies.endedAt),
            ),
        });

        // Same doctor on same base: update in place instead of close+create.
        if (existing && existing.doctorId === input.doctorId) {
            // Preserve the earliest boardStartedAt — but only if it belongs to the current
            // operational shift context. A stale anchor from a past shift would cause the
            // occupancy to be invisible on the board (board-rules visibility check would expire it).
            const currentShiftStart = resolveOperationalShiftWindow(input.startedAt).startedAt;
            const PRE_SHIFT_TOLERANCE_MS = 60 * 60 * 1000;
            const existingAnchorIsStale = existing.boardStartedAt!.getTime() < (currentShiftStart.getTime() - PRE_SHIFT_TOLERANCE_MS);
            const keptBoardStartedAt = (existingAnchorIsStale || effectiveBoardStartedAt.getTime() < existing.boardStartedAt!.getTime())
                ? effectiveBoardStartedAt
                : existing.boardStartedAt!;

            const keptContinuityGroupId = resolvedContinuityGroupId ?? existing.continuityGroupId;

            // F2 safety: never allow started_at to advance forward past the existing value.
            const keptStartedAt = input.startedAt.getTime() < existing.startedAt.getTime()
                ? input.startedAt
                : existing.startedAt;

            const windowRef = keptBoardStartedAt.getTime() > keptStartedAt.getTime()
                ? keptBoardStartedAt : keptStartedAt;
            const { scheduledStartAt: recalcStart, scheduledEndAt: recalcEnd } = inferInterventionCoverageWindow({
                startedAt: windowRef,
                shiftLabel: input.shiftLabel ?? existing.shiftLabel,
                explicitScheduledStartAt: null,
                explicitScheduledEndAt: null,
            });

            const [updated] = await tx.update(interventionOccupancies)
                .set({
                    startedAt: keptStartedAt,
                    boardStartedAt: keptBoardStartedAt,
                    continuityGroupId: keptContinuityGroupId,
                    scheduledStartAt: recalcStart,
                    scheduledEndAt: recalcEnd,
                    shiftLabel: input.shiftLabel ?? existing.shiftLabel,
                    roleLabel: input.roleLabel !== undefined ? input.roleLabel : existing.roleLabel,
                    notes: input.notes ? `${existing.notes ?? ""}\n${input.notes}`.trim() : existing.notes,
                    updatedByUserId: input.createdByUserId ?? null,
                    updatedAt: new Date(),
                })
                .where(eq(interventionOccupancies.id, existing.id))
                .returning();

            await syncInterventionBankHours(tx, existing.id);
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

            if (!resolvedContinuityGroupId) {
                resolvedContinuityGroupId = otherBaseOccupancy.continuityGroupId;
            }
        }

        const shouldTakeBoardImmediately = input.source !== "import";
        const currentBoardCarrier = existing?.boardStartedAt ? existing : await tx.query.interventionOccupancies.findFirst({
            where: and(
                eq(interventionOccupancies.baseId, input.baseId),
                isNotNull(interventionOccupancies.boardStartedAt),
                isNull(interventionOccupancies.endedAt),
            ),
            orderBy: [desc(interventionOccupancies.boardStartedAt), desc(interventionOccupancies.startedAt)],
        });

        const shouldPreserveCurrentBoardCarrier = Boolean(
            historicalCorrectionEndAt
            && currentBoardCarrier
            && input.startedAt.getTime() < currentBoardCarrier.startedAt.getTime(),
        );

        if (shouldTakeBoardImmediately && currentBoardCarrier && !shouldPreserveCurrentBoardCarrier) {
            const takeoverAt = resolveSafeInterventionHandoffAt({
                sourceStartedAt: currentBoardCarrier.startedAt,
                requestedAt: input.startedAt,
            });

            // P2: guard against zero-duration occupancies caused by retroactive or duplicate arrivals.
            if (!takeoverAt && currentBoardCarrier.doctorId !== input.doctorId) {
                throw new Error("arrival_conflicts_with_active_occupancy");
            }

            if (takeoverAt && currentBoardCarrier.doctorId !== input.doctorId) {
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
            boardStartedAt: shouldTakeBoardImmediately || !existing ? effectiveBoardStartedAt : null,
            shiftLabel: normalizedShiftLabel,
            roleLabel: defaultDoctorRoleLabel ?? null,
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
    input: { endedAt: Date; actualEndedAt?: Date | null },
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

        const actualEndedAt = input.actualEndedAt ?? input.endedAt;
        if (actualEndedAt.getTime() < existing.startedAt.getTime()) {
            throw new Error("Actual end cannot be before the recorded arrival.");
        }

        const [updated] = await tx
            .update(interventionOccupancies)
            .set({
                endedAt: input.endedAt,
                actualEndedAt,
                updatedByUserId: updatedByUserId ?? null,
                updatedAt: new Date(),
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

        const nextNotes = input?.notes?.trim()
            ? input.notes.trim()
            : existing.notes;
        const baseShiftLabel = existing.shiftLabel && existing.shiftLabel !== "P"
            ? existing.shiftLabel
            : resolveOperationalShiftWindow(existing.startedAt).shiftLabel;
        const inferredScheduledStartAt = existing.scheduledStartAt
            ?? inferOperationalScheduledStartAt(existing.startedAt, baseShiftLabel, null);
        const continuationAt = input?.continuedAt ?? new Date();
        const continuationBoundary = resolveOperationalShiftWindow(continuationAt).nextBoundaryAt;
        const nextScheduledEndAt = existing.scheduledEndAt && existing.scheduledEndAt.getTime() > continuationBoundary.getTime()
            ? existing.scheduledEndAt
            : continuationBoundary;
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

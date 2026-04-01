import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, isNull, isNotNull } from "drizzle-orm";
import { getDb } from "@/db";
import { interventionBaseDeactivations, interventionBases, interventionOccupancies } from "@/db/schema";
import { publishBoardUpdate } from "@/lib/board-live";
import { syncInterventionBankHours } from "@/modules/bank-hours/service";
import { resolveOperationalShiftWindow } from "@/modules/operational/board-rules";
import { inferInterventionCoverageWindow, inferOperationalScheduledStartAt } from "@/modules/operational/rules";

type Executor = any;

export interface StartInterventionOccupancyInput {
    doctorId: string;
    baseId: number;
    continuityGroupId?: string | null;
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

export function resolveContinuationBoardStartedAt(params: {
    startedAt: Date;
    boardStartedAt?: Date | null;
    continuedAt: Date;
}) {
    const currentBoardStartedAt = params.boardStartedAt ?? params.startedAt;
    const continuationShiftStart = resolveOperationalShiftWindow(params.continuedAt).startedAt;
    return continuationShiftStart.getTime() > currentBoardStartedAt.getTime()
        ? continuationShiftStart
        : currentBoardStartedAt;
}

function clampOccupancyEndAt(startedAt: Date, endedAt: Date) {
    return endedAt.getTime() < startedAt.getTime() ? startedAt : endedAt;
}

export function resolveInterventionBaseDeactivationExpiresAt(deactivatedAt: Date) {
    return resolveOperationalShiftWindow(deactivatedAt).nextBoundaryAt;
}

export function isInterventionBaseDeactivationActive(params: {
    deactivatedAt: Date;
    reactivatedAt?: Date | null;
    referenceAt: Date;
}) {
    if (params.referenceAt.getTime() < params.deactivatedAt.getTime()) {
        return false;
    }

    const expiresAt = resolveInterventionBaseDeactivationExpiresAt(params.deactivatedAt);
    const effectiveEndAt = params.reactivatedAt && params.reactivatedAt.getTime() < expiresAt.getTime()
        ? params.reactivatedAt
        : expiresAt;

    return params.referenceAt.getTime() < effectiveEndAt.getTime();
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
    await tx.update(interventionBaseDeactivations)
        .set({
            reactivatedAt: params.expiredAt,
            updatedByUserId: params.updatedByUserId ?? null,
            updatedAt: new Date(),
        })
        .where(eq(interventionBaseDeactivations.id, params.deactivationId));
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
        ),
        orderBy: [desc(interventionBaseDeactivations.deactivatedAt)],
    });

    if (!openDeactivation) {
        return null;
    }

    if (isInterventionBaseDeactivationActive({
        deactivatedAt: openDeactivation.deactivatedAt,
        reactivatedAt: openDeactivation.reactivatedAt,
        referenceAt: params.referenceAt,
    })) {
        return openDeactivation;
    }

    await closeExpiredInterventionBaseDeactivation(tx, {
        deactivationId: openDeactivation.id,
        expiredAt: resolveInterventionBaseDeactivationExpiresAt(openDeactivation.deactivatedAt),
        updatedByUserId: params.updatedByUserId ?? null,
    });

    return null;
}

export async function expireInterventionBaseDeactivations(referenceAt: Date, updatedByUserId?: string | null) {
    const db = getDb();
    return db.transaction(async (tx) => {
        const openDeactivations = await tx.query.interventionBaseDeactivations.findMany({
            where: isNull(interventionBaseDeactivations.reactivatedAt),
            orderBy: [asc(interventionBaseDeactivations.deactivatedAt)],
        });

        let expiredCount = 0;
        for (const deactivation of openDeactivations) {
            if (isInterventionBaseDeactivationActive({
                deactivatedAt: deactivation.deactivatedAt,
                reactivatedAt: deactivation.reactivatedAt,
                referenceAt,
            })) {
                continue;
            }

            await closeExpiredInterventionBaseDeactivation(tx, {
                deactivationId: deactivation.id,
                expiredAt: resolveInterventionBaseDeactivationExpiresAt(deactivation.deactivatedAt),
                updatedByUserId: updatedByUserId ?? null,
            });
            expiredCount += 1;
        }

        return expiredCount;
    });
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
    const created = await db.transaction(async (tx) => {
        const normalizedShiftLabel = input.shiftLabel ?? resolveOperationalShiftWindow(input.startedAt).shiftLabel;
        const { scheduledStartAt: inferredScheduledStartAt, scheduledEndAt: inferredScheduledEndAt } = inferInterventionCoverageWindow({
            startedAt: input.startedAt,
            shiftLabel: normalizedShiftLabel,
            explicitScheduledStartAt: input.scheduledStartAt ?? null,
            explicitScheduledEndAt: input.scheduledEndAt ?? null,
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
            throw new Error("Base desativada. Reative a USA antes de abrir nova cobertura.");
        }
        const existing = await tx.query.interventionOccupancies.findFirst({
            where: and(
                eq(interventionOccupancies.baseId, input.baseId),
                isNull(interventionOccupancies.endedAt),
            ),
        });

        const shouldTakeBoardImmediately = input.source !== "import";
        const currentBoardCarrier = existing?.boardStartedAt ? existing : await tx.query.interventionOccupancies.findFirst({
            where: and(
                eq(interventionOccupancies.baseId, input.baseId),
                isNotNull(interventionOccupancies.boardStartedAt),
                isNull(interventionOccupancies.endedAt),
            ),
            orderBy: [desc(interventionOccupancies.boardStartedAt), desc(interventionOccupancies.startedAt)],
        });

        if (shouldTakeBoardImmediately && currentBoardCarrier) {
            const takeoverAt = input.startedAt.getTime() >= currentBoardCarrier.startedAt.getTime()
                ? input.startedAt
                : currentBoardCarrier.startedAt;

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

        const [created] = await tx.insert(interventionOccupancies).values({
            doctorId: input.doctorId,
            baseId: input.baseId,
            continuityGroupId: input.continuityGroupId ?? randomUUID(),
            scheduledStartAt: inferredScheduledStartAt,
            scheduledEndAt: inferredScheduledEndAt,
            startedAt: input.startedAt,
            boardStartedAt: shouldTakeBoardImmediately || !existing ? (input.boardStartedAt ?? input.startedAt) : null,
            shiftLabel: normalizedShiftLabel,
            roleLabel: input.roleLabel ?? null,
            source: input.source,
            notes: input.notes ?? null,
            createdByUserId: input.createdByUserId ?? null,
            updatedByUserId: input.createdByUserId ?? null,
        }).returning();

        if (shouldTakeBoardImmediately) {
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

        return created;
    });

    publishBoardUpdate(`intervention:start:${input.baseId}`);
    return created;
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

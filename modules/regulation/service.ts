import { randomUUID } from "node:crypto";
import { and, desc, eq, isNull, lte } from "drizzle-orm";
import { getDb } from "@/db";
import { regulationOccupancies } from "@/db/schema";
import { publishBoardUpdate } from "@/lib/board-live";
import { syncRegulationBankHours } from "@/modules/bank-hours/service";
import { resolveOperationalShiftWindow } from "@/modules/operational/board-rules";
import { inferOperationalScheduledStartAt, inferRegulationCoverageWindow, resolveRegulationBoardEndAt } from "@/modules/operational/rules";

export interface StartRegulationOccupancyInput {
    doctorId: string;
    postId: number;
    continuityGroupId?: string | null;
    startedAt: Date;
    scheduledStartAt?: Date | null;
    scheduledEndAt?: Date | null;
    shiftLabel?: string | null;
    roleLabel?: string | null;
    ramalLabel?: string | null;
    source: "manual" | "telegram" | "import" | "admin_correction";
    notes?: string | null;
    createdByUserId?: string | null;
}

function resolveRegulationContinuationBoardStartedAt(params: {
    startedAt: Date;
    boardStartedAt: Date;
    continuedAt: Date;
}) {
    const continuationShiftStart = resolveOperationalShiftWindow(params.continuedAt).startedAt;
    return continuationShiftStart.getTime() > params.boardStartedAt.getTime()
        ? continuationShiftStart
        : params.boardStartedAt;
}

export async function startRegulationOccupancy(input: StartRegulationOccupancyInput) {
    const db = getDb();
    const created = await db.transaction(async (tx) => {
        const { scheduledStartAt: inferredScheduledStartAt, scheduledEndAt: inferredScheduledEndAt } = inferRegulationCoverageWindow({
            startedAt: input.startedAt,
            shiftLabel: input.shiftLabel ?? null,
            explicitScheduledStartAt: input.scheduledStartAt ?? null,
            explicitScheduledEndAt: input.scheduledEndAt ?? null,
        });

        const duplicated = await tx.query.regulationOccupancies.findFirst({
            where: and(
                eq(regulationOccupancies.postId, input.postId),
                eq(regulationOccupancies.doctorId, input.doctorId),
                eq(regulationOccupancies.startedAt, input.startedAt),
                isNull(regulationOccupancies.endedAt),
            ),
        });

        if (duplicated && (duplicated.shiftLabel ?? null) === (input.shiftLabel ?? null)) {
            return duplicated;
        }

        const existing = await tx.query.regulationOccupancies.findFirst({
            where: and(
                eq(regulationOccupancies.postId, input.postId),
                lte(regulationOccupancies.startedAt, input.startedAt),
                isNull(regulationOccupancies.endedAt),
            ),
            orderBy: [desc(regulationOccupancies.startedAt)],
        });

        if (existing) {
            const boardEndedAt = resolveRegulationBoardEndAt(input.startedAt, existing.scheduledEndAt);
            await tx.update(regulationOccupancies)
                .set({
                    endedAt: boardEndedAt,
                    actualEndedAt: existing.actualEndedAt ?? boardEndedAt,
                    updatedByUserId: input.createdByUserId ?? null,
                    updatedAt: new Date(),
                })
                .where(eq(regulationOccupancies.id, existing.id));

            await syncRegulationBankHours(tx, existing.id);
        }

        const [created] = await tx.insert(regulationOccupancies).values({
            doctorId: input.doctorId,
            postId: input.postId,
            continuityGroupId: input.continuityGroupId ?? randomUUID(),
            scheduledStartAt: inferredScheduledStartAt,
            scheduledEndAt: inferredScheduledEndAt,
            startedAt: input.startedAt,
            boardStartedAt: input.startedAt,
            shiftLabel: input.shiftLabel ?? null,
            roleLabel: input.roleLabel ?? null,
            ramalLabel: input.ramalLabel ?? null,
            source: input.source,
            notes: input.notes ?? null,
            createdByUserId: input.createdByUserId ?? null,
            updatedByUserId: input.createdByUserId ?? null,
        }).returning();

        return created;
    });

    publishBoardUpdate(`regulation:start:${input.postId}`);
    return created;
}

export async function continueRegulationOccupancy(
    id: string,
    input?: { notes?: string | null; continuedAt?: Date | null },
    updatedByUserId?: string | null,
) {
    const db = getDb();
    const updated = await db.transaction(async (tx) => {
        const existing = await tx.query.regulationOccupancies.findFirst({
            where: eq(regulationOccupancies.id, id),
        });

        if (!existing) {
            throw new Error("Regulation occupancy not found.");
        }

        if (existing.endedAt) {
            throw new Error("Only active regulation occupancies can be continued.");
        }

        const nextNotes = input?.notes?.trim()
            ? input.notes.trim()
            : existing.notes;
        const baseShiftLabel = existing.shiftLabel && existing.shiftLabel !== "P"
            ? existing.shiftLabel
            : resolveOperationalShiftWindow(existing.startedAt).shiftLabel;
        const inferredScheduledStartAt = existing.scheduledStartAt
            ?? inferOperationalScheduledStartAt(existing.startedAt, baseShiftLabel, null);
        const { scheduledEndAt: nextScheduledEndAt } = inferRegulationCoverageWindow({
            startedAt: existing.startedAt,
            shiftLabel: "P",
            explicitScheduledStartAt: inferredScheduledStartAt,
            explicitScheduledEndAt: existing.scheduledEndAt,
        });
        const continuationAt = input?.continuedAt ?? new Date();
        const nextBoardStartedAt = resolveRegulationContinuationBoardStartedAt({
            startedAt: existing.startedAt,
            boardStartedAt: existing.boardStartedAt,
            continuedAt: continuationAt,
        });

        const [updated] = await tx.update(regulationOccupancies)
            .set({
                boardStartedAt: nextBoardStartedAt,
                shiftLabel: "P",
                scheduledStartAt: inferredScheduledStartAt,
                scheduledEndAt: nextScheduledEndAt,
                notes: nextNotes ?? null,
                updatedByUserId: updatedByUserId ?? null,
                updatedAt: new Date(),
            })
            .where(eq(regulationOccupancies.id, id))
            .returning();

        await syncRegulationBankHours(tx, id);
        return updated;
    });

    publishBoardUpdate(`regulation:continue:${id}`);
    return updated;
}

export async function endRegulationOccupancy(
    id: string,
    input: { endedAt: Date; actualEndedAt?: Date | null },
    updatedByUserId?: string | null,
) {
    const db = getDb();
    const updated = await db.transaction(async (tx) => {
        const existing = await tx.query.regulationOccupancies.findFirst({
            where: eq(regulationOccupancies.id, id),
        });

        if (!existing) {
            throw new Error("Regulation occupancy not found.");
        }

        const boardEndedAt = resolveRegulationBoardEndAt(input.endedAt, existing.scheduledEndAt);
        const actualEndedAt = input.actualEndedAt ?? input.endedAt;
        if (actualEndedAt.getTime() < existing.startedAt.getTime()) {
            throw new Error("Actual end cannot be before the recorded arrival.");
        }

        const [updated] = await tx
            .update(regulationOccupancies)
            .set({
                endedAt: boardEndedAt,
                actualEndedAt,
                updatedByUserId: updatedByUserId ?? null,
                updatedAt: new Date(),
            })
            .where(eq(regulationOccupancies.id, id))
            .returning();

        await syncRegulationBankHours(tx, id);
        return updated;
    });

    publishBoardUpdate(`regulation:end:${id}`);
    return updated;
}

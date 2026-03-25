import { and, asc, desc, eq, isNull, isNotNull } from "drizzle-orm";
import { getDb } from "@/db";
import { interventionOccupancies } from "@/db/schema";
import { syncInterventionBankHours } from "@/modules/bank-hours/service";

export interface StartInterventionOccupancyInput {
    doctorId: string;
    baseId: number;
    startedAt: Date;
    scheduledStartAt?: Date | null;
    scheduledEndAt?: Date | null;
    shiftLabel?: string | null;
    roleLabel?: string | null;
    source: "manual" | "telegram" | "import" | "admin_correction";
    notes?: string | null;
    createdByUserId?: string | null;
}

export async function startInterventionOccupancy(input: StartInterventionOccupancyInput) {
    const db = getDb();
    return db.transaction(async (tx) => {
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
            scheduledStartAt: input.scheduledStartAt ?? null,
            scheduledEndAt: input.scheduledEndAt ?? null,
            startedAt: input.startedAt,
            boardStartedAt: shouldTakeBoardImmediately || !existing ? input.startedAt : null,
            shiftLabel: input.shiftLabel ?? null,
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
                    boardStartedAt: input.startedAt,
                    updatedByUserId: input.createdByUserId ?? null,
                    updatedAt: new Date(),
                })
                .where(eq(interventionOccupancies.id, created.id));
        }

        return created;
    });
}

export async function endInterventionOccupancy(
    id: string,
    input: { endedAt: Date; actualEndedAt?: Date | null },
    updatedByUserId?: string | null,
) {
    const db = getDb();
    return db.transaction(async (tx) => {
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
}

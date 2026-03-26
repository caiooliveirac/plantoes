import { and, desc, eq, isNull, lte } from "drizzle-orm";
import { getDb } from "@/db";
import { regulationOccupancies } from "@/db/schema";
import { syncRegulationBankHours } from "@/modules/bank-hours/service";
import { inferOperationalScheduledStartAt, inferRegulationScheduledEndAt, resolveRegulationBoardEndAt } from "@/modules/operational/rules";

export interface StartRegulationOccupancyInput {
    doctorId: string;
    postId: number;
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

export async function startRegulationOccupancy(input: StartRegulationOccupancyInput) {
    const db = getDb();
    return db.transaction(async (tx) => {
        const inferredScheduledStartAt = inferOperationalScheduledStartAt(
            input.startedAt,
            input.shiftLabel ?? null,
            input.scheduledStartAt ?? null,
        );
        const inferredScheduledEndAt = inferRegulationScheduledEndAt(
            input.startedAt,
            input.shiftLabel ?? null,
            input.scheduledEndAt ?? null,
        );

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
}

export async function endRegulationOccupancy(
    id: string,
    input: { endedAt: Date; actualEndedAt?: Date | null },
    updatedByUserId?: string | null,
) {
    const db = getDb();
    return db.transaction(async (tx) => {
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
}

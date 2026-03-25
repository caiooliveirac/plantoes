import { and, asc, desc, eq, isNull } from "drizzle-orm";
import { getDb } from "@/db";
import { bankHoursEntries, interventionOccupancies, regulationOccupancies } from "@/db/schema";
import { syncInterventionBankHours, syncRegulationBankHours } from "@/modules/bank-hours/service";

type OptionalDate = Date | null | undefined;
type Executor = any;

export interface RegulationOccupancyCorrectionInput {
    doctorId?: string;
    startedAt?: Date;
    boardStartedAt?: Date;
    endedAt?: OptionalDate;
    actualEndedAt?: OptionalDate;
    shiftLabel?: string | null;
    roleLabel?: string | null;
    ramalLabel?: string | null;
    notes?: string | null;
}

export interface InterventionOccupancyCorrectionInput {
    doctorId?: string;
    startedAt?: Date;
    boardStartedAt?: OptionalDate;
    endedAt?: OptionalDate;
    actualEndedAt?: OptionalDate;
    shiftLabel?: string | null;
    roleLabel?: string | null;
    notes?: string | null;
}

function hasOwn<T extends object, K extends PropertyKey>(value: T, key: K): value is T & Record<K, unknown> {
    return Object.prototype.hasOwnProperty.call(value, key);
}

function validateChronology(startedAt: Date, boardStartedAt: Date | null, endedAt: Date | null, actualEndedAt: Date | null) {
    if (boardStartedAt && boardStartedAt.getTime() < startedAt.getTime()) {
        throw new Error("Board start cannot be before the recorded arrival.");
    }
    if (endedAt && endedAt.getTime() < startedAt.getTime()) {
        throw new Error("Board end cannot be before the recorded arrival.");
    }
    if (actualEndedAt && actualEndedAt.getTime() < startedAt.getTime()) {
        throw new Error("Actual end cannot be before the recorded arrival.");
    }
    if (endedAt && boardStartedAt && endedAt.getTime() < boardStartedAt.getTime()) {
        throw new Error("Board end cannot be before the board start.");
    }
}

async function reconcileInterventionBoardState(tx: Executor, baseId: number, updatedByUserId?: string | null) {
    const openOccupancies: Array<typeof interventionOccupancies.$inferSelect> = await tx.query.interventionOccupancies.findMany({
        where: and(
            eq(interventionOccupancies.baseId, baseId),
            isNull(interventionOccupancies.endedAt),
        ),
        orderBy: [asc(interventionOccupancies.startedAt)],
    });

    if (openOccupancies.length === 0) {
        return;
    }

    const currentCarrier = openOccupancies.find((occupancy) => occupancy.boardStartedAt !== null) ?? null;
    if (currentCarrier) {
        for (const occupancy of openOccupancies) {
            const nextBoardStartedAt = occupancy.id === currentCarrier.id ? occupancy.boardStartedAt : null;
            if ((occupancy.boardStartedAt?.getTime() ?? null) !== (nextBoardStartedAt?.getTime() ?? null)) {
                await tx.update(interventionOccupancies)
                    .set({
                        boardStartedAt: nextBoardStartedAt,
                        updatedAt: new Date(),
                        updatedByUserId: updatedByUserId ?? null,
                    })
                    .where(eq(interventionOccupancies.id, occupancy.id));
            }
        }
        return;
    }

    const latestEnded: typeof interventionOccupancies.$inferSelect | undefined = await tx.query.interventionOccupancies.findFirst({
        where: and(
            eq(interventionOccupancies.baseId, baseId),
        ),
        orderBy: [desc(interventionOccupancies.endedAt), asc(interventionOccupancies.startedAt)],
    });

    const nextCarrier = latestEnded?.endedAt
        ? openOccupancies.find((occupancy) => occupancy.startedAt.getTime() <= latestEnded.endedAt!.getTime()) ?? openOccupancies[0]
        : openOccupancies[0];

    for (const occupancy of openOccupancies) {
        const nextBoardStartedAt = occupancy.id === nextCarrier.id
            ? latestEnded?.endedAt ?? occupancy.startedAt
            : null;
        if ((occupancy.boardStartedAt?.getTime() ?? null) !== (nextBoardStartedAt?.getTime() ?? null)) {
            await tx.update(interventionOccupancies)
                .set({
                    boardStartedAt: nextBoardStartedAt,
                    updatedAt: new Date(),
                    updatedByUserId: updatedByUserId ?? null,
                })
                .where(eq(interventionOccupancies.id, occupancy.id));
        }
    }
}

export async function correctRegulationOccupancy(
    id: string,
    input: RegulationOccupancyCorrectionInput,
    updatedByUserId?: string | null,
) {
    const db = getDb();
    return db.transaction(async (tx) => {
        const existing = await tx.query.regulationOccupancies.findFirst({ where: eq(regulationOccupancies.id, id) });
        if (!existing) {
            throw new Error("Regulation occupancy not found.");
        }

        const startedAt = hasOwn(input, "startedAt") ? input.startedAt as Date : existing.startedAt;
        const boardStartedAt = hasOwn(input, "boardStartedAt") ? input.boardStartedAt as Date : existing.boardStartedAt;
        const endedAt = hasOwn(input, "endedAt") ? (input.endedAt ?? null) : existing.endedAt;
        const actualEndedAt = hasOwn(input, "actualEndedAt") ? (input.actualEndedAt ?? null) : existing.actualEndedAt;

        validateChronology(startedAt, boardStartedAt, endedAt, actualEndedAt);

        const [updated] = await tx.update(regulationOccupancies)
            .set({
                doctorId: hasOwn(input, "doctorId") ? input.doctorId ?? existing.doctorId : existing.doctorId,
                startedAt,
                boardStartedAt,
                endedAt,
                actualEndedAt,
                shiftLabel: hasOwn(input, "shiftLabel") ? input.shiftLabel ?? null : existing.shiftLabel,
                roleLabel: hasOwn(input, "roleLabel") ? input.roleLabel ?? null : existing.roleLabel,
                ramalLabel: hasOwn(input, "ramalLabel") ? input.ramalLabel ?? null : existing.ramalLabel,
                notes: hasOwn(input, "notes") ? input.notes ?? null : existing.notes,
                updatedByUserId: updatedByUserId ?? null,
                updatedAt: new Date(),
            })
            .where(eq(regulationOccupancies.id, id))
            .returning();

        await syncRegulationBankHours(tx, id);
        return updated;
    });
}

export async function correctInterventionOccupancy(
    id: string,
    input: InterventionOccupancyCorrectionInput,
    updatedByUserId?: string | null,
) {
    const db = getDb();
    return db.transaction(async (tx) => {
        const existing = await tx.query.interventionOccupancies.findFirst({ where: eq(interventionOccupancies.id, id) });
        if (!existing) {
            throw new Error("Intervention occupancy not found.");
        }

        const startedAt = hasOwn(input, "startedAt") ? input.startedAt as Date : existing.startedAt;
        const boardStartedAt = hasOwn(input, "boardStartedAt") ? (input.boardStartedAt ?? null) : existing.boardStartedAt;
        const endedAt = hasOwn(input, "endedAt") ? (input.endedAt ?? null) : existing.endedAt;
        const actualEndedAt = hasOwn(input, "actualEndedAt") ? (input.actualEndedAt ?? null) : existing.actualEndedAt;

        validateChronology(startedAt, boardStartedAt, endedAt, actualEndedAt);

        const [updated] = await tx.update(interventionOccupancies)
            .set({
                doctorId: hasOwn(input, "doctorId") ? input.doctorId ?? existing.doctorId : existing.doctorId,
                startedAt,
                boardStartedAt,
                endedAt,
                actualEndedAt,
                shiftLabel: hasOwn(input, "shiftLabel") ? input.shiftLabel ?? null : existing.shiftLabel,
                roleLabel: hasOwn(input, "roleLabel") ? input.roleLabel ?? null : existing.roleLabel,
                notes: hasOwn(input, "notes") ? input.notes ?? null : existing.notes,
                updatedByUserId: updatedByUserId ?? null,
                updatedAt: new Date(),
            })
            .where(eq(interventionOccupancies.id, id))
            .returning();

        await reconcileInterventionBoardState(tx, existing.baseId, updatedByUserId);
        await syncInterventionBankHours(tx, id);
        return updated;
    });
}

export async function removeRegulationOccupancyRecord(id: string, updatedByUserId?: string | null) {
    const db = getDb();
    return db.transaction(async (tx) => {
        const existing = await tx.query.regulationOccupancies.findFirst({ where: eq(regulationOccupancies.id, id) });
        if (!existing) {
            throw new Error("Regulation occupancy not found.");
        }

        await tx.delete(bankHoursEntries).where(eq(bankHoursEntries.regulationOccupancyId, id));
        const [deleted] = await tx.delete(regulationOccupancies)
            .where(eq(regulationOccupancies.id, id))
            .returning();

        return {
            ...deleted,
            updatedByUserId: updatedByUserId ?? null,
        };
    });
}

export async function removeInterventionOccupancyRecord(id: string, updatedByUserId?: string | null) {
    const db = getDb();
    return db.transaction(async (tx) => {
        const existing = await tx.query.interventionOccupancies.findFirst({ where: eq(interventionOccupancies.id, id) });
        if (!existing) {
            throw new Error("Intervention occupancy not found.");
        }

        await tx.delete(bankHoursEntries).where(eq(bankHoursEntries.interventionOccupancyId, id));
        const [deleted] = await tx.delete(interventionOccupancies)
            .where(eq(interventionOccupancies.id, id))
            .returning();

        await reconcileInterventionBoardState(tx, existing.baseId, updatedByUserId);
        return {
            ...deleted,
            updatedByUserId: updatedByUserId ?? null,
        };
    });
}
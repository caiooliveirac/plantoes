import { and, eq, isNull } from "drizzle-orm";
import { BANK_HOURS_RULE_VERSION, calculateBankHours } from "@/modules/bank-hours/calculator";
import { bankHoursEntries, interventionOccupancies, regulationOccupancies } from "@/db/schema";

type Executor = any;

function shouldSyncEntry(occupancy: {
    doctorId: string;
    startedAt: Date;
    scheduledStartAt: Date | null;
    scheduledEndAt: Date | null;
    actualEndedAt: Date | null;
}) {
    return Boolean(
        occupancy.scheduledStartAt
        && occupancy.scheduledEndAt
        && occupancy.actualEndedAt,
    );
}

async function upsertRegulationBankHours(db: Executor, occupancy: typeof regulationOccupancies.$inferSelect) {
    const existing = await db.query.bankHoursEntries.findFirst({
        where: eq(bankHoursEntries.regulationOccupancyId, occupancy.id),
    });

    if (!shouldSyncEntry(occupancy)) {
        if (existing) {
            await db.delete(bankHoursEntries).where(eq(bankHoursEntries.id, existing.id));
        }
        return null;
    }

    const calculation = calculateBankHours({
        scheduledStartAt: occupancy.scheduledStartAt as Date,
        scheduledEndAt: occupancy.scheduledEndAt as Date,
        actualStartAt: occupancy.startedAt,
        actualEndAt: occupancy.actualEndedAt as Date,
    });

    const values = {
        doctorId: occupancy.doctorId,
        sourceType: "regulation" as const,
        regulationOccupancyId: occupancy.id,
        interventionOccupancyId: null,
        scheduledStartAt: occupancy.scheduledStartAt as Date,
        scheduledEndAt: occupancy.scheduledEndAt as Date,
        actualStartAt: occupancy.startedAt,
        actualEndAt: occupancy.actualEndedAt as Date,
        arrivalDelayMinutes: calculation.arrivalDelayMinutes,
        overtimeMinutes: calculation.overtimeMinutes,
        overtimeMultiplier: calculation.overtimeMultiplier,
        creditedOvertimeMinutes: calculation.creditedOvertimeMinutes,
        balanceMinutes: calculation.balanceMinutes,
        ruleCode: calculation.ruleCode,
        calculationVersion: BANK_HOURS_RULE_VERSION,
        explanation: calculation.explanation,
        updatedAt: new Date(),
    };

    if (existing) {
        const [updated] = await db.update(bankHoursEntries)
            .set(values)
            .where(eq(bankHoursEntries.id, existing.id))
            .returning();
        return updated;
    }

    const [created] = await db.insert(bankHoursEntries)
        .values(values)
        .returning();
    return created;
}

async function upsertInterventionBankHours(db: Executor, occupancy: typeof interventionOccupancies.$inferSelect) {
    const existing = await db.query.bankHoursEntries.findFirst({
        where: eq(bankHoursEntries.interventionOccupancyId, occupancy.id),
    });

    if (!shouldSyncEntry(occupancy)) {
        if (existing) {
            await db.delete(bankHoursEntries).where(eq(bankHoursEntries.id, existing.id));
        }
        return null;
    }

    const calculation = calculateBankHours({
        scheduledStartAt: occupancy.scheduledStartAt as Date,
        scheduledEndAt: occupancy.scheduledEndAt as Date,
        actualStartAt: occupancy.startedAt,
        actualEndAt: occupancy.actualEndedAt as Date,
    });

    const values = {
        doctorId: occupancy.doctorId,
        sourceType: "intervention" as const,
        regulationOccupancyId: null,
        interventionOccupancyId: occupancy.id,
        scheduledStartAt: occupancy.scheduledStartAt as Date,
        scheduledEndAt: occupancy.scheduledEndAt as Date,
        actualStartAt: occupancy.startedAt,
        actualEndAt: occupancy.actualEndedAt as Date,
        arrivalDelayMinutes: calculation.arrivalDelayMinutes,
        overtimeMinutes: calculation.overtimeMinutes,
        overtimeMultiplier: calculation.overtimeMultiplier,
        creditedOvertimeMinutes: calculation.creditedOvertimeMinutes,
        balanceMinutes: calculation.balanceMinutes,
        ruleCode: calculation.ruleCode,
        calculationVersion: BANK_HOURS_RULE_VERSION,
        explanation: calculation.explanation,
        updatedAt: new Date(),
    };

    if (existing) {
        const [updated] = await db.update(bankHoursEntries)
            .set(values)
            .where(eq(bankHoursEntries.id, existing.id))
            .returning();
        return updated;
    }

    const [created] = await db.insert(bankHoursEntries)
        .values(values)
        .returning();
    return created;
}

export async function syncRegulationBankHours(db: Executor, occupancyId: string) {
    const occupancy = await db.query.regulationOccupancies.findFirst({
        where: eq(regulationOccupancies.id, occupancyId),
    });

    if (!occupancy) {
        return null;
    }

    return upsertRegulationBankHours(db, occupancy);
}

export async function syncInterventionBankHours(db: Executor, occupancyId: string) {
    const occupancy = await db.query.interventionOccupancies.findFirst({
        where: eq(interventionOccupancies.id, occupancyId),
    });

    if (!occupancy) {
        return null;
    }

    return upsertInterventionBankHours(db, occupancy);
}

export async function findActiveInterventionBoardOccupancy(db: Executor, baseId: number) {
    return db.query.interventionOccupancies.findFirst({
        where: and(
            eq(interventionOccupancies.baseId, baseId),
            isNull(interventionOccupancies.endedAt),
        ),
        orderBy: (fields: typeof interventionOccupancies, operators: { asc: (value: unknown) => unknown }) => [
            operators.asc(fields.boardStartedAt),
            operators.asc(fields.startedAt),
        ],
    });
}
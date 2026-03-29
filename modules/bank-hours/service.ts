import { and, eq, inArray, isNull } from "drizzle-orm";
import { BANK_HOURS_RULE_VERSION, calculateBankHours } from "@/modules/bank-hours/calculator";
import { buildContinuityBankHoursSpan } from "@/modules/bank-hours/continuity";
import { bankHoursEntries, interventionOccupancies, regulationOccupancies } from "@/db/schema";

type Executor = any;

async function listContinuityGroupOccupancies(db: Executor, continuityGroupId: string) {
    const [regulation, intervention] = await Promise.all([
        db.query.regulationOccupancies.findMany({
            where: eq(regulationOccupancies.continuityGroupId, continuityGroupId),
        }),
        db.query.interventionOccupancies.findMany({
            where: eq(interventionOccupancies.continuityGroupId, continuityGroupId),
        }),
    ]);

    return [
        ...regulation.map((occupancy: typeof regulationOccupancies.$inferSelect) => ({
            occupancyId: occupancy.id,
            domain: "regulation" as const,
            doctorId: occupancy.doctorId,
            continuityGroupId: occupancy.continuityGroupId,
            startedAt: occupancy.startedAt,
            endedAt: occupancy.endedAt,
            actualEndedAt: occupancy.actualEndedAt,
            scheduledStartAt: occupancy.scheduledStartAt,
            scheduledEndAt: occupancy.scheduledEndAt,
            shiftLabel: occupancy.shiftLabel,
        })),
        ...intervention.map((occupancy: typeof interventionOccupancies.$inferSelect) => ({
            occupancyId: occupancy.id,
            domain: "intervention" as const,
            doctorId: occupancy.doctorId,
            continuityGroupId: occupancy.continuityGroupId,
            startedAt: occupancy.startedAt,
            endedAt: occupancy.endedAt,
            actualEndedAt: occupancy.actualEndedAt,
            scheduledStartAt: occupancy.scheduledStartAt,
            scheduledEndAt: occupancy.scheduledEndAt,
            shiftLabel: occupancy.shiftLabel,
        })),
    ];
}

async function deleteContinuityGroupBankHours(db: Executor, occupancyIds: Array<{ domain: "regulation" | "intervention"; occupancyId: string }>) {
    const regulationIds = occupancyIds
        .filter((occupancy) => occupancy.domain === "regulation")
        .map((occupancy) => occupancy.occupancyId);
    const interventionIds = occupancyIds
        .filter((occupancy) => occupancy.domain === "intervention")
        .map((occupancy) => occupancy.occupancyId);

    if (regulationIds.length > 0) {
        await db.delete(bankHoursEntries).where(inArray(bankHoursEntries.regulationOccupancyId, regulationIds));
    }

    if (interventionIds.length > 0) {
        await db.delete(bankHoursEntries).where(inArray(bankHoursEntries.interventionOccupancyId, interventionIds));
    }
}

export async function syncBankHoursByContinuityGroup(db: Executor, continuityGroupId: string) {
    const occupancies = await listContinuityGroupOccupancies(db, continuityGroupId);
    if (occupancies.length === 0) {
        return null;
    }

    await deleteContinuityGroupBankHours(db, occupancies.map((occupancy) => ({
        domain: occupancy.domain,
        occupancyId: occupancy.occupancyId,
    })));

    const span = buildContinuityBankHoursSpan(occupancies);
    if (!span.isClosed || !span.scheduledStartAt || !span.scheduledEndAt || !span.actualEndAt) {
        return null;
    }

    const calculation = calculateBankHours({
        scheduledStartAt: span.scheduledStartAt,
        scheduledEndAt: span.scheduledEndAt,
        actualStartAt: span.actualStartAt,
        actualEndAt: span.actualEndAt,
    });

    const [created] = await db.insert(bankHoursEntries)
        .values({
            doctorId: span.doctorId,
            sourceType: span.carrierDomain,
            regulationOccupancyId: span.carrierDomain === "regulation" ? span.carrierOccupancyId : null,
            interventionOccupancyId: span.carrierDomain === "intervention" ? span.carrierOccupancyId : null,
            scheduledStartAt: span.scheduledStartAt,
            scheduledEndAt: span.scheduledEndAt,
            actualStartAt: span.actualStartAt,
            actualEndAt: span.actualEndAt,
            arrivalDelayMinutes: calculation.arrivalDelayMinutes,
            overtimeMinutes: calculation.overtimeMinutes,
            overtimeMultiplier: calculation.overtimeMultiplier,
            creditedOvertimeMinutes: calculation.creditedOvertimeMinutes,
            balanceMinutes: calculation.balanceMinutes,
            ruleCode: calculation.ruleCode,
            calculationVersion: BANK_HOURS_RULE_VERSION,
            explanation: calculation.explanation,
            updatedAt: new Date(),
        })
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

    return syncBankHoursByContinuityGroup(db, occupancy.continuityGroupId);
}

export async function syncInterventionBankHours(db: Executor, occupancyId: string) {
    const occupancy = await db.query.interventionOccupancies.findFirst({
        where: eq(interventionOccupancies.id, occupancyId),
    });

    if (!occupancy) {
        return null;
    }

    return syncBankHoursByContinuityGroup(db, occupancy.continuityGroupId);
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
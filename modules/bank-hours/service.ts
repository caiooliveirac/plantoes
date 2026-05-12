import { and, eq, inArray, isNull } from "drizzle-orm";
import { BANK_HOURS_RULE_VERSION, applyAnomalyGuard, calculateBankHours } from "@/modules/bank-hours/calculator";
import { buildContinuityBankHoursSpan } from "@/modules/bank-hours/continuity";
import { getDb } from "@/db";
import { bankHoursBalanceOverrides, bankHoursEntries, doctors, interventionOccupancies, regulationOccupancies } from "@/db/schema";
import { extractDoctorPreferredOperationalRole } from "@/modules/doctors/directory";

type Executor = any;

/**
 * Detects phantom zero-duration occupancies created by the Telegram board-takeover
 * pipeline where started_at = ended_at and no real work was performed (actualEndedAt
 * also equals startedAt or is absent). Occupancies where actualEndedAt differs from
 * startedAt represent real work and must NOT be filtered.
 */
function isTrueZeroDuration(occupancy: {
    startedAt: string | Date;
    endedAt?: string | Date | null;
    actualEndedAt?: string | Date | null;
}): boolean {
    if (!occupancy.endedAt) return false;
    const startMs = new Date(occupancy.startedAt).getTime();
    const endMs = new Date(occupancy.endedAt).getTime();
    if (startMs !== endMs) return false;
    const effectiveEndMs = occupancy.actualEndedAt
        ? new Date(occupancy.actualEndedAt).getTime()
        : endMs;
    return effectiveEndMs === startMs;
}

export interface BankHoursBalanceOverrideSummary {
    continuityGroupId: string;
    doctorId: string;
    balanceMinutes: number;
    notes: string;
    createdByUserId: string | null;
    updatedByUserId: string | null;
    createdAt: Date;
    updatedAt: Date;
}

export const MANUAL_BANK_HOURS_OVERRIDE_RULE_CODE = "MANUAL_BANK_OVERRIDE";

function formatSignedMinutes(value: number) {
    const sign = value > 0 ? "+" : value < 0 ? "-" : "";
    return `${sign}${Math.abs(value)} min`;
}

export function buildBankHoursBalanceOverrideExplanation(params: {
    balanceMinutes: number;
    notes: string;
    automaticBalanceMinutes: number | null;
}) {
    const automaticPart = params.automaticBalanceMinutes === null
        ? ""
        : ` Saldo automatico original: ${formatSignedMinutes(params.automaticBalanceMinutes)}.`;

    return `Saldo ajustado manualmente para ${formatSignedMinutes(params.balanceMinutes)}.${automaticPart} Motivo: ${params.notes.trim()}`;
}

export async function listBankHoursBalanceOverridesByContinuityGroupIds(
    db: Executor,
    continuityGroupIds: string[],
): Promise<Map<string, BankHoursBalanceOverrideSummary>> {
    const normalizedIds = [...new Set(continuityGroupIds.filter(Boolean))];
    if (normalizedIds.length === 0) {
        return new Map<string, BankHoursBalanceOverrideSummary>();
    }

    const rows = await db.query.bankHoursBalanceOverrides.findMany({
        where: inArray(bankHoursBalanceOverrides.continuityGroupId, normalizedIds),
    });

    return new Map(rows.map((row: typeof bankHoursBalanceOverrides.$inferSelect) => [
        row.continuityGroupId,
        {
            continuityGroupId: row.continuityGroupId,
            doctorId: row.doctorId,
            balanceMinutes: row.balanceMinutes,
            notes: row.notes,
            createdByUserId: row.createdByUserId,
            updatedByUserId: row.updatedByUserId,
            createdAt: row.createdAt,
            updatedAt: row.updatedAt,
        } satisfies BankHoursBalanceOverrideSummary,
    ]));
}

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

async function isPiamPreferredDoctorBankHours(db: Executor, doctorId: string) {
    const doctor = await db.query.doctors.findFirst({
        where: eq(doctors.id, doctorId),
        columns: { metadata: true },
    });
    return doctor ? extractDoctorPreferredOperationalRole(doctor.metadata) === "PIAM" : false;
}

export async function syncBankHoursByContinuityGroup(db: Executor, continuityGroupId: string) {
    const occupancies = await listContinuityGroupOccupancies(db, continuityGroupId);
    if (occupancies.length === 0) {
        return null;
    }

    // Always delete stale entries for the full set (including zero-duration artifacts)
    await deleteContinuityGroupBankHours(db, occupancies.map((occupancy) => ({
        domain: occupancy.domain,
        occupancyId: occupancy.occupancyId,
    })));

    // PIAM cardiologists are remunerated by closed-shift flat rate and explicitly do not
    // accumulate banco de horas: delete any stale entry and skip recalculation.
    const piamDoctorIds = new Set<string>();
    for (const doctorId of new Set(occupancies.map((o) => o.doctorId))) {
        if (await isPiamPreferredDoctorBankHours(db, doctorId)) {
            piamDoctorIds.add(doctorId);
        }
    }
    if (piamDoctorIds.size > 0 && occupancies.every((o) => piamDoctorIds.has(o.doctorId))) {
        return null;
    }

    // Filter out phantom zero-duration occupancies before calculating bank hours.
    // These are artifacts from the Telegram board-takeover pipeline — they carry no
    // actual work and must not generate bank hours entries.
    const meaningful = occupancies.filter((o) => !isTrueZeroDuration(o));
    if (meaningful.length === 0) {
        return null;
    }

    const span = buildContinuityBankHoursSpan(meaningful);
    if (!span.isClosed || !span.scheduledStartAt || !span.scheduledEndAt || !span.actualEndAt) {
        return null;
    }

    const rawCalculation = calculateBankHours({
        scheduledStartAt: span.scheduledStartAt,
        scheduledEndAt: span.scheduledEndAt,
        actualStartAt: span.actualStartAt,
        actualEndAt: span.actualEndAt,
    });
    const calculation = applyAnomalyGuard(rawCalculation);
    const override = (await listBankHoursBalanceOverridesByContinuityGroupIds(db, [continuityGroupId])).get(continuityGroupId) ?? null;
    const balanceMinutes = override?.balanceMinutes ?? calculation.balanceMinutes;
    const ruleCode = override ? MANUAL_BANK_HOURS_OVERRIDE_RULE_CODE : calculation.ruleCode;
    const explanation = override
        ? buildBankHoursBalanceOverrideExplanation({
            balanceMinutes: override.balanceMinutes,
            notes: override.notes,
            automaticBalanceMinutes: calculation.balanceMinutes,
        })
        : calculation.explanation;

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
            balanceMinutes,
            ruleCode,
            calculationVersion: BANK_HOURS_RULE_VERSION,
            explanation,
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

async function resolveOccupancyOverrideTarget(db: Executor, params: {
    domain: "regulation" | "intervention";
    occupancyId: string;
}) {
    if (params.domain === "regulation") {
        const occupancy = await db.query.regulationOccupancies.findFirst({
            where: eq(regulationOccupancies.id, params.occupancyId),
        });
        if (!occupancy) {
            throw new Error("Regulation occupancy not found.");
        }

        return {
            continuityGroupId: occupancy.continuityGroupId,
            doctorId: occupancy.doctorId,
        };
    }

    const occupancy = await db.query.interventionOccupancies.findFirst({
        where: eq(interventionOccupancies.id, params.occupancyId),
    });
    if (!occupancy) {
        throw new Error("Intervention occupancy not found.");
    }

    return {
        continuityGroupId: occupancy.continuityGroupId,
        doctorId: occupancy.doctorId,
    };
}

export async function applyBankHoursBalanceOverride(params: {
    domain: "regulation" | "intervention";
    occupancyId: string;
    balanceMinutes: number;
    notes: string;
    actorUserId?: string | null;
}) {
    const db = getDb();
    return db.transaction(async (tx) => {
        const target = await resolveOccupancyOverrideTarget(tx, {
            domain: params.domain,
            occupancyId: params.occupancyId,
        });
        const occupancies = await listContinuityGroupOccupancies(tx, target.continuityGroupId);
        if (occupancies.length === 0) {
            throw new Error("Nao encontrei o grupo de continuidade desse plantao.");
        }

        const span = buildContinuityBankHoursSpan(occupancies);
        if (!span.isClosed || !span.actualEndAt || !span.scheduledStartAt || !span.scheduledEndAt) {
            throw new Error("Esse plantao ainda nao tem fechamento suficiente para ajuste manual do banco.");
        }

        const [saved] = await tx.insert(bankHoursBalanceOverrides)
            .values({
                continuityGroupId: target.continuityGroupId,
                doctorId: target.doctorId,
                balanceMinutes: params.balanceMinutes,
                notes: params.notes.trim(),
                createdByUserId: params.actorUserId ?? null,
                updatedByUserId: params.actorUserId ?? null,
                updatedAt: new Date(),
            })
            .onConflictDoUpdate({
                target: bankHoursBalanceOverrides.continuityGroupId,
                set: {
                    doctorId: target.doctorId,
                    balanceMinutes: params.balanceMinutes,
                    notes: params.notes.trim(),
                    updatedByUserId: params.actorUserId ?? null,
                    updatedAt: new Date(),
                },
            })
            .returning();

        const bankEntry = await syncBankHoursByContinuityGroup(tx, target.continuityGroupId);

        return {
            override: saved,
            bankEntry,
            continuityGroupId: target.continuityGroupId,
            doctorId: target.doctorId,
        };
    });
}
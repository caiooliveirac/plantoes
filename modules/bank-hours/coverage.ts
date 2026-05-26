import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { interventionOccupancies } from "@/db/schema";
import { syncBankHoursByContinuityGroup } from "@/modules/bank-hours/service";

export const INTERVENTION_COVERAGE_KIND = "COBERTURA";

export const COVERAGE_PROMPT_THRESHOLD_MINUTES = 120;

export interface InterventionCoverageActor {
    userId: string | null;
    telegramId?: string | null;
    label?: string | null;
}

export interface InterventionCoverageMarkResult {
    occupancyId: string;
    doctorId: string;
    baseId: number;
    coverageKind: string;
    coverageNote: string | null;
    coverageMarkedAt: Date;
    coverageMarkedByUserId: string | null;
    arrivalDelayMinutes: number;
}

function diffMinutes(start: Date, end: Date) {
    return Math.max(0, Math.trunc((end.getTime() - start.getTime()) / 60000));
}

export function resolveInterventionArrivalDelayMinutes(occupancy: {
    scheduledStartAt: Date | string | null;
    startedAt: Date | string;
}): number {
    if (!occupancy.scheduledStartAt) {
        return 0;
    }
    return diffMinutes(
        new Date(occupancy.scheduledStartAt),
        new Date(occupancy.startedAt),
    );
}

/**
 * Marks an intervention occupancy as COBERTURA and triggers a recalculation of
 * its bank_hours_entry. The arrival delay stays in the audit trail; the balance
 * stops being debited.
 *
 * No-op (returns the existing snapshot) if the occupancy is already marked as
 * coverage. The caller can detect this by comparing coverageMarkedAt against
 * the value before the call.
 */
export async function markInterventionAsCoverage(params: {
    occupancyId: string;
    note?: string | null;
    actor: InterventionCoverageActor;
}): Promise<InterventionCoverageMarkResult> {
    const db = getDb();
    const occupancy = await db.query.interventionOccupancies.findFirst({
        where: eq(interventionOccupancies.id, params.occupancyId),
    });

    if (!occupancy) {
        throw new Error(`Intervention occupancy ${params.occupancyId} not found`);
    }

    const arrivalDelayMinutes = resolveInterventionArrivalDelayMinutes(occupancy);
    const now = new Date();
    const coverageNote = params.note?.trim() || null;

    if (occupancy.coverageKind) {
        return {
            occupancyId: occupancy.id,
            doctorId: occupancy.doctorId,
            baseId: occupancy.baseId,
            coverageKind: occupancy.coverageKind,
            coverageNote: occupancy.coverageNote,
            coverageMarkedAt: occupancy.coverageMarkedAt ?? now,
            coverageMarkedByUserId: occupancy.coverageMarkedByUserId,
            arrivalDelayMinutes,
        };
    }

    await db.update(interventionOccupancies)
        .set({
            coverageKind: INTERVENTION_COVERAGE_KIND,
            coverageNote,
            coverageMarkedByUserId: params.actor.userId,
            coverageMarkedAt: now,
            updatedAt: now,
            updatedByUserId: params.actor.userId ?? occupancy.updatedByUserId,
        })
        .where(eq(interventionOccupancies.id, params.occupancyId));

    await syncBankHoursByContinuityGroup(db, occupancy.continuityGroupId);

    return {
        occupancyId: occupancy.id,
        doctorId: occupancy.doctorId,
        baseId: occupancy.baseId,
        coverageKind: INTERVENTION_COVERAGE_KIND,
        coverageNote,
        coverageMarkedAt: now,
        coverageMarkedByUserId: params.actor.userId,
        arrivalDelayMinutes,
    };
}

/**
 * Removes the COBERTURA flag from an intervention occupancy and recalculates
 * the bank_hours_entry under normal rules.
 */
export async function unmarkInterventionAsCoverage(params: {
    occupancyId: string;
    actor: InterventionCoverageActor;
}): Promise<{ occupancyId: string; wasCoverage: boolean }> {
    const db = getDb();
    const occupancy = await db.query.interventionOccupancies.findFirst({
        where: eq(interventionOccupancies.id, params.occupancyId),
    });

    if (!occupancy) {
        throw new Error(`Intervention occupancy ${params.occupancyId} not found`);
    }

    if (!occupancy.coverageKind) {
        return { occupancyId: occupancy.id, wasCoverage: false };
    }

    const now = new Date();
    await db.update(interventionOccupancies)
        .set({
            coverageKind: null,
            coverageNote: null,
            coverageMarkedByUserId: null,
            coverageMarkedAt: null,
            updatedAt: now,
            updatedByUserId: params.actor.userId ?? occupancy.updatedByUserId,
        })
        .where(eq(interventionOccupancies.id, params.occupancyId));

    await syncBankHoursByContinuityGroup(db, occupancy.continuityGroupId);

    return { occupancyId: occupancy.id, wasCoverage: true };
}

export function formatCoverageDelayLabel(minutes: number): string {
    if (minutes <= 0) {
        return "sem atraso";
    }
    const hours = Math.floor(minutes / 60);
    const mins = minutes % 60;
    if (hours === 0) {
        return `${mins} min`;
    }
    if (mins === 0) {
        return hours === 1 ? "1 hora" : `${hours} horas`;
    }
    return `${hours}h${mins.toString().padStart(2, "0")}min`;
}

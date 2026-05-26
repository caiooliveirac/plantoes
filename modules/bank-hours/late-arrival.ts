import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { interventionOccupancies } from "@/db/schema";
import { syncBankHoursByContinuityGroup } from "@/modules/bank-hours/service";

/** Coordination rule: intervention SD doctors who arrive at or after this
 *  local hour (America/Bahia) are eligible for half-shift recognition. */
export const LATE_HALF_SHIFT_CUTOFF_HOUR = 9;

/** Canonical half-shift window (America/Bahia) when an SD arrival is
 *  acknowledged: pays 13:00–19:00, anything before 13:00 is carryover. */
export const LATE_HALF_SHIFT_PAY_START_HOUR = 13;
export const LATE_HALF_SHIFT_PAY_END_HOUR = 19;

export interface LateArrivalActor {
    userId: string | null;
    telegramId?: string | null;
    label?: string | null;
}

export interface LateArrivalAcknowledgementResult {
    occupancyId: string;
    doctorId: string;
    baseId: number;
    actualStartAt: Date;
    newScheduledStartAt: Date;
    newScheduledEndAt: Date;
    carryoverMinutes: number;
    acknowledgedAt: Date;
    acknowledgedByUserId: string | null;
}

function bahiaDateParts(date: Date): { year: number; month: number; day: number } {
    const parts = new Intl.DateTimeFormat("en-CA", {
        timeZone: "America/Bahia",
        year: "numeric", month: "2-digit", day: "2-digit",
    }).formatToParts(date);
    const y = Number(parts.find((p) => p.type === "year")?.value);
    const m = Number(parts.find((p) => p.type === "month")?.value);
    const d = Number(parts.find((p) => p.type === "day")?.value);
    return { year: y, month: m, day: d };
}

/** Build a UTC Date matching `year-month-day hour:minute` in America/Bahia.
 *  Bahia has no DST, so the offset is a stable −03:00 — but we still derive
 *  the offset from the date to keep this robust. */
function bahiaLocalAt(year: number, month: number, day: number, hour: number, minute: number): Date {
    // First guess UTC ignoring offset, then read what the formatter reports for
    // that instant in Bahia and shift by the delta. Bahia = UTC−3 stably.
    const guess = new Date(Date.UTC(year, month - 1, day, hour + 3, minute, 0));
    return guess;
}

export function resolveLateHalfShiftWindowFor(startedAt: Date): {
    scheduledStartAt: Date;
    scheduledEndAt: Date;
} {
    const parts = bahiaDateParts(startedAt);
    return {
        scheduledStartAt: bahiaLocalAt(parts.year, parts.month, parts.day, LATE_HALF_SHIFT_PAY_START_HOUR, 0),
        scheduledEndAt: bahiaLocalAt(parts.year, parts.month, parts.day, LATE_HALF_SHIFT_PAY_END_HOUR, 0),
    };
}

/** Bahia-local hour at which the intervention started (used to decide if
 *  the >= 9h cutoff was hit). */
export function resolveBahiaHour(date: Date): number {
    const parts = new Intl.DateTimeFormat("en-CA", {
        timeZone: "America/Bahia",
        hour: "2-digit",
        hour12: false,
    }).formatToParts(date);
    const hourPart = parts.find((p) => p.type === "hour")?.value ?? "0";
    return Number(hourPart);
}

export function isLateHalfShiftCandidate(occupancy: {
    shiftLabel: string | null;
    startedAt: Date | string;
    lateArrivalAcknowledgedAt?: Date | string | null;
}): boolean {
    if (occupancy.lateArrivalAcknowledgedAt) {
        return false;
    }
    const startedAt = occupancy.startedAt instanceof Date ? occupancy.startedAt : new Date(occupancy.startedAt);
    const hour = resolveBahiaHour(startedAt);
    if (hour < LATE_HALF_SHIFT_CUTOFF_HOUR) {
        return false;
    }
    // Diurnal window: between cutoff (9h) and 18h (Bahia). Beyond 18h the
    // arrival is most likely a SN/P case and the rule does not apply.
    return hour < 18;
}

/** Acknowledges a SD intervention arrival as a late-half-shift case. Converts
 *  scheduled window to 13:00–19:00 (Bahia local), sets role_label to
 *  MEIO_PLANTAO, stamps the acknowledgement metadata and triggers recalc. */
export async function acknowledgeInterventionLateArrival(params: {
    occupancyId: string;
    note?: string | null;
    actor: LateArrivalActor;
}): Promise<LateArrivalAcknowledgementResult> {
    const db = getDb();
    const occupancy = await db.query.interventionOccupancies.findFirst({
        where: eq(interventionOccupancies.id, params.occupancyId),
    });
    if (!occupancy) {
        throw new Error(`Intervention occupancy ${params.occupancyId} not found`);
    }
    // Note: nao validamos o shift_label original. O bot pode ter inferido P/SN
    // por causa do horario; o reconhecimento converte para SD/MEIO_PLANTAO.
    const startedAt = occupancy.startedAt instanceof Date ? occupancy.startedAt : new Date(occupancy.startedAt);
    if (resolveBahiaHour(startedAt) < LATE_HALF_SHIFT_CUTOFF_HOUR) {
        throw new Error(`Chegada antes das ${LATE_HALF_SHIFT_CUTOFF_HOUR}h: regra de meio plantao por atraso nao se aplica.`);
    }

    const { scheduledStartAt, scheduledEndAt } = resolveLateHalfShiftWindowFor(startedAt);
    const now = new Date();
    const carryoverMinutes = Math.max(0, Math.trunc((scheduledStartAt.getTime() - startedAt.getTime()) / 60000));

    await db.update(interventionOccupancies)
        .set({
            shiftLabel: "SD",
            roleLabel: "MEIO_PLANTAO",
            scheduledStartAt,
            scheduledEndAt,
            lateArrivalAcknowledgedAt: now,
            lateArrivalAcknowledgedByUserId: params.actor.userId,
            lateArrivalAcknowledgedNote: params.note?.trim() || null,
            updatedAt: now,
            updatedByUserId: params.actor.userId ?? occupancy.updatedByUserId,
        })
        .where(eq(interventionOccupancies.id, params.occupancyId));

    await syncBankHoursByContinuityGroup(db, occupancy.continuityGroupId);

    return {
        occupancyId: occupancy.id,
        doctorId: occupancy.doctorId,
        baseId: occupancy.baseId,
        actualStartAt: startedAt,
        newScheduledStartAt: scheduledStartAt,
        newScheduledEndAt: scheduledEndAt,
        carryoverMinutes,
        acknowledgedAt: now,
        acknowledgedByUserId: params.actor.userId,
    };
}

export async function revertInterventionLateArrival(params: {
    occupancyId: string;
    actor: LateArrivalActor;
}): Promise<{ occupancyId: string; wasAcknowledged: boolean }> {
    const db = getDb();
    const occupancy = await db.query.interventionOccupancies.findFirst({
        where: eq(interventionOccupancies.id, params.occupancyId),
    });
    if (!occupancy) {
        throw new Error(`Intervention occupancy ${params.occupancyId} not found`);
    }
    if (!occupancy.lateArrivalAcknowledgedAt) {
        return { occupancyId: occupancy.id, wasAcknowledged: false };
    }

    const now = new Date();
    await db.update(interventionOccupancies)
        .set({
            lateArrivalAcknowledgedAt: null,
            lateArrivalAcknowledgedByUserId: null,
            lateArrivalAcknowledgedNote: null,
            updatedAt: now,
            updatedByUserId: params.actor.userId ?? occupancy.updatedByUserId,
        })
        .where(eq(interventionOccupancies.id, params.occupancyId));

    await syncBankHoursByContinuityGroup(db, occupancy.continuityGroupId);

    return { occupancyId: occupancy.id, wasAcknowledged: true };
}

export function formatCarryoverLabel(minutes: number): string {
    if (minutes <= 0) return "sem carryover";
    const h = Math.floor(minutes / 60);
    const m = minutes % 60;
    if (h === 0) return `${m} min`;
    if (m === 0) return h === 1 ? "1 hora" : `${h} horas`;
    return `${h}h${String(m).padStart(2, "0")}min`;
}

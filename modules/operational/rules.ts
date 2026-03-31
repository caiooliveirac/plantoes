import { resolveOperationalShiftWindow } from "@/modules/operational/board-rules";

const OPERATIONAL_LOCAL_OFFSET_MINUTES = -180;

function toOperationalLocalClock(date: Date) {
    return new Date(date.getTime() + (OPERATIONAL_LOCAL_OFFSET_MINUTES * 60000));
}

function fromOperationalLocalClockParts(year: number, month: number, day: number, hour: number, minute: number) {
    return new Date(Date.UTC(year, month - 1, day, hour - (OPERATIONAL_LOCAL_OFFSET_MINUTES / 60), minute, 0, 0));
}

function addOperationalLocalDays(date: Date, days: number) {
    return new Date(date.getTime() + (days * 86400000));
}

function resolveClosestScheduledStart(startedAt: Date, hour: number, minute: number) {
    const local = toOperationalLocalClock(startedAt);
    const year = local.getUTCFullYear();
    const month = local.getUTCMonth() + 1;
    const day = local.getUTCDate();
    const currentDay = fromOperationalLocalClockParts(year, month, day, hour, minute);
    const previousDay = addOperationalLocalDays(currentDay, -1);

    return Math.abs(currentDay.getTime() - startedAt.getTime()) <= Math.abs(previousDay.getTime() - startedAt.getTime())
        ? currentDay
        : previousDay;
}

export function inferOperationalScheduledStartAt(startedAt: Date, shiftLabel?: string | null, explicitScheduledStartAt?: Date | null) {
    if (explicitScheduledStartAt) {
        return explicitScheduledStartAt;
    }

    const normalized = shiftLabel?.trim().toUpperCase();
    if (!normalized || (normalized !== "SD" && normalized !== "SN")) {
        return null;
    }

    if (normalized === "SD") {
        return resolveClosestScheduledStart(startedAt, 7, 0);
    }

    return resolveClosestScheduledStart(startedAt, 19, 0);
}

export function inferInterventionScheduledEndAt(startedAt: Date, shiftLabel?: string | null, explicitScheduledEndAt?: Date | null) {
    if (explicitScheduledEndAt) {
        return explicitScheduledEndAt;
    }

    const normalized = shiftLabel?.trim().toUpperCase();
    if (!normalized || (normalized !== "SD" && normalized !== "SN")) {
        return null;
    }

    if (normalized === "SD") {
        const scheduledStartAt = inferOperationalScheduledStartAt(startedAt, normalized, null);
        return scheduledStartAt ? fromOperationalLocalClockParts(
            toOperationalLocalClock(scheduledStartAt).getUTCFullYear(),
            toOperationalLocalClock(scheduledStartAt).getUTCMonth() + 1,
            toOperationalLocalClock(scheduledStartAt).getUTCDate(),
            19,
            0,
        ) : null;
    }

    const scheduledStartAt = inferOperationalScheduledStartAt(startedAt, normalized, null);
    if (!scheduledStartAt) {
        return null;
    }

    const nextDay = addOperationalLocalDays(toOperationalLocalClock(scheduledStartAt), 1);
    return fromOperationalLocalClockParts(
        nextDay.getUTCFullYear(),
        nextDay.getUTCMonth() + 1,
        nextDay.getUTCDate(),
        7,
        0,
    );
}

export function inferInterventionCoverageWindow(params: {
    startedAt: Date;
    shiftLabel?: string | null;
    explicitScheduledStartAt?: Date | null;
    explicitScheduledEndAt?: Date | null;
}) {
    const normalized = params.shiftLabel?.trim().toUpperCase() ?? null;
    const baseShiftLabel = normalized === "SD" || normalized === "SN"
        ? normalized
        : resolveOperationalShiftWindow(params.startedAt).shiftLabel;
    const scheduledStartAt = inferOperationalScheduledStartAt(
        params.startedAt,
        baseShiftLabel,
        params.explicitScheduledStartAt ?? null,
    );
    let scheduledEndAt = inferInterventionScheduledEndAt(
        params.startedAt,
        baseShiftLabel,
        params.explicitScheduledEndAt ?? null,
    );

    if (normalized === "P" && scheduledEndAt && !params.explicitScheduledEndAt) {
        const extendedBoundary = resolveOperationalShiftWindow(new Date(scheduledEndAt.getTime() + 60000)).nextBoundaryAt;
        if (extendedBoundary.getTime() > scheduledEndAt.getTime()) {
            scheduledEndAt = extendedBoundary;
        }
    }

    return {
        baseShiftLabel,
        scheduledStartAt,
        scheduledEndAt,
    };
}

export function inferRegulationCoverageWindow(params: {
    startedAt: Date;
    shiftLabel?: string | null;
    explicitScheduledStartAt?: Date | null;
    explicitScheduledEndAt?: Date | null;
}) {
    const normalized = params.shiftLabel?.trim().toUpperCase() ?? null;
    const baseShiftLabel = normalized === "SD" || normalized === "SN"
        ? normalized
        : resolveOperationalShiftWindow(params.startedAt).shiftLabel;
    const scheduledStartAt = inferOperationalScheduledStartAt(
        params.startedAt,
        baseShiftLabel,
        params.explicitScheduledStartAt ?? null,
    );
    let scheduledEndAt = inferRegulationScheduledEndAt(
        params.startedAt,
        baseShiftLabel,
        params.explicitScheduledEndAt ?? null,
    );

    if (normalized === "P" && scheduledEndAt && !params.explicitScheduledEndAt) {
        const extendedReference = new Date(scheduledEndAt.getTime() + 60000);
        const nextShiftLabel = resolveOperationalShiftWindow(extendedReference).shiftLabel;
        const extendedScheduledEndAt = inferRegulationScheduledEndAt(extendedReference, nextShiftLabel, null);
        if (extendedScheduledEndAt && extendedScheduledEndAt.getTime() > scheduledEndAt.getTime()) {
            scheduledEndAt = extendedScheduledEndAt;
        }
    }

    return {
        baseShiftLabel,
        scheduledStartAt,
        scheduledEndAt,
    };
}

export function inferRegulationScheduledEndAt(startedAt: Date, shiftLabel?: string | null, explicitScheduledEndAt?: Date | null) {
    if (explicitScheduledEndAt) {
        return explicitScheduledEndAt;
    }

    const normalized = shiftLabel?.trim().toUpperCase();
    if (!normalized || (normalized !== "SD" && normalized !== "SN")) {
        return null;
    }

    if (normalized === "SD") {
        const scheduledStartAt = inferOperationalScheduledStartAt(startedAt, normalized, null);
        return scheduledStartAt ? fromOperationalLocalClockParts(
            toOperationalLocalClock(scheduledStartAt).getUTCFullYear(),
            toOperationalLocalClock(scheduledStartAt).getUTCMonth() + 1,
            toOperationalLocalClock(scheduledStartAt).getUTCDate(),
            19,
            15,
        ) : null;
    }

    const scheduledStartAt = inferOperationalScheduledStartAt(startedAt, normalized, null);
    if (!scheduledStartAt) {
        return null;
    }

    const nextDay = addOperationalLocalDays(toOperationalLocalClock(scheduledStartAt), 1);
    return fromOperationalLocalClockParts(
        nextDay.getUTCFullYear(),
        nextDay.getUTCMonth() + 1,
        nextDay.getUTCDate(),
        7,
        15,
    );
}

export function resolveRegulationBoardEndAt(proposedEndAt: Date, scheduledEndAt?: Date | null) {
    if (!scheduledEndAt) {
        return proposedEndAt;
    }

    return proposedEndAt.getTime() <= scheduledEndAt.getTime() ? proposedEndAt : scheduledEndAt;
}

export function resolveTelegramEventTime(referenceDate: Date, hhmm?: string | null) {
    if (!hhmm) {
        return referenceDate;
    }

    const [hoursRaw, minutesRaw] = hhmm.split(":");
    const hours = Number(hoursRaw);
    const minutes = Number(minutesRaw);
    if (!Number.isInteger(hours) || !Number.isInteger(minutes)) {
        return referenceDate;
    }

    const local = toOperationalLocalClock(referenceDate);
    const resolved = fromOperationalLocalClockParts(
        local.getUTCFullYear(),
        local.getUTCMonth() + 1,
        local.getUTCDate(),
        hours,
        minutes,
    );

    const candidates = [
        new Date(resolved.getTime() - 86400000),
        resolved,
        new Date(resolved.getTime() + 86400000),
    ];

    return candidates.reduce((closest, candidate) => {
        const candidateDistance = Math.abs(candidate.getTime() - referenceDate.getTime());
        const closestDistance = Math.abs(closest.getTime() - referenceDate.getTime());
        return candidateDistance < closestDistance ? candidate : closest;
    });
}
const OPERATIONAL_LOCAL_OFFSET_MINUTES = -180;

function toOperationalLocalClock(date: Date) {
    return new Date(date.getTime() + (OPERATIONAL_LOCAL_OFFSET_MINUTES * 60000));
}

function fromOperationalLocalClockParts(year: number, month: number, day: number, hour: number, minute: number) {
    return new Date(Date.UTC(year, month - 1, day, hour - (OPERATIONAL_LOCAL_OFFSET_MINUTES / 60), minute, 0, 0));
}

export function inferOperationalScheduledStartAt(startedAt: Date, shiftLabel?: string | null, explicitScheduledStartAt?: Date | null) {
    if (explicitScheduledStartAt) {
        return explicitScheduledStartAt;
    }

    const normalized = shiftLabel?.trim().toUpperCase();
    if (!normalized || (normalized !== "SD" && normalized !== "SN")) {
        return null;
    }

    const local = toOperationalLocalClock(startedAt);
    const year = local.getUTCFullYear();
    const month = local.getUTCMonth() + 1;
    const day = local.getUTCDate();
    const hour = local.getUTCHours();

    if (normalized === "SD") {
        return fromOperationalLocalClockParts(year, month, day, 7, 0);
    }

    const startBase = fromOperationalLocalClockParts(year, month, day, 19, 0);
    return hour >= 19 ? startBase : new Date(startBase.getTime() - 86400000);
}

export function inferInterventionScheduledEndAt(startedAt: Date, shiftLabel?: string | null, explicitScheduledEndAt?: Date | null) {
    if (explicitScheduledEndAt) {
        return explicitScheduledEndAt;
    }

    const normalized = shiftLabel?.trim().toUpperCase();
    if (!normalized || (normalized !== "SD" && normalized !== "SN")) {
        return null;
    }

    const local = toOperationalLocalClock(startedAt);
    const year = local.getUTCFullYear();
    const month = local.getUTCMonth() + 1;
    const day = local.getUTCDate();
    const hour = local.getUTCHours();

    if (normalized === "SD") {
        return fromOperationalLocalClockParts(year, month, day, 19, 0);
    }

    const endBase = fromOperationalLocalClockParts(year, month, day, 7, 0);
    return hour >= 19 ? new Date(endBase.getTime() + 86400000) : endBase;
}

export function inferRegulationScheduledEndAt(startedAt: Date, shiftLabel?: string | null, explicitScheduledEndAt?: Date | null) {
    if (explicitScheduledEndAt) {
        return explicitScheduledEndAt;
    }

    const normalized = shiftLabel?.trim().toUpperCase();
    if (!normalized || (normalized !== "SD" && normalized !== "SN")) {
        return null;
    }

    const local = toOperationalLocalClock(startedAt);
    const year = local.getUTCFullYear();
    const month = local.getUTCMonth() + 1;
    const day = local.getUTCDate();
    const hour = local.getUTCHours();
    const minute = local.getUTCMinutes();

    if (normalized === "SD") {
        return fromOperationalLocalClockParts(year, month, day, 19, 15);
    }

    const addDay = hour > 7 || (hour === 7 && minute > 15);
    const endBase = fromOperationalLocalClockParts(year, month, day, 7, 15);
    return addDay ? new Date(endBase.getTime() + 86400000) : endBase;
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
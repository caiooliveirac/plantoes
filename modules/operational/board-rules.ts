export type OperationalShiftLabel = "SD" | "SN";
export type OccupancyShiftLabel = OperationalShiftLabel | "P" | null;

const SAO_PAULO_OFFSET_MINUTES = -180;
const PRE_SHIFT_TOLERANCE_MINUTES = 60;
// Early-arrival detection window: arrivals within 3 h before the next boundary
// are classified as belonging to the upcoming shift (04:00→SD, 16:00→SN).
const EARLY_ARRIVAL_WINDOW_MINUTES = 180;
const VERIFICATION_GRACE_MINUTES = 15;
const OVERTIME_JUSTIFICATION_MINUTES = 15;

interface SaoPauloParts {
    year: number;
    month: number;
    day: number;
    hour: number;
    minute: number;
}

function toSaoPauloDate(value: string | Date) {
    const date = value instanceof Date ? value : new Date(value);
    return new Date(date.getTime() + (SAO_PAULO_OFFSET_MINUTES * 60000));
}

function fromSaoPauloClockParts(year: number, month: number, day: number, hour: number, minute: number) {
    return new Date(Date.UTC(year, month - 1, day, hour - (SAO_PAULO_OFFSET_MINUTES / 60), minute, 0, 0));
}

function addDays(date: Date, days: number) {
    return new Date(date.getTime() + (days * 86400000));
}

function addMinutes(date: Date, minutes: number) {
    return new Date(date.getTime() + (minutes * 60000));
}

export function getSaoPauloParts(value: string | Date): SaoPauloParts {
    const local = toSaoPauloDate(value);
    return {
        year: local.getUTCFullYear(),
        month: local.getUTCMonth() + 1,
        day: local.getUTCDate(),
        hour: local.getUTCHours(),
        minute: local.getUTCMinutes(),
    };
}

export function resolveOperationalShiftLabel(reference: string | Date): OperationalShiftLabel {
    return resolveOperationalShiftWindow(reference).shiftLabel;
}

export function resolveOperationalShiftWindow(reference: string | Date) {
    const parts = getSaoPauloParts(reference);

    if (parts.hour >= 7 && parts.hour < 19) {
        const startedAt = fromSaoPauloClockParts(parts.year, parts.month, parts.day, 7, 0);
        const nextBoundaryAt = fromSaoPauloClockParts(parts.year, parts.month, parts.day, 19, 0);
        const previousBoundaryAt = addDays(nextBoundaryAt, -1);
        return {
            shiftLabel: "SD" as const,
            startedAt,
            nextBoundaryAt,
            previousBoundaryAt,
        };
    }

    if (parts.hour >= 19) {
        const startedAt = fromSaoPauloClockParts(parts.year, parts.month, parts.day, 19, 0);
        const nextBoundaryAt = addDays(fromSaoPauloClockParts(parts.year, parts.month, parts.day, 7, 0), 1);
        const previousBoundaryAt = fromSaoPauloClockParts(parts.year, parts.month, parts.day, 7, 0);
        return {
            shiftLabel: "SN" as const,
            startedAt,
            nextBoundaryAt,
            previousBoundaryAt,
        };
    }

    const startedAt = addDays(fromSaoPauloClockParts(parts.year, parts.month, parts.day, 19, 0), -1);
    const nextBoundaryAt = fromSaoPauloClockParts(parts.year, parts.month, parts.day, 7, 0);
    const previousBoundaryAt = addDays(nextBoundaryAt, -1);
    return {
        shiftLabel: "SN" as const,
        startedAt,
        nextBoundaryAt,
        previousBoundaryAt,
    };
}

/**
 * When no explicit shift label is provided, resolve the shift for a new arrival.
 * If the arrival falls within EARLY_ARRIVAL_WINDOW_MINUTES (3 h) before the next boundary,
 * classify it as the upcoming shift rather than the current one.
 * Examples: arrival at 04:00 (3 h before SD) → "SD"; arrival at 16:00 (3 h before SN) → "SN".
 */
export function resolveArrivalShiftLabel(arrivalAt: string | Date): OperationalShiftLabel {
    const window = resolveOperationalShiftWindow(arrivalAt);
    const msToNextBoundary = window.nextBoundaryAt.getTime() - new Date(arrivalAt).getTime();
    if (msToNextBoundary > 0 && msToNextBoundary <= EARLY_ARRIVAL_WINDOW_MINUTES * 60000) {
        return window.shiftLabel === "SD" ? "SN" : "SD";
    }
    return window.shiftLabel;
}

export function isBeforeCurrentOperationalShift(startedAt: string | Date | null, reference: string | Date) {
    if (!startedAt) {
        return false;
    }

    const currentShiftStart = resolveOperationalShiftWindow(reference).startedAt;
    const toleratedShiftStart = addMinutes(currentShiftStart, -PRE_SHIFT_TOLERANCE_MINUTES);
    return new Date(startedAt).getTime() < toleratedShiftStart.getTime();
}

export function shouldHighlightInterventionVerification(
    startedAt: string | Date | null,
    reference: string | Date,
    shiftLabel: OccupancyShiftLabel = null,
) {
    if (!isBeforeCurrentOperationalShift(startedAt, reference)) {
        return false;
    }

    if (shiftLabel !== "P") {
        return true;
    }

    const boundary = resolveInterventionVerificationBoundary(startedAt, reference, shiftLabel);
    if (!boundary) {
        return true;
    }

    return new Date(reference).getTime() >= addMinutes(boundary, VERIFICATION_GRACE_MINUTES).getTime();
}

export function hasPlannedInterventionCoverageForCurrentShift(params: {
    shiftLabel: OccupancyShiftLabel;
    scheduledEndAt: string | Date | null;
    reference: string | Date;
}) {
    if (params.shiftLabel !== "P" || !params.scheduledEndAt) {
        return false;
    }

    const currentShiftStart = resolveOperationalShiftWindow(params.reference).startedAt;
    return new Date(params.scheduledEndAt).getTime() > currentShiftStart.getTime();
}

export function resolveFirstVerificationBoundary(startedAt: string | Date | null) {
    if (!startedAt) {
        return null;
    }

    const parts = getSaoPauloParts(startedAt);
    if (parts.hour < 7) {
        return fromSaoPauloClockParts(parts.year, parts.month, parts.day, 7, 0);
    }
    if (parts.hour < 19) {
        return fromSaoPauloClockParts(parts.year, parts.month, parts.day, 19, 0);
    }

    return addDays(fromSaoPauloClockParts(parts.year, parts.month, parts.day, 7, 0), 1);
}

export function resolveOvertimeJustificationThreshold(startedAt: string | Date | null) {
    const boundary = resolveFirstVerificationBoundary(startedAt);
    if (!boundary) {
        return null;
    }

    return addMinutes(boundary, OVERTIME_JUSTIFICATION_MINUTES);
}

export function requiresOvertimeJustification(startedAt: string | Date | null, reference: string | Date | null) {
    if (!reference) {
        return false;
    }

    const threshold = resolveOvertimeJustificationThreshold(startedAt);
    if (!threshold) {
        return false;
    }

    return new Date(reference).getTime() >= threshold.getTime();
}

export function resolveProlongedShiftExpiry(startedAt: string | Date | null, shiftLabel: OccupancyShiftLabel) {
    if (!startedAt || shiftLabel !== "P") {
        return null;
    }

    const parts = getSaoPauloParts(startedAt);
    const sameDaySeven = fromSaoPauloClockParts(parts.year, parts.month, parts.day, 7, 0);
    return addDays(sameDaySeven, 1);
}

export function resolveImplicitOccupancyExpiry(startedAt: string | Date | null, shiftLabel: OccupancyShiftLabel) {
    if (!startedAt) {
        return null;
    }

    if (shiftLabel === "P") {
        return resolveProlongedShiftExpiry(startedAt, shiftLabel);
    }

    return resolveFirstVerificationBoundary(startedAt);
}

function resolveInterventionVerificationBoundary(
    startedAt: string | Date | null,
    reference: string | Date,
    shiftLabel: OccupancyShiftLabel,
) {
    if (!startedAt) {
        return null;
    }

    if (shiftLabel !== "P") {
        return resolveFirstVerificationBoundary(startedAt);
    }

    const currentShiftStart = resolveOperationalShiftWindow(reference).startedAt;
    if (new Date(startedAt).getTime() < currentShiftStart.getTime()) {
        return currentShiftStart;
    }

    return resolveFirstVerificationBoundary(startedAt);
}

export function shouldKeepRegulationOccupancyVisible(params: {
    startedAt: string | Date | null;
    boardStartedAt?: string | Date | null;
    shiftLabel: OccupancyShiftLabel;
    reference: string | Date;
}) {
    const { startedAt, shiftLabel, reference } = params;
    if (!startedAt) {
        return true;
    }

    const visibilityAnchorAt = params.boardStartedAt ?? startedAt;

    if (!isBeforeCurrentOperationalShift(visibilityAnchorAt, reference)) {
        return true;
    }

    const expiresAt = resolveImplicitOccupancyExpiry(visibilityAnchorAt, shiftLabel);
    if (!expiresAt) {
        return false;
    }

    return new Date(reference).getTime() < addMinutes(expiresAt, VERIFICATION_GRACE_MINUTES).getTime();
}

export function resolveContinuationBadgeLabel(params: {
    startedAt: string | Date | null;
    shiftLabel: OccupancyShiftLabel;
    reference: string | Date;
}) {
    const { startedAt, shiftLabel, reference } = params;
    if (!startedAt || shiftLabel !== "P") {
        return null;
    }

    const boundary = resolveInterventionVerificationBoundary(startedAt, reference, shiftLabel);
    if (!boundary) {
        return null;
    }

    const now = new Date(reference).getTime();
    const boundaryTime = boundary.getTime();
    const graceLimit = addMinutes(boundary, VERIFICATION_GRACE_MINUTES).getTime();
    if (now < boundaryTime || now >= graceLimit) {
        return null;
    }

    return `Continua as ${boundary.toLocaleTimeString("pt-BR", {
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
        timeZone: "America/Sao_Paulo",
    })}`;
}
import { BAHIA_OFFSET_MINUTES } from "@/lib/time";

export type MonthlyReportDomain = "regulation" | "intervention";
export type MonthlyReportSource = "manual" | "telegram" | "import" | "admin_correction";
export type MonthlyReportPaymentStatus = "ready_for_payment" | "needs_review";

export interface MonthlyReportAuditEntry {
    id: string;
    action: string;
    actorEmail: string | null;
    createdAt: string;
    details: Record<string, unknown>;
}

export interface RawMonthlyReportShift {
    occupancyId: string;
    domain: MonthlyReportDomain;
    doctorId: string;
    doctorName: string;
    displayName: string | null;
    targetCode: string;
    targetLabel: string;
    continuityGroupId: string;
    startedAt: string;
    boardStartedAt: string | null;
    endedAt: string | null;
    actualEndedAt: string | null;
    scheduledStartAt: string | null;
    scheduledEndAt: string | null;
    shiftLabel: string | null;
    roleLabel: string | null;
    source: MonthlyReportSource;
    notes: string | null;
    createdAt: string;
    updatedAt: string;
    createdByEmail: string | null;
    updatedByEmail: string | null;
    arrivalDelayMinutes: number | null;
    overtimeMinutes: number | null;
    creditedOvertimeMinutes: number | null;
    balanceMinutes: number | null;
    ruleCode: string | null;
    bankHoursExplanation: string | null;
    auditTrail: MonthlyReportAuditEntry[];
    duplicateCount?: number;
    collapsedOccupancyIds?: string[];
    paymentAuditPerformed?: boolean;
    paymentAllocationSlotKeys?: string[];
    continuityCarrierOccupancyId?: string | null;
    continuityGroupSize?: number;
}

export interface MonthlyReportShift extends RawMonthlyReportShift {
    workedMinutes: number | null;
    paymentStatus: MonthlyReportPaymentStatus;
    inconsistencies: string[];
    flags: {
        hasManualSource: boolean;
        hasMissingBankHours: boolean;
        hasOpenShift: boolean;
        hasMissingSchedule: boolean;
        hasLateArrival: boolean;
        hasNegativeBalance: boolean;
        hasOvertimeWithoutNote: boolean;
        hasCorrectionHistory: boolean;
        hasDuplicateCoverage: boolean;
        hasPaymentAllocationMismatch: boolean;
        spansMultiplePaymentSlots: boolean;
    };
}

export interface MonthlyReportDoctorGroup {
    doctorId: string;
    doctorName: string;
    displayName: string | null;
    paymentStatus: MonthlyReportPaymentStatus;
    shiftCount: number;
    workedMinutes: number;
    balanceMinutes: number;
    inconsistentShiftCount: number;
    manualShiftCount: number;
    correctedShiftCount: number;
    shifts: MonthlyReportShift[];
}

export interface MonthlyReportSummary {
    doctorCount: number;
    shiftCount: number;
    inconsistentShiftCount: number;
    readyForPaymentCount: number;
    needsReviewCount: number;
    doctorsReadyForPaymentCount: number;
    doctorsNeedsReviewCount: number;
    openShiftCount: number;
    manualShiftCount: number;
    correctedShiftCount: number;
    doctorsWithPendenciesCount: number;
    workedMinutes: number;
    balanceMinutes: number;
}

export interface MonthlyReportModel {
    monthKey: string;
    monthLabel: string;
    range: {
        startIso: string;
        endIso: string;
    };
    presetMonths: Array<{ key: string; label: string }>;
    summary: MonthlyReportSummary;
    groups: MonthlyReportDoctorGroup[];
}

function formatMonthLabel(date: Date) {
    return new Intl.DateTimeFormat("pt-BR", {
        month: "long",
        year: "numeric",
        timeZone: "UTC",
    }).format(date);
}

function toMonthKey(date: Date) {
    return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

function startOfUtcMonth(year: number, monthIndex: number) {
    return new Date(Date.UTC(year, monthIndex, 1, 0, 0, 0, 0));
}

function fromSaoPauloClockParts(year: number, month: number, day: number, hour: number, minute: number) {
    return new Date(Date.UTC(year, month - 1, day, hour - (BAHIA_OFFSET_MINUTES / 60), minute, 0, 0));
}

// Abril/2026: primeiro mês fechado por este app (regulation_occupancies começa em 2026-04-01).
const FIRST_REPORT_YEAR = 2026;
const FIRST_REPORT_MONTH_INDEX = 3;

export function resolveMonthlyReportRange(monthKey?: string | null, reference = new Date()) {
    const fallback = startOfUtcMonth(reference.getUTCFullYear(), reference.getUTCMonth());
    const parsed = monthKey?.match(/^(\d{4})-(\d{2})$/);
    const monthAnchor = parsed
        ? startOfUtcMonth(Number(parsed[1]), Number(parsed[2]) - 1)
        : fallback;
    const monthStart = fromSaoPauloClockParts(monthAnchor.getUTCFullYear(), monthAnchor.getUTCMonth() + 1, 1, 7, 0);
    const nextMonthAnchor = startOfUtcMonth(monthAnchor.getUTCFullYear(), monthAnchor.getUTCMonth() + 1);
    const monthEnd = fromSaoPauloClockParts(nextMonthAnchor.getUTCFullYear(), nextMonthAnchor.getUTCMonth() + 1, 1, 7, 0);

    // Do mês corrente até o primeiro mês com fechamento neste app (mínimo 3),
    // para que maio/junho não sumam do seletor conforme o ano avança.
    const monthsSinceFirst = (fallback.getUTCFullYear() - FIRST_REPORT_YEAR) * 12
        + (fallback.getUTCMonth() - FIRST_REPORT_MONTH_INDEX) + 1;
    const presetMonths = Array.from({ length: Math.max(3, monthsSinceFirst) }, (_, index) => {
        const date = startOfUtcMonth(fallback.getUTCFullYear(), fallback.getUTCMonth() - index);
        return {
            key: toMonthKey(date),
            label: formatMonthLabel(date),
        };
    });
    if (!presetMonths.some((preset) => preset.key === toMonthKey(monthAnchor))) {
        presetMonths.push({ key: toMonthKey(monthAnchor), label: formatMonthLabel(monthAnchor) });
    }

    return {
        monthKey: toMonthKey(monthAnchor),
        monthLabel: formatMonthLabel(monthAnchor),
        start: monthStart,
        end: monthEnd,
        presetMonths,
    };
}

export function formatMinutesForHumans(minutes: number | null) {
    if (minutes === null) {
        return "--";
    }

    const sign = minutes < 0 ? "-" : "";
    const absolute = Math.abs(minutes);
    const hours = Math.floor(absolute / 60);
    const remainder = absolute % 60;

    if (hours === 0) {
        return `${sign}${remainder} min`;
    }

    if (remainder === 0) {
        return `${sign}${hours} h`;
    }

    return `${sign}${hours} h ${String(remainder).padStart(2, "0")}`;
}

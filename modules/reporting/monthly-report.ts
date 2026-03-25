export type MonthlyReportDomain = "regulation" | "intervention";
export type MonthlyReportSource = "manual" | "telegram" | "import" | "admin_correction";
export type MonthlyReportPaymentStatus = "ready_for_payment" | "needs_review";

const SAO_PAULO_OFFSET_HOURS = -3;

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
    startedAt: string;
    boardStartedAt: string | null;
    endedAt: string | null;
    actualEndedAt: string | null;
    scheduledStartAt: string | null;
    scheduledEndAt: string | null;
    shiftLabel: string | null;
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

export function resolveMonthlyReportPaymentStatus(inconsistencies: string[]): MonthlyReportPaymentStatus {
    return inconsistencies.length > 0 ? "needs_review" : "ready_for_payment";
}

function formatMonthLabel(date: Date) {
    return new Intl.DateTimeFormat("pt-BR", {
        month: "long",
        year: "numeric",
        timeZone: "America/Sao_Paulo",
    }).format(date);
}

function toMonthKey(date: Date) {
    return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

function startOfUtcMonth(year: number, monthIndex: number) {
    return new Date(Date.UTC(year, monthIndex, 1, 0, 0, 0, 0));
}

function fromSaoPauloClockParts(year: number, month: number, day: number, hour: number, minute: number) {
    return new Date(Date.UTC(year, month - 1, day, hour - SAO_PAULO_OFFSET_HOURS, minute, 0, 0));
}

export function resolveMonthlyReportRange(monthKey?: string | null, reference = new Date()) {
    const fallback = startOfUtcMonth(reference.getUTCFullYear(), reference.getUTCMonth());
    const parsed = monthKey?.match(/^(\d{4})-(\d{2})$/);
    const monthAnchor = parsed
        ? startOfUtcMonth(Number(parsed[1]), Number(parsed[2]) - 1)
        : fallback;
    const monthStart = fromSaoPauloClockParts(monthAnchor.getUTCFullYear(), monthAnchor.getUTCMonth() + 1, 1, 7, 0);
    const nextMonthAnchor = startOfUtcMonth(monthAnchor.getUTCFullYear(), monthAnchor.getUTCMonth() + 1);
    const monthEnd = fromSaoPauloClockParts(nextMonthAnchor.getUTCFullYear(), nextMonthAnchor.getUTCMonth() + 1, 1, 7, 0);

    const presetMonths = Array.from({ length: 3 }, (_, index) => {
        const date = startOfUtcMonth(fallback.getUTCFullYear(), fallback.getUTCMonth() - index);
        return {
            key: toMonthKey(date),
            label: formatMonthLabel(date),
        };
    });

    return {
        monthKey: toMonthKey(monthAnchor),
        monthLabel: formatMonthLabel(monthAnchor),
        start: monthStart,
        end: monthEnd,
        presetMonths,
    };
}

function computeWorkedMinutes(startedAt: string, endedAt: string | null) {
    if (!endedAt) {
        return null;
    }

    const diff = new Date(endedAt).getTime() - new Date(startedAt).getTime();
    if (Number.isNaN(diff) || diff <= 0) {
        return null;
    }

    return Math.round(diff / 60000);
}

export function detectMonthlyReportInconsistencies(shift: RawMonthlyReportShift) {
    const inconsistencies: string[] = [];
    const hasOpenShift = !shift.endedAt;
    const hasMissingSchedule = !shift.scheduledStartAt || !shift.scheduledEndAt;
    const hasMissingBankHours = Boolean(shift.endedAt) && shift.balanceMinutes === null;
    const hasManualSource = shift.source === "manual" || shift.source === "admin_correction";
    const hasLateArrival = (shift.arrivalDelayMinutes ?? 0) > 15;
    const hasNegativeBalance = (shift.balanceMinutes ?? 0) < 0;
    const hasOvertimeWithoutNote = (shift.creditedOvertimeMinutes ?? 0) > 0 && !shift.notes?.trim();
    const hasCorrectionHistory = shift.auditTrail.some((entry) => entry.action.endsWith(".corrected"));

    if (hasOpenShift) {
        inconsistencies.push("Plantão sem saída registrada");
    }

    if (hasMissingSchedule) {
        inconsistencies.push("Plantão sem janela prevista completa");
    }

    if (hasMissingBankHours) {
        inconsistencies.push("Plantão encerrado sem cálculo de banco de horas");
    }

    if (hasManualSource) {
        inconsistencies.push("Lançamento manual ou corrigido por chefia/admin");
    }

    if (hasCorrectionHistory) {
        inconsistencies.push("Plantão sofreu correção manual durante o mês");
    }

    if (hasLateArrival) {
        inconsistencies.push("Entrada com atraso acima da tolerância operacional");
    }

    if (hasNegativeBalance) {
        inconsistencies.push("Plantão gerou débito de horas, conferir abatimento");
    }

    if (hasOvertimeWithoutNote) {
        inconsistencies.push("Hora extra creditada sem observação operacional");
    }

    if (shift.endedAt && new Date(shift.endedAt).getTime() <= new Date(shift.startedAt).getTime()) {
        inconsistencies.push("Saída igual ou anterior à entrada");
    }

    return {
        inconsistencies,
        flags: {
            hasManualSource,
            hasMissingBankHours,
            hasOpenShift,
            hasMissingSchedule,
            hasLateArrival,
            hasNegativeBalance,
            hasOvertimeWithoutNote,
            hasCorrectionHistory,
        },
    };
}

export function buildMonthlyReportModel(shifts: RawMonthlyReportShift[], monthKey?: string | null, reference = new Date()): MonthlyReportModel {
    const range = resolveMonthlyReportRange(monthKey, reference);
    const enrichedShifts: MonthlyReportShift[] = shifts
        .map((shift) => {
            const derived = detectMonthlyReportInconsistencies(shift);
            return {
                ...shift,
                workedMinutes: computeWorkedMinutes(shift.startedAt, shift.endedAt),
                paymentStatus: resolveMonthlyReportPaymentStatus(derived.inconsistencies),
                inconsistencies: derived.inconsistencies,
                flags: derived.flags,
            };
        })
        .sort((left, right) => new Date(right.startedAt).getTime() - new Date(left.startedAt).getTime());

    const groupsMap = new Map<string, MonthlyReportDoctorGroup>();
    for (const shift of enrichedShifts) {
        const current = groupsMap.get(shift.doctorId);
        if (!current) {
            groupsMap.set(shift.doctorId, {
                doctorId: shift.doctorId,
                doctorName: shift.doctorName,
                displayName: shift.displayName,
                paymentStatus: shift.paymentStatus,
                shiftCount: 1,
                workedMinutes: shift.workedMinutes ?? 0,
                balanceMinutes: shift.balanceMinutes ?? 0,
                inconsistentShiftCount: shift.inconsistencies.length > 0 ? 1 : 0,
                manualShiftCount: shift.flags.hasManualSource ? 1 : 0,
                correctedShiftCount: shift.flags.hasCorrectionHistory ? 1 : 0,
                shifts: [shift],
            });
            continue;
        }

        current.shiftCount += 1;
        current.workedMinutes += shift.workedMinutes ?? 0;
        current.balanceMinutes += shift.balanceMinutes ?? 0;
        current.inconsistentShiftCount += shift.inconsistencies.length > 0 ? 1 : 0;
        current.manualShiftCount += shift.flags.hasManualSource ? 1 : 0;
        current.correctedShiftCount += shift.flags.hasCorrectionHistory ? 1 : 0;
        if (shift.paymentStatus === "needs_review") {
            current.paymentStatus = "needs_review";
        }
        current.shifts.push(shift);
    }

    const groups = Array.from(groupsMap.values())
        .sort((left, right) => {
            if (right.inconsistentShiftCount !== left.inconsistentShiftCount) {
                return right.inconsistentShiftCount - left.inconsistentShiftCount;
            }

            return left.doctorName.localeCompare(right.doctorName, "pt-BR");
        });

    return {
        monthKey: range.monthKey,
        monthLabel: range.monthLabel,
        range: {
            startIso: range.start.toISOString(),
            endIso: range.end.toISOString(),
        },
        presetMonths: range.presetMonths,
        summary: {
            doctorCount: groups.length,
            shiftCount: enrichedShifts.length,
            inconsistentShiftCount: enrichedShifts.filter((shift) => shift.inconsistencies.length > 0).length,
            readyForPaymentCount: enrichedShifts.filter((shift) => shift.paymentStatus === "ready_for_payment").length,
            needsReviewCount: enrichedShifts.filter((shift) => shift.paymentStatus === "needs_review").length,
            doctorsReadyForPaymentCount: groups.filter((group) => group.paymentStatus === "ready_for_payment").length,
            doctorsNeedsReviewCount: groups.filter((group) => group.paymentStatus === "needs_review").length,
            openShiftCount: enrichedShifts.filter((shift) => shift.flags.hasOpenShift).length,
            manualShiftCount: enrichedShifts.filter((shift) => shift.flags.hasManualSource).length,
            correctedShiftCount: enrichedShifts.filter((shift) => shift.flags.hasCorrectionHistory).length,
            doctorsWithPendenciesCount: groups.filter((group) => group.inconsistentShiftCount > 0).length,
            workedMinutes: enrichedShifts.reduce((total, shift) => total + (shift.workedMinutes ?? 0), 0),
            balanceMinutes: enrichedShifts.reduce((total, shift) => total + (shift.balanceMinutes ?? 0), 0),
        },
        groups,
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

export function buildMonthlyReportCsv(model: MonthlyReportModel) {
    const header = [
        "medico",
        "status_pagamento",
        "dominio",
        "codigo",
        "local",
        "entrada",
        "saida",
        "trabalhado_min",
        "saldo_min",
        "origem",
        "auditorias",
        "inconsistencias",
        "notas",
    ];

    const rows = model.groups.flatMap((group) => group.shifts.map((shift) => [
        group.doctorName,
        shift.paymentStatus,
        shift.domain === "regulation" ? "Regulação" : "Intervenção",
        shift.targetCode,
        shift.targetLabel,
        shift.startedAt,
        shift.endedAt ?? "",
        String(shift.workedMinutes ?? ""),
        String(shift.balanceMinutes ?? ""),
        shift.source,
        String(shift.auditTrail.length),
        shift.inconsistencies.join(" | "),
        shift.notes ?? "",
    ]));

    return [header, ...rows]
        .map((columns) => columns.map((value) => `"${String(value).replaceAll("\"", '""')}"`).join(","))
        .join("\n");
}
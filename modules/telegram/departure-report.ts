import { resolveOperationalShiftWindow } from "@/modules/operational/board-rules";
import { formatDoctorSurfaceName } from "@/modules/doctors/directory";
import {
    sortTelegramInterventionCodes,
    sortTelegramInterventionTargetRows,
    sortTelegramRegulationCodes,
    sortTelegramRegulationTargetRows,
} from "@/modules/telegram/presentation-order";
import type { PaymentAllocationBoard, PaymentAllocationRow } from "@/services/board.service";

const OPERATIONAL_LOCAL_OFFSET_MINUTES = -180;

export interface TelegramDepartureReportRequest {
    operationalDate: string;
    shiftLabel: "SD" | "SN";
}

function toOperationalLocalClock(date: Date) {
    return new Date(date.getTime() + (OPERATIONAL_LOCAL_OFFSET_MINUTES * 60000));
}

function formatDateParts(year: number, month: number, day: number) {
    return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function getOperationalLocalDateParts(date: Date) {
    const local = toOperationalLocalClock(date);
    return {
        year: local.getUTCFullYear(),
        month: local.getUTCMonth() + 1,
        day: local.getUTCDate(),
    };
}

function addOperationalLocalDays(parts: { year: number; month: number; day: number }, days: number) {
    const noonUtc = Date.UTC(parts.year, parts.month - 1, parts.day, 15, 0, 0, 0);
    return getOperationalLocalDateParts(new Date(noonUtc + (days * 86400000)));
}

function formatDateLabel(operationalDateIso: string) {
    return new Intl.DateTimeFormat("pt-BR", {
        dateStyle: "short",
        timeZone: "America/Sao_Paulo",
    }).format(new Date(operationalDateIso));
}

function formatHour(value: string | Date | null) {
    if (!value) {
        return "--:--";
    }

    return new Intl.DateTimeFormat("pt-BR", {
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
        timeZone: "America/Sao_Paulo",
    }).format(new Date(value));
}

function formatDuration(minutes: number, withSign = false) {
    const sign = minutes > 0 ? "+" : minutes < 0 ? "-" : withSign ? "+" : "";
    const absoluteMinutes = Math.abs(minutes);
    const hours = Math.trunc(absoluteMinutes / 60);
    const remainder = absoluteMinutes % 60;
    return `${sign}${hours}h${String(remainder).padStart(2, "0")}`;
}

function summarizeIssues(issues: string[]) {
    return issues
        .slice(0, 2)
        .map((issue) => issue
            .replace(/Plantao/g, "Plantão")
            .replace(/saida/g, "saída")
            .replace(/consolidada/g, "consolidada")
            .replace(/Lancamento manual ou corrigido manualmente/gi, "manual")
            .replace(/sem saída consolidada/gi, "sem saída"))
        .join("; ");
}

function resolveExitAt(row: PaymentAllocationRow) {
    return row.sourceActualEndedAt ?? row.sourceEndedAt ?? row.actualEndedAt ?? row.endedAt;
}

function resolveArrivalAt(row: PaymentAllocationRow) {
    return row.sourceStartedAt ?? row.startedAt;
}

function hasExplicitSourceExit(row: PaymentAllocationRow) {
    return Boolean(row.sourceActualEndedAt ?? row.sourceEndedAt);
}

function shouldUseSourceCoverage(row: PaymentAllocationRow) {
    if (!hasExplicitSourceExit(row)) {
        return false;
    }

    return (row.sourceStartedAt ?? null) !== (row.startedAt ?? null)
        || (row.sourceActualEndedAt ?? row.sourceEndedAt ?? null) !== (row.actualEndedAt ?? row.endedAt ?? null)
        || (row.sourceBalanceMinutes ?? null) !== (row.balanceMinutes ?? null)
        || (row.sourceRuleCode ?? null) !== (row.ruleCode ?? null);
}

function resolveReportedBankHours(row: PaymentAllocationRow) {
    if (!shouldUseSourceCoverage(row)) {
        return {
            arrivalDelayMinutes: row.arrivalDelayMinutes,
            overtimeMinutes: row.overtimeMinutes,
            creditedOvertimeMinutes: row.creditedOvertimeMinutes,
            balanceMinutes: row.balanceMinutes,
        };
    }

    return {
        arrivalDelayMinutes: row.sourceArrivalDelayMinutes ?? row.arrivalDelayMinutes,
        overtimeMinutes: row.sourceOvertimeMinutes ?? row.overtimeMinutes,
        creditedOvertimeMinutes: row.sourceCreditedOvertimeMinutes ?? row.creditedOvertimeMinutes,
        balanceMinutes: row.sourceBalanceMinutes ?? row.balanceMinutes,
    };
}

function resolveBankHoursLabel(row: PaymentAllocationRow) {
    if (row.continuesBeyondShift && !hasExplicitSourceExit(row)) {
        return "CONTINUA";
    }

    const metrics = resolveReportedBankHours(row);
    if (metrics.balanceMinutes === null) {
        return "BH pendente";
    }

    const detailParts: string[] = [];
    if ((metrics.arrivalDelayMinutes ?? 0) > 0) {
        detailParts.push(`atraso ${formatDuration(metrics.arrivalDelayMinutes ?? 0)}`);
    }

    if ((metrics.overtimeMinutes ?? 0) > 0) {
        const multiplier = (metrics.creditedOvertimeMinutes ?? 0) > 0 && (metrics.overtimeMinutes ?? 0) > 0
            ? Math.round((metrics.creditedOvertimeMinutes ?? 0) / (metrics.overtimeMinutes ?? 1))
            : 1;
        detailParts.push(`extra ${formatDuration(metrics.overtimeMinutes ?? 0)} x${multiplier}`);
    }

    if (detailParts.length === 0) {
        return "BH 0";
    }

    return `BH ${formatDuration(metrics.balanceMinutes, true)} (${detailParts.join(", ")})`;
}

function buildDepartureReportLine(row: PaymentAllocationRow) {
    if (!row.occupancyId) {
        return `⚪ ${row.targetCode} | --:-- | sem ocupação definida | --:-- | BH pendente`;
    }

    const name = formatDoctorSurfaceName({
        fullName: row.doctorName,
        displayName: row.displayName,
        fallback: "médico não identificado",
    });
    const visibleIssues = row.continuesBeyondShift
        ? row.issues.filter((issue) => !/sem saida consolidada/i.test(issue))
        : row.issues;
    const prefix = row.continuesBeyondShift
        ? "🔁"
        : row.paymentStatus === "ready_for_payment" ? "✅" : "⚠️";
    const reviewSuffix = visibleIssues.length > 0
        ? ` | revisar: ${summarizeIssues(visibleIssues)}`
        : "";
    const disabledSuffix = row.disabledDuringShift && row.disabledAt
        ? ` | base desativada ${formatHour(row.disabledAt)}`
        : row.disabledDuringShift
            ? " | base desativada no turno"
            : "";

    return `${prefix} ${row.targetCode} | ${formatHour(resolveArrivalAt(row))} | ${name} | ${formatHour(resolveExitAt(row))} | ${resolveBankHoursLabel(row)}${reviewSuffix}${disabledSuffix}`;
}

function buildDisabledDepartureLine(row: PaymentAllocationRow) {
    const disabledAt = row.disabledAt ? formatHour(row.disabledAt) : "--:--";
    const reason = row.disabledReason?.trim() ? ` | ${row.disabledReason.trim()}` : "";
    return `⚫ ${row.targetCode} | ${disabledAt} | base desativada para o turno${reason}`;
}

export function resolveTelegramDepartureReportRequest(params: {
    operationalDate: string | null;
    shiftLabel: "SD" | "SN" | null;
    reference: Date;
}): TelegramDepartureReportRequest {
    if (params.operationalDate && params.shiftLabel) {
        return {
            operationalDate: params.operationalDate,
            shiftLabel: params.shiftLabel,
        };
    }

    const currentShift = resolveOperationalShiftWindow(params.reference);
    const currentParts = getOperationalLocalDateParts(currentShift.startedAt);
    if (currentShift.shiftLabel === "SN") {
        return {
            operationalDate: formatDateParts(currentParts.year, currentParts.month, currentParts.day),
            shiftLabel: "SD",
        };
    }

    const previousParts = addOperationalLocalDays(currentParts, -1);
    return {
        operationalDate: formatDateParts(previousParts.year, previousParts.month, previousParts.day),
        shiftLabel: "SN",
    };
}

export function buildTelegramDepartureReport(board: PaymentAllocationBoard) {
    const regulationAssigned = sortTelegramRegulationTargetRows(board.regulation.filter((row) => row.occupancyId));
    const interventionAssigned = sortTelegramInterventionTargetRows(board.intervention.filter((row) => row.occupancyId));
    const assignedNeedsReviewCount = [...regulationAssigned, ...interventionAssigned]
        .filter((row) => row.paymentStatus === "needs_review" && !row.continuesBeyondShift).length;
    const emptyTargets = [
        ...sortTelegramRegulationCodes(board.regulation.filter((row) => !row.occupancyId && !row.disabledEntireShift).map((row) => row.targetCode)),
        ...sortTelegramInterventionCodes(board.intervention.filter((row) => !row.occupancyId && !row.disabledEntireShift).map((row) => row.targetCode)),
    ];
    const disabledTargets = sortTelegramInterventionTargetRows(board.intervention.filter((row) => row.disabledEntireShift));

    const header = [
        `📤 Saídas ${formatDateLabel(board.operationalDate)} ${board.shiftLabel}.`,
        "Formato: alvo | chegada real | nome | saída | banco.",
        `Alocados ${board.summary.assignedCount}/${board.summary.totalTargets} | revisar ${assignedNeedsReviewCount} | vazios ${board.summary.unassignedCount} | desativadas ${board.summary.disabledCount ?? 0}`,
    ];

    const regulationBlock = regulationAssigned.length > 0
        ? ["", "Regulação:", regulationAssigned.map(buildDepartureReportLine).join("\n")]
        : [];
    const interventionBlock = interventionAssigned.length > 0
        ? ["", "Intervenção:", interventionAssigned.map(buildDepartureReportLine).join("\n")]
        : [];
    const emptyBlock = emptyTargets.length > 0
        ? ["", `Vazios (${emptyTargets.length}): ${emptyTargets.join(", ")}`]
        : [];
    const disabledBlock = disabledTargets.length > 0
        ? ["", "Desativadas:", disabledTargets.map(buildDisabledDepartureLine).join("\n")]
        : [];

    const allAssigned = [...regulationAssigned, ...interventionAssigned];
    const totalCredit = allAssigned.reduce((sum, row) => {
        const bh = resolveReportedBankHours(row);
        const balance = bh.balanceMinutes ?? 0;
        return balance > 0 ? sum + balance : sum;
    }, 0);
    const totalDebit = allAssigned.reduce((sum, row) => {
        const bh = resolveReportedBankHours(row);
        const balance = bh.balanceMinutes ?? 0;
        return balance < 0 ? sum + balance : sum;
    }, 0);
    const totalNet = totalCredit + totalDebit;
    const bhFooter = ["", `BH turno: ${formatDuration(totalCredit, true)} crédito, ${formatDuration(totalDebit, true)} débito, saldo ${formatDuration(totalNet, true)}`];

    return [...header, ...regulationBlock, ...interventionBlock, ...emptyBlock, ...disabledBlock, ...bhFooter].join("\n");
}
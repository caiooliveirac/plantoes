import { resolveOperationalShiftWindow } from "@/modules/operational/board-rules";
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
            .replace(/consolidada/g, "consolidada"))
        .join("; ");
}

function resolveExitAt(row: PaymentAllocationRow) {
    return row.sourceActualEndedAt ?? row.sourceEndedAt ?? row.actualEndedAt ?? row.endedAt;
}

function resolveBankHoursLabel(row: PaymentAllocationRow) {
    if (row.continuesBeyondShift) {
        return "CONTINUA";
    }

    if (row.balanceMinutes === null) {
        return "BH pendente";
    }

    const detailParts: string[] = [];
    if ((row.arrivalDelayMinutes ?? 0) > 0) {
        detailParts.push(`atraso ${formatDuration(row.arrivalDelayMinutes ?? 0)}`);
    }

    if ((row.overtimeMinutes ?? 0) > 0) {
        const multiplier = (row.creditedOvertimeMinutes ?? 0) > 0 && (row.overtimeMinutes ?? 0) > 0
            ? Math.round((row.creditedOvertimeMinutes ?? 0) / (row.overtimeMinutes ?? 1))
            : 1;
        detailParts.push(`extra ${formatDuration(row.overtimeMinutes ?? 0)} x${multiplier}`);
    }

    if (detailParts.length === 0) {
        detailParts.push("sem impacto");
    }

    return `BH ${formatDuration(row.balanceMinutes, true)} (${detailParts.join(", ")})`;
}

function buildDepartureReportLine(row: PaymentAllocationRow) {
    if (!row.occupancyId) {
        return `⚪ ${row.targetCode} | --:-- | sem ocupação definida | --:-- | BH pendente`;
    }

    const name = row.displayName ?? row.doctorName ?? "médico não identificado";
    const visibleIssues = row.continuesBeyondShift
        ? row.issues.filter((issue) => !/sem saida consolidada/i.test(issue))
        : row.issues;
    const prefix = row.continuesBeyondShift
        ? "🔁"
        : row.paymentStatus === "ready_for_payment" ? "✅" : "⚠️";
    const reviewSuffix = visibleIssues.length > 0
        ? ` | revisar: ${summarizeIssues(visibleIssues)}`
        : "";

    return `${prefix} ${row.targetCode} | ${formatHour(row.startedAt)} | ${name} | ${formatHour(resolveExitAt(row))} | ${resolveBankHoursLabel(row)}${reviewSuffix}`;
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
    const regulationAssigned = board.regulation.filter((row) => row.occupancyId);
    const interventionAssigned = board.intervention.filter((row) => row.occupancyId);
    const assignedNeedsReviewCount = [...regulationAssigned, ...interventionAssigned]
        .filter((row) => row.paymentStatus === "needs_review" && !row.continuesBeyondShift).length;
    const emptyTargets = [...board.regulation, ...board.intervention]
        .filter((row) => !row.occupancyId)
        .map((row) => row.targetCode);

    const header = [
        `📤 Saídas ${formatDateLabel(board.operationalDate)} ${board.shiftLabel}.`,
        "Formato: alvo | chegada | nome | saída | banco.",
        `Alocados ${board.summary.assignedCount}/${board.summary.totalTargets} | revisar ${assignedNeedsReviewCount} | vazios ${board.summary.unassignedCount}`,
    ];

    const regulationBlock = regulationAssigned.length > 0
        ? ["", "Regulação:", regulationAssigned.map(buildDepartureReportLine).join("\n")]
        : [];
    const interventionBlock = interventionAssigned.length > 0
        ? ["", "Intervenção:", interventionAssigned.map(buildDepartureReportLine).join("\n")]
        : [];
    const emptyBlock = emptyTargets.length > 0
        ? ["", `Vazios: ${emptyTargets.join(", ")}`]
        : [];

    return [...header, ...regulationBlock, ...interventionBlock, ...emptyBlock].join("\n");
}
import type { MealBreakSession } from "@/modules/telegram/meal-breaks";
import { resolveOperationalShiftWindow } from "@/modules/operational/board-rules";
import { formatDoctorSurfaceName } from "@/modules/doctors/directory";
import { resolveTelegramDepartureReportRequest } from "@/modules/telegram/departure-report";
import {
    sortTelegramInterventionRows,
    sortTelegramInterventionTargetRows,
    sortTelegramRegulationRows,
    sortTelegramRegulationTargetRows,
} from "@/modules/telegram/presentation-order";
import type { PaymentAllocationBoard, PaymentAllocationRow, InterventionBoardRow, RegulationBoardRow } from "@/services/board.service";

export interface TelegramSummaryReportData {
    departureBoard: PaymentAllocationBoard;
    currentBoard: {
        intervention: InterventionBoardRow[];
        regulation: RegulationBoardRow[];
    };
    mealBreakSession: MealBreakSession | null;
}

function formatDateLabel(value: string | Date) {
    return new Intl.DateTimeFormat("pt-BR", {
        dateStyle: "short",
        timeZone: "America/Sao_Paulo",
    }).format(new Date(value));
}

function formatHour(value: string | Date | null | undefined) {
    if (!value) {
        return "";
    }

    return new Intl.DateTimeFormat("pt-BR", {
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
        timeZone: "America/Sao_Paulo",
    }).format(new Date(value));
}

function compactDoctorName(name: string | null | undefined) {
    const resolved = name?.trim() ?? "";
    if (!resolved) {
        return "";
    }

    const tokens = resolved.split(/\s+/).filter(Boolean);
    if (tokens.length <= 1) {
        return resolved;
    }

    const particles = new Set(["de", "da", "do", "dos", "das", "e"]);
    const suffixes = new Set(["Filho", "Neto", "Junior", "Jr", "Sobrinho"]);
    const first = tokens[0] ?? resolved;
    const filtered = tokens.filter((token) => !particles.has(token.toLowerCase()));
    const last = filtered[filtered.length - 1] ?? tokens[tokens.length - 1] ?? first;
    const previous = filtered[filtered.length - 2] ?? tokens[tokens.length - 2] ?? null;

    if (suffixes.has(last) && previous) {
        return `${first} ${previous} ${last}`;
    }

    return first === last ? first : `${first} ${last}`;
}

function resolveSummaryExitAt(row: PaymentAllocationRow) {
    return row.sourceActualEndedAt ?? row.sourceEndedAt ?? row.actualEndedAt ?? row.endedAt ?? null;
}

function resolveSummaryArrivalAt(row: PaymentAllocationRow | RegulationBoardRow | InterventionBoardRow) {
    return row.startedAt ?? null;
}

function buildSection(title: string, header: string, rows: string[]) {
    return [title, header, ...rows].join("\n");
}

function buildSortedDepartureRows(rows: PaymentAllocationRow[], domain: "regulation" | "intervention") {
    const sortedRows = domain === "regulation"
        ? sortTelegramRegulationTargetRows(rows)
        : sortTelegramInterventionTargetRows(rows);

    return sortedRows
        .filter((row) => Boolean(row.occupancyId))
        .map((row) => {
            const code = row.targetCode;
            const name = compactDoctorName(formatDoctorSurfaceName({ fullName: row.doctorName, displayName: row.displayName, fallback: "" }));
            const exitAt = resolveSummaryExitAt(row);
            const continua = row.continuesBeyondShift && !exitAt;
            return { code, name, exitAt, continua };
        })
        .filter((row) => Boolean(row.exitAt) || row.continua)
        .map((row) => row.continua
            ? `${row.code}|${row.name}|continua`
            : `${row.code}|${row.name}|${formatHour(row.exitAt)}`);
}

function buildInterventionArrivalRows(rows: InterventionBoardRow[], currentShiftLabel: "SD" | "SN") {
    return sortTelegramInterventionRows(rows)
        .filter((row) => row.status === "active" && Boolean(row.doctorId))
        .map((row) => {
            const name = compactDoctorName(formatDoctorSurfaceName({ fullName: row.doctorName, displayName: row.displayName, fallback: "" }));
            const pSuffix = row.shiftLabel === "P" ? " (P)" : "";
            return `${row.baseCode}|${name}|${formatHour(resolveSummaryArrivalAt(row))}${pSuffix}`;
        });
}

function resolveRegulationMealBreakColumns(session: MealBreakSession | null, ramal: string, shiftLabel: "SD" | "SN") {
    if (!session) {
        return shiftLabel === "SD"
            ? { first: "", second: "" }
            : { first: "", second: "" };
    }

    if (shiftLabel === "SD") {
        return {
            first: session.lunchAssignments[ramal] ?? "",
            second: session.restAssignments[ramal] ?? "",
        };
    }

    return {
        first: session.dinnerAssignments[ramal] ?? "",
        second: session.nightWorkAssignments[ramal] ?? "",
    };
}

function buildRegulationArrivalRows(params: {
    rows: RegulationBoardRow[];
    mealBreakSession: MealBreakSession | null;
    shiftLabel: "SD" | "SN";
    includeMealColumns: boolean;
}) {
    return sortTelegramRegulationRows(params.rows)
        .filter((row) => row.status === "active" && Boolean(row.doctorId))
        .map((row) => {
            const name = compactDoctorName(formatDoctorSurfaceName({ fullName: row.doctorName, displayName: row.displayName, fallback: "" }));
            const pSuffix = row.shiftLabel === "P" ? " (P)" : "";
            const base = `${row.postCode}|${name}|${formatHour(resolveSummaryArrivalAt(row))}${pSuffix}`;
            if (!params.includeMealColumns) {
                return base;
            }
            const mealBreak = resolveRegulationMealBreakColumns(params.mealBreakSession, row.postCode, params.shiftLabel);
            return `${base}|${mealBreak.first}|${mealBreak.second}`;
        });
}

export function buildTelegramSummaryReport(params: {
    data: TelegramSummaryReportData;
    reference: Date;
}) {
    const departureRequest = resolveTelegramDepartureReportRequest({
        operationalDate: null,
        shiftLabel: null,
        reference: params.reference,
    });
    const currentShiftLabel = params.data.mealBreakSession?.mode === "night"
        ? "SN"
        : resolveOperationalShiftWindow(params.reference).shiftLabel;

    const departureInterventionRows = buildSortedDepartureRows(params.data.departureBoard.intervention, "intervention");
    const departureRegulationRows = buildSortedDepartureRows(params.data.departureBoard.regulation, "regulation");
    const arrivalInterventionRows = buildInterventionArrivalRows(params.data.currentBoard.intervention, currentShiftLabel);
    const hasMealData = params.data.mealBreakSession !== null;
    const arrivalRegulationRows = buildRegulationArrivalRows({
        rows: params.data.currentBoard.regulation,
        mealBreakSession: params.data.mealBreakSession,
        shiftLabel: currentShiftLabel,
        includeMealColumns: hasMealData,
    });

    const regulationHeader = !hasMealData
        ? "ramal|nome|chegada"
        : currentShiftLabel === "SD"
            ? "ramal|nome|chegada|almoco|descanso"
            : "ramal|nome|chegada|jantar|trabalho";

    const depShiftLabel = params.data.departureBoard.shiftLabel ?? departureRequest.shiftLabel;

    return [
        `📋 RESUMO ${formatDateLabel(params.reference)} ${currentShiftLabel}`,
        "",
        `📤 SAÍDAS ${depShiftLabel} (${departureInterventionRows.length} int, ${departureRegulationRows.length} reg)`,
        "",
        buildSection("INTERVENÇÃO", "base|nome|saída", departureInterventionRows),
        "",
        buildSection("REGULAÇÃO", "ramal|nome|saída", departureRegulationRows),
        "",
        `📥 CHEGADAS ${currentShiftLabel} (${arrivalInterventionRows.length} int, ${arrivalRegulationRows.length} reg)`,
        "",
        buildSection("INTERVENÇÃO", "base|nome|chegada", arrivalInterventionRows),
        "",
        buildSection("REGULAÇÃO", regulationHeader, arrivalRegulationRows),
    ].join("\n");
}
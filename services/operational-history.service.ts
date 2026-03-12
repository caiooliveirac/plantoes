import { isNucleoRegulationPost, isPiamRegulationPost } from "@/modules/operational/board-display";
import { formatDoctorSurfaceName } from "@/modules/doctors/directory";
import { compareTelegramInterventionCodes, compareTelegramRegulationCodes } from "@/modules/telegram/presentation-order";
import {
    getHistoricalOperationalPresenceBoard,
    type HistoricalOperationalPresenceBoard,
    type HistoricalOperationalPresenceRow,
} from "@/services/board.service";

const OPERATIONAL_LOCAL_OFFSET_MINUTES = -180;
const REGULATION_EXPECTED_OCCUPANCY_DAY = 12;
const REGULATION_EXPECTED_OCCUPANCY_NIGHT = 10;
const INTERVENTION_EXPECTED_OCCUPANCY = 12;
const LATE_ENTRY_ALERT_MINUTES = 15;

export type HistoricalShiftLabel = "SD" | "SN";
export type HistoricalRowState = "occupied" | "vacant" | "disabled";
export type HistoricalCheckpointStatus = "ok" | "vacant" | "disabled";
export type HistoricalPendingPriority = "critical" | "warning";

export interface HistoricalShiftPointer {
    operationalDate: string;
    shiftLabel: HistoricalShiftLabel;
    label: string;
}

export interface HistoricalTargetOption {
    targetId: number | null;
    targetCode: string;
    targetLabel: string;
    sortOrder: number;
    state: HistoricalRowState;
    disabled: boolean;
    roleLabel: string | null;
}

export interface HistoricalOperationalRow {
    domain: "regulation" | "intervention";
    targetId: number | null;
    targetCode: string;
    targetLabel: string;
    sortOrder: number;
    state: HistoricalRowState;
    occupancyId: string | null;
    doctorId: string | null;
    doctorName: string | null;
    displayName: string | null;
    doctorLabel: string;
    arrivalAt: string | null;
    departureAt: string | null;
    roleLabel: string | null;
    source: string | null;
    notes: string | null;
    disabledAt: string | null;
    disabledReason: string | null;
    arrivalDelayMinutes: number | null;
    issues: string[];
    isRelocated: boolean;
    relocationHint: string | null;
    contextHints: string[];
}

export interface HistoricalRelevantPendingItem {
    domain: "regulation" | "intervention";
    targetCode: string;
    targetLabel: string;
    message: string;
    priority: HistoricalPendingPriority;
}

export interface HistoricalOperationalBoard {
    generatedAt: string;
    operationalDate: string;
    dateKey: string;
    shiftLabel: HistoricalShiftLabel;
    startedAt: string;
    endedAt: string;
    previousSlot: HistoricalShiftPointer;
    nextSlot: HistoricalShiftPointer;
    summary: {
        regulation: {
            occupiedCount: number;
            chiefStatus: HistoricalCheckpointStatus;
            nucleoStatus: HistoricalCheckpointStatus | null;
            piamStatus: HistoricalCheckpointStatus;
            pendingRequiredCodes: string[];
        };
        intervention: {
            occupiedCount: number;
            vacantCount: number;
            disabledCount: number;
            pendingCodes: string[];
        };
        pending: {
            vacantReview: string[];
            coverageIssues: string[];
        };
        relevantPending: {
            totalItems: number;
            regulationExpectedCount: number;
            regulationOccupiedCount: number;
            regulationShortfall: number;
            regulationBelowExpected: boolean;
            interventionExpectedCount: number;
            interventionOccupiedCount: number;
            interventionShortfall: number;
            interventionBelowExpected: boolean;
            items: HistoricalRelevantPendingItem[];
        };
    };
    regulation: HistoricalOperationalRow[];
    intervention: HistoricalOperationalRow[];
    targetOptions: {
        regulation: HistoricalTargetOption[];
        intervention: HistoricalTargetOption[];
    };
}

export interface HistoricalOperationalRequest {
    operationalDate?: string | null;
    shiftLabel?: HistoricalShiftLabel | null;
    reference?: Date;
}

function toOperationalLocalClock(date: Date) {
    return new Date(date.getTime() + (OPERATIONAL_LOCAL_OFFSET_MINUTES * 60000));
}

function getOperationalLocalDateParts(date: Date) {
    const local = toOperationalLocalClock(date);
    return {
        year: local.getUTCFullYear(),
        month: local.getUTCMonth() + 1,
        day: local.getUTCDate(),
        hour: local.getUTCHours(),
    };
}

function formatDateParts(year: number, month: number, day: number) {
    return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function parseDateKey(value: string) {
    const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!match) {
        return null;
    }

    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) {
        return null;
    }

    const probe = new Date(Date.UTC(year, month - 1, day, 15, 0, 0, 0));
    const parts = getOperationalLocalDateParts(probe);
    if (parts.year !== year || parts.month !== month || parts.day !== day) {
        return null;
    }

    return { year, month, day };
}

function addOperationalLocalDays(parts: { year: number; month: number; day: number }, days: number) {
    const noonUtc = Date.UTC(parts.year, parts.month - 1, parts.day, 15, 0, 0, 0);
    const shifted = new Date(noonUtc + (days * 86400000));
    const next = getOperationalLocalDateParts(shifted);
    return {
        year: next.year,
        month: next.month,
        day: next.day,
    };
}

function formatSlotLabel(operationalDate: string, shiftLabel: HistoricalShiftLabel) {
    return `${new Intl.DateTimeFormat("pt-BR", {
        day: "2-digit",
        month: "2-digit",
        timeZone: "America/Sao_Paulo",
    }).format(new Date(`${operationalDate}T12:00:00.000Z`))} • ${shiftLabel}`;
}

function formatBoardTime(value: string | null) {
    if (!value) {
        return null;
    }

    return new Intl.DateTimeFormat("pt-BR", {
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
        timeZone: "America/Sao_Paulo",
    }).format(new Date(value));
}

function normalizeOperationalCode(value: string) {
    return value.trim().toUpperCase();
}

function isChiefRegulationPost(code: string) {
    return normalizeOperationalCode(code) === "2031";
}

function resolveCurrentShift(reference = new Date()) {
    const parts = getOperationalLocalDateParts(reference);
    if (parts.hour >= 19) {
        return {
            operationalDate: formatDateParts(parts.year, parts.month, parts.day),
            shiftLabel: "SN" as const,
        };
    }

    if (parts.hour >= 7) {
        return {
            operationalDate: formatDateParts(parts.year, parts.month, parts.day),
            shiftLabel: "SD" as const,
        };
    }

    const previousDay = addOperationalLocalDays(parts, -1);
    return {
        operationalDate: formatDateParts(previousDay.year, previousDay.month, previousDay.day),
        shiftLabel: "SN" as const,
    };
}

function compareHistoricalRegulationCodes(left: string, right: string) {
    const normalizedLeft = normalizeOperationalCode(left);
    const normalizedRight = normalizeOperationalCode(right);

    const historicalSpecialOrder = new Map<string, number>([
        ["PIAM", 0],
        ["NUCLEO", 1],
    ]);
    const leftSpecial = historicalSpecialOrder.get(normalizedLeft);
    const rightSpecial = historicalSpecialOrder.get(normalizedRight);

    if (leftSpecial !== undefined || rightSpecial !== undefined) {
        if (leftSpecial === undefined) {
            return -1;
        }
        if (rightSpecial === undefined) {
            return 1;
        }

        return leftSpecial - rightSpecial;
    }

    return compareTelegramRegulationCodes(normalizedLeft, normalizedRight);
}

function compareHistoricalInterventionCodes(left: string, right: string) {
    return compareTelegramInterventionCodes(normalizeOperationalCode(left), normalizeOperationalCode(right));
}

function compareRowsByTargetCode<T extends { targetCode: string }>(
    left: T,
    right: T,
    compare: (leftCode: string, rightCode: string) => number,
) {
    const targetCodeDiff = compare(left.targetCode, right.targetCode);
    if (targetCodeDiff !== 0) {
        return targetCodeDiff;
    }

    return 0;
}

function resolveCurrentShiftExpectedRegulationOccupancy(shiftLabel: HistoricalShiftLabel) {
    return shiftLabel === "SD" ? REGULATION_EXPECTED_OCCUPANCY_DAY : REGULATION_EXPECTED_OCCUPANCY_NIGHT;
}

function resolveCurrentShiftExpectedInterventionOccupancy(disabledCount: number) {
    return Math.max(0, INTERVENTION_EXPECTED_OCCUPANCY - disabledCount);
}

export function stepHistoricalShiftSlot(
    slot: { operationalDate: string; shiftLabel: HistoricalShiftLabel },
    direction: "previous" | "next",
) {
    const parts = parseDateKey(slot.operationalDate);
    if (!parts) {
        throw new Error("Use datas no formato YYYY-MM-DD para navegar pelos turnos.");
    }

    if (direction === "previous") {
        if (slot.shiftLabel === "SN") {
            return {
                operationalDate: slot.operationalDate,
                shiftLabel: "SD" as const,
            };
        }

        const previousDay = addOperationalLocalDays(parts, -1);
        return {
            operationalDate: formatDateParts(previousDay.year, previousDay.month, previousDay.day),
            shiftLabel: "SN" as const,
        };
    }

    if (slot.shiftLabel === "SD") {
        return {
            operationalDate: slot.operationalDate,
            shiftLabel: "SN" as const,
        };
    }

    const nextDay = addOperationalLocalDays(parts, 1);
    return {
        operationalDate: formatDateParts(nextDay.year, nextDay.month, nextDay.day),
        shiftLabel: "SD" as const,
    };
}

export function resolveHistoricalOperationalRequest(params: HistoricalOperationalRequest = {}) {
    if ((params.operationalDate && !params.shiftLabel) || (!params.operationalDate && params.shiftLabel)) {
        throw new Error("Selecione data e turno juntos para abrir o historico.");
    }

    if (!params.operationalDate && !params.shiftLabel) {
        return stepHistoricalShiftSlot(resolveCurrentShift(params.reference), "previous");
    }

    const date = params.operationalDate?.trim() ?? "";
    if (!parseDateKey(date)) {
        throw new Error("Use datas no formato YYYY-MM-DD.");
    }

    if (params.shiftLabel !== "SD" && params.shiftLabel !== "SN") {
        throw new Error("Turno historico invalido.");
    }

    return {
        operationalDate: date,
        shiftLabel: params.shiftLabel,
    };
}

function resolveHistoricalRowState(row: HistoricalOperationalPresenceRow): HistoricalRowState {
    return row.status === "empty"
        ? "vacant"
        : row.status;
}

function isRequiredRegulationVacancy(targetCode: string, shiftLabel: HistoricalShiftLabel) {
    const normalized = normalizeOperationalCode(targetCode);
    if (normalized === "2031") {
        return true;
    }

    if (isPiamRegulationPost(normalized)) {
        return true;
    }

    return shiftLabel === "SD" && isNucleoRegulationPost(normalized);
}

function resolveRelocationHint(notes: string | null | undefined) {
    const normalized = notes?.trim() ?? "";
    if (!normalized) {
        return null;
    }

    const match = normalized.match(/Remanejado(?:\s+por\s+conflito\s+operacional)?\s+de\s+([^\s.]+)\s+para\s+([^\s.]+)/i);
    if (!match) {
        return null;
    }

    const sourceCode = match[1]?.trim().toUpperCase() ?? "";
    const destinationCode = match[2]?.trim().toUpperCase() ?? "";
    if (!sourceCode || !destinationCode) {
        return null;
    }

    return `${sourceCode} -> ${destinationCode}`;
}

function buildContextHints(row: HistoricalOperationalPresenceRow, state: HistoricalRowState) {
    const hints: string[] = [];
    const relocationHint = resolveRelocationHint(row.notes);
    const disabledAtLabel = formatBoardTime(row.disabledAt ?? null);

    if (row.disabledAt) {
        if (state === "disabled") {
            hints.push(disabledAtLabel
                ? `${row.domain === "regulation" ? "Ramal" : "Base"} desativad${row.domain === "regulation" ? "o" : "a"} às ${disabledAtLabel}`
                : `${row.domain === "regulation" ? "Ramal" : "Base"} desativad${row.domain === "regulation" ? "o" : "a"} no turno`);
        } else {
            hints.push(disabledAtLabel ? `Desativado às ${disabledAtLabel}` : "Desativado durante o turno");
        }
    }

    if (relocationHint) {
        hints.push(`Remanejado ${relocationHint}`);
    }

    if (state === "occupied" && (row.arrivalDelayMinutes ?? 0) >= LATE_ENTRY_ALERT_MINUTES && row.startedAt) {
        const startedAtLabel = formatBoardTime(row.startedAt);
        if (startedAtLabel) {
            hints.push(`Entrada tardia (${startedAtLabel})`);
        }
    }

    if (row.issues.some((issue) => /manual|corrigid/i.test(issue))) {
        hints.push("Correção manual");
    }

    if (row.disabledReason?.trim()) {
        hints.push(row.disabledReason.trim());
    }

    return [...new Set(hints)].slice(0, 3);
}

function mapHistoricalRow(row: HistoricalOperationalPresenceRow): HistoricalOperationalRow {
    const state = resolveHistoricalRowState(row);
    const relocationHint = resolveRelocationHint(row.notes);

    return {
        domain: row.domain,
        targetId: row.targetId ?? null,
        targetCode: row.targetCode,
        targetLabel: row.targetLabel,
        sortOrder: row.sortOrder,
        state,
        occupancyId: row.occupancyId,
        doctorId: row.doctorId,
        doctorName: row.doctorName,
        displayName: row.displayName,
        doctorLabel: state === "occupied"
            ? formatDoctorSurfaceName({
                fullName: row.doctorName,
                displayName: row.displayName,
                fallback: "Medico nao identificado",
            })
            : state === "disabled"
                ? row.domain === "regulation"
                    ? "Ramal desativado"
                    : "Base desativada"
                : "Sem medico",
        arrivalAt: state === "occupied" ? row.startedAt : null,
        departureAt: state === "occupied" ? row.actualEndedAt ?? row.endedAt : null,
        roleLabel: row.roleLabel,
        source: row.source,
        notes: row.notes ?? null,
        disabledAt: row.disabledAt ?? null,
        disabledReason: row.disabledReason ?? null,
        arrivalDelayMinutes: row.arrivalDelayMinutes,
        issues: row.issues,
        isRelocated: Boolean(relocationHint),
        relocationHint,
        contextHints: buildContextHints(row, state),
    };
}

function mapTargetOption(row: HistoricalOperationalPresenceRow): HistoricalTargetOption {
    const state = resolveHistoricalRowState(row);

    return {
        targetId: row.targetId ?? null,
        targetCode: row.targetCode,
        targetLabel: row.targetLabel,
        sortOrder: row.sortOrder,
        state,
        disabled: state === "disabled",
        roleLabel: row.roleLabel,
    };
}

function resolveCheckpointStatus(row: HistoricalOperationalPresenceRow | undefined): HistoricalCheckpointStatus {
    if (!row) {
        return "vacant";
    }

    const state = resolveHistoricalRowState(row);
    if (state === "occupied") {
        return "ok";
    }

    return state === "disabled" ? "disabled" : "vacant";
}

function buildPendingCoverageIssues(rows: HistoricalOperationalRow[]) {
    return rows
        .filter((row) => row.state !== "disabled" && row.issues.length > 0)
        .map((row) => `${row.targetCode}: ${row.issues[0]}`)
        .slice(0, 6);
}

function buildRelevantPendingSummary(params: {
    regulationRows: HistoricalOperationalRow[];
    interventionRows: HistoricalOperationalRow[];
    shiftLabel: HistoricalShiftLabel;
}) {
    const interventionVacantRows = sortInterventionRows(
        params.interventionRows.filter((row) => row.state === "vacant"),
    );
    const regulationPriorityVacancies = sortRegulationRows(
        params.regulationRows.filter((row) => row.state === "vacant" && (
            isChiefRegulationPost(row.targetCode)
            || isPiamRegulationPost(row.targetCode)
            || (params.shiftLabel === "SD" && isNucleoRegulationPost(row.targetCode))
        )),
    );
    const interventionDisabledCount = params.interventionRows.filter((row) => row.state === "disabled").length;
    const interventionOccupiedCount = params.interventionRows.filter((row) => row.state === "occupied").length;
    const interventionExpectedCount = resolveCurrentShiftExpectedInterventionOccupancy(interventionDisabledCount);
    const regulationOccupiedCount = params.regulationRows.filter((row) => row.state === "occupied").length;
    const regulationExpectedCount = resolveCurrentShiftExpectedRegulationOccupancy(params.shiftLabel);
    const items: HistoricalRelevantPendingItem[] = [
        ...interventionVacantRows.map((row) => ({
            domain: row.domain,
            targetCode: row.targetCode,
            targetLabel: row.targetLabel,
            message: `${row.targetCode} sem medico`,
            priority: "critical" as const,
        })),
    ];

    if (regulationOccupiedCount < regulationExpectedCount) {
        items.push({
            domain: "regulation",
            targetCode: "REGULACAO",
            targetLabel: "Regulação",
            message: `Regulação abaixo do esperado (${regulationOccupiedCount}/${regulationExpectedCount})`,
            priority: "warning",
        });
    }

    items.push(...regulationPriorityVacancies.map((row) => ({
        domain: row.domain,
        targetCode: row.targetCode,
        targetLabel: row.targetLabel,
        message: `${row.targetCode} sem medico`,
        priority: isChiefRegulationPost(row.targetCode) ? "critical" as const : "warning" as const,
    })));

    return {
        totalItems: items.length,
        regulationExpectedCount,
        regulationOccupiedCount,
        regulationShortfall: Math.max(0, regulationExpectedCount - regulationOccupiedCount),
        regulationBelowExpected: regulationOccupiedCount < regulationExpectedCount,
        interventionExpectedCount,
        interventionOccupiedCount,
        interventionShortfall: Math.max(0, interventionExpectedCount - interventionOccupiedCount),
        interventionBelowExpected: interventionOccupiedCount < interventionExpectedCount,
        items,
    };
}

function sortRegulationRows<TRow extends { targetCode: string }>(rows: TRow[]) {
    return [...rows].sort((left, right) => compareRowsByTargetCode(left, right, compareHistoricalRegulationCodes));
}

function sortInterventionRows<TRow extends { targetCode: string }>(rows: TRow[]) {
    return [...rows].sort((left, right) => compareRowsByTargetCode(left, right, compareHistoricalInterventionCodes));
}

export function buildHistoricalOperationalBoardModel(board: HistoricalOperationalPresenceBoard): HistoricalOperationalBoard {
    const dateKey = board.operationalDate.slice(0, 10);
    const slot = {
        operationalDate: dateKey,
        shiftLabel: board.shiftLabel,
    };

    const regulationRows = sortRegulationRows(board.regulation.map(mapHistoricalRow));
    const interventionRows = sortInterventionRows(board.intervention.map(mapHistoricalRow));
    const allVisibleRows = [...regulationRows, ...interventionRows];
    const chiefRow = board.regulation.find((row) => normalizeOperationalCode(row.targetCode) === "2031");
    const nucleoRow = board.shiftLabel === "SD"
        ? board.regulation.find((row) => isNucleoRegulationPost(row.targetCode))
        : undefined;
    const piamRow = board.regulation.find((row) => isPiamRegulationPost(row.targetCode));
    const previousSlot = stepHistoricalShiftSlot(slot, "previous");
    const nextSlot = stepHistoricalShiftSlot(slot, "next");
    const relevantPending = buildRelevantPendingSummary({
        regulationRows,
        interventionRows,
        shiftLabel: board.shiftLabel,
    });

    return {
        generatedAt: board.generatedAt,
        operationalDate: board.operationalDate,
        dateKey,
        shiftLabel: board.shiftLabel,
        startedAt: board.startedAt,
        endedAt: board.endedAt,
        previousSlot: {
            ...previousSlot,
            label: formatSlotLabel(previousSlot.operationalDate, previousSlot.shiftLabel),
        },
        nextSlot: {
            ...nextSlot,
            label: formatSlotLabel(nextSlot.operationalDate, nextSlot.shiftLabel),
        },
        summary: {
            regulation: {
                occupiedCount: regulationRows.filter((row) => row.state === "occupied").length,
                chiefStatus: resolveCheckpointStatus(chiefRow),
                nucleoStatus: board.shiftLabel === "SD" ? resolveCheckpointStatus(nucleoRow) : null,
                piamStatus: resolveCheckpointStatus(piamRow),
                pendingRequiredCodes: board.regulation
                    .filter((row) => isRequiredRegulationVacancy(row.targetCode, board.shiftLabel))
                    .filter((row) => resolveHistoricalRowState(row) === "vacant")
                    .map((row) => row.targetCode),
            },
            intervention: {
                occupiedCount: interventionRows.filter((row) => row.state === "occupied").length,
                vacantCount: interventionRows.filter((row) => row.state === "vacant").length,
                disabledCount: interventionRows.filter((row) => row.state === "disabled").length,
                pendingCodes: interventionRows.filter((row) => row.state === "vacant").map((row) => row.targetCode),
            },
            pending: {
                vacantReview: allVisibleRows.filter((row) => row.state === "vacant").map((row) => row.targetCode),
                coverageIssues: buildPendingCoverageIssues(allVisibleRows),
            },
            relevantPending,
        },
        regulation: regulationRows,
        intervention: interventionRows,
        targetOptions: {
            regulation: sortRegulationRows(board.regulation.map(mapTargetOption)),
            intervention: sortInterventionRows(board.intervention.map(mapTargetOption)),
        },
    };
}

export async function getHistoricalOperationalBoard(params: HistoricalOperationalRequest = {}) {
    const request = resolveHistoricalOperationalRequest(params);
    const board = await getHistoricalOperationalPresenceBoard({
        operationalDate: request.operationalDate,
        shiftLabel: request.shiftLabel,
    });

    return buildHistoricalOperationalBoardModel(board);
}

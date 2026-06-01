import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { interventionBases, regulationPosts } from "@/db/schema";
import {
    getOperationalSlotPresenceBoard,
    type OperationalSlotPresenceBoard,
    type OperationalSlotPresenceRow,
    type PaymentAllocationBoard,
    type PaymentAllocationRow,
} from "@/services/board.service";
import { getPayableAllocationBoardsForRange } from "@/services/payable-shifts.service";
import { getBankHoursHistory } from "@/services/bank-hours-history.service";

const OPERATIONAL_LOCAL_OFFSET_MINUTES = -180;
const SLOT_DURATION_MS = 12 * 60 * 60 * 1000;
const DEFAULT_LOOKBACK_DAYS = 7;
const MAX_LOOKBACK_DAYS = 31;

export type SlotAuditPositionState = "occupied" | "pending" | "empty" | "disabled";

export interface SlotAuditPosition {
    domain: "regulation" | "intervention";
    targetCode: string;
    targetLabel: string;
    sortOrder: number;
    state: SlotAuditPositionState;
    doctorId: string | null;
    doctorName: string | null;
    displayName: string | null;
    /** Nome do médico que VAI RECEBER esta posição (o escolhido pelo payment-closing). */
    doctorLabel: string;
    /** Chegada considerada para pagamento (início da janela real). */
    arrivalAt: string | null;
    /** Saída considerada para pagamento (fim da janela real). */
    departureAt: string | null;
    /** Saldo de banco de horas DESTE plantão (mesmo número da tela de banco de horas). */
    balanceMinutes: number | null;
    /** Posição desativada hoje mas que teve pagamento neste slot (espelha o fechamento). */
    isInactiveTarget: boolean;
    disabledReason: string | null;
    issues: string[];
}

export interface SlotAuditPanel {
    domain: "regulation" | "intervention";
    title: string;
    /** Quantos ramais/bases estão ativos hoje (contagem esperada do cabeçalho). */
    activeCount: number;
    positions: SlotAuditPosition[];
}

export interface SlotAuditReport {
    generatedAt: string;
    operationalDate: string;
    shiftLabel: "SD" | "SN";
    slotStartedAt: string;
    slotEndedAt: string;
    /** Verdadeiro quando o slot selecionado já encerrou (auditoria de plantão fechado). */
    isClosed: boolean;
    summary: {
        occupiedCount: number;
        pendingCount: number;
        emptyCount: number;
        disabledCount: number;
        payableCount: number;
    };
    regulation: SlotAuditPanel;
    intervention: SlotAuditPanel;
}

export interface SlotAuditRequest {
    date?: string | null;
    shiftLabel?: "SD" | "SN" | null;
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

/** Início do slot SD (07:00 horário local) de uma data operacional, em UTC. */
function resolveSdSlotStart(parts: { year: number; month: number; day: number }) {
    // 07:00 local (offset -03) == 10:00 UTC.
    return new Date(Date.UTC(parts.year, parts.month - 1, parts.day, 10, 0, 0, 0));
}

/**
 * Resolve o plantão (slot) mais recente que já encerrou em horário local.
 * Slots: SD = 07:00–19:00; SN = 19:00–07:00 do dia seguinte.
 */
function resolveMostRecentClosedSlot(reference: Date) {
    const parts = getOperationalLocalDateParts(reference);
    const today = { year: parts.year, month: parts.month, day: parts.day };

    if (parts.hour >= 19) {
        // SN de hoje em andamento -> último encerrado: SD de hoje.
        return { operationalDate: formatDateParts(today.year, today.month, today.day), shiftLabel: "SD" as const };
    }

    const yesterdayProbe = getOperationalLocalDateParts(new Date(reference.getTime() - 86400000));
    const yesterday = { year: yesterdayProbe.year, month: yesterdayProbe.month, day: yesterdayProbe.day };

    if (parts.hour >= 7) {
        // SD de hoje em andamento -> último encerrado: SN de ontem.
        return { operationalDate: formatDateParts(yesterday.year, yesterday.month, yesterday.day), shiftLabel: "SN" as const };
    }

    // SN de ontem em andamento -> último encerrado: SD de ontem.
    return { operationalDate: formatDateParts(yesterday.year, yesterday.month, yesterday.day), shiftLabel: "SD" as const };
}

export function resolveSlotAuditRequest(params: SlotAuditRequest = {}) {
    const reference = params.reference ?? new Date();
    const requestedShift = params.shiftLabel === "SD" || params.shiftLabel === "SN" ? params.shiftLabel : null;
    const requestedDate = params.date?.trim() || null;

    if (requestedDate) {
        const parts = parseDateKey(requestedDate);
        if (!parts) {
            throw new Error("Use uma data no formato YYYY-MM-DD.");
        }

        return {
            operationalDate: formatDateParts(parts.year, parts.month, parts.day),
            shiftLabel: requestedShift ?? "SD",
            reference,
        };
    }

    const fallback = resolveMostRecentClosedSlot(reference);
    return {
        operationalDate: fallback.operationalDate,
        shiftLabel: requestedShift ?? fallback.shiftLabel,
        reference,
    };
}

async function loadActiveTargetCodes() {
    const db = getDb();
    const [regulationRows, interventionRows] = await Promise.all([
        db
            .select({ code: regulationPosts.code })
            .from(regulationPosts)
            .where(eq(regulationPosts.isActive, true)),
        db
            .select({ code: interventionBases.code })
            .from(interventionBases)
            .where(eq(interventionBases.isActive, true)),
    ]);

    return {
        regulation: new Set(regulationRows.map((row) => row.code)),
        intervention: new Set(interventionRows.map((row) => row.code)),
    };
}

function resolvePositionState(row: PaymentAllocationRow): SlotAuditPositionState {
    if (row.occupancyId) {
        return row.paymentStatus === "ready_for_payment" ? "occupied" : "pending";
    }

    if (row.disabledDuringShift || row.disabledEntireShift) {
        return "disabled";
    }

    return "empty";
}

function compareNumericCode(left: string, right: string) {
    const leftDigits = left.replace(/\D+/g, "");
    const rightDigits = right.replace(/\D+/g, "");
    if (leftDigits && rightDigits) {
        const leftNumber = Number(leftDigits);
        const rightNumber = Number(rightDigits);
        if (leftNumber !== rightNumber) {
            return leftNumber - rightNumber;
        }
    }

    return left.localeCompare(right, "pt-BR");
}

function comparePositions(left: SlotAuditPosition, right: SlotAuditPosition) {
    // Ativos primeiro; depois ordem numérica crescente do código.
    if (left.isInactiveTarget !== right.isInactiveTarget) {
        return left.isInactiveTarget ? 1 : -1;
    }

    if (left.sortOrder !== right.sortOrder) {
        return left.sortOrder - right.sortOrder;
    }

    return compareNumericCode(left.targetCode, right.targetCode);
}

function buildPositions(params: {
    rows: PaymentAllocationRow[];
    activeCodes: Set<string>;
    balanceByContinuityGroup: Map<string, number>;
    continuityGroupByOccupancyId: Map<string, string>;
}): SlotAuditPosition[] {
    return params.rows
        .map((row) => {
            const isActiveTarget = params.activeCodes.has(row.targetCode);
            const continuityGroupId = row.occupancyId
                ? params.continuityGroupByOccupancyId.get(row.occupancyId) ?? null
                : null;
            const balanceMinutes = continuityGroupId
                ? params.balanceByContinuityGroup.get(continuityGroupId) ?? null
                : null;

            return {
                domain: row.domain,
                targetCode: row.targetCode,
                targetLabel: row.targetLabel,
                sortOrder: row.sortOrder,
                state: resolvePositionState(row),
                doctorId: row.doctorId,
                doctorName: row.doctorName,
                displayName: row.displayName,
                doctorLabel: (row.displayName?.trim() || row.doctorName?.trim() || "Sem médico"),
                arrivalAt: row.startedAt,
                departureAt: row.endedAt,
                balanceMinutes,
                isInactiveTarget: !isActiveTarget,
                disabledReason: row.disabledReason ?? null,
                issues: row.issues,
            } satisfies SlotAuditPosition;
        })
        // Espelha o fechamento: posições inativas hoje só aparecem se tiveram pagamento neste slot.
        // Posições inativas vazias/desativadas (resíduo) são descartadas.
        .filter((position) => !position.isInactiveTarget || position.state === "occupied" || position.state === "pending")
        .sort(comparePositions);
}

function buildBalanceByContinuityGroup(history: Awaited<ReturnType<typeof getBankHoursHistory>>) {
    const map = new Map<string, number>();
    for (const doctor of history.doctors) {
        for (const shift of doctor.shifts) {
            if (shift.continuityGroupId && shift.balanceMinutes !== null && shift.balanceMinutes !== undefined) {
                map.set(shift.continuityGroupId, shift.balanceMinutes);
            }
        }
    }

    return map;
}

function selectBoardForShift(boards: PaymentAllocationBoard[], shiftLabel: "SD" | "SN") {
    return boards.find((board) => board.shiftLabel === shiftLabel) ?? null;
}

export async function getSlotAuditReport(params: SlotAuditRequest = {}): Promise<SlotAuditReport> {
    const request = resolveSlotAuditRequest(params);
    const dateParts = parseDateKey(request.operationalDate);
    if (!dateParts) {
        throw new Error("Use uma data no formato YYYY-MM-DD.");
    }

    const rangeStart = resolveSdSlotStart(dateParts);
    const rangeEnd = new Date(rangeStart.getTime() + (2 * SLOT_DURATION_MS));

    const [{ boards, continuityGroupByOccupancyId }, history, activeCodes] = await Promise.all([
        getPayableAllocationBoardsForRange(rangeStart, rangeEnd),
        getBankHoursHistory(),
        loadActiveTargetCodes(),
    ]);

    const balanceByContinuityGroup = buildBalanceByContinuityGroup(history);
    const board = selectBoardForShift(boards, request.shiftLabel);

    const slotStart = request.shiftLabel === "SD"
        ? rangeStart
        : new Date(rangeStart.getTime() + SLOT_DURATION_MS);
    const slotEnd = new Date(slotStart.getTime() + SLOT_DURATION_MS);

    const regulationPositions = board
        ? buildPositions({
            rows: board.regulation,
            activeCodes: activeCodes.regulation,
            balanceByContinuityGroup,
            continuityGroupByOccupancyId,
        })
        : [];
    const interventionPositions = board
        ? buildPositions({
            rows: board.intervention,
            activeCodes: activeCodes.intervention,
            balanceByContinuityGroup,
            continuityGroupByOccupancyId,
        })
        : [];

    const allPositions = [...regulationPositions, ...interventionPositions];
    const occupiedCount = allPositions.filter((position) => position.state === "occupied").length;
    const pendingCount = allPositions.filter((position) => position.state === "pending").length;
    const emptyCount = allPositions.filter((position) => position.state === "empty").length;
    const disabledCount = allPositions.filter((position) => position.state === "disabled").length;

    return {
        generatedAt: new Date().toISOString(),
        operationalDate: request.operationalDate,
        shiftLabel: request.shiftLabel,
        slotStartedAt: slotStart.toISOString(),
        slotEndedAt: slotEnd.toISOString(),
        isClosed: slotEnd.getTime() <= request.reference.getTime(),
        summary: {
            occupiedCount,
            pendingCount,
            emptyCount,
            disabledCount,
            payableCount: occupiedCount + pendingCount,
        },
        regulation: {
            domain: "regulation",
            title: "Regulação — Cobertura Telefônica",
            activeCount: activeCodes.regulation.size,
            positions: regulationPositions,
        },
        intervention: {
            domain: "intervention",
            title: "Intervenção — Bases e Viaturas",
            activeCount: activeCodes.intervention.size,
            positions: interventionPositions,
        },
    };
}

// ---------------------------------------------------------------------------
// Relatório de presença por slot (consumido pelo bot do Telegram).
//
// Mantido aqui por compatibilidade: o report privado do chefe no Telegram usa
// o board de PRESENÇA (getOperationalSlotPresenceBoard), não a alocação de
// pagamento. A view /admin/slot-audit migrou para a auditoria por posição
// acima (getSlotAuditReport). As duas APIs coexistem e compartilham helpers.
// ---------------------------------------------------------------------------

export interface OperationalSlotAuditEntry {
    domain: "regulation" | "intervention";
    targetCode: string;
    targetLabel: string;
    status: "occupied" | "empty" | "disabled";
    doctorId: string | null;
    doctorName: string | null;
    displayName: string | null;
    doctorLabel: string;
    disabledReason: string | null;
}

export interface OperationalSlotAuditSlot {
    operationalDate: string;
    shiftLabel: "SD" | "SN";
    generatedAt: string;
    totalTargets: number;
    occupiedCount: number;
    emptyCount: number;
    disabledCount: number;
    regulation: OperationalSlotAuditEntry[];
    intervention: OperationalSlotAuditEntry[];
}

export interface OperationalSlotAuditReport {
    generatedAt: string;
    startDate: string;
    endDate: string;
    shiftLabel: "SD" | "SN" | null;
    dayCount: number;
    summary: {
        slotCount: number;
        totalTargets: number;
        occupiedCount: number;
        emptyCount: number;
        disabledCount: number;
    };
    slots: OperationalSlotAuditSlot[];
}

export interface OperationalSlotAuditRequest {
    startDate?: string | null;
    endDate?: string | null;
    shiftLabel?: "SD" | "SN" | null;
    reference?: Date;
}

export interface ResolvedOperationalSlotAuditRequest {
    startDate: string;
    endDate: string;
    shiftLabel: "SD" | "SN" | null;
    dayCount: number;
    slots: Array<{ operationalDate: string; shiftLabel: "SD" | "SN" }>;
}

function addOperationalLocalDays(parts: { year: number; month: number; day: number }, days: number) {
    const noonUtc = Date.UTC(parts.year, parts.month - 1, parts.day, 15, 0, 0, 0);
    return getOperationalLocalDateParts(new Date(noonUtc + (days * 86400000)));
}

function compareDateKeys(left: string, right: string) {
    return left.localeCompare(right);
}

function resolveDefaultDateRange(reference = new Date()) {
    const endParts = getOperationalLocalDateParts(reference);
    const startParts = addOperationalLocalDays(endParts, -(DEFAULT_LOOKBACK_DAYS - 1));
    return {
        startDate: formatDateParts(startParts.year, startParts.month, startParts.day),
        endDate: formatDateParts(endParts.year, endParts.month, endParts.day),
    };
}

function mapAuditEntry(row: OperationalSlotPresenceRow): OperationalSlotAuditEntry {
    return {
        domain: row.domain,
        targetCode: row.targetCode,
        targetLabel: row.targetLabel,
        status: row.status,
        doctorId: row.doctorId,
        doctorName: row.doctorName,
        displayName: row.displayName,
        doctorLabel: row.doctorLabel,
        disabledReason: row.disabledReason ?? null,
    };
}

function countEntries(entries: OperationalSlotAuditEntry[], status: OperationalSlotAuditEntry["status"]) {
    return entries.filter((entry) => entry.status === status).length;
}

export function resolveOperationalSlotAuditRequest(params: OperationalSlotAuditRequest = {}): ResolvedOperationalSlotAuditRequest {
    const fallback = resolveDefaultDateRange(params.reference);
    const startDate = params.startDate?.trim() || fallback.startDate;
    const endDate = params.endDate?.trim() || startDate || fallback.endDate;

    const startParts = parseDateKey(startDate);
    const endParts = parseDateKey(endDate);
    if (!startParts || !endParts) {
        throw new Error("Use datas no formato YYYY-MM-DD.");
    }

    if (compareDateKeys(startDate, endDate) > 0) {
        throw new Error("A data inicial nao pode ser maior que a final.");
    }

    const slotDates: string[] = [];
    let cursor = startParts;
    while (compareDateKeys(formatDateParts(cursor.year, cursor.month, cursor.day), endDate) <= 0) {
        slotDates.push(formatDateParts(cursor.year, cursor.month, cursor.day));
        cursor = addOperationalLocalDays(cursor, 1);
    }

    if (slotDates.length > MAX_LOOKBACK_DAYS) {
        throw new Error(`A consulta aceita no maximo ${MAX_LOOKBACK_DAYS} dias por vez.`);
    }

    const shifts = params.shiftLabel ? [params.shiftLabel] : ["SD", "SN"] as const;
    const slots = slotDates
        .slice()
        .reverse()
        .flatMap((operationalDate) => shifts.map((shiftLabel) => ({ operationalDate, shiftLabel })));

    return {
        startDate,
        endDate,
        shiftLabel: params.shiftLabel ?? null,
        dayCount: slotDates.length,
        slots,
    };
}

export function buildOperationalSlotAuditReport(params: {
    startDate: string;
    endDate: string;
    shiftLabel?: "SD" | "SN" | null;
    boards: OperationalSlotPresenceBoard[];
}): OperationalSlotAuditReport {
    const slots = params.boards.map((board) => {
        const regulation = board.regulation.map(mapAuditEntry);
        const intervention = board.intervention.map(mapAuditEntry);
        const entries = [...regulation, ...intervention];

        return {
            operationalDate: board.operationalDate.slice(0, 10),
            shiftLabel: board.shiftLabel,
            generatedAt: board.generatedAt,
            totalTargets: entries.length,
            occupiedCount: countEntries(entries, "occupied"),
            emptyCount: countEntries(entries, "empty"),
            disabledCount: countEntries(entries, "disabled"),
            regulation,
            intervention,
        } satisfies OperationalSlotAuditSlot;
    });

    const summary = slots.reduce((accumulator, slot) => ({
        slotCount: accumulator.slotCount + 1,
        totalTargets: accumulator.totalTargets + slot.totalTargets,
        occupiedCount: accumulator.occupiedCount + slot.occupiedCount,
        emptyCount: accumulator.emptyCount + slot.emptyCount,
        disabledCount: accumulator.disabledCount + slot.disabledCount,
    }), {
        slotCount: 0,
        totalTargets: 0,
        occupiedCount: 0,
        emptyCount: 0,
        disabledCount: 0,
    });

    const dayKeys = new Set(slots.map((slot) => slot.operationalDate));

    return {
        generatedAt: new Date().toISOString(),
        startDate: params.startDate,
        endDate: params.endDate,
        shiftLabel: params.shiftLabel ?? null,
        dayCount: dayKeys.size,
        summary,
        slots,
    };
}

export async function getOperationalSlotAuditReport(params: OperationalSlotAuditRequest = {}) {
    const request = resolveOperationalSlotAuditRequest(params);
    const boards = await Promise.all(request.slots.map((slot) => getOperationalSlotPresenceBoard({
        operationalDate: slot.operationalDate,
        shiftLabel: slot.shiftLabel,
    })));

    return buildOperationalSlotAuditReport({
        startDate: request.startDate,
        endDate: request.endDate,
        shiftLabel: request.shiftLabel,
        boards,
    });
}

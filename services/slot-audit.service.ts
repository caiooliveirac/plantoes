import { getOperationalSlotPresenceBoard, type OperationalSlotPresenceBoard, type OperationalSlotPresenceRow } from "@/services/board.service";

const OPERATIONAL_LOCAL_OFFSET_MINUTES = -180;
const DEFAULT_LOOKBACK_DAYS = 7;
const MAX_LOOKBACK_DAYS = 31;

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

function toOperationalLocalClock(date: Date) {
    return new Date(date.getTime() + (OPERATIONAL_LOCAL_OFFSET_MINUTES * 60000));
}

function getOperationalLocalDateParts(date: Date) {
    const local = toOperationalLocalClock(date);
    return {
        year: local.getUTCFullYear(),
        month: local.getUTCMonth() + 1,
        day: local.getUTCDate(),
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
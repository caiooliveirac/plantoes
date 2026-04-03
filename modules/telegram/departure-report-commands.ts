export interface ParsedTelegramDepartureReportCommand {
    name: "departure_report";
    operationalDate: string | null;
    shiftLabel: "SD" | "SN" | null;
    rawBody: string;
}

const TELEGRAM_DEPARTURE_REPORT_PREFIX = /^\/saidas(?:@\w+)?\b/i;

function normalizeShiftToken(value: string | null | undefined) {
    const normalized = value?.trim().toUpperCase();
    if (!normalized) {
        return null;
    }

    if (normalized === "SD" || normalized === "DIURNO") {
        return "SD" as const;
    }

    if (normalized === "SN" || normalized === "NOTURNO") {
        return "SN" as const;
    }

    return null;
}

function formatDateParts(year: number, month: number, day: number) {
    return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function normalizeDateToken(value: string | null | undefined, reference = new Date()) {
    const normalized = value?.trim().toLowerCase();
    if (!normalized) {
        return null;
    }

    if (normalized === "hoje") {
        const local = new Date(reference.getTime() - (3 * 60 * 60000));
        return formatDateParts(local.getUTCFullYear(), local.getUTCMonth() + 1, local.getUTCDate());
    }

    if (normalized === "ontem") {
        const local = new Date(reference.getTime() - (3 * 60 * 60000) - 86400000);
        return formatDateParts(local.getUTCFullYear(), local.getUTCMonth() + 1, local.getUTCDate());
    }

    const isoMatch = normalized.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (isoMatch) {
        return `${isoMatch[1]}-${isoMatch[2]}-${isoMatch[3]}`;
    }

    const brMatch = normalized.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
    if (brMatch) {
        return `${brMatch[3]}-${brMatch[2]}-${brMatch[1]}`;
    }

    return null;
}

export const TELEGRAM_DEPARTURE_REPORT_USAGE = "/saidas [ontem|hoje|YYYY-MM-DD] [SD|SN]";

export function isTelegramDepartureReportCommandText(text: string) {
    return TELEGRAM_DEPARTURE_REPORT_PREFIX.test(text.trim());
}

export function parseTelegramDepartureReportCommand(text: string, reference = new Date()): ParsedTelegramDepartureReportCommand | null {
    const match = text.trim().match(/^\/saidas(?:@\w+)?\s*([\s\S]*)$/i);
    if (!match) {
        return null;
    }

    const rawBody = match[1]?.trim() ?? "";
    if (!rawBody) {
        return {
            name: "departure_report",
            operationalDate: null,
            shiftLabel: null,
            rawBody,
        };
    }

    const tokens = rawBody.split(/\s+/).filter(Boolean);
    if (tokens.length !== 2) {
        return null;
    }

    const operationalDate = normalizeDateToken(tokens[0], reference);
    const shiftLabel = normalizeShiftToken(tokens[1]);
    if (!operationalDate || !shiftLabel) {
        return null;
    }

    return {
        name: "departure_report",
        operationalDate,
        shiftLabel,
        rawBody,
    };
}
export interface ParsedTelegramSlotAuditCommand {
    name: "slot_audit";
    startDate: string | null;
    endDate: string | null;
    shiftLabel: "SD" | "SN" | null;
    rawBody: string;
}

const TELEGRAM_SLOT_AUDIT_PREFIX = /^\/slots(?:@\w+)?\b/i;

function formatDateParts(year: number, month: number, day: number) {
    return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function normalizeShiftToken(value: string | null | undefined) {
    const normalized = value?.trim().toUpperCase();
    if (normalized === "SD" || normalized === "DIURNO") {
        return "SD" as const;
    }

    if (normalized === "SN" || normalized === "NOTURNO") {
        return "SN" as const;
    }

    return null;
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

export const TELEGRAM_SLOT_AUDIT_USAGE = "/slots [YYYY-MM-DD [YYYY-MM-DD]] [SD|SN]";

export function isTelegramSlotAuditCommandText(text: string) {
    return TELEGRAM_SLOT_AUDIT_PREFIX.test(text.trim());
}

export function parseTelegramSlotAuditCommand(text: string, reference = new Date()): ParsedTelegramSlotAuditCommand | null {
    const match = text.trim().match(/^\/slots(?:@\w+)?\s*([\s\S]*)$/i);
    if (!match) {
        return null;
    }

    const rawBody = match[1]?.trim() ?? "";
    if (!rawBody) {
        return {
            name: "slot_audit",
            startDate: null,
            endDate: null,
            shiftLabel: null,
            rawBody,
        };
    }

    const tokens = rawBody.split(/\s+/).filter(Boolean);
    let startDate: string | null = null;
    let endDate: string | null = null;
    let shiftLabel: "SD" | "SN" | null = null;

    if (tokens.length === 1) {
        startDate = normalizeDateToken(tokens[0], reference);
        endDate = startDate;
    } else if (tokens.length === 2) {
        startDate = normalizeDateToken(tokens[0], reference);
        const candidateShift = normalizeShiftToken(tokens[1]);
        if (candidateShift) {
            endDate = startDate;
            shiftLabel = candidateShift;
        } else {
            endDate = normalizeDateToken(tokens[1], reference);
        }
    } else if (tokens.length === 3) {
        startDate = normalizeDateToken(tokens[0], reference);
        endDate = normalizeDateToken(tokens[1], reference);
        shiftLabel = normalizeShiftToken(tokens[2]);
    } else {
        return null;
    }

    if (!startDate || !endDate) {
        return null;
    }

    if (tokens.length === 3 && !shiftLabel) {
        return null;
    }

    return {
        name: "slot_audit",
        startDate,
        endDate,
        shiftLabel,
        rawBody,
    };
}
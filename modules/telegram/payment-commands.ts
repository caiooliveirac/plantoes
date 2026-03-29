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

export const TELEGRAM_PAYMENT_REPORT_USAGE = "/pagamento conferir [YYYY-MM-DD] [SD|SN]";
export const TELEGRAM_PAYMENT_CORRECTION_USAGE = "/pagamento corrigir alvo | Nome Completo | [YYYY-MM-DD] | [SD|SN] | [motivo]";

export type TelegramPaymentAdminCommand =
    | {
        name: "payment_report";
        operationalDate: string | null;
        shiftLabel: "SD" | "SN" | null;
        rawBody: string;
    }
    | {
        name: "payment_correct";
        targetCode: string;
        doctorName: string;
        operationalDate: string | null;
        shiftLabel: "SD" | "SN" | null;
        note: string | null;
        rawBody: string;
    };

export function isTelegramPaymentAdminCommandText(text: string) {
    return /^\/pagamento(?:@\w+)?\b/i.test(text.trim());
}

export function parseTelegramPaymentAdminCommand(text: string, reference = new Date()): TelegramPaymentAdminCommand | null {
    const match = text.trim().match(/^\/pagamento(?:@\w+)?\s+(conferir|corrigir)\b\s*([\s\S]*)$/i);
    if (!match) {
        return null;
    }

    const action = match[1]?.toLowerCase();
    const rawBody = match[2]?.trim() ?? "";

    if (action === "conferir") {
        if (!rawBody) {
            return {
                name: "payment_report",
                operationalDate: null,
                shiftLabel: null,
                rawBody,
            };
        }

        const tokens = rawBody.split(/\s+/).filter(Boolean);
        if (tokens.length === 1) {
            const shiftLabel = normalizeShiftToken(tokens[0]);
            if (!shiftLabel) {
                return null;
            }

            return {
                name: "payment_report",
                operationalDate: null,
                shiftLabel,
                rawBody,
            };
        }

        if (tokens.length !== 2) {
            return null;
        }

        const operationalDate = normalizeDateToken(tokens[0], reference);
        const shiftLabel = normalizeShiftToken(tokens[1]);
        if (!operationalDate || !shiftLabel) {
            return null;
        }

        return {
            name: "payment_report",
            operationalDate,
            shiftLabel,
            rawBody,
        };
    }

    const parts = rawBody.split("|").map((item) => item.trim()).filter((item, index) => index < 2 || item.length > 0);
    if (parts.length < 2) {
        return null;
    }

    const targetCode = parts[0]?.trim().toUpperCase().replace(/\s+/g, "") ?? "";
    const doctorName = parts[1]?.trim() ?? "";
    if (!targetCode || !doctorName) {
        return null;
    }

    let operationalDate: string | null = null;
    let shiftLabel: "SD" | "SN" | null = null;
    let note: string | null = null;

    if (parts.length >= 3) {
        const maybeDate = normalizeDateToken(parts[2], reference);
        const maybeShift = normalizeShiftToken(parts[2]);
        if (maybeDate) {
            operationalDate = maybeDate;
            shiftLabel = parts[3] ? normalizeShiftToken(parts[3]) : null;
            if (!shiftLabel) {
                return null;
            }
            note = parts.slice(4).join(" | ").trim() || null;
        } else if (maybeShift) {
            shiftLabel = maybeShift;
            note = parts.slice(3).join(" | ").trim() || null;
        } else {
            note = parts.slice(2).join(" | ").trim() || null;
        }
    }

    return {
        name: "payment_correct",
        targetCode,
        doctorName,
        operationalDate,
        shiftLabel,
        note,
        rawBody,
    };
}
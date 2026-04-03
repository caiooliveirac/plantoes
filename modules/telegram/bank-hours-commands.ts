export interface ParsedTelegramBankHoursCommand {
    name: "bank_hours_override";
    doctorName: string;
    shiftLabel: "SD" | "SN";
    balanceMinutes: number;
    rawBody: string;
}

export const TELEGRAM_BANK_HOURS_USAGE = "/banco Nome Completo SD 0";

export function isTelegramBankHoursCommandText(text: string) {
    return /^\/banco(?:@\w+)?\b/i.test(text.trim());
}

export function parseTelegramBankHoursCommand(text: string): ParsedTelegramBankHoursCommand | null {
    const match = text.trim().match(/^\/banco(?:@(\w+))?\s+([\s\S]+?)\s+(SD|SN)\s+([+-]?\d+)\s*$/i);
    if (!match) {
        return null;
    }

    const doctorName = match[2]?.trim() ?? "";
    const shiftLabel = match[3]?.trim().toUpperCase();
    const balanceMinutes = Number(match[4]);
    if (!doctorName || !Number.isInteger(balanceMinutes) || (shiftLabel !== "SD" && shiftLabel !== "SN")) {
        return null;
    }

    return {
        name: "bank_hours_override",
        doctorName,
        shiftLabel,
        balanceMinutes,
        rawBody: text.trim().replace(/^\/banco(?:@\w+)?/i, "").trim(),
    };
}
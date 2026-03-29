export interface ParsedTelegramShiftReportCommand {
    name: "shift_report";
    rawBody: string;
}

const TELEGRAM_SHIFT_REPORT_PREFIX = /^\/plantao(?:@\w+)?\b/i;

export function isTelegramShiftReportCommandText(text: string) {
    return TELEGRAM_SHIFT_REPORT_PREFIX.test(text.trim());
}

export function parseTelegramShiftReportCommand(text: string): ParsedTelegramShiftReportCommand | null {
    const match = text.trim().match(/^\/plantao(?:@\w+)?\s*([\s\S]*)$/i);
    if (!match) {
        return null;
    }

    const rawBody = match[1]?.trim() ?? "";
    if (rawBody && !/^(agora|atual)$/i.test(rawBody)) {
        return null;
    }

    return {
        name: "shift_report",
        rawBody,
    };
}
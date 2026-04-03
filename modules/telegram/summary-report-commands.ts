export interface ParsedTelegramSummaryReportCommand {
    name: "summary_report";
    rawBody: string;
}

const TELEGRAM_SUMMARY_REPORT_PREFIX = /^\/resumo(?:@\w+)?\b/i;

export const TELEGRAM_SUMMARY_REPORT_USAGE = "/resumo";

export function isTelegramSummaryReportCommandText(text: string) {
    return TELEGRAM_SUMMARY_REPORT_PREFIX.test(text.trim());
}

export function parseTelegramSummaryReportCommand(text: string): ParsedTelegramSummaryReportCommand | null {
    const match = text.trim().match(/^\/resumo(?:@(\w+))?\s*([\s\S]*)$/i);
    if (!match) {
        return null;
    }

    const rawBody = match[2]?.trim() ?? "";
    if (rawBody && !/^(agora|atual)$/i.test(rawBody)) {
        return null;
    }

    return {
        name: "summary_report",
        rawBody,
    };
}
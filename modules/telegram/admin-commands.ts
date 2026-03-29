export const TELEGRAM_DOCTOR_ADMIN_COMMAND_USAGE = "/medico cadastrar Nome Completo | Nome de exibicao | codigo";

const TELEGRAM_DOCTOR_ADMIN_PREFIX = /^\/medico(?:@\w+)?\b/i;

export interface ParsedTelegramDoctorAdminCommand {
    name: "doctor_create";
    fullName: string;
    displayName: string | null;
    externalCode: string | null;
    rawBody: string;
}

export function isTelegramDoctorAdminCommandText(text: string) {
    return TELEGRAM_DOCTOR_ADMIN_PREFIX.test(text.trim());
}

export function parseTelegramDoctorAdminCommand(text: string): ParsedTelegramDoctorAdminCommand | null {
    const match = text.trim().match(/^\/medico(?:@\w+)?\s+(?:cadastrar|cadastro|novo)\b\s*([\s\S]*)$/i);
    if (!match) {
        return null;
    }

    const rawBody = match[1]?.trim() ?? "";
    if (!rawBody) {
        return null;
    }

    const parts = rawBody.split("|").map((item) => item.trim());
    if (parts.length === 0 || parts.length > 3 || !parts[0]) {
        return null;
    }

    return {
        name: "doctor_create",
        fullName: parts[0],
        displayName: parts[1] || null,
        externalCode: parts[2] || null,
        rawBody,
    };
}
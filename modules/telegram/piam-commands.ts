export const TELEGRAM_PIAM_COMMAND_USAGE =
    "/piam Nome do medico  |  /piam remover Nome do medico  |  /piam listar";

const TELEGRAM_PIAM_PREFIX = /^\/piam(?:@\w+)?\b/i;

export type ParsedTelegramPiamCommand =
    | { name: "piam_assign"; lookup: string; rawBody: string }
    | { name: "piam_unassign"; lookup: string; rawBody: string }
    | { name: "piam_list"; rawBody: string };

export function isTelegramPiamCommandText(text: string) {
    return TELEGRAM_PIAM_PREFIX.test(text.trim());
}

export function parseTelegramPiamCommand(text: string): ParsedTelegramPiamCommand | null {
    const match = text.trim().match(/^\/piam(?:@\w+)?\s*([\s\S]*)$/i);
    if (!match) {
        return null;
    }

    const rawBody = match[1]?.trim() ?? "";
    if (!rawBody) {
        return null;
    }

    const lowered = rawBody.toLowerCase();
    if (lowered === "listar" || lowered === "list" || lowered === "ls") {
        return { name: "piam_list", rawBody };
    }

    const removeMatch = rawBody.match(/^(?:remover|remove|rm|tirar|desmarcar)\s+([\s\S]+)$/i);
    if (removeMatch) {
        const lookup = removeMatch[1].trim();
        if (!lookup) {
            return null;
        }
        return { name: "piam_unassign", lookup, rawBody };
    }

    return { name: "piam_assign", lookup: rawBody, rawBody };
}

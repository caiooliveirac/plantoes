export const TELEGRAM_DOCTOR_ADMIN_COMMAND_USAGE = "/medico cadastrar Nome Completo | Nome de exibicao | codigo | alias 1, alias 2";

const TELEGRAM_DOCTOR_ADMIN_PREFIX = /^\/medico(?:@\w+)?\b/i;

export interface ParsedTelegramDoctorAdminCommand {
    name: "doctor_create" | "doctor_update";
    lookup?: string;
    fullName: string;
    displayName?: string | null;
    externalCode?: string | null;
    aliases?: string[];
    hasDisplayName?: boolean;
    hasExternalCode?: boolean;
    hasAliases?: boolean;
    rawBody: string;
}

export function isTelegramDoctorAdminCommandText(text: string) {
    return TELEGRAM_DOCTOR_ADMIN_PREFIX.test(text.trim());
}

export function parseTelegramDoctorAdminCommand(text: string): ParsedTelegramDoctorAdminCommand | null {
    const match = text.trim().match(/^\/medico(?:@\w+)?\s+(cadastrar|cadastro|novo|atualizar|editar)\b\s*([\s\S]*)$/i);
    if (!match) {
        return null;
    }

    const action = match[1]?.trim().toLowerCase() ?? "";
    const rawBody = match[2]?.trim() ?? "";
    if (!rawBody) {
        return null;
    }

    const parts = rawBody.split("|").map((item) => item.trim());
    if (parts.length === 0 || parts.length > 5 || !parts[0]) {
        return null;
    }

    if (action === "atualizar" || action === "editar") {
        if (parts.length < 2 || !parts[1]) {
            return null;
        }

        return {
            name: "doctor_update",
            lookup: parts[0],
            fullName: parts[1],
            displayName: parts.length >= 3 ? (parts[2] || null) : undefined,
            externalCode: parts.length >= 4 ? (parts[3] || null) : undefined,
            aliases: parts.length >= 5
                ? parts[4].split(",").map((item) => item.trim()).filter(Boolean)
                : undefined,
            hasDisplayName: parts.length >= 3,
            hasExternalCode: parts.length >= 4,
            hasAliases: parts.length >= 5,
            rawBody,
        };
    }

    return {
        name: "doctor_create",
        fullName: parts[0],
        displayName: parts[1] || null,
        externalCode: parts[2] || null,
        aliases: parts.length >= 4
            ? parts[3].split(",").map((item) => item.trim()).filter(Boolean)
            : [],
        hasDisplayName: parts.length >= 2,
        hasExternalCode: parts.length >= 3,
        hasAliases: parts.length >= 4,
        rawBody,
    };
}

// ─── /desfazer — Admin Undo Command ────────────────────────────────────

const TELEGRAM_UNDO_PREFIX = /^\/desfazer(?:@\w+)?\b/i;

export interface ParsedTelegramUndoCommand {
    name: "undo_list" | "undo_confirm";
    /** 1-based index from the list, present when confirming. */
    index: number | null;
    rawBody: string;
}

export function isTelegramUndoCommandText(text: string) {
    return TELEGRAM_UNDO_PREFIX.test(text.trim());
}

export function parseTelegramUndoCommand(text: string): ParsedTelegramUndoCommand | null {
    const match = text.trim().match(/^\/desfazer(?:@\w+)?\s*(.*)$/i);
    if (!match) {
        return null;
    }

    const rawBody = match[1]?.trim() ?? "";

    if (!rawBody) {
        return { name: "undo_list", index: null, rawBody };
    }

    const numMatch = rawBody.match(/^(\d+)$/);
    if (numMatch) {
        const index = parseInt(numMatch[1], 10);
        if (index < 1 || index > 20) {
            return null;
        }
        return { name: "undo_confirm", index, rawBody };
    }

    // Unrecognized argument
    return null;
}
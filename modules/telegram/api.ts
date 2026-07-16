function getBaseUrl() {
    const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
    if (!token) {
        throw new Error("TELEGRAM_BOT_TOKEN is not configured.");
    }

    return `https://api.telegram.org/bot${token}`;
}

export interface TelegramUser {
    id: number;
    first_name: string;
    last_name?: string;
    username?: string;
}

export interface TelegramMessage {
    message_id: number;
    from?: TelegramUser;
    chat: { id: number; type: string; title?: string };
    date: number;
    text?: string;
    /** Mensagem citada quando o usuário responde (reply) a um balão — ex.: responder "SD" ao prompt do PIAM. */
    reply_to_message?: TelegramMessage;
}

export interface TelegramCallbackQuery {
    id: string;
    from: TelegramUser;
    message?: TelegramMessage;
    chat_instance?: string;
    data?: string;
}

export interface TelegramUpdate {
    update_id: number;
    message?: TelegramMessage;
    callback_query?: TelegramCallbackQuery;
}

export interface TelegramReplyKeyboardMarkup {
    keyboard: Array<Array<{ text: string }>>;
    resize_keyboard?: boolean;
    one_time_keyboard?: boolean;
    selective?: boolean;
}

export interface TelegramReplyKeyboardRemove {
    remove_keyboard: true;
    selective?: boolean;
}

export interface TelegramInlineKeyboardButton {
    text: string;
    /** Payload devolvido no callback_query ao tocar (≤ 64 bytes). Omitir em botões de link. */
    callback_data?: string;
    /** Botão de link (abre URL, não gera callback) — ex.: levar ao privado do bot. */
    url?: string;
}

/** Type guard: o botão tem callback_data (não é botão de link)? Use antes de ler o payload. */
export function isCallbackButton(
    button: TelegramInlineKeyboardButton,
): button is TelegramInlineKeyboardButton & { callback_data: string } {
    return typeof button.callback_data === "string" && button.callback_data.length > 0;
}

export interface TelegramInlineKeyboardMarkup {
    inline_keyboard: TelegramInlineKeyboardButton[][];
}

export type TelegramReplyMarkup =
    | TelegramReplyKeyboardMarkup
    | TelegramReplyKeyboardRemove
    | TelegramInlineKeyboardMarkup;

async function callApi<T>(method: string, body: Record<string, unknown>) {
    const maxAttempts = 3;
    let lastError: unknown;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            const response = await fetch(`${getBaseUrl()}/${method}`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(body),
                signal: AbortSignal.timeout(10_000),
            });

            const data = await response.json();
            if (!data.ok) {
                // Erro de aplicacao do Telegram (chat invalido, bloqueado...) nao e
                // transitorio: lanca e NAO retenta.
                throw new Error(`Telegram API ${method}: ${data.description ?? "request failed"}`);
            }

            return data.result as T;
        } catch (error) {
            lastError = error;
            // So retenta falha de transporte (fetch failed / timeout). Erro de aplicacao
            // ("Telegram API ...") cai aqui mas nao e transitorio -> relanca na hora.
            const transient = error instanceof Error
                && (error.name === "TimeoutError"
                    || error.message === "fetch failed"
                    || error.message.toLowerCase().includes("network"));
            if (!transient || attempt === maxAttempts) {
                throw error;
            }
            await new Promise((resolve) => setTimeout(resolve, 250 * attempt));
        }
    }

    throw lastError;
}

/**
 * Opções de formatação por callsite. `parseMode: "Markdown"` liga negrito/código
 * no balão — SÓ use em copies cujas interpolações passam por escapeTelegramMarkdown().
 * A env TELEGRAM_PARSE_MODE=off desliga globalmente (rollback sem deploy).
 */
export interface TelegramFormatOptions {
    parseMode?: "Markdown";
}

function resolveParseMode(options?: TelegramFormatOptions): "Markdown" | undefined {
    if (!options?.parseMode) {
        return undefined;
    }
    if (process.env.TELEGRAM_PARSE_MODE?.trim().toLowerCase() === "off") {
        return undefined;
    }
    return options.parseMode;
}

/**
 * Erro de aplicação do Telegram por entidade Markdown quebrada (ex.: `*` sem par
 * vindo de texto não escapado). Não é transitório: o retry de transporte do callApi
 * já relançou na hora — aqui decidimos reenviar UMA vez sem parse_mode.
 */
function isParseEntitiesError(error: unknown): boolean {
    return error instanceof Error && error.message.toLowerCase().includes("can't parse entities");
}

/**
 * Escapa os 4 caracteres ativos do Markdown v1 do Telegram (`_`, `*`, `` ` ``, `[`).
 * Aplique em TODA interpolação (nomes do banco, display names, tokens do parser)
 * antes de enviar com `parseMode: "Markdown"`.
 */
export function escapeTelegramMarkdown(value: string): string {
    return value.replace(/([_*`\[])/g, "\\$1");
}

export async function sendMessage(
    chatId: string | number,
    text: string,
    replyToMessageId?: number,
    replyMarkup?: TelegramReplyMarkup,
    options?: TelegramFormatOptions,
) {
    const body: Record<string, unknown> = {
        chat_id: Number(chatId),
        text,
        ...(replyToMessageId ? { reply_to_message_id: replyToMessageId } : {}),
        ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
    };

    const parseMode = resolveParseMode(options);
    if (!parseMode) {
        return callApi<TelegramMessage>("sendMessage", body);
    }

    try {
        return await callApi<TelegramMessage>("sendMessage", { ...body, parse_mode: parseMode });
    } catch (error) {
        // Degradação graciosa: Markdown malformado nunca pode engolir a mensagem.
        if (isParseEntitiesError(error)) {
            return callApi<TelegramMessage>("sendMessage", body);
        }
        throw error;
    }
}

export function buildChoiceKeyboard(rows: string[][]): TelegramReplyKeyboardMarkup {
    return {
        keyboard: rows.map((row) => row.map((text) => ({ text }))),
        resize_keyboard: true,
        one_time_keyboard: true,
    };
}

export const REMOVE_KEYBOARD: TelegramReplyKeyboardRemove = { remove_keyboard: true };

export function buildInlineKeyboard(rows: TelegramInlineKeyboardButton[][]): TelegramInlineKeyboardMarkup {
    return { inline_keyboard: rows };
}

/** Responde ao toque do botão inline (fecha o "loading" do cliente Telegram). */
export function answerCallbackQuery(callbackQueryId: string, text?: string, showAlert = false) {
    return callApi<boolean>("answerCallbackQuery", {
        callback_query_id: callbackQueryId,
        ...(text ? { text } : {}),
        ...(showAlert ? { show_alert: true } : {}),
    });
}

/** Edita o texto de uma mensagem já enviada (e remove o teclado inline por padrão). */
export async function editMessageText(
    chatId: string | number,
    messageId: number,
    text: string,
    replyMarkup?: TelegramInlineKeyboardMarkup,
    options?: TelegramFormatOptions,
) {
    const body: Record<string, unknown> = {
        chat_id: Number(chatId),
        message_id: messageId,
        text,
        ...(replyMarkup ? { reply_markup: replyMarkup } : { reply_markup: { inline_keyboard: [] } }),
    };

    const parseMode = resolveParseMode(options);
    if (!parseMode) {
        return callApi<TelegramMessage | boolean>("editMessageText", body);
    }

    try {
        return await callApi<TelegramMessage | boolean>("editMessageText", { ...body, parse_mode: parseMode });
    } catch (error) {
        // Mesma degradação graciosa do sendMessage: a edição não pode se perder.
        if (isParseEntitiesError(error)) {
            return callApi<TelegramMessage | boolean>("editMessageText", body);
        }
        throw error;
    }
}

let cachedBotUsername: string | null = null;

/**
 * Username do bot sem `@` (para montar links t.me/... e reconhecer sufixo @bot em
 * comandos). Usa TELEGRAM_BOT_USERNAME se definida; senão consulta getMe uma única
 * vez e cacheia no módulo.
 */
export async function getBotUsername(): Promise<string> {
    const fromEnv = process.env.TELEGRAM_BOT_USERNAME?.trim();
    if (fromEnv) {
        return fromEnv.replace(/^@/, "");
    }
    if (cachedBotUsername) {
        return cachedBotUsername;
    }
    const me = await callApi<TelegramUser>("getMe", {});
    if (!me.username) {
        throw new Error("Telegram getMe did not return a bot username.");
    }
    cachedBotUsername = me.username.replace(/^@/, "");
    return cachedBotUsername;
}

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
}

export interface TelegramUpdate {
    update_id: number;
    message?: TelegramMessage;
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

export type TelegramReplyMarkup = TelegramReplyKeyboardMarkup | TelegramReplyKeyboardRemove;

async function callApi<T>(method: string, body: Record<string, unknown>) {
    const response = await fetch(`${getBaseUrl()}/${method}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
    });

    const data = await response.json();
    if (!data.ok) {
        throw new Error(`Telegram API ${method}: ${data.description ?? "request failed"}`);
    }

    return data.result as T;
}

export function sendMessage(
    chatId: string | number,
    text: string,
    replyToMessageId?: number,
    replyMarkup?: TelegramReplyMarkup,
) {
    return callApi<TelegramMessage>("sendMessage", {
        chat_id: Number(chatId),
        text,
        ...(replyToMessageId ? { reply_to_message_id: replyToMessageId } : {}),
        ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
    });
}

export function buildChoiceKeyboard(rows: string[][]): TelegramReplyKeyboardMarkup {
    return {
        keyboard: rows.map((row) => row.map((text) => ({ text }))),
        resize_keyboard: true,
        one_time_keyboard: true,
    };
}

export const REMOVE_KEYBOARD: TelegramReplyKeyboardRemove = { remove_keyboard: true };
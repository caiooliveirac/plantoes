function parseChatIds(raw?: string) {
    if (!raw) {
        return [] as string[];
    }

    return [...new Set(
        raw
            .split(",")
            .map((value) => value.trim())
            .filter(Boolean),
    )];
}

function parseTelegramUserIds(raw?: string) {
    if (!raw) {
        return [] as string[];
    }

    return [...new Set(
        raw
            .split(",")
            .map((value) => value.trim())
            .filter(Boolean),
    )];
}

export function getTelegramPrivateControlUserIds() {
    return parseTelegramUserIds(process.env.TELEGRAM_PRIVATE_CONTROL_USER_IDS);
}

export function getTelegramAllowedChatIds() {
    const explicit = parseChatIds(process.env.TELEGRAM_ALLOWED_CHAT_IDS);
    if (explicit.length > 0) {
        return explicit;
    }

    return parseChatIds(process.env.TELEGRAM_GROUP_CHAT_ID);
}

export function getTelegramReminderChatIds() {
    const explicit = parseChatIds(process.env.TELEGRAM_REMINDER_CHAT_IDS);
    if (explicit.length > 0) {
        return explicit;
    }

    return getTelegramAllowedChatIds();
}

export function isTelegramChatAllowed(chatId: number | string) {
    const allowed = getTelegramAllowedChatIds();
    if (allowed.length === 0) {
        return true;
    }

    return allowed.includes(String(chatId));
}

export function isTelegramPrivateControlUserId(userId: number | string | null | undefined) {
    if (!userId) {
        return false;
    }

    const normalized = String(userId);
    return getTelegramPrivateControlUserIds().includes(normalized)
        || getTelegramAdminUserIds().includes(normalized)
        || getTelegramChiefUserIds().includes(normalized);
}

export function getTelegramAnnouncementChatIds() {
    const chats = getTelegramAllowedChatIds();
    return chats.filter((chatId) => chatId.startsWith("-"));
}

export function getTelegramWebhookSecret() {
    return process.env.TELEGRAM_WEBHOOK_SECRET?.trim() || process.env.AUTH_SECRET?.trim() || "";
}

export function getTelegramAdminUserIds() {
    return parseTelegramUserIds(process.env.TELEGRAM_ADMIN_IDS);
}

export function getTelegramChiefUserIds() {
    return parseTelegramUserIds(process.env.TELEGRAM_CHIEF_IDS);
}

export function getTelegramReminderPollMs() {
    const raw = process.env.TELEGRAM_REMINDER_POLL_MS?.trim();
    if (!raw) {
        return 60_000;
    }

    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed < 15_000) {
        return 60_000;
    }

    return parsed;
}
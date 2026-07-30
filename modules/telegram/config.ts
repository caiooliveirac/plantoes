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

export function getTelegramRegulationAlertUserIds() {
    return parseTelegramUserIds(process.env.TELEGRAM_REGULATION_ALERT_USER_IDS);
}

export function getTelegramReminderPollMs() {
    const raw = process.env.TELEGRAM_REMINDER_POLL_MS?.trim();
    if (!raw) {
        // Meal-breaks cobra a cada 90s; poll de 30s mantém essa cadência sem
        // acelerar as regras de dedupe dos demais lembretes.
        return 30_000;
    }

    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed < 15_000) {
        return 30_000;
    }

    return parsed;
}

// Cutoff que separa a FASE 1 (registra o horário declarado pelo plantonista, mas
// avisa que a regra vai mudar) da FASE 2 (passa a registrar apenas o timestamp da
// mensagem do Telegram, ignorando o horário declarado). Configurável via env
// ARRIVAL_TIME_CUTOFF, com instante ISO no fuso de Salvador/BR (UTC-3), por exemplo
// "2026-06-01T00:00:00-03:00". Ausente ou inválido => null => FASE 1 (fail-safe:
// preserva o comportamento atual de aceitar o horário declarado).
export function getArrivalTimeCutoff(): Date | null {
    const raw = process.env.ARRIVAL_TIME_CUTOFF?.trim();
    if (!raw) {
        return null;
    }

    const parsed = new Date(raw);
    if (Number.isNaN(parsed.getTime())) {
        return null;
    }

    return parsed;
}

// Resolve em qual fase a chegada cai, comparando o timestamp da mensagem (a primeira
// mensagem daquele aviso) contra o cutoff. Compara sempre contra o referenceAt da
// mensagem — nunca contra o relógio do servidor — para que reprocessamentos e testes
// sejam determinísticos.
export function resolveArrivalPhase(referenceAt: Date): "phase1" | "phase2" {
    const cutoff = getArrivalTimeCutoff();
    if (!cutoff) {
        return "phase1";
    }

    return referenceAt.getTime() >= cutoff.getTime() ? "phase2" : "phase1";
}

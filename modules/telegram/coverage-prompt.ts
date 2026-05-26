import { and, desc, eq, gte } from "drizzle-orm";
import { getDb } from "@/db";
import { doctors, interventionBases, interventionOccupancies, telegramBotNotices } from "@/db/schema";
import {
    COVERAGE_PROMPT_THRESHOLD_MINUTES,
    formatCoverageDelayLabel,
    markInterventionAsCoverage,
    resolveInterventionArrivalDelayMinutes,
} from "@/modules/bank-hours/coverage";
import { buildChoiceKeyboard, REMOVE_KEYBOARD, sendMessage } from "@/modules/telegram/api";
import { getTelegramAdminUserIds } from "@/modules/telegram/config";

export const COVERAGE_CONFIRM_TEXT = "✅ É COBERTURA";
export const COVERAGE_REJECT_TEXT = "❌ É chegada normal";

const COVERAGE_NOTICE_STAGE = "awaiting_coverage_response";
const COVERAGE_NOTICE_TTL_MS = 60 * 60 * 1000; // 1 hour: prompt deixa de valer

function coverageNoticeKey(chatId: string, occupancyId: string) {
    return `coverage_prompt:${chatId}:${occupancyId}`;
}

export interface CoveragePromptPayload {
    occupancyId: string;
    baseId: number;
    baseCode: string;
    doctorId: string;
    doctorName: string;
    delayMinutes: number;
    expectedSenderTelegramId: string | null;
    chefe: boolean;
    promptedAt: string;
    promptMessageId: number | null;
}

function normalizeCoverageReplyText(text: string) {
    return text.replace(/[\s ]+/g, " ").trim();
}

export function isCoverageReplyText(text: string): "confirm" | "reject" | null {
    const normalized = normalizeCoverageReplyText(text);
    if (normalized === COVERAGE_CONFIRM_TEXT || normalized.toUpperCase() === "É COBERTURA") {
        return "confirm";
    }
    if (normalized === COVERAGE_REJECT_TEXT || normalized.toUpperCase() === "É CHEGADA NORMAL") {
        return "reject";
    }
    return null;
}

/**
 * If the freshly-recorded intervention arrival has >= 2h of delay, prompt the
 * sender to declare whether the occupancy is a COBERTURA. The prompt is stored
 * in telegram_bot_notices so a later reply (clicking the ReplyKeyboard button)
 * can be matched back to the occupancy.
 *
 * Scope is intervention only — regulation arrivals are never prompted because
 * regulation has its own continuity/role rules and is out of scope.
 */
export async function maybeSendInterventionCoveragePrompt(params: {
    chatId: string | number;
    occupancyId: string;
    senderTelegramId: string | null;
    senderName: string | null;
    senderIsChefe: boolean;
    replyToMessageId?: number;
}): Promise<{ prompted: boolean; delayMinutes: number }> {
    const db = getDb();
    const occupancy = await db.query.interventionOccupancies.findFirst({
        where: eq(interventionOccupancies.id, params.occupancyId),
    });
    if (!occupancy) {
        return { prompted: false, delayMinutes: 0 };
    }

    if (occupancy.coverageKind) {
        // Already coverage — nothing to do.
        return { prompted: false, delayMinutes: 0 };
    }

    const delayMinutes = resolveInterventionArrivalDelayMinutes(occupancy);
    if (delayMinutes < COVERAGE_PROMPT_THRESHOLD_MINUTES) {
        return { prompted: false, delayMinutes };
    }

    const [base, doctor] = await Promise.all([
        db.query.interventionBases.findFirst({ where: eq(interventionBases.id, occupancy.baseId) }),
        db.query.doctors.findFirst({ where: eq(doctors.id, occupancy.doctorId) }),
    ]);
    if (!base || !doctor) {
        return { prompted: false, delayMinutes };
    }

    const chatId = String(params.chatId);
    const delayLabel = formatCoverageDelayLabel(delayMinutes);
    const doctorSurfaceName = doctor.displayName ?? doctor.fullName;
    const senderDescription = params.senderIsChefe
        ? "Chefe, voce esta registrando a chegada de"
        : "Voce esta chegando como";

    const body = [
        `👀 *Atraso de ${delayLabel} detectado*`,
        "",
        `${senderDescription} *${doctorSurfaceName}* na base *${base.code}* — escala ${formatScheduledRange(occupancy)}, chegada efetiva ${formatLocalTime(occupancy.startedAt)}.`,
        "",
        "Isso e uma *COBERTURA* (titular nao pode estar e voce/ele esta suprindo o plantao)?",
        "",
        "👉 *Se sim*: o atraso fica registrado mas *NAO* sera descontado do banco de horas.",
        "👉 *Se nao*: o atraso entra no banco normalmente.",
        "",
        "_Atencao: marcar como cobertura indevidamente fica registrado no historico publico e pode ser revisto pela chefia._",
    ].join("\n");

    const sent = await sendMessage(
        chatId,
        body,
        params.replyToMessageId,
        buildChoiceKeyboard([[COVERAGE_CONFIRM_TEXT, COVERAGE_REJECT_TEXT]]),
    );

    const payload: CoveragePromptPayload = {
        occupancyId: occupancy.id,
        baseId: base.id,
        baseCode: base.code,
        doctorId: doctor.id,
        doctorName: doctorSurfaceName,
        delayMinutes,
        expectedSenderTelegramId: params.senderTelegramId,
        chefe: params.senderIsChefe,
        promptedAt: new Date().toISOString(),
        promptMessageId: sent?.message_id ?? null,
    };

    await db.insert(telegramBotNotices)
        .values({
            noticeKey: coverageNoticeKey(chatId, occupancy.id),
            chatId,
            stage: COVERAGE_NOTICE_STAGE,
            payload,
        })
        .onConflictDoUpdate({
            target: telegramBotNotices.noticeKey,
            set: {
                stage: COVERAGE_NOTICE_STAGE,
                payload,
                createdAt: new Date(),
            },
        });

    return { prompted: true, delayMinutes };
}

function formatScheduledRange(occupancy: { scheduledStartAt: Date | string | null; scheduledEndAt: Date | string | null }): string {
    if (!occupancy.scheduledStartAt || !occupancy.scheduledEndAt) {
        return "escala nao localizada";
    }
    return `${formatLocalTime(occupancy.scheduledStartAt)}–${formatLocalTime(occupancy.scheduledEndAt)}`;
}

function formatLocalTime(value: Date | string): string {
    const date = value instanceof Date ? value : new Date(value);
    return date.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit", timeZone: "America/Bahia" });
}

async function findLatestPendingCoverageNotice(chatId: string) {
    const cutoff = new Date(Date.now() - COVERAGE_NOTICE_TTL_MS);
    const rows = await getDb().query.telegramBotNotices.findMany({
        where: and(
            eq(telegramBotNotices.chatId, chatId),
            eq(telegramBotNotices.stage, COVERAGE_NOTICE_STAGE),
            gte(telegramBotNotices.createdAt, cutoff),
        ),
        orderBy: [desc(telegramBotNotices.createdAt)],
        limit: 1,
    });
    return rows[0] ?? null;
}

/**
 * Tries to handle a message as a reply to a coverage prompt. Returns null if
 * no pending prompt matches (the caller falls through to normal parsing).
 */
export async function tryHandleCoveragePromptReply(params: {
    chatId: string | number;
    text: string;
    senderTelegramId: string | null;
    senderName: string | null;
    replyToMessageId?: number;
}): Promise<{ status: "confirmed" | "rejected" | "forbidden" | "expired" | "not_a_reply" } | null> {
    const intent = isCoverageReplyText(params.text);
    if (!intent) {
        return null;
    }

    const chatId = String(params.chatId);
    const notice = await findLatestPendingCoverageNotice(chatId);
    if (!notice) {
        return { status: "expired" };
    }

    const payload = notice.payload as CoveragePromptPayload;
    const senderId = params.senderTelegramId;
    const expectedId = payload.expectedSenderTelegramId;
    const isAdmin = senderId ? getTelegramAdminUserIds().includes(senderId) : false;
    const allowed = !expectedId || senderId === expectedId || isAdmin;

    if (!allowed) {
        await sendMessage(
            chatId,
            `🛑 Apenas quem registrou a chegada (ou o admin) pode confirmar a cobertura desse atraso. Resposta ignorada.`,
            params.replyToMessageId,
            REMOVE_KEYBOARD,
        );
        return { status: "forbidden" };
    }

    const db = getDb();
    await db.delete(telegramBotNotices).where(eq(telegramBotNotices.noticeKey, notice.noticeKey));

    if (intent === "reject") {
        await sendMessage(
            chatId,
            `Ok — *chegada normal* registrada para *${payload.doctorName}* em *${payload.baseCode}*. O atraso de ${formatCoverageDelayLabel(payload.delayMinutes)} entra no banco de horas.`,
            params.replyToMessageId,
            REMOVE_KEYBOARD,
        );
        return { status: "rejected" };
    }

    const result = await markInterventionAsCoverage({
        occupancyId: payload.occupancyId,
        note: `Confirmada via Telegram por ${params.senderName ?? senderId ?? "sender desconhecido"} apos prompt automatico de atraso ${formatCoverageDelayLabel(payload.delayMinutes)}.`,
        actor: { userId: null, telegramId: senderId, label: params.senderName },
    });

    await sendMessage(
        chatId,
        buildCoverageAnnouncement({
            doctorName: payload.doctorName,
            baseCode: payload.baseCode,
            delayMinutes: result.arrivalDelayMinutes,
            markedByLabel: params.senderName ?? senderId ?? "sender desconhecido",
            markedByChefe: payload.chefe,
            source: "telegram_prompt",
        }),
        params.replyToMessageId,
        REMOVE_KEYBOARD,
    );

    return { status: "confirmed" };
}

/**
 * Big, public, audit-friendly announcement that gets posted in the group when
 * an intervention occupancy is marked as COBERTURA. The intent is to make any
 * attempt to misuse the flag visible to everyone — chefes, peers, and Caio.
 */
export function buildCoverageAnnouncement(params: {
    doctorName: string;
    baseCode: string;
    delayMinutes: number;
    markedByLabel: string;
    markedByChefe: boolean;
    source: "telegram_prompt" | "telegram_command" | "drawer";
}): string {
    const delayLabel = formatCoverageDelayLabel(params.delayMinutes);
    const sourceLabel =
        params.source === "telegram_prompt" ? "via prompt automatico do bot"
        : params.source === "telegram_command" ? "via comando /cobertura no Telegram"
        : "via quadro operacional";
    const actorRole = params.markedByChefe ? "chefe" : "medico";

    return [
        "🟡 *COBERTURA REGISTRADA* 🟡",
        "━━━━━━━━━━━━━━━━━━━━",
        `*Medico:* ${params.doctorName}`,
        `*Base:* ${params.baseCode}`,
        `*Atraso registrado:* ${delayLabel}`,
        `*Marcado por:* ${params.markedByLabel} (${actorRole})`,
        `*Como:* ${sourceLabel}`,
        "━━━━━━━━━━━━━━━━━━━━",
        "⚠️ *Este atraso NAO sera descontado do banco de horas.*",
        "📋 Este aviso fica registrado no historico publico e pode ser auditado pela chefia a qualquer momento.",
    ].join("\n");
}

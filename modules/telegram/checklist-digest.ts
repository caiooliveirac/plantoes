/**
 * Digest do checklist das USAs (11h e 13h) — fase 2 da aposentadoria do bot do
 * checklist: o mesmo resumo que o @samu_checklists_bot manda hoje passa a sair
 * pelo bot dos Plantões, lendo o texto pronto de /api/internal/menu/status.
 *
 * DESLIGADO por padrão (CHECKLIST_DIGEST_ENABLED) para não duplicar enquanto o
 * croner do app checklist ainda estiver ativo — a virada é: publicar os
 * endpoints lá, ligar a flag aqui, desligar o croner lá. Plano completo em
 * docs/checklist-bot-migration.md.
 *
 * Mesmo padrão do payment-digest: janela por horário local + reserva
 * idempotente por (admin, dia, slot) em telegram_bot_notices, com rollback se
 * o envio falhar. Horários em America/Bahia como no app checklist — desde o fim
 * do horário de verão é o mesmo relógio de America/Sao_Paulo, então reusamos
 * getSaoPauloParts.
 */

import { eq } from "drizzle-orm";

import { getDb } from "@/db";
import { telegramBotNotices } from "@/db/schema";
import { getSaoPauloParts } from "@/modules/operational/board-rules";
import { sendMessage } from "@/modules/telegram/api";
import { fetchChecklistMenuText } from "@/modules/telegram/checklist-menu";
import { getTelegramAdminUserIds } from "@/modules/telegram/config";

const STAGE = "checklist_digest";

// Slots do dia, iguais aos do croner do app checklist. A janela de 10min casa
// com o poll de 30s do worker e tolera um restart sem perder o slot.
const DIGEST_SLOT_HOURS = [11, 13] as const;
const DIGEST_WINDOW_MINUTES = 10;

function pad2(value: number) {
    return String(value).padStart(2, "0");
}

export function isChecklistDigestEnabled(env: Record<string, string | undefined> = process.env) {
    const raw = env.CHECKLIST_DIGEST_ENABLED?.trim().toLowerCase();
    return raw === "1" || raw === "true";
}

/** Slot ativo neste instante (ex.: "11h"), ou null fora das janelas. */
export function resolveChecklistDigestSlot(referenceDate: Date): string | null {
    const parts = getSaoPauloParts(referenceDate);
    const hour = DIGEST_SLOT_HOURS.find((slot) => slot === parts.hour);
    if (hour === undefined || parts.minute >= DIGEST_WINDOW_MINUTES) {
        return null;
    }
    return `${hour}h`;
}

export function checklistDigestNoticeKey(referenceDate: Date, slot: string) {
    const parts = getSaoPauloParts(referenceDate);
    return `checklist-digest:${parts.year}-${pad2(parts.month)}-${pad2(parts.day)}:${slot}`;
}

// Reserva idempotente por (admin, dia, slot): primeira inserção vence; repetições
// caem no onConflictDoNothing — mesmo padrão do payment-digest.
async function reserveNotice(noticeKey: string, chatId: string) {
    const db = getDb();
    const [inserted] = await db.insert(telegramBotNotices)
        .values({
            noticeKey: `${chatId}:${noticeKey}`,
            chatId,
            stage: STAGE,
            payload: {},
        })
        .onConflictDoNothing()
        .returning();
    return inserted ?? null;
}

async function rollbackNotice(noticeKey: string, chatId: string) {
    const db = getDb();
    await db.delete(telegramBotNotices).where(eq(telegramBotNotices.noticeKey, `${chatId}:${noticeKey}`));
}

/**
 * Um tick do worker: dentro da janela de um slot, busca o status do dia no app
 * checklist e entrega no privado de cada admin, uma vez por slot. Falha de
 * consulta NÃO consome o slot (sem reserva) — o próximo tick tenta de novo
 * dentro da janela; fora dela, o digest daquele slot simplesmente não sai.
 */
export async function sendChecklistDigestCycle(referenceDate = new Date()) {
    if (!isChecklistDigestEnabled() || !process.env.TELEGRAM_BOT_TOKEN?.trim()) {
        return { sent: 0, evaluated: 0 };
    }

    const slot = resolveChecklistDigestSlot(referenceDate);
    if (!slot) {
        return { sent: 0, evaluated: 0 };
    }

    const admins = [...new Set(getTelegramAdminUserIds().filter(Boolean))];
    if (admins.length === 0) {
        return { sent: 0, evaluated: 0 };
    }

    const status = await fetchChecklistMenuText("status");
    if (status.status !== "ok") {
        console.error(`[checklist-digest] status indisponível no slot ${slot} (${status.status})`);
        return { sent: 0, evaluated: admins.length };
    }

    const noticeKey = checklistDigestNoticeKey(referenceDate, slot);
    let sent = 0;
    let evaluated = 0;

    for (const chatId of admins) {
        evaluated += 1;
        const reserved = await reserveNotice(noticeKey, chatId);
        if (!reserved) {
            continue;
        }
        try {
            await sendMessage(chatId, status.text, undefined, undefined, { parseMode: "HTML" });
            sent += 1;
        } catch (error) {
            await rollbackNotice(noticeKey, chatId);
            console.error(`[checklist-digest] envio falhou para ${chatId} ${noticeKey}`, error);
        }
    }

    return { sent, evaluated };
}

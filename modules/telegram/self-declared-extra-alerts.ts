/**
 * Varredura diária dos plantões extra declarados pelos médicos: quem declarou
 * um extra num dia+turno e depois TRABALHOU nesse turno tem o extra remarcado
 * para o primeiro slot livre — senão o dia pagaria duas vezes o mesmo slot.
 *
 * Mesma janela das 8h e mesma idempotência por dia (telegram_bot_notices) dos
 * outros avisos administrativos. O remanejo acontece mesmo com o Telegram fora
 * do ar: o aviso é best-effort, a correção do pagamento não é.
 */
import { eq, inArray } from "drizzle-orm";

import { getDb } from "@/db";
import { auditLogs, doctors, telegramBotNotices } from "@/db/schema";
import { getSaoPauloParts } from "@/modules/operational/board-rules";
import { sendMessage } from "@/modules/telegram/api";
import { getTelegramAdminUserIds } from "@/modules/telegram/config";
import {
    relocateCollidingSelfDeclaredExtras,
    type SelfDeclaredExtraMove,
} from "@/services/self-declared-extra-slots.service";

const STAGE = "self-declared-extra";

function pad2(value: number) {
    return String(value).padStart(2, "0");
}

/** Mesma janela das 8h dos outros avisos administrativos. */
export function shouldRunSelfDeclaredExtraCycle(referenceDate: Date) {
    const parts = getSaoPauloParts(referenceDate);
    return parts.hour === 8 && parts.minute < 10;
}

function formatDia(operationalDate: string) {
    return operationalDate.split("-").reverse().slice(0, 2).join("/");
}

export function buildSelfDeclaredExtraMessage(
    moves: Array<SelfDeclaredExtraMove & { doctorName: string }>,
    options: { adminUrl: string },
): string | null {
    if (moves.length === 0) return null;
    const linhas = moves.map((move) => {
        const de = `${formatDia(move.from.operationalDate)} (${move.from.shiftLabel})`;
        return move.to
            ? `• *${move.doctorName}* — extra de ${de} virou ${formatDia(move.to.operationalDate)} (${move.to.shiftLabel}): trabalhou no turno declarado.`
            : `• *${move.doctorName}* — extra de ${de} bateu com plantão trabalhado e o mês não tem slot livre. Precisa de decisão.`;
    });
    return [
        "🔁 *Plantão extra declarado remarcado*",
        ...linhas,
        `Conferir em ${options.adminUrl}`,
    ].join("\n");
}

export async function sendSelfDeclaredExtraCycle(referenceDate = new Date()) {
    if (!shouldRunSelfDeclaredExtraCycle(referenceDate)) {
        return { sent: 0, evaluated: 0 };
    }

    const parts = getSaoPauloParts(referenceDate);
    const monthKey = `${parts.year}-${pad2(parts.month)}`;
    const day = `${monthKey}-${pad2(parts.day)}`;

    // Reserva do dia ANTES de mexer: dois workers não remarcam em duplicidade.
    const noticeKey = `self-declared-extra:${day}`;
    const [reserved] = await getDb()
        .insert(telegramBotNotices)
        .values({ noticeKey, chatId: "system", stage: STAGE, payload: { monthKey } })
        .onConflictDoNothing()
        .returning();
    if (!reserved) {
        return { sent: 0, evaluated: 0 };
    }

    const moves = await relocateCollidingSelfDeclaredExtras(monthKey);
    if (moves.length === 0) {
        return { sent: 0, evaluated: 0 };
    }

    for (const move of moves) {
        await getDb().insert(auditLogs).values({
            actorUserId: null,
            action: "medico.bank_hours_settlement.auto_relocate",
            entityType: "bank_hours_settlement",
            entityId: move.settlementId,
            details: { doctorId: move.doctorId, monthKey, from: move.from, to: move.to },
        });
    }

    const nameRows = await getDb()
        .select({ id: doctors.id, fullName: doctors.fullName, displayName: doctors.displayName })
        .from(doctors)
        .where(inArray(doctors.id, [...new Set(moves.map((move) => move.doctorId))]));
    const nameById = new Map(nameRows.map((row) => [row.id, row.displayName?.trim() || row.fullName]));

    const appUrl = (process.env.AUTH_URL?.trim() || "https://plantoes.mnrs.com.br").replace(/\/$/, "");
    const message = buildSelfDeclaredExtraMessage(
        moves.map((move) => ({ ...move, doctorName: nameById.get(move.doctorId) ?? move.doctorId })),
        { adminUrl: `${appUrl}/admin/payment-closing` },
    );

    let sent = 0;
    if (message && process.env.TELEGRAM_BOT_TOKEN?.trim()) {
        for (const chatId of new Set(getTelegramAdminUserIds().filter(Boolean))) {
            try {
                await sendMessage(chatId, message);
                sent += 1;
            } catch (error) {
                console.error(`[self-declared-extra] aviso falhou ${chatId}`, error);
            }
        }
    }

    return { sent, evaluated: moves.length };
}

/** Solta a reserva do dia — só para teste/reprocessamento manual. */
export async function releaseSelfDeclaredExtraNotice(day: string) {
    await getDb().delete(telegramBotNotices).where(eq(telegramBotNotices.noticeKey, `self-declared-extra:${day}`));
}

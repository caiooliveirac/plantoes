/**
 * Roda a verificação pós-virada (services/verificacao-pos-virada.service.ts) uma
 * vez por virada de turno (07:00 e 19:00, resolveOperationalShiftWindow) e avisa
 * os admins no privado SÓ quando há achado. Sem achado, nada sai — o registro
 * fica em telegram_bot_notices (payload.achado=false) para auditoria.
 *
 * Quando: uma hora depois da virada, para as saídas da virada já estarem
 * registradas. Janela: as 12h anteriores a esse momento — janelas consecutivas
 * se encostam, então cada saída é olhada uma vez só (o roteiro manual usava 48h
 * e repetiria o mesmo achado em quatro viradas).
 *
 * Idempotência: uma reserva por virada em telegram_bot_notices, tomada ANTES de
 * rodar as consultas — o worker cicla a cada 30s e as consultas rodam uma vez.
 *
 * Feature flag: VERIFICACAO_POS_VIRADA=on liga. Qualquer outro valor desliga.
 */
import { eq } from "drizzle-orm";

import { getDb } from "@/db";
import { telegramBotNotices } from "@/db/schema";
import { resolveOperationalShiftWindow } from "@/modules/operational/board-rules";
import { sendMessage } from "@/modules/telegram/api";
import { getTelegramAdminUserIds } from "@/modules/telegram/config";
import {
    formatVerificacaoResumo,
    hasVerificacaoAchado,
    runVerificacaoPosVirada,
    type VerificacaoJanela,
} from "@/services/verificacao-pos-virada.service";

const STAGE = "verificacao-pos-virada";
const ATRASO_APOS_VIRADA_MS = 60 * 60 * 1000;
const JANELA_MS = 12 * 60 * 60 * 1000;

export function isVerificacaoPosViradaEnabled(value = process.env.VERIFICACAO_POS_VIRADA) {
    return value?.trim().toLowerCase() === "on";
}

/** Virada mais recente e a janela que a verificação dela cobre; null antes da hora. */
export function resolveVerificacaoPosVirada(referenceDate: Date): { virada: Date; janela: VerificacaoJanela } | null {
    const virada = resolveOperationalShiftWindow(referenceDate).startedAt;
    const fim = new Date(virada.getTime() + ATRASO_APOS_VIRADA_MS);
    if (referenceDate < fim) {
        return null;
    }
    return { virada, janela: { inicio: new Date(fim.getTime() - JANELA_MS), fim } };
}

export async function sendVerificacaoPosViradaCycle(referenceDate = new Date()) {
    if (!isVerificacaoPosViradaEnabled() || !process.env.TELEGRAM_BOT_TOKEN?.trim()) {
        return { sent: 0, evaluated: 0 };
    }
    const alvo = resolveVerificacaoPosVirada(referenceDate);
    if (!alvo) {
        return { sent: 0, evaluated: 0 };
    }

    const noticeKey = `verificacao-pos-virada:${alvo.virada.toISOString()}`;
    const [reserved] = await getDb()
        .insert(telegramBotNotices)
        .values({ noticeKey, chatId: "admins", stage: STAGE, payload: {} })
        .onConflictDoNothing()
        .returning({ id: telegramBotNotices.id });
    if (!reserved) {
        return { sent: 0, evaluated: 0 };
    }

    try {
        const result = await runVerificacaoPosVirada(alvo.janela);
        const achado = hasVerificacaoAchado(result);
        await getDb()
            .update(telegramBotNotices)
            .set({ payload: { achado, janela: result.janela } })
            .where(eq(telegramBotNotices.noticeKey, noticeKey));
        if (!achado) {
            return { sent: 0, evaluated: 1 };
        }

        const admins = [...new Set(getTelegramAdminUserIds().filter(Boolean))];
        const text = formatVerificacaoResumo(result);
        const outcomes = await Promise.allSettled(admins.map((chatId) => sendMessage(chatId, text)));
        const sent = outcomes.filter((outcome) => outcome.status === "fulfilled").length;
        if (admins.length > 0 && sent === 0) {
            // Ninguém recebeu: solta a reserva para o próximo ciclo tentar de novo.
            await getDb().delete(telegramBotNotices).where(eq(telegramBotNotices.noticeKey, noticeKey));
            console.error("[verificacao-pos-virada] nenhum admin recebeu o aviso", outcomes);
        }
        return { sent, evaluated: 1 };
    } catch (error) {
        // Consulta falhou: solta a reserva (próximo ciclo tenta) sem derrubar o
        // ciclo do worker, que roda os outros avisos em paralelo.
        await getDb().delete(telegramBotNotices).where(eq(telegramBotNotices.noticeKey, noticeKey)).catch(() => undefined);
        console.error("[verificacao-pos-virada] falhou", error);
        return { sent: 0, evaluated: 0 };
    }
}

/**
 * Avisos do monitor de acessos (docs/monitor-acessos.md) no privado dos admins
 * (TELEGRAM_ADMIN_IDS). Roda no ciclo do plantoes-telegram-worker.
 *
 * 1. Alerta na hora: conta com episódio FORTE de uso simultâneo que terminou há
 *    menos de 20 minutos (ou segue em curso). No máximo um aviso por conta a
 *    cada 3 horas por admin — deduplicado em telegram_bot_notices (reserva
 *    idempotente, igual aos outros avisos). Checa a cada 2 minutos.
 * 2. Resumo diário às 8h (America/Bahia, janela 8:00–8:09): contas com indício
 *    forte e de atenção nas últimas 24 h. Sai mesmo sem nada — é a prova de
 *    que o monitor está vivo.
 * 3. Poda da retenção (180 dias), uma vez por dia na mesma janela das 8h.
 *    Não depende da flag: guardar além do prazo não é opção.
 *
 * Flag: ACESSOS_ALERTAS_ENABLED=1 liga os envios (1 e 2). Desligada, nada sai;
 * o registro e a tela /admin/acessos seguem funcionando.
 */
import { and, eq, gt, like } from "drizzle-orm";
import { getDb } from "@/db";
import { telegramBotNotices } from "@/db/schema";
import { mensagemDeUsoSimultaneo, mensagemDoResumoDiario } from "@/modules/acessos/mensagens";
import { diaIso } from "@/modules/acessos/texto";
import { getSaoPauloParts } from "@/modules/operational/board-rules";
import { sendMessage } from "@/modules/telegram/api";
import { getTelegramAdminUserIds } from "@/modules/telegram/config";
import { podarRegistrosAntigos } from "@/services/acessos.service";
import { carregarMonitor } from "@/services/acessos-relatorio.service";

const STAGE = "acessos";
const CHECAR_A_CADA_MS = 2 * 60_000;
const JANELA_DO_ALERTA_MS = 20 * 60_000;
const INTERVALO_ENTRE_ALERTAS_MS = 3 * 60 * 60_000;
const OLHAR_PARA_TRAS_MS = 3 * 60 * 60_000;

export function isAcessosAlertasEnabled() {
    const value = process.env.ACESSOS_ALERTAS_ENABLED?.trim().toLowerCase();
    return value === "1" || value === "true";
}

/** Mesma janela das 8h dos outros avisos administrativos. */
export function isJanelaDoResumoDiario(referenceDate: Date) {
    const parts = getSaoPauloParts(referenceDate);
    return parts.hour === 8 && parts.minute < 10;
}

function urlDoApp() {
    return (process.env.AUTH_URL?.trim() || "https://plantoes.mnrs.com.br").replace(/\/$/, "");
}

async function enviarUmaVez(chatId: string, noticeKey: string, texto: string, payload: Record<string, unknown>) {
    const [reservado] = await getDb()
        .insert(telegramBotNotices)
        .values({ noticeKey, chatId, stage: STAGE, payload })
        .onConflictDoNothing()
        .returning();
    if (!reservado) return false;
    try {
        await sendMessage(chatId, texto);
        return true;
    } catch (error) {
        // Falhou o envio: solta a reserva para o próximo ciclo tentar de novo.
        await getDb().delete(telegramBotNotices).where(eq(telegramBotNotices.noticeKey, noticeKey));
        console.error(`[acessos] aviso falhou ${chatId} ${noticeKey}`, error);
        return false;
    }
}

let ultimaChecagem = 0;
let ultimaPoda: string | null = null;

/** Só para os testes. */
export function reiniciarCicloDeAcessos() {
    ultimaChecagem = 0;
    ultimaPoda = null;
}

export async function sendAcessosCycle(referenceDate = new Date()) {
    const resultado = { sent: 0, evaluated: 0 };
    const dia = diaIso(referenceDate);

    if (isJanelaDoResumoDiario(referenceDate) && ultimaPoda !== dia) {
        ultimaPoda = dia;
        try {
            const podados = await podarRegistrosAntigos(referenceDate);
            if (podados.eventos + podados.presenca + podados.sessoes > 0) console.log(`[acessos] retenção: ${JSON.stringify(podados)}`);
        } catch (error) {
            console.error("[acessos] poda da retenção falhou", error);
        }
    }

    if (!isAcessosAlertasEnabled() || !process.env.TELEGRAM_BOT_TOKEN?.trim()) return resultado;
    const admins = [...new Set(getTelegramAdminUserIds().filter(Boolean))];
    if (admins.length === 0) return resultado;
    try {
        await enviarAvisos(referenceDate, admins, dia, resultado);
    } catch (error) {
        // Sem a migration 0046 (ou banco fora) o ciclo falha a cada 30 s: loga de 10 em 10 min.
        if (referenceDate.getTime() - ultimoErro > 10 * 60_000) {
            ultimoErro = referenceDate.getTime();
            console.error("[acessos] ciclo de avisos falhou", error);
        }
    }
    return resultado;
}

let ultimoErro = 0;

async function enviarAvisos(referenceDate: Date, admins: string[], dia: string, resultado: { sent: number; evaluated: number }) {
    const app = urlDoApp();

    if (isJanelaDoResumoDiario(referenceDate)) {
        const dados = await carregarMonitor({ desde: new Date(referenceDate.getTime() - 24 * 60 * 60_000), ate: referenceDate });
        resultado.evaluated += dados.analises.length;
        const texto = mensagemDoResumoDiario(dados.analises, referenceDate, `${app}/admin/acessos?periodo=24h`);
        for (const chatId of admins) {
            if (await enviarUmaVez(chatId, `${chatId}:acessos-diario:${dia}`, texto, { contas: dados.analises.length })) resultado.sent += 1;
        }
    }

    if (referenceDate.getTime() - ultimaChecagem < CHECAR_A_CADA_MS) return;
    ultimaChecagem = referenceDate.getTime();
    const dados = await carregarMonitor({ desde: new Date(referenceDate.getTime() - OLHAR_PARA_TRAS_MS), ate: referenceDate });
    resultado.evaluated += dados.analises.length;
    for (const analise of dados.analises) {
        const recente = analise.episodios.find((episodio) => (
            episodio.forca === "forte" && referenceDate.getTime() - episodio.fim.getTime() <= JANELA_DO_ALERTA_MS
        ));
        if (!recente) continue;
        const texto = mensagemDeUsoSimultaneo(analise, recente, dados.redes, `${app}/admin/acessos/${analise.conta.userId}?periodo=24h`);
        for (const chatId of admins) {
            const prefixo = `${chatId}:acessos-forte:${analise.conta.userId}:`;
            const [avisadoHaPouco] = await getDb()
                .select({ id: telegramBotNotices.id })
                .from(telegramBotNotices)
                .where(and(
                    like(telegramBotNotices.noticeKey, `${prefixo}%`),
                    gt(telegramBotNotices.createdAt, new Date(referenceDate.getTime() - INTERVALO_ENTRE_ALERTAS_MS)),
                ))
                .limit(1);
            if (avisadoHaPouco) continue;
            const noticeKey = `${prefixo}${recente.inicio.toISOString()}`;
            if (await enviarUmaVez(chatId, noticeKey, texto, { userId: analise.conta.userId, inicio: recente.inicio.toISOString() })) resultado.sent += 1;
        }
    }
}

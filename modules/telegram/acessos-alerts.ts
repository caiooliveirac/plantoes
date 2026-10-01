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
 * 3. Redes (a cada 30 min, olhando 7 dias — services/acessos-redes.service.ts):
 *    rede coletiva fora do plantão (3+ contas fora do turno, fora da Central)
 *    ou com vazamento provável; avisa de novo quando cresce (mais contas ou
 *    mais vazamentos), no máximo 1× a cada 24 h por rede. E faixa com 2+
 *    plantonistas no PC que o portão NÃO trata como Central e já barrou alguém
 *    (segunda saída da Central? posto noutro prédio?) — 1× por dia.
 *    Rede rotulada "conhecida" ou "Central" não gera aviso de suspeita.
 * 4. Poda da retenção (180 dias), uma vez por dia na mesma janela das 8h.
 *    Não depende da flag: guardar além do prazo não é opção.
 *
 * Flag: ACESSOS_ALERTAS_ENABLED=1 liga os envios (1 e 2). Desligada, nada sai;
 * o registro e a tela /admin/acessos seguem funcionando.
 */
import { and, eq, gt, like } from "drizzle-orm";
import { getDb } from "@/db";
import { telegramBotNotices } from "@/db/schema";
import { atitudeDeRiscoLigada, decidirAtitude } from "@/modules/acessos/atitude";
import { mensagemDeUsoSimultaneo, mensagemDoResumoDiario } from "@/modules/acessos/mensagens";
import { diaIso } from "@/modules/acessos/texto";
import { getSaoPauloParts } from "@/modules/operational/board-rules";
import { sendMessage } from "@/modules/telegram/api";
import { getTelegramAdminUserIds } from "@/modules/telegram/config";
import { aplicarAtitudeDeRisco } from "@/services/acessos-acoes.service";
import { podarRegistrosAntigos } from "@/services/acessos.service";
import { carregarMonitor } from "@/services/acessos-relatorio.service";
import { carregarRedes } from "@/services/acessos-redes.service";
import { PLANTONISTAS_POSSIVEL_CENTRAL, type RedeAnalisada } from "@/modules/acessos/redes";

const STAGE = "acessos";
const CHECAR_A_CADA_MS = 2 * 60_000;
const JANELA_DO_ALERTA_MS = 20 * 60_000;
const INTERVALO_ENTRE_ALERTAS_MS = 3 * 60 * 60_000;
const OLHAR_PARA_TRAS_MS = 3 * 60 * 60_000;
const CHECAR_REDES_A_CADA_MS = 30 * 60_000;
const REDES_OLHAM_MS = 7 * 24 * 60 * 60_000;
const INTERVALO_POR_REDE_MS = 24 * 60 * 60_000;

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
let ultimaChecagemDeRedes = 0;
let ultimaPoda: string | null = null;

/** Só para os testes. */
export function reiniciarCicloDeAcessos() {
    ultimaChecagem = 0;
    ultimaChecagemDeRedes = 0;
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

    const alertasLigados = isAcessosAlertasEnabled() && Boolean(process.env.TELEGRAM_BOT_TOKEN?.trim());
    const admins = alertasLigados ? [...new Set(getTelegramAdminUserIds().filter(Boolean))] : [];
    const alertas = alertasLigados && admins.length > 0;
    // A atitude de risco alto não depende do aviso no Telegram.
    if (!alertas && !atitudeDeRiscoLigada()) return resultado;
    try {
        await enviarAvisos(referenceDate, admins, dia, resultado, alertas);
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

async function enviarAvisos(referenceDate: Date, admins: string[], dia: string, resultado: { sent: number; evaluated: number }, alertas: boolean) {
    const app = urlDoApp();

    if (alertas && isJanelaDoResumoDiario(referenceDate)) {
        const dados = await carregarMonitor({ desde: new Date(referenceDate.getTime() - 24 * 60 * 60_000), ate: referenceDate });
        resultado.evaluated += dados.analises.length;
        const texto = mensagemDoResumoDiario(dados.analises, referenceDate, `${app}/admin/acessos?periodo=24h`);
        for (const chatId of admins) {
            if (await enviarUmaVez(chatId, `${chatId}:acessos-diario:${dia}`, texto, { contas: dados.analises.length })) resultado.sent += 1;
        }
    }

    if (alertas && referenceDate.getTime() - ultimaChecagemDeRedes >= CHECAR_REDES_A_CADA_MS) {
        ultimaChecagemDeRedes = referenceDate.getTime();
        try {
            await avisarRedes(referenceDate, admins, app, resultado);
        } catch (error) {
            // Sem a migration 0048 (rótulos) as redes não carregam; os outros avisos seguem.
            console.error("[acessos] vigia de redes falhou", error);
        }
    }

    if (referenceDate.getTime() - ultimaChecagem < CHECAR_A_CADA_MS) return;
    ultimaChecagem = referenceDate.getTime();
    const dados = await carregarMonitor({ desde: new Date(referenceDate.getTime() - OLHAR_PARA_TRAS_MS), ate: referenceDate });
    resultado.evaluated += dados.analises.length;
    for (const analise of dados.analises) {
        if (atitudeDeRiscoLigada()) {
            const bruto = dados.brutos.get(analise.conta.userId);
            const atitude = decidirAtitude({
                email: analise.conta.email,
                papeis: analise.conta.papeis,
                nivel: analise.nivel,
                episodios: analise.episodios,
                eventos: bruto?.eventos ?? [],
                agora: referenceDate,
                aindaAberto: analise.abertaAgora.redes >= 2,
            });
            if (atitude === "derrubar" || atitude === "trocar_senha") {
                try {
                    await aplicarAtitudeDeRisco(atitude, analise.conta, analise.resumo);
                    console.log(`[acessos] ${atitude} ${analise.conta.email}`);
                } catch (error) {
                    console.error(`[acessos] atitude ${atitude} falhou ${analise.conta.email}`, error);
                }
            }
        }
        const recente = analise.episodios.find((episodio) => (
            episodio.forca === "forte" && referenceDate.getTime() - episodio.fim.getTime() <= JANELA_DO_ALERTA_MS
        ));
        if (!recente || !alertas) continue;
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

function nomeDaRede(rede: RedeAnalisada) {
    return rede.rotulo?.label ?? rede.dominios[0] ?? rede.provedores[0] ?? "rede sem nome";
}

export function mensagemDeRedeSuspeita(rede: RedeAnalisada, emails: Map<string, string>, link: string) {
    const fora = rede.contas.filter((c) => c.minutosFora > 0 || c.barrados > 0);
    const linhas = fora.slice(0, 8).map((c) => {
        const h = Math.round(c.minutosFora / 6) / 10;
        return `• ${emails.get(c.userId) ?? c.userId.slice(0, 8)} — ${c.veredito === "vazou" ? "VAZOU (provável)" : c.veredito.replace("_", " ")}, ${h}h fora do plantão${c.barrados ? `, ${c.barrados} barrado(s)` : ""}`;
    });
    return [
        `Rede suspeita: ${nomeDaRede(rede)} (${rede.faixa})`,
        `${rede.contasFora} contas usadas fora do plantão nos últimos 7 dias${rede.vazamentos ? `, ${rede.vazamentos} com vazamento provável (em uso lá enquanto o dono estava na Central)` : ""}.`,
        [rede.provedores.join(", "), rede.lugares.join(", ")].filter(Boolean).join(" · "),
        ...linhas,
        fora.length > 8 ? `… e mais ${fora.length - 8}.` : "",
        link,
    ].filter(Boolean).join("\n");
}

async function avisarRedes(referenceDate: Date, admins: string[], app: string, resultado: { sent: number; evaluated: number }) {
    const dados = await carregarRedes({ desde: new Date(referenceDate.getTime() - REDES_OLHAM_MS), ate: referenceDate });
    const emails = new Map([...dados.contas].map(([id, c]) => [id, c.email]));
    const dia = diaIso(referenceDate);
    for (const rede of dados.redes) {
        if (rede.central || rede.rotulo?.kind === "conhecida") continue;
        const link = `${app}/admin/acessos/redes?periodo=7d#${encodeURIComponent(rede.faixa)}`;
        if (rede.coletivaFora || rede.vazamentos > 0) {
            resultado.evaluated += 1;
            const texto = mensagemDeRedeSuspeita(rede, emails, link);
            for (const chatId of admins) {
                const prefixo = `${chatId}:acessos-rede:${rede.faixa}:`;
                const [recente] = await getDb()
                    .select({ id: telegramBotNotices.id })
                    .from(telegramBotNotices)
                    .where(and(like(telegramBotNotices.noticeKey, `${prefixo}%`), gt(telegramBotNotices.createdAt, new Date(referenceDate.getTime() - INTERVALO_POR_REDE_MS))))
                    .limit(1);
                if (recente) continue;
                // Mesma contagem já avisada: só volta a avisar se crescer.
                const noticeKey = `${prefixo}${rede.contasFora}:${rede.vazamentos}`;
                if (await enviarUmaVez(chatId, noticeKey, texto, { faixa: rede.faixa })) resultado.sent += 1;
            }
        }
        if (rede.plantonistas >= PLANTONISTAS_POSSIVEL_CENTRAL && rede.barrados > 0) {
            const texto = [
                `Possível Central não reconhecida: ${nomeDaRede(rede)} (${rede.faixa})`,
                `${rede.plantonistas} plantonista(s) usaram a Mesa num PC ali dentro do turno, e o portão já barrou ${rede.barrados} acesso(s) fora do turno.`,
                "Se for posto de trabalho (outra saída da Central, COI…), rotule como Central.",
                link,
            ].join("\n");
            for (const chatId of admins) {
                if (await enviarUmaVez(chatId, `${chatId}:acessos-quase-central:${rede.faixa}:${dia}`, texto, { faixa: rede.faixa })) resultado.sent += 1;
            }
        }
    }
}

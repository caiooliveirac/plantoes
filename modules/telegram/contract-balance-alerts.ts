/**
 * Varredura diária e alertas do saldo contratual (SPEC §8, Fase 6).
 *
 * Duas responsabilidades, nesta ordem:
 *
 *  1. RECONCILIAR. É a rede de segurança do razão. O valor de um mês pode mudar
 *     depois da atestação por oito caminhos, e só três estão instrumentados
 *     (atestação, plantão extra, acerto de banco de horas). Chegada registrada
 *     pelo bot, undo, correção administrativa e atraso reconhecido não avisam
 *     ninguém. A varredura passa por todo mês atestado recente e deixa o razão
 *     igual ao fechamento — é o que impede o saldo de desencontrar em silêncio.
 *
 *  2. AVISAR. Só depois de reconciliar, porque alertar sobre número velho é pior
 *     que não alertar.
 *
 * Deduplicação: reusa telegram_bot_notices, com o mesmo padrão de reserva
 * idempotente do digest de pagamento. A chave carrega o gatilho e o médico, e a
 * janela de 7 dias vira parte da chave — repetir o mesmo alerta antes disso cai
 * no onConflictDoNothing e não sai.
 */
import { and, eq, gte, sql } from "drizzle-orm";

import { getDb } from "@/db";
import { telegramBotNotices } from "@/db/schema";
import { getSaoPauloParts } from "@/modules/operational/board-rules";
import { sendMessage } from "@/modules/telegram/api";
import { getTelegramAdminUserIds } from "@/modules/telegram/config";
import { syncContractLedgerForMonthBatch } from "@/services/contract-ledger.service";
import { loadContractBalances, type ContractBalanceRow } from "@/services/contract-balance.service";
import { tracksContractBalance } from "@/modules/reporting/payment-closing-pendencies";

const STAGE = "contract-balance";
/** Não repetir o mesmo alerta antes disto (SPEC §8). */
const DEDUP_DAYS = 7;
/** Quantos meses para trás a varredura reconcilia. */
const SWEEP_MONTHS = 3;

function pad2(value: number) {
    return String(value).padStart(2, "0");
}

function monthKeyOf(reference: Date, monthsBack: number) {
    const parts = getSaoPauloParts(reference);
    const date = new Date(Date.UTC(parts.year, parts.month - 1 - monthsBack, 1));
    return `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}`;
}

function formatBrl(cents: number) {
    return (cents / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

function formatDate(value: Date | string) {
    return new Date(value).toLocaleDateString("pt-BR", { timeZone: "UTC" });
}

// --------------------------------------------------------------------------
// 1. Varredura
// --------------------------------------------------------------------------

export async function runContractLedgerSweep(referenceDate = new Date()) {
    const months = Array.from({ length: SWEEP_MONTHS }, (_, index) => monthKeyOf(referenceDate, index));
    const resumo = { meses: months.length, contratos: 0, ajustados: 0 };

    for (const monthKey of months) {
        const results = await syncContractLedgerForMonthBatch({ monthKey });
        for (const [, result] of results) {
            resumo.contratos += 1;
            if (result.outcome !== "sem_alteracao" && result.outcome !== "sem_contrato") {
                resumo.ajustados += 1;
                console.log(`[contract-balance] ${monthKey} ${result.contractId} ${result.outcome} ${result.deltaCents}`);
            }
        }
    }
    return resumo;
}

// --------------------------------------------------------------------------
// 2. Alertas
// --------------------------------------------------------------------------

export type AlertTrigger = "exhaustion_projected" | "milestone" | "depleted" | "cycle_ending";

export interface ContractAlert {
    trigger: AlertTrigger;
    contractId: string;
    doctorName: string;
    /** Entra na chave de deduplicação: marco de 50/75/90 não pode se sobrepor. */
    discriminator: string;
    message: string;
}

/** Marcos de consumo que valem aviso, do maior para o menor (SPEC §8). */
const MILESTONES = [0.9, 0.75, 0.5] as const;

/**
 * Gatilhos que interrompem o dia do chefe. Os outros entram no digest semanal.
 *
 * Não é preferência estética: com todos os quatro saindo avulsos o volume medido
 * contra os dados reais foi de ~9 mensagens por dia e 53 no primeiro. Nesse
 * ritmo o chefe silencia o bot e perde junto os dois avisos que importam.
 */
const IMMEDIATE_TRIGGERS: ReadonlySet<AlertTrigger> = new Set(["depleted", "exhaustion_projected"]);

export function isImmediateAlert(alert: ContractAlert) {
    return IMMEDIATE_TRIGGERS.has(alert.trigger);
}

/**
 * Decide o que merece alerta. Pura de propósito: é a parte que erra feio se
 * errar (alerta demais vira ruído, e ruído faz o chefe parar de ler).
 */
export function buildContractAlerts(rows: ContractBalanceRow[], referenceDate: Date): ContractAlert[] {
    const alerts: ContractAlert[] = [];

    for (const row of rows) {
        const m = row.metrics;
        // Contrato esperando o coordenador não tem o que alertar: o saldo é zero
        // porque ninguém digitou, não porque acabou.
        //
        // ESTA GUARDA JÁ FALHOU UMA VEZ, e o custo foi uma lista de alertas
        // falsos enviada à chefia — sete médicos anunciados como "saldo zerado"
        // com o valor da própria produção deles. A flag exigia consumo zero, então
        // morria no primeiro plantão depois da carga. Hoje ela pergunta a coisa
        // certa (existe lançamento 'opening' no razão?), mas se você for mexer no
        // que alimenta `awaitingOpeningBalance`, leia antes
        // docs/saldo-contrato/03-validacao-alertas-08-2026.md §1.
        if (row.awaitingOpeningBalance) continue;

        if (m.balanceCents <= 0) {
            alerts.push({
                trigger: "depleted",
                contractId: row.contractId,
                doctorName: row.doctorName,
                discriminator: row.cycleStart,
                message: `⚠️ *${row.doctorName}* está com o saldo de contrato zerado: ${formatBrl(m.balanceCents)}.`
                    + `\nCiclo até ${formatDate(row.cycleEnd)}. Contrato ${row.contractNumber}.`,
            });
            continue;
        }

        // Só projeta com amostra suficiente — nos primeiros 45 dias do razão o
        // burn rate é ruído e alertar em cima dele queima a confiança no aviso.
        if (m.hasReliableBurnRate && m.slackMonths !== null && m.slackMonths < 0 && m.projectedDepletionDate) {
            alerts.push({
                trigger: "exhaustion_projected",
                contractId: row.contractId,
                doctorName: row.doctorName,
                discriminator: row.cycleStart,
                message: `📉 *${row.doctorName}* passou a projetar exaustão antes do fim do ciclo.`
                    + `\nNo ritmo atual o saldo acaba em *${formatDate(m.projectedDepletionDate)}*, e o ciclo só termina em ${formatDate(row.cycleEnd)}.`
                    + `\nSaldo hoje ${formatBrl(m.balanceCents)}. Para chegar inteiro: ${formatBrl(m.healthyMonthlyBudgetCents)}/mês`
                    + ` (≈ ${m.monthlyWeekdayShifts} plantões de semana).`,
            });
        }

        // Marco só vale quando o consumo está ADIANTE do ritmo. "Passou de 50% do
        // teto" com 77% do ciclo decorrido não é notícia — é um médico indo bem.
        // Sem esta guarda o marco sozinho gera ~230 alertas em 30 dias e o chefe
        // para de ler todos os outros junto.
        if (m.consumedPct !== null && m.paceIndex !== null && m.paceIndex > 1) {
            const milestone = MILESTONES.find((value) => m.consumedPct! >= value);
            if (milestone !== undefined) {
                alerts.push({
                    trigger: "milestone",
                    contractId: row.contractId,
                    doctorName: row.doctorName,
                    discriminator: `${row.cycleStart}:${milestone}`,
                    message: `📊 *${row.doctorName}* passou de ${Math.round(milestone * 100)}% do teto e está acima do ritmo`
                        + ` (${(m.consumedPct * 100).toFixed(1)}% consumido contra ${(m.elapsedPct * 100).toFixed(1)}% de ciclo decorrido).`
                        + `\nSaldo ${formatBrl(m.balanceCents)}, ciclo até ${formatDate(row.cycleEnd)}.`,
                });
            }
        }

        // Faltando 60 dias para o fim do ciclo: hora de tratar renovação, e o
        // saldo não usado é a informação que falta para negociar.
        const diasAteFim = Math.round(
            (new Date(`${row.cycleEnd}T00:00:00Z`).getTime() - referenceDate.getTime()) / 86_400_000,
        );
        if (diasAteFim > 0 && diasAteFim <= 60) {
            alerts.push({
                trigger: "cycle_ending",
                contractId: row.contractId,
                doctorName: row.doctorName,
                discriminator: row.cycleEnd,
                message: `🗓️ O ciclo de *${row.doctorName}* termina em ${formatDate(row.cycleEnd)} (${diasAteFim} dias).`
                    + `\nSaldo não utilizado: ${formatBrl(m.balanceCents)}. Contrato ${row.contractNumber}.`
                    + `\nNa renovação, informe o saldo de abertura do ciclo novo.`,
            });
        }
    }

    return alerts;
}

/**
 * Digest semanal: o top-10 por folga (o pior primeiro) mais as contagens do que
 * não vira alerta avulso. É o formato que o chefe lê de fato.
 */
export function buildWeeklyDigest(rows: ContractBalanceRow[], referenceDate: Date): string | null {
    const ativos = rows.filter((row) => !row.awaitingOpeningBalance);
    if (ativos.length === 0) return null;

    const ranked = [...ativos].sort((left, right) => {
        const a = left.metrics.slackMonths ?? Number.POSITIVE_INFINITY;
        const b = right.metrics.slackMonths ?? Number.POSITIVE_INFINITY;
        return a - b;
    });

    const emRisco = ativos.filter((row) => ["critical", "depleted"].includes(row.metrics.riskLevel)).length;
    const estourados = ativos.filter((row) => row.metrics.balanceCents <= 0).length;
    const aguardando = rows.filter((row) => row.awaitingOpeningBalance).length;
    const outros = buildContractAlerts(ativos, referenceDate).filter((alert) => !isImmediateAlert(alert));

    const linhas = [
        `*Saldo de contrato — resumo da semana*`,
        `_posição de ${formatDate(referenceDate)}_`,
        ``,
        `${ativos.length} contratos acompanhados · *${emRisco}* em risco · *${estourados}* com saldo zerado`,
        aguardando > 0 ? `${aguardando} aguardando o saldo de abertura do coordenador` : null,
        ``,
        `*Piores folgas*`,
    ].filter((line): line is string => line !== null);

    for (const row of ranked.slice(0, 10)) {
        const m = row.metrics;
        const folga = m.slackMonths === null ? "—" : `${m.slackMonths.toFixed(1)} m`;
        const acaba = m.projectedDepletionDate ? formatDate(m.projectedDepletionDate) : "sem projeção";
        linhas.push(`• ${row.doctorName} — saldo ${formatBrl(m.balanceCents)}, folga ${folga}, acaba ${acaba}`);
    }

    const porGatilho = new Map<AlertTrigger, number>();
    for (const alert of outros) porGatilho.set(alert.trigger, (porGatilho.get(alert.trigger) ?? 0) + 1);
    if (porGatilho.size > 0) {
        linhas.push(``, `*Também nesta semana*`);
        const rotulos: Record<AlertTrigger, string> = {
            milestone: "passaram de um marco de consumo acima do ritmo",
            cycle_ending: "ciclos terminando em até 60 dias",
            depleted: "com saldo zerado",
            exhaustion_projected: "projetando exaustão antes do fim do ciclo",
        };
        for (const [trigger, total] of porGatilho) {
            linhas.push(`• ${total} ${rotulos[trigger]}`);
        }
    }

    return linhas.join("\n");
}

/** Segunda-feira, na mesma janela das 8h. */
export function shouldSendWeeklyDigest(referenceDate: Date) {
    const parts = getSaoPauloParts(referenceDate);
    // getSaoPauloParts não devolve dia da semana; deriva do ano/mês/dia já
    // convertidos, em UTC, para não reintroduzir fuso na conta.
    const weekday = new Date(Date.UTC(parts.year, parts.month - 1, parts.day)).getUTCDay();
    return weekday === 1 && shouldRunContractBalanceCycle(referenceDate);
}

/** Janela de dedup: o mesmo alerta não se repete dentro de DEDUP_DAYS. */
function alertNoticeKey(alert: ContractAlert, referenceDate: Date, chatId: string) {
    const bucket = Math.floor(referenceDate.getTime() / (DEDUP_DAYS * 86_400_000));
    return `${chatId}:contract-alert:${alert.trigger}:${alert.contractId}:${alert.discriminator}:${bucket}`;
}

async function reserveNotice(noticeKey: string, chatId: string) {
    const [inserted] = await getDb().insert(telegramBotNotices)
        .values({ noticeKey, chatId, stage: STAGE, payload: {} })
        .onConflictDoNothing()
        .returning();
    return inserted ?? null;
}

async function rollbackNotice(noticeKey: string) {
    await getDb().delete(telegramBotNotices).where(eq(telegramBotNotices.noticeKey, noticeKey));
}

/**
 * A janela por bucket sozinha deixaria passar um alerta na virada do bucket.
 * Esta checagem olha os últimos DEDUP_DAYS de verdade.
 */
async function sentRecently(alert: ContractAlert, chatId: string, referenceDate: Date) {
    const since = new Date(referenceDate.getTime() - DEDUP_DAYS * 86_400_000);
    const prefix = `${chatId}:contract-alert:${alert.trigger}:${alert.contractId}:${alert.discriminator}:`;
    const rows = await getDb()
        .select({ id: telegramBotNotices.id })
        .from(telegramBotNotices)
        .where(and(
            eq(telegramBotNotices.stage, STAGE),
            gte(telegramBotNotices.createdAt, since),
            sql`${telegramBotNotices.noticeKey} like ${`${prefix}%`}`,
        ))
        .limit(1);
    return rows.length > 0;
}

/** Roda a cada ciclo do worker; só age na janela das 8h (America/Sao_Paulo). */
export function shouldRunContractBalanceCycle(referenceDate: Date) {
    const parts = getSaoPauloParts(referenceDate);
    return parts.hour === 8 && parts.minute < 10;
}

export async function sendContractBalanceCycle(referenceDate = new Date()) {
    if (!shouldRunContractBalanceCycle(referenceDate)) {
        return { sent: 0, evaluated: 0 };
    }

    // Reconciliar SEMPRE, mesmo sem bot configurado: a varredura é a rede de
    // segurança do saldo, não um detalhe da notificação.
    await runContractLedgerSweep(referenceDate);

    if (!process.env.TELEGRAM_BOT_TOKEN?.trim()) {
        return { sent: 0, evaluated: 0 };
    }
    const admins = [...new Set(getTelegramAdminUserIds().filter(Boolean))];
    if (admins.length === 0) {
        return { sent: 0, evaluated: 0 };
    }

    // Estatutário e psiquiatra não têm saldo acompanhado: avisar sobre o teto
    // deles seria cobrar ação que a coordenação não toma (mesmo corte do
    // fechamento). A reconciliação do razão acima segue valendo para todos.
    const { rows: todasAsLinhas } = await loadContractBalances({ asOf: referenceDate });
    const rows = todasAsLinhas.filter(tracksContractBalance);
    // Avulso só o que exige ação hoje; o resto vai no digest de segunda.
    const alerts = buildContractAlerts(rows, referenceDate).filter(isImmediateAlert);
    const digest = shouldSendWeeklyDigest(referenceDate) ? buildWeeklyDigest(rows, referenceDate) : null;

    let sent = 0;
    let evaluated = 0;
    for (const chatId of admins) {
        if (digest) {
            evaluated += 1;
            const parts = getSaoPauloParts(referenceDate);
            const digestKey = `${chatId}:contract-digest:${parts.year}-${pad2(parts.month)}-${pad2(parts.day)}`;
            if (await reserveNotice(digestKey, chatId)) {
                try {
                    await sendMessage(chatId, digest);
                    sent += 1;
                } catch (error) {
                    await rollbackNotice(digestKey);
                    console.error(`[contract-balance] digest falhou ${chatId}`, error);
                }
            }
        }

        for (const alert of alerts) {
            evaluated += 1;
            if (await sentRecently(alert, chatId, referenceDate)) continue;

            const noticeKey = alertNoticeKey(alert, referenceDate, chatId);
            const reserved = await reserveNotice(noticeKey, chatId);
            if (!reserved) continue;

            try {
                await sendMessage(chatId, alert.message);
                sent += 1;
            } catch (error) {
                await rollbackNotice(noticeKey);
                console.error(`[contract-balance] alerta falhou ${chatId} ${noticeKey}`, error);
            }
        }
    }

    return { sent, evaluated };
}

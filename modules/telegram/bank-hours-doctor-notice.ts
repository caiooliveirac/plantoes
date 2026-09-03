/**
 * Aviso privado ao médico quando um acerto de banco de horas é lançado ou
 * estornado.
 *
 * Não existe vínculo formal telegram_id ↔ doctor_id no banco. O canal privado é
 * derivado do autoatendimento: toda consulta de pagamento aceita (/pagamento
 * <codinome>) grava resolution_data.doctorId com o chat_id privado do médico.
 * Usamos o chat mais recente. Sem chat conhecido, o aviso fica registrado como
 * NÃO ENTREGUE (telegram_bot_notices, payload.delivered=false) — o ajuste em si
 * nunca depende do Telegram, e a folha/página do médico mostram o acerto de
 * qualquer forma.
 *
 * Idempotência: noticeKey por settlementId — reenvio do mesmo acerto não duplica.
 */
import { sql } from "drizzle-orm";

import { getDb } from "@/db";
import { telegramBotNotices } from "@/db/schema";
import { formatSignedHours } from "@/modules/bank-hours/pending-actions";
import { sendMessage } from "@/modules/telegram/api";
import { isBankHoursPendingAlertsEnabled } from "@/modules/telegram/bank-hours-pending-alerts";

const STAGE = "bank-hours";

/** Último chat privado conhecido do médico (autoatendimento aceito). */
export async function findDoctorTelegramChatId(doctorId: string): Promise<string | null> {
    const result = await getDb().execute(sql`
        select chat_id as "chatId"
        from operations_v2.telegram_ingested_messages
        where resolution_data->>'doctorId' = ${doctorId}
          and status = 'accepted'
          and chat_id not like '-%'
        order by created_at desc
        limit 1
    `);
    const row = (result as unknown as Array<{ chatId?: string }>)[0];
    return row?.chatId ?? null;
}

function monthLabel(monthKey: string): string {
    const [year, month] = monthKey.split("-").map(Number);
    return new Date(Date.UTC(year, (month ?? 1) - 1, 1))
        .toLocaleDateString("pt-BR", { month: "long", year: "numeric", timeZone: "UTC" });
}

export interface DoctorSettlementNoticeParams {
    settlementId: string;
    doctorId: string;
    doctorFirstName: string;
    monthKey: string;
    /** payroll = abatimento em folha do estatutário (sem plantão verde/vermelho). */
    kind: "bonus" | "penalty" | "payroll";
    /** Saldo elegível restante depois do lançamento, em minutos (com sinal). */
    residualMinutes: number | null;
    /** Minutos abatidos em folha (só kind payroll). */
    payrollMinutes?: number | null;
    reversal?: boolean;
}

export function buildDoctorSettlementNotice(params: DoctorSettlementNoticeParams): string {
    const mes = monthLabel(params.monthKey);
    const sobra = params.residualMinutes === null
        ? null
        : `Saldo restante no banco de horas: ${formatSignedHours(params.residualMinutes)}.`;
    if (params.kind === "payroll") {
        const horas = params.payrollMinutes ? formatSignedHours(-Math.abs(params.payrollMinutes)) : null;
        return [
            `Olá, ${params.doctorFirstName}.`,
            params.reversal
                ? `O abatimento em folha do seu banco de horas de ${mes} foi *estornado* pela coordenação — os atrasos daquele mês voltam a contar no saldo.`
                : `Os atrasos do seu banco de horas de ${mes}${horas ? ` (${horas})` : ""} foram *abatidos em folha* pela coordenação: o desconto sai na folha de pagamento/ponto, e essas horas deixam de pesar no saldo do banco.`,
            sobra,
            "O lançamento já aparece quando você consulta seu painel de banco de horas.",
        ].filter((line): line is string => line !== null).join("\n");
    }
    if (params.reversal) {
        return [
            `Olá, ${params.doctorFirstName}.`,
            params.kind === "bonus"
                ? `O plantão de 12h acrescentado à sua folha de ${mes} pelo banco de horas foi *estornado* pela coordenação.`
                : `O desconto de um plantão de 12h na sua folha de ${mes} pelo banco de horas foi *estornado* pela coordenação.`,
            sobra,
            "O estorno já aparece quando você gera ou consulta sua folha de ponto.",
        ].filter((line): line is string => line !== null).join("\n");
    }
    return [
        `Olá, ${params.doctorFirstName}.`,
        params.kind === "bonus"
            ? `Foi *acrescentado 1 plantão de 12h* à sua folha de ${mes} como compensação pelo seu saldo positivo de banco de horas.`
            : `Foi *descontado 1 plantão de 12h* na sua folha de ${mes} para compensar o saldo negativo de banco de horas.`,
        sobra,
        "O ajuste já aparece quando você gera ou consulta sua folha de ponto.",
    ].filter((line): line is string => line !== null).join("\n");
}

/**
 * Nunca lança: o acerto já foi commitado e não pode ser desfeito por falha de
 * Telegram. Devolve o estado da entrega para auditoria/UI.
 */
export async function notifyDoctorBankHoursSettlement(
    params: DoctorSettlementNoticeParams,
): Promise<{ delivered: boolean; reason: string | null }> {
    const noticeKey = `bank-hours-doctor:${params.settlementId}${params.reversal ? ":reversal" : ""}`;
    const record = async (chatId: string, delivered: boolean, reason: string | null) => {
        await getDb()
            .insert(telegramBotNotices)
            .values({ noticeKey, chatId, stage: STAGE, payload: { delivered, reason, doctorId: params.doctorId } })
            .onConflictDoNothing();
    };

    try {
        if (!isBankHoursPendingAlertsEnabled() || !process.env.TELEGRAM_BOT_TOKEN?.trim()) {
            await record("none", false, "disabled");
            return { delivered: false, reason: "disabled" };
        }
        const chatId = await findDoctorTelegramChatId(params.doctorId);
        if (!chatId) {
            await record("none", false, "no_known_chat");
            return { delivered: false, reason: "no_known_chat" };
        }
        await sendMessage(chatId, buildDoctorSettlementNotice(params));
        await record(chatId, true, null);
        return { delivered: true, reason: null };
    } catch (error) {
        console.error(`[bank-hours] aviso ao médico falhou ${params.doctorId}`, error);
        await record("none", false, "send_failed").catch(() => undefined);
        return { delivered: false, reason: "send_failed" };
    }
}

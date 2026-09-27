/**
 * Aviso no PRIVADO do médico da regulação na hora oficial do fim do turno
 * (07:00 / 19:00 — a virada de resolveOperationalShiftWindow), não no fim da
 * janela (07:15 / 19:15). Os 15 min extras seguem como estão: sem sucessor, o
 * médico fica no painel para o auxiliar ainda passar ocorrência; o painel já o
 * destaca como "saindo" (resolveOccupancyDirection → .is-leaving).
 *
 * Quem recebe: titular (board_started_at) de ramal da regulação cujo turno
 * acaba nesta virada (scheduled_end_at no fim da janela: SD 19:15, SN e P 07:15)
 * e que ainda não avisou a saída. Dois casos:
 *  - segue no painel (sem saída registrada) → "segue até 19:15";
 *  - foi rendido pela chegada do sucessor (saída carimbada na hora da chegada
 *    dele, resolveDepartureOrigin = "successor") → diz quem assumiu.
 * Não recebe: quem já avisou saída (mensagem 'departure' na ocupação), quem
 * continuou (scheduled_end_at além da janela ou outra ocupação que segue),
 * sombra, PIAM/Núcleo, meio plantão (fecha 17:00) e P que ainda não terminou.
 *
 * Canal: findDoctorTelegramChatId, o mesmo da DM de fechamento. Sem chat
 * privado conhecido, não envia (sem fallback no grupo).
 *
 * Flag TELEGRAM_AVISO_FIM_TURNO, mesmo significado de TELEGRAM_DM_FECHAMENTO:
 * off (padrão) | admins (ensaio para TELEGRAM_ADMIN_IDS, só de quem tem chat
 * conhecido) | on (envia ao médico).
 *
 * Idempotência: uma reserva por médico + virada em telegram_bot_notices; envio
 * fora de transação; falha libera a reserva e nunca derruba o ciclo.
 */
import { eq, sql } from "drizzle-orm";

import { getDb } from "@/db";
import { telegramBotNotices } from "@/db/schema";
import { bahiaClockHHMM } from "@/lib/time";
import { formatDoctorSurfaceName } from "@/modules/doctors/directory";
import { resolveOperationalShiftWindow } from "@/modules/operational/board-rules";
import { resolveDepartureOrigin } from "@/modules/operational/departure-origin";
import { inferRegulationScheduledEndAt } from "@/modules/operational/rules";
import { escapeTelegramMarkdown, sendMessage } from "@/modules/telegram/api";
import { findDoctorTelegramChatId } from "@/modules/telegram/bank-hours-doctor-notice";
import { getTelegramAdminUserIds } from "@/modules/telegram/config";
import { resolveFechamentoDmMode } from "@/modules/telegram/fechamento-doctor-notice";

const STAGE = "aviso-fim-turno";

export function resolveAvisoFimTurnoMode(value = process.env.TELEGRAM_AVISO_FIM_TURNO) {
    return resolveFechamentoDmMode(value);
}

/**
 * Virada que acabou de passar e o fim da janela da regulação do turno que
 * terminou nela. Null fora do intervalo [virada, fim da janela).
 */
export function resolveFimTurnoJanela(reference: Date): { virada: Date; fimJanela: Date; turno: "SD" | "SN" } | null {
    const virada = resolveOperationalShiftWindow(reference).startedAt;
    const antes = new Date(virada.getTime() - 60000);
    const turno = resolveOperationalShiftWindow(antes).shiftLabel;
    const fimJanela = inferRegulationScheduledEndAt(antes, turno, null);
    if (!fimJanela || reference.getTime() < virada.getTime() || reference.getTime() >= fimJanela.getTime()) {
        return null;
    }
    return { virada, fimJanela, turno };
}

export interface AvisoFimTurnoCandidate {
    doctorId: string;
    doctorName: string;
    displayName: string | null;
    postCode: string;
    scheduledEndAt: string;
    actualEndedAt: string | null;
    successorName: string | null;
    successorDisplayName: string | null;
    successorStartedAt: string | null;
}

export async function loadAvisoFimTurnoCandidates(janela: { virada: Date; fimJanela: Date }): Promise<AvisoFimTurnoCandidate[]> {
    const virada = janela.virada.toISOString();
    const fimJanela = janela.fimJanela.toISOString();
    const result = await getDb().execute(sql`
        select
            ro.doctor_id::text as "doctorId",
            d.full_name as "doctorName",
            d.display_name as "displayName",
            rp.code as "postCode",
            ro.scheduled_end_at as "scheduledEndAt",
            ro.actual_ended_at as "actualEndedAt",
            succ.full_name as "successorName",
            succ.display_name as "successorDisplayName",
            succ.started_at as "successorStartedAt"
        from operations_v2.regulation_occupancies ro
        join operations_v2.regulation_posts rp on rp.id = ro.post_id
        join operations_v2.doctors d on d.id = ro.doctor_id
        left join lateral (
            select sd.full_name, sd.display_name, s.started_at
            from operations_v2.regulation_occupancies s
            join operations_v2.doctors sd on sd.id = s.doctor_id
            where s.post_id = ro.post_id
              and s.id <> ro.id
              and s.doctor_id <> ro.doctor_id
              and s.board_started_at is not null
              and s.started_at >= ro.started_at
            order by s.started_at asc
            limit 1
        ) succ on true
        where ro.board_started_at is not null
          and ro.started_at < ${virada}
          and ro.scheduled_end_at > ${virada}
          and ro.scheduled_end_at <= ${fimJanela}
          and upper(rp.code) not in ('PIAM', 'NUCLEO')
          and not exists (
              select 1 from operations_v2.telegram_ingested_messages m
              where m.related_occupancy_id = ro.id and m.parsed_action = 'departure'
          )
          -- Continuou (bloco novo do mesmo médico que vai além da janela): não é fim.
          and not exists (
              select 1 from operations_v2.regulation_occupancies o
              where o.doctor_id = ro.doctor_id
                and o.id <> ro.id
                and o.scheduled_end_at > ${fimJanela}
                and (o.actual_ended_at is null or o.actual_ended_at > ${virada})
          )
          and not exists (
              select 1 from operations_v2.intervention_occupancies o
              where o.doctor_id = ro.doctor_id
                and o.scheduled_end_at > ${fimJanela}
                and (o.actual_ended_at is null or o.actual_ended_at > ${virada})
          )
        order by rp.code
    `);
    return result as unknown as AvisoFimTurnoCandidate[];
}

/** Quem avisar e com qual sucessor. Um aviso por médico. */
export function selectAvisoFimTurnoTargets(candidates: AvisoFimTurnoCandidate[]) {
    const seen = new Set<string>();
    const targets: Array<AvisoFimTurnoCandidate & { successor: string | null }> = [];
    for (const row of candidates) {
        if (seen.has(row.doctorId)) continue;
        let successor: string | null = null;
        if (row.actualEndedAt) {
            // Saída carimbada que não é a chegada do sucessor: registro de outra
            // origem (mudança de ramal, correção) — nada a pedir.
            const origin = resolveDepartureOrigin({
                hasDepartureMessage: false,
                actualEndedAt: row.actualEndedAt,
                scheduledEndAt: row.scheduledEndAt,
                successorStartedAt: row.successorStartedAt,
            });
            if (origin !== "successor") continue;
            successor = formatDoctorSurfaceName({ fullName: row.successorName, displayName: row.successorDisplayName });
        }
        seen.add(row.doctorId);
        targets.push({ ...row, successor });
    }
    return targets;
}

export function buildAvisoFimTurnoMessage(params: {
    doctorName: string;
    postCode: string;
    virada: Date;
    fimJanela: Date;
    successor: string | null;
}) {
    const hora = bahiaClockHHMM(params.virada);
    const ramal = escapeTelegramMarkdown(params.postCode);
    const comando = `\`${`${params.doctorName} saindo ${params.postCode} ${hora}`.replace(/[`\n]/g, " ")}\``;
    return [
        `⏰ Seu turno no *${ramal}* terminou às ${hora}.`,
        params.successor
            ? `*${escapeTelegramMarkdown(params.successor)}* já assumiu o ramal.`
            : `Ninguém assumiu ainda: você segue no painel até ${bahiaClockHHMM(params.fimJanela)} para o auxiliar poder passar ocorrência.`,
        `Ao sair, avise no grupo com a hora real: ${comando}`,
    ].join("\n");
}

export interface AvisoFimTurnoDeps {
    loadCandidates: (janela: { virada: Date; fimJanela: Date }) => Promise<AvisoFimTurnoCandidate[]>;
    findChatId: (doctorId: string) => Promise<string | null>;
}

const defaultDeps: AvisoFimTurnoDeps = { loadCandidates: loadAvisoFimTurnoCandidates, findChatId: findDoctorTelegramChatId };

async function reserve(noticeKey: string, chatId: string, payload: Record<string, unknown>) {
    const [inserted] = await getDb()
        .insert(telegramBotNotices)
        .values({ noticeKey, chatId, stage: STAGE, payload })
        .onConflictDoNothing()
        .returning({ id: telegramBotNotices.id });
    return Boolean(inserted);
}

export async function sendAvisoFimTurnoCycle(referenceDate = new Date(), deps: AvisoFimTurnoDeps = defaultDeps) {
    const mode = resolveAvisoFimTurnoMode();
    if (mode === "off" || !process.env.TELEGRAM_BOT_TOKEN?.trim()) {
        return { sent: 0, evaluated: 0 };
    }
    const janela = resolveFimTurnoJanela(referenceDate);
    if (!janela) {
        return { sent: 0, evaluated: 0 };
    }

    let sent = 0;
    let evaluated = 0;
    try {
        const targets = selectAvisoFimTurnoTargets(await deps.loadCandidates(janela));
        const admins = [...new Set(getTelegramAdminUserIds().filter(Boolean))];
        for (const target of targets) {
            try {
                const doctorChatId = await deps.findChatId(target.doctorId);
                if (!doctorChatId) continue;
                evaluated += 1;
                const doctorName = formatDoctorSurfaceName({ fullName: target.doctorName, displayName: target.displayName });
                const text = buildAvisoFimTurnoMessage({
                    doctorName,
                    postCode: target.postCode,
                    virada: janela.virada,
                    fimJanela: janela.fimJanela,
                    successor: target.successor,
                });
                const baseKey = `aviso-fim-turno:${target.doctorId}:${janela.virada.toISOString()}`;
                const chatIds = mode === "admins" ? admins : [doctorChatId];
                for (const chatId of chatIds) {
                    const noticeKey = mode === "admins" ? `${baseKey}:ensaio:${chatId}` : baseKey;
                    if (!await reserve(noticeKey, chatId, { doctorId: target.doctorId, postCode: target.postCode, turno: janela.turno, mode })) {
                        continue;
                    }
                    try {
                        await sendMessage(
                            chatId,
                            mode === "admins" ? `🧪 Ensaio — iria para ${escapeTelegramMarkdown(doctorName)}:\n\n${text}` : text,
                            undefined,
                            undefined,
                            { parseMode: "Markdown" },
                        );
                        sent += 1;
                    } catch (error) {
                        await getDb().delete(telegramBotNotices).where(eq(telegramBotNotices.noticeKey, noticeKey)).catch(() => undefined);
                        console.error(`[aviso-fim-turno] envio falhou ${target.doctorId}`, error);
                    }
                }
            } catch (error) {
                console.error(`[aviso-fim-turno] falhou ${target.doctorId}`, error);
            }
        }
    } catch (error) {
        console.error("[aviso-fim-turno] falhou", error);
    }
    return { sent, evaluated };
}

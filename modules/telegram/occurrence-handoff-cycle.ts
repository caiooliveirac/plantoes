// Ciclo do worker para a passagem de ocorrências (roda a cada poll do
// telegram-reminder-worker). Por saída:
// - 15 min antes: aviso (uma vez);
// - de 10 min antes até 10 min depois: cobrança com @ de quem não informou, a
//   cada 3 min enquanto faltar alguém;
// - divisão: assim que todos informam (ou na hora da saída); depois, cada mudança
//   até 10 min após a saída EDITA a mesma mensagem, em vez de mandar outra.
// Desliga com OCCURRENCE_HANDOFF_BOT_ENABLED=0 (o painel continua funcionando).

import { editMessageText, sendMessage } from "@/modules/telegram/api";
import { MEAL_BREAK_FORMAT_OPTIONS, resolveMealBreakDoctorMention } from "@/modules/telegram/meal-breaks";
import {
    buildHandoffDivisionMessage,
    buildHandoffNoticeMessage,
    buildHandoffPendingMessage,
} from "@/modules/telegram/occurrence-handoff-messages";
import {
    getOccurrenceHandoffState,
    patchOccurrenceHandoffRecord,
    planFromState,
} from "@/services/occurrence-handoff.service";

const PENDING_INTERVAL_MS = 3 * 60 * 1000;

export function isOccurrenceHandoffBotEnabled(env: NodeJS.ProcessEnv = process.env) {
    const raw = env.OCCURRENCE_HANDOFF_BOT_ENABLED?.trim().toLowerCase();
    return !(raw === "0" || raw === "false" || raw === "off");
}

/**
 * Erro de edição que não adianta repetir: texto igual, mensagem apagada ou velha
 * demais. Sem isto o ciclo tentava a cada poll até +10 min, logando cada vez.
 */
export function isSettledEditError(error: unknown) {
    const message = error instanceof Error ? error.message.toLowerCase() : "";
    return message.includes("message is not modified")
        || message.includes("message to edit not found")
        || message.includes("message can't be edited");
}

function publicLink() {
    const base = process.env.AUTH_URL?.trim() || "https://plantoes.mnrs.com.br";
    return base.endsWith("/") ? base : `${base}/`;
}

export async function sendOccurrenceHandoffCycle(reference = new Date()) {
    if (!process.env.TELEGRAM_BOT_TOKEN?.trim() || !isOccurrenceHandoffBotEnabled()) {
        return { sent: 0, evaluated: 0 };
    }
    const state = await getOccurrenceHandoffState(reference);
    if (!state?.window) return { sent: 0, evaluated: 0 };
    const plan = planFromState(state);
    if (!plan || plan.givers.length === 0) return { sent: 0, evaluated: 0 };

    const { chatId, operationalDate, window } = state;
    const record = state.record ?? { counts: {}, transfers: [] };
    const link = publicLink();
    const mentions = new Map<string, string | null>();
    const resolveMentions = async (ramals: string[]) => {
        await Promise.all(ramals.filter((r) => !mentions.has(r)).map(async (ramal) => {
            const doctorId = state.doctorIds[ramal];
            let mention: string | null = null;
            if (doctorId) {
                try {
                    mention = await resolveMealBreakDoctorMention({ chatId, referenceAt: reference, doctorId });
                } catch (error) {
                    console.warn(`[occurrence-handoff] mention failed for ${ramal}`, error);
                }
            }
            mentions.set(ramal, mention);
        }));
    };
    const mention = (ramal: string) => mentions.get(ramal) ?? null;
    let sent = 0;

    try {
        if (!record.noticeSentAt && (window.phase === "aviso" || window.phase === "contagem")) {
            await sendMessage(chatId, buildHandoffNoticeMessage({ plan, link }), undefined, undefined, MEAL_BREAK_FORMAT_OPTIONS);
            await patchOccurrenceHandoffRecord(chatId, operationalDate, window.slot, { noticeSentAt: reference.toISOString() });
            sent += 1;
        }

        const lastPending = record.pendingSentAt ? new Date(record.pendingSentAt).getTime() : 0;
        if (window.editable && plan.pendingGivers.length > 0 && reference.getTime() - lastPending >= PENDING_INTERVAL_MS) {
            await resolveMentions(plan.pendingGivers);
            const text = buildHandoffPendingMessage({ plan, link, mention });
            if (text) {
                await sendMessage(chatId, text, undefined, undefined, MEAL_BREAK_FORMAT_OPTIONS);
                await patchOccurrenceHandoffRecord(chatId, operationalDate, window.slot, { pendingSentAt: reference.toISOString() });
                sent += 1;
            }
        }

        const ready = plan.pendingGivers.length === 0 || window.phase === "divisao" || window.phase === "encerrada";
        // Com a mensagem já enviada, edita mesmo se a divisão zerou (todos corrigiram para 0).
        if (ready && (plan.transfers.length > 0 || record.divisionMessageId)) {
            await resolveMentions([...plan.givers.map((g) => g.ramal)]);
            const text = buildHandoffDivisionMessage({ plan, link, mention });
            if (!record.divisionMessageId) {
                const message = await sendMessage(chatId, text, undefined, undefined, MEAL_BREAK_FORMAT_OPTIONS);
                await patchOccurrenceHandoffRecord(chatId, operationalDate, window.slot, {
                    divisionMessageId: message?.message_id,
                    divisionText: text,
                });
                sent += 1;
            } else if (text !== record.divisionText && window.editable) {
                let edited = true;
                try {
                    await editMessageText(chatId, record.divisionMessageId, text, undefined, MEAL_BREAK_FORMAT_OPTIONS);
                } catch (error) {
                    if (!isSettledEditError(error)) throw error;
                    console.warn(`[occurrence-handoff] edit skipped for ${chatId} ${operationalDate} ${window.slot}`, error);
                    edited = false;
                }
                await patchOccurrenceHandoffRecord(chatId, operationalDate, window.slot, { divisionText: text });
                if (edited) sent += 1;
            }
        }
    } catch (error) {
        console.error(`[occurrence-handoff] cycle failed for ${chatId} ${operationalDate} ${window.slot}`, error);
    }

    return { sent, evaluated: 1 };
}

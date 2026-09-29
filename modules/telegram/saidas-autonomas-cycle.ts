/**
 * A fila "Saídas a confirmar" andando sozinha (docs/saidas-a-confirmar.md):
 *
 *   - rotina ("auto") vencida na virada → o sistema confirma;
 *   - sugestão ("glance") parada 24h → o sistema aplica a sugestão;
 *   - decisão humana ("decide") parada 24h → escala para o privado dos admins,
 *     uma vez por saída; continua na fila até alguém decidir.
 *
 * O que a chefia desfez vira dela: não é confirmado de novo, só escala.
 *
 * Flag SAIDAS_AUTONOMAS: ligado por padrão (decisão da coordenação em
 * 29/09/2026); "sombra" só registra no log o que faria; "0" desliga.
 */
import { eq } from "drizzle-orm";

import { getDb } from "@/db";
import { telegramBotNotices } from "@/db/schema";
import { resolveDepartureAutonomy, type DepartureAutonomyResult } from "@/modules/operational/departure-autonomy";
import { sendMessage } from "@/modules/telegram/api";
import { getTelegramAdminUserIds } from "@/modules/telegram/config";
import { listPendingDepartureConfirmations, type PendingDepartureConfirmation } from "@/services/board.service";
import { confirmDepartureBySystem, listDepartureIdsUndoneByChief } from "@/services/departure-autonomy.service";

const STAGE = "saidas-autonomas";
/** A fila muda devagar; olhar a cada 5 min basta e poupa a consulta pesada. */
const CYCLE_EVERY_MS = 5 * 60_000;
let lastRunMs = 0;

export type SaidasAutonomasMode = "on" | "sombra" | "off";

export function resolveSaidasAutonomasMode(raw = process.env.SAIDAS_AUTONOMAS): SaidasAutonomasMode {
    const value = raw?.trim().toLowerCase();
    if (value === "0" || value === "false" || value === "off") return "off";
    if (value === "sombra") return "sombra";
    return "on";
}

export type SaidaAction =
    | { kind: "confirm"; reason: "virada" | "prazo" }
    | { kind: "escalate" }
    | { kind: "wait" };

/** Puro: o que fazer com um item da fila agora. */
export function decideSaidaAction(assessment: DepartureAutonomyResult, now: Date, undoneByChief: boolean): SaidaAction {
    if (undoneByChief || assessment.autonomy === "decide") {
        return assessment.deadlineAt.getTime() <= now.getTime() ? { kind: "escalate" } : { kind: "wait" };
    }
    if (assessment.dueAt.getTime() > now.getTime()) return { kind: "wait" };
    return { kind: "confirm", reason: assessment.autonomy === "auto" ? "virada" : "prazo" };
}

function hourMinute(iso: string) {
    return new Intl.DateTimeFormat("pt-BR", { timeZone: "America/Sao_Paulo", hour: "2-digit", minute: "2-digit", hour12: false })
        .format(new Date(iso));
}

export function buildEscalationMessage(items: Array<{ pending: PendingDepartureConfirmation; assessment: DepartureAutonomyResult }>, url: string) {
    const lines = items.map(({ pending, assessment }) =>
        `• ${pending.displayName ?? pending.doctorName} — ${pending.targetCode} ${pending.shiftLabel ?? ""}, saiu ${hourMinute(pending.actualEndedAt)}. ${assessment.triage.headline}`);
    return [
        `⚠️ Saída sem decisão há 24h (${items.length})`,
        ...lines,
        "",
        `Decidir em ${url} → Saídas a confirmar.`,
    ].join("\n");
}

async function escalate(items: Array<{ pending: PendingDepartureConfirmation; assessment: DepartureAutonomyResult }>) {
    if (items.length === 0 || !process.env.TELEGRAM_BOT_TOKEN?.trim()) return 0;
    const admins = [...new Set(getTelegramAdminUserIds().filter(Boolean))];
    const url = (process.env.AUTH_URL?.trim() || "https://plantoes.mnrs.com.br").replace(/\/$/, "");

    let sent = 0;
    for (const chatId of admins) {
        // Reserva por saída: dois ciclos (ou dois workers) nunca avisam a mesma duas vezes.
        const reserved: typeof items = [];
        const keys: string[] = [];
        for (const item of items) {
            const noticeKey = `${chatId}:saida-sem-decisao:${item.pending.occupancyId}`;
            const [row] = await getDb()
                .insert(telegramBotNotices)
                .values({ noticeKey, chatId, stage: STAGE, payload: { occupancyId: item.pending.occupancyId } })
                .onConflictDoNothing()
                .returning();
            if (row) {
                reserved.push(item);
                keys.push(noticeKey);
            }
        }
        if (reserved.length === 0) continue;
        try {
            await sendMessage(chatId, buildEscalationMessage(reserved, url));
            sent += 1;
        } catch (error) {
            for (const noticeKey of keys) {
                await getDb().delete(telegramBotNotices).where(eq(telegramBotNotices.noticeKey, noticeKey));
            }
            console.error(`[saidas-autonomas] escalonamento falhou ${chatId}`, error);
        }
    }
    return sent;
}

export async function runSaidasAutonomasCycle(referenceDate = new Date()) {
    const mode = resolveSaidasAutonomasMode();
    if (mode === "off" || referenceDate.getTime() - lastRunMs < CYCLE_EVERY_MS) {
        return { evaluated: 0, sent: 0, confirmed: 0 };
    }
    lastRunMs = referenceDate.getTime();

    const pending = await listPendingDepartureConfirmations();
    const undone = await listDepartureIdsUndoneByChief(pending.map((item) => item.occupancyId));

    let confirmed = 0;
    const toEscalate: Array<{ pending: PendingDepartureConfirmation; assessment: DepartureAutonomyResult }> = [];
    for (const item of pending) {
        const assessment = resolveDepartureAutonomy(item);
        const action = decideSaidaAction(assessment, referenceDate, undone.has(item.occupancyId));
        if (action.kind === "wait") continue;
        if (mode === "sombra") {
            console.log(`[saidas-autonomas] sombra: ${action.kind} ${item.domain} ${item.occupancyId} ${assessment.autonomy}/${assessment.triage.kind}`);
            continue;
        }
        if (action.kind === "escalate") {
            toEscalate.push({ pending: item, assessment });
            continue;
        }
        try {
            if (await confirmDepartureBySystem({ pending: item, assessment, reason: action.reason })) {
                confirmed += 1;
            }
        } catch (error) {
            console.error(`[saidas-autonomas] confirmar ${item.domain} ${item.occupancyId} falhou`, error);
        }
    }

    const sent = mode === "on" ? await escalate(toEscalate) : 0;
    if (confirmed > 0 || sent > 0) {
        console.log(`[saidas-autonomas] confirmadas=${confirmed} escalonadas=${toEscalate.length} avisos=${sent}`);
    }
    return { evaluated: pending.length, sent, confirmed };
}

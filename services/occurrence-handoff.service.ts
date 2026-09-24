// Passagem de ocorrências: estado por saída (contagem declarada + última divisão),
// guardado em telegram_bot_notices (payload jsonb) — sem migration, como a sessão
// de refeições. Uma linha por chat + dia operacional + horário de saída.
//
// A divisão em si é pura (modules/operational/occurrence-handoff.ts). Aqui só se
// monta o roster a partir da sessão de refeições e se grava.

import { and, eq, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { telegramBotNotices } from "@/db/schema";
import { isNucleoRegulationPost, isPiamRegulationPost } from "@/modules/operational/board-display";
import { getSaoPauloParts } from "@/modules/operational/board-rules";
import {
    planOccurrenceHandoff,
    resolveHandoffWindow,
    type HandoffCounts,
    type HandoffPhase,
    type HandoffRosterEntry,
    type HandoffTransfer,
    type OccurrenceHandoffPlan,
} from "@/modules/operational/occurrence-handoff";
import { normalizeOperationalRoleLabel } from "@/modules/operational/roles";
import { getCurrentDayMealBreakSessionWithChat, type MealBreakSession } from "@/modules/telegram/meal-breaks";

export const OCCURRENCE_HANDOFF_STAGE = "occ_handoff";

export interface OccurrenceHandoffRecord {
    counts: Record<string, HandoffCounts>;
    /** Última divisão calculada — desempate a favor dela no próximo recálculo. */
    transfers: HandoffTransfer[];
    noticeSentAt?: string;
    pendingSentAt?: string;
    divisionMessageId?: number;
    divisionText?: string;
    updatedAt?: string;
}

export interface OccurrenceHandoffState {
    chatId: string;
    operationalDate: string;
    now: string;
    roster: HandoffRosterEntry[];
    /** ramal → doctorId, para o @ do bot. Não vai para a rota pública. */
    doctorIds: Record<string, string>;
    window: { slot: string; phase: HandoffPhase; editable: boolean } | null;
    record: OccurrenceHandoffRecord | null;
}

export function formatSaoPauloHHMM(reference: Date) {
    const parts = getSaoPauloParts(reference);
    return `${String(parts.hour).padStart(2, "0")}:${String(parts.minute).padStart(2, "0")}`;
}

function noticeKey(chatId: string, operationalDate: string, slot: string) {
    return `${chatId}:occurrence_handoff:${operationalDate}:${slot}`;
}

/**
 * Roster da passagem a partir da sessão de refeições. RECIP/MRV vêm da sessão;
 * PSIQ não tem horário gravado (o fluxo o presume 12:30 e descanso 18:00), então
 * entra como presumido para a chefia conferir.
 */
export function buildHandoffRoster(session: MealBreakSession): HandoffRosterEntry[] {
    return session.roster.map((doctor) => {
        const ramal = doctor.ramal;
        const baseRole = normalizeOperationalRoleLabel(doctor.roleLabel) || null;
        const role = session.recipRamal === ramal ? "RECIP" : session.mrvRamals.includes(ramal) ? "MRV" : baseRole;
        const isPsiq = role === "PSIQ";
        const lunch = session.lunchAssignments[ramal] ?? (isPsiq ? "12:30" : null);
        const rest = session.restAssignments[ramal] ?? (isPsiq ? "18:00" : null);
        return {
            ramal,
            name: doctor.name,
            role,
            excludedPost: isNucleoRegulationPost(ramal) || isPiamRegulationPost(ramal),
            lunch,
            rest,
            lunchAssumed: isPsiq && !session.lunchAssignments[ramal],
        };
    });
}

async function loadRecord(chatId: string, operationalDate: string, slot: string): Promise<OccurrenceHandoffRecord | null> {
    const row = await getDb().query.telegramBotNotices.findFirst({
        where: eq(telegramBotNotices.noticeKey, noticeKey(chatId, operationalDate, slot)),
    });
    return row ? (row.payload as OccurrenceHandoffRecord) : null;
}

export async function getOccurrenceHandoffState(reference = new Date()): Promise<OccurrenceHandoffState | null> {
    const current = await getCurrentDayMealBreakSessionWithChat(reference);
    if (!current) return null;
    const window = resolveHandoffWindow(formatSaoPauloHHMM(reference));
    const operationalDate = current.session.operationalDate;
    return {
        chatId: current.chatId,
        operationalDate,
        now: reference.toISOString(),
        roster: buildHandoffRoster(current.session),
        doctorIds: Object.fromEntries(current.session.roster.map((d) => [d.ramal, d.doctorId])),
        window,
        record: window ? await loadRecord(current.chatId, operationalDate, window.slot) : null,
    };
}

export function planFromState(state: OccurrenceHandoffState, counts?: Record<string, HandoffCounts>): OccurrenceHandoffPlan | null {
    if (!state.window) return null;
    return planOccurrenceHandoff({
        roster: state.roster,
        slot: state.window.slot,
        counts: counts ?? state.record?.counts ?? {},
        seed: state.operationalDate,
        previous: state.record?.transfers,
    });
}

export class OccurrenceHandoffError extends Error {
    constructor(message: string, readonly status: number) {
        super(message);
    }
}

/**
 * Grava a contagem de quem sai e recalcula a divisão, com a anterior como
 * desempate. Linha travada durante a transação: dois médicos informando ao mesmo
 * tempo não se atropelam.
 */
export async function saveOccurrenceHandoffCounts(params: {
    slot: string;
    ramal: string;
    counts: HandoffCounts;
    reference?: Date;
}) {
    const reference = params.reference ?? new Date();
    const state = await getOccurrenceHandoffState(reference);
    if (!state || !state.window || state.window.slot !== params.slot) {
        throw new OccurrenceHandoffError("Fora da janela desta saída.", 409);
    }
    if (!state.window.editable) {
        throw new OccurrenceHandoffError("A divisão desta saída já fechou.", 409);
    }
    const probe = planFromState(state, {});
    if (!probe?.givers.some((g) => g.ramal === params.ramal)) {
        throw new OccurrenceHandoffError("Este ramal não sai neste horário.", 400);
    }
    const clean = (n: number) => Math.max(0, Math.min(99, Math.floor(Number(n) || 0)));
    const counts: HandoffCounts = { aguardando: clean(params.counts.aguardando), regulado: clean(params.counts.regulado) };

    const key = noticeKey(state.chatId, state.operationalDate, params.slot);
    const db = getDb();
    await db.insert(telegramBotNotices)
        .values({ noticeKey: key, chatId: state.chatId, stage: OCCURRENCE_HANDOFF_STAGE, payload: { counts: {}, transfers: [] } })
        .onConflictDoNothing();

    return db.transaction(async (tx) => {
        const locked = await tx.execute(sql`select payload from ${telegramBotNotices} where ${telegramBotNotices.noticeKey} = ${key} for update`);
        const rows = (Array.isArray(locked) ? locked : (locked as { rows?: unknown[] }).rows ?? []) as Array<{ payload: OccurrenceHandoffRecord }>;
        const record: OccurrenceHandoffRecord = rows[0]?.payload ?? { counts: {}, transfers: [] };
        const nextCounts = { ...record.counts, [params.ramal]: counts };
        const plan = planOccurrenceHandoff({
            roster: state.roster,
            slot: params.slot,
            counts: nextCounts,
            seed: state.operationalDate,
            previous: record.transfers,
        });
        const next: OccurrenceHandoffRecord = {
            ...record,
            counts: nextCounts,
            transfers: plan.transfers,
            updatedAt: reference.toISOString(),
        };
        await tx.update(telegramBotNotices)
            .set({ payload: next })
            .where(and(eq(telegramBotNotices.noticeKey, key), eq(telegramBotNotices.stage, OCCURRENCE_HANDOFF_STAGE)));
        return { plan, record: next };
    });
}

/** Marca campos de controle do bot (aviso/cobrança/mensagem da divisão). */
export async function patchOccurrenceHandoffRecord(chatId: string, operationalDate: string, slot: string, patch: Partial<OccurrenceHandoffRecord>) {
    const key = noticeKey(chatId, operationalDate, slot);
    const db = getDb();
    await db.insert(telegramBotNotices)
        .values({ noticeKey: key, chatId, stage: OCCURRENCE_HANDOFF_STAGE, payload: { counts: {}, transfers: [], ...patch } })
        .onConflictDoUpdate({
            target: telegramBotNotices.noticeKey,
            set: { payload: sql`${telegramBotNotices.payload} || ${JSON.stringify(patch)}::jsonb` },
        });
}

import { sql } from "drizzle-orm";

/**
 * O posto onde o médico CHEGOU decide a hora prevista de chegada do turno.
 *
 * Só um ramal tem hora própria: o NUCLEO abre às 08:00 no SD (todo o resto,
 * 07:00/19:00 — modules/operational/rules.ts). Quem chega 07:50 no NUCLEO está
 * no horário. Se a chefia o remaneja às 10:00 para a CRU, ele não volta no tempo
 * para ter chegado às 07:00: a exigência de chegada foi fixada quando ele chegou,
 * pelo posto em que chegou. Reinferir a janela pelo posto ATUAL (o destino)
 * inventava 50 min de atraso e derrubava a hora extra em dobro.
 *
 * Este módulo responde "qual posto define a chegada deste turno?" para quem
 * precisa inferir a janela de uma posição que não é a primeira do turno:
 *
 *   1. a posição mais antiga do mesmo grupo de continuidade no turno (a
 *      chegada de fato) — ramal da regulação devolve o código; base de
 *      intervenção devolve null (07:00/19:00);
 *   2. sem posição anterior (origem apagada, grupo partido), a origem que o
 *      próprio remanejo gravou nas notas ("Remanejado de NUCLEO para 2151.");
 *   3. sem nada disso, o posto atual.
 *
 * Contexto do defeito e do saneamento: docs/remanejamento-nucleo-banco-horas.md.
 */

export type TurnoLegDomain = "regulation" | "intervention";

export interface TurnoLeg {
    domain: TurnoLegDomain;
    targetCode: string;
    startedAt: Date;
}

/**
 * Notas de remanejo, nos três formatos que o sistema grava
 * (transferNoteLine, displaceNoteLine e handleTelegramReassignment).
 * Captura a PRIMEIRA ocorrência: numa cadeia NUCLEO → 2151 → 2152 as notas
 * acumulam e a primeira linha é a origem do turno.
 */
const REASSIGNMENT_ORIGIN_RE = /Remanejado(?:\s+via\s+Telegram)?(?:\s+por\s+conflito\s+operacional)?\s+de\s+([^\s.]+)\s+para\s+[^\s.]+/i;

export function parseReassignmentOriginCode(notes: string | null | undefined): string | null {
    if (!notes) {
        return null;
    }
    const match = notes.match(REASSIGNMENT_ORIGIN_RE);
    return match ? match[1].trim().toUpperCase() : null;
}

/** Quantas horas antes da posição atual uma posição anterior ainda é o mesmo turno. */
export const TURNO_ARRIVAL_LOOKBACK_MS = 13 * 60 * 60 * 1000;

/**
 * Posto (código) que define a chegada do turno para a posição `current`.
 * `null` = chegada em base de intervenção (sem hora própria: 07:00/19:00).
 */
export function pickTurnoArrivalPostCode(params: {
    current: TurnoLeg & { notes: string | null };
    earlierLegs: TurnoLeg[];
}): string | null {
    const earliest = params.earlierLegs
        .filter((leg) => {
            const gap = params.current.startedAt.getTime() - leg.startedAt.getTime();
            return gap > 0 && gap <= TURNO_ARRIVAL_LOOKBACK_MS;
        })
        .sort((left, right) => left.startedAt.getTime() - right.startedAt.getTime())[0] ?? null;
    if (earliest) {
        return earliest.domain === "regulation" ? earliest.targetCode : null;
    }

    const origin = parseReassignmentOriginCode(params.current.notes);
    if (origin) {
        return origin;
    }

    return params.current.domain === "regulation" ? params.current.targetCode : null;
}

type Executor = any;

interface EarlierLegRow {
    domain: TurnoLegDomain;
    code: string;
    startedAt: string | Date;
}

/**
 * Posições anteriores do mesmo médico no mesmo grupo de continuidade, dentro
 * da janela do turno. Cobertura de madrugada fica fora (docs/madrugada.md).
 */
export async function listEarlierTurnoLegsTx(tx: Executor, params: {
    doctorId: string;
    continuityGroupId: string;
    startedAt: Date;
    excludeOccupancyId?: string | null;
}): Promise<TurnoLeg[]> {
    const startedAtIso = params.startedAt.toISOString();
    const since = new Date(params.startedAt.getTime() - TURNO_ARRIVAL_LOOKBACK_MS).toISOString();
    const excludeId = params.excludeOccupancyId ?? "00000000-0000-0000-0000-000000000000";
    const result = await tx.execute(sql`
        select x.domain, x.code, x.started_at as "startedAt" from (
            select 'regulation' as domain, rp.code, ro.id, ro.doctor_id, ro.continuity_group_id, ro.started_at, ro.madrugada_cobertura
            from operations_v2.regulation_occupancies ro
            join operations_v2.regulation_posts rp on rp.id = ro.post_id
            union all
            select 'intervention', ib.code, io.id, io.doctor_id, io.continuity_group_id, io.started_at, false
            from operations_v2.intervention_occupancies io
            join operations_v2.intervention_bases ib on ib.id = io.base_id
        ) x
        where x.doctor_id = ${params.doctorId}::uuid
          and x.continuity_group_id = ${params.continuityGroupId}::uuid
          and x.id <> ${excludeId}::uuid
          and not x.madrugada_cobertura
          and x.started_at < ${startedAtIso}::timestamptz
          and x.started_at >= ${since}::timestamptz
        order by x.started_at asc
    `);
    const rows = ((result as unknown as { rows?: EarlierLegRow[] }).rows ?? result) as EarlierLegRow[];
    return rows.map((row) => ({
        domain: row.domain,
        targetCode: row.code,
        startedAt: row.startedAt instanceof Date ? row.startedAt : new Date(row.startedAt),
    }));
}

/**
 * Versão com banco de pickTurnoArrivalPostCode: busca as posições anteriores
 * do grupo e decide. Sem grupo (posição nova, ainda sem herança) cai nas
 * notas e depois no posto atual.
 */
export async function resolveTurnoArrivalPostCodeTx(tx: Executor, params: {
    domain: TurnoLegDomain;
    targetCode: string;
    doctorId: string;
    continuityGroupId: string | null;
    startedAt: Date;
    notes: string | null;
    excludeOccupancyId?: string | null;
}): Promise<string | null> {
    const earlierLegs = params.continuityGroupId
        ? await listEarlierTurnoLegsTx(tx, {
            doctorId: params.doctorId,
            continuityGroupId: params.continuityGroupId,
            startedAt: params.startedAt,
            excludeOccupancyId: params.excludeOccupancyId ?? null,
        })
        : [];
    return pickTurnoArrivalPostCode({
        current: {
            domain: params.domain,
            targetCode: params.targetCode,
            startedAt: params.startedAt,
            notes: params.notes,
        },
        earlierLegs,
    });
}

/**
 * Guarda contra plantão duplicado no mesmo dia e turno.
 *
 * Em 2026-08-03 um médico terminou com duas ocupações no mesmo dia e turno — uma
 * registrada pelo bot às 07:14 no ramal 2032, outra lançada à mão às 15:43 no
 * ramal 2034 — porque a tela não avisou que já existia. O mês fechou com 9
 * plantões para 8 dias trabalhados, R$ 1.244,87 a mais, e isso foi atestado
 * antes de alguém perceber.
 *
 * O que NÃO é duplicidade, e por isso o filtro é estreito:
 *
 *   - transferência entre postos/bases: gera linha nova, mas mantém o mesmo
 *     continuity_group_id — é o mesmo plantão mudando de lugar;
 *   - ocupação sombra: entra sem board_started_at justamente para não disputar
 *     o quadro com o titular;
 *   - continuidade de turno: reusa o grupo do plantão anterior.
 *
 * Duplicidade de verdade é: mesmo médico, mesmo dia operacional, mesmo turno,
 * grupos de continuidade DIFERENTES, e as duas segurando o quadro.
 */
import { sql } from "drizzle-orm";
import { getDb } from "@/db";
import { resolveArrivalIdentity } from "@/modules/operational/occupancy-identity";

export interface OccupancyConflict {
    domain: "regulation" | "intervention";
    occupancyId: string;
    targetCode: string;
    startedAt: string;
    source: string;
}

export async function findSameDayOccupancies(params: {
    doctorId: string;
    startedAt: Date;
    shiftLabel: string | null;
    /** Grupo do plantão sendo criado: transferência e continuidade reusam. */
    continuityGroupId?: string | null;
}): Promise<OccupancyConflict[]> {
    // Turno sem rótulo não tem como ser comparado com segurança.
    if (!params.shiftLabel) return [];

    const dia = params.startedAt.toISOString();
    const grupo = params.continuityGroupId ?? null;

    const linhas = await getDb().execute(sql`
        select 'regulation' as domain, o.id::text as occupancy_id, rp.code as target_code,
               o.started_at::text as started_at, o.source::text as source
        from operations_v2.regulation_occupancies o
        join operations_v2.regulation_posts rp on rp.id = o.post_id
        where o.doctor_id = ${params.doctorId}
          and o.shift_label = ${params.shiftLabel}
          and o.board_started_at is not null
          and (o.started_at at time zone 'America/Sao_Paulo')::date
              = (${dia}::timestamptz at time zone 'America/Sao_Paulo')::date
          and (${grupo}::uuid is null or o.continuity_group_id <> ${grupo}::uuid)
        union all
        select 'intervention', o.id::text, ib.code,
               o.started_at::text, o.source::text
        from operations_v2.intervention_occupancies o
        join operations_v2.intervention_bases ib on ib.id = o.base_id
        where o.doctor_id = ${params.doctorId}
          and o.shift_label = ${params.shiftLabel}
          and o.board_started_at is not null
          and (o.started_at at time zone 'America/Sao_Paulo')::date
              = (${dia}::timestamptz at time zone 'America/Sao_Paulo')::date
          and (${grupo}::uuid is null or o.continuity_group_id <> ${grupo}::uuid)
    `) as unknown as {
        domain: "regulation" | "intervention";
        occupancy_id: string;
        target_code: string;
        started_at: string;
        source: string;
    }[];

    return linhas.map((linha) => ({
        domain: linha.domain,
        occupancyId: linha.occupancy_id,
        targetCode: linha.target_code,
        startedAt: linha.started_at,
        source: linha.source,
    }));
}

export interface MergeableOccupancy {
    occupancyId: string;
    targetCode: string;
    /** Chegada já registrada neste plantão. */
    startedAt: string;
    /** Saída registrada que a nova chegada desmente (nula = fechamento automático). */
    departureAt: string | null;
    source: string;
}

/**
 * Plantão FECHADO do mesmo médico no MESMO alvo cuja janela ainda cobre esta
 * chegada. Lançar por cima disso não cria um segundo plantão: cria uma duplicata
 * com horário divergente. A tela pergunta o horário verdadeiro e junta.
 */
export async function findMergeableOccupancy(params: {
    domain: "regulation" | "intervention";
    targetId: number;
    doctorId: string;
    startedAt: Date;
}): Promise<MergeableOccupancy | null> {
    const desde = new Date(params.startedAt.getTime() - 24 * 60 * 60 * 1000).toISOString();

    const linhas = await getDb().execute(
        params.domain === "regulation"
            ? sql`
                select o.id::text as occupancy_id, rp.code as target_code, o.started_at, o.ended_at,
                       o.actual_ended_at, o.scheduled_end_at, o.departure_confirmed_at, o.notes,
                       o.source::text as source
                from operations_v2.regulation_occupancies o
                join operations_v2.regulation_posts rp on rp.id = o.post_id
                where o.doctor_id = ${params.doctorId}
                  and o.post_id = ${params.targetId}
                  and o.ended_at is not null
                  and o.started_at >= ${desde}::timestamptz
                order by o.started_at desc
            `
            : sql`
                select o.id::text as occupancy_id, ib.code as target_code, o.started_at, o.ended_at,
                       o.actual_ended_at, o.scheduled_end_at, o.departure_confirmed_at, o.notes,
                       o.source::text as source
                from operations_v2.intervention_occupancies o
                join operations_v2.intervention_bases ib on ib.id = o.base_id
                where o.doctor_id = ${params.doctorId}
                  and o.base_id = ${params.targetId}
                  and o.ended_at is not null
                  and o.started_at >= ${desde}::timestamptz
                order by o.started_at desc
            `,
    ) as unknown as {
        occupancy_id: string;
        target_code: string;
        started_at: string | Date;
        ended_at: string | Date | null;
        actual_ended_at: string | Date | null;
        scheduled_end_at: string | Date | null;
        departure_confirmed_at: string | Date | null;
        source: string;
    }[];

    const data = (value: string | Date | null) => (value ? new Date(value) : null);
    const identity = resolveArrivalIdentity({
        startedAt: params.startedAt,
        existing: linhas.map((linha) => ({
            id: linha.occupancy_id,
            doctorId: params.doctorId,
            startedAt: new Date(linha.started_at),
            endedAt: data(linha.ended_at),
            actualEndedAt: data(linha.actual_ended_at),
            scheduledEndAt: data(linha.scheduled_end_at),
            departureConfirmed: linha.departure_confirmed_at !== null,
        })),
    });

    if (identity.kind !== "merge") {
        return null;
    }

    const alvo = linhas.find((linha) => linha.occupancy_id === identity.occupancyId);
    if (!alvo) return null;

    return {
        occupancyId: alvo.occupancy_id,
        targetCode: alvo.target_code,
        startedAt: new Date(alvo.started_at).toISOString(),
        departureAt: identity.previousDepartureAt?.toISOString() ?? null,
        source: alvo.source,
    };
}

/** Mensagem da tela de junção: o que existe, e o que a confirmação vai fazer. */
export function describeMergeable(mergeable: MergeableOccupancy): string {
    const hora = (iso: string) => new Intl.DateTimeFormat("pt-BR", {
        hour: "2-digit", minute: "2-digit", timeZone: "America/Sao_Paulo",
    }).format(new Date(iso));

    const saida = mergeable.departureAt
        ? `com saída registrada às ${hora(mergeable.departureAt)}`
        : "encerrado sem saída verbalizada";

    return `Este médico já tem plantão no ${mergeable.targetCode} nesta janela,`
        + ` com chegada às ${hora(mergeable.startedAt)} e ${saida}.`
        + " Lançar de novo criaria um segundo plantão e pagaria em dobro."
        + " Informe o horário verdadeiro de chegada e confirme para JUNTAR ao plantão que já existe.";
}

/** Mensagem para a tela: diz o que já existe e o que vai acontecer se insistir. */
export function describeConflicts(conflicts: OccupancyConflict[]): string {
    const lista = conflicts
        .map((c) => {
            const hora = new Intl.DateTimeFormat("pt-BR", {
                hour: "2-digit", minute: "2-digit", timeZone: "America/Sao_Paulo",
            }).format(new Date(c.startedAt));
            const origem = c.source === "telegram" ? "registrado pelo bot" : `origem ${c.source}`;
            return `${c.targetCode} às ${hora} (${origem})`;
        })
        .join("; ");

    return `Este médico já tem plantão neste dia e turno: ${lista}.`
        + " Lançar outro faz o mês contar em dobro e infla o valor da nota."
        + " Se for mesmo um segundo plantão, confirme para prosseguir.";
}

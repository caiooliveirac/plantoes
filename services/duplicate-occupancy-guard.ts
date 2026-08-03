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

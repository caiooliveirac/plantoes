/**
 * Verificação pós-virada: as consultas de docs/verificacao-saidas-continuidade.md
 * (itens 1 a 6 — os que o banco responde), numa janela [inicio, fim).
 * Só leitura.
 *
 * Achado = o que o roteiro chama de falha:
 *  - item 2: saída 10h+ depois do fim programado, sem a marca de continuação e
 *    sem sucessor no ramal (a regra das 10h deixou escapar);
 *  - item 4: banco de horas creditando acima do teto de 720 min;
 *  - item 5: P com /corrigir e sobra de 6h+ (plantão fantasma, regressão do #237);
 *  - item 6: correção de plantão sem origem na auditoria.
 * Itens 1 e 3 são contagens de contexto — zero não é falha.
 */
import { sql } from "drizzle-orm";

import { getDb } from "@/db";

const MARCA_CONTINUACAO = "%continuacao reconhecida pela permanencia%";
const MARCA_CORRIGIR = "%[telegram /corrigir]%";
const TETO_CREDITO_MINUTOS = 720;

export interface VerificacaoJanela {
    inicio: Date;
    fim: Date;
}

export interface SaidaSuspeita {
    medico: string;
    ramal: string;
    turno: string | null;
    scheduledEndAt: string;
    actualEndedAt: string;
    sobraHoras: number;
}

export interface VerificacaoPosVirada {
    janela: { inicio: string; fim: string };
    /** 1. Continuações reconhecidas pela permanência (contexto). */
    continuacoesMarcadas: number;
    /** 2. Saídas 10h+ sem marca e sem sucessor (achado). */
    escapesRegra10h: SaidaSuspeita[];
    /** 3. Chegadas com âncora herdada / chegadas (contexto). */
    ancora: { herdada: number; chegadas: number };
    /** 4. Banco de horas (achado se acimaDoTeto > 0). */
    bancoDeHoras: { acimaDoTeto: number; permanenciasLongas: number; total: number };
    /** 5. P fantasma depois de /corrigir (achado). */
    pFantasma: SaidaSuspeita[];
    /** 6. Correções auditadas; semOrigem > 0 é achado. */
    correcoes: { total: number; semOrigem: number };
}

type Row = Record<string, unknown>;

async function rows(query: ReturnType<typeof sql>) {
    return (await getDb().execute(query)) as unknown as Row[];
}

function iso(value: unknown) {
    return value instanceof Date ? value.toISOString() : String(value);
}

function toSaida(row: Row): SaidaSuspeita {
    return {
        medico: String(row.medico),
        ramal: String(row.ramal),
        turno: (row.turno as string | null) ?? null,
        scheduledEndAt: iso(row.scheduled_end_at),
        actualEndedAt: iso(row.actual_ended_at),
        sobraHoras: Number(row.sobra_h),
    };
}

export async function runVerificacaoPosVirada(janela: VerificacaoJanela): Promise<VerificacaoPosVirada> {
    const inicio = janela.inicio.toISOString();
    const fim = janela.fim.toISOString();

    // Sequencial de propósito: pool pequeno, e são seis leituras curtas.
    const [marcadas] = await rows(sql`
        select count(*)::int as n
        from operations_v2.regulation_occupancies o
        where o.notes ilike ${MARCA_CONTINUACAO}
          and o.updated_at >= ${inicio} and o.updated_at < ${fim}
    `);

    const escapes = await rows(sql`
        select d.full_name as medico, p.code as ramal, o.shift_label as turno,
               o.scheduled_end_at, o.actual_ended_at,
               round(extract(epoch from (o.actual_ended_at - o.scheduled_end_at)) / 3600, 1) as sobra_h
        from operations_v2.regulation_occupancies o
        join operations_v2.doctors d on d.id = o.doctor_id
        join operations_v2.regulation_posts p on p.id = o.post_id
        where o.actual_ended_at >= ${inicio} and o.actual_ended_at < ${fim}
          and o.scheduled_end_at is not null
          and o.actual_ended_at >= o.scheduled_end_at + interval '10 hours'
          and coalesce(o.notes, '') not ilike ${MARCA_CONTINUACAO}
          and not exists (
              select 1
              from operations_v2.regulation_occupancies s
              where s.post_id = o.post_id
                and s.id <> o.id
                and s.doctor_id <> o.doctor_id
                and s.started_at between o.scheduled_end_at - interval '2 hours'
                                     and o.scheduled_end_at + interval '4 hours'
          )
        order by sobra_h desc
    `);

    const [ancora] = await rows(sql`
        select count(*) filter (where o.board_started_at < o.started_at)::int as herdada,
               count(*)::int as chegadas
        from operations_v2.regulation_occupancies o
        where o.created_at >= ${inicio} and o.created_at < ${fim}
          and o.board_started_at is not null
    `);

    const [banco] = await rows(sql`
        select count(*) filter (where credited_overtime_minutes > ${TETO_CREDITO_MINUTOS})::int as acima_do_teto,
               count(*) filter (where rule_code = 'EXTENDED_STAY_PAYABLE_SHIFT')::int as permanencias_longas,
               count(*)::int as total
        from operations_v2.bank_hours_entries
        where updated_at >= ${inicio} and updated_at < ${fim}
    `);

    const fantasmas = await rows(sql`
        select d.full_name as medico, p.code as ramal, o.shift_label as turno,
               o.scheduled_end_at, o.actual_ended_at,
               round(extract(epoch from (o.actual_ended_at - o.scheduled_end_at)) / 3600, 1) as sobra_h
        from operations_v2.regulation_occupancies o
        join operations_v2.doctors d on d.id = o.doctor_id
        join operations_v2.regulation_posts p on p.id = o.post_id
        where o.shift_label = 'P'
          and o.notes ilike ${MARCA_CORRIGIR}
          and o.updated_at >= ${inicio} and o.updated_at < ${fim}
          and o.actual_ended_at > o.scheduled_end_at + interval '6 hours'
        order by sobra_h desc
    `);

    const [correcoes] = await rows(sql`
        select count(*)::int as total,
               count(*) filter (where coalesce(details->>'source', '') = '')::int as sem_origem
        from operations_v2.audit_logs
        where action in ('regulation_occupancy.corrected', 'intervention_occupancy.corrected')
          and created_at >= ${inicio} and created_at < ${fim}
    `);

    return {
        janela: { inicio, fim },
        continuacoesMarcadas: Number(marcadas?.n ?? 0),
        escapesRegra10h: escapes.map(toSaida),
        ancora: { herdada: Number(ancora?.herdada ?? 0), chegadas: Number(ancora?.chegadas ?? 0) },
        bancoDeHoras: {
            acimaDoTeto: Number(banco?.acima_do_teto ?? 0),
            permanenciasLongas: Number(banco?.permanencias_longas ?? 0),
            total: Number(banco?.total ?? 0),
        },
        pFantasma: fantasmas.map(toSaida),
        correcoes: { total: Number(correcoes?.total ?? 0), semOrigem: Number(correcoes?.sem_origem ?? 0) },
    };
}

export function hasVerificacaoAchado(result: VerificacaoPosVirada) {
    return result.escapesRegra10h.length > 0
        || result.bancoDeHoras.acimaDoTeto > 0
        || result.pFantasma.length > 0
        || result.correcoes.semOrigem > 0;
}

const HORA_SP = new Intl.DateTimeFormat("pt-BR", {
    timeZone: "America/Sao_Paulo",
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
});

function formatSaida(saida: SaidaSuspeita) {
    return `  • ${saida.medico} ${saida.ramal}${saida.turno ? ` ${saida.turno}` : ""}: saiu ${HORA_SP.format(new Date(saida.actualEndedAt))} (+${saida.sobraHoras}h)`;
}

const MAX_LINHAS_POR_ITEM = 5;

function listar(saidas: SaidaSuspeita[]) {
    const linhas = saidas.slice(0, MAX_LINHAS_POR_ITEM).map(formatSaida);
    if (saidas.length > MAX_LINHAS_POR_ITEM) {
        linhas.push(`  … e mais ${saidas.length - MAX_LINHAS_POR_ITEM}`);
    }
    return linhas;
}

/** Resumo curto, uma linha por item do roteiro (ok / falhou / sem dado). */
export function formatVerificacaoResumo(result: VerificacaoPosVirada) {
    const linhas = [
        `🔎 Verificação pós-virada (${HORA_SP.format(new Date(result.janela.inicio))} → ${HORA_SP.format(new Date(result.janela.fim))})`,
        `1. Continuações pela permanência: ${result.continuacoesMarcadas}`,
    ];

    if (result.escapesRegra10h.length > 0) {
        linhas.push(`2. ❌ ${result.escapesRegra10h.length} saída(s) 10h+ sem continuação nem sucessor:`, ...listar(result.escapesRegra10h));
    } else {
        linhas.push("2. ok — nenhuma saída 10h+ escapou");
    }

    linhas.push(result.ancora.chegadas > 0
        ? `3. Âncora herdada: ${result.ancora.herdada}/${result.ancora.chegadas} chegadas`
        : "3. sem dado — nenhuma chegada na janela");

    const banco = result.bancoDeHoras;
    if (banco.acimaDoTeto > 0) {
        linhas.push(`4. ❌ ${banco.acimaDoTeto} lançamento(s) de banco acima do teto de 12h (de ${banco.total})`);
    } else {
        linhas.push(banco.total > 0 ? `4. ok — teto respeitado (${banco.total} lançamentos, ${banco.permanenciasLongas} permanências longas)` : "4. sem dado — nenhum lançamento");
    }

    if (result.pFantasma.length > 0) {
        linhas.push(`5. ❌ ${result.pFantasma.length} P fantasma depois de /corrigir (não lançar na folha):`, ...listar(result.pFantasma));
    } else {
        linhas.push("5. ok — nenhum P fantasma");
    }

    const correcoes = result.correcoes;
    if (correcoes.semOrigem > 0) {
        linhas.push(`6. ❌ ${correcoes.semOrigem} de ${correcoes.total} correção(ões) sem origem na auditoria`);
    } else {
        linhas.push(correcoes.total > 0 ? `6. ok — ${correcoes.total} correção(ões), todas com origem` : "6. sem dado — nenhuma correção");
    }

    return linhas.join("\n");
}

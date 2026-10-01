/* ==========================================================================
   GET /api/servicos/relatorio/turno?data=YYYY-MM-DD&turno=SD|SN
   Quem estava no turno, para o relatório da chefia (relatorio.mnrs.com.br).

   Quem chama: o servidor do relatório, em 127.0.0.1. Portão: o mesmo token de
   serviço do quadro/porteiro (ESCALA_SSO_TOKEN em x-escala-token, tempo
   constante). Sem a variável: 503.

   Devolve horários BRUTOS (o relatório não aplica tolerância):
     { ok, turno: { data, turno, inicio, fim },
       regulacao:   [ocupação…],   // ramais (2031 = chefia)
       intervencao: [ocupação…],   // bases USA
       desativacoes: [{ tipo: "base"|"ramal", codigo, desde, ate, notas }],
       enfermeiros: [{ nome, profissionalId, registradoEm, substituidoEm }] }
   ocupação = { id, codigo, rotulo, medicoId, nome, nomeCompleto,
                programadoInicio, programadoFim, chegada, quadroDesde,
                handoff, saida, turnoRotulo, funcao, ramal, origem,
                sombra, madrugadaCobertura, saidaAntecipada, atrasoDispensado }

   Pertence ao turno a ocupação cuja janela [programado/chegada, saída/handoff/
   programado] cruza o miolo do turno (início+1h … fim−1h): quem só rendeu às
   07:20 ou chegou às 18:30 para o SN não entra no SD.
   ========================================================================== */
import { timingSafeEqual } from "node:crypto";
import { sql } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";
import { getDb, hasDatabaseUrl } from "@/db";

function tokenConfere(recebido: string | null, esperado: string): boolean {
    if (!recebido) return false;
    const a = Buffer.from(recebido, "utf8");
    const b = Buffer.from(esperado, "utf8");
    return a.length === b.length && timingSafeEqual(a, b);
}

function janela(data: string, turno: "SD" | "SN") {
    // Salvador = UTC-3 fixo. SD 07–19 do dia; SN 19 do dia → 07 do dia seguinte.
    const base = Date.parse(`${data}T00:00:00-03:00`);
    const inicio = new Date(base + (turno === "SD" ? 7 : 19) * 3600e3);
    const fim = new Date(inicio.getTime() + 12 * 3600e3);
    return { inicio, fim };
}

const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : v ? String(v) : null);

function linhaOcupacao(r: Record<string, unknown>) {
    return {
        id: String(r.id),
        codigo: String(r.codigo),
        rotulo: String(r.rotulo),
        medicoId: String(r.medico_id),
        nome: String(r.nome),
        nomeCompleto: String(r.nome_completo),
        programadoInicio: iso(r.scheduled_start_at),
        programadoFim: iso(r.scheduled_end_at),
        chegada: iso(r.started_at),
        quadroDesde: iso(r.board_started_at),
        handoff: iso(r.ended_at),
        saida: iso(r.actual_ended_at),
        turnoRotulo: (r.shift_label as string | null) ?? null,
        funcao: (r.role_label as string | null) ?? null,
        ramal: (r.ramal_label as string | null) ?? null,
        origem: String(r.source),
        sombra: r.board_started_at == null,
        madrugadaCobertura: Boolean(r.madrugada_cobertura),
        saidaAntecipada: (r.early_departure_outcome as string | null) ?? null,
        atrasoDispensado: r.arrival_delay_waived_at != null,
    };
}

export async function GET(request: NextRequest) {
    const esperado = process.env.ESCALA_SSO_TOKEN;
    if (!esperado) return NextResponse.json({ error: "integration_not_configured" }, { status: 503 });
    if (!tokenConfere(request.headers.get("x-escala-token"), esperado)) {
        return NextResponse.json({ error: "invalid_token" }, { status: 401 });
    }
    if (!hasDatabaseUrl()) return NextResponse.json({ error: "no_database" }, { status: 503 });

    const data = request.nextUrl.searchParams.get("data") ?? "";
    const turno = request.nextUrl.searchParams.get("turno");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(data) || (turno !== "SD" && turno !== "SN")) {
        return NextResponse.json({ error: "invalid_params" }, { status: 400 });
    }
    const { inicio, fim } = janela(data, turno);
    const miolo0 = new Date(inicio.getTime() + 3600e3).toISOString();
    const miolo1 = new Date(fim.getTime() - 3600e3).toISOString();

    try {
        const db = getDb();
        const ocupacoes = (tabela: "regulation" | "intervention") => {
            const occ = tabela === "regulation" ? sql`operations_v2.regulation_occupancies` : sql`operations_v2.intervention_occupancies`;
            const lugar = tabela === "regulation" ? sql`operations_v2.regulation_posts` : sql`operations_v2.intervention_bases`;
            const fk = tabela === "regulation" ? sql`o.post_id` : sql`o.base_id`;
            const ramal = tabela === "regulation" ? sql`o.ramal_label` : sql`null::text`;
            const madrugada = tabela === "regulation" ? sql`o.madrugada_cobertura` : sql`false`;
            return db.execute(sql`
                select o.id, l.code as codigo, l.label as rotulo, d.id as medico_id,
                       coalesce(nullif(trim(d.display_name), ''), d.full_name) as nome,
                       d.full_name as nome_completo,
                       o.scheduled_start_at, o.scheduled_end_at, o.started_at, o.board_started_at,
                       o.ended_at, o.actual_ended_at, o.shift_label, o.role_label, ${ramal} as ramal_label,
                       o.source, ${madrugada} as madrugada_cobertura, o.early_departure_outcome,
                       o.arrival_delay_waived_at
                  from ${occ} o
                  join ${lugar} l on l.id = ${fk}
                  join operations_v2.doctors d on d.id = o.doctor_id
                 where coalesce(o.scheduled_start_at, o.started_at) < ${miolo1}::timestamptz
                   and coalesce(o.actual_ended_at, o.ended_at, o.scheduled_end_at, o.started_at + interval '12 hours') > ${miolo0}::timestamptz
                 order by l.sort_order, o.started_at
            `);
        };
        const [reg, int, desat, enf] = await Promise.all([
            ocupacoes("regulation"),
            ocupacoes("intervention"),
            db.execute(sql`
                select 'base' as tipo, b.code as codigo, x.deactivated_at as desde, x.reactivated_at as ate, x.notes as notas
                  from operations_v2.intervention_base_deactivations x
                  join operations_v2.intervention_bases b on b.id = x.base_id
                 where x.deactivated_at < ${fim.toISOString()}::timestamptz
                   and coalesce(x.reactivated_at, 'infinity') > ${inicio.toISOString()}::timestamptz
                union all
                select 'ramal', p.code, x.deactivated_at, x.reactivated_at, x.notes
                  from operations_v2.regulation_post_deactivations x
                  join operations_v2.regulation_posts p on p.id = x.post_id
                 where x.deactivated_at < ${fim.toISOString()}::timestamptz
                   and coalesce(x.reactivated_at, 'infinity') > ${inicio.toISOString()}::timestamptz
                 order by 2, 3
            `),
            db.execute(sql`
                select nome, profissional_id, registrado_em, substituido_em
                  from operations_v2.enfermeiros_plantao
                 where turno_data = ${data}::date and turno = ${turno}
                 order by registrado_em
            `),
        ]);
        const rows = (r: unknown) => r as Array<Record<string, unknown>>;
        return NextResponse.json({
            ok: true,
            turno: { data, turno, inicio: inicio.toISOString(), fim: fim.toISOString() },
            regulacao: rows(reg).map(linhaOcupacao),
            intervencao: rows(int).map(linhaOcupacao),
            desativacoes: rows(desat).map((r) => ({ tipo: String(r.tipo), codigo: String(r.codigo), desde: iso(r.desde), ate: iso(r.ate), notas: (r.notas as string | null) ?? null })),
            enfermeiros: rows(enf).map((r) => ({ nome: String(r.nome), profissionalId: (r.profissional_id as string | null) ?? null, registradoEm: iso(r.registrado_em), substituidoEm: iso(r.substituido_em) })),
        }, { headers: { "cache-control": "no-store" } });
    } catch (error) {
        console.error(`[relatorio-turno] ${error instanceof Error ? error.message : String(error)}`);
        return NextResponse.json({ error: "unavailable" }, { status: 500 });
    }
}

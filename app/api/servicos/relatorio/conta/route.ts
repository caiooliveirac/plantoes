/* ==========================================================================
   GET /api/servicos/relatorio/conta?email=…
   Quem é a conta, para o portão do relatório da chefia (relatorio.mnrs.com.br).

   O porteiro só repassa email/nome/admin; o relatório pergunta aqui os papéis
   e quando a pessoa esteve na 2031 (chefia). A regra de acesso (chief que foi
   2031 nas últimas 36 h; admin lê tudo) fica no relatório — aqui só os fatos.

   Portão: ESCALA_SSO_TOKEN em x-escala-token (tempo constante); sem: 503.

     200 { ok, conta: null }                         // email sem conta ativa
     200 { ok, conta: { email, papeis[], medico: { id, nome, nomeCompleto } | null,
                        chefias: [{ inicio, fim, programadoInicio, programadoFim }] } }
   `chefias` = ocupações titulares na 2031 com chegada nos últimos 7 dias.
   ========================================================================== */
import { timingSafeEqual } from "node:crypto";
import { sql } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";
import { getDb, hasDatabaseUrl } from "@/db";
import { CHIEF_REGULATION_POST_CODE } from "@/modules/operational/roles";

function tokenConfere(recebido: string | null, esperado: string): boolean {
    if (!recebido) return false;
    const a = Buffer.from(recebido, "utf8");
    const b = Buffer.from(esperado, "utf8");
    return a.length === b.length && timingSafeEqual(a, b);
}

const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : v ? String(v) : null);

export async function GET(request: NextRequest) {
    const esperado = process.env.ESCALA_SSO_TOKEN;
    if (!esperado) return NextResponse.json({ error: "integration_not_configured" }, { status: 503 });
    if (!tokenConfere(request.headers.get("x-escala-token"), esperado)) {
        return NextResponse.json({ error: "invalid_token" }, { status: 401 });
    }
    if (!hasDatabaseUrl()) return NextResponse.json({ error: "no_database" }, { status: 503 });

    const email = (request.nextUrl.searchParams.get("email") ?? "").trim().toLowerCase();
    if (!email || email.length > 200) return NextResponse.json({ error: "invalid_params" }, { status: 400 });

    try {
        const db = getDb();
        const contas = (await db.execute(sql`
            select u.id, u.email, d.id as medico_id,
                   coalesce(nullif(trim(d.display_name), ''), d.full_name) as nome,
                   d.full_name as nome_completo,
                   coalesce(array_agg(r.role::text) filter (where r.role is not null), '{}') as papeis
              from operations_v2.users u
              left join operations_v2.doctors d on d.id = u.doctor_id
              left join operations_v2.user_roles r on r.user_id = u.id
             where lower(u.email) = ${email} and u.is_active
             group by u.id, d.id
             limit 1
        `)) as unknown as Array<Record<string, unknown>>;
        const c = contas[0];
        if (!c) return NextResponse.json({ ok: true, conta: null }, { headers: { "cache-control": "no-store" } });

        let chefias: Array<Record<string, unknown>> = [];
        if (c.medico_id) {
            chefias = (await db.execute(sql`
                select o.started_at, coalesce(o.actual_ended_at, o.ended_at) as fim,
                       o.scheduled_start_at, o.scheduled_end_at
                  from operations_v2.regulation_occupancies o
                  join operations_v2.regulation_posts p on p.id = o.post_id
                 where p.code = ${CHIEF_REGULATION_POST_CODE}
                   and o.doctor_id = ${String(c.medico_id)}::uuid
                   and o.board_started_at is not null
                   and o.started_at > now() - interval '7 days'
                 order by o.started_at desc
            `)) as unknown as Array<Record<string, unknown>>;
        }
        return NextResponse.json({
            ok: true,
            conta: {
                email: String(c.email),
                papeis: (c.papeis as string[]) ?? [],
                medico: c.medico_id ? { id: String(c.medico_id), nome: String(c.nome), nomeCompleto: String(c.nome_completo) } : null,
                chefias: chefias.map((r) => ({
                    inicio: iso(r.started_at),
                    fim: iso(r.fim),
                    programadoInicio: iso(r.scheduled_start_at),
                    programadoFim: iso(r.scheduled_end_at),
                })),
            },
        }, { headers: { "cache-control": "no-store" } });
    } catch (error) {
        console.error(`[relatorio-conta] ${error instanceof Error ? error.message : String(error)}`);
        return NextResponse.json({ error: "unavailable" }, { status: 500 });
    }
}

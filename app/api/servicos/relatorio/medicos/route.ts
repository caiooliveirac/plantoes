/* ==========================================================================
   GET /api/servicos/relatorio/medicos?q=…
   Busca de médico por nome para o relatório da chefia lançar quem deu o
   plantão numa base da rendição (o relatório conhece a escala, não os ids
   da Mesa). Só ativos, até 20, sem e-mail.

   Portão: x-escala-token (ESCALA_SSO_TOKEN), igual a /rendicao. Sem: 503.
   200 { ok, medicos: [{ id, nome, nomeCompleto }] }
   ========================================================================== */
import { timingSafeEqual } from "node:crypto";
import { sql } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";
import { getDb, hasDatabaseUrl } from "@/db";
import { normalizeDoctorName } from "@/modules/doctors/importer";

function tokenConfere(recebido: string | null, esperado: string): boolean {
    if (!recebido) return false;
    const a = Buffer.from(recebido, "utf8");
    const b = Buffer.from(esperado, "utf8");
    return a.length === b.length && timingSafeEqual(a, b);
}

export async function GET(request: NextRequest) {
    const esperado = process.env.ESCALA_SSO_TOKEN;
    if (!esperado) return NextResponse.json({ error: "integration_not_configured" }, { status: 503 });
    if (!tokenConfere(request.headers.get("x-escala-token"), esperado)) {
        return NextResponse.json({ error: "invalid_token" }, { status: 401 });
    }
    if (!hasDatabaseUrl()) return NextResponse.json({ error: "no_database" }, { status: 503 });

    const q = normalizeDoctorName((request.nextUrl.searchParams.get("q") ?? "").slice(0, 80));
    if (q.length < 2) return NextResponse.json({ error: "invalid_params" }, { status: 400 });
    const padrao = `%${q.split(/\s+/).join("%")}%`;

    try {
        const rows = (await getDb().execute(sql`
            select id, coalesce(nullif(trim(display_name), ''), full_name) as nome, full_name
              from operations_v2.doctors
             where is_active and (normalized_name ilike ${padrao} or display_name ilike ${padrao})
             order by full_name
             limit 20
        `)) as unknown as Array<{ id: string; nome: string; full_name: string }>;
        return NextResponse.json(
            { ok: true, medicos: rows.map((r) => ({ id: r.id, nome: r.nome, nomeCompleto: r.full_name })) },
            { headers: { "cache-control": "no-store" } },
        );
    } catch (error) {
        console.error(`[relatorio-medicos] ${error instanceof Error ? error.message : String(error)}`);
        return NextResponse.json({ error: "unavailable" }, { status: 500 });
    }
}

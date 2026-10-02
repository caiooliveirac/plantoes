/* ==========================================================================
   POST /api/servicos/relatorio/rendicao/saida
   O chefe de plantão lança, no relatório da chefia (relatorio.mnrs.com.br),
   a saída real de um médico da rendição (USA do plantão anterior). A saída
   vai para actual_ended_at pela mesma correção da tela de admin
   (correctInterventionOccupancy: auditoria em audit_logs, saída validada pela
   chefia, banco de horas recalculado) — ou seja, entra no histórico que
   alimenta pagamento e banco de horas.

   Portão: x-escala-token (ESCALA_SSO_TOKEN), igual a /rendicao. Sem: 503.
   Corpo: { occupancyId, saida (ISO), email (quem lança: chief|admin ativo),
            motivo?, confirmar? }
     confirmar ausente/false → só a prévia, nada é gravado.
     confirmar true          → grava e devolve o saldo já recalculado.
   200 { ok, gravado, medico, antes: { saida, saldoMin }, depois: { saida, saldoMin } }
   saldoMin = saldo do banco de horas do plantão (contínuo) em minutos.
   ========================================================================== */
import { timingSafeEqual } from "node:crypto";
import { sql } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { getDb, hasDatabaseUrl } from "@/db";
import { calculateBankHours } from "@/modules/bank-hours/calculator";
import { correctInterventionOccupancy } from "@/modules/operational/corrections";

function tokenConfere(recebido: string | null, esperado: string): boolean {
    if (!recebido) return false;
    const a = Buffer.from(recebido, "utf8");
    const b = Buffer.from(esperado, "utf8");
    return a.length === b.length && timingSafeEqual(a, b);
}

const corpoSchema = z.object({
    occupancyId: z.string().uuid(),
    saida: z.iso.datetime({ offset: true }),
    email: z.string().trim().toLowerCase().min(3).max(200),
    motivo: z.string().trim().max(500).optional(),
    confirmar: z.boolean().optional(),
});

const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : v ? new Date(String(v)).toISOString() : null);

type Banco = { scheduled_start_at: unknown; scheduled_end_at: unknown; actual_start_at: unknown; balance_minutes: number } | undefined;

/** Lançamento do banco do plantão contínuo (P = um lançamento só) desta ocupação. */
async function bancoDoGrupo(grupo: string): Promise<Banco> {
    const rows = (await getDb().execute(sql`
        select e.scheduled_start_at, e.scheduled_end_at, e.actual_start_at, e.balance_minutes
          from operations_v2.bank_hours_entries e
          join operations_v2.intervention_occupancies o on o.id = e.intervention_occupancy_id
         where o.continuity_group_id = ${grupo}::uuid
         order by e.actual_end_at desc
         limit 1
    `)) as unknown as Banco[];
    return rows[0];
}

export async function POST(request: NextRequest) {
    const esperado = process.env.ESCALA_SSO_TOKEN;
    if (!esperado) return NextResponse.json({ error: "integration_not_configured" }, { status: 503 });
    if (!tokenConfere(request.headers.get("x-escala-token"), esperado)) {
        return NextResponse.json({ error: "invalid_token" }, { status: 401 });
    }
    if (!hasDatabaseUrl()) return NextResponse.json({ error: "no_database" }, { status: 503 });

    const parsed = corpoSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: "invalid_params" }, { status: 400 });
    const { occupancyId, email, motivo, confirmar } = parsed.data;
    const saida = new Date(parsed.data.saida);

    try {
        const db = getDb();
        const [conta] = (await db.execute(sql`
            select u.id
              from operations_v2.users u
              join operations_v2.user_roles r on r.user_id = u.id
             where lower(u.email) = ${email} and u.is_active and r.role::text in ('chief', 'admin')
             limit 1
        `)) as unknown as Array<{ id: string }>;
        if (!conta) return NextResponse.json({ error: "forbidden", mensagem: "Só chefia ou admin da Mesa lança saída." }, { status: 403 });

        const [occ] = (await db.execute(sql`
            select o.id, o.continuity_group_id, o.started_at, o.ended_at, o.actual_ended_at,
                   o.scheduled_start_at, o.scheduled_end_at, o.arrival_delay_waived_at,
                   coalesce(nullif(trim(d.display_name), ''), d.full_name) as nome
              from operations_v2.intervention_occupancies o
              join operations_v2.doctors d on d.id = o.doctor_id
             where o.id = ${occupancyId}::uuid
        `)) as unknown as Array<Record<string, unknown>>;
        if (!occ) return NextResponse.json({ error: "not_found", mensagem: "Plantão não encontrado na Mesa." }, { status: 404 });
        if (!occ.ended_at) {
            return NextResponse.json({ error: "still_open", mensagem: "O plantão ainda está aberto na Mesa: encerre por lá." }, { status: 409 });
        }

        if (saida.getTime() < new Date(String(occ.started_at)).getTime()) {
            return NextResponse.json({ error: "rejected", mensagem: "A saída não pode ser antes da chegada." }, { status: 422 });
        }
        const fimPrevisto = occ.scheduled_end_at ? new Date(String(occ.scheduled_end_at)).getTime() : null;
        if (fimPrevisto !== null && Math.abs(saida.getTime() - fimPrevisto) > 24 * 3600e3) {
            return NextResponse.json({ error: "rejected", mensagem: "Saída a mais de 24 h do fim previsto: confira o dia." }, { status: 422 });
        }

        const grupo = String(occ.continuity_group_id);
        const bancoAntes = await bancoDoGrupo(grupo);
        const antes = { saida: iso(occ.actual_ended_at ?? occ.ended_at), saldoMin: bancoAntes?.balance_minutes ?? null };

        if (!confirmar) {
            const janela = {
                scheduledStartAt: (bancoAntes?.scheduled_start_at ?? occ.scheduled_start_at) as string,
                scheduledEndAt: (bancoAntes?.scheduled_end_at ?? occ.scheduled_end_at) as string,
                actualStartAt: (bancoAntes?.actual_start_at ?? occ.started_at) as string,
            };
            const previa = janela.scheduledStartAt && janela.scheduledEndAt
                ? calculateBankHours({ ...janela, actualEndAt: saida, arrivalDelayWaived: !!occ.arrival_delay_waived_at })
                : null;
            return NextResponse.json(
                { ok: true, gravado: false, medico: String(occ.nome), antes, depois: { saida: saida.toISOString(), saldoMin: previa?.balanceMinutes ?? null } },
                { headers: { "cache-control": "no-store" } },
            );
        }

        await correctInterventionOccupancy(
            occupancyId,
            {
                actualEndedAt: saida,
                chiefConfirmed: true,
                auditSource: "relatorio da chefia (rendicao)",
                auditReason: motivo || "Saída lançada pela chefia no relatório do plantão.",
            },
            conta.id,
        );
        const bancoDepois = await bancoDoGrupo(grupo);
        console.info(`[relatorio-rendicao-saida] ${occupancyId} ${antes.saida} -> ${saida.toISOString()} por ${conta.id}`);
        return NextResponse.json(
            { ok: true, gravado: true, medico: String(occ.nome), antes, depois: { saida: saida.toISOString(), saldoMin: bancoDepois?.balance_minutes ?? null } },
            { headers: { "cache-control": "no-store" } },
        );
    } catch (error) {
        const mensagem = error instanceof Error ? error.message : String(error);
        console.error(`[relatorio-rendicao-saida] ${mensagem}`);
        return NextResponse.json({ error: "unavailable", mensagem }, { status: 500 });
    }
}

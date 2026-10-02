/* ==========================================================================
   POST /api/servicos/relatorio/rendicao/plantao
   O chefe de plantão lança, pelo relatório da chefia, um médico que deu o
   plantão numa base da rendição sem ocupação na Mesa — inclusive base que
   estava desativada no turno (a desativação não bloqueia o lançamento).
   Mesmo caminho da tela /admin/lancar-plantao (createManualShift): plantão
   já cumprido, saída confirmada, banco de horas e auditoria de sempre — ou
   seja, entra no histórico que alimenta pagamento e banco de horas.

   Portão: x-escala-token (ESCALA_SSO_TOKEN). Sem: 503.
   Corpo: { email (chief|admin ativo), codigo (base), data (YYYY-MM-DD do
            início do turno), turno SD|SN, medicoId, chegada HH:MM, saida HH:MM,
            motivo?, confirmar? }
     confirmar ausente/false → prévia, nada grava.
     confirmar true          → grava; devolve occupancyId.
   200 { ok, gravado, occupancyId?, medico, codigo, chegada, saida,
         saldoPlantaoMin, saldoAntesMin, saldoDepoisMin, explicacao, sobreposicoes }
   ========================================================================== */
import { timingSafeEqual } from "node:crypto";
import { sql } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { getDb, hasDatabaseUrl } from "@/db";
import { auditLogs } from "@/db/schema";
import { createManualShift, previewManualShift, type ManualShiftInput } from "@/services/admin-manual-shift.service";

function tokenConfere(recebido: string | null, esperado: string): boolean {
    if (!recebido) return false;
    const a = Buffer.from(recebido, "utf8");
    const b = Buffer.from(esperado, "utf8");
    return a.length === b.length && timingSafeEqual(a, b);
}

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const corpoSchema = z.object({
    email: z.string().trim().toLowerCase().min(3).max(200),
    codigo: z.string().trim().min(1).max(32),
    data: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    turno: z.enum(["SD", "SN"]),
    medicoId: z.string().uuid(),
    chegada: z.string().regex(HHMM),
    saida: z.string().regex(HHMM),
    motivo: z.string().trim().max(500).optional(),
    confirmar: z.boolean().optional(),
});

export async function POST(request: NextRequest) {
    const esperado = process.env.ESCALA_SSO_TOKEN;
    if (!esperado) return NextResponse.json({ error: "integration_not_configured" }, { status: 503 });
    if (!tokenConfere(request.headers.get("x-escala-token"), esperado)) {
        return NextResponse.json({ error: "invalid_token" }, { status: 401 });
    }
    if (!hasDatabaseUrl()) return NextResponse.json({ error: "no_database" }, { status: 503 });

    const parsed = corpoSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: "invalid_params", mensagem: "Preencha médico, chegada e saída." }, { status: 400 });
    const b = parsed.data;

    const db = getDb();
    const [conta] = (await db.execute(sql`
        select u.id
          from operations_v2.users u
          join operations_v2.user_roles r on r.user_id = u.id
         where lower(u.email) = ${b.email} and u.is_active and r.role::text in ('chief', 'admin')
         limit 1
    `)) as unknown as Array<{ id: string }>;
    if (!conta) return NextResponse.json({ error: "forbidden", mensagem: "Só chefia ou admin da Mesa lança plantão." }, { status: 403 });

    const [base] = (await db.execute(sql`
        select id from operations_v2.intervention_bases where code = ${b.codigo.toUpperCase()} limit 1
    `)) as unknown as Array<{ id: number }>;
    if (!base) return NextResponse.json({ error: "not_found", mensagem: `Base ${b.codigo} não existe na Mesa.` }, { status: 404 });

    const input: ManualShiftInput = {
        doctorId: b.medicoId,
        domain: "intervention",
        targetId: Number(base.id),
        operationalDate: b.data,
        shiftLabel: b.turno,
        arrivalTime: b.chegada,
        departureTime: b.saida,
        isShadow: false,
        reason: b.motivo && b.motivo.length >= 8 ? b.motivo : "Lançado pela chefia no relatório do plantão (rendição).",
    };

    try {
        const [medico] = (await db.execute(sql`
            select coalesce(nullif(trim(display_name), ''), full_name) as nome from operations_v2.doctors where id = ${b.medicoId}::uuid and is_active
        `)) as unknown as Array<{ nome: string }>;
        if (!medico) return NextResponse.json({ error: "not_found", mensagem: "Médico não encontrado na Mesa." }, { status: 404 });

        const preview = await previewManualShift(input);
        const resposta = {
            ok: true,
            medico: medico.nome,
            codigo: preview.target.code,
            chegada: preview.startedAt,
            saida: preview.departureAt,
            programadoInicio: preview.scheduledStartAt,
            programadoFim: preview.scheduledEndAt,
            saldoPlantaoMin: preview.calculation.balanceMinutes,
            saldoAntesMin: preview.balanceBeforeMinutes,
            saldoDepoisMin: preview.balanceAfterMinutes,
            explicacao: preview.calculation.explanation,
            sobreposicoes: preview.overlaps.map((o) => ({ codigo: o.code, inicio: o.startedAt, fim: o.endsAt })),
        };
        if (!b.confirmar) return NextResponse.json({ ...resposta, gravado: false }, { headers: { "cache-control": "no-store" } });

        const result = await createManualShift(input, conta.id);
        await db.insert(auditLogs).values({
            actorUserId: conta.id,
            action: "admin.manual_shift.create",
            entityType: "intervention_occupancy",
            entityId: result.occupancyId,
            details: { ...input, source: "relatorio da chefia (rendicao)", bankEntry: result.bankEntry },
        });
        console.info(`[relatorio-rendicao-plantao] ${b.codigo} ${b.data} ${b.turno} ${b.chegada}-${b.saida} -> ${result.occupancyId} por ${conta.id}`);
        return NextResponse.json(
            { ...resposta, gravado: true, occupancyId: result.occupancyId, saldoPlantaoMin: result.bankEntry?.balanceMinutes ?? resposta.saldoPlantaoMin },
            { headers: { "cache-control": "no-store" } },
        );
    } catch (error) {
        // previewManualShift/createManualShift recusam com mensagem pronta (futuro, duplicado, base inativa)
        const mensagem = error instanceof Error ? error.message : String(error);
        console.error(`[relatorio-rendicao-plantao] ${mensagem}`);
        return NextResponse.json({ error: "rejected", mensagem }, { status: 422 });
    }
}

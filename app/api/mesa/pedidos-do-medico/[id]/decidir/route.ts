/**
 * A chefia decide um pedido do médico. Aceitar `continuar` cria a continuação
 * pelo mesmo caminho do bot (continue*Occupancy); recusar só marca.
 *
 * POST { decisao: "aceito"|"recusado", note? }
 *  200 { ok: true, pedido: { id, status, decidedAt, continuacao: null | { occupancyId, scheduledEndAt, shiftLabel } } }
 *  404 pedido_nao_encontrado · 409 pedido_ja_decidido | continuacao_falhou (motivo)
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { hasDatabaseUrl } from "@/db";
import { AuthError, requireMesaEscrita } from "@/lib/auth/server";
import { decidirPedido } from "@/services/medico-pedidos.service";
import { PresencaRecusada } from "@/services/medico-presenca.service";

const schema = z.object({
    decisao: z.enum(["aceito", "recusado"]),
    note: z.union([z.string().trim().max(2000), z.null()]).optional(),
});

export async function POST(request: NextRequest, context: RouteContext<"/api/mesa/pedidos-do-medico/[id]/decidir">) {
    if (!hasDatabaseUrl()) {
        return NextResponse.json({ error: "DATABASE_URL is not configured for operations-v2." }, { status: 503 });
    }

    let session;
    try {
        session = await requireMesaEscrita(["admin", "chief"]);
    } catch (error) {
        const status = error instanceof AuthError ? error.status : 500;
        return NextResponse.json({ error: error instanceof Error ? error.message : "Unauthorized." }, { status });
    }

    const parsed = schema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
        return NextResponse.json({ error: "payload_invalido" }, { status: 400 });
    }

    const { id } = await context.params;
    try {
        const pedido = await decidirPedido({ id, decisao: parsed.data.decisao, note: parsed.data.note ?? null, actorUserId: session.user.id });
        return NextResponse.json({ ok: true, pedido });
    } catch (error) {
        if (error instanceof PresencaRecusada) {
            return NextResponse.json(error.body, { status: error.status });
        }
        return NextResponse.json({ error: error instanceof Error ? error.message : "decisao_falhou" }, { status: 400 });
    }
}

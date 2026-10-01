/**
 * Pedidos pendentes dos médicos (hoje: continuar para o turno seguinte) para a
 * chefia decidir na Mesa. Leitura: admin/chief com sessão da Mesa.
 *
 * GET → 200 { pedidos: [{ id, kind, status, createdAt, medico: { id, nome }, turnoAtual,
 *               ocupacao: { domain, occupancyId, targetId, code, startedAt, shiftLabel } }] }
 */
import { NextResponse } from "next/server";
import { hasDatabaseUrl } from "@/db";
import { AuthError, requireMesaSession } from "@/lib/auth/server";
import { listarPedidosPendentes } from "@/services/medico-pedidos.service";

export async function GET() {
    if (!hasDatabaseUrl()) {
        return NextResponse.json({ error: "DATABASE_URL is not configured for operations-v2." }, { status: 503 });
    }

    try {
        await requireMesaSession(["admin", "chief"]);
    } catch (error) {
        const status = error instanceof AuthError ? error.status : 500;
        return NextResponse.json({ error: error instanceof Error ? error.message : "Unauthorized." }, { status });
    }

    try {
        return NextResponse.json({ pedidos: await listarPedidosPendentes() });
    } catch (error) {
        return NextResponse.json({ error: error instanceof Error ? error.message : "listagem_falhou" }, { status: 400 });
    }
}

/**
 * O médico em turno avisa pela web que vai PROLONGAR para o turno seguinte.
 * Não cria a continuação: grava um pedido pendente que admin/chief decide em
 * /api/mesa/pedidos-do-medico (services/medico-pedidos.service.ts).
 *
 * POST {}
 *  201 { ok: true, pedido: { id, kind: "continuar", status: "pendente", createdAt, ocupacao } }
 *  409 fora_de_turno | pedido_ja_pendente · 403 sem_medico_vinculado | sem_papel_medico
 */
import { NextResponse } from "next/server";
import { hasDatabaseUrl } from "@/db";
import { AuthError, requireAuthenticatedSession } from "@/lib/auth/server";
import { pedirContinuacao } from "@/services/medico-pedidos.service";
import { PresencaRecusada, medicoDaSessao } from "@/services/medico-presenca.service";

export async function POST() {
    if (!hasDatabaseUrl()) {
        return NextResponse.json({ error: "DATABASE_URL is not configured for operations-v2." }, { status: 503 });
    }

    let session;
    try {
        session = await requireAuthenticatedSession();
    } catch (error) {
        const status = error instanceof AuthError ? error.status : 500;
        return NextResponse.json({ error: error instanceof Error ? error.message : "Unauthorized." }, { status });
    }

    try {
        const medico = medicoDaSessao(session);
        const pedido = await pedirContinuacao({ medico });
        return NextResponse.json({ ok: true, pedido }, { status: 201 });
    } catch (error) {
        if (error instanceof PresencaRecusada) {
            return NextResponse.json(error.body, { status: error.status });
        }
        return NextResponse.json({ error: error instanceof Error ? error.message : "pedido_falhou" }, { status: 400 });
    }
}

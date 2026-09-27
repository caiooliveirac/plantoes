import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { hasDatabaseUrl } from "@/db";
import { AuthError, requireAuthenticatedSession } from "@/lib/auth/server";
import { AcaoDeAcessoError, encerrarSessaoPeloAdmin } from "@/services/acessos-acoes.service";

/* Monitor de acessos: o admin encerra UMA sessão (um aparelho). Motivo obrigatório. */
const ID_VALIDO = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const schema = z.object({ motivo: z.string().max(500) });

export async function POST(request: NextRequest, { params }: { params: Promise<{ sessionId: string }> }) {
    if (!hasDatabaseUrl()) {
        return NextResponse.json({ error: "Banco indisponível." }, { status: 503 });
    }
    try {
        const session = await requireAuthenticatedSession(["admin"]);
        const { sessionId } = await params;
        const parsed = schema.safeParse(await request.json().catch(() => null));
        if (!parsed.success || !ID_VALIDO.test(sessionId)) {
            return NextResponse.json({ error: "Pedido inválido." }, { status: 400 });
        }
        const resultado = await encerrarSessaoPeloAdmin(sessionId, session.user.id, parsed.data.motivo);
        return NextResponse.json({ ok: true, ...resultado });
    } catch (error) {
        if (error instanceof AuthError || error instanceof AcaoDeAcessoError) {
            return NextResponse.json({ error: error.message }, { status: error.status });
        }
        throw error;
    }
}

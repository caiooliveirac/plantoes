import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { hasDatabaseUrl } from "@/db";
import { AuthError, requireAuthenticatedSession } from "@/lib/auth/server";
import { AcaoDeAcessoError, agirNaConta } from "@/services/acessos-acoes.service";

/* Monitor de acessos: ação do admin sobre uma conta (encerrar sessões, exigir
   nova senha, suspender, reativar). Motivo obrigatório — vai para audit_logs. */
const ID_VALIDO = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const schema = z.object({
    acao: z.enum(["encerrar_sessoes", "exigir_nova_senha", "suspender", "reativar", "dar_radio_operador", "tirar_radio_operador"]),
    motivo: z.string().max(500),
});

export async function POST(request: NextRequest, { params }: { params: Promise<{ userId: string }> }) {
    if (!hasDatabaseUrl()) {
        return NextResponse.json({ error: "Banco indisponível." }, { status: 503 });
    }
    try {
        const session = await requireAuthenticatedSession(["admin"]);
        const { userId } = await params;
        const parsed = schema.safeParse(await request.json().catch(() => null));
        if (!parsed.success || !ID_VALIDO.test(userId)) {
            return NextResponse.json({ error: "Pedido inválido." }, { status: 400 });
        }
        const resultado = await agirNaConta(parsed.data.acao, userId, session.user.id, parsed.data.motivo);
        return NextResponse.json({ ok: true, ...resultado });
    } catch (error) {
        if (error instanceof AuthError || error instanceof AcaoDeAcessoError) {
            return NextResponse.json({ error: error.message }, { status: error.status });
        }
        throw error;
    }
}

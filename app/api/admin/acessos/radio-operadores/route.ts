import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { hasDatabaseUrl } from "@/db";
import { AuthError, requireAuthenticatedSession } from "@/lib/auth/server";
import { AcaoDeAcessoError, cadastrarRadioOperador } from "@/services/acessos-acoes.service";

/* Cadastro de rádio-operador pelo admin (modules/auth/contracts.ts,
   RADIO_OPERADOR_ROLE): cria a conta se não existir (e-mail para criar a
   senha) e dá o papel. Fica em audit_logs e na linha do tempo da conta. */
const schema = z.object({
    email: z.string().max(200),
    nome: z.string().max(160),
});

export async function POST(request: NextRequest) {
    if (!hasDatabaseUrl()) {
        return NextResponse.json({ error: "Banco indisponível." }, { status: 503 });
    }
    try {
        const session = await requireAuthenticatedSession(["admin"]);
        const parsed = schema.safeParse(await request.json().catch(() => null));
        if (!parsed.success) return NextResponse.json({ error: "Pedido inválido." }, { status: 400 });
        const resultado = await cadastrarRadioOperador(parsed.data, session.user.id);
        return NextResponse.json({ ok: true, ...resultado });
    } catch (error) {
        if (error instanceof AuthError || error instanceof AcaoDeAcessoError) {
            return NextResponse.json({ error: error.message }, { status: error.status });
        }
        throw error;
    }
}

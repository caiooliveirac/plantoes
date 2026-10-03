/* ==========================================================================
   POST /api/servicos/portal/trocar-senha — a senha definitiva escolhida no
   portal (mnrs.com.br), no primeiro acesso ou ao unificar com o Escalas.

   Quem chama é o porteiro, servidor↔servidor, com a senha atual que a pessoa
   acabou de digitar. Antes ele entrava em /api/auth/login e chamava
   change-password com o cookie de lá — o que não funciona para conta só do
   portal (papel `portal`), que o login do app recusa.

   Portão: x-escala-token (ESCALA_SSO_TOKEN), tempo constante; sem a variável,
   503. A senha atual é conferida no escopo "portal" e a nova passa pela
   política de sempre (changeOwnPassword).

     body  { email, currentPassword, nextPassword }
     200   { ok: true } · 400 { error } · 401 token ou senha atual
   ========================================================================== */
import { timingSafeEqual } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { hasDatabaseUrl } from "@/db";
import { authenticateWithPassword, changeOwnPassword } from "@/services/auth.service";

const schema = z.object({
    email: z.string().email(),
    currentPassword: z.string().min(1),
    nextPassword: z.string().min(10).max(128),
});

function tokenConfere(recebido: string | null, esperado: string): boolean {
    if (!recebido) return false;
    const a = Buffer.from(recebido, "utf8");
    const b = Buffer.from(esperado, "utf8");
    return a.length === b.length && timingSafeEqual(a, b);
}

export async function POST(request: NextRequest) {
    const esperado = process.env.ESCALA_SSO_TOKEN;
    if (!esperado) {
        return NextResponse.json({ error: "integration_not_configured" }, { status: 503 });
    }
    if (!tokenConfere(request.headers.get("x-escala-token"), esperado)) {
        return NextResponse.json({ error: "invalid_token" }, { status: 401 });
    }
    if (!hasDatabaseUrl()) {
        return NextResponse.json({ error: "DATABASE_URL is not configured for operations-v2." }, { status: 503 });
    }
    const parsed = schema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
        return NextResponse.json({ error: "Senha atual e nova senha valida sao obrigatorias." }, { status: 400 });
    }
    const conta = await authenticateWithPassword(parsed.data.email, parsed.data.currentPassword, { escopo: "portal" });
    if (conta.status !== "success") {
        return NextResponse.json({ error: conta.status }, { status: 401 });
    }
    try {
        await changeOwnPassword(conta.user.id, parsed.data.currentPassword, parsed.data.nextPassword);
        console.log(`[portal-trocar-senha] ${new Date().toISOString()} ok ${JSON.stringify({ email: conta.user.email })}`);
        return NextResponse.json({ ok: true });
    } catch (error) {
        return NextResponse.json(
            { error: error instanceof Error ? error.message : "Nao foi possivel atualizar a senha." },
            { status: 400 },
        );
    }
}

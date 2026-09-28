/* ==========================================================================
   POST /api/servicos/contas-escala — conta de operador da Central aprovada no
   Escalas (TARM, rádio-operador e quem coordena essas categorias).

   Quem chama é o servidor do Escalas, na aprovação do cadastro, nunca o
   navegador. Mesmo portão do verificar-escala: x-escala-token
   (ESCALA_SSO_TOKEN), tempo constante; sem a variável, 503.

     body  { email, nome, senhaTemporaria, papeis: ("tarm" | "radio_operador")[] }
     200   { ok, situacao: "criada" | "existente", ... }
     400   pedido inválido ou senha temporária fraca · 401 token · 503 desligada

   Conta nova: papel `portal` + os papéis, senha temporária, troca obrigatória
   (o portal pede a definitiva no primeiro acesso). Conta existente: só ganha
   os papéis que faltam — a senha nunca é tocada. Regras em
   services/portal-accounts.service.ts (provisionarContaDoEscala).
   ========================================================================== */
import { timingSafeEqual } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { hasDatabaseUrl } from "@/db";
import { ContaDoEscalaError, provisionarContaDoEscala } from "@/services/portal-accounts.service";

const schema = z.object({
    email: z.string().email().max(200),
    nome: z.string().trim().min(2).max(160),
    senhaTemporaria: z.string().min(10).max(128),
    papeis: z.array(z.enum(["tarm", "radio_operador"])).min(1).max(2),
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
        console.error("[contas-escala] ESCALA_SSO_TOKEN ausente no ambiente — rota desligada.");
        return NextResponse.json({ error: "integration_not_configured" }, { status: 503 });
    }
    if (!tokenConfere(request.headers.get("x-escala-token"), esperado)) {
        return NextResponse.json({ error: "invalid_token" }, { status: 401 });
    }
    if (!hasDatabaseUrl()) {
        return NextResponse.json({ error: "DATABASE_URL is not configured for operations-v2." }, { status: 503 });
    }
    const parsed = schema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: "invalid_request" }, { status: 400 });
    try {
        const resultado = await provisionarContaDoEscala(parsed.data);
        console.log(`[contas-escala] ${new Date().toISOString()} ${resultado.situacao} ${JSON.stringify({ email: parsed.data.email.trim().toLowerCase(), papeis: parsed.data.papeis })}`);
        return NextResponse.json({ ok: true, ...resultado });
    } catch (error) {
        if (error instanceof ContaDoEscalaError) return NextResponse.json({ error: error.message }, { status: 400 });
        throw error;
    }
}

/* ==========================================================================
   POST /api/servicos/contas-portal — conta de portal para quem não é médico.

   Quem chama é o servidor de outro app (hoje o Huddle), nunca o navegador.
   Contrato (os outros repos estão escritos contra estes nomes):

     header  x-portal-token: <PORTAL_CONTAS_TOKEN>
     body    { email, nome (2..160), origem (2..40, ex. "huddle"), consultar? }

     200 { ok, situacao: "existente", ativa, acessoPortal }  conta já existe — nada muda
     200 { ok, situacao: "inexistente" }                     consultar: true, sem conta
     200 { ok, situacao: "criada", emailEnviado }            conta nova com papel `portal`
     401 { error: "invalid_token" }   503 { error: "integration_not_configured" }

   FALHA FECHADA: sem PORTAL_CONTAS_TOKEN (vazio ou "CHANGE_ME") a rota
   responde 503 e não cria nada. Regras e motivo em
   services/portal-accounts.service.ts; portão e schema em
   modules/auth/contas-portal.ts.
   ========================================================================== */

import { NextRequest, NextResponse } from "next/server";
import { hasDatabaseUrl } from "@/db";
import {
    CONTAS_PORTAL_MAX_BYTES,
    contasPortalSchema,
    tokenDeContasPortal,
    tokenDeContasPortalConfere,
} from "@/modules/auth/contas-portal";
import { provisionarContaPortal } from "@/services/portal-accounts.service";

export async function POST(request: NextRequest) {
    const esperado = tokenDeContasPortal();
    if (!esperado) {
        console.error("[contas-portal] PORTAL_CONTAS_TOKEN ausente no ambiente — rota desligada.");
        return NextResponse.json({ error: "integration_not_configured" }, { status: 503 });
    }
    if (!tokenDeContasPortalConfere(request.headers.get("x-portal-token"), esperado)) {
        return NextResponse.json({ error: "invalid_token" }, { status: 401 });
    }
    if (!hasDatabaseUrl()) {
        return NextResponse.json({ error: "DATABASE_URL is not configured for operations-v2." }, { status: 503 });
    }

    const declarado = Number(request.headers.get("content-length") ?? "0");
    if (declarado > CONTAS_PORTAL_MAX_BYTES) {
        return NextResponse.json({ error: "payload_too_large" }, { status: 413 });
    }
    const bruto = await request.text().catch(() => "");
    if (Buffer.byteLength(bruto, "utf8") > CONTAS_PORTAL_MAX_BYTES) {
        return NextResponse.json({ error: "payload_too_large" }, { status: 413 });
    }
    let corpo: unknown = null;
    try {
        corpo = JSON.parse(bruto);
    } catch {
        corpo = null;
    }
    const parsed = contasPortalSchema.safeParse(corpo);
    if (!parsed.success) {
        return NextResponse.json(
            { error: "invalid_payload", campos: [...new Set(parsed.error.issues.map((issue) => String(issue.path[0] ?? "")))] },
            { status: 400 },
        );
    }

    try {
        const resultado = await provisionarContaPortal(parsed.data);
        console.log(
            `[contas-portal] ${new Date().toISOString()} ${resultado.situacao} ${JSON.stringify({
                email: parsed.data.email,
                origem: parsed.data.origem,
                ...(resultado.situacao === "criada" ? { emailEnviado: resultado.emailEnviado } : {}),
            })}`,
        );
        return NextResponse.json(resultado);
    } catch (error) {
        console.error("[contas-portal] falha ao provisionar", error);
        return NextResponse.json({ error: "internal_error" }, { status: 500 });
    }
}

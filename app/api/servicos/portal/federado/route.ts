/* ==========================================================================
   POST /api/servicos/portal/federado — quem é este usuário do GOA?

   Quem chama: o porteiro do mnrs.com.br (mnrs-portal, GET /de/goa), servidor↔
   servidor, DEPOIS de conferir a assinatura do handoff que o SkyRescue
   emitiu (docs/internos-goa.md). Portão: o mesmo token de serviço do
   verificar-escala (ESCALA_SSO_TOKEN no header x-escala-token, tempo
   constante). Sem a variável: 503, falha fechada.

     body  { provedor: "goa", sujeito: "<users.id do GOA>", login, nome? }

     200 { ok, criada, userId, email, nome, normalizedName: null, roles,
           mustChangePassword: false, sessionVersion }   ← formato do verificar-escala
     403 { error: "inactive_account" | "papel_nao_permitido" }
     409 { error: "email_em_uso" }   400 { error: "login_invalido" | "invalid_payload" }

   Só sai conta que é SÓ `interno` (modules/auth/internos-goa.ts): o GOA não
   tem como virar médico, chefia ou admin daqui. Cada resposta vira evento no
   monitor de acessos com o IP/aparelho que o porteiro repassa.
   ========================================================================== */
import { NextRequest, NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { hasDatabaseUrl } from "@/db";
import { lerContextoRequisicao } from "@/lib/acessos/contexto";
import { depoisDaResposta } from "@/lib/acessos/depois";
import { federadoSchema } from "@/modules/auth/internos-goa";
import { registrarEvento } from "@/services/acessos.service";
import { resolverInternoDoGoa } from "@/services/internos-goa.service";

function tokenConfere(recebido: string | null, esperado: string): boolean {
    if (!recebido) return false;
    const a = Buffer.from(recebido, "utf8");
    const b = Buffer.from(esperado, "utf8");
    return a.length === b.length && timingSafeEqual(a, b);
}

const STATUS_DA_RECUSA = { inactive_account: 403, papel_nao_permitido: 403, email_em_uso: 409, login_invalido: 400 } as const;

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
    const parsed = federadoSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
        return NextResponse.json({ error: "invalid_payload" }, { status: 400 });
    }

    const pedido = parsed.data;
    const resultado = await resolverInternoDoGoa(pedido);
    const contexto = lerContextoRequisicao(request.headers);
    const quem = { provedor: pedido.provedor, sujeito: pedido.sujeito, login: pedido.login };

    if (!resultado.ok) {
        console.log(`[federado] ${new Date().toISOString()} recusado ${JSON.stringify({ ...quem, motivo: resultado.motivo })}`);
        if (resultado.userId) {
            const userId = resultado.userId;
            depoisDaResposta(() => registrarEvento({ tipo: "goa_recusado", userId, contexto, detalhes: { ...quem, motivo: resultado.motivo } }));
        }
        return NextResponse.json({ error: resultado.motivo }, { status: STATUS_DA_RECUSA[resultado.motivo] });
    }

    console.log(`[federado] ${new Date().toISOString()} ok ${JSON.stringify({ ...quem, email: resultado.email, criada: resultado.criada })}`);
    const userId = resultado.userId;
    depoisDaResposta(() => registrarEvento({ tipo: "goa_entrou", userId, contexto, detalhes: { ...quem, criada: resultado.criada } }));
    return NextResponse.json({
        ok: true,
        criada: resultado.criada,
        userId: resultado.userId,
        email: resultado.email,
        doctorId: null,
        nome: resultado.nome,
        normalizedName: null,
        roles: resultado.roles,
        mustChangePassword: false,
        sessionVersion: resultado.sessionVersion,
    });
}

/* ==========================================================================
   Sessão do portal: vale? — e registro do uso no monitor de acessos.

   Quem chama: o porteiro do mnrs.com.br (kairos deploy/porteiro), servidor↔
   servidor em 127.0.0.1, antes de deixar passar Tabela e Triagem (nginx
   auth_request → /_auth/portao) e ao abrir o portal. No máximo uma vez por
   minuto por sessão × IP (o porteiro guarda a resposta), mais cada ação
   (POST/PATCH/DELETE) na hora.

   Portão: o mesmo token de serviço do verificar-escala (ESCALA_SSO_TOKEN no
   header x-escala-token, tempo constante). Sem a variável: 503, falha fechada
   — e o porteiro, sem resposta, deixa a sessão passar (não derruba a Tabela
   quando o Plantões reinicia).

   Recusa: conta inexistente, suspensa, sem papel, ou `sv` do cookie diferente
   de users.session_version (troca de senha, "encerrar sessões"). O porteiro
   trata a recusa como "sem sessão": manda ao login do portal.

   Registro (docs/monitor-acessos.md): o login do portal vira uma sessão de
   origem `portal_cookie` com o `sid` que o porteiro gravou no cookie; o IP,
   aparelho e localização vêm dos cabeçalhos do visitante que o porteiro
   repassa. Caminho sem query string (a Tabela manda endereço de ocorrência
   em ?local=).
   ========================================================================== */
import { NextRequest, NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { hasDatabaseUrl } from "@/db";
import { lerContextoRequisicao } from "@/lib/acessos/contexto";
import { depoisDaResposta } from "@/lib/acessos/depois";
import { registrarAcesso, registrarEvento } from "@/services/acessos.service";
import { conferirSessaoDoPortal } from "@/services/acessos-portal.service";

const schema = z.object({
    email: z.string().email(),
    sid: z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i),
    sv: z.number().int().min(0).nullable().optional(),
    pedidos: z.number().int().min(1).max(100_000).optional(),
    sistema: z.string().regex(/^[a-z0-9-]{1,32}$/).optional(),
    metodo: z.string().regex(/^[A-Z]{3,7}$/).nullable().optional(),
    caminho: z.string().max(300).nullable().optional(),
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
        return NextResponse.json({ error: "invalid_payload" }, { status: 400 });
    }

    const { email, sid, sv, pedidos, sistema, metodo, caminho } = parsed.data;
    const conferencia = await conferirSessaoDoPortal(email, sv);
    const contexto = {
        ...lerContextoRequisicao(request.headers),
        metodo: metodo ?? "GET",
        caminho: caminho ? caminho.split("?")[0].split("#")[0] : null,
        rsc: false,
        prefetch: false,
        usoMesa: null,
    };

    if (conferencia.ok && conferencia.userId) {
        const userId = conferencia.userId;
        depoisDaResposta(() => registrarAcesso({
            sessaoId: sid,
            userId,
            versao: sv ?? 0,
            contexto,
            pedidos,
            origemSeNova: "portal_cookie",
            sistema,
        }));
    } else if (conferencia.userId) {
        const userId = conferencia.userId;
        depoisDaResposta(() => registrarEvento({
            tipo: "portal_recusado",
            userId,
            contexto,
            detalhes: { motivo: conferencia.motivo, ...(sistema ? { sistema } : {}) },
        }));
    }
    return NextResponse.json({ ok: conferencia.ok, ...(conferencia.motivo ? { motivo: conferencia.motivo } : {}) });
}

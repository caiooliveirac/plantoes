import { NextResponse, type NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { getDb, hasDatabaseUrl } from "@/db";
import { userRoles, users } from "@/db/schema";
import { temAcessoAoPlantoes } from "@/modules/auth/contracts";
import { lerContextoRequisicao } from "@/lib/acessos/contexto";
import { depoisDaResposta } from "@/lib/acessos/depois";
import { writeSessionCookie } from "@/lib/auth/server";
import { federacaoConfigurada, ID_PLANTOES, lerTokenHandoff } from "@/lib/auth/federacao";
import { destinoInterno } from "@/lib/auth/destino-interno";
import { destinoSemSessao } from "@/lib/auth/portao";
import { registrarEvento } from "@/services/acessos.service";

/* Troca de serviço — lado do DESTINO (quem vem do escala entra aqui).

   GET /api/auth/sso?token=…: valida o handoff (60 s, aud = "plantoes") e
   procura a conta ATIVA com aquele e-mail que tenha algum papel do app
   (`portal` não conta — modules/auth/contracts.ts). Existindo,
   emite a sessão daqui sem senha: a identidade já foi autenticada pelo
   escala. Sem conta = sem acesso, com a frase na tela — quem decide quem
   opera aqui é a chefia, criando/liberando a conta como sempre.

   Versão da sessão (`sv`): o porteiro do portal manda a session_version de
   quando conferiu a senha. Diferente da atual = o login do portal é de antes
   de uma troca de senha ou de "encerrar sessões" (monitor de acessos): recusa
   e manda ao portal, que pede a senha de novo (a trava de laço de lá mostra o
   formulário). Handoff sem `sv` (escala, porteiro antigo) segue valendo. */

function base(req: NextRequest): string {
    return (process.env.AUTH_URL?.trim() || req.url).replace(/\/+$/, "");
}

export async function GET(req: NextRequest) {
    if (!federacaoConfigurada()) return NextResponse.json({ error: "federation_not_configured" }, { status: 404 });
    if (!hasDatabaseUrl()) return NextResponse.json({ error: "DATABASE_URL is not configured." }, { status: 503 });

    const token = req.nextUrl.searchParams.get("token") ?? "";
    const handoff = token ? lerTokenHandoff(token) : null;
    if (!handoff) return NextResponse.redirect(new URL("/?sso=token-invalido", base(req)));

    const db = getDb();
    const [user] = await db
        .select({ id: users.id, isActive: users.isActive, sessionVersion: users.sessionVersion })
        .from(users)
        .where(eq(users.email, handoff.email))
        .limit(1);
    const roles = user
        ? (await db.select({ role: userRoles.role }).from(userRoles).where(eq(userRoles.userId, user.id))).map((r) => r.role)
        : [];
    // Conta só com o papel `portal` (entra no mnrs.com.br, não aqui) = sem acesso.
    if (!user || !user.isActive || !temAcessoAoPlantoes(roles)) {
        console.log(`[sso-escala] ${new Date().toISOString()} sem_acesso ${JSON.stringify({ email: handoff.email, origem: handoff.origem })}`);
        return NextResponse.redirect(new URL("/?sso=sem-acesso", base(req)));
    }

    const contexto = lerContextoRequisicao(req.headers);
    if (handoff.sv !== undefined && handoff.sv !== user.sessionVersion) {
        console.log(`[sso-escala] ${new Date().toISOString()} versao_antiga ${JSON.stringify({ email: handoff.email, origem: handoff.origem })}`);
        depoisDaResposta(() => registrarEvento({
            tipo: "sso_recusado",
            userId: user.id,
            contexto,
            detalhes: { motivo: "login do portal anterior à troca de senha ou ao encerramento das sessões", origem: handoff.origem },
        }));
        const destino = destinoSemSessao();
        return NextResponse.redirect(destino.startsWith("http") ? destino : new URL(destino, base(req)));
    }

    // origem "plantoes" = porteiro do portal (a senha foi conferida aqui); "samu-salvador" = app do escala.
    const origem = handoff.origem === ID_PLANTOES ? "portal" : "escala";
    await writeSessionCookie(user.id, { origem, detalhes: { handoffOrigem: handoff.origem } });
    console.log(`[sso-escala] ${new Date().toISOString()} ok ${JSON.stringify({ email: handoff.email, origem: handoff.origem })}`);
    // ?proximo=: o portal mnrs.com.br leva direto a /medico, /medico/folha-ponto…
    return NextResponse.redirect(new URL(destinoInterno(req.nextUrl.searchParams.get("proximo")), base(req)));
}

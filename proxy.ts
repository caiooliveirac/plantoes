import { NextResponse, type NextRequest } from "next/server";
import { CABECALHO_ROTA } from "@/lib/acessos/contexto";
import { criarCookieAparelho, lerCookieAparelho, nomeCookieAparelho, opcoesCookieAparelho } from "@/lib/auth/aparelho";
import { mutacaoDeOutroSite } from "@/lib/auth/origem";
import { createSessionToken, sessionIdOf, verifySessionToken } from "@/lib/auth/token";
import { SESSION_COOKIE_NAME, SESSION_RENEW_AFTER_MS, SESSION_TTL_MS } from "@/lib/auth/server";

/* Renovação deslizante da sessão: cookie válido emitido há mais de um dia sai
   daqui reemitido com 30 dias a partir de agora (lib/auth/server.ts). É o que
   faz "30 dias" valer 30 dias desde o último uso, não desde o login. Só em
   navegação de página: em /api a resposta é JSON e o cookie de página chega
   logo em seguida de qualquer jeito. Sem AUTH_SECRET (build, teste) não faz
   nada — o portão de verdade continua sendo cada rota.

   Monitor de acessos: repassa "MÉTODO /caminho" no cabeçalho x-plantoes-rota
   (Server Component não sabe a própria rota; o portão registra o pedido). O
   valor é sempre sobrescrito aqui — o do cliente nunca passa. A renovação
   mantém o `sid` da sessão; cookie de antes do monitor ganha o id derivado
   dele (lib/auth/token.ts), o mesmo que o portão já usava para ele.

   CSRF: POST/PUT/PATCH/DELETE em /api vindo de outro site (inclusive
   subdomínio irmão de mnrs.com.br) morre aqui com 403 (lib/auth/origem.ts).

   Aparelho (lib/auth/aparelho.ts, docs/presenca-mesa.md): pedido sem cookie
   de aparelho válido ganha um. Vai na resposta e também no próprio pedido,
   para a página que está sendo montada já enxergar o aparelho. */
export function proxy(request: NextRequest) {
    if (request.nextUrl.pathname.startsWith("/api/") && mutacaoDeOutroSite(request.method, request.headers)) {
        return NextResponse.json({ error: "Pedido de outro site recusado." }, { status: 403 });
    }
    const requestHeaders = new Headers(request.headers);
    requestHeaders.set(CABECALHO_ROTA, `${request.method} ${request.nextUrl.pathname}`);
    const secret = process.env.AUTH_SECRET;
    const nomeAparelho = nomeCookieAparelho();
    let aparelhoNovo: string | null = null;
    if (secret && !lerCookieAparelho(request.cookies.get(nomeAparelho)?.value, secret)) {
        aparelhoNovo = criarCookieAparelho(secret);
        const outros = (request.headers.get("cookie") ?? "")
            .split(";")
            .map((parte) => parte.trim())
            .filter((parte) => parte && !parte.startsWith(`${nomeAparelho}=`));
        requestHeaders.set("cookie", [...outros, `${nomeAparelho}=${aparelhoNovo}`].join("; "));
    }
    const res = NextResponse.next({ request: { headers: requestHeaders } });
    if (aparelhoNovo) res.cookies.set(nomeAparelho, aparelhoNovo, opcoesCookieAparelho());
    if (request.nextUrl.pathname.startsWith("/api/")) return res;
    const raw = request.cookies.get(SESSION_COOKIE_NAME)?.value;
    if (!secret || !raw) return res;
    const parsed = verifySessionToken(raw, secret);
    if (!parsed) return res;
    const emitidoEm = parsed.iat ?? parsed.exp - SESSION_TTL_MS;
    if (Date.now() - emitidoEm < SESSION_RENEW_AFTER_MS) return res;
    // Renovação nunca passa do corte da virada (lib/auth/corte-virada.ts).
    const tetoRenovado = Date.now() + SESSION_TTL_MS;
    const expiresAt = new Date(typeof parsed.cv === "number" ? Math.min(tetoRenovado, parsed.cv) : tetoRenovado);
    const token = createSessionToken({ sub: parsed.sub, exp: expiresAt.getTime(), sv: parsed.sv ?? 0, sid: sessionIdOf(parsed, raw), iat: parsed.iat, ...(typeof parsed.cv === "number" ? { cv: parsed.cv } : {}) }, secret);
    res.cookies.set(SESSION_COOKIE_NAME, token, {
        httpOnly: true,
        sameSite: "lax",
        secure: process.env.NODE_ENV === "production",
        path: "/",
        expires: expiresAt,
    });
    return res;
}

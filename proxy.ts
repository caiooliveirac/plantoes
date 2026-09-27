import { NextResponse, type NextRequest } from "next/server";
import { CABECALHO_ROTA } from "@/lib/acessos/contexto";
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
   dele (lib/auth/token.ts), o mesmo que o portão já usava para ele. */
export function proxy(request: NextRequest) {
    const requestHeaders = new Headers(request.headers);
    requestHeaders.set(CABECALHO_ROTA, `${request.method} ${request.nextUrl.pathname}`);
    const res = NextResponse.next({ request: { headers: requestHeaders } });
    if (request.nextUrl.pathname.startsWith("/api/")) return res;
    const secret = process.env.AUTH_SECRET;
    const raw = request.cookies.get(SESSION_COOKIE_NAME)?.value;
    if (!secret || !raw) return res;
    const parsed = verifySessionToken(raw, secret);
    if (!parsed) return res;
    const emitidoEm = parsed.exp - SESSION_TTL_MS;
    if (Date.now() - emitidoEm < SESSION_RENEW_AFTER_MS) return res;
    const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
    const token = createSessionToken({ sub: parsed.sub, exp: expiresAt.getTime(), sv: parsed.sv ?? 0, sid: sessionIdOf(parsed, raw) }, secret);
    res.cookies.set(SESSION_COOKIE_NAME, token, {
        httpOnly: true,
        sameSite: "lax",
        secure: process.env.NODE_ENV === "production",
        path: "/",
        expires: expiresAt,
    });
    return res;
}

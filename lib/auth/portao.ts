/**
 * Portão do quadro operacional: quem não tem sessão não vê `/` nem as rotas que
 * entregam o quadro (/api/board, /api/board/stream, passagem de ocorrências).
 *
 * Sem sessão, a pessoa vai ao login único do portal (kairos ADR 0013):
 * mnrs.com.br/?proximo=plantoes → porteiro assina um handoff de 60 s →
 * /api/auth/sso grava o cookie daqui → volta para `/` já logada. Fora de
 * produção não há porteiro, então o destino é o login local (/entrar), que
 * também é a porta de emergência se o porteiro cair.
 *
 * O portão mora em cada página e rota (readAuthenticatedSession /
 * requireSessionForRead), nunca no proxy.ts: o proxy só renova o cookie e não
 * toca o banco — conta inativa ou sem papel passaria por ele (AUTH_PLAN.md).
 */
export const PORTAL_LOGIN_URL = "https://mnrs.com.br/?proximo=plantoes";

export function destinoSemSessao(env: Record<string, string | undefined> = process.env): string {
    const configurado = env.PORTAL_LOGIN_URL?.trim();
    if (configurado) return configurado;
    return env.NODE_ENV === "production" ? PORTAL_LOGIN_URL : "/entrar";
}

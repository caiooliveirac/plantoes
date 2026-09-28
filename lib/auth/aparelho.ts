import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";

/* Identidade do aparelho (docs/presenca-mesa.md): um id por navegador, num
   cookie próprio, HttpOnly e assinado com AUTH_SECRET — script da página não
   lê, e id inventado não vale. É o que separa "duas abas do mesmo computador"
   (mesmo aparelho, dividem a Mesa) de "outro aparelho da mesma conta" (espera a
   vez). Quem recebe só a senha entra de outro navegador: outro aparelho.

   Não é prova criptográfica: quem copia os cookies de um navegador leva o
   aparelho junto. Sobrevive ao "Sair" e à troca de conta — num PC da Central o
   aparelho é o mesmo para todos os médicos que o usam.

   Em produção o nome leva `__Host-`: o navegador só aceita esse cookie vindo
   do próprio host, com Secure e sem Domain — subdomínio irmão de mnrs.com.br
   não consegue plantar um aparelho aqui. */
export const COOKIE_APARELHO_MAX_AGE_S = 400 * 24 * 60 * 60; // teto do Chrome

export function nomeCookieAparelho(env: Record<string, string | undefined> = process.env) {
    return env.NODE_ENV === "production" ? "__Host-plantoes_aparelho" : "plantoes_aparelho";
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function assinar(id: string, secret: string) {
    return createHmac("sha256", secret).update(`aparelho:${id}`).digest("base64url");
}

export function criarCookieAparelho(secret: string, id: string = randomUUID()) {
    return `${id}.${assinar(id, secret)}`;
}

/** Id do aparelho se o cookie é legítimo; senão null. */
export function lerCookieAparelho(valor: string | undefined | null, secret: string): string | null {
    if (!valor) return null;
    const [id, assinatura] = valor.split(".");
    if (!id || !assinatura || !UUID.test(id)) return null;
    const esperada = Buffer.from(assinar(id, secret));
    const recebida = Buffer.from(assinatura);
    if (esperada.length !== recebida.length || !timingSafeEqual(esperada, recebida)) return null;
    return id;
}

export function opcoesCookieAparelho() {
    return {
        httpOnly: true,
        sameSite: "lax" as const,
        secure: process.env.NODE_ENV === "production",
        path: "/",
        maxAge: COOKIE_APARELHO_MAX_AGE_S,
    };
}

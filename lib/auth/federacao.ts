/* ==========================================================================
   Federação com o Escalas & Trocas — "um clique entre os apps".

   O médico já está logado aqui; abrir a escala não deveria pedir e-mail e
   senha de novo. O escala já faz isso entre as instalações dele (SAMU ⇄ UPA)
   com um JWT de 60 s assinado por chave compartilhada:

     origem   GET /api/auth/handoff?para=<id>       (exige sessão)
              → 302 <urlDestino>/api/auth/sso?token=<jwt>
     destino  valida assinatura, `aud` = ele mesmo, `exp`; emite a sessão local.

   Este arquivo é a nossa ponta do mesmo contrato. Sem `jose` no projeto, o
   JWT HS256 é assinado à mão com node:crypto — o formato é o padrão
   (header.payload.assinatura em base64url), então o escala lê com o jose dele.

   Claims: { tipo: "escala-handoff", origem, sub: e-mail, aud, iat, exp,
             nome?, normalizedName? }. `normalizedName` é o que o /sso do
   escala usa para achar o profissional do médico — mesma junção por nome do
   login por senha (verificar-escala).

   Ligado só com as duas variáveis:
     ESCALA_FEDERACAO_URL     = https://escala.mnrs.com.br
     ESCALA_FEDERACAO_SECRET  = o AUTH_SECRET do escala (chave da federação lá)
   Sem elas nada aparece na tela e as rotas respondem 404.
   ========================================================================== */

import { createHmac, timingSafeEqual } from "node:crypto";

export const ID_PLANTOES = "plantoes";
export const ID_ESCALA = "samu-salvador";
const TIPO = "escala-handoff";
const VALIDADE_SEGUNDOS = 60;

export function federacaoConfigurada(): boolean {
    return Boolean(escalaUrl() && process.env.ESCALA_FEDERACAO_SECRET?.trim());
}

export function escalaUrl(): string {
    return (process.env.ESCALA_FEDERACAO_URL ?? "").trim().replace(/\/+$/, "");
}

function segredo(): string {
    const s = process.env.ESCALA_FEDERACAO_SECRET?.trim();
    if (!s) throw new Error("ESCALA_FEDERACAO_SECRET ausente — federação com o escala desligada.");
    return s;
}

const b64url = (v: string | Buffer) => Buffer.from(v).toString("base64url");
const deB64url = (v: string) => Buffer.from(v, "base64url").toString("utf8");

export interface HandoffClaims {
    email: string;
    origem: string;
    nome?: string;
    normalizedName?: string;
}

/** Token que ESTA origem emite para `para`. `agora` em segundos, injetável. */
export function criarTokenHandoff(
    claims: HandoffClaims,
    para: string,
    chave: string = segredo(),
    agora: number = Math.floor(Date.now() / 1000),
): string {
    const corpo: Record<string, unknown> = {
        tipo: TIPO,
        origem: claims.origem,
        sub: claims.email,
        aud: para,
        iat: agora,
        exp: agora + VALIDADE_SEGUNDOS,
    };
    if (claims.nome) corpo.nome = claims.nome;
    if (claims.normalizedName) corpo.normalizedName = claims.normalizedName;
    const cabecalho = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
    const payload = b64url(JSON.stringify(corpo));
    const assinatura = createHmac("sha256", chave).update(`${cabecalho}.${payload}`).digest("base64url");
    return `${cabecalho}.${payload}.${assinatura}`;
}

/** Valida um token RECEBIDO: assinatura, `exp`, tipo e `aud` = `meuId`.
    Qualquer coisa fora disso é null — a rota decide o que dizer. */
export function lerTokenHandoff(
    token: string,
    meuId: string = ID_PLANTOES,
    chave: string = segredo(),
    agora: number = Math.floor(Date.now() / 1000),
): HandoffClaims | null {
    const partes = token.split(".");
    if (partes.length !== 3) return null;
    const [cabecalho, payload, assinatura] = partes;
    const esperada = createHmac("sha256", chave).update(`${cabecalho}.${payload}`).digest("base64url");
    const a = Buffer.from(assinatura, "utf8");
    const b = Buffer.from(esperada, "utf8");
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
    try {
        const cab = JSON.parse(deB64url(cabecalho)) as { alg?: string };
        if (cab.alg !== "HS256") return null;
        const c = JSON.parse(deB64url(payload)) as Record<string, unknown>;
        if (c.tipo !== TIPO || c.aud !== meuId) return null;
        if (typeof c.exp !== "number" || c.exp <= agora) return null;
        if (typeof c.sub !== "string" || !c.sub.includes("@")) return null;
        return {
            email: c.sub.trim().toLowerCase(),
            origem: typeof c.origem === "string" ? c.origem : "?",
            nome: typeof c.nome === "string" ? c.nome : undefined,
            normalizedName: typeof c.normalizedName === "string" ? c.normalizedName : undefined,
        };
    } catch {
        return null;
    }
}

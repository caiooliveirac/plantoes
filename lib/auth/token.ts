import { createHash, createHmac, timingSafeEqual } from "node:crypto";

/* `typ` separa o token de sessão do token da folha-ponto (lib/folha-ponto/token.ts),
   que usa o mesmo AUTH_SECRET. `sv` é a versão da sessão do usuário
   (users.session_version): troca/reset de senha incrementa e derruba os cookies
   emitidos antes. Os dois são opcionais na leitura porque o cookie emitido antes
   deles não os tem — vale como sv=0, que é o default da coluna.
   `sid` é o id da sessão no monitor de acessos (operations_v2.auth_sessions,
   docs/monitor-acessos.md): um por login, sobrevive à renovação diária do
   proxy.ts. Cookie de antes do monitor não tem — ganha um id derivado dele
   mesmo (legacySessionId), estável até a próxima renovação gravar o `sid`. */
export const SESSION_TOKEN_TYPE = "session";

export interface SessionTokenPayload {
    typ?: typeof SESSION_TOKEN_TYPE;
    sub: string;
    exp: number;
    sv?: number;
    sid?: string;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Id de sessão para cookie sem `sid`: hash do próprio token, no formato uuid
    (a coluna é uuid). Determinístico — duas abas com o mesmo cookie caem na
    mesma sessão — e impossível de escolher, porque o token é assinado. */
export function legacySessionId(rawToken: string) {
    const hex = createHash("sha256").update(`sessao-anterior:${rawToken}`).digest("hex");
    // uuid versão 8 (RFC 9562, "definido pela aplicação"): nibble de versão 8, variante 10xx.
    const variante = ((parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-${variante}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/** Id da sessão do cookie: o `sid` gravado nele, ou o derivado do token antigo. */
export function sessionIdOf(payload: Pick<SessionTokenPayload, "sid">, rawToken: string) {
    return payload.sid ?? legacySessionId(rawToken);
}

function encodeBase64Url(value: string) {
    return Buffer.from(value, "utf8").toString("base64url");
}

function decodeBase64Url(value: string) {
    return Buffer.from(value, "base64url").toString("utf8");
}

function sign(payload: string, secret: string) {
    return createHmac("sha256", secret).update(payload).digest("base64url");
}

export function createSessionToken(payload: Omit<SessionTokenPayload, "typ">, secret: string) {
    const serialized = JSON.stringify({ typ: SESSION_TOKEN_TYPE, ...payload });
    const encodedPayload = encodeBase64Url(serialized);
    const signature = sign(encodedPayload, secret);
    return `${encodedPayload}.${signature}`;
}

export function verifySessionToken(token: string, secret: string, now = Date.now()) {
    const [encodedPayload, signature] = token.split(".");
    if (!encodedPayload || !signature) {
        return null;
    }

    const expectedSignature = sign(encodedPayload, secret);
    const signatureBuffer = Buffer.from(signature, "utf8");
    const expectedBuffer = Buffer.from(expectedSignature, "utf8");

    if (signatureBuffer.length !== expectedBuffer.length) {
        return null;
    }

    if (!timingSafeEqual(signatureBuffer, expectedBuffer)) {
        return null;
    }

    try {
        const parsed = JSON.parse(decodeBase64Url(encodedPayload)) as SessionTokenPayload;
        if (!parsed?.sub || typeof parsed.exp !== "number") {
            return null;
        }

        if (parsed.typ !== undefined && parsed.typ !== SESSION_TOKEN_TYPE) {
            return null;
        }

        if (parsed.sv !== undefined && !Number.isInteger(parsed.sv)) {
            return null;
        }

        if (parsed.sid !== undefined && (typeof parsed.sid !== "string" || !UUID_PATTERN.test(parsed.sid))) {
            return null;
        }

        if (parsed.exp <= now) {
            return null;
        }

        return parsed;
    } catch {
        return null;
    }
}

/** O cookie só vale enquanto a versão dele for a do banco. Sem `sv` = 0. */
export function isSessionVersionCurrent(payload: Pick<SessionTokenPayload, "sv">, currentVersion: number) {
    return (payload.sv ?? 0) === currentVersion;
}

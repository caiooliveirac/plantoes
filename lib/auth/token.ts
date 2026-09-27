import { createHmac, timingSafeEqual } from "node:crypto";

/* `typ` separa o token de sessão do token da folha-ponto (lib/folha-ponto/token.ts),
   que usa o mesmo AUTH_SECRET. `sv` é a versão da sessão do usuário
   (users.session_version): troca/reset de senha incrementa e derruba os cookies
   emitidos antes. Os dois são opcionais na leitura porque o cookie emitido antes
   deles não os tem — vale como sv=0, que é o default da coluna. */
export const SESSION_TOKEN_TYPE = "session";

export interface SessionTokenPayload {
    typ?: typeof SESSION_TOKEN_TYPE;
    sub: string;
    exp: number;
    sv?: number;
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

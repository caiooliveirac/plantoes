import { createHmac, timingSafeEqual } from "node:crypto";

// Token assinado que dá acesso de leitura à folha de ponto de UM médico/mês via link
// (enviado ao médico no privado do bot). Mesmo molde de lib/auth/token.ts: payload
// base64url + HMAC-SHA256 (segredo = AUTH_SECRET) + expiração, comparado com
// timingSafeEqual.

export const FOLHA_TOKEN_DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface FolhaTokenPayload {
    medicoId: string;
    ano: number;
    mes: number;
    exp: number;
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

function getSecret() {
    const secret = process.env.AUTH_SECRET?.trim();
    if (!secret) {
        throw new Error("AUTH_SECRET is required to sign folha-ponto tokens.");
    }
    return secret;
}

export function signFolhaToken(payload: FolhaTokenPayload) {
    const encodedPayload = encodeBase64Url(JSON.stringify(payload));
    return `${encodedPayload}.${sign(encodedPayload, getSecret())}`;
}

export function createFolhaToken(params: { medicoId: string; ano: number; mes: number }, ttlMs = FOLHA_TOKEN_DEFAULT_TTL_MS, now = Date.now()) {
    return signFolhaToken({ ...params, exp: now + ttlMs });
}

export function verifyFolhaToken(token: string, now = Date.now()): FolhaTokenPayload | null {
    const [encodedPayload, signature] = token.split(".");
    if (!encodedPayload || !signature) {
        return null;
    }

    const expected = sign(encodedPayload, getSecret());
    const signatureBuffer = Buffer.from(signature, "utf8");
    const expectedBuffer = Buffer.from(expected, "utf8");
    if (signatureBuffer.length !== expectedBuffer.length || !timingSafeEqual(signatureBuffer, expectedBuffer)) {
        return null;
    }

    try {
        const parsed = JSON.parse(decodeBase64Url(encodedPayload)) as FolhaTokenPayload;
        if (!parsed?.medicoId || typeof parsed.ano !== "number" || typeof parsed.mes !== "number" || typeof parsed.exp !== "number") {
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

// True quando o token é válido E corresponde exatamente ao médico/ano/mês pedidos.
export function isValidFolhaToken(token: string | undefined | null, params: { medicoId: string; ano: number; mes: number }, now = Date.now()) {
    if (!token) {
        return false;
    }
    const payload = verifyFolhaToken(token, now);
    return Boolean(payload && payload.medicoId === params.medicoId && payload.ano === params.ano && payload.mes === params.mes);
}

import { createHmac, timingSafeEqual } from "node:crypto";

export interface SessionTokenPayload {
    sub: string;
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

export function createSessionToken(payload: SessionTokenPayload, secret: string) {
    const serialized = JSON.stringify(payload);
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

        if (parsed.exp <= now) {
            return null;
        }

        return parsed;
    } catch {
        return null;
    }
}
import test from "node:test";
import assert from "node:assert/strict";
import { createSessionToken, verifySessionToken } from "@/lib/auth/token";

const secret = "test-secret";

test("accepts a valid signed session token", () => {
    const token = createSessionToken({ sub: "user-1", exp: Date.now() + 60_000 }, secret);
    const payload = verifySessionToken(token, secret);

    assert.ok(payload);
    assert.equal(payload?.sub, "user-1");
});

test("rejects tampered session tokens", () => {
    const token = createSessionToken({ sub: "user-1", exp: Date.now() + 60_000 }, secret);
    const [encodedPayload, signature] = token.split(".");
    const tamperedPayload = `${encodedPayload.slice(0, -1)}${encodedPayload.slice(-1) === "A" ? "B" : "A"}`;
    const tampered = `${tamperedPayload}.${signature}`;
    const parsed = verifySessionToken(tampered, secret);

    assert.equal(parsed, null);
});

test("rejects expired session tokens", () => {
    const token = createSessionToken({ sub: "user-1", exp: Date.now() - 1_000 }, secret);
    const payload = verifySessionToken(token, secret);

    assert.equal(payload, null);
});
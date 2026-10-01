import test from "node:test";
import assert from "node:assert/strict";
import { proximaVirada, proximoCorte } from "@/lib/auth/corte-virada";
import { createSessionToken, verifySessionToken } from "@/lib/auth/token";

// Fuso operacional UTC-3: 07:00 local = 10:00Z; 19:00 local = 22:00Z.
const z = (iso: string) => new Date(iso);

test("corte da virada: login antes da virada cai 15 min depois dela", () => {
    assert.equal(proximoCorte(z("2026-10-01T09:50:00Z")).toISOString(), "2026-10-01T10:15:00.000Z"); // 06:50 → 07:15
    assert.equal(proximoCorte(z("2026-10-01T21:59:00Z")).toISOString(), "2026-10-01T22:15:00.000Z"); // 18:59 → 19:15
});

test("corte da virada: login depois da virada vive até o corte seguinte", () => {
    assert.equal(proximoCorte(z("2026-10-01T10:00:00Z")).toISOString(), "2026-10-01T22:15:00.000Z"); // 07:00 → 19:15
    assert.equal(proximoCorte(z("2026-10-01T10:10:00Z")).toISOString(), "2026-10-01T22:15:00.000Z"); // 07:10 → 19:15
    assert.equal(proximoCorte(z("2026-10-01T22:00:00Z")).toISOString(), "2026-10-02T10:15:00.000Z"); // 19:00 → 07:15 dia seguinte
    assert.equal(proximoCorte(z("2026-10-02T02:30:00Z")).toISOString(), "2026-10-02T10:15:00.000Z"); // 23:30 → 07:15
    assert.equal(proximaVirada(z("2026-10-01T22:00:00Z")).toISOString(), "2026-10-02T10:00:00.000Z");
});

test("token com cv cai no corte mesmo com exp maior; sem cv (admin) segue", () => {
    const secret = "segredo-de-teste";
    const agora = Date.UTC(2026, 9, 1, 12, 0, 0);
    const comCorte = createSessionToken({ sub: "u1", exp: agora + 30 * 86_400_000, cv: agora + 60_000, iat: agora }, secret);
    assert.ok(verifySessionToken(comCorte, secret, agora));
    assert.equal(verifySessionToken(comCorte, secret, agora + 60_000), null);
    const semCorte = createSessionToken({ sub: "u2", exp: agora + 30 * 86_400_000, iat: agora }, secret);
    assert.ok(verifySessionToken(semCorte, secret, agora + 86_400_000));
});

test("cookie de antes do corte (sem iat nem cv) cai no corte seguinte à última renovação", async () => {
    const { corteDoCookieAntigo } = await import("@/lib/auth/corte-virada");
    const TTL = 30 * 24 * 3_600_000;
    // Renovado às 09:00 de 01/10 (Bahia, UTC−3): cai às 19:15 do mesmo dia.
    const renovadoEm = Date.parse("2026-10-01T12:00:00Z");
    assert.equal(corteDoCookieAntigo({ exp: renovadoEm + TTL }, TTL)?.toISOString(), "2026-10-01T22:15:00.000Z");
    // Cookie novo não entra: com cv, o próprio token corta; com iat e sem cv é admin.
    assert.equal(corteDoCookieAntigo({ exp: renovadoEm + TTL, iat: renovadoEm }, TTL), null);
    assert.equal(corteDoCookieAntigo({ exp: renovadoEm + TTL, cv: renovadoEm + 3_600_000 }, TTL), null);
});

import assert from "node:assert/strict";
import test from "node:test";

process.env.AUTH_SECRET = process.env.AUTH_SECRET || "test-secret-for-signup";

import {
    buildSignupCodeEmail,
    generateSignupCode,
    hashSignupCode,
    normalizeSignupEmail,
} from "@/modules/auth/doctor-signup";
import { getRequestIp, isSignupRateLimited } from "@/modules/auth/signup-rate-limit";

test("generateSignupCode devolve sempre 6 dígitos (zeros à esquerda inclusos)", () => {
    for (let i = 0; i < 200; i++) {
        const code = generateSignupCode();
        assert.match(code, /^\d{6}$/);
    }
});

test("hashSignupCode amarra o código ao email (normalizado)", () => {
    const a = hashSignupCode("123456", "Medico@Gmail.com ");
    const b = hashSignupCode("123456", "medico@gmail.com");
    const outroEmail = hashSignupCode("123456", "outro@gmail.com");
    const outroCodigo = hashSignupCode("654321", "medico@gmail.com");
    assert.equal(a, b);
    assert.notEqual(a, outroEmail);
    assert.notEqual(a, outroCodigo);
});

test("normalizeSignupEmail baixa caixa e apara espaços", () => {
    assert.equal(normalizeSignupEmail("  Fulano@Exemplo.COM "), "fulano@exemplo.com");
});

test("buildSignupCodeEmail inclui código e validade", () => {
    const email = buildSignupCodeEmail({ code: "042137", fullName: "Ana Souza" });
    assert.ok(email.subject.includes("042137"));
    assert.ok(email.text.includes("042137"));
    assert.ok(email.text.includes("Ana Souza"));
    assert.ok(email.text.includes("15 minutos"));
});

test("isSignupRateLimited bloqueia a 11ª tentativa na janela e libera em janela nova", () => {
    const now = Date.now();
    for (let i = 0; i < 10; i++) {
        assert.equal(isSignupRateLimited("10.0.0.1", now), false, `tentativa ${i + 1} devia passar`);
    }
    assert.equal(isSignupRateLimited("10.0.0.1", now), true);
    // Outro IP não é afetado.
    assert.equal(isSignupRateLimited("10.0.0.2", now), false);
    // Janela nova (15min depois) zera a contagem.
    assert.equal(isSignupRateLimited("10.0.0.1", now + 15 * 60 * 1000), false);
});

test("getRequestIp usa o primeiro x-forwarded-for", () => {
    assert.equal(getRequestIp(new Headers({ "x-forwarded-for": "1.2.3.4, 10.0.0.1" })), "1.2.3.4");
    assert.equal(getRequestIp(new Headers()), "unknown");
});

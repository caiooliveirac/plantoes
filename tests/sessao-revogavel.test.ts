import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createSessionToken, isSessionVersionCurrent, verifySessionToken } from "@/lib/auth/token";
import { createFolhaToken, verifyFolhaToken } from "@/lib/folha-ponto/token";
import {
    clearLoginFailures,
    getLoginClientIp,
    isLoginRateLimited,
    loginRateLimitKeys,
    registerLoginFailure,
} from "@/modules/auth/login-rate-limit";

const secret = "test-secret";
process.env.AUTH_SECRET = secret;

// Assina um payload arbitrário no formato dos dois tokens (base64url + HMAC).
function signRaw(payload: object) {
    const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
    return `${encoded}.${createHmac("sha256", secret).update(encoded).digest("base64url")}`;
}

function decode(token: string) {
    return JSON.parse(Buffer.from(token.split(".")[0], "base64url").toString("utf8"));
}

// ── Sessão: versão ──────────────────────────────────────────────────────────

test("token de sessão novo leva typ e sv", () => {
    const token = createSessionToken({ sub: "user-1", exp: Date.now() + 60_000, sv: 3 }, secret);
    assert.deepEqual({ typ: decode(token).typ, sv: decode(token).sv }, { typ: "session", sv: 3 });
    const parsed = verifySessionToken(token, secret);
    assert.ok(parsed);
    assert.equal(isSessionVersionCurrent(parsed, 3), true);
    assert.equal(isSessionVersionCurrent(parsed, 4), false, "senha trocada depois da emissão derruba o cookie");
});

test("cookie antigo sem typ/sv continua valendo como sv=0 (deploy não desloga)", () => {
    const legacy = signRaw({ sub: "user-1", exp: Date.now() + 60_000 });
    const parsed = verifySessionToken(legacy, secret);
    assert.ok(parsed);
    assert.equal(isSessionVersionCurrent(parsed, 0), true);
    assert.equal(isSessionVersionCurrent(parsed, 1), false);
});

test("sv não inteiro é recusado", () => {
    assert.equal(verifySessionToken(signRaw({ sub: "u", exp: Date.now() + 60_000, sv: "0" }), secret), null);
});

// ── typ: sessão x folha-ponto ───────────────────────────────────────────────

test("verify de sessão recusa payload com typ de folha", () => {
    const token = signRaw({ typ: "folha", sub: "user-1", exp: Date.now() + 60_000 });
    assert.equal(verifySessionToken(token, secret), null);
});

test("token de folha novo leva typ=folha e é recusado como sessão", () => {
    const token = createFolhaToken({ medicoId: "m-1", ano: 2026, mes: 9 });
    assert.equal(decode(token).typ, "folha");
    assert.ok(verifyFolhaToken(token));
    assert.equal(verifySessionToken(token, secret), null);
});

test("verify de folha recusa typ de sessão e aceita link antigo sem typ", () => {
    const exp = Date.now() + 60_000;
    assert.equal(verifyFolhaToken(signRaw({ typ: "session", medicoId: "m-1", ano: 2026, mes: 9, exp })), null);
    assert.ok(verifyFolhaToken(signRaw({ medicoId: "m-1", ano: 2026, mes: 9, exp })), "link de folha já emitido (≤7 dias) segue abrindo");
    const sessao = createSessionToken({ sub: "user-1", exp, sv: 0 }, secret);
    assert.equal(verifyFolhaToken(sessao), null);
});

// ── Rate limit do login ─────────────────────────────────────────────────────

test("10 falhas do mesmo e-mail bloqueiam o e-mail, de qualquer IP", () => {
    const now = 1_000_000;
    for (let i = 0; i < 10; i += 1) {
        assert.equal(isLoginRateLimited(loginRateLimitKeys(`10.0.0.${i}`, "alvo@x.com"), now), false);
        registerLoginFailure(loginRateLimitKeys(`10.0.0.${i}`, "alvo@x.com"), now);
    }
    assert.equal(isLoginRateLimited(loginRateLimitKeys("10.9.9.9", " ALVO@x.com "), now), true);
    assert.equal(isLoginRateLimited(loginRateLimitKeys("10.9.9.9", "outro@x.com"), now), false);
    // Janela de 15 min vence e libera.
    assert.equal(isLoginRateLimited(loginRateLimitKeys("10.9.9.9", "alvo@x.com"), now + 15 * 60 * 1000), false);
});

test("10 falhas do mesmo IP bloqueiam o IP para qualquer e-mail", () => {
    const now = 2_000_000;
    for (let i = 0; i < 10; i += 1) registerLoginFailure(loginRateLimitKeys("203.0.113.7", `u${i}@x.com`), now);
    assert.equal(isLoginRateLimited(loginRateLimitKeys("203.0.113.7", "novo@x.com"), now + 1000), true);
    assert.equal(isLoginRateLimited(loginRateLimitKeys("203.0.113.8", "novo@x.com"), now + 1000), false);
});

test("login certo limpa a contagem do e-mail", () => {
    const now = 3_000_000;
    for (let i = 0; i < 10; i += 1) registerLoginFailure(loginRateLimitKeys(null, "esqueci@x.com"), now);
    assert.equal(isLoginRateLimited(loginRateLimitKeys(null, "esqueci@x.com"), now), true);
    clearLoginFailures("esqueci@x.com");
    assert.equal(isLoginRateLimited(loginRateLimitKeys(null, "esqueci@x.com"), now), false);
});

test("IP do login vem de cf-connecting-ip/x-real-ip, nunca de x-forwarded-for", () => {
    assert.equal(getLoginClientIp(new Headers({ "cf-connecting-ip": "1.1.1.1", "x-real-ip": "2.2.2.2" })), "1.1.1.1");
    assert.equal(getLoginClientIp(new Headers({ "x-real-ip": "2.2.2.2" })), "2.2.2.2");
    assert.equal(getLoginClientIp(new Headers({ "x-forwarded-for": "3.3.3.3" })), null);
    assert.deepEqual(loginRateLimitKeys(null, "a@x.com"), ["email:a@x.com"], "sem IP, só a chave do e-mail");
});

// ── Guardas de código ───────────────────────────────────────────────────────

function collectTs(dir: string, out: string[] = []) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) collectTs(full, out);
        else if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) out.push(full);
    }
    return out;
}

test("todo update de users que grava senha também sobe session_version", () => {
    const root = process.cwd();
    const files = ["app", "services", "modules", "lib", "scripts"].flatMap((dir) => collectTs(join(root, dir)));
    let achados = 0;
    for (const file of files) {
        const source = readFileSync(file, "utf8");
        for (const match of source.matchAll(/\.update\(users\)\s*\.set\(\{([\s\S]*?)\}\)/g)) {
            if (!/passwordHash/.test(match[1])) continue;
            achados += 1;
            assert.match(match[1], /sessionVersion: sql`\$\{users\.sessionVersion\} \+ 1`/, `${file.slice(root.length + 1)} grava senha sem derrubar as sessões antigas`);
        }
    }
    // eram 6 até 29/09/2026; as duas do fluxo de chefia saíram com a tela "Acesso de chefia"
    assert.ok(achados >= 5, `esperava ao menos 5 gravações de senha, achei ${achados}`);
});

test("sessão confere a versão e a troca de senha reemite o cookie deste aparelho", () => {
    const server = readFileSync(join(process.cwd(), "lib/auth/server.ts"), "utf8");
    assert.match(server, /isSessionVersionCurrent\(token, user\.sessionVersion\)/);
    const proxy = readFileSync(join(process.cwd(), "proxy.ts"), "utf8");
    assert.match(proxy, /sv: parsed\.sv \?\? 0/, "renovação do proxy preserva o sv");
    const changePassword = readFileSync(join(process.cwd(), "app/api/auth/change-password/route.ts"), "utf8");
    assert.match(changePassword, /changeOwnPassword[\s\S]*writeSessionCookie\(session\.user\.id[,)]/);
});

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NextRequest } from "next/server";
import {
    PLANTOES_ROLES,
    USER_ROLES,
    rolesDoPlantoes,
    temAcessoAoPlantoes,
} from "@/modules/auth/contracts";
import {
    contasPortalSchema,
    tokenDeContasPortal,
    tokenDeContasPortalConfere,
} from "@/modules/auth/contas-portal";
import { buildPortalWelcomeEmail } from "@/services/portal-accounts.service";
import { POST } from "@/app/api/servicos/contas-portal/route";

/**
 * Conta de portal (papel `portal`): entra no mnrs.com.br pelo verificar-escala,
 * nunca no app Plantões. Aqui a parte pura — papéis, portão e schema da rota
 * de criação, texto do e-mail. O comportamento com banco está em
 * tests/contas-portal-db.test.ts.
 */

function withEnv(env: Record<string, string | undefined>, fn: () => Promise<void> | void) {
    const saved: Record<string, string | undefined> = {};
    for (const key of Object.keys(env)) {
        saved[key] = process.env[key];
        if (env[key] === undefined) delete process.env[key];
        else process.env[key] = env[key];
    }
    const restore = () => {
        for (const [key, value] of Object.entries(saved)) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
    };
    return Promise.resolve().then(fn).finally(restore);
}

// ── Papéis ──────────────────────────────────────────────────────────────────

test("papel portal existe no contrato e fica fora dos papéis do app", () => {
    assert.ok(USER_ROLES.includes("portal"));
    assert.ok(!(PLANTOES_ROLES as readonly string[]).includes("portal"));
    assert.deepEqual([...PLANTOES_ROLES].sort(), ["admin", "chief", "doctor", "payment_closing_limited", "radio_operador"]);
});

test("rádio-operador abre o Plantões mesmo com a conta nascida como portal", () => {
    assert.equal(temAcessoAoPlantoes(["portal", "radio_operador"]), true);
    assert.deepEqual(rolesDoPlantoes(["portal", "radio_operador"]), ["radio_operador"]);
});

test("só portal = sem acesso ao Plantões; portal junto de outro papel não tira nada", () => {
    assert.equal(temAcessoAoPlantoes([]), false);
    assert.equal(temAcessoAoPlantoes(["portal"]), false);
    assert.equal(temAcessoAoPlantoes(["portal", "doctor"]), true);
    assert.deepEqual(rolesDoPlantoes(["portal", "chief", "papel_desconhecido"]), ["chief"]);
});

test("schema do banco tem o mesmo enum do contrato e a migration acrescenta portal", () => {
    const schema = readFileSync(join(process.cwd(), "db/schema.ts"), "utf8");
    const enumMatch = schema.match(/userRoleEnum = operationsV2\.enum\("user_role", \[([^\]]*)\]\)/);
    assert.ok(enumMatch);
    assert.deepEqual(enumMatch[1].split(",").map((v) => v.trim().replace(/"/g, "")), [...USER_ROLES]);
    const migration = readFileSync(join(process.cwd(), "db/migrations/0045_portal_role.sql"), "utf8");
    assert.match(migration, /alter type operations_v2\.user_role\s+add value if not exists 'portal'/);
});

test("pontos de decisão de acesso do app filtram o papel portal", () => {
    const root = process.cwd();
    const server = readFileSync(join(root, "lib/auth/server.ts"), "utf8");
    assert.match(server, /rolesDoPlantoes\(/, "loadUserSession precisa descartar portal");
    const sso = readFileSync(join(root, "app/api/auth/sso/route.ts"), "utf8");
    assert.match(sso, /temAcessoAoPlantoes\(roles\)/);
    const login = readFileSync(join(root, "app/api/auth/login/route.ts"), "utf8");
    assert.doesNotMatch(login, /escopo:\s*"portal"/, "login do app nunca usa o escopo do portal");
    const verificar = readFileSync(join(root, "app/api/auth/verificar-escala/route.ts"), "utf8");
    assert.match(verificar, /escopo:\s*"portal"/);
});

// ── Portão ──────────────────────────────────────────────────────────────────

test("PORTAL_CONTAS_TOKEN ausente, vazio ou CHANGE_ME = desligado", () => {
    assert.equal(tokenDeContasPortal({}), null);
    assert.equal(tokenDeContasPortal({ PORTAL_CONTAS_TOKEN: "  " }), null);
    assert.equal(tokenDeContasPortal({ PORTAL_CONTAS_TOKEN: "CHANGE_ME" }), null);
    assert.equal(tokenDeContasPortal({ PORTAL_CONTAS_TOKEN: " segredo " }), "segredo");
});

test("token confere só idêntico", () => {
    assert.equal(tokenDeContasPortalConfere("segredo", "segredo"), true);
    for (const recebido of [null, "", "segred", "segredo2", "SEGREDO"]) {
        assert.equal(tokenDeContasPortalConfere(recebido, "segredo"), false, String(recebido));
    }
});

function pedido(body: string, token?: string) {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (token !== undefined) headers["x-portal-token"] = token;
    return new NextRequest("http://localhost/api/servicos/contas-portal", { method: "POST", headers, body });
}

const corpoValido = JSON.stringify({ email: "a@b.com", nome: "Fulana", origem: "huddle" });

test("rota: sem token no ambiente → 503 integration_not_configured", () =>
    withEnv({ PORTAL_CONTAS_TOKEN: undefined }, async () => {
        for (const valor of [undefined, "", "CHANGE_ME"]) {
            process.env.PORTAL_CONTAS_TOKEN = valor ?? "";
            const response = await POST(pedido(corpoValido, "CHANGE_ME"));
            assert.equal(response.status, 503);
            assert.deepEqual(await response.json(), { error: "integration_not_configured" });
        }
    }));

test("rota: token errado ou ausente → 401 invalid_token", () =>
    withEnv({ PORTAL_CONTAS_TOKEN: "segredo-do-portal" }, async () => {
        for (const header of [undefined, "", "segredo", "segredo-do-portal-x"]) {
            const response = await POST(pedido(corpoValido, header));
            assert.equal(response.status, 401, `header=${JSON.stringify(header)}`);
            assert.deepEqual(await response.json(), { error: "invalid_token" });
        }
    }));

test("rota: corpo inválido ou grande demais não chega ao banco", () =>
    withEnv({ PORTAL_CONTAS_TOKEN: "segredo-do-portal", DATABASE_URL: "postgres://nao-usado@127.0.0.1:1/nada" }, async () => {
        const invalido = await POST(pedido("não é json", "segredo-do-portal"));
        assert.equal(invalido.status, 400);
        const grande = await POST(pedido(JSON.stringify({ email: "a@b.com", nome: "x".repeat(5000), origem: "huddle" }), "segredo-do-portal"));
        assert.equal(grande.status, 413);
    }));

// ── Schema ──────────────────────────────────────────────────────────────────

test("schema: e-mail aparado e em minúsculas; campos estritos", () => {
    const ok = contasPortalSchema.parse({ email: "  Fulana@Hospital.COM ", nome: " Fulana de Tal ", origem: "huddle", consultar: true });
    assert.deepEqual(ok, { email: "fulana@hospital.com", nome: "Fulana de Tal", origem: "huddle", consultar: true });
    assert.equal(contasPortalSchema.safeParse({ email: "a@b.com", nome: "Fu", origem: "huddle" }).success, true);

    const recusados: unknown[] = [
        { email: "nao-e-email", nome: "Fulana", origem: "huddle" },
        { email: "a@b.com", nome: "F", origem: "huddle" },
        { email: "a@b.com", nome: "x".repeat(161), origem: "huddle" },
        { email: "a@b.com", nome: "Fulana\nBcc: x@y.z", origem: "huddle" },
        { email: "a@b.com", nome: "Fulana", origem: "h" },
        { email: "a@b.com", nome: "Fulana", origem: "x".repeat(41) },
        { email: "a@b.com", nome: "Fulana", origem: "hud<script>" },
        { email: "a@b.com", nome: "Fulana", origem: "huddle", consultar: "sim" },
        { email: "a@b.com", nome: "Fulana", origem: "huddle", role: "admin" },
        { nome: "Fulana", origem: "huddle" },
    ];
    for (const corpo of recusados) {
        assert.equal(contasPortalSchema.safeParse(corpo).success, false, JSON.stringify(corpo));
    }
});

// ── E-mail de boas-vindas ───────────────────────────────────────────────────

test("boas-vindas: assunto, quem criou, link, prazo e onde entrar", () => {
    const mail = buildPortalWelcomeEmail({
        nome: "Fulana de Tal",
        origem: "huddle",
        email: "fulana@hospital.com",
        link: "https://plantoes.mnrs.com.br/redefinir-senha/abc123",
    });
    assert.equal(mail.subject, "Seu acesso ao portal mnrs.com.br");
    assert.match(mail.text, /Olá, Fulana de Tal!/);
    assert.match(mail.text, /administração do Huddle criou um acesso/);
    assert.match(mail.text, /https:\/\/plantoes\.mnrs\.com\.br\/redefinir-senha\/abc123/);
    assert.match(mail.text, /7 dias/);
    assert.match(mail.text, /entre em https:\/\/mnrs\.com\.br com este e-mail \(fulana@hospital\.com\)/);
});

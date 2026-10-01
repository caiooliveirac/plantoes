import test, { after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq, inArray, like } from "drizzle-orm";
import { NextRequest } from "next/server";

/**
 * Conta de portal e motivo da recusa do verificar-escala — contra um Postgres
 * de verdade, com as migrations aplicadas.
 *
 * SÓ roda quando DATABASE_URL aponta para um banco cujo nome termina em
 * `_test` (o CI usa plantoes_test, com `npm run db:migrate` antes). Em
 * qualquer outro banco — em especial o de produção, `plantoes` — o arquivo
 * inteiro é pulado sem abrir conexão. Cada teste cria contas com e-mail
 * aleatório (@portal-teste.invalid) e apaga tudo no fim.
 */

function bancoDeTeste(): string | null {
    const raw = process.env.DATABASE_URL;
    if (!raw) return null;
    try {
        const nome = new URL(raw).pathname.replace(/^\//, "");
        return /_test$/.test(nome) ? nome : null;
    } catch {
        return null;
    }
}

const banco = bancoDeTeste();
const skip = banco ? false : "DATABASE_URL não aponta para um banco *_test";

process.env.AUTH_SECRET ??= "test-secret-contas-portal";

const criados: string[] = [];
function emailNovo(prefixo: string) {
    return `${prefixo}-${randomUUID().slice(0, 8)}@portal-teste.invalid`;
}

async function modulos() {
    const [{ getDb, closeDb }, schema, auth, portal, server, contracts] = await Promise.all([
        import("@/db"),
        import("@/db/schema"),
        import("@/services/auth.service"),
        import("@/services/portal-accounts.service"),
        import("@/lib/auth/server"),
        import("@/modules/auth/contracts"),
    ]);
    return { getDb, closeDb, schema, auth, portal, server, contracts };
}

async function criarConta(email: string, senha: string, roles: string[]) {
    const { getDb, schema, auth } = await modulos();
    const db = getDb();
    const [user] = await db
        .insert(schema.users)
        .values({ email, passwordHash: await auth.hashPassword(senha), isActive: true })
        .returning({ id: schema.users.id });
    for (const role of roles) {
        await db.insert(schema.userRoles).values({ userId: user.id, role: role as "portal" });
    }
    criados.push(user.id);
    return user.id;
}

after(async () => {
    if (!banco) return;
    const { getDb, closeDb, schema } = await modulos();
    const db = getDb();
    const doTeste = await db
        .select({ id: schema.users.id })
        .from(schema.users)
        .where(like(schema.users.email, "%@portal-teste.invalid"));
    const ids = [...new Set([...criados, ...doTeste.map((r) => r.id)])];
    if (ids.length > 0) {
        await db.delete(schema.auditLogs).where(inArray(schema.auditLogs.entityId, ids));
        await db.delete(schema.users).where(inArray(schema.users.id, ids)); // cascata: user_roles, password_reset_tokens
    }
    await closeDb();
});

const SENHA = "Senha-Forte-123";

function verificarRequest(email: string, password: string) {
    return new NextRequest("http://localhost/api/auth/verificar-escala", {
        method: "POST",
        headers: { "content-type": "application/json", "x-escala-token": "token-escala-teste" },
        body: JSON.stringify({ email, password }),
    });
}

async function verificar(email: string, password: string) {
    process.env.ESCALA_SSO_TOKEN = "token-escala-teste";
    const { POST } = await import("@/app/api/auth/verificar-escala/route");
    const response = await POST(verificarRequest(email, password));
    return { status: response.status, body: await response.json() };
}

// ── Papel portal: portal sim, Plantões não ─────────────────────────────────

test("portal-only: verificar-escala aceita (roles = [portal])", { skip }, async () => {
    const email = emailNovo("so-portal");
    await criarConta(email, SENHA, ["portal"]);
    const { status, body } = await verificar(email, SENHA);
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.deepEqual(body.roles, ["portal"]);
});

test("portal-only: login do app recusa com no_roles_assigned", { skip }, async () => {
    const email = emailNovo("so-portal-login");
    await criarConta(email, SENHA, ["portal"]);
    const { auth } = await modulos();
    assert.deepEqual(await auth.authenticateWithPassword(email, SENHA), { status: "no_roles_assigned" });

    const { POST } = await import("@/app/api/auth/login/route");
    const response = await POST(new NextRequest("http://localhost/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, password: SENHA }),
    }));
    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), { error: "no_roles_assigned" });
});

test("portal-only: carregador de sessão devolve null; com outro papel, portal some de roles", { skip }, async () => {
    const { server } = await modulos();
    const soPortal = await criarConta(emailNovo("so-portal-sessao"), SENHA, ["portal"]);
    assert.equal(await server.loadUserSession({ sub: soPortal, exp: Date.now() + 60_000, sv: 0, iat: Date.now() }), null);

    const misto = await criarConta(emailNovo("medico-e-portal"), SENHA, ["portal", "doctor"]);
    const sessao = await server.loadUserSession({ sub: misto, exp: Date.now() + 60_000, sv: 0, iat: Date.now() });
    assert.ok(sessao);
    assert.deepEqual(sessao.user.roles, ["doctor"]);
});

test("portal-only: SSO do portal manda para sem-acesso", { skip }, async () => {
    process.env.ESCALA_FEDERACAO_URL = "https://escala.exemplo.invalid";
    process.env.ESCALA_FEDERACAO_SECRET = "segredo-federacao-teste";
    process.env.AUTH_URL = "http://localhost:3000";
    const email = emailNovo("so-portal-sso");
    await criarConta(email, SENHA, ["portal"]);
    const { criarTokenHandoff } = await import("@/lib/auth/federacao");
    const { GET } = await import("@/app/api/auth/sso/route");
    const token = criarTokenHandoff({ email, origem: "samu-salvador" }, "plantoes");
    const response = await GET(new NextRequest(`http://localhost/api/auth/sso?token=${encodeURIComponent(token)}`));
    assert.equal(response.status, 307);
    assert.equal(response.headers.get("location"), "http://localhost:3000/?sso=sem-acesso");
    assert.equal(response.headers.get("set-cookie"), null);
});

// ── verificar-escala: motivo da recusa ──────────────────────────────────────

test("verificar-escala: e-mail sem conta → 401 invalid_credentials + conta inexistente", { skip }, async () => {
    const { status, body } = await verificar(emailNovo("ninguem"), SENHA);
    assert.equal(status, 401);
    assert.deepEqual(body, { error: "invalid_credentials", conta: "inexistente" });
});

test("verificar-escala: senha errada sem histórico → existente, senhaAlteradaEm null", { skip }, async () => {
    const email = emailNovo("sem-historico");
    await criarConta(email, SENHA, ["doctor"]);
    const { status, body } = await verificar(email, "outra-senha-errada");
    assert.equal(status, 401);
    assert.deepEqual(body, { error: "invalid_credentials", conta: "existente", senhaAlteradaEm: null });
});

test("verificar-escala: senhaAlteradaEm = auditoria de troca de senha", { skip }, async () => {
    const email = emailNovo("trocou-senha");
    const userId = await criarConta(email, SENHA, ["chief"]);
    const { getDb, schema } = await modulos();
    const quando = new Date("2026-08-10T12:34:56.000Z");
    await getDb().insert(schema.auditLogs).values([
        { actorUserId: userId, action: "auth.password_changed", entityType: "user", entityId: userId, createdAt: new Date("2026-07-01T00:00:00.000Z") },
        { actorUserId: userId, action: "auth.password_changed_first_login", entityType: "user", entityId: userId, createdAt: quando },
        // Ação que não mexe em senha não conta, mesmo mais recente.
        { actorUserId: userId, action: "chief_exit.unknown_reported", entityType: "user", entityId: userId, createdAt: new Date("2026-09-01T00:00:00.000Z") },
    ]);
    const { body } = await verificar(email, "errada-de-novo");
    assert.equal(body.conta, "existente");
    assert.equal(body.senhaAlteradaEm, quando.toISOString());
});

test("verificar-escala: senhaAlteradaEm = uso de link de redefinição", { skip }, async () => {
    const email = emailNovo("usou-link");
    const userId = await criarConta(email, SENHA, ["doctor"]);
    const { getDb, schema } = await modulos();
    const usado = new Date("2026-09-20T08:00:00.000Z");
    await getDb().insert(schema.passwordResetTokens).values({
        userId,
        token: randomUUID().replace(/-/g, ""),
        expiresAt: new Date("2026-09-20T10:00:00.000Z"),
        usedAt: usado,
    });
    const { body } = await verificar(email, "errada");
    assert.equal(body.senhaAlteradaEm, usado.toISOString());
});

test("verificar-escala: portal-only com senha errada também explica (existente)", { skip }, async () => {
    const email = emailNovo("portal-errou");
    await criarConta(email, SENHA, ["portal"]);
    const { status, body } = await verificar(email, "errada");
    assert.equal(status, 401);
    assert.equal(body.error, "invalid_credentials");
    assert.equal(body.conta, "existente");
});

// ── Criação de conta de portal ─────────────────────────────────────────────

function contasRequest(body: object) {
    return new NextRequest("http://localhost/api/servicos/contas-portal", {
        method: "POST",
        headers: { "content-type": "application/json", "x-portal-token": "token-portal-teste" },
        body: JSON.stringify(body),
    });
}

async function contas(body: object) {
    process.env.PORTAL_CONTAS_TOKEN = "token-portal-teste";
    delete process.env.GMAIL_SMTP_USER;
    delete process.env.GMAIL_SMTP_APP_PASSWORD;
    const { POST } = await import("@/app/api/servicos/contas-portal/route");
    const response = await POST(contasRequest(body));
    return { status: response.status, body: await response.json() };
}

test("contas-portal: consultar sem conta → inexistente, nada criado", { skip }, async () => {
    const email = emailNovo("consulta");
    const { body } = await contas({ email, nome: "Fulana", origem: "huddle", consultar: true });
    assert.deepEqual(body, { ok: true, situacao: "inexistente" });
    const { getDb, schema } = await modulos();
    assert.equal((await getDb().select().from(schema.users).where(eq(schema.users.email, email))).length, 0);
});

test("contas-portal: cria conta portal, audita, gera link de 7 dias, e-mail falha sem desfazer", { skip }, async () => {
    const email = emailNovo("nova");
    const { status, body } = await contas({ email: `  ${email.toUpperCase()} `, nome: "Fulana de Tal", origem: "huddle" });
    assert.equal(status, 200);
    // Sem SMTP no teste: conta fica, emailEnviado false.
    assert.deepEqual(body, { ok: true, situacao: "criada", emailEnviado: false });

    const { getDb, schema, auth } = await modulos();
    const db = getDb();
    const [user] = await db.select().from(schema.users).where(eq(schema.users.email, email));
    assert.ok(user, "e-mail gravado aparado e em minúsculas");
    criados.push(user.id);
    assert.equal(user.isActive, true);
    assert.equal(user.mustChangePassword, false);
    assert.equal(user.doctorId, null);
    const roles = await db.select({ role: schema.userRoles.role }).from(schema.userRoles).where(eq(schema.userRoles.userId, user.id));
    assert.deepEqual(roles.map((r) => r.role), ["portal"]);

    const [audit] = await db.select().from(schema.auditLogs).where(eq(schema.auditLogs.entityId, user.id));
    assert.equal(audit.action, "portal_account.created");
    assert.equal(audit.actorUserId, null);
    assert.deepEqual(audit.details, { email, nome: "Fulana de Tal", origem: "huddle" });

    const [reset] = await db.select().from(schema.passwordResetTokens).where(eq(schema.passwordResetTokens.userId, user.id));
    const dias = (reset.expiresAt.getTime() - Date.now()) / 86_400_000;
    assert.ok(dias > 6.9 && dias <= 7, `link vale ${dias} dias`);

    // Ninguém sabe a senha inicial; o link define a senha e marca a conta como só-portal.
    assert.equal((await auth.authenticateWithPassword(email, SENHA, { escopo: "portal" })).status, "invalid_credentials");
    const lido = await auth.getPasswordResetToken(reset.token);
    assert.equal(lido?.somentePortal, true);
    const consumido = await auth.consumePasswordReset(reset.token, SENHA);
    assert.deepEqual(consumido, { ok: true, somentePortal: true });
    assert.equal((await auth.authenticateWithPassword(email, SENHA, { escopo: "portal" })).status, "success");
    assert.equal((await auth.authenticateWithPassword(email, SENHA)).status, "no_roles_assigned");

    const auditorias = await db.select({ action: schema.auditLogs.action }).from(schema.auditLogs).where(eq(schema.auditLogs.entityId, user.id));
    assert.ok(auditorias.some((a) => a.action === "auth.password_reset_completed"));

    // Senha errada depois disso: existente, com a data da definição.
    const { body: recusa } = await verificar(email, "errada");
    assert.equal(recusa.conta, "existente");
    assert.equal(typeof recusa.senhaAlteradaEm, "string");
});

test("contas-portal: conta existente não é alterada; acessoPortal reflete ativa + papel", { skip }, async () => {
    const { getDb, schema } = await modulos();
    const db = getDb();

    const medico = emailNovo("medico");
    const medicoId = await criarConta(medico, SENHA, ["doctor"]);
    const [antes] = await db.select().from(schema.users).where(eq(schema.users.id, medicoId));
    const { body } = await contas({ email: medico, nome: "Outro Nome", origem: "huddle" });
    assert.deepEqual(body, { ok: true, situacao: "existente", ativa: true, acessoPortal: true });
    const [depois] = await db.select().from(schema.users).where(eq(schema.users.id, medicoId));
    assert.deepEqual(depois, antes);
    const roles = await db.select({ role: schema.userRoles.role }).from(schema.userRoles).where(eq(schema.userRoles.userId, medicoId));
    assert.deepEqual(roles.map((r) => r.role), ["doctor"], "não ganhou papel portal");

    const semPapel = emailNovo("sem-papel");
    await criarConta(semPapel, SENHA, []);
    assert.deepEqual((await contas({ email: semPapel, nome: "Fulana", origem: "huddle" })).body, {
        ok: true, situacao: "existente", ativa: true, acessoPortal: false,
    });

    const inativa = emailNovo("inativa");
    const inativaId = await criarConta(inativa, SENHA, ["portal"]);
    await db.update(schema.users).set({ isActive: false }).where(eq(schema.users.id, inativaId));
    assert.deepEqual((await contas({ email: inativa, nome: "Fulana", origem: "huddle", consultar: true })).body, {
        ok: true, situacao: "existente", ativa: false, acessoPortal: false,
    });
});

test("contas-portal: dois pedidos simultâneos criam uma conta só", { skip }, async () => {
    const email = emailNovo("corrida");
    const respostas = await Promise.all([
        contas({ email, nome: "Fulana", origem: "huddle" }),
        contas({ email, nome: "Fulana", origem: "huddle" }),
    ]);
    const situacoes = respostas.map((r) => r.body.situacao).sort();
    assert.deepEqual(respostas.map((r) => r.status), [200, 200]);
    assert.ok(situacoes.includes("criada"), JSON.stringify(situacoes));
    assert.ok(situacoes.every((s) => s === "criada" || s === "existente"));
    const { getDb, schema } = await modulos();
    const rows = await getDb().select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.email, email));
    assert.equal(rows.length, 1);
    criados.push(rows[0].id);
});

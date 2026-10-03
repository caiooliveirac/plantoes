import test, { after } from "node:test";
import assert from "node:assert/strict";
import { and, eq, inArray, like } from "drizzle-orm";
import { NextRequest } from "next/server";

/**
 * Interno do GOA pelo porteiro (POST /api/servicos/portal/federado) contra
 * Postgres de verdade (docs/internos-goa.md). Só roda com DATABASE_URL num
 * banco `*_test`. Contas goa.teste-federado-*@samu.local, apagadas no fim.
 */
function bancoDeTeste(): string | null {
    try {
        const nome = new URL(process.env.DATABASE_URL ?? "").pathname.replace(/^\//, "");
        return /_test$/.test(nome) ? nome : null;
    } catch {
        return null;
    }
}

const banco = bancoDeTeste();
const skip = banco ? false : "DATABASE_URL não aponta para um banco *_test";
process.env.ESCALA_SSO_TOKEN ??= "token-de-teste-federado";
const TOKEN = process.env.ESCALA_SSO_TOKEN;
const PREFIXO = "goa.teste-federado-";
const sujeitoBase = 900_000_000 + Math.floor(Math.random() * 1_000_000);

async function modulos() {
    const [{ getDb, closeDb }, schema, rota, auth] = await Promise.all([
        import("@/db"),
        import("@/db/schema"),
        import("@/app/api/servicos/portal/federado/route"),
        import("@/services/auth.service"),
    ]);
    return { getDb, closeDb, schema, rota, auth };
}

function pedido(corpo: unknown, token: string | null = TOKEN) {
    return new NextRequest("http://localhost/api/servicos/portal/federado", {
        method: "POST",
        headers: { "content-type": "application/json", ...(token ? { "x-escala-token": token } : {}) },
        body: JSON.stringify(corpo),
    });
}

after(async () => {
    if (!banco) return;
    const { getDb, closeDb, schema } = await modulos();
    const db = getDb();
    const contas = await db.select({ id: schema.users.id }).from(schema.users).where(like(schema.users.email, `${PREFIXO}%`));
    const ids = contas.map((c) => c.id);
    if (ids.length) {
        await db.delete(schema.auditLogs).where(inArray(schema.auditLogs.entityId, ids));
        await db.delete(schema.users).where(inArray(schema.users.id, ids));
    }
    await closeDb();
});

test("federado: sem o token de serviço não responde nada", { skip }, async () => {
    const { rota } = await modulos();
    const r = await rota.POST(pedido({ provedor: "goa", sujeito: "1", login: "x" }, "errado"));
    assert.equal(r.status, 401);
});

test("federado: primeira vez cria conta interno; depois vale o vínculo, não o login", { skip }, async () => {
    const { rota, getDb, schema } = await modulos();
    const sujeito = String(sujeitoBase + 1);
    const r1 = await rota.POST(pedido({ provedor: "goa", sujeito, login: "teste-federado-ana", nome: "Ana Interna" }));
    assert.equal(r1.status, 200);
    const d1 = await r1.json();
    assert.equal(d1.ok, true);
    assert.equal(d1.criada, true);
    assert.equal(d1.email, `${PREFIXO}ana@samu.local`);
    assert.deepEqual(d1.roles, ["interno"]);
    assert.equal(d1.mustChangePassword, false);
    assert.equal(Number.isInteger(d1.sessionVersion), true);

    // Login renomeado no GOA: mesma conta daqui.
    const r2 = await rota.POST(pedido({ provedor: "goa", sujeito, login: "teste-federado-ana-lima", nome: "Ana Lima" }));
    const d2 = await r2.json();
    assert.equal(d2.criada, false);
    assert.equal(d2.userId, d1.userId);
    assert.equal(d2.email, d1.email);
    assert.equal(d2.nome, "Ana Lima");

    const [u] = await getDb().select({ doctorId: schema.users.doctorId }).from(schema.users).where(eq(schema.users.id, d1.userId));
    assert.equal(u.doctorId, null);
});

test("federado: conta suspensa ou com outro papel é recusada e não é recriada", { skip }, async () => {
    const { rota, getDb, schema } = await modulos();
    const sujeito = String(sujeitoBase + 2);
    const d = await (await rota.POST(pedido({ provedor: "goa", sujeito, login: "teste-federado-bia" }))).json();
    assert.equal(d.ok, true);

    await getDb().insert(schema.userRoles).values({ userId: d.userId, role: "chief" });
    const r1 = await rota.POST(pedido({ provedor: "goa", sujeito, login: "teste-federado-bia" }));
    assert.equal(r1.status, 403);
    assert.equal((await r1.json()).error, "papel_nao_permitido");
    await getDb().delete(schema.userRoles).where(and(eq(schema.userRoles.userId, d.userId), eq(schema.userRoles.role, "chief")));

    await getDb().update(schema.users).set({ isActive: false }).where(eq(schema.users.id, d.userId));
    const r2 = await rota.POST(pedido({ provedor: "goa", sujeito, login: "teste-federado-bia" }));
    assert.equal(r2.status, 403);
    assert.equal((await r2.json()).error, "inactive_account");
    const contas = await getDb().select({ id: schema.users.id }).from(schema.users).where(like(schema.users.email, `${PREFIXO}bia%`));
    assert.equal(contas.length, 1);
});

test("federado: e-mail já ocupado por outra conta não é vinculado", { skip }, async () => {
    const { rota } = await modulos();
    const ok = await (await rota.POST(pedido({ provedor: "goa", sujeito: String(sujeitoBase + 3), login: "teste-federado-caio" }))).json();
    assert.equal(ok.ok, true);
    // Outro usuário do GOA com o mesmo login (o primeiro foi renomeado lá): não herda a conta.
    const r = await rota.POST(pedido({ provedor: "goa", sujeito: String(sujeitoBase + 4), login: "teste-federado-caio" }));
    assert.equal(r.status, 409);
    assert.equal((await r.json()).error, "email_em_uso");
});

test("federado: conta de interno não entra por senha, nem no portal", { skip }, async () => {
    const { rota, getDb, schema, auth } = await modulos();
    const d = await (await rota.POST(pedido({ provedor: "goa", sujeito: String(sujeitoBase + 5), login: "teste-federado-davi" }))).json();
    const senha = ["Senha", "Manual", "123"].join("");
    await getDb().update(schema.users).set({ passwordHash: await auth.hashPassword(senha) }).where(eq(schema.users.id, d.userId));
    assert.equal((await auth.authenticateWithPassword(d.email, senha)).status, "no_roles_assigned");
    assert.equal((await auth.authenticateWithPassword(d.email, senha, { escopo: "portal" })).status, "no_roles_assigned");
});

test("federado: conta de interno não ganha sessão no app Plantões (sem Mesa)", { skip }, async () => {
    const { rota } = await modulos();
    const { loadUserSession } = await import("@/lib/auth/server");
    const d = await (await rota.POST(pedido({ provedor: "goa", sujeito: String(sujeitoBase + 6), login: "teste-federado-eva" }))).json();
    assert.equal(d.ok, true);
    const sessao = await loadUserSession({ sub: d.userId, exp: Date.now() + 60_000, sv: d.sessionVersion } as Parameters<typeof loadUserSession>[0]);
    assert.equal(sessao, null);
});

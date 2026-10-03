import test, { after } from "node:test";
import assert from "node:assert/strict";
import { eq, inArray, like } from "drizzle-orm";
import { NextRequest } from "next/server";

/**
 * Conta de operador da Central aprovada no Escalas (POST
 * /api/servicos/contas-escala) contra Postgres de verdade. Só roda com
 * DATABASE_URL num banco `*_test`. Contas @contas-escala-teste.invalid,
 * apagadas no fim.
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
process.env.ESCALA_SSO_TOKEN ??= "token-de-teste-contas-escala";
const TOKEN = process.env.ESCALA_SSO_TOKEN;
const SENHA = "k7Pm-x4Rt-9wQz";

async function modulos() {
    const [{ getDb, closeDb }, schema, rota, auth] = await Promise.all([
        import("@/db"),
        import("@/db/schema"),
        import("@/app/api/servicos/contas-escala/route"),
        import("@/services/auth.service"),
    ]);
    return { getDb, closeDb, schema, rota, auth };
}

function pedido(corpo: unknown, token: string | null = TOKEN) {
    return new NextRequest("http://localhost/api/servicos/contas-escala", {
        method: "POST",
        headers: { "content-type": "application/json", ...(token ? { "x-escala-token": token } : {}) },
        body: JSON.stringify(corpo),
    });
}

async function papeisDe(email: string) {
    const { getDb, schema } = await modulos();
    const [u] = await getDb().select({ id: schema.users.id, must: schema.users.mustChangePassword }).from(schema.users).where(eq(schema.users.email, email));
    const papeis = (await getDb().select({ role: schema.userRoles.role }).from(schema.userRoles).where(eq(schema.userRoles.userId, u.id))).map((r) => r.role).sort();
    return { id: u.id, papeis, must: u.must };
}

after(async () => {
    if (!banco) return;
    const { getDb, closeDb, schema } = await modulos();
    const db = getDb();
    const ids = (await db.select({ id: schema.users.id }).from(schema.users).where(like(schema.users.email, "%@contas-escala-teste.invalid"))).map((r) => r.id);
    if (ids.length > 0) {
        await db.delete(schema.auditLogs).where(inArray(schema.auditLogs.entityId, ids));
        await db.delete(schema.users).where(inArray(schema.users.id, ids));
    }
    await closeDb();
});

test("contas-escala (banco): sem token ou token errado não faz nada", { skip }, async () => {
    const { rota } = await modulos();
    const email = `x-${Date.now()}@contas-escala-teste.invalid`;
    assert.equal((await rota.POST(pedido({ email, nome: "X Y", senhaTemporaria: SENHA, papeis: ["tarm"] }, null))).status, 401);
    assert.equal((await rota.POST(pedido({ email, nome: "X Y", senhaTemporaria: SENHA, papeis: ["tarm"] }, "errado"))).status, 401);
});

test("contas-escala (banco): conta nova nasce com portal + papéis, senha temporária e troca obrigatória", { skip }, async () => {
    const { rota, auth } = await modulos();
    const email = `tarm-${Date.now()}@contas-escala-teste.invalid`;
    const r = await rota.POST(pedido({ email: email.toUpperCase(), nome: "Telefonista", senhaTemporaria: SENHA, papeis: ["tarm", "radio_operador"] }));
    assert.equal(r.status, 200);
    assert.equal((await r.json()).situacao, "criada");
    const conta = await papeisDe(email);
    assert.deepEqual(conta.papeis, ["portal", "radio_operador", "tarm"]);
    assert.equal(conta.must, true);
    const login = await auth.authenticateWithPassword(email, SENHA, { escopo: "portal" });
    assert.equal(login.status, "success");
});

test("contas-escala (banco): conta existente só ganha papel — senha intocada; admin nunca vem daqui", { skip }, async () => {
    const { rota, auth, getDb, schema } = await modulos();
    const email = `medico-${Date.now()}@contas-escala-teste.invalid`;
    await getDb().insert(schema.users).values({ email, passwordHash: await auth.hashPassword("Senha-Antiga-123"), isActive: true });
    const r = await rota.POST(pedido({ email, nome: "Médico", senhaTemporaria: SENHA, papeis: ["tarm"] }));
    assert.equal((await r.json()).situacao, "existente");
    assert.deepEqual((await papeisDe(email)).papeis, ["portal", "tarm"]);
    assert.equal((await auth.authenticateWithPassword(email, SENHA, { escopo: "portal" })).status, "invalid_credentials");
    assert.equal((await auth.authenticateWithPassword(email, "Senha-Antiga-123", { escopo: "portal" })).status, "success");
    assert.equal((await rota.POST(pedido({ email, nome: "Médico", senhaTemporaria: SENHA, papeis: ["admin"] }))).status, 400);
});

test("contas-escala (banco): enfermeiro(a) aprovado no Escalas ganha portal + enfermeiro", { skip }, async () => {
    const { rota } = await modulos();
    const email = `enf-${Date.now()}@contas-escala-teste.invalid`;
    const r = await rota.POST(pedido({ email, nome: "Enfermeira", senhaTemporaria: SENHA, papeis: ["enfermeiro"] }));
    assert.equal((await r.json()).situacao, "criada");
    assert.deepEqual((await papeisDe(email)).papeis, ["enfermeiro", "portal"]);
});

test("contas-escala (banco): senha temporária fraca é recusada", { skip }, async () => {
    const { rota } = await modulos();
    const email = `fraca-${Date.now()}@contas-escala-teste.invalid`;
    assert.equal((await rota.POST(pedido({ email, nome: "X Y", senhaTemporaria: "123456", papeis: ["tarm"] }))).status, 400);
    assert.equal((await rota.POST(pedido({ email, nome: "X Y", senhaTemporaria: "aaaaaaaaaaaa", papeis: ["tarm"] }))).status, 400);
});

test("portal/trocar-senha (banco): conta só do portal troca a temporária pela definitiva", { skip }, async () => {
    const { rota, auth } = await modulos();
    const troca = await import("@/app/api/servicos/portal/trocar-senha/route");
    const email = `troca-${Date.now()}@contas-escala-teste.invalid`;
    await rota.POST(pedido({ email, nome: "Condutor", senhaTemporaria: "abcd2345ef", papeis: [] }));
    const pedir = (corpo: unknown, token: string | null = TOKEN) => troca.POST(new NextRequest("http://localhost/api/servicos/portal/trocar-senha", {
        method: "POST",
        headers: { "content-type": "application/json", ...(token ? { "x-escala-token": token } : {}) },
        body: JSON.stringify(corpo),
    }));
    assert.equal((await pedir({ email, currentPassword: "abcd2345ef", nextPassword: "Definitiva123" }, "errado")).status, 401);
    assert.equal((await pedir({ email, currentPassword: "errada12345", nextPassword: "Definitiva123" })).status, 401);
    assert.equal((await pedir({ email, currentPassword: "abcd2345ef", nextPassword: "fracafraca" })).status, 400);
    assert.equal((await pedir({ email, currentPassword: "abcd2345ef", nextPassword: "Definitiva123" })).status, 200);
    const login = await auth.authenticateWithPassword(email, "Definitiva123", { escopo: "portal" });
    assert.equal(login.status, "success");
    assert.equal(login.status === "success" && login.user.mustChangePassword, false);
});

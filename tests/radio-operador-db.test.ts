import test, { after } from "node:test";
import assert from "node:assert/strict";
import { eq, inArray, like } from "drizzle-orm";

/**
 * Rádio-operador contra Postgres de verdade (migrations 0048–0050): cadastro
 * pelo admin (conta nova ou existente), tirar o papel, e a rede da Central que
 * decide a isenção da presença na Mesa. Só roda com DATABASE_URL num banco
 * `*_test`. Contas @radio-teste.invalid e a faixa de documentação 192.0.2.0/24
 * (RFC 5737), apagadas no fim.
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
const FAIXA = "192.0.2.0/24";

async function modulos() {
    const [{ getDb, closeDb }, schema, acoes, portao, auth] = await Promise.all([
        import("@/db"),
        import("@/db/schema"),
        import("@/services/acessos-acoes.service"),
        import("@/services/acessos-portao.service"),
        import("@/services/auth.service"),
    ]);
    return { getDb, closeDb, schema, acoes, portao, auth };
}

async function papeisDe(userId: string) {
    const { getDb, schema } = await modulos();
    return (await getDb().select({ role: schema.userRoles.role }).from(schema.userRoles).where(eq(schema.userRoles.userId, userId))).map((r) => r.role).sort();
}

async function admin() {
    const { getDb, schema, auth } = await modulos();
    const [user] = await getDb().insert(schema.users)
        .values({ email: `admin-${Date.now()}@radio-teste.invalid`, passwordHash: await auth.hashPassword("senha-de-teste-123"), isActive: true })
        .returning({ id: schema.users.id });
    await getDb().insert(schema.userRoles).values({ userId: user.id, role: "admin" });
    return user.id;
}

after(async () => {
    if (!banco) return;
    const { getDb, closeDb, schema } = await modulos();
    const db = getDb();
    const ids = (await db.select({ id: schema.users.id }).from(schema.users).where(like(schema.users.email, "%@radio-teste.invalid"))).map((r) => r.id);
    if (ids.length > 0) {
        await db.delete(schema.auditLogs).where(inArray(schema.auditLogs.entityId, ids));
        await db.delete(schema.passwordResetTokens).where(inArray(schema.passwordResetTokens.userId, ids));
        await db.delete(schema.users).where(inArray(schema.users.id, ids));
    }
    await db.delete(schema.authNetworkLabels).where(eq(schema.authNetworkLabels.faixa, FAIXA));
    await closeDb();
});

test("rádio-operador (banco): cadastro cria a conta de portal com o papel; repetir não duplica; tirar tira", { skip }, async () => {
    const { acoes } = await modulos();
    const adminId = await admin();
    const email = `radio-${Date.now()}@radio-teste.invalid`;

    const criado = await acoes.cadastrarRadioOperador({ email: email.toUpperCase(), nome: "Rádio Teste" }, adminId);
    assert.equal(criado.situacao, "criada");
    assert.equal(criado.jaEra, false);
    assert.deepEqual(await papeisDe(criado.userId), ["portal", "radio_operador"]);

    const repetido = await acoes.cadastrarRadioOperador({ email, nome: "Rádio Teste" }, adminId);
    assert.equal(repetido.userId, criado.userId);
    assert.equal(repetido.jaEra, true);

    assert.ok((await acoes.listarRadioOperadores()).some((c) => c.userId === criado.userId));
    await acoes.agirNaConta("tirar_radio_operador", criado.userId, adminId, "saiu da função de rádio");
    assert.deepEqual(await papeisDe(criado.userId), ["portal"]);
    await assert.rejects(acoes.agirNaConta("tirar_radio_operador", criado.userId, adminId, "de novo por engano"), /não é de rádio-operador/);
    await acoes.agirNaConta("dar_radio_operador", criado.userId, adminId, "voltou para o rádio");
    assert.deepEqual(await papeisDe(criado.userId), ["portal", "radio_operador"]);

    await assert.rejects(acoes.cadastrarRadioOperador({ email: "sem-arroba", nome: "X Y" }, adminId), /E-mail inválido/);
});

test("rádio-operador (banco): conta de médico já existente só ganha o papel", { skip }, async () => {
    const { acoes, getDb, schema, auth } = await modulos();
    const adminId = await admin();
    const email = `medico-${Date.now()}@radio-teste.invalid`;
    const [medico] = await getDb().insert(schema.users)
        .values({ email, passwordHash: await auth.hashPassword("senha-de-teste-123"), isActive: true })
        .returning({ id: schema.users.id });
    await getDb().insert(schema.userRoles).values({ userId: medico.id, role: "doctor" });

    const r = await acoes.cadastrarRadioOperador({ email, nome: "Médico e Rádio" }, adminId);
    assert.equal(r.situacao, "existente");
    assert.equal(r.userId, medico.id);
    assert.deepEqual(await papeisDe(medico.id), ["doctor", "radio_operador"]);
});

test("rádio-operador (banco): a isenção só vale na faixa da Central (rótulo ou medida)", { skip }, async () => {
    const { portao, getDb, schema } = await modulos();
    await getDb().insert(schema.authNetworkLabels).values({ faixa: FAIXA, kind: "central", label: "Central de teste" }).onConflictDoNothing();
    portao.esquecerCentralDoPortao();
    assert.equal(await portao.naRedeDaCentral("192.0.2.77"), true);
    assert.equal(await portao.naRedeDaCentral("198.51.100.1"), false);
    assert.equal(await portao.naRedeDaCentral(null), false);
});

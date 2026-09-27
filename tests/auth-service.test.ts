import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { sql } from "drizzle-orm";
import { closeDb, getDb } from "@/db";
import {
    authenticateWithPassword,
    changeOwnPassword,
    consumePasswordReset,
    createPasswordReset,
    getPasswordResetToken,
    hashPassword,
} from "@/services/auth.service";

/**
 * Caracterização do services/auth.service.ts (login, troca de senha, reset)
 * contra um Postgres de verdade. Mesma trava do tests/payable-shifts-service:
 * só roda com DATABASE_URL de um banco de teste (nome contém "test") e apaga
 * o que gravou.
 */

const databaseName = (() => {
    try {
        return new URL(process.env.DATABASE_URL ?? "").pathname.slice(1);
    } catch {
        return "";
    }
})();
const skip = /test/i.test(databaseName)
    ? false
    : "precisa de DATABASE_URL apontando para um banco de teste (nome com 'test')";

const tag = randomUUID().slice(0, 8);
const SENHA = "Senha-Inicial-1";
const userIds: string[] = [];

async function insertUser(name: string, params: { roles?: string[]; isActive?: boolean; mustChangePassword?: boolean } = {}) {
    const id = randomUUID();
    userIds.push(id);
    const email = `${name}-${tag}@teste.local`;
    await getDb().execute(sql`
        insert into operations_v2.users (id, email, password_hash, is_active, must_change_password)
        values (${id}, ${email}, ${await hashPassword(SENHA)}, ${params.isActive ?? true}, ${params.mustChangePassword ?? false})
    `);
    for (const role of params.roles ?? ["doctor"]) {
        await getDb().execute(sql`insert into operations_v2.user_roles (user_id, role) values (${id}, ${role})`);
    }
    return { id, email };
}

const users: Record<string, { id: string; email: string }> = {};

before(async () => {
    if (skip) return;
    users.ativo = await insertUser("ativo", { roles: ["chief", "doctor"] });
    users.inativo = await insertUser("inativo", { isActive: false });
    users.semPapel = await insertUser("sem-papel", { roles: [] });
    users.primeiroAcesso = await insertUser("primeiro-acesso", { mustChangePassword: true });
    users.reset = await insertUser("reset");
    users.soPortal = await insertUser("so-portal", { roles: ["portal"] });
});

after(async () => {
    if (skip) return;
    const db = getDb();
    await db.execute(sql`delete from operations_v2.audit_logs where actor_user_id in ${userIds}`);
    await db.execute(sql`delete from operations_v2.password_reset_tokens where user_id in ${userIds}`);
    await db.execute(sql`delete from operations_v2.user_roles where user_id in ${userIds}`);
    await db.execute(sql`delete from operations_v2.users where id in ${userIds}`);
    await closeDb();
});

test("login normaliza o e-mail e devolve os papéis", { skip }, async () => {
    const result = await authenticateWithPassword(`  ${users.ativo!.email.toUpperCase()} `, SENHA);
    assert.equal(result.status, "success");
    assert.ok(result.status === "success");
    assert.equal(result.user.id, users.ativo!.id);
    assert.deepEqual([...result.user.roles].sort(), ["chief", "doctor"]);
    assert.equal(result.user.mustChangePassword, false);
});

test("login recusa senha errada e e-mail desconhecido com o mesmo status", { skip }, async () => {
    assert.deepEqual(await authenticateWithPassword(users.ativo!.email, "Outra-Senha-1"), { status: "invalid_credentials" });
    assert.deepEqual(await authenticateWithPassword(`ninguem-${tag}@teste.local`, SENHA), { status: "invalid_credentials" });
});

test("login com senha certa distingue conta inativa e conta sem papel", { skip }, async () => {
    assert.deepEqual(await authenticateWithPassword(users.inativo!.email, SENHA), { status: "inactive_account" });
    assert.deepEqual(await authenticateWithPassword(users.semPapel!.email, SENHA), { status: "no_roles_assigned" });
    // Senha errada numa conta inativa não revela que ela existe.
    assert.deepEqual(await authenticateWithPassword(users.inativo!.email, "Outra-Senha-1"), { status: "invalid_credentials" });
});

test("troca de senha exige a senha atual e a política", { skip }, async () => {
    const { id } = users.primeiroAcesso!;
    await assert.rejects(changeOwnPassword(id, "Errada-123", "Nova-Senha-123"), /Senha atual incorreta/);
    await assert.rejects(changeOwnPassword(id, SENHA, "curta"), /pelo menos 10 caracteres/);
    await assert.rejects(changeOwnPassword(id, SENHA, SENHA), /diferente da senha atual/);
    await assert.rejects(changeOwnPassword(randomUUID(), SENHA, "Nova-Senha-123"), /User not found/);
});

test("troca de senha no primeiro acesso limpa a flag e registra auditoria", { skip }, async () => {
    const { id, email } = users.primeiroAcesso!;
    const before = await authenticateWithPassword(email, SENHA);
    assert.ok(before.status === "success" && before.user.mustChangePassword);

    assert.deepEqual(await changeOwnPassword(id, SENHA, "Nova-Senha-123"), { ok: true });

    assert.deepEqual(await authenticateWithPassword(email, SENHA), { status: "invalid_credentials" });
    const afterChange = await authenticateWithPassword(email, "Nova-Senha-123");
    assert.ok(afterChange.status === "success");
    assert.equal(afterChange.user.mustChangePassword, false);

    const audit = await getDb().execute(sql`
        select action from operations_v2.audit_logs where actor_user_id = ${id} order by created_at
    `) as unknown as Array<{ action: string }>;
    assert.deepEqual(audit.map((row) => row.action), ["auth.password_changed_first_login"]);
});

test("reset de senha: só para conta ativa, token de uso único", { skip }, async () => {
    assert.deepEqual(await createPasswordReset(users.inativo!.email), { created: false, token: null });
    assert.deepEqual(await createPasswordReset(`ninguem-${tag}@teste.local`), { created: false, token: null });

    const { created, token } = await createPasswordReset(users.reset!.email.toUpperCase());
    assert.equal(created, true);
    assert.ok(token);
    assert.equal((await getPasswordResetToken(token))?.userId, users.reset!.id);

    await assert.rejects(consumePasswordReset(token, "curta"), /pelo menos 10 caracteres/);
    // somentePortal: false — conta com papel do app; a tela manda para o login daqui.
    assert.deepEqual(await consumePasswordReset(token, "Resetada-123"), { ok: true, somentePortal: false });
    assert.equal(await getPasswordResetToken(token), null);
    await assert.rejects(consumePasswordReset(token, "Outra-Senha-123"), /invalid or expired/);

    assert.equal((await authenticateWithPassword(users.reset!.email, "Resetada-123")).status, "success");
});

test("reset de senha: conta só com papel portal volta somentePortal (tela manda para mnrs.com.br)", { skip }, async () => {
    const { created, token } = await createPasswordReset(users.soPortal!.email);
    assert.equal(created, true);
    assert.ok(token);
    assert.equal((await getPasswordResetToken(token))?.somentePortal, true);
    assert.deepEqual(await consumePasswordReset(token, "Resetada-123"), { ok: true, somentePortal: true });
    // Senha nova vale no portal, não no app.
    assert.equal((await authenticateWithPassword(users.soPortal!.email, "Resetada-123", { escopo: "portal" })).status, "success");
    assert.deepEqual(await authenticateWithPassword(users.soPortal!.email, "Resetada-123"), { status: "no_roles_assigned" });
});

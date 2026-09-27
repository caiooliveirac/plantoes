import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { sql } from "drizzle-orm";
import { closeDb, getDb } from "@/db";
import { authenticateWithPassword, hashPassword } from "@/services/auth.service";
import {
    createChiefInvite,
    getValidChiefInvite,
    listChiefAccessRequests,
    listChiefAssignments,
    listChiefInvites,
    listDoctorsForChiefInvite,
    provisionChiefBootstrapAccess,
    reviewChiefAccessRequest,
    submitChiefAccessRequest,
} from "@/services/chief-access.service";

/**
 * Caracterização do services/chief-access.service.ts (convite → pedido →
 * revisão, e o bootstrap direto do admin) contra um Postgres de verdade. É o
 * caminho que decide quem vira chefe, então o foco são os portões: convite
 * expirado/usado/token errado, e-mail amarrado ao convite, pedido revisado
 * duas vezes, conta admin protegida no bootstrap e session_version (#317).
 *
 * Mesma trava do tests/auth-service: só roda com DATABASE_URL de um banco de
 * teste (nome contém "test") e apaga o que gravou.
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
const EMAIL_LIKE = `%-${tag}@teste.local`;
const doctorIds: string[] = [];

function email(name: string) {
    return `${name}-${tag}@teste.local`;
}

async function insertDoctor(name: string, isActive = true) {
    const id = randomUUID();
    doctorIds.push(id);
    const fullName = `${name} ${tag}`;
    await getDb().execute(sql`
        insert into operations_v2.doctors (id, full_name, normalized_name, is_active)
        values (${id}, ${fullName}, ${fullName.toLowerCase()}, ${isActive})
    `);
    return id;
}

async function insertUser(name: string, roles: string[], doctorId: string | null = null) {
    const id = randomUUID();
    await getDb().execute(sql`
        insert into operations_v2.users (id, email, password_hash, doctor_id)
        values (${id}, ${email(name)}, ${await hashPassword(SENHA)}, ${doctorId})
    `);
    for (const role of roles) {
        await getDb().execute(sql`insert into operations_v2.user_roles (user_id, role) values (${id}, ${role})`);
    }
    return id;
}

async function userRow(userEmail: string) {
    const rows = await getDb().execute(sql`
        select u.id, u.doctor_id, u.session_version, u.must_change_password, u.is_active,
               coalesce(array_agg(ur.role::text order by ur.role::text) filter (where ur.role is not null), '{}') as roles
        from operations_v2.users u
        left join operations_v2.user_roles ur on ur.user_id = u.id
        where u.email = ${userEmail}
        group by u.id
    `) as unknown as Array<{
        id: string;
        doctor_id: string | null;
        session_version: number;
        must_change_password: boolean;
        is_active: boolean;
        roles: string[];
    }>;
    return rows[0] ?? null;
}

const inDays = (days: number) => new Date(Date.now() + days * 24 * 60 * 60 * 1000);

let adminId = "";
let doctorA = "";
let doctorB = "";
let doctorInativo = "";

function requestInput(token: string, overrides: Partial<Parameters<typeof submitChiefAccessRequest>[0]> = {}) {
    return {
        token,
        doctorId: doctorA,
        requestedEmail: email("pedido"),
        phone: "71999990000",
        registrationNumber: "CRM-BA 1234",
        selfieUrl: "https://exemplo.local/selfie.jpg",
        password: "Senha-Do-Pedido-1",
        ...overrides,
    };
}

async function bearerInvite(expiresAt = inDays(7)) {
    return createChiefInvite({ inviteMode: "bearer", expiresAt }, adminId);
}

before(async () => {
    if (skip) return;
    adminId = await insertUser("admin", ["admin"]);
    doctorA = await insertDoctor("Chefe A");
    doctorB = await insertDoctor("Chefe B");
    doctorInativo = await insertDoctor("Chefe Inativo", false);
});

after(async () => {
    if (skip) return;
    const db = getDb();
    const userIds = (await db.execute(sql`
        select id from operations_v2.users where email like ${EMAIL_LIKE}
    `) as unknown as Array<{ id: string }>).map((row) => row.id);
    const inviteIds = (await db.execute(sql`
        select id from operations_v2.chief_invites
        where invited_by_user_id in ${userIds} or email like ${EMAIL_LIKE}
    `) as unknown as Array<{ id: string }>).map((row) => row.id);
    const requestIds = inviteIds.length === 0 ? [] : (await db.execute(sql`
        select id from operations_v2.chief_access_requests where invite_id in ${inviteIds}
    `) as unknown as Array<{ id: string }>).map((row) => row.id);
    const entityIds = [...userIds, ...inviteIds, ...requestIds];

    await db.execute(sql`delete from operations_v2.audit_logs where actor_user_id in ${userIds} or entity_id in ${entityIds}`);
    if (requestIds.length) {
        await db.execute(sql`delete from operations_v2.chief_access_requests where id in ${requestIds}`);
    }
    if (inviteIds.length) {
        await db.execute(sql`delete from operations_v2.chief_invites where id in ${inviteIds}`);
    }
    await db.execute(sql`delete from operations_v2.user_roles where user_id in ${userIds}`);
    await db.execute(sql`delete from operations_v2.users where id in ${userIds}`);
    await db.execute(sql`delete from operations_v2.doctors where id in ${doctorIds}`);
    await closeDb();
});

// ---------------------------------------------------------------------------
// Convites
// ---------------------------------------------------------------------------

test("convite: nasce com token opaco, fica válido até expirar e é auditado", { skip }, async () => {
    const invite = await createChiefInvite(
        { inviteMode: "email", email: email("convidado").toUpperCase(), expiresAt: inDays(3) },
        adminId,
    );
    assert.match(invite.token, /^[0-9a-f]{32}$/);
    assert.equal(invite.email, email("convidado"), "e-mail do convite é normalizado");
    assert.equal(invite.usedAt, null);
    assert.equal((await getValidChiefInvite(invite.token))?.id, invite.id);

    const listed = (await listChiefInvites()).find((row) => row.id === invite.id);
    assert.equal(listed?.invited_by_email, email("admin"));

    const audit = await getDb().execute(sql`
        select action from operations_v2.audit_logs where entity_id = ${invite.id}
    `) as unknown as Array<{ action: string }>;
    assert.deepEqual(audit.map((row) => row.action), ["chief_invite.created"]);
});

test("convite por e-mail sem e-mail é recusado", { skip }, async () => {
    await assert.rejects(
        createChiefInvite({ inviteMode: "email", expiresAt: inDays(3) }, adminId),
        /requires an email/,
    );
});

test("convite: token errado e convite expirado não valem", { skip }, async () => {
    assert.equal(await getValidChiefInvite("nao-existe"), null);
    assert.equal(await getValidChiefInvite(""), null);

    const expired = await bearerInvite(new Date(Date.now() - 60_000));
    assert.equal(await getValidChiefInvite(expired.token), null);
    await assert.rejects(submitChiefAccessRequest(requestInput(expired.token)), /invalid or expired/);
    await assert.rejects(submitChiefAccessRequest(requestInput("token-errado")), /invalid or expired/);
});

test("lista de médicos do convite só traz ativos", { skip }, async () => {
    const ids = new Set((await listDoctorsForChiefInvite()).map((row) => row.id));
    assert.ok(ids.has(doctorA));
    assert.ok(!ids.has(doctorInativo));
});

// ---------------------------------------------------------------------------
// Pedido de acesso
// ---------------------------------------------------------------------------

test("pedido: consome o convite (uso único) e é auditado sem ator", { skip }, async () => {
    const invite = await bearerInvite();
    const request = await submitChiefAccessRequest(requestInput(invite.token, {
        requestedEmail: `  ${email("uso-unico").toUpperCase()}`,
    }));
    assert.equal(request.status, "pending");
    assert.equal(request.requestedEmail, email("uso-unico"));
    assert.notEqual(request.passwordHash, "Senha-Do-Pedido-1", "senha nunca é gravada em claro");

    assert.equal(await getValidChiefInvite(invite.token), null, "convite usado deixa de valer");
    await assert.rejects(
        submitChiefAccessRequest(requestInput(invite.token, { requestedEmail: email("segundo-uso") })),
        /invalid or expired/,
    );

    const audit = await getDb().execute(sql`
        select action, actor_user_id from operations_v2.audit_logs where entity_id = ${request.id}
    `) as unknown as Array<{ action: string; actor_user_id: string | null }>;
    assert.deepEqual([...audit], [{ action: "chief_request.submitted", actor_user_id: null }]);
});

test("pedido: convite por e-mail só aceita o e-mail amarrado (sem diferenciar caixa)", { skip }, async () => {
    const invite = await createChiefInvite(
        { inviteMode: "email", email: email("amarrado"), expiresAt: inDays(3) },
        adminId,
    );
    await assert.rejects(
        submitChiefAccessRequest(requestInput(invite.token, { requestedEmail: email("intruso") })),
        /does not match/,
    );
    assert.ok(await getValidChiefInvite(invite.token), "tentativa recusada não queima o convite");

    const request = await submitChiefAccessRequest(requestInput(invite.token, {
        requestedEmail: email("amarrado").toUpperCase(),
    }));
    assert.equal(request.requestedEmail, email("amarrado"));
});

test("pedido: médico inexistente ou inativo é recusado sem queimar o convite", { skip }, async () => {
    const invite = await bearerInvite();
    await assert.rejects(
        submitChiefAccessRequest(requestInput(invite.token, { doctorId: doctorInativo })),
        /not found in the official directory/,
    );
    await assert.rejects(
        submitChiefAccessRequest(requestInput(invite.token, { doctorId: randomUUID() })),
        /not found in the official directory/,
    );
    assert.ok(await getValidChiefInvite(invite.token));
});

test("pedido: senha de chefia passa pela política de senha", { skip }, async () => {
    const invite = await bearerInvite();
    await assert.rejects(
        submitChiefAccessRequest(requestInput(invite.token, { requestedEmail: email("senha-fraca"), password: "12345678" })),
        /pelo menos 10 caracteres/,
    );
    await assert.rejects(
        submitChiefAccessRequest(requestInput(invite.token, { requestedEmail: email("senha-fraca"), password: "senhasemgrupos" })),
        /tres grupos/,
    );
    assert.ok(await getValidChiefInvite(invite.token), "senha recusada não queima o convite");
});

// ---------------------------------------------------------------------------
// Revisão
// ---------------------------------------------------------------------------

test("revisão: aprovar cria o usuário chefe com a senha do pedido", { skip }, async () => {
    const invite = await bearerInvite();
    const request = await submitChiefAccessRequest(requestInput(invite.token, { requestedEmail: email("aprovado") }));

    const approved = await reviewChiefAccessRequest(
        { requestId: request.id, decision: "approved", reviewNotes: "ok" },
        adminId,
    );
    assert.equal(approved.status, "approved");
    assert.equal(approved.reviewedByUserId, adminId);
    assert.ok(approved.reviewedAt);

    const user = await userRow(email("aprovado"));
    assert.ok(user);
    assert.equal(approved.approvedUserId, user.id);
    assert.equal(user.doctor_id, doctorA);
    assert.deepEqual(user.roles, ["chief"]);
    assert.equal(user.must_change_password, true, "chefe aprovado troca a senha no primeiro acesso");
    assert.equal(user.session_version, 0);

    const login = await authenticateWithPassword(email("aprovado"), "Senha-Do-Pedido-1");
    assert.ok(login.status === "success" && login.user.mustChangePassword);
    assert.deepEqual(login.user.roles, ["chief"]);

    const listed = (await listChiefAccessRequests()).find((row) => row.id === request.id);
    assert.equal(listed?.status, "approved");
    assert.equal(listed?.reviewer_email, email("admin"));
    assert.equal(listed?.approved_email, email("aprovado"));
    assert.ok((await listChiefAssignments()).some((row) => row.id === user.id));

    const audit = await getDb().execute(sql`
        select action, actor_user_id from operations_v2.audit_logs
        where entity_id = ${request.id} order by created_at
    `) as unknown as Array<{ action: string; actor_user_id: string | null }>;
    assert.deepEqual(audit.map((row) => row.action), ["chief_request.submitted", "chief_request.approved"]);
    assert.equal(audit[1]!.actor_user_id, adminId);
});

test("revisão: aprovar para conta existente troca a senha, soma o papel e derruba sessões (#317)", { skip }, async () => {
    const existingId = await insertUser("medico-existente", ["doctor"], doctorB);
    const invite = await bearerInvite();
    const request = await submitChiefAccessRequest(requestInput(invite.token, {
        doctorId: doctorB,
        requestedEmail: email("medico-existente"),
    }));

    await reviewChiefAccessRequest({ requestId: request.id, decision: "approved" }, adminId);

    const user = await userRow(email("medico-existente"));
    assert.equal(user?.id, existingId);
    assert.deepEqual(user?.roles, ["chief", "doctor"]);
    assert.equal(user?.session_version, 1, "sessões abertas com a senha antiga caem");
    assert.equal((await authenticateWithPassword(email("medico-existente"), SENHA)).status, "invalid_credentials");
    assert.equal((await authenticateWithPassword(email("medico-existente"), "Senha-Do-Pedido-1")).status, "success");
});

test("revisão: rejeitar não cria usuário e registra a nota", { skip }, async () => {
    const invite = await bearerInvite();
    const request = await submitChiefAccessRequest(requestInput(invite.token, { requestedEmail: email("rejeitado") }));

    const rejected = await reviewChiefAccessRequest(
        { requestId: request.id, decision: "rejected", reviewNotes: "selfie ilegível" },
        adminId,
    );
    assert.equal(rejected.status, "rejected");
    assert.equal(rejected.reviewNotes, "selfie ilegível");
    assert.equal(rejected.approvedUserId, null);
    assert.equal(await userRow(email("rejeitado")), null);
});

test("revisão: pedido já revisado não é revisado de novo", { skip }, async () => {
    const invite = await bearerInvite();
    const request = await submitChiefAccessRequest(requestInput(invite.token, { requestedEmail: email("revisado-2x") }));
    await reviewChiefAccessRequest({ requestId: request.id, decision: "rejected" }, adminId);

    await assert.rejects(
        reviewChiefAccessRequest({ requestId: request.id, decision: "approved" }, adminId),
        /Only pending/,
    );
    await assert.rejects(
        reviewChiefAccessRequest({ requestId: request.id, decision: "rejected" }, adminId),
        /Only pending/,
    );
    assert.equal(await userRow(email("revisado-2x")), null, "rejeitado continua sem conta");
    await assert.rejects(
        reviewChiefAccessRequest({ requestId: randomUUID(), decision: "approved" }, adminId),
        /not found/,
    );
});

test("revisão: aprovar pedido com e-mail de conta admin é recusado (como no bootstrap)", { skip }, async () => {
    await insertUser("admin-alvo", ["admin"]);
    const invite = await bearerInvite();
    const request = await submitChiefAccessRequest(requestInput(invite.token, { requestedEmail: email("admin-alvo") }));

    await assert.rejects(reviewChiefAccessRequest({ requestId: request.id, decision: "approved" }, adminId), /conta admin/);
    assert.equal((await authenticateWithPassword(email("admin-alvo"), SENHA)).status, "success", "senha do admin intacta");
    const admin = await userRow(email("admin-alvo"));
    assert.deepEqual(admin?.roles, ["admin"]);
    assert.equal(admin?.session_version, 0);

    // A recusa não consome o pedido: o admin ainda pode rejeitá-lo.
    const rejected = await reviewChiefAccessRequest({ requestId: request.id, decision: "rejected" }, adminId);
    assert.equal(rejected.status, "rejected");
});

test("revisão: aprovar pedido com e-mail de conta de outro médico (ou sem médico) é recusado", { skip }, async () => {
    await insertUser("vinculado-b", ["doctor"], doctorB);
    const invite = await bearerInvite();
    const request = await submitChiefAccessRequest(requestInput(invite.token, {
        doctorId: doctorA,
        requestedEmail: email("vinculado-b"),
    }));

    await assert.rejects(reviewChiefAccessRequest({ requestId: request.id, decision: "approved" }, adminId), /outro medico/);
    let user = await userRow(email("vinculado-b"));
    assert.equal(user?.doctor_id, doctorB);
    assert.deepEqual(user?.roles, ["doctor"]);
    assert.equal((await authenticateWithPassword(email("vinculado-b"), SENHA)).status, "success");

    // Conta sem médico vinculado também não é "do próprio médico": a senha dela não muda.
    await insertUser("sem-medico", ["doctor"]);
    const invite2 = await bearerInvite();
    const request2 = await submitChiefAccessRequest(requestInput(invite2.token, { requestedEmail: email("sem-medico") }));
    await assert.rejects(reviewChiefAccessRequest({ requestId: request2.id, decision: "approved" }, adminId), /outro medico/);
    user = await userRow(email("sem-medico"));
    assert.equal(user?.doctor_id, null);
    assert.equal((await authenticateWithPassword(email("sem-medico"), SENHA)).status, "success");
});

test("revisão: aprovar e rejeitar o mesmo pedido ao mesmo tempo — só um vence", { skip }, async () => {
    for (let round = 0; round < 5; round += 1) {
        const invite = await bearerInvite();
        const request = await submitChiefAccessRequest(requestInput(invite.token, { requestedEmail: email(`corrida-${round}`) }));

        const results = await Promise.allSettled([
            reviewChiefAccessRequest({ requestId: request.id, decision: "approved" }, adminId),
            reviewChiefAccessRequest({ requestId: request.id, decision: "rejected" }, adminId),
        ]);
        const fulfilled = results.filter((result) => result.status === "fulfilled");
        const rejected = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
        assert.equal(fulfilled.length, 1, `rodada ${round}`);
        assert.match(String(rejected[0]?.reason), /Only pending/, `rodada ${round}`);

        const winner = (fulfilled[0] as PromiseFulfilledResult<{ status: string }>).value.status;
        const user = await userRow(email(`corrida-${round}`));
        assert.equal(Boolean(user), winner === "approved", `rodada ${round}: conta só existe se a aprovação venceu`);
        const audit = await getDb().execute(sql`
            select action from operations_v2.audit_logs
            where entity_id = ${request.id} and action <> 'chief_request.submitted'
        `) as unknown as Array<{ action: string }>;
        assert.deepEqual(audit.map((row) => row.action), [`chief_request.${winner}`], `rodada ${round}`);
    }
});

// ---------------------------------------------------------------------------
// Bootstrap direto pelo admin
// ---------------------------------------------------------------------------

test("bootstrap: conta nova nasce chefe com troca de senha obrigatória", { skip }, async () => {
    const result = await provisionChiefBootstrapAccess(
        { doctorId: doctorA, email: email("boot-novo").toUpperCase(), temporaryPassword: "Provisoria-123" },
        adminId,
    );
    assert.equal(result.email, email("boot-novo"));
    assert.equal(result.wasExistingUser, false);
    assert.equal(result.mustChangePassword, true);

    const user = await userRow(email("boot-novo"));
    assert.deepEqual(user?.roles, ["chief"]);
    assert.equal(user?.session_version, 0);

    const login = await authenticateWithPassword(email("boot-novo"), "Provisoria-123");
    assert.ok(login.status === "success" && login.user.mustChangePassword);

    const audit = await getDb().execute(sql`
        select action, actor_user_id from operations_v2.audit_logs where entity_id = ${result.id}
    `) as unknown as Array<{ action: string; actor_user_id: string }>;
    assert.deepEqual([...audit], [{ action: "chief_access.bootstrap_created", actor_user_id: adminId }]);
});

test("bootstrap: conta existente do mesmo médico é rotacionada e sessões caem (#317)", { skip }, async () => {
    const existingId = await insertUser("boot-existente", ["doctor"], doctorA);

    const first = await provisionChiefBootstrapAccess(
        { doctorId: doctorA, email: email("boot-existente"), temporaryPassword: "Provisoria-123" },
        adminId,
    );
    assert.equal(first.id, existingId);
    assert.equal(first.wasExistingUser, true);
    let user = await userRow(email("boot-existente"));
    assert.deepEqual(user?.roles, ["chief", "doctor"]);
    assert.equal(user?.session_version, 1);
    assert.equal(user?.must_change_password, true);

    // Rodar de novo (nova senha provisória) é idempotente no papel e sobe a versão de novo.
    await provisionChiefBootstrapAccess(
        { doctorId: doctorA, email: email("boot-existente"), temporaryPassword: "Provisoria-456" },
        adminId,
    );
    user = await userRow(email("boot-existente"));
    assert.deepEqual(user?.roles, ["chief", "doctor"]);
    assert.equal(user?.session_version, 2);
    assert.equal((await authenticateWithPassword(email("boot-existente"), "Provisoria-123")).status, "invalid_credentials");
});

test("bootstrap: recusa conta admin, conta de outro médico, médico inativo e senha fraca", { skip }, async () => {
    await insertUser("boot-admin", ["admin"]);
    await assert.rejects(
        provisionChiefBootstrapAccess({ doctorId: doctorA, email: email("boot-admin"), temporaryPassword: "Provisoria-123" }, adminId),
        /conta admin/,
    );
    assert.equal((await authenticateWithPassword(email("boot-admin"), SENHA)).status, "success", "senha do admin intacta");
    assert.equal((await userRow(email("boot-admin")))?.session_version, 0);

    await insertUser("boot-outro", ["doctor"], doctorB);
    await assert.rejects(
        provisionChiefBootstrapAccess({ doctorId: doctorA, email: email("boot-outro"), temporaryPassword: "Provisoria-123" }, adminId),
        /vinculado a outro medico/,
    );
    assert.deepEqual((await userRow(email("boot-outro")))?.roles, ["doctor"]);

    await assert.rejects(
        provisionChiefBootstrapAccess({ doctorId: doctorInativo, email: email("boot-inativo"), temporaryPassword: "Provisoria-123" }, adminId),
        /nao encontrado/,
    );
    await assert.rejects(
        provisionChiefBootstrapAccess({ doctorId: doctorA, email: email("boot-fraca"), temporaryPassword: "fraca" }, adminId),
        /pelo menos 10 caracteres/,
    );
    assert.equal(await userRow(email("boot-inativo")), null);
    assert.equal(await userRow(email("boot-fraca")), null);
});

// ---------------------------------------------------------------------------
// Quem pode: o service confia no chamador; o portão é a rota (só admin).
// ---------------------------------------------------------------------------

function handlerSource(route: string, method: "GET" | "POST") {
    const source = readFileSync(join(process.cwd(), route), "utf8");
    const start = source.indexOf(`export async function ${method}(`);
    assert.ok(start >= 0, `${route} sem ${method}`);
    const next = source.indexOf("export async function", start + 1);
    return source.slice(start, next < 0 ? undefined : next);
}

test("rotas de chefia: criar convite, revisar, listar e bootstrap exigem sessão admin", () => {
    const ADMIN_GUARD = /requireAuthenticatedSession\(\["admin"\]\)/;
    const guarded: Array<[string, "GET" | "POST"]> = [
        ["app/api/chief/invites/route.ts", "GET"],
        ["app/api/chief/invites/route.ts", "POST"],
        ["app/api/chief/requests/route.ts", "GET"],
        ["app/api/chief/requests/[id]/review/route.ts", "POST"],
        ["app/api/chief/bootstrap/route.ts", "POST"],
    ];
    for (const [route, method] of guarded) {
        assert.match(handlerSource(route, method), ADMIN_GUARD, `${method} ${route}`);
    }
    // O envio do pedido é público de propósito: a credencial é o token do convite.
    assert.doesNotMatch(handlerSource("app/api/chief/requests/route.ts", "POST"), /requireAuthenticatedSession/);
    assert.match(handlerSource("app/api/chief/requests/route.ts", "POST"), /submitChiefAccessRequest\(/);
});

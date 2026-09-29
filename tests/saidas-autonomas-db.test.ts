import test, { after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";

/**
 * Saídas a confirmar andando sozinhas, contra um Postgres de verdade: o sistema
 * confirma pelo mesmo caminho da chefia (banco de horas sai igual), marca a
 * confirmação como dele, e o Desfazer devolve tudo — inclusive o desfecho que
 * ele mesmo gravou.
 *
 * SÓ roda quando DATABASE_URL aponta para um banco cujo nome termina em
 * `_test` (mesma trava de tests/madrugada-db.test.ts).
 */

function bancoDeTeste(): string | null {
    const raw = process.env.DATABASE_URL;
    if (!raw) return null;
    try {
        return /_test$/.test(new URL(raw).pathname.replace(/^\//, "")) ? raw : null;
    } catch {
        return null;
    }
}

const banco = bancoDeTeste();
const skip = banco ? false : "DATABASE_URL não aponta para um banco *_test";
const medicos: string[] = [];
const usuarios: string[] = [];

async function modulos() {
    const [{ getDb, closeDb }, schema, board, autonomy, service] = await Promise.all([
        import("@/db"),
        import("@/db/schema"),
        import("@/services/board.service"),
        import("@/modules/operational/departure-autonomy"),
        import("@/services/departure-autonomy.service"),
    ]);
    return { getDb, closeDb, schema, board, autonomy, service };
}

async function criarMedico(nome: string) {
    const { getDb, schema } = await modulos();
    const sufixo = Array.from(randomBytes(8), (b) => String.fromCharCode(65 + (b % 26))).join("");
    const [doctor] = await getDb()
        .insert(schema.doctors)
        .values({ fullName: `${nome} ${sufixo}`, normalizedName: `SAIDAS TESTE ${nome} ${sufixo}` })
        .returning({ id: schema.doctors.id });
    medicos.push(doctor.id);
    return doctor;
}

// Ontem, no relógio de São Paulo: dentro da janela de 7 dias da fila.
function ontem(hhmm: string) {
    const now = new Date(Date.now() - 24 * 3_600_000);
    const day = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" }).format(now);
    return new Date(`${day}T${hhmm}:00-03:00`);
}

async function ocupacao(values: { doctorId: string; code: string; startedAt: Date; actualEndedAt: Date | null }) {
    const { getDb, schema } = await modulos();
    const post = await getDb().query.regulationPosts.findFirst({ where: eq(schema.regulationPosts.code, values.code) });
    assert.ok(post, `ramal ${values.code} existe`);
    const [row] = await getDb().insert(schema.regulationOccupancies).values({
        doctorId: values.doctorId,
        continuityGroupId: randomUUID(),
        postId: post.id,
        scheduledStartAt: ontem("07:00"),
        scheduledEndAt: ontem("19:15"),
        startedAt: values.startedAt,
        boardStartedAt: values.startedAt,
        endedAt: values.actualEndedAt,
        actualEndedAt: values.actualEndedAt,
        shiftLabel: "SD",
        ramalLabel: values.code,
        source: "telegram",
    }).returning();
    return row;
}

async function chefe() {
    const { getDb, schema } = await modulos();
    const [user] = await getDb().insert(schema.users)
        .values({ email: `saidas-${randomUUID()}@teste.local`, passwordHash: "x" })
        .returning({ id: schema.users.id });
    usuarios.push(user.id);
    return user.id;
}

after(async () => {
    if (!banco) return;
    const { getDb, closeDb, schema } = await modulos();
    const db = getDb();
    if (medicos.length > 0) {
        const ocupacoes = await db.select({ id: schema.regulationOccupancies.id }).from(schema.regulationOccupancies)
            .where(inArray(schema.regulationOccupancies.doctorId, medicos));
        const ids = ocupacoes.map((row) => row.id);
        if (ids.length > 0) {
            await db.delete(schema.bankHoursEntries).where(inArray(schema.bankHoursEntries.regulationOccupancyId, ids));
            await db.delete(schema.auditLogs).where(inArray(schema.auditLogs.entityId, ids));
        }
        await db.delete(schema.regulationOccupancies).where(inArray(schema.regulationOccupancies.doctorId, medicos));
        await db.delete(schema.doctors).where(inArray(schema.doctors.id, medicos));
    }
    if (usuarios.length > 0) {
        await db.delete(schema.auditLogs).where(inArray(schema.auditLogs.actorUserId, usuarios));
        await db.delete(schema.users).where(inArray(schema.users.id, usuarios));
    }
    await closeDb();
});

test("sistema confirma a sugestão como a chefia confirmaria; Desfazer devolve à fila e tira do automático", { skip }, async () => {
    const { getDb, schema, board, autonomy, service } = await modulos();
    const medico = await criarMedico("JANELA");
    const occ = await ocupacao({ doctorId: medico.id, code: "2152", startedAt: ontem("07:00"), actualEndedAt: ontem("19:15") });

    const pending = (await board.listPendingDepartureConfirmations()).find((item) => item.occupancyId === occ.id);
    assert.ok(pending, "saída está na fila");
    assert.equal(pending.origin, "window");
    const assessment = autonomy.resolveDepartureAutonomy(pending);
    assert.equal(assessment.autonomy, "glance");

    assert.equal(await service.confirmDepartureBySystem({ pending, assessment, reason: "prazo" }), true);
    const confirmada = await getDb().query.regulationOccupancies.findFirst({ where: eq(schema.regulationOccupancies.id, occ.id) });
    assert.ok(confirmada?.departureConfirmedAt, "confirmada");
    assert.equal(confirmada?.departureConfirmedByUserId, null, "sem usuário: foi o sistema");
    assert.ok(autonomy.isSystemDepartureConfirmNote(confirmada?.departureConfirmedNote));
    const banco = await getDb().select().from(schema.bankHoursEntries).where(eq(schema.bankHoursEntries.regulationOccupancyId, occ.id));
    assert.equal(banco.length, 1, "confirmar libera o banco de horas, como a chefia");

    assert.ok((await service.listSystemConfirmedDepartures()).some((item) => item.occupancyId === occ.id));
    assert.equal(await service.confirmDepartureBySystem({ pending, assessment, reason: "prazo" }), false, "já confirmada: não repete");

    await service.undoSystemDepartureConfirmation({ domain: "regulation", occupancyId: occ.id, userId: await chefe() });
    const desfeita = await getDb().query.regulationOccupancies.findFirst({ where: eq(schema.regulationOccupancies.id, occ.id) });
    assert.equal(desfeita?.departureConfirmedAt, null);
    assert.equal(desfeita?.departureConfirmedNote, null);
    const bancoDepois = await getDb().select().from(schema.bankHoursEntries).where(eq(schema.bankHoursEntries.regulationOccupancyId, occ.id));
    assert.equal(bancoDepois.length, 0, "saída não confirmada volta a reter o banco");
    assert.ok((await service.listDepartureIdsUndoneByChief([occ.id])).has(occ.id), "fica com a chefia");
    await assert.rejects(
        service.undoSystemDepartureConfirmation({ domain: "regulation", occupancyId: occ.id, userId: await chefe() }),
        /já não está confirmada pelo sistema/,
    );
});

test("saída faltando ≤2h rendida por outro: sistema grava plantão inteiro; Desfazer limpa o desfecho que ele gravou", { skip }, async () => {
    const { getDb, schema, board, autonomy, service } = await modulos();
    const saiu = await criarMedico("SAIU");
    const chegou = await criarMedico("CHEGOU");
    const occ = await ocupacao({ doctorId: saiu.id, code: "2153", startedAt: ontem("07:00"), actualEndedAt: ontem("17:30") });
    await ocupacao({ doctorId: chegou.id, code: "2153", startedAt: ontem("17:30"), actualEndedAt: ontem("19:15") });

    const pending = (await board.listPendingDepartureConfirmations()).find((item) => item.occupancyId === occ.id);
    assert.ok(pending);
    assert.equal(pending.origin, "successor");
    const assessment = autonomy.resolveDepartureAutonomy(pending);
    assert.equal(assessment.triage.kind, "early_full");
    assert.equal(assessment.suggestion?.outcome, "full_shift");

    assert.equal(await service.confirmDepartureBySystem({ pending, assessment, reason: "prazo" }), true);
    const confirmada = await getDb().query.regulationOccupancies.findFirst({ where: eq(schema.regulationOccupancies.id, occ.id) });
    assert.equal(confirmada?.earlyDepartureOutcome, "full_shift");

    await service.undoSystemDepartureConfirmation({ domain: "regulation", occupancyId: occ.id, userId: await chefe() });
    const desfeita = await getDb().query.regulationOccupancies.findFirst({ where: eq(schema.regulationOccupancies.id, occ.id) });
    assert.equal(desfeita?.earlyDepartureOutcome, null);
    assert.equal(desfeita?.departureConfirmedAt, null);
});

test("chefia confirmou antes: o sistema desiste e não sobrescreve quem confirmou", { skip }, async () => {
    const { getDb, schema, board, autonomy, service } = await modulos();
    const medico = await criarMedico("CORRIDA");
    const occ = await ocupacao({ doctorId: medico.id, code: "2154", startedAt: ontem("07:00"), actualEndedAt: ontem("19:15") });

    const pending = (await board.listPendingDepartureConfirmations()).find((item) => item.occupancyId === occ.id);
    assert.ok(pending);
    const assessment = autonomy.resolveDepartureAutonomy(pending);

    // A chefia confirma entre a leitura da fila e a ação do sistema.
    const chefeId = await chefe();
    await getDb().update(schema.regulationOccupancies)
        .set({ departureConfirmedAt: new Date(), departureConfirmedByUserId: chefeId })
        .where(eq(schema.regulationOccupancies.id, occ.id));

    assert.equal(await service.confirmDepartureBySystem({ pending, assessment, reason: "prazo" }), false);
    const depois = await getDb().query.regulationOccupancies.findFirst({ where: eq(schema.regulationOccupancies.id, occ.id) });
    assert.equal(depois?.departureConfirmedByUserId, chefeId);
    assert.equal(depois?.departureConfirmedNote, null);
});

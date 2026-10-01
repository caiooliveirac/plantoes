import test, { after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { and, desc, eq, inArray } from "drizzle-orm";

/**
 * Atraso desconsiderado pela chefia, contra um Postgres de verdade: a marca
 * zera o atraso do banco (dobro no excedente, prefixo na explicação), deixa
 * evento + auditoria com o estado anterior, e o undo operacional repõe o atraso.
 *
 * SÓ roda quando DATABASE_URL aponta para um banco cujo nome termina em `_test`
 * (mesma trava de tests/retirar-desfecho-db.test.ts).
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
const medicos: string[] = [];
const usuarios: string[] = [];

async function modulos() {
    const [{ getDb, closeDb }, schema, waiver, bank, undo] = await Promise.all([
        import("@/db"),
        import("@/db/schema"),
        import("@/modules/operational/atraso-desconsiderado"),
        import("@/modules/bank-hours/service"),
        import("@/modules/operational/undo"),
    ]);
    return { getDb, closeDb, schema, waiver, bank, undo };
}

const local = (iso: string) => new Date(`${iso}-03:00`);

async function criarMedico() {
    const { getDb, schema } = await modulos();
    const sufixo = Array.from(randomBytes(8), (b) => String.fromCharCode(65 + (b % 26))).join("");
    const [doctor] = await getDb()
        .insert(schema.doctors)
        .values({ fullName: `Atraso Teste ${sufixo}`, normalizedName: `ATRASO TESTE ${sufixo}` })
        .returning({ id: schema.doctors.id });
    medicos.push(doctor.id);
    return doctor;
}

async function criarChefe() {
    const { getDb, schema } = await modulos();
    const [user] = await getDb()
        .insert(schema.users)
        .values({ email: `atraso-teste-${randomUUID()}@samu.local`, passwordHash: "x" })
        .returning({ id: schema.users.id });
    usuarios.push(user.id);
    return user;
}

after(async () => {
    if (!banco) return;
    const { getDb, closeDb, schema } = await modulos();
    const db = getDb();
    if (medicos.length > 0) {
        const ocupacoes = (await db.select({ id: schema.regulationOccupancies.id }).from(schema.regulationOccupancies)
            .where(inArray(schema.regulationOccupancies.doctorId, medicos))).map((row) => row.id);
        if (ocupacoes.length > 0) {
            await db.delete(schema.bankHoursEntries).where(inArray(schema.bankHoursEntries.regulationOccupancyId, ocupacoes));
            await db.delete(schema.shiftEvents).where(inArray(schema.shiftEvents.entityId, ocupacoes));
            // audit_logs.entity_id é varchar: lista de strings, não subquery uuid.
            await db.delete(schema.auditLogs).where(inArray(schema.auditLogs.entityId, ocupacoes));
        }
        await db.delete(schema.regulationOccupancies).where(inArray(schema.regulationOccupancies.doctorId, medicos));
        await db.delete(schema.doctors).where(inArray(schema.doctors.id, medicos));
    }
    if (usuarios.length > 0) {
        await db.delete(schema.users).where(inArray(schema.users.id, usuarios));
    }
    await closeDb();
});

test("marcar o atraso como desconsiderado zera o débito, audita e o undo repõe os 30 min", { skip }, async () => {
    const { getDb, schema, waiver, bank, undo } = await modulos();
    const db = getDb();
    const medico = await criarMedico();
    const chefe = await criarChefe();
    const post = await db.query.regulationPosts.findFirst({ where: eq(schema.regulationPosts.code, "2034") });
    assert.ok(post, "ramal 2034 existe");

    // SD com 30 min de atraso e 75 min de excedente (o fim previsto 19:15 recua
    // para 19:00 no banco), janela fechada e saída confirmada.
    const [ocupacao] = await db.insert(schema.regulationOccupancies).values({
        doctorId: medico.id,
        continuityGroupId: randomUUID(),
        postId: post.id,
        scheduledStartAt: local("2026-02-11T07:00"),
        scheduledEndAt: local("2026-02-11T19:15"),
        startedAt: local("2026-02-11T07:30"),
        boardStartedAt: local("2026-02-11T07:30"),
        endedAt: local("2026-02-11T20:15"),
        actualEndedAt: local("2026-02-11T20:15"),
        departureConfirmedAt: local("2026-02-11T20:16"),
        departureConfirmedByUserId: chefe.id,
        shiftLabel: "SD",
        ramalLabel: "2034",
        source: "telegram",
    }).returning();

    const entradaDe = async () => {
        const rows = await db.select().from(schema.bankHoursEntries)
            .where(eq(schema.bankHoursEntries.regulationOccupancyId, ocupacao.id));
        assert.equal(rows.length, 1, "uma entrada de banco por ocupação");
        return rows[0]!;
    };

    await bank.syncRegulationBankHours(db, ocupacao.id);
    const antes = await entradaDe();
    assert.equal(antes.arrivalDelayMinutes, 30);
    assert.equal(antes.overtimeMultiplier, 1);
    assert.equal(antes.overtimeMinutes, 75);
    assert.equal(antes.balanceMinutes, 75 - 30);

    // Marca.
    const { previous } = await waiver.setArrivalDelayWaiver(db, {
        domain: "regulation",
        occupancyId: ocupacao.id,
        waived: true,
        note: "Avisou antes da chegada",
        actorUserId: chefe.id,
    });
    assert.deepEqual(previous, { waivedAt: null, byUserId: null, note: null });

    const marcada = await db.query.regulationOccupancies.findFirst({ where: eq(schema.regulationOccupancies.id, ocupacao.id) });
    assert.ok(marcada?.arrivalDelayWaivedAt, "waivedAt gravado");
    assert.equal(marcada?.arrivalDelayWaivedByUserId, chefe.id);
    assert.equal(marcada?.arrivalDelayWaiverNote, "Avisou antes da chegada");
    assert.equal(marcada?.startedAt.getTime(), local("2026-02-11T07:30").getTime(), "startedAt não muda");

    const depois = await entradaDe();
    assert.equal(depois.arrivalDelayMinutes, 0);
    assert.equal(depois.overtimeMultiplier, 2);
    assert.equal(depois.creditedOvertimeMinutes, 150);
    assert.equal(depois.balanceMinutes, 150);
    assert.equal(depois.ruleCode, "ON_TIME_DOUBLE_OVERTIME");
    assert.ok(depois.explanation.startsWith("Atraso de 30 min desconsiderado pela chefia. "), depois.explanation);

    const evento = await db.query.shiftEvents.findFirst({
        where: and(eq(schema.shiftEvents.entityId, ocupacao.id), eq(schema.shiftEvents.eventType, "regulation_occupancy.arrival_delay_waived")),
    });
    assert.ok(evento, "shift_events registrou a marcação");
    assert.equal((evento.payload as { doctorId: string }).doctorId, medico.id);

    const auditoria = await db.query.auditLogs.findFirst({
        where: and(eq(schema.auditLogs.entityId, ocupacao.id), eq(schema.auditLogs.action, waiver.ARRIVAL_DELAY_WAIVER_SET_ACTION)),
        orderBy: [desc(schema.auditLogs.createdAt)],
    });
    assert.ok(auditoria, "audit_logs registrou a marcação");
    assert.equal(auditoria.actorUserId, chefe.id);
    assert.deepEqual((auditoria.details as { previous: unknown }).previous, { waivedAt: null, byUserId: null, note: null });

    // Undo: aparece na lista do próprio chefe e, desfeito, repõe os 30 min.
    const listadas = await undo.getUndoableActions(chefe.id);
    assert.ok(listadas.some((entry) => entry.auditLogId === auditoria.id), "marcação aparece como desfazível");

    const resultado = await undo.undoAction(auditoria.id, chefe.id, "marquei a ocupação errada");
    assert.equal(resultado.success, true, resultado.message);

    const restaurada = await db.query.regulationOccupancies.findFirst({ where: eq(schema.regulationOccupancies.id, ocupacao.id) });
    assert.equal(restaurada?.arrivalDelayWaivedAt, null);
    assert.equal(restaurada?.arrivalDelayWaivedByUserId, null);
    assert.equal(restaurada?.arrivalDelayWaiverNote, null);

    const final = await entradaDe();
    assert.equal(final.arrivalDelayMinutes, 30);
    assert.equal(final.overtimeMultiplier, 1);
    assert.equal(final.balanceMinutes, 45);

    const desfeita = await db.query.auditLogs.findFirst({
        where: and(eq(schema.auditLogs.entityId, ocupacao.id), eq(schema.auditLogs.action, `${waiver.ARRIVAL_DELAY_WAIVER_SET_ACTION}.undone`)),
    });
    assert.ok(desfeita, "undo deixou o rastro .undone");
});

test("remover a marca grava o anterior e o undo devolve a marca", { skip }, async () => {
    const { getDb, schema, waiver, undo } = await modulos();
    const db = getDb();
    const medico = await criarMedico();
    const chefe = await criarChefe();
    const post = await db.query.regulationPosts.findFirst({ where: eq(schema.regulationPosts.code, "2034") });
    assert.ok(post);

    const [ocupacao] = await db.insert(schema.regulationOccupancies).values({
        doctorId: medico.id,
        continuityGroupId: randomUUID(),
        postId: post.id,
        scheduledStartAt: local("2026-02-12T07:00"),
        scheduledEndAt: local("2026-02-12T19:15"),
        startedAt: local("2026-02-12T07:45"),
        boardStartedAt: local("2026-02-12T07:45"),
        endedAt: local("2026-02-12T19:15"),
        actualEndedAt: local("2026-02-12T19:15"),
        departureConfirmedAt: local("2026-02-12T19:16"),
        departureConfirmedByUserId: chefe.id,
        shiftLabel: "SD",
        ramalLabel: "2034",
        source: "telegram",
    }).returning();

    await waiver.setArrivalDelayWaiver(db, {
        domain: "regulation", occupancyId: ocupacao.id, waived: true, note: "Trânsito, avisou no grupo", actorUserId: chefe.id,
    });
    const { previous } = await waiver.setArrivalDelayWaiver(db, {
        domain: "regulation", occupancyId: ocupacao.id, waived: false, note: null, actorUserId: chefe.id,
    });
    assert.ok(previous.waivedAt, "anterior guarda quando foi marcada");
    assert.equal(previous.byUserId, chefe.id);
    assert.equal(previous.note, "Trânsito, avisou no grupo");

    const [entrada] = await db.select().from(schema.bankHoursEntries).where(eq(schema.bankHoursEntries.regulationOccupancyId, ocupacao.id));
    assert.equal(entrada?.arrivalDelayMinutes, 45, "sem a marca o atraso volta");

    const remocao = await db.query.auditLogs.findFirst({
        where: and(eq(schema.auditLogs.entityId, ocupacao.id), eq(schema.auditLogs.action, waiver.ARRIVAL_DELAY_WAIVER_REMOVED_ACTION)),
    });
    assert.ok(remocao);
    const resultado = await undo.undoAction(remocao.id, chefe.id, "era para manter");
    assert.equal(resultado.success, true, resultado.message);

    const devolvida = await db.query.regulationOccupancies.findFirst({ where: eq(schema.regulationOccupancies.id, ocupacao.id) });
    assert.equal(devolvida?.arrivalDelayWaivedAt?.toISOString(), previous.waivedAt);
    assert.equal(devolvida?.arrivalDelayWaiverNote, "Trânsito, avisou no grupo");
    const [reentrada] = await db.select().from(schema.bankHoursEntries).where(eq(schema.bankHoursEntries.regulationOccupancyId, ocupacao.id));
    assert.equal(reentrada?.arrivalDelayMinutes, 0);
});

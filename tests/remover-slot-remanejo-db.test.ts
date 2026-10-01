import test, { after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";

/**
 * Remover um slot no fechamento, contra um Postgres de verdade.
 *
 * Regra: remover tira SÓ a célula clicada (um turno, um alvo).
 *
 * Caso real (Gustavo, 2032, 28/09/2026): a perna de remanejo nasce com
 * `source = admin_correction` (corrections.ts). A remoção apagava a linha
 * inteira para essa origem — tirar o SN levava junto o SD trabalhado. E quando
 * o SN removido era o PRIMEIRO turno de um P (SN + SD seguinte), a ocupação era
 * zerada e o SD do dia seguinte ia junto.
 *
 * SÓ roda quando DATABASE_URL aponta para um banco cujo nome termina em
 * `_test` (mesma trava de tests/madrugada-db.test.ts).
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
    const [{ getDb, closeDb }, schema, attestation, payable] = await Promise.all([
        import("@/db"),
        import("@/db/schema"),
        import("@/services/payment-attestation.service"),
        import("@/services/payable-shifts.service"),
    ]);
    return { getDb, closeDb, schema, attestation, payable };
}

const sufixo = () => Array.from(randomBytes(8), (b) => String.fromCharCode(65 + (b % 26))).join("");
const local = (iso: string) => new Date(`${iso}-03:00`);

after(async () => {
    if (!banco) return;
    const { getDb, closeDb, schema } = await modulos();
    const db = getDb();
    if (medicos.length > 0) {
        const ocupacoes = db.select({ id: schema.regulationOccupancies.id }).from(schema.regulationOccupancies)
            .where(inArray(schema.regulationOccupancies.doctorId, medicos));
        await db.delete(schema.bankHoursEntries).where(inArray(schema.bankHoursEntries.regulationOccupancyId, ocupacoes));
        await db.delete(schema.regulationOccupancies).where(inArray(schema.regulationOccupancies.doctorId, medicos));
        await db.delete(schema.doctors).where(inArray(schema.doctors.id, medicos));
    }
    if (usuarios.length > 0) {
        await db.delete(schema.users).where(inArray(schema.users.id, usuarios));
    }
    await closeDb();
});

async function prepararMedico(rotulo: string) {
    const { getDb, schema } = await modulos();
    const db = getDb();
    const s = sufixo();
    const [doctor] = await db.insert(schema.doctors)
        .values({ fullName: `${rotulo} ${s}`, normalizedName: `REMOVER SLOT TESTE ${rotulo} ${s}` })
        .returning({ id: schema.doctors.id });
    medicos.push(doctor.id);
    const [user] = await db.insert(schema.users)
        .values({ email: `remover-slot-${s.toLowerCase()}@teste.local`, passwordHash: "x" })
        .returning({ id: schema.users.id });
    usuarios.push(user.id);
    const post = await db.query.regulationPosts.findFirst({ where: eq(schema.regulationPosts.code, "2034") });
    assert.ok(post, "ramal 2034 existe");
    return { doctorId: doctor.id, userId: user.id, postId: post.id };
}

test("remover o SN de uma perna de remanejo (admin_correction) mantém o SD trabalhado", { skip }, async () => {
    const { getDb, schema, attestation, payable } = await modulos();
    const db = getDb();
    const s = sufixo();
    const [doctor] = await db.insert(schema.doctors)
        .values({ fullName: `REMANEJO ${s}`, normalizedName: `REMOVER SLOT TESTE ${s}` })
        .returning({ id: schema.doctors.id });
    medicos.push(doctor.id);
    const [user] = await db.insert(schema.users)
        .values({ email: `remover-slot-${s.toLowerCase()}@teste.local`, passwordHash: "x" })
        .returning({ id: schema.users.id });
    usuarios.push(user.id);

    const post = await db.query.regulationPosts.findFirst({ where: eq(schema.regulationPosts.code, "2034") });
    assert.ok(post, "ramal 2034 existe");

    // Remanejado para a 2034 às 08:39 num P de 24h (SD+SN) e ficou até 21:00.
    const [perna] = await db.insert(schema.regulationOccupancies).values({
        doctorId: doctor.id,
        continuityGroupId: randomUUID(),
        postId: post.id,
        scheduledStartAt: local("2026-03-10T07:00"),
        scheduledEndAt: local("2026-03-11T07:15"),
        startedAt: local("2026-03-10T08:39"),
        boardStartedAt: local("2026-03-10T08:39"),
        endedAt: local("2026-03-10T21:00"),
        actualEndedAt: local("2026-03-10T21:00"),
        shiftLabel: "P",
        ramalLabel: "2034",
        source: "admin_correction",
        notes: "Remanejado de 2035 para 2034.",
    }).returning();

    const turnosAntes = await payable.getChiefPayableShiftsBoard("2026-03");
    const doMedico = (board: typeof turnosAntes) => board.doctors.find((row) => row.doctorId === doctor.id)?.total ?? 0;
    assert.equal(doMedico(turnosAntes), 2, "antes da remoção: SD e SN do dia 10");

    await attestation.applyManualRemoveAssignment({
        operationalDate: "2026-03-10",
        shiftLabel: "SN",
        domain: "regulation",
        targetCode: "2034",
        occupancyId: perna.id,
        actorUserId: user.id,
    });

    const depois = await db.query.regulationOccupancies.findFirst({ where: eq(schema.regulationOccupancies.id, perna.id) });
    assert.ok(depois, "a perna do remanejo não pode ser apagada");
    assert.equal(depois.actualEndedAt?.toISOString(), local("2026-03-10T19:00").toISOString(), "recortada no início do SN");

    const turnosDepois = await payable.getChiefPayableShiftsBoard("2026-03");
    assert.equal(doMedico(turnosDepois), 1, "o SD trabalhado continua pago");
});

test("remover o SN que abre um P (SN + SD seguinte) mantém o SD do dia seguinte", { skip }, async () => {
    const { getDb, schema, attestation, payable } = await modulos();
    const db = getDb();
    const { doctorId, userId, postId } = await prepararMedico("NOITE-DIA");

    const [plantao] = await db.insert(schema.regulationOccupancies).values({
        doctorId,
        continuityGroupId: randomUUID(),
        postId,
        scheduledStartAt: local("2026-03-14T19:00"),
        scheduledEndAt: local("2026-03-15T19:15"),
        startedAt: local("2026-03-14T18:55"),
        boardStartedAt: local("2026-03-14T18:55"),
        endedAt: local("2026-03-15T19:10"),
        actualEndedAt: local("2026-03-15T19:10"),
        shiftLabel: "P",
        ramalLabel: "2034",
        source: "telegram",
        notes: "2034 SN\ncontinua 2034 SD",
    }).returning();

    const total = async () => (await payable.getChiefPayableShiftsBoard("2026-03")).doctors
        .find((row) => row.doctorId === doctorId)?.total ?? 0;
    assert.equal(await total(), 2, "antes: SN 14 e SD 15");

    await attestation.applyManualRemoveAssignment({
        operationalDate: "2026-03-14",
        shiftLabel: "SN",
        domain: "regulation",
        targetCode: "2034",
        occupancyId: plantao.id,
        actorUserId: userId,
    });

    const depois = await db.query.regulationOccupancies.findFirst({ where: eq(schema.regulationOccupancies.id, plantao.id) });
    assert.equal(depois?.startedAt.toISOString(), local("2026-03-15T07:00").toISOString(), "passa a começar no SD");
    assert.equal(depois?.actualEndedAt?.toISOString(), local("2026-03-15T19:10").toISOString(), "a saída do SD não muda");
    assert.equal(await total(), 1, "só o SN saiu; o SD 15 continua pago");
});

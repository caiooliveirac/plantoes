import test, { after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";

/**
 * Retirar com desfecho escolhido pela chefia, contra um Postgres de verdade.
 *
 * Caso real (1362, 29/09/2026): quem veio cobrir a madrugada antes de existir
 * o comando declarou "SD" às 03:17 e ficou com uma ocupação SD aberta; às 07:02
 * o titular do dia chegou e ela virou deslocada. Deslocado segue pago — sem
 * retirar, eram dois SD pagos no mesmo ramal. "Remover sem saldo" tem de zerar
 * pagamento e banco dela sem tocar em quem ficou.
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

async function modulos() {
    const [{ getDb, closeDb }, schema, regulation, payable] = await Promise.all([
        import("@/db"),
        import("@/db/schema"),
        import("@/modules/regulation/service"),
        import("@/services/payable-shifts.service"),
    ]);
    return { getDb, closeDb, schema, regulation, payable };
}

async function criarMedico(nome: string) {
    const { getDb, schema } = await modulos();
    const sufixo = Array.from(randomBytes(8), (b) => String.fromCharCode(65 + (b % 26))).join("");
    const [doctor] = await getDb()
        .insert(schema.doctors)
        .values({ fullName: `${nome} ${sufixo}`, normalizedName: `RETIRAR TESTE ${nome} ${sufixo}` })
        .returning({ id: schema.doctors.id });
    medicos.push(doctor.id);
    return doctor;
}

const local = (iso: string) => new Date(`${iso}-03:00`);

async function ocupacao(values: {
    doctorId: string;
    shiftLabel: "SD" | "SN";
    scheduledStartAt: string;
    scheduledEndAt: string;
    startedAt: string;
    boardStartedAt: string | null;
    endedAt?: string;
    notes?: string;
}) {
    const { getDb, schema } = await modulos();
    const post = await getDb().query.regulationPosts.findFirst({ where: eq(schema.regulationPosts.code, "2034") });
    assert.ok(post, "ramal 2034 existe");
    const [row] = await getDb().insert(schema.regulationOccupancies).values({
        doctorId: values.doctorId,
        continuityGroupId: randomUUID(),
        postId: post.id,
        scheduledStartAt: local(values.scheduledStartAt),
        scheduledEndAt: local(values.scheduledEndAt),
        startedAt: local(values.startedAt),
        boardStartedAt: values.boardStartedAt ? local(values.boardStartedAt) : null,
        endedAt: values.endedAt ? local(values.endedAt) : null,
        actualEndedAt: values.endedAt ? local(values.endedAt) : null,
        shiftLabel: values.shiftLabel,
        ramalLabel: "2034",
        source: "telegram",
        notes: values.notes ?? null,
    }).returning();
    return row;
}

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
    await closeDb();
});

test("retirar sem saldo: deslocada que nem estava no plantão sai sem pagamento e sem banco; o titular segue pago", { skip }, async () => {
    const { getDb, schema, regulation, payable } = await modulos();
    const noite = await criarMedico("NOITE");
    const madrugada = await criarMedico("MADRUGADA");
    const dia = await criarMedico("DIA");

    await ocupacao({
        doctorId: noite.id, shiftLabel: "SN",
        scheduledStartAt: "2026-02-10T19:00", scheduledEndAt: "2026-02-11T07:15",
        startedAt: "2026-02-10T18:57", boardStartedAt: null, endedAt: "2026-02-11T07:15",
        notes: "[DESLOCADO] por quem cobriu a madrugada",
    });
    const deslocada = await ocupacao({
        doctorId: madrugada.id, shiftLabel: "SD",
        scheduledStartAt: "2026-02-11T07:00", scheduledEndAt: "2026-02-11T19:15",
        startedAt: "2026-02-11T03:17", boardStartedAt: null,
        notes: "[DESLOCADO] por quem chegou para o dia",
    });
    await ocupacao({
        doctorId: dia.id, shiftLabel: "SD",
        scheduledStartAt: "2026-02-11T07:00", scheduledEndAt: "2026-02-11T19:15",
        startedAt: "2026-02-11T07:02", boardStartedAt: "2026-02-11T07:02", endedAt: "2026-02-11T19:15",
    });

    // Pagar acima da régua (meio, com a régua dizendo só banco) sem justificativa
    // é recusado e não fecha nada.
    await assert.rejects(
        regulation.endRegulationOccupancy(deslocada.id, {
            endedAt: local("2026-02-11T07:02"),
            actualEndedAt: local("2026-02-11T07:02"),
            chiefConfirmed: true,
            chiefWithdrawal: true,
            chiefOutcome: "half_shift",
        }),
        /justificativa/,
    );
    const intacta = await getDb().query.regulationOccupancies.findFirst({ where: eq(schema.regulationOccupancies.id, deslocada.id) });
    assert.equal(intacta?.endedAt, null, "recusa não fecha a ocupação");

    const retirada = await regulation.endRegulationOccupancy(deslocada.id, {
        endedAt: local("2026-02-11T07:02"),
        actualEndedAt: local("2026-02-11T07:02"),
        chiefConfirmed: true,
        chiefWithdrawal: true,
        chiefOutcome: "no_balance",
    });
    assert.equal(retirada.earlyDepartureOutcome, "no_balance");

    const entradas = await getDb().select().from(schema.bankHoursEntries)
        .where(eq(schema.bankHoursEntries.regulationOccupancyId, deslocada.id));
    assert.ok(entradas.every((entry) => entry.balanceMinutes === 0), "sem saldo não gera banco");

    const mensal = await payable.getChiefPayableShiftsBoard("2026-02");
    const totalDe = (doctorId: string) => mensal.doctors.find((doctor) => doctor.doctorId === doctorId)?.total ?? 0;
    assert.equal(totalDe(madrugada.id), 0, "retirada sem saldo não recebe");
    assert.equal(totalDe(dia.id), 1, "titular do dia segue com o plantão inteiro");
    assert.equal(totalDe(noite.id), 1, "quem foi coberto na madrugada não perde o SN");
});

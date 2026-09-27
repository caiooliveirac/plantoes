import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { sql } from "drizzle-orm";
import { closeDb, getDb } from "@/db";
import {
    canDeclareChiefExtraShift,
    createChiefExtraShift,
    deleteChiefExtraShift,
    loadChiefExtraShifts,
    updateChiefExtraShift,
} from "@/services/chief-extra-shifts.service";

/**
 * Caracterização do services/chief-extra-shifts.service.ts (plantão extra de
 * chefia, pago como extra: 'chief' = 1 unidade, 'chief_half' = 0,5) contra um
 * Postgres de verdade. Cada linha aqui vira dinheiro no fechamento, então o
 * foco é: um por dia+turno, e o médico só mexe no que é dele, de chefia, no mês.
 *
 * Mesma trava do tests/payable-shifts-service: só roda com DATABASE_URL de um
 * banco de teste (nome contém "test") e apaga o que gravou. Testes `todo`
 * descrevem comportamento esperado que o service ainda não cumpre.
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

const MONTH = "2026-05";
const tag = randomUUID().slice(0, 8);
const doctorIds: string[] = [];

async function insertDoctor(name: string) {
    const id = randomUUID();
    doctorIds.push(id);
    const fullName = `${name} ${tag}`;
    await getDb().execute(sql`
        insert into operations_v2.doctors (id, full_name, normalized_name)
        values (${id}, ${fullName}, ${fullName.toUpperCase()})
    `);
    return id;
}

async function countChiefExtras(doctorId: string) {
    const rows = await getDb().execute(sql`
        select kind, unit from operations_v2.admin_extra_shifts where doctor_id = ${doctorId} order by operational_date, shift_label
    `) as unknown as Array<{ kind: string; unit: number }>;
    return rows.map((row) => `${row.kind}:${row.unit}`);
}

let chefe = "";
let outro = "";

before(async () => {
    if (skip) return;
    chefe = await insertDoctor("Chefe Extra");
    outro = await insertDoctor("Outro Extra");
});

after(async () => {
    if (skip) return;
    const db = getDb();
    await db.execute(sql`delete from operations_v2.admin_extra_shifts where doctor_id in ${doctorIds}`);
    await db.execute(sql`delete from operations_v2.regulation_occupancies where doctor_id in ${doctorIds}`);
    await db.execute(sql`delete from operations_v2.doctors where id in ${doctorIds}`);
    await closeDb();
});

test("quem pode declarar: só quem já ocupou a 2031 (ou está na allowlist)", { skip }, async () => {
    const ramal = await insertDoctor("Ramal 2031");
    assert.equal(await canDeclareChiefExtraShift(ramal), false);
    assert.equal(await canDeclareChiefExtraShift(randomUUID()), false);

    await getDb().execute(sql`
        insert into operations_v2.regulation_occupancies (
            doctor_id, post_id, scheduled_start_at, scheduled_end_at, started_at, board_started_at, ended_at,
            actual_ended_at, shift_label, source, continuity_group_id
        )
        select ${ramal}, rp.id, '2019-03-01T10:00:00Z', '2019-03-01T22:00:00Z', '2019-03-01T10:00:00Z',
            '2019-03-01T10:00:00Z', '2019-03-01T22:00:00Z', '2019-03-01T22:00:00Z', 'SD', 'telegram', ${randomUUID()}
        from operations_v2.regulation_posts rp where rp.code = '2031'
    `);
    assert.equal(await canDeclareChiefExtraShift(ramal), true);
});

test("criar: inteiro vale 1 unidade 'chief', meio vale 'chief_half' (unit continua 1)", { skip }, async () => {
    const full = await createChiefExtraShift({
        doctorId: chefe, operationalDate: `${MONTH}-10`, shiftLabel: "SD", coverage: "full", actorUserId: null,
    });
    const half = await createChiefExtraShift({
        doctorId: chefe, operationalDate: `${MONTH}-03`, shiftLabel: "SN", coverage: "half", actorUserId: null,
    });
    assert.equal(full.coverage, "full");
    assert.equal(half.coverage, "half");

    const listed = await loadChiefExtraShifts(chefe, MONTH);
    assert.deepEqual(
        listed.map((row) => `${row.operationalDate} ${row.shiftLabel} ${row.coverage}`),
        [`${MONTH}-03 SN half`, `${MONTH}-10 SD full`],
        "ordenado por data",
    );
    assert.deepEqual(await countChiefExtras(chefe), ["chief_half:1", "chief:1"]);
    assert.deepEqual(await loadChiefExtraShifts(chefe, "2026-06"), [], "outro mês não aparece");
});

test("criar: um por dia+turno — inteiro ou meio, duplo clique cai no erro", { skip }, async () => {
    await assert.rejects(
        createChiefExtraShift({ doctorId: chefe, operationalDate: `${MONTH}-10`, shiftLabel: "SD", coverage: "full", actorUserId: null }),
        /já têm um plantão de chefia/,
    );
    await assert.rejects(
        createChiefExtraShift({ doctorId: chefe, operationalDate: `${MONTH}-10`, shiftLabel: "SD", coverage: "half", actorUserId: null }),
        /já têm um plantão de chefia/,
    );
    // Outro turno no mesmo dia, e outro médico no mesmo turno, podem.
    await createChiefExtraShift({ doctorId: chefe, operationalDate: `${MONTH}-10`, shiftLabel: "SN", coverage: "full", actorUserId: null });
    await createChiefExtraShift({ doctorId: outro, operationalDate: `${MONTH}-10`, shiftLabel: "SD", coverage: "full", actorUserId: null });
    await assert.rejects(
        createChiefExtraShift({ doctorId: randomUUID(), operationalDate: `${MONTH}-10`, shiftLabel: "SD", coverage: "full", actorUserId: null }),
        /Médico não encontrado/,
    );
});

test("criar: extra comum (verde do admin) no mesmo turno não bloqueia o de chefia", { skip }, async () => {
    await getDb().execute(sql`
        insert into operations_v2.admin_extra_shifts (doctor_id, operational_date, shift_label, kind, unit)
        values (${outro}, ${`${MONTH}-20`}::date, 'SD', 'extra', 1)
    `);
    const chief = await createChiefExtraShift({
        doctorId: outro, operationalDate: `${MONTH}-20`, shiftLabel: "SD", coverage: "full", actorUserId: null,
    });
    assert.equal(chief.coverage, "full");
});

test("alterar: troca dia/turno, mantém inteiro/meio quando omitido e troca quando informado", { skip }, async () => {
    const row = await createChiefExtraShift({
        doctorId: chefe, operationalDate: `${MONTH}-05`, shiftLabel: "SD", coverage: "half", actorUserId: null,
    });
    assert.deepEqual(
        await updateChiefExtraShift({ id: row.id, doctorId: chefe, monthKey: MONTH, operationalDate: `${MONTH}-06`, shiftLabel: "SN" }),
        { coverage: "half" },
    );
    assert.deepEqual(
        await updateChiefExtraShift({ id: row.id, doctorId: chefe, monthKey: MONTH, operationalDate: `${MONTH}-06`, shiftLabel: "SN", coverage: "full" }),
        { coverage: "full" },
    );
    const moved = (await loadChiefExtraShifts(chefe, MONTH)).find((item) => item.id === row.id);
    assert.equal(`${moved?.operationalDate} ${moved?.shiftLabel} ${moved?.coverage}`, `${MONTH}-06 SN full`);
});

test("alterar/remover: só o próprio plantão de chefia, dentro do mês informado", { skip }, async () => {
    const row = await createChiefExtraShift({
        doctorId: chefe, operationalDate: `${MONTH}-07`, shiftLabel: "SD", coverage: "full", actorUserId: null,
    });
    const base = { id: row.id, doctorId: chefe, monthKey: MONTH, operationalDate: `${MONTH}-08`, shiftLabel: "SD" as const };

    await assert.rejects(updateChiefExtraShift({ ...base, doctorId: outro }), /não pode mais ser alterado/);
    await assert.rejects(updateChiefExtraShift({ ...base, monthKey: "2026-06" }), /não pode mais ser alterado/);
    await assert.rejects(deleteChiefExtraShift({ id: row.id, doctorId: outro, monthKey: MONTH }), /não pode mais ser removido/);
    await assert.rejects(deleteChiefExtraShift({ id: row.id, doctorId: chefe, monthKey: "2026-04" }), /não pode mais ser removido/);

    // Extra comum do coordenador não é mexível por aqui, nem sendo do próprio médico.
    const [plain] = await getDb().execute(sql`
        insert into operations_v2.admin_extra_shifts (doctor_id, operational_date, shift_label, kind, unit)
        values (${chefe}, ${`${MONTH}-25`}::date, 'SD', 'extra', 1) returning id
    `) as unknown as Array<{ id: string }>;
    await assert.rejects(updateChiefExtraShift({ ...base, id: plain!.id }), /não pode mais ser alterado/);
    await assert.rejects(deleteChiefExtraShift({ id: plain!.id, doctorId: chefe, monthKey: MONTH }), /não pode mais ser removido/);

    const removed = await deleteChiefExtraShift({ id: row.id, doctorId: chefe, monthKey: MONTH });
    assert.equal(`${removed.operationalDate} ${removed.shiftLabel} ${removed.coverage}`, `${MONTH}-07 SD full`);
    assert.ok(!(await loadChiefExtraShifts(chefe, MONTH)).some((item) => item.id === row.id));
    await assert.rejects(deleteChiefExtraShift({ id: row.id, doctorId: chefe, monthKey: MONTH }), /não pode mais ser removido/);
});

test("alterar: mover para dia+turno que já tem plantão de chefia é recusado", {
    skip,
    todo: "updateChiefExtraShift não repete a checagem de duplicata do create: dois plantões de chefia no mesmo dia+turno (pagamento em dobro)",
}, async () => {
    await createChiefExtraShift({ doctorId: chefe, operationalDate: `${MONTH}-12`, shiftLabel: "SD", coverage: "full", actorUserId: null });
    const other = await createChiefExtraShift({
        doctorId: chefe, operationalDate: `${MONTH}-13`, shiftLabel: "SD", coverage: "full", actorUserId: null,
    });
    await assert.rejects(
        updateChiefExtraShift({ id: other.id, doctorId: chefe, monthKey: MONTH, operationalDate: `${MONTH}-12`, shiftLabel: "SD" }),
    );
});

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { sql } from "drizzle-orm";
import { closeDb, getDb } from "@/db";
import {
    createMonthlyBreakdownLoader,
    getDoctorMonthlyPayableBreakdown,
    getPayableAllocationBoardsForRange,
    loadChiefPayableBoardCore,
    loadChiefPayableFinancials,
} from "@/services/payable-shifts.service";
import { resolveMonthlyReportRange } from "@/modules/reporting/monthly-report";
import type { ChiefPayableBoardModel, DoctorFinancialExtras } from "@/modules/reporting/payable-shifts";

/**
 * Caracterização do services/payable-shifts.service.ts contra um Postgres de
 * verdade (as mesmas migrations do CI). As regras puras já têm teste em
 * tests/payable-shifts.test.ts; aqui o alvo é o que só existe no service: as
 * consultas (janela ±1 dia, residente fora, extras do admin, contrato legado)
 * e a soma em centavos por mês. Fixa o comportamento ATUAL — mudar um número
 * aqui é mudar quanto alguém recebe.
 *
 * Só roda com DATABASE_URL de um banco de teste (nome contém "test"): o arquivo
 * grava médicos e ocupações e apaga o que gravou no fim.
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

const MONTH = "2026-04";
const tag = randomUUID().slice(0, 8);
const doctorIds: string[] = [];

async function insertDoctor(name: string, metadata: Record<string, unknown> = {}) {
    const id = randomUUID();
    doctorIds.push(id);
    const fullName = `${name} ${tag}`;
    await getDb().execute(sql`
        insert into operations_v2.doctors (id, full_name, normalized_name, metadata)
        values (${id}, ${fullName}, ${fullName.toLowerCase()}, ${JSON.stringify(metadata)}::jsonb)
    `);
    return id;
}

async function insertIntervention(params: {
    doctorId: string;
    baseCode: string;
    startedAt: string;
    endedAt: string;
    shiftLabel: "SD" | "SN" | "P";
    continuityGroupId?: string;
    earlyDepartureOutcome?: string | null;
    roleLabel?: string | null;
}) {
    await getDb().execute(sql`
        insert into operations_v2.intervention_occupancies (
            doctor_id, base_id, scheduled_start_at, scheduled_end_at, started_at, board_started_at, ended_at,
            actual_ended_at, shift_label, role_label, source, continuity_group_id, early_departure_outcome
        )
        select ${params.doctorId}, ib.id, ${params.startedAt}::timestamptz, ${params.endedAt}::timestamptz,
            ${params.startedAt}::timestamptz, ${params.startedAt}::timestamptz, ${params.endedAt}::timestamptz, ${params.endedAt}::timestamptz,
            ${params.shiftLabel}, ${params.roleLabel ?? null}, 'telegram',
            ${params.continuityGroupId ?? randomUUID()}, ${params.earlyDepartureOutcome ?? null}
        from operations_v2.intervention_bases ib where ib.code = ${params.baseCode}
    `);
}

async function insertRegulation(params: {
    doctorId: string;
    postCode: string;
    startedAt: string;
    endedAt: string;
    scheduledStartAt?: string;
    scheduledEndAt?: string;
    shiftLabel: "SD" | "SN" | "P";
    roleLabel?: string | null;
}) {
    await getDb().execute(sql`
        insert into operations_v2.regulation_occupancies (
            doctor_id, post_id, scheduled_start_at, scheduled_end_at, started_at, board_started_at, ended_at,
            actual_ended_at, shift_label, role_label, source, continuity_group_id
        )
        select ${params.doctorId}, rp.id, ${params.scheduledStartAt ?? params.startedAt}::timestamptz,
            ${params.scheduledEndAt ?? params.endedAt}::timestamptz,
            ${params.startedAt}::timestamptz, ${params.startedAt}::timestamptz, ${params.endedAt}::timestamptz, ${params.endedAt}::timestamptz,
            ${params.shiftLabel}, ${params.roleLabel ?? null}, 'telegram', ${randomUUID()}
        from operations_v2.regulation_posts rp where rp.code = ${params.postCode}
    `);
}

async function insertExtra(doctorId: string, operationalDate: string, shiftLabel: "SD" | "SN", kind: string, unit: number) {
    await getDb().execute(sql`
        insert into operations_v2.admin_extra_shifts (doctor_id, operational_date, shift_label, kind, unit)
        values (${doctorId}, ${operationalDate}::date, ${shiftLabel}, ${kind}, ${unit})
    `);
}

const ids: Record<string, string> = {};
const deactivationNote = `teste payable-shifts ${tag}`;
let breakdown: Awaited<ReturnType<typeof getDoctorMonthlyPayableBreakdown>>;
let board: ChiefPayableBoardModel;
let financials: Record<string, DoctorFinancialExtras>;

// Tarifas (centavos) de modules/reporting/payable-shifts.ts, repetidas aqui de
// propósito: se a tabela mudar, este teste tem de ser atualizado conscientemente.
const GENERALISTA_UTIL = 124487;
const GENERALISTA_FDS = 138110;
const ESPECIALISTA_FDS = 145715;

function april(doctor: string) {
    return breakdown.get(ids[doctor]!)?.get(MONTH);
}

function shiftsOf(doctor: string) {
    return board.payableShifts
        .filter((shift) => shift.doctorId === ids[doctor])
        .map((shift) => `${shift.operationalDate} ${shift.shiftLabel} ${shift.tagCode} ${shift.paymentUnit}${shift.paymentTag ? ` ${shift.paymentTag}` : ""}`);
}

function rowOf(doctor: string) {
    return board.doctors.find((row) => row.doctorId === ids[doctor]);
}

before(async () => {
    if (skip) return;
    ids.ana = await insertDoctor("Ana Generalista");
    ids.bruno = await insertDoctor("Bruno Especialista", { isPaymentSpecialist: true });
    ids.carla = await insertDoctor("Carla Continuidade");
    ids.davi = await insertDoctor("Davi Meio Plantao");
    ids.eva = await insertDoctor("Eva Virada");
    ids.fabio = await insertDoctor("Fabio Estatutario", { employmentType: "estatutario" });
    ids.gil = await insertDoctor("Gil Residente", { isResidente: true });
    ids.hugo = await insertDoctor("Hugo Retirada");
    ids.iris = await insertDoctor("Iris Feriado");
    ids.jonas = await insertDoctor("Jonas Extra Virada");

    // Ana: SD inteiro numa terça (07:00–19:00 locais) + extra verde + punição.
    await insertIntervention({ doctorId: ids.ana, baseCode: "SM01", startedAt: "2026-04-07T10:00:00.000Z", endedAt: "2026-04-07T22:00:00.000Z", shiftLabel: "SD" });
    await insertExtra(ids.ana, "2026-04-08", "SD", "extra", 1);
    await insertExtra(ids.ana, "2026-04-11", "SN", "penalty", -1);

    // Bruno: P de 24h num sábado.
    await insertIntervention({ doctorId: ids.bruno, baseCode: "CB02", startedAt: "2026-04-11T10:00:00.000Z", endedAt: "2026-04-12T10:00:00.000Z", shiftLabel: "P" });

    // Carla: SD + continuação SN no mesmo grupo de continuidade (quarta).
    const carlaGroup = randomUUID();
    await insertIntervention({ doctorId: ids.carla, baseCode: "PR03", startedAt: "2026-04-08T10:00:00.000Z", endedAt: "2026-04-08T22:00:00.000Z", shiftLabel: "SD", continuityGroupId: carlaGroup });
    await insertIntervention({ doctorId: ids.carla, baseCode: "PR03", startedAt: "2026-04-08T22:00:00.000Z", endedAt: "2026-04-09T10:00:00.000Z", shiftLabel: "SN", continuityGroupId: carlaGroup });

    // Davi: meio plantão (11:30–17:00) na regulação, quinta.
    await insertRegulation({ doctorId: ids.davi, postCode: "1326", startedAt: "2026-04-09T14:30:00.000Z", endedAt: "2026-04-09T20:00:00.000Z", shiftLabel: "SD", roleLabel: "MEIO_PLANTAO" });

    // Eva: SN que entra no mês (31/03 → 01/04) e SN que sai dele (30/04 → 01/05).
    await insertIntervention({ doctorId: ids.eva, baseCode: "PM04", startedAt: "2026-03-31T22:00:00.000Z", endedAt: "2026-04-01T10:00:00.000Z", shiftLabel: "SN" });
    await insertIntervention({ doctorId: ids.eva, baseCode: "PM04", startedAt: "2026-04-30T22:00:00.000Z", endedAt: "2026-05-01T10:00:00.000Z", shiftLabel: "SN" });

    // Fabio: estatutário, SD numa terça.
    await insertIntervention({ doctorId: ids.fabio, baseCode: "BR05", startedAt: "2026-04-07T10:00:00.000Z", endedAt: "2026-04-07T22:00:00.000Z", shiftLabel: "SD" });

    // Gil: residente, SD numa terça — nunca entra em pagamento.
    await insertRegulation({ doctorId: ids.gil, postCode: "1327", startedAt: "2026-04-07T10:00:00.000Z", endedAt: "2026-04-07T22:00:00.000Z", shiftLabel: "SD" });

    // Hugo: SD com retirada antecipada às 13:00 → só banco de horas.
    await insertIntervention({ doctorId: ids.hugo, baseCode: "SM01", startedAt: "2026-04-14T10:00:00.000Z", endedAt: "2026-04-14T16:00:00.000Z", shiftLabel: "SD", earlyDepartureOutcome: "bank_only" });

    // Iris: SD no feriado SAMU de 03/04 (sexta).
    await insertIntervention({ doctorId: ids.iris, baseCode: "CB02", startedAt: "2026-04-03T10:00:00.000Z", endedAt: "2026-04-03T22:00:00.000Z", shiftLabel: "SD" });

    // Jonas: só extras do admin, um de cada lado da virada (31/03 e 01/05).
    await insertExtra(ids.jonas, "2026-03-31", "SN", "extra", 1);
    await insertExtra(ids.jonas, "2026-05-01", "SD", "extra", 1);

    // PM04 desativada o dia 20/04 inteiro (07:00 → 07:00 do dia seguinte).
    await getDb().execute(sql`
        insert into operations_v2.intervention_base_deactivations (base_id, deactivated_at, reactivated_at, notes)
        select ib.id, '2026-04-20T10:00:00.000Z'::timestamptz, '2026-04-21T10:00:00.000Z'::timestamptz, ${deactivationNote}
        from operations_v2.intervention_bases ib where ib.code = 'PM04'
    `);

    // Contrato legado (doctor_contracts) só para Ana.
    await getDb().execute(sql`
        insert into operations_v2.doctor_contracts (doctor_id, ceiling_brl, seed_month)
        values (${ids.ana}, 100000, ${MONTH})
    `);

    const range = resolveMonthlyReportRange(MONTH);
    breakdown = await getDoctorMonthlyPayableBreakdown(range.start, range.end);
    board = await loadChiefPayableBoardCore(MONTH);
    financials = await loadChiefPayableFinancials(MONTH);
});

after(async () => {
    if (skip) return;
    const db = getDb();
    for (const table of ["intervention_occupancies", "regulation_occupancies", "admin_extra_shifts", "doctor_contracts"]) {
        await db.execute(sql`delete from ${sql.raw(`operations_v2.${table}`)} where doctor_id in ${doctorIds}`);
    }
    await db.execute(sql`delete from operations_v2.intervention_base_deactivations where notes = ${deactivationNote}`);
    await db.execute(sql`delete from operations_v2.doctors where id in ${doctorIds}`);
    await closeDb();
});

test("turno inteiro: SD de dia útil paga uma unidade na tarifa de dia útil", { skip }, () => {
    assert.deepEqual(shiftsOf("fabio"), ["2026-04-07 SD BR05 1"]);
    // Ana também tem extras; o SD real dela é este:
    assert.ok(shiftsOf("ana").includes("2026-04-07 SD SM01 1"));
});

test("P de 24h no sábado vira SD + SN, ambos na tarifa de fim de semana do especialista", { skip }, () => {
    assert.deepEqual(shiftsOf("bruno"), ["2026-04-11 SD CB02 1", "2026-04-11 SN CB02 1"]);
    assert.deepEqual(april("bruno"), { amountCents: 2 * ESPECIALISTA_FDS, weekdayShifts: 0, weekendShifts: 2 });
    assert.equal(rowOf("bruno")?.paymentProfile, "specialist");
});

test("continuação: SD + SN no mesmo grupo de continuidade pagam duas unidades", { skip }, async () => {
    assert.deepEqual(shiftsOf("carla"), ["2026-04-08 SD PR03 1", "2026-04-08 SN PR03 1"]);
    assert.deepEqual(april("carla"), { amountCents: 2 * GENERALISTA_UTIL, weekdayShifts: 2, weekendShifts: 0 });

    const range = resolveMonthlyReportRange(MONTH);
    const { boards, continuityGroupByOccupancyId } = await getPayableAllocationBoardsForRange(range.start, range.end);
    assert.equal(boards.length, 60, "30 dias × 2 slots de 12h");
    const carlaOccupancies = board.payableShifts.filter((shift) => shift.doctorId === ids.carla).map((shift) => shift.occupancyId);
    assert.equal(carlaOccupancies.length, 2);
    assert.notEqual(carlaOccupancies[0], carlaOccupancies[1]);
    assert.equal(
        continuityGroupByOccupancyId.get(carlaOccupancies[0]!),
        continuityGroupByOccupancyId.get(carlaOccupancies[1]!),
    );
});

// O service não lê sessões de refeição: o que mexe no pagamento é o meio
// plantão (role MEIO_PLANTAO, janela 11:30–17:00).
test("meio plantão na regulação paga 0,5 unidade com tag MEIO", { skip }, () => {
    assert.deepEqual(shiftsOf("davi"), ["2026-04-09 SD CRU 0.5 MEIO"]);
    assert.deepEqual(april("davi"), { amountCents: Math.round(GENERALISTA_UTIL / 2), weekdayShifts: 0.5, weekendShifts: 0 });
});

test("virada de mês: SN de 31/03 fica em março, SN de 30/04 → 01/05 fica em abril", { skip }, () => {
    assert.deepEqual(shiftsOf("eva"), ["2026-04-30 SN PM04 1"]);
    assert.deepEqual(april("eva"), { amountCents: GENERALISTA_UTIL, weekdayShifts: 1, weekendShifts: 0 });
    assert.deepEqual([...breakdown.get(ids.eva!)!.keys()], [MONTH]);
});

test("feriado SAMU (03/04, sexta) paga tarifa de fim de semana", { skip }, () => {
    assert.deepEqual(april("iris"), { amountCents: GENERALISTA_FDS, weekdayShifts: 0, weekendShifts: 1 });
});

test("estatutário conta o plantão mas não recebe pela tabela", { skip }, () => {
    assert.deepEqual(april("fabio"), { amountCents: 0, weekdayShifts: 1, weekendShifts: 0 });
    const row = rowOf("fabio");
    assert.equal(row?.employmentType, "estatutario");
    assert.equal(row?.total, 1);
    assert.equal(row?.totalDue, 0);
});

test("residente fica fora da apuração, do quadro e da lista de médicos", { skip }, () => {
    assert.equal(breakdown.has(ids.gil!), false);
    assert.deepEqual(shiftsOf("gil"), []);
    assert.equal(rowOf("gil"), undefined);
    assert.equal(board.allDoctorNames.some((name) => name.startsWith("Gil Residente")), false);
});

test("retirada antecipada só banco de horas zera o slot (unidade 0, tag BANCO)", { skip }, () => {
    assert.deepEqual(shiftsOf("hugo"), ["2026-04-14 SD SM01 0 BANCO"]);
    assert.deepEqual(april("hugo"), { amountCents: 0, weekdayShifts: 0, weekendShifts: 0 });
});

test("extras do admin: verde soma, punição (unit -1) subtrai valor e contagem", { skip }, () => {
    assert.deepEqual(shiftsOf("ana"), [
        "2026-04-07 SD SM01 1",
        "2026-04-08 SD EXTRA 1",
        "2026-04-11 SN EXTRA -1",
    ]);
    assert.deepEqual(april("ana"), {
        amountCents: GENERALISTA_UTIL + GENERALISTA_UTIL - GENERALISTA_FDS,
        weekdayShifts: 2,
        weekendShifts: -1,
    });
});

test("extra do admin em 31/03 não entra em abril; o de 01/05 cai no mês 2026-05 da apuração", { skip }, async () => {
    // A apuração por mês (razão do saldo contratual) separa pelo operationalDate...
    assert.deepEqual([...breakdown.get(ids.jonas!)!.keys()], ["2026-05"]);
    // ...e o loader memoizado entrega só o mês pedido.
    const loader = createMonthlyBreakdownLoader();
    const first = loader(MONTH);
    assert.equal(loader(MONTH), first, "mesmo mês, mesma promise");
    assert.equal((await first).has(ids.jonas!), false);
});

test("médico com contrato legado tem saldo = teto - consumo desde a semente; sem contrato fica null", { skip }, () => {
    const ana = financials[ids.ana!];
    assert.equal(ana?.contractCeilingBrl, 100000);
    assert.equal(ana?.contractSeedMonth, MONTH);
    assert.equal(ana?.contractBalanceBrl, 100000 - (GENERALISTA_UTIL * 2 - GENERALISTA_FDS) / 100);

    const bruno = financials[ids.bruno!];
    assert.equal(bruno?.contractCeilingBrl, null);
    assert.equal(bruno?.contractBalanceBrl, null);
    assert.deepEqual(bruno?.contractBalances, []);
});

test("base desativada o dia inteiro aparece como desativada no SD e no SN", { skip }, () => {
    const pm04 = board.disabledTargets
        .filter((target) => target.targetCode === "PM04" && target.operationalDate === "2026-04-20")
        .map((target) => `${target.shiftLabel} ${target.disabledEntireShift} ${target.disabledReason}`);
    assert.deepEqual(pm04, [`SD true ${deactivationNote}`, `SN true ${deactivationNote}`]);
});

test("fechamento de abril NÃO deveria incluir o extra do admin lançado em 01/05", {
    skip,
    todo: "bug: extraEndDate converte range.end (01/05 07:00 local) na data local 01/05, então o extra desse dia entra no fechamento de abril E no de maio",
}, () => {
    assert.deepEqual(shiftsOf("jonas"), []);
});

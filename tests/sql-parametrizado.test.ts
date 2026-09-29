import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { inArray, sql } from "drizzle-orm";
import { closeDb, getDb } from "@/db";
import { contractLedger, doctors } from "@/db/schema";
import { loadBriefingBankHours } from "@/lib/briefing/bank-hours";
import { listRecentHandoffs } from "@/services/board.service";

/**
 * Troca de sql.raw (IDs/números colados no texto da consulta) por parâmetro:
 * inArray() no saldo do contrato e no de-para de nomes do briefing,
 * make_interval() na tolerância das rendições e na janela de atrasos. Aqui a
 * forma antiga fica como referência e a nova tem de devolver o mesmo resultado
 * contra um Postgres de verdade.
 *
 * Só roda com DATABASE_URL de um banco de teste (nome contém "test").
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
const doctorIds: string[] = [];
const contractIds: string[] = [];
let postId = 0;

async function insertDoctor(name: string) {
    const id = randomUUID();
    doctorIds.push(id);
    const fullName = `${name} ${tag}`;
    await getDb().execute(sql`
        insert into operations_v2.doctors (id, full_name, normalized_name)
        values (${id}, ${fullName}, ${fullName.toLowerCase()})
    `);
    return id;
}

async function insertContractWithLedger(doctorId: string, entries: number) {
    const id = randomUUID();
    contractIds.push(id);
    await getDb().execute(sql`
        insert into operations_v2.contracts (id, doctor_id, contract_number, category, cycle_start, cycle_end, started_at)
        values (${id}, ${doctorId}, ${`T-${randomUUID().slice(0, 8)}`}, 'generalista', '2026-01-01', '2027-01-01', '2026-01-01')
    `);
    for (let i = 0; i < entries; i++) {
        await getDb().execute(sql`
            insert into operations_v2.contract_ledger (contract_id, entry_date, type, amount, description)
            values (${id}, '2026-05-10', 'manual_adjustment', ${-100 * (i + 1)}, 'teste sql parametrizado')
        `);
    }
    return id;
}

async function insertRegulation(doctorId: string, startedAt: Date, endedAt: Date) {
    await getDb().execute(sql`
        insert into operations_v2.regulation_occupancies
            (doctor_id, continuity_group_id, post_id, started_at, ended_at, source)
        values (${doctorId}, ${randomUUID()}, ${postId}, ${startedAt.toISOString()}, ${endedAt.toISOString()}, 'manual')
    `);
}

async function insertDelay(doctorId: string, daysAgo: number, minutes: number) {
    const start = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000).toISOString();
    await getDb().execute(sql`
        insert into operations_v2.bank_hours_entries
            (doctor_id, source_type, scheduled_start_at, scheduled_end_at, actual_start_at, actual_end_at,
             arrival_delay_minutes, overtime_minutes, overtime_multiplier, credited_overtime_minutes,
             balance_minutes, rule_code, explanation)
        values (${doctorId}, 'manual_adjustment', ${start}, ${start}, ${start}, ${start},
                ${minutes}, 0, 1, 0, 0, 'teste', 'teste sql parametrizado')
    `);
}

before(async () => {
    if (skip) return;
    const [post] = await getDb().execute<{ id: number }>(sql`
        insert into operations_v2.regulation_posts (code, label, is_active)
        values (${`T${tag}`.slice(0, 32)}, 'Ramal teste sql parametrizado', false)
        returning id
    `) as unknown as { id: number }[];
    postId = post.id;
});

after(async () => {
    if (!skip) {
        const db = getDb();
        if (contractIds.length > 0) {
            await db.execute(sql`delete from operations_v2.contract_ledger where contract_id in ${contractIds}`);
            await db.execute(sql`delete from operations_v2.contracts where id in ${contractIds}`);
        }
        if (doctorIds.length > 0) {
            await db.execute(sql`delete from operations_v2.bank_hours_entries where doctor_id in ${doctorIds}`);
            await db.execute(sql`delete from operations_v2.regulation_occupancies where doctor_id in ${doctorIds}`);
            await db.execute(sql`delete from operations_v2.doctors where id in ${doctorIds}`);
        }
        if (postId) await db.execute(sql`delete from operations_v2.regulation_posts where id = ${postId}`);
    }
    await closeDb();
});

function oldUuidAny(ids: string[]) {
    return sql.raw(`array[${ids.map((id) => `'${id}'`).join(",")}]::uuid[]`);
}

test("razão do contrato: inArray devolve os mesmos lançamentos que o any(array[...]) antigo", { skip }, async () => {
    const db = getDb();
    const doctorId = await insertDoctor("Saldo SQL");
    const a = await insertContractWithLedger(doctorId, 2);
    const b = await insertContractWithLedger(doctorId, 3);
    const fora = await insertContractWithLedger(doctorId, 1);
    // Repetido de propósito: a lista vem de linhas por mês e pode repetir contrato.
    const pedidos = [a, b, a];

    const antigo = await db.select({ id: contractLedger.id }).from(contractLedger)
        .where(sql`${contractLedger.contractId} = any(${oldUuidAny(pedidos)})`);
    const novo = await db.select({ id: contractLedger.id }).from(contractLedger)
        .where(inArray(contractLedger.contractId, pedidos));

    assert.equal(antigo.length, 5);
    assert.deepEqual(novo.map((r) => r.id).sort(), antigo.map((r) => r.id).sort());
    const [{ n }] = await db.execute<{ n: number }>(sql`
        select count(*)::int as n from operations_v2.contract_ledger where contract_id = ${fora}
    `) as unknown as { n: number }[];
    assert.equal(n, 1, "o contrato fora da lista existe mas não entra em nenhuma das duas");
});

test("briefing: de-para de nomes com inArray devolve os mesmos médicos que o any(array[...]) antigo", { skip }, async () => {
    const db = getDb();
    const um = await insertDoctor("Nome Um");
    const dois = await insertDoctor("Nome Dois");
    await insertDoctor("Nome Fora");
    const pedidos = [...new Set([um, dois, um])];

    const antigo = await db.select({ id: doctors.id }).from(doctors)
        .where(sql`${doctors.id} = any(${oldUuidAny(pedidos)})`);
    const novo = await db.select({ id: doctors.id }).from(doctors)
        .where(inArray(doctors.id, pedidos));

    assert.deepEqual(novo.map((r) => r.id).sort(), [um, dois].sort());
    assert.deepEqual(novo.map((r) => r.id).sort(), antigo.map((r) => r.id).sort());
});

test("make_interval com parâmetro dá o mesmo instante que o interval literal antigo", { skip }, async () => {
    const db = getDb();
    for (const minutos of [0, 1, 60, 90, 1440]) {
        const [row] = await db.execute<{ igual: boolean }>(sql`
            select (now() - ${sql.raw(`interval '${minutos} minutes'`)}) = (now() - make_interval(mins => ${minutos})) as igual
        `) as unknown as { igual: boolean }[];
        assert.equal(row.igual, true, `${minutos} minutos`);
    }
    for (const dias of [1, 14, 30]) {
        const [row] = await db.execute<{ igual: boolean }>(sql`
            select (now() - ${sql.raw(`interval '${dias} days'`)}) = (now() - make_interval(days => ${dias})) as igual
        `) as unknown as { igual: boolean }[];
        assert.equal(row.igual, true, `${dias} dias`);
    }
});

test("listRecentHandoffs: sucessor 80 min antes do fim entra com tolerância 90 e sai com 60", { skip }, async () => {
    const antes = await insertDoctor("Rendido");
    const depois = await insertDoctor("Rendeu");
    const fim = new Date(Date.now() - 60 * 60 * 1000);
    await insertRegulation(antes, new Date(fim.getTime() - 10 * 60 * 60 * 1000), fim);
    const inicioSucessor = new Date(fim.getTime() - 80 * 60 * 1000);
    await insertRegulation(depois, inicioSucessor, new Date(fim.getTime() + 30 * 60 * 1000));

    const doPosto = (rows: Awaited<ReturnType<typeof listRecentHandoffs>>) =>
        rows.filter((row) => row.targetCode === `T${tag}`.slice(0, 32));

    // A janela padrão caiu para 1h (#387) e o fim do plantão aqui fica a 60 min
    // de agora, na borda: a janela explícita mantém o teste sobre a tolerância.
    const com90 = doPosto(await listRecentHandoffs({ windowHours: 12, toleranceMinutes: 90 }));
    assert.equal(com90.length, 1);
    assert.equal(com90[0].predecessorName, `Rendido ${tag}`);
    assert.equal(com90[0].successorName, `Rendeu ${tag}`);
    assert.equal(doPosto(await listRecentHandoffs({ windowHours: 12, toleranceMinutes: 60 })).length, 0);
});

test("loadBriefingBankHours: janela de 14 dias parametrizada pega 13 dias e deixa 15 de fora", { skip }, async () => {
    const doctorId = await insertDoctor("Atrasado");
    await insertDelay(doctorId, 13, 25);
    await insertDelay(doctorId, 15, 40);

    const { atrasos } = await loadBriefingBankHours();
    const meus = atrasos.filter((row) => row.doctorName === `Atrasado ${tag}`);
    assert.deepEqual(meus.map((row) => row.minutes), [25]);
});

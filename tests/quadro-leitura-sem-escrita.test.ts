import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { sql } from "drizzle-orm";
import { closeDb, getDb } from "@/db";
import { expireInterventionBaseDeactivations } from "@/modules/intervention/service";
import { resolveOperationalShiftWindow } from "@/modules/operational/board-rules";
import { expireRegulationPostDeactivations } from "@/modules/regulation/service";
import { getOperationalBoard, getPaymentAllocationBoard } from "@/services/board.service";

/**
 * Padrão 4 de docs/bug-hotspots.md: o quadro não grava ao ler. Desativação de
 * base/posto vence na virada do turno; quem grava reactivated_at é o
 * plantoes-telegram-worker (expire*Deactivations a cada ciclo). Até ele passar,
 * a leitura (quadro ao vivo e quadro de pagamento) já trata a janela aberta de
 * turno anterior como vencida — mesmo resultado visível, sem escrita.
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

const tag = randomUUID().slice(0, 6).toUpperCase();
const shiftStartedAt = resolveOperationalShiftWindow(new Date()).startedAt;
const expiredAt = new Date(shiftStartedAt.getTime() - 2 * 60 * 60 * 1000);

const codes = {
    baseVencida: `BV${tag}`,
    baseVigente: `BA${tag}`,
    postoVencido: `PV${tag}`,
    postoVigente: `PA${tag}`,
};
const ids = { bases: [] as number[], posts: [] as number[] };
let createdLegacyStub = false;

// O quadro ao vivo lê também o legado (public.shift_current_state & cia.), que
// não existe no banco de teste. Stub vazio só se faltar, e só ele é apagado.
async function ensureLegacyStub() {
    const [row] = await getDb().execute<{ existe: boolean }>(sql`
        select to_regclass('public.shift_current_state') is not null as existe
    `) as unknown as { existe: boolean }[];
    if (row.existe) return;
    createdLegacyStub = true;
    await getDb().execute(sql`
        create table public.bases (id uuid primary key, code text, sector text);
        create table public.users (id uuid primary key, name text);
        create table public.shift_instances (
            id uuid primary key, base_id uuid, scheduled_start_at timestamptz,
            scheduled_end_at timestamptz, role_function text
        );
        create table public.shift_current_state (
            shift_instance_id uuid, executor_user_id uuid, status text, ramal text,
            arrival_time timestamptz, departure_time timestamptz,
            role_function_detected text, updated_at timestamptz
        );
    `);
}

async function insertBase(code: string, deactivatedAt: Date) {
    const [row] = await getDb().execute<{ id: number }>(sql`
        insert into operations_v2.intervention_bases (code, label) values (${code}, ${`Base ${code}`}) returning id
    `) as unknown as { id: number }[];
    ids.bases.push(row.id);
    await getDb().execute(sql`
        insert into operations_v2.intervention_base_deactivations (base_id, deactivated_at, notes)
        values (${row.id}, ${deactivatedAt.toISOString()}, 'teste leitura sem escrita')
    `);
}

async function insertPost(code: string, deactivatedAt: Date) {
    const [row] = await getDb().execute<{ id: number }>(sql`
        insert into operations_v2.regulation_posts (code, label) values (${code}, ${`Ramal ${code}`}) returning id
    `) as unknown as { id: number }[];
    ids.posts.push(row.id);
    await getDb().execute(sql`
        insert into operations_v2.regulation_post_deactivations (post_id, deactivated_at, notes)
        values (${row.id}, ${deactivatedAt.toISOString()}, 'teste leitura sem escrita')
    `);
}

async function deactivationRows() {
    const rows = await getDb().execute<{ code: string; reactivatedAt: Date | string | null; updatedAt: Date | string }>(sql`
        select ib.code, d.reactivated_at as "reactivatedAt", d.updated_at as "updatedAt"
        from operations_v2.intervention_base_deactivations d
        join operations_v2.intervention_bases ib on ib.id = d.base_id
        where ib.id in ${ids.bases}
        union all
        select rp.code, d.reactivated_at, d.updated_at
        from operations_v2.regulation_post_deactivations d
        join operations_v2.regulation_posts rp on rp.id = d.post_id
        where rp.id in ${ids.posts}
    `) as unknown as { code: string; reactivatedAt: Date | string | null; updatedAt: Date | string }[];
    return new Map(rows.map((row) => [row.code, {
        reactivatedAt: row.reactivatedAt ? new Date(row.reactivatedAt).toISOString() : null,
        updatedAt: new Date(row.updatedAt).toISOString(),
    }]));
}

before(async () => {
    if (skip) return;
    await ensureLegacyStub();
    // Vencida: aberta no turno anterior (a virada já passou). Vigente: aberta no
    // início do turno atual.
    await insertBase(codes.baseVencida, expiredAt);
    await insertBase(codes.baseVigente, shiftStartedAt);
    await insertPost(codes.postoVencido, expiredAt);
    await insertPost(codes.postoVigente, shiftStartedAt);
});

after(async () => {
    if (!skip) {
        const db = getDb();
        if (ids.bases.length > 0) await db.execute(sql`delete from operations_v2.intervention_bases where id in ${ids.bases}`);
        if (ids.posts.length > 0) await db.execute(sql`delete from operations_v2.regulation_posts where id in ${ids.posts}`);
        if (createdLegacyStub) {
            await db.execute(sql`drop table public.shift_current_state, public.shift_instances, public.users, public.bases`);
        }
    }
    await closeDb();
});

test("getOperationalBoard esconde a desativação vencida e não grava nada nas desativações", { skip }, async () => {
    const antes = await deactivationRows();
    const board = await getOperationalBoard();

    const base = (code: string) => board.intervention.find((row) => row.baseCode === code);
    const posto = (code: string) => board.regulation.find((row) => row.postCode === code);
    assert.ok(base(codes.baseVencida) && posto(codes.postoVencido), "alvos de teste aparecem no quadro");
    assert.notEqual(base(codes.baseVencida)?.status, "disabled");
    assert.equal(base(codes.baseVigente)?.status, "disabled");
    assert.notEqual(posto(codes.postoVencido)?.status, "disabled");
    assert.equal(posto(codes.postoVigente)?.status, "disabled");

    assert.deepEqual(await deactivationRows(), antes, "leitura do quadro não pode gravar reactivated_at");
    assert.equal(antes.get(codes.baseVencida)?.reactivatedAt, null);
});

test("quadro de pagamento do turno atual ignora a vencida e não grava", { skip }, async () => {
    const antes = await deactivationRows();
    const board = await getPaymentAllocationBoard();

    const alvo = (code: string) => [...board.intervention, ...board.regulation].find((row) => row.targetCode === code);
    assert.equal(alvo(codes.baseVencida)?.disabledDuringShift, false);
    assert.equal(alvo(codes.baseVigente)?.disabledDuringShift, true);
    assert.equal(alvo(codes.postoVencido)?.disabledDuringShift, false);
    assert.equal(alvo(codes.postoVigente)?.disabledDuringShift, true);

    assert.deepEqual(await deactivationRows(), antes, "leitura do pagamento não pode gravar reactivated_at");
});

test("reaper do worker grava reactivated_at = virada só na vencida", { skip }, async () => {
    const agora = new Date();
    assert.ok(await expireInterventionBaseDeactivations(agora) >= 1);
    assert.ok(await expireRegulationPostDeactivations(agora) >= 1);

    const depois = await deactivationRows();
    assert.equal(depois.get(codes.baseVencida)?.reactivatedAt, shiftStartedAt.toISOString());
    assert.equal(depois.get(codes.postoVencido)?.reactivatedAt, shiftStartedAt.toISOString());
    assert.equal(depois.get(codes.baseVigente)?.reactivatedAt, null);
    assert.equal(depois.get(codes.postoVigente)?.reactivatedAt, null);

    // Depois de gravado, o quadro continua igual: vencida some, vigente segue.
    const board = await getOperationalBoard();
    assert.notEqual(board.intervention.find((row) => row.baseCode === codes.baseVencida)?.status, "disabled");
    assert.equal(board.intervention.find((row) => row.baseCode === codes.baseVigente)?.status, "disabled");
});

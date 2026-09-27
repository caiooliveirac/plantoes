import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, afterEach, before, test } from "node:test";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { closeDb, getDb, hasDatabaseUrl } from "@/db";
import { bankHoursEntries, doctors, regulationOccupancies, regulationPosts, telegramIngestedMessages } from "@/db/schema";
import { describeTelegramError, formatTelegramErrorForUser } from "@/modules/telegram/errors";
import { processTelegramUpdate } from "@/modules/telegram/service";

/**
 * Chegada antecipada do PRÓXIMO turno com o titular do turno que acaba ainda no
 * quadro (LIVE, 21–24/09/2026: 23505 em regulation_occupancies_one_active_board_per_post_idx,
 * médico via "erro técnico" e reenviava até 4x). A regra (docs/chegada.md, princípio 4
 * e cenário "Posto com médico do turno ANTERIOR") é rendição: o anterior é encerrado
 * na hora da chegada e quem chega assume o quadro. O portão de tomada já deixava
 * passar; quem falhava era startRegulationOccupancy, que rendia o registro errado
 * quando havia no posto um plantão fora do quadro (deslocado): o do próprio médico
 * que chega, vencido, ou o de um terceiro mais recente que o titular.
 */

const skip = !hasDatabaseUrl() && "DATABASE_URL não configurada";
let messageSeq = Math.floor(Math.random() * 1_000_000_000);
const createdDoctorIds: string[] = [];

async function postId(code: string) {
    const post = await getDb().query.regulationPosts.findFirst({ where: eq(regulationPosts.code, code) });
    assert.ok(post, `ramal ${code} semeado pelas migrations`);
    return post.id;
}

async function createDoctor(fullName: string) {
    const [doctor] = await getDb().insert(doctors).values({
        fullName,
        normalizedName: fullName.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase(),
    }).returning();
    createdDoctorIds.push(doctor.id);
    return doctor;
}

type OccupancySeed = {
    doctorId: string;
    postId: number;
    startedAt: string;
    boardStartedAt: string | null;
    scheduledStartAt: string;
    scheduledEndAt: string;
    shiftLabel: string;
    notes?: string;
};

async function seedOccupancy(seed: OccupancySeed) {
    const [row] = await getDb().insert(regulationOccupancies).values({
        doctorId: seed.doctorId,
        postId: seed.postId,
        continuityGroupId: randomUUID(),
        startedAt: new Date(seed.startedAt),
        boardStartedAt: seed.boardStartedAt ? new Date(seed.boardStartedAt) : null,
        scheduledStartAt: new Date(seed.scheduledStartAt),
        scheduledEndAt: new Date(seed.scheduledEndAt),
        shiftLabel: seed.shiftLabel,
        source: "telegram",
        notes: seed.notes ?? null,
    }).returning();
    return row;
}

async function send(text: string, at: string) {
    messageSeq += 1;
    await processTelegramUpdate({
        update_id: messageSeq,
        message: {
            message_id: messageSeq,
            date: Math.floor(new Date(at).getTime() / 1000),
            text,
            chat: { id: -100123, type: "group" },
            from: { id: 42, first_name: "Teste" },
        },
    });
    const [log] = await getDb().select().from(telegramIngestedMessages)
        .where(eq(telegramIngestedMessages.telegramMessageId, messageSeq));
    return log;
}

async function openOn(post: number) {
    return getDb().select().from(regulationOccupancies)
        .where(and(eq(regulationOccupancies.postId, post), isNull(regulationOccupancies.endedAt)));
}

async function byId(id: string) {
    const row = await getDb().query.regulationOccupancies.findFirst({ where: eq(regulationOccupancies.id, id) });
    assert.ok(row);
    return row;
}

const originalFetch = globalThis.fetch;
const originalToken = process.env.TELEGRAM_BOT_TOKEN;
before(() => {
    // Respostas do bot vão para um fetch falso: nada sai para o Telegram.
    process.env.TELEGRAM_BOT_TOKEN = "teste";
    globalThis.fetch = (async () => new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }))) as typeof fetch;
});

afterEach(async () => {
    if (skip || createdDoctorIds.length === 0) return;
    const db = getDb();
    const ids = createdDoctorIds.splice(0);
    await db.delete(bankHoursEntries).where(inArray(bankHoursEntries.doctorId, ids));
    await db.delete(regulationOccupancies).where(inArray(regulationOccupancies.doctorId, ids));
    await db.delete(doctors).where(inArray(doctors.id, ids));
});

after(async () => {
    globalThis.fetch = originalFetch;
    if (originalToken === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
    else process.env.TELEGRAM_BOT_TOKEN = originalToken;
    if (skip) return;
    await closeDb();
});

test("Caroline 1365 SN às 18:38 com Indira SD no quadro e plantão velho dela deslocado no posto", { skip }, async () => {
    const post = await postId("1365");
    const indira = await createDoctor("Indira Parron");
    const caroline = await createDoctor("Caroline Luane Rabelo");
    const indiraOcc = await seedOccupancy({
        doctorId: indira.id, postId: post, shiftLabel: "SD",
        startedAt: "2026-09-24T07:08:00-03:00", boardStartedAt: "2026-09-24T07:08:00-03:00",
        scheduledStartAt: "2026-09-24T07:00:00-03:00", scheduledEndAt: "2026-09-24T19:15:00-03:00",
    });
    const stale = await seedOccupancy({
        doctorId: caroline.id, postId: post, shiftLabel: "SN",
        startedAt: "2026-09-20T19:05:00-03:00", boardStartedAt: null,
        scheduledStartAt: "2026-09-20T19:00:00-03:00", scheduledEndAt: "2026-09-21T07:15:00-03:00",
        notes: "[DESLOCADO] 2026-09-20T23:00:00.000Z por Fulano",
    });

    const log = await send("Caroline Luane Rabelo 1365 SN RMT", "2026-09-24T18:38:00-03:00");
    assert.equal(log.status, "accepted", `${log.status} ${log.errorMessage}`);

    const open = await openOn(post);
    assert.equal(open.length, 1, "um só titular no posto");
    assert.equal(open[0].doctorId, caroline.id);
    assert.equal(open[0].boardStartedAt?.toISOString(), new Date("2026-09-24T18:38:00-03:00").toISOString());
    assert.equal(open[0].shiftLabel, "SN");
    // Indira rendida na hora da chegada (mesmo desfecho do posto sem deslocado).
    assert.equal((await byId(indiraOcc.id)).endedAt?.toISOString(), new Date("2026-09-24T18:38:00-03:00").toISOString());
    assert.ok((await byId(stale.id)).endedAt, "o plantão vencido da Caroline é fechado");
});

test("Míriam 2152 SN às 18:41 com Briang SD no quadro e um deslocado mais recente que ele", { skip }, async () => {
    const post = await postId("2152");
    const briang = await createDoctor("Briang Souza");
    const miriam = await createDoctor("Miriam Ruth");
    const outro = await createDoctor("Otavio Deslocado");
    const briangOcc = await seedOccupancy({
        doctorId: briang.id, postId: post, shiftLabel: "SD",
        startedAt: "2026-09-22T09:13:00-03:00", boardStartedAt: "2026-09-22T09:13:00-03:00",
        scheduledStartAt: "2026-09-22T07:00:00-03:00", scheduledEndAt: "2026-09-22T19:15:00-03:00",
    });
    const displaced = await seedOccupancy({
        doctorId: outro.id, postId: post, shiftLabel: "SD",
        startedAt: "2026-09-22T10:00:00-03:00", boardStartedAt: null,
        scheduledStartAt: "2026-09-22T07:00:00-03:00", scheduledEndAt: "2026-09-22T19:15:00-03:00",
        notes: "[DESLOCADO] 2026-09-22T14:00:00.000Z por Briang",
    });

    const log = await send("MIRIAM RUTH 2152 SN", "2026-09-22T18:41:00-03:00");
    assert.equal(log.status, "accepted", `${log.status} ${log.errorMessage}`);

    const withBoard = (await openOn(post)).filter((occ) => occ.boardStartedAt !== null);
    assert.equal(withBoard.length, 1);
    assert.equal(withBoard[0].doctorId, miriam.id);
    assert.equal((await byId(briangOcc.id)).endedAt?.toISOString(), new Date("2026-09-22T18:41:00-03:00").toISOString());
    // O deslocado segue fora do quadro, com o plantão aberto (princípio 4).
    const displacedAfter = await byId(displaced.id);
    assert.equal(displacedAfter.endedAt, null);
    assert.equal(displacedAfter.boardStartedAt, null);
});

test("Gerardson 2152 SD às 06:56 com Isabella SN no quadro e deslocado mais recente", { skip }, async () => {
    const post = await postId("2152");
    const isabella = await createDoctor("Isabella Nobrega");
    const gerardson = await createDoctor("Gerardson Lima");
    const outro = await createDoctor("Otavio Deslocado");
    const isabellaOcc = await seedOccupancy({
        doctorId: isabella.id, postId: post, shiftLabel: "SN",
        startedAt: "2026-09-20T22:39:00-03:00", boardStartedAt: "2026-09-20T22:39:00-03:00",
        scheduledStartAt: "2026-09-20T19:00:00-03:00", scheduledEndAt: "2026-09-21T07:15:00-03:00",
    });
    await seedOccupancy({
        doctorId: outro.id, postId: post, shiftLabel: "SN",
        startedAt: "2026-09-20T23:00:00-03:00", boardStartedAt: null,
        scheduledStartAt: "2026-09-20T19:00:00-03:00", scheduledEndAt: "2026-09-21T07:15:00-03:00",
        notes: "[DESLOCADO] 2026-09-21T03:00:00.000Z por Isabella",
    });

    const log = await send("Gerardson SD 2152", "2026-09-21T06:56:00-03:00");
    assert.equal(log.status, "accepted", `${log.status} ${log.errorMessage}`);
    const withBoard = (await openOn(post)).filter((occ) => occ.boardStartedAt !== null);
    assert.equal(withBoard.length, 1);
    assert.equal(withBoard[0].doctorId, gerardson.id);
    assert.equal(withBoard[0].boardStartedAt?.toISOString(), new Date("2026-09-21T06:56:00-03:00").toISOString());
    assert.equal((await byId(isabellaOcc.id)).endedAt?.toISOString(), new Date("2026-09-21T06:56:00-03:00").toISOString());
});

test("sombra que chegou no posto vazio (com board) não barra o titular: sai do quadro e segue", { skip }, async () => {
    const post = await postId("2032");
    const sombra = await createDoctor("Sabrina Sombra");
    const ana = await createDoctor("Ana Luiza Costa");
    const shadow = await seedOccupancy({
        doctorId: sombra.id, postId: post, shiftLabel: "SD",
        startedAt: "2026-09-23T06:40:00-03:00", boardStartedAt: "2026-09-23T06:40:00-03:00",
        scheduledStartAt: "2026-09-23T07:00:00-03:00", scheduledEndAt: "2026-09-23T19:15:00-03:00",
        notes: "[telegram sombra] Sabrina sombra 2032",
    });

    const log = await send("Ana Luiza Costa na 2032 SD", "2026-09-23T06:52:00-03:00");
    assert.equal(log.status, "accepted", `${log.status} ${log.errorMessage}`);
    const withBoard = (await openOn(post)).filter((occ) => occ.boardStartedAt !== null);
    assert.equal(withBoard.length, 1);
    assert.equal(withBoard[0].doctorId, ana.id);
    const shadowAfter = await byId(shadow.id);
    assert.equal(shadowAfter.endedAt, null, "sombra coexiste");
    assert.equal(shadowAfter.boardStartedAt, null);
});

test("describeTelegramError: SQLSTATE e constraint/coluna, sem SQL nem params", () => {
    const pg = Object.assign(new Error('duplicate key value violates unique constraint "regulation_occupancies_one_active_board_per_post_idx"'), {
        code: "23505",
        constraint_name: "regulation_occupancies_one_active_board_per_post_idx",
    });
    const drizzle = new Error("Failed query: insert into x values ($1)\nparams: Caroline", { cause: pg });
    const logged = describeTelegramError(drizzle, "telegram_processing_failed");
    assert.equal(logged, "db_update_failed:23505:regulation_occupancies_one_active_board_per_post_idx");
    assert.doesNotMatch(logged, /insert|Caroline/);
    // Coluna quando não há constraint; só o código quando o PG não diz a coluna (22001).
    assert.equal(describeTelegramError(new Error("Failed query: x", { cause: Object.assign(new Error("null value"), { code: "23502", column_name: "doctor_id" }) }), "f"), "db_update_failed:23502:doctor_id");
    assert.equal(describeTelegramError(new Error("Failed query: x", { cause: Object.assign(new Error("value too long"), { code: "22001" }) }), "f"), "db_update_failed:22001");
    assert.equal(describeTelegramError(new Error("Failed query: x\nparams: y"), "f"), "db_update_failed");
    assert.ok(describeTelegramError(new Error("Failed query: x", { cause: Object.assign(new Error("e"), { code: "23505", constraint_name: "c".repeat(400) }) }), "f").length <= 240);
    // Erros comuns seguem com a própria mensagem; não-Error cai no fallback.
    assert.equal(describeTelegramError(new Error("arrival_conflicts_with_active_occupancy"), "f"), "arrival_conflicts_with_active_occupancy");
    assert.equal(describeTelegramError("x", "telegram_processing_failed"), "telegram_processing_failed");
    // Para o médico, segue a mesma mensagem de falha do banco.
    assert.match(formatTelegramErrorForUser(logged), /banco recusou/);
});

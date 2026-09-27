/* Caracterização da chegada pelo bot, de ponta a ponta (processTelegramUpdate →
   banco), com o Telegram mockado. Trava o comportamento ATUAL dos cenários de
   docs/chegada.md (seção 5 e defeitos D1–D12, D7/#328, D8/#319) para que a
   extração da decisão (modules/telegram/arrival-classification.ts) não mude nada.

   Cada cenário usa médicos novos e um ramal/base próprio; tudo que o cenário
   grava é apagado no fim. As datas são fixas (fase 2 já vigente). */

import assert from "node:assert/strict";
import { after, afterEach, before, describe, test } from "node:test";

import { and, asc, eq, inArray } from "drizzle-orm";

import { closeDb, getDb } from "@/db";
import {
    auditLogs,
    bankHoursEntries,
    doctors,
    interventionBases,
    interventionOccupancies,
    regulationOccupancies,
    regulationPosts,
    telegramIngestedMessages,
} from "@/db/schema";
import type { TelegramUpdate } from "@/modules/telegram/api";
import { processTelegramUpdate } from "@/modules/telegram/service";

const skip = !process.env.DATABASE_URL || !process.env.DATABASE_URL.includes("test");

function at(iso: string) {
    return new Date(`${iso}-03:00`);
}

function hhmm(value: Date | null | undefined) {
    if (!value) return null;
    return value.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "America/Sao_Paulo" });
}

// Nome só com letras (o parser trata dígitos como hora/ramal) e único por execução.
function randomLetters(size: number) {
    const alphabet = "bcdfghjklmnpqrstvwxz";
    let out = "";
    for (let index = 0; index < size; index += 1) {
        out += alphabet[Math.floor(Math.random() * alphabet.length)];
    }
    return out;
}

describe("chegada pelo bot — caracterização (banco + Telegram mockado)", { skip }, () => {
    const originalFetch = globalThis.fetch;
    const originalToken = process.env.TELEGRAM_BOT_TOKEN;
    const originalCutoff = process.env.ARRIVAL_TIME_CUTOFF;
    const chatId = -(1_000_000_000_000 + Math.floor(Math.random() * 1_000_000_000));
    let messageId = Math.floor(Math.random() * 1_000_000);
    let updateId = Math.floor(Math.random() * 1_000_000);
    const replies: string[] = [];
    const createdDoctorIds: string[] = [];

    before(() => {
        process.env.TELEGRAM_BOT_TOKEN = "test-token";
        // Produção roda na fase 2 ("vale a hora do aviso") desde 01/06/2026.
        process.env.ARRIVAL_TIME_CUTOFF = "2026-06-01T00:00:00-03:00";
        globalThis.fetch = (async (_url: string, init?: RequestInit) => {
            const body = init?.body ? JSON.parse(String(init.body)) : {};
            if (typeof body.text === "string") replies.push(body.text);
            return new Response(JSON.stringify({ ok: true, result: { message_id: 1, chat: { id: chatId, type: "group" }, date: 0 } }));
        }) as typeof fetch;
    });

    afterEach(async () => {
        replies.length = 0;
        if (createdDoctorIds.length === 0) return;
        const db = getDb();
        const regIds = (await db.select({ id: regulationOccupancies.id }).from(regulationOccupancies)
            .where(inArray(regulationOccupancies.doctorId, createdDoctorIds))).map((row) => row.id);
        const intIds = (await db.select({ id: interventionOccupancies.id }).from(interventionOccupancies)
            .where(inArray(interventionOccupancies.doctorId, createdDoctorIds))).map((row) => row.id);
        const occIds = [...regIds, ...intIds];
        if (occIds.length > 0) {
            await db.delete(auditLogs).where(inArray(auditLogs.entityId, occIds));
            await db.delete(bankHoursEntries).where(inArray(bankHoursEntries.doctorId, createdDoctorIds));
            await db.update(telegramIngestedMessages).set({ relatedOccupancyId: null })
                .where(eq(telegramIngestedMessages.chatId, String(chatId)));
        }
        await db.delete(regulationOccupancies).where(inArray(regulationOccupancies.doctorId, createdDoctorIds));
        await db.delete(interventionOccupancies).where(inArray(interventionOccupancies.doctorId, createdDoctorIds));
        await db.delete(telegramIngestedMessages).where(eq(telegramIngestedMessages.chatId, String(chatId)));
        await db.delete(doctors).where(inArray(doctors.id, createdDoctorIds));
        createdDoctorIds.length = 0;
    });

    after(async () => {
        globalThis.fetch = originalFetch;
        if (originalToken === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
        else process.env.TELEGRAM_BOT_TOKEN = originalToken;
        if (originalCutoff === undefined) delete process.env.ARRIVAL_TIME_CUTOFF;
        else process.env.ARRIVAL_TIME_CUTOFF = originalCutoff;
        await closeDb();
    });

    async function createDoctor(firstName: string) {
        const surname = `${randomLetters(1).toUpperCase()}${randomLetters(7)}`;
        const fullName = `${firstName} ${surname}`;
        const [row] = await getDb().insert(doctors).values({
            fullName,
            normalizedName: fullName.toLowerCase(),
        }).returning({ id: doctors.id });
        createdDoctorIds.push(row.id);
        return { id: row.id, name: fullName };
    }

    async function send(text: string, sentAt: Date, senderId = 900_001) {
        messageId += 1;
        updateId += 1;
        const update = {
            update_id: updateId,
            message: {
                message_id: messageId,
                date: Math.floor(sentAt.getTime() / 1000),
                chat: { id: chatId, type: "group" },
                from: { id: senderId, first_name: "Tarm" },
                text,
            },
        } as unknown as TelegramUpdate;
        const result = await processTelegramUpdate(update);
        // Em produção a linha do log nasce na hora da mensagem; aqui nasce "agora".
        // A 1ª tentativa e a janela da tomada leem created_at: alinha com a mensagem.
        await getDb().update(telegramIngestedMessages).set({ createdAt: sentAt })
            .where(and(eq(telegramIngestedMessages.chatId, String(chatId)), eq(telegramIngestedMessages.telegramMessageId, messageId)));
        return result;
    }

    async function lastLog() {
        const [row] = await getDb().select().from(telegramIngestedMessages)
            .where(and(eq(telegramIngestedMessages.chatId, String(chatId)), eq(telegramIngestedMessages.telegramMessageId, messageId)));
        return row;
    }

    async function regulationRows(doctorId: string) {
        const rows = await getDb().select({
            id: regulationOccupancies.id,
            postId: regulationOccupancies.postId,
            startedAt: regulationOccupancies.startedAt,
            boardStartedAt: regulationOccupancies.boardStartedAt,
            endedAt: regulationOccupancies.endedAt,
            scheduledStartAt: regulationOccupancies.scheduledStartAt,
            scheduledEndAt: regulationOccupancies.scheduledEndAt,
            shiftLabel: regulationOccupancies.shiftLabel,
            roleLabel: regulationOccupancies.roleLabel,
            continuityGroupId: regulationOccupancies.continuityGroupId,
            notes: regulationOccupancies.notes,
            code: regulationPosts.code,
        }).from(regulationOccupancies)
            .innerJoin(regulationPosts, eq(regulationPosts.id, regulationOccupancies.postId))
            .where(eq(regulationOccupancies.doctorId, doctorId))
            .orderBy(asc(regulationOccupancies.startedAt), asc(regulationOccupancies.createdAt));
        return rows.map((row) => ({
            code: row.code,
            started: hhmm(row.startedAt),
            board: hhmm(row.boardStartedAt),
            ended: hhmm(row.endedAt),
            schedStart: hhmm(row.scheduledStartAt),
            schedEnd: hhmm(row.scheduledEndAt),
            shift: row.shiftLabel,
            role: row.roleLabel,
            group: row.continuityGroupId,
            notes: row.notes ?? "",
        }));
    }

    async function interventionRows(doctorId: string) {
        const rows = await getDb().select({
            startedAt: interventionOccupancies.startedAt,
            boardStartedAt: interventionOccupancies.boardStartedAt,
            endedAt: interventionOccupancies.endedAt,
            scheduledEndAt: interventionOccupancies.scheduledEndAt,
            shiftLabel: interventionOccupancies.shiftLabel,
            notes: interventionOccupancies.notes,
            code: interventionBases.code,
        }).from(interventionOccupancies)
            .innerJoin(interventionBases, eq(interventionBases.id, interventionOccupancies.baseId))
            .where(eq(interventionOccupancies.doctorId, doctorId))
            .orderBy(asc(interventionOccupancies.startedAt), asc(interventionOccupancies.createdAt));
        return rows.map((row) => ({
            code: row.code,
            started: hhmm(row.startedAt),
            board: hhmm(row.boardStartedAt),
            ended: hhmm(row.endedAt),
            schedEnd: hhmm(row.scheduledEndAt),
            shift: row.shiftLabel,
            notes: row.notes ?? "",
        }));
    }

    // Resumo estável de uma linha: sem ids/grupo (aleatórios) e sem notas.
    type Row = Awaited<ReturnType<typeof regulationRows>>[number] | Awaited<ReturnType<typeof interventionRows>>[number];
    function brief(rows: Row[]) {
        return rows.map((row) => [row.code, row.started, row.board, row.ended, row.schedEnd, row.shift, "role" in row ? row.role : "-"].join(" "));
    }

    async function status() {
        return (await lastLog()).status;
    }

    test("posto vazio: cria a ocupação e assume o quadro com a hora do aviso", async () => {
        const a = await createDoctor("Livia");
        await send(`2153 ${a.name} SD`, at("2026-09-14T07:05:00"));
        assert.equal(await status(), "accepted");
        assert.deepEqual(brief(await regulationRows(a.id)), ["2153 07:05 07:05  19:15 SD "]);
        assert.match(replies[0], /na 2153 desde 07:05/);
    });

    test("D1/D5: reenvio no mesmo turno atualiza no lugar e mantém a 1ª chegada", async () => {
        const a = await createDoctor("Livia");
        await send(`2151 ${a.name} SD`, at("2026-09-14T07:10:00"));
        await send(`2151 ${a.name} SD`, at("2026-09-14T18:40:00"));
        assert.equal(await status(), "accepted");
        assert.deepEqual(brief(await regulationRows(a.id)), ["2151 07:10 07:10  19:15 SD MRV"]);
        assert.match(replies[1], /desde 07:10 — chegada mantida pelo primeiro aviso/);
    });

    test("D2: SD→SN segundos depois da própria chegada é correção de rótulo, não continuação", async () => {
        const a = await createDoctor("Emily");
        await send(`2034 ${a.name} sd`, at("2026-09-14T19:08:05"));
        await send(`2034 ${a.name} sn`, at("2026-09-14T19:08:15"));
        assert.equal(await status(), "accepted");
        assert.deepEqual(brief(await regulationRows(a.id)), ["2034 19:08 19:08  07:15 SN "]);
        assert.doesNotMatch(replies[1], /continua/);
    });

    test("D6: reenvio à tarde de quem chegou de manhã não vira meio plantão", async () => {
        const a = await createDoctor("Jonas");
        await send(`2154 ${a.name} SD`, at("2026-09-14T07:16:00"));
        await send(`2154 ${a.name} SD`, at("2026-09-14T16:12:00"));
        assert.equal(await status(), "accepted");
        assert.deepEqual(brief(await regulationRows(a.id)), ["2154 07:16 07:16  19:15 SD "]);
    });

    test("meio plantão: chegada nova na faixa 11:10–17:00 com 'meio plantão' fecha às 17:00", async () => {
        const a = await createDoctor("Marta");
        await send(`2152 ${a.name} meio plantão`, at("2026-09-14T12:05:00"));
        assert.equal(await status(), "accepted");
        const rows = await regulationRows(a.id);
        assert.deepEqual(brief(rows), ["2152 12:05 12:05  17:00  MEIO_PLANTAO"]);
        assert.equal(rows[0].schedStart, "11:30");
        assert.match(replies[0], /Meio plantão da tarde/);
    });

    test("D7: 'SD' às 18:35 sem plantão aberto pergunta SD/SN e não grava", async () => {
        const a = await createDoctor("Gerardo");
        await send(`2033 ${a.name} SD`, at("2026-09-14T18:35:00"));
        assert.equal(await status(), "pending_shift_selection");
        assert.deepEqual(await regulationRows(a.id), []);
        assert.match(replies[0], /É o \*SD\* que termina às 19h ou o \*SN\*/);
    });

    test("tomada: pede confirmação; reenvio exato desloca o ocupante com a 1ª tentativa; deslocado que reenvia passa pelo portão", async () => {
        const a = await createDoctor("Ana");
        const b = await createDoctor("Bruno");
        await send(`2032 ${a.name} SD`, at("2026-09-14T07:00:00"), 900_010);
        await send(`2032 ${b.name} SD`, at("2026-09-14T08:00:00"), 900_011);
        assert.equal(await status(), "pending_takeover_confirmation");
        assert.deepEqual(await regulationRows(b.id), []);
        assert.match(replies[1], /POSTO OCUPADO/);

        replies.length = 0;
        await send(`2032 ${b.name} SD`, at("2026-09-14T08:05:00"), 900_011);
        assert.equal(await status(), "accepted");
        const rowsA = await regulationRows(a.id);
        assert.deepEqual(brief(rowsA), ["2032 07:00   19:15 SD MRV"]);
        assert.match(rowsA[0].notes, /\[DESLOCADO\] 2026-09-14T11:00:00.000Z por /);
        assert.deepEqual(brief(await regulationRows(b.id)), ["2032 08:00 08:00  19:15 SD MRV"]);
        assert.match(replies[0], /desde 08:00 — chegada mantida pelo primeiro aviso/);
        assert.match(replies[1], /assumiu \*2032\*/);

        replies.length = 0;
        await send(`2032 ${a.name} SD`, at("2026-09-14T09:00:00"), 900_010);
        assert.equal(await status(), "pending_takeover_confirmation");
        assert.deepEqual(brief(await regulationRows(a.id)), ["2032 07:00   19:15 SD MRV"]);
    });

    test("rendição: quem chega no SD encerra o SN anterior na hora da chegada", async () => {
        const a = await createDoctor("Carlos");
        const b = await createDoctor("Diana");
        await send(`2031 ${a.name} SN`, at("2026-09-13T19:02:00"), 900_020);
        await send(`2031 ${b.name} SD`, at("2026-09-14T07:05:00"), 900_021);
        assert.equal(await status(), "accepted");
        assert.deepEqual(brief(await regulationRows(a.id)), ["2031 19:02 19:02 07:05 07:15 SN CP"]);
        assert.deepEqual(brief(await regulationRows(b.id)), ["2031 07:05 07:05  19:15 SD CP"]);
    });

    test("D12: 'remanejada para' sem plantão aberto vira chegada", async () => {
        const a = await createDoctor("Yngra");
        await send(`${a.name} remanejada para 1321 SD`, at("2026-09-14T07:20:00"));
        assert.equal(await status(), "accepted");
        assert.deepEqual(brief(await regulationRows(a.id)), ["1321 07:20 07:20  19:15 SD RMT"]);
    });

    test("troca de ramal com plantão aberto é tratada como remanejo (implícito)", async () => {
        // O remanejo (transferOperationalOccupancy) usa o relógio real: com data fixa
        // no passado a origem já está vencida e o remanejo é recusado. O que se trava
        // aqui é a CLASSIFICAÇÃO: foi para o remanejo, não virou chegada nova.
        const a = await createDoctor("Paulo");
        await send(`1322 ${a.name} SD`, at("2026-09-14T07:00:00"));
        await send(`1323 ${a.name} SD`, at("2026-09-14T10:00:00"));
        assert.equal(await status(), "error");
        assert.deepEqual((await regulationRows(a.id)).map((row) => row.code), ["1322"]);
        assert.match(replies[1], /registre como chegada normal em vez de remanejamento/);
    });

    test("remanejo depois do fim do turno de origem vira chegada do turno atual", async () => {
        const a = await createDoctor("Rita");
        await send(`1324 ${a.name} SD`, at("2026-09-14T07:00:00"));
        await send(`${a.name} remanejada para 1325`, at("2026-09-14T19:40:00"));
        assert.equal(await status(), "accepted");
        const rows = await regulationRows(a.id);
        assert.deepEqual(brief(rows), ["1324 07:00 07:00 19:15 19:15 SD RMT", "1325 19:40 19:40  07:15 SN RMT"]);
        assert.equal(rows[0].group, rows[1].group);
    });

    test("SD→SN no mesmo ramal horas depois é continuação (P, chegada original)", async () => {
        const a = await createDoctor("Sergio");
        await send(`1326 ${a.name} SD`, at("2026-09-14T07:00:00"));
        await send(`1326 ${a.name} SN`, at("2026-09-14T18:50:00"));
        assert.equal(await status(), "accepted");
        assert.deepEqual(brief(await regulationRows(a.id)), ["1326 07:00 07:00  07:15 P "]);
        assert.match(replies[1], /continua em 1326 desde 07:00/);
    });

    test("'continuando' em outro ramal abre bloco novo no mesmo grupo", async () => {
        const a = await createDoctor("Tania");
        await send(`1327 ${a.name} SD`, at("2026-09-14T07:00:00"));
        await send(`${a.name} continuando 1328 SN`, at("2026-09-14T19:05:00"));
        assert.equal(await status(), "accepted");
        const rows = await regulationRows(a.id);
        assert.deepEqual(brief(rows), ["1327 07:00 07:00 19:05 19:15 SD ", "1328 19:05 19:05  07:15 SN "]);
        assert.equal(rows[0].group, rows[1].group);
        assert.match(replies[1], /continua em 1328/);
    });

    test("'continuando' no mesmo ramal estende o plantão (P)", async () => {
        const a = await createDoctor("Felipe");
        await send(`1361 ${a.name} SD`, at("2026-09-14T07:00:00"));
        await send(`${a.name} continuando 1361`, at("2026-09-14T18:55:00"));
        assert.equal(await status(), "accepted");
        assert.deepEqual(brief(await regulationRows(a.id)), ["1361 07:00 07:00  07:15 P RMT"]);
    });

    test("SN em outro ramal depois do SD: continuidade implícita no mesmo grupo", async () => {
        const a = await createDoctor("Helena");
        await send(`1362 ${a.name} SD`, at("2026-09-14T07:00:00"));
        await send(`1363 ${a.name} SN`, at("2026-09-14T19:05:00"));
        assert.equal(await status(), "accepted");
        const rows = await regulationRows(a.id);
        assert.deepEqual(brief(rows), ["1362 07:00 07:00 19:05 19:15 SD RMT", "1363 19:05 19:05  07:15 SN RMT"]);
        assert.equal(rows[0].group, rows[1].group);
    });

    test("base com titular: quem chega vira dupla, sem portão de tomada", async () => {
        const a = await createDoctor("Uemerson");
        const b = await createDoctor("Vera");
        await send(`PR03 ${a.name} SD`, at("2026-09-14T07:00:00"), 900_030);
        await send(`PR03 ${b.name} SD`, at("2026-09-14T07:30:00"), 900_031);
        assert.equal(await status(), "accepted");
        assert.deepEqual(brief(await interventionRows(a.id)), ["PR03 07:00 07:00  19:00 SD -"]);
        const rowsB = await interventionRows(b.id);
        assert.deepEqual(brief(rowsB), ["PR03 07:30   19:00 SD -"]);
        assert.match(rowsB[0].notes, /\[DUPLA\]/);
    });

    test("intervenção: reenvio no mesmo turno mantém a 1ª chegada", async () => {
        const a = await createDoctor("Igor");
        await send(`PM04 ${a.name} SD`, at("2026-09-14T07:10:00"));
        await send(`PM04 ${a.name} SD`, at("2026-09-14T18:20:00"));
        assert.equal(await status(), "accepted");
        assert.deepEqual(brief(await interventionRows(a.id)), ["PM04 07:10 07:10  19:00 SD -"]);
        assert.match(replies[1], /desde 07:10 — chegada mantida pelo primeiro aviso/);
    });

    test("sombra não pega o quadro nem passa pelo portão de tomada", async () => {
        const a = await createDoctor("Wagner");
        const b = await createDoctor("Leonardo");
        await send(`2035 ${a.name} SD`, at("2026-09-14T07:00:00"), 900_040);
        await send(`${b.name} sombra 2035 SD`, at("2026-09-14T07:14:00"), 900_041);
        assert.equal(await status(), "accepted");
        assert.deepEqual(brief(await regulationRows(a.id)), ["2035 07:00 07:00  19:15 SD "]);
        const rowsB = await regulationRows(b.id);
        assert.deepEqual(brief(rowsB), ["2035 07:14   19:15 SD "]);
        assert.match(rowsB[0].notes, /\[telegram sombra\]/);
    });

    test("PIAM: médico PIAM é alocado no PIAM com 07:00–19:00, qualquer ramal citado", async () => {
        const a = await createDoctor("Joana");
        await getDb().update(doctors).set({ metadata: { preferredOperationalRole: "PIAM" } }).where(eq(doctors.id, a.id));
        await send(`1364 ${a.name} SD`, at("2026-09-14T07:03:00"));
        assert.equal(await status(), "accepted");
        assert.deepEqual(brief(await regulationRows(a.id)), ["PIAM 07:00 07:00 19:00 19:00 SD PIAM"]);
    });
    test("D8: edição de aviso sem efeito é reprocessada com a hora da mensagem original", async () => {
        const a = await createDoctor("Otavio");
        const sentAt = at("2026-09-14T07:02:00");
        await send(`${a.name} chegou`, sentAt);
        const original = await lastLog();
        assert.notEqual(original.status, "accepted");
        updateId += 1;
        await processTelegramUpdate({
            update_id: updateId,
            edited_message: {
                message_id: messageId,
                date: Math.floor(sentAt.getTime() / 1000),
                edit_date: Math.floor(at("2026-09-14T07:04:00").getTime() / 1000),
                chat: { id: chatId, type: "group" },
                from: { id: 900_001, first_name: "Tarm" },
                text: `1365 ${a.name} SD`,
            },
        } as unknown as TelegramUpdate);
        assert.equal(await status(), "accepted");
        assert.deepEqual(brief(await regulationRows(a.id)), ["1365 07:02 07:02  19:15 SD RMT"]);
    });
});

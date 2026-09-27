import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, afterEach, beforeEach, describe, test } from "node:test";

import { inArray, like } from "drizzle-orm";

import { closeDb, getDb } from "@/db";
import { doctors, regulationOccupancies, regulationPosts, telegramBotNotices, telegramIngestedMessages } from "@/db/schema";
import { resolveOccupancyDirection } from "@/modules/operational/board-rules";
import {
    buildAvisoFimTurnoMessage,
    loadAvisoFimTurnoCandidates,
    resolveAvisoFimTurnoMode,
    resolveFimTurnoJanela,
    sendAvisoFimTurnoCycle,
} from "@/modules/telegram/aviso-fim-turno";

const at = (iso: string) => new Date(iso);

test("flag TELEGRAM_AVISO_FIM_TURNO: mesmos valores do TELEGRAM_DM_FECHAMENTO", () => {
    assert.equal(resolveAvisoFimTurnoMode(undefined), "off");
    assert.equal(resolveAvisoFimTurnoMode("true"), "off");
    assert.equal(resolveAvisoFimTurnoMode(" ON "), "on");
    assert.equal(resolveAvisoFimTurnoMode("admins"), "admins");
});

test("janela do aviso: da virada oficial (19:00/07:00) até o fim da janela da regulação (19:15/07:15)", () => {
    assert.equal(resolveFimTurnoJanela(at("2031-02-11T18:59:00-03:00")), null);
    const sd = resolveFimTurnoJanela(at("2031-02-11T19:00:00-03:00"));
    assert.equal(sd?.turno, "SD");
    assert.equal(sd?.virada.toISOString(), at("2031-02-11T19:00:00-03:00").toISOString());
    assert.equal(sd?.fimJanela.toISOString(), at("2031-02-11T19:15:00-03:00").toISOString());
    assert.equal(resolveFimTurnoJanela(at("2031-02-11T19:14:59-03:00"))?.turno, "SD");
    assert.equal(resolveFimTurnoJanela(at("2031-02-11T19:15:00-03:00")), null);
    const sn = resolveFimTurnoJanela(at("2031-02-12T07:05:00-03:00"));
    assert.equal(sn?.turno, "SN");
    assert.equal(sn?.fimJanela.toISOString(), at("2031-02-12T07:15:00-03:00").toISOString());
    assert.equal(resolveFimTurnoJanela(at("2031-02-12T12:00:00-03:00")), null);
});

test("mensagem: sem sucessor segue no painel; com sucessor diz quem; sempre o comando de saída", () => {
    const base = { doctorName: "Ana Souza", postCode: "2151", virada: at("2031-02-11T19:00:00-03:00"), fimJanela: at("2031-02-11T19:15:00-03:00") };
    const sozinho = buildAvisoFimTurnoMessage({ ...base, successor: null });
    assert.match(sozinho, /terminou às 19:00/);
    assert.match(sozinho, /segue no painel até 19:15 para o auxiliar poder passar ocorrência/);
    assert.match(sozinho, /`Ana Souza saindo 2151 19:00`/);
    const rendido = buildAvisoFimTurnoMessage({ ...base, successor: "Bruno" });
    assert.match(rendido, /\*Bruno\* já assumiu o ramal/);
    assert.doesNotMatch(rendido, /segue no painel/);
});

test("painel: titular do SD aparece 'saindo' entre 19:00 e 19:15; antes não; P 24h não", () => {
    // O destaque já existe (resolveOccupancyDirection → .is-leaving no quadro).
    const sd = { startedAt: "2031-02-11T06:55:00-03:00", scheduledEndAt: "2031-02-11T19:15:00-03:00", shiftLabel: "SD" as const };
    assert.equal(resolveOccupancyDirection({ ...sd, reference: "2031-02-11T18:59:00-03:00" }).status, "entrando");
    assert.equal(resolveOccupancyDirection({ ...sd, reference: "2031-02-11T19:00:00-03:00" }).status, "saindo");
    assert.equal(resolveOccupancyDirection({ ...sd, reference: "2031-02-11T19:14:00-03:00" }).status, "saindo");
    const sn = { startedAt: "2031-02-11T18:55:00-03:00", scheduledEndAt: "2031-02-12T07:15:00-03:00", shiftLabel: "SN" as const };
    assert.equal(resolveOccupancyDirection({ ...sn, reference: "2031-02-12T07:05:00-03:00" }).status, "saindo");
    const p = { startedAt: "2031-02-11T06:58:00-03:00", scheduledEndAt: "2031-02-12T07:15:00-03:00", shiftLabel: "P" as const };
    assert.equal(resolveOccupancyDirection({ ...p, reference: "2031-02-11T19:05:00-03:00" }).status, "entrando");
});

describe("sendAvisoFimTurnoCycle (banco + Telegram mockado)", { skip: !/_test\b/.test(process.env.DATABASE_URL ?? "") }, () => {
    const originalFetch = globalThis.fetch;
    const envKeys = ["TELEGRAM_BOT_TOKEN", "TELEGRAM_ADMIN_IDS", "TELEGRAM_AVISO_FIM_TURNO"] as const;
    const originalEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
    const tag = randomUUID().slice(0, 6).toUpperCase();
    const doctorIds: string[] = [];
    const postIds: number[] = [];
    const chats = new Map<string, string>();
    let calls: Array<{ chat_id: number; text: string }>;
    let telegramFails: boolean;
    const deps = {
        loadCandidates: loadAvisoFimTurnoCandidates,
        findChatId: async (doctorId: string) => chats.get(doctorId) ?? null,
    };
    const ids: Record<string, string> = {};

    async function doctor(key: string, withChat = true) {
        const [row] = await getDb().insert(doctors).values({
            fullName: `Medico ${key} ${tag}`,
            normalizedName: `medico ${key} ${tag}`.toLowerCase(),
        }).returning({ id: doctors.id });
        doctorIds.push(row.id);
        ids[key] = row.id;
        if (withChat) chats.set(row.id, String(800_000_000 + doctorIds.length));
        return row.id;
    }

    async function post(key: string) {
        const [row] = await getDb().insert(regulationPosts).values({ code: `T${key}${tag}`, label: key }).returning({ id: regulationPosts.id });
        postIds.push(row.id);
        return row.id;
    }

    async function occupancy(values: {
        doctorId: string;
        postId: number;
        startedAt: string;
        scheduledEndAt: string | null;
        shiftLabel: string;
        actualEndedAt?: string;
        shadow?: boolean;
        roleLabel?: string;
    }) {
        const [row] = await getDb().insert(regulationOccupancies).values({
            doctorId: values.doctorId,
            continuityGroupId: randomUUID(),
            postId: values.postId,
            startedAt: at(values.startedAt),
            boardStartedAt: values.shadow ? null : at(values.startedAt),
            scheduledEndAt: values.scheduledEndAt ? at(values.scheduledEndAt) : null,
            endedAt: values.actualEndedAt ? at(values.actualEndedAt) : null,
            actualEndedAt: values.actualEndedAt ? at(values.actualEndedAt) : null,
            shiftLabel: values.shiftLabel,
            roleLabel: values.roleLabel ?? null,
            source: "telegram",
        }).returning({ id: regulationOccupancies.id });
        return row.id;
    }

    beforeEach(async () => {
        calls = [];
        telegramFails = false;
        process.env.TELEGRAM_BOT_TOKEN = "test-token";
        process.env.TELEGRAM_ADMIN_IDS = "111";
        process.env.TELEGRAM_AVISO_FIM_TURNO = "on";
        globalThis.fetch = (async (_url: string, init?: RequestInit) => {
            const body = JSON.parse(String(init?.body));
            calls.push({ chat_id: body.chat_id, text: body.text });
            const payload = telegramFails
                ? { ok: false, description: "Forbidden: bot was blocked by the user" }
                : { ok: true, result: { message_id: 1, chat: { id: body.chat_id, type: "private" }, date: 0 } };
            return new Response(JSON.stringify(payload));
        }) as typeof fetch;

        const d = "2031-02-11";
        // Titular do SD sem sucessor: segue no painel.
        await occupancy({ doctorId: await doctor("sozinho"), postId: await post("A"), startedAt: `${d}T06:55:00-03:00`, scheduledEndAt: `${d}T19:15:00-03:00`, shiftLabel: "SD" });
        // Rendido às 18:50 pelo SN (saída carimbada na chegada do sucessor).
        const postB = await post("B");
        await occupancy({ doctorId: await doctor("rendido"), postId: postB, startedAt: `${d}T06:58:00-03:00`, scheduledEndAt: `${d}T19:15:00-03:00`, shiftLabel: "SD", actualEndedAt: `${d}T18:50:00-03:00` });
        await occupancy({ doctorId: await doctor("sucessor"), postId: postB, startedAt: `${d}T18:50:00-03:00`, scheduledEndAt: "2031-02-12T07:15:00-03:00", shiftLabel: "SN" });
        // Já avisou a saída.
        const declarou = await occupancy({ doctorId: await doctor("declarou"), postId: await post("C"), startedAt: `${d}T07:01:00-03:00`, scheduledEndAt: `${d}T19:15:00-03:00`, shiftLabel: "SD", actualEndedAt: `${d}T18:40:00-03:00` });
        await getDb().insert(telegramIngestedMessages).values({
            telegramMessageId: Math.floor(Math.random() * 1_000_000_000),
            chatId: `-${tag}`,
            rawText: "saindo",
            parsedAction: "departure",
            relatedOccupancyId: declarou,
            status: "applied",
        });
        // Declarou continuação: janela vai até 07:15 de amanhã.
        await occupancy({ doctorId: await doctor("continua"), postId: await post("D"), startedAt: `${d}T06:50:00-03:00`, scheduledEndAt: "2031-02-12T07:15:00-03:00", shiftLabel: "SD" });
        // Sombra (sem titularidade no quadro).
        await occupancy({ doctorId: await doctor("sombra"), postId: await post("E"), startedAt: `${d}T07:00:00-03:00`, scheduledEndAt: `${d}T19:15:00-03:00`, shiftLabel: "SD", shadow: true });
        // Meio plantão fechado às 17:00.
        await occupancy({ doctorId: await doctor("meio"), postId: await post("F"), startedAt: `${d}T12:05:00-03:00`, scheduledEndAt: `${d}T17:00:00-03:00`, shiftLabel: "SD", roleLabel: "MEIO_PLANTAO", actualEndedAt: `${d}T17:00:00-03:00` });
        // P 24h: só termina às 07:00 de amanhã.
        await occupancy({ doctorId: await doctor("p24"), postId: await post("G"), startedAt: `${d}T06:57:00-03:00`, scheduledEndAt: "2031-02-12T07:15:00-03:00", shiftLabel: "P" });
        // Sem chat privado conhecido.
        await occupancy({ doctorId: await doctor("semchat", false), postId: await post("H"), startedAt: `${d}T06:59:00-03:00`, scheduledEndAt: `${d}T19:15:00-03:00`, shiftLabel: "SD" });
    });

    afterEach(async () => {
        globalThis.fetch = originalFetch;
        for (const key of envKeys) {
            if (originalEnv[key] === undefined) delete process.env[key];
            else process.env[key] = originalEnv[key];
        }
        const db = getDb();
        await db.delete(telegramBotNotices).where(like(telegramBotNotices.noticeKey, "aviso-fim-turno:%"));
        await db.delete(telegramIngestedMessages).where(like(telegramIngestedMessages.chatId, `-${tag}`));
        if (doctorIds.length) await db.delete(regulationOccupancies).where(inArray(regulationOccupancies.doctorId, doctorIds));
        if (postIds.length) await db.delete(regulationPosts).where(inArray(regulationPosts.id, postIds));
        if (doctorIds.length) await db.delete(doctors).where(inArray(doctors.id, doctorIds));
        doctorIds.length = 0;
        postIds.length = 0;
        chats.clear();
    });

    after(async () => {
        await closeDb();
    });

    const recipients = () => calls.map((call) => String(call.chat_id));

    test("19:02: só o titular sem sucessor e o rendido recebem, cada um no seu privado", async () => {
        const result = await sendAvisoFimTurnoCycle(at("2031-02-11T19:02:00-03:00"), deps);
        assert.deepEqual(result, { sent: 2, evaluated: 2 });
        assert.deepEqual(recipients().sort(), [chats.get(ids.sozinho), chats.get(ids.rendido)].sort());
        const sozinho = calls.find((call) => String(call.chat_id) === chats.get(ids.sozinho))!;
        assert.match(sozinho.text, /segue no painel até 19:15/);
        const rendido = calls.find((call) => String(call.chat_id) === chats.get(ids.rendido))!;
        assert.match(rendido.text, new RegExp(`Medico sucessor ${tag}\\* já assumiu`));
    });

    test("idempotente: o ciclo seguinte (30s depois) não reenvia", async () => {
        await sendAvisoFimTurnoCycle(at("2031-02-11T19:02:00-03:00"), deps);
        const again = await sendAvisoFimTurnoCycle(at("2031-02-11T19:02:30-03:00"), deps);
        assert.equal(again.sent, 0);
        assert.equal(calls.length, 2);
    });

    test("antes das 19:00 e depois das 19:15: nada", async () => {
        assert.equal((await sendAvisoFimTurnoCycle(at("2031-02-11T18:59:00-03:00"), deps)).sent, 0);
        assert.equal((await sendAvisoFimTurnoCycle(at("2031-02-11T19:15:00-03:00"), deps)).sent, 0);
        assert.equal(calls.length, 0);
    });

    test("P 24h recebe na virada das 07:00 do dia seguinte", async () => {
        const result = await sendAvisoFimTurnoCycle(at("2031-02-12T07:01:00-03:00"), deps);
        assert.ok(recipients().includes(chats.get(ids.p24)!));
        assert.ok(recipients().includes(chats.get(ids.continua)!), "continuação do SD termina às 07:00 também");
        assert.ok(recipients().includes(chats.get(ids.sucessor)!), "o SN que rendeu às 18:50 termina às 07:00");
        assert.ok(!recipients().includes(chats.get(ids.sozinho)!), "o SD de ontem já teve o aviso dele");
        assert.equal(result.sent, 3);
    });

    test("off: não envia", async () => {
        process.env.TELEGRAM_AVISO_FIM_TURNO = "off";
        assert.deepEqual(await sendAvisoFimTurnoCycle(at("2031-02-11T19:02:00-03:00"), deps), { sent: 0, evaluated: 0 });
        assert.equal(calls.length, 0);
    });

    test("admins: ensaio vai só para os admins e não consome o envio real", async () => {
        process.env.TELEGRAM_AVISO_FIM_TURNO = "admins";
        await sendAvisoFimTurnoCycle(at("2031-02-11T19:02:00-03:00"), deps);
        assert.deepEqual(recipients(), ["111", "111"]);
        assert.match(calls[0].text, /^🧪 Ensaio — iria para Medico/);

        process.env.TELEGRAM_AVISO_FIM_TURNO = "on";
        calls = [];
        const real = await sendAvisoFimTurnoCycle(at("2031-02-11T19:03:00-03:00"), deps);
        assert.equal(real.sent, 2);
    });

    test("falha no Telegram libera a reserva e não derruba o ciclo", async () => {
        telegramFails = true;
        const failed = await sendAvisoFimTurnoCycle(at("2031-02-11T19:02:00-03:00"), deps);
        assert.equal(failed.sent, 0);
        telegramFails = false;
        const retried = await sendAvisoFimTurnoCycle(at("2031-02-11T19:02:30-03:00"), deps);
        assert.equal(retried.sent, 2);
    });
});

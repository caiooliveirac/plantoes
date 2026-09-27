import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, afterEach, beforeEach, describe, test } from "node:test";

import { eq, like } from "drizzle-orm";

import { closeDb, getDb } from "@/db";
import { telegramBotNotices, telegramIngestedMessages } from "@/db/schema";
import { verifyFolhaToken } from "@/lib/folha-ponto/token";
import type { ChiefPayableBoardModel, ChiefPayableDoctorRow, PayableShift } from "@/modules/reporting/payable-shifts";
import {
    buildFechamentoDoctorMessage,
    notifyDoctorMonthClosed,
    resolveFechamentoDmMode,
    type FechamentoDoctorNoticeDeps,
} from "@/modules/telegram/fechamento-doctor-notice";

test("flag TELEGRAM_DM_FECHAMENTO: só on/admins ligam; o resto é off", () => {
    assert.equal(resolveFechamentoDmMode(undefined), "off");
    assert.equal(resolveFechamentoDmMode(""), "off");
    assert.equal(resolveFechamentoDmMode("true"), "off");
    assert.equal(resolveFechamentoDmMode(" ON "), "on");
    assert.equal(resolveFechamentoDmMode("admins"), "admins");
});

test("mensagem: contagem, R$, folha e pendência de saída tardia", () => {
    const text = buildFechamentoDoctorMessage({
        monthLabel: "Junho 2026",
        shiftCount: 3,
        total: 4500,
        folhaUrl: "https://x/folha",
        pendingLateDepartures: 2,
    });
    assert.match(text, /Fechamento de Junho 2026: 3 plantões, R\$\s?4\.500,00, folha pronta\./);
    assert.match(text, /2 saídas tardias ainda aguardam validação da chefia/);
    assert.match(text, /Folha de ponto: https:\/\/x\/folha$/);
});

test("mensagem: estatutário sem R$ e sem linha de pendência quando não há", () => {
    const text = buildFechamentoDoctorMessage({
        monthLabel: "Junho 2026",
        shiftCount: 1,
        total: null,
        folhaUrl: "https://x/folha",
        pendingLateDepartures: 0,
    });
    assert.equal(text, "📄 Fechamento de Junho 2026: 1 plantão, folha pronta.\nFolha de ponto: https://x/folha");
});

function makeShift(operationalDate: string): PayableShift {
    return {
        payableShiftId: randomUUID(),
        occupancyId: randomUUID(),
        domain: "regulation",
        doctorId: "doc",
        doctorName: "Médico",
        displayName: null,
        targetCode: "PR03",
        targetLabel: "PR03",
        tagCode: "PR03",
        operationalDate,
        shiftLabel: "SD",
        slotStartedAt: `${operationalDate}T10:00:00.000Z`,
        slotEndedAt: `${operationalDate}T22:00:00.000Z`,
        startedAt: `${operationalDate}T10:00:00.000Z`,
        endedAt: `${operationalDate}T22:00:00.000Z`,
        actualEndedAt: null,
        scheduledStartAt: null,
        scheduledEndAt: null,
        durationMinutes: 720,
        paymentStatus: "ready_for_payment",
        auditStatus: "clean",
        issues: [],
        source: "telegram",
        roleLabel: null,
        paymentUnit: 1,
        paymentTag: null,
        earlyDepartureOutcome: null,
    };
}

function makeBoard(doctorId: string, shiftCount: number, totalDue: number): ChiefPayableBoardModel {
    const shifts = Array.from({ length: shiftCount }, (_, index) => makeShift(`2026-06-${String(index + 1).padStart(2, "0")}`));
    const row: ChiefPayableDoctorRow = {
        doctorId,
        doctorName: "Fulana de Tal",
        displayName: null,
        paymentStatus: "ready_for_payment",
        totalSD: shiftCount,
        totalSN: 0,
        total: shiftCount,
        totalDue,
        pendingCount: 0,
        attestedAt: "2026-07-02T12:00:00.000Z",
        employmentType: "pj",
        usaShiftCount: 0,
        cruShiftCount: shiftCount,
        cells: shifts.map((shift) => ({ day: shift.operationalDate.slice(8, 10), shifts: [shift] })),
    };
    return { monthKey: "2026-06", monthLabel: "Junho 2026", doctors: [row] } as unknown as ChiefPayableBoardModel;
}

describe("notifyDoctorMonthClosed (banco + Telegram mockado)", { skip: !process.env.DATABASE_URL }, () => {
    const originalFetch = globalThis.fetch;
    const envKeys = ["TELEGRAM_BOT_TOKEN", "TELEGRAM_ADMIN_IDS", "TELEGRAM_DM_FECHAMENTO"] as const;
    const originalEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
    let calls: Array<{ chat_id: number; text: string }>;
    let telegramFails: boolean;
    let doctorId: string;
    let board: ChiefPayableBoardModel;
    const doctorChatId = String(700_000_000 + Math.floor(Math.random() * 1_000_000));
    const deps: FechamentoDoctorNoticeDeps = {
        loadBoard: async () => board,
        countPendingLateDepartures: async () => 1,
    };

    beforeEach(async () => {
        calls = [];
        telegramFails = false;
        doctorId = randomUUID();
        board = makeBoard(doctorId, 3, 4500);
        process.env.TELEGRAM_BOT_TOKEN = "test-token";
        process.env.TELEGRAM_ADMIN_IDS = "111,222";
        process.env.TELEGRAM_DM_FECHAMENTO = "on";
        globalThis.fetch = (async (_url: string, init?: RequestInit) => {
            const body = JSON.parse(String(init?.body));
            calls.push({ chat_id: body.chat_id, text: body.text });
            const payload = telegramFails
                ? { ok: false, description: "Forbidden: bot was blocked by the user" }
                : { ok: true, result: { message_id: 1, chat: { id: body.chat_id, type: "private" }, date: 0 } };
            return new Response(JSON.stringify(payload));
        }) as typeof fetch;
        // Canal privado conhecido: um /pagamento aceito do médico.
        await getDb().insert(telegramIngestedMessages).values({
            telegramMessageId: Math.floor(Math.random() * 1_000_000_000),
            chatId: doctorChatId,
            rawText: "/pagamento codinome",
            status: "accepted",
            resolutionData: { doctorId },
        });
    });

    afterEach(async () => {
        globalThis.fetch = originalFetch;
        for (const key of envKeys) {
            if (originalEnv[key] === undefined) delete process.env[key];
            else process.env[key] = originalEnv[key];
        }
        await getDb().delete(telegramBotNotices).where(like(telegramBotNotices.noticeKey, `fechamento-medico:${doctorId}:%`));
        await getDb().delete(telegramIngestedMessages).where(eq(telegramIngestedMessages.chatId, doctorChatId));
    });

    after(async () => {
        await closeDb();
    });

    test("off: não envia nada", async () => {
        process.env.TELEGRAM_DM_FECHAMENTO = "off";
        const result = await notifyDoctorMonthClosed({ doctorId, monthKey: "2026-06" }, deps);
        assert.deepEqual(result, { status: "disabled" });
        assert.equal(calls.length, 0);
    });

    test("on: envia ao médico com os números do /pagamento e link assinado da folha", async () => {
        const result = await notifyDoctorMonthClosed({ doctorId, monthKey: "2026-06" }, deps);
        assert.deepEqual(result, { status: "sent", chatIds: [doctorChatId] });
        assert.equal(calls.length, 1);
        assert.equal(String(calls[0].chat_id), doctorChatId);
        assert.match(calls[0].text, /3 plantões, R\$\s?4\.500,00, folha pronta/);
        assert.match(calls[0].text, /1 saída tardia ainda aguarda validação/);
        const token = calls[0].text.match(new RegExp(`/folha-ponto/${doctorId}/2026/06\\?t=(\\S+)`))?.[1];
        assert.ok(token, "link da folha ausente");
        const payload = verifyFolhaToken(token);
        assert.equal(payload?.medicoId, doctorId);
        assert.equal(payload?.mes, 6);
    });

    test("reassinar sem mudança não reenvia; números novos reenviam", async () => {
        await notifyDoctorMonthClosed({ doctorId, monthKey: "2026-06" }, deps);
        const repeat = await notifyDoctorMonthClosed({ doctorId, monthKey: "2026-06" }, deps);
        assert.deepEqual(repeat, { status: "already_sent" });
        assert.equal(calls.length, 1);

        board = makeBoard(doctorId, 4, 6000);
        const changed = await notifyDoctorMonthClosed({ doctorId, monthKey: "2026-06" }, deps);
        assert.equal(changed.status, "sent");
        assert.equal(calls.length, 2);
        assert.match(calls[1].text, /4 plantões/);
    });

    test("falha no Telegram libera a reserva: a próxima atestação tenta de novo", async () => {
        telegramFails = true;
        const failed = await notifyDoctorMonthClosed({ doctorId, monthKey: "2026-06" }, deps);
        assert.deepEqual(failed, { status: "failed" });

        telegramFails = false;
        const retried = await notifyDoctorMonthClosed({ doctorId, monthKey: "2026-06" }, deps);
        assert.equal(retried.status, "sent");
    });

    test("admins: ensaio vai para os admins, nunca para o médico", async () => {
        process.env.TELEGRAM_DM_FECHAMENTO = "admins";
        const result = await notifyDoctorMonthClosed({ doctorId, monthKey: "2026-06" }, deps);
        assert.deepEqual(result, { status: "sent", chatIds: ["111", "222"] });
        assert.deepEqual(calls.map((call) => String(call.chat_id)), ["111", "222"]);
        assert.match(calls[0].text, /^🧪 Ensaio — iria para .*Fulana/);
        assert.match(calls[0].text, /3 plantões/);

        // O ensaio não consome o envio real.
        process.env.TELEGRAM_DM_FECHAMENTO = "on";
        const real = await notifyDoctorMonthClosed({ doctorId, monthKey: "2026-06" }, deps);
        assert.deepEqual(real, { status: "sent", chatIds: [doctorChatId] });
    });

    test("sem chat privado conhecido: não envia", async () => {
        const other = randomUUID();
        board = makeBoard(other, 2, 3000);
        const result = await notifyDoctorMonthClosed({ doctorId: other, monthKey: "2026-06" }, deps);
        assert.deepEqual(result, { status: "no_known_chat" });
        assert.equal(calls.length, 0);
    });

    test("sem plantão no mês: não envia", async () => {
        board = makeBoard(doctorId, 0, 0);
        const result = await notifyDoctorMonthClosed({ doctorId, monthKey: "2026-06" }, deps);
        assert.deepEqual(result, { status: "no_shifts" });
        assert.equal(calls.length, 0);
    });
});

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, afterEach, before, describe, test } from "node:test";

import { inArray, like } from "drizzle-orm";

import { closeDb, getDb } from "@/db";
import {
    auditLogs,
    bankHoursEntries,
    doctors,
    regulationOccupancies,
    regulationPosts,
    telegramBotNotices,
} from "@/db/schema";
import {
    isVerificacaoPosViradaEnabled,
    resolveVerificacaoPosVirada,
    sendVerificacaoPosViradaCycle,
} from "@/modules/telegram/verificacao-pos-virada-cycle";
import {
    formatVerificacaoResumo,
    hasVerificacaoAchado,
    runVerificacaoPosVirada,
} from "@/services/verificacao-pos-virada.service";

test("flag VERIFICACAO_POS_VIRADA: só 'on' liga", () => {
    assert.equal(isVerificacaoPosViradaEnabled(undefined), false);
    assert.equal(isVerificacaoPosViradaEnabled("1"), false);
    assert.equal(isVerificacaoPosViradaEnabled(" On "), true);
});

test("agenda: uma hora depois da virada das 07:00/19:00, janela das 12h anteriores", () => {
    // 07:30 SP: a virada das 07:00 ainda não completou uma hora.
    assert.equal(resolveVerificacaoPosVirada(new Date("2020-03-10T10:30:00Z")), null);

    const manha = resolveVerificacaoPosVirada(new Date("2020-03-10T12:05:00Z"));
    assert.equal(manha?.virada.toISOString(), "2020-03-10T10:00:00.000Z");
    assert.equal(manha?.janela.inicio.toISOString(), "2020-03-09T23:00:00.000Z");
    assert.equal(manha?.janela.fim.toISOString(), "2020-03-10T11:00:00.000Z");

    // 01:00 SP ainda pertence à virada das 19:00 do dia anterior.
    const noite = resolveVerificacaoPosVirada(new Date("2020-03-11T04:00:00Z"));
    assert.equal(noite?.virada.toISOString(), "2020-03-10T22:00:00.000Z");
    assert.equal(noite?.janela.fim.toISOString(), "2020-03-10T23:00:00.000Z");
});

describe("verificação pós-virada contra o banco", { skip: !process.env.DATABASE_URL }, () => {
    const janela = { inicio: new Date("2020-03-09T23:00:00Z"), fim: new Date("2020-03-10T11:00:00Z") };
    const dentro = new Date("2020-03-10T09:00:00Z");
    const tag = randomUUID().slice(0, 8);
    const doctorIds = [randomUUID(), randomUUID(), randomUUID()];
    let postIds: number[] = [];
    const occupancyIds: string[] = [];
    const auditIds: string[] = [];

    before(async () => {
        const db = getDb();
        await db.insert(doctors).values(doctorIds.map((id, index) => ({
            id,
            fullName: `VPV ${tag} Médico ${index + 1}`,
            normalizedName: `vpv ${tag} medico ${index + 1}`,
        })));
        const posts = await db.insert(regulationPosts)
            .values(["A", "B", "C"].map((suffix) => ({ code: `V${tag}${suffix}`, label: `VPV ${suffix}` })))
            .returning({ id: regulationPosts.id });
        postIds = posts.map((post) => post.id);
        const [postA, postB, postC] = postIds;
        const [d1, d2, d3] = doctorIds;
        const fimSD = new Date("2020-03-09T22:00:00Z");

        const occupancy = (values: Partial<typeof regulationOccupancies.$inferInsert> & {
            doctorId: string;
            postId: number;
            startedAt: Date;
            endedAt: Date;
        }) => {
            const id = randomUUID();
            occupancyIds.push(id);
            return { id, continuityGroupId: randomUUID(), source: "telegram" as const, ...values };
        };

        await db.insert(regulationOccupancies).values([
            // Escapou da regra das 10h: +11h, sem marca, ninguém assumiu o ramal A.
            occupancy({
                doctorId: d1, postId: postA, shiftLabel: "SD",
                startedAt: new Date("2020-03-09T10:00:00Z"), scheduledEndAt: fimSD,
                endedAt: dentro, actualEndedAt: dentro,
            }),
            // Marcada como continuação: conta no item 1 e não é achado. Âncora herdada.
            occupancy({
                doctorId: d2, postId: postB, shiftLabel: "SD",
                startedAt: new Date("2020-03-09T10:00:00Z"), boardStartedAt: new Date("2020-03-08T22:00:00Z"),
                scheduledEndAt: fimSD, endedAt: dentro, actualEndedAt: dentro,
                notes: "telegram: continuacao reconhecida pela permanencia",
                createdAt: dentro, updatedAt: dentro,
            }),
            // +11h no ramal C, mas houve sucessor: foi rendido, não emendou.
            occupancy({
                doctorId: d1, postId: postC, shiftLabel: "SD",
                startedAt: new Date("2020-03-09T10:00:00Z"), scheduledEndAt: fimSD,
                endedAt: dentro, actualEndedAt: dentro,
            }),
            occupancy({
                doctorId: d3, postId: postC, shiftLabel: "SN",
                startedAt: new Date("2020-03-09T22:30:00Z"), boardStartedAt: new Date("2020-03-09T22:30:00Z"),
                scheduledEndAt: new Date("2020-03-10T10:00:00Z"), endedAt: new Date("2020-03-10T10:00:00Z"),
                createdAt: dentro,
            }),
            // P fantasma: /corrigir e sobra de 7h.
            occupancy({
                doctorId: d3, postId: postA, shiftLabel: "P",
                startedAt: new Date("2020-03-09T19:00:00Z"), scheduledEndAt: new Date("2020-03-10T01:00:00Z"),
                endedAt: new Date("2020-03-10T08:00:00Z"), actualEndedAt: new Date("2020-03-10T08:00:00Z"),
                notes: "[telegram /corrigir] chegada 16h", updatedAt: dentro,
            }),
        ]);

        const entry = (occupancyId: string, credited: number, ruleCode: string) => ({
            doctorId: d1,
            sourceType: "regulation" as const,
            regulationOccupancyId: occupancyId,
            scheduledStartAt: new Date("2020-03-09T10:00:00Z"),
            scheduledEndAt: fimSD,
            actualStartAt: new Date("2020-03-09T10:00:00Z"),
            actualEndAt: dentro,
            arrivalDelayMinutes: 0,
            overtimeMinutes: credited / 2,
            overtimeMultiplier: 2,
            creditedOvertimeMinutes: credited,
            balanceMinutes: credited,
            ruleCode,
            explanation: "teste",
            updatedAt: dentro,
        });
        await db.insert(bankHoursEntries).values([
            entry(occupancyIds[0], 800, "TESTE"),
            entry(occupancyIds[2], 0, "EXTENDED_STAY_PAYABLE_SHIFT"),
        ]);

        const audits = await db.insert(auditLogs).values([
            { action: "regulation_occupancy.corrected", entityType: "regulation_occupancy", entityId: occupancyIds[4], details: { source: "telegram /corrigir" }, createdAt: dentro },
            { action: "regulation_occupancy.corrected", entityType: "regulation_occupancy", entityId: occupancyIds[0], details: {}, createdAt: dentro },
        ]).returning({ id: auditLogs.id });
        auditIds.push(...audits.map((row) => row.id));
    });

    after(async () => {
        const db = getDb();
        await db.delete(auditLogs).where(inArray(auditLogs.id, auditIds));
        await db.delete(bankHoursEntries).where(inArray(bankHoursEntries.regulationOccupancyId, occupancyIds));
        await db.delete(regulationOccupancies).where(inArray(regulationOccupancies.id, occupancyIds));
        await db.delete(regulationPosts).where(inArray(regulationPosts.id, postIds));
        await db.delete(doctors).where(inArray(doctors.id, doctorIds));
        await closeDb();
    });

    test("cada item do roteiro na janela", async () => {
        const result = await runVerificacaoPosVirada(janela);

        assert.equal(result.continuacoesMarcadas, 1);
        assert.deepEqual(result.escapesRegra10h.map((row) => [row.medico, row.ramal, row.sobraHoras]), [[`VPV ${tag} Médico 1`, `V${tag}A`, 11]]);
        assert.deepEqual(result.ancora, { herdada: 1, chegadas: 2 });
        assert.deepEqual(result.bancoDeHoras, { acimaDoTeto: 1, permanenciasLongas: 1, total: 2 });
        assert.deepEqual(result.pFantasma.map((row) => [row.ramal, row.turno, row.sobraHoras]), [[`V${tag}A`, "P", 7]]);
        assert.deepEqual(result.correcoes, { total: 2, semOrigem: 1 });
        assert.equal(hasVerificacaoAchado(result), true);

        const resumo = formatVerificacaoResumo(result);
        assert.match(resumo, /2\. ❌ 1 saída\(s\) 10h\+/);
        assert.match(resumo, /4\. ❌ 1 lançamento/);
        assert.match(resumo, /5\. ❌ 1 P fantasma/);
        assert.match(resumo, /6\. ❌ 1 de 2 correção/);
    });

    test("janela sem movimento: nenhum achado, 'sem dado' não vira ok", async () => {
        const result = await runVerificacaoPosVirada({ inicio: new Date("2020-02-01T00:00:00Z"), fim: new Date("2020-02-01T12:00:00Z") });
        assert.equal(hasVerificacaoAchado(result), false);
        const resumo = formatVerificacaoResumo(result);
        assert.match(resumo, /3\. sem dado/);
        assert.match(resumo, /4\. sem dado/);
        assert.match(resumo, /6\. sem dado/);
    });

    describe("ciclo do worker (Telegram mockado)", () => {
        const originalFetch = globalThis.fetch;
        const envKeys = ["TELEGRAM_BOT_TOKEN", "TELEGRAM_ADMIN_IDS", "VERIFICACAO_POS_VIRADA"] as const;
        const originalEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
        const calls: Array<{ chat_id: number; text: string }> = [];
        const reference = new Date("2020-03-10T12:05:00Z");

        before(() => {
            process.env.TELEGRAM_BOT_TOKEN = "test-token";
            process.env.TELEGRAM_ADMIN_IDS = "111";
            globalThis.fetch = (async (_url: string, init?: RequestInit) => {
                const body = JSON.parse(String(init?.body));
                calls.push({ chat_id: body.chat_id, text: body.text });
                return new Response(JSON.stringify({ ok: true, result: { message_id: 1, chat: { id: body.chat_id, type: "private" }, date: 0 } }));
            }) as typeof fetch;
        });

        afterEach(async () => {
            calls.length = 0;
            await getDb().delete(telegramBotNotices).where(like(telegramBotNotices.noticeKey, "verificacao-pos-virada:2020-%"));
        });

        after(() => {
            globalThis.fetch = originalFetch;
            for (const key of envKeys) {
                if (originalEnv[key] === undefined) delete process.env[key];
                else process.env[key] = originalEnv[key];
            }
        });

        test("desligado: nada roda nem sai", async () => {
            process.env.VERIFICACAO_POS_VIRADA = "off";
            assert.deepEqual(await sendVerificacaoPosViradaCycle(reference), { sent: 0, evaluated: 0 });
            assert.equal(calls.length, 0);
        });

        test("ligado com achado: um aviso por virada, mesmo com o worker ciclando", async () => {
            process.env.VERIFICACAO_POS_VIRADA = "on";
            assert.deepEqual(await sendVerificacaoPosViradaCycle(reference), { sent: 1, evaluated: 1 });
            assert.equal(calls.length, 1);
            assert.equal(String(calls[0].chat_id), "111");
            assert.match(calls[0].text, /Verificação pós-virada/);

            assert.deepEqual(await sendVerificacaoPosViradaCycle(new Date(reference.getTime() + 30_000)), { sent: 0, evaluated: 0 });
            assert.equal(calls.length, 1);
        });

        test("ligado sem achado: roda e não envia", async () => {
            process.env.VERIFICACAO_POS_VIRADA = "on";
            // Virada das 07:00 de 01/02/2020: janela sem nenhum dado.
            assert.deepEqual(await sendVerificacaoPosViradaCycle(new Date("2020-02-01T12:05:00Z")), { sent: 0, evaluated: 1 });
            assert.equal(calls.length, 0);
        });
    });
});

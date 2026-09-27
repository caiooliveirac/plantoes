import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { eq, inArray } from "drizzle-orm";
import { closeDb, getDb, hasDatabaseUrl } from "@/db";
import { bankHoursEntries, doctors, interventionBases, interventionOccupancies, telegramIngestedMessages } from "@/db/schema";
import { clampTelegramLogColumns, processTelegramUpdate } from "@/modules/telegram/service";

/**
 * LIVE 21/09/2026 (30 casos): "value too long for type character varying(32)" num
 * UPDATE de telegram_ingested_messages. A coluna era parsed_action: a 2ª
 * justificativa inválida de saída tardia grava "departure_justification_manual_review"
 * (37). A correção da ocupação já tinha sido aplicada; só o log falhava, e o médico
 * via "erro técnico". O PM04 no log é o ADR-007 R5 (saída citou PM40, aplicada onde
 * a médica estava), não bug do parser.
 */

const skip = !hasDatabaseUrl() && "DATABASE_URL não configurada";
let seq = Math.floor(Math.random() * 1_000_000_000);
const doctorIds: string[] = [];
const originalFetch = globalThis.fetch;
const originalToken = process.env.TELEGRAM_BOT_TOKEN;

before(() => {
    // Respostas do bot vão para um fetch falso: nada sai para o Telegram.
    process.env.TELEGRAM_BOT_TOKEN = "teste";
    globalThis.fetch = (async () => new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }))) as typeof fetch;
});

after(async () => {
    globalThis.fetch = originalFetch;
    if (originalToken === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
    else process.env.TELEGRAM_BOT_TOKEN = originalToken;
    if (skip) return;
    const db = getDb();
    if (doctorIds.length > 0) {
        await db.delete(bankHoursEntries).where(inArray(bankHoursEntries.doctorId, doctorIds));
        await db.delete(interventionOccupancies).where(inArray(interventionOccupancies.doctorId, doctorIds));
        await db.delete(doctors).where(inArray(doctors.id, doctorIds));
    }
    await closeDb();
});

async function send(text: string, at: string) {
    seq += 1;
    await processTelegramUpdate({
        update_id: seq,
        message: {
            message_id: seq,
            date: Math.floor(new Date(at).getTime() / 1000),
            text,
            chat: { id: -100456, type: "group" },
            from: { id: 4242, first_name: "Ananda" },
        },
    });
    const [log] = await getDb().select().from(telegramIngestedMessages).where(eq(telegramIngestedMessages.telegramMessageId, seq));
    return log;
}

test("Ananda: saída tardia com justificativa inválida duas vezes vai para revisão sem estourar o log", { skip }, async () => {
    const db = getDb();
    const base = await db.query.interventionBases.findFirst({ where: eq(interventionBases.code, "PM04") });
    assert.ok(base);
    const [ananda] = await db.insert(doctors).values({ fullName: "Ananda Andrade", normalizedName: "ananda andrade" }).returning();
    const [sucessor] = await db.insert(doctors).values({ fullName: "Zeca Sucessor", normalizedName: "zeca sucessor" }).returning();
    doctorIds.push(ananda.id, sucessor.id);
    const common = { baseId: base.id, source: "telegram" as const };
    await db.insert(interventionOccupancies).values({
        ...common, doctorId: ananda.id, continuityGroupId: randomUUID(), shiftLabel: "SD",
        startedAt: new Date("2026-09-21T07:00:00-03:00"), boardStartedAt: new Date("2026-09-21T07:00:00-03:00"),
        scheduledStartAt: new Date("2026-09-21T07:00:00-03:00"), scheduledEndAt: new Date("2026-09-21T19:00:00-03:00"),
        endedAt: new Date("2026-09-21T19:00:00-03:00"),
    });
    await db.insert(interventionOccupancies).values({
        ...common, doctorId: sucessor.id, continuityGroupId: randomUUID(), shiftLabel: "SN",
        startedAt: new Date("2026-09-21T19:00:00-03:00"), boardStartedAt: new Date("2026-09-21T19:00:00-03:00"),
        scheduledStartAt: new Date("2026-09-21T19:00:00-03:00"), scheduledEndAt: new Date("2026-09-22T07:00:00-03:00"),
    });

    const departure = await send("Ananda Andrade saida PM40", "2026-09-21T19:30:00-03:00");
    assert.equal(departure.status, "pending_departure_justification");
    assert.equal(departure.parsedTargetCode, "PM04");

    const firstRetry = await send("Remanejada para PM40 formação de SuperUS", "2026-09-21T19:32:00-03:00");
    assert.equal(firstRetry.errorMessage, "departure_justification_invalid_retry");

    const manualReview = await send("Remanejada para PM40 formação de SuperUS, sem ocorrência", "2026-09-21T19:34:00-03:00");
    assert.equal(manualReview.status, "accepted", `${manualReview.status} ${manualReview.errorMessage}`);
    assert.equal(manualReview.parsedAction, "departure_justif_manual_review");
    assert.equal(manualReview.parsedTargetCode, "PM04");
});

test("clampTelegramLogColumns corta só o que não cabe na coluna", () => {
    assert.deepEqual(clampTelegramLogColumns({ parsedAction: "arrival", parsedTargetCode: "PM04" }), {});
    const clamped = clampTelegramLogColumns({
        parsedAction: "x".repeat(40),
        parsedDomain: "y".repeat(33),
        parsedTargetCode: "z".repeat(70),
        rawText: "w".repeat(500),
    });
    assert.deepEqual(clamped, { parsedAction: "x".repeat(32), parsedDomain: "y".repeat(32), parsedTargetCode: "z".repeat(64) });
});

test("nenhum parsedAction literal do bot passa de varchar(32)", () => {
    const dir = join(process.cwd(), "modules/telegram");
    for (const file of readdirSync(dir).filter((name) => name.endsWith(".ts"))) {
        const source = readFileSync(join(dir, file), "utf8");
        for (const match of source.matchAll(/parsedAction: "([^"]+)"/g)) {
            assert.ok(match[1].length <= 32, `${file}: ${match[1]} (${match[1].length})`);
        }
    }
});

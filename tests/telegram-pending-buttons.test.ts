import assert from "node:assert/strict";
import test from "node:test";
import {
    buildCoiRamalCallbackData,
    buildCoiRamalKeyboard,
    buildCoiRamalPromptText,
    buildExpiredPendingAlertText,
    buildNameSelectionCallbackData,
    buildNameSelectionKeyboard,
    buildPiamShiftCallbackData,
    buildPiamShiftKeyboard,
    buildPiamShiftPromptText,
    buildShiftSelectionCallbackData,
    buildShiftSelectionKeyboard,
    buildShiftSelectionPromptText,
    buildThirdPartyPressAlertText,
    classifyPendingShortReply,
    classifyPiamShiftTextReply,
    COI_RAMAL_CHOICES,
    parseCoiRamalCallbackData,
    parseNameSelectionCallbackData,
    parsePiamShiftCallbackData,
    parseShiftSelectionCallbackData,
    PENDING_REOPEN_WINDOW_MS,
    resolvePendingPresserPermission,
    resolvePendingReopenState,
    sanitizeTelegramCodeSpan,
    TELEGRAM_CALLBACK_DATA_MAX_BYTES,
} from "@/modules/telegram/pending-buttons";
import { isCallbackButton } from "@/modules/telegram/api";

const LOG_ID = "0d9e4f6a-1b2c-4d3e-8f90-a1b2c3d4e5f6"; // UUID de 36 chars, como o id real do log

// ── callback_data: round-trip e validação ──────────────────────────────────────────

test("shift selection callback data round-trips for SD/SN/P", () => {
    for (const shift of ["SD", "SN", "P"] as const) {
        const data = buildShiftSelectionCallbackData(shift, LOG_ID);
        assert.ok(Buffer.byteLength(data, "utf8") <= TELEGRAM_CALLBACK_DATA_MAX_BYTES, `${data} must fit 64 bytes`);
        assert.deepEqual(parseShiftSelectionCallbackData(data), { shift, logId: LOG_ID });
    }
});

test("shift selection parser rejects foreign prefixes, bad shifts and bad ids", () => {
    assert.equal(parseShiftSelectionCallbackData(null), null);
    assert.equal(parseShiftSelectionCallbackData(""), null);
    assert.equal(parseShiftSelectionCallbackData(`pSN:r:${LOG_ID}`), null);
    assert.equal(parseShiftSelectionCallbackData(`f6:SX:${LOG_ID}`), null);
    assert.equal(parseShiftSelectionCallbackData("f6:SD:"), null);
    assert.equal(parseShiftSelectionCallbackData("f6:SD:not a log id!"), null);
    assert.equal(parseShiftSelectionCallbackData(`f6:SD:${LOG_ID}:extra`), null);
});

test("name selection callback data round-trips for positions 1..3 and rejects others", () => {
    for (const position of [1, 2, 3]) {
        const data = buildNameSelectionCallbackData(position, LOG_ID);
        assert.deepEqual(parseNameSelectionCallbackData(data), { position, logId: LOG_ID });
    }
    assert.throws(() => buildNameSelectionCallbackData(0, LOG_ID));
    assert.throws(() => buildNameSelectionCallbackData(4, LOG_ID));
    assert.equal(parseNameSelectionCallbackData(`nm:0:${LOG_ID}`), null);
    assert.equal(parseNameSelectionCallbackData(`nm:4:${LOG_ID}`), null);
    assert.equal(parseNameSelectionCallbackData(`nm:x:${LOG_ID}`), null);
});

test("piam shift callback data accepts only SD/SN", () => {
    assert.deepEqual(parsePiamShiftCallbackData(buildPiamShiftCallbackData("SD", LOG_ID)), { shift: "SD", logId: LOG_ID });
    assert.deepEqual(parsePiamShiftCallbackData(buildPiamShiftCallbackData("SN", LOG_ID)), { shift: "SN", logId: LOG_ID });
    assert.equal(parsePiamShiftCallbackData(`pi:P:${LOG_ID}`), null);
});

test("coi ramal callback data requires a 4-digit ramal", () => {
    const data = buildCoiRamalCallbackData("2262", LOG_ID);
    assert.deepEqual(parseCoiRamalCallbackData(data), { ramal: "2262", logId: LOG_ID });
    assert.throws(() => buildCoiRamalCallbackData("136", LOG_ID));
    assert.throws(() => buildCoiRamalCallbackData("PM04", LOG_ID));
    assert.equal(parseCoiRamalCallbackData(`coi:136:${LOG_ID}`), null);
    assert.equal(parseCoiRamalCallbackData(`coi:PM04:${LOG_ID}`), null);
});

test("builders refuse log ids that would break the 64-byte limit or the id shape", () => {
    assert.throws(() => buildShiftSelectionCallbackData("SD", "a".repeat(80)));
    assert.throws(() => buildShiftSelectionCallbackData("SD", "não-é-uuid!"));
});

// ── Teclados ───────────────────────────────────────────────────────────────────────

test("shift selection keyboard offers SD, SN and P 24h in one row", () => {
    const keyboard = buildShiftSelectionKeyboard(LOG_ID);
    assert.equal(keyboard.inline_keyboard.length, 1);
    const [row] = keyboard.inline_keyboard;
    assert.deepEqual(row.map((button) => button.text), ["☀️ SD", "🌙 SN", "🕐 P 24h"]);
    for (const button of row) {
        assert.ok(isCallbackButton(button));
        assert.ok(parseShiftSelectionCallbackData(button.callback_data));
    }
});

test("name selection keyboard shows full names, one per row, capped at 3", () => {
    const keyboard = buildNameSelectionKeyboard([
        { fullName: "Ana Maria Souza", displayName: "Ana" },
        { fullName: "Ana Marta Sousa" },
        { fullName: "Ana Paula Souza" },
        { fullName: "Ana Extra Que Nao Entra" },
    ], LOG_ID);
    assert.equal(keyboard.inline_keyboard.length, 3);
    assert.equal(keyboard.inline_keyboard[0][0].text, "1. Ana Maria Souza");
    assert.equal(keyboard.inline_keyboard[2][0].text, "3. Ana Paula Souza");
    assert.deepEqual(parseNameSelectionCallbackData(keyboard.inline_keyboard[1][0].callback_data), {
        position: 2,
        logId: LOG_ID,
    });
});

test("piam keyboard labels carry the shift windows", () => {
    const keyboard = buildPiamShiftKeyboard(LOG_ID);
    const [row] = keyboard.inline_keyboard;
    assert.deepEqual(row.map((button) => button.text), ["☀️ SD 07h–19h", "🌙 SN 19h–07h"]);
});

test("coi keyboard offers exactly the two COI ramais", () => {
    const keyboard = buildCoiRamalKeyboard(LOG_ID);
    const [row] = keyboard.inline_keyboard;
    assert.deepEqual(row.map((button) => button.text), [...COI_RAMAL_CHOICES]);
    assert.deepEqual(parseCoiRamalCallbackData(row[0].callback_data), { ramal: "2262", logId: LOG_ID });
});

// ── Cópias ─────────────────────────────────────────────────────────────────────────

test("shift selection prompt is short, bolds the key data and keeps a copyable example", () => {
    const prompt = buildShiftSelectionPromptText({ doctorLabel: "Luan Sampaio", targetLabel: "2035" });
    assert.ok(prompt.length <= 200, `prompt has ${prompt.length} chars (max 200)`);
    assert.match(prompt, /\*turno\*/);
    assert.match(prompt, /\*Luan Sampaio\*/);
    assert.match(prompt, /\*2035\*/);
    assert.match(prompt, /`Luan Sampaio 2035 SD 07:00`/);
});

test("shift selection prompt escapes markdown in interpolations and strips backticks from the code span", () => {
    const prompt = buildShiftSelectionPromptText({ doctorLabel: "Ana*Beatriz", targetLabel: "20_35" });
    assert.ok(prompt.includes("*Ana\\*Beatriz*"));
    assert.ok(prompt.includes("*20\\_35*"));
    const withBacktick = buildShiftSelectionPromptText({ doctorLabel: "Ana`rm -rf`", targetLabel: "2035" });
    const codeSpan = withBacktick.split("reenvie: ")[1];
    assert.ok(!codeSpan.includes("`Ana`"), "code span must not contain nested backticks from the name");
});

test("piam prompt keeps textual fallback and coi prompt stays under 200 chars", () => {
    const piam = buildPiamShiftPromptText("Aline Cardoso");
    assert.match(piam, /\*Aline Cardoso\*/);
    assert.match(piam, /\*SD\*.+\*SN\*/);
    const coi = buildCoiRamalPromptText();
    assert.ok(coi.length <= 200, `coi prompt has ${coi.length} chars (max 200)`);
    assert.match(coi, /`2262`/);
});

test("sanitizeTelegramCodeSpan removes backticks and newlines", () => {
    assert.equal(sanitizeTelegramCodeSpan("a`b`c"), "a b c");
    assert.equal(sanitizeTelegramCodeSpan("linha1\nlinha2"), "linha1 linha2");
    assert.equal(sanitizeTelegramCodeSpan("  espremido   demais  "), "espremido demais");
});

test("expired/third-party alerts are short enough for answerCallbackQuery (200 chars)", () => {
    for (const kind of ["shift_selection", "name_selection", "piam_shift", "coi_ramal"] as const) {
        assert.ok(buildExpiredPendingAlertText(kind).length <= 200);
    }
    assert.ok(buildThirdPartyPressAlertText().length <= 200);
});

// ── Validação de quem toca ─────────────────────────────────────────────────────────

test("presser permission: author, chief/admin and third party", () => {
    const base = { chiefTelegramIds: ["111"], adminTelegramIds: ["222"] };
    assert.equal(resolvePendingPresserPermission({ ...base, presserTelegramId: "999", pendingSenderTelegramId: "999" }), "author");
    assert.equal(resolvePendingPresserPermission({ ...base, presserTelegramId: "111", pendingSenderTelegramId: "999" }), "privileged");
    assert.equal(resolvePendingPresserPermission({ ...base, presserTelegramId: "222", pendingSenderTelegramId: "999" }), "privileged");
    assert.equal(resolvePendingPresserPermission({ ...base, presserTelegramId: "333", pendingSenderTelegramId: "999" }), "denied");
    assert.equal(resolvePendingPresserPermission({ ...base, presserTelegramId: null, pendingSenderTelegramId: "999" }), "denied");
    // Pendência sem autor registrado: só chefia/admin pode agir.
    assert.equal(resolvePendingPresserPermission({ ...base, presserTelegramId: "333", pendingSenderTelegramId: null }), "denied");
    assert.equal(resolvePendingPresserPermission({ ...base, presserTelegramId: "111", pendingSenderTelegramId: null }), "privileged");
});

// ── Resposta curta órfã: classificação e decisão de reabertura ─────────────────────

test("classifyPendingShortReply recognizes shifts, options, ramais and times", () => {
    assert.deepEqual(classifyPendingShortReply("SD"), { kind: "shift", shift: "SD" });
    assert.deepEqual(classifyPendingShortReply(" sn "), { kind: "shift", shift: "SN" });
    assert.deepEqual(classifyPendingShortReply("p"), { kind: "shift", shift: "P" });
    assert.deepEqual(classifyPendingShortReply("2"), { kind: "option", option: 2 });
    assert.deepEqual(classifyPendingShortReply("1367"), { kind: "ramal", ramal: "1367" });
    assert.deepEqual(classifyPendingShortReply("19:05"), { kind: "time", time: "19:05" });
});

test("classifyPendingShortReply ignores anything that is not a short orphan reply", () => {
    assert.equal(classifyPendingShortReply(null), null);
    assert.equal(classifyPendingShortReply(""), null);
    assert.equal(classifyPendingShortReply("4"), null);
    assert.equal(classifyPendingShortReply("SDX"), null);
    assert.equal(classifyPendingShortReply("Vagner Costa 1363 SD"), null);
    // "NNNN HH:MM" é payload do teclado de refeição — tratado antes no pipeline.
    assert.equal(classifyPendingShortReply("1363 12:30"), null);
    assert.equal(classifyPendingShortReply("25:00"), null);
    assert.equal(classifyPendingShortReply("12:75"), null);
    assert.equal(classifyPendingShortReply("123"), null);
    assert.equal(classifyPendingShortReply("12345"), null);
});

test("classifyPiamShiftTextReply accepts SD/SN and the taught words, with accents", () => {
    assert.equal(classifyPiamShiftTextReply("SD"), "SD");
    assert.equal(classifyPiamShiftTextReply("dia"), "SD");
    assert.equal(classifyPiamShiftTextReply("DIURNO"), "SD");
    assert.equal(classifyPiamShiftTextReply("sn"), "SN");
    assert.equal(classifyPiamShiftTextReply("noite"), "SN");
    assert.equal(classifyPiamShiftTextReply("NOTURNO"), "SN");
    assert.equal(classifyPiamShiftTextReply("P"), null);
    assert.equal(classifyPiamShiftTextReply("boa noite"), null);
    assert.equal(classifyPiamShiftTextReply("dias"), null);
});

test("resolvePendingReopenState: active within TTL, reopenable up to 2h, stale after", () => {
    const ttlMs = 30 * 60 * 1000;
    const createdAt = new Date("2026-07-14T12:00:00.000Z");
    const at = (offsetMs: number) => new Date(createdAt.getTime() + offsetMs);

    assert.equal(resolvePendingReopenState({ createdAt, now: at(0), ttlMs }), "active");
    assert.equal(resolvePendingReopenState({ createdAt, now: at(ttlMs), ttlMs }), "active");
    assert.equal(resolvePendingReopenState({ createdAt, now: at(ttlMs + 1), ttlMs }), "reopenable");
    assert.equal(resolvePendingReopenState({ createdAt, now: at(PENDING_REOPEN_WINDOW_MS), ttlMs }), "reopenable");
    assert.equal(resolvePendingReopenState({ createdAt, now: at(PENDING_REOPEN_WINDOW_MS + 1), ttlMs }), "stale");
});

// ── Onda 2 parte 2: tomada, justificativa de saída e reset geral ───────────────────

// Imports separados para não mexer no bloco existente.
import {
    buildDepartureJustificationCallbackData,
    buildDepartureJustificationKeyboard,
    buildResetAllCallbackData,
    buildResetAllConfirmationKeyboard,
    buildResetAllConfirmationPromptText,
    buildTakeoverDecisionCallbackData,
    buildTakeoverDecisionKeyboard,
    parseDepartureJustificationCallbackData,
    parseResetAllCallbackData,
    parseTakeoverDecisionCallbackData,
    RESET_ALL_CONFIRM_TTL_MS,
} from "@/modules/telegram/pending-buttons";

test("takeover callback data round-trips para assume/reject", () => {
    assert.deepEqual(
        parseTakeoverDecisionCallbackData(buildTakeoverDecisionCallbackData("assume", LOG_ID)),
        { decision: "assume", logId: LOG_ID },
    );
    assert.deepEqual(
        parseTakeoverDecisionCallbackData(buildTakeoverDecisionCallbackData("reject", LOG_ID)),
        { decision: "reject", logId: LOG_ID },
    );
    assert.equal(parseTakeoverDecisionCallbackData(`tk:maybe:${LOG_ID}`), null);
    assert.equal(parseTakeoverDecisionCallbackData(`dj:occ:${LOG_ID}`), null);
    assert.equal(parseTakeoverDecisionCallbackData("tk:ok:"), null);
    assert.equal(parseTakeoverDecisionCallbackData(null), null);
});

test("teclado da tomada: [✅ Assumir NNNN] [❌ Era outro ramal] numa linha", () => {
    const keyboard = buildTakeoverDecisionKeyboard("2034", LOG_ID);
    const [row] = keyboard.inline_keyboard;
    assert.deepEqual(row.map((button) => button.text), ["✅ Assumir 2034", "❌ Era outro ramal"]);
    assert.deepEqual(parseTakeoverDecisionCallbackData(row[0].callback_data), { decision: "assume", logId: LOG_ID });
    assert.deepEqual(parseTakeoverDecisionCallbackData(row[1].callback_data), { decision: "reject", logId: LOG_ID });
});

test("departure justification callback data cobre occ/hyg/none e rejeita o resto", () => {
    assert.deepEqual(
        parseDepartureJustificationCallbackData(buildDepartureJustificationCallbackData("occurrence", LOG_ID)),
        { choice: "occurrence", logId: LOG_ID },
    );
    assert.deepEqual(
        parseDepartureJustificationCallbackData(buildDepartureJustificationCallbackData("hygienization", LOG_ID)),
        { choice: "hygienization", logId: LOG_ID },
    );
    assert.deepEqual(
        parseDepartureJustificationCallbackData(buildDepartureJustificationCallbackData("none", LOG_ID)),
        { choice: "none", logId: LOG_ID },
    );
    assert.equal(parseDepartureJustificationCallbackData(`dj:xyz:${LOG_ID}`), null);
    assert.equal(parseDepartureJustificationCallbackData(`tk:ok:${LOG_ID}`), null);
});

test("teclado da justificativa: 🚑/🧼 na 1ª linha e Sem motivo na 2ª", () => {
    const keyboard = buildDepartureJustificationKeyboard(LOG_ID);
    assert.equal(keyboard.inline_keyboard.length, 2);
    assert.deepEqual(keyboard.inline_keyboard[0].map((button) => button.text), ["🚑 Ocorrência", "🧼 Higienização"]);
    assert.deepEqual(keyboard.inline_keyboard[1].map((button) => button.text), ["Sem motivo"]);
    for (const row of keyboard.inline_keyboard) {
        for (const button of row) {
            assert.ok(isCallbackButton(button));
            assert.ok(parseDepartureJustificationCallbackData(button.callback_data));
        }
    }
});

test("reset-all callback data round-trips para confirm/cancel e o TTL é 5 min", () => {
    assert.deepEqual(
        parseResetAllCallbackData(buildResetAllCallbackData("confirm", LOG_ID)),
        { decision: "confirm", logId: LOG_ID },
    );
    assert.deepEqual(
        parseResetAllCallbackData(buildResetAllCallbackData("cancel", LOG_ID)),
        { decision: "cancel", logId: LOG_ID },
    );
    assert.equal(parseResetAllCallbackData(`rta:si:${LOG_ID}`), null);
    assert.equal(RESET_ALL_CONFIRM_TTL_MS, 5 * 60 * 1000);
});

test("teclado e copy do reset-all trazem a CONTAGEM e o fallback textual CONFIRMO", () => {
    const keyboard = buildResetAllConfirmationKeyboard(42, LOG_ID);
    assert.equal(keyboard.inline_keyboard.length, 2);
    assert.equal(keyboard.inline_keyboard[0][0].text, "🔐 Confirmar reset de 42 codinomes");
    assert.equal(keyboard.inline_keyboard[1][0].text, "Cancelar");
    assert.deepEqual(parseResetAllCallbackData(keyboard.inline_keyboard[0][0].callback_data), { decision: "confirm", logId: LOG_ID });

    const prompt = buildResetAllConfirmationPromptText(42);
    assert.match(prompt, /\*42\* médicos ativos/);
    assert.match(prompt, /\*5 min\*/);
    assert.match(prompt, /`\/pagamento resetar-todos CONFIRMO`/);
});

test("alerts de expiração das novas pendências cabem no answerCallbackQuery", () => {
    for (const kind of ["takeover", "departure_justification", "destination_selection", "reset_all"] as const) {
        const text = buildExpiredPendingAlertText(kind);
        assert.ok(text.length <= 200, `${kind}: ${text.length} chars`);
        assert.match(text, /^⏰/);
    }
});

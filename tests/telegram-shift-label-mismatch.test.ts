import assert from "node:assert/strict";
import test from "node:test";

import { buildShiftLabelMismatchKeyboard, buildShiftLabelMismatchPromptText, parseShiftSelectionCallbackData } from "@/modules/telegram/pending-buttons";
import {
    isTelegramShiftLabelTimeMismatch,
    resolveConfirmedShiftLabelWindow,
    shouldAskTelegramShiftLabelMismatch,
} from "@/modules/telegram/service";
import { inferRegulationCoverageWindow } from "@/modules/operational/rules";

// D7 (docs/chegada.md): Gerardson, 2152, 03/09/2026 — "SD" às 18:35 gravava rótulo SD
// com janela SN (19:00).
const GERARDSON_AT = new Date("2026-09-03T18:35:00-03:00");
const ARRIVAL = {
    sector: "REGULATION" as const,
    baseCode: "2152",
    shiftType: "SD" as const,
    isDeparture: false,
    isContinuation: false,
    isReassignment: false,
};

test("isTelegramShiftLabelTimeMismatch: só o rótulo do turno que acaba, dentro da janela antecipada de 3h", () => {
    assert.equal(isTelegramShiftLabelTimeMismatch(GERARDSON_AT, "SD"), true);
    assert.equal(isTelegramShiftLabelTimeMismatch(GERARDSON_AT, "SN"), false);
    assert.equal(isTelegramShiftLabelTimeMismatch(GERARDSON_AT, "P"), false);
    assert.equal(isTelegramShiftLabelTimeMismatch(GERARDSON_AT, null), false);
    // Bordas da janela antecipada (16:00–18:59 → SN; 04:00–06:59 → SD).
    assert.equal(isTelegramShiftLabelTimeMismatch(new Date("2026-09-03T15:59:00-03:00"), "SD"), false);
    assert.equal(isTelegramShiftLabelTimeMismatch(new Date("2026-09-03T16:00:00-03:00"), "SD"), true);
    assert.equal(isTelegramShiftLabelTimeMismatch(new Date("2026-09-03T19:00:00-03:00"), "SD"), false);
    // Simétrico na virada da manhã: "SN" às 05:30.
    assert.equal(isTelegramShiftLabelTimeMismatch(new Date("2026-09-04T05:30:00-03:00"), "SN"), true);
    assert.equal(isTelegramShiftLabelTimeMismatch(new Date("2026-09-04T03:59:00-03:00"), "SN"), false);
    // "SD" às 06:50 é o caso normal de chegada antecipada, não discorda.
    assert.equal(isTelegramShiftLabelTimeMismatch(new Date("2026-09-04T06:50:00-03:00"), "SD"), false);
});

test("shouldAskTelegramShiftLabelMismatch: pergunta só na chegada nova", () => {
    assert.equal(shouldAskTelegramShiftLabelMismatch({ parsed: ARRIVAL, eventAt: GERARDSON_AT, hasActiveOccupancy: false }), true);
    assert.equal(shouldAskTelegramShiftLabelMismatch({ parsed: { ...ARRIVAL, sector: "INTERVENTION", baseCode: "USA01" }, eventAt: GERARDSON_AT, hasActiveOccupancy: false }), true);
    // Já tem plantão aberto: reenvio/correção de rótulo/remanejo seguem as regras próprias.
    assert.equal(shouldAskTelegramShiftLabelMismatch({ parsed: ARRIVAL, eventAt: GERARDSON_AT, hasActiveOccupancy: true }), false);
    assert.equal(shouldAskTelegramShiftLabelMismatch({ parsed: { ...ARRIVAL, isDeparture: true }, eventAt: GERARDSON_AT, hasActiveOccupancy: false }), false);
    assert.equal(shouldAskTelegramShiftLabelMismatch({ parsed: { ...ARRIVAL, isContinuation: true }, eventAt: GERARDSON_AT, hasActiveOccupancy: false }), false);
    assert.equal(shouldAskTelegramShiftLabelMismatch({ parsed: { ...ARRIVAL, isReassignment: true }, eventAt: GERARDSON_AT, hasActiveOccupancy: false }), false);
    assert.equal(shouldAskTelegramShiftLabelMismatch({ parsed: { ...ARRIVAL, baseCode: "PIAM" }, eventAt: GERARDSON_AT, hasActiveOccupancy: false }), false);
    // Meio plantão da regulação (11:10–17:00) tem janela fixa: "SD" às 16:30 não pergunta.
    const halfShiftAt = new Date("2026-09-03T16:30:00-03:00");
    assert.equal(shouldAskTelegramShiftLabelMismatch({ parsed: ARRIVAL, eventAt: halfShiftAt, hasActiveOccupancy: false }), false);
    // …na intervenção não há meio plantão.
    assert.equal(shouldAskTelegramShiftLabelMismatch({ parsed: { ...ARRIVAL, sector: "INTERVENTION", baseCode: "USA01" }, eventAt: halfShiftAt, hasActiveOccupancy: false }), true);
});

test("resolveConfirmedShiftLabelWindow: SD confirmado às 18:35 fica com a janela do SD de hoje", () => {
    const regulation = resolveConfirmedShiftLabelWindow({ sector: "REGULATION", eventAt: GERARDSON_AT, shiftType: "SD", shiftLabelConfirmed: true, postCode: "2152" });
    assert.ok(regulation);
    assert.equal(regulation.scheduledStartAt.toISOString(), new Date("2026-09-03T07:00:00-03:00").toISOString());
    assert.equal(regulation.scheduledEndAt.toISOString(), new Date("2026-09-03T19:15:00-03:00").toISOString());

    const intervention = resolveConfirmedShiftLabelWindow({ sector: "INTERVENTION", eventAt: GERARDSON_AT, shiftType: "SD", shiftLabelConfirmed: true });
    assert.ok(intervention);
    assert.equal(intervention.scheduledStartAt.toISOString(), new Date("2026-09-03T07:00:00-03:00").toISOString());
    assert.equal(intervention.scheduledEndAt.toISOString(), new Date("2026-09-03T19:00:00-03:00").toISOString());

    // Sem confirmação, ou SN escolhido: regra normal (a régua de tempo já concorda).
    assert.equal(resolveConfirmedShiftLabelWindow({ sector: "REGULATION", eventAt: GERARDSON_AT, shiftType: "SD", postCode: "2152" }), null);
    assert.equal(resolveConfirmedShiftLabelWindow({ sector: "REGULATION", eventAt: GERARDSON_AT, shiftType: "SN", shiftLabelConfirmed: true, postCode: "2152" }), null);
    const snWindow = inferRegulationCoverageWindow({ startedAt: GERARDSON_AT, shiftLabel: "SN", postCode: "2152" });
    assert.equal(snWindow.baseShiftLabel, "SN");
    assert.equal(snWindow.scheduledStartAt?.toISOString(), new Date("2026-09-03T19:00:00-03:00").toISOString());
});

test("pergunta SD/SN: texto e botões de um toque no callback do F6", () => {
    const text = buildShiftLabelMismatchPromptText({ doctorLabel: "Gerardson", targetLabel: "2152", declaredShift: "SD", timeLabel: "18:35" });
    assert.match(text, /veio \*SD\*/);
    assert.match(text, /às 18:35/);
    assert.match(text, /\*SN\* que começa às 19h/);

    const keyboard = buildShiftLabelMismatchKeyboard("SD", "0b9f6f7e-2d1c-4c43-9a51-3f7d1f0b8a11");
    const [row] = keyboard.inline_keyboard;
    assert.deepEqual(row.map((button) => button.text), ["☀️ SD até 19h", "🌙 SN 19h–07h"]);
    assert.deepEqual(row.map((button) => parseShiftSelectionCallbackData(button.callback_data)?.shift), ["SD", "SN"]);

    const morning = buildShiftLabelMismatchKeyboard("SN", "0b9f6f7e-2d1c-4c43-9a51-3f7d1f0b8a11");
    assert.deepEqual(morning.inline_keyboard[0].map((button) => button.text), ["🌙 SN até 07h", "☀️ SD 07h–19h"]);
});

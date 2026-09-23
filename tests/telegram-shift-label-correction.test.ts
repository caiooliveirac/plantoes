import assert from "node:assert/strict";
import test from "node:test";

import { isTelegramShiftLabelCorrection, shouldTreatTelegramArrivalAsContinuation } from "@/modules/telegram/service";

// D2 (docs/chegada.md): Emily, 2034, 07/09/2026 — "2034 sd" às 19:08:05 e "2034 sn"
// às 19:08:15. O segundo aviso corrige o rótulo; não é SD emendando em SN.
const EMILY = {
    activeShiftLabel: "SD",
    activeStartedAt: new Date("2026-09-07T19:08:05-03:00"),
    incomingShiftLabel: "SN",
    eventAt: new Date("2026-09-07T19:08:15-03:00"),
};

test("isTelegramShiftLabelCorrection: SD→SN segundos depois da própria chegada é correção", () => {
    assert.equal(isTelegramShiftLabelCorrection(EMILY), true);
    assert.equal(shouldTreatTelegramArrivalAsContinuation({
        sector: "REGULATION",
        isDeparture: false,
        isContinuation: false,
        ...EMILY,
    }), false);
});

test("isTelegramShiftLabelCorrection: SD desde a manhã avisando SN à noite segue continuação", () => {
    const params = {
        ...EMILY,
        activeStartedAt: new Date("2026-09-07T06:55:00-03:00"),
    };
    assert.equal(isTelegramShiftLabelCorrection(params), false);
    assert.equal(shouldTreatTelegramArrivalAsContinuation({
        sector: "REGULATION",
        isDeparture: false,
        isContinuation: false,
        ...params,
    }), true);
});

test("isTelegramShiftLabelCorrection: P e continuação explícita nunca são correção", () => {
    assert.equal(isTelegramShiftLabelCorrection({ ...EMILY, incomingShiftLabel: "P" }), false);
    assert.equal(shouldTreatTelegramArrivalAsContinuation({
        sector: "REGULATION",
        isDeparture: false,
        isContinuation: true,
        ...EMILY,
    }), true);
});

test("isTelegramShiftLabelCorrection: depois de 15 minutos já não é correção", () => {
    assert.equal(isTelegramShiftLabelCorrection({
        ...EMILY,
        eventAt: new Date("2026-09-07T19:24:00-03:00"),
    }), false);
});

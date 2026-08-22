import test from "node:test";
import assert from "node:assert/strict";

import { resolveContinuityRevertTarget } from "@/modules/telegram/continuity-revert";

test("alvo da reversão: P declarado de madrugada (chegada adiantada) é SD, não SN", () => {
    // 06:20 SP — antes das 7h, dentro da janela de chegada adiantada de 3h.
    assert.equal(resolveContinuityRevertTarget(new Date("2026-08-07T09:20:00Z")), "SD");
    // 05:07 SP — caso Caio 2152.
    assert.equal(resolveContinuityRevertTarget(new Date("2026-08-07T08:07:00Z")), "SD");
});

test("alvo da reversão: P declarado na noite (ou adiantado para ela) é SN", () => {
    // 20:30 SP — noite em curso.
    assert.equal(resolveContinuityRevertTarget(new Date("2026-08-07T23:30:00Z")), "SN");
    // 17:40 SP — adiantado para o noturno.
    assert.equal(resolveContinuityRevertTarget(new Date("2026-08-07T20:40:00Z")), "SN");
    // 02:00 SP — meio da noite, fora da janela de 3h antes das 7h.
    assert.equal(resolveContinuityRevertTarget(new Date("2026-08-07T05:00:00Z")), "SN");
});

test("alvo da reversão: P declarado no meio do dia é SD", () => {
    // 10:00 SP.
    assert.equal(resolveContinuityRevertTarget(new Date("2026-08-07T13:00:00Z")), "SD");
});

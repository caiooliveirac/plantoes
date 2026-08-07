import assert from "node:assert/strict";
import test from "node:test";
import {
    buildContinuityRevertCallbackData,
    CONTINUITY_REVERT_TTL_MS,
    evaluateContinuityRevert,
    parseContinuityRevertCallbackData,
    resolveContinuityRevertTarget,
} from "@/modules/telegram/continuity-revert";

const UUID = "11111111-2222-3333-4444-555555555555";

test("callback_data faz round-trip para regulação e intervenção", () => {
    const reg = buildContinuityRevertCallbackData("regulation", UUID);
    const intv = buildContinuityRevertCallbackData("intervention", UUID);

    assert.deepEqual(parseContinuityRevertCallbackData(reg), { domain: "regulation", occupancyId: UUID });
    assert.deepEqual(parseContinuityRevertCallbackData(intv), { domain: "intervention", occupancyId: UUID });
});

test("callback_data cabe no limite de 64 bytes do Telegram", () => {
    const data = buildContinuityRevertCallbackData("intervention", UUID);
    assert.ok(Buffer.byteLength(data, "utf8") <= 64, `callback_data ${data} excede 64 bytes`);
});

test("parse rejeita prefixo desconhecido, formato inválido e vazio", () => {
    assert.equal(parseContinuityRevertCallbackData(null), null);
    assert.equal(parseContinuityRevertCallbackData(""), null);
    assert.equal(parseContinuityRevertCallbackData("outro:r:" + UUID), null);
    assert.equal(parseContinuityRevertCallbackData("pSN:x:" + UUID), null); // domínio inválido
    assert.equal(parseContinuityRevertCallbackData("pSN:r"), null); // faltando id
    assert.equal(parseContinuityRevertCallbackData("pSN:r:"), null); // id vazio
});

test("gate: ocupação inexistente => not_found", () => {
    const outcome = evaluateContinuityRevert({ occupancy: null, now: new Date("2026-06-07T00:00:00Z") });
    assert.equal(outcome, "not_found");
});

test("gate: já não é P => already_changed", () => {
    const now = new Date("2026-06-07T00:00:00Z");
    const outcome = evaluateContinuityRevert({
        occupancy: { shiftLabel: "SN", createdAt: new Date(now.getTime() - 1000) },
        now,
    });
    assert.equal(outcome, "already_changed");
});

test("gate: P fresco dentro de 2 min => ok", () => {
    const now = new Date("2026-06-07T00:00:00Z");
    const outcome = evaluateContinuityRevert({
        occupancy: { shiftLabel: "P", createdAt: new Date(now.getTime() - (CONTINUITY_REVERT_TTL_MS - 1000)) },
        now,
    });
    assert.equal(outcome, "ok");
});

test("gate: P antigo (passou de 2 min) => expired", () => {
    const now = new Date("2026-06-07T00:00:00Z");
    const outcome = evaluateContinuityRevert({
        occupancy: { shiftLabel: "P", createdAt: new Date(now.getTime() - (CONTINUITY_REVERT_TTL_MS + 1000)) },
        now,
    });
    assert.equal(outcome, "expired");
});

// Fuso operacional fixo UTC-3: 09:00Z = 06:00 em SP.
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

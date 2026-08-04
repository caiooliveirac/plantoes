import assert from "node:assert/strict";
import test from "node:test";
import { resolveTelegramExplicitContinuationBlock } from "@/modules/telegram/service";
import { resolveContinuationInPlaceShiftLabel } from "@/modules/operational/rules";

// Horários em America/Sao_Paulo (-03): 19:00 local = 22:00Z.
const sp = (iso: string) => new Date(`${iso}-03:00`);

// Caso real 03/08/2026: plantonistas de P avisando "continua" em volta da virada
// das 19:00. O bloco novo é SEMPRE o SN 19:00→07:15 — nunca o SD da manhã, que
// já estava expirado e fazia a ocupação nascer fechada (fora do painel e da
// divisão do jantar).
test("continua antes da virada das 19h abre o bloco SN a partir das 19:00 (Matheus 18:43)", () => {
    const block = resolveTelegramExplicitContinuationBlock(sp("2026-08-03T18:43:58"));
    assert.equal(block.blockStartAt.getTime(), sp("2026-08-03T19:00:00").getTime());
    assert.equal(block.shiftLabel, "SN");
});

test("continua depois do auto-close das 19:15 ainda abre o bloco SN das 19:00 (Claudio 19:24)", () => {
    const block = resolveTelegramExplicitContinuationBlock(sp("2026-08-03T19:24:43"));
    assert.equal(block.blockStartAt.getTime(), sp("2026-08-03T19:00:00").getTime());
    assert.equal(block.shiftLabel, "SN");
});

test("continua às 20h segue referenciando a virada das 19:00 (Rafaela 20:02)", () => {
    const block = resolveTelegramExplicitContinuationBlock(sp("2026-08-03T20:02:31"));
    assert.equal(block.blockStartAt.getTime(), sp("2026-08-03T19:00:00").getTime());
    assert.equal(block.shiftLabel, "SN");
});

// Direção da manhã (casos Uenderson jul/2026): mesmos dois lados da virada das 07:00.
test("continua às 06:41 referencia a virada das 07:00 e abre SD", () => {
    const block = resolveTelegramExplicitContinuationBlock(sp("2026-08-03T06:41:00"));
    assert.equal(block.blockStartAt.getTime(), sp("2026-08-03T07:00:00").getTime());
    assert.equal(block.shiftLabel, "SD");
});

test("continua às 08:12 referencia a virada das 07:00 e abre SD", () => {
    const block = resolveTelegramExplicitContinuationBlock(sp("2026-08-03T08:12:00"));
    assert.equal(block.blockStartAt.getTime(), sp("2026-08-03T07:00:00").getTime());
    assert.equal(block.shiftLabel, "SD");
});

// ─── Rótulo da continuação in-place ("continua" repetido) ───────────────────
//
// "P" só quando a linha ativa atravessa a virada desde ANTES dela. Um continua
// repetido acha o bloco novo (started >= virada) como ativa: rebatizar de "P"
// dava cobertura de 24h a partir da noite (pagamento do SD seguinte não
// trabalhado) — caso Rafaela Menoita 03/08/2026, linha P st=20:02 em produção.

test("chegada de manhã que continua para a noite vira P (caso Manuella)", () => {
    assert.equal(resolveContinuationInPlaceShiftLabel({
        existingStartedAt: sp("2026-08-03T06:41:00"),
        existingShiftLabel: "SD",
        fallbackShiftLabel: "SD",
        continuationAt: sp("2026-08-03T19:24:00"),
    }), "P");
});

test("continua repetido sobre o bloco noturno mantém SN, não vira P (caso Rafaela)", () => {
    assert.equal(resolveContinuationInPlaceShiftLabel({
        existingStartedAt: sp("2026-08-03T20:02:25"),
        existingShiftLabel: "SN",
        fallbackShiftLabel: "SN",
        continuationAt: sp("2026-08-03T20:14:32"),
    }), "SN");
});

test("continua repetido sobre bloco iniciado exatamente na virada mantém o rótulo", () => {
    assert.equal(resolveContinuationInPlaceShiftLabel({
        existingStartedAt: sp("2026-08-03T19:00:00"),
        existingShiftLabel: "SN",
        fallbackShiftLabel: "SN",
        continuationAt: sp("2026-08-03T20:30:00"),
    }), "SN");
});

test("continua repetido sobre linha P de manhã segue P (idempotente)", () => {
    assert.equal(resolveContinuationInPlaceShiftLabel({
        existingStartedAt: sp("2026-08-03T06:41:00"),
        existingShiftLabel: "P",
        fallbackShiftLabel: "SD",
        continuationAt: sp("2026-08-03T20:00:00"),
    }), "P");
});

test("'continua' ao chegar de manhã (caso Uenderson 07:03/08:12) não vira P", () => {
    assert.equal(resolveContinuationInPlaceShiftLabel({
        existingStartedAt: sp("2026-08-03T07:03:00"),
        existingShiftLabel: "SD",
        fallbackShiftLabel: "SD",
        continuationAt: sp("2026-08-03T08:12:00"),
    }), "SD");
});

test("rótulo nulo cai no fallback quando não atravessa a virada", () => {
    assert.equal(resolveContinuationInPlaceShiftLabel({
        existingStartedAt: sp("2026-08-03T19:40:00"),
        existingShiftLabel: null,
        fallbackShiftLabel: "SN",
        continuationAt: sp("2026-08-03T21:00:00"),
    }), "SN");
});

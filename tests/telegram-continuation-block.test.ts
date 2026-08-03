import assert from "node:assert/strict";
import test from "node:test";
import { resolveTelegramExplicitContinuationBlock } from "@/modules/telegram/service";

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

import test from "node:test";
import assert from "node:assert/strict";
import { janelaDeCompetencia, mesAnteriorDe, mesCorrenteSP } from "@/lib/medico/competencia";

test("mês anterior atravessa a virada do ano", () => {
    assert.equal(mesAnteriorDe("2026-01"), "2025-12");
    assert.equal(mesAnteriorDe("2026-09"), "2026-08");
});

test("a janela do autoatendimento é o mês corrente e o anterior", () => {
    assert.equal(janelaDeCompetencia("2026-09", "2026-09"), "corrente");
    assert.equal(janelaDeCompetencia("2026-08", "2026-09"), "anterior");
    // Retrasado e futuro ficam de fora — o mês passado é a folga da nota fiscal,
    // não uma porta aberta para trás.
    assert.equal(janelaDeCompetencia("2026-07", "2026-09"), "fora");
    assert.equal(janelaDeCompetencia("2026-10", "2026-09"), "fora");
});

test("mês corrente sai no fuso de São Paulo, não em UTC", () => {
    // 01/09 00:30 UTC ainda é 31/08 21:30 em São Paulo.
    assert.equal(mesCorrenteSP(new Date("2026-09-01T00:30:00Z")), "2026-08");
    assert.equal(mesCorrenteSP(new Date("2026-09-01T12:00:00Z")), "2026-09");
});

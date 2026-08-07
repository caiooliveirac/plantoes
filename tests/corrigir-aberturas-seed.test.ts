import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { planejar, TOLERANCE, type AberturaAtual, type Correcao } from "@/scripts/corrigir-aberturas-seed";

const dados = JSON.parse(readFileSync("docs/saldo-contrato/aberturas-a-corrigir.json", "utf8")) as {
    correcoes: Correcao[];
};
const francisco = dados.correcoes.find((item) => item.contractNumber === "797/2024")!;
const karen = dados.correcoes.find((item) => item.contractNumber === "518/2024")!;

const abertura = (entryDate: string, amountBrl: number): AberturaAtual[] =>
    [{ ledgerId: "l-1", entryDate, amountBrl }];

test("Francisco: -46.778,94 em 31/05 vira +153.128,27", () => {
    const plano = planejar(francisco, abertura("2026-05-31", -46778.94));
    assert.equal(plano.status, "corrigir");
    assert.equal(plano.alvo?.paraBrl, 153128.27);
    // A diferença que estava escondida no razão.
    assert.ok(Math.abs(153128.27 - -46778.94 - 199907.21) <= TOLERANCE);
});

test("Karen: as duas variantes movem exatamente o mesmo delta de 82.866,00", () => {
    for (const variante of karen.variantes) {
        const plano = planejar(karen, abertura(variante.entryDate, variante.deBrl));
        assert.equal(plano.status, "corrigir", variante.entryDate);
        assert.ok(
            Math.abs(plano.alvo!.paraBrl - variante.deBrl - 82866.0) <= TOLERANCE,
            `${variante.entryDate}: delta ${plano.alvo!.paraBrl - variante.deBrl}`,
        );
    }
});

test("Karen: o saldo final é -6.896,24 pelos dois caminhos", () => {
    // Direto na semente de 31/05.
    const direto = planejar(karen, abertura("2026-05-31", -89762.24));
    assert.ok(Math.abs(direto.alvo!.paraBrl - -6896.24) <= TOLERANCE);
    // Depois do reparo de maio: abertura em 01/05 menos o gasto do mês.
    const apos = planejar(karen, abertura("2026-05-01", -69571.86));
    assert.ok(Math.abs(apos.alvo!.paraBrl - 20190.38 - -6896.24) <= TOLERANCE);
});

test("rodar duas vezes não muda nada", () => {
    for (const correcao of dados.correcoes) {
        for (const variante of correcao.variantes) {
            const plano = planejar(correcao, abertura(variante.entryDate, variante.paraBrl));
            assert.equal(plano.status, "ja_corrigido", `${correcao.doctorName} ${variante.entryDate}`);
        }
    }
});

test("valor fora das variantes não é tocado", () => {
    const plano = planejar(francisco, abertura("2026-05-31", -50000));
    assert.equal(plano.status, "valor_divergente");
    assert.equal(plano.alvo, undefined);
});

test("valor certo na data errada não é tocado", () => {
    const plano = planejar(francisco, abertura("2026-05-01", -46778.94));
    assert.equal(plano.status, "valor_divergente");
});

test("contrato sem abertura no razão não é tocado", () => {
    assert.equal(planejar(francisco, []).status, "sem_abertura");
});

test("mais de uma abertura vira decisão humana", () => {
    const plano = planejar(francisco, [
        { ledgerId: "l-1", entryDate: "2026-05-31", amountBrl: -46778.94 },
        { ledgerId: "l-2", entryDate: "2026-05-01", amountBrl: 100 },
    ]);
    assert.equal(plano.status, "multiplas_aberturas");
});

test("delta declarado que não bate com a variante é barrado", () => {
    const adulterado: Correcao = {
        ...karen,
        variantes: [{ entryDate: "2026-05-31", deBrl: -89762.24, paraBrl: -6896.24 }],
        deltaBrl: 1000,
    };
    assert.equal(planejar(adulterado, abertura("2026-05-31", -89762.24)).status, "valor_divergente");
});

test("todo contrato declara um teto da tabela de referência", () => {
    // 248.598 = 36h generalista (Francisco, Karen); 165.732 = 24h generalista.
    for (const correcao of dados.correcoes) {
        assert.ok(
            [248598.0, 165732.0].includes(correcao.expectedCeilingBrl),
            `${correcao.doctorName}: teto ${correcao.expectedCeilingBrl} fora da tabela`,
        );
    }
});

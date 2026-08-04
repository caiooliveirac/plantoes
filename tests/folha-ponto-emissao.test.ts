import assert from "node:assert/strict";
import test from "node:test";

import {
    dataMinimaEmissao,
    formatarLocalData,
    isDiaUtil,
    localDataDaFolha,
    primeiroDiaUtilDoMes,
    resolverDataEmissao,
} from "@/lib/folha-ponto/emissao";

test("primeiro dia útil pula fim de semana", () => {
    // 01/08/2026 é sábado, 02 é domingo → 03 (segunda).
    assert.equal(primeiroDiaUtilDoMes(2026, 8), "2026-08-03");
    // 01/11/2026 é domingo, 02 é Finados → 03 (terça).
    assert.equal(primeiroDiaUtilDoMes(2026, 11), "2026-11-03");
    // 01/01/2027 é feriado numa sexta → 04 (segunda).
    assert.equal(primeiroDiaUtilDoMes(2027, 1), "2027-01-04");
    // 02/07/2026 (Independência da Bahia) cai numa quinta; 01 é quarta útil.
    assert.equal(primeiroDiaUtilDoMes(2026, 7), "2026-07-01");
    // 01/09/2026 é terça útil.
    assert.equal(primeiroDiaUtilDoMes(2026, 9), "2026-09-01");
});

test("feriado SAMU e fim de semana não são dia útil", () => {
    assert.equal(isDiaUtil("2026-05-01"), false); // Dia do Trabalho
    assert.equal(isDiaUtil("2026-06-04"), false); // feriado SAMU (Corpus Christi)
    assert.equal(isDiaUtil("2026-08-01"), false); // sábado
    assert.equal(isDiaUtil("2026-08-03"), true);
});

test("data mínima é o primeiro dia útil do mês seguinte, virando o ano", () => {
    assert.equal(dataMinimaEmissao(2026, 7), "2026-08-03");
    assert.equal(dataMinimaEmissao(2026, 12), "2027-01-04");
});

test("emissão antes do mês fechar crava a data mínima", () => {
    // Folha de julho aberta ainda em julho: nunca sai com data de julho.
    assert.equal(resolverDataEmissao(2026, 7, "2026-07-20"), "2026-08-03");
    // Aberta no próprio 1º dia útil: a data mínima.
    assert.equal(resolverDataEmissao(2026, 7, "2026-08-03"), "2026-08-03");
    // No fim de semana anterior ao 1º dia útil também.
    assert.equal(resolverDataEmissao(2026, 7, "2026-08-01"), "2026-08-03");
});

test("emissão depois do mínimo usa o dia em que a pessoa gerou", () => {
    assert.equal(resolverDataEmissao(2026, 7, "2026-08-11"), "2026-08-11");
    assert.equal(resolverDataEmissao(2026, 7, "2026-09-02"), "2026-09-02");
});

test("local e data sai por extenso, com o mês da emissão (não o do relatório)", () => {
    assert.equal(formatarLocalData("2026-08-03"), "Salvador, 3 de agosto de 2026");
    assert.equal(localDataDaFolha(2026, 7, "2026-07-15"), "Salvador, 3 de agosto de 2026");
    assert.equal(localDataDaFolha(2026, 12, "2026-12-31"), "Salvador, 4 de janeiro de 2027");
});

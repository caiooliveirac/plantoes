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

// --- linhas do relatório de atividades ---

import { MIN_LINHAS_RELATORIO, montarLinhasImpressas, montarRelatorio } from "@/lib/folha-ponto/montar";
import type { Plantao } from "@/lib/folha-ponto/types";

function plantoes(qtd: number): Plantao[] {
    return Array.from({ length: qtd }, (_, i) => ({
        dia: (i % 31) + 1,
        turno: i < 31 ? ("SD" as const) : ("SN" as const),
        baseNomeCurto: "CRU",
    }));
}

test("relatório não corta atividade de quem dá muitos plantões", () => {
    // O comportamento antigo cravava 25 linhas: quem passava disso tinha
    // atividade sumindo do relatório assinado.
    const linhas = montarRelatorio(plantoes(34), 7);
    assert.equal(linhas.length, 34);
    assert.equal(montarLinhasImpressas(linhas).length, 34);
    assert.ok(montarLinhasImpressas(linhas).every((linha) => linha !== null));
});

test("relatório não inventa linha vazia além do mínimo", () => {
    // As linhas vazias sobrando é que empurravam a folha para uma segunda página.
    for (const qtd of [10, 15, 20, 25, 31]) {
        assert.equal(montarLinhasImpressas(montarRelatorio(plantoes(qtd), 7)).length, qtd);
    }
});

test("poucos plantões ainda rendem uma tabela com cara de formulário", () => {
    const impressas = montarLinhasImpressas(montarRelatorio(plantoes(3), 7));
    assert.equal(impressas.length, MIN_LINHAS_RELATORIO);
    assert.equal(impressas.filter((linha) => linha !== null).length, 3);
    assert.ok(impressas.slice(3).every((linha) => linha === null));
});

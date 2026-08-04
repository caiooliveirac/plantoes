import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
    planejar,
    ultimoDiaDoMes,
    TOLERANCE,
    type ContratoPendente,
    type Encerramento,
} from "@/scripts/lancar-tetos-pendentes";

const dados = JSON.parse(readFileSync("docs/saldo-contrato/tetos-pendentes.json", "utf8")) as {
    contratos: ContratoPendente[];
    encerrar: Encerramento[];
};

const ativo = (contrato: ContratoPendente, cycleEnd = "2027-12-31") => ({
    cycleStart: contrato.expectedCycleStart,
    cycleEnd,
    status: "active",
    temOpening: false,
});

test("ultimoDiaDoMes cobre mês de 30, 31 e fevereiro", () => {
    assert.equal(ultimoDiaDoMes("2026-04"), "2026-04-30");
    assert.equal(ultimoDiaDoMes("2026-05"), "2026-05-31");
    assert.equal(ultimoDiaDoMes("2026-02"), "2026-02-28");
});

test("todo contrato do JSON fecha a aritmética teto − consumo = saldo", () => {
    for (const contrato of dados.contratos) {
        const consumo = contrato.months.reduce((soma, mes) => soma + mes.amountBrl, 0);
        const saldo = contrato.seedClosingBrl ?? contrato.ceilingBrl - consumo;
        assert.ok(
            Math.abs(saldo - contrato.expectedBalanceBrl) <= TOLERANCE,
            `${contrato.doctorName}: ${saldo.toFixed(2)} != ${contrato.expectedBalanceBrl.toFixed(2)}`,
        );
    }
});

test("todo saldo esperado é positivo e menor que o teto", () => {
    for (const contrato of dados.contratos) {
        assert.ok(contrato.expectedBalanceBrl > 0, `${contrato.doctorName} nasce com saldo não positivo`);
        assert.ok(
            contrato.expectedBalanceBrl <= contrato.ceilingBrl + TOLERANCE,
            `${contrato.doctorName} tem saldo acima do teto`,
        );
    }
});

test("o teto de cada contrato é o da tabela de referência para a CH e a categoria", () => {
    // Psiquiatria entra na coluna ESPECIALISTA (decisão de Caio, 2026-08-04).
    const referencia: Record<number, { generalista: number; especialista: number }> = {
        12: { generalista: 82866, especialista: 87429 },
        24: { generalista: 165732, especialista: 174858 },
        36: { generalista: 248598, especialista: 262287 },
        48: { generalista: 331464, especialista: 349716 },
    };
    for (const contrato of dados.contratos) {
        const coluna = contrato.category === "generalista" ? "generalista" : "especialista";
        assert.equal(
            contrato.ceilingBrl,
            referencia[contrato.weeklyHours][coluna],
            `${contrato.doctorName} (${contrato.weeklyHours}h ${contrato.category})`,
        );
    }
});

test("planeja lançar quando o contrato está ativo e sem abertura", () => {
    const contrato = dados.contratos.find((item) => item.contractNumber === "219/2025")!;
    const plano = planejar(contrato, ativo(contrato), false);
    assert.equal(plano.status, "lancar");
});

test("contrato que já tem abertura é pulado", () => {
    const contrato = dados.contratos.find((item) => item.contractNumber === "219/2025")!;
    const plano = planejar(contrato, { ...ativo(contrato), temOpening: true }, false);
    assert.equal(plano.status, "ja_lancado");
});

test("cycle_start diferente do esperado bloqueia", () => {
    const contrato = dados.contratos.find((item) => item.contractNumber === "219/2025")!;
    const plano = planejar(contrato, { ...ativo(contrato), cycleStart: "2025-03-10" }, false);
    assert.equal(plano.status, "ciclo_divergente");
});

test("ciclo assumido só passa com a flag explícita", () => {
    const thiago = dados.contratos.find((item) => item.cycleStartIsAssumed)!;
    assert.equal(planejar(thiago, ativo(thiago), false).status, "ciclo_assumido_bloqueado");
    assert.equal(planejar(thiago, ativo(thiago), true).status, "lancar");
});

test("mês de consumo fora do ciclo bloqueia", () => {
    const contrato = dados.contratos.find((item) => item.contractNumber === "219/2025")!;
    const plano = planejar(contrato, { ...ativo(contrato, "2026-04-01"), cycleStart: contrato.expectedCycleStart }, false);
    assert.equal(plano.status, "mes_fora_do_ciclo");
});

test("aritmética adulterada no JSON é barrada", () => {
    const contrato = dados.contratos.find((item) => item.contractNumber === "219/2025")!;
    const adulterado = { ...contrato, expectedBalanceBrl: contrato.expectedBalanceBrl + 1000 };
    assert.equal(planejar(adulterado, ativo(contrato), false).status, "aritmetica_nao_fecha");
});

test("consumo maior que o teto vira saldo negativo e é barrado", () => {
    const contrato = dados.contratos.find((item) => item.contractNumber === "219/2025")!;
    const estourado: ContratoPendente = {
        ...contrato,
        months: [{ month: "2026-04", amountBrl: 200000, weekdayShifts: 1, weekendShifts: 0 }],
        expectedBalanceBrl: contrato.ceilingBrl - 200000,
    };
    assert.equal(planejar(estourado, ativo(contrato), false).status, "saldo_negativo");
});

test("sem contrato no banco não inventa nada", () => {
    const contrato = dados.contratos[0];
    assert.equal(planejar(contrato, null, false).status, "sem_contrato");
});

test("os números de Ketherynne e Bruno Mota são os corrigidos, não os da planilha", () => {
    // A planilha subestima os dois: a cadeia dela perde um mês em cada caso.
    const ketherynne = dados.contratos.find((item) => item.contractNumber === "55/2025")!;
    const consumoK = ketherynne.months.reduce((soma, mes) => soma + mes.amountBrl, 0);
    assert.ok(Math.abs(consumoK - 22655.19) <= TOLERANCE, `Ketherynne: ${consumoK}`);

    const bruno = dados.contratos.find((item) => item.contractNumber === "633/2025")!;
    const consumoB = bruno.months.reduce((soma, mes) => soma + mes.amountBrl, 0);
    assert.ok(Math.abs(consumoB - 4234.41) <= TOLERANCE, `Bruno Mota: ${consumoB}`);
});

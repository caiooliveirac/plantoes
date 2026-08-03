/**
 * Reparo da linha de maio (scripts/repair-maio-extrato.ts): o planner puro.
 *
 * O que não pode quebrar em silêncio é a idoneidade — nenhum número entra no
 * razão sem a cadeia início − gasto = fim fechar, e célula faltando só é
 * derivada quando sobra exatamente uma incógnita.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { planMayRepair, type MayRow } from "@/scripts/repair-maio-extrato";

function row(overrides: Partial<MayRow> = {}): MayRow {
    return {
        rawName: "MEDICA TESTE",
        normalized: "MEDICA TESTE",
        contractNumbers: ["123/2025"],
        startBalance: 50000,
        monthTotal: 13679.07,
        closingBalance: 36320.93,
        weekdayShifts: 7,
        weekendShifts: 3,
        weekdayAmount: 8714.09,
        weekendAmount: 4964.98,
        ...overrides,
    };
}

describe("planMayRepair — cadeia fecha", () => {
    it("três números legíveis e consistentes viram plano ok", () => {
        const plan = planMayRepair(row());
        assert.equal(plan.status, "ok");
        assert.equal(plan.startBalance, 50000);
        assert.equal(plan.monthTotal, 13679.07);
        assert.equal(plan.closingBalance, 36320.93);
        assert.equal(plan.weekdayShifts, 7);
        assert.equal(plan.weekendShifts, 3);
    });

    it("cadeia que não fecha é recusada", () => {
        const plan = planMayRepair(row({ closingBalance: 30000 }));
        assert.equal(plan.status, "cadeia_quebrada");
    });

    it("gasto negativo é recusado", () => {
        const plan = planMayRepair(row({ monthTotal: -100, closingBalance: 50100, weekdayAmount: null, weekendAmount: null }));
        assert.equal(plan.status, "cadeia_quebrada");
    });

    it("decomposição VALOR SEMANA + VALOR FDS tem que bater com o TOTAL", () => {
        const plan = planMayRepair(row({ weekdayAmount: 1000, weekendAmount: 1000 }));
        assert.equal(plan.status, "soma_nao_bate");
    });
});

describe("planMayRepair — células faltando (casos reais da planilha)", () => {
    it("gasto vazio com início = fim vira gasto zero, marcado como derivado", () => {
        // Caso Acacio/Yngra/Alecianne: TOTAL em branco, saldo idêntico nas pontas.
        const plan = planMayRepair(row({
            startBalance: 11931.84, monthTotal: null, closingBalance: 11931.84,
            weekdayShifts: null, weekendShifts: null, weekdayAmount: null, weekendAmount: null,
        }));
        assert.equal(plan.status, "ok_derivado");
        assert.equal(plan.monthTotal, 0);
        assert.equal(plan.weekdayShifts, 0);
    });

    it("início vazio é derivado de fim + gasto", () => {
        // Caso Bruno Mota: planilha abre em branco e fecha em −1.411,47 com gasto 1.411,47.
        const plan = planMayRepair(row({
            startBalance: null, monthTotal: 1411.47, closingBalance: -1411.47,
            weekdayShifts: 0, weekendShifts: 1, weekdayAmount: null, weekendAmount: null,
        }));
        assert.equal(plan.status, "ok_derivado");
        assert.equal(plan.startBalance, 0);
    });

    it("fim ilegível fica de fora: é o número que valida contra o razão", () => {
        const plan = planMayRepair(row({ closingBalance: null }));
        assert.equal(plan.status, "ilegivel");
    });

    it("duas células faltando ficam de fora", () => {
        const plan = planMayRepair(row({ startBalance: null, monthTotal: null }));
        assert.equal(plan.status, "ilegivel");
    });
});

describe("planMayRepair — plantões", () => {
    it("plantões fora do passo de 0,5 são zerados sem derrubar o valor", () => {
        const plan = planMayRepair(row({ weekdayShifts: 7.3, weekdayAmount: null, weekendAmount: null }));
        assert.equal(plan.status, "ok");
        assert.equal(plan.weekdayShifts, 0);
        assert.equal(plan.weekendShifts, 0);
        assert.equal(plan.monthTotal, 13679.07);
    });

    it("meio plantão é aceito", () => {
        const plan = planMayRepair(row({ weekdayShifts: 7.5, weekdayAmount: null, weekendAmount: null }));
        assert.equal(plan.weekdayShifts, 7.5);
    });

    it("gasto zero zera os plantões", () => {
        const plan = planMayRepair(row({
            monthTotal: 0, closingBalance: 50000, weekdayShifts: 2,
            weekdayAmount: null, weekendAmount: null,
        }));
        assert.equal(plan.status, "ok");
        assert.equal(plan.monthTotal, 0);
        assert.equal(plan.weekdayShifts, 0);
    });
});

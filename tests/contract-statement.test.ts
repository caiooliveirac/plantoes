/**
 * Extrato mês a mês do saldo contratual (lib/contracts/statement.ts).
 *
 * As duas regras que não podem quebrar em silêncio:
 *  1. A fronteira do ciclo — contrato renovado em 01/08 NÃO recebe consumo de
 *     agosto (o bug visto na página de Paula Mayana).
 *  2. O saldo corre linha a linha e a última linha é o saldo atual, com a data
 *     certa no rótulo (dia 1º seguinte, fim do ciclo, ou HOJE).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
    buildContractStatement,
    isMonthWithinCycle,
    nextMonthKey,
    type StatementMonthMovements,
} from "@/lib/contracts/statement";

const brl = (value: number) => Math.round(value * 100);

const months = (entries: Record<string, Partial<StatementMonthMovements>>) =>
    new Map(Object.entries(entries).map(([key, value]) => [key, {
        consumptionCents: value.consumptionCents ?? 0,
        adjustmentsCents: value.adjustmentsCents ?? 0,
    }]));

describe("fronteira do ciclo (caso Paula Mayana: renovação em 01/08)", () => {
    it("agosto fica FORA do ciclo que termina em 01/08", () => {
        assert.equal(isMonthWithinCycle("2026-08", "2025-08-01", "2026-08-01"), false);
    });

    it("julho fica dentro, e agosto pertence ao ciclo novo", () => {
        assert.equal(isMonthWithinCycle("2026-07", "2025-08-01", "2026-08-01"), true);
        assert.equal(isMonthWithinCycle("2026-08", "2026-08-01", "2027-08-01"), true);
    });

    it("mês que só encosta no ciclo pela metade ainda conta (fim no meio do mês)", () => {
        assert.equal(isMonthWithinCycle("2026-08", "2025-08-15", "2026-08-15"), true);
        assert.equal(isMonthWithinCycle("2026-09", "2025-08-15", "2026-08-15"), false);
    });

    it("o extrato do contrato renovado em 01/08 termina em 01/08, sem linha de agosto", () => {
        const rows = buildContractStatement({
            openingCents: brl(50000),
            openingDate: "2026-05-01",
            months: months({
                "2026-05": { consumptionCents: brl(10000) },
                "2026-06": { consumptionCents: brl(12000) },
                "2026-07": { consumptionCents: brl(8000) },
            }),
            cycleEnd: "2026-08-01",
            asOfDate: "2026-08-03",
        });
        assert.equal(rows.length, 3);
        const ultima = rows.at(-1)!;
        assert.equal(ultima.monthKey, "2026-07");
        assert.equal(ultima.endDate, "2026-08-01");
        assert.equal(ultima.endIsToday, false);
        assert.equal(ultima.endBalanceCents, brl(50000 - 10000 - 12000 - 8000));
    });
});

describe("extrato — saldo datado, linha a linha", () => {
    const rows = buildContractStatement({
        openingCents: brl(30000),
        openingDate: "2026-06-15",
        months: months({
            "2026-06": { consumptionCents: brl(5000) },
            "2026-07": { consumptionCents: brl(7000), adjustmentsCents: brl(1000) },
            "2026-08": { consumptionCents: brl(2000) },
        }),
        cycleEnd: "2027-06-15",
        asOfDate: "2026-08-03",
    });

    it("primeira linha começa na data da abertura, não no dia 1º", () => {
        assert.equal(rows[0].startDate, "2026-06-15");
        assert.equal(rows[0].startBalanceCents, brl(30000));
    });

    it("o saldo final de um mês é o inicial do seguinte, com a data do dia 1º", () => {
        assert.equal(rows[0].endDate, "2026-07-01");
        assert.equal(rows[0].endBalanceCents, brl(25000));
        assert.equal(rows[1].startDate, "2026-07-01");
        assert.equal(rows[1].startBalanceCents, brl(25000));
    });

    it("ajuste manual entra no mês e muda o saldo final", () => {
        assert.equal(rows[1].adjustmentsCents, brl(1000));
        assert.equal(rows[1].endBalanceCents, brl(25000 + 1000 - 7000));
    });

    it("o mês corrente termina HOJE, com a data de hoje", () => {
        const ultima = rows.at(-1)!;
        assert.equal(ultima.monthKey, "2026-08");
        assert.equal(ultima.endIsToday, true);
        assert.equal(ultima.endDate, "2026-08-03");
        assert.equal(ultima.endBalanceCents, brl(19000 - 2000));
    });
});

describe("extrato — casos de borda", () => {
    it("ajuste datado fora da janela dobra para a ponta: o saldo final tem que bater com o razão", () => {
        const rows = buildContractStatement({
            openingCents: brl(10000),
            openingDate: "2026-07-01",
            months: months({
                "2026-01": { adjustmentsCents: brl(500) },
                "2026-07": { consumptionCents: brl(1000) },
            }),
            cycleEnd: "2027-07-01",
            asOfDate: "2026-07-20",
        });
        assert.equal(rows.length, 1);
        assert.equal(rows[0].endBalanceCents, brl(10000 + 500 - 1000));
    });

    it("mês sem movimento aparece com gasto zero e saldo carregado", () => {
        const rows = buildContractStatement({
            openingCents: brl(10000),
            openingDate: "2026-05-01",
            months: months({ "2026-07": { consumptionCents: brl(1000) } }),
            cycleEnd: "2027-05-01",
            asOfDate: "2026-07-10",
        });
        assert.equal(rows.length, 3);
        assert.equal(rows[1].consumptionCents, 0);
        assert.equal(rows[1].startBalanceCents, brl(10000));
        assert.equal(rows[1].endBalanceCents, brl(10000));
    });

    it("abertura no futuro não gera linha", () => {
        const rows = buildContractStatement({
            openingCents: brl(10000),
            openingDate: "2026-09-01",
            months: new Map(),
            cycleEnd: "2027-09-01",
            asOfDate: "2026-08-03",
        });
        assert.equal(rows.length, 0);
    });

    it("virada de ano no nextMonthKey", () => {
        assert.equal(nextMonthKey("2026-12"), "2027-01");
    });
});

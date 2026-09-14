/**
 * Quais meses o saldo contratual ainda apura ao vivo (services/contract-balance.service.ts).
 *
 * Mês fechado no razão é período imutável: não pode voltar a ser montado ao
 * abrir a tela. Só os meses em aberto de algum contrato — depois da abertura,
 * dentro do ciclo, sem lançamento — custam board.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { monthRange, resolveMonthsNeedingLiveApuracao } from "@/services/contract-balance.service";

const meses = monthRange("2025-06", "2026-09");

function contrato(overrides: Partial<{ contractId: string; doctorId: string; cycleStart: string; cycleEnd: string; openingAt: Date }> = {}) {
    return {
        contractId: "c1",
        doctorId: "d1",
        cycleStart: "2026-03-01",
        cycleEnd: "2027-03-01",
        openingAt: new Date("2026-03-01T00:00:00Z"),
        ...overrides,
    };
}

describe("resolveMonthsNeedingLiveApuracao", () => {
    it("ignora os meses antes da abertura e fora do ciclo", () => {
        const result = resolveMonthsNeedingLiveApuracao({
            contratos: [contrato()],
            meses,
            settledKeys: new Set(),
            ledger: new Map(),
        });
        assert.deepEqual(result, monthRange("2026-03", "2026-09"));
    });

    it("pula o mês já lançado no razão do contrato ou com consumo vivo em outro contrato do médico", () => {
        const result = resolveMonthsNeedingLiveApuracao({
            contratos: [contrato()],
            meses,
            settledKeys: new Set(["d1|2026-05"]),
            ledger: new Map([["c1", {
                openingCents: 0,
                openingDate: "2026-03-01",
                settledByMonth: new Map([["2026-03", 100], ["2026-04", 0]]),
                adjustmentsByMonth: new Map(),
            }]]),
        });
        assert.deepEqual(result, monthRange("2026-06", "2026-09"));
    });

    it("um mês entra se QUALQUER contrato ainda precisar dele; a ordem é a de `meses`", () => {
        const result = resolveMonthsNeedingLiveApuracao({
            contratos: [
                contrato({ contractId: "c1", doctorId: "d1", cycleStart: "2026-08-01", cycleEnd: "2027-08-01", openingAt: new Date("2026-08-01T00:00:00Z") }),
                contrato({ contractId: "c2", doctorId: "d2", cycleStart: "2026-01-01", cycleEnd: "2026-05-01", openingAt: new Date("2026-01-01T00:00:00Z") }),
            ],
            meses,
            settledKeys: new Set(["d2|2026-02", "d2|2026-03"]),
            ledger: new Map(),
        });
        assert.deepEqual(result, ["2026-01", "2026-04", "2026-08", "2026-09"]);
    });

    it("sem contrato, nenhum mês é montado", () => {
        assert.deepEqual(resolveMonthsNeedingLiveApuracao({ contratos: [], meses, settledKeys: new Set(), ledger: new Map() }), []);
    });
});

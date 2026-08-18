import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
    planCeilingCorrectionAdjustment,
    planClosingTransfers,
    type ClosingLedgerRow,
} from "@/lib/contracts/redefinition";

const DOCTOR = "d1";
const OLD = "contrato-antigo";
const OTHER = "contrato-de-outro-vinculo";

function row(overrides: Partial<ClosingLedgerRow> & { month: string }): ClosingLedgerRow {
    return {
        contractId: OLD,
        sourceKey: `${DOCTOR}|${overrides.month}`,
        amountCents: -100_000,
        weekdayShifts: 1,
        weekendShifts: 0,
        sourceRevision: 0,
        ...overrides,
    };
}

describe("planClosingTransfers", () => {
    it("migra o mês vivo do contrato antigo que cai no ciclo novo", () => {
        const transfers = planClosingTransfers({
            rows: [row({ month: "2026-06" })],
            oldContractId: OLD,
            newCycleStart: "2026-05-01",
            newCycleEnd: "2027-05-01",
        });
        assert.equal(transfers.length, 1);
        assert.equal(transfers[0].monthKey, "2026-06");
        assert.equal(transfers[0].netCents, -100_000);
        assert.equal(transfers[0].reversalRevision, 1);
        assert.equal(transfers[0].invoiceRevision, 2);
    });

    it("não migra mês fora do ciclo novo nem origem morta (soma zero)", () => {
        const transfers = planClosingTransfers({
            rows: [
                // Antes do ciclo novo: fica no contrato antigo.
                row({ month: "2026-03" }),
                // Atestado e desassinado: invoice + estorno somam zero.
                row({ month: "2026-06", amountCents: -100_000 }),
                row({ month: "2026-06", amountCents: 100_000, weekdayShifts: -1, sourceRevision: 1 }),
            ],
            oldContractId: OLD,
            newCycleStart: "2026-05-01",
            newCycleEnd: "2027-05-01",
        });
        assert.equal(transfers.length, 0);
    });

    it("soma reajustes do mesmo mês e continua a revisão da maior global", () => {
        const transfers = planClosingTransfers({
            rows: [
                row({ month: "2026-06", amountCents: -100_000, sourceRevision: 0 }),
                // Reajuste depois da atestação: mais consumo no mesmo mês.
                row({ month: "2026-06", amountCents: -20_000, weekdayShifts: 0, weekendShifts: 1, sourceRevision: 1 }),
                // Revisão maior gravada por OUTRO contrato do médico: o índice
                // único é global, as novas revisões têm que vir depois dela.
                row({ month: "2026-06", contractId: OTHER, amountCents: -5_000, weekdayShifts: 0, sourceRevision: 4 }),
            ],
            oldContractId: OLD,
            newCycleStart: "2026-05-01",
            newCycleEnd: "2027-05-01",
        });
        assert.equal(transfers.length, 1);
        // Só o que está no contrato antigo migra — o valor do outro contrato não.
        assert.equal(transfers[0].netCents, -120_000);
        assert.equal(transfers[0].weekdayShifts, 1);
        assert.equal(transfers[0].weekendShifts, 1);
        assert.equal(transfers[0].reversalRevision, 5);
        assert.equal(transfers[0].invoiceRevision, 6);
    });

    it("ordena por mês e ignora sourceKey nulo", () => {
        const transfers = planClosingTransfers({
            rows: [
                row({ month: "2026-07" }),
                row({ month: "2026-05" }),
                { contractId: OLD, sourceKey: null, amountCents: -1, weekdayShifts: 0, weekendShifts: 0, sourceRevision: 0 },
            ],
            oldContractId: OLD,
            newCycleStart: "2026-05-01",
            newCycleEnd: "2027-05-01",
        });
        assert.deepEqual(transfers.map((transfer) => transfer.monthKey), ["2026-05", "2026-07"]);
    });
});

describe("planCeilingCorrectionAdjustment", () => {
    it("lança a diferença quando a abertura veio do teto errado (caso Zolaína)", () => {
        assert.equal(
            planCeilingCorrectionAdjustment({
                openingCents: 33_146_400,
                openingEntryCount: 1,
                previousCeilingCents: 33_146_400,
                newCeilingCents: 41_433_000,
            }),
            8_286_600,
        );
    });

    it("não mexe na abertura medida, que não deriva do teto", () => {
        assert.equal(
            planCeilingCorrectionAdjustment({
                openingCents: 10_878_485,
                openingEntryCount: 1,
                previousCeilingCents: 17_485_800,
                newCeilingCents: 18_000_000,
            }),
            0,
        );
    });

    it("nada a lançar sem abertura, sem teto anterior, ou com teto igual", () => {
        const base = { openingCents: 0, openingEntryCount: 0, previousCeilingCents: 100, newCeilingCents: 200 };
        assert.equal(planCeilingCorrectionAdjustment(base), 0);
        assert.equal(planCeilingCorrectionAdjustment({ ...base, openingEntryCount: 1, previousCeilingCents: null }), 0);
        assert.equal(
            planCeilingCorrectionAdjustment({ openingCents: 100, openingEntryCount: 1, previousCeilingCents: 100, newCeilingCents: 100 }),
            0,
        );
    });
});

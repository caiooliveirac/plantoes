import assert from "node:assert/strict";
import test from "node:test";
import {
    BANK_HOURS_PAYROLL_SETTLEMENT_KIND,
    buildPayrollSettlementNote,
    formatPayrollMinutes,
    resolvePayrollDeductionForMonth,
} from "@/modules/bank-hours/payroll";

test("abatimento em folha soma só os plantões negativos do mês", () => {
    const result = resolvePayrollDeductionForMonth({
        monthKey: "2026-06",
        shifts: [
            { monthKey: "2026-06", balanceMinutes: -40 },
            { monthKey: "2026-06", balanceMinutes: 90 },
            { monthKey: "2026-06", balanceMinutes: -20 },
            { monthKey: "2026-06", balanceMinutes: 0 },
            { monthKey: "2026-05", balanceMinutes: -300 },
        ],
        settlements: [],
    });

    assert.equal(result.negativeShiftCount, 2);
    assert.equal(result.negativeMinutes, -60);
    assert.equal(result.abatedMinutes, 0);
    assert.equal(result.remainingMinutes, -60);
    assert.equal(result.pending, true);
});

test("abatimento já lançado zera a pendência do mês; estorno reabre", () => {
    const shifts = [{ monthKey: "2026-06", balanceMinutes: -60 }];
    const abatido = resolvePayrollDeductionForMonth({
        monthKey: "2026-06",
        shifts,
        settlements: [{ monthKey: "2026-06", kind: BANK_HOURS_PAYROLL_SETTLEMENT_KIND, deltaMinutes: 60 }],
    });
    assert.equal(abatido.abatedMinutes, 60);
    assert.equal(abatido.remainingMinutes, 0);
    assert.equal(abatido.pending, false);

    const estornado = resolvePayrollDeductionForMonth({
        monthKey: "2026-06",
        shifts,
        settlements: [
            { monthKey: "2026-06", kind: BANK_HOURS_PAYROLL_SETTLEMENT_KIND, deltaMinutes: 60 },
            { monthKey: "2026-06", kind: BANK_HOURS_PAYROLL_SETTLEMENT_KIND, deltaMinutes: -60 },
        ],
    });
    assert.equal(estornado.abatedMinutes, 0);
    assert.equal(estornado.pending, true);
});

test("acerto de ±12h (bonus/penalty) e acerto de outro mês não contam como abatimento", () => {
    const result = resolvePayrollDeductionForMonth({
        monthKey: "2026-06",
        shifts: [{ monthKey: "2026-06", balanceMinutes: -60 }],
        settlements: [
            { monthKey: "2026-06", kind: "penalty", deltaMinutes: 720 },
            { monthKey: "2026-05", kind: BANK_HOURS_PAYROLL_SETTLEMENT_KIND, deltaMinutes: 60 },
        ],
    });
    assert.equal(result.abatedMinutes, 0);
    assert.equal(result.remainingMinutes, -60);
    assert.equal(result.pending, true);
});

test("novo atraso depois de um abatimento parcial só cobra a diferença", () => {
    const result = resolvePayrollDeductionForMonth({
        monthKey: "2026-06",
        shifts: [
            { monthKey: "2026-06", balanceMinutes: -60 },
            { monthKey: "2026-06", balanceMinutes: -25 },
        ],
        settlements: [{ monthKey: "2026-06", kind: BANK_HOURS_PAYROLL_SETTLEMENT_KIND, deltaMinutes: 60 }],
    });
    assert.equal(result.remainingMinutes, -25);
    assert.equal(result.pending, true);
});

test("mês sem atraso não tem nada a abater, mesmo com saldo total negativo", () => {
    const result = resolvePayrollDeductionForMonth({
        monthKey: "2026-06",
        shifts: [
            { monthKey: "2026-06", balanceMinutes: 30 },
            { monthKey: "2026-05", balanceMinutes: -900 },
        ],
        settlements: [],
    });
    assert.equal(result.negativeShiftCount, 0);
    assert.equal(result.pending, false);
});

test("nota do abatimento é legível e carrega mês, plantões e horas", () => {
    assert.equal(
        buildPayrollSettlementNote({ monthKey: "2026-06", negativeShiftCount: 2, deltaMinutes: 85 }),
        "Abatido em folha — 2026-06: 2 plantões com atraso, 1h25 descontados na folha de pagamento/ponto",
    );
    assert.equal(
        buildPayrollSettlementNote({ monthKey: "2026-06", negativeShiftCount: 1, deltaMinutes: 20 }),
        "Abatido em folha — 2026-06: 1 plantão com atraso, 20 min descontados na folha de pagamento/ponto",
    );
});

test("formatPayrollMinutes", () => {
    assert.equal(formatPayrollMinutes(0), "0 min");
    assert.equal(formatPayrollMinutes(-45), "45 min");
    assert.equal(formatPayrollMinutes(60), "1h");
    assert.equal(formatPayrollMinutes(125), "2h05");
});

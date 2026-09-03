import assert from "node:assert/strict";
import test from "node:test";
import {
    BANK_HOURS_PAYROLL_SETTLEMENT_KIND,
    PAYROLL_SPLIT_CROSSING_DEBIT,
    buildPayrollSettlementNote,
    formatPayrollMinutes,
    resolvePayrollDeductionForDoctorMonth,
    resolvePayrollDeductionForMonth,
    resolvePayrollOpeningBalance,
} from "@/modules/bank-hours/payroll";

const M = "2026-06";
const shift = (balanceMinutes: number, day = 1, monthKey = M) => ({
    monthKey,
    balanceMinutes,
    startedAt: `${monthKey}-${String(day).padStart(2, "0")}T10:00:00.000Z`,
});

test("decisão vigente: débito que cruza o zero é dividido entre banco e folha", () => {
    assert.equal(PAYROLL_SPLIT_CROSSING_DEBIT, true);
});

test("saldo prévio positivo cobre todos os débitos: nada vai à folha", () => {
    const result = resolvePayrollDeductionForMonth({
        monthKey: M,
        openingBalanceMinutes: 300,
        shifts: [shift(-40, 3), shift(90, 5), shift(-20, 9), shift(0, 11), shift(-300, 1, "2026-05")],
        settlements: [],
    });
    assert.equal(result.creditShiftCount, 1);
    assert.equal(result.creditMinutes, 90);
    assert.equal(result.negativeShiftCount, 2);
    assert.equal(result.negativeMinutes, -60);
    assert.equal(result.availableMinutes, 390);
    assert.equal(result.absorbedMinutes, 60);
    assert.equal(result.payrollMinutes, 0);
    assert.equal(result.closingBankMinutes, 330);
    assert.equal(result.remainingMinutes, 0);
    assert.equal(result.pending, false);
});

test("exemplo da regra: prévio -2h, créditos +6h, débito -5h → 4h do banco, 1h na folha, banco zera", () => {
    const result = resolvePayrollDeductionForMonth({
        monthKey: M,
        openingBalanceMinutes: -120,
        shifts: [shift(360, 2), shift(-300, 10)],
        settlements: [],
    });
    assert.equal(result.availableMinutes, 240);
    assert.deepEqual(result.creditSteps, [
        { startedAt: shift(360, 2).startedAt, balanceMinutes: 360, bankBeforeMinutes: -120, bankAfterMinutes: 240 },
    ]);
    assert.equal(result.absorbedMinutes, 240);
    assert.equal(result.payrollMinutes, 60);
    assert.equal(result.closingBankMinutes, 0);
    assert.equal(result.pending, true);
    assert.equal(result.remainingMinutes, -60);
    assert.equal(result.steps.length, 1);
    assert.deepEqual(result.steps[0], {
        startedAt: shift(-300, 10).startedAt,
        balanceMinutes: -300,
        bankBeforeMinutes: 240,
        bankMinutes: 240,
        payrollMinutes: 60,
        bankAfterMinutes: 0,
        crossedZero: true,
    });
});

test("créditos entram ANTES dos débitos, independente da ordem cronológica", () => {
    // Débito no dia 2, crédito só no dia 20: mesmo assim o crédito serve de colchão.
    const result = resolvePayrollDeductionForMonth({
        monthKey: M,
        openingBalanceMinutes: 0,
        shifts: [shift(-60, 2), shift(60, 20)],
        settlements: [],
    });
    assert.equal(result.absorbedMinutes, 60);
    assert.equal(result.payrollMinutes, 0);
    assert.equal(result.closingBankMinutes, 0);
});

test("débitos consomem o banco em ordem cronológica; após cruzar o zero, tudo vai à folha", () => {
    const result = resolvePayrollDeductionForMonth({
        monthKey: M,
        openingBalanceMinutes: 50,
        shifts: [shift(-30, 20), shift(-30, 5), shift(-30, 12)],
        settlements: [],
    });
    assert.deepEqual(
        result.steps.map((step) => [step.startedAt?.slice(8, 10), step.bankMinutes, step.payrollMinutes, step.crossedZero]),
        [["05", 30, 0, false], ["12", 20, 10, true], ["20", 0, 30, false]],
    );
    assert.equal(result.absorbedMinutes, 50);
    assert.equal(result.payrollMinutes, 40);
    assert.equal(result.closingBankMinutes, 0);
});

test("prévio negativo nunca vai à folha: créditos só o atenuam e cada débito vai inteiro à folha", () => {
    const result = resolvePayrollDeductionForMonth({
        monthKey: M,
        openingBalanceMinutes: -600,
        shifts: [shift(90, 3), shift(-40, 8), shift(-25, 15)],
        settlements: [],
    });
    assert.equal(result.availableMinutes, -510);
    assert.equal(result.absorbedMinutes, 0);
    assert.equal(result.payrollMinutes, 65);
    assert.equal(result.closingBankMinutes, -510);
    assert.equal(result.remainingMinutes, -65);
    assert.equal(result.pending, true);
    assert.ok(result.steps.every((step) => !step.crossedZero && step.bankMinutes === 0));
});

test("modo alternativo (split desligado): débito que cruza vai inteiro à folha e o banco guarda a sobra", () => {
    const result = resolvePayrollDeductionForMonth({
        monthKey: M,
        openingBalanceMinutes: -120,
        shifts: [shift(360, 2), shift(-300, 10), shift(-100, 20)],
        settlements: [],
        splitCrossingDebit: false,
    });
    assert.equal(result.steps[0].bankMinutes, 0);
    assert.equal(result.steps[0].payrollMinutes, 300);
    assert.equal(result.steps[0].crossedZero, true);
    // O débito menor seguinte ainda cabe nos +4h que sobraram.
    assert.equal(result.steps[1].bankMinutes, 100);
    assert.equal(result.closingBankMinutes, 140);
    assert.equal(result.payrollMinutes, 300);
});

test("abatimento já lançado zera a pendência do mês; estorno reabre", () => {
    const shifts = [shift(-60)];
    const abatido = resolvePayrollDeductionForMonth({
        monthKey: M,
        openingBalanceMinutes: 0,
        shifts,
        settlements: [{ monthKey: M, kind: BANK_HOURS_PAYROLL_SETTLEMENT_KIND, deltaMinutes: 60 }],
    });
    assert.equal(abatido.abatedMinutes, 60);
    assert.equal(abatido.remainingMinutes, 0);
    assert.equal(abatido.pending, false);

    const estornado = resolvePayrollDeductionForMonth({
        monthKey: M,
        openingBalanceMinutes: 0,
        shifts,
        settlements: [
            { monthKey: M, kind: BANK_HOURS_PAYROLL_SETTLEMENT_KIND, deltaMinutes: 60 },
            { monthKey: M, kind: BANK_HOURS_PAYROLL_SETTLEMENT_KIND, deltaMinutes: -60 },
        ],
    });
    assert.equal(estornado.abatedMinutes, 0);
    assert.equal(estornado.pending, true);
});

test("acerto de ±12h e acerto de outro mês não contam como abatimento do mês", () => {
    const result = resolvePayrollDeductionForMonth({
        monthKey: M,
        openingBalanceMinutes: 0,
        shifts: [shift(-60)],
        settlements: [
            { monthKey: M, kind: "penalty", deltaMinutes: 720 },
            { monthKey: "2026-05", kind: BANK_HOURS_PAYROLL_SETTLEMENT_KIND, deltaMinutes: 60 },
        ],
    });
    assert.equal(result.abatedMinutes, 0);
    assert.equal(result.remainingMinutes, -60);
    assert.equal(result.pending, true);
});

test("saldo prévio = legado + plantões e acertos de meses anteriores; o próprio mês fica fora", () => {
    const opening = resolvePayrollOpeningBalance({
        monthKey: M,
        legacyMinutes: -1000,
        shifts: [shift(100, 1, "2026-04"), shift(50, 1, "2026-05"), shift(-999, 1, M), shift(400, 1, "2026-07")],
        settlements: [
            { monthKey: "2026-05", kind: BANK_HOURS_PAYROLL_SETTLEMENT_KIND, deltaMinutes: 30 },
            { monthKey: M, kind: BANK_HOURS_PAYROLL_SETTLEMENT_KIND, deltaMinutes: 999 },
            { monthKey: "2026-07", kind: "bonus", deltaMinutes: -720 },
        ],
    });
    assert.equal(opening, -1000 + 100 + 50 + 30);
});

test("atalho por médico: saldo depois = prévio + créditos − absorvido, coerente com o settlement", () => {
    const result = resolvePayrollDeductionForDoctorMonth({
        monthKey: M,
        legacyMinutes: 0,
        shifts: [shift(200, 1, "2026-05"), shift(30, 2), shift(-100, 4), shift(-200, 6)],
        settlements: [],
    });
    assert.equal(result.openingBalanceMinutes, 200);
    assert.equal(result.availableMinutes, 230);
    assert.equal(result.absorbedMinutes, 230);
    assert.equal(result.payrollMinutes, 70);
    // Balanço real do banco após gravar o settlement (+70): 200 + 30 − 300 + 70 = 0.
    assert.equal(200 + 30 - 300 + result.payrollMinutes, result.closingBankMinutes);
});

test("mês sem atraso não tem nada a abater, mesmo com saldo total negativo", () => {
    const result = resolvePayrollDeductionForMonth({
        monthKey: M,
        openingBalanceMinutes: -900,
        shifts: [shift(30)],
        settlements: [],
    });
    assert.equal(result.negativeShiftCount, 0);
    assert.equal(result.pending, false);
    assert.equal(result.steps.length, 0);
});

test("nota do abatimento é legível e carrega mês, plantões, absorvido e horas", () => {
    assert.equal(
        buildPayrollSettlementNote({ monthKey: M, negativeShiftCount: 2, deltaMinutes: 85 }),
        "Abatido em folha — 2026-06: 2 plantões com atraso, 1h25 descontados na folha de pagamento/ponto",
    );
    assert.equal(
        buildPayrollSettlementNote({ monthKey: M, negativeShiftCount: 1, deltaMinutes: 20, absorbedMinutes: 240 }),
        "Abatido em folha — 2026-06: 1 plantão com atraso, 4h absorvidos pelo banco, 20 min descontados na folha de pagamento/ponto",
    );
});

test("formatPayrollMinutes", () => {
    assert.equal(formatPayrollMinutes(0), "0 min");
    assert.equal(formatPayrollMinutes(-45), "45 min");
    assert.equal(formatPayrollMinutes(60), "1h");
    assert.equal(formatPayrollMinutes(125), "2h05");
});

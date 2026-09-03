import assert from "node:assert/strict";
import test from "node:test";
import {
    BANK_HOURS_PAYROLL_SETTLEMENT_KIND,
    PAYROLL_SPLIT_CROSSING_DEBIT,
    formatPayrollMinutes,
    resolvePayrollDeductionForDoctorMonth,
    resolvePayrollDeductionForMonth,
    resolvePayrollLedger,
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
    });
    assert.equal(result.creditShiftCount, 1);
    assert.equal(result.creditMinutes, 90);
    assert.equal(result.negativeShiftCount, 2);
    assert.equal(result.negativeMinutes, -60);
    assert.equal(result.availableMinutes, 390);
    assert.equal(result.absorbedMinutes, 60);
    assert.equal(result.payrollMinutes, 0);
    assert.equal(result.closingBankMinutes, 330);
});

test("exemplo da regra: prévio -2h, créditos +6h, débito -5h → 4h do banco, 1h na folha, banco zera", () => {
    const result = resolvePayrollDeductionForMonth({
        monthKey: M,
        openingBalanceMinutes: -120,
        shifts: [shift(360, 2), shift(-300, 10)],
    });
    assert.equal(result.availableMinutes, 240);
    assert.deepEqual(result.creditSteps, [
        { startedAt: shift(360, 2).startedAt, balanceMinutes: 360, bankBeforeMinutes: -120, bankAfterMinutes: 240 },
    ]);
    assert.equal(result.absorbedMinutes, 240);
    assert.equal(result.payrollMinutes, 60);
    assert.equal(result.closingBankMinutes, 0);
    assert.deepEqual(result.steps, [{
        startedAt: shift(-300, 10).startedAt,
        balanceMinutes: -300,
        bankBeforeMinutes: 240,
        bankMinutes: 240,
        payrollMinutes: 60,
        bankAfterMinutes: 0,
        crossedZero: true,
    }]);
});

test("créditos entram ANTES dos débitos, independente da ordem cronológica", () => {
    const result = resolvePayrollDeductionForMonth({
        monthKey: M,
        openingBalanceMinutes: 0,
        shifts: [shift(-60, 2), shift(60, 20)],
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
    });
    assert.equal(result.availableMinutes, -510);
    assert.equal(result.absorbedMinutes, 0);
    assert.equal(result.payrollMinutes, 65);
    assert.equal(result.closingBankMinutes, -510);
    assert.ok(result.steps.every((step) => !step.crossedZero && step.bankMinutes === 0));
});

test("modo alternativo (split desligado): débito que cruza vai inteiro à folha e o banco guarda a sobra", () => {
    const result = resolvePayrollDeductionForMonth({
        monthKey: M,
        openingBalanceMinutes: -120,
        shifts: [shift(360, 2), shift(-300, 10), shift(-100, 20)],
        splitCrossingDebit: false,
    });
    assert.equal(result.steps[0].bankMinutes, 0);
    assert.equal(result.steps[0].payrollMinutes, 300);
    assert.equal(result.steps[0].crossedZero, true);
    assert.equal(result.steps[1].bankMinutes, 100);
    assert.equal(result.closingBankMinutes, 140);
    assert.equal(result.payrollMinutes, 300);
});

test("razão: settlements payroll antigos são ignorados; bônus entra no banco ao fim do mês dele", () => {
    const ledger = resolvePayrollLedger({
        legacyMinutes: -1000,
        shifts: [shift(100, 1, "2026-04"), shift(50, 1, "2026-05"), shift(-30, 1, M), shift(400, 1, "2026-07")],
        settlements: [
            { monthKey: "2026-05", kind: BANK_HOURS_PAYROLL_SETTLEMENT_KIND, deltaMinutes: 30 },
            { monthKey: M, kind: BANK_HOURS_PAYROLL_SETTLEMENT_KIND, deltaMinutes: 999 },
            { monthKey: "2026-07", kind: "bonus", deltaMinutes: -720 },
        ],
    });
    assert.deepEqual(
        ledger.months.map((month) => [month.monthKey, month.openingBalanceMinutes, month.payrollMinutes, month.closingBankMinutes]),
        [
            ["2026-04", -1000, 0, -900],
            ["2026-05", -900, 0, -850],
            [M, -850, 30, -850],
            ["2026-07", -850, 0, -450],
        ],
    );
    assert.equal(ledger.balanceMinutes, -450 - 720);
    assert.equal(ledger.payrollTotalMinutes, 30);
});

test("razão: o banco zera num mês e o mês seguinte já parte do zero", () => {
    const ledger = resolvePayrollLedger({
        legacyMinutes: -120,
        shifts: [shift(360, 2), shift(-300, 10), shift(-60, 5, "2026-07")],
        settlements: [],
        throughMonthKey: "2026-08",
    });
    assert.deepEqual(
        ledger.months.map((month) => [month.monthKey, month.openingBalanceMinutes, month.payrollMinutes, month.closingBankMinutes]),
        [[M, -120, 60, 0], ["2026-07", 0, 60, 0], ["2026-08", 0, 0, 0]],
    );
    assert.equal(ledger.balanceMinutes, 0);
});

test("cascata de um mês usa o prévio do razão: saldo depois = prévio + créditos − absorvido", () => {
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
    assert.equal(result.closingBankMinutes, 0);
});

test("mês sem atraso não tem nada para a folha, mesmo com saldo total negativo", () => {
    const result = resolvePayrollDeductionForMonth({
        monthKey: M,
        openingBalanceMinutes: -900,
        shifts: [shift(30)],
    });
    assert.equal(result.negativeShiftCount, 0);
    assert.equal(result.payrollMinutes, 0);
    assert.equal(result.steps.length, 0);
});

test("formatPayrollMinutes", () => {
    assert.equal(formatPayrollMinutes(0), "0 min");
    assert.equal(formatPayrollMinutes(-45), "45 min");
    assert.equal(formatPayrollMinutes(60), "1h");
    assert.equal(formatPayrollMinutes(125), "2h05");
});

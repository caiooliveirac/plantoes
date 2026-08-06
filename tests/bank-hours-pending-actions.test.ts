import { test } from "node:test";
import assert from "node:assert/strict";

import {
    BANK_HOURS_PENDING_UNIT_MINUTES,
    buildBankHoursPendingSummaryMessage,
    formatSignedHours,
    resolveBankHoursPendingAction,
    type BankHoursPendingRow,
} from "@/modules/bank-hours/pending-actions";

function action(bonusEligibleMinutes: number, penaltyEligibleMinutes = bonusEligibleMinutes, settlementDeltaMinutes = 0) {
    return resolveBankHoursPendingAction({ bonusEligibleMinutes, penaltyEligibleMinutes, settlementDeltaMinutes });
}

test("unidade padrão é 12h", () => {
    assert.equal(BANK_HOURS_PENDING_UNIT_MINUTES, 720);
});

test("+11h59 não gera ação (sem arredondar para cima)", () => {
    const result = action(719);
    assert.equal(result.direction, null);
    assert.equal(result.pendingUnits, 0);
    assert.equal(result.residualMinutes, 719);
});

test("+12h gera exatamente uma ação de acréscimo", () => {
    const result = action(720);
    assert.equal(result.direction, "bonus");
    assert.equal(result.pendingUnits, 1);
    assert.equal(result.residualMinutes, 0);
});

test("+23h59 gera apenas uma ação, com sobra", () => {
    const result = action(1439);
    assert.equal(result.direction, "bonus");
    assert.equal(result.pendingUnits, 1);
    assert.equal(result.residualMinutes, 719);
});

test("+24h gera duas ações", () => {
    const result = action(1440);
    assert.equal(result.pendingUnits, 2);
    assert.equal(result.residualMinutes, 0);
});

test("-11h59 não gera ação", () => {
    const result = action(-719, -719);
    assert.equal(result.direction, null);
    assert.equal(result.residualMinutes, -719);
});

test("-12h gera uma ação de retirada", () => {
    const result = action(-720, -720);
    assert.equal(result.direction, "penalty");
    assert.equal(result.pendingUnits, 1);
    assert.equal(result.residualMinutes, 0);
});

test("-24h gera duas ações; -25h sobra -1h", () => {
    assert.equal(action(-1440, -1440).pendingUnits, 2);
    const sobra = action(-1500, -1500);
    assert.equal(sobra.pendingUnits, 2);
    assert.equal(sobra.residualMinutes, -60);
});

test("aplicar uma unidade em +24h mantém outra pendente (saldo elegível já com acerto)", () => {
    // Saldo bruto +24h, um bônus aplicado (delta -720): elegível cai para +12h.
    const result = action(720, 720, -720);
    assert.equal(result.direction, "bonus");
    assert.equal(result.pendingUnits, 1);
    assert.equal(result.inconsistency, false, "mesma direção não é inconsistência");
});

test("aplicar todas as unidades deixa só o resíduo, sem ação", () => {
    // Bruto +27h → dois bônus aplicados (-24h) → sobra +3h.
    const result = action(180, 180, -1440);
    assert.equal(result.direction, null);
    assert.equal(result.residualMinutes, 180);
    assert.equal(result.inconsistency, false);
});

test("saldo que virou negativo APÓS bônus pago é inconsistência", () => {
    // Bônus pago (delta -720) e depois plantão invalidado: elegível -12h.
    const result = action(-720, -720, -720);
    assert.equal(result.direction, "penalty");
    assert.equal(result.inconsistency, true);
});

test("saldo que virou positivo após punição cobrada é inconsistência", () => {
    const result = action(720, 720, 720);
    assert.equal(result.direction, "bonus");
    assert.equal(result.inconsistency, true);
});

test("formatSignedHours cobre sobras quebradas", () => {
    assert.equal(formatSignedHours(0), "+0h");
    assert.equal(formatSignedHours(180), "+3h");
    assert.equal(formatSignedHours(-60), "-1h");
    assert.equal(formatSignedHours(-125), "-2h05");
    assert.equal(formatSignedHours(1620), "+27h");
});

test("resumo diário: null sem pendências, mensagem única agrupada com pendências", () => {
    assert.equal(buildBankHoursPendingSummaryMessage([]), null);

    const rows: BankHoursPendingRow[] = [
        { doctorName: "João Silva", direction: "bonus", eligibleMinutes: 1620, pendingUnits: 2, residualMinutes: 180, inconsistency: false },
        { doctorName: "Pedro Santos", direction: "penalty", eligibleMinutes: -840, pendingUnits: 1, residualMinutes: -120, inconsistency: false },
        { doctorName: "Carlos Alves", direction: "penalty", eligibleMinutes: -720, pendingUnits: 1, residualMinutes: 0, inconsistency: true },
    ];
    const message = buildBankHoursPendingSummaryMessage(rows, { adminUrl: "https://example.test/admin/bank-hours" });
    assert.ok(message);
    assert.match(message, /João Silva: \+27h — 2 plantões verdes disponíveis — sobra \+3h/);
    assert.match(message, /Pedro Santos: -14h — retirar 1 plantão \(vermelho\) — sobra -2h/);
    assert.match(message, /Revisão necessária/);
    assert.match(message, /Carlos Alves/);
    assert.match(message, /Total: 3 médicos aguardando ação\./);
    assert.match(message, /https:\/\/example\.test\/admin\/bank-hours/);
});

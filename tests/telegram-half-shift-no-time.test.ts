/**
 * Meio plantão da tarde SEM exigir horário.
 *
 * Regra de negócio (junho/2026): qualquer forma de aviso de meio plantão da tarde
 * ("meio plantão", "meio turno", "turno da tarde", "tarde", "de tarde", "mp", "mt")
 * deve ser aceita sem que o médico precise digitar um horário. O sistema aloca como
 * MEIO_PLANTAO na janela fixa 11:30–17:00 (esperado chegar 11:30, auto-saída 17:00),
 * paga como meia jornada (0.5) e o banco de horas só pesa atraso quando o aviso vem
 * depois das 11:30 + 15 min de tolerância.
 *
 * Incidente que originou a regra: Uenderson avisou "Uenderson 1361 meio plantão tarde"
 * às 14:34 e tomou erro (arrival_missing_name_or_shift) por não ter informado hora,
 * ficando sem registro.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { parseMessage } from "@/modules/telegram/parser";
import { arrivalHalfShiftSatisfiesShiftGate, shouldAssumeTelegramHalfShift } from "@/modules/telegram/service";
import { calculateBankHours } from "@/modules/bank-hours/calculator";
import { HALF_SHIFT_ROLE_LABEL, resolvePaymentUnitFromRole } from "@/modules/operational/half-shift";

// Salvador/Bahia = America/Sao_Paulo = UTC-3 o ano todo (Brasil sem horário de verão).
const at = (hhmm: string) => new Date(`2026-06-02T${hhmm}:00-03:00`);

const HALF_SHIFT_FORMS = [
    "Uenderson 1361 meio plantão",
    "Uenderson 1361 meio turno",
    "Uenderson 1361 turno da tarde",
    "Uenderson 1361 tarde",
    "Uenderson 1361 de tarde",
    "Uenderson 1361 mp",
    "Uenderson 1361 mt",
];

test("parser: todas as formas de meio plantão viram roleFunction MEIO sem turno SD/SN/P", () => {
    for (const text of HALF_SHIFT_FORMS) {
        const parsed = parseMessage(text);
        assert.equal(parsed.sector, "REGULATION", `setor para: ${text}`);
        assert.equal(parsed.roleFunction, HALF_SHIFT_ROLE_LABEL, `roleFunction para: ${text}`);
        assert.equal(parsed.shiftType, null, `shiftType deve ficar nulo para: ${text}`);
        assert.equal(parsed.arrivalTime, null, `não deve exigir horário para: ${text}`);
    }
});

test("parser: 'boa tarde' é saudação, não meio plantão", () => {
    const parsed = parseMessage("boa tarde pessoal");
    assert.notEqual(parsed.roleFunction, HALF_SHIFT_ROLE_LABEL);
});

test("gate: meio plantão SEM horário é aceito pela hora da mensagem dentro da janela", () => {
    const parsed = parseMessage("Uenderson 1361 meio plantão tarde");
    // Mensagem do Uenderson às 14:34 — antes do fix isso tomava erro.
    assert.equal(arrivalHalfShiftSatisfiesShiftGate(parsed, at("14:34")), true);
    // Nome extraído satisfaz o outro lado do gate (hasName).
    assert.ok(parsed.extractedNames.length > 0, "esperava nome extraído");
});

test("gate: limites da janela 10:30 (inclusive) – 17:00 (exclusive) pela hora da mensagem", () => {
    const parsed = parseMessage("Uenderson 1361 tarde");
    assert.equal(arrivalHalfShiftSatisfiesShiftGate(parsed, at("10:30")), true, "10:30 inclusive");
    assert.equal(arrivalHalfShiftSatisfiesShiftGate(parsed, at("16:59")), true, "16:59 dentro");
    assert.equal(arrivalHalfShiftSatisfiesShiftGate(parsed, at("10:29")), false, "10:29 antes");
    assert.equal(arrivalHalfShiftSatisfiesShiftGate(parsed, at("17:00")), false, "17:00 exclusive");
    assert.equal(arrivalHalfShiftSatisfiesShiftGate(parsed, at("18:30")), false, "18:30 depois");
});

test("gate: horário declarado, quando presente, manda na janela (independe da hora da mensagem)", () => {
    const parsed = parseMessage("Uenderson 1361 meio turno 11:30");
    assert.equal(parsed.arrivalTime, "11:30");
    // Mensagem chegou às 20:00, mas declarou 11:30: dentro da janela → aceito.
    assert.equal(arrivalHalfShiftSatisfiesShiftGate(parsed, at("20:00")), true);

    const outside = parseMessage("Uenderson 1361 meio turno 09:00");
    assert.equal(arrivalHalfShiftSatisfiesShiftGate(outside, at("14:00")), false);
});

test("gate: turno explícito (SN) não passa pelo atalho de meio plantão", () => {
    const parsed = parseMessage("Uenderson 1361 sn");
    assert.equal(arrivalHalfShiftSatisfiesShiftGate(parsed, at("14:34")), false);
});

test("shouldAssumeTelegramHalfShift: assume meia jornada pela hora do evento na janela", () => {
    const parsed = parseMessage("Uenderson 1361 meio plantão tarde");
    assert.equal(shouldAssumeTelegramHalfShift({ parsed, eventAt: at("14:34"), effectiveShiftType: null }), true);
    assert.equal(shouldAssumeTelegramHalfShift({ parsed, eventAt: at("18:00"), effectiveShiftType: null }), false);
});

test("shouldAssumeTelegramHalfShift: chegada SD às 11:37 também vira meio plantão", () => {
    const parsed = parseMessage("Alessandra 1361 SD 11:37");
    assert.equal(shouldAssumeTelegramHalfShift({ parsed, eventAt: at("11:37"), effectiveShiftType: "SD" }), true);
});

// --- Banco de horas: janela fixa 11:30–17:00, "só pesa atraso" (sem crédito por chegar cedo) ---

const halfShiftBank = (actualStartHHMM: string, actualEndHHMM = "17:00") => calculateBankHours({
    scheduledStartAt: at("11:30"),
    scheduledEndAt: at("17:00"),
    actualStartAt: at(actualStartHHMM),
    actualEndAt: at(actualEndHHMM),
});

test("banco: aviso pontual (11:30) não gera débito nem crédito", () => {
    const result = halfShiftBank("11:30");
    assert.equal(result.arrivalDelayMinutes, 0);
    assert.equal(result.balanceMinutes, 0);
    assert.equal(result.ruleCode, "ON_TIME_NO_OVERTIME");
});

test("banco: aviso até 15 min após 11:30 fica na tolerância (saldo 0)", () => {
    const result = halfShiftBank("11:45");
    assert.equal(result.arrivalDelayMinutes, 0);
    assert.equal(result.balanceMinutes, 0);
});

test("banco: avisar antes das 11:30 não dá crédito (só pesa atraso)", () => {
    const result = halfShiftBank("11:00");
    assert.equal(result.arrivalDelayMinutes, 0);
    assert.equal(result.balanceMinutes, 0);
});

test("banco: atraso acima de 15 min após 11:30 debita o atraso", () => {
    const result = halfShiftBank("11:50"); // 20 min
    assert.equal(result.arrivalDelayMinutes, 20);
    assert.equal(result.balanceMinutes, -20);
    assert.equal(result.ruleCode, "LATE_NO_OVERTIME");
});

test("banco: caso Uenderson — aviso às 14:34 debita o atraso desde as 11:30", () => {
    const result = halfShiftBank("14:34"); // 184 min
    assert.equal(result.arrivalDelayMinutes, 184);
    assert.equal(result.balanceMinutes, -184);
});

test("pagamento: meio plantão é meia jornada (0.5)", () => {
    assert.equal(resolvePaymentUnitFromRole(HALF_SHIFT_ROLE_LABEL), 0.5);
});

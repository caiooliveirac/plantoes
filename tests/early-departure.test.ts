import assert from "node:assert/strict";
import test from "node:test";
import {
    classifyEarlyDeparture,
    isEarlyDepartureEligible,
    resolveEarlyDeparturePaymentUnit,
} from "@/modules/operational/early-departure";
import { buildEarlyDepartureBankHours } from "@/modules/bank-hours/calculator";

function iso(value: string) {
    return new Date(value).toISOString();
}

// ── Faixas medidas da janela (SD 07:00–19:00, horário de São Paulo) ─────────

test("retirada antes de 6h de janela vira bank_only com crédito das horas trabalhadas", () => {
    const result = classifyEarlyDeparture({
        departureAt: iso("2026-08-03T12:00:00-03:00"),
        scheduledStartAt: iso("2026-08-03T07:00:00-03:00"),
        scheduledEndAt: iso("2026-08-03T19:00:00-03:00"),
        startedAt: iso("2026-08-03T07:00:00-03:00"),
    });

    assert.equal(result.outcome, "bank_only");
    assert.equal(result.elapsedMinutes, 300);
    assert.equal(result.workedMinutes, 300);
    assert.equal(result.bankCreditMinutes, 300);
});

test("chegada atrasada só credita as horas trabalhadas, não a janela", () => {
    // Chegou 09:00, retirado 12:00: 5h de janela decorridas, 3h trabalhadas.
    const result = classifyEarlyDeparture({
        departureAt: iso("2026-08-03T12:00:00-03:00"),
        scheduledStartAt: iso("2026-08-03T07:00:00-03:00"),
        scheduledEndAt: iso("2026-08-03T19:00:00-03:00"),
        startedAt: iso("2026-08-03T09:00:00-03:00"),
    });

    assert.equal(result.outcome, "bank_only");
    assert.equal(result.workedMinutes, 180);
    assert.equal(result.bankCreditMinutes, 180);
});

test("chegada muito cedo não infla o crédito: trabalhado conta da janela", () => {
    // Chegou 05:30 (antes da janela), retirado 10:00 → trabalhado = 3h, não 4h30.
    const result = classifyEarlyDeparture({
        departureAt: iso("2026-08-03T10:00:00-03:00"),
        scheduledStartAt: iso("2026-08-03T07:00:00-03:00"),
        scheduledEndAt: iso("2026-08-03T19:00:00-03:00"),
        startedAt: iso("2026-08-03T05:30:00-03:00"),
    });

    assert.equal(result.outcome, "bank_only");
    assert.equal(result.workedMinutes, 180);
});

test("13:00 em diante (6h de janela) assina meio plantão; excedente de 6h vira crédito", () => {
    // Caso do usuário: saiu 15:00 → meio plantão + 2h de crédito.
    const result = classifyEarlyDeparture({
        departureAt: iso("2026-08-03T15:00:00-03:00"),
        scheduledStartAt: iso("2026-08-03T07:00:00-03:00"),
        scheduledEndAt: iso("2026-08-03T19:00:00-03:00"),
        startedAt: iso("2026-08-03T07:00:00-03:00"),
    });

    assert.equal(result.outcome, "half_shift");
    assert.equal(result.bankCreditMinutes, 120);
});

test("bordas: 12:59 é bank_only, 13:00 é half_shift", () => {
    const base = {
        scheduledStartAt: iso("2026-08-03T07:00:00-03:00"),
        scheduledEndAt: iso("2026-08-03T19:00:00-03:00"),
        startedAt: iso("2026-08-03T07:00:00-03:00"),
    };

    assert.equal(classifyEarlyDeparture({ ...base, departureAt: iso("2026-08-03T12:59:00-03:00") }).outcome, "bank_only");
    assert.equal(classifyEarlyDeparture({ ...base, departureAt: iso("2026-08-03T13:00:00-03:00") }).outcome, "half_shift");
});

test("bordas: 16:59 é half_shift, 17:00 (2h do fim) assina inteiro", () => {
    const base = {
        scheduledStartAt: iso("2026-08-03T07:00:00-03:00"),
        scheduledEndAt: iso("2026-08-03T19:00:00-03:00"),
        startedAt: iso("2026-08-03T07:00:00-03:00"),
    };

    assert.equal(classifyEarlyDeparture({ ...base, departureAt: iso("2026-08-03T16:59:00-03:00") }).outcome, "half_shift");
    const full = classifyEarlyDeparture({ ...base, departureAt: iso("2026-08-03T17:00:00-03:00") });
    assert.equal(full.outcome, "full_shift");
    assert.equal(full.bankCreditMinutes, 0);
});

test("meio-plantão atrasado na faixa half não pode ter crédito negativo", () => {
    // Chegou 09:00 e saiu 14:00: half seria worked(5h) - 6h < 0 → clamp em 0.
    const result = classifyEarlyDeparture({
        departureAt: iso("2026-08-03T14:00:00-03:00"),
        scheduledStartAt: iso("2026-08-03T07:00:00-03:00"),
        scheduledEndAt: iso("2026-08-03T19:00:00-03:00"),
        startedAt: iso("2026-08-03T09:00:00-03:00"),
    });

    assert.equal(result.outcome, "half_shift");
    assert.equal(result.bankCreditMinutes, 0);
});

// ── Turno noturno cruzando meia-noite ───────────────────────────────────────

test("SN 19:00–07:00: retirada 23:30 é bank_only; 02:00 é half; 05:30 é inteiro", () => {
    const base = {
        scheduledStartAt: iso("2026-08-03T19:00:00-03:00"),
        scheduledEndAt: iso("2026-08-04T07:00:00-03:00"),
        startedAt: iso("2026-08-03T19:00:00-03:00"),
    };

    assert.equal(classifyEarlyDeparture({ ...base, departureAt: iso("2026-08-03T23:30:00-03:00") }).outcome, "bank_only");
    assert.equal(classifyEarlyDeparture({ ...base, departureAt: iso("2026-08-04T02:00:00-03:00") }).outcome, "half_shift");
    assert.equal(classifyEarlyDeparture({ ...base, departureAt: iso("2026-08-04T05:30:00-03:00") }).outcome, "full_shift");
});

// ── Casos fora da faixa ─────────────────────────────────────────────────────

test("retirada de sobra do turno anterior (depois do fim da janela) é full_shift", () => {
    // SD 07–19 retirado às 19:30 na virada: encerramento normal, sem faixa.
    const result = classifyEarlyDeparture({
        departureAt: iso("2026-08-03T19:30:00-03:00"),
        scheduledStartAt: iso("2026-08-03T07:00:00-03:00"),
        scheduledEndAt: iso("2026-08-03T19:00:00-03:00"),
        startedAt: iso("2026-08-03T07:05:00-03:00"),
    });

    assert.equal(result.outcome, "full_shift");
    assert.equal(result.bankCreditMinutes, 0);
});

test("posto núcleo (08:00) mede a janela da agenda, não das 07:00", () => {
    // Núcleo SD 08:00–19:00: retirada 13:30 tem 5h30 de janela → bank_only.
    const result = classifyEarlyDeparture({
        departureAt: iso("2026-08-03T13:30:00-03:00"),
        scheduledStartAt: iso("2026-08-03T08:00:00-03:00"),
        scheduledEndAt: iso("2026-08-03T19:00:00-03:00"),
        startedAt: iso("2026-08-03T08:00:00-03:00"),
    });

    assert.equal(result.outcome, "bank_only");
    assert.equal(result.elapsedMinutes, 330);
});

test("P atravessando a virada mede só o segmento do turno corrente", () => {
    // P iniciado ontem 07:00, agendado até amanhã 07:00, retirado 22:00 de hoje:
    // o segmento corrente começa 19:00 → 3h de janela → bank_only.
    const result = classifyEarlyDeparture({
        departureAt: iso("2026-08-03T22:00:00-03:00"),
        scheduledStartAt: iso("2026-08-03T07:00:00-03:00"),
        scheduledEndAt: iso("2026-08-04T07:00:00-03:00"),
        startedAt: iso("2026-08-03T07:00:00-03:00"),
    });

    assert.equal(result.outcome, "bank_only");
    assert.equal(result.elapsedMinutes, 180);
    assert.equal(result.workedMinutes, 180);
});

test("sem janela agendada, cai na janela operacional 07/19", () => {
    const result = classifyEarlyDeparture({
        departureAt: iso("2026-08-03T12:00:00-03:00"),
        startedAt: iso("2026-08-03T07:10:00-03:00"),
    });

    assert.equal(result.outcome, "bank_only");
    assert.equal(result.elapsedMinutes, 300);
    assert.equal(result.workedMinutes, 290);
});

// ── Elegibilidade e fração de pagamento ─────────────────────────────────────

test("meio plantão declarado (MEIO_PLANTAO) não entra na régua", () => {
    assert.equal(isEarlyDepartureEligible({ roleLabel: "MEIO_PLANTAO" }), false);
    assert.equal(isEarlyDepartureEligible({ roleLabel: "Meio Plantao" }), false);
    assert.equal(isEarlyDepartureEligible({ roleLabel: "REGULADOR" }), true);
    assert.equal(isEarlyDepartureEligible({ roleLabel: null }), true);
});

test("fração de pagamento por desfecho: 0 / 0.5 / regra normal", () => {
    assert.equal(resolveEarlyDeparturePaymentUnit("bank_only"), 0);
    assert.equal(resolveEarlyDeparturePaymentUnit("half_shift"), 0.5);
    assert.equal(resolveEarlyDeparturePaymentUnit("full_shift"), null);
    assert.equal(resolveEarlyDeparturePaymentUnit(null), null);
});

// ── Banco de horas do desfecho ──────────────────────────────────────────────

test("bank_only credita exatamente as horas trabalhadas, sem débito", () => {
    const result = buildEarlyDepartureBankHours({
        outcome: "bank_only",
        workedMinutes: 300,
        bankCreditMinutes: 300,
        arrivalDelayMinutes: 0,
    });

    assert.equal(result.balanceMinutes, 300);
    assert.equal(result.creditedOvertimeMinutes, 300);
    assert.equal(result.ruleCode, "EARLY_DEPARTURE_BANK_ONLY");
});

test("half_shift credita o excedente de 6h", () => {
    const result = buildEarlyDepartureBankHours({
        outcome: "half_shift",
        workedMinutes: 480,
        bankCreditMinutes: 120,
        arrivalDelayMinutes: 0,
    });

    assert.equal(result.balanceMinutes, 120);
    assert.equal(result.ruleCode, "EARLY_DEPARTURE_HALF_CREDIT");
});

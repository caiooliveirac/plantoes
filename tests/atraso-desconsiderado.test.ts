import test from "node:test";
import assert from "node:assert/strict";
import { ARRIVAL_GRACE_MINUTES, buildEarlyDepartureBankHours, calculateBankHours } from "@/modules/bank-hours/calculator";
import { buildContinuityBankHoursSpan } from "@/modules/bank-hours/continuity";

/**
 * Atraso desconsiderado pela chefia (puro): o cálculo trata a chegada como
 * pontual sem mexer na hora real — atraso 0, excedente em dobro, código de
 * pontual — e a explicação registra o atraso bruto perdoado.
 */

const base = {
    scheduledStartAt: "2026-02-11T10:00:00.000Z",
    scheduledEndAt: "2026-02-11T22:15:00.000Z",
};

test("sem a marca, 30 min de atraso debitam e deixam o excedente simples", () => {
    const result = calculateBankHours({
        ...base,
        actualStartAt: "2026-02-11T10:30:00.000Z",
        actualEndAt: "2026-02-11T23:15:00.000Z",
    });
    assert.equal(result.arrivalDelayMinutes, 30);
    assert.equal(result.overtimeMultiplier, 1);
    assert.equal(result.ruleCode, "LATE_SIMPLE_OVERTIME");
    assert.equal(result.balanceMinutes, 60 - 30);
    assert.ok(!result.explanation.startsWith("Atraso de"));
});

test("com a marca, 30 min de atraso viram pontual: atraso 0, dobro e prefixo na explicação", () => {
    const result = calculateBankHours({
        ...base,
        actualStartAt: "2026-02-11T10:30:00.000Z",
        actualEndAt: "2026-02-11T23:15:00.000Z",
        arrivalDelayWaived: true,
    });
    assert.equal(result.arrivalDelayMinutes, 0);
    assert.equal(result.overtimeMultiplier, 2);
    assert.equal(result.creditedOvertimeMinutes, 120);
    assert.equal(result.balanceMinutes, 120);
    assert.equal(result.ruleCode, "ON_TIME_DOUBLE_OVERTIME");
    assert.ok(result.explanation.startsWith("Atraso de 30 min desconsiderado pela chefia. "), result.explanation);
});

test("com a marca e sem excedente, fica o código de pontual sem crédito", () => {
    const result = calculateBankHours({
        ...base,
        actualStartAt: "2026-02-11T11:00:00.000Z",
        actualEndAt: "2026-02-11T22:15:00.000Z",
        arrivalDelayWaived: true,
    });
    assert.equal(result.arrivalDelayMinutes, 0);
    assert.equal(result.balanceMinutes, 0);
    assert.equal(result.ruleCode, "ON_TIME_NO_OVERTIME");
    assert.ok(result.explanation.startsWith("Atraso de 60 min desconsiderado pela chefia. "));
});

test("atraso dentro da tolerância não ganha prefixo mesmo com a marca", () => {
    const within = ARRIVAL_GRACE_MINUTES;
    const waived = calculateBankHours({
        ...base,
        actualStartAt: new Date(new Date(base.scheduledStartAt).getTime() + within * 60_000),
        actualEndAt: "2026-02-11T22:15:00.000Z",
        arrivalDelayWaived: true,
    });
    const plain = calculateBankHours({
        ...base,
        actualStartAt: new Date(new Date(base.scheduledStartAt).getTime() + within * 60_000),
        actualEndAt: "2026-02-11T22:15:00.000Z",
    });
    assert.deepEqual(waived, plain);
    assert.ok(!waived.explanation.startsWith("Atraso de"));
});

test("marca falsa ou ausente é o cálculo de sempre", () => {
    const input = { ...base, actualStartAt: "2026-02-11T10:30:00.000Z", actualEndAt: "2026-02-11T22:15:00.000Z" };
    assert.deepEqual(calculateBankHours({ ...input, arrivalDelayWaived: false }), calculateBankHours(input));
});

test("régua de saída antecipada recebe o atraso já zerado", () => {
    const raw = calculateBankHours({
        ...base,
        actualStartAt: "2026-02-11T10:30:00.000Z",
        actualEndAt: "2026-02-11T18:00:00.000Z",
        arrivalDelayWaived: true,
    });
    const early = buildEarlyDepartureBankHours({
        outcome: "bank_only",
        workedMinutes: 450,
        bankCreditMinutes: 450,
        arrivalDelayMinutes: raw.arrivalDelayMinutes,
    });
    assert.equal(early.arrivalDelayMinutes, 0);
    assert.equal(early.balanceMinutes, 450);
});

test("span de continuidade carrega a marca se qualquer membro a tiver", () => {
    const common = {
        doctorId: "d1",
        continuityGroupId: "g1",
        domain: "regulation" as const,
        shiftLabel: "SD",
        scheduledStartAt: base.scheduledStartAt,
        scheduledEndAt: base.scheduledEndAt,
    };
    const semMarca = buildContinuityBankHoursSpan([
        { ...common, occupancyId: "a", startedAt: "2026-02-11T10:30:00.000Z", endedAt: "2026-02-11T15:00:00.000Z" },
        { ...common, occupancyId: "b", startedAt: "2026-02-11T15:00:00.000Z", endedAt: "2026-02-11T22:15:00.000Z" },
    ]);
    assert.equal(semMarca.arrivalDelayWaived, false);

    const comMarca = buildContinuityBankHoursSpan([
        { ...common, occupancyId: "a", startedAt: "2026-02-11T10:30:00.000Z", endedAt: "2026-02-11T15:00:00.000Z" },
        { ...common, occupancyId: "b", startedAt: "2026-02-11T15:00:00.000Z", endedAt: "2026-02-11T22:15:00.000Z", arrivalDelayWaivedAt: "2026-02-11T16:00:00.000Z" },
    ]);
    assert.equal(comMarca.arrivalDelayWaived, true);
});

test("aviso ao secretário: desconsiderar e voltar a contar, com atraso e motivo", async () => {
    const { buildArrivalDelayWaiverNotice } = await import("@/lib/avisos/abono-atraso");
    const texto = buildArrivalDelayWaiverNotice({
        waived: true,
        doctorName: "Dr. Bruno",
        targetCode: "1362",
        actorLabel: "chefe@samu.local",
        startedAt: new Date("2026-10-01T10:22:00Z"),
        scheduledStartAt: new Date("2026-10-01T10:00:00Z"),
        note: "Avisou antes da chegada",
    });
    assert.match(texto, /chefe@samu.local desconsiderou o atraso de Dr\. Bruno \(1362\)/);
    assert.match(texto, /atraso de 22 min \(previsto 07:00, chegou 07:22\)/);
    assert.match(texto, /Motivo: Avisou antes da chegada\./);
    const volta = buildArrivalDelayWaiverNotice({
        waived: false, doctorName: null, targetCode: "CB02", actorLabel: null,
        startedAt: new Date("2026-10-01T10:05:00Z"), scheduledStartAt: new Date("2026-10-01T10:00:00Z"), note: null,
    });
    assert.match(volta, /chefia de plantão voltou a contar o atraso de ocupante \(CB02\): chegada 07:05, dentro da tolerância/);
});

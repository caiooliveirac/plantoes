import assert from "node:assert/strict";
import test from "node:test";
import { calculateBankHours } from "@/modules/bank-hours/calculator";

function iso(value: string) {
    return new Date(value).toISOString();
}

test("gives double overtime when arrival is on time", () => {
    const result = calculateBankHours({
        scheduledStartAt: iso("2026-03-25T07:00:00-03:00"),
        scheduledEndAt: iso("2026-03-25T19:00:00-03:00"),
        actualStartAt: iso("2026-03-25T07:12:00-03:00"),
        actualEndAt: iso("2026-03-25T19:30:00-03:00"),
    });

    assert.equal(result.arrivalDelayMinutes, 0);
    assert.equal(result.overtimeMinutes, 30);
    assert.equal(result.creditedOvertimeMinutes, 60);
    assert.equal(result.balanceMinutes, 60);
});

test("uses full arrival delay once tolerance is broken", () => {
    const result = calculateBankHours({
        scheduledStartAt: iso("2026-03-25T07:00:00-03:00"),
        scheduledEndAt: iso("2026-03-25T19:00:00-03:00"),
        actualStartAt: iso("2026-03-25T07:18:00-03:00"),
        actualEndAt: iso("2026-03-25T19:45:00-03:00"),
    });

    assert.equal(result.arrivalDelayMinutes, 18);
    assert.equal(result.overtimeMultiplier, 1);
    assert.equal(result.creditedOvertimeMinutes, 45);
    assert.equal(result.balanceMinutes, 27);
});

test("does not create extra debit for leaving early", () => {
    const result = calculateBankHours({
        scheduledStartAt: iso("2026-03-25T07:00:00-03:00"),
        scheduledEndAt: iso("2026-03-25T19:00:00-03:00"),
        actualStartAt: iso("2026-03-25T06:55:00-03:00"),
        actualEndAt: iso("2026-03-25T18:40:00-03:00"),
    });

    assert.equal(result.arrivalDelayMinutes, 0);
    assert.equal(result.overtimeMinutes, 0);
    assert.equal(result.balanceMinutes, 0);
});

test("ignores arrival and late exit below 15 minutes", () => {
    const result = calculateBankHours({
        scheduledStartAt: iso("2026-03-25T07:00:00-03:00"),
        scheduledEndAt: iso("2026-03-25T19:00:00-03:00"),
        actualStartAt: iso("2026-03-25T07:14:00-03:00"),
        actualEndAt: iso("2026-03-25T19:14:00-03:00"),
    });

    assert.equal(result.arrivalDelayMinutes, 0);
    assert.equal(result.overtimeMinutes, 0);
    assert.equal(result.overtimeMultiplier, 2);
    assert.equal(result.creditedOvertimeMinutes, 0);
    assert.equal(result.balanceMinutes, 0);
});

test("starts crediting late departure from exactly 15 minutes", () => {
    const result = calculateBankHours({
        scheduledStartAt: iso("2026-03-25T07:00:00-03:00"),
        scheduledEndAt: iso("2026-03-25T19:00:00-03:00"),
        actualStartAt: iso("2026-03-25T07:00:00-03:00"),
        actualEndAt: iso("2026-03-25T19:15:00-03:00"),
    });

    assert.equal(result.arrivalDelayMinutes, 0);
    assert.equal(result.overtimeMinutes, 15);
    assert.equal(result.overtimeMultiplier, 2);
    assert.equal(result.creditedOvertimeMinutes, 30);
    assert.equal(result.balanceMinutes, 30);
});

test("starts charging arrival delay from exactly 15 minutes", () => {
    const result = calculateBankHours({
        scheduledStartAt: iso("2026-03-25T07:00:00-03:00"),
        scheduledEndAt: iso("2026-03-25T19:00:00-03:00"),
        actualStartAt: iso("2026-03-25T07:15:00-03:00"),
        actualEndAt: iso("2026-03-25T19:15:00-03:00"),
    });

    assert.equal(result.arrivalDelayMinutes, 15);
    assert.equal(result.overtimeMinutes, 15);
    assert.equal(result.overtimeMultiplier, 1);
    assert.equal(result.creditedOvertimeMinutes, 15);
    assert.equal(result.balanceMinutes, 0);
});

test("breaks forgiveness after 15 minutes and removes doubled overtime", () => {
    const result = calculateBankHours({
        scheduledStartAt: iso("2026-03-25T07:00:00-03:00"),
        scheduledEndAt: iso("2026-03-25T19:00:00-03:00"),
        actualStartAt: iso("2026-03-25T07:16:00-03:00"),
        actualEndAt: iso("2026-03-25T19:16:00-03:00"),
    });

    assert.equal(result.arrivalDelayMinutes, 16);
    assert.equal(result.overtimeMinutes, 16);
    assert.equal(result.overtimeMultiplier, 1);
    assert.equal(result.creditedOvertimeMinutes, 16);
    assert.equal(result.balanceMinutes, 0);
});

test("does not reward early arrival by itself", () => {
    const result = calculateBankHours({
        scheduledStartAt: iso("2026-03-25T07:00:00-03:00"),
        scheduledEndAt: iso("2026-03-25T19:00:00-03:00"),
        actualStartAt: iso("2026-03-25T06:42:00-03:00"),
        actualEndAt: iso("2026-03-25T19:00:00-03:00"),
    });

    assert.equal(result.arrivalDelayMinutes, 0);
    assert.equal(result.overtimeMinutes, 0);
    assert.equal(result.creditedOvertimeMinutes, 0);
    assert.equal(result.balanceMinutes, 0);
});

test("continued shift ignores arrival and late exit below 15 minutes", () => {
    const result = calculateBankHours({
        scheduledStartAt: iso("2026-03-25T19:00:00-03:00"),
        scheduledEndAt: iso("2026-03-26T07:00:00-03:00"),
        actualStartAt: iso("2026-03-25T19:14:00-03:00"),
        actualEndAt: iso("2026-03-26T07:14:00-03:00"),
    });

    assert.equal(result.arrivalDelayMinutes, 0);
    assert.equal(result.overtimeMinutes, 0);
    assert.equal(result.overtimeMultiplier, 2);
    assert.equal(result.creditedOvertimeMinutes, 0);
    assert.equal(result.balanceMinutes, 0);
});

test("continued shift starts counting from exactly 15 minutes", () => {
    const result = calculateBankHours({
        scheduledStartAt: iso("2026-03-25T19:00:00-03:00"),
        scheduledEndAt: iso("2026-03-26T07:00:00-03:00"),
        actualStartAt: iso("2026-03-25T19:15:00-03:00"),
        actualEndAt: iso("2026-03-26T07:15:00-03:00"),
    });

    assert.equal(result.arrivalDelayMinutes, 15);
    assert.equal(result.overtimeMinutes, 15);
    assert.equal(result.overtimeMultiplier, 1);
    assert.equal(result.creditedOvertimeMinutes, 15);
    assert.equal(result.balanceMinutes, 0);
});

test("continued shift loses the doubled bonus when arrival exceeds tolerance", () => {
    const result = calculateBankHours({
        scheduledStartAt: iso("2026-03-25T19:00:00-03:00"),
        scheduledEndAt: iso("2026-03-26T07:00:00-03:00"),
        actualStartAt: iso("2026-03-25T19:16:00-03:00"),
        actualEndAt: iso("2026-03-26T07:16:00-03:00"),
    });

    assert.equal(result.arrivalDelayMinutes, 16);
    assert.equal(result.overtimeMinutes, 16);
    assert.equal(result.overtimeMultiplier, 1);
    assert.equal(result.creditedOvertimeMinutes, 16);
    assert.equal(result.balanceMinutes, 0);
});

test("continued shift leaving early does not create benefit", () => {
    const result = calculateBankHours({
        scheduledStartAt: iso("2026-03-25T19:00:00-03:00"),
        scheduledEndAt: iso("2026-03-26T07:00:00-03:00"),
        actualStartAt: iso("2026-03-25T19:12:00-03:00"),
        actualEndAt: iso("2026-03-26T06:40:00-03:00"),
    });

    assert.equal(result.arrivalDelayMinutes, 0);
    assert.equal(result.overtimeMinutes, 0);
    assert.equal(result.creditedOvertimeMinutes, 0);
    assert.equal(result.balanceMinutes, 0);
});

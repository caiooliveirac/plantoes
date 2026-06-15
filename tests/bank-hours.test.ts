import assert from "node:assert/strict";
import test from "node:test";
import { applyAnomalyGuard, calculateBankHours } from "@/modules/bank-hours/calculator";
import { resolveBankHoursScheduledWindow } from "@/modules/bank-hours/window";

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

test("keeps late departure neutral at exactly 15 minutes", () => {
    const result = calculateBankHours({
        scheduledStartAt: iso("2026-03-25T07:00:00-03:00"),
        scheduledEndAt: iso("2026-03-25T19:00:00-03:00"),
        actualStartAt: iso("2026-03-25T07:00:00-03:00"),
        actualEndAt: iso("2026-03-25T19:15:00-03:00"),
    });

    assert.equal(result.arrivalDelayMinutes, 0);
    assert.equal(result.overtimeMinutes, 0);
    assert.equal(result.overtimeMultiplier, 2);
    assert.equal(result.creditedOvertimeMinutes, 0);
    assert.equal(result.balanceMinutes, 0);
});

test("keeps arrival delay neutral at exactly 15 minutes", () => {
    const result = calculateBankHours({
        scheduledStartAt: iso("2026-03-25T07:00:00-03:00"),
        scheduledEndAt: iso("2026-03-25T19:00:00-03:00"),
        actualStartAt: iso("2026-03-25T07:15:00-03:00"),
        actualEndAt: iso("2026-03-25T19:15:00-03:00"),
    });

    assert.equal(result.arrivalDelayMinutes, 0);
    assert.equal(result.overtimeMinutes, 0);
    assert.equal(result.overtimeMultiplier, 2);
    assert.equal(result.creditedOvertimeMinutes, 0);
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

test("continued shift keeps exactly 15 minutes neutral", () => {
    const result = calculateBankHours({
        scheduledStartAt: iso("2026-03-25T19:00:00-03:00"),
        scheduledEndAt: iso("2026-03-26T07:00:00-03:00"),
        actualStartAt: iso("2026-03-25T19:15:00-03:00"),
        actualEndAt: iso("2026-03-26T07:15:00-03:00"),
    });

    assert.equal(result.arrivalDelayMinutes, 0);
    assert.equal(result.overtimeMinutes, 0);
    assert.equal(result.overtimeMultiplier, 2);
    assert.equal(result.creditedOvertimeMinutes, 0);
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

test("regulation bank-hours window removes the duplicated 15-minute grace on exit", () => {
    const window = resolveBankHoursScheduledWindow({
        domain: "regulation",
        startedAt: iso("2026-04-09T19:02:20-03:00"),
        shiftLabel: "SN",
        scheduledStartAt: iso("2026-04-09T19:00:00-03:00"),
        scheduledEndAt: iso("2026-04-10T07:15:00-03:00"),
        postCode: "2031",
    });

    assert.equal(window.scheduledStartAt?.toISOString(), iso("2026-04-09T19:00:00-03:00"));
    assert.equal(window.scheduledEndAt?.toISOString(), iso("2026-04-10T07:00:00-03:00"));

    const result = calculateBankHours({
        scheduledStartAt: window.scheduledStartAt!,
        scheduledEndAt: window.scheduledEndAt!,
        actualStartAt: iso("2026-04-09T19:02:20-03:00"),
        actualEndAt: iso("2026-04-10T07:20:00-03:00"),
    });

    assert.equal(result.arrivalDelayMinutes, 0);
    assert.equal(result.overtimeMinutes, 20);
    assert.equal(result.creditedOvertimeMinutes, 40);
    assert.equal(result.balanceMinutes, 40);
});

test("regulation bank-hours window preserves explicit custom end times", () => {
    const window = resolveBankHoursScheduledWindow({
        domain: "regulation",
        startedAt: iso("2026-04-09T10:30:00-03:00"),
        shiftLabel: "SD",
        scheduledStartAt: iso("2026-04-09T10:30:00-03:00"),
        scheduledEndAt: iso("2026-04-09T17:00:00-03:00"),
        postCode: "2031",
    });

    assert.equal(window.scheduledEndAt?.toISOString(), iso("2026-04-09T17:00:00-03:00"));
});

test("regulation bank-hours window also normalizes explicit P ends at 07:15 or 19:15", () => {
    const window = resolveBankHoursScheduledWindow({
        domain: "regulation",
        startedAt: iso("2026-04-07T07:00:00-03:00"),
        shiftLabel: "P",
        scheduledStartAt: iso("2026-04-07T07:00:00-03:00"),
        scheduledEndAt: iso("2026-04-07T19:15:00-03:00"),
        postCode: "1368",
    });

    assert.equal(window.scheduledEndAt?.toISOString(), iso("2026-04-07T19:00:00-03:00"));
});

test("anomaly guard clamps excessive delay to zero balance", () => {
    // P shift misregistered as SN: scheduledStart 19:00 but arrived 07:00 next day = 720 min "delay"
    // Doctor left at 07:15 (within scheduled end), so no overtime to compensate
    const raw = calculateBankHours({
        scheduledStartAt: iso("2026-04-04T19:00:00-03:00"),
        scheduledEndAt: iso("2026-04-05T07:00:00-03:00"),
        actualStartAt: iso("2026-04-05T07:00:00-03:00"),
        actualEndAt: iso("2026-04-05T07:00:00-03:00"),
    });

    assert.equal(raw.arrivalDelayMinutes, 720);
    assert.equal(raw.balanceMinutes, -720);

    const guarded = applyAnomalyGuard(raw);
    assert.equal(guarded.balanceMinutes, 0);
    assert.equal(guarded.creditedOvertimeMinutes, 0);
    assert.equal(guarded.ruleCode, "ANOMALY_EXCESSIVE_DELAY");
    assert.ok(guarded.explanation.includes("ANOMALIA"));
});

test("anomaly guard clamps excessive overtime to zero balance", () => {
    // SD scheduled 07:00-19:15 but doctor stayed until 07:00 next day = ~720 min overtime
    const raw = calculateBankHours({
        scheduledStartAt: iso("2026-04-05T07:00:00-03:00"),
        scheduledEndAt: iso("2026-04-05T19:15:00-03:00"),
        actualStartAt: iso("2026-04-05T07:20:00-03:00"),
        actualEndAt: iso("2026-04-06T06:55:00-03:00"),
    });

    assert.equal(raw.overtimeMinutes > 360, true);

    const guarded = applyAnomalyGuard(raw);
    assert.equal(guarded.balanceMinutes, 0);
    assert.equal(guarded.creditedOvertimeMinutes, 0);
    assert.ok(guarded.ruleCode.startsWith("ANOMALY_"));
});

test("anomaly guard passes through normal calculations unchanged", () => {
    const raw = calculateBankHours({
        scheduledStartAt: iso("2026-04-05T07:00:00-03:00"),
        scheduledEndAt: iso("2026-04-05T19:00:00-03:00"),
        actualStartAt: iso("2026-04-05T07:12:00-03:00"),
        actualEndAt: iso("2026-04-05T19:30:00-03:00"),
    });

    const guarded = applyAnomalyGuard(raw);
    assert.deepEqual(guarded, raw);
});

test("anomaly guard passes through delay at exactly 360 minutes", () => {
    const raw = calculateBankHours({
        scheduledStartAt: iso("2026-04-05T07:00:00-03:00"),
        scheduledEndAt: iso("2026-04-05T19:00:00-03:00"),
        actualStartAt: iso("2026-04-05T13:00:00-03:00"),
        actualEndAt: iso("2026-04-05T19:00:00-03:00"),
    });

    assert.equal(raw.arrivalDelayMinutes, 360);
    const guarded = applyAnomalyGuard(raw);
    assert.deepEqual(guarded, raw);
});

// ================================================================
// LATE HALF-SHIFT RECOGNITION — SD intervention arrival after 9h gets
// converted to half-shift (paid 13–19), with the time worked before
// 13:00 credited to the bank as carryover. The caller passes the
// half-shift window as scheduledStartAt/scheduledEndAt.
// ================================================================

test("late half-shift: arrival 9h credits 4h carryover to bank", () => {
    const result = calculateBankHours({
        scheduledStartAt: iso("2026-05-26T13:00:00-03:00"),
        scheduledEndAt: iso("2026-05-26T19:00:00-03:00"),
        actualStartAt: iso("2026-05-26T09:00:00-03:00"),
        actualEndAt: iso("2026-05-26T19:00:00-03:00"),
        lateHalfShiftAcknowledged: true,
    });

    assert.equal(result.ruleCode, "LATE_HALF_SHIFT_CARRYOVER");
    assert.equal(result.arrivalDelayMinutes, 0);
    assert.equal(result.balanceMinutes, 240);
});

test("late half-shift: arrival 10h credits 3h carryover", () => {
    const result = calculateBankHours({
        scheduledStartAt: iso("2026-05-26T13:00:00-03:00"),
        scheduledEndAt: iso("2026-05-26T19:00:00-03:00"),
        actualStartAt: iso("2026-05-26T10:00:00-03:00"),
        actualEndAt: iso("2026-05-26T19:00:00-03:00"),
        lateHalfShiftAcknowledged: true,
    });
    assert.equal(result.balanceMinutes, 180);
});

test("late half-shift: arrival 11h credits 2h carryover", () => {
    const result = calculateBankHours({
        scheduledStartAt: iso("2026-05-26T13:00:00-03:00"),
        scheduledEndAt: iso("2026-05-26T19:00:00-03:00"),
        actualStartAt: iso("2026-05-26T11:00:00-03:00"),
        actualEndAt: iso("2026-05-26T19:00:00-03:00"),
        lateHalfShiftAcknowledged: true,
    });
    assert.equal(result.balanceMinutes, 120);
});

test("late half-shift: arrival 12h credits 1h carryover", () => {
    const result = calculateBankHours({
        scheduledStartAt: iso("2026-05-26T13:00:00-03:00"),
        scheduledEndAt: iso("2026-05-26T19:00:00-03:00"),
        actualStartAt: iso("2026-05-26T12:00:00-03:00"),
        actualEndAt: iso("2026-05-26T19:00:00-03:00"),
        lateHalfShiftAcknowledged: true,
    });
    assert.equal(result.balanceMinutes, 60);
});

test("late half-shift: arrival 13:11 (after half-shift start) has no carryover, delay tolerated", () => {
    const result = calculateBankHours({
        scheduledStartAt: iso("2026-05-26T13:00:00-03:00"),
        scheduledEndAt: iso("2026-05-26T19:00:00-03:00"),
        actualStartAt: iso("2026-05-26T13:11:00-03:00"),
        actualEndAt: iso("2026-05-26T19:00:00-03:00"),
        lateHalfShiftAcknowledged: true,
    });
    assert.equal(result.ruleCode, "LATE_HALF_SHIFT_CARRYOVER");
    assert.equal(result.arrivalDelayMinutes, 0); // 11 min within 15 min tolerance
    assert.equal(result.balanceMinutes, 0);
});

test("late half-shift: arrival 14h (1h after half-shift start) debits the delay", () => {
    const result = calculateBankHours({
        scheduledStartAt: iso("2026-05-26T13:00:00-03:00"),
        scheduledEndAt: iso("2026-05-26T19:00:00-03:00"),
        actualStartAt: iso("2026-05-26T14:00:00-03:00"),
        actualEndAt: iso("2026-05-26T19:00:00-03:00"),
        lateHalfShiftAcknowledged: true,
    });
    assert.equal(result.ruleCode, "LATE_HALF_SHIFT_CARRYOVER");
    assert.equal(result.arrivalDelayMinutes, 60);
    assert.equal(result.balanceMinutes, -60);
});

test("late half-shift: anomaly guard preserves LATE_HALF_SHIFT_CARRYOVER", () => {
    const raw = calculateBankHours({
        scheduledStartAt: iso("2026-05-26T13:00:00-03:00"),
        scheduledEndAt: iso("2026-05-26T19:00:00-03:00"),
        actualStartAt: iso("2026-05-26T09:00:00-03:00"),
        actualEndAt: iso("2026-05-26T19:00:00-03:00"),
        lateHalfShiftAcknowledged: true,
    });
    const guarded = applyAnomalyGuard(raw);
    assert.equal(guarded.ruleCode, "LATE_HALF_SHIFT_CARRYOVER");
    assert.equal(guarded.balanceMinutes, 240);
});

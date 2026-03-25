import assert from "node:assert/strict";
import test from "node:test";
import {
    buildMonthlyReportModel,
    detectMonthlyReportInconsistencies,
    formatMinutesForHumans,
    resolveMonthlyReportRange,
    resolveMonthlyReportPaymentStatus,
    type MonthlyReportAuditEntry,
    type RawMonthlyReportShift,
} from "@/modules/reporting/monthly-report";

function makeAuditEntry(overrides: Partial<MonthlyReportAuditEntry> = {}): MonthlyReportAuditEntry {
    return {
        id: "audit-1",
        action: "intervention_occupancy.corrected",
        actorEmail: "admin@samu.local",
        createdAt: "2026-03-10T19:10:00.000Z",
        details: { notes: "Ajuste após conferência" },
        ...overrides,
    };
}

function makeShift(overrides: Partial<RawMonthlyReportShift> = {}): RawMonthlyReportShift {
    return {
        occupancyId: "occ-1",
        domain: "intervention",
        doctorId: "doc-1",
        doctorName: "Caio Oliveira do Carmo",
        displayName: "Caio Oliveira",
        targetCode: "PP20",
        targetLabel: "PA Pituba",
        startedAt: "2026-03-10T07:00:00.000Z",
        boardStartedAt: "2026-03-10T07:00:00.000Z",
        endedAt: "2026-03-10T19:00:00.000Z",
        actualEndedAt: "2026-03-10T19:00:00.000Z",
        scheduledStartAt: "2026-03-10T07:00:00.000Z",
        scheduledEndAt: "2026-03-10T19:00:00.000Z",
        shiftLabel: "SD",
        source: "telegram",
        notes: null,
        createdAt: "2026-03-10T07:01:00.000Z",
        updatedAt: "2026-03-10T19:01:00.000Z",
        createdByEmail: null,
        updatedByEmail: null,
        arrivalDelayMinutes: 0,
        overtimeMinutes: 0,
        creditedOvertimeMinutes: 0,
        balanceMinutes: 0,
        ruleCode: "default",
        bankHoursExplanation: "ok",
        auditTrail: [],
        ...overrides,
    };
}

test("resolveMonthlyReportRange normalizes month keys and presets", () => {
    const result = resolveMonthlyReportRange("2026-03", new Date("2026-03-25T12:00:00.000Z"));

    assert.equal(result.monthKey, "2026-03");
    assert.equal(result.start.toISOString(), "2026-03-01T00:00:00.000Z");
    assert.equal(result.end.toISOString(), "2026-04-01T00:00:00.000Z");
    assert.equal(result.presetMonths[0]?.key, "2026-03");
});

test("detectMonthlyReportInconsistencies flags open, manual and missing bank hours issues", () => {
    const result = detectMonthlyReportInconsistencies(makeShift({
        endedAt: null,
        scheduledEndAt: null,
        source: "admin_correction",
        balanceMinutes: null,
    }));

    assert.equal(result.flags.hasOpenShift, true);
    assert.equal(result.flags.hasManualSource, true);
    assert.equal(result.flags.hasMissingSchedule, true);
    assert.ok(result.inconsistencies.some((item) => item.includes("saída")));
});

test("detectMonthlyReportInconsistencies flags correction history, delay and negative balance", () => {
    const result = detectMonthlyReportInconsistencies(makeShift({
        arrivalDelayMinutes: 25,
        balanceMinutes: -45,
        creditedOvertimeMinutes: 120,
        notes: null,
        auditTrail: [makeAuditEntry()],
    }));

    assert.equal(result.flags.hasLateArrival, true);
    assert.equal(result.flags.hasNegativeBalance, true);
    assert.equal(result.flags.hasCorrectionHistory, true);
    assert.equal(result.flags.hasOvertimeWithoutNote, true);
    assert.ok(result.inconsistencies.some((item) => item.includes("correção manual")));
});

test("buildMonthlyReportModel groups by doctor and prioritizes inconsistencies", () => {
    const model = buildMonthlyReportModel([
        makeShift({ occupancyId: "1", doctorId: "doc-1", doctorName: "Caio Oliveira" }),
        makeShift({
            occupancyId: "2",
            doctorId: "doc-2",
            doctorName: "Dora Silva",
            source: "manual",
            balanceMinutes: null,
        }),
    ], "2026-03", new Date("2026-03-25T12:00:00.000Z"));

    assert.equal(model.summary.shiftCount, 2);
    assert.equal(model.summary.doctorCount, 2);
    assert.equal(model.summary.doctorsWithPendenciesCount, 1);
    assert.equal(model.summary.readyForPaymentCount, 1);
    assert.equal(model.summary.needsReviewCount, 1);
    assert.equal(model.groups[0]?.doctorName, "Dora Silva");
    assert.equal(model.groups[0]?.paymentStatus, "needs_review");
    assert.equal(model.groups[0]?.inconsistentShiftCount, 1);
});

test("resolveMonthlyReportPaymentStatus separates ready rows from review rows", () => {
    assert.equal(resolveMonthlyReportPaymentStatus([]), "ready_for_payment");
    assert.equal(resolveMonthlyReportPaymentStatus(["Plantão sem saída registrada"]), "needs_review");
});

test("formatMinutesForHumans formats hours and minutes cleanly", () => {
    assert.equal(formatMinutesForHumans(125), "2 h 05");
    assert.equal(formatMinutesForHumans(-30), "-30 min");
});
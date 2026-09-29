import assert from "node:assert/strict";
import test from "node:test";
import { formatMinutesForHumans, resolveMonthlyReportRange } from "@/modules/reporting/monthly-report";

test("resolveMonthlyReportRange normalizes month keys and presets", () => {
    const result = resolveMonthlyReportRange("2026-03", new Date("2026-03-25T12:00:00.000Z"));

    assert.equal(result.monthKey, "2026-03");
    assert.equal(result.start.toISOString(), "2026-03-01T10:00:00.000Z");
    assert.equal(result.end.toISOString(), "2026-04-01T10:00:00.000Z");
    assert.equal(result.presetMonths[0]?.key, "2026-03");
});

test("resolveMonthlyReportRange lists every month back to abril/2026 and keeps the selected one", () => {
    const september = resolveMonthlyReportRange(null, new Date("2026-09-02T12:00:00.000Z"));
    assert.deepEqual(
        september.presetMonths.map((preset) => preset.key),
        ["2026-09", "2026-08", "2026-07", "2026-06", "2026-05", "2026-04"],
    );

    const older = resolveMonthlyReportRange("2026-02", new Date("2026-09-02T12:00:00.000Z"));
    assert.equal(older.presetMonths.at(-1)?.key, "2026-02");
});

test("resolveMonthlyReportRange includes the last night shift of the month", () => {
    const result = resolveMonthlyReportRange("2026-03", new Date("2026-04-01T02:30:00.000Z"));

    assert.equal(result.monthKey, "2026-03");
    assert.equal(result.start.toISOString(), "2026-03-01T10:00:00.000Z");
    assert.equal(result.end.toISOString(), "2026-04-01T10:00:00.000Z");
});

test("formatMinutesForHumans formats hours and minutes cleanly", () => {
    assert.equal(formatMinutesForHumans(125), "2 h 05");
    assert.equal(formatMinutesForHumans(-30), "-30 min");
});

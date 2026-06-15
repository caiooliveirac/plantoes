import assert from "node:assert/strict";
import test from "node:test";
import { resolveHistoricalAdminCorrectionEndAt } from "@/modules/regulation/service";
import { resolveHistoricalInterventionAdminCorrectionEndAt } from "@/modules/intervention/service";

test("resolveHistoricalAdminCorrectionEndAt returns scheduled end for past admin correction", () => {
    const startedAt = new Date("2026-04-08T10:00:00.000Z");
    const inferredScheduledEndAt = new Date("2026-04-08T22:00:00.000Z");
    const now = new Date("2026-04-16T12:00:00.000Z");

    const result = resolveHistoricalAdminCorrectionEndAt({
        source: "admin_correction",
        startedAt,
        inferredScheduledEndAt,
        now,
    });

    assert.equal(result?.toISOString(), inferredScheduledEndAt.toISOString());
});

test("resolveHistoricalAdminCorrectionEndAt does not close current/future correction", () => {
    const startedAt = new Date("2026-04-16T10:00:00.000Z");
    const inferredScheduledEndAt = new Date("2026-04-16T22:00:00.000Z");
    const now = new Date("2026-04-16T12:00:00.000Z");

    const result = resolveHistoricalAdminCorrectionEndAt({
        source: "admin_correction",
        startedAt,
        inferredScheduledEndAt,
        now,
    });

    assert.equal(result, null);
});

test("resolveHistoricalInterventionAdminCorrectionEndAt mirrors past-close behavior", () => {
    const startedAt = new Date("2026-04-08T10:00:00.000Z");
    const inferredScheduledEndAt = new Date("2026-04-08T22:00:00.000Z");
    const now = new Date("2026-04-16T12:00:00.000Z");

    const result = resolveHistoricalInterventionAdminCorrectionEndAt({
        source: "admin_correction",
        startedAt,
        inferredScheduledEndAt,
        now,
    });

    assert.equal(result?.toISOString(), inferredScheduledEndAt.toISOString());
});

test("resolveHistoricalInterventionAdminCorrectionEndAt keeps non-admin sources unchanged", () => {
    const startedAt = new Date("2026-04-08T10:00:00.000Z");
    const inferredScheduledEndAt = new Date("2026-04-08T22:00:00.000Z");
    const now = new Date("2026-04-16T12:00:00.000Z");

    const result = resolveHistoricalInterventionAdminCorrectionEndAt({
        source: "manual",
        startedAt,
        inferredScheduledEndAt,
        now,
    });

    assert.equal(result, null);
});

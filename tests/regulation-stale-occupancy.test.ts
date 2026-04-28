import assert from "node:assert/strict";
import test from "node:test";
import { shouldReopenStaleSameDoctorRegulationOccupancy } from "@/modules/regulation/service";

test("shouldReopenStaleSameDoctorRegulationOccupancy returns true for stale multi-day re-arrival", () => {
    const result = shouldReopenStaleSameDoctorRegulationOccupancy({
        existingStartedAt: new Date("2026-04-08T07:03:52-03:00"),
        existingBoardStartedAt: new Date("2026-04-08T07:03:52-03:00"),
        incomingStartedAt: new Date("2026-04-15T07:06:00-03:00"),
    });

    assert.equal(result, true);
});

test("shouldReopenStaleSameDoctorRegulationOccupancy returns false for same-shift correction", () => {
    const result = shouldReopenStaleSameDoctorRegulationOccupancy({
        existingStartedAt: new Date("2026-04-15T07:00:00-03:00"),
        existingBoardStartedAt: new Date("2026-04-15T07:00:00-03:00"),
        incomingStartedAt: new Date("2026-04-15T07:12:00-03:00"),
    });

    assert.equal(result, false);
});

test("shouldReopenStaleSameDoctorRegulationOccupancy returns false when incoming time is earlier", () => {
    const result = shouldReopenStaleSameDoctorRegulationOccupancy({
        existingStartedAt: new Date("2026-04-15T07:10:00-03:00"),
        existingBoardStartedAt: new Date("2026-04-15T07:10:00-03:00"),
        incomingStartedAt: new Date("2026-04-15T07:05:00-03:00"),
    });

    assert.equal(result, false);
});

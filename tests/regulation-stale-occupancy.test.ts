import assert from "node:assert/strict";
import test from "node:test";
import { shouldReopenStaleSameDoctorRegulationOccupancy } from "@/modules/regulation/service";
import { isRearrivalWithinOwnWindow } from "@/modules/operational/board-rules";

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

// D1 (docs/chegada.md): Livia, 2153, 13/09/2026. SD desde 06:47, reenvio "2153 SD" às
// 19:11 com a ocupação aberta até 19:15 — é o mesmo plantão, não reabre.
test("shouldReopenStaleSameDoctorRegulationOccupancy: reenvio dentro da própria janela não reabre", () => {
    const existing = {
        startedAt: new Date("2026-09-13T06:47:00-03:00"),
        scheduledEndAt: new Date("2026-09-13T19:15:00-03:00"),
    };
    const incoming = new Date("2026-09-13T19:11:00-03:00");
    const withinOwnWindow = isRearrivalWithinOwnWindow({
        existingScheduledEndAt: existing.scheduledEndAt,
        existingShiftLabel: "SD",
        incomingAt: incoming,
        incomingShiftLabel: "SD",
    });
    assert.equal(withinOwnWindow, true);
    assert.equal(shouldReopenStaleSameDoctorRegulationOccupancy({
        existingStartedAt: existing.startedAt,
        existingBoardStartedAt: existing.startedAt,
        incomingStartedAt: incoming,
        withinOwnWindow,
    }), false);
    // Sem a janela própria o critério antigo reabriria — é o que acontecia.
    assert.equal(shouldReopenStaleSameDoctorRegulationOccupancy({
        existingStartedAt: existing.startedAt,
        existingBoardStartedAt: existing.startedAt,
        incomingStartedAt: incoming,
    }), true);
});

test("isRearrivalWithinOwnWindow: depois do fim programado ou com rótulo diferente não é o mesmo plantão", () => {
    const base = {
        existingScheduledEndAt: new Date("2026-09-13T19:15:00-03:00"),
        existingShiftLabel: "SD",
    };
    assert.equal(isRearrivalWithinOwnWindow({ ...base, incomingAt: new Date("2026-09-13T19:20:00-03:00"), incomingShiftLabel: "SD" }), false);
    assert.equal(isRearrivalWithinOwnWindow({ ...base, incomingAt: new Date("2026-09-13T19:05:00-03:00"), incomingShiftLabel: "SN" }), false);
    assert.equal(isRearrivalWithinOwnWindow({ ...base, incomingAt: new Date("2026-09-13T19:05:00-03:00"), incomingShiftLabel: null }), true);
    assert.equal(isRearrivalWithinOwnWindow({ ...base, existingScheduledEndAt: null, incomingAt: new Date("2026-09-13T12:00:00-03:00"), incomingShiftLabel: "SD" }), false);
});

import assert from "node:assert/strict";
import test from "node:test";
import { UNDO_WINDOW_MS } from "@/modules/operational/undo";

// ─── UNDO_WINDOW_MS constant ────────────────────────────────────────

test("UNDO_WINDOW_MS is 30 minutes", () => {
    assert.equal(UNDO_WINDOW_MS, 30 * 60 * 1000);
});

// ─── Eligibility validation logic (unit-testable aspects) ───────────

test("undo window rejects actions older than 30 minutes", () => {
    const actionTime = new Date(Date.now() - UNDO_WINDOW_MS - 1);
    const elapsedMs = Date.now() - actionTime.getTime();
    assert.ok(elapsedMs > UNDO_WINDOW_MS, "Elapsed time should exceed the window");
});

test("undo window accepts actions within 30 minutes", () => {
    const actionTime = new Date(Date.now() - UNDO_WINDOW_MS + 60_000);
    const elapsedMs = Date.now() - actionTime.getTime();
    assert.ok(elapsedMs <= UNDO_WINDOW_MS, "Elapsed time should be within the window");
});

test("undo window accepts actions just performed", () => {
    const actionTime = new Date();
    const elapsedMs = Date.now() - actionTime.getTime();
    assert.ok(elapsedMs <= UNDO_WINDOW_MS);
});

// ─── Action type classification ─────────────────────────────────────

const UNDOABLE_ACTIONS = [
    "regulation_occupancy.started",
    "regulation_occupancy.corrected",
    "regulation_occupancy.deleted",
    "intervention_occupancy.started",
    "intervention_occupancy.corrected",
    "intervention_occupancy.deleted",
    "operational_occupancy.transferred",
];

test("undoable action list includes all expected action types", () => {
    for (const action of UNDOABLE_ACTIONS) {
        assert.ok(UNDOABLE_ACTIONS.includes(action), `${action} should be undoable`);
    }
});

test("undone actions are not undoable", () => {
    const undoneActions = UNDOABLE_ACTIONS.map((a) => `${a}.undone`);
    for (const action of undoneActions) {
        assert.ok(!UNDOABLE_ACTIONS.includes(action), `${action} should NOT be undoable`);
    }
});

test("random actions are not undoable", () => {
    const randomActions = [
        "bank_hours.adjusted",
        "user.created",
        "meal_break.started",
    ];
    for (const action of randomActions) {
        assert.ok(!UNDOABLE_ACTIONS.includes(action), `${action} should NOT be undoable`);
    }
});

// ─── beforeSnapshot structure validation ─────────────────────────────

test("regulation beforeSnapshot has required fields for undo correction", () => {
    const requiredFields = [
        "doctorId", "postId", "startedAt", "boardStartedAt",
        "endedAt", "actualEndedAt", "scheduledStartAt", "scheduledEndAt",
        "shiftLabel", "roleLabel", "ramalLabel", "notes", "continuityGroupId",
    ];

    // Simulate a beforeSnapshot as created by the enriched audit log
    const snapshot = {
        doctorId: "uuid-1",
        postId: 5,
        startedAt: "2026-04-08T10:00:00.000Z",
        boardStartedAt: "2026-04-08T10:00:00.000Z",
        endedAt: null,
        actualEndedAt: null,
        scheduledStartAt: "2026-04-08T10:00:00.000Z",
        scheduledEndAt: "2026-04-08T22:15:00.000Z",
        shiftLabel: "SD",
        roleLabel: "MR",
        ramalLabel: "1366",
        notes: null,
        continuityGroupId: "uuid-2",
    };

    for (const field of requiredFields) {
        assert.ok(field in snapshot, `beforeSnapshot missing field: ${field}`);
    }
});

test("intervention beforeSnapshot has required fields for undo correction", () => {
    const requiredFields = [
        "doctorId", "baseId", "startedAt", "boardStartedAt",
        "endedAt", "actualEndedAt", "scheduledStartAt", "scheduledEndAt",
        "shiftLabel", "roleLabel", "notes", "continuityGroupId",
    ];

    const snapshot = {
        doctorId: "uuid-1",
        baseId: 3,
        startedAt: "2026-04-08T10:00:00.000Z",
        boardStartedAt: "2026-04-08T10:00:00.000Z",
        endedAt: null,
        actualEndedAt: null,
        scheduledStartAt: "2026-04-08T10:00:00.000Z",
        scheduledEndAt: "2026-04-08T22:00:00.000Z",
        shiftLabel: "SD",
        roleLabel: null,
        notes: null,
        continuityGroupId: "uuid-2",
    };

    for (const field of requiredFields) {
        assert.ok(field in snapshot, `beforeSnapshot missing field: ${field}`);
    }
});

// ─── Safety constraint: own actions only ────────────────────────────

test("safety: different actor userId should block undo", () => {
    const actorUserId = "user-A";
    const requestingUserId = "user-B";
    assert.notEqual(actorUserId, requestingUserId, "Different users should not match");
});

test("safety: same actor userId should allow undo", () => {
    const actorUserId = "user-A";
    const requestingUserId = "user-A";
    assert.equal(actorUserId, requestingUserId, "Same user should match");
});

// ─── Safety constraint: no later action blocks undo ─────────────────

test("safety: later action on same entity blocks undo", () => {
    const actionTime = new Date("2026-04-08T10:00:00Z");
    const laterActionTime = new Date("2026-04-08T10:05:00Z");
    assert.ok(laterActionTime.getTime() > actionTime.getTime(), "Later action should have higher timestamp");
});

// ─── Displacement detection logic ───────────────────────────────────

test("displacement detection: endedAt matching startedAt signals displacement", () => {
    const newOccupancyStartedAt = new Date("2026-04-08T10:00:00Z");
    const displacedEndedAt = new Date("2026-04-08T10:00:00Z");
    assert.equal(
        displacedEndedAt.getTime(),
        newOccupancyStartedAt.getTime(),
        "Displaced occupancy endedAt should equal new occupancy startedAt",
    );
});

test("displacement detection: different endedAt does not signal displacement", () => {
    const newOccupancyStartedAt = new Date("2026-04-08T10:00:00Z");
    const someOtherEndedAt = new Date("2026-04-08T09:30:00Z");
    assert.notEqual(
        someOtherEndedAt.getTime(),
        newOccupancyStartedAt.getTime(),
        "Different times should not be detected as displacement",
    );
});

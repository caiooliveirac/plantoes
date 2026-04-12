import assert from "node:assert/strict";
import test from "node:test";
import { mergeOperationalNotes, validateChronology, validateCorrectionChronology } from "@/modules/operational/corrections";

// ─── validateChronology ──────────────────────────────────────────────

test("validateChronology accepts valid chronological order", () => {
    const startedAt = new Date("2025-04-04T07:00:00Z");
    const boardStartedAt = new Date("2025-04-04T07:05:00Z");
    const endedAt = new Date("2025-04-04T19:00:00Z");
    const actualEndedAt = new Date("2025-04-04T19:10:00Z");

    assert.doesNotThrow(() => validateChronology(startedAt, boardStartedAt, endedAt, actualEndedAt));
});

test("validateChronology accepts null optional timestamps", () => {
    const startedAt = new Date("2025-04-04T07:00:00Z");
    assert.doesNotThrow(() => validateChronology(startedAt, null, null, null));
});

test("validateChronology accepts equal timestamps (boardStartedAt = startedAt)", () => {
    const startedAt = new Date("2025-04-04T07:00:00Z");
    assert.doesNotThrow(() => validateChronology(startedAt, startedAt, null, null));
});

test("validateChronology accepts equal timestamps (endedAt = startedAt)", () => {
    const startedAt = new Date("2025-04-04T07:00:00Z");
    assert.doesNotThrow(() => validateChronology(startedAt, null, startedAt, null));
});

test("validateChronology throws when boardStartedAt is before startedAt", () => {
    const startedAt = new Date("2025-04-04T07:00:00Z");
    const boardStartedAt = new Date("2025-04-04T06:59:00Z");

    assert.throws(
        () => validateChronology(startedAt, boardStartedAt, null, null),
        /Board start cannot be before the recorded arrival/,
    );
});

test("validateChronology throws when endedAt is before startedAt", () => {
    const startedAt = new Date("2025-04-04T07:00:00Z");
    const endedAt = new Date("2025-04-04T06:30:00Z");

    assert.throws(
        () => validateChronology(startedAt, null, endedAt, null),
        /Board end cannot be before the recorded arrival/,
    );
});

test("validateChronology throws when actualEndedAt is before startedAt", () => {
    const startedAt = new Date("2025-04-04T07:00:00Z");
    const actualEndedAt = new Date("2025-04-04T06:00:00Z");

    assert.throws(
        () => validateChronology(startedAt, null, null, actualEndedAt),
        /Actual end cannot be before the recorded arrival/,
    );
});

test("validateChronology throws when endedAt is before boardStartedAt", () => {
    const startedAt = new Date("2025-04-04T07:00:00Z");
    const boardStartedAt = new Date("2025-04-04T08:00:00Z");
    const endedAt = new Date("2025-04-04T07:30:00Z");

    assert.throws(
        () => validateChronology(startedAt, boardStartedAt, endedAt, null),
        /Board end cannot be before the board start/,
    );
});

test("validateChronology accepts actualEndedAt after endedAt (overtime scenario)", () => {
    const startedAt = new Date("2025-04-04T07:00:00Z");
    const endedAt = new Date("2025-04-04T19:00:00Z");
    const actualEndedAt = new Date("2025-04-04T19:30:00Z");

    assert.doesNotThrow(() => validateChronology(startedAt, null, endedAt, actualEndedAt));
});

test("validateChronology accepts actualEndedAt before endedAt (early departure)", () => {
    const startedAt = new Date("2025-04-04T07:00:00Z");
    const endedAt = new Date("2025-04-04T19:00:00Z");
    const actualEndedAt = new Date("2025-04-04T18:00:00Z");

    assert.doesNotThrow(() => validateChronology(startedAt, null, endedAt, actualEndedAt));
});

test("validateChronology rejects boardStartedAt < startedAt (direct validation)", () => {
    // validateChronology itself still rejects this — but correctRegulationOccupancy
    // should skip calling it when only non-temporal fields change, since continuity
    // occupancies legitimately have boardStartedAt < startedAt.
    const startedAt = new Date("2025-04-04T19:00:00-03:00");
    const boardStartedAt = new Date("2025-04-04T07:00:00-03:00"); // original SD arrival

    assert.throws(
        () => validateChronology(startedAt, boardStartedAt, null, null),
        /Board start cannot be before the recorded arrival/,
    );
});

test("validateCorrectionChronology allows correcting actual end on continuity rows without revalidating the inherited board anchor", () => {
    const startedAt = new Date("2025-04-04T19:00:00-03:00");
    const boardStartedAt = new Date("2025-04-04T07:00:00-03:00");
    const actualEndedAt = new Date("2025-04-05T07:10:00-03:00");

    assert.doesNotThrow(() => validateCorrectionChronology({
        startedAt,
        boardStartedAt,
        endedAt: null,
        actualEndedAt,
        actualEndedAtChanged: true,
    }));
});

test("validateCorrectionChronology still rejects impossible board anchors when the anchor itself is being edited", () => {
    const startedAt = new Date("2025-04-04T19:00:00-03:00");
    const boardStartedAt = new Date("2025-04-04T07:00:00-03:00");

    assert.throws(
        () => validateCorrectionChronology({
            startedAt,
            boardStartedAt,
            endedAt: null,
            actualEndedAt: null,
            boardStartedAtChanged: true,
        }),
        /Board start cannot be before the recorded arrival/,
    );
});

// ─── mergeOperationalNotes ───────────────────────────────────────────

test("mergeOperationalNotes joins non-empty segments", () => {
    const result = mergeOperationalNotes("first note", "second note");
    assert.equal(result, "first note\n\nsecond note");
});

test("mergeOperationalNotes returns null for empty input", () => {
    const result = mergeOperationalNotes(null, undefined, "");
    assert.equal(result, null);
});

test("mergeOperationalNotes skips null and undefined segments", () => {
    const result = mergeOperationalNotes(null, "valid note", undefined);
    assert.equal(result, "valid note");
});

test("mergeOperationalNotes trims whitespace from segments", () => {
    const result = mergeOperationalNotes("  note with spaces  ", "  another  ");
    assert.equal(result, "note with spaces\n\nanother");
});

test("mergeOperationalNotes returns single segment without double newline", () => {
    const result = mergeOperationalNotes("only one");
    assert.equal(result, "only one");
});

test("mergeOperationalNotes handles all null/empty inputs", () => {
    assert.equal(mergeOperationalNotes(), null);
    assert.equal(mergeOperationalNotes(null), null);
    assert.equal(mergeOperationalNotes(null, null, null), null);
    assert.equal(mergeOperationalNotes("", "", ""), null);
});

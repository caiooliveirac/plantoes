import assert from "node:assert/strict";
import test from "node:test";
import { resolveEntryDeparture } from "@/lib/board/entry-departure";

// These tests guard the contract that the "plantão anterior" panel always shows
// the correct departure time and visually distinguishes handoff closures from
// verbalized departures.

function makeEntry(actualEndedAt: string | null, endedAt: string | null) {
    return { actualEndedAt, endedAt };
}

test("verbalized departure: actual_ended_at is used and not flagged as handoff-only", () => {
    const result = resolveEntryDeparture(makeEntry("2026-06-12T11:21:00.000Z", "2026-06-12T10:08:00.000Z"));
    assert.equal(result.time, "2026-06-12T11:21:00.000Z");
    assert.equal(result.isHandoffOnly, false);
});

test("handoff-only departure: actual_ended_at is null, ended_at used as fallback and flagged", () => {
    const result = resolveEntryDeparture(makeEntry(null, "2026-06-12T10:08:00.000Z"));
    assert.equal(result.time, "2026-06-12T10:08:00.000Z");
    assert.equal(result.isHandoffOnly, true);
});

test("open occupancy: both null — no departure time, not handoff-only", () => {
    const result = resolveEntryDeparture(makeEntry(null, null));
    assert.equal(result.time, null);
    assert.equal(result.isHandoffOnly, false);
});

test("actual_ended_at identical to ended_at: still verbalized, not handoff-only", () => {
    const ts = "2026-06-12T10:08:00.000Z";
    const result = resolveEntryDeparture(makeEntry(ts, ts));
    assert.equal(result.time, ts);
    assert.equal(result.isHandoffOnly, false);
});

test("actual_ended_at later than ended_at (late departure): verbalized time wins", () => {
    const result = resolveEntryDeparture(makeEntry("2026-06-12T11:21:00.000Z", "2026-06-12T07:08:00.000Z"));
    assert.equal(result.time, "2026-06-12T11:21:00.000Z");
    assert.equal(result.isHandoffOnly, false);
});

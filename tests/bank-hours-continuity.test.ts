import assert from "node:assert/strict";
import test from "node:test";
import { buildContinuityBankHoursSpan, buildContinuityCarrierLookup } from "@/modules/bank-hours/continuity";

test("buildContinuityBankHoursSpan preserves first arrival and final exit across a domain switch", () => {
    const span = buildContinuityBankHoursSpan([
        {
            occupancyId: "occ-1",
            domain: "intervention",
            doctorId: "doc-1",
            continuityGroupId: "cg-1",
            startedAt: new Date("2026-03-25T07:12:00-03:00"),
            endedAt: new Date("2026-03-25T19:00:00-03:00"),
            actualEndedAt: new Date("2026-03-25T19:00:00-03:00"),
            scheduledStartAt: null,
            scheduledEndAt: null,
            shiftLabel: "SD",
        },
        {
            occupancyId: "occ-2",
            domain: "regulation",
            doctorId: "doc-1",
            continuityGroupId: "cg-1",
            startedAt: new Date("2026-03-25T19:00:00-03:00"),
            endedAt: new Date("2026-03-26T07:20:00-03:00"),
            actualEndedAt: new Date("2026-03-26T07:20:00-03:00"),
            scheduledStartAt: null,
            scheduledEndAt: null,
            shiftLabel: "SN",
        },
    ]);

    assert.equal(span.carrierOccupancyId, "occ-1");
    assert.equal(span.actualStartAt.toISOString(), new Date("2026-03-25T07:12:00-03:00").toISOString());
    assert.equal(span.actualEndAt?.toISOString(), new Date("2026-03-26T07:20:00-03:00").toISOString());
    assert.equal(span.scheduledStartAt?.toISOString(), new Date("2026-03-25T07:00:00-03:00").toISOString());
    assert.equal(span.scheduledEndAt?.toISOString(), new Date("2026-03-26T07:15:00-03:00").toISOString());
});

test("buildContinuityCarrierLookup points every member to the first operational record in the chain", () => {
    const lookup = buildContinuityCarrierLookup([
        {
            occupancyId: "occ-1",
            doctorId: "doc-1",
            continuityGroupId: "cg-1",
            startedAt: "2026-03-25T10:00:00.000Z",
            endedAt: "2026-03-25T22:00:00.000Z",
            actualEndedAt: "2026-03-25T22:00:00.000Z",
        },
        {
            occupancyId: "occ-2",
            doctorId: "doc-1",
            continuityGroupId: "cg-1",
            startedAt: "2026-03-25T22:00:00.000Z",
            endedAt: "2026-03-26T10:00:00.000Z",
            actualEndedAt: "2026-03-26T10:00:00.000Z",
        },
    ]);

    assert.deepEqual(lookup.get("occ-1"), {
        carrierOccupancyId: "occ-1",
        continuityGroupId: "cg-1",
        memberCount: 2,
    });
    assert.deepEqual(lookup.get("occ-2"), {
        carrierOccupancyId: "occ-1",
        continuityGroupId: "cg-1",
        memberCount: 2,
    });
});
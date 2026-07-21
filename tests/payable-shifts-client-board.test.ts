import test from "node:test";
import assert from "node:assert/strict";
import {
    toChiefPayableClientBoard,
    type AttestationSegment,
    type ChiefPayableBoardModel,
    type PayableShift,
} from "@/modules/reporting/payable-shifts";

function buildShift(overrides: Partial<PayableShift>): PayableShift {
    return {
        payableShiftId: "ps-1",
        occupancyId: "occ-1",
        domain: "regulation",
        doctorId: "doc-1",
        doctorName: "Ana",
        displayName: null,
        targetCode: "1361",
        targetLabel: "Ramal 1361",
        tagCode: "1361",
        operationalDate: "2026-06-10",
        shiftLabel: "SD",
        slotStartedAt: "2026-06-10T10:00:00.000Z",
        slotEndedAt: "2026-06-10T22:00:00.000Z",
        startedAt: "2026-06-10T10:00:00.000Z",
        endedAt: null,
        durationMinutes: null,
        paymentStatus: "ready_for_payment",
        auditStatus: "clean",
        issues: [],
        source: "telegram",
        roleLabel: null,
        paymentUnit: 1,
        paymentTag: null,
        ...overrides,
    };
}

function buildSegment(overrides: Partial<AttestationSegment>): AttestationSegment {
    return {
        segmentId: "seg-1",
        occupancyId: "occ-1",
        domain: "regulation",
        doctorId: "doc-1",
        doctorName: "Ana",
        displayName: null,
        targetCode: "1361",
        targetLabel: "Ramal 1361",
        shiftLabel: "SD",
        startedAt: "2026-06-10T10:00:00.000Z",
        endedAt: null,
        durationMinutes: null,
        source: "telegram",
        continuityGroupId: null,
        status: "consolidated",
        discardReason: null,
        selectedForPayment: true,
        ...overrides,
    };
}

function buildBoard(overrides: Partial<ChiefPayableBoardModel>): ChiefPayableBoardModel {
    return {
        monthKey: "2026-06",
        monthLabel: "Junho de 2026",
        presetMonths: [],
        range: { startIso: "2026-06-01T03:00:00.000Z", endIso: "2026-07-01T03:00:00.000Z" },
        days: ["10"],
        summary: {
            doctorCount: 0,
            payableShiftCount: 0,
            payableUnitCount: 0,
            totalDueAmount: 0,
            readyCount: 0,
            needsReviewCount: 0,
            segmentCount: 0,
            discardedSegmentCount: 0,
            disabledTargetCount: 0,
            uncoveredTargetCount: 0,
            byEmploymentType: {
                pj: { doctorCount: 0, payableShiftCount: 0, payableUnitCount: 0, totalDueAmount: 0 },
                estatutario: { doctorCount: 0, payableShiftCount: 0, payableUnitCount: 0, totalDueAmount: 0 },
            },
        },
        targetOptions: [],
        doctors: [],
        payableShifts: [],
        disabledTargets: [],
        uncoveredTargets: [],
        attestationSegments: [],
        allDoctorNames: [],
        ...overrides,
    };
}

test("toChiefPayableClientBoard remove a lista plana duplicada e os segments completos", () => {
    const board = buildBoard({
        payableShifts: [buildShift({})],
        attestationSegments: [buildSegment({})],
    });

    const clientBoard = toChiefPayableClientBoard(board);

    assert.equal("payableShifts" in clientBoard, false);
    assert.equal("attestationSegments" in clientBoard, false);
    assert.deepEqual(clientBoard.days, ["10"]);
    assert.equal(clientBoard.monthKey, "2026-06");
});

test("toChiefPayableClientBoard mantém apenas segments descartados por not_selected_for_payment, compactados", () => {
    const kept = buildSegment({
        segmentId: "seg-displaced",
        doctorId: "doc-2",
        status: "discarded",
        discardReason: "not_selected_for_payment",
        selectedForPayment: false,
    });
    const board = buildBoard({
        attestationSegments: [
            buildSegment({ segmentId: "seg-consolidated" }),
            buildSegment({ segmentId: "seg-other-discard", status: "discarded", discardReason: "duplicate_segment", selectedForPayment: false }),
            kept,
        ],
    });

    const clientBoard = toChiefPayableClientBoard(board);

    assert.equal(clientBoard.displacedCandidateSegments.length, 1);
    assert.deepEqual(clientBoard.displacedCandidateSegments[0], {
        segmentId: "seg-displaced",
        doctorId: "doc-2",
        domain: "regulation",
        targetCode: "1361",
        targetLabel: "Ramal 1361",
        startedAt: "2026-06-10T10:00:00.000Z",
        shiftLabel: "SD",
    });
});

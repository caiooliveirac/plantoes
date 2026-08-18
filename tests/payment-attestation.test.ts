import assert from "node:assert/strict";
import test from "node:test";
import type { PaymentAllocationBoard } from "@/services/board.service";
import { buildPaymentAttestationPreview } from "@/services/payment-attestation.service";

function makeBoard(): PaymentAllocationBoard {
    return {
        generatedAt: "2026-03-29T00:05:00.000Z",
        operationalDate: "2026-03-28T12:00:00.000Z",
        shiftLabel: "SN",
        startedAt: "2026-03-28T22:00:00.000Z",
        endedAt: "2026-03-29T10:00:00.000Z",
        summary: {
            totalTargets: 3,
            assignedCount: 2,
            readyForPaymentCount: 1,
            needsReviewCount: 2,
            unassignedCount: 1,
            disabledCount: 1,
        },
        regulation: [
            {
                domain: "regulation",
                targetCode: "2031",
                targetLabel: "2031",
                sortOrder: 31,
                defaultRole: "MR",
                occupancyId: "reg-1",
                doctorId: "doc-1",
                doctorName: "Bruno Lima",
                displayName: "Bruno",
                startedAt: "2026-03-28T22:00:00.000Z",
                endedAt: "2026-03-29T10:15:00.000Z",
                actualEndedAt: "2026-03-29T10:15:00.000Z",
                scheduledStartAt: "2026-03-28T22:00:00.000Z",
                scheduledEndAt: "2026-03-29T10:15:00.000Z",
                shiftLabel: "SN",
                roleLabel: "MR",
                ramalLabel: "2031",
                earlyDepartureOutcome: null,
                candidateLabels: [],
                conflictCandidateLabels: [],
                hasDoctorOverlapConflict: false,
                source: "telegram",
                candidateCount: 1,
                paymentStatus: "ready_for_payment",
                issues: [],
                arrivalDelayMinutes: 0,
                overtimeMinutes: 0,
                creditedOvertimeMinutes: 0,
                balanceMinutes: 0,
                ruleCode: "ON_TIME_NO_OVERTIME",
                bankHoursExplanation: "ok",
            },
        ],
        intervention: [
            {
                domain: "intervention",
                targetCode: "PM04",
                targetLabel: "PM04",
                sortOrder: 4,
                defaultRole: null,
                occupancyId: "int-1",
                doctorId: "doc-2",
                doctorName: "Ana Souza",
                displayName: "Ana",
                startedAt: "2026-03-28T22:05:00.000Z",
                endedAt: null,
                actualEndedAt: null,
                scheduledStartAt: "2026-03-28T22:00:00.000Z",
                scheduledEndAt: "2026-03-29T10:00:00.000Z",
                shiftLabel: "SN",
                roleLabel: null,
                ramalLabel: null,
                earlyDepartureOutcome: null,
                candidateLabels: [],
                conflictCandidateLabels: [],
                hasDoctorOverlapConflict: false,
                source: "telegram",
                candidateCount: 1,
                paymentStatus: "needs_review",
                issues: ["Plantao sem saida consolidada"],
                arrivalDelayMinutes: 0,
                overtimeMinutes: 0,
                creditedOvertimeMinutes: 0,
                balanceMinutes: 0,
                ruleCode: null,
                bankHoursExplanation: null,
            },
            {
                domain: "intervention",
                targetCode: "IT30",
                targetLabel: "IT30",
                sortOrder: 30,
                defaultRole: null,
                disabledAt: "2026-03-28T21:30:00.000Z",
                disabledReason: "USA recolhida",
                disabledDuringShift: true,
                disabledEntireShift: true,
                occupancyId: null,
                doctorId: null,
                doctorName: null,
                displayName: null,
                startedAt: null,
                endedAt: null,
                actualEndedAt: null,
                scheduledStartAt: null,
                scheduledEndAt: null,
                shiftLabel: "SN",
                roleLabel: null,
                ramalLabel: null,
                earlyDepartureOutcome: null,
                candidateLabels: [],
                conflictCandidateLabels: [],
                hasDoctorOverlapConflict: false,
                source: null,
                candidateCount: 0,
                paymentStatus: "ready_for_payment",
                issues: ["Base desativada desde 2026-03-28T21:30:00.000Z"],
                arrivalDelayMinutes: null,
                overtimeMinutes: null,
                creditedOvertimeMinutes: null,
                balanceMinutes: null,
                ruleCode: null,
                bankHoursExplanation: null,
            },
        ],
    };
}

test("buildPaymentAttestationPreview keeps regulation before intervention and excludes disabled targets from payable totals", () => {
    const preview = buildPaymentAttestationPreview(makeBoard());

    assert.equal(preview.status, "preview");
    assert.equal(preview.entries[0]?.targetCode, "2031");
    assert.equal(preview.entries[1]?.targetCode, "PM04");
    assert.equal(preview.entries[2]?.targetCode, "IT30");
    assert.equal(preview.summary.totalTargets, 2);
    assert.equal(preview.summary.readyCount, 1);
    assert.equal(preview.summary.needsReviewCount, 1);
    assert.equal(preview.summary.disabledCount, 1);
    assert.equal(preview.summary.doctorCount, 1);
    assert.equal(preview.canApprove, false);
});

test("buildPaymentAttestationPreview allows approval when every payable line is ready", () => {
    const board = makeBoard();
    board.intervention[0] = {
        ...board.intervention[0],
        endedAt: "2026-03-29T10:00:00.000Z",
        actualEndedAt: "2026-03-29T10:00:00.000Z",
        paymentStatus: "ready_for_payment",
        issues: [],
        ruleCode: "ON_TIME_NO_OVERTIME",
        bankHoursExplanation: "ok",
    };
    board.summary.readyForPaymentCount = 2;
    board.summary.needsReviewCount = 0;

    const preview = buildPaymentAttestationPreview(board);

    assert.equal(preview.summary.readyCount, 2);
    assert.equal(preview.summary.needsReviewCount, 0);
    assert.equal(preview.summary.doctorCount, 2);
    assert.equal(preview.canApprove, true);
});
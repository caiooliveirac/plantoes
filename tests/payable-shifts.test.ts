import assert from "node:assert/strict";
import test from "node:test";
import {
    buildAdminExtraPayableShift,
    buildAttestationSegments,
    buildChiefPayableBoard,
    buildDisabledTargetsFromBoards,
    buildUncoveredTargetsFromBoards,
    buildPayableShiftsFromBoards,
    buildPayableTargetOptions,
    resolveDoctorPaymentProfile,
    resolveShiftDueAmount,
    type RawPresenceEvent,
} from "@/modules/reporting/payable-shifts";
import type { PaymentAllocationBoard } from "@/services/board.service";

function makeRawEvent(overrides: Partial<RawPresenceEvent> = {}): RawPresenceEvent {
    return {
        occupancyId: "occ-1",
        domain: "intervention",
        doctorId: "doc-1",
        doctorName: "Syone de Jesus Feitosa",
        displayName: "Syone Feitosa",
        targetCode: "BR60",
        targetLabel: "BR60",
        startedAt: "2026-04-01T22:00:00.000Z",
        endedAt: "2026-04-02T10:00:00.000Z",
        actualEndedAt: "2026-04-02T10:00:00.000Z",
        scheduledStartAt: "2026-04-01T22:00:00.000Z",
        scheduledEndAt: "2026-04-02T10:00:00.000Z",
        shiftLabel: "SN",
        source: "telegram",
        continuityGroupId: "cg-1",
        notes: null,
        ...overrides,
    };
}

function makeBoard(overrides: Partial<PaymentAllocationBoard> = {}): PaymentAllocationBoard {
    return {
        generatedAt: "2026-04-12T00:00:00.000Z",
        operationalDate: "2026-04-10T12:00:00.000Z",
        shiftLabel: "SD",
        startedAt: "2026-04-10T10:00:00.000Z",
        endedAt: "2026-04-10T22:00:00.000Z",
        summary: {
            totalTargets: 1,
            assignedCount: 1,
            readyForPaymentCount: 1,
            needsReviewCount: 0,
            unassignedCount: 0,
            disabledCount: 0,
        },
        regulation: [],
        intervention: [
            {
                domain: "intervention",
                targetCode: "BR60",
                targetLabel: "BR60",
                sortOrder: 60,
                defaultRole: null,
                disabledAt: null,
                disabledReason: null,
                disabledDuringShift: false,
                disabledEntireShift: false,
                occupancyId: "occ-24h",
                doctorId: "doc-1",
                doctorName: "Syone de Jesus Feitosa",
                displayName: "Syone Feitosa",
                startedAt: "2026-04-10T10:02:55.000Z",
                endedAt: "2026-04-10T22:00:00.000Z",
                actualEndedAt: "2026-04-10T22:00:00.000Z",
                scheduledStartAt: "2026-04-10T10:00:00.000Z",
                scheduledEndAt: "2026-04-10T22:00:00.000Z",
                shiftLabel: "SD",
                roleLabel: null,
                ramalLabel: null,
                source: "telegram",
                notes: null,
                candidateCount: 1,
                paymentStatus: "ready_for_payment",
                issues: [],
                arrivalDelayMinutes: 3,
                overtimeMinutes: 0,
                creditedOvertimeMinutes: 0,
                balanceMinutes: 0,
                ruleCode: "ON_TIME_NO_OVERTIME",
                bankHoursExplanation: "ok",
                sourceShiftLabel: "P",
                sourceStartedAt: "2026-04-10T10:02:55.000Z",
                sourceBoardStartedAt: "2026-04-10T10:02:55.000Z",
                sourceEndedAt: "2026-04-11T09:46:00.000Z",
                sourceActualEndedAt: "2026-04-11T09:46:00.000Z",
                sourceScheduledStartAt: "2026-04-10T10:00:00.000Z",
                sourceScheduledEndAt: "2026-04-11T10:00:00.000Z",
                sourceArrivalDelayMinutes: 3,
                sourceOvertimeMinutes: 0,
                sourceCreditedOvertimeMinutes: 0,
                sourceBalanceMinutes: 0,
                sourceRuleCode: "ON_TIME_NO_OVERTIME",
                sourceBankHoursExplanation: "ok",
                continuesBeyondShift: true,
            },
        ],
        ...overrides,
    };
}

test("buildAttestationSegments discards short fragment and keeps SN real selected for payment", () => {
    const snReal = makeRawEvent({ occupancyId: "occ-real", startedAt: "2026-04-01T21:45:00.000Z", endedAt: "2026-04-02T10:00:00.000Z", actualEndedAt: "2026-04-02T10:00:00.000Z" });
    const shortFragment = makeRawEvent({ occupancyId: "occ-frag", targetCode: "BR05", targetLabel: "BR05", startedAt: "2026-04-01T21:45:00.000Z", endedAt: "2026-04-01T22:19:14.000Z", actualEndedAt: "2026-04-01T22:19:14.000Z" });

    const segments = buildAttestationSegments({
        rawEvents: [snReal, shortFragment],
        selectedOccupancyIds: new Set(["occ-real"]),
    });

    assert.equal(segments.find((segment) => segment.occupancyId === "occ-real")?.status, "consolidated");
    assert.equal(segments.find((segment) => segment.occupancyId === "occ-frag")?.status, "discarded");
    assert.equal(segments.find((segment) => segment.occupancyId === "occ-frag")?.discardReason, "short_fragment");
});

test("buildAttestationSegments discards duplicate residual records", () => {
    const canonical = makeRawEvent({ occupancyId: "occ-keep", endedAt: "2026-04-02T10:00:00.000Z", actualEndedAt: "2026-04-02T10:00:00.000Z" });
    const duplicate = makeRawEvent({ occupancyId: "occ-drop", endedAt: null, actualEndedAt: null });

    const segments = buildAttestationSegments({
        rawEvents: [canonical, duplicate],
        selectedOccupancyIds: new Set(["occ-keep"]),
    });

    assert.equal(segments.find((segment) => segment.occupancyId === "occ-keep")?.status, "consolidated");
    assert.equal(segments.find((segment) => segment.occupancyId === "occ-drop")?.discardReason, "duplicate_segment");
});

test("buildPayableShiftsFromBoards splits continuous 24h coverage into SD and SN payable units", () => {
    const sdBoard = makeBoard();
    const snBoard = makeBoard({
        shiftLabel: "SN",
        startedAt: "2026-04-10T22:00:00.000Z",
        endedAt: "2026-04-11T10:00:00.000Z",
        intervention: [{
            ...makeBoard().intervention[0],
            startedAt: "2026-04-10T22:00:00.000Z",
            endedAt: "2026-04-11T09:46:00.000Z",
            actualEndedAt: "2026-04-11T09:46:00.000Z",
            shiftLabel: "SN",
            continuesBeyondShift: false,
        }],
    });

    const payable = buildPayableShiftsFromBoards([sdBoard, snBoard]);

    assert.equal(payable.length, 2);
    assert.deepEqual(payable.map((item) => item.shiftLabel), ["SD", "SN"]);
    assert.equal(payable[0]?.occupancyId, payable[1]?.occupancyId);
});

test("buildPayableShiftsFromBoards inclui titular e sombra na mesma base e turno", () => {
    const board = makeBoard({
        intervention: [
            makeBoard().intervention[0],
            {
                ...makeBoard().intervention[0],
                occupancyId: "occ-shadow",
                doctorId: "doc-2",
                doctorName: "Bruna Sombra",
                displayName: "Bruna",
                notes: "[telegram sombra] Bruna Sombra BR60 10:05 sombra",
            },
        ],
        summary: {
            totalTargets: 1,
            assignedCount: 1,
            readyForPaymentCount: 1,
            needsReviewCount: 0,
            unassignedCount: 0,
            disabledCount: 0,
        },
    });

    const payable = buildPayableShiftsFromBoards([board]);

    assert.equal(payable.length, 2);
    assert.deepEqual(payable.map((item) => item.occupancyId).sort(), ["occ-24h", "occ-shadow"]);
});

test("buildChiefPayableBoard keeps two payable shifts in the same day cell", () => {
    const basePayable = buildPayableShiftsFromBoards([makeBoard()]);
    const disabled = buildDisabledTargetsFromBoards({ boards: [makeBoard({
        intervention: [
            {
                ...makeBoard().intervention[0],
                occupancyId: null,
                doctorId: null,
                doctorName: null,
                displayName: null,
                startedAt: null,
                endedAt: null,
                actualEndedAt: null,
                scheduledStartAt: null,
                scheduledEndAt: null,
                shiftLabel: null,
                paymentStatus: "needs_review",
                disabledDuringShift: true,
                disabledEntireShift: true,
                disabledReason: "Manutenção",
                candidateCount: 0,
                issues: ["Base desativada"],
                sourceShiftLabel: null,
                sourceStartedAt: null,
                sourceBoardStartedAt: null,
                sourceEndedAt: null,
                sourceActualEndedAt: null,
                sourceScheduledStartAt: null,
                sourceScheduledEndAt: null,
                sourceArrivalDelayMinutes: null,
                sourceOvertimeMinutes: null,
                sourceCreditedOvertimeMinutes: null,
                sourceBalanceMinutes: null,
                sourceRuleCode: null,
                sourceBankHoursExplanation: null,
                continuesBeyondShift: false,
            },
        ],
    })] });
    const uncovered = buildUncoveredTargetsFromBoards({ boards: [makeBoard({
        intervention: [
            {
                ...makeBoard().intervention[0],
                occupancyId: null,
                doctorId: null,
                doctorName: null,
                displayName: null,
                startedAt: null,
                endedAt: null,
                actualEndedAt: null,
                scheduledStartAt: null,
                scheduledEndAt: null,
                shiftLabel: null,
                paymentStatus: "needs_review",
                disabledDuringShift: false,
                disabledEntireShift: false,
                disabledReason: null,
                candidateCount: 0,
                issues: ["Sem ocupacao identificada para o turno"],
                sourceShiftLabel: null,
                sourceStartedAt: null,
                sourceBoardStartedAt: null,
                sourceEndedAt: null,
                sourceActualEndedAt: null,
                sourceScheduledStartAt: null,
                sourceScheduledEndAt: null,
                sourceArrivalDelayMinutes: null,
                sourceOvertimeMinutes: null,
                sourceCreditedOvertimeMinutes: null,
                sourceBalanceMinutes: null,
                sourceRuleCode: null,
                sourceBankHoursExplanation: null,
                continuesBeyondShift: false,
            },
        ],
    })] });

    const board = buildChiefPayableBoard({
        monthKey: "2026-04",
        monthLabel: "abril de 2026",
        presetMonths: [{ key: "2026-04", label: "abril de 2026" }],
        rangeStartIso: "2026-04-01T10:00:00.000Z",
        rangeEndIso: "2026-05-01T10:00:00.000Z",
        payableShifts: [
            {
                ...basePayable[0],
                payableShiftId: "sd",
                operationalDate: "2026-04-10",
                shiftLabel: "SD",
                tagCode: "PM04",
            },
            {
                ...basePayable[0],
                payableShiftId: "sn",
                operationalDate: "2026-04-10",
                shiftLabel: "SN",
                tagCode: "BR05",
            },
        ],
        disabledTargets: disabled,
        uncoveredTargets: uncovered,
        targetOptions: buildPayableTargetOptions({
            payableShifts: basePayable,
            disabledTargets: disabled,
            uncoveredTargets: uncovered,
        }),
        attestationSegments: [],
    });

    const doctor = board.doctors[0];
    assert.ok(doctor);
    const day10 = doctor?.cells.find((cell) => cell.day === "10");
    assert.ok(day10);
    assert.equal(day10?.shifts.length, 2);
    assert.equal(day10?.shifts[0]?.shiftLabel, "SD");
    assert.equal(day10?.shifts[1]?.shiftLabel, "SN");
});

test("buildChiefPayableBoard conta plantões USA (intervenção) e CRU (regulação) por médico", () => {
    const basePayable = buildPayableShiftsFromBoards([makeBoard()]);
    const usaShift = { ...basePayable[0], domain: "intervention" as const, tagCode: "BR05" };

    const board = buildChiefPayableBoard({
        monthKey: "2026-04",
        monthLabel: "abril de 2026",
        presetMonths: [{ key: "2026-04", label: "abril de 2026" }],
        rangeStartIso: "2026-04-01T10:00:00.000Z",
        rangeEndIso: "2026-05-01T10:00:00.000Z",
        payableShifts: [
            { ...usaShift, payableShiftId: "usa-1", operationalDate: "2026-04-10", shiftLabel: "SD" },
            { ...usaShift, payableShiftId: "usa-2", operationalDate: "2026-04-11", shiftLabel: "SN" },
            { ...usaShift, payableShiftId: "cru-1", operationalDate: "2026-04-12", shiftLabel: "SD", domain: "regulation", tagCode: "CRU" },
            // Punição de banco de horas (unidade negativa) não conta como plantão cumprido.
            { ...usaShift, payableShiftId: "pen-1", operationalDate: "2026-04-13", shiftLabel: "SD", domain: "regulation", tagCode: "CRU", paymentUnit: -1 },
        ],
        disabledTargets: [],
        uncoveredTargets: [],
        targetOptions: [],
        attestationSegments: [],
    });

    const doctor = board.doctors[0];
    assert.ok(doctor);
    assert.equal(doctor?.usaShiftCount, 2, "duas USAs cumpridas");
    assert.equal(doctor?.cruShiftCount, 1, "uma CRU cumprida (punição não conta)");
});

test("buildChiefPayableBoard marca médico que só cumpriu uma função", () => {
    const basePayable = buildPayableShiftsFromBoards([makeBoard()]);
    const usaShift = { ...basePayable[0], domain: "intervention" as const, tagCode: "BR05" };

    const board = buildChiefPayableBoard({
        monthKey: "2026-04",
        monthLabel: "abril de 2026",
        presetMonths: [{ key: "2026-04", label: "abril de 2026" }],
        rangeStartIso: "2026-04-01T10:00:00.000Z",
        rangeEndIso: "2026-05-01T10:00:00.000Z",
        payableShifts: [
            { ...usaShift, payableShiftId: "usa-1", operationalDate: "2026-04-10", shiftLabel: "SD" },
            { ...usaShift, payableShiftId: "usa-2", operationalDate: "2026-04-11", shiftLabel: "SN" },
        ],
        disabledTargets: [],
        uncoveredTargets: [],
        targetOptions: [],
        attestationSegments: [],
    });

    const doctor = board.doctors[0];
    assert.ok(doctor);
    assert.equal(doctor?.usaShiftCount, 2);
    assert.equal(doctor?.cruShiftCount, 0);
    // XOR: só uma das funções foi cumprida → linha destacada no painel.
    assert.equal((doctor!.usaShiftCount > 0) !== (doctor!.cruShiftCount > 0), true);
});

test("buildChiefPayableBoard keeps audit/payment divergence explicit in summary", () => {
    const payableShifts = buildPayableShiftsFromBoards([makeBoard()]);
    const disabledTargets = [];
    const uncoveredTargets = [];
    const board = buildChiefPayableBoard({
        monthKey: "2026-04",
        monthLabel: "abril de 2026",
        presetMonths: [{ key: "2026-04", label: "abril de 2026" }],
        rangeStartIso: "2026-04-01T10:00:00.000Z",
        rangeEndIso: "2026-05-01T10:00:00.000Z",
        payableShifts,
        disabledTargets,
        uncoveredTargets,
        targetOptions: buildPayableTargetOptions({ payableShifts, disabledTargets, uncoveredTargets }),
        attestationSegments: [
            {
                segmentId: "seg-1",
                occupancyId: "occ-24h",
                domain: "intervention",
                doctorId: "doc-1",
                doctorName: "Syone de Jesus Feitosa",
                displayName: "Syone Feitosa",
                targetCode: "BR60",
                targetLabel: "BR60",
                shiftLabel: "P",
                startedAt: "2026-04-10T10:02:55.000Z",
                endedAt: "2026-04-11T09:46:00.000Z",
                durationMinutes: 1423,
                source: "telegram",
                continuityGroupId: "cg-1",
                status: "discarded",
                discardReason: "not_selected_for_payment",
                selectedForPayment: false,
            },
        ],
    });

    assert.equal(board.summary.payableShiftCount, 1);
    assert.equal(board.summary.segmentCount, 1);
    assert.equal(board.summary.discardedSegmentCount, 1);
    assert.equal(board.summary.disabledTargetCount, 0);
    assert.equal(board.summary.uncoveredTargetCount, 0);
});

test("buildDisabledTargetsFromBoards collects disabled bases by day/shift", () => {
    const board = makeBoard({
        intervention: [
            {
                ...makeBoard().intervention[0],
                occupancyId: null,
                doctorId: null,
                doctorName: null,
                displayName: null,
                startedAt: null,
                endedAt: null,
                actualEndedAt: null,
                scheduledStartAt: null,
                scheduledEndAt: null,
                shiftLabel: null,
                paymentStatus: "needs_review",
                disabledDuringShift: true,
                disabledEntireShift: true,
                disabledReason: "Manutenção",
                candidateCount: 0,
                issues: ["Base desativada"],
                sourceShiftLabel: null,
                sourceStartedAt: null,
                sourceBoardStartedAt: null,
                sourceEndedAt: null,
                sourceActualEndedAt: null,
                sourceScheduledStartAt: null,
                sourceScheduledEndAt: null,
                sourceArrivalDelayMinutes: null,
                sourceOvertimeMinutes: null,
                sourceCreditedOvertimeMinutes: null,
                sourceBalanceMinutes: null,
                sourceRuleCode: null,
                sourceBankHoursExplanation: null,
                continuesBeyondShift: false,
            },
        ],
    });

    const snapshots = buildDisabledTargetsFromBoards({ boards: [board] });
    assert.equal(snapshots.length, 1);
    assert.equal(snapshots[0]?.targetCode, "BR60");
    assert.equal(snapshots[0]?.shiftLabel, "SD");
    assert.equal(snapshots[0]?.domain, "intervention");
});

test("buildDisabledTargetsFromBoards ignores future slots", () => {
    const pastBoard = makeBoard({
        intervention: [
            {
                ...makeBoard().intervention[0],
                occupancyId: null,
                doctorId: null,
                doctorName: null,
                displayName: null,
                startedAt: null,
                endedAt: null,
                actualEndedAt: null,
                scheduledStartAt: null,
                scheduledEndAt: null,
                shiftLabel: null,
                paymentStatus: "needs_review",
                disabledDuringShift: true,
                disabledEntireShift: true,
                disabledReason: "sem médico",
                candidateCount: 0,
                issues: ["Base desativada"],
                sourceShiftLabel: null,
                sourceStartedAt: null,
                sourceBoardStartedAt: null,
                sourceEndedAt: null,
                sourceActualEndedAt: null,
                sourceScheduledStartAt: null,
                sourceScheduledEndAt: null,
                sourceArrivalDelayMinutes: null,
                sourceOvertimeMinutes: null,
                sourceCreditedOvertimeMinutes: null,
                sourceBalanceMinutes: null,
                sourceRuleCode: null,
                sourceBankHoursExplanation: null,
                continuesBeyondShift: false,
            },
        ],
    });
    const futureBoard = {
        ...pastBoard,
        startedAt: "2099-01-01T03:00:00.000Z",
    };
    // With cutoff at pastBoard.startedAt, future board is excluded
    const snapshots = buildDisabledTargetsFromBoards({
        boards: [pastBoard, futureBoard],
        maxSlotStartedAtIso: pastBoard.startedAt,
    });
    assert.equal(snapshots.length, 1);
});

test("buildUncoveredTargetsFromBoards collects non-disabled empty slots", () => {
    const board = makeBoard({
        intervention: [
            {
                ...makeBoard().intervention[0],
                occupancyId: null,
                doctorId: null,
                doctorName: null,
                displayName: null,
                startedAt: null,
                endedAt: null,
                actualEndedAt: null,
                scheduledStartAt: null,
                scheduledEndAt: null,
                shiftLabel: null,
                paymentStatus: "needs_review",
                disabledDuringShift: false,
                disabledEntireShift: false,
                disabledReason: null,
                candidateCount: 0,
                issues: ["Sem ocupacao identificada para o turno"],
                sourceShiftLabel: null,
                sourceStartedAt: null,
                sourceBoardStartedAt: null,
                sourceEndedAt: null,
                sourceActualEndedAt: null,
                sourceScheduledStartAt: null,
                sourceScheduledEndAt: null,
                sourceArrivalDelayMinutes: null,
                sourceOvertimeMinutes: null,
                sourceCreditedOvertimeMinutes: null,
                sourceBalanceMinutes: null,
                sourceRuleCode: null,
                sourceBankHoursExplanation: null,
                continuesBeyondShift: false,
            },
        ],
    });

    const snapshots = buildUncoveredTargetsFromBoards({ boards: [board] });
    assert.equal(snapshots.length, 1);
    assert.equal(snapshots[0]?.targetCode, "BR60");
    assert.equal(snapshots[0]?.shiftLabel, "SD");
    assert.equal(snapshots[0]?.domain, "intervention");
});

test("buildUncoveredTargetsFromBoards ignores regulation ramais", () => {
    const board = makeBoard({
        regulation: [
            {
                domain: "regulation",
                targetCode: "1321",
                targetLabel: "1321",
                sortOrder: 1,
                defaultRole: null,
                disabledAt: null,
                disabledReason: null,
                disabledDuringShift: false,
                disabledEntireShift: false,
                occupancyId: null,
                doctorId: null,
                doctorName: null,
                displayName: null,
                startedAt: null,
                endedAt: null,
                actualEndedAt: null,
                scheduledStartAt: null,
                scheduledEndAt: null,
                shiftLabel: null,
                roleLabel: null,
                ramalLabel: null,
                source: null,
                notes: null,
                candidateCount: 0,
                paymentStatus: "needs_review",
                issues: ["Sem ocupacao identificada para o turno"],
                arrivalDelayMinutes: null,
                overtimeMinutes: null,
                creditedOvertimeMinutes: null,
                balanceMinutes: null,
                ruleCode: null,
                bankHoursExplanation: null,
                sourceShiftLabel: null,
                sourceStartedAt: null,
                sourceBoardStartedAt: null,
                sourceEndedAt: null,
                sourceActualEndedAt: null,
                sourceScheduledStartAt: null,
                sourceScheduledEndAt: null,
                sourceArrivalDelayMinutes: null,
                sourceOvertimeMinutes: null,
                sourceCreditedOvertimeMinutes: null,
                sourceBalanceMinutes: null,
                sourceRuleCode: null,
                sourceBankHoursExplanation: null,
                continuesBeyondShift: false,
            },
        ],
        intervention: [],
    });

    const snapshots = buildUncoveredTargetsFromBoards({ boards: [board] });
    assert.equal(snapshots.length, 0);
});

test("buildUncoveredTargetsFromBoards includes PIAM uncovered on both shifts", () => {
    const sdBoard = makeBoard({
        shiftLabel: "SD",
        regulation: [
            {
                domain: "regulation",
                targetCode: "PIAM",
                targetLabel: "PIAM",
                sortOrder: 999,
                defaultRole: null,
                disabledAt: null,
                disabledReason: null,
                disabledDuringShift: false,
                disabledEntireShift: false,
                occupancyId: null,
                doctorId: null,
                doctorName: null,
                displayName: null,
                startedAt: null,
                endedAt: null,
                actualEndedAt: null,
                scheduledStartAt: null,
                scheduledEndAt: null,
                shiftLabel: null,
                roleLabel: null,
                ramalLabel: null,
                source: null,
                notes: null,
                candidateCount: 0,
                paymentStatus: "needs_review",
                issues: ["Sem ocupacao identificada para o turno"],
                arrivalDelayMinutes: null,
                overtimeMinutes: null,
                creditedOvertimeMinutes: null,
                balanceMinutes: null,
                ruleCode: null,
                bankHoursExplanation: null,
                sourceShiftLabel: null,
                sourceStartedAt: null,
                sourceBoardStartedAt: null,
                sourceEndedAt: null,
                sourceActualEndedAt: null,
                sourceScheduledStartAt: null,
                sourceScheduledEndAt: null,
                sourceArrivalDelayMinutes: null,
                sourceOvertimeMinutes: null,
                sourceCreditedOvertimeMinutes: null,
                sourceBalanceMinutes: null,
                sourceRuleCode: null,
                sourceBankHoursExplanation: null,
                continuesBeyondShift: false,
            },
        ],
        intervention: [],
    });
    const snBoard = {
        ...sdBoard,
        shiftLabel: "SN" as const,
        startedAt: "2026-04-10T22:00:00.000Z",
        endedAt: "2026-04-11T10:00:00.000Z",
    };

    const snapshots = buildUncoveredTargetsFromBoards({ boards: [sdBoard, snBoard] });
    assert.equal(snapshots.length, 2);
    assert.deepEqual(snapshots.map((item) => item.shiftLabel), ["SD", "SN"]);
    assert.ok(snapshots.every((item) => item.domain === "regulation" && item.targetCode === "PIAM"));
});

test("buildUncoveredTargetsFromBoards includes NUCLEO only on SD", () => {
    const sdBoard = makeBoard({
        shiftLabel: "SD",
        regulation: [
            {
                domain: "regulation",
                targetCode: "NUCLEO",
                targetLabel: "NUCLEO",
                sortOrder: 998,
                defaultRole: null,
                disabledAt: null,
                disabledReason: null,
                disabledDuringShift: false,
                disabledEntireShift: false,
                occupancyId: null,
                doctorId: null,
                doctorName: null,
                displayName: null,
                startedAt: null,
                endedAt: null,
                actualEndedAt: null,
                scheduledStartAt: null,
                scheduledEndAt: null,
                shiftLabel: null,
                roleLabel: null,
                ramalLabel: null,
                source: null,
                notes: null,
                candidateCount: 0,
                paymentStatus: "needs_review",
                issues: ["Sem ocupacao identificada para o turno"],
                arrivalDelayMinutes: null,
                overtimeMinutes: null,
                creditedOvertimeMinutes: null,
                balanceMinutes: null,
                ruleCode: null,
                bankHoursExplanation: null,
                sourceShiftLabel: null,
                sourceStartedAt: null,
                sourceBoardStartedAt: null,
                sourceEndedAt: null,
                sourceActualEndedAt: null,
                sourceScheduledStartAt: null,
                sourceScheduledEndAt: null,
                sourceArrivalDelayMinutes: null,
                sourceOvertimeMinutes: null,
                sourceCreditedOvertimeMinutes: null,
                sourceBalanceMinutes: null,
                sourceRuleCode: null,
                sourceBankHoursExplanation: null,
                continuesBeyondShift: false,
            },
        ],
        intervention: [],
    });
    const snBoard = {
        ...sdBoard,
        shiftLabel: "SN" as const,
        startedAt: "2026-04-10T22:00:00.000Z",
        endedAt: "2026-04-11T10:00:00.000Z",
    };

    const snapshots = buildUncoveredTargetsFromBoards({ boards: [sdBoard, snBoard] });
    assert.equal(snapshots.length, 1);
    assert.equal(snapshots[0]?.targetCode, "NUCLEO");
    assert.equal(snapshots[0]?.shiftLabel, "SD");
    assert.equal(snapshots[0]?.domain, "regulation");
});

test("buildUncoveredTargetsFromBoards ignores future slots", () => {
    const board = makeBoard({
        startedAt: "2099-04-10T10:00:00.000Z",
        endedAt: "2099-04-10T22:00:00.000Z",
        intervention: [
            {
                ...makeBoard().intervention[0],
                occupancyId: null,
                doctorId: null,
                doctorName: null,
                displayName: null,
                startedAt: null,
                endedAt: null,
                actualEndedAt: null,
                scheduledStartAt: null,
                scheduledEndAt: null,
                shiftLabel: null,
                paymentStatus: "needs_review",
                disabledDuringShift: false,
                disabledEntireShift: false,
                disabledReason: null,
                candidateCount: 0,
                issues: ["Sem ocupacao identificada para o turno"],
                sourceShiftLabel: null,
                sourceStartedAt: null,
                sourceBoardStartedAt: null,
                sourceEndedAt: null,
                sourceActualEndedAt: null,
                sourceScheduledStartAt: null,
                sourceScheduledEndAt: null,
                sourceArrivalDelayMinutes: null,
                sourceOvertimeMinutes: null,
                sourceCreditedOvertimeMinutes: null,
                sourceBalanceMinutes: null,
                sourceRuleCode: null,
                sourceBankHoursExplanation: null,
                continuesBeyondShift: false,
            },
        ],
    });

    const snapshots = buildUncoveredTargetsFromBoards({
        boards: [board],
        maxSlotStartedAtIso: "2026-04-30T23:59:59.000Z",
    });
    assert.equal(snapshots.length, 0);
});

test("resolveDoctorPaymentProfile honors PSIQ and specialist flags", () => {
    assert.equal(resolveDoctorPaymentProfile({ preferredOperationalRole: "PSIQ" }), "psychiatry");
    assert.equal(resolveDoctorPaymentProfile({ paymentProfile: { isSpecialist: true } }), "specialist");
    assert.equal(resolveDoctorPaymentProfile({ isPaymentSpecialist: true }), "specialist");
    assert.equal(resolveDoctorPaymentProfile({}), "generalist");
});

test("resolveShiftDueAmount mantém centésimos corretos em meio plantão de dia útil", () => {
    assert.equal(resolveShiftDueAmount({
        profile: "generalist",
        operationalDate: "2026-06-22",
        paymentUnit: 0.5,
    }), 622.44);
});

test("buildChiefPayableBoard mantém total correto para 10,5 plantões em dia útil", () => {
    const payableShifts = [
        ...Array.from({ length: 10 }, (_, index) => buildAdminExtraPayableShift({
            id: `full-${index + 1}`,
            doctorId: "doc-105",
            doctorName: "Alessandra Barboza",
            displayName: null,
            operationalDate: "2026-06-22",
            shiftLabel: "SD",
            label: `EXTRA-${index + 1}`,
            unit: 1,
        })),
        buildAdminExtraPayableShift({
            id: "half-1",
            doctorId: "doc-105",
            doctorName: "Alessandra Barboza",
            displayName: null,
            operationalDate: "2026-06-22",
            shiftLabel: "SD",
            label: "EXTRA-HALF",
            unit: 0.5,
        }),
    ];

    const board = buildChiefPayableBoard({
        monthKey: "2026-06",
        monthLabel: "junho de 2026",
        presetMonths: [{ key: "2026-06", label: "junho de 2026" }],
        rangeStartIso: "2026-06-01T10:00:00.000Z",
        rangeEndIso: "2026-07-01T10:00:00.000Z",
        payableShifts,
        disabledTargets: [],
        uncoveredTargets: [],
        targetOptions: [],
        attestationSegments: [],
        allDoctorNames: ["Alessandra Barboza"],
        doctorPaymentProfiles: {
            "doc-105": "generalist",
        },
    });

    const doctor = board.doctors.find((entry) => entry.doctorId === "doc-105");
    assert.ok(doctor);
    assert.equal(doctor?.total, 10.5);
    assert.equal(doctor?.weekdayShiftCount, 10.5);
    assert.equal(doctor?.totalDue, 13071.14);
});

test("buildChiefPayableBoard mantém total de 10,5 por unidades agregadas mesmo com vários meios plantões", () => {
    const payableShifts = Array.from({ length: 21 }, (_, index) => buildAdminExtraPayableShift({
        id: `half-${index + 1}`,
        doctorId: "doc-105b",
        doctorName: "Alessandra Barboza",
        displayName: null,
        operationalDate: "2026-06-22",
        shiftLabel: "SD",
        label: `EXTRA-HALF-${index + 1}`,
        unit: 0.5,
    }));

    const board = buildChiefPayableBoard({
        monthKey: "2026-06",
        monthLabel: "junho de 2026",
        presetMonths: [{ key: "2026-06", label: "junho de 2026" }],
        rangeStartIso: "2026-06-01T10:00:00.000Z",
        rangeEndIso: "2026-07-01T10:00:00.000Z",
        payableShifts,
        disabledTargets: [],
        uncoveredTargets: [],
        targetOptions: [],
        attestationSegments: [],
        allDoctorNames: ["Alessandra Barboza"],
        doctorPaymentProfiles: {
            "doc-105b": "generalist",
        },
    });

    const doctor = board.doctors.find((entry) => entry.doctorId === "doc-105b");
    assert.ok(doctor);
    assert.equal(doctor?.total, 10.5);
    assert.equal(doctor?.weekdayShiftCount, 10.5);
    assert.equal(doctor?.totalDue, 13071.14);
});

test("buildChiefPayableBoard computes due amount by profile and weekday/weekend", () => {
    const weekdayShift = {
        ...makeBoard().intervention[0],
        occupancyId: "occ-weekday",
        startedAt: "2026-04-10T10:00:00.000Z",
        endedAt: "2026-04-10T22:00:00.000Z",
        actualEndedAt: "2026-04-10T22:00:00.000Z",
        shiftLabel: "SD" as const,
        sourceShiftLabel: "SD" as const,
        continuesBeyondShift: false,
    };
    const weekendShift = {
        ...makeBoard().intervention[0],
        occupancyId: "occ-weekend",
        startedAt: "2026-04-12T22:00:00.000Z",
        endedAt: "2026-04-13T10:00:00.000Z",
        actualEndedAt: "2026-04-13T10:00:00.000Z",
        shiftLabel: "SN" as const,
        sourceShiftLabel: "SN" as const,
        continuesBeyondShift: false,
    };

    const payableShifts = buildPayableShiftsFromBoards([
        makeBoard({
            operationalDate: "2026-04-10T12:00:00.000Z",
            shiftLabel: "SD",
            startedAt: "2026-04-10T10:00:00.000Z",
            endedAt: "2026-04-10T22:00:00.000Z",
            intervention: [weekdayShift],
        }),
        makeBoard({
            operationalDate: "2026-04-12T12:00:00.000Z",
            shiftLabel: "SN",
            startedAt: "2026-04-12T22:00:00.000Z",
            endedAt: "2026-04-13T10:00:00.000Z",
            intervention: [weekendShift],
        }),
    ]);

    const board = buildChiefPayableBoard({
        monthKey: "2026-04",
        monthLabel: "abril de 2026",
        presetMonths: [{ key: "2026-04", label: "abril de 2026" }],
        rangeStartIso: "2026-04-01T10:00:00.000Z",
        rangeEndIso: "2026-05-01T10:00:00.000Z",
        payableShifts,
        disabledTargets: [],
        uncoveredTargets: [],
        targetOptions: buildPayableTargetOptions({ payableShifts, disabledTargets: [], uncoveredTargets: [] }),
        attestationSegments: [],
        allDoctorNames: [],
        doctorPaymentProfiles: {
            "doc-1": "specialist",
        },
    });

    const doctor = board.doctors.find((entry) => entry.doctorId === "doc-1");
    assert.ok(doctor);
    assert.equal(doctor?.paymentProfile, "specialist");
    assert.equal(doctor?.totalSDDue, 1329.66);
    assert.equal(doctor?.totalSNDue, 1457.15);
    assert.equal(doctor?.totalDue, 2786.81);
    assert.equal(board.summary.totalDueAmount, 2786.81);
});

test("buildChiefPayableBoard zera valor devido e soma separado para médico estatutário", () => {
    const shift = {
        ...makeBoard().intervention[0],
        occupancyId: "occ-estatutario",
        startedAt: "2026-04-10T10:00:00.000Z",
        endedAt: "2026-04-10T22:00:00.000Z",
        actualEndedAt: "2026-04-10T22:00:00.000Z",
        shiftLabel: "SD" as const,
        sourceShiftLabel: "SD" as const,
        continuesBeyondShift: false,
    };

    const payableShifts = buildPayableShiftsFromBoards([
        makeBoard({
            operationalDate: "2026-04-10T12:00:00.000Z",
            shiftLabel: "SD",
            startedAt: "2026-04-10T10:00:00.000Z",
            endedAt: "2026-04-10T22:00:00.000Z",
            intervention: [shift],
        }),
    ]);

    const board = buildChiefPayableBoard({
        monthKey: "2026-04",
        monthLabel: "abril de 2026",
        presetMonths: [{ key: "2026-04", label: "abril de 2026" }],
        rangeStartIso: "2026-04-01T10:00:00.000Z",
        rangeEndIso: "2026-05-01T10:00:00.000Z",
        payableShifts,
        disabledTargets: [],
        uncoveredTargets: [],
        targetOptions: buildPayableTargetOptions({ payableShifts, disabledTargets: [], uncoveredTargets: [] }),
        attestationSegments: [],
        allDoctorNames: [],
        doctorEmploymentTypes: {
            "doc-1": "estatutario",
        },
    });

    const doctor = board.doctors.find((entry) => entry.doctorId === "doc-1");
    assert.ok(doctor);
    assert.equal(doctor?.employmentType, "estatutario");
    assert.equal(doctor?.totalDue, 0);
    assert.equal(board.summary.byEmploymentType.estatutario.doctorCount, 1);
    assert.equal(board.summary.byEmploymentType.estatutario.totalDueAmount, 0);
    assert.equal(board.summary.byEmploymentType.pj.doctorCount, 0);
});

test("buildAdminExtraPayableShift marca plantão extra verde com unidade cheia", () => {
    const extra = buildAdminExtraPayableShift({
        id: "extra-1",
        doctorId: "doc-1",
        doctorName: "Syone de Jesus Feitosa",
        displayName: "Syone Feitosa",
        operationalDate: "2026-04-14",
        shiftLabel: "SD",
        label: "EXTRA",
    });

    assert.equal(extra.source, "admin_extra");
    assert.equal(extra.payableShiftId, "extra:extra-1");
    assert.equal(extra.occupancyId, "extra:extra-1");
    assert.equal(extra.tagCode, "EXTRA");
    assert.equal(extra.targetCode, "EXTRA");
    assert.equal(extra.operationalDate, "2026-04-14");
    assert.equal(extra.shiftLabel, "SD");
    assert.equal(extra.paymentUnit, 1);
    assert.equal(extra.paymentStatus, "ready_for_payment");
    // SD começa 06:00 local (09:00Z) e dura 12h.
    assert.equal(extra.slotStartedAt, "2026-04-14T09:00:00.000Z");
    assert.equal(extra.slotEndedAt, "2026-04-14T21:00:00.000Z");
});

test("buildAdminExtraPayableShift usa rótulo padrão EXTRA e slot noturno", () => {
    const extra = buildAdminExtraPayableShift({
        id: "extra-2",
        doctorId: "doc-1",
        doctorName: "Syone de Jesus Feitosa",
        displayName: null,
        operationalDate: "2026-04-14",
        shiftLabel: "SN",
        label: null,
    });

    assert.equal(extra.tagCode, "EXTRA");
    // SN começa 18:00 local (21:00Z).
    assert.equal(extra.slotStartedAt, "2026-04-14T21:00:00.000Z");
    assert.equal(extra.slotEndedAt, "2026-04-15T09:00:00.000Z");
});

test("plantão extra entra no board, na coluna do dia e no total a pagar", () => {
    const extra = buildAdminExtraPayableShift({
        id: "extra-3",
        doctorId: "doc-x",
        doctorName: "Dra. Exemplo",
        displayName: null,
        operationalDate: "2026-04-15",
        shiftLabel: "SD",
        label: "EXTRA",
    });

    const board = buildChiefPayableBoard({
        monthKey: "2026-04",
        monthLabel: "abril de 2026",
        presetMonths: [{ key: "2026-04", label: "abril de 2026" }],
        rangeStartIso: "2026-04-01T10:00:00.000Z",
        rangeEndIso: "2026-05-01T10:00:00.000Z",
        payableShifts: [extra],
        disabledTargets: [],
        uncoveredTargets: [],
        targetOptions: [],
        attestationSegments: [],
        allDoctorNames: [],
        doctorPaymentProfiles: { "doc-x": "generalist" },
    });

    const doctor = board.doctors.find((entry) => entry.doctorId === "doc-x");
    assert.ok(doctor);
    assert.equal(doctor?.total, 1);
    assert.equal(doctor?.totalSD, 1);
    // dia 15, tarifa dia útil de generalista.
    assert.equal(doctor?.totalDue, 1244.87);
    const cell = doctor?.cells.find((entry) => entry.day === "15");
    assert.equal(cell?.shifts.length, 1);
    assert.equal(cell?.shifts[0]?.source, "admin_extra");
});

import assert from "node:assert/strict";
import test from "node:test";
import {
    buildPaymentAllocationBoardModel,
    type PaymentAllocationRawRow,
    type PaymentAllocationTargetDefinition,
} from "@/services/board.service";

function makeTarget(overrides: Partial<PaymentAllocationTargetDefinition> = {}): PaymentAllocationTargetDefinition {
    return {
        domain: "intervention",
        targetCode: "PM04",
        targetLabel: "Base PM04",
        sortOrder: 4,
        defaultRole: null,
        ...overrides,
    };
}

function makeRow(overrides: Partial<PaymentAllocationRawRow> = {}): PaymentAllocationRawRow {
    return {
        occupancyId: "occ-1",
        domain: "intervention",
        targetCode: "PM04",
        targetLabel: "Base PM04",
        doctorId: "doc-1",
        doctorName: "Ana Souza",
        displayName: "Ana",
        startedAt: "2026-03-28T10:00:00.000Z",
        boardStartedAt: "2026-03-28T10:00:00.000Z",
        endedAt: "2026-03-28T22:00:00.000Z",
        actualEndedAt: "2026-03-28T22:00:00.000Z",
        scheduledStartAt: "2026-03-28T10:00:00.000Z",
        scheduledEndAt: "2026-03-28T22:00:00.000Z",
        shiftLabel: "SD",
        roleLabel: null,
        ramalLabel: null,
        arrivalDelayMinutes: 0,
        overtimeMinutes: 0,
        creditedOvertimeMinutes: 0,
        balanceMinutes: 0,
        ruleCode: "ON_TIME_NO_OVERTIME",
        bankHoursExplanation: "ok",
        source: "telegram",
        notes: "PM04 Ana Souza 07:00",
        ...overrides,
    };
}

test("buildPaymentAllocationBoardModel chooses a primary candidate and flags target for review when there is conflict", () => {
    const board = buildPaymentAllocationBoardModel({
        targets: [makeTarget()],
        rawRows: [
            makeRow(),
            makeRow({
                occupancyId: "occ-2",
                doctorId: "doc-2",
                doctorName: "Bruno Lima",
                displayName: "Bruno",
                source: "admin_correction",
                startedAt: "2026-03-28T11:00:00.000Z",
                boardStartedAt: "2026-03-28T11:00:00.000Z",
                endedAt: null,
                actualEndedAt: null,
                scheduledStartAt: null,
                scheduledEndAt: null,
                notes: "PM04 Bruno Lima 08:00",
            }),
        ],
        operationalDate: "2026-03-28T15:00:00.000Z",
        shiftLabel: "SD",
        startedAt: "2026-03-28T10:00:00.000Z",
        endedAt: "2026-03-28T22:00:00.000Z",
        generatedAt: "2026-03-28T23:00:00.000Z",
    });

    assert.equal(board.summary.totalTargets, 1);
    assert.equal(board.intervention[0]?.doctorName, "Bruno Lima");
    assert.equal(board.intervention[0]?.candidateCount, 2);
    assert.equal(board.intervention[0]?.paymentStatus, "needs_review");
    assert.match(board.intervention[0]?.issues.join(" ") ?? "", /Mais de um medico candidato/i);
});

test("buildPaymentAllocationBoardModel keeps empty targets visible as review rows", () => {
    const board = buildPaymentAllocationBoardModel({
        targets: [
            makeTarget({ domain: "regulation", targetCode: "1367", targetLabel: "Ramal 1367", sortOrder: 7, defaultRole: "MALCON" }),
        ],
        rawRows: [],
        operationalDate: "2026-03-28T15:00:00.000Z",
        shiftLabel: "SD",
        startedAt: "2026-03-28T10:00:00.000Z",
        endedAt: "2026-03-28T22:00:00.000Z",
        generatedAt: "2026-03-28T23:00:00.000Z",
    });

    assert.equal(board.summary.unassignedCount, 1);
    assert.equal(board.regulation[0]?.occupancyId, null);
    assert.equal(board.regulation[0]?.paymentStatus, "needs_review");
    assert.match(board.regulation[0]?.issues[0] ?? "", /Sem ocupacao identificada/);
});

test("buildPaymentAllocationBoardModel carries explicit P arrival into the next shift payment slot", () => {
    const board = buildPaymentAllocationBoardModel({
        targets: [makeTarget()],
        rawRows: [makeRow({
            shiftLabel: "P",
            startedAt: "2026-03-28T10:00:00.000Z",
            boardStartedAt: "2026-03-28T10:00:00.000Z",
            endedAt: null,
            actualEndedAt: null,
            scheduledStartAt: "2026-03-28T10:00:00.000Z",
            scheduledEndAt: "2026-03-29T10:00:00.000Z",
        })],
        operationalDate: "2026-03-28T15:00:00.000Z",
        shiftLabel: "SN",
        startedAt: "2026-03-28T22:00:00.000Z",
        endedAt: "2026-03-29T10:00:00.000Z",
        generatedAt: "2026-03-29T00:00:00.000Z",
    });

    assert.equal(board.intervention[0]?.doctorName, "Ana Souza");
    assert.equal(board.intervention[0]?.shiftLabel, "SN");
    assert.equal(board.intervention[0]?.startedAt, "2026-03-28T22:00:00.000Z");
    assert.equal(board.intervention[0]?.scheduledStartAt, "2026-03-28T22:00:00.000Z");
    assert.equal(board.intervention[0]?.scheduledEndAt, "2026-03-29T10:00:00.000Z");
    assert.equal(board.intervention[0]?.paymentStatus, "needs_review");
    assert.match(board.intervention[0]?.issues.join(" ") ?? "", /sem saida consolidada/i);
});

test("buildPaymentAllocationBoardModel prefers the explicit starter of the current slot over a carried predecessor", () => {
    const board = buildPaymentAllocationBoardModel({
        targets: [makeTarget({ targetCode: "IT30", targetLabel: "IT30", sortOrder: 30 })],
        rawRows: [
            makeRow({
                occupancyId: "occ-prev",
                targetCode: "IT30",
                targetLabel: "IT30",
                doctorId: "doc-prev",
                doctorName: "João Santana",
                displayName: "João Santana",
                startedAt: "2026-03-27T10:18:21.000Z",
                boardStartedAt: "2026-03-27T22:00:00.000Z",
                endedAt: "2026-03-28T10:13:13.000Z",
                actualEndedAt: "2026-03-28T10:13:13.000Z",
                scheduledStartAt: "2026-03-27T10:00:00.000Z",
                scheduledEndAt: "2026-03-28T10:00:00.000Z",
                shiftLabel: "P",
                notes: "Continua P",
            }),
            makeRow({
                occupancyId: "occ-current",
                targetCode: "IT30",
                targetLabel: "IT30",
                doctorId: "doc-current",
                doctorName: "Marcio Pina",
                displayName: "Marcio Pina",
                startedAt: "2026-03-28T10:13:13.000Z",
                boardStartedAt: "2026-03-28T10:13:13.000Z",
                endedAt: null,
                actualEndedAt: null,
                scheduledStartAt: "2026-03-28T10:00:00.000Z",
                scheduledEndAt: "2026-03-28T22:00:00.000Z",
                shiftLabel: "SD",
                notes: "Marcio Pina IT30 SD",
            }),
        ],
        operationalDate: "2026-03-28T15:00:00.000Z",
        shiftLabel: "SD",
        startedAt: "2026-03-28T10:00:00.000Z",
        endedAt: "2026-03-28T22:00:00.000Z",
        generatedAt: "2026-03-28T23:00:00.000Z",
    });

    assert.equal(board.intervention[0]?.doctorName, "Marcio Pina");
    assert.equal(board.intervention[0]?.candidateCount, 1);
    assert.equal(board.intervention[0]?.paymentStatus, "ready_for_payment");
    assert.equal(board.intervention[0]?.issues.length, 0);
});

test("buildPaymentAllocationBoardModel anchors explicit P arrivals to the shift where they actually started", () => {
    const board = buildPaymentAllocationBoardModel({
        targets: [makeTarget({ targetCode: "CN10", targetLabel: "CN10", sortOrder: 10 })],
        rawRows: [
            makeRow({
                occupancyId: "occ-prev",
                targetCode: "CN10",
                targetLabel: "CN10",
                doctorId: "doc-prev",
                doctorName: "Gustavo Bazin Vieira Mauchle",
                displayName: "Gustavo Mauchle",
                startedAt: "2026-03-27T10:05:36.000Z",
                boardStartedAt: "2026-03-27T22:00:00.000Z",
                endedAt: "2026-03-28T10:01:54.000Z",
                actualEndedAt: "2026-03-28T10:15:00.000Z",
                scheduledStartAt: "2026-03-27T10:00:00.000Z",
                scheduledEndAt: "2026-03-28T10:00:00.000Z",
                shiftLabel: "P",
                notes: "Continuar",
            }),
            makeRow({
                occupancyId: "occ-current",
                targetCode: "CN10",
                targetLabel: "CN10",
                doctorId: "doc-current",
                doctorName: "João Victor Simões Castro Perrone",
                displayName: "João Perrone",
                startedAt: "2026-03-28T10:01:54.000Z",
                boardStartedAt: "2026-03-28T22:00:00.000Z",
                endedAt: null,
                actualEndedAt: null,
                scheduledStartAt: "2026-03-28T10:00:00.000Z",
                scheduledEndAt: "2026-03-29T10:00:00.000Z",
                shiftLabel: "P",
                notes: "Tinha avisado P",
            }),
        ],
        operationalDate: "2026-03-28T15:00:00.000Z",
        shiftLabel: "SD",
        startedAt: "2026-03-28T10:00:00.000Z",
        endedAt: "2026-03-28T22:00:00.000Z",
        generatedAt: "2026-03-28T23:00:00.000Z",
    });

    assert.equal(board.intervention[0]?.doctorName, "João Victor Simões Castro Perrone");
    assert.equal(board.intervention[0]?.startedAt, "2026-03-28T10:01:54.000Z");
    assert.equal(board.intervention[0]?.sourceShiftLabel, "P");
    assert.equal(board.intervention[0]?.continuesBeyondShift, true);
});

test("buildPaymentAllocationBoardModel does not carry an intervention P into a third payable shift without a current-slot starter", () => {
    const board = buildPaymentAllocationBoardModel({
        targets: [makeTarget({ targetCode: "PM04", targetLabel: "PM04", sortOrder: 4 })],
        rawRows: [
            makeRow({
                occupancyId: "occ-prev",
                targetCode: "PM04",
                targetLabel: "PM04",
                doctorId: "doc-karla",
                doctorName: "Karla Santos Pinto",
                displayName: "Karla Pinto",
                startedAt: "2026-03-27T11:32:00.000Z",
                boardStartedAt: "2026-03-27T22:00:00.000Z",
                endedAt: "2026-03-28T12:35:22.000Z",
                actualEndedAt: "2026-03-28T12:35:22.000Z",
                scheduledStartAt: "2026-03-27T10:00:00.000Z",
                scheduledEndAt: "2026-03-28T10:00:00.000Z",
                shiftLabel: "P",
                notes: "Continua P",
            }),
        ],
        operationalDate: "2026-03-28T15:00:00.000Z",
        shiftLabel: "SD",
        startedAt: "2026-03-28T10:00:00.000Z",
        endedAt: "2026-03-28T22:00:00.000Z",
        generatedAt: "2026-03-28T23:00:00.000Z",
    });

    assert.equal(board.intervention[0]?.occupancyId, null);
    assert.equal(board.intervention[0]?.doctorName, null);
    assert.equal(board.intervention[0]?.candidateCount, 0);
    assert.equal(board.intervention[0]?.paymentStatus, "needs_review");
    assert.match(board.intervention[0]?.issues[0] ?? "", /Sem ocupacao identificada/i);
});

test("buildPaymentAllocationBoardModel keeps one allocation per doctor in the same slot and prefers the stronger target", () => {
    const board = buildPaymentAllocationBoardModel({
        targets: [
            makeTarget({
                domain: "regulation",
                targetCode: "1365",
                targetLabel: "Ramal 1365",
                sortOrder: 65,
                defaultRole: "MALCON",
            }),
            makeTarget({
                targetCode: "PP20",
                targetLabel: "PP20",
                sortOrder: 20,
            }),
        ],
        rawRows: [
            makeRow({
                domain: "regulation",
                targetCode: "1365",
                targetLabel: "Ramal 1365",
                doctorId: "doc-uenderson",
                doctorName: "Uenderson Araujo Barbosa",
                displayName: "Uenderson Barbosa",
                startedAt: "2026-03-24T23:18:00.000Z",
                boardStartedAt: "2026-03-24T23:18:00.000Z",
                endedAt: "2026-03-25T10:15:00.000Z",
                actualEndedAt: "2026-03-25T10:15:00.000Z",
                scheduledStartAt: "2026-03-24T22:00:00.000Z",
                scheduledEndAt: "2026-03-25T10:00:00.000Z",
                shiftLabel: "SN",
                notes: "Uenderson 1365 SN",
                source: "telegram",
            }),
            makeRow({
                occupancyId: "occ-import",
                targetCode: "PP20",
                targetLabel: "PP20",
                doctorId: "doc-uenderson",
                doctorName: "Uenderson Araujo Barbosa",
                displayName: "Uenderson Barbosa",
                startedAt: "2026-03-24T23:57:54.000Z",
                boardStartedAt: "2026-03-24T23:57:54.000Z",
                endedAt: "2026-03-25T05:40:57.000Z",
                actualEndedAt: "2026-03-25T05:40:57.000Z",
                scheduledStartAt: "2026-03-24T22:00:00.000Z",
                scheduledEndAt: "2026-03-25T10:00:00.000Z",
                shiftLabel: "SN",
                notes: "Imported from legacy shift_current_state",
                source: "import",
            }),
        ],
        operationalDate: "2026-03-24T12:00:00.000Z",
        shiftLabel: "SN",
        startedAt: "2026-03-24T22:00:00.000Z",
        endedAt: "2026-03-25T10:00:00.000Z",
        generatedAt: "2026-03-25T12:00:00.000Z",
    });

    assert.equal(board.regulation[0]?.doctorName, "Uenderson Araujo Barbosa");
    assert.equal(board.regulation[0]?.paymentStatus, "ready_for_payment");
    assert.equal(board.intervention[0]?.occupancyId, null);
    assert.equal(board.intervention[0]?.candidateCount, 1);
    assert.equal(board.intervention[0]?.paymentStatus, "needs_review");
    assert.match(board.intervention[0]?.issues.join(" ") ?? "", /conflitam com alocacoes mais confiaveis/i);
});
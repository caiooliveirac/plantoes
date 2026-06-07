import assert from "node:assert/strict";
import test from "node:test";
import type { BankHoursBalanceOverrideSummary } from "@/modules/bank-hours/service";
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
        continuityGroupId: "cg-1",
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
        createdAt: "2026-03-28T10:00:00.000Z",
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

test("buildPaymentAllocationBoardModel inclui titular e sombra como linhas pagaveis no mesmo alvo", () => {
    const board = buildPaymentAllocationBoardModel({
        targets: [makeTarget({ targetCode: "PM40", targetLabel: "PM40", sortOrder: 40 })],
        rawRows: [
            makeRow({
                occupancyId: "occ-titular",
                targetCode: "PM40",
                targetLabel: "PM40",
                doctorId: "doc-titular",
                doctorName: "Titular PM40",
                displayName: "Titular",
                startedAt: "2026-04-28T10:00:00.000Z",
                boardStartedAt: "2026-04-28T10:00:00.000Z",
                endedAt: "2026-04-28T22:00:00.000Z",
                actualEndedAt: "2026-04-28T22:00:00.000Z",
                scheduledStartAt: "2026-04-28T10:00:00.000Z",
                scheduledEndAt: "2026-04-28T22:00:00.000Z",
                notes: "Titular PM40 07:00",
            }),
            makeRow({
                occupancyId: "occ-shadow",
                targetCode: "PM40",
                targetLabel: "PM40",
                doctorId: "doc-leonardo",
                doctorName: "Leonardo Prado Faben",
                displayName: "Leonardo",
                startedAt: "2026-04-28T10:10:00.000Z",
                boardStartedAt: null,
                endedAt: "2026-04-28T22:00:00.000Z",
                actualEndedAt: "2026-04-28T22:00:00.000Z",
                scheduledStartAt: "2026-04-28T10:00:00.000Z",
                scheduledEndAt: "2026-04-28T22:00:00.000Z",
                notes: "[telegram sombra] Leonardo Prado Faben PM40 07:10 sombra",
            }),
        ],
        operationalDate: "2026-04-28T12:00:00.000Z",
        shiftLabel: "SD",
        startedAt: "2026-04-28T10:00:00.000Z",
        endedAt: "2026-04-28T22:00:00.000Z",
        generatedAt: "2026-04-28T23:00:00.000Z",
    });

    const pm40Rows = board.intervention.filter((row) => row.targetCode === "PM40" && row.occupancyId);
    assert.equal(pm40Rows.length, 2);
    assert.deepEqual(pm40Rows.map((row) => row.doctorName).sort(), ["Leonardo Prado Faben", "Titular PM40"]);
});

test("buildPaymentAllocationBoardModel inclui sombra aberta no mesmo alvo quando o titular tambem esta aberto", () => {
    const board = buildPaymentAllocationBoardModel({
        targets: [makeTarget({ targetCode: "PM40", targetLabel: "PM40", sortOrder: 40 })],
        rawRows: [
            makeRow({
                occupancyId: "occ-shadow-open",
                targetCode: "PM40",
                targetLabel: "PM40",
                doctorId: "doc-leonardo",
                doctorName: "Leonardo Prado Faben",
                displayName: "Leonardo",
                startedAt: "2026-04-28T10:14:00.000Z",
                boardStartedAt: null,
                endedAt: null,
                actualEndedAt: null,
                scheduledStartAt: "2026-04-28T10:00:00.000Z",
                scheduledEndAt: "2026-04-28T22:00:00.000Z",
                source: "telegram",
                notes: "[telegram sombra] Leonardo Prado sombra PM40 07:14\n[telegram sombra] Leonardo Prado Faben PM40 sombra 07:14",
            }),
            makeRow({
                occupancyId: "occ-titular-open",
                targetCode: "PM40",
                targetLabel: "PM40",
                doctorId: "doc-karen",
                doctorName: "Karen Seifarth Miranda",
                displayName: "Karen Seifarth",
                startedAt: "2026-04-28T10:16:12.000Z",
                boardStartedAt: "2026-04-28T10:16:12.000Z",
                endedAt: null,
                actualEndedAt: null,
                scheduledStartAt: "2026-04-28T10:00:00.000Z",
                scheduledEndAt: "2026-04-28T22:00:00.000Z",
                source: "telegram",
                notes: "Karen Seifarth Miranda chegada pm40",
            }),
        ],
        operationalDate: "2026-04-28T12:00:00.000Z",
        shiftLabel: "SD",
        startedAt: "2026-04-28T10:00:00.000Z",
        endedAt: "2026-04-28T22:00:00.000Z",
        generatedAt: "2026-04-28T13:00:00.000Z",
    });

    const pm40Rows = board.intervention.filter((row) => row.targetCode === "PM40" && row.occupancyId);
    assert.equal(pm40Rows.length, 2);
    assert.deepEqual(pm40Rows.map((row) => row.doctorName).sort(), ["Karen Seifarth Miranda", "Leonardo Prado Faben"]);
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


test("buildPaymentAllocationBoardModel excludes bases desativadas o turno inteiro from payable totals", () => {
    const board = buildPaymentAllocationBoardModel({
        targets: [makeTarget({
            targetCode: "PP20",
            targetLabel: "PP20",
            sortOrder: 20,
            disabledAt: "2026-03-28T08:30:00.000Z",
            disabledReason: "USA recolhida",
            disabledDuringShift: true,
            disabledEntireShift: true,
        })],
        rawRows: [],
        operationalDate: "2026-03-28T15:00:00.000Z",
        shiftLabel: "SD",
        startedAt: "2026-03-28T10:00:00.000Z",
        endedAt: "2026-03-28T22:00:00.000Z",
        generatedAt: "2026-03-28T23:00:00.000Z",
    });

    assert.equal(board.summary.totalTargets, 0);
    assert.equal(board.summary.unassignedCount, 0);
    assert.equal(board.summary.disabledCount, 1);
    assert.equal(board.intervention[0]?.disabledEntireShift, true);
    assert.equal(board.intervention[0]?.paymentStatus, "ready_for_payment");
});

test("buildPaymentAllocationBoardModel clears disabled state when arrival happens after reactivation", () => {
    const board = buildPaymentAllocationBoardModel({
        targets: [makeTarget({
            targetCode: "PP30",
            targetLabel: "PP30",
            sortOrder: 30,
            disabledAt: "2026-03-28T08:30:00.000Z",
            reactivatedAt: "2026-03-28T10:05:00.000Z",
            disabledReason: "Manutencao",
            disabledDuringShift: true,
            disabledEntireShift: false,
        })],
        rawRows: [makeRow({
            targetCode: "PP30",
            targetLabel: "PP30",
            startedAt: "2026-03-28T10:05:00.000Z",
            boardStartedAt: "2026-03-28T10:05:00.000Z",
            endedAt: null,
            actualEndedAt: null,
            scheduledStartAt: "2026-03-28T10:00:00.000Z",
            scheduledEndAt: "2026-03-28T22:00:00.000Z",
            notes: "PP30 Ana Souza 07:00",
        })],
        operationalDate: "2026-03-28T15:00:00.000Z",
        shiftLabel: "SD",
        startedAt: "2026-03-28T10:00:00.000Z",
        endedAt: "2026-03-28T22:00:00.000Z",
        generatedAt: "2026-03-28T23:00:00.000Z",
    });

    assert.equal(board.summary.totalTargets, 1);
    assert.equal(board.summary.disabledCount, 0);
    assert.equal(board.intervention[0]?.occupancyId, "occ-1");
    assert.equal(board.intervention[0]?.doctorName, "Ana Souza");
    assert.equal(board.intervention[0]?.disabledDuringShift, false);
});

test("buildPaymentAllocationBoardModel suppresses payable occupancy when deactivation happens later in the slot", () => {
    const board = buildPaymentAllocationBoardModel({
        targets: [makeTarget({
            targetCode: "CN10",
            targetLabel: "CN10",
            sortOrder: 10,
            disabledAt: "2026-03-28T12:12:00.000Z",
            disabledReason: "Base recolhida",
            disabledDuringShift: true,
            disabledEntireShift: false,
        })],
        rawRows: [makeRow({
            targetCode: "CN10",
            targetLabel: "CN10",
            startedAt: "2026-03-28T10:03:28.000Z",
            boardStartedAt: "2026-03-28T10:03:28.000Z",
            endedAt: "2026-03-28T11:15:11.000Z",
            actualEndedAt: "2026-03-28T11:15:11.000Z",
            scheduledStartAt: "2026-03-28T10:00:00.000Z",
            scheduledEndAt: "2026-03-28T22:00:00.000Z",
            notes: "CN10 Cecilia 07:00",
        })],
        operationalDate: "2026-03-28T15:00:00.000Z",
        shiftLabel: "SD",
        startedAt: "2026-03-28T10:00:00.000Z",
        endedAt: "2026-03-28T22:00:00.000Z",
        generatedAt: "2026-03-28T23:00:00.000Z",
    });

    assert.equal(board.summary.totalTargets, 0);
    assert.equal(board.summary.disabledCount, 1);
    assert.equal(board.intervention[0]?.occupancyId, null);
    assert.equal(board.intervention[0]?.doctorName, null);
    assert.equal(board.intervention[0]?.disabledDuringShift, true);
});

test("buildPaymentAllocationBoardModel conta ramal desativado como categoria propria na regulacao", () => {
    const board = buildPaymentAllocationBoardModel({
        targets: [makeTarget({
            domain: "regulation",
            targetCode: "1367",
            targetLabel: "1367",
            sortOrder: 7,
            defaultRole: "MR",
            disabledAt: "2026-03-28T08:30:00.000Z",
            disabledReason: "Sem linha telefonica",
            disabledDuringShift: true,
            disabledEntireShift: true,
        })],
        rawRows: [],
        operationalDate: "2026-03-28T15:00:00.000Z",
        shiftLabel: "SD",
        startedAt: "2026-03-28T10:00:00.000Z",
        endedAt: "2026-03-28T22:00:00.000Z",
        generatedAt: "2026-03-28T23:00:00.000Z",
    });

    assert.equal(board.summary.totalTargets, 0);
    assert.equal(board.summary.disabledCount, 1);
    assert.equal(board.regulation[0]?.disabledEntireShift, true);
    assert.equal(board.regulation[0]?.paymentStatus, "ready_for_payment");
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

test("buildPaymentAllocationBoardModel ignores stale scheduled start from a previous day when classifying the current SN slot", () => {
    const board = buildPaymentAllocationBoardModel({
        targets: [makeTarget({ targetCode: "PM40", targetLabel: "PM40", sortOrder: 40 })],
        rawRows: [makeRow({
            targetCode: "PM40",
            targetLabel: "PM40",
            startedAt: "2026-03-28T21:57:56.000Z",
            boardStartedAt: "2026-03-28T21:57:56.000Z",
            endedAt: "2026-03-29T10:27:29.000Z",
            actualEndedAt: "2026-03-29T10:27:29.000Z",
            scheduledStartAt: "2026-03-27T22:00:00.000Z",
            scheduledEndAt: "2026-03-28T10:00:00.000Z",
            shiftLabel: "SN",
            notes: "Saindo liberado pela chefia",
        })],
        operationalDate: "2026-03-28T15:00:00.000Z",
        shiftLabel: "SN",
        startedAt: "2026-03-28T22:00:00.000Z",
        endedAt: "2026-03-29T10:00:00.000Z",
        generatedAt: "2026-03-29T00:00:00.000Z",
    });

    assert.equal(board.intervention[0]?.doctorName, "Ana Souza");
    assert.equal(board.intervention[0]?.occupancyId, "occ-1");
    assert.equal(board.intervention[0]?.startedAt, "2026-03-28T22:00:00.000Z");
    assert.equal(board.intervention[0]?.scheduledStartAt, "2026-03-28T22:00:00.000Z");
    assert.equal(board.intervention[0]?.paymentStatus, "ready_for_payment");
});

test("buildPaymentAllocationBoardModel applies a manual bank override to the payable row", () => {
    const overrides = new Map<string, BankHoursBalanceOverrideSummary>([["cg-1", {
        continuityGroupId: "cg-1",
        doctorId: "doc-1",
        balanceMinutes: 0,
        notes: "Plantao sem direito a banco.",
        createdByUserId: null,
        updatedByUserId: null,
        createdAt: new Date("2026-03-29T12:00:00.000Z"),
        updatedAt: new Date("2026-03-29T12:00:00.000Z"),
    }]]);

    const board = buildPaymentAllocationBoardModel({
        targets: [makeTarget()],
        rawRows: [makeRow({
            balanceMinutes: 40,
            ruleCode: "ON_TIME_DOUBLE_OVERTIME",
            bankHoursExplanation: "Credito automatico em dobro.",
        })],
        operationalDate: "2026-03-28T15:00:00.000Z",
        shiftLabel: "SD",
        startedAt: "2026-03-28T10:00:00.000Z",
        endedAt: "2026-03-28T22:00:00.000Z",
        bankHoursBalanceOverridesByContinuityGroupId: overrides,
        generatedAt: "2026-03-28T23:00:00.000Z",
    });

    assert.equal(board.intervention[0]?.balanceMinutes, 0);
    assert.equal(board.intervention[0]?.ruleCode, "MANUAL_BANK_OVERRIDE");
    assert.match(board.intervention[0]?.bankHoursExplanation ?? "", /sem direito a banco/i);
});

test("buildPaymentAllocationBoardModel prefers the open duplicate when the same doctor was accidentally closed and relaunched at the same start time", () => {
    const board = buildPaymentAllocationBoardModel({
        targets: [makeTarget({ domain: "regulation", targetCode: "2031", targetLabel: "Ramal 2031", sortOrder: 31, defaultRole: null })],
        rawRows: [
            makeRow({
                occupancyId: "occ-closed",
                domain: "regulation",
                targetCode: "2031",
                targetLabel: "Ramal 2031",
                startedAt: "2026-03-29T10:00:00.000Z",
                boardStartedAt: "2026-03-29T10:00:00.000Z",
                endedAt: "2026-03-29T14:38:42.000Z",
                actualEndedAt: "2026-03-29T14:38:42.000Z",
                scheduledStartAt: "2026-03-29T10:00:00.000Z",
                scheduledEndAt: "2026-03-30T10:15:00.000Z",
                shiftLabel: "P",
                ramalLabel: "2031",
                notes: "Felipe Carvalho 2031 06:59 P",
            }),
            makeRow({
                occupancyId: "occ-open",
                domain: "regulation",
                targetCode: "2031",
                targetLabel: "Ramal 2031",
                startedAt: "2026-03-29T10:00:00.000Z",
                boardStartedAt: "2026-03-29T10:00:00.000Z",
                endedAt: null,
                actualEndedAt: null,
                scheduledStartAt: "2026-03-29T10:00:00.000Z",
                scheduledEndAt: "2026-03-30T10:15:00.000Z",
                shiftLabel: "P",
                ramalLabel: "2031",
                notes: "Felipe Carvalho 2031 06:59 P",
            }),
        ],
        operationalDate: "2026-03-29T15:00:00.000Z",
        shiftLabel: "SD",
        startedAt: "2026-03-29T10:00:00.000Z",
        endedAt: "2026-03-29T22:00:00.000Z",
        generatedAt: "2026-03-29T15:00:00.000Z",
    });

    assert.equal(board.regulation[0]?.occupancyId, "occ-open");
    assert.equal(board.regulation[0]?.endedAt, null);
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

test("buildPaymentAllocationBoardModel reuses the first arrival from the continuity group even when the next shift moved to another target", () => {
    const board = buildPaymentAllocationBoardModel({
        targets: [makeTarget({ targetCode: "2154", targetLabel: "2154", sortOrder: 54, domain: "regulation", defaultRole: "MR" })],
        rawRows: [
            makeRow({
                occupancyId: "occ-sd",
                domain: "intervention",
                targetCode: "PM40",
                targetLabel: "PM40",
                doctorId: "doc-matheus",
                doctorName: "Matheus Henrique Quezado Cordeiro",
                displayName: "Matheus Quezado",
                startedAt: "2026-03-28T10:06:00.000Z",
                boardStartedAt: "2026-03-28T10:06:00.000Z",
                endedAt: "2026-03-28T22:25:14.000Z",
                actualEndedAt: "2026-03-28T22:25:14.000Z",
                scheduledStartAt: "2026-03-28T10:00:00.000Z",
                scheduledEndAt: "2026-03-28T22:00:00.000Z",
                continuityGroupId: "cg-matheus",
                shiftLabel: "SD",
                notes: "Matheus Quezado PM40 SD",
            }),
            makeRow({
                occupancyId: "occ-sn",
                domain: "regulation",
                targetCode: "2154",
                targetLabel: "2154",
                doctorId: "doc-matheus",
                doctorName: "Matheus Henrique Quezado Cordeiro",
                displayName: "Matheus Quezado",
                startedAt: "2026-03-28T22:25:14.000Z",
                boardStartedAt: "2026-03-28T22:25:14.000Z",
                endedAt: "2026-03-29T10:36:00.000Z",
                actualEndedAt: "2026-03-29T10:36:00.000Z",
                scheduledStartAt: "2026-03-28T22:00:00.000Z",
                scheduledEndAt: "2026-03-29T10:15:00.000Z",
                continuityGroupId: "cg-matheus",
                shiftLabel: "SN",
                roleLabel: "MR",
                ramalLabel: "2154",
                notes: "Matheus Quezado 2154 continuando SN",
            }),
        ],
        operationalDate: "2026-03-28T12:00:00.000Z",
        shiftLabel: "SN",
        startedAt: "2026-03-28T22:00:00.000Z",
        endedAt: "2026-03-29T10:00:00.000Z",
        generatedAt: "2026-03-29T12:00:00.000Z",
    });

    assert.equal(board.regulation[0]?.doctorName, "Matheus Henrique Quezado Cordeiro");
    assert.equal(board.regulation[0]?.sourceShiftLabel, "P");
    assert.equal(board.regulation[0]?.sourceStartedAt, "2026-03-28T10:06:00.000Z");
    assert.equal(board.regulation[0]?.sourceScheduledStartAt, "2026-03-28T10:00:00.000Z");
    assert.equal(board.regulation[0]?.sourceScheduledEndAt, "2026-03-29T10:00:00.000Z");
    assert.equal(board.regulation[0]?.sourceActualEndedAt, "2026-03-29T10:36:00.000Z");
    assert.equal(board.regulation[0]?.sourceBalanceMinutes, 72);
});

test("buildPaymentAllocationBoardModel excludes nucleo from SN payment allocation", () => {
    const board = buildPaymentAllocationBoardModel({
        targets: [makeTarget({
            domain: "regulation",
            targetCode: "NUCLEO",
            targetLabel: "Núcleo",
            sortOrder: 250,
            defaultRole: null,
        })],
        rawRows: [],
        operationalDate: "2026-03-28T15:00:00.000Z",
        shiftLabel: "SN",
        startedAt: "2026-03-28T22:00:00.000Z",
        endedAt: "2026-03-29T10:00:00.000Z",
        generatedAt: "2026-03-29T12:00:00.000Z",
    });

    assert.equal(board.summary.totalTargets, 0);
    assert.equal(board.regulation.length, 0);
});

test("buildPaymentAllocationBoardModel keeps nucleo on SD as remanejado when only previous-shift coverage exists", () => {
    const board = buildPaymentAllocationBoardModel({
        targets: [makeTarget({
            domain: "regulation",
            targetCode: "NUCLEO",
            targetLabel: "Núcleo",
            sortOrder: 250,
            defaultRole: null,
        })],
        rawRows: [
            makeRow({
                occupancyId: "occ-nucleo-prev",
                domain: "regulation",
                targetCode: "NUCLEO",
                targetLabel: "Núcleo",
                doctorId: "doc-prev",
                doctorName: "Médico do turno anterior",
                displayName: "Anterior",
                startedAt: "2026-03-27T22:00:00.000Z",
                boardStartedAt: "2026-03-27T22:00:00.000Z",
                endedAt: null,
                actualEndedAt: null,
                scheduledStartAt: "2026-03-27T22:00:00.000Z",
                scheduledEndAt: "2026-03-28T10:00:00.000Z",
                continuityGroupId: "cg-nucleo",
                shiftLabel: "P",
                ramalLabel: "NUCLEO",
                source: "telegram",
                notes: "Nucleo continuando sem novo titular",
            }),
        ],
        operationalDate: "2026-03-28T15:00:00.000Z",
        shiftLabel: "SD",
        startedAt: "2026-03-28T10:00:00.000Z",
        endedAt: "2026-03-28T22:00:00.000Z",
        generatedAt: "2026-03-28T23:00:00.000Z",
    });

    assert.equal(board.regulation[0]?.targetCode, "NUCLEO");
    assert.equal(board.regulation[0]?.occupancyId, null);
    assert.equal(board.regulation[0]?.doctorName, null);
    assert.equal(board.regulation[0]?.candidateCount, 0);
    assert.equal(board.regulation[0]?.paymentStatus, "needs_review");
    assert.match(board.regulation[0]?.issues.join(" ") ?? "", /REMANEJADO PARA CRU/i);
    assert.match(board.regulation[0]?.issues.join(" ") ?? "", /não pode reaproveitar o plantonista anterior/i);
});

test("buildPaymentAllocationBoardModel does not carry a regulation P without departure into the next SD due to regulation buffer", () => {
    // Briang scenario: P started at SD Apr 4, scheduledEndAt includes 15-min regulation buffer (07:15 local = 10:15 UTC).
    // Without departure, the P should NOT bleed into SD Apr 5 (starts at 10:00 UTC).
    const board = buildPaymentAllocationBoardModel({
        targets: [makeTarget({ domain: "regulation", targetCode: "2152", targetLabel: "Ramal 2152", sortOrder: 52, defaultRole: null })],
        rawRows: [
            makeRow({
                occupancyId: "occ-briang",
                domain: "regulation",
                targetCode: "2152",
                targetLabel: "Ramal 2152",
                doctorId: "doc-briang",
                doctorName: "Briang Aaron Manuel Seguir Ibarra",
                displayName: "Briang Ibarra",
                startedAt: "2026-04-04T11:02:00.000Z",
                boardStartedAt: "2026-04-04T11:02:00.000Z",
                endedAt: null,
                actualEndedAt: null,
                scheduledStartAt: "2026-04-04T10:00:00.000Z",
                scheduledEndAt: "2026-04-05T10:15:00.000Z",
                shiftLabel: "P",
                ramalLabel: "2152",
                notes: "Briang 2152 08:02 P",
            }),
        ],
        operationalDate: "2026-04-05T15:00:00.000Z",
        shiftLabel: "SD",
        startedAt: "2026-04-05T10:00:00.000Z",
        endedAt: "2026-04-05T22:00:00.000Z",
        generatedAt: "2026-04-05T15:00:00.000Z",
    });

    assert.equal(board.regulation[0]?.occupancyId, null);
    assert.equal(board.regulation[0]?.doctorName, null);
    assert.equal(board.regulation[0]?.candidateCount, 0);
    assert.match(board.regulation[0]?.issues[0] ?? "", /Sem ocupacao identificada/i);
});

test("buildPaymentAllocationBoardModel carries SN P-shift with no exit into the immediately following SD slot (boundary equality)", () => {
    // Guilherme scenario: doctor arrived in SN (e.g. 20:30 SP = 23:30 UTC), said "P"
    // (continues). The P-shift's implicitExpiry = 07:00 SP next day = exactly the SD
    // slot start. Must be included in the SD payment slot.
    const board = buildPaymentAllocationBoardModel({
        targets: [makeTarget({ targetCode: "PM40", targetLabel: "PM40", sortOrder: 40 })],
        rawRows: [makeRow({
            occupancyId: "occ-guilherme",
            targetCode: "PM40",
            targetLabel: "PM40",
            doctorId: "doc-guilherme",
            doctorName: "Guilherme Rabelo",
            displayName: "Guilherme Rabelo",
            // 20:30 SP April 11 = 23:30 UTC April 11 (arrived in SN)
            startedAt: "2026-04-11T23:30:00.000Z",
            boardStartedAt: "2026-04-11T23:30:00.000Z",
            endedAt: null,
            actualEndedAt: null,
            scheduledStartAt: "2026-04-11T22:00:00.000Z",
            scheduledEndAt: "2026-04-12T10:00:00.000Z",
            shiftLabel: "P",
            notes: "Guilherme PM40 P continua",
        })],
        // SD April 12: 07:00 SP = 10:00 UTC
        operationalDate: "2026-04-12T15:00:00.000Z",
        shiftLabel: "SD",
        startedAt: "2026-04-12T10:00:00.000Z",
        endedAt: "2026-04-12T22:00:00.000Z",
        generatedAt: "2026-04-12T12:00:00.000Z",
    });

    assert.equal(board.intervention[0]?.doctorName, "Guilherme Rabelo");
    assert.equal(board.intervention[0]?.occupancyId, "occ-guilherme");
    assert.match(board.intervention[0]?.issues.join(" ") ?? "", /sem saida consolidada/i);
});

test("buildPaymentAllocationBoardModel does not let a backdated telegram ghost truncate the displaced doctor (continuation-bug defense)", () => {
    // Reprodução do caso 26/04/2026 PR03: Taiane fez o SD legítimo (07:05-19:25).
    // O bot, ao processar "Caio continua PR03" às 20:03, criou um registro P com
    // started_at=07:10 (anchor da regulação 2153 do Caio), o que fazia o
    // resolveSuccessorStartMap encurtar a Taiane a 5 minutos e filtrá-la como
    // micro-cobertura. A defesa em profundidade (Frente 2) detecta a discrepância
    // created_at - started_at > 6h em registros telegram e ignora esse "fantasma"
    // como sucessor, preservando a duração real da Taiane.
    const board = buildPaymentAllocationBoardModel({
        targets: [makeTarget({ targetCode: "PR03", targetLabel: "PR03" })],
        rawRows: [
            makeRow({
                occupancyId: "occ-taiane",
                targetCode: "PR03",
                targetLabel: "PR03",
                doctorId: "doc-taiane",
                doctorName: "Taiane Pinto",
                displayName: "Taiane",
                startedAt: "2026-04-26T10:05:00.000Z", // 07:05 SP
                boardStartedAt: "2026-04-26T10:05:00.000Z",
                endedAt: "2026-04-26T22:25:00.000Z",   // 19:25 SP
                actualEndedAt: "2026-04-26T22:25:00.000Z",
                scheduledStartAt: "2026-04-26T10:00:00.000Z",
                scheduledEndAt: "2026-04-26T22:00:00.000Z",
                shiftLabel: "SD",
                source: "telegram",
                createdAt: "2026-04-26T10:05:40.000Z",
                notes: "Taiane Pinto pr03 sd",
            }),
            makeRow({
                occupancyId: "occ-caio-ghost",
                targetCode: "PR03",
                targetLabel: "PR03",
                doctorId: "doc-caio",
                doctorName: "Caio Oliveira",
                displayName: "Caio",
                // Backdated: started_at claims 07:10 SP, mas o registro foi
                // criado às 20:03 SP (gap > 6h → ghost telegram detectado).
                startedAt: "2026-04-26T10:10:00.000Z",
                boardStartedAt: "2026-04-26T10:10:00.000Z",
                endedAt: null,
                actualEndedAt: "2026-04-27T11:03:00.000Z",
                scheduledStartAt: "2026-04-26T10:00:00.000Z",
                scheduledEndAt: "2026-04-27T10:00:00.000Z",
                shiftLabel: "P",
                source: "telegram",
                createdAt: "2026-04-26T23:03:21.000Z", // 20:03 SP — 12,9h após started_at
                notes: "Caio continua PR03",
            }),
        ],
        operationalDate: "2026-04-26T15:00:00.000Z",
        shiftLabel: "SD",
        startedAt: "2026-04-26T10:00:00.000Z",
        endedAt: "2026-04-26T22:00:00.000Z",
        generatedAt: "2026-04-27T00:00:00.000Z",
    });

    // Taiane deve sobreviver como candidata real do PR03 SD. Sem a defesa, ela
    // seria filtrada como micro-cobertura (5 min) e o Caio ghost ganharia o slot.
    const taianeRow = board.intervention.find((row) => row.doctorName === "Taiane Pinto")
        ?? board.regulation.find((row) => row.doctorName === "Taiane Pinto");
    assert.ok(taianeRow, "Taiane deveria continuar na alocação de pagamento do PR03 SD");
});
// ---------------------------------------------------------------------------
// P noturno (continuidade) NÃO pode virar SD fantasma no dia seguinte quando o
// médico já tem um SD no mesmo dia. Caso real: Reinaldo SD@1368 + SN(P)@2033 na
// segunda gerava um SD@2033 fantasma na terça que deslocava o SD@1368 legítimo.
// ---------------------------------------------------------------------------

function makeRegRow(overrides: Partial<PaymentAllocationRawRow> = {}): PaymentAllocationRawRow {
    return makeRow({
        domain: "regulation",
        targetCode: "1368",
        targetLabel: "1368",
        ramalLabel: "1368",
        ...overrides,
    });
}

test("um P noturno NÃO cria SD fantasma no dia seguinte quando o médico já tem SD no mesmo dia", () => {
    const board = buildPaymentAllocationBoardModel({
        targets: [
            makeTarget({ domain: "regulation", targetCode: "1368", targetLabel: "1368", sortOrder: 1, defaultRole: "COI" }),
            makeTarget({ domain: "regulation", targetCode: "2033", targetLabel: "2033", sortOrder: 33 }),
        ],
        rawRows: [
            // SD da segunda na 1368 (bem registrado).
            makeRegRow({
                occupancyId: "occ-sd-1368",
                targetCode: "1368", targetLabel: "1368", ramalLabel: "1368",
                doctorId: "doc-reinaldo", doctorName: "Reinaldo Lima", displayName: "Reinaldo",
                startedAt: "2026-03-28T10:00:00.000Z",
                boardStartedAt: "2026-03-28T10:00:00.000Z",
                endedAt: "2026-03-28T22:00:00.000Z",
                actualEndedAt: "2026-03-28T22:00:00.000Z",
                scheduledStartAt: "2026-03-28T10:00:00.000Z",
                scheduledEndAt: "2026-03-28T22:00:00.000Z",
                shiftLabel: "SD",
                continuityGroupId: "cg-rei-sd",
                notes: "Reinaldo 1368 SD",
            }),
            // SN da segunda na 2033, avisada como continuidade (P), sem saída.
            makeRegRow({
                occupancyId: "occ-sn-2033",
                targetCode: "2033", targetLabel: "2033", ramalLabel: "2033",
                doctorId: "doc-reinaldo", doctorName: "Reinaldo Lima", displayName: "Reinaldo",
                startedAt: "2026-03-28T22:00:00.000Z",
                boardStartedAt: "2026-03-28T22:00:00.000Z",
                endedAt: null,
                actualEndedAt: null,
                scheduledStartAt: "2026-03-28T22:00:00.000Z",
                scheduledEndAt: "2026-03-29T10:00:00.000Z",
                shiftLabel: "P",
                continuityGroupId: "cg-rei-sn",
                notes: "Reinaldo continua 2033",
            }),
        ],
        // Board do SD de TERÇA (dia seguinte).
        operationalDate: "2026-03-29T15:00:00.000Z",
        shiftLabel: "SD",
        startedAt: "2026-03-29T10:00:00.000Z",
        endedAt: "2026-03-29T22:00:00.000Z",
        generatedAt: "2026-03-29T23:00:00.000Z",
    });

    const reinaldoRows = board.regulation.filter((row) => row.doctorName === "Reinaldo Lima");
    assert.equal(
        reinaldoRows.length,
        0,
        "Reinaldo não deveria aparecer no SD de terça (P da segunda à noite é continuidade do dia que já trabalhou)",
    );
});

test("um P noturno SEM SD no mesmo dia continua cobrindo o SD seguinte (forward legítimo)", () => {
    const board = buildPaymentAllocationBoardModel({
        targets: [
            makeTarget({ domain: "regulation", targetCode: "2033", targetLabel: "2033", sortOrder: 33 }),
        ],
        rawRows: [
            // Apenas a chegada noturna em P, sem nenhum SD na segunda.
            makeRegRow({
                occupancyId: "occ-sn-2033",
                targetCode: "2033", targetLabel: "2033", ramalLabel: "2033",
                doctorId: "doc-fresh", doctorName: "Carla Nunes", displayName: "Carla",
                startedAt: "2026-03-28T22:00:00.000Z",
                boardStartedAt: "2026-03-28T22:00:00.000Z",
                endedAt: null,
                actualEndedAt: null,
                scheduledStartAt: "2026-03-28T22:00:00.000Z",
                scheduledEndAt: "2026-03-29T10:00:00.000Z",
                shiftLabel: "P",
                continuityGroupId: "cg-carla",
                notes: "Carla P 2033",
            }),
        ],
        operationalDate: "2026-03-29T15:00:00.000Z",
        shiftLabel: "SD",
        startedAt: "2026-03-29T10:00:00.000Z",
        endedAt: "2026-03-29T22:00:00.000Z",
        generatedAt: "2026-03-29T23:00:00.000Z",
    });

    const carlaRow = board.regulation.find((row) => row.doctorName === "Carla Nunes");
    assert.ok(carlaRow, "Carla deveria continuar cobrindo o SD seguinte: P noturno sem SD no dia é forward legítimo");
    assert.equal(carlaRow?.targetCode, "2033");
});

test("o P noturno suprimido não desloca o SD real do médico em outro ramal", () => {
    // SD de terça: Reinaldo tem um SD real na 1368 (terça) e o resíduo do P da
    // segunda na 2033. O fantasma não pode roubar o doctorId e derrubar a 1368.
    const board = buildPaymentAllocationBoardModel({
        targets: [
            makeTarget({ domain: "regulation", targetCode: "1368", targetLabel: "1368", sortOrder: 1, defaultRole: "COI" }),
            makeTarget({ domain: "regulation", targetCode: "2033", targetLabel: "2033", sortOrder: 33 }),
        ],
        rawRows: [
            // SD da SEGUNDA na 1368 (gera o "tem SD no mesmo dia" para o P da segunda à noite).
            makeRegRow({
                occupancyId: "occ-sd-seg-1368",
                targetCode: "1368", targetLabel: "1368", ramalLabel: "1368",
                doctorId: "doc-reinaldo", doctorName: "Reinaldo Lima", displayName: "Reinaldo",
                startedAt: "2026-03-28T10:00:00.000Z",
                boardStartedAt: "2026-03-28T10:00:00.000Z",
                endedAt: "2026-03-28T22:00:00.000Z",
                actualEndedAt: "2026-03-28T22:00:00.000Z",
                scheduledStartAt: "2026-03-28T10:00:00.000Z",
                scheduledEndAt: "2026-03-28T22:00:00.000Z",
                shiftLabel: "SD",
                continuityGroupId: "cg-rei-seg-sd",
                notes: "Reinaldo 1368 SD segunda",
            }),
            // P da segunda à noite na 2033 (residual que carregaria para terça).
            makeRegRow({
                occupancyId: "occ-sn-seg-2033",
                targetCode: "2033", targetLabel: "2033", ramalLabel: "2033",
                doctorId: "doc-reinaldo", doctorName: "Reinaldo Lima", displayName: "Reinaldo",
                startedAt: "2026-03-28T22:00:00.000Z",
                boardStartedAt: "2026-03-28T22:00:00.000Z",
                endedAt: null,
                actualEndedAt: null,
                scheduledStartAt: "2026-03-28T22:00:00.000Z",
                scheduledEndAt: "2026-03-29T10:00:00.000Z",
                shiftLabel: "P",
                continuityGroupId: "cg-rei-seg-sn",
                notes: "Reinaldo continua 2033",
            }),
            // SD real de TERÇA na 1368.
            makeRegRow({
                occupancyId: "occ-sd-ter-1368",
                targetCode: "1368", targetLabel: "1368", ramalLabel: "1368",
                doctorId: "doc-reinaldo", doctorName: "Reinaldo Lima", displayName: "Reinaldo",
                startedAt: "2026-03-29T10:00:00.000Z",
                boardStartedAt: "2026-03-29T10:00:00.000Z",
                endedAt: "2026-03-29T22:00:00.000Z",
                actualEndedAt: "2026-03-29T22:00:00.000Z",
                scheduledStartAt: "2026-03-29T10:00:00.000Z",
                scheduledEndAt: "2026-03-29T22:00:00.000Z",
                shiftLabel: "SD",
                continuityGroupId: "cg-rei-ter-sd",
                notes: "Reinaldo 1368 SD terça",
            }),
        ],
        operationalDate: "2026-03-29T15:00:00.000Z",
        shiftLabel: "SD",
        startedAt: "2026-03-29T10:00:00.000Z",
        endedAt: "2026-03-29T22:00:00.000Z",
        generatedAt: "2026-03-29T23:00:00.000Z",
    });

    const row1368 = board.regulation.find((row) => row.targetCode === "1368");
    const row2033 = board.regulation.find((row) => row.targetCode === "2033");
    assert.equal(row1368?.doctorName, "Reinaldo Lima", "o SD real de terça na 1368 deve ser pago");
    assert.notEqual(row2033?.doctorName, "Reinaldo Lima", "a 2033 não deve receber o fantasma de terça");
});

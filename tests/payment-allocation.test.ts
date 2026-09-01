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
        earlyDepartureOutcome: null,
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

    // O vencedor (Bruno, admin_correction, prioridade de lock-in) fica na linha
    // principal do alvo — mas Ana (titular real, telegram) não pode desaparecer
    // sem rastro: ela ganha uma linha própria, também flagada needs_review pelo
    // mesmo conflito, pro chefe decidir quem de fato cobriu o alvo (caso Sadja
    // Costa vs Murilo Damasceno, CZ50, 14/08/2026 — ver board.service.ts,
    // buildAdditionalShadowPaymentAllocationRows).
    assert.equal(board.summary.totalTargets, 2);
    assert.equal(board.intervention[0]?.doctorName, "Bruno Lima");
    assert.equal(board.intervention[0]?.candidateCount, 2);
    assert.equal(board.intervention[0]?.paymentStatus, "needs_review");
    assert.match(board.intervention[0]?.issues.join(" ") ?? "", /Conflito entre medicos titulares/i);

    const anaRow = board.intervention.find((row) => row.doctorName === "Ana Souza");
    assert.ok(anaRow, "Ana nao pode desaparecer do pagamento so por ter perdido o conflito de alvo");
    assert.equal(anaRow?.paymentStatus, "needs_review");
    assert.match(anaRow?.issues.join(" ") ?? "", /Conflito entre medicos titulares/i);
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
    const titularRow = pm40Rows.find((row) => row.doctorName === "Titular PM40") ?? null;
    assert.equal(titularRow?.hasDoctorOverlapConflict, false);
    assert.equal(titularRow?.issues.some((issue) => /Conflito entre medicos titulares/i.test(issue)), false);
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

test("buildPaymentAllocationBoardModel does not carry SN P-shift into SD on boundary equality", () => {
    // A igualdade exata na fronteira (07:00) nao deve mais carregar cobertura para o
    // slot seguinte de pagamento. O plantao precisa cobrir tempo estritamente dentro
    // do slot alvo para ser contado.
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

    assert.equal(board.intervention[0]?.doctorName, null);
    assert.equal(board.intervention[0]?.occupancyId, null);
    assert.match(board.intervention[0]?.issues.join(" ") ?? "", /Sem ocupacao identificada/i);
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

test("uma correção manual (admin_correction) retrodatada não pode ghost-fechar o titular real de OUTRO alvo (caso Ana Luiza Alves, ramal 2154, 18/08/2026)", () => {
    // Gerardson tem uma cadeia de continuidade que começa no ramal 1367 (SD) e
    // segue pro 2154 (SN, "Continua do SD"). O registro de continuidade herda o
    // started_at de ORIGEM da cadeia (07:11, quando ele chegou no 1367), mesmo o
    // 2154 sendo, na prática, só ocupado por ele às 19:00. Sem a defesa (Frente 2
    // estendida a admin_correction/manual), resolveSuccessorStartMap usava esse
    // started_at herdado pra tratar Gerardson como "sucessor" de Ana Luiza no
    // 2154 às 07:11 — encolhendo a presença real dela (chegou 06:59) a 12 minutos
    // e derrubando-a como ruído (isLikelyNoise), mesmo o SD dela não tendo nada a
    // ver com o SN do Gerardson.
    const board = buildPaymentAllocationBoardModel({
        targets: [makeTarget({ domain: "regulation", targetCode: "2154", targetLabel: "Ramal 2154", sortOrder: 22 })],
        rawRows: [
            makeRow({
                occupancyId: "occ-ana-luiza",
                domain: "regulation",
                targetCode: "2154",
                targetLabel: "Ramal 2154",
                doctorId: "doc-ana-luiza",
                doctorName: "Ana Luiza Andrade Alves",
                displayName: "Ana Luiza Alves",
                startedAt: "2026-08-18T09:59:00.000Z", // 06:59 SP
                boardStartedAt: "2026-08-18T09:59:39.000Z",
                endedAt: "2026-08-18T22:00:00.000Z",     // 19:00 SP
                actualEndedAt: "2026-08-18T22:00:00.000Z",
                scheduledStartAt: "2026-08-18T10:00:00.000Z",
                scheduledEndAt: "2026-08-18T22:15:00.000Z",
                continuityGroupId: "cg-ana-luiza",
                shiftLabel: "SD",
                source: "telegram",
                notes: "Ana Luiza na 2154 SD",
                createdAt: "2026-08-18T09:59:39.000Z",
            }),
            makeRow({
                occupancyId: "occ-gerardson-2154",
                domain: "regulation",
                targetCode: "2154",
                targetLabel: "Ramal 2154",
                doctorId: "doc-gerardson",
                doctorName: "Gerardson Macedo e Silva Souza",
                displayName: "Gerardson Macedo",
                // started_at herdado da origem da cadeia (1367, 07:11 SP) — não de
                // quando ele de fato assumiu o 2154 (19:00 SP).
                startedAt: "2026-08-18T10:11:00.000Z",
                boardStartedAt: "2026-08-18T10:11:00.000Z",
                endedAt: "2026-08-19T10:15:00.000Z",
                actualEndedAt: "2026-08-19T10:15:00.000Z",
                scheduledStartAt: "2026-08-18T22:00:00.000Z", // 19:00 SP — SN de fato
                scheduledEndAt: "2026-08-19T10:15:00.000Z",
                continuityGroupId: "cg-gerardson",
                shiftLabel: "SN",
                source: "admin_correction",
                notes: "Continua do SD",
                // Criado bem depois (20:26 SP) do started_at herdado (07:11 SP).
                createdAt: "2026-08-18T23:26:00.000Z",
            }),
        ],
        operationalDate: "2026-08-18T15:00:00.000Z",
        shiftLabel: "SD",
        startedAt: "2026-08-18T10:00:00.000Z",
        endedAt: "2026-08-18T22:00:00.000Z",
        generatedAt: "2026-08-19T00:00:00.000Z",
    });

    const anaLuizaRow = board.regulation.find((row) => row.doctorName === "Ana Luiza Andrade Alves");
    assert.ok(anaLuizaRow, "Ana Luiza nao pode sumir do SD do ramal 2154 por causa do SN retrodatado do Gerardson");
    assert.equal(anaLuizaRow?.paymentStatus, "ready_for_payment");
    assert.deepEqual(anaLuizaRow?.issues, []);
});

test("titular real que perde um conflito de alvo pra outro titular fica visivel como needs_review, nao desaparece (caso Sadja Costa vs Murilo Damasceno, CZ50, 14/08/2026)", () => {
    // Sadja fez o plantao real via Telegram (chegada 07:28, saida 20:40). Murilo
    // tem uma correcao manual do chefe remanejando-o pro MESMO alvo (CZ50) o dia
    // inteiro, criada as 20:52 — ja depois da Sadja ter saido. O motor da
    // prioridade de lock-in pro admin_correction e Murilo vence o alvo, mas Sadja
    // nao pode desaparecer do pagamento sem deixar rastro algum: ela precisa
    // aparecer como needs_review, com o mesmo conflito flagado, pro chefe decidir.
    const board = buildPaymentAllocationBoardModel({
        targets: [makeTarget({ targetCode: "CZ50", targetLabel: "CZ50", sortOrder: 50 })],
        rawRows: [
            makeRow({
                occupancyId: "occ-sadja",
                targetCode: "CZ50",
                targetLabel: "CZ50",
                doctorId: "doc-sadja",
                doctorName: "Sadja Carolina Santos Costa",
                displayName: "Sadja Costa",
                startedAt: "2026-08-14T10:28:47.000Z", // 07:28 SP
                boardStartedAt: "2026-08-14T10:28:47.000Z",
                endedAt: "2026-08-14T23:40:09.000Z",    // 20:40 SP
                actualEndedAt: "2026-08-14T23:40:09.000Z",
                scheduledStartAt: "2026-08-14T10:00:00.000Z",
                scheduledEndAt: "2026-08-14T22:00:00.000Z",
                continuityGroupId: "cg-sadja",
                source: "telegram",
                notes: "Sadja Costa CZ50 SD",
                createdAt: "2026-08-14T10:28:48.000Z",
            }),
            makeRow({
                occupancyId: "occ-murilo",
                targetCode: "CZ50",
                targetLabel: "CZ50",
                doctorId: "doc-murilo",
                doctorName: "Murilo Candido do Monte Damasceno",
                displayName: "Murilo Damasceno",
                startedAt: "2026-08-14T10:22:10.000Z", // 07:22 SP
                boardStartedAt: "2026-08-14T10:22:10.000Z",
                endedAt: "2026-08-15T23:00:19.000Z",
                actualEndedAt: "2026-08-15T23:00:19.000Z",
                scheduledStartAt: "2026-08-14T10:00:00.000Z",
                scheduledEndAt: "2026-08-15T10:00:00.000Z",
                continuityGroupId: "cg-murilo",
                source: "admin_correction",
                notes: "Murilo Damasceno na IT30 P\nRemanejado de IT30 para CZ50. Motivo: FURO NA ÁREA",
                createdAt: "2026-08-14T23:52:36.000Z", // 20:52 SP
            }),
        ],
        operationalDate: "2026-08-14T15:00:00.000Z",
        shiftLabel: "SD",
        startedAt: "2026-08-14T10:00:00.000Z",
        endedAt: "2026-08-14T22:00:00.000Z",
        generatedAt: "2026-08-15T00:00:00.000Z",
    });

    const muriloRow = board.intervention.find((row) => row.doctorName === "Murilo Candido do Monte Damasceno");
    const sadjaRow = board.intervention.find((row) => row.doctorName === "Sadja Carolina Santos Costa");
    assert.ok(muriloRow, "Murilo deveria vencer o lock-in do admin_correction");
    assert.ok(sadjaRow, "Sadja nao pode desaparecer do pagamento so por ter perdido o conflito de alvo");
    assert.equal(sadjaRow?.paymentStatus, "needs_review");
    assert.match(sadjaRow?.issues.join(" ") ?? "", /Conflito entre medicos titulares/i);
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

test("um P noturno sem declaração no slot seguinte não cobre SD automaticamente", () => {
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
    assert.equal(carlaRow, undefined, "Sem declaração explícita no SD seguinte, a cobertura não deve ser carregada para pagamento");
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

test("buildPaymentAllocationBoardModel: base diurna (dayOnly) entra no SD e some do SN", () => {
    const goaTarget = makeTarget({ targetCode: "GOA", targetLabel: "GOA", sortOrder: 130, dayOnly: true });
    const normalTarget = makeTarget();

    const sdBoard = buildPaymentAllocationBoardModel({
        targets: [normalTarget, goaTarget],
        rawRows: [makeRow({ targetCode: "GOA", targetLabel: "GOA" })],
        operationalDate: "2026-03-28T15:00:00.000Z",
        shiftLabel: "SD",
        startedAt: "2026-03-28T10:00:00.000Z",
        endedAt: "2026-03-28T22:00:00.000Z",
        generatedAt: "2026-03-28T23:00:00.000Z",
    });
    const goaRow = sdBoard.intervention.find((row) => row.targetCode === "GOA");
    assert.equal(goaRow?.doctorName, "Ana Souza", "chegada na GOA durante o dia deve virar linha pagável do SD");

    const snBoard = buildPaymentAllocationBoardModel({
        targets: [normalTarget, goaTarget],
        rawRows: [],
        operationalDate: "2026-03-28T15:00:00.000Z",
        shiftLabel: "SN",
        startedAt: "2026-03-28T22:00:00.000Z",
        endedAt: "2026-03-29T10:00:00.000Z",
        generatedAt: "2026-03-29T11:00:00.000Z",
    });
    const snCodes = snBoard.intervention.map((row) => row.targetCode);
    assert.ok(!snCodes.includes("GOA"), "base diurna não é alvo no SN — não pode contar como furo noturno");
    assert.ok(snCodes.includes("PM04"), "base normal continua aparecendo no SN");
});

// Caso real (Rafael Santana, ramal 2152, 19/08/2026): declarou 24h às 07:00,
// Jean Rios chegou às 07:09 e tomou a titularidade do quadro, Rafael ficou sem
// board e permaneceu até 07:14 do dia seguinte. A folha truncava a cobertura
// dele na chegada de Jean — 10 minutos, abaixo da presença mínima — e o plantão
// inteiro sumia do pagamento. Quem perde a titularidade e FICA não foi rendido.
test("presença sem titularidade não é truncada pela chegada de quem tomou a posição", () => {
    const board = buildPaymentAllocationBoardModel({
        targets: [makeTarget({ domain: "regulation", targetCode: "2152", targetLabel: "Ramal 2152" })],
        rawRows: [
            makeRow({
                occupancyId: "occ-titular",
                domain: "regulation",
                targetCode: "2152",
                targetLabel: "Ramal 2152",
                doctorId: "doc-jean",
                doctorName: "Jean Rios",
                startedAt: "2026-08-19T10:09:00.000Z",
                boardStartedAt: "2026-08-19T10:09:00.000Z",
                endedAt: "2026-08-19T21:52:00.000Z",
                actualEndedAt: "2026-08-19T21:52:00.000Z",
                shiftLabel: "SD",
                notes: "Jean Rios 2152 SD",
            }),
            makeRow({
                occupancyId: "occ-sem-board",
                domain: "regulation",
                targetCode: "2152",
                targetLabel: "Ramal 2152",
                doctorId: "doc-rafael",
                doctorName: "Rafael Santana",
                startedAt: "2026-08-19T10:00:00.000Z",
                boardStartedAt: null,
                endedAt: "2026-08-20T10:14:00.000Z",
                actualEndedAt: "2026-08-20T10:14:00.000Z",
                shiftLabel: "P",
                notes: "Rafael Azevedo 24h 2152",
            }),
        ],
        operationalDate: "2026-08-19",
        shiftLabel: "SD",
        startedAt: "2026-08-19T10:00:00.000Z",
        endedAt: "2026-08-19T22:00:00.000Z",
    });

    const ocupantes = board.regulation.filter((row) => row.doctorName).map((row) => row.doctorName);
    assert.ok(ocupantes.includes("Jean Rios"), "o titular do quadro continua pago");
    assert.ok(ocupantes.includes("Rafael Santana"), "quem ficou sem board e permaneceu também é pago");
});

// A contrapartida: ninguém recebe dois plantões pelo mesmo turno. Se o médico já
// é titular de uma posição no slot, o registro sem board dele em OUTRA posição
// não vira pagamento extra (Gerardson, 1367 + 2154, 18/08/2026).
test("registro sem titularidade não paga de novo quem já é titular em outra posição do mesmo turno", () => {
    const board = buildPaymentAllocationBoardModel({
        targets: [
            makeTarget({ domain: "regulation", targetCode: "1367", targetLabel: "Ramal 1367" }),
            makeTarget({ domain: "regulation", targetCode: "2154", targetLabel: "Ramal 2154", sortOrder: 5 }),
        ],
        rawRows: [
            makeRow({
                occupancyId: "occ-titular-2154",
                domain: "regulation",
                targetCode: "2154",
                targetLabel: "Ramal 2154",
                doctorId: "doc-ger",
                doctorName: "Gerardson Macedo",
                startedAt: "2026-08-18T22:00:00.000Z",
                boardStartedAt: "2026-08-18T22:00:00.000Z",
                endedAt: "2026-08-19T10:00:00.000Z",
                actualEndedAt: "2026-08-19T10:00:00.000Z",
                shiftLabel: "SN",
                notes: "Gerardson 2154 SN",
            }),
            makeRow({
                occupancyId: "occ-sem-board-1367",
                domain: "regulation",
                targetCode: "1367",
                targetLabel: "Ramal 1367",
                doctorId: "doc-ger",
                doctorName: "Gerardson Macedo",
                startedAt: "2026-08-18T22:00:00.000Z",
                boardStartedAt: null,
                endedAt: "2026-08-19T10:00:00.000Z",
                actualEndedAt: "2026-08-19T10:00:00.000Z",
                shiftLabel: "SN",
                notes: "Gerardson 1367",
            }),
        ],
        operationalDate: "2026-08-18",
        shiftLabel: "SN",
        startedAt: "2026-08-18T22:00:00.000Z",
        endedAt: "2026-08-19T10:00:00.000Z",
    });

    const doGerardson = board.regulation.filter((row) => row.doctorName === "Gerardson Macedo");
    assert.equal(doGerardson.length, 1, "um plantão por turno, não dois");
});

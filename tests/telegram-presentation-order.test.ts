import assert from "node:assert/strict";
import test from "node:test";
import { buildTelegramDepartureReport } from "@/modules/telegram/departure-report";
import { compareTelegramInterventionCodes, compareTelegramRegulationCodes } from "@/modules/telegram/presentation-order";
import { buildTelegramShiftReport } from "@/modules/telegram/shift-report";
import { buildTelegramSummaryReport } from "@/modules/telegram/summary-report";
import type { InterventionBoardRow, PaymentAllocationRow, RegulationBoardRow } from "@/services/board.service";

function makePaymentRow(overrides: Partial<PaymentAllocationRow> = {}): PaymentAllocationRow {
    return {
        domain: "intervention",
        targetCode: "PM04",
        targetLabel: "PM04",
        sortOrder: 4,
        defaultRole: null,
        occupancyId: "occ-1",
        doctorId: "doc-1",
        doctorName: "Medico Teste",
        displayName: "Medico Teste",
        startedAt: "2026-03-28T22:00:00.000Z",
        endedAt: "2026-03-29T10:00:00.000Z",
        actualEndedAt: "2026-03-29T10:00:00.000Z",
        scheduledStartAt: "2026-03-28T22:00:00.000Z",
        scheduledEndAt: "2026-03-29T10:00:00.000Z",
        shiftLabel: "SN",
        roleLabel: null,
        ramalLabel: null,
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
        continuesBeyondShift: false,
        ...overrides,
    };
}

function makeInterventionRow(overrides: Partial<InterventionBoardRow> = {}): InterventionBoardRow {
    return {
        baseId: 4,
        occupancyId: "int-1",
        baseCode: "PM04",
        baseLabel: "PM04",
        doctorId: "doc-1",
        doctorName: "Medico Teste",
        displayName: "Medico Teste",
        startedAt: "2026-03-29T10:00:00.000Z",
        boardStartedAt: "2026-03-29T10:00:00.000Z",
        scheduledEndAt: "2026-03-29T22:00:00.000Z",
        shiftLabel: "SD",
        roleLabel: null,
        status: "active",
        liveSource: "operations_v2",
        liveUpdatedAt: null,
        ...overrides,
    };
}

function makeRegulationRow(overrides: Partial<RegulationBoardRow> = {}): RegulationBoardRow {
    return {
        postId: 31,
        occupancyId: "reg-1",
        postCode: "2031",
        postLabel: "2031",
        defaultRole: "MR",
        doctorId: "doc-1",
        doctorName: "Medico Teste",
        displayName: "Medico Teste",
        startedAt: "2026-03-29T10:00:00.000Z",
        boardStartedAt: "2026-03-29T10:00:00.000Z",
        scheduledEndAt: "2026-03-29T22:15:00.000Z",
        shiftLabel: "SD",
        roleLabel: "MR",
        ramalLabel: "2031",
        status: "active",
        liveSource: "operations_v2",
        liveUpdatedAt: null,
        ...overrides,
    };
}

test("presentation order keeps intervention in fixed operational sequence and regulation with 2031 first", () => {
    assert.deepEqual(
        ["PM40", "BR05", "SM01", "IT30", "PM04"].sort(compareTelegramInterventionCodes),
        ["SM01", "PM04", "BR05", "IT30", "PM40"],
    );

    assert.deepEqual(
        ["1366", "2032", "2031", "1321", "2154"].sort(compareTelegramRegulationCodes),
        ["2031", "2032", "2154", "1321", "1366"],
    );
});

test("buildTelegramDepartureReport orders regulation and intervention by operational presentation order", () => {
    const report = buildTelegramDepartureReport({
        generatedAt: "2026-03-29T12:00:00.000Z",
        operationalDate: "2026-03-28T12:00:00.000Z",
        shiftLabel: "SN",
        startedAt: "2026-03-28T22:00:00.000Z",
        endedAt: "2026-03-29T10:00:00.000Z",
        summary: {
            totalTargets: 5,
            assignedCount: 5,
            readyForPaymentCount: 5,
            needsReviewCount: 0,
            unassignedCount: 0,
        },
        regulation: [
            makePaymentRow({ domain: "regulation", targetCode: "1366", targetLabel: "1366", sortOrder: 66, defaultRole: "MR", ramalLabel: "1366", roleLabel: "MR", doctorName: "Ultimo Reg" }),
            makePaymentRow({ domain: "regulation", targetCode: "2031", targetLabel: "2031", sortOrder: 31, defaultRole: "MR", ramalLabel: "2031", roleLabel: "MR", doctorName: "Chefia" }),
            makePaymentRow({ domain: "regulation", targetCode: "2032", targetLabel: "2032", sortOrder: 32, defaultRole: "MR", ramalLabel: "2032", roleLabel: "MR", doctorName: "Segundo Reg" }),
        ],
        intervention: [
            makePaymentRow({ targetCode: "IT30", targetLabel: "IT30", sortOrder: 30, doctorName: "Terceira Base" }),
            makePaymentRow({ targetCode: "SM01", targetLabel: "SM01", sortOrder: 1, doctorName: "Primeira Base" }),
        ],
    });

    assert.ok(report.indexOf("✅ 2031") < report.indexOf("✅ 2032"));
    assert.ok(report.indexOf("✅ 2032") < report.indexOf("✅ 1366"));
    assert.ok(report.indexOf("✅ SM01") < report.indexOf("✅ IT30"));
});

test("buildTelegramSummaryReport orders exits and arrivals with the same operational hierarchy", () => {
    const report = buildTelegramSummaryReport({
        reference: new Date("2026-03-29T10:20:00-03:00"),
        data: {
            departureBoard: {
                generatedAt: "2026-03-29T12:00:00.000Z",
                operationalDate: "2026-03-28T12:00:00.000Z",
                shiftLabel: "SN",
                startedAt: "2026-03-28T22:00:00.000Z",
                endedAt: "2026-03-29T10:00:00.000Z",
                summary: {
                    totalTargets: 4,
                    assignedCount: 4,
                    readyForPaymentCount: 4,
                    needsReviewCount: 0,
                    unassignedCount: 0,
                },
                intervention: [
                    makePaymentRow({ targetCode: "IT30", targetLabel: "IT30", doctorName: "Carlos Lima", displayName: "Carlos Lima" }),
                    makePaymentRow({ targetCode: "SM01", targetLabel: "SM01", doctorName: "Ana Souza", displayName: "Ana Souza" }),
                ],
                regulation: [
                    makePaymentRow({ domain: "regulation", targetCode: "1366", targetLabel: "1366", defaultRole: "MR", ramalLabel: "1366", roleLabel: "MR", doctorName: "Bruno Lima", displayName: "Bruno Lima" }),
                    makePaymentRow({ domain: "regulation", targetCode: "2031", targetLabel: "2031", defaultRole: "MR", ramalLabel: "2031", roleLabel: "MR", doctorName: "Caio Melo", displayName: "Caio Melo" }),
                ],
            },
            currentBoard: {
                intervention: [
                    makeInterventionRow({ baseCode: "IT30", baseLabel: "IT30", doctorName: "Carlos Lima", displayName: "Carlos Lima" }),
                    makeInterventionRow({ baseCode: "SM01", baseLabel: "SM01", doctorName: "Ana Souza", displayName: "Ana Souza" }),
                ],
                regulation: [
                    makeRegulationRow({ postCode: "1366", postLabel: "1366", ramalLabel: "1366", doctorName: "Bruno Lima", displayName: "Bruno Lima" }),
                    makeRegulationRow({ postCode: "2031", postLabel: "2031", ramalLabel: "2031", doctorName: "Caio Melo", displayName: "Caio Melo" }),
                ],
            },
            mealBreakSession: null,
        },
    });

    assert.ok(report.indexOf("SM01|Ana Souza") < report.indexOf("IT30|Carlos Lima"));
    assert.ok(report.indexOf("2031|Caio Melo") < report.indexOf("1366|Bruno Lima"));
    assert.ok(report.lastIndexOf("SM01|Ana") < report.lastIndexOf("IT30|Carlos Lima"));
    assert.ok(report.lastIndexOf("2031|Caio Melo") < report.lastIndexOf("1366|Bruno"));
});

test("buildTelegramShiftReport orders confirmed, pending and disabled lines by operational chat order", () => {
    const report = buildTelegramShiftReport({
        reference: new Date("2026-03-28T19:20:00-03:00"),
        board: {
            intervention: [
                makeInterventionRow({ baseCode: "IT30", baseLabel: "IT30", doctorName: null, displayName: null, occupancyId: null, doctorId: null, startedAt: null, boardStartedAt: null, scheduledEndAt: null, shiftLabel: null, status: "disabled", disabledAt: "2026-03-28T21:30:00.000Z" }),
                makeInterventionRow({ baseCode: "PM04", baseLabel: "PM04", doctorName: "Segunda Base", displayName: "Segunda Base", shiftLabel: "SN" }),
                makeInterventionRow({ baseCode: "SM01", baseLabel: "SM01", doctorName: "Primeira Base", displayName: "Primeira Base", shiftLabel: "SN" }),
            ],
            regulation: [
                makeRegulationRow({ postCode: "1366", postLabel: "1366", ramalLabel: "1366", doctorName: "Ultimo Ramal", displayName: "Ultimo Ramal", shiftLabel: "SN" }),
                makeRegulationRow({ postCode: "2032", postLabel: "2032", ramalLabel: "2032", doctorName: "Segundo Ramal", displayName: "Segundo Ramal", shiftLabel: "SN" }),
                makeRegulationRow({ postCode: "2031", postLabel: "2031", ramalLabel: "2031", doctorName: "Chefia", displayName: "Chefia", shiftLabel: "SN" }),
            ],
        },
    });

    assert.ok(report.indexOf("✅ SM01") < report.indexOf("✅ PM04"));
    assert.ok(report.indexOf("✅ 2031") < report.indexOf("✅ 2032"));
    assert.ok(report.indexOf("✅ 2032") < report.indexOf("✅ 1366"));
    assert.ok(report.indexOf("✅ PM04") < report.indexOf("⚫ IT30"));
});
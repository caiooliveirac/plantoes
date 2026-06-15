import assert from "node:assert/strict";
import test from "node:test";
import ExcelJS from "exceljs";
import { buildMonthlyReportWorkbook } from "@/modules/reporting/monthly-report-xlsx";
import type { MonthlyReportModel } from "@/modules/reporting/monthly-report";

function makeModel(): MonthlyReportModel {
    return {
        monthKey: "2026-03",
        monthLabel: "março de 2026",
        range: {
            startIso: "2026-03-01T00:00:00.000Z",
            endIso: "2026-04-01T00:00:00.000Z",
        },
        presetMonths: [
            { key: "2026-03", label: "março de 2026" },
            { key: "2026-02", label: "fevereiro de 2026" },
        ],
        summary: {
            doctorCount: 1,
            shiftCount: 2,
            inconsistentShiftCount: 1,
            readyForPaymentCount: 1,
            needsReviewCount: 1,
            doctorsReadyForPaymentCount: 0,
            doctorsNeedsReviewCount: 1,
            openShiftCount: 0,
            manualShiftCount: 1,
            correctedShiftCount: 1,
            doctorsWithPendenciesCount: 1,
            workedMinutes: 1440,
            balanceMinutes: -30,
        },
        groups: [
            {
                doctorId: "doc-1",
                doctorName: "Caio Oliveira do Carmo",
                displayName: "Caio Oliveira",
                paymentStatus: "needs_review",
                shiftCount: 2,
                workedMinutes: 1440,
                balanceMinutes: -30,
                inconsistentShiftCount: 1,
                manualShiftCount: 1,
                correctedShiftCount: 1,
                shifts: [
                    {
                        occupancyId: "occ-1",
                        domain: "intervention",
                        doctorId: "doc-1",
                        doctorName: "Caio Oliveira do Carmo",
                        displayName: "Caio Oliveira",
                        targetCode: "PP20",
                        targetLabel: "PA Pituba",
                        continuityGroupId: "cg-1",
                        startedAt: "2026-03-10T07:00:00.000Z",
                        boardStartedAt: "2026-03-10T07:00:00.000Z",
                        endedAt: "2026-03-10T19:00:00.000Z",
                        actualEndedAt: "2026-03-10T19:05:00.000Z",
                        scheduledStartAt: "2026-03-10T07:00:00.000Z",
                        scheduledEndAt: "2026-03-10T19:00:00.000Z",
                        shiftLabel: "SD",
                        source: "manual",
                        notes: "Ajuste pós conferência",
                        createdAt: "2026-03-10T07:00:00.000Z",
                        updatedAt: "2026-03-10T19:05:00.000Z",
                        createdByEmail: "admin@samu.local",
                        updatedByEmail: "admin@samu.local",
                        arrivalDelayMinutes: 20,
                        overtimeMinutes: 5,
                        creditedOvertimeMinutes: 10,
                        balanceMinutes: -30,
                        ruleCode: "default",
                        bankHoursExplanation: "Houve atraso operacional",
                        paymentStatus: "needs_review",
                        inconsistencies: ["Entrada com atraso acima da tolerância operacional"],
                        flags: {
                            hasManualSource: true,
                            hasMissingBankHours: false,
                            hasOpenShift: false,
                            hasMissingSchedule: false,
                            hasLateArrival: true,
                            hasNegativeBalance: true,
                            hasOvertimeWithoutNote: false,
                            hasCorrectionHistory: true,
                            hasDuplicateCoverage: false,
                            hasPaymentAllocationMismatch: false,
                            spansMultiplePaymentSlots: false,
                        },
                        workedMinutes: 720,
                        auditTrail: [
                            {
                                id: "audit-1",
                                action: "intervention_occupancy.corrected",
                                actorEmail: "admin@samu.local",
                                createdAt: "2026-03-10T19:10:00.000Z",
                                details: { notes: "Ajuste pós conferência" },
                            },
                        ],
                    },
                    {
                        occupancyId: "occ-2",
                        domain: "regulation",
                        doctorId: "doc-1",
                        doctorName: "Caio Oliveira do Carmo",
                        displayName: "Caio Oliveira",
                        targetCode: "MR01",
                        targetLabel: "Mesa vermelha",
                        continuityGroupId: "cg-2",
                        startedAt: "2026-03-11T07:00:00.000Z",
                        boardStartedAt: "2026-03-11T07:00:00.000Z",
                        endedAt: "2026-03-11T19:00:00.000Z",
                        actualEndedAt: "2026-03-11T19:00:00.000Z",
                        scheduledStartAt: "2026-03-11T07:00:00.000Z",
                        scheduledEndAt: "2026-03-11T19:00:00.000Z",
                        shiftLabel: "SD",
                        source: "telegram",
                        notes: null,
                        createdAt: "2026-03-11T07:00:00.000Z",
                        updatedAt: "2026-03-11T19:00:00.000Z",
                        createdByEmail: null,
                        updatedByEmail: null,
                        arrivalDelayMinutes: 0,
                        overtimeMinutes: 0,
                        creditedOvertimeMinutes: 0,
                        balanceMinutes: 0,
                        ruleCode: "default",
                        bankHoursExplanation: "Sem ajustes",
                        paymentStatus: "ready_for_payment",
                        inconsistencies: [],
                        flags: {
                            hasManualSource: false,
                            hasMissingBankHours: false,
                            hasOpenShift: false,
                            hasMissingSchedule: false,
                            hasLateArrival: false,
                            hasNegativeBalance: false,
                            hasOvertimeWithoutNote: false,
                            hasCorrectionHistory: false,
                            hasDuplicateCoverage: false,
                            hasPaymentAllocationMismatch: false,
                            spansMultiplePaymentSlots: false,
                        },
                        workedMinutes: 720,
                        auditTrail: [],
                    },
                ],
            },
        ],
    };
}

test("buildMonthlyReportWorkbook creates structured sheets for admin review", async () => {
    const buffer = await buildMonthlyReportWorkbook(makeModel());
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer as ExcelJS.Buffer);

    assert.deepEqual(workbook.worksheets.map((sheet) => sheet.name), [
        "Resumo",
        "Médicos",
        "Plantões",
        "Pendências",
        "Auditoria",
    ]);

    const summarySheet = workbook.getWorksheet("Resumo");
    const pendingSheet = workbook.getWorksheet("Pendências");
    assert.ok(summarySheet);
    assert.ok(pendingSheet);
    assert.equal(summarySheet?.getCell("A1").value, "Relatório mensal SAMU · março de 2026");
    assert.equal(pendingSheet?.actualRowCount, 2);
});
import assert from "node:assert/strict";
import test from "node:test";
import ExcelJS from "exceljs";
import { buildChiefMonthlyPayableWorkbook } from "@/modules/reporting/payable-shifts-xlsx";
import type { ChiefPayableBoardModel } from "@/modules/reporting/payable-shifts";

function makeBoard(): ChiefPayableBoardModel {
    return {
        monthKey: "2026-04",
        monthLabel: "abril de 2026",
        presetMonths: [{ key: "2026-04", label: "abril de 2026" }],
        range: {
            startIso: "2026-04-01T10:00:00.000Z",
            endIso: "2026-05-01T10:00:00.000Z",
        },
        days: ["01", "02", "03"],
        summary: {
            doctorCount: 1,
            payableShiftCount: 2,
            payableUnitCount: 2,
            readyCount: 2,
            needsReviewCount: 0,
            segmentCount: 3,
            discardedSegmentCount: 1,
            disabledTargetCount: 0,
            uncoveredTargetCount: 0,
        byEmploymentType: {
            pj: { doctorCount: 0, payableShiftCount: 0, payableUnitCount: 0, totalDueAmount: 0 },
            estatutario: { doctorCount: 0, payableShiftCount: 0, payableUnitCount: 0, totalDueAmount: 0 },
        },
        },
        targetOptions: [],
        doctors: [
            {
                doctorId: "doc-1",
                doctorName: "Syone de Jesus Feitosa",
                displayName: "Syone Feitosa",
                paymentStatus: "ready_for_payment",
                totalSD: 1,
                totalSN: 1,
                total: 2,
                pendingCount: 0,
                employmentType: "pj",
                cells: [
                    {
                        day: "01",
                        shifts: [{
                            payableShiftId: "p1",
                            occupancyId: "occ-1",
                            domain: "intervention",
                            doctorId: "doc-1",
                            doctorName: "Syone de Jesus Feitosa",
                            displayName: "Syone Feitosa",
                            targetCode: "BR60",
                            targetLabel: "BR60",
                            tagCode: "BR60",
                            operationalDate: "2026-04-01",
                            shiftLabel: "SN",
                            slotStartedAt: "2026-04-01T22:00:00.000Z",
                            slotEndedAt: "2026-04-02T10:00:00.000Z",
                            startedAt: "2026-04-01T22:00:00.000Z",
                            endedAt: "2026-04-02T10:00:00.000Z",
                            durationMinutes: 720,
                            paymentStatus: "ready_for_payment",
                            auditStatus: "clean",
                            issues: [],
                            source: "telegram",
                            roleLabel: null,
                            paymentUnit: 1,
                            paymentTag: null,
                        }],
                    },
                    {
                        day: "02",
                        shifts: [{
                            payableShiftId: "p2",
                            occupancyId: "occ-2",
                            domain: "regulation",
                            doctorId: "doc-1",
                            doctorName: "Syone de Jesus Feitosa",
                            displayName: "Syone Feitosa",
                            targetCode: "2154",
                            targetLabel: "2154",
                            tagCode: "CRU",
                            operationalDate: "2026-04-02",
                            shiftLabel: "SD",
                            slotStartedAt: "2026-04-02T10:00:00.000Z",
                            slotEndedAt: "2026-04-02T22:00:00.000Z",
                            startedAt: "2026-04-02T10:00:00.000Z",
                            endedAt: "2026-04-02T22:00:00.000Z",
                            durationMinutes: 720,
                            paymentStatus: "ready_for_payment",
                            auditStatus: "clean",
                            issues: [],
                            source: "telegram",
                            roleLabel: null,
                            paymentUnit: 1,
                            paymentTag: null,
                        }],
                    },
                    { day: "03", shifts: [] },
                ],
            },
        ],
        payableShifts: [],
        disabledTargets: [],
        uncoveredTargets: [],
        attestationSegments: [],
        allDoctorNames: [],
    };
}

test("buildChiefMonthlyPayableWorkbook renders doctor x day matrix", async () => {
    const buffer = await buildChiefMonthlyPayableWorkbook(makeBoard());
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer as ExcelJS.Buffer);

    const paymentSheet = workbook.getWorksheet("Pagamento");
    assert.ok(paymentSheet);
    assert.equal(paymentSheet?.getCell("A1").value, "Médico");
    assert.equal(paymentSheet?.getCell("C2").value, "BR60SN");
    assert.equal(paymentSheet?.getCell("D2").value, "CRUSD");
});

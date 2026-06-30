import assert from "node:assert/strict";
import test from "node:test";
import {
    buildAdminExtraPayableShift,
    buildChiefPayableBoard,
    type AdminExtraShiftInput,
} from "@/modules/reporting/payable-shifts";
import {
    buildBankHoursHistoryModel,
    type BankHoursSettlementSummary,
    type RawBankHoursHistoryShift,
} from "@/modules/reporting/bank-hours-history";

function makeExtraInput(overrides: Partial<AdminExtraShiftInput> = {}): AdminExtraShiftInput {
    return {
        id: "extra-1",
        doctorId: "doc-1",
        doctorName: "Médico Teste",
        displayName: null,
        operationalDate: "2026-04-06",
        shiftLabel: "SD",
        label: "Banco de horas",
        ...overrides,
    };
}

function buildBoardWith(payableShifts: ReturnType<typeof buildAdminExtraPayableShift>[]) {
    return buildChiefPayableBoard({
        monthKey: "2026-04",
        monthLabel: "abril/2026",
        presetMonths: [],
        rangeStartIso: "2026-04-01T03:00:00.000Z",
        rangeEndIso: "2026-05-01T03:00:00.000Z",
        payableShifts,
        disabledTargets: [],
        uncoveredTargets: [],
        targetOptions: [],
        attestationSegments: [],
        allDoctorNames: ["Médico Teste"],
    });
}

test("buildAdminExtraPayableShift respeita o sinal: verde +1, vermelho -1, default +1", () => {
    assert.equal(buildAdminExtraPayableShift(makeExtraInput()).paymentUnit, 1);
    assert.equal(buildAdminExtraPayableShift(makeExtraInput({ kind: "bonus", unit: 1 })).paymentUnit, 1);
    assert.equal(buildAdminExtraPayableShift(makeExtraInput({ kind: "penalty", unit: -1 })).paymentUnit, -1);
});

test("plantão vermelho (unit -1) subtrai do total; verde + vermelho no mesmo dia se cancelam", () => {
    const green = buildAdminExtraPayableShift(makeExtraInput({ id: "g", kind: "bonus", unit: 1 }));
    const red = buildAdminExtraPayableShift(makeExtraInput({ id: "r", kind: "penalty", unit: -1 }));

    const greenOnly = buildBoardWith([green]).doctors[0];
    const redOnly = buildBoardWith([red]).doctors[0];
    const both = buildBoardWith([green, red]).doctors[0];

    assert.ok((greenOnly.totalDue ?? 0) > 0, "verde deve somar valor positivo");
    assert.equal(redOnly.totalDue, Number((-(greenOnly.totalDue ?? 0)).toFixed(2)), "vermelho deve ser o oposto do verde");
    assert.equal(both.totalDue, 0, "verde + vermelho no mesmo dia zeram o total");
});

function makeBankShift(overrides: Partial<RawBankHoursHistoryShift> = {}): RawBankHoursHistoryShift {
    return {
        occupancyId: "occ-1",
        domain: "intervention",
        doctorId: "doc-1",
        doctorName: "Médico Teste",
        displayName: null,
        targetCode: "PR03",
        targetLabel: "Base PR03",
        continuityGroupId: "cg-1",
        startedAt: "2026-03-25T10:00:00.000Z",
        boardStartedAt: "2026-03-25T10:00:00.000Z",
        handoffEndedAt: "2026-03-25T22:20:00.000Z",
        actualEndedAt: "2026-03-25T22:20:00.000Z",
        effectiveEndedAt: "2026-03-25T22:20:00.000Z",
        shiftLabel: "SD",
        source: "telegram",
        notes: null,
        createdAt: "2026-03-25T10:00:00.000Z",
        updatedAt: "2026-03-25T22:20:00.000Z",
        createdByEmail: null,
        updatedByEmail: null,
        hasPersistedBankEntry: true,
        occupancyScheduledStartAt: "2026-03-25T10:00:00.000Z",
        occupancyScheduledEndAt: "2026-03-25T22:15:00.000Z",
        bankScheduledStartAt: "2026-03-25T10:00:00.000Z",
        bankScheduledEndAt: "2026-03-25T22:15:00.000Z",
        bankActualStartAt: "2026-03-25T10:00:00.000Z",
        bankActualEndAt: "2026-03-25T22:20:00.000Z",
        arrivalDelayMinutes: 0,
        overtimeMinutes: 0,
        creditedOvertimeMinutes: 0,
        balanceMinutes: 720,
        ruleCode: "ON_TIME_NO_OVERTIME",
        bankHoursExplanation: "saldo de teste",
        manualBalanceMinutes: null,
        manualBalanceNotes: null,
        manualBalanceUpdatedAt: null,
        manualBalanceActorEmail: null,
        auditTrail: [],
        ...overrides,
    };
}

test("buildBankHoursHistoryModel debita o acerto: -12h zera o saldo bruto de +12h", () => {
    const settlement: BankHoursSettlementSummary = {
        id: "set-1",
        monthKey: "2026-04",
        kind: "bonus",
        deltaMinutes: -720,
        operationalDate: "2026-04-06",
        notes: "Banco de horas +12h",
        createdAt: "2026-04-10T12:00:00.000Z",
    };
    const settlementsByDoctor = new Map([["doc-1", [settlement]]]);

    const baseline = buildBankHoursHistoryModel([makeBankShift()]);
    assert.equal(baseline.doctors[0].balanceMinutes, 720, "sem acerto, saldo bruto é +720");

    const model = buildBankHoursHistoryModel([makeBankShift()], settlementsByDoctor);
    const doctor = model.doctors[0];
    assert.equal(doctor.balanceMinutes, 0, "saldo efetivo = bruto (+720) + acerto (-720) = 0");
    assert.equal(doctor.settlements.length, 1);
    assert.equal(doctor.settlements[0].kind, "bonus");
    assert.equal(model.summary.balanceMinutes, 0, "o resumo também reflete o acerto");
});

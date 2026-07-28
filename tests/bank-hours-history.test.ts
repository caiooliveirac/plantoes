import assert from "node:assert/strict";
import test from "node:test";
import { buildBankHoursProof, buildBankHoursHistoryModel, type RawBankHoursHistoryShift } from "@/modules/reporting/bank-hours-history";

function makeShift(overrides: Partial<RawBankHoursHistoryShift> = {}): RawBankHoursHistoryShift {
    return {
        occupancyId: "occ-1",
        domain: "intervention",
        doctorId: "doc-1",
        doctorName: "Vagner Barroso",
        displayName: "Vagner",
        targetCode: "PR03",
        targetLabel: "Base PR03",
        continuityGroupId: "cg-1",
        startedAt: "2026-03-25T10:00:00.000Z",
        boardStartedAt: "2026-03-25T10:00:00.000Z",
        handoffEndedAt: "2026-03-25T22:20:00.000Z",
        actualEndedAt: "2026-03-25T22:50:00.000Z",
        effectiveEndedAt: "2026-03-25T22:50:00.000Z",
        shiftLabel: "SD",
        source: "telegram",
        notes: null,
        createdAt: "2026-03-25T10:00:00.000Z",
        updatedAt: "2026-03-25T22:50:00.000Z",
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
        balanceMinutes: 0,
        ruleCode: "ON_TIME_NO_OVERTIME",
        bankHoursExplanation: "Chegou com ate 15 min de atraso e a saida ficou com ate 15 min alem da janela prevista, sem impacto no banco.",
        manualBalanceMinutes: null,
        manualBalanceNotes: null,
        manualBalanceUpdatedAt: null,
        manualBalanceActorEmail: null,
        auditTrail: [],
        ...overrides,
    };
}

test("buildBankHoursProof explains when rendição overrides a later physical exit", () => {
    const proof = buildBankHoursProof(makeShift());

    assert.equal(proof.mode, "handoff");
    assert.match(proof.summary, /rendição/i);
    assert.match(proof.items.join(" "), /saída física/i);
    assert.match(proof.items.join(" "), /cálculo travou na rendição/i);
});

test("rendição fechada como handoff (sem actualEndedAt) não vira override de saída física", () => {
    // Novo modelo: a rendição grava só o endedAt do handoff, sem saída física verbalizada.
    // O cálculo fecha limpo no horário do handoff e não há "saída física retida" a sinalizar.
    const overrides = {
        actualEndedAt: null,
        effectiveEndedAt: "2026-03-25T22:20:00.000Z",
        bankActualEndAt: "2026-03-25T22:20:00.000Z",
    } as const;

    const proof = buildBankHoursProof(makeShift(overrides));
    assert.notEqual(proof.mode, "handoff");

    const shift = buildBankHoursHistoryModel([makeShift(overrides)]).doctors[0]?.shifts[0];
    assert.ok(shift);
    assert.equal(shift.flags.hasHandoffOverride, false);
    assert.equal(shift.countedEndAt, "2026-03-25T22:20:00.000Z");
});

test("buildBankHoursProof explains doubled overtime when entry stayed on time", () => {
    const proof = buildBankHoursProof(makeShift({
        actualEndedAt: "2026-03-25T22:35:00.000Z",
        effectiveEndedAt: "2026-03-25T22:35:00.000Z",
        bankActualEndAt: "2026-03-25T22:35:00.000Z",
        handoffEndedAt: "2026-03-25T22:35:00.000Z",
        overtimeMinutes: 20,
        creditedOvertimeMinutes: 40,
        balanceMinutes: 40,
    }));

    assert.equal(proof.mode, "double_overtime");
    assert.match(proof.summary, /dobro/i);
});

test("buildBankHoursProof explains simple overtime when entry was late", () => {
    const proof = buildBankHoursProof(makeShift({
        actualEndedAt: "2026-03-25T22:35:00.000Z",
        effectiveEndedAt: "2026-03-25T22:35:00.000Z",
        bankActualEndAt: "2026-03-25T22:35:00.000Z",
        handoffEndedAt: "2026-03-25T22:35:00.000Z",
        bankActualStartAt: "2026-03-25T10:30:00.000Z",
        arrivalDelayMinutes: 30,
        overtimeMinutes: 20,
        creditedOvertimeMinutes: 20,
        balanceMinutes: -10,
        ruleCode: "LATE_SIMPLE_OVERTIME",
    }));

    assert.equal(proof.mode, "simple_overtime");
    assert.match(proof.summary, /bônus em dobro/i);
    assert.match(proof.items.join(" "), /30 min de atraso/i);
});

test("buildBankHoursHistoryModel reconstructs closed shifts without persisted bank row", () => {
    const model = buildBankHoursHistoryModel([makeShift({
        bankScheduledStartAt: null,
        bankScheduledEndAt: null,
        bankActualStartAt: null,
        bankActualEndAt: null,
        hasPersistedBankEntry: false,
        arrivalDelayMinutes: null,
        overtimeMinutes: null,
        creditedOvertimeMinutes: null,
        balanceMinutes: null,
        ruleCode: null,
        bankHoursExplanation: null,
    })]);

    const shift = model.doctors[0]?.shifts[0];
    assert.ok(shift);
    assert.equal(shift.proof.mode, "handoff");
    assert.equal(shift.ruleCode, "ON_TIME_NO_OVERTIME");
    assert.equal(shift.bankScheduledStartAt, "2026-03-25T10:00:00.000Z");
    assert.equal(shift.bankScheduledEndAt, "2026-03-25T22:15:00.000Z");
    assert.match(shift.proof.items.join(" "), /reconstruída a partir da janela operacional/i);
});

test("buildBankHoursProof keeps open shifts as pending with precise explanation", () => {
    const proof = buildBankHoursProof(makeShift({
        handoffEndedAt: null,
        actualEndedAt: null,
        effectiveEndedAt: null,
        bankActualEndAt: null,
        creditedOvertimeMinutes: null,
        balanceMinutes: null,
        ruleCode: null,
        bankHoursExplanation: null,
    }));

    assert.equal(proof.mode, "pending");
    assert.match(proof.summary, /aberto/i);
    assert.match(proof.items.join(" "), /saída consolidada/i);
});

test("buildBankHoursHistoryModel collapses a continuity chain into one bank-hours row", () => {
    const model = buildBankHoursHistoryModel([
        makeShift({
            occupancyId: "chain-1",
            continuityGroupId: "chain-1",
            targetCode: "PR03",
            targetLabel: "Base PR03",
            startedAt: "2026-03-25T10:00:00.000Z",
            handoffEndedAt: "2026-03-25T22:00:00.000Z",
            actualEndedAt: "2026-03-25T22:00:00.000Z",
            effectiveEndedAt: "2026-03-25T22:00:00.000Z",
            shiftLabel: "SD",
            occupancyScheduledStartAt: "2026-03-25T10:00:00.000Z",
            occupancyScheduledEndAt: "2026-03-25T22:15:00.000Z",
            bankScheduledStartAt: "2026-03-25T10:00:00.000Z",
            bankScheduledEndAt: "2026-03-26T10:15:00.000Z",
            bankActualStartAt: "2026-03-25T10:00:00.000Z",
            bankActualEndAt: "2026-03-26T10:20:00.000Z",
            arrivalDelayMinutes: 0,
            overtimeMinutes: 5,
            creditedOvertimeMinutes: 10,
            balanceMinutes: 10,
            ruleCode: "ON_TIME_DOUBLE_OVERTIME",
            bankHoursExplanation: "continuidade consolidada",
        }),
        makeShift({
            occupancyId: "chain-2",
            continuityGroupId: "chain-1",
            domain: "regulation",
            targetCode: "1367",
            targetLabel: "Ramal 1367",
            startedAt: "2026-03-25T22:00:00.000Z",
            handoffEndedAt: "2026-03-26T10:20:00.000Z",
            actualEndedAt: "2026-03-26T10:20:00.000Z",
            effectiveEndedAt: "2026-03-26T10:20:00.000Z",
            shiftLabel: "SN",
            hasPersistedBankEntry: false,
            occupancyScheduledStartAt: "2026-03-25T22:00:00.000Z",
            occupancyScheduledEndAt: "2026-03-26T10:15:00.000Z",
            bankScheduledStartAt: null,
            bankScheduledEndAt: null,
            bankActualStartAt: null,
            bankActualEndAt: null,
            arrivalDelayMinutes: null,
            overtimeMinutes: null,
            creditedOvertimeMinutes: null,
            balanceMinutes: null,
            ruleCode: null,
            bankHoursExplanation: null,
        }),
    ]);

    const doctor = model.doctors[0];
    const shift = doctor?.shifts[0];

    assert.equal(model.summary.shiftCount, 1);
    assert.equal(doctor?.shiftCount, 1);
    assert.equal(shift?.shiftLabel, "P");
    assert.equal(shift?.targetCode, "PR03 -> 1367");
    assert.equal(shift?.countedEndAt, "2026-03-26T10:20:00.000Z");
    assert.equal(shift?.balanceMinutes, 10);
});

test("buildBankHoursProof highlights a manual balance override over the automatic result", () => {
    const proof = buildBankHoursProof(makeShift({
        actualEndedAt: "2026-03-25T22:35:00.000Z",
        effectiveEndedAt: "2026-03-25T22:35:00.000Z",
        bankActualEndAt: "2026-03-25T22:35:00.000Z",
        handoffEndedAt: "2026-03-25T22:35:00.000Z",
        overtimeMinutes: 20,
        creditedOvertimeMinutes: 40,
        balanceMinutes: 40,
        manualBalanceMinutes: 0,
        manualBalanceNotes: "Plantao sem direito a banco por decisao auditada.",
        manualBalanceUpdatedAt: "2026-03-26T12:00:00.000Z",
        manualBalanceActorEmail: "admin@mnrs.com.br",
    }));

    assert.equal(proof.mode, "neutral");
    assert.match(proof.summary, /ajustado manualmente/i);
    assert.match(proof.items.join(" "), /admin@mnrs.com.br/);
    assert.match(proof.items.join(" "), /sem direito a banco/i);
});
test("modelo nomeia quem rendeu quando a rendição prevalece sobre a saída física", () => {
    const model = buildBankHoursHistoryModel([
        makeShift(),
        makeShift({
            occupancyId: "occ-2",
            continuityGroupId: "cg-2",
            doctorId: "doc-2",
            doctorName: "Helena Prado",
            displayName: "Helena",
            startedAt: "2026-03-25T22:20:00.000Z",
            boardStartedAt: "2026-03-25T22:20:00.000Z",
            handoffEndedAt: null,
            actualEndedAt: null,
            effectiveEndedAt: null,
            bankScheduledStartAt: "2026-03-25T22:15:00.000Z",
            bankScheduledEndAt: "2026-03-26T10:15:00.000Z",
            bankActualStartAt: "2026-03-25T22:20:00.000Z",
            bankActualEndAt: null,
            hasPersistedBankEntry: false,
            arrivalDelayMinutes: null,
            overtimeMinutes: null,
            creditedOvertimeMinutes: null,
            balanceMinutes: null,
            ruleCode: null,
            bankHoursExplanation: null,
        }),
    ]);

    const vagner = model.doctors.find((doctor) => doctor.doctorId === "doc-1");
    const shift = vagner?.shifts[0];
    assert.ok(shift);
    assert.equal(shift.flags.hasHandoffOverride, true);
    assert.equal(shift.successorDoctorName, "Helena");
    assert.match(shift.proof.items.join(" "), /Helena assumiu a cobertura/);
});

test("correções da chefia viram entradas legíveis com o chefe da 2031 no momento", () => {
    const model = buildBankHoursHistoryModel([
        makeShift({
            auditTrail: [{
                id: "audit-1",
                action: "intervention_occupancy.corrected",
                actorEmail: "chefe@mnrs.com.br",
                createdAt: "2026-03-25T14:00:00.000Z",
                details: {
                    notes: "Chegada corrigida a pedido da coordenacao.",
                    previousStartedAt: "2026-03-25T10:00:00.000Z",
                    nextStartedAt: "2026-03-25T10:40:00.000Z",
                    beforeSnapshot: {
                        startedAt: "2026-03-25T10:00:00.000Z",
                        endedAt: "2026-03-25T22:20:00.000Z",
                        actualEndedAt: "2026-03-25T22:50:00.000Z",
                    },
                },
            }],
        }),
        // Chefia titular da 2031 cobrindo o horário da correção.
        makeShift({
            occupancyId: "occ-chief",
            continuityGroupId: "cg-chief",
            domain: "regulation",
            targetCode: "2031",
            targetLabel: "Ramal 2031",
            doctorId: "doc-chief",
            doctorName: "Paulo Cesar",
            displayName: "Paulo",
            startedAt: "2026-03-25T10:05:00.000Z",
            boardStartedAt: "2026-03-25T10:05:00.000Z",
            handoffEndedAt: "2026-03-25T22:00:00.000Z",
            actualEndedAt: "2026-03-25T22:00:00.000Z",
            effectiveEndedAt: "2026-03-25T22:00:00.000Z",
            hasPersistedBankEntry: false,
            arrivalDelayMinutes: null,
            overtimeMinutes: null,
            creditedOvertimeMinutes: null,
            balanceMinutes: null,
            ruleCode: null,
            bankHoursExplanation: null,
        }),
    ]);

    const vagner = model.doctors.find((doctor) => doctor.doctorId === "doc-1");
    const shift = vagner?.shifts[0];
    assert.ok(shift);
    assert.equal(shift.corrections.length, 1);
    const correction = shift.corrections[0]!;
    assert.equal(correction.actorEmail, "chefe@mnrs.com.br");
    assert.equal(correction.chiefOnDutyName, "Paulo");
    assert.equal(correction.undone, false);
    assert.match(correction.changes.join(" "), /Chegada: .*07:00.* → .*07:40/);
    assert.match(correction.notes ?? "", /pedido da coordenacao/);
});

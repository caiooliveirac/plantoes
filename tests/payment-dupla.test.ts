/**
 * Pagamento de quem divide o alvo com outro médico (regra do dono, 20/09/2026):
 *   - USA com dupla: os dois pagos, SEM aviso de conflito — o próprio sistema
 *     registrou que dividiam a base ([DUPLA]).
 *   - Ramal com deslocado: o aviso de conflito FICA (é erro de não ter remanejado),
 *     mas os dois são pagos — needs_review avisa, não bloqueia.
 * O invariante do ADR-006 (um médico, um plantão por slot) não muda: aqui são
 * médicos DIFERENTES no mesmo alvo.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { buildPayableShiftsFromBoards } from "@/modules/reporting/payable-shifts";
import {
    buildPaymentAllocationBoardModel,
    type PaymentAllocationRawRow,
    type PaymentAllocationTargetDefinition,
} from "@/services/board.service";

const SD = { startedAt: "2026-09-20T10:00:00.000Z", endedAt: "2026-09-20T22:00:00.000Z", shiftLabel: "SD" as const };
const CONFLICT = /Conflito entre medicos titulares/i;

function target(domain: "regulation" | "intervention", code: string): PaymentAllocationTargetDefinition {
    return { domain, targetCode: code, targetLabel: code, sortOrder: 1, defaultRole: null };
}

function row(overrides: Partial<PaymentAllocationRawRow> & { occupancyId: string; targetCode: string; doctorId: string }): PaymentAllocationRawRow {
    return {
        domain: "intervention",
        targetLabel: overrides.targetCode,
        doctorName: overrides.doctorId,
        displayName: overrides.doctorId,
        startedAt: "2026-09-20T10:02:00.000Z",
        boardStartedAt: "2026-09-20T10:02:00.000Z",
        endedAt: "2026-09-20T22:00:00.000Z",
        actualEndedAt: "2026-09-20T22:00:00.000Z",
        scheduledStartAt: "2026-09-20T10:00:00.000Z",
        scheduledEndAt: "2026-09-20T22:00:00.000Z",
        continuityGroupId: `cg-${overrides.occupancyId}`,
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
        notes: `${overrides.targetCode} chegada`,
        createdAt: overrides.startedAt ?? "2026-09-20T10:02:00.000Z",
        ...overrides,
    };
}

function board(targets: PaymentAllocationTargetDefinition[], rawRows: PaymentAllocationRawRow[]) {
    return buildPaymentAllocationBoardModel({
        targets,
        rawRows,
        operationalDate: "2026-09-20T15:00:00.000Z",
        ...SD,
        generatedAt: "2026-09-21T12:00:00.000Z",
    });
}

test("USA com dupla fora do quadro: os dois pagos, sem conflito, prontos para pagamento", () => {
    const model = board([target("intervention", "CZ50")], [
        row({ occupancyId: "leo", targetCode: "CZ50", doctorId: "Leo Morais" }),
        row({
            occupancyId: "copque",
            targetCode: "CZ50",
            doctorId: "Leonardo Copque",
            startedAt: "2026-09-20T12:40:00.000Z",
            boardStartedAt: null,
            notes: "Leonardo Copque CZ50\n[DUPLA] 2026-09-20T12:40:00.000Z",
        }),
    ]);

    const rows = model.intervention.filter((entry) => entry.occupancyId);
    assert.deepEqual(rows.map((entry) => entry.doctorId).sort(), ["Leo Morais", "Leonardo Copque"]);
    for (const entry of rows) {
        assert.equal(entry.hasDoctorOverlapConflict, false, `${entry.doctorId} sem conflito`);
        assert.equal(entry.issues.some((issue) => CONFLICT.test(issue)), false);
        assert.equal(entry.paymentStatus, "ready_for_payment");
    }

    const shifts = buildPayableShiftsFromBoards([model]);
    assert.equal(shifts.length, 2);
    assert.ok(shifts.every((shift) => shift.paymentUnit === 1));
});

test("dupla que assumiu o quadro quando o titular saiu: marcador fica e o conflito não aparece", () => {
    const model = board([target("intervention", "CZ50")], [
        row({
            occupancyId: "leo",
            targetCode: "CZ50",
            doctorId: "Leo Morais",
            endedAt: "2026-09-20T18:00:00.000Z",
            actualEndedAt: "2026-09-20T18:00:00.000Z",
        }),
        row({
            occupancyId: "copque",
            targetCode: "CZ50",
            doctorId: "Leonardo Copque",
            startedAt: "2026-09-20T12:40:00.000Z",
            boardStartedAt: "2026-09-20T18:00:00.000Z",
            notes: "Leonardo Copque CZ50\n[DUPLA] 2026-09-20T12:40:00.000Z",
        }),
    ]);

    const rows = model.intervention.filter((entry) => entry.occupancyId);
    assert.equal(rows.length, 2);
    assert.ok(rows.every((entry) => !entry.issues.some((issue) => CONFLICT.test(issue))));
    assert.equal(buildPayableShiftsFromBoards([model]).length, 2);
});

test("dois titulares de verdade na mesma base (sem [DUPLA]) seguem acusando conflito", () => {
    const model = board([target("intervention", "CZ50")], [
        row({ occupancyId: "sadja", targetCode: "CZ50", doctorId: "Sadja" }),
        row({ occupancyId: "murilo", targetCode: "CZ50", doctorId: "Murilo", source: "admin_correction", notes: "remanejado por furo na area" }),
    ]);

    const rows = model.intervention.filter((entry) => entry.occupancyId);
    assert.ok(rows.length >= 1);
    assert.ok(rows.every((entry) => entry.issues.some((issue) => CONFLICT.test(issue))));
});

test("ramal com deslocado: o aviso fica, e os dois são pagos", () => {
    const model = board([target("regulation", "2152")], [
        row({
            occupancyId: "kemylla",
            domain: "regulation",
            targetCode: "2152",
            doctorId: "Kemylla",
            boardStartedAt: null,
            notes: "Kemylla 2152 SD\n[DESLOCADO] 2026-09-20T13:00:00.000Z por remanejamento da chefia",
        }),
        row({
            occupancyId: "yngra",
            domain: "regulation",
            targetCode: "2152",
            doctorId: "Yngra",
            startedAt: "2026-09-20T13:00:00.000Z",
            boardStartedAt: "2026-09-20T13:00:00.000Z",
            source: "admin_correction",
        }),
    ]);

    const rows = model.regulation.filter((entry) => entry.occupancyId);
    assert.deepEqual(rows.map((entry) => entry.doctorId).sort(), ["Kemylla", "Yngra"]);
    assert.ok(rows.every((entry) => entry.issues.some((issue) => CONFLICT.test(issue))), "aviso de conflito mantido no ramal");
    assert.ok(rows.every((entry) => entry.paymentStatus === "needs_review"));

    const shifts = buildPayableShiftsFromBoards([model]);
    assert.deepEqual(shifts.map((shift) => shift.doctorId).sort(), ["Kemylla", "Yngra"], "aviso não bloqueia: os dois pagáveis");
    assert.ok(shifts.every((shift) => shift.paymentUnit === 1));
});

test("deslocado de base vindo do bot é pago (antes sumia da folha por não ter board)", () => {
    const model = board([target("intervention", "PM40")], [
        row({
            occupancyId: "noturno",
            targetCode: "PM40",
            doctorId: "Deslocado",
            boardStartedAt: null,
            notes: "Deslocado PM40 SD\n[DESLOCADO] 2026-09-20T13:00:00.000Z por Titular Novo",
        }),
        row({
            occupancyId: "novo",
            targetCode: "PM40",
            doctorId: "Titular Novo",
            startedAt: "2026-09-20T13:00:00.000Z",
            boardStartedAt: "2026-09-20T13:00:00.000Z",
        }),
    ]);

    const shifts = buildPayableShiftsFromBoards([model]);
    assert.deepEqual(shifts.map((shift) => shift.doctorId).sort(), ["Deslocado", "Titular Novo"]);
});

test("ADR-006 intacto: dupla numa base + titular em outra no mesmo turno paga um plantão só", () => {
    const model = board([target("intervention", "CZ50"), { ...target("intervention", "PM40"), sortOrder: 2 }], [
        row({ occupancyId: "leo", targetCode: "CZ50", doctorId: "Leo Morais" }),
        row({
            occupancyId: "copque-dupla",
            targetCode: "CZ50",
            doctorId: "Leonardo Copque",
            startedAt: "2026-09-20T10:20:00.000Z",
            boardStartedAt: null,
            notes: "Leonardo Copque CZ50\n[DUPLA] 2026-09-20T10:20:00.000Z",
        }),
        row({
            occupancyId: "copque-titular",
            targetCode: "PM40",
            doctorId: "Leonardo Copque",
            startedAt: "2026-09-20T10:30:00.000Z",
            boardStartedAt: "2026-09-20T10:30:00.000Z",
        }),
    ]);

    const shifts = buildPayableShiftsFromBoards([model]);
    assert.equal(shifts.filter((shift) => shift.doctorId === "Leonardo Copque").length, 1, "um médico, um plantão por slot");
    assert.equal(shifts.filter((shift) => shift.doctorId === "Leo Morais").length, 1);
});

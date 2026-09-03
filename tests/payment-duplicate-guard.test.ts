/**
 * Invariante financeiro: um médico recebe NO MÁXIMO um plantão por slot de 12h,
 * independente de quantos alvos (ramal/base) o registrem no mesmo horário.
 *
 * Roda no CI (test:deploy). Se este arquivo quebrar, o fechamento pode pagar em
 * dobro — não relaxe as asserções sem ler docs/adr/006-one-payment-per-doctor-slot.md.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { buildPayableShiftsFromBoards } from "@/modules/reporting/payable-shifts";
import {
    buildPaymentAllocationBoardModel,
    type PaymentAllocationBoard,
    type PaymentAllocationRawRow,
    type PaymentAllocationTargetDefinition,
} from "@/services/board.service";

const SD = { startedAt: "2026-08-26T10:00:00.000Z", endedAt: "2026-08-26T22:00:00.000Z", shiftLabel: "SD" as const };
const SN = { startedAt: "2026-08-26T22:00:00.000Z", endedAt: "2026-08-27T10:00:00.000Z", shiftLabel: "SN" as const };

function target(domain: "regulation" | "intervention", code: string, sortOrder: number): PaymentAllocationTargetDefinition {
    return { domain, targetCode: code, targetLabel: code, sortOrder, defaultRole: null };
}

function row(overrides: Partial<PaymentAllocationRawRow> & { occupancyId: string; targetCode: string }): PaymentAllocationRawRow {
    const domain = overrides.domain ?? "regulation";
    return {
        domain,
        targetLabel: overrides.targetCode,
        doctorId: "doc-1",
        doctorName: "Medico Um",
        displayName: "Um",
        startedAt: "2026-08-26T10:00:00.000Z",
        boardStartedAt: "2026-08-26T10:00:00.000Z",
        endedAt: "2026-08-26T22:15:00.000Z",
        actualEndedAt: "2026-08-26T22:15:00.000Z",
        scheduledStartAt: "2026-08-26T10:00:00.000Z",
        scheduledEndAt: "2026-08-26T22:15:00.000Z",
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
        createdAt: overrides.startedAt ?? "2026-08-26T10:00:00.000Z",
        ...overrides,
    };
}

function board(targets: PaymentAllocationTargetDefinition[], rawRows: PaymentAllocationRawRow[], slot: typeof SD | typeof SN): PaymentAllocationBoard {
    return buildPaymentAllocationBoardModel({
        targets,
        rawRows,
        operationalDate: "2026-08-26T15:00:00.000Z",
        ...slot,
        generatedAt: "2026-08-28T00:00:00.000Z",
    });
}

/** Conta plantões pagáveis por médico+slot; o máximo deve ser 1. */
function maxShiftsPerDoctorSlot(boards: PaymentAllocationBoard[]) {
    const counts = new Map<string, number>();
    for (const shift of buildPayableShiftsFromBoards(boards)) {
        const key = `${shift.doctorId}|${shift.slotStartedAt}`;
        counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return Math.max(0, ...counts.values());
}

const REG = [target("regulation", "2154", 1), target("regulation", "2032", 2)];

test("titular em dois ramais no mesmo turno paga um so", () => {
    const boards = [board(REG, [
        row({ occupancyId: "a", targetCode: "2154" }),
        row({ occupancyId: "b", targetCode: "2032", startedAt: "2026-08-26T10:05:00.000Z", boardStartedAt: "2026-08-26T10:05:00.000Z" }),
    ], SD)];
    assert.equal(maxShiftsPerDoctorSlot(boards), 1);
});

test("sombra num ramal com titular + titular retroagido noutro ramal paga um so (caso Matheus Libório 26/08/2026)", () => {
    const rawRows = [
        row({ occupancyId: "ana", targetCode: "2032", doctorId: "doc-ana", doctorName: "Ana", displayName: "Ana", startedAt: "2026-08-26T09:49:15.000Z", boardStartedAt: "2026-08-26T09:49:15.000Z", endedAt: "2026-08-26T21:30:40.000Z", actualEndedAt: "2026-08-26T21:30:40.000Z" }),
        row({ occupancyId: "m-2032", targetCode: "2032", shiftLabel: "P", endedAt: "2026-08-27T10:15:00.000Z", actualEndedAt: "2026-08-27T10:15:00.000Z", scheduledEndAt: "2026-08-27T10:15:00.000Z", notes: "ESTAVANOPLANTAO", createdAt: "2026-08-26T21:31:01.000Z" }),
        row({ occupancyId: "m-2154", targetCode: "2154", startedAt: "2026-08-26T09:53:57.000Z", boardStartedAt: null, endedAt: "2026-08-26T21:30:40.000Z", actualEndedAt: "2026-08-26T21:30:40.000Z", notes: "[telegram sombra] Medico Um sombra SD 2154" }),
        row({ occupancyId: "kem", targetCode: "2154", doctorId: "doc-kem", doctorName: "Kemylla", displayName: "Kemylla", startedAt: "2026-08-26T10:31:00.000Z", boardStartedAt: "2026-08-26T10:31:00.000Z" }),
    ];
    const boards = [board(REG, rawRows, SD), board(REG, rawRows, SN)];
    assert.equal(maxShiftsPerDoctorSlot(boards), 1);
    const shifts = buildPayableShiftsFromBoards(boards);
    assert.equal(shifts.filter((shift) => shift.doctorId === "doc-1").length, 2, "SD + SN, nao SD + SD + SN");
    assert.ok(shifts.some((shift) => shift.doctorId === "doc-ana"), "titular real do 2032 segue pago");
    assert.ok(shifts.some((shift) => shift.doctorId === "doc-kem"), "titular real do 2154 segue pago");
    const flagged = shifts.find((shift) => shift.doctorId === "doc-1" && shift.shiftLabel === "SD");
    assert.ok(flagged?.issues.some((issue) => issue.startsWith("Tambem consta em")), "o plantao pago avisa a duplicata");
});

test("mesmo medico em base de intervencao e ramal de regulacao no mesmo turno paga um so", () => {
    const targets = [target("intervention", "PM04", 1), target("regulation", "2033", 2)];
    const boards = [board(targets, [
        row({ occupancyId: "int", domain: "intervention", targetCode: "PM04", startedAt: "2026-08-26T10:02:00.000Z", boardStartedAt: "2026-08-26T10:02:00.000Z", endedAt: "2026-08-26T21:56:00.000Z", actualEndedAt: "2026-08-26T21:56:00.000Z" }),
        row({ occupancyId: "reg", targetCode: "2033", startedAt: "2026-08-26T10:02:00.000Z", boardStartedAt: "2026-08-26T10:02:00.000Z", endedAt: "2026-08-27T10:07:00.000Z", actualEndedAt: "2026-08-27T10:07:00.000Z", shiftLabel: "P", scheduledEndAt: "2026-08-27T10:15:00.000Z" }),
    ], SD)];
    assert.equal(maxShiftsPerDoctorSlot(boards), 1);
});

test("duas sombras do mesmo medico em ramais diferentes pagam um so", () => {
    const boards = [board(REG, [
        row({ occupancyId: "s1", targetCode: "2154", boardStartedAt: null, notes: "[telegram sombra] Medico Um sombra SD 2154" }),
        row({ occupancyId: "s2", targetCode: "2032", boardStartedAt: null, notes: "[telegram sombra] Medico Um sombra SD 2032" }),
        row({ occupancyId: "t1", targetCode: "2154", doctorId: "doc-t1", doctorName: "Titular Um", displayName: "T1" }),
        row({ occupancyId: "t2", targetCode: "2032", doctorId: "doc-t2", doctorName: "Titular Dois", displayName: "T2" }),
    ], SD)];
    assert.equal(maxShiftsPerDoctorSlot(boards), 1);
});

test("P de 24h num alvo so paga SD e SN (slots distintos, nao e duplicata)", () => {
    const rawRows = [row({ occupancyId: "p", targetCode: "2032", shiftLabel: "P", endedAt: "2026-08-27T10:15:00.000Z", actualEndedAt: "2026-08-27T10:15:00.000Z", scheduledEndAt: "2026-08-27T10:15:00.000Z" })];
    const boards = [board(REG, rawRows, SD), board(REG, rawRows, SN)];
    assert.equal(maxShiftsPerDoctorSlot(boards), 1);
    assert.equal(buildPayableShiftsFromBoards(boards).length, 2);
});

test("sombra e titular de medicos diferentes no mesmo alvo pagam os dois (sombra legitima)", () => {
    const boards = [board(REG, [
        row({ occupancyId: "tit", targetCode: "2154" }),
        row({ occupancyId: "som", targetCode: "2154", doctorId: "doc-2", doctorName: "Medico Dois", displayName: "Dois", boardStartedAt: null, notes: "[telegram sombra] Medico Dois sombra SD 2154" }),
    ], SD)];
    assert.equal(buildPayableShiftsFromBoards(boards).length, 2);
});

test("remanejo real no meio do turno (janelas sem sobreposicao) nao e marcado como duplicata", () => {
    const boards = [board(REG, [
        row({ occupancyId: "antes", targetCode: "2154", endedAt: "2026-08-26T16:00:00.000Z", actualEndedAt: "2026-08-26T16:00:00.000Z" }),
        row({ occupancyId: "depois", targetCode: "2032", startedAt: "2026-08-26T16:00:00.000Z", boardStartedAt: "2026-08-26T16:00:00.000Z" }),
    ], SD)];
    const shifts = buildPayableShiftsFromBoards(boards);
    assert.ok(shifts.every((shift) => !shift.issues.some((issue) => issue.startsWith("Duplicado:") || issue.startsWith("Tambem consta em"))));
});

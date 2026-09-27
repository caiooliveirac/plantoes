import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildPayableShiftsFromBoards } from "@/modules/reporting/payable-shifts";
import { buildTurnoShadowReport, renderTurnoShadowReportMarkdown } from "@/modules/reporting/turno-shadow-report";
import type { PaymentAllocationBoard } from "@/services/board.service";
import { withReadOnlySession } from "@/scripts/relatorio-sombra-turno";

type Row = PaymentAllocationBoard["intervention"][number];

// SD de 15/09/2026 (terça): 07:00–19:00 em São Paulo.
const SLOT = { startedAt: "2026-09-15T10:00:00.000Z", endedAt: "2026-09-15T22:00:00.000Z" };

function row(overrides: Partial<Row>): Row {
    return {
        domain: "intervention",
        targetCode: "2152",
        targetLabel: "2152",
        sortOrder: 1,
        defaultRole: null,
        disabledAt: null,
        disabledReason: null,
        disabledDuringShift: false,
        disabledEntireShift: false,
        occupancyId: "occ",
        doctorId: "doc",
        doctorName: "Médico",
        displayName: "Médico",
        startedAt: SLOT.startedAt,
        endedAt: SLOT.endedAt,
        actualEndedAt: SLOT.endedAt,
        scheduledStartAt: SLOT.startedAt,
        scheduledEndAt: SLOT.endedAt,
        shiftLabel: "SD",
        roleLabel: null,
        ramalLabel: null,
        source: "telegram",
        notes: null,
        candidateCount: 1,
        candidateLabels: [],
        conflictCandidateLabels: [],
        hasDoctorOverlapConflict: false,
        earlyDepartureOutcome: null,
        paymentStatus: "ready_for_payment",
        issues: [],
        arrivalDelayMinutes: 0,
        overtimeMinutes: 0,
        creditedOvertimeMinutes: 0,
        balanceMinutes: 0,
        ruleCode: "ON_TIME_NO_OVERTIME",
        bankHoursExplanation: "ok",
        sourceShiftLabel: "SD",
        sourceStartedAt: SLOT.startedAt,
        sourceBoardStartedAt: SLOT.startedAt,
        sourceEndedAt: SLOT.endedAt,
        sourceActualEndedAt: SLOT.endedAt,
        sourceScheduledStartAt: SLOT.startedAt,
        sourceScheduledEndAt: SLOT.endedAt,
        sourceArrivalDelayMinutes: 0,
        sourceOvertimeMinutes: 0,
        sourceCreditedOvertimeMinutes: 0,
        sourceBalanceMinutes: 0,
        sourceRuleCode: "ON_TIME_NO_OVERTIME",
        sourceBankHoursExplanation: "ok",
        ...overrides,
    } as Row;
}

function board(intervention: Row[]): PaymentAllocationBoard {
    return {
        generatedAt: "2026-09-16T00:00:00.000Z",
        operationalDate: "2026-09-15T12:00:00.000Z",
        shiftLabel: "SD",
        ...SLOT,
        summary: {
            totalTargets: intervention.length,
            assignedCount: intervention.length,
            readyForPaymentCount: intervention.length,
            needsReviewCount: 0,
            unassignedCount: 0,
            disabledCount: 0,
        },
        regulation: [],
        intervention,
    };
}

// Fixture com os três desenhos do ADR-007:
//  - Kêmylla: 1 min no 2154 julgado bank_only + 11h20 no 2152 → divergência sem mudar valor;
//  - Expulso: 30 min sem corte → por turno seria só banco (perde o plantão);
//  - Saída real: 3h com bank_only no único pedaço → concordam.
const FIXTURE = [board([
    row({ occupancyId: "k1", doctorId: "kemylla", doctorName: "Kêmylla", targetCode: "2154",
        startedAt: "2026-09-15T10:15:00.000Z", endedAt: "2026-09-15T10:16:00.000Z", earlyDepartureOutcome: "bank_only" }),
    row({ occupancyId: "k2", doctorId: "kemylla", doctorName: "Kêmylla", targetCode: "2152",
        startedAt: "2026-09-15T10:40:00.000Z" }),
    row({ occupancyId: "e1", doctorId: "expulso", doctorName: "Expulso", targetCode: "BR05",
        startedAt: "2026-09-15T10:05:00.000Z", endedAt: "2026-09-15T10:35:00.000Z" }),
    row({ occupancyId: "s1", doctorId: "saiu", doctorName: "Saiu", targetCode: "BR06",
        startedAt: "2026-09-15T10:05:00.000Z", endedAt: "2026-09-15T13:05:00.000Z", earlyDepartureOutcome: "bank_only" }),
])];

const SETTINGS = {
    profiles: new Map([["kemylla", "generalist" as const], ["expulso", "generalist" as const], ["saiu", "generalist" as const]]),
    employmentTypes: new Map([["kemylla", "pj" as const], ["expulso", "pj" as const], ["saiu", "pj" as const]]),
};

describe("relatório da sombra ADR-007 R4", () => {
    const report = buildTurnoShadowReport(buildPayableShiftsFromBoards(FIXTURE), SETTINGS);

    it("conta as divergências por tipo, com o que a própria sombra calculou", () => {
        assert.deepEqual(report.countsByKind, {
            corte_em_turno_inteiro: 1,
            corte_fora_do_fim: 0,
            turno_curto_sem_corte: 1,
        });
        const kemylla = report.divergences.find((item) => item.doctorId === "kemylla");
        assert.equal(kemylla?.targetCode, "2154");
        assert.equal(kemylla?.recordedOutcome, "bank_only");
        assert.equal(kemylla?.turnoOutcome, "full_shift");
        assert.equal(kemylla?.operationalDate, "2026-09-15");
        assert.equal(report.divergences.some((item) => item.doctorId === "saiu"), false, "saída real concorda");
    });

    it("impacto é por turno: Kêmylla já recebe 1 plantão; o expulso perderia o dele", () => {
        const kemylla = report.turns.find((turn) => turn.doctorId === "kemylla");
        assert.deepEqual([kemylla?.currentUnits, kemylla?.shadowUnits, kemylla?.deltaCents], [1, 1, 0]);
        const expulso = report.turns.find((turn) => turn.doctorId === "expulso");
        assert.deepEqual([expulso?.currentUnits, expulso?.shadowUnits, expulso?.deltaUnits], [1, 0, -1]);
        assert.equal(expulso?.deltaCents, -124487, "tarifa generalista de dia útil");
        assert.equal(report.totals.turns, 2);
        assert.equal(report.totals.deltaCents, -124487);
        assert.equal(report.totals.gainCents, 0);
    });

    it("markdown traz contagem, impacto e exemplos com médico/data/turno", () => {
        const md = renderTurnoShadowReportMarkdown(report, { from: "2026-09-15", to: "2026-09-15", maxExamples: 5 });
        assert.match(md, /# Sombra ADR-007 R4 — 2026-09-15 a 2026-09-15/);
        assert.match(md, /\| \*\*Total\*\* \| \*\*2\*\* \|/);
        assert.match(md, /\| 2026-09-15 \| SD \| Kêmylla \| 2154 \| bank_only \| full_shift \| 11h21 \|/);
        assert.match(md, /Turnos afetados: \*\*2\*\*/);
        assert.match(md, /Expulso/);
    });

    it("sem divergência, relatório vazio e sem turnos", () => {
        const vazio = buildTurnoShadowReport(buildPayableShiftsFromBoards([board([row({})])]), SETTINGS);
        assert.equal(vazio.divergences.length, 0);
        assert.equal(vazio.totals.turns, 0);
    });
});

describe("withReadOnlySession", () => {
    it("acrescenta default_transaction_read_only sem perder o search_path", () => {
        const url = new URL(withReadOnlySession("postgres://u:p@127.0.0.1:5433/plantoes?options=-csearch_path%3Doperations_v2"));
        assert.equal(url.searchParams.get("options"), "-csearch_path=operations_v2 -c default_transaction_read_only=on");
    });
});

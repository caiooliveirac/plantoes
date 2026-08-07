import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { computeCycleMetrics, type CycleMetricsInput } from "@/lib/contracts/balance-metrics";
import { findPendingRenewals } from "@/lib/contracts/renewal";
import type { ContractBalanceRow } from "@/services/contract-balance.service";

const brl = (value: number) => Math.round(value * 100);
const HOJE = new Date("2026-08-07T11:00:00Z");

function row(overrides: Partial<ContractBalanceRow> = {}): ContractBalanceRow {
    const cycleStart = overrides.cycleStart ?? "2025-08-01";
    const cycleEnd = overrides.cycleEnd ?? "2026-08-01";
    const input: CycleMetricsInput = {
        ceilingCents: brl(165732),
        balanceCents: brl(40000),
        observedConsumptionCents: brl(60000),
        observedSince: new Date(`${cycleStart}T00:00:00Z`),
        cycleStart: new Date(`${cycleStart}T00:00:00Z`),
        cycleEnd: new Date(`${cycleEnd}T00:00:00Z`),
        asOf: HOJE,
        weekdayRateCents: brl(1244.87),
        weekendRateCents: brl(1381.10),
        weekdayShifts: 40,
        weekendShifts: 10,
    };
    return {
        contractId: "c-1",
        doctorId: "d-1",
        doctorName: "Médico Teste",
        contractNumber: "123/2025",
        companyName: null,
        category: "generalista",
        weeklyHours: 24,
        cycleStart,
        cycleEnd,
        ceilingCents: input.ceilingCents,
        awaitingOpeningBalance: false,
        settledBalanceCents: input.balanceCents,
        pendingConsumptionCents: 0,
        statement: [],
        metrics: computeCycleMetrics(input),
        metricsInput: input,
        ...overrides,
    };
}

describe("findPendingRenewals — contrato vencido ou renovado sem valor", () => {
    it("contrato que venceu no mês passado e não tem sucessor é pendência", () => {
        // cycleEnd exclusivo em 01/07 = valeu até 30/06; hoje é 07/08.
        const pendencias = findPendingRenewals([row({ cycleEnd: "2026-07-01" })], HOJE);
        assert.equal(pendencias.length, 1);
        assert.equal(pendencias[0].kind, "vencido");
        assert.equal(pendencias[0].daysOverdue, 37);
    });

    it("vence hoje já conta como vencido — cycleEnd é exclusivo", () => {
        const pendencias = findPendingRenewals([row({ cycleEnd: "2026-08-07" })], HOJE);
        assert.equal(pendencias.length, 1);
        assert.equal(pendencias[0].kind, "vencido");
        assert.equal(pendencias[0].daysOverdue, 0);
    });

    it("contrato correndo dentro do ciclo não é pendência", () => {
        assert.deepEqual(findPendingRenewals([row({ cycleEnd: "2027-01-01" })], HOJE), []);
    });

    it("ciclo novo já valendo e sem saldo de abertura é pendência", () => {
        const pendencias = findPendingRenewals([
            row({ cycleStart: "2026-08-01", cycleEnd: "2027-08-01", awaitingOpeningBalance: true }),
        ], HOJE);
        assert.equal(pendencias.length, 1);
        assert.equal(pendencias[0].kind, "sem_saldo_de_abertura");
        assert.equal(pendencias[0].daysOverdue, 0);
    });

    it("ciclo futuro sem saldo ainda não cobra nada — há tempo de digitar", () => {
        assert.deepEqual(findPendingRenewals([
            row({ cycleStart: "2026-09-01", cycleEnd: "2027-09-01", awaitingOpeningBalance: true }),
        ], HOJE), []);
    });

    it("médico com o velho vencido e o novo sem valor aparece uma vez só", () => {
        const pendencias = findPendingRenewals([
            row({ contractId: "velho", cycleStart: "2025-08-01", cycleEnd: "2026-08-01" }),
            row({ contractId: "novo", cycleStart: "2026-08-01", cycleEnd: "2027-08-01", awaitingOpeningBalance: true }),
        ], HOJE);
        assert.equal(pendencias.length, 1);
        assert.equal(pendencias[0].contractId, "novo");
        assert.equal(pendencias[0].kind, "sem_saldo_de_abertura");
    });

    it("renovação lançada em dia zera a pendência dos dois contratos", () => {
        assert.deepEqual(findPendingRenewals([
            row({ contractId: "velho", cycleStart: "2025-08-01", cycleEnd: "2026-08-01" }),
            row({ contractId: "novo", cycleStart: "2026-08-01", cycleEnd: "2027-08-01" }),
        ], HOJE), []);
    });

    it("ordena o vencido há mais tempo primeiro", () => {
        const pendencias = findPendingRenewals([
            row({ contractId: "a", doctorId: "d-a", doctorName: "Ana", cycleEnd: "2026-08-01" }),
            row({ contractId: "b", doctorId: "d-b", doctorName: "Bruno", cycleEnd: "2026-05-01" }),
        ], HOJE);
        assert.deepEqual(pendencias.map((item) => item.doctorName), ["Bruno", "Ana"]);
    });
});

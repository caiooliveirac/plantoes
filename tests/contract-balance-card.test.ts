/**
 * Regras do bloco de saldo do fechamento que não podem quebrar em silêncio.
 * O componente é React e a suíte do repo não renderiza React — então o que se
 * testa aqui é a decisão, que é onde mora o risco.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { computeCycleMetrics, type CycleMetricsInput } from "@/lib/contracts/balance-metrics";

const brl = (value: number) => Math.round(value * 100);

function input(overrides: Partial<CycleMetricsInput> = {}): CycleMetricsInput {
    return {
        ceilingCents: brl(165732),
        balanceCents: brl(21036.70),
        observedConsumptionCents: brl(60000),
        observedSince: new Date("2026-01-23T00:00:00Z"),
        cycleStart: new Date("2026-01-23T00:00:00Z"),
        cycleEnd: new Date("2027-01-23T00:00:00Z"),
        asOf: new Date("2026-06-30T00:00:00Z"),
        weekdayRateCents: brl(1244.87),
        weekendRateCents: brl(1381.10),
        weekdayShifts: 40,
        weekendShifts: 10,
        ...overrides,
    };
}

/** Mesma conta do card: aplica o fechamento em aberto sobre o estado atual. */
function aplicarFechamento(base: CycleMetricsInput, draft: { amountCents: number; weekdayShifts: number; weekendShifts: number }) {
    return computeCycleMetrics({
        ...base,
        balanceCents: base.balanceCents - draft.amountCents,
        observedConsumptionCents: base.observedConsumptionCents + draft.amountCents,
        weekdayShifts: base.weekdayShifts + draft.weekdayShifts,
        weekendShifts: base.weekendShifts + draft.weekendShifts,
    });
}

describe("bloco de saldo — antes e depois do fechamento", () => {
    it("o 'depois' é o 'hoje' menos o fechamento em aberto", () => {
        const base = input();
        const antes = computeCycleMetrics(base);
        const depois = aplicarFechamento(base, { amountCents: brl(13679.07), weekdayShifts: 7, weekendShifts: 3 });
        assert.equal(antes.balanceCents, brl(21036.70));
        assert.equal(depois.balanceCents, brl(21036.70) - brl(13679.07));
    });

    it("o fechamento que derruba o saldo abaixo de zero é o gatilho do banner", () => {
        const depois = aplicarFechamento(input(), { amountCents: brl(30000), weekdayShifts: 20, weekendShifts: 4 });
        assert.ok(depois.balanceCents < 0);
        assert.equal(depois.riskLevel, "depleted");
    });
});

describe("bloco de saldo — contrato ainda sem saldo informado", () => {
    // Saldo zero porque ninguém digitou, não porque acabou: não pode disparar o
    // banner de estouro, senão o botão de atestar trava sem checkbox na tela.
    const semSaldo = input({ balanceCents: 0, observedConsumptionCents: 0, weekdayShifts: 0, weekendShifts: 0 });

    it("fica negativo ao aplicar o fechamento — por isso a guarda existe", () => {
        const depois = aplicarFechamento(semSaldo, { amountCents: brl(12448.70), weekdayShifts: 10, weekendShifts: 0 });
        assert.ok(depois.balanceCents < 0, "é este negativo que a guarda do card precisa ignorar");
    });
});

describe("bloco de saldo — teto não cadastrado", () => {
    const semTeto = computeCycleMetrics(input({ ceilingCents: null }));

    it("não mostra percentual consumido nem índice de ritmo", () => {
        assert.equal(semTeto.consumedPct, null);
        assert.equal(semTeto.paceIndex, null);
    });

    it("mas continua com saldo e com plantões restantes", () => {
        assert.ok(semTeto.balanceCents > 0);
        assert.ok(semTeto.remainingWeekdayShifts > 0);
    });
});

describe("bloco de saldo — amostra curta", () => {
    it("não anuncia data de exaustão nos primeiros 45 dias do razão", () => {
        const metrics = computeCycleMetrics(input({
            observedSince: new Date("2026-06-10T00:00:00Z"),
            observedConsumptionCents: brl(40000),
        }));
        assert.equal(metrics.hasReliableBurnRate, false);
        assert.equal(metrics.projectedDepletionDate, null);
    });
});

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
    classifyRisk,
    computeCycleMetrics,
    floorHalf,
    simulateClosing,
    type CycleMetricsInput,
} from "@/lib/contracts/balance-metrics";

const brl = (value: number) => Math.round(value * 100);

const WEEKDAY = brl(1244.87);
const WEEKEND = brl(1381.10);

function input(overrides: Partial<CycleMetricsInput> = {}): CycleMetricsInput {
    return {
        ceilingCents: brl(331464),
        balanceCents: brl(185635.74),
        observedConsumptionCents: brl(145828.26),
        observedSince: new Date("2026-01-03T00:00:00Z"),
        cycleStart: new Date("2026-01-03T00:00:00Z"),
        cycleEnd: new Date("2027-01-03T00:00:00Z"),
        asOf: new Date("2026-05-31T00:00:00Z"),
        weekdayRateCents: WEEKDAY,
        weekendRateCents: WEEKEND,
        weekdayShifts: 0,
        weekendShifts: 0,
        ...overrides,
    };
}

describe("computeCycleMetrics — Caio Oliveira do Carmo (SPEC §5.3)", () => {
    const metrics = computeCycleMetrics(input());

    it("mede o ciclo em 148 de 365 dias", () => {
        assert.equal(metrics.totalDays, 365);
        assert.equal(metrics.elapsedDays, 148);
    });

    it("reproduz o saldo da planilha", () => {
        assert.equal(metrics.balanceCents, 18563574);
        assert.equal(metrics.consumedCents, 14582826);
    });

    it("acha o ritmo 8,5% acima do esperado", () => {
        assert.ok(metrics.paceIndex !== null);
        assert.ok(Math.abs(metrics.paceIndex! - 1.085) < 0.005, `paceIndex=${metrics.paceIndex}`);
    });

    it("calcula burn rate de ~R$ 29.970/mês", () => {
        assert.ok(Math.abs(metrics.burnRateMonthlyCents - brl(29970.33)) < brl(1));
    });

    it("projeta folga negativa de ~1 mês e risco 'warning'", () => {
        assert.ok(metrics.slackMonths !== null);
        assert.ok(Math.abs(metrics.slackMonths! - -0.94) < 0.05, `slack=${metrics.slackMonths}`);
        assert.equal(metrics.riskLevel, "warning");
    });

    it("projeta a exaustão em 05/12/2026, antes do fim do ciclo", () => {
        assert.equal(metrics.projectedDepletionDate?.toISOString().slice(0, 10), "2026-12-05");
        // O ponto da feature: acaba ANTES do fim do ciclo (03/01/2027).
        assert.ok(metrics.projectedDepletionDate! < new Date("2027-01-03T00:00:00Z"));
    });

    it("traduz o orçamento mensal saudável em plantões de meio em meio", () => {
        assert.ok(Math.abs(metrics.healthyMonthlyBudgetCents - brl(26020)) < brl(10));
        assert.equal(metrics.monthlyWeekdayShifts % 0.5, 0);
        assert.ok(metrics.monthlyWeekdayShifts >= 20 && metrics.monthlyWeekdayShifts <= 21);
    });
});

describe("computeCycleMetrics — Karen Seifarth (regressão do caso extremo)", () => {
    const metrics = computeCycleMetrics(input({
        ceilingCents: brl(248598),
        balanceCents: brl(-89762.24),
        observedConsumptionCents: brl(338360.24),
        observedSince: new Date("2025-08-16T00:00:00Z"),
        cycleStart: new Date("2025-08-16T00:00:00Z"),
        cycleEnd: new Date("2026-08-16T00:00:00Z"),
    }));

    it("acha o ritmo 72% acima do esperado", () => {
        assert.ok(Math.abs(metrics.paceIndex! - 1.725) < 0.01, `paceIndex=${metrics.paceIndex}`);
    });

    it("classifica como 'depleted' e não projeta mais nada", () => {
        assert.equal(metrics.riskLevel, "depleted");
        assert.equal(metrics.projectedDepletionDate, null);
        assert.equal(metrics.runwayMonths, null);
    });

    it("não oferece nenhum plantão restante com saldo negativo", () => {
        assert.equal(metrics.remainingWeekdayShifts, 0);
        assert.equal(metrics.remainingShiftsAtOwnMix, 0);
    });
});

describe("computeCycleMetrics — bordas", () => {
    it("saldo exatamente zero é 'depleted'", () => {
        const metrics = computeCycleMetrics(input({ balanceCents: 0 }));
        assert.equal(metrics.riskLevel, "depleted");
    });

    it("consumo zero: sem divisão por zero, runway indefinido, risco 'safe'", () => {
        const metrics = computeCycleMetrics(input({
            balanceCents: brl(331464),
            observedConsumptionCents: 0,
        }));
        assert.equal(metrics.runwayMonths, null);
        assert.equal(metrics.slackMonths, null);
        assert.equal(metrics.projectedDepletionDate, null);
        assert.equal(metrics.burnRateMonthlyCents, 0);
        assert.equal(metrics.projectedOverrunCents, 0);
        assert.equal(metrics.riskLevel, "safe");
    });

    it("ciclo aberto em 29/02 termina em 28/02 do ano seguinte", () => {
        const metrics = computeCycleMetrics(input({
            cycleStart: new Date("2028-02-29T00:00:00Z"),
            cycleEnd: new Date("2029-02-28T00:00:00Z"),
            observedSince: new Date("2028-02-29T00:00:00Z"),
            asOf: new Date("2028-06-01T00:00:00Z"),
        }));
        assert.equal(metrics.totalDays, 365);
        assert.equal(metrics.elapsedDays, 93);
    });

    it("janela observada curta: sem data de exaustão e risco no máximo 'watch'", () => {
        const metrics = computeCycleMetrics(input({
            observedSince: new Date("2026-05-11T00:00:00Z"),
            observedConsumptionCents: brl(60000),
            balanceCents: brl(20000),
        }));
        assert.equal(metrics.observedDays, 20);
        assert.equal(metrics.hasReliableBurnRate, false);
        assert.equal(metrics.projectedDepletionDate, null);
        assert.ok(["safe", "watch"].includes(metrics.riskLevel), `risco=${metrics.riskLevel}`);
    });

    it("asOf depois do fim do ciclo não passa de 100% decorrido", () => {
        const metrics = computeCycleMetrics(input({ asOf: new Date("2027-06-01T00:00:00Z") }));
        assert.equal(metrics.elapsedDays, metrics.totalDays);
        assert.equal(metrics.remainingDays, 0);
        assert.equal(metrics.healthyMonthlyBudgetCents, 0);
    });
});

describe("computeCycleMetrics — teto ainda não cadastrado", () => {
    const metrics = computeCycleMetrics(input({
        ceilingCents: null,
        balanceCents: brl(50000),
        observedConsumptionCents: brl(30000),
    }));

    it("devolve null, não zero, no que depende do teto", () => {
        assert.equal(metrics.consumedPct, null);
        assert.equal(metrics.expectedConsumptionCents, null);
        assert.equal(metrics.paceIndex, null);
        assert.equal(metrics.paceDeltaCents, null);
    });

    it("mantém saldo, ritmo e tradução em plantões", () => {
        assert.equal(metrics.consumedCents, brl(30000));
        assert.ok(metrics.burnRateMonthlyCents > 0);
        assert.ok(metrics.remainingWeekdayShifts > 0);
    });
});

describe("computeCycleMetrics — contrato vindo do backfill", () => {
    // Ciclo começou em agosto/2025, mas só há consumo medido de junho/2026 em
    // diante: o burn rate tem que sair da janela observada, não do ciclo inteiro.
    const metrics = computeCycleMetrics(input({
        ceilingCents: brl(165732),
        balanceCents: brl(40000),
        observedConsumptionCents: brl(20000),
        observedSince: new Date("2026-05-31T00:00:00Z"),
        cycleStart: new Date("2025-08-16T00:00:00Z"),
        cycleEnd: new Date("2026-08-16T00:00:00Z"),
        asOf: new Date("2026-07-31T00:00:00Z"),
    }));

    it("mede o ritmo nos 61 dias observados, não nos 349 do ciclo", () => {
        assert.equal(metrics.observedDays, 61);
        assert.equal(metrics.elapsedDays, 349);
        // R$ 20.000 em 61 dias ~ R$ 9.972/mês. Pelo ciclo inteiro daria ~R$ 1.700.
        assert.ok(metrics.burnRateMonthlyCents > brl(9000), `burn=${metrics.burnRateMonthlyCents}`);
    });

    it("conta o consumo do ciclo inteiro pelo teto, não só o observado", () => {
        assert.equal(metrics.consumedCents, brl(165732) - brl(40000));
        assert.ok(metrics.consumedCents > metrics.balanceCents);
    });
});

describe("classifyRisk", () => {
    const base = { balanceCents: brl(10000), hasReliableBurnRate: true };

    it("folga menor que -1 mês é crítico", () => {
        assert.equal(classifyRisk({ ...base, slackMonths: -1.5, paceIndex: 1.2 }), "critical");
    });

    it("folga pouco negativa é warning", () => {
        assert.equal(classifyRisk({ ...base, slackMonths: -0.5, paceIndex: 1.05 }), "warning");
    });

    it("ritmo acima de 1,15 puxa para watch mesmo com folga confortável", () => {
        assert.equal(classifyRisk({ ...base, slackMonths: 3, paceIndex: 1.3 }), "watch");
    });

    it("folga e ritmo bons são safe", () => {
        assert.equal(classifyRisk({ ...base, slackMonths: 3, paceIndex: 0.9 }), "safe");
    });

    it("amostra curta nunca passa de watch, mesmo com folga péssima", () => {
        assert.equal(
            classifyRisk({ ...base, slackMonths: -5, paceIndex: 3, hasReliableBurnRate: false }),
            "watch",
        );
    });

    it("saldo negativo é depleted mesmo com amostra curta", () => {
        assert.equal(
            classifyRisk({ balanceCents: -1, slackMonths: null, paceIndex: null, hasReliableBurnRate: false }),
            "depleted",
        );
    });
});

describe("floorHalf", () => {
    it("arredonda para baixo em passos de 0,5", () => {
        assert.equal(floorHalf(3.9), 3.5);
        assert.equal(floorHalf(3.5), 3.5);
        assert.equal(floorHalf(3.4), 3);
        assert.equal(floorHalf(0.4), 0);
    });

    it("nunca devolve negativo nem NaN", () => {
        assert.equal(floorHalf(-2), 0);
        assert.equal(floorHalf(Number.NaN), 0);
        assert.equal(floorHalf(Number.POSITIVE_INFINITY), 0);
    });
});

describe("simulateClosing", () => {
    const original = input({ weekdayShifts: 10, weekendShifts: 4 });
    const result = simulateClosing(original, {
        amountCents: brl(24878.60),
        weekdayShifts: 11.5,
        weekendShifts: 6,
    });

    it("desconta o fechamento do saldo", () => {
        assert.equal(result.before.balanceCents, brl(185635.74));
        assert.equal(result.after.balanceCents, brl(185635.74) - brl(24878.60));
    });

    it("soma o consumo do rascunho ao ritmo", () => {
        assert.ok(result.after.burnRateMonthlyCents > result.before.burnRateMonthlyCents);
    });

    it("não muta a entrada — a UI recalcula a cada tecla", () => {
        assert.equal(original.balanceCents, brl(185635.74));
        assert.equal(original.weekdayShifts, 10);
    });

    it("mostra o estouro quando o fechamento derruba o saldo abaixo de zero", () => {
        const overrun = simulateClosing(
            input({ balanceCents: brl(5000) }),
            { amountCents: brl(12000), weekdayShifts: 8, weekendShifts: 2 },
        );
        assert.ok(overrun.after.balanceCents < 0);
        assert.equal(overrun.after.riskLevel, "depleted");
    });
});

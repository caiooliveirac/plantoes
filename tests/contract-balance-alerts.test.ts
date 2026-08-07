import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { computeCycleMetrics, type CycleMetricsInput } from "@/lib/contracts/balance-metrics";
import { buildContractAlerts, buildWeeklyDigest, shouldRunContractBalanceCycle } from "@/modules/telegram/contract-balance-alerts";
import type { ContractBalanceRow } from "@/services/contract-balance.service";

const brl = (value: number) => Math.round(value * 100);
const HOJE = new Date("2026-06-30T11:00:00Z");

function metricsInput(overrides: Partial<CycleMetricsInput> = {}): CycleMetricsInput {
    return {
        ceilingCents: brl(165732),
        balanceCents: brl(40000),
        observedConsumptionCents: brl(60000),
        observedSince: new Date("2026-01-23T00:00:00Z"),
        cycleStart: new Date("2026-01-23T00:00:00Z"),
        cycleEnd: new Date("2027-01-23T00:00:00Z"),
        asOf: HOJE,
        weekdayRateCents: brl(1244.87),
        weekendRateCents: brl(1381.10),
        weekdayShifts: 40,
        weekendShifts: 10,
        ...overrides,
    };
}

function row(overrides: Partial<ContractBalanceRow> = {}, inputOverrides: Partial<CycleMetricsInput> = {}): ContractBalanceRow {
    const input = metricsInput(inputOverrides);
    return {
        contractId: "c-1",
        doctorId: "d-1",
        doctorName: "Médico Teste",
        contractNumber: "123/2025",
        companyName: null,
        category: "generalista",
        paymentProfile: "generalist",
        employmentType: "pj",
        isNaoPlantonista: false,
        weeklyHours: 24,
        cycleStart: input.cycleStart.toISOString().slice(0, 10),
        cycleEnd: input.cycleEnd.toISOString().slice(0, 10),
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

describe("buildContractAlerts — o que merece alerta", () => {
    it("saldo zerado alerta, e só isso — não empilha marco em cima", () => {
        const alerts = buildContractAlerts([row({}, { balanceCents: brl(-5000) })], HOJE);
        assert.equal(alerts.length, 1);
        assert.equal(alerts[0].trigger, "depleted");
    });

    it("projeção de exaustão antes do fim do ciclo alerta", () => {
        const alerts = buildContractAlerts([
            row({}, { balanceCents: brl(20000), observedConsumptionCents: brl(140000) }),
        ], HOJE);
        assert.ok(alerts.some((alert) => alert.trigger === "exhaustion_projected"));
    });

    it("marco de consumo alerta uma vez, no maior patamar atingido", () => {
        const alerts = buildContractAlerts([
            row({}, { balanceCents: brl(10000) }),
        ], HOJE).filter((alert) => alert.trigger === "milestone");
        assert.equal(alerts.length, 1);
        // 165.732 - 10.000 = 155.732 consumido = 94% -> patamar de 90%.
        assert.ok(alerts[0].discriminator.endsWith(":0.9"), alerts[0].discriminator);
    });

    it("marco NÃO alerta quem está abaixo do ritmo — isso é ruído, não notícia", () => {
        // Metade do teto consumido com 77% do ciclo decorrido: médico indo bem.
        const alerts = buildContractAlerts([
            row({}, {
                balanceCents: brl(82866),
                cycleStart: new Date("2025-10-24T00:00:00Z"),
                cycleEnd: new Date("2026-10-24T00:00:00Z"),
            }),
        ], HOJE).filter((alert) => alert.trigger === "milestone");
        assert.equal(alerts.length, 0);
    });

    it("contrato esperando o coordenador não gera alerta nenhum", () => {
        const alerts = buildContractAlerts([
            row({ awaitingOpeningBalance: true }, { balanceCents: 0, observedConsumptionCents: 0 }),
        ], HOJE);
        assert.equal(alerts.length, 0);
    });

    // Regressão do caso João Miguez (dossiê 03-validacao-alertas-08-2026): o
    // contrato sem teto lançado que JÁ PRODUZIU. Antes do conserto,
    // `awaitingOpeningBalance` exigia consumo zero, então a flag caía no
    // primeiro plantão e o bot anunciava "saldo zerado" com o valor da própria
    // produção do médico. Aqui a flag é `true` mesmo com consumo — que é o que
    // o serviço passa a devolver quando não há lançamento de abertura no razão.
    it("contrato sem abertura no razão não alerta nem depois de o médico produzir", () => {
        const alerts = buildContractAlerts([
            row({ awaitingOpeningBalance: true, pendingConsumptionCents: brl(25277.89) }, {
                balanceCents: brl(-25277.89),
                observedConsumptionCents: brl(25277.89),
                observedSince: new Date("2026-03-10T00:00:00Z"),
            }),
        ], HOJE);
        assert.deepEqual(alerts, []);
    });

    it("o digest conta esse contrato como aguardando, não como estourado", () => {
        const digest = buildWeeklyDigest([
            row({ awaitingOpeningBalance: true, pendingConsumptionCents: brl(25277.89) }, {
                balanceCents: brl(-25277.89),
                observedConsumptionCents: brl(25277.89),
            }),
            row({ contractId: "c-2", doctorName: "Outro Médico" }),
        ], HOJE);
        assert.ok(digest);
        assert.match(digest, /1 aguardando o saldo de abertura/);
        assert.match(digest, /\*0\* com saldo zerado/);
        assert.doesNotMatch(digest, /Médico Teste/);
    });

    it("amostra curta não vira alerta de projeção", () => {
        const alerts = buildContractAlerts([
            row({}, {
                balanceCents: brl(20000),
                observedConsumptionCents: brl(140000),
                observedSince: new Date("2026-06-15T00:00:00Z"),
            }),
        ], HOJE);
        assert.equal(alerts.some((alert) => alert.trigger === "exhaustion_projected"), false);
    });

    it("ciclo terminando em 60 dias avisa, com o saldo não utilizado", () => {
        const alerts = buildContractAlerts([
            row({}, { cycleEnd: new Date("2026-08-10T00:00:00Z") }),
        ], HOJE).filter((alert) => alert.trigger === "cycle_ending");
        assert.equal(alerts.length, 1);
        assert.match(alerts[0].message, /Saldo não utilizado/);
    });

    it("ciclo longe não avisa", () => {
        const alerts = buildContractAlerts([row()], HOJE).filter((alert) => alert.trigger === "cycle_ending");
        assert.equal(alerts.length, 0);
    });
});

describe("dedup — 30 dias simulados", () => {
    // Espelha a chave usada no envio: mesmo gatilho, mesmo contrato, mesmo
    // discriminador, mesma janela de 7 dias = mesma chave = não sai de novo.
    const DEDUP_DAYS = 7;
    function chave(alert: { trigger: string; contractId: string; discriminator: string }, quando: Date) {
        const bucket = Math.floor(quando.getTime() / (DEDUP_DAYS * 86_400_000));
        return `admin:contract-alert:${alert.trigger}:${alert.contractId}:${alert.discriminator}:${bucket}`;
    }

    it("o mesmo alerta não repete mais de uma vez por semana em 30 dias", () => {
        const enviadas = new Set<string>();
        for (let dia = 0; dia < 30; dia++) {
            const quando = new Date(HOJE.getTime() + dia * 86_400_000);
            const alerts = buildContractAlerts([
                row({}, { balanceCents: brl(20000), observedConsumptionCents: brl(140000), asOf: quando }),
            ], quando);
            for (const alert of alerts) enviadas.add(chave(alert, quando));
        }

        const porGatilho = new Map<string, number>();
        for (const key of enviadas) {
            const trigger = key.split(":")[2];
            porGatilho.set(trigger, (porGatilho.get(trigger) ?? 0) + 1);
        }
        // 30 dias / 7 = no máximo 5 janelas por gatilho.
        for (const [trigger, total] of porGatilho) {
            assert.ok(total <= 5, `${trigger} saiu ${total} vezes em 30 dias`);
        }
    });

    it("nenhuma chave se repete — a mesma janela nunca envia duas vezes", () => {
        const emitidas: string[] = [];
        for (let dia = 0; dia < 30; dia++) {
            const quando = new Date(HOJE.getTime() + dia * 86_400_000);
            for (const alert of buildContractAlerts([row({}, { balanceCents: brl(-1), asOf: quando })], quando)) {
                const key = chave(alert, quando);
                if (!emitidas.includes(key)) emitidas.push(key);
            }
        }
        assert.equal(new Set(emitidas).size, emitidas.length);
        assert.ok(emitidas.length <= 5, `saiu ${emitidas.length} vezes em 30 dias`);
    });
});

describe("shouldRunContractBalanceCycle", () => {
    it("só age na janela das 8h de São Paulo", () => {
        assert.equal(shouldRunContractBalanceCycle(new Date("2026-06-30T11:05:00Z")), true);
        assert.equal(shouldRunContractBalanceCycle(new Date("2026-06-30T11:15:00Z")), false);
        assert.equal(shouldRunContractBalanceCycle(new Date("2026-06-30T20:00:00Z")), false);
    });
});

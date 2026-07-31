/**
 * Motor de cálculo do saldo contratual (docs/saldo-contrato/SPEC.md §5).
 *
 * Módulo PURO: nenhum import de banco, de Next ou de React. Recebe números,
 * devolve números. Roda igual no servidor e no cliente — é o que permite o bloco
 * do fechamento recalcular ao vivo, a cada plantão marcado, sem round-trip.
 *
 * DINHEIRO EM CENTAVOS INTEIROS, ponta a ponta, como o resto do repo
 * (modules/reporting/payable-shifts.ts). Nenhum valor monetário passa por float.
 * As únicas frações aqui são razões e contagens de plantão (que andam de 0,5).
 *
 * Duas diferenças em relação ao SPEC §5, ambas consequência de como o backfill
 * ficou (docs/saldo-contrato/00-levantamento.md §6):
 *
 *  1. O teto pode ser desconhecido. O backfill importou o saldo de maio, não o
 *     teto, e para parte dos contratos o coordenador ainda vai digitar. Sem teto
 *     não existe percentual consumido nem índice de ritmo — mas saldo, burn rate,
 *     runway e tradução em plantões continuam valendo. Os campos que dependem do
 *     teto vêm `null` em vez de zero: zero mentiria dizendo "não consumiu nada".
 *
 *  2. O burn rate é medido na JANELA OBSERVADA, não no ciclo inteiro. Um contrato
 *     backfillado tem saldo desde maio e consumo registrado só de junho em diante;
 *     dividir esse consumo pelos dias decorridos do ciclo (que pode ter começado
 *     em 2024) daria um ritmo artificialmente baixo, e uma projeção otimista —
 *     justo o erro que a feature existe para evitar.
 */

/** Tudo em centavos inteiros. `null` em ceilingCents = teto ainda não cadastrado. */
export interface CycleMetricsInput {
    /** Teto do ciclo. `null` quando o coordenador ainda não informou. */
    ceilingCents: number | null;
    /** Saldo atual, vindo da view contract_balance. Pode ser negativo. */
    balanceCents: number;
    /** Consumo registrado no razão desde `observedSince`. Sempre >= 0. */
    observedConsumptionCents: number;
    /** Data do lançamento de abertura: início da janela em que há consumo medido. */
    observedSince: Date;
    cycleStart: Date;
    /** Exclusivo. */
    cycleEnd: Date;
    /** Data de referência do cálculo. */
    asOf: Date;
    weekdayRateCents: number;
    weekendRateCents: number;
    /** Plantões acumulados na janela observada, para o mix real do médico. */
    weekdayShifts: number;
    weekendShifts: number;
}

export type RiskLevel = "safe" | "watch" | "warning" | "critical" | "depleted";

export interface CycleMetrics {
    balanceCents: number;
    /** Consumo do ciclo. Com teto: `teto − saldo`. Sem teto: só o observado. */
    consumedCents: number;
    /** 0..1+. `null` sem teto. */
    consumedPct: number | null;

    elapsedDays: number;
    totalDays: number;
    elapsedPct: number;
    remainingDays: number;
    remainingMonths: number;

    /** Ritmo linear esperado até hoje. `null` sem teto. */
    expectedConsumptionCents: number | null;
    /** IR: consumo / esperado. `null` sem teto. */
    paceIndex: number | null;
    /** consumo − esperado. `null` sem teto. */
    paceDeltaCents: number | null;

    /** Dias com consumo medido. Abaixo de 45 a projeção não é confiável. */
    observedDays: number;
    /** `false` nos primeiros 45 dias de janela observada. */
    hasReliableBurnRate: boolean;
    burnRateMonthlyCents: number;
    /** Quanto dá para gastar por mês para chegar ao fim do ciclo. */
    healthyMonthlyBudgetCents: number;
    /** `null` = saldo não acaba no ritmo atual (ou ritmo zero). */
    runwayMonths: number | null;
    /** runway − meses restantes. Negativo = vai estourar antes do fim. */
    slackMonths: number | null;
    /** `null` quando não projetável (ritmo zero, saldo zerado ou amostra curta). */
    projectedDepletionDate: Date | null;
    /** Quanto estouraria mantendo o ritmo até o fim do ciclo. 0 se não estoura. */
    projectedOverrunCents: number;

    /** Custo médio real do mix do médico. Sem histórico, média das duas tarifas. */
    avgShiftCostCents: number;
    remainingWeekdayShifts: number;
    remainingWeekendShifts: number;
    remainingShiftsAtOwnMix: number;
    monthlyWeekdayShifts: number;
    monthlyWeekendShifts: number;
    monthlyShiftsAtOwnMix: number;

    riskLevel: RiskLevel;
    asOf: Date;
}

const MS_PER_DAY = 86_400_000;
/** Abaixo disso o burn rate é ruído: um mês pesado distorce tudo (SPEC §5.2). */
export const MIN_OBSERVED_DAYS = 45;

/** Diferença em dias inteiros, ignorando hora — as datas aqui são competência. */
function daysBetween(from: Date, to: Date): number {
    const a = Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate());
    const b = Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), to.getUTCDate());
    return Math.round((b - a) / MS_PER_DAY);
}

function clamp(value: number, min: number, max: number): number {
    return Math.min(Math.max(value, min), max);
}

/** Arredonda para baixo em múltiplos de 0,5 — meio plantão é a menor unidade. */
export function floorHalf(value: number): number {
    if (!Number.isFinite(value) || value <= 0) return 0;
    return Math.floor(value * 2) / 2;
}

/** Quantos plantões de `rateCents` cabem em `budgetCents`, em passos de 0,5. */
function shiftsWithin(budgetCents: number, rateCents: number): number {
    if (rateCents <= 0 || budgetCents <= 0) return 0;
    return floorHalf(budgetCents / rateCents);
}

/**
 * Risco pela FOLGA — a métrica que responde à pergunta do chefe ("ele chega ao
 * fim do ciclo?") — com o índice de ritmo como desempate.
 *
 * O amortecedor dos 45 dias é regra, não estética: com amostra curta o teto do
 * risco é 'watch'. Pintar de vermelho um médico que teve um mês pesado logo após
 * a abertura do ciclo destrói a confiança no indicador.
 */
export function classifyRisk(params: {
    balanceCents: number;
    slackMonths: number | null;
    paceIndex: number | null;
    hasReliableBurnRate: boolean;
}): RiskLevel {
    const { balanceCents, slackMonths, paceIndex, hasReliableBurnRate } = params;

    // Saldo zerado ou negativo é fato consumado, não projeção: vale sempre.
    if (balanceCents <= 0) return "depleted";

    const tight = (slackMonths !== null && slackMonths < 0.5) || (paceIndex !== null && paceIndex > 1.15);

    if (!hasReliableBurnRate) return tight ? "watch" : "safe";

    if (slackMonths !== null) {
        if (slackMonths < -1) return "critical";
        if (slackMonths < -0.25) return "warning";
    }
    return tight ? "watch" : "safe";
}

export function computeCycleMetrics(input: CycleMetricsInput): CycleMetrics {
    const {
        ceilingCents, balanceCents, observedConsumptionCents, observedSince,
        cycleStart, cycleEnd, asOf, weekdayRateCents, weekendRateCents,
        weekdayShifts, weekendShifts,
    } = input;

    const totalDays = Math.max(1, daysBetween(cycleStart, cycleEnd));
    const elapsedDays = clamp(daysBetween(cycleStart, asOf), 0, totalDays);
    const remainingDays = totalDays - elapsedDays;
    const elapsedPct = elapsedDays / totalDays;
    const daysPerMonth = totalDays / 12;
    const remainingMonths = remainingDays / daysPerMonth;

    // Com teto, o consumo do ciclo é o que sumiu do teto — inclui o que foi gasto
    // antes de o razão começar. Sem teto, só dá para afirmar o que foi observado.
    const consumedCents = ceilingCents === null
        ? observedConsumptionCents
        : ceilingCents - balanceCents;

    const consumedPct = ceilingCents === null || ceilingCents === 0
        ? null
        : consumedCents / ceilingCents;
    const expectedConsumptionCents = ceilingCents === null
        ? null
        : Math.round(ceilingCents * elapsedPct);
    const paceIndex = expectedConsumptionCents === null || expectedConsumptionCents <= 0
        ? null
        : consumedCents / expectedConsumptionCents;
    const paceDeltaCents = expectedConsumptionCents === null
        ? null
        : consumedCents - expectedConsumptionCents;

    // Ritmo medido só onde há medição: da abertura do razão até hoje.
    const observedDays = Math.max(0, daysBetween(observedSince, asOf));
    const hasReliableBurnRate = observedDays >= MIN_OBSERVED_DAYS;
    const dailyBurnCents = observedDays > 0 ? observedConsumptionCents / observedDays : 0;
    const burnRateMonthlyCents = Math.round(dailyBurnCents * daysPerMonth);

    const healthyMonthlyBudgetCents = remainingMonths > 0
        ? Math.round(balanceCents / remainingMonths)
        : 0;

    const burning = dailyBurnCents > 0 && balanceCents > 0;
    const runwayDays = burning ? balanceCents / dailyBurnCents : null;
    const runwayMonths = runwayDays === null ? null : runwayDays / daysPerMonth;
    const slackMonths = runwayMonths === null ? null : runwayMonths - remainingMonths;

    // Sem amostra confiável não se anuncia data de exaustão: o número existiria,
    // mas seria chute com cara de precisão.
    const projectedDepletionDate = burning && hasReliableBurnRate && runwayDays !== null
        ? new Date(asOf.getTime() + Math.round(runwayDays) * MS_PER_DAY)
        : null;

    const projectedOverrunCents = Math.max(
        0,
        Math.round(dailyBurnCents * remainingDays) - Math.max(0, balanceCents),
    );

    const totalShifts = weekdayShifts + weekendShifts;
    const avgShiftCostCents = totalShifts > 0
        ? Math.round(observedConsumptionCents / totalShifts)
        : Math.round((weekdayRateCents + weekendRateCents) / 2);

    return {
        balanceCents,
        consumedCents,
        consumedPct,
        elapsedDays,
        totalDays,
        elapsedPct,
        remainingDays,
        remainingMonths,
        expectedConsumptionCents,
        paceIndex,
        paceDeltaCents,
        observedDays,
        hasReliableBurnRate,
        burnRateMonthlyCents,
        healthyMonthlyBudgetCents,
        runwayMonths,
        slackMonths,
        projectedDepletionDate,
        projectedOverrunCents,
        avgShiftCostCents,
        remainingWeekdayShifts: shiftsWithin(balanceCents, weekdayRateCents),
        remainingWeekendShifts: shiftsWithin(balanceCents, weekendRateCents),
        remainingShiftsAtOwnMix: shiftsWithin(balanceCents, avgShiftCostCents),
        monthlyWeekdayShifts: shiftsWithin(healthyMonthlyBudgetCents, weekdayRateCents),
        monthlyWeekendShifts: shiftsWithin(healthyMonthlyBudgetCents, weekendRateCents),
        monthlyShiftsAtOwnMix: shiftsWithin(healthyMonthlyBudgetCents, avgShiftCostCents),
        riskLevel: classifyRisk({ balanceCents, slackMonths, paceIndex, hasReliableBurnRate }),
        asOf,
    };
}

/**
 * Métricas de um fechamento ainda não confirmado: o "saldo depois" do bloco do
 * payment closing. Não persiste nada — é a mesma função pura com o consumo do
 * rascunho somado. É isto que o cliente chama a cada plantão marcado.
 */
export function simulateClosing(
    input: CycleMetricsInput,
    draft: { amountCents: number; weekdayShifts: number; weekendShifts: number },
): { before: CycleMetrics; after: CycleMetrics } {
    return {
        before: computeCycleMetrics(input),
        after: computeCycleMetrics({
            ...input,
            balanceCents: input.balanceCents - draft.amountCents,
            observedConsumptionCents: input.observedConsumptionCents + draft.amountCents,
            weekdayShifts: input.weekdayShifts + draft.weekdayShifts,
            weekendShifts: input.weekendShifts + draft.weekendShifts,
        }),
    };
}

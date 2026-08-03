/**
 * Extrato mês a mês do saldo contratual.
 *
 * Módulo PURO, como lib/contracts/balance-metrics.ts: recebe números e datas,
 * devolve linhas. É o que permite testar a regra mais delicada do extrato — a
 * fronteira do ciclo — sem banco.
 *
 * A pergunta que o extrato responde é a do médico olhando a própria página:
 * "quanto eu tinha em 01/07, quanto gastei em julho, quanto sobrou em 01/08?".
 * Por isso cada linha carrega DATAS, não só o nome do mês: saldo inicial datado
 * (01/07) e saldo final datado (01/08 — ou HOJE, se o mês ainda está correndo).
 *
 * A fronteira do ciclo é regra dura: um contrato renovado em 01/08 NÃO recebe
 * consumo de agosto — agosto pertence ao ciclo novo. O extrato do contrato
 * antigo termina exatamente em 01/08, e é isso que corrige o caso Paula Mayana
 * (plantões de agosto entravam no cálculo do contrato anterior).
 */

export interface StatementMonthMovements {
    /** Consumo do mês em centavos, sempre >= 0. */
    consumptionCents: number;
    /** Ajustes manuais do mês em centavos, com sinal (positivo credita). */
    adjustmentsCents: number;
}

export interface ContractStatementMonth {
    /** "2026-07" */
    monthKey: string;
    /** Data do saldo inicial (AAAA-MM-DD). No primeiro mês é a data da abertura. */
    startDate: string;
    startBalanceCents: number;
    consumptionCents: number;
    adjustmentsCents: number;
    /** Data do saldo final: dia 1º do mês seguinte, o fim do ciclo, ou hoje. */
    endDate: string;
    endBalanceCents: number;
    /** `true` = o mês ainda está correndo e o saldo final é o de HOJE. */
    endIsToday: boolean;
}

/** "2026-07" -> "2026-08". */
export function nextMonthKey(monthKey: string): string {
    const [year, month] = monthKey.split("-").map(Number);
    const nextMonth = month === 12 ? 1 : month + 1;
    const nextYear = month === 12 ? year + 1 : year;
    return `${nextYear}-${String(nextMonth).padStart(2, "0")}`;
}

/**
 * O mês (AAAA-MM) tem alguma interseção com a janela [cycleStart, cycleEnd)?
 *
 * É a guarda da fronteira de renovação: com cycleEnd = 2026-08-01, o mês
 * 2026-08 fica FORA — plantões de agosto não consomem o contrato antigo.
 */
export function isMonthWithinCycle(monthKey: string, cycleStart: string, cycleEnd: string): boolean {
    const monthStart = `${monthKey}-01`;
    const monthEndExclusive = `${nextMonthKey(monthKey)}-01`;
    return monthStart < cycleEnd && monthEndExclusive > cycleStart;
}

export interface BuildStatementParams {
    /** Crédito de abertura em centavos e sua competência. */
    openingCents: number;
    openingDate: string;
    /** Movimentos por mês (AAAA-MM). Meses ausentes contam como zero. */
    months: Map<string, StatementMonthMovements>;
    /** Fim do ciclo, EXCLUSIVO (AAAA-MM-DD). O extrato para aqui. */
    cycleEnd: string;
    /** Data de referência (AAAA-MM-DD). */
    asOfDate: string;
}

/**
 * Monta o extrato: uma linha por mês, da abertura até hoje ou até o fim do
 * ciclo — o que vier primeiro. O saldo corre linha a linha
 * (inicial + ajustes − consumo = final), então a última linha é, por
 * construção, o saldo atual do contrato.
 *
 * Ajustes datados fora da janela do extrato (antes da abertura ou depois do
 * último mês) são dobrados para a primeira/última linha: o saldo final tem que
 * bater com a soma do razão, senão o extrato vira uma segunda verdade.
 */
export function buildContractStatement(params: BuildStatementParams): ContractStatementMonth[] {
    const { openingCents, openingDate, cycleEnd, asOfDate } = params;

    const cycleEnded = asOfDate >= cycleEnd;
    const firstMonth = openingDate.slice(0, 7);
    // Fim exclusivo => o último mês do ciclo é o do dia anterior a cycleEnd.
    const lastCycleMonth = previousDayMonthKey(cycleEnd);
    const lastMonth = cycleEnded ? lastCycleMonth : minKey(asOfDate.slice(0, 7), lastCycleMonth);
    if (lastMonth < firstMonth) return [];

    // Ajustes fora da janela dobram para as pontas (ver doc acima).
    const movements = new Map<string, StatementMonthMovements>();
    for (const [monthKey, value] of params.months) {
        const clamped = monthKey < firstMonth ? firstMonth : monthKey > lastMonth ? lastMonth : monthKey;
        const current = movements.get(clamped) ?? { consumptionCents: 0, adjustmentsCents: 0 };
        movements.set(clamped, {
            consumptionCents: current.consumptionCents + value.consumptionCents,
            adjustmentsCents: current.adjustmentsCents + value.adjustmentsCents,
        });
    }

    const rows: ContractStatementMonth[] = [];
    let running = openingCents;
    for (let monthKey = firstMonth; monthKey <= lastMonth; monthKey = nextMonthKey(monthKey)) {
        const movement = movements.get(monthKey) ?? { consumptionCents: 0, adjustmentsCents: 0 };
        const isLast = monthKey === lastMonth;
        const startBalanceCents = running;
        const endBalanceCents = running + movement.adjustmentsCents - movement.consumptionCents;
        rows.push({
            monthKey,
            startDate: monthKey === firstMonth ? openingDate : `${monthKey}-01`,
            startBalanceCents,
            consumptionCents: movement.consumptionCents,
            adjustmentsCents: movement.adjustmentsCents,
            endDate: isLast
                ? (cycleEnded ? cycleEnd : asOfDate)
                : `${nextMonthKey(monthKey)}-01`,
            endBalanceCents,
            endIsToday: isLast && !cycleEnded,
        });
        running = endBalanceCents;
    }
    return rows;
}

function minKey(a: string, b: string): string {
    return a < b ? a : b;
}

/** Mês (AAAA-MM) do dia anterior a uma data AAAA-MM-DD. */
function previousDayMonthKey(dateIso: string): string {
    const date = new Date(`${dateIso}T00:00:00Z`);
    date.setUTCDate(date.getUTCDate() - 1);
    return date.toISOString().slice(0, 7);
}

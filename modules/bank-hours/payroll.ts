/**
 * Abatimento em folha do banco de horas — o acerto do ESTATUTÁRIO.
 *
 * Módulo propositalmente SEM imports (como pending-actions): roda no client
 * component do banco de horas e na rota que grava o abatimento.
 *
 * Regra de negócio: o estatutário não é pago por plantão neste sistema, então
 * saldo negativo não vira "plantão vermelho" — o atraso de cada plantão é
 * descontado direto na folha de pagamento/ponto da prefeitura, plantão a
 * plantão, dentro do mês. O que a coordenação precisa é a soma dos atrasos do
 * mês e um registro de que ela já foi levada à folha, para o banco não cobrar
 * a mesma hora duas vezes.
 *
 * Só os plantões NEGATIVOS entram: o crédito (hora extra) continua acumulando
 * no banco e pode virar plantão extra pela régua normal de +12h.
 */

export const BANK_HOURS_PAYROLL_SETTLEMENT_KIND = "payroll";

export interface PayrollShiftInput {
    /** Mês operacional do plantão (AAAA-MM, fuso de São Paulo). */
    monthKey: string;
    balanceMinutes: number | null;
}

export interface PayrollSettlementInput {
    monthKey: string;
    kind: string;
    /** Positivo = abatimento lançado; negativo = estorno de um abatimento. */
    deltaMinutes: number;
}

export interface PayrollDeductionForMonth {
    monthKey: string;
    /** Plantões do mês com saldo negativo (os que a folha desconta). */
    negativeShiftCount: number;
    /** Soma dos saldos negativos do mês, em minutos (≤ 0). */
    negativeMinutes: number;
    /** O que já foi abatido em folha neste mês (líquido de estornos, ≥ 0 normalmente). */
    abatedMinutes: number;
    /** negativeMinutes + abatedMinutes: o que ainda falta levar à folha (≤ 0 quando pendente). */
    remainingMinutes: number;
    /** Ainda há atraso do mês sem abatimento registrado. */
    pending: boolean;
}

export function resolvePayrollDeductionForMonth(params: {
    monthKey: string;
    shifts: PayrollShiftInput[];
    settlements: PayrollSettlementInput[];
}): PayrollDeductionForMonth {
    let negativeShiftCount = 0;
    let negativeMinutes = 0;
    for (const shift of params.shifts) {
        if (shift.monthKey !== params.monthKey) continue;
        const balance = shift.balanceMinutes ?? 0;
        if (balance < 0) {
            negativeShiftCount += 1;
            negativeMinutes += balance;
        }
    }

    let abatedMinutes = 0;
    for (const settlement of params.settlements) {
        if (settlement.monthKey !== params.monthKey) continue;
        if (settlement.kind !== BANK_HOURS_PAYROLL_SETTLEMENT_KIND) continue;
        abatedMinutes += settlement.deltaMinutes;
    }

    const remainingMinutes = negativeMinutes + abatedMinutes;
    return {
        monthKey: params.monthKey,
        negativeShiftCount,
        negativeMinutes,
        abatedMinutes,
        remainingMinutes,
        pending: remainingMinutes < 0,
    };
}

/** Texto padrão gravado em notes do acerto de folha — legível na folha e no histórico. */
export function buildPayrollSettlementNote(params: {
    monthKey: string;
    negativeShiftCount: number;
    deltaMinutes: number;
}): string {
    const plantoes = params.negativeShiftCount === 1 ? "1 plantão com atraso" : `${params.negativeShiftCount} plantões com atraso`;
    return `Abatido em folha — ${params.monthKey}: ${plantoes}, ${formatPayrollMinutes(params.deltaMinutes)} descontados na folha de pagamento/ponto`;
}

export function formatPayrollMinutes(minutes: number): string {
    const abs = Math.abs(minutes);
    const hours = Math.floor(abs / 60);
    const rest = abs % 60;
    if (hours === 0) return `${rest} min`;
    return rest === 0 ? `${hours}h` : `${hours}h${String(rest).padStart(2, "0")}`;
}

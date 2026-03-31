export const BANK_HOURS_RULE_VERSION = 3;
export const ARRIVAL_GRACE_MINUTES = 15;
export const DEPARTURE_GRACE_MINUTES = 15;

export interface BankHoursCalculationInput {
    scheduledStartAt: Date | string;
    scheduledEndAt: Date | string;
    actualStartAt: Date | string;
    actualEndAt: Date | string;
}

export interface BankHoursCalculationResult {
    arrivalDelayMinutes: number;
    overtimeMinutes: number;
    overtimeMultiplier: 1 | 2;
    creditedOvertimeMinutes: number;
    balanceMinutes: number;
    ruleCode: string;
    explanation: string;
}

function toDate(value: Date | string) {
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) {
        throw new Error("Invalid date for bank hours calculation.");
    }
    return date;
}

function diffMinutes(start: Date, end: Date) {
    return Math.trunc((end.getTime() - start.getTime()) / 60000);
}

export function calculateBankHours(input: BankHoursCalculationInput): BankHoursCalculationResult {
    const scheduledStartAt = toDate(input.scheduledStartAt);
    const scheduledEndAt = toDate(input.scheduledEndAt);
    const actualStartAt = toDate(input.actualStartAt);
    const actualEndAt = toDate(input.actualEndAt);

    const rawArrivalDelay = Math.max(0, diffMinutes(scheduledStartAt, actualStartAt));
    const rawOvertime = Math.max(0, diffMinutes(scheduledEndAt, actualEndAt));
    const arrivalDelayMinutes = rawArrivalDelay <= ARRIVAL_GRACE_MINUTES ? 0 : rawArrivalDelay;
    const overtimeMinutes = rawOvertime <= DEPARTURE_GRACE_MINUTES ? 0 : rawOvertime;
    const overtimeMultiplier: 1 | 2 = arrivalDelayMinutes === 0 ? 2 : 1;
    const creditedOvertimeMinutes = overtimeMinutes * overtimeMultiplier;
    const balanceMinutes = creditedOvertimeMinutes - arrivalDelayMinutes;

    const ruleCode = arrivalDelayMinutes === 0
        ? (overtimeMinutes > 0 ? "ON_TIME_DOUBLE_OVERTIME" : "ON_TIME_NO_OVERTIME")
        : (overtimeMinutes > 0 ? "LATE_SIMPLE_OVERTIME" : "LATE_NO_OVERTIME");

    const explanation = arrivalDelayMinutes === 0
        ? (overtimeMinutes > 0
            ? `Chegou com ate ${ARRIVAL_GRACE_MINUTES} min de atraso e o excedente acima de ${DEPARTURE_GRACE_MINUTES} min entrou em dobro.`
            : (rawOvertime > 0
                ? `Chegou com ate ${ARRIVAL_GRACE_MINUTES} min de atraso e a saida ficou com ate ${DEPARTURE_GRACE_MINUTES} min alem da janela prevista, sem impacto no banco.`
                : `Chegou dentro da tolerancia de ate ${ARRIVAL_GRACE_MINUTES} min e nao gerou debito nem credito adicional.`))
        : (overtimeMinutes > 0
            ? `Chegou com ${arrivalDelayMinutes} min de atraso e o excedente acima de ${DEPARTURE_GRACE_MINUTES} min ficou simples.`
            : (rawOvertime > 0
                ? `Chegou com ${arrivalDelayMinutes} min de atraso e a saida ficou com ate ${DEPARTURE_GRACE_MINUTES} min alem da janela prevista, sem credito compensatorio.`
                : `Chegou com ${arrivalDelayMinutes} min de atraso e nao gerou credito adicional.`));

    return {
        arrivalDelayMinutes,
        overtimeMinutes,
        overtimeMultiplier,
        creditedOvertimeMinutes,
        balanceMinutes,
        ruleCode,
        explanation,
    };
}

export const BANK_HOURS_RULE_VERSION = 9;
export const ARRIVAL_GRACE_MINUTES = 15;
export const DEPARTURE_GRACE_MINUTES = 15;

/**
 * Maximum credible delay or overtime in minutes.
 * Any value above this threshold indicates a likely misconfigured scheduled window
 * (e.g., P shift registered as SD, broken continuity chain, wrong scheduledStartAt).
 * Bank hours entries exceeding this are clamped to 0 with ANOMALY_* rule code.
 */
export const ANOMALY_THRESHOLD_MINUTES = 360; // 6 hours

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

export const EARLY_DEPARTURE_BANK_ONLY_RULE_CODE = "EARLY_DEPARTURE_BANK_ONLY";
export const EARLY_DEPARTURE_HALF_CREDIT_RULE_CODE = "EARLY_DEPARTURE_HALF_CREDIT";

function formatMinutesAsHours(minutes: number) {
    const hours = Math.floor(minutes / 60);
    const rest = minutes % 60;
    if (hours === 0) {
        return `${rest} min`;
    }
    return rest === 0 ? `${hours}h` : `${hours}h${String(rest).padStart(2, "0")}`;
}

/**
 * Resultado de banco para retirada/saída antecipada decidida pela chefia
 * (modules/operational/early-departure.ts). Substitui a matemática padrão de
 * atraso/excedente: o saldo é exatamente o crédito do desfecho —
 * 'bank_only' credita as horas trabalhadas dentro da janela (o plantão não é
 * assinado); 'half_shift' credita o que passar de 6h trabalhadas (meio plantão
 * assinado). Não existe débito nesta régua e a tolerância de 15 min não se
 * aplica: a hora é a que a chefia confirmou.
 */
export function buildEarlyDepartureBankHours(params: {
    outcome: "bank_only" | "half_shift";
    workedMinutes: number;
    bankCreditMinutes: number;
    arrivalDelayMinutes: number;
}): BankHoursCalculationResult {
    const credit = Math.max(0, params.bankCreditMinutes);
    const worked = formatMinutesAsHours(Math.max(0, params.workedMinutes));

    const explanation = params.outcome === "bank_only"
        ? `Retirada antes de 6h de janela: o plantao nao e assinado. Trabalhou ${worked} dentro da janela; ${credit} min creditados no banco de horas.`
        : `Retirada entre 6h e 10h de janela: assina MEIO plantao. Trabalhou ${worked} dentro da janela; o excedente de 6h (${credit} min) creditado no banco de horas.`;

    return {
        arrivalDelayMinutes: params.arrivalDelayMinutes,
        overtimeMinutes: 0,
        overtimeMultiplier: 1,
        creditedOvertimeMinutes: credit,
        balanceMinutes: credit,
        ruleCode: params.outcome === "bank_only"
            ? EARLY_DEPARTURE_BANK_ONLY_RULE_CODE
            : EARLY_DEPARTURE_HALF_CREDIT_RULE_CODE,
        explanation,
    };
}

/**
 * Detects scheduled window anomalies: delay or overtime above the credible threshold.
 * Returns a clamped result with ANOMALY rule code when the calculated values are implausible.
 * This catches: P shifts misregistered as SD/SN, orphaned scheduledStartAt from deleted
 * continuity chains, or any data integrity issue producing phantom 12h+ credits/debits.
 */
export function applyAnomalyGuard(calculation: BankHoursCalculationResult): BankHoursCalculationResult {
    const isAnomalousDelay = calculation.arrivalDelayMinutes > ANOMALY_THRESHOLD_MINUTES;
    const isAnomalousOvertime = calculation.overtimeMinutes > ANOMALY_THRESHOLD_MINUTES;

    if (!isAnomalousDelay && !isAnomalousOvertime) {
        return calculation;
    }

    const anomalyType = isAnomalousDelay && isAnomalousOvertime
        ? "ANOMALY_DELAY_AND_OVERTIME"
        : isAnomalousDelay
            ? "ANOMALY_EXCESSIVE_DELAY"
            : "ANOMALY_EXCESSIVE_OVERTIME";

    const detail = isAnomalousDelay
        ? `Atraso calculado de ${calculation.arrivalDelayMinutes} min excede limite de ${ANOMALY_THRESHOLD_MINUTES} min.`
        : `Overtime calculado de ${calculation.overtimeMinutes} min excede limite de ${ANOMALY_THRESHOLD_MINUTES} min.`;

    return {
        arrivalDelayMinutes: calculation.arrivalDelayMinutes,
        overtimeMinutes: calculation.overtimeMinutes,
        overtimeMultiplier: calculation.overtimeMultiplier,
        creditedOvertimeMinutes: 0,
        balanceMinutes: 0,
        ruleCode: anomalyType,
        explanation: `⚠️ ANOMALIA DETECTADA: ${detail} Provavel janela agendada incorreta (P registrado como SD/SN, grupo continuidade quebrado, etc). Saldo zerado automaticamente — requer revisao manual.`,
    };
}

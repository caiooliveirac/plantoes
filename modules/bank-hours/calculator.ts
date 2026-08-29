import {
    classifyExtendedStay,
    describeExtendedStay,
    isPayableExtendedStay,
    type ExtendedStayClassification,
} from "@/modules/operational/extended-stay";

export const BANK_HOURS_RULE_VERSION = 10;
export const ARRIVAL_GRACE_MINUTES = 15;
export const DEPARTURE_GRACE_MINUTES = 15;

/**
 * Atraso máximo crível. Acima disso a janela agendada é que está errada (P
 * registrado como SD, cadeia de continuidade quebrada, scheduledStartAt torto),
 * e um débito de 12h castigaria o médico por um defeito nosso: zera com
 * ANOMALY_* e pede revisão humana.
 *
 * Do lado do EXCEDENTE não existe mais anomalia: permanência longa é um fato
 * operacional com desfecho próprio (classifyExtendedStay) — vira plantão na
 * folha, não crédito no banco.
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
    /** Plantões que a permanência gerou na folha (null quando não gerou nenhum). */
    extendedStay: ExtendedStayClassification | null;
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
        extendedStay: null,
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
        extendedStay: null,
    };
}

export const EXTENDED_STAY_RULE_CODE = "EXTENDED_STAY_PAYABLE_SHIFT";

/**
 * Teto do banco de horas e desfecho da permanência longa.
 *
 * Duas coisas, uma passagem obrigatória — todo caminho que calcula banco passa
 * por aqui (gravação, reconstrução do histórico, quadro ao vivo, scripts):
 *
 *  - ATRASO improvável (> 6h) continua sendo anomalia de janela: zera e pede
 *    revisão, porque a alternativa é debitar 12h de quem não faltou.
 *
 *  - EXCEDENTE de 6h ou mais NÃO é banco de horas. Ficar meio turno a mais numa
 *    posição é plantão prestado, e plantão prestado se assina na folha: a régua
 *    de classifyExtendedStay (espelho da régua de saída antecipada da chefia)
 *    diz quantos inteiros e meios aquilo vale, e só o resto abaixo de 6h segue
 *    como crédito. Sem isso, uma janela agendada torta virava crédito de 12h ou
 *    23h — e o aviso diário oferecia "plantão verde" à chefia (caso Rafael
 *    Santana, 21→22/08/2026).
 *
 * O teto é estrutural: nenhum plantão credita mais que 6h brutas (12h em dobro).
 */
/**
 * O ÚNICO cálculo de banco que a interface pode mostrar.
 *
 * `calculateBankHours` é a matemática crua; quem decide o que vira crédito é
 * `applyAnomalyGuard`. Telas que chamavam a crua exibiam números que o servidor
 * nunca gravou — o modal de saída chegou a oferecer "confirmar 23h30 de banco
 * de horas" a quem tinha emendado o turno seguinte (caso Felipe Carneiro), e o
 * histórico do turno anterior repetia o mesmo saldo fantasma. Preview e
 * gravação passam por aqui.
 */
export function calculateGuardedBankHours(input: BankHoursCalculationInput): BankHoursCalculationResult {
    return applyAnomalyGuard(calculateBankHours(input));
}

export function applyAnomalyGuard(calculation: BankHoursCalculationResult): BankHoursCalculationResult {
    const isAnomalousDelay = calculation.arrivalDelayMinutes > ANOMALY_THRESHOLD_MINUTES;

    if (isAnomalousDelay) {
        return {
            ...calculation,
            creditedOvertimeMinutes: 0,
            balanceMinutes: 0,
            extendedStay: null,
            ruleCode: "ANOMALY_EXCESSIVE_DELAY",
            explanation: `⚠️ ANOMALIA DETECTADA: Atraso calculado de ${calculation.arrivalDelayMinutes} min excede limite de ${ANOMALY_THRESHOLD_MINUTES} min. Provavel janela agendada incorreta (P registrado como SD/SN, grupo continuidade quebrado, etc). Saldo zerado automaticamente — requer revisao manual.`,
        };
    }

    const extendedStay = classifyExtendedStay(calculation.overtimeMinutes);
    if (!isPayableExtendedStay(extendedStay)) {
        return calculation;
    }

    // Só o resto abaixo de 6h continua no banco; o multiplicador da chegada
    // pontual segue valendo sobre ele.
    const creditedOvertimeMinutes = extendedStay.bankMinutes * calculation.overtimeMultiplier;

    return {
        ...calculation,
        creditedOvertimeMinutes,
        balanceMinutes: creditedOvertimeMinutes - calculation.arrivalDelayMinutes,
        extendedStay,
        ruleCode: EXTENDED_STAY_RULE_CODE,
        explanation: `Permaneceu ${formatMinutesAsHours(extendedStay.overtimeMinutes)} alem do previsto: acima de 6h a permanencia nao e banco de horas, e plantao a assinar na posicao — ${describeExtendedStay(extendedStay)}.${extendedStay.bankMinutes > 0 ? ` Restam ${formatMinutesAsHours(extendedStay.bankMinutes)} no banco.` : ""}`,
    };
}

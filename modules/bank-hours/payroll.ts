/**
 * Abatimento em folha do banco de horas — o acerto do ESTATUTÁRIO.
 *
 * Módulo propositalmente SEM imports (como pending-actions): roda no client
 * component do banco de horas e na rota que grava o abatimento.
 *
 * Regra de negócio (decidida em 2026-09-03, PR seguinte ao #256):
 *
 * O estatutário não é pago por plantão neste sistema, então atraso não vira
 * "plantão vermelho". Mas o banco POSITIVO é o primeiro colchão do atraso —
 * a folha só entra quando o banco cruza o zero. Mês a mês, em cascata:
 *
 *   1. Saldo prévio = saldo efetivo até o fim do mês anterior (legado da
 *      planilha + plantões + acertos de meses anteriores). Pode ser negativo.
 *   2. Somam-se PRIMEIRO todos os créditos do mês (plantões com saldo > 0):
 *      disponível = prévio + créditos.
 *   3. Os débitos do mês (plantões com saldo < 0) consomem o disponível em
 *      ordem cronológica:
 *        - disponível > 0 e cobre o débito: sai do banco, nada em folha;
 *        - débito que CRUZA o zero: ver PAYROLL_SPLIT_CROSSING_DEBIT;
 *        - disponível ≤ 0: o débito vai INTEIRO à folha. O banco nunca fica
 *          mais negativo por causa de um débito — saldo prévio negativo é
 *          coisa do passado, só os créditos o corroem, e ele NUNCA vai à folha.
 *
 * O settlement "payroll" grava só a parcela que foi à folha (payrollMinutes),
 * devolvendo esses minutos ao banco: saldo depois = prévio + créditos − absorvido.
 */

export const BANK_HOURS_PAYROLL_SETTLEMENT_KIND = "payroll";

/**
 * DECISÃO REVERSÍVEL — débito que cruza o zero do banco.
 *
 *   true  (vigente): divide. A parte que cabe no banco zera o banco; o resto
 *                    vai à folha. Ex.: prévio −2h, créditos +6h → disponível
 *                    +4h; débito de −5h → 4h do banco, 1h na folha, banco = 0.
 *   false           : o débito que cruza vai INTEIRO à folha e o banco fica
 *                    com o que sobrou (+4h no exemplo). Débitos menores
 *                    seguintes ainda podem ser absorvidos.
 *
 * Trocar este valor muda só o cálculo daqui para frente (settlements já
 * gravados guardam o valor lançado na época). Testes em
 * tests/bank-hours-payroll.test.ts cobrem os dois modos.
 */
export const PAYROLL_SPLIT_CROSSING_DEBIT = true;

export interface PayrollShiftInput {
    /** Mês operacional do plantão (AAAA-MM, fuso de São Paulo). */
    monthKey: string;
    balanceMinutes: number | null;
    /** Ordena os débitos dentro do mês (ISO). Sem ele, ordem de chegada. */
    startedAt?: string;
}

export interface PayrollSettlementInput {
    monthKey: string;
    kind: string;
    /** Positivo = abatimento lançado; negativo = estorno de um abatimento. */
    deltaMinutes: number;
}

/** Um débito do mês e como ele foi repartido entre banco e folha. */
export interface PayrollDebitStep {
    startedAt: string | null;
    /** Saldo do plantão (< 0). */
    balanceMinutes: number;
    /** Banco antes deste débito (pode ser ≤ 0). */
    bankBeforeMinutes: number;
    /** Quanto o banco absorveu (≥ 0). */
    bankMinutes: number;
    /** Quanto foi à folha (≥ 0). bankMinutes + payrollMinutes = −balanceMinutes. */
    payrollMinutes: number;
    bankAfterMinutes: number;
    /** Este débito cruzou o zero (foi repartido ou, sem split, empurrado inteiro à folha). */
    crossedZero: boolean;
}

export interface PayrollDeductionForMonth {
    monthKey: string;
    /** Saldo efetivo até o fim do mês anterior (legado + plantões + acertos anteriores). */
    openingBalanceMinutes: number;
    /** Plantões do mês com saldo positivo e a soma deles (≥ 0). */
    creditShiftCount: number;
    creditMinutes: number;
    /** Plantões do mês com saldo negativo e a soma deles (≤ 0). */
    negativeShiftCount: number;
    negativeMinutes: number;
    /** openingBalanceMinutes + creditMinutes: o que o banco tem antes dos débitos. */
    availableMinutes: number;
    /** Parte dos débitos que o banco absorveu (≥ 0). */
    absorbedMinutes: number;
    /** Parte dos débitos que vai à folha (≥ 0). absorbed + payroll = −negativeMinutes. */
    payrollMinutes: number;
    /** Banco depois de aplicar créditos e débitos absorvidos (o que sobra com o payroll lançado). */
    closingBankMinutes: number;
    /** O que já foi abatido em folha neste mês (líquido de estornos, ≥ 0 normalmente). */
    abatedMinutes: number;
    /** −payrollMinutes + abatedMinutes: o que ainda falta levar à folha (≤ 0 quando pendente). */
    remainingMinutes: number;
    /** Ainda há parcela do mês devida à folha sem abatimento registrado. */
    pending: boolean;
    /** Débitos em ordem cronológica, com a repartição de cada um (para o diagrama). */
    steps: PayrollDebitStep[];
}

/**
 * Saldo prévio do mês: tudo que tem monthKey < mês (plantões e acertos de
 * qualquer kind) + o legado da planilha, que é anterior a qualquer plantão da
 * aplicação. Acertos do PRÓPRIO mês ficam fora — o payroll do mês é tratado
 * em abatedMinutes; bônus/penalidade do mesmo mês não existem para estatutário.
 */
export function resolvePayrollOpeningBalance(params: {
    monthKey: string;
    legacyMinutes: number;
    shifts: PayrollShiftInput[];
    settlements: PayrollSettlementInput[];
}): number {
    let total = params.legacyMinutes;
    for (const shift of params.shifts) {
        if (shift.monthKey < params.monthKey) total += shift.balanceMinutes ?? 0;
    }
    for (const settlement of params.settlements) {
        if (settlement.monthKey < params.monthKey) total += settlement.deltaMinutes;
    }
    return total;
}

export function resolvePayrollDeductionForMonth(params: {
    monthKey: string;
    openingBalanceMinutes: number;
    shifts: PayrollShiftInput[];
    settlements: PayrollSettlementInput[];
    /** Override para testes; produção usa PAYROLL_SPLIT_CROSSING_DEBIT. */
    splitCrossingDebit?: boolean;
}): PayrollDeductionForMonth {
    const split = params.splitCrossingDebit ?? PAYROLL_SPLIT_CROSSING_DEBIT;

    let creditShiftCount = 0;
    let creditMinutes = 0;
    let negativeShiftCount = 0;
    let negativeMinutes = 0;
    const debits: PayrollShiftInput[] = [];
    for (const shift of params.shifts) {
        if (shift.monthKey !== params.monthKey) continue;
        const balance = shift.balanceMinutes ?? 0;
        if (balance > 0) {
            creditShiftCount += 1;
            creditMinutes += balance;
        } else if (balance < 0) {
            negativeShiftCount += 1;
            negativeMinutes += balance;
            debits.push(shift);
        }
    }
    debits.sort((left, right) => (left.startedAt ?? "").localeCompare(right.startedAt ?? ""));

    const availableMinutes = params.openingBalanceMinutes + creditMinutes;
    let bank = availableMinutes;
    let absorbedMinutes = 0;
    let payrollMinutes = 0;
    const steps: PayrollDebitStep[] = [];
    for (const shift of debits) {
        const debit = -(shift.balanceMinutes ?? 0);
        const before = bank;
        let bankMinutes = 0;
        let toPayroll = 0;
        let crossedZero = false;
        if (bank <= 0) {
            toPayroll = debit;
        } else if (bank >= debit) {
            bankMinutes = debit;
        } else {
            crossedZero = true;
            if (split) {
                bankMinutes = bank;
                toPayroll = debit - bank;
            } else {
                toPayroll = debit;
            }
        }
        bank -= bankMinutes;
        absorbedMinutes += bankMinutes;
        payrollMinutes += toPayroll;
        steps.push({
            startedAt: shift.startedAt ?? null,
            balanceMinutes: shift.balanceMinutes ?? 0,
            bankBeforeMinutes: before,
            bankMinutes,
            payrollMinutes: toPayroll,
            bankAfterMinutes: bank,
            crossedZero,
        });
    }

    let abatedMinutes = 0;
    for (const settlement of params.settlements) {
        if (settlement.monthKey !== params.monthKey) continue;
        if (settlement.kind !== BANK_HOURS_PAYROLL_SETTLEMENT_KIND) continue;
        abatedMinutes += settlement.deltaMinutes;
    }

    const remainingMinutes = -payrollMinutes + abatedMinutes;
    return {
        monthKey: params.monthKey,
        openingBalanceMinutes: params.openingBalanceMinutes,
        creditShiftCount,
        creditMinutes,
        negativeShiftCount,
        negativeMinutes,
        availableMinutes,
        absorbedMinutes,
        payrollMinutes,
        closingBankMinutes: bank,
        abatedMinutes,
        remainingMinutes,
        pending: remainingMinutes < 0,
        steps,
    };
}

/** Atalho usado pelo client e pela rota: saldo prévio + cascata do mês. */
export function resolvePayrollDeductionForDoctorMonth(params: {
    monthKey: string;
    legacyMinutes: number;
    shifts: PayrollShiftInput[];
    settlements: PayrollSettlementInput[];
}): PayrollDeductionForMonth {
    return resolvePayrollDeductionForMonth({
        monthKey: params.monthKey,
        openingBalanceMinutes: resolvePayrollOpeningBalance(params),
        shifts: params.shifts,
        settlements: params.settlements,
    });
}

/** Texto padrão gravado em notes do acerto de folha — legível na folha e no histórico. */
export function buildPayrollSettlementNote(params: {
    monthKey: string;
    negativeShiftCount: number;
    deltaMinutes: number;
    /** Quanto dos débitos do mês o banco absorveu antes de a folha entrar. */
    absorbedMinutes?: number;
}): string {
    const plantoes = params.negativeShiftCount === 1 ? "1 plantão com atraso" : `${params.negativeShiftCount} plantões com atraso`;
    const absorbed = params.absorbedMinutes ? `, ${formatPayrollMinutes(params.absorbedMinutes)} absorvidos pelo banco` : "";
    return `Abatido em folha — ${params.monthKey}: ${plantoes}${absorbed}, ${formatPayrollMinutes(params.deltaMinutes)} descontados na folha de pagamento/ponto`;
}

export function formatPayrollMinutes(minutes: number): string {
    const abs = Math.abs(minutes);
    const hours = Math.floor(abs / 60);
    const rest = abs % 60;
    if (hours === 0) return `${rest} min`;
    return rest === 0 ? `${hours}h` : `${hours}h${String(rest).padStart(2, "0")}`;
}

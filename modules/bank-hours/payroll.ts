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
 * A folha é AUTOMÁTICA: o saldo do estatutário É a cascata rodada mês a mês
 * desde o legado (resolvePayrollLedger) — a parcela "vai à folha" nunca entra
 * no banco. Não há botão nem settlement a gravar; a coordenação lê o previsto
 * na tela e lança na folha de pagamento/ponto por fora. Settlements de kind
 * "payroll" gravados antes de 2026-09 (regra antiga, manual) são registro
 * histórico e ficam FORA do cálculo.
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

/** Um crédito do mês e o banco antes/depois dele (entra ANTES de qualquer débito). */
export interface PayrollCreditStep {
    startedAt: string | null;
    /** Saldo do plantão (> 0). */
    balanceMinutes: number;
    bankBeforeMinutes: number;
    bankAfterMinutes: number;
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
    /** Créditos em ordem cronológica, com o banco antes/depois (para o diagrama). */
    creditSteps: PayrollCreditStep[];
    /** Débitos em ordem cronológica, com a repartição de cada um (para o diagrama). */
    steps: PayrollDebitStep[];
}

/** Razão do estatutário: a cascata rodada mês a mês desde o legado. */
export interface PayrollLedger {
    /** Meses em ordem crescente (os com plantão ou acerto, + throughMonthKey). */
    months: PayrollDeductionForMonth[];
    /** Saldo efetivo do banco ao fim do último mês. */
    balanceMinutes: number;
    /** Tudo que foi à folha, somado. */
    payrollTotalMinutes: number;
}

/**
 * Roda a cascata mês a mês a partir do legado da planilha (anterior a qualquer
 * plantão da aplicação). Acertos que NÃO são payroll (bônus de +12h) entram no
 * banco ao fim do mês deles; settlements "payroll" são ignorados — a cascata
 * já mantém a parcela de folha fora do banco.
 */
export function resolvePayrollLedger(params: {
    legacyMinutes: number;
    shifts: PayrollShiftInput[];
    settlements: PayrollSettlementInput[];
    /** Garante este mês na lista mesmo sem plantão/acerto (mês em foco na tela). */
    throughMonthKey?: string;
    splitCrossingDebit?: boolean;
}): PayrollLedger {
    const monthKeys = new Set<string>();
    for (const shift of params.shifts) monthKeys.add(shift.monthKey);
    for (const settlement of params.settlements) {
        if (settlement.kind !== BANK_HOURS_PAYROLL_SETTLEMENT_KIND) monthKeys.add(settlement.monthKey);
    }
    if (params.throughMonthKey) monthKeys.add(params.throughMonthKey);

    let running = params.legacyMinutes;
    let payrollTotalMinutes = 0;
    const months: PayrollDeductionForMonth[] = [];
    for (const monthKey of Array.from(monthKeys).sort()) {
        const month = resolvePayrollDeductionForMonth({
            monthKey,
            openingBalanceMinutes: running,
            shifts: params.shifts,
            splitCrossingDebit: params.splitCrossingDebit,
        });
        running = month.closingBankMinutes;
        for (const settlement of params.settlements) {
            if (settlement.monthKey === monthKey && settlement.kind !== BANK_HOURS_PAYROLL_SETTLEMENT_KIND) {
                running += settlement.deltaMinutes;
            }
        }
        payrollTotalMinutes += month.payrollMinutes;
        months.push(month);
    }
    return { months, balanceMinutes: running, payrollTotalMinutes };
}

export function resolvePayrollDeductionForMonth(params: {
    monthKey: string;
    openingBalanceMinutes: number;
    shifts: PayrollShiftInput[];
    /** Override para testes; produção usa PAYROLL_SPLIT_CROSSING_DEBIT. */
    splitCrossingDebit?: boolean;
}): PayrollDeductionForMonth {
    const split = params.splitCrossingDebit ?? PAYROLL_SPLIT_CROSSING_DEBIT;

    let creditShiftCount = 0;
    let creditMinutes = 0;
    let negativeShiftCount = 0;
    let negativeMinutes = 0;
    const debits: PayrollShiftInput[] = [];
    const credits: PayrollShiftInput[] = [];
    for (const shift of params.shifts) {
        if (shift.monthKey !== params.monthKey) continue;
        const balance = shift.balanceMinutes ?? 0;
        if (balance > 0) {
            creditShiftCount += 1;
            creditMinutes += balance;
            credits.push(shift);
        } else if (balance < 0) {
            negativeShiftCount += 1;
            negativeMinutes += balance;
            debits.push(shift);
        }
    }
    const byStart = (left: PayrollShiftInput, right: PayrollShiftInput) => (left.startedAt ?? "").localeCompare(right.startedAt ?? "");
    debits.sort(byStart);
    credits.sort(byStart);

    const creditSteps: PayrollCreditStep[] = [];
    let bank = params.openingBalanceMinutes;
    for (const shift of credits) {
        const balance = shift.balanceMinutes ?? 0;
        creditSteps.push({ startedAt: shift.startedAt ?? null, balanceMinutes: balance, bankBeforeMinutes: bank, bankAfterMinutes: bank + balance });
        bank += balance;
    }
    const availableMinutes = bank;
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
        creditSteps,
        steps,
    };
}

/** Cascata de UM mês, com o prévio vindo do razão (coerente com o saldo da tela). */
export function resolvePayrollDeductionForDoctorMonth(params: {
    monthKey: string;
    legacyMinutes: number;
    shifts: PayrollShiftInput[];
    settlements: PayrollSettlementInput[];
}): PayrollDeductionForMonth {
    const ledger = resolvePayrollLedger({ ...params, throughMonthKey: params.monthKey });
    return ledger.months.find((month) => month.monthKey === params.monthKey)!;
}

export function formatPayrollMinutes(minutes: number): string {
    const abs = Math.abs(minutes);
    const hours = Math.floor(abs / 60);
    const rest = abs % 60;
    if (hours === 0) return `${rest} min`;
    return rest === 0 ? `${hours}h` : `${hours}h${String(rest).padStart(2, "0")}`;
}

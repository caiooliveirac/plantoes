/**
 * Régua do acerto de banco de horas (±12h) do fechamento mensal.
 *
 * Módulo propositalmente SEM imports: é usado também em client components
 * (payment-closing e bank-hours), e o resto de modules/reporting arrasta
 * dependências de Node (fs) que não podem ir para o bundle do navegador.
 *
 * Regra de negócio: só as horas formadas DESDE mai/2025 (planilha 25→26 +
 * aplicação) entram na régua de pagar/punir — a regra não existia antes.
 * A parcela anterior a mai/2025 nunca vira bônus nem punição: quando é
 * dívida, as horas recentes a amortizam ANTES de qualquer bônus; quando é
 * crédito, fica fora da régua (não remunera nem blinda punição).
 *
 * Exceção (decidida em 2026-09-12): ESTATUTÁRIO. O saldo dele é a cascata da
 * folha rodada sobre o legado inteiro (modules/bank-hours/payroll.ts), então
 * o crédito anterior a mai/2025 ENTRA na conta do bônus — vira plantão de
 * R$ 0 lançado só para controle do dia. Punição de estatutário não existe
 * (folha cuida), então penaltyEligibleMinutes segue só o recente.
 */
export interface BankHoursSettlementBalance {
    /** Saldo bruto total (antigo + recente), como o histórico exibe. */
    totalMinutes: number;
    /** Parcela anterior a mai/2025 (planilha). Fora da régua do acerto. */
    oldMinutes: number;
    /** Parcela desde mai/2025 (planilha 25→26 + aplicação + acertos). */
    recentMinutes: number;
    /** Saldo que pode virar bônus: o recente amortiza a dívida antiga primeiro. */
    bonusEligibleMinutes: number;
    /** Saldo que pode virar punição: só o recente (dívida antiga não pune). */
    penaltyEligibleMinutes: number;
}

export function resolveBankHoursSettlementBalance(params: {
    oldMinutes: number;
    recentMinutes: number;
    /** Ausente/"pj" = régua padrão; "estatutario" = saldo antigo inteiro conta no bônus. */
    employmentType?: "pj" | "estatutario" | null;
}): BankHoursSettlementBalance {
    const statutory = params.employmentType === "estatutario";
    return {
        totalMinutes: params.oldMinutes + params.recentMinutes,
        oldMinutes: params.oldMinutes,
        recentMinutes: params.recentMinutes,
        bonusEligibleMinutes: statutory
            ? params.oldMinutes + params.recentMinutes
            : params.recentMinutes + Math.min(params.oldMinutes, 0),
        penaltyEligibleMinutes: params.recentMinutes,
    };
}

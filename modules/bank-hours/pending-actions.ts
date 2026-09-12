/**
 * Pendências acionáveis do banco de horas (múltiplos de ±12h).
 *
 * Módulo propositalmente SEM imports (como bank-hours-settlement-rule): é usado
 * em client components e no worker do Telegram. A régua de elegibilidade
 * (bonusEligibleMinutes / penaltyEligibleMinutes) vem de
 * resolveBankHoursSettlementBalance — este módulo só decide QUANTAS unidades de
 * 12h estão pendentes e se algo ficou inconsistente após um acerto.
 */

/** Cada unidade acionável do banco de horas vale 12h (720 min). */
export const BANK_HOURS_PENDING_UNIT_MINUTES = 12 * 60;

export type BankHoursPendingDirection = "bonus" | "penalty";

export interface BankHoursPendingAction {
    /** null = saldo entre -11h59 e +11h59, nada a fazer. */
    direction: BankHoursPendingDirection | null;
    /** Plantões de 12h ainda aplicáveis (floor, nunca arredonda 11h59 → 12h). */
    pendingUnits: number;
    /** Sobra (com sinal) depois de aplicar todas as unidades pendentes. */
    residualMinutes: number;
    /**
     * O saldo andou na direção CONTRÁRIA aos acertos já lançados: ex. bônus pago
     * e depois um plantão invalidado derrubou o saldo para -12h. Nunca corrige
     * sozinho — pede revisão humana (estorno formal ou novo acerto).
     */
    inconsistency: boolean;
}

export function resolveBankHoursPendingAction(params: {
    bonusEligibleMinutes: number;
    penaltyEligibleMinutes: number;
    /** Soma histórica dos acertos (bonus = negativo, penalty = positivo). */
    settlementDeltaMinutes?: number;
}): BankHoursPendingAction {
    const unit = BANK_HOURS_PENDING_UNIT_MINUTES;
    const settlementDelta = params.settlementDeltaMinutes ?? 0;

    let direction: BankHoursPendingDirection | null = null;
    let pendingUnits = 0;
    let residualMinutes = 0;

    if (params.bonusEligibleMinutes >= unit) {
        direction = "bonus";
        pendingUnits = Math.floor(params.bonusEligibleMinutes / unit);
        residualMinutes = params.bonusEligibleMinutes - pendingUnits * unit;
    } else if (params.penaltyEligibleMinutes <= -unit) {
        direction = "penalty";
        pendingUnits = Math.floor(-params.penaltyEligibleMinutes / unit);
        residualMinutes = params.penaltyEligibleMinutes + pendingUnits * unit;
    } else {
        residualMinutes = params.penaltyEligibleMinutes < 0
            ? params.penaltyEligibleMinutes
            : params.bonusEligibleMinutes;
    }

    // settlementDelta < 0 = bônus já pagos; se agora a pendência é punição, o
    // saldo caiu depois do pagamento. E vice-versa.
    const inconsistency = (settlementDelta < 0 && direction === "penalty")
        || (settlementDelta > 0 && direction === "bonus");

    return { direction, pendingUnits, residualMinutes, inconsistency };
}

export function formatSignedHours(minutes: number): string {
    const sign = minutes < 0 ? "-" : "+";
    const abs = Math.abs(minutes);
    const hours = Math.floor(abs / 60);
    const rest = abs % 60;
    return rest === 0 ? `${sign}${hours}h` : `${sign}${hours}h${String(rest).padStart(2, "0")}`;
}

export interface BankHoursPendingRow {
    doctorName: string;
    direction: BankHoursPendingDirection;
    /** Saldo elegível (com sinal) que sustenta a pendência. */
    eligibleMinutes: number;
    pendingUnits: number;
    residualMinutes: number;
    inconsistency: boolean;
}

/**
 * Resumo diário único para o privado dos admins. Devolve null quando não há
 * nada pendente — o worker então não envia nada.
 */
export function buildBankHoursPendingSummaryMessage(
    rows: BankHoursPendingRow[],
    options: { adminUrl?: string | null } = {},
): string | null {
    if (rows.length === 0) return null;

    const bonuses = rows.filter((row) => row.direction === "bonus");
    const penalties = rows.filter((row) => row.direction === "penalty");
    const inconsistent = rows.filter((row) => row.inconsistency);

    // Uma linha por médico: nome, saldo, quantos plantões, sobra.
    const line = (row: BankHoursPendingRow) => {
        const sobra = row.residualMinutes === 0 ? "zera" : `sobra ${formatSignedHours(row.residualMinutes)}`;
        return `• ${row.doctorName} ${formatSignedHours(row.eligibleMinutes)} → ${row.pendingUnits} ${row.pendingUnits === 1 ? "plantão" : "plantões"}, ${sobra}`;
    };

    const linhas: string[] = ["*Banco de horas*"];
    if (bonuses.length > 0) linhas.push("🟢 Pagar:", ...bonuses.map(line));
    if (penalties.length > 0) linhas.push("🔴 Descontar:", ...penalties.map(line));
    if (inconsistent.length > 0) {
        linhas.push("⚠️ Revisar (saldo contrário aos acertos):", ...inconsistent.map((row) => `• ${row.doctorName} ${formatSignedHours(row.eligibleMinutes)}`));
    }
    if (options.adminUrl) linhas.push(options.adminUrl);
    return linhas.join("\n");
}

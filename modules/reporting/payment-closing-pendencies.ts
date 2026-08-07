/**
 * Pendências do fechamento por médico — o que o coordenador consegue ANTECIPAR
 * antes de assinar o mês: acerto de banco de horas já formado (±12h) e os três
 * defeitos de contrato (ritmo, saldo acabado, valor não lançado).
 *
 * Módulo com imports só de outros módulos SEM imports (pending-actions e
 * bank-hours-settlement-rule): roda no client component do payment-closing, e o
 * resto de modules/reporting arrasta dependências de Node que não vão ao bundle.
 *
 * Nada aqui é regra nova: banco de horas reusa a régua de ±12h, e a pendência de
 * renovação vem pronta do servidor (lib/contracts/renewal.ts), que é a MESMA
 * usada nos avisos do Telegram e no briefing. Duas definições de "contrato
 * vencido" é exatamente como a tela e o aviso passam a discordar.
 */
import { resolveBankHoursPendingAction } from "@/modules/bank-hours/pending-actions";
import { resolveBankHoursSettlementBalance } from "@/modules/reporting/bank-hours-settlement-rule";
import type { RenewalKind } from "@/lib/contracts/renewal";

export type PaymentClosingPendency =
    | "bank_bonus"
    | "bank_penalty"
    | "contract_pace"
    | "contract_depleted"
    | "contract_missing";

/** Índice de ritmo a partir do qual o consumo já passou do previsto — mesmo corte de classifyRisk. */
export const PACE_ALERT_INDEX = 1.15;

export interface PendencyContractInput {
    /** Fim do ciclo, exclusivo (AAAA-MM-DD). */
    cycleEnd: string;
    ceilingCents: number | null;
    balanceCents: number;
    paceIndex: number | null;
    awaitingOpeningBalance: boolean;
}

export interface PendencyDoctorInput {
    bankHoursOldMinutes?: number | null;
    bankHoursRecentMinutes?: number | null;
    bankHoursMinutes?: number | null;
    contractBalances?: PendencyContractInput[];
    contractPendingRenewal?: { kind: RenewalKind } | null;
    /** "estatutario" é remunerado fora deste sistema. */
    employmentType?: "pj" | "estatutario" | null;
    paymentProfile?: "generalist" | "specialist" | "psychiatry" | null;
}

/**
 * Estatutário e psiquiatria ficam FORA do acompanhamento de saldo contratual:
 * o pagamento deles corre por outra via e a coordenação não segue teto nem ciclo.
 * Sem contrato para acompanhar, tudo que a tela mostrasse sobre saldo — pendência,
 * ritmo, projeção — seria invenção. O psiquiatra continua com o cálculo de valor
 * por plantão (tarifa própria); o que some é só a parte de contrato.
 */
export function tracksContractBalance(doctor: PendencyDoctorInput): boolean {
    return doctor.employmentType !== "estatutario" && doctor.paymentProfile !== "psychiatry";
}

export function resolveDoctorPendencies(doctor: PendencyDoctorInput): PaymentClosingPendency[] {
    const pendencies: PaymentClosingPendency[] = [];

    const bank = resolveBankHoursSettlementBalance({
        oldMinutes: doctor.bankHoursOldMinutes ?? 0,
        recentMinutes: doctor.bankHoursRecentMinutes ?? doctor.bankHoursMinutes ?? 0,
    });
    const action = resolveBankHoursPendingAction(bank);
    if (action.direction === "bonus") {
        pendencies.push("bank_bonus");
    } else if (action.direction === "penalty") {
        pendencies.push("bank_penalty");
    }

    if (!tracksContractBalance(doctor)) {
        return pendencies;
    }

    const contracts = doctor.contractBalances ?? [];
    // Teto ausente segue o contrato MAIS RECENTE, como findPendingRenewals: o
    // contrato velho sem teto não é pendência quando já existe sucessor com teto.
    const newest = contracts.reduce<PendencyContractInput | null>(
        (latest, contract) => (!latest || contract.cycleEnd > latest.cycleEnd ? contract : latest),
        null,
    );

    // Novato sem nenhum contrato, renovação vencida/sem abertura, ou contrato
    // criado sem teto: os três terminam na mesma ação do coordenador — lançar o
    // valor. `null` de teto não é zero (docs/saldo-contrato/README.md).
    if (contracts.length === 0 || doctor.contractPendingRenewal != null || newest?.ceilingCents == null) {
        pendencies.push("contract_missing");
    }

    // Saldo acabado só conta quando é consumo real: razão vazio dá saldo zero por
    // falta de digitação, e isso é contract_missing, não contrato estourado.
    if (contracts.some((contract) => !contract.awaitingOpeningBalance
        && contract.ceilingCents !== null
        && contract.balanceCents <= 0)) {
        pendencies.push("contract_depleted");
    }

    // Ritmo só interessa em contrato que ainda tem saldo — o que já zerou aparece
    // no filtro anterior, e apareceria nos dois.
    if (contracts.some((contract) => contract.paceIndex !== null
        && contract.paceIndex > PACE_ALERT_INDEX
        && contract.balanceCents > 0)) {
        pendencies.push("contract_pace");
    }

    return pendencies;
}

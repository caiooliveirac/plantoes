/**
 * Renovação pendente: o contrato acabou (ou o ciclo novo começou) e ninguém
 * lançou o valor.
 *
 * Os alertas de saldo (modules/telegram/contract-balance-alerts.ts) não cobrem
 * este caso por construção: `depleted`/`exhaustion_projected` pulam o contrato
 * com `awaitingOpeningBalance` — saldo zero por falta de digitação não é saldo
 * acabado — e `cycle_ending` só dispara ANTES do fim (`diasAteFim > 0`). No dia
 * seguinte ao vencimento o contrato some de todos os avisos justamente quando
 * vira pendência do coordenador.
 *
 * Duas formas da mesma pendência:
 *
 *  - `vencido`: o contrato mais novo do médico já passou do fim do ciclo e não
 *    existe sucessor. Ninguém criou a renovação.
 *  - `sem_saldo_de_abertura`: a renovação existe e está valendo hoje, mas o
 *    razão está vazio — o coordenador criou o contrato e não digitou o teto.
 *
 * `cycleEnd` é EXCLUSIVO (mesma convenção de lib/contracts/statement.ts): um
 * ciclo com `cycleEnd = 2026-08-01` vale até 31/07 e está vencido em 01/08.
 */
import type { ContractBalanceRow } from "@/services/contract-balance.service";
import { bahiaDateIso } from "@/lib/time";

/**
 * Só o que a regra lê. A fila de pendências de contrato monta estas linhas com
 * uma query leve, sem apurar o saldo (services/contract-pendency-queue.service.ts).
 */
export type RenewalInputRow = Pick<ContractBalanceRow,
    "doctorId" | "doctorName" | "contractId" | "contractNumber" | "cycleStart" | "cycleEnd" | "awaitingOpeningBalance">;

export type RenewalKind = "vencido" | "sem_saldo_de_abertura";

export interface PendingRenewal {
    kind: RenewalKind;
    doctorId: string;
    doctorName: string;
    contractId: string;
    contractNumber: string;
    /** Fim do ciclo, exclusivo (AAAA-MM-DD). */
    cycleEnd: string;
    cycleStart: string;
    /** Dias corridos desde o vencimento. 0 em `sem_saldo_de_abertura`. */
    daysOverdue: number;
}


function daysBetween(fromDay: string, toDay: string): number {
    const from = Date.parse(`${fromDay}T00:00:00Z`);
    const to = Date.parse(`${toDay}T00:00:00Z`);
    return Math.round((to - from) / 86_400_000);
}

/**
 * Uma pendência por médico, no máximo — a do contrato mais recente. Um médico
 * com o contrato antigo vencido E o novo sem saldo tem UMA notícia para o
 * coordenador ("falta lançar o valor"), não duas.
 *
 * `rows` são os contratos ATIVOS (é o que loadContractBalances devolve):
 * contrato encerrado não é pendência de ninguém.
 */
export function findPendingRenewals(rows: RenewalInputRow[], asOf: Date): PendingRenewal[] {
    const hoje = bahiaDateIso(asOf);

    const maisRecentePorMedico = new Map<string, RenewalInputRow>();
    for (const row of rows) {
        const atual = maisRecentePorMedico.get(row.doctorId);
        if (!atual || row.cycleEnd > atual.cycleEnd) maisRecentePorMedico.set(row.doctorId, row);
    }

    const pendencias: PendingRenewal[] = [];
    for (const row of maisRecentePorMedico.values()) {
        const base = {
            doctorId: row.doctorId,
            doctorName: row.doctorName,
            contractId: row.contractId,
            contractNumber: row.contractNumber,
            cycleEnd: row.cycleEnd,
            cycleStart: row.cycleStart,
        };

        if (row.cycleEnd <= hoje) {
            pendencias.push({ ...base, kind: "vencido", daysOverdue: daysBetween(row.cycleEnd, hoje) });
            continue;
        }

        // Ciclo futuro ainda não é pendência: o coordenador tem até ele começar
        // para digitar o valor.
        if (row.awaitingOpeningBalance && row.cycleStart <= hoje) {
            pendencias.push({ ...base, kind: "sem_saldo_de_abertura", daysOverdue: 0 });
        }
    }

    // Pior primeiro: o vencido há mais tempo abre a lista.
    return pendencias.sort((left, right) => right.daysOverdue - left.daysOverdue
        || left.doctorName.localeCompare(right.doctorName, "pt-BR"));
}

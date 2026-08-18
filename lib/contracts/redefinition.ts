/**
 * Redefinição de contrato — a parte pura: dado o razão de fechamentos do
 * médico, quais consumos precisam migrar do contrato antigo para o novo.
 *
 * Módulo puro como balance-metrics.ts/statement.ts, para a regra mais delicada
 * da rota /api/admin/contracts/[id]/redefine ser testável sem banco: um mês
 * lançado no contrato antigo que pertence ao ciclo novo tem que sair de lá
 * (estorno) e entrar no novo (relançamento), senão fica "settled" num contrato
 * terminado e nunca desconta do saldo redefinido.
 */
import { isMonthWithinCycle } from "@/lib/contracts/statement";

export interface ClosingLedgerRow {
    contractId: string;
    /** '<doctorId>|<AAAA-MM>' — pode ser null em lançamento antigo. */
    sourceKey: string | null;
    amountCents: number;
    weekdayShifts: number;
    weekendShifts: number;
    sourceRevision: number;
}

export interface ClosingTransfer {
    sourceKey: string;
    monthKey: string;
    /** Soma viva no contrato antigo (negativa = consumo). */
    netCents: number;
    weekdayShifts: number;
    weekendShifts: number;
    /** Revisões livres — o índice único (sourceType, sourceKey, revision) é global. */
    reversalRevision: number;
    invoiceRevision: number;
}

/**
 * Um transfer por origem viva no contrato antigo cujo mês cai no ciclo novo.
 * Origem "morta" (soma zero: atestado e desassinado) não migra — não há nada
 * vivo para descontar. As revisões continuam da maior já usada pela origem em
 * QUALQUER contrato do médico.
 */
export function planClosingTransfers(params: {
    rows: ClosingLedgerRow[];
    oldContractId: string;
    newCycleStart: string;
    newCycleEnd: string;
}): ClosingTransfer[] {
    const bySourceKey = new Map<string, {
        netCents: number;
        weekdayShifts: number;
        weekendShifts: number;
        maxRevision: number;
    }>();
    for (const row of params.rows) {
        if (!row.sourceKey) continue;
        const acc = bySourceKey.get(row.sourceKey)
            ?? { netCents: 0, weekdayShifts: 0, weekendShifts: 0, maxRevision: -1 };
        acc.maxRevision = Math.max(acc.maxRevision, row.sourceRevision);
        if (row.contractId === params.oldContractId) {
            acc.netCents += row.amountCents;
            acc.weekdayShifts += row.weekdayShifts;
            acc.weekendShifts += row.weekendShifts;
        }
        bySourceKey.set(row.sourceKey, acc);
    }

    const transfers: ClosingTransfer[] = [];
    for (const [sourceKey, live] of bySourceKey) {
        if (live.netCents === 0) continue;
        const monthKey = sourceKey.split("|")[1];
        if (!monthKey || !isMonthWithinCycle(monthKey, params.newCycleStart, params.newCycleEnd)) continue;
        transfers.push({
            sourceKey,
            monthKey,
            netCents: live.netCents,
            weekdayShifts: live.weekdayShifts,
            weekendShifts: live.weekendShifts,
            reversalRevision: live.maxRevision + 1,
            invoiceRevision: live.maxRevision + 2,
        });
    }
    return transfers.sort((left, right) => left.monthKey.localeCompare(right.monthKey));
}

/**
 * Correção de teto no mês em que o contrato já começou: quanto a abertura
 * precisa receber, como lançamento 'opening' complementar, para acompanhar o
 * teto novo.
 *
 * Todo contrato nascido da redefinição ou da renovação lança `opening = teto`.
 * Corrigir só `contracts.ceiling_amount` deixa os dois divergentes, e
 * `consumed = teto − saldo` (balance-metrics.ts) lê a diferença como consumo que
 * nunca houve — um ciclo de 17 dias aparecendo com 20% gasto e ritmo 363% acima
 * (caso Zolaína, 18/08/2026).
 *
 * Abertura que NÃO bate com o teto anterior foi MEDIDA (saldo de planilha,
 * âncora do coordenador) e não deriva do número errado: essa fica quieta.
 * Devolve 0 quando não há nada a lançar.
 */
export function planCeilingCorrectionAdjustment(params: {
    /** Soma dos lançamentos 'opening' do contrato. */
    openingCents: number;
    /** Quantos lançamentos 'opening' existem — zero = razão ainda sem abertura. */
    openingEntryCount: number;
    previousCeilingCents: number | null;
    newCeilingCents: number;
}): number {
    if (params.openingEntryCount === 0) return 0;
    if (params.previousCeilingCents === null) return 0;
    if (params.openingCents !== params.previousCeilingCents) return 0;
    return params.newCeilingCents - params.openingCents;
}

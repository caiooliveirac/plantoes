/**
 * Razão do saldo contratual: quem escreve em operations_v2.contract_ledger.
 *
 * O problema que este arquivo resolve: o valor de um mês NÃO congela quando o
 * admin assina a atestação. Depois disso o total ainda pode mudar por pelo menos
 * oito caminhos — plantão extra/vermelho do admin, acerto de banco de horas,
 * correção administrativa, undo, chegada ou saída registrada pelo bot do
 * Telegram, confirmação de partida, atraso reconhecido. Pendurar um gatilho em
 * cada um desses writers é frágil: o nono aparece depois e o saldo desencontra
 * do fechamento em silêncio.
 *
 * Por isso aqui não existe "lançar". Existe RECONCILIAR: `syncContractLedgerForMonth`
 * compara o total pagável de agora com o 'invoice' vivo no razão e, se diferirem,
 * estorna o antigo e lança o novo. Chamar de novo sem mudança nenhuma não escreve
 * nada — é idempotente por construção, o que permite chamá-la em três lugares
 * sem medo:
 *
 *   1. na atestação, dentro da mesma transação (assinar lança, desassinar estorna);
 *   2. nas rotas de admin que sabidamente mexem no total;
 *   3. numa varredura diária dos meses abertos (Fase 6) — a rede que pega o que
 *      veio por um caminho que ninguém lembrou de instrumentar.
 *
 * O razão é append-only: nada é editado nem apagado. Corrigir é estornar e
 * relançar, e o histórico fica mostrando "o admin lançou um extra em 12/08, o
 * saldo caiu R$ 1.381,10".
 */
import { and, desc, eq, isNull, lte, or, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { contractLedger, contracts, paymentClosingAttestations } from "@/db/schema";
import { resolveMonthlyReportRange } from "@/modules/reporting/monthly-report";
import { isMonthWithinCycle } from "@/lib/contracts/statement";
import { getDoctorMonthlyPayableBreakdown } from "@/services/payable-shifts.service";

/** Origem dos lançamentos automáticos. Casa com contract_ledger.source_type. */
export const CLOSING_SOURCE_TYPE = "payment_closing_attestation";

/** '<doctorId>|<AAAA-MM>' — chave lógica estável (a atestação some ao desassinar). */
export function closingSourceKey(doctorId: string, monthKey: string): string {
    return `${doctorId}|${monthKey}`;
}

export type LedgerSyncOutcome =
    | "sem_contrato"        // o médico não tem contrato cobrindo o mês
    | "sem_alteracao"       // o razão já reflete o valor atual
    | "lancado"             // primeiro invoice do mês
    | "reajustado"          // estorno + novo invoice (o total mudou)
    | "estornado";          // atestação desfeita: só o estorno

export interface LedgerSyncResult {
    outcome: LedgerSyncOutcome;
    contractId: string | null;
    /** Valor consumido depois do sync, em centavos. Positivo = consumo. */
    consumedCents: number;
    /** Diferença aplicada nesta chamada, em centavos. */
    deltaCents: number;
}

/** Último dia do mês, para a competência do lançamento. */
function monthLastDay(monthKey: string): string {
    const [year, month] = monthKey.split("-").map(Number);
    return new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
}

function centsToNumeric(cents: number): string {
    return (cents / 100).toFixed(2);
}

/**
 * Qual contrato do médico vale na competência do mês. A janela manda: um médico
 * pode ter dois contratos ativos (Ana Beatriz D'Almeida) e o fechamento precisa
 * saber contra qual a nota corre. Havendo empate, vence o que começou depois.
 *
 * O CICLO também manda: contrato renovado em 01/08 não recebe lançamento de
 * agosto — agosto pertence ao ciclo novo. Enquanto a renovação não é
 * confirmada no sistema (não existe contrato com ciclo cobrindo o mês), o mês
 * fica sem lançamento ("sem_contrato") em vez de consumir o saldo do ciclo
 * vencido. O razão é append-only: um lançamento no contrato errado não se
 * corrige sozinho depois — melhor não escrever do que escrever errado. A
 * varredura diária lança o mês assim que o contrato novo existir.
 */
export async function resolveContractForMonth(
    tx: DbLike,
    doctorId: string,
    monthKey: string,
): Promise<{ id: string } | null> {
    const reference = monthLastDay(monthKey);
    const rows = await tx
        .select({ id: contracts.id, cycleStart: contracts.cycleStart, cycleEnd: contracts.cycleEnd })
        .from(contracts)
        .where(and(
            eq(contracts.doctorId, doctorId),
            eq(contracts.status, "active"),
            lte(contracts.startedAt, reference),
            or(isNull(contracts.endedAt), sql`${contracts.endedAt} > ${reference}`),
        ))
        .orderBy(desc(contracts.startedAt));
    const match = rows.find((row) => isMonthWithinCycle(monthKey, row.cycleStart, row.cycleEnd));
    return match ? { id: match.id } : null;
}

/**
 * Aceita tanto o db quanto uma transação: o sync precisa rodar DENTRO da
 * transação da atestação. O tipo do tx do Drizzle não é o mesmo do db (falta
 * `$client`), então o contrato aqui é só o que este arquivo usa de fato.
 */
type DbLike = Pick<ReturnType<typeof getDb>, "select" | "insert">;

interface LiveInvoice {
    amountCents: number;
    weekdayShifts: number;
    weekendShifts: number;
    nextRevision: number;
}

/**
 * Soma o que já está no razão para esta origem. Como estorno é lançamento novo
 * (e não UPDATE), o valor vivo é a soma algébrica de tudo — invoice negativo
 * mais reversal positivo. Zero significa "não há invoice vivo".
 */
async function loadLiveInvoice(tx: DbLike, sourceKey: string): Promise<LiveInvoice> {
    const rows = await tx
        .select({
            amount: contractLedger.amount,
            weekdayShifts: contractLedger.weekdayShifts,
            weekendShifts: contractLedger.weekendShifts,
            revision: contractLedger.sourceRevision,
        })
        .from(contractLedger)
        .where(and(
            eq(contractLedger.sourceType, CLOSING_SOURCE_TYPE),
            eq(contractLedger.sourceKey, sourceKey),
        ));

    let amountCents = 0;
    let weekdayShifts = 0;
    let weekendShifts = 0;
    let maxRevision = -1;
    for (const row of rows) {
        amountCents += Math.round(Number(row.amount) * 100);
        weekdayShifts += Number(row.weekdayShifts);
        weekendShifts += Number(row.weekendShifts);
        maxRevision = Math.max(maxRevision, row.revision);
    }
    return { amountCents, weekdayShifts, weekendShifts, nextRevision: maxRevision + 1 };
}

/** O que já está lançado para uma origem, somado. */
export interface LiveLedgerState {
    amountCents: number;
    weekdayShifts: number;
    weekendShifts: number;
    nextRevision: number;
}

export interface LedgerSyncPlan {
    /** `false` = nada a escrever; o razão já reflete o valor atual. */
    shouldWrite: boolean;
    deltaCents: number;
    deltaWeekdayShifts: number;
    deltaWeekendShifts: number;
    revision: number;
    entryType: "invoice" | "invoice_reversal";
    outcome: LedgerSyncOutcome;
}

/**
 * A decisão do sync, sem banco: dado o que está lançado e quanto o mês vale
 * agora, o que precisa ser escrito. Separada para poder ser testada — é aqui que
 * mora a idempotência e o sinal dos plantões no estorno.
 */
export function planLedgerSync(params: {
    live: LiveLedgerState;
    current: { amountCents: number; weekdayShifts: number; weekendShifts: number };
    attested: boolean;
}): LedgerSyncPlan {
    const { live, attested } = params;
    // Desassinado, o alvo é zero: o estorno leva o saldo de volta ao que era.
    const current = attested ? params.current : { amountCents: 0, weekdayShifts: 0, weekendShifts: 0 };

    // No razão o consumo é negativo; o breakdown do fechamento vem positivo.
    const targetAmountCents = -current.amountCents;
    const deltaCents = targetAmountCents - live.amountCents;
    const deltaWeekdayShifts = current.weekdayShifts - live.weekdayShifts;
    const deltaWeekendShifts = current.weekendShifts - live.weekendShifts;

    const shouldWrite = deltaCents !== 0 || deltaWeekdayShifts !== 0 || deltaWeekendShifts !== 0;
    const outcome: LedgerSyncOutcome = !shouldWrite
        ? "sem_alteracao"
        : !attested
            ? "estornado"
            : live.nextRevision === 0
                ? "lancado"
                : "reajustado";

    return {
        shouldWrite,
        deltaCents,
        deltaWeekdayShifts,
        deltaWeekendShifts,
        revision: live.nextRevision,
        // O sinal escolhe o tipo: consumo é 'invoice', devolução de saldo é
        // 'invoice_reversal'. Vale tanto para desassinar quanto para o admin
        // remover um plantão de um mês já atestado.
        entryType: deltaCents > 0 ? "invoice_reversal" : "invoice",
        outcome,
    };
}

export interface SyncParams {
    doctorId: string;
    monthKey: string;
    /**
     * Consumo do mês já apurado. Evita reconstruir o board a cada médico: o
     * `getDoctorMonthlyPayableBreakdown` monta o mês INTEIRO, então numa
     * varredura por (médico, mês) o custo vira quadrático se cada chamada
     * refizer a apuração. Ver `syncContractLedgerForMonthBatch`.
     */
    precomputed?: { amountCents: number; weekdayShifts: number; weekendShifts: number };
    /**
     * `false` desfaz o lançamento (o admin desassinou). O estorno é lançamento
     * novo com os plantões NEGATIVOS — sem isso a view soma os plantões duas
     * vezes, porque ela soma as colunas cruas.
     *
     * OMITIDO = descobre sozinho, consultando a atestação. É o modo da varredura
     * diária: ela não sabe o estado de cada mês, e assumir `true` faria rascunho
     * consumir saldo antes de o coordenador assinar — o SPEC §4.1 proíbe.
     */
    attested?: boolean;
    actorUserId?: string | null;
    /** Nota fiscal e processo, quando conhecidos, para o lançamento carregar. */
    invoiceNumber?: string | null;
    processNumber?: string | null;
    /** Permite rodar dentro da transação da atestação. */
    tx?: DbLike;
}

/** O mês está assinado? Rascunho não consome saldo. */
async function isMonthAttested(tx: DbLike, doctorId: string, monthKey: string): Promise<boolean> {
    const rows = await tx
        .select({ id: paymentClosingAttestations.id })
        .from(paymentClosingAttestations)
        .where(and(
            eq(paymentClosingAttestations.doctorId, doctorId),
            eq(paymentClosingAttestations.monthKey, monthKey),
        ))
        .limit(1);
    return rows.length > 0;
}

/** Apura o consumo de um mês. Fora de transação, sempre — abre conexão própria. */
export async function loadMonthConsumption(doctorId: string, monthKey: string) {
    const range = resolveMonthlyReportRange(monthKey);
    const breakdown = await getDoctorMonthlyPayableBreakdown(range.start, range.end);
    return breakdown.get(doctorId)?.get(monthKey) ?? { amountCents: 0, weekdayShifts: 0, weekendShifts: 0 };
}

export async function syncContractLedgerForMonth(params: SyncParams): Promise<LedgerSyncResult> {
    const { doctorId, monthKey, actorUserId = null, tx = getDb() } = params;

    // DEADLOCK: o pool tem max=1 (db/index.ts). Se este sync roda DENTRO de uma
    // transação e precisa apurar o mês, o getDoctorMonthlyPayableBreakdown pede
    // uma segunda conexão que nunca vem — a transação segura a única que existe.
    // Trava o app inteiro, não só a atestação. Aconteceu em produção em
    // 2026-08-03: 13 minutos de "idle in transaction" e nenhuma requisição
    // respondendo. Quem chama dentro de transação apura ANTES e passa em
    // precomputed.
    if (params.tx && !params.precomputed) {
        throw new Error(
            "syncContractLedgerForMonth dentro de transação exige `precomputed`"
            + " — apure o mês antes de abrir a transação (ver loadMonthConsumption).",
        );
    }
    const sourceKey = closingSourceKey(doctorId, monthKey);
    const attested = params.attested ?? await isMonthAttested(tx, doctorId, monthKey);

    const contract = await resolveContractForMonth(tx, doctorId, monthKey);
    const live = await loadLiveInvoice(tx, sourceKey);

    if (!contract) {
        // Sem contrato não há onde lançar. Não é erro: 65 médicos ativos ainda
        // não têm contrato cadastrado, e o fechamento deles segue funcionando.
        return { outcome: "sem_contrato", contractId: null, consumedCents: -live.amountCents, deltaCents: 0 };
    }

    // Quanto o mês vale AGORA — não o que valia quando o admin assinou.
    const current = params.precomputed ?? await (async () => {
        const range = resolveMonthlyReportRange(monthKey);
        const breakdown = await getDoctorMonthlyPayableBreakdown(range.start, range.end);
        return breakdown.get(doctorId)?.get(monthKey)
            ?? { amountCents: 0, weekdayShifts: 0, weekendShifts: 0 };
    })();

    const plan = planLedgerSync({ live, current, attested });
    if (!plan.shouldWrite) {
        return {
            outcome: "sem_alteracao",
            contractId: contract.id,
            consumedCents: -live.amountCents,
            deltaCents: 0,
        };
    }

    await tx.insert(contractLedger).values({
        contractId: contract.id,
        entryDate: monthLastDay(monthKey),
        type: plan.entryType,
        amount: centsToNumeric(plan.deltaCents),
        weekdayShifts: plan.deltaWeekdayShifts.toFixed(1),
        weekendShifts: plan.deltaWeekendShifts.toFixed(1),
        sourceType: CLOSING_SOURCE_TYPE,
        sourceKey,
        sourceRevision: plan.revision,
        invoiceNumber: params.invoiceNumber ?? null,
        processNumber: params.processNumber ?? null,
        description: plan.outcome === "estornado"
            ? `Atestação de ${monthKey} desfeita — estorno do consumo lançado`
            : plan.outcome === "lancado"
                ? `Fechamento de ${monthKey} atestado`
                : `Fechamento de ${monthKey} reajustado — o total do mês mudou depois da atestação`,
        createdByUserId: actorUserId,
    });

    return {
        outcome: plan.outcome,
        contractId: contract.id,
        consumedCents: -(live.amountCents + plan.deltaCents),
        deltaCents: plan.deltaCents,
    };
}

/**
 * Reconcilia todos os meses atestados de um médico. Usada quando a mudança não
 * diz a qual mês pertence (correção administrativa, undo) e pela varredura.
 */
export async function syncContractLedgerForMonths(params: {
    doctorId: string;
    monthKeys: string[];
    actorUserId?: string | null;
    tx?: DbLike;
}): Promise<LedgerSyncResult[]> {
    const results: LedgerSyncResult[] = [];
    for (const monthKey of params.monthKeys) {
        // Sem `attested`: cada mês responde por si, consultando a atestação.
        results.push(await syncContractLedgerForMonth({
            doctorId: params.doctorId,
            monthKey,
            actorUserId: params.actorUserId,
            tx: params.tx,
        }));
    }
    return results;
}

/**
 * Reconcilia um mês inteiro de uma vez: apura o board UMA vez e reusa para todos
 * os médicos. É o que a varredura diária (Fase 6) usa — sem isso cada médico
 * refaria a apuração do mês, e a varredura de ~130 contratos leva minutos em vez
 * de segundos.
 *
 * `doctorIds` omitido = todos os médicos com atestação naquele mês.
 */
export async function syncContractLedgerForMonthBatch(params: {
    monthKey: string;
    doctorIds?: string[];
    actorUserId?: string | null;
    tx?: DbLike;
}): Promise<Map<string, LedgerSyncResult>> {
    const { monthKey, actorUserId = null, tx = getDb() } = params;
    const range = resolveMonthlyReportRange(monthKey);
    const breakdown = await getDoctorMonthlyPayableBreakdown(range.start, range.end);

    const attestedRows = await tx
        .select({ doctorId: paymentClosingAttestations.doctorId })
        .from(paymentClosingAttestations)
        .where(eq(paymentClosingAttestations.monthKey, monthKey));
    const attestedIds = new Set(attestedRows.map((row) => row.doctorId));

    // Quem tem atestação (pode precisar lançar) + quem já tem lançamento no razão
    // (pode precisar estornar, se a atestação foi desfeita).
    const targets = new Set(params.doctorIds ?? [...attestedIds]);
    if (!params.doctorIds) {
        const withEntries = await tx
            .select({ sourceKey: contractLedger.sourceKey })
            .from(contractLedger)
            .where(and(
                eq(contractLedger.sourceType, CLOSING_SOURCE_TYPE),
                sql`${contractLedger.sourceKey} like ${`%|${monthKey}`}`,
            ));
        for (const row of withEntries) {
            if (row.sourceKey) targets.add(row.sourceKey.split("|")[0]);
        }
    }

    const results = new Map<string, LedgerSyncResult>();
    for (const doctorId of targets) {
        results.set(doctorId, await syncContractLedgerForMonth({
            doctorId,
            monthKey,
            attested: attestedIds.has(doctorId),
            precomputed: breakdown.get(doctorId)?.get(monthKey)
                ?? { amountCents: 0, weekdayShifts: 0, weekendShifts: 0 },
            actorUserId,
            tx,
        }));
    }
    return results;
}

/** Ajuste manual do admin. Justificativa é obrigatória — sem ela não há auditoria. */
export async function recordManualAdjustment(params: {
    contractId: string;
    amountCents: number;
    entryDate: string;
    description: string;
    actorUserId: string;
    tx?: DbLike;
}): Promise<void> {
    const description = params.description.trim();
    if (description.length < 5) {
        throw new Error("Descreva o motivo do ajuste — ele fica no histórico do contrato.");
    }
    if (!Number.isInteger(params.amountCents) || params.amountCents === 0) {
        throw new Error("O ajuste precisa de um valor diferente de zero.");
    }

    const tx = params.tx ?? getDb();
    await tx.insert(contractLedger).values({
        contractId: params.contractId,
        entryDate: params.entryDate,
        type: "manual_adjustment",
        amount: centsToNumeric(params.amountCents),
        description,
        createdByUserId: params.actorUserId,
    });
}


/**
 * Quanto falta (ou sobra) para o razão fechar no saldo informado para o dia 1º
 * de um mês. O saldo do dia inclui o que está lançado NAQUELE dia: a abertura
 * do contrato tem a data do primeiro dia do ciclo, e excluí-la fazia a correção
 * SOMAR ao valor errado em vez de substituí-lo — o admin informava 152.465,92
 * para 01/05 e o saldo virava 78.288,13 + 152.465,92 (caso Alexandre Curi,
 * 31/08/2026). Consumo de fechamento cai sempre no último dia do mês, então
 * incluir o próprio dia 1º não engole mês nenhum; uma âncora anterior no mesmo
 * dia entra na conta e a correção seguinte substitui de novo, não acumula.
 */
export function planBalanceAnchor(params: {
    entries: Array<{ entryDate: string; amountCents: number }>;
    /** AAAA-MM-01. */
    anchorDate: string;
    targetBalanceCents: number;
}): { deltaCents: number; balanceBeforeCents: number } {
    const balanceBeforeCents = params.entries
        .filter((entry) => entry.entryDate <= params.anchorDate)
        .reduce((total, entry) => total + entry.amountCents, 0);
    return { deltaCents: params.targetBalanceCents - balanceBeforeCents, balanceBeforeCents };
}

/**
 * Âncora de saldo: o admin informa "no dia 1º de <mês> o saldo era R$ X" e o
 * serviço converte isso no ajuste manual que faz a soma do razão bater — sem
 * tocar teto, ciclo ou histórico (append-only: correção vira lançamento).
 */
export async function recordBalanceAnchor(params: {
    contractId: string;
    targetBalanceCents: number;
    /** AAAA-MM-01; o saldo informado é o do dia 1º do mês. */
    anchorDate: string;
    description: string;
    actorUserId: string;
}): Promise<{ deltaCents: number; balanceBeforeCents: number }> {
    const db = getDb();
    const rows = await db
        .select({ entryDate: contractLedger.entryDate, amount: contractLedger.amount })
        .from(contractLedger)
        .where(eq(contractLedger.contractId, params.contractId));
    const { deltaCents, balanceBeforeCents } = planBalanceAnchor({
        entries: rows.map((row) => ({
            entryDate: row.entryDate,
            amountCents: Math.round(Number(row.amount) * 100),
        })),
        anchorDate: params.anchorDate,
        targetBalanceCents: params.targetBalanceCents,
    });
    if (deltaCents === 0) {
        throw new Error(
            "O saldo calculado nessa data já é exatamente esse — nenhum ajuste necessário.",
        );
    }
    await recordManualAdjustment({
        contractId: params.contractId,
        amountCents: deltaCents,
        entryDate: params.anchorDate,
        description: params.description,
        actorUserId: params.actorUserId,
    });
    return { deltaCents, balanceBeforeCents };
}

/**
 * Crédito de abertura do contrato: o saldo que o coordenador digita quando a
 * planilha não trouxe número confiável, e o que o chefe define ao renovar.
 * Só o primeiro vale — um segundo 'opening' somaria saldo do nada.
 */
export async function recordOpeningBalance(params: {
    contractId: string;
    balanceCents: number;
    entryDate: string;
    /** `null` quando a abertura vem de script de carga, não de um clique. */
    actorUserId: string | null;
    tx?: DbLike;
}): Promise<void> {
    const tx = params.tx ?? getDb();
    const existing = await tx
        .select({ id: contractLedger.id })
        .from(contractLedger)
        .where(and(
            eq(contractLedger.contractId, params.contractId),
            eq(contractLedger.type, "opening"),
        ))
        .limit(1);
    if (existing.length > 0) {
        throw new Error("Este contrato já tem saldo de abertura. Para corrigir, lance um ajuste manual.");
    }

    await tx.insert(contractLedger).values({
        contractId: params.contractId,
        entryDate: params.entryDate,
        type: "opening",
        amount: centsToNumeric(params.balanceCents),
        description: "Saldo de abertura informado pelo coordenador",
        createdByUserId: params.actorUserId,
    });
}

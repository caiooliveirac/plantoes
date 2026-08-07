/**
 * Leitura do saldo contratual: junta a view contract_balance com o motor puro
 * da Fase 2 (lib/contracts/balance-metrics.ts).
 *
 * Nenhuma regra de negócio mora aqui — o cálculo é do módulo puro, a soma é da
 * view. Este arquivo só busca, converte para centavos e monta o read model.
 *
 * Vai mexer no saldo de contrato? Leia docs/saldo-contrato/README.md antes. O
 * saldo veio de uma planilha editada à mão, e o que parece bug de cálculo aqui
 * costuma ser dado de origem torto — inclusive saldo negativo que na verdade é
 * consumo acumulado num contrato sem teto lançado.
 */
import { and, eq, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { contractLedger, contracts } from "@/db/schema";
import {
    computeCycleMetrics,
    type CycleMetrics,
    type CycleMetricsInput,
} from "@/lib/contracts/balance-metrics";
import {
    buildContractStatement,
    isMonthWithinCycle,
    type ContractStatementMonth,
    type StatementMonthMovements,
} from "@/lib/contracts/statement";
import {
    resolveDoctorEmploymentType,
    resolveDoctorPaymentProfile,
    type DoctorEmploymentType,
    type DoctorPaymentProfile,
} from "@/modules/reporting/payable-shifts";
import { extractDoctorIsNaoPlantonista } from "@/modules/doctors/directory";
import { resolveMonthlyReportRange } from "@/modules/reporting/monthly-report";
import { getDoctorMonthlyPayableBreakdown } from "@/services/payable-shifts.service";

/** Mesmas tarifas do fechamento, em centavos (modules/reporting/payable-shifts.ts). */
const RATE_CENTS: Record<DoctorPaymentProfile, { weekday: number; weekend: number }> = {
    generalist: { weekday: 124487, weekend: 138110 },
    specialist: { weekday: 132966, weekend: 145715 },
    psychiatry: { weekday: 129982, weekend: 141147 },
};

interface MonthMovement { amountCents: number; weekdayShifts: number; weekendShifts: number }

/** Razão de um contrato quebrado por mês, para o extrato e para o saldo ao vivo. */
interface ContractLedgerMonthly {
    openingCents: number;
    openingDate: string | null;
    /** Consumo lançado no razão por mês (positivo = gasto), net de estornos. */
    settledByMonth: Map<string, number>;
    /** Ajustes manuais por mês, com sinal. */
    adjustmentsByMonth: Map<string, number>;
}

/**
 * Carrega o razão inteiro dos contratos pedidos, quebrado por mês, e o conjunto
 * global de (médico, mês) que já tem consumo VIVO lançado — vivo = a soma
 * algébrica dos lançamentos daquela origem é diferente de zero. Um mês atestado
 * e depois desassinado soma zero: para o saldo ele volta a ser apurado ao vivo,
 * porque o gasto do médico existe independente de assinatura.
 */
async function loadLedgerBreakdown(contractIds: string[]): Promise<{
    byContract: Map<string, ContractLedgerMonthly>;
    settledKeys: Set<string>;
}> {
    const db = getDb();

    // Origem de fechamento é global (o lançamento pode estar num contrato antigo
    // do mesmo médico): meses com consumo vivo no razão não voltam como pendência.
    const closingRows = await db
        .select({ sourceKey: contractLedger.sourceKey, amount: contractLedger.amount })
        .from(contractLedger)
        .where(eq(contractLedger.sourceType, "payment_closing_attestation"));
    const netByKey = new Map<string, number>();
    for (const row of closingRows) {
        if (!row.sourceKey) continue;
        netByKey.set(row.sourceKey, (netByKey.get(row.sourceKey) ?? 0) + Math.round(Number(row.amount) * 100));
    }
    const settledKeys = new Set<string>();
    for (const [key, net] of netByKey) if (net !== 0) settledKeys.add(key);

    const byContract = new Map<string, ContractLedgerMonthly>();
    if (contractIds.length === 0) return { byContract, settledKeys };

    const rows = await db
        .select({
            contractId: contractLedger.contractId,
            entryDate: contractLedger.entryDate,
            type: contractLedger.type,
            amount: contractLedger.amount,
            sourceKey: contractLedger.sourceKey,
        })
        .from(contractLedger)
        .where(sql`${contractLedger.contractId} = any(${sql.raw(`array[${contractIds.map((id) => `'${id}'`).join(",")}]::uuid[]`)})`);

    for (const row of rows) {
        const data = byContract.get(row.contractId)
            ?? { openingCents: 0, openingDate: null, settledByMonth: new Map(), adjustmentsByMonth: new Map() };
        const cents = Math.round(Number(row.amount) * 100);
        if (row.type === "opening") {
            data.openingCents += cents;
            if (data.openingDate === null || row.entryDate < data.openingDate) data.openingDate = row.entryDate;
        } else if (row.type === "manual_adjustment") {
            const mes = row.entryDate.slice(0, 7);
            data.adjustmentsByMonth.set(mes, (data.adjustmentsByMonth.get(mes) ?? 0) + cents);
        } else {
            // invoice / invoice_reversal: competência vem da chave da origem
            // ('<doctorId>|AAAA-MM'), com fallback na data do lançamento.
            const mes = row.sourceKey?.split("|")[1] ?? row.entryDate.slice(0, 7);
            data.settledByMonth.set(mes, (data.settledByMonth.get(mes) ?? 0) - cents);
        }
        byContract.set(row.contractId, data);
    }
    return { byContract, settledKeys };
}

/** Meses AAAA-MM de `primeiro` até `ultimo`, inclusive. */
function monthRange(primeiro: string, ultimo: string): string[] {
    const meses: string[] = [];
    let [ano, mes] = primeiro.split("-").map(Number);
    const [anoFim, mesFim] = ultimo.split("-").map(Number);
    while (ano < anoFim || (ano === anoFim && mes <= mesFim)) {
        meses.push(`${ano}-${String(mes).padStart(2, "0")}`);
        mes += 1;
        if (mes > 12) { mes = 1; ano += 1; }
    }
    return meses;
}

/**
 * Apura o valor pagável de cada mês para todos os médicos, uma vez por mês —
 * a apuração monta o mês inteiro, então o custo é por mês, não por contrato.
 */
async function loadMonthlyApuracao(meses: string[]): Promise<Map<string, Map<string, MonthMovement>>> {
    const apuracao = new Map<string, Map<string, MonthMovement>>();
    for (const mesChave of meses) {
        const range = resolveMonthlyReportRange(mesChave);
        apuracao.set(mesChave, new Map());
        const breakdown = await getDoctorMonthlyPayableBreakdown(range.start, range.end);
        for (const [doctorId, porMes] of breakdown) {
            const valor = porMes.get(mesChave);
            if (valor) apuracao.get(mesChave)!.set(doctorId, valor);
        }
    }
    return apuracao;
}

/**
 * Consumo que o médico já fez e o razão ainda não registrou.
 *
 * O razão só recebe lançamento no fechamento — mas o médico precisa ver o que
 * já gastou, não o que já foi carimbado: a cada plantão que ele dá, o saldo
 * dele muda de fato. Assinatura NÃO é pré-condição do valor: mês sem lançamento
 * vivo no razão é apurado ao vivo. Sem isto a tela mostrava saldo melhor que a
 * realidade para 126 dos 136 contratos (R$ 3,3 milhões no total).
 *
 * Conta os meses cuja competência é posterior ao lançamento de abertura, que
 * estão DENTRO do ciclo do contrato (renovou em 01/08 → agosto é do ciclo novo)
 * e que ainda não têm lançamento vivo no razão. Assim nada é contado duas vezes.
 */
function computePendingConsumption(params: {
    contratos: { contractId: string; doctorId: string; cycleStart: string; cycleEnd: string; openingAt: Date }[];
    meses: string[];
    apuracao: Map<string, Map<string, MonthMovement>>;
    settledKeys: Set<string>;
    /** Meses já lançados no razão do próprio contrato (qualquer origem — inclui import de planilha). */
    ledger: Map<string, ContractLedgerMonthly>;
    excludeMonthKey?: string;
}): Map<string, MonthMovement> {
    const pendente = new Map<string, MonthMovement>();
    for (const contrato of params.contratos) {
        const settledByMonth = params.ledger.get(contrato.contractId)?.settledByMonth;
        let amountCents = 0;
        let weekdayShifts = 0;
        let weekendShifts = 0;
        for (const mesChave of params.meses) {
            // Competência posterior à abertura, dentro do ciclo, e ainda não lançada.
            const ultimoDia = new Date(Date.UTC(
                Number(mesChave.slice(0, 4)),
                Number(mesChave.slice(5, 7)),
                0,
            ));
            if (ultimoDia <= contrato.openingAt) continue;
            if (!isMonthWithinCycle(mesChave, contrato.cycleStart, contrato.cycleEnd)) continue;
            if (mesChave === params.excludeMonthKey) continue;
            if (params.settledKeys.has(`${contrato.doctorId}|${mesChave}`)) continue;
            if (settledByMonth?.has(mesChave)) continue;
            const valor = params.apuracao.get(mesChave)?.get(contrato.doctorId);
            if (!valor) continue;
            amountCents += valor.amountCents;
            weekdayShifts += valor.weekdayShifts;
            weekendShifts += valor.weekendShifts;
        }
        pendente.set(contrato.contractId, { amountCents, weekdayShifts, weekendShifts });
    }
    return pendente;
}

export interface ContractBalanceRow {
    contractId: string;
    doctorId: string;
    doctorName: string;
    contractNumber: string;
    companyName: string | null;
    category: "generalista" | "especialista" | "psiquiatria";
    /**
     * Perfil e vínculo do MÉDICO (metadata), não do contrato. É por eles que as
     * varreduras decidem quem tem saldo acompanhado — ver `tracksContractBalance`
     * em modules/reporting/payment-closing-pendencies.ts.
     */
    paymentProfile: DoctorPaymentProfile;
    employmentType: DoctorEmploymentType;
    /** Cadastro que não dá plantão (conta de sistema, coordenação): fora das varreduras. */
    isNaoPlantonista: boolean;
    weeklyHours: number | null;
    cycleStart: string;
    cycleEnd: string;
    ceilingCents: number | null;
    /** `true` = razão vazio: o coordenador ainda não informou o saldo. */
    awaitingOpeningBalance: boolean;
    /** Saldo já conferido e assinado — o que está no razão. */
    settledBalanceCents: number;
    /** Plantões já dados que ainda não foram fechados. */
    pendingConsumptionCents: number;
    metrics: CycleMetrics;
    /** A entrada exata que gerou `metrics` — o /simulate reusa em vez de remontar. */
    metricsInput: CycleMetricsInput;
    /**
     * Extrato mês a mês: saldo datado no início do mês, gasto do mês, saldo
     * datado no fim (dia 1º do mês seguinte, fim do ciclo, ou HOJE). Inclui o
     * mês corrente mesmo quando `excludeMonthKey` o tira do saldo projetado —
     * o extrato mostra a realidade de hoje, sem depender de assinatura.
     */
    statement: ContractStatementMonth[];
}

interface BalanceViewRow {
    contract_id: string;
    doctor_id: string;
    cycle_start: string;
    cycle_end: string;
    ceiling: string | null;
    opening_balance: string;
    balance: string;
    consumed: string;
    weekday_shifts: string;
    weekend_shifts: string;
    last_invoice_date: string | null;
}

function toCents(value: string | null): number | null {
    if (value === null) return null;
    return Math.round(Number(value) * 100);
}

function toDate(value: string): Date {
    return new Date(`${value}T00:00:00Z`);
}

export async function loadContractBalances(params: {
    asOf?: Date;
    doctorId?: string;
    /**
     * Mês que NÃO deve entrar no saldo projetado.
     *
     * A tela do fechamento subtrai o mês em edição por conta própria ("saldo
     * depois"). Se ele também entrasse no saldo em aberto, o valor sairia
     * descontado duas vezes. Quem monta o board do mês M passa M aqui; o painel
     * do médico não passa nada, porque quer ver tudo que já gastou.
     */
    excludeMonthKey?: string;
} = {}): Promise<{ rows: ContractBalanceRow[]; asOf: Date; computedAt: Date }> {
    const asOf = params.asOf ?? new Date();
    const db = getDb();

    const filter = params.doctorId ? sql`and b.doctor_id = ${params.doctorId}` : sql``;
    const result = await db.execute(sql`
        select b.*, c.contract_number, c.company_name, c.category, c.weekly_hours,
               d.full_name, d.metadata
        from operations_v2.contract_balance b
        join operations_v2.contracts c on c.id = b.contract_id
        join operations_v2.doctors d on d.id = b.doctor_id
        where c.status = 'active' ${filter}
        order by d.full_name
    `);
    const viewRows = result as unknown as (BalanceViewRow & {
        contract_number: string;
        company_name: string | null;
        category: ContractBalanceRow["category"];
        weekly_hours: string | null;
        full_name: string;
        metadata: unknown;
    })[];

    const { byContract: ledger, settledKeys } = await loadLedgerBreakdown(viewRows.map((row) => row.contract_id));

    // Janela observada de cada contrato: começa no lançamento de abertura;
    // sem abertura, no início do ciclo.
    const observedSince = new Map<string, Date>();
    for (const row of viewRows) {
        const openingDate = ledger.get(row.contract_id)?.openingDate;
        observedSince.set(row.contract_id, openingDate ? toDate(openingDate) : toDate(row.cycle_start));
    }

    const contratos = viewRows.map((row) => ({
        contractId: row.contract_id,
        doctorId: row.doctor_id,
        cycleStart: row.cycle_start,
        cycleEnd: row.cycle_end,
        openingAt: observedSince.get(row.contract_id)!,
    }));

    // Meses a apurar ao vivo: da abertura mais antiga até o mês corrente.
    const mesDe = (data: Date) => `${data.getUTCFullYear()}-${String(data.getUTCMonth() + 1).padStart(2, "0")}`;
    const mesAtual = mesDe(asOf);
    const primeiroMes = contratos
        .map((c) => mesDe(c.openingAt))
        .reduce((menor, atual) => (atual < menor ? atual : menor), mesAtual);
    const meses = contratos.length > 0 ? monthRange(primeiroMes, mesAtual) : [];
    const apuracao = await loadMonthlyApuracao(meses);

    // O que o médico já gastou e o fechamento ainda não carimbou.
    const pendente = computePendingConsumption({
        contratos,
        meses,
        apuracao,
        settledKeys,
        ledger,
        excludeMonthKey: params.excludeMonthKey,
    });

    const asOfDate = asOf.toISOString().slice(0, 10);
    // Extrato mês a mês por contrato: razão (fechado + ajustes) + apuração ao
    // vivo dos meses sem lançamento. Diferente do saldo projetado, o extrato
    // NÃO exclui o mês em edição — a última linha é o saldo de hoje de fato.
    const statements = new Map<string, ContractStatementMonth[]>();
    for (const contrato of contratos) {
        const data = ledger.get(contrato.contractId)
            ?? { openingCents: 0, openingDate: null, settledByMonth: new Map<string, number>(), adjustmentsByMonth: new Map<string, number>() };
        const months = new Map<string, StatementMonthMovements>();
        const add = (mes: string, delta: Partial<StatementMonthMovements>) => {
            const atual = months.get(mes) ?? { consumptionCents: 0, adjustmentsCents: 0 };
            months.set(mes, {
                consumptionCents: atual.consumptionCents + (delta.consumptionCents ?? 0),
                adjustmentsCents: atual.adjustmentsCents + (delta.adjustmentsCents ?? 0),
            });
        };
        for (const [mes, cents] of data.settledByMonth) add(mes, { consumptionCents: cents });
        for (const [mes, cents] of data.adjustmentsByMonth) add(mes, { adjustmentsCents: cents });
        for (const mesChave of meses) {
            const ultimoDia = new Date(Date.UTC(Number(mesChave.slice(0, 4)), Number(mesChave.slice(5, 7)), 0));
            if (ultimoDia <= contrato.openingAt) continue;
            if (!isMonthWithinCycle(mesChave, contrato.cycleStart, contrato.cycleEnd)) continue;
            if (data.settledByMonth.has(mesChave)) continue;
            if (settledKeys.has(`${contrato.doctorId}|${mesChave}`)) continue;
            const valor = apuracao.get(mesChave)?.get(contrato.doctorId);
            if (!valor) continue;
            add(mesChave, { consumptionCents: valor.amountCents });
        }
        statements.set(contrato.contractId, buildContractStatement({
            openingCents: data.openingCents,
            openingDate: data.openingDate ?? contrato.cycleStart,
            months,
            cycleEnd: contrato.cycleEnd,
            asOfDate,
        }));
    }

    const rows = viewRows.map((row) => {
        const profile = resolveDoctorPaymentProfile(row.metadata);
        const rates = RATE_CENTS[profile];
        const settledBalanceCents = toCents(row.balance) ?? 0;
        const settledConsumedCents = toCents(row.consumed) ?? 0;
        const emAberto = pendente.get(row.contract_id) ?? { amountCents: 0, weekdayShifts: 0, weekendShifts: 0 };

        // O saldo que vale para quem acompanha o próprio contrato é o de agora,
        // não o do último mês assinado. O razão continua guardando o fechado.
        const balanceCents = settledBalanceCents - emAberto.amountCents;
        const consumedCents = settledConsumedCents + emAberto.amountCents;

        const input: CycleMetricsInput = {
            ceilingCents: toCents(row.ceiling),
            balanceCents,
            observedConsumptionCents: consumedCents,
            // Sem abertura ainda, a janela observada começa no ciclo — o
            // amortecedor de 45 dias do motor cuida do resto.
            observedSince: observedSince.get(row.contract_id) ?? toDate(row.cycle_start),
            cycleStart: toDate(row.cycle_start),
            cycleEnd: toDate(row.cycle_end),
            asOf,
            weekdayRateCents: rates.weekday,
            weekendRateCents: rates.weekend,
            weekdayShifts: Number(row.weekday_shifts) + emAberto.weekdayShifts,
            weekendShifts: Number(row.weekend_shifts) + emAberto.weekendShifts,
        };

        return {
            contractId: row.contract_id,
            doctorId: row.doctor_id,
            doctorName: row.full_name,
            contractNumber: row.contract_number,
            companyName: row.company_name,
            category: row.category,
            paymentProfile: profile,
            employmentType: resolveDoctorEmploymentType(row.metadata),
            isNaoPlantonista: extractDoctorIsNaoPlantonista(row.metadata),
            weeklyHours: row.weekly_hours === null ? null : Number(row.weekly_hours),
            cycleStart: row.cycle_start,
            cycleEnd: row.cycle_end,
            ceilingCents: toCents(row.ceiling),
            // A pergunta é "existe lançamento de abertura no razão?", NÃO "o médico
            // ficou parado?". A versão antiga também exigia consumo zero, e com
            // isso a flag caía no primeiro plantão depois da carga: o contrato sem
            // teto passava a valer `0 − consumo` e o alerta das 08:00 anunciava
            // como "saldo zerado" um número que era a produção do médico. Foi o que
            // aconteceu com João Miguez e mais seis (dossiê 03-validacao-alertas-08-2026).
            // openingDate só é não-nulo quando existe entry do tipo 'opening' —
            // inclusive uma abertura de R$ 0,00 digitada de propósito pelo chefe.
            awaitingOpeningBalance: ledger.get(row.contract_id)?.openingDate == null,
            settledBalanceCents,
            pendingConsumptionCents: emAberto.amountCents,
            metrics: computeCycleMetrics(input),
            metricsInput: input,
            statement: statements.get(row.contract_id) ?? [],
        } satisfies ContractBalanceRow;
    });

    return { rows, asOf, computedAt: new Date() };
}

/** Médicos ativos sem contrato: aparecem na tela com o saldo em branco. */
export async function loadDoctorsWithoutContract(): Promise<{ id: string; fullName: string }[]> {
    const rows = await getDb().execute(sql`
        select d.id, d.full_name
        from operations_v2.doctors d
        where d.is_active
          and not exists (
            select 1 from operations_v2.contracts c
            where c.doctor_id = d.id and c.status = 'active'
          )
        order by d.full_name
    `);
    return (rows as unknown as { id: string; full_name: string }[])
        .map((row) => ({ id: row.id, fullName: row.full_name }));
}

/** Histórico do razão de um contrato, do mais recente para o mais antigo. */
export async function loadContractLedger(contractId: string) {
    return getDb()
        .select({
            id: contractLedger.id,
            entryDate: contractLedger.entryDate,
            type: contractLedger.type,
            amount: contractLedger.amount,
            weekdayShifts: contractLedger.weekdayShifts,
            weekendShifts: contractLedger.weekendShifts,
            invoiceNumber: contractLedger.invoiceNumber,
            processNumber: contractLedger.processNumber,
            description: contractLedger.description,
            createdAt: contractLedger.createdAt,
        })
        .from(contractLedger)
        .where(eq(contractLedger.contractId, contractId))
        .orderBy(sql`entry_date desc, created_at desc`);
}

/** Contratos ativos de um médico, para o seletor do fechamento. */
export async function loadActiveContractsForDoctor(doctorId: string) {
    return getDb()
        .select({
            id: contracts.id,
            contractNumber: contracts.contractNumber,
            companyName: contracts.companyName,
            cycleStart: contracts.cycleStart,
            cycleEnd: contracts.cycleEnd,
            startedAt: contracts.startedAt,
            endedAt: contracts.endedAt,
        })
        .from(contracts)
        .where(and(eq(contracts.doctorId, doctorId), eq(contracts.status, "active")))
        .orderBy(contracts.startedAt);
}

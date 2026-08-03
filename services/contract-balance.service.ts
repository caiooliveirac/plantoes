/**
 * Leitura do saldo contratual: junta a view contract_balance com o motor puro
 * da Fase 2 (lib/contracts/balance-metrics.ts).
 *
 * Nenhuma regra de negócio mora aqui — o cálculo é do módulo puro, a soma é da
 * view. Este arquivo só busca, converte para centavos e monta o read model.
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
    resolveDoctorPaymentProfile,
    type DoctorPaymentProfile,
} from "@/modules/reporting/payable-shifts";
import { resolveMonthlyReportRange } from "@/modules/reporting/monthly-report";
import { getDoctorMonthlyPayableBreakdown } from "@/services/payable-shifts.service";

/** Mesmas tarifas do fechamento, em centavos (modules/reporting/payable-shifts.ts). */
const RATE_CENTS: Record<DoctorPaymentProfile, { weekday: number; weekend: number }> = {
    generalist: { weekday: 124487, weekend: 138110 },
    specialist: { weekday: 132966, weekend: 145715 },
    psychiatry: { weekday: 129982, weekend: 141147 },
};

/**
 * Consumo que o médico já fez e o razão ainda não registrou.
 *
 * O razão só recebe lançamento de fechamento ATESTADO — é o registro do que foi
 * conferido e assinado. Mas o médico precisa ver o que já gastou, não o que já
 * foi carimbado: a cada plantão que ele dá, o saldo dele muda de fato. Sem isto
 * a tela mostrava saldo melhor que a realidade para 126 dos 136 contratos, um
 * total de R$ 3,3 milhões — gente com saldo positivo na tela que já estava
 * negativa de verdade.
 *
 * Conta os meses do ciclo cuja competência é posterior ao lançamento de abertura
 * e que ainda não têm invoice no razão. Assim nada é contado duas vezes.
 */
async function loadPendingConsumption(params: {
    contratos: { contractId: string; doctorId: string; cycleEnd: string; openingAt: Date }[];
    asOf: Date;
    excludeMonthKey?: string;
}): Promise<Map<string, { amountCents: number; weekdayShifts: number; weekendShifts: number }>> {
    const pendente = new Map<string, { amountCents: number; weekdayShifts: number; weekendShifts: number }>();
    if (params.contratos.length === 0) return pendente;

    const mesDe = (data: Date) => `${data.getUTCFullYear()}-${String(data.getUTCMonth() + 1).padStart(2, "0")}`;
    const mesAtual = mesDe(params.asOf);
    const primeiroMes = params.contratos
        .map((c) => mesDe(c.openingAt))
        .reduce((menor, atual) => (atual < menor ? atual : menor), mesAtual);

    // Meses a apurar, uma vez cada — a apuração monta o mês inteiro.
    const meses: string[] = [];
    let [ano, mes] = primeiroMes.split("-").map(Number);
    const [anoFim, mesFim] = mesAtual.split("-").map(Number);
    while (ano < anoFim || (ano === anoFim && mes <= mesFim)) {
        meses.push(`${ano}-${String(mes).padStart(2, "0")}`);
        mes += 1;
        if (mes > 12) { mes = 1; ano += 1; }
    }
    if (meses.length === 0) return pendente;

    const jaLancado = new Set<string>();
    const linhas = await getDb()
        .select({ sourceKey: contractLedger.sourceKey })
        .from(contractLedger)
        .where(eq(contractLedger.sourceType, "payment_closing_attestation"));
    for (const linha of linhas) if (linha.sourceKey) jaLancado.add(linha.sourceKey);

    const apuracao = new Map<string, Map<string, { amountCents: number; weekdayShifts: number; weekendShifts: number }>>();
    for (const mesChave of meses) {
        const range = resolveMonthlyReportRange(mesChave);
        apuracao.set(mesChave, new Map());
        const breakdown = await getDoctorMonthlyPayableBreakdown(range.start, range.end);
        for (const [doctorId, porMes] of breakdown) {
            const valor = porMes.get(mesChave);
            if (valor) apuracao.get(mesChave)!.set(doctorId, valor);
        }
    }

    for (const contrato of params.contratos) {
        let amountCents = 0;
        let weekdayShifts = 0;
        let weekendShifts = 0;
        for (const mesChave of meses) {
            // Competência posterior à abertura, dentro do ciclo, e ainda não lançada.
            const ultimoDia = new Date(Date.UTC(
                Number(mesChave.slice(0, 4)),
                Number(mesChave.slice(5, 7)),
                0,
            ));
            if (ultimoDia <= contrato.openingAt) continue;
            if (`${mesChave}-01` >= contrato.cycleEnd) continue;
            if (mesChave === params.excludeMonthKey) continue;
            if (jaLancado.has(`${contrato.doctorId}|${mesChave}`)) continue;
            const valor = apuracao.get(mesChave)?.get(contrato.doctorId);
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

/**
 * Data a partir da qual há consumo medido. É o lançamento de abertura: antes
 * dele o razão não sabe nada, e medir ritmo em janela sem dado dá projeção
 * otimista (ver o comentário do burn rate em lib/contracts/balance-metrics.ts).
 */
async function loadObservedSince(contractIds: string[]): Promise<Map<string, Date>> {
    if (contractIds.length === 0) return new Map();
    const rows = await getDb()
        .select({ contractId: contractLedger.contractId, entryDate: contractLedger.entryDate })
        .from(contractLedger)
        .where(and(
            eq(contractLedger.type, "opening"),
            sql`${contractLedger.contractId} = any(${sql.raw(`array[${contractIds.map((id) => `'${id}'`).join(",")}]::uuid[]`)})`,
        ));
    return new Map(rows.map((row) => [row.contractId, toDate(row.entryDate)]));
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

    const observedSince = await loadObservedSince(viewRows.map((row) => row.contract_id));

    // O que o médico já gastou e o fechamento ainda não carimbou.
    const pendente = await loadPendingConsumption({
        asOf,
        excludeMonthKey: params.excludeMonthKey,
        contratos: viewRows.map((row) => ({
            contractId: row.contract_id,
            doctorId: row.doctor_id,
            cycleEnd: row.cycle_end,
            openingAt: observedSince.get(row.contract_id) ?? toDate(row.cycle_start),
        })),
    });

    const rows = viewRows.map((row) => {
        const profile = resolveDoctorPaymentProfile(row.metadata);
        const rates = RATE_CENTS[profile];
        const settledBalanceCents = toCents(row.balance) ?? 0;
        const openingCents = toCents(row.opening_balance) ?? 0;
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
            weeklyHours: row.weekly_hours === null ? null : Number(row.weekly_hours),
            cycleStart: row.cycle_start,
            cycleEnd: row.cycle_end,
            ceilingCents: toCents(row.ceiling),
            awaitingOpeningBalance: openingCents === 0 && settledConsumedCents === 0 && emAberto.amountCents === 0,
            settledBalanceCents,
            pendingConsumptionCents: emAberto.amountCents,
            metrics: computeCycleMetrics(input),
            metricsInput: input,
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

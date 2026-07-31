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

/** Mesmas tarifas do fechamento, em centavos (modules/reporting/payable-shifts.ts). */
const RATE_CENTS: Record<DoctorPaymentProfile, { weekday: number; weekend: number }> = {
    generalist: { weekday: 124487, weekend: 138110 },
    specialist: { weekday: 132966, weekend: 145715 },
    psychiatry: { weekday: 129982, weekend: 141147 },
};

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

    const rows = viewRows.map((row) => {
        const profile = resolveDoctorPaymentProfile(row.metadata);
        const rates = RATE_CENTS[profile];
        const balanceCents = toCents(row.balance) ?? 0;
        const openingCents = toCents(row.opening_balance) ?? 0;
        const consumedCents = toCents(row.consumed) ?? 0;

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
            weekdayShifts: Number(row.weekday_shifts),
            weekendShifts: Number(row.weekend_shifts),
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
            awaitingOpeningBalance: openingCents === 0 && consumedCents === 0,
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

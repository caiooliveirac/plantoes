/**
 * Fila de pendências de contrato: o trabalho manual que sobrou da carga da
 * planilha (docs/saldo-contrato/02-pendencias-pos-deploy.md) e que até aqui só
 * se enxergava rodando script (lancar-tetos-pendentes.ts + tetos-pendentes.json).
 *
 * Só LEITURA. Cada item aponta para a tela que já resolve — o modal do médico
 * no fechamento (contrato, teto, saldo de abertura, renovação, vínculo) ou o
 * cadastro de médicos (desativar quem saiu). Nenhuma regra nova de escrita.
 *
 * Nada aqui é régua nova de contrato: quem tem saldo acompanhado é
 * `tracksContractBalance`, e vencido/sem abertura é `findPendingRenewals` — as
 * mesmas da tela do fechamento e dos avisos das 8h. Deliberadamente NÃO passa
 * por loadContractBalances: a fila não precisa de saldo, e aquela leitura apura
 * mês a mês.
 *
 * Antes de mexer, leia docs/saldo-contrato/README.md.
 */
import { sql } from "drizzle-orm";
import { getDb } from "@/db";
import { findPendingRenewals, type RenewalInputRow } from "@/lib/contracts/renewal";
import { extractDoctorIsNaoPlantonista } from "@/modules/doctors/directory";
import { tracksContractBalance } from "@/modules/reporting/payment-closing-pendencies";
import { resolveDoctorEmploymentType, resolveDoctorPaymentProfile } from "@/modules/reporting/payable-shifts";

/** Na ordem em que a tela mostra: o que mais dói primeiro. */
export const CONTRACT_PENDENCY_KINDS = [
    "sem_contrato",
    "vencido",
    "sem_saldo_de_abertura",
    "sem_teto",
    "vinculo_suspeito",
    "sem_plantao_recente",
] as const;

export type ContractPendencyKind = (typeof CONTRACT_PENDENCY_KINDS)[number];

/**
 * Sem plantão há mais que isto, o PJ sem contrato vira "conferir se ainda está
 * ativo" (grupo E de 02-pendencias) em vez de "plantonando sem contrato".
 */
export const RECENT_SHIFT_DAYS = 90;

export interface ContractPendencyDoctor {
    id: string;
    fullName: string;
    metadata: unknown;
    admittedAt: string | null;
    /** Último início de plantão, em qualquer dos dois domínios. */
    lastShiftAt: Date | null;
}

export interface ContractPendencyContract {
    contractId: string;
    doctorId: string;
    contractNumber: string;
    cycleStart: string;
    cycleEnd: string;
    ceilingCents: number | null;
    /** Razão sem lançamento de abertura. */
    awaitingOpeningBalance: boolean;
}

export interface ContractPendencyItem {
    kind: ContractPendencyKind;
    doctorId: string;
    doctorName: string;
    contractNumber: string | null;
    /** Frase curta do que está errado e do que fazer. */
    detail: string;
    /** AAAA-MM do último plantão (SP) — é o mês em que o modal do fechamento abre o médico. */
    lastShiftMonth: string | null;
}

export interface ContractPendencyQueue {
    items: ContractPendencyItem[];
    counts: Record<ContractPendencyKind, number>;
    total: number;
    asOf: Date;
}

const DAY_MS = 86_400_000;

function monthInSaoPaulo(value: Date): string {
    // en-CA formata AAAA-MM-DD.
    return value.toLocaleDateString("en-CA", { timeZone: "America/Sao_Paulo" }).slice(0, 7);
}

function formatDay(isoDay: string): string {
    return `${isoDay.slice(8, 10)}/${isoDay.slice(5, 7)}/${isoDay.slice(0, 4)}`;
}

/** Classificação pura: uma pendência por médico, no máximo. */
export function classifyContractPendencies(params: {
    doctors: ContractPendencyDoctor[];
    contracts: ContractPendencyContract[];
    asOf: Date;
}): ContractPendencyQueue {
    const { asOf } = params;
    const contractsByDoctor = new Map<string, ContractPendencyContract[]>();
    for (const contract of params.contracts) {
        const list = contractsByDoctor.get(contract.doctorId) ?? [];
        list.push(contract);
        contractsByDoctor.set(contract.doctorId, list);
    }

    const items: ContractPendencyItem[] = [];
    const renewalRows: RenewalInputRow[] = [];
    const doctorsById = new Map(params.doctors.map((doctor) => [doctor.id, doctor]));

    for (const doctor of params.doctors) {
        const contracts = contractsByDoctor.get(doctor.id) ?? [];
        const lastShiftMonth = doctor.lastShiftAt ? monthInSaoPaulo(doctor.lastShiftAt) : null;
        const base = { doctorId: doctor.id, doctorName: doctor.fullName, lastShiftMonth };
        const input = {
            employmentType: resolveDoctorEmploymentType(doctor.metadata),
            paymentProfile: resolveDoctorPaymentProfile(doctor.metadata),
            isNaoPlantonista: extractDoctorIsNaoPlantonista(doctor.metadata),
        };

        if (input.isNaoPlantonista) continue;

        // Estatutário não tem teto PJ. Com contrato ativo, um dos dois está
        // errado — em geral o vínculo (grupo D de 02-pendencias).
        if (input.employmentType === "estatutario") {
            if (contracts.length > 0) {
                items.push({
                    ...base,
                    kind: "vinculo_suspeito",
                    contractNumber: contracts[0].contractNumber,
                    detail: "Cadastrado como estatutário, mas com contrato PJ ativo. Confira o vínculo antes de mexer no contrato.",
                });
            }
            continue;
        }

        // Psiquiatria fica fora do acompanhamento de saldo — mesma régua da tela.
        if (!tracksContractBalance(input)) continue;

        if (contracts.length === 0) {
            const recent = doctor.lastShiftAt !== null
                && asOf.getTime() - doctor.lastShiftAt.getTime() <= RECENT_SHIFT_DAYS * DAY_MS;
            if (recent) {
                const semAdmissao = doctor.admittedAt === null ? " Sem data de admissão no cadastro: o ciclo sai dela." : "";
                items.push({
                    ...base,
                    kind: "sem_contrato",
                    contractNumber: null,
                    detail: `Plantonando sem contrato: cadastre contrato, ciclo e saldo. Se for estatutário, o errado é o vínculo.${semAdmissao}`,
                });
            } else {
                items.push({
                    ...base,
                    kind: "sem_plantao_recente",
                    contractNumber: null,
                    detail: doctor.lastShiftAt
                        ? `Ativo, sem contrato e sem plantão há mais de ${RECENT_SHIFT_DAYS} dias. Confira se ainda está na escala.`
                        : "Ativo, sem contrato e sem nenhum plantão registrado. Confira se ainda está na escala.",
                });
            }
            continue;
        }

        for (const contract of contracts) {
            renewalRows.push({
                doctorId: doctor.id,
                doctorName: doctor.fullName,
                contractId: contract.contractId,
                contractNumber: contract.contractNumber,
                cycleStart: contract.cycleStart,
                cycleEnd: contract.cycleEnd,
                awaitingOpeningBalance: contract.awaitingOpeningBalance,
            });
        }
    }

    const renewals = findPendingRenewals(renewalRows, asOf);
    const withRenewal = new Set<string>();
    for (const renewal of renewals) {
        withRenewal.add(renewal.doctorId);
        const doctor = doctorsById.get(renewal.doctorId)!;
        items.push({
            kind: renewal.kind,
            doctorId: renewal.doctorId,
            doctorName: renewal.doctorName,
            contractNumber: renewal.contractNumber,
            lastShiftMonth: doctor.lastShiftAt ? monthInSaoPaulo(doctor.lastShiftAt) : null,
            detail: renewal.kind === "vencido"
                ? `Ciclo terminou em ${formatDay(renewal.cycleEnd)} (${renewal.daysOverdue} dias) e não há renovação.`
                : "Contrato valendo sem saldo de abertura lançado. Um razão vazio não é saldo zero.",
        });
    }

    // Teto segue o contrato MAIS RECENTE, como resolveDoctorPendencies: o velho
    // sem teto não é pendência quando já existe sucessor com teto.
    for (const [doctorId, contracts] of contractsByDoctor) {
        if (withRenewal.has(doctorId)) continue;
        if (!renewalRows.some((row) => row.doctorId === doctorId)) continue;
        const newest = contracts.reduce((latest, contract) => (contract.cycleEnd > latest.cycleEnd ? contract : latest));
        if (newest.ceilingCents !== null) continue;
        const doctor = doctorsById.get(doctorId)!;
        items.push({
            kind: "sem_teto",
            doctorId,
            doctorName: doctor.fullName,
            contractNumber: newest.contractNumber,
            lastShiftMonth: doctor.lastShiftAt ? monthInSaoPaulo(doctor.lastShiftAt) : null,
            detail: "Contrato sem teto: sem ele não há percentual consumido nem projeção. Teto vazio não é zero.",
        });
    }

    const order = new Map(CONTRACT_PENDENCY_KINDS.map((kind, index) => [kind, index]));
    items.sort((left, right) => order.get(left.kind)! - order.get(right.kind)!
        || left.doctorName.localeCompare(right.doctorName, "pt-BR"));

    const counts = Object.fromEntries(CONTRACT_PENDENCY_KINDS.map((kind) => [kind, 0])) as Record<ContractPendencyKind, number>;
    for (const item of items) counts[item.kind] += 1;

    return { items, counts, total: items.length, asOf };
}

/**
 * Onde se resolve cada pendência. O modal do fechamento só abre médico que tem
 * plantão no mês pedido — por isso o mês do último plantão. Quem não tem
 * plantão nenhum fica sem link (o cadastro de médicos saiu em 29/09/2026).
 */
export function contractPendencyHref(item: Pick<ContractPendencyItem, "kind" | "doctorId" | "lastShiftMonth">): string | null {
    if (item.kind === "sem_plantao_recente" || item.lastShiftMonth === null) return null;
    return `/admin/payment-closing?month=${item.lastShiftMonth}&doctor=${item.doctorId}`;
}

export async function loadContractPendencyQueue(asOf: Date = new Date()): Promise<ContractPendencyQueue> {
    const db = getDb();
    const [doctorRows, contractRows] = await Promise.all([
        db.execute(sql`
            select d.id, d.full_name, d.metadata, d.admitted_at::text as admitted_at,
                   greatest(
                       (select max(r.started_at) from operations_v2.regulation_occupancies r where r.doctor_id = d.id),
                       (select max(i.started_at) from operations_v2.intervention_occupancies i where i.doctor_id = d.id)
                   ) as last_shift_at
            from operations_v2.doctors d
            where d.is_active
        `),
        db.execute(sql`
            select c.id, c.doctor_id, c.contract_number, c.cycle_start::text as cycle_start,
                   c.cycle_end::text as cycle_end, c.ceiling_amount,
                   not exists (
                       select 1 from operations_v2.contract_ledger l
                       where l.contract_id = c.id and l.type = 'opening'
                   ) as awaiting_opening_balance
            from operations_v2.contracts c
            join operations_v2.doctors d on d.id = c.doctor_id and d.is_active
            where c.status = 'active'
        `),
    ]);

    const doctors = (doctorRows as unknown as {
        id: string; full_name: string; metadata: unknown; admitted_at: string | null; last_shift_at: string | Date | null;
    }[]).map((row) => ({
        id: row.id,
        fullName: row.full_name,
        metadata: row.metadata,
        admittedAt: row.admitted_at,
        lastShiftAt: row.last_shift_at === null ? null : new Date(row.last_shift_at),
    }));

    const contracts = (contractRows as unknown as {
        id: string; doctor_id: string; contract_number: string; cycle_start: string; cycle_end: string;
        ceiling_amount: string | null; awaiting_opening_balance: boolean;
    }[]).map((row) => ({
        contractId: row.id,
        doctorId: row.doctor_id,
        contractNumber: row.contract_number,
        cycleStart: row.cycle_start,
        cycleEnd: row.cycle_end,
        ceilingCents: row.ceiling_amount === null ? null : Math.round(Number(row.ceiling_amount) * 100),
        awaitingOpeningBalance: row.awaiting_opening_balance,
    }));

    return classifyContractPendencies({ doctors, contracts, asOf });
}

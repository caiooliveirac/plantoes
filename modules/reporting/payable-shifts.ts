import type { PaymentAllocationBoard, PaymentAllocationRow } from "@/services/board.service";
import { HALF_SHIFT_DISPLAY_LABEL, HALF_SHIFT_ROLE_LABEL, HALF_SHIFT_TAG_LABEL, isHalfShiftRoleLabel, resolvePaymentUnitFromRole } from "@/modules/operational/half-shift";
import { isNucleoRegulationPost, isPiamRegulationPost } from "@/modules/operational/board-display";
import { isPaymentAffectingEarlyDepartureOutcome, resolveEarlyDeparturePaymentUnit } from "@/modules/operational/early-departure";
import { isPremiumRateDate } from "@/modules/operational/holidays";
import type { ContractStatementMonth } from "@/lib/contracts/statement";
import type { RenewalKind } from "@/lib/contracts/renewal";

const SAO_PAULO_OFFSET_MINUTES = -180;
const MIN_SEGMENT_MINUTES = 45;

// Rótulos exibidos no fechamento para os desfechos de retirada antecipada.
export const EARLY_DEPARTURE_BANK_ONLY_DISPLAY_LABEL = "Retirada antecipada — só banco de horas";
export const EARLY_DEPARTURE_HALF_DISPLAY_LABEL = "Retirada antecipada — meio plantão";
export const EARLY_DEPARTURE_BANK_ONLY_TAG_LABEL = "BANCO";

export type DoctorPaymentProfile = "generalist" | "specialist" | "psychiatry";

/**
 * Vínculo do médico com a prefeitura: "pj" (contratado via empresa, tabela de
 * pagamento por plantão vigente) ou "estatutario" (efetivo/REDA, remunerado
 * fora deste sistema — não gera valor a pagar por plantão aqui).
 */
export type DoctorEmploymentType = "pj" | "estatutario";

const DOCTOR_PAYMENT_RATES: Record<DoctorPaymentProfile, { weekday: number; weekend: number }> = {
    generalist: { weekday: 1244.87, weekend: 1381.10 },
    specialist: { weekday: 1329.66, weekend: 1457.15 },
    psychiatry: { weekday: 1299.82, weekend: 1411.47 },
};

const DOCTOR_PAYMENT_RATE_CENTS: Record<DoctorPaymentProfile, { weekday: number; weekend: number }> = {
    generalist: { weekday: 124487, weekend: 138110 },
    specialist: { weekday: 132966, weekend: 145715 },
    psychiatry: { weekday: 129982, weekend: 141147 },
};

interface DoctorPaymentMetadata {
    preferredOperationalRole?: unknown;
    paymentProfile?: {
        isSpecialist?: unknown;
    };
    isPaymentSpecialist?: unknown;
    employmentType?: unknown;
}

export type AttestationSegmentStatus = "consolidated" | "discarded";
export type AttestationSegmentDiscardReason =
    | "invalid_timeline"
    | "short_fragment"
    | "duplicate_segment"
    | "not_selected_for_payment";

export interface RawPresenceEvent {
    occupancyId: string;
    domain: "regulation" | "intervention";
    doctorId: string;
    doctorName: string;
    displayName: string | null;
    targetCode: string;
    targetLabel: string;
    startedAt: string;
    endedAt: string | null;
    actualEndedAt: string | null;
    scheduledStartAt: string | null;
    scheduledEndAt: string | null;
    shiftLabel: "SD" | "SN" | "P" | null;
    source: "manual" | "telegram" | "import" | "admin_correction";
    continuityGroupId: string | null;
    notes: string | null;
}

export interface AttestationSegment {
    segmentId: string;
    occupancyId: string;
    domain: RawPresenceEvent["domain"];
    doctorId: string;
    doctorName: string;
    displayName: string | null;
    targetCode: string;
    targetLabel: string;
    shiftLabel: RawPresenceEvent["shiftLabel"];
    startedAt: string;
    endedAt: string | null;
    durationMinutes: number | null;
    source: RawPresenceEvent["source"];
    continuityGroupId: string | null;
    status: AttestationSegmentStatus;
    discardReason: AttestationSegmentDiscardReason | null;
    selectedForPayment: boolean;
}

export interface PayableShift {
    payableShiftId: string;
    occupancyId: string;
    domain: "regulation" | "intervention";
    doctorId: string;
    doctorName: string;
    displayName: string | null;
    targetCode: string;
    targetLabel: string;
    tagCode: string;
    operationalDate: string;
    shiftLabel: "SD" | "SN";
    slotStartedAt: string;
    slotEndedAt: string;
    startedAt: string;
    endedAt: string | null;
    /** Saída real verbalizada/registrada (null = fechado por handoff/boundary). */
    actualEndedAt: string | null;
    scheduledStartAt: string | null;
    scheduledEndAt: string | null;
    durationMinutes: number | null;
    paymentStatus: "ready_for_payment" | "needs_review";
    auditStatus: "clean" | "review";
    issues: string[];
    source: string | null;
    roleLabel: string | null;
    paymentUnit: number;
    paymentTag: string | null;
    /** Plantão extra de CHEFIA: pago como qualquer extra, mas sem nenhuma relação
     * com o banco de horas. O board pinta diferente para não confundir com o
     * extra que sai do acerto de ±12h. */
    isChiefExtra?: boolean;
    /** kind normalizado do admin_extra_shift ('extra' | 'half_extra' | 'bonus' |
     * 'penalty' | 'chief' | 'chief_half'). Só presente em extras; a UI deriva
     * daqui o código curto do chip (o `tagCode` continua sendo o label livre,
     * que exportações e folha usam por extenso). */
    extraKind?: string | null;
    /** Desfecho da régua de retirada antecipada aplicado a ESTE slot (ou null). */
    earlyDepartureOutcome: "bank_only" | "half_shift" | null;
}

/**
 * Marca um PayableShift como plantão extra adicionado manualmente pelo admin na
 * tela de fechamento. O board do payment-closing pinta de verde toda tag com este
 * source — distinguindo o que o chefe acrescentou do que o bot registrou.
 */
export const ADMIN_EXTRA_SHIFT_SOURCE = "admin_extra";

/**
 * Plantão extra de chefia (kind 'chief' em admin_extra_shifts). É um extra de
 * pagamento como os outros — e NUNCA um acerto de banco de horas: não nasce de
 * settlement, não desconta saldo, não aparece nas telas de banco de horas.
 */
export const CHIEF_EXTRA_SHIFT_KIND = "chief";

/**
 * Meio plantão de chefia (kind 'chief_half'): mesma natureza do 'chief' — fora
 * do banco de horas, marcado como chefia no board — pagando 0,5 unidade, igual
 * à régua do meio plantão comum.
 */
export const CHIEF_EXTRA_HALF_SHIFT_KIND = "chief_half";

/** Rótulo fixo do chip: quem olha o board sabe na hora que é chefia. */
export const CHIEF_EXTRA_SHIFT_LABEL = "PLANTÃO DE CHEFIA";

/**
 * Código curto do chip de um extra no quadro/lista, por kind. O label livre
 * ("plantão trocado", "EXTRA DECLARADO") continua guardado e aparece no
 * tooltip e na lista plantão-a-plantão — mas o chip usa um código de largura
 * fixa para não esticar a coluna do dia (chips de plantão real têm 3-4 letras).
 */
export function resolveExtraShiftChipCode(kind: string | null | undefined): string {
    const normalized = String(kind ?? "extra").trim().toLowerCase();
    if (normalized === CHIEF_EXTRA_SHIFT_KIND || normalized === CHIEF_EXTRA_HALF_SHIFT_KIND) {
        return "CHEFIA";
    }
    if (normalized === "bonus") {
        return "BÔNUS";
    }
    if (normalized === "penalty") {
        return "PUNIÇÃO";
    }
    return "EXTRA";
}

export interface AdminExtraShiftInput {
    id: string;
    doctorId: string;
    doctorName: string;
    displayName: string | null;
    operationalDate: string;
    shiftLabel: "SD" | "SN";
    label: string | null;
    /** 'extra' | 'half_extra' | 'bonus' | 'penalty' | 'chief' | 'chief_half'.
     * Padrão 'extra' para registros antigos. */
    kind?: string;
    /** +1 (verde) ou -1 (vermelho, punição do banco de horas). Padrão +1. */
    unit?: number;
}

/**
 * Converte um plantão extra (tabela admin_extra_shifts) num PayableShift verde.
 * Não amarra a ramal/base: usa um rótulo livre como tagCode e um slot sintético
 * de 12h só para ordenação. operationalDate define a coluna do dia e a tarifa
 * (dia útil vs fim de semana/feriado), igual aos demais plantões.
 */
export function buildAdminExtraPayableShift(input: AdminExtraShiftInput): PayableShift {
    const tagCode = input.label?.trim() ? input.label.trim() : "EXTRA";
    const normalizedKind = String(input.kind ?? "extra").trim().toLowerCase();
    const isChiefExtra = normalizedKind === CHIEF_EXTRA_SHIFT_KIND
        || normalizedKind === CHIEF_EXTRA_HALF_SHIFT_KIND;
    // Meio plantão (do admin ou de chefia) paga 0,5 unidade e leva a tag MEIO.
    const isHalfExtra = normalizedKind === "half_extra"
        || normalizedKind === CHIEF_EXTRA_HALF_SHIFT_KIND;
    // Slot local: SD = 06:00–18:00, SN = 18:00–06:00 (offset São Paulo -180min).
    const slotStartedAt = input.shiftLabel === "SD"
        ? `${input.operationalDate}T09:00:00.000Z`
        : `${input.operationalDate}T21:00:00.000Z`;
    const slotEndMs = new Date(slotStartedAt).getTime() + (12 * 60 * 60 * 1000);
    const slotEndedAt = new Date(slotEndMs).toISOString();
    const paymentUnit = isHalfExtra
        ? 0.5
        : (typeof input.unit === "number" ? input.unit : 1);

    return {
        payableShiftId: `extra:${input.id}`,
        occupancyId: `extra:${input.id}`,
        domain: "regulation",
        doctorId: input.doctorId,
        doctorName: input.doctorName,
        displayName: input.displayName,
        targetCode: tagCode,
        targetLabel: tagCode,
        tagCode,
        operationalDate: input.operationalDate,
        shiftLabel: input.shiftLabel,
        slotStartedAt,
        slotEndedAt,
        startedAt: slotStartedAt,
        endedAt: slotEndedAt,
        actualEndedAt: null,
        scheduledStartAt: null,
        scheduledEndAt: null,
        durationMinutes: 12 * 60,
        paymentStatus: "ready_for_payment",
        auditStatus: "clean",
        issues: isHalfExtra ? [HALF_SHIFT_DISPLAY_LABEL] : [],
        source: ADMIN_EXTRA_SHIFT_SOURCE,
        roleLabel: isHalfExtra ? HALF_SHIFT_ROLE_LABEL : null,
        // unit -1 (penalty) faz o plantão subtrair do total a pagar — o board pinta
        // de vermelho quando paymentUnit < 0; verdes (extra/bonus) ficam +1.
        paymentUnit,
        paymentTag: isHalfExtra ? HALF_SHIFT_TAG_LABEL : null,
        isChiefExtra,
        extraKind: normalizedKind,
        earlyDepartureOutcome: null,
    } satisfies PayableShift;
}

export interface DisabledTargetSnapshot {
    snapshotId: string;
    domain: "regulation" | "intervention";
    targetCode: string;
    targetLabel: string;
    operationalDate: string;
    day: string;
    shiftLabel: "SD" | "SN";
    disabledReason: string | null;
    disabledEntireShift: boolean;
    disabledDuringShift: boolean;
}

export interface UncoveredTargetSnapshot {
    snapshotId: string;
    domain: "regulation" | "intervention";
    targetCode: string;
    targetLabel: string;
    operationalDate: string;
    day: string;
    shiftLabel: "SD" | "SN";
    reason: string | null;
}

export interface PayableTargetOption {
    domain: "regulation" | "intervention";
    targetCode: string;
    targetLabel: string;
}

export interface ChiefPayableCell {
    day: string;
    shifts: PayableShift[];
}

export interface ChiefPayableDoctorRow {
    doctorId: string;
    doctorName: string;
    displayName: string | null;
    paymentStatus: "ready_for_payment" | "needs_review";
    totalSD: number;
    totalSN: number;
    total: number;
    totalSDDue?: number;
    totalSNDue?: number;
    totalDue?: number;
    weekdayShiftCount?: number;
    weekendShiftCount?: number;
    paymentProfile?: DoctorPaymentProfile;
    /** "pj" (tabela de plantão vigente) ou "estatutario" (pago fora deste sistema; totalDue = 0). */
    employmentType: DoctorEmploymentType;
    pendingCount: number;
    /** ISO de quando o admin conferiu/assinou este médico no mês; null = não atestado. */
    attestedAt: string | null;
    /** Nº da nota fiscal informado pelo admin neste mês. */
    invoiceNumber?: string | null;
    /** Nº do processo de pagamento informado pelo admin neste mês. */
    paymentProcessNumber?: string | null;
    /** Teto do contrato em R$ (semente); null quando ainda não cadastrado. */
    contractCeilingBrl?: number | null;
    /** Saldo em R$ no início do seedMonth; null = parte do teto. */
    contractOpeningBalanceBrl?: number | null;
    /** Mês inicial do contrato (YYYY-MM) a partir do qual o teto é consumido. */
    contractSeedMonth?: string | null;
    /** Saldo contratual calculado até este mês (teto - pagamentos acumulados). */
    contractBalanceBrl?: number | null;
    /** Saldo efetivo do banco de horas (bruto + acertos), em minutos. */
    bankHoursMinutes?: number | null;
    /** Parcela do saldo anterior a mai/2025 (planilha) — fora da régua de acerto. */
    bankHoursOldMinutes?: number | null;
    /** Parcela do saldo desde mai/2025 (planilha 25→26 + aplicação + acertos). */
    bankHoursRecentMinutes?: number | null;
    /** Acerto de banco de horas lançado neste mês (bônus/punição), se houver. */
    bankHoursSettlement?: ChiefPayableBankHoursSettlement | null;
    /** Contratos ativos do médico com saldo e métricas. Mais de um = seletor. */
    contractBalances?: ContractBalanceSummary[];
    /** Renovação pendente do contrato mais recente (lib/contracts/renewal.ts). */
    contractPendingRenewal?: ChiefPayableContractRenewal | null;
    /** Plantões cumpridos em USA (intervenção/ambulância) no mês — só linhas com unidade positiva. */
    usaShiftCount: number;
    /** Plantões cumpridos em CRU (regulação/ramais) no mês — só linhas com unidade positiva. */
    cruShiftCount: number;
    cells: ChiefPayableCell[];
}

/** Pendência de renovação já resolvida no servidor — a tela só exibe/filtra. */
export interface ChiefPayableContractRenewal {
    kind: RenewalKind;
    /** Dias corridos desde o vencimento. 0 em `sem_saldo_de_abertura`. */
    daysOverdue: number;
    cycleEnd: string;
}

export interface ChiefPayableBankHoursSettlement {
    /** payroll = abatimento em folha do estatutário (sem plantão verde/vermelho). */
    kind: "bonus" | "penalty" | "payroll";
    deltaMinutes: number;
    operationalDate: string | null;
    notes: string;
    createdAt: string;
}

/** Dados financeiros por médico injetados no board pelo serviço (fora do cálculo de plantões). */
/**
 * Saldo contratual do médico para o bloco do fechamento (Fase 4).
 *
 * `metricsInput` viaja serializado de propósito: o cliente reconstrói as datas e
 * chama o MESMO módulo puro do servidor (lib/contracts/balance-metrics.ts) a
 * cada plantão marcado. Sem round-trip por tecla, e sem uma segunda
 * implementação da conta no front — que é como os dois números divergem.
 */
export interface ContractBalanceSummary {
    contractId: string;
    contractNumber: string;
    cycleStart: string;
    cycleEnd: string;
    ceilingCents: number | null;
    balanceCents: number;
    consumedCents: number;
    consumedPct: number | null;
    elapsedPct: number;
    /** Consumo / esperado até hoje. `null` sem teto. > 1 = acima do ritmo. */
    paceIndex: number | null;
    riskLevel: "safe" | "watch" | "warning" | "critical" | "depleted";
    hasReliableBurnRate: boolean;
    projectedDepletionDate: string | null;
    healthyMonthlyBudgetCents: number;
    monthlyWeekdayShifts: number;
    remainingWeekdayShifts: number;
    /** Razão vazio: o coordenador ainda precisa informar o saldo de abertura. */
    awaitingOpeningBalance: boolean;
    /** Saldo já conferido e assinado — o que está no razão. */
    settledBalanceCents: number;
    /** Plantões já dados, ainda sem fechamento assinado, fora do mês em edição. */
    pendingConsumptionCents: number;
    /**
     * Extrato mês a mês (datas em AAAA-MM-DD): saldo no início do mês, gasto do
     * mês, saldo no fim (dia 1º seguinte, fim do ciclo, ou hoje). Já vem pronto
     * do servidor — o cliente só formata.
     */
    statement: ContractStatementMonth[];
    metricsInput: {
        ceilingCents: number | null;
        balanceCents: number;
        observedConsumptionCents: number;
        observedSince: string;
        cycleStart: string;
        cycleEnd: string;
        asOf: string;
        weekdayRateCents: number;
        weekendRateCents: number;
        weekdayShifts: number;
        weekendShifts: number;
    };
}

export interface DoctorFinancialExtras {
    invoiceNumber?: string | null;
    paymentProcessNumber?: string | null;
    contractCeilingBrl?: number | null;
    contractOpeningBalanceBrl?: number | null;
    contractSeedMonth?: string | null;
    contractBalanceBrl?: number | null;
    bankHoursMinutes?: number | null;
    bankHoursOldMinutes?: number | null;
    bankHoursRecentMinutes?: number | null;
    bankHoursSettlement?: ChiefPayableBankHoursSettlement | null;
    /** Contratos ativos do médico. Mais de um = seletor no bloco de saldo. */
    contractBalances?: ContractBalanceSummary[];
    contractPendingRenewal?: ChiefPayableContractRenewal | null;
}

export interface ChiefPayableBoardModel {
    allDoctorNames: string[];
    monthKey: string;
    monthLabel: string;
    presetMonths: Array<{ key: string; label: string }>;
    range: {
        startIso: string;
        endIso: string;
    };
    days: string[];
    summary: {
        doctorCount: number;
        payableShiftCount: number;
        payableUnitCount: number;
        totalDueAmount?: number;
        readyCount: number;
        needsReviewCount: number;
        segmentCount: number;
        discardedSegmentCount: number;
        disabledTargetCount: number;
        uncoveredTargetCount: number;
        /** Somas separadas por vínculo — a prefeitura só desembolsa pela linha "pj"; "estatutario" fica a 0. */
        byEmploymentType: Record<DoctorEmploymentType, {
            doctorCount: number;
            payableShiftCount: number;
            payableUnitCount: number;
            totalDueAmount: number;
        }>;
    };
    targetOptions: PayableTargetOption[];
    doctors: ChiefPayableDoctorRow[];
    payableShifts: PayableShift[];
    disabledTargets: DisabledTargetSnapshot[];
    uncoveredTargets: UncoveredTargetSnapshot[];
    attestationSegments: AttestationSegment[];
}

function toSaoPauloClock(dateIso: string) {
    return new Date(new Date(dateIso).getTime() + (SAO_PAULO_OFFSET_MINUTES * 60000));
}

function toOperationalDate(dateIso: string) {
    const local = toSaoPauloClock(dateIso);
    const year = local.getUTCFullYear();
    const month = String(local.getUTCMonth() + 1).padStart(2, "0");
    const day = String(local.getUTCDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
}

function isWeekendOperationalDate(operationalDate: string) {
    return isPremiumRateDate(operationalDate);
}

function asDoctorPaymentMetadata(value: unknown): DoctorPaymentMetadata {
    if (!value || typeof value !== "object") {
        return {};
    }

    return value as DoctorPaymentMetadata;
}

export function resolveDoctorPaymentProfile(metadata: unknown): DoctorPaymentProfile {
    const typed = asDoctorPaymentMetadata(metadata);
    const preferredRole = String(typed.preferredOperationalRole ?? "").trim().toUpperCase();
    if (preferredRole === "PSIQ") {
        return "psychiatry";
    }

    if (preferredRole === "PIAM") {
        return "specialist";
    }

    const specialistFlag = typed.paymentProfile?.isSpecialist;
    if (specialistFlag === true) {
        return "specialist";
    }

    if (typed.isPaymentSpecialist === true) {
        return "specialist";
    }

    return "generalist";
}

/**
 * Vínculo estatutário/REDA é remunerado fora deste sistema (folha da
 * prefeitura) — por isso o padrão aqui é "pj": todo médico sem classificação
 * explícita segue sendo pago normalmente pela tabela de plantão, como sempre
 * foi antes desta distinção existir.
 */
export function resolveDoctorEmploymentType(metadata: unknown): DoctorEmploymentType {
    const typed = asDoctorPaymentMetadata(metadata);
    const raw = String(typed.employmentType ?? "").trim().toLowerCase();
    if (raw === "estatutario" || raw === "estatutário" || raw === "reda") {
        return "estatutario";
    }

    return "pj";
}

export function resolveShiftDueAmount(params: {
    profile: DoctorPaymentProfile;
    operationalDate: string;
    paymentUnit: number;
    employmentType?: DoctorEmploymentType;
}) {
    return resolveShiftDueAmountCents(params) / 100;
}

export function resolveShiftDueAmountCents(params: {
    profile: DoctorPaymentProfile;
    operationalDate: string;
    paymentUnit: number;
    employmentType?: DoctorEmploymentType;
}) {
    if (params.employmentType === "estatutario") {
        return 0;
    }

    const rates = DOCTOR_PAYMENT_RATE_CENTS[params.profile];
    const rateCents = isWeekendOperationalDate(params.operationalDate) ? rates.weekend : rates.weekday;
    const unitMilli = Math.round(params.paymentUnit * 1000);
    return Math.round((rateCents * unitMilli) / 1000);
}

function resolveDueAmountCentsByDayKind(params: {
    profile: DoctorPaymentProfile;
    isWeekend: boolean;
    paymentUnit: number;
    employmentType?: DoctorEmploymentType;
}) {
    if (params.employmentType === "estatutario") {
        return 0;
    }

    const rates = DOCTOR_PAYMENT_RATE_CENTS[params.profile];
    const rateCents = params.isWeekend ? rates.weekend : rates.weekday;
    const unitMilli = Math.round(params.paymentUnit * 1000);
    return Math.round((rateCents * unitMilli) / 1000);
}

function resolveDurationMinutes(startedAt: string, endedAt: string | null) {
    if (!endedAt) {
        return null;
    }

    const durationMs = new Date(endedAt).getTime() - new Date(startedAt).getTime();
    if (!Number.isFinite(durationMs) || durationMs <= 0) {
        return null;
    }

    return Math.round(durationMs / 60000);
}

function buildSegmentDuplicateKey(event: RawPresenceEvent) {
    const operationalDate = toOperationalDate(event.startedAt);
    return [event.doctorId, event.domain, event.targetCode, event.shiftLabel ?? "UNK", operationalDate, event.startedAt].join("|");
}

function rankSegmentCandidate(event: RawPresenceEvent) {
    let score = 0;
    const durationMinutes = resolveDurationMinutes(event.startedAt, event.actualEndedAt ?? event.endedAt);

    if (durationMinutes !== null) {
        score += Math.min(durationMinutes, 12 * 60);
    }

    if (event.actualEndedAt) {
        score += 40;
    }

    if (event.scheduledStartAt && event.scheduledEndAt) {
        score += 20;
    }

    if (event.source === "telegram") {
        score += 6;
    }

    if (event.source === "manual" || event.source === "admin_correction") {
        score -= 10;
    }

    return score;
}

export function buildAttestationSegments(params: {
    rawEvents: RawPresenceEvent[];
    selectedOccupancyIds: Set<string>;
}) {
    const grouped = new Map<string, RawPresenceEvent[]>();
    for (const event of params.rawEvents) {
        const key = buildSegmentDuplicateKey(event);
        const bucket = grouped.get(key) ?? [];
        bucket.push(event);
        grouped.set(key, bucket);
    }

    const duplicateLosers = new Set<string>();
    for (const bucket of grouped.values()) {
        if (bucket.length < 2) {
            continue;
        }

        const ranked = [...bucket].sort((left, right) => rankSegmentCandidate(right) - rankSegmentCandidate(left));
        for (const loser of ranked.slice(1)) {
            duplicateLosers.add(loser.occupancyId);
        }
    }

    return params.rawEvents.map((event) => {
        const endedAt = event.actualEndedAt ?? event.endedAt;
        const durationMinutes = resolveDurationMinutes(event.startedAt, endedAt);
        const selectedForPayment = params.selectedOccupancyIds.has(event.occupancyId);
        const duplicateDiscard = duplicateLosers.has(event.occupancyId);

        const status: AttestationSegmentStatus = (() => {
            if (duplicateDiscard) {
                return "discarded";
            }

            if (durationMinutes === null) {
                return "discarded";
            }

            if (durationMinutes < MIN_SEGMENT_MINUTES) {
                return "discarded";
            }

            if (!selectedForPayment) {
                return "discarded";
            }

            return "consolidated";
        })();

        const discardReason: AttestationSegmentDiscardReason | null = (() => {
            if (status === "consolidated") {
                return null;
            }

            if (duplicateDiscard) {
                return "duplicate_segment";
            }

            if (durationMinutes === null) {
                return "invalid_timeline";
            }

            if (durationMinutes < MIN_SEGMENT_MINUTES) {
                return "short_fragment";
            }

            return "not_selected_for_payment";
        })();

        return {
            segmentId: `seg:${event.occupancyId}`,
            occupancyId: event.occupancyId,
            domain: event.domain,
            doctorId: event.doctorId,
            doctorName: event.doctorName,
            displayName: event.displayName,
            targetCode: event.targetCode,
            targetLabel: event.targetLabel,
            shiftLabel: event.shiftLabel,
            startedAt: event.startedAt,
            endedAt,
            durationMinutes,
            source: event.source,
            continuityGroupId: event.continuityGroupId,
            status,
            discardReason,
            selectedForPayment,
        } satisfies AttestationSegment;
    });
}

function mapAllocationRowToPayableShift(board: PaymentAllocationBoard, row: PaymentAllocationRow): PayableShift | null {
    if (!row.occupancyId || !row.doctorId || !row.doctorName) {
        return null;
    }

    const durationMinutes = resolveDurationMinutes(row.startedAt ?? board.startedAt, row.endedAt);
    const operationalDate = toOperationalDate(board.startedAt);

    const isHalfShift = isHalfShiftRoleLabel(row.roleLabel);

    // Desfecho de retirada/saída antecipada (early-departure.ts): vale só no
    // slot em que a saída de fato caiu — um "P" retirado no segundo turno
    // mantém o primeiro turno pagável por inteiro. Saída exatamente no fim do
    // slot não é antecipada: o desfecho ali é resíduo (ex.: SN removido no
    // fechamento recortou a ocupação até as 19:00) e não pode zerar o slot.
    const rowEndedAtMs = row.endedAt ? new Date(row.endedAt).getTime() : null;
    const earlyOutcome = isPaymentAffectingEarlyDepartureOutcome(row.earlyDepartureOutcome)
        && rowEndedAtMs !== null
        && rowEndedAtMs > new Date(board.startedAt).getTime()
        && rowEndedAtMs < new Date(board.endedAt).getTime()
        ? row.earlyDepartureOutcome
        : null;
    const earlyOutcomeLabel = earlyOutcome === "bank_only"
        ? EARLY_DEPARTURE_BANK_ONLY_DISPLAY_LABEL
        : earlyOutcome === "half_shift"
            ? EARLY_DEPARTURE_HALF_DISPLAY_LABEL
            : null;

    return {
        payableShiftId: [row.doctorId, board.startedAt, board.shiftLabel, row.domain, row.targetCode].join("|"),
        occupancyId: row.occupancyId,
        domain: row.domain,
        doctorId: row.doctorId,
        doctorName: row.doctorName,
        displayName: row.displayName,
        targetCode: row.targetCode,
        targetLabel: row.targetLabel,
        tagCode: row.domain === "regulation" ? "CRU" : row.targetCode,
        operationalDate,
        shiftLabel: board.shiftLabel,
        slotStartedAt: board.startedAt,
        slotEndedAt: board.endedAt,
        startedAt: row.startedAt ?? board.startedAt,
        endedAt: row.endedAt,
        actualEndedAt: row.actualEndedAt,
        scheduledStartAt: row.scheduledStartAt,
        scheduledEndAt: row.scheduledEndAt,
        durationMinutes,
        paymentStatus: row.paymentStatus,
        auditStatus: row.paymentStatus === "ready_for_payment" ? "clean" : "review",
        issues: [
            ...row.issues,
            ...(isHalfShift ? [HALF_SHIFT_DISPLAY_LABEL] : []),
            ...(earlyOutcomeLabel ? [earlyOutcomeLabel] : []),
        ],
        source: row.source,
        roleLabel: row.roleLabel,
        paymentUnit: resolveEarlyDeparturePaymentUnit(earlyOutcome) ?? resolvePaymentUnitFromRole(row.roleLabel),
        paymentTag: earlyOutcome === "half_shift"
            ? HALF_SHIFT_TAG_LABEL
            : earlyOutcome === "bank_only"
                ? EARLY_DEPARTURE_BANK_ONLY_TAG_LABEL
                : isHalfShift
                    ? HALF_SHIFT_TAG_LABEL
                    : null,
        earlyDepartureOutcome: earlyOutcome,
    } satisfies PayableShift;
}

export function buildPayableShiftsFromBoards(boards: PaymentAllocationBoard[]) {
    const payable = boards
        .flatMap((board) => [...board.regulation, ...board.intervention]
            .map((row) => mapAllocationRowToPayableShift(board, row))
            .filter((row): row is PayableShift => Boolean(row))
        )
        .sort((left, right) => {
            const byDate = new Date(left.slotStartedAt).getTime() - new Date(right.slotStartedAt).getTime();
            if (byDate !== 0) {
                return byDate;
            }

            return left.doctorName.localeCompare(right.doctorName, "pt-BR");
        });

    const deduped = new Map<string, PayableShift>();
    for (const shift of payable) {
        deduped.set(shift.payableShiftId, shift);
    }

    return Array.from(deduped.values());
}

export function buildDisabledTargetsFromBoards(params: {
    boards: PaymentAllocationBoard[];
    maxSlotStartedAtIso?: string | null;
}) {
    const snapshots: DisabledTargetSnapshot[] = [];
    const maxSlotStartedAtMs = params.maxSlotStartedAtIso
        ? new Date(params.maxSlotStartedAtIso).getTime()
        : null;

    for (const board of params.boards) {
        if (maxSlotStartedAtMs !== null && new Date(board.startedAt).getTime() > maxSlotStartedAtMs) {
            continue;
        }

        const operationalDate = toOperationalDate(board.startedAt);
        const day = operationalDate.slice(8, 10);
        const rows = [...board.regulation, ...board.intervention];
        for (const row of rows) {
            const disabledEntireShift = Boolean(row.disabledEntireShift ?? false);
            const disabledDuringShift = Boolean(row.disabledDuringShift ?? false);
            if (!disabledEntireShift && !disabledDuringShift) {
                continue;
            }

            // Se há ocupação atribuída no slot, o alvo está efetivamente coberto:
            // o intervalo de desativação registrado é uma residue (ex.: zero-duração
            // do bot ou vazamento do slot vizinho) e não deve aparecer como desativada.
            if (row.occupancyId) {
                continue;
            }

            snapshots.push({
                snapshotId: [operationalDate, board.shiftLabel, row.domain, row.targetCode].join("|"),
                domain: row.domain,
                targetCode: row.targetCode,
                targetLabel: row.targetLabel,
                operationalDate,
                day,
                shiftLabel: board.shiftLabel,
                disabledReason: row.disabledReason ?? null,
                disabledEntireShift,
                disabledDuringShift,
            });
        }
    }

    const unique = new Map<string, DisabledTargetSnapshot>();
    for (const snapshot of snapshots) {
        unique.set(snapshot.snapshotId, snapshot);
    }

    return Array.from(unique.values()).sort((left, right) => {
        const byDate = left.operationalDate.localeCompare(right.operationalDate);
        if (byDate !== 0) {
            return byDate;
        }

        if (left.shiftLabel !== right.shiftLabel) {
            return left.shiftLabel === "SD" ? -1 : 1;
        }

        if (left.domain !== right.domain) {
            return left.domain === "regulation" ? -1 : 1;
        }

        return left.targetCode.localeCompare(right.targetCode, "pt-BR");
    });
}

export function buildUncoveredTargetsFromBoards(params: {
    boards: PaymentAllocationBoard[];
    maxSlotStartedAtIso?: string | null;
}) {
    const snapshots: UncoveredTargetSnapshot[] = [];
    const maxSlotStartedAtMs = params.maxSlotStartedAtIso
        ? new Date(params.maxSlotStartedAtIso).getTime()
        : null;

    for (const board of params.boards) {
        if (maxSlotStartedAtMs !== null && new Date(board.startedAt).getTime() > maxSlotStartedAtMs) {
            continue;
        }

        const operationalDate = toOperationalDate(board.startedAt);
        const day = operationalDate.slice(8, 10);
        const rows = [...board.regulation, ...board.intervention];
        for (const row of rows) {
            const isSpecialRegulationCoverage = row.domain === "regulation"
                && (isPiamRegulationPost(row.targetCode) || (board.shiftLabel === "SD" && isNucleoRegulationPost(row.targetCode)));

            if (row.domain !== "intervention" && !isSpecialRegulationCoverage) {
                continue;
            }

            const isUncovered = !row.occupancyId && !Boolean(row.disabledDuringShift ?? false) && !Boolean(row.disabledEntireShift ?? false);
            if (!isUncovered) {
                continue;
            }

            snapshots.push({
                snapshotId: [operationalDate, board.shiftLabel, row.domain, row.targetCode].join("|"),
                domain: row.domain,
                targetCode: row.targetCode,
                targetLabel: row.targetLabel,
                operationalDate,
                day,
                shiftLabel: board.shiftLabel,
                reason: row.issues[0] ?? null,
            });
        }
    }

    const unique = new Map<string, UncoveredTargetSnapshot>();
    for (const snapshot of snapshots) {
        unique.set(snapshot.snapshotId, snapshot);
    }

    return Array.from(unique.values()).sort((left, right) => {
        const byDate = left.operationalDate.localeCompare(right.operationalDate);
        if (byDate !== 0) {
            return byDate;
        }

        if (left.shiftLabel !== right.shiftLabel) {
            return left.shiftLabel === "SD" ? -1 : 1;
        }

        if (left.domain !== right.domain) {
            return left.domain === "regulation" ? -1 : 1;
        }

        return left.targetCode.localeCompare(right.targetCode, "pt-BR");
    });
}

export function buildPayableTargetOptions(params: {
    payableShifts: PayableShift[];
    disabledTargets: DisabledTargetSnapshot[];
    uncoveredTargets: UncoveredTargetSnapshot[];
}) {
    const options = new Map<string, PayableTargetOption>();

    for (const shift of params.payableShifts) {
        const key = `${shift.domain}|${shift.targetCode}`;
        if (!options.has(key)) {
            options.set(key, {
                domain: shift.domain,
                targetCode: shift.targetCode,
                targetLabel: shift.targetLabel,
            });
        }
    }

    for (const snapshot of params.disabledTargets) {
        const key = `${snapshot.domain}|${snapshot.targetCode}`;
        if (!options.has(key)) {
            options.set(key, {
                domain: snapshot.domain,
                targetCode: snapshot.targetCode,
                targetLabel: snapshot.targetLabel,
            });
        }
    }

    for (const snapshot of params.uncoveredTargets) {
        const key = `${snapshot.domain}|${snapshot.targetCode}`;
        if (!options.has(key)) {
            options.set(key, {
                domain: snapshot.domain,
                targetCode: snapshot.targetCode,
                targetLabel: snapshot.targetLabel,
            });
        }
    }

    return Array.from(options.values()).sort((left, right) => {
        if (left.domain !== right.domain) {
            return left.domain === "regulation" ? -1 : 1;
        }
        return left.targetCode.localeCompare(right.targetCode, "pt-BR");
    });
}

export function buildChiefPayableBoard(params: {
    monthKey: string;
    monthLabel: string;
    presetMonths: Array<{ key: string; label: string }>;
    rangeStartIso: string;
    rangeEndIso: string;
    payableShifts: PayableShift[];
    disabledTargets: DisabledTargetSnapshot[];
    uncoveredTargets: UncoveredTargetSnapshot[];
    targetOptions: PayableTargetOption[];
    attestationSegments: AttestationSegment[];
    allDoctorNames: string[];
    /**
     * Quadro de médicos ativos. Quem não deu plantão no mês entra como linha
     * vazia — o fechamento é a porta de entrada do modal (contrato, banco de
     * horas, NF) e trocar de mês só para achar o médico era o atrito.
     */
    rosterDoctors?: Array<{ doctorId: string; doctorName: string; displayName?: string | null }>;
    doctorPaymentProfiles?: Record<string, DoctorPaymentProfile>;
    doctorEmploymentTypes?: Record<string, DoctorEmploymentType>;
    doctorAttestations?: Record<string, string>;
    doctorFinancials?: Record<string, DoctorFinancialExtras>;
}) {
    const dayCount = new Date(params.rangeEndIso).getTime() > new Date(params.rangeStartIso).getTime()
        ? Math.round((new Date(params.rangeEndIso).getTime() - new Date(params.rangeStartIso).getTime()) / 86400000)
        : 0;
    const days = Array.from({ length: dayCount }, (_, index) => {
        const day = new Date(new Date(params.rangeStartIso).getTime() + (index * 86400000));
        const local = toSaoPauloClock(day.toISOString());
        return String(local.getUTCDate()).padStart(2, "0");
    });

    const grouped = new Map<string, PayableShift[]>();
    for (const shift of params.payableShifts) {
        const key = shift.doctorId;
        const bucket = grouped.get(key) ?? [];
        bucket.push(shift);
        grouped.set(key, bucket);
    }

    const doctors = Array.from(grouped.entries()).map(([doctorId, shifts]) => {
        const dayMap = new Map<string, PayableShift[]>();
        for (const shift of shifts) {
            const day = shift.operationalDate.slice(8, 10);
            const bucket = dayMap.get(day) ?? [];
            bucket.push(shift);
            dayMap.set(day, bucket);
        }

        const orderedShifts = [...shifts].sort((left, right) => {
            const bySlot = new Date(left.slotStartedAt).getTime() - new Date(right.slotStartedAt).getTime();
            if (bySlot !== 0) {
                return bySlot;
            }
            if (left.shiftLabel !== right.shiftLabel) {
                return left.shiftLabel === "SD" ? -1 : 1;
            }
            return left.targetCode.localeCompare(right.targetCode, "pt-BR");
        });

        const totalSDUnits = orderedShifts
            .filter((shift) => shift.shiftLabel === "SD")
            .reduce((sum, shift) => sum + shift.paymentUnit, 0);
        const totalSNUnits = orderedShifts
            .filter((shift) => shift.shiftLabel === "SN")
            .reduce((sum, shift) => sum + shift.paymentUnit, 0);
        const totalUnits = orderedShifts.reduce((sum, shift) => sum + shift.paymentUnit, 0);
        const paymentProfile = params.doctorPaymentProfiles?.[doctorId] ?? "generalist";
        const employmentType = params.doctorEmploymentTypes?.[doctorId] ?? "pj";
        const totalSDDueCents = orderedShifts
            .filter((shift) => shift.shiftLabel === "SD")
            .reduce((sum, shift) => sum + resolveShiftDueAmountCents({
                profile: paymentProfile,
                operationalDate: shift.operationalDate,
                paymentUnit: shift.paymentUnit,
                employmentType,
            }), 0);
        const totalSNDueCents = orderedShifts
            .filter((shift) => shift.shiftLabel === "SN")
            .reduce((sum, shift) => sum + resolveShiftDueAmountCents({
                profile: paymentProfile,
                operationalDate: shift.operationalDate,
                paymentUnit: shift.paymentUnit,
                employmentType,
            }), 0);
        const totalDueCents = orderedShifts
            .reduce((sum, shift) => sum + resolveShiftDueAmountCents({
                profile: paymentProfile,
                operationalDate: shift.operationalDate,
                paymentUnit: shift.paymentUnit,
                employmentType,
            }), 0);
        const weekdayUnits = orderedShifts
            .filter((shift) => !isWeekendOperationalDate(shift.operationalDate))
            .reduce((sum, shift) => sum + shift.paymentUnit, 0);
        const weekendUnits = orderedShifts
            .filter((shift) => isWeekendOperationalDate(shift.operationalDate))
            .reduce((sum, shift) => sum + shift.paymentUnit, 0);
        const totalDueFromUnitsCents = resolveDueAmountCentsByDayKind({
            profile: paymentProfile,
            isWeekend: false,
            paymentUnit: weekdayUnits,
            employmentType,
        }) + resolveDueAmountCentsByDayKind({
            profile: paymentProfile,
            isWeekend: true,
            paymentUnit: weekendUnits,
            employmentType,
        });
        // Unidades de plantão (meio plantão = 0,5), não contagem de linhas.
        const weekdayShiftCount = Number(orderedShifts
            .filter((shift) => !isWeekendOperationalDate(shift.operationalDate))
            .reduce((sum, shift) => sum + shift.paymentUnit, 0)
            .toFixed(2));
        const weekendShiftCount = Number(orderedShifts
            .filter((shift) => isWeekendOperationalDate(shift.operationalDate))
            .reduce((sum, shift) => sum + shift.paymentUnit, 0)
            .toFixed(2));
        const pendingCount = orderedShifts.filter((shift) => shift.paymentStatus === "needs_review").length;
        const paymentStatus = pendingCount > 0 ? "needs_review" : "ready_for_payment";
        // USA = intervenção (bases/ambulância); CRU = regulação (ramais). Conta plantões
        // efetivamente cumpridos (unidade > 0), ignorando punições de banco de horas.
        const usaShiftCount = orderedShifts.filter((shift) => shift.domain === "intervention" && shift.paymentUnit > 0).length;
        const cruShiftCount = orderedShifts.filter((shift) => shift.domain === "regulation" && shift.paymentUnit > 0).length;

        return {
            doctorId,
            doctorName: orderedShifts[0]?.doctorName ?? "Desconhecido",
            displayName: orderedShifts[0]?.displayName ?? null,
            paymentStatus,
            totalSD: Number(totalSDUnits.toFixed(2)),
            totalSN: Number(totalSNUnits.toFixed(2)),
            total: Number(totalUnits.toFixed(2)),
            totalSDDue: totalSDDueCents / 100,
            totalSNDue: totalSNDueCents / 100,
            totalDue: totalDueFromUnitsCents / 100,
            weekdayShiftCount,
            weekendShiftCount,
            paymentProfile,
            employmentType,
            pendingCount,
            attestedAt: params.doctorAttestations?.[doctorId] ?? null,
            invoiceNumber: params.doctorFinancials?.[doctorId]?.invoiceNumber ?? null,
            paymentProcessNumber: params.doctorFinancials?.[doctorId]?.paymentProcessNumber ?? null,
            contractCeilingBrl: params.doctorFinancials?.[doctorId]?.contractCeilingBrl ?? null,
            contractOpeningBalanceBrl: params.doctorFinancials?.[doctorId]?.contractOpeningBalanceBrl ?? null,
            contractSeedMonth: params.doctorFinancials?.[doctorId]?.contractSeedMonth ?? null,
            contractBalanceBrl: params.doctorFinancials?.[doctorId]?.contractBalanceBrl ?? null,
            contractBalances: params.doctorFinancials?.[doctorId]?.contractBalances ?? [],
            contractPendingRenewal: params.doctorFinancials?.[doctorId]?.contractPendingRenewal ?? null,
            bankHoursMinutes: params.doctorFinancials?.[doctorId]?.bankHoursMinutes ?? null,
            bankHoursOldMinutes: params.doctorFinancials?.[doctorId]?.bankHoursOldMinutes ?? null,
            bankHoursRecentMinutes: params.doctorFinancials?.[doctorId]?.bankHoursRecentMinutes ?? null,
            bankHoursSettlement: params.doctorFinancials?.[doctorId]?.bankHoursSettlement ?? null,
            usaShiftCount,
            cruShiftCount,
            cells: days.map((day) => ({
                day,
                shifts: [...(dayMap.get(day) ?? [])].sort((left, right) => {
                    if (left.shiftLabel !== right.shiftLabel) {
                        return left.shiftLabel === "SD" ? -1 : 1;
                    }
                    return left.targetCode.localeCompare(right.targetCode, "pt-BR");
                }),
            })),
        } satisfies ChiefPayableDoctorRow;
    }).sort((left, right) => left.doctorName.localeCompare(right.doctorName, "pt-BR"));

    // Linhas vazias do quadro: entram DEPOIS de todo o resumo, para não contarem
    // como médico do mês nem mexerem em unidade, valor ou pendência.
    const rosterOnlyDoctors: ChiefPayableDoctorRow[] = (params.rosterDoctors ?? [])
        .filter((doctor) => !grouped.has(doctor.doctorId))
        .map((doctor) => {
            const financials = params.doctorFinancials?.[doctor.doctorId];
            return {
                doctorId: doctor.doctorId,
                doctorName: doctor.doctorName,
                displayName: doctor.displayName ?? null,
                paymentStatus: "ready_for_payment",
                totalSD: 0,
                totalSN: 0,
                total: 0,
                totalSDDue: 0,
                totalSNDue: 0,
                totalDue: 0,
                weekdayShiftCount: 0,
                weekendShiftCount: 0,
                paymentProfile: params.doctorPaymentProfiles?.[doctor.doctorId] ?? "generalist",
                employmentType: params.doctorEmploymentTypes?.[doctor.doctorId] ?? "pj",
                pendingCount: 0,
                attestedAt: params.doctorAttestations?.[doctor.doctorId] ?? null,
                invoiceNumber: financials?.invoiceNumber ?? null,
                paymentProcessNumber: financials?.paymentProcessNumber ?? null,
                contractCeilingBrl: financials?.contractCeilingBrl ?? null,
                contractOpeningBalanceBrl: financials?.contractOpeningBalanceBrl ?? null,
                contractSeedMonth: financials?.contractSeedMonth ?? null,
                contractBalanceBrl: financials?.contractBalanceBrl ?? null,
                contractBalances: financials?.contractBalances ?? [],
                contractPendingRenewal: financials?.contractPendingRenewal ?? null,
                bankHoursMinutes: financials?.bankHoursMinutes ?? null,
                bankHoursOldMinutes: financials?.bankHoursOldMinutes ?? null,
                bankHoursRecentMinutes: financials?.bankHoursRecentMinutes ?? null,
                bankHoursSettlement: financials?.bankHoursSettlement ?? null,
                usaShiftCount: 0,
                cruShiftCount: 0,
                cells: days.map((day) => ({ day, shifts: [] })),
            } satisfies ChiefPayableDoctorRow;
        })
        .sort((left, right) => left.doctorName.localeCompare(right.doctorName, "pt-BR"));

    const byEmploymentType: Record<DoctorEmploymentType, {
        doctorCount: number;
        payableShiftCount: number;
        payableUnitCount: number;
        totalDueAmount: number;
    }> = {
        pj: { doctorCount: 0, payableShiftCount: 0, payableUnitCount: 0, totalDueAmount: 0 },
        estatutario: { doctorCount: 0, payableShiftCount: 0, payableUnitCount: 0, totalDueAmount: 0 },
    };
    for (const doctor of doctors) {
        const bucket = byEmploymentType[doctor.employmentType];
        bucket.doctorCount += 1;
        bucket.payableShiftCount += doctor.cells.reduce((sum, cell) => sum + cell.shifts.length, 0);
        bucket.payableUnitCount = Number((bucket.payableUnitCount + doctor.total).toFixed(2));
        bucket.totalDueAmount = Number((bucket.totalDueAmount + Math.round((doctor.totalDue ?? 0) * 100) / 100).toFixed(2));
    }

    return {
        monthKey: params.monthKey,
        monthLabel: params.monthLabel,
        presetMonths: params.presetMonths,
        range: {
            startIso: params.rangeStartIso,
            endIso: params.rangeEndIso,
        },
        days,
        summary: {
            doctorCount: doctors.length,
            payableShiftCount: params.payableShifts.length,
            payableUnitCount: Number(params.payableShifts.reduce((sum, shift) => sum + shift.paymentUnit, 0).toFixed(2)),
            totalDueAmount: doctors.reduce((sum, doctor) => sum + Math.round((doctor.totalDue ?? 0) * 100), 0) / 100,
            readyCount: params.payableShifts.filter((shift) => shift.paymentStatus === "ready_for_payment").length,
            needsReviewCount: params.payableShifts.filter((shift) => shift.paymentStatus === "needs_review").length,
            segmentCount: params.attestationSegments.length,
            discardedSegmentCount: params.attestationSegments.filter((segment) => segment.status === "discarded").length,
            disabledTargetCount: params.disabledTargets.length,
            uncoveredTargetCount: params.uncoveredTargets.length,
            byEmploymentType,
        },
        targetOptions: params.targetOptions,
        doctors: [...doctors, ...rosterOnlyDoctors],
        payableShifts: params.payableShifts,
        disabledTargets: params.disabledTargets,
        uncoveredTargets: params.uncoveredTargets,
        attestationSegments: params.attestationSegments,
        allDoctorNames: params.allDoctorNames,
    } satisfies ChiefPayableBoardModel;
}

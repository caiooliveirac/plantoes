import { buildContinuityGroups } from "@/modules/bank-hours/continuity";
import { calculateBankHours } from "@/modules/bank-hours/calculator";
import { resolveBankHoursScheduledWindow } from "@/modules/bank-hours/window";
import { buildBankHoursBalanceOverrideExplanation, MANUAL_BANK_HOURS_OVERRIDE_RULE_CODE } from "@/modules/bank-hours/service";
import { resolveOperationalShiftWindow } from "@/modules/operational/board-rules";
import {
    describeLateDepartureReason,
    translateBankHoursRuleCode,
    type BankHoursLateDeparture,
} from "@/modules/reporting/bank-hours-labels";
import type { MonthlyReportAuditEntry, MonthlyReportSource } from "@/modules/reporting/monthly-report";

export type { BankHoursLateDeparture } from "@/modules/reporting/bank-hours-labels";

export interface RawBankHoursHistoryShift {
    occupancyId: string;
    domain: "regulation" | "intervention";
    doctorId: string;
    doctorName: string;
    displayName: string | null;
    targetCode: string;
    targetLabel: string;
    continuityGroupId: string;
    startedAt: string;
    boardStartedAt: string | null;
    handoffEndedAt: string | null;
    actualEndedAt: string | null;
    effectiveEndedAt: string | null;
    shiftLabel: string | null;
    source: MonthlyReportSource;
    notes: string | null;
    createdAt: string;
    updatedAt: string;
    createdByEmail: string | null;
    updatedByEmail: string | null;
    hasPersistedBankEntry: boolean;
    occupancyScheduledStartAt: string | null;
    occupancyScheduledEndAt: string | null;
    bankScheduledStartAt: string | null;
    bankScheduledEndAt: string | null;
    bankActualStartAt: string | null;
    bankActualEndAt: string | null;
    arrivalDelayMinutes: number | null;
    overtimeMinutes: number | null;
    creditedOvertimeMinutes: number | null;
    balanceMinutes: number | null;
    ruleCode: string | null;
    bankHoursExplanation: string | null;
    manualBalanceMinutes: number | null;
    manualBalanceNotes: string | null;
    manualBalanceUpdatedAt: string | null;
    manualBalanceActorEmail: string | null;
    auditTrail: MonthlyReportAuditEntry[];
    lateDeparture?: BankHoursLateDeparture | null;
}

interface ResolvedBankHoursMetrics {
    arrivalDelayMinutes: number;
    overtimeMinutes: number;
    creditedOvertimeMinutes: number;
    balanceMinutes: number;
    ruleCode: string;
    explanation: string;
    source: "persisted" | "reconstructed" | "manual_override";
}

export interface BankHoursProof {
    summary: string;
    items: string[];
    mode: "handoff" | "double_overtime" | "simple_overtime" | "debit" | "neutral" | "pending";
}

/** Uma correção administrativa reconstruída da trilha de auditoria, já legível. */
export interface BankHoursShiftCorrection {
    id: string;
    createdAt: string;
    actorEmail: string | null;
    /** Quem estava no ramal 2031 (chefia de plantão) no momento da correção. */
    chiefOnDutyName: string | null;
    changes: string[];
    notes: string | null;
    undone: boolean;
}

export interface BankHoursHistoryShift extends RawBankHoursHistoryShift {
    workedMinutes: number | null;
    countedStartAt: string | null;
    countedEndAt: string | null;
    proof: BankHoursProof;
    /** Quem assumiu o posto/base na rendição, quando identificável. */
    successorDoctorName: string | null;
    successorTookOverAt: string | null;
    corrections: BankHoursShiftCorrection[];
    flags: {
        hasCorrectionHistory: boolean;
        hasHandoffOverride: boolean;
        hasLateArrival: boolean;
        hasOpenShift: boolean;
    };
}

/** Saldo legado da planilha da coordenação (migration 0034), já matched. */
export interface BankHoursLegacySummary {
    spreadsheetName: string;
    preMay2025Minutes: number;
    spreadsheetPeriodMinutes: number;
    totalMinutes: number;
    source: string;
    notes: string | null;
}

export interface BankHoursLegacyDoctorRecord extends BankHoursLegacySummary {
    doctorId: string;
    doctorName: string;
    displayName: string | null;
}

export interface BankHoursDoctorHistory {
    doctorId: string;
    doctorName: string;
    displayName: string | null;
    shiftCount: number;
    workedMinutes: number;
    /** Saldo EFETIVO: apurado pela aplicação + acertos + saldo legado da planilha. */
    balanceMinutes: number;
    /** Parcela apurada pela aplicação (plantões + acertos), sem o legado. */
    applicationBalanceMinutes: number;
    /** Parcela legada da planilha; null = plantonista sem registro legado. */
    legacy: BankHoursLegacySummary | null;
    creditedOvertimeMinutes: number;
    arrivalDelayMinutes: number;
    lateArrivalCount: number;
    handoffOverrideCount: number;
    correctionCount: number;
    openShiftCount: number;
    lastShiftAt: string | null;
    shifts: BankHoursHistoryShift[];
    /** Acertos (bônus/punição) lançados no fechamento; já somados em balanceMinutes. */
    settlements: BankHoursSettlementSummary[];
}

// Régua do acerto de ±12h: vive em módulo próprio (sem imports) para poder ir
// ao bundle do client sem arrastar as dependências de Node deste arquivo.
export { resolveBankHoursSettlementBalance, type BankHoursSettlementBalance } from "@/modules/reporting/bank-hours-settlement-rule";

export interface BankHoursSettlementSummary {
    id: string;
    monthKey: string;
    kind: "bonus" | "penalty";
    deltaMinutes: number;
    operationalDate: string | null;
    notes: string;
    createdAt: string;
}

export interface BankHoursHistoryModel {
    generatedAt: string;
    summary: {
        doctorCount: number;
        shiftCount: number;
        workedMinutes: number;
        balanceMinutes: number;
        lateArrivalCount: number;
        handoffOverrideCount: number;
        correctionCount: number;
    };
    doctors: BankHoursDoctorHistory[];
}

const SAO_PAULO_TIME_ZONE = "America/Sao_Paulo";

/** Ramal cuja titularidade identifica a chefia de plantão (CP) num dado instante. */
const CHIEF_POST_CODE = "2031";

/** Tolerância para casar a chegada de quem rendeu com o fim contado do plantão anterior. */
const SUCCESSOR_MATCH_TOLERANCE_MS = 45 * 60000;

function joinDistinct(values: Array<string | null>) {
    const filtered = Array.from(new Set(values.filter((value): value is string => Boolean(value?.trim()))));
    if (filtered.length === 0) {
        return null;
    }

    return filtered.join(" -> ");
}

function mergeAuditTrail(entries: MonthlyReportAuditEntry[][]) {
    return entries
        .flat()
        .filter((entry, index, collection) => collection.findIndex((candidate) => candidate.id === entry.id) === index);
}

function collapseContinuityHistoryShifts(shifts: RawBankHoursHistoryShift[]) {
    return buildContinuityGroups(shifts).map((group) => {
        if (group.members.length === 1) {
            return group.carrier;
        }

        return {
            ...group.carrier,
            targetCode: joinDistinct(group.members.map((member) => member.targetCode)) ?? group.carrier.targetCode,
            targetLabel: joinDistinct(group.members.map((member) => member.targetLabel)) ?? group.carrier.targetLabel,
            shiftLabel: "P",
            handoffEndedAt: group.tail.handoffEndedAt,
            actualEndedAt: group.tail.actualEndedAt,
            effectiveEndedAt: group.tail.effectiveEndedAt,
            occupancyScheduledStartAt: group.carrier.occupancyScheduledStartAt,
            occupancyScheduledEndAt: group.tail.occupancyScheduledEndAt,
            notes: joinDistinct(group.members.map((member) => member.notes)),
            updatedAt: group.tail.updatedAt,
            updatedByEmail: group.tail.updatedByEmail ?? group.carrier.updatedByEmail,
            hasPersistedBankEntry: group.members.some((member) => member.hasPersistedBankEntry),
            auditTrail: mergeAuditTrail(group.members.map((member) => member.auditTrail)),
            lateDeparture: group.tail.lateDeparture
                ?? group.members.map((member) => member.lateDeparture).find(Boolean)
                ?? null,
        } satisfies RawBankHoursHistoryShift;
    });
}

function formatLocalTime(value: string | null) {
    if (!value) {
        return "--";
    }

    return new Intl.DateTimeFormat("pt-BR", {
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
        timeZone: SAO_PAULO_TIME_ZONE,
    }).format(new Date(value));
}

function formatLocalDateTime(value: string | null) {
    if (!value) {
        return "--";
    }

    return new Intl.DateTimeFormat("pt-BR", {
        dateStyle: "short",
        timeStyle: "short",
        timeZone: SAO_PAULO_TIME_ZONE,
    }).format(new Date(value));
}

function sameInstant(left: string | null, right: string | null) {
    if (!left || !right) {
        return false;
    }

    return new Date(left).getTime() === new Date(right).getTime();
}

function diffMinutes(startAt: string | null, endAt: string | null) {
    if (!startAt || !endAt) {
        return null;
    }

    const diff = new Date(endAt).getTime() - new Date(startAt).getTime();
    if (Number.isNaN(diff)) {
        return null;
    }

    return Math.round(diff / 60000);
}

function resolveCountedStartAt(shift: RawBankHoursHistoryShift) {
    return shift.bankActualStartAt ?? shift.startedAt ?? null;
}

function resolveCountedEndAt(shift: RawBankHoursHistoryShift) {
    return shift.bankActualEndAt
        ?? shift.handoffEndedAt
        ?? shift.actualEndedAt
        ?? shift.effectiveEndedAt
        ?? null;
}

function resolveBaseShiftLabel(shift: RawBankHoursHistoryShift) {
    if (shift.shiftLabel && shift.shiftLabel !== "P") {
        return shift.shiftLabel;
    }

    return resolveOperationalShiftWindow(shift.startedAt).shiftLabel;
}

function resolveScheduledWindow(shift: RawBankHoursHistoryShift) {
    const inferredWindow = resolveBankHoursScheduledWindow({
        domain: shift.domain,
        startedAt: shift.startedAt,
        shiftLabel: shift.shiftLabel,
        scheduledStartAt: shift.bankScheduledStartAt ?? shift.occupancyScheduledStartAt,
        scheduledEndAt: shift.bankScheduledEndAt ?? shift.occupancyScheduledEndAt,
        postCode: shift.domain === "regulation" ? shift.targetCode : null,
    });

    return {
        scheduledStartAt: inferredWindow.scheduledStartAt?.toISOString() ?? null,
        scheduledEndAt: inferredWindow.scheduledEndAt?.toISOString() ?? null,
    };
}

function resolveBankHoursMetrics(
    shift: RawBankHoursHistoryShift,
    countedStartAt: string | null,
    countedEndAt: string | null,
    scheduledStartAt: string | null,
    scheduledEndAt: string | null,
): ResolvedBankHoursMetrics | null {
    if (shift.manualBalanceMinutes !== null) {
        const automaticMetrics = scheduledStartAt && scheduledEndAt && countedStartAt && countedEndAt
            ? calculateBankHours({
                scheduledStartAt,
                scheduledEndAt,
                actualStartAt: countedStartAt,
                actualEndAt: countedEndAt,
            })
            : null;

        return {
            arrivalDelayMinutes: automaticMetrics?.arrivalDelayMinutes ?? shift.arrivalDelayMinutes ?? 0,
            overtimeMinutes: automaticMetrics?.overtimeMinutes ?? shift.overtimeMinutes ?? 0,
            creditedOvertimeMinutes: automaticMetrics?.creditedOvertimeMinutes ?? shift.creditedOvertimeMinutes ?? 0,
            balanceMinutes: shift.manualBalanceMinutes,
            ruleCode: MANUAL_BANK_HOURS_OVERRIDE_RULE_CODE,
            explanation: buildBankHoursBalanceOverrideExplanation({
                balanceMinutes: shift.manualBalanceMinutes,
                notes: shift.manualBalanceNotes ?? shift.bankHoursExplanation ?? "Ajuste manual sem motivo detalhado.",
                automaticBalanceMinutes: automaticMetrics?.balanceMinutes ?? shift.balanceMinutes ?? null,
            }),
            source: "manual_override",
        };
    }

    if (shift.hasPersistedBankEntry) {
        return {
            arrivalDelayMinutes: shift.arrivalDelayMinutes ?? 0,
            overtimeMinutes: shift.overtimeMinutes ?? 0,
            creditedOvertimeMinutes: shift.creditedOvertimeMinutes ?? 0,
            balanceMinutes: shift.balanceMinutes ?? 0,
            ruleCode: shift.ruleCode ?? "UNSPECIFIED_RULE",
            explanation: shift.bankHoursExplanation ?? "Sem explicacao persistida no banco.",
            source: "persisted",
        };
    }

    if (!scheduledStartAt || !scheduledEndAt || !countedStartAt || !countedEndAt) {
        return null;
    }

    const calculation = calculateBankHours({
        scheduledStartAt,
        scheduledEndAt,
        actualStartAt: countedStartAt,
        actualEndAt: countedEndAt,
    });

    return {
        arrivalDelayMinutes: calculation.arrivalDelayMinutes,
        overtimeMinutes: calculation.overtimeMinutes,
        creditedOvertimeMinutes: calculation.creditedOvertimeMinutes,
        balanceMinutes: calculation.balanceMinutes,
        ruleCode: calculation.ruleCode,
        explanation: calculation.explanation,
        source: "reconstructed",
    };
}

function computeWorkedMinutes(startedAt: string, endedAt: string | null) {
    const diff = diffMinutes(startedAt, endedAt);
    if (diff === null || diff <= 0) {
        return null;
    }

    return diff;
}

interface SuccessorCandidate {
    doctorId: string;
    doctorName: string;
    displayName: string | null;
    continuityGroupId: string;
    startedAtMs: number;
    startedAt: string;
}

/**
 * Índice "quem assumiu este posto/base logo depois": usa a lista COMPLETA de
 * ocupações (antes do colapso de continuidade) para nomear quem rendeu.
 */
function buildSuccessorLookup(shifts: RawBankHoursHistoryShift[]) {
    const byTarget = new Map<string, SuccessorCandidate[]>();
    for (const shift of shifts) {
        const startedAtMs = new Date(shift.startedAt).getTime();
        if (Number.isNaN(startedAtMs)) {
            continue;
        }

        const key = `${shift.domain}:${shift.targetCode}`;
        const list = byTarget.get(key) ?? [];
        list.push({
            doctorId: shift.doctorId,
            doctorName: shift.doctorName,
            displayName: shift.displayName,
            continuityGroupId: shift.continuityGroupId,
            startedAtMs,
            startedAt: shift.startedAt,
        });
        byTarget.set(key, list);
    }

    return (shift: RawBankHoursHistoryShift, handoffAt: string | null) => {
        if (!handoffAt) {
            return null;
        }

        const handoffMs = new Date(handoffAt).getTime();
        if (Number.isNaN(handoffMs)) {
            return null;
        }

        // O colapso concatena códigos com " -> "; procure em todos os alvos do grupo.
        const targetCodes = shift.targetCode.split(" -> ").map((code) => code.trim()).filter(Boolean);
        let best: { candidate: SuccessorCandidate; distance: number } | null = null;
        for (const targetCode of targetCodes) {
            for (const candidate of byTarget.get(`${shift.domain}:${targetCode}`) ?? []) {
                if (candidate.doctorId === shift.doctorId || candidate.continuityGroupId === shift.continuityGroupId) {
                    continue;
                }

                const distance = Math.abs(candidate.startedAtMs - handoffMs);
                if (distance <= SUCCESSOR_MATCH_TOLERANCE_MS && (!best || distance < best.distance)) {
                    best = { candidate, distance };
                }
            }
        }

        return best?.candidate ?? null;
    };
}

/**
 * Índice "quem era a chefia de plantão (titular da 2031) num dado instante".
 * Preferimos titulares do quadro (boardStartedAt preenchido); sombra não chefia.
 */
function buildChiefOnDutyLookup(shifts: RawBankHoursHistoryShift[]) {
    const intervals = shifts
        .filter((shift) => shift.domain === "regulation" && shift.targetCode === CHIEF_POST_CODE && shift.boardStartedAt)
        .map((shift) => {
            const startMs = new Date(shift.startedAt).getTime();
            const endSource = shift.effectiveEndedAt ?? shift.handoffEndedAt;
            const endMs = endSource ? new Date(endSource).getTime() : startMs + 14 * 3600000;
            return {
                startMs,
                endMs,
                name: shift.displayName ?? shift.doctorName,
            };
        })
        .filter((interval) => !Number.isNaN(interval.startMs) && !Number.isNaN(interval.endMs));

    return (at: string | null) => {
        if (!at) {
            return null;
        }

        const atMs = new Date(at).getTime();
        if (Number.isNaN(atMs)) {
            return null;
        }

        let best: { startMs: number; name: string } | null = null;
        for (const interval of intervals) {
            if (interval.startMs <= atMs && atMs <= interval.endMs && (!best || interval.startMs > best.startMs)) {
                best = interval;
            }
        }

        return best?.name ?? null;
    };
}

function readIsoField(details: Record<string, unknown>, key: string) {
    const value = details[key];
    return typeof value === "string" && value.trim() ? value : null;
}

function readSnapshotField(details: Record<string, unknown>, key: string) {
    const snapshot = details.beforeSnapshot;
    if (typeof snapshot !== "object" || snapshot === null) {
        return null;
    }

    const value = (snapshot as Record<string, unknown>)[key];
    return typeof value === "string" && value.trim() ? value : null;
}

function describeTimeChange(label: string, before: string | null, after: string | null) {
    if (!after || sameInstant(before, after)) {
        return null;
    }

    return `${label}: ${formatLocalDateTime(before)} → ${formatLocalDateTime(after)}`;
}

/**
 * Reconstrói as correções administrativas do plantão a partir da trilha de
 * auditoria, com o que mudou (chegada/saída) e quem era a chefia na hora.
 */
function extractCorrections(
    auditTrail: MonthlyReportAuditEntry[],
    chiefOnDutyAt: (at: string | null) => string | null,
): BankHoursShiftCorrection[] {
    const corrections: BankHoursShiftCorrection[] = [];
    for (const entry of auditTrail) {
        const isCorrection = entry.action.endsWith(".corrected");
        const isUndo = entry.action.endsWith(".corrected.undone");
        if (!isCorrection && !isUndo) {
            continue;
        }

        if (isUndo) {
            corrections.push({
                id: entry.id,
                createdAt: entry.createdAt,
                actorEmail: entry.actorEmail,
                chiefOnDutyName: chiefOnDutyAt(entry.createdAt),
                changes: ["Correção desfeita — o registro voltou ao estado anterior."],
                notes: null,
                undone: true,
            });
            continue;
        }

        const details = entry.details ?? {};
        const changes: string[] = [];

        const arrivalChange = describeTimeChange(
            "Chegada",
            readIsoField(details, "previousStartedAt") ?? readSnapshotField(details, "startedAt"),
            readIsoField(details, "nextStartedAt") ?? readIsoField(details, "startedAt"),
        );
        if (arrivalChange) {
            changes.push(arrivalChange);
        }

        const handoffChange = describeTimeChange(
            "Saída do quadro (rendição)",
            readSnapshotField(details, "endedAt"),
            readIsoField(details, "endedAt"),
        );
        if (handoffChange) {
            changes.push(handoffChange);
        }

        const physicalChange = describeTimeChange(
            "Saída física",
            readSnapshotField(details, "actualEndedAt"),
            readIsoField(details, "actualEndedAt"),
        );
        if (physicalChange) {
            changes.push(physicalChange);
        }

        const previousDoctorId = typeof details.previousDoctorId === "string" ? details.previousDoctorId : null;
        const nextDoctorId = typeof details.nextDoctorId === "string" ? details.nextDoctorId : null;
        if (previousDoctorId && nextDoctorId && previousDoctorId !== nextDoctorId) {
            changes.push("Plantonista do registro trocado.");
        }

        if (changes.length === 0) {
            changes.push("Registro corrigido pela administração (detalhes na trilha de auditoria).");
        }

        corrections.push({
            id: entry.id,
            createdAt: entry.createdAt,
            actorEmail: entry.actorEmail,
            chiefOnDutyName: chiefOnDutyAt(entry.createdAt),
            changes,
            notes: typeof details.notes === "string" && details.notes.trim() ? details.notes.trim() : null,
            undone: false,
        });
    }

    return corrections.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
}

export function buildBankHoursProof(
    shift: RawBankHoursHistoryShift,
    context?: { successorDoctorName?: string | null },
): BankHoursProof {
    const countedStartAt = resolveCountedStartAt(shift);
    const countedEndAt = resolveCountedEndAt(shift);
    const { scheduledStartAt, scheduledEndAt } = resolveScheduledWindow(shift);
    const metrics = resolveBankHoursMetrics(shift, countedStartAt, countedEndAt, scheduledStartAt, scheduledEndAt);
    const items: string[] = [];

    if (!countedEndAt) {
        items.push("Ainda não existe saída consolidada para este plantão. Enquanto ele estiver aberto, o banco de horas fica apenas em observação.");
        if (scheduledStartAt && scheduledEndAt) {
            items.push(`A janela operacional esperada para este plantão é ${formatLocalTime(scheduledStartAt)} até ${formatLocalTime(scheduledEndAt)}.`);
        }
        if (shift.bankHoursExplanation) {
            items.push(shift.bankHoursExplanation);
        }

        return {
            summary: "Plantão ainda aberto no histórico.",
            items,
            mode: "pending",
        };
    }

    if (!scheduledStartAt || !scheduledEndAt || !countedStartAt || !metrics) {
        items.push("Existe encerramento registrado, mas ainda faltam dados confiáveis de turno ou janela operacional para fechar o cálculo do banco com segurança.");
        if (shift.bankHoursExplanation) {
            items.push(shift.bankHoursExplanation);
        }

        return {
            summary: "Encerrado sem janela suficiente para cálculo.",
            items,
            mode: "pending",
        };
    }

    if (metrics.source === "reconstructed") {
        items.push("Não havia linha persistida de banco de horas para este plantão. A leitura abaixo foi reconstruída a partir da janela operacional do plantão e do encerramento registrado no quadro.");
    }

    if (metrics.source === "manual_override") {
        items.push(`O saldo final deste plantão foi ajustado manualmente para ${metrics.balanceMinutes} min${shift.manualBalanceActorEmail ? ` por ${shift.manualBalanceActorEmail}` : ""}${shift.manualBalanceUpdatedAt ? ` em ${formatLocalDateTime(shift.manualBalanceUpdatedAt)}` : ""}.`);
    }

    if (metrics.arrivalDelayMinutes === 0) {
        items.push(`A entrada considerada foi ${formatLocalTime(countedStartAt)} para uma janela prevista em ${formatLocalTime(scheduledStartAt)}. Ficou dentro da tolerância, então não houve débito de chegada.`);
    } else {
        items.push(`A entrada considerada foi ${formatLocalTime(countedStartAt)} para uma janela prevista em ${formatLocalTime(scheduledStartAt)}. Isso gerou ${metrics.arrivalDelayMinutes} min de atraso abatidos no banco.`);
    }

    if (shift.actualEndedAt && !sameInstant(countedEndAt, shift.actualEndedAt)) {
        if (shift.handoffEndedAt && sameInstant(countedEndAt, shift.handoffEndedAt)) {
            const successorName = context?.successorDoctorName ?? null;
            items.push(successorName
                ? `${successorName} assumiu a cobertura às ${formatLocalTime(shift.handoffEndedAt)}. Existe uma saída física registrada às ${formatLocalTime(shift.actualEndedAt)}, mas o cálculo travou na rendição porque a responsabilidade já tinha sido transferida.`
                : `A responsabilidade operacional foi entregue às ${formatLocalTime(shift.handoffEndedAt)}. Existe uma saída física registrada às ${formatLocalTime(shift.actualEndedAt)}, mas o cálculo travou na rendição porque outra pessoa já tinha assumido a cobertura.`);
        } else {
            items.push(`O cálculo usou ${formatLocalTime(countedEndAt)} como horário final válido. A saída física em ${formatLocalTime(shift.actualEndedAt)} ficou guardada como prova, mas não substituiu o encerramento operacional contado.`);
        }
    } else if (metrics.creditedOvertimeMinutes === 0) {
        items.push(`A saída considerada foi ${formatLocalTime(countedEndAt)} para uma janela prevista até ${formatLocalTime(scheduledEndAt)}. Como ficou dentro da tolerância final, não houve crédito extra.`);
    } else if (metrics.arrivalDelayMinutes === 0 && metrics.creditedOvertimeMinutes > metrics.overtimeMinutes) {
        items.push(`A saída considerada foi ${formatLocalTime(countedEndAt)} e passou ${metrics.overtimeMinutes} min da janela prevista. Como a entrada ficou no prazo, esse excedente entrou com crédito em dobro.`);
    } else {
        items.push(`A saída considerada foi ${formatLocalTime(countedEndAt)} e gerou ${metrics.creditedOvertimeMinutes} min de crédito. Como houve atraso na entrada, o bônus em dobro não se aplica neste plantão.`);
    }

    const lateDepartureReason = describeLateDepartureReason(shift.lateDeparture);
    if (lateDepartureReason && metrics.creditedOvertimeMinutes > 0) {
        items.push(`A permanência além do previsto tem justificativa registrada no bot: ${lateDepartureReason}.`);
    }

    if (metrics.ruleCode && metrics.explanation) {
        items.push(`Regra aplicada: ${translateBankHoursRuleCode(metrics.ruleCode)}. ${metrics.explanation}`);
    } else if (metrics.ruleCode) {
        items.push(`Regra aplicada: ${translateBankHoursRuleCode(metrics.ruleCode)}.`);
    } else if (metrics.explanation) {
        items.push(metrics.explanation);
    }

    if (shift.notes?.trim()) {
        items.push(`Observação operacional registrada: ${shift.notes.trim()}`);
    }

    if (shift.actualEndedAt && !sameInstant(countedEndAt, shift.actualEndedAt)) {
        return {
            summary: "Cálculo encerrado na rendição, não na saída física.",
            items,
            mode: "handoff",
        };
    }

    if (metrics.source === "manual_override") {
        return {
            summary: "Saldo ajustado manualmente pela administração.",
            items,
            mode: "neutral",
        };
    }

    if (metrics.arrivalDelayMinutes === 0 && metrics.creditedOvertimeMinutes > metrics.overtimeMinutes) {
        return {
            summary: "Entrada no prazo preservou o crédito em dobro.",
            items,
            mode: "double_overtime",
        };
    }

    if (metrics.arrivalDelayMinutes > 0 && metrics.creditedOvertimeMinutes > 0) {
        return {
            summary: "O atraso de entrada derrubou o bônus em dobro.",
            items,
            mode: "simple_overtime",
        };
    }

    if (metrics.balanceMinutes < 0) {
        return {
            summary: "O débito de chegada superou qualquer compensação.",
            items,
            mode: "debit",
        };
    }

    return {
        summary: "Registro alinhado com a janela operacional contabilizada.",
        items,
        mode: "neutral",
    };
}

function compareDoctors(left: BankHoursDoctorHistory, right: BankHoursDoctorHistory) {
    if (right.handoffOverrideCount !== left.handoffOverrideCount) {
        return right.handoffOverrideCount - left.handoffOverrideCount;
    }

    if (right.correctionCount !== left.correctionCount) {
        return right.correctionCount - left.correctionCount;
    }

    return left.doctorName.localeCompare(right.doctorName, "pt-BR");
}

export function buildBankHoursHistoryModel(
    shifts: RawBankHoursHistoryShift[],
    settlementsByDoctor: Map<string, BankHoursSettlementSummary[]> = new Map(),
    legacyByDoctor: Map<string, BankHoursLegacyDoctorRecord> = new Map(),
): BankHoursHistoryModel {
    const findSuccessor = buildSuccessorLookup(shifts);
    const chiefOnDutyAt = buildChiefOnDutyLookup(shifts);
    const normalizedShifts: BankHoursHistoryShift[] = collapseContinuityHistoryShifts(shifts)
        .map((shift) => {
            const countedStartAt = resolveCountedStartAt(shift);
            const countedEndAt = resolveCountedEndAt(shift);
            const { scheduledStartAt, scheduledEndAt } = resolveScheduledWindow(shift);
            const metrics = resolveBankHoursMetrics(shift, countedStartAt, countedEndAt, scheduledStartAt, scheduledEndAt);
            const hasCorrectionHistory = shift.auditTrail.some((entry) => entry.action.endsWith(".corrected")) || shift.manualBalanceMinutes !== null;
            const handoffPrevailed = Boolean(shift.actualEndedAt && countedEndAt && !sameInstant(shift.actualEndedAt, countedEndAt));
            const successor = handoffPrevailed ? findSuccessor(shift, countedEndAt) : null;
            const resolvedShift = {
                ...shift,
                bankScheduledStartAt: scheduledStartAt,
                bankScheduledEndAt: scheduledEndAt,
                bankActualStartAt: shift.bankActualStartAt ?? countedStartAt,
                bankActualEndAt: shift.bankActualEndAt ?? countedEndAt,
                arrivalDelayMinutes: metrics?.arrivalDelayMinutes ?? shift.arrivalDelayMinutes,
                overtimeMinutes: metrics?.overtimeMinutes ?? shift.overtimeMinutes,
                creditedOvertimeMinutes: metrics?.creditedOvertimeMinutes ?? shift.creditedOvertimeMinutes,
                balanceMinutes: metrics?.balanceMinutes ?? shift.balanceMinutes,
                ruleCode: metrics?.ruleCode ?? shift.ruleCode,
                bankHoursExplanation: metrics?.explanation ?? shift.bankHoursExplanation,
            } satisfies RawBankHoursHistoryShift;
            return {
                ...resolvedShift,
                workedMinutes: computeWorkedMinutes(shift.startedAt, shift.effectiveEndedAt),
                countedStartAt,
                countedEndAt,
                proof: buildBankHoursProof(resolvedShift, { successorDoctorName: successor ? (successor.displayName ?? successor.doctorName) : null }),
                successorDoctorName: successor ? (successor.displayName ?? successor.doctorName) : null,
                successorTookOverAt: successor?.startedAt ?? null,
                corrections: extractCorrections(shift.auditTrail, chiefOnDutyAt),
                flags: {
                    hasCorrectionHistory,
                    hasHandoffOverride: handoffPrevailed,
                    hasLateArrival: (resolvedShift.arrivalDelayMinutes ?? 0) > 0,
                    hasOpenShift: !shift.effectiveEndedAt,
                },
            } satisfies BankHoursHistoryShift;
        })
        .sort((left, right) => new Date(right.startedAt).getTime() - new Date(left.startedAt).getTime());

    const doctorsMap = new Map<string, BankHoursDoctorHistory>();
    for (const shift of normalizedShifts) {
        const current = doctorsMap.get(shift.doctorId);
        if (!current) {
            doctorsMap.set(shift.doctorId, {
                doctorId: shift.doctorId,
                doctorName: shift.doctorName,
                displayName: shift.displayName,
                shiftCount: 1,
                workedMinutes: shift.workedMinutes ?? 0,
                balanceMinutes: shift.balanceMinutes ?? 0,
                creditedOvertimeMinutes: shift.creditedOvertimeMinutes ?? 0,
                arrivalDelayMinutes: shift.arrivalDelayMinutes ?? 0,
                lateArrivalCount: shift.flags.hasLateArrival ? 1 : 0,
                handoffOverrideCount: shift.flags.hasHandoffOverride ? 1 : 0,
                correctionCount: shift.flags.hasCorrectionHistory ? 1 : 0,
                openShiftCount: shift.flags.hasOpenShift ? 1 : 0,
                lastShiftAt: shift.startedAt,
                shifts: [shift],
                settlements: [],
                applicationBalanceMinutes: 0,
                legacy: null,
            });
            continue;
        }

        current.shiftCount += 1;
        current.workedMinutes += shift.workedMinutes ?? 0;
        current.balanceMinutes += shift.balanceMinutes ?? 0;
        current.creditedOvertimeMinutes += shift.creditedOvertimeMinutes ?? 0;
        current.arrivalDelayMinutes += shift.arrivalDelayMinutes ?? 0;
        current.lateArrivalCount += shift.flags.hasLateArrival ? 1 : 0;
        current.handoffOverrideCount += shift.flags.hasHandoffOverride ? 1 : 0;
        current.correctionCount += shift.flags.hasCorrectionHistory ? 1 : 0;
        current.openShiftCount += shift.flags.hasOpenShift ? 1 : 0;
        current.lastShiftAt = current.lastShiftAt && new Date(current.lastShiftAt).getTime() > new Date(shift.startedAt).getTime()
            ? current.lastShiftAt
            : shift.startedAt;
        current.shifts.push(shift);
    }

    // Dobra os acertos do fechamento no saldo do médico: o saldo da página passa a
    // ser o EFETIVO (bruto + acertos), igual ao que o modal do payment-closing usa.
    let settlementTotalMinutes = 0;
    for (const doctor of doctorsMap.values()) {
        const entries = (settlementsByDoctor.get(doctor.doctorId) ?? [])
            .slice()
            .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
        doctor.settlements = entries;
        const delta = entries.reduce((sum, entry) => sum + entry.deltaMinutes, 0);
        doctor.balanceMinutes += delta;
        settlementTotalMinutes += delta;
    }

    // Soma o saldo legado da planilha por cima do apurado pela aplicação, sem
    // misturar as parcelas: applicationBalanceMinutes preserva o que a aplicação
    // apurou e legacy carrega a composição da planilha para a view. Plantonista
    // com legado mas sem plantão na aplicação ainda precisa aparecer.
    let legacyTotalMinutes = 0;
    for (const record of legacyByDoctor.values()) {
        const { doctorId, doctorName, displayName, ...summary } = record;
        legacyTotalMinutes += summary.totalMinutes;
        const current = doctorsMap.get(doctorId);
        if (current) {
            current.applicationBalanceMinutes = current.balanceMinutes;
            current.legacy = summary;
            current.balanceMinutes += summary.totalMinutes;
            continue;
        }

        doctorsMap.set(doctorId, {
            doctorId,
            doctorName,
            displayName,
            shiftCount: 0,
            workedMinutes: 0,
            balanceMinutes: summary.totalMinutes,
            applicationBalanceMinutes: 0,
            legacy: summary,
            creditedOvertimeMinutes: 0,
            arrivalDelayMinutes: 0,
            lateArrivalCount: 0,
            handoffOverrideCount: 0,
            correctionCount: 0,
            openShiftCount: 0,
            lastShiftAt: null,
            shifts: [],
            settlements: [],
        });
    }
    for (const doctor of doctorsMap.values()) {
        if (!doctor.legacy) {
            doctor.applicationBalanceMinutes = doctor.balanceMinutes;
        }
    }

    const doctors = Array.from(doctorsMap.values()).sort(compareDoctors);

    return {
        generatedAt: new Date().toISOString(),
        summary: {
            doctorCount: doctors.length,
            shiftCount: normalizedShifts.length,
            workedMinutes: normalizedShifts.reduce((total, shift) => total + (shift.workedMinutes ?? 0), 0),
            balanceMinutes: normalizedShifts.reduce((total, shift) => total + (shift.balanceMinutes ?? 0), 0) + settlementTotalMinutes + legacyTotalMinutes,
            lateArrivalCount: normalizedShifts.filter((shift) => shift.flags.hasLateArrival).length,
            handoffOverrideCount: normalizedShifts.filter((shift) => shift.flags.hasHandoffOverride).length,
            correctionCount: normalizedShifts.filter((shift) => shift.flags.hasCorrectionHistory).length,
        },
        doctors,
    };
}
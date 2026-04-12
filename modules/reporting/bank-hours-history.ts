import { buildContinuityGroups } from "@/modules/bank-hours/continuity";
import { calculateBankHours } from "@/modules/bank-hours/calculator";
import { buildBankHoursBalanceOverrideExplanation, MANUAL_BANK_HOURS_OVERRIDE_RULE_CODE } from "@/modules/bank-hours/service";
import { resolveOperationalShiftWindow } from "@/modules/operational/board-rules";
import {
    inferInterventionCoverageWindow,
    inferRegulationCoverageWindow,
} from "@/modules/operational/rules";
import type { MonthlyReportAuditEntry, MonthlyReportSource } from "@/modules/reporting/monthly-report";

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

export interface BankHoursHistoryShift extends RawBankHoursHistoryShift {
    workedMinutes: number | null;
    countedStartAt: string | null;
    countedEndAt: string | null;
    proof: BankHoursProof;
    flags: {
        hasCorrectionHistory: boolean;
        hasHandoffOverride: boolean;
        hasLateArrival: boolean;
        hasOpenShift: boolean;
    };
}

export interface BankHoursDoctorHistory {
    doctorId: string;
    doctorName: string;
    displayName: string | null;
    shiftCount: number;
    workedMinutes: number;
    balanceMinutes: number;
    creditedOvertimeMinutes: number;
    arrivalDelayMinutes: number;
    lateArrivalCount: number;
    handoffOverrideCount: number;
    correctionCount: number;
    openShiftCount: number;
    lastShiftAt: string | null;
    shifts: BankHoursHistoryShift[];
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
    const startedAt = new Date(shift.startedAt);
    const inferredWindow = shift.domain === "regulation"
        ? inferRegulationCoverageWindow({
            startedAt,
            shiftLabel: shift.shiftLabel,
            postCode: shift.targetCode,
            explicitScheduledStartAt: shift.bankScheduledStartAt ? new Date(shift.bankScheduledStartAt) : (shift.occupancyScheduledStartAt ? new Date(shift.occupancyScheduledStartAt) : null),
            explicitScheduledEndAt: shift.bankScheduledEndAt ? new Date(shift.bankScheduledEndAt) : (shift.occupancyScheduledEndAt ? new Date(shift.occupancyScheduledEndAt) : null),
        })
        : inferInterventionCoverageWindow({
            startedAt,
            shiftLabel: shift.shiftLabel,
            explicitScheduledStartAt: shift.bankScheduledStartAt ? new Date(shift.bankScheduledStartAt) : (shift.occupancyScheduledStartAt ? new Date(shift.occupancyScheduledStartAt) : null),
            explicitScheduledEndAt: shift.bankScheduledEndAt ? new Date(shift.bankScheduledEndAt) : (shift.occupancyScheduledEndAt ? new Date(shift.occupancyScheduledEndAt) : null),
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

export function buildBankHoursProof(shift: RawBankHoursHistoryShift): BankHoursProof {
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
        items.push("Nao havia linha persistida de banco de horas para este plantão. A leitura abaixo foi reconstruida a partir da janela operacional do plantão e do encerramento registrado no quadro.");
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
            items.push(`A responsabilidade operacional foi entregue às ${formatLocalTime(shift.handoffEndedAt)}. Existe uma saída física registrada às ${formatLocalTime(shift.actualEndedAt)}, mas o cálculo travou na rendição porque outra pessoa já tinha assumido a cobertura.`);
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

    if (metrics.ruleCode && metrics.explanation) {
        items.push(`Regra aplicada: ${metrics.ruleCode}. ${metrics.explanation}`);
    } else if (metrics.ruleCode) {
        items.push(`Regra aplicada: ${metrics.ruleCode}.`);
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

export function buildBankHoursHistoryModel(shifts: RawBankHoursHistoryShift[]): BankHoursHistoryModel {
    const normalizedShifts: BankHoursHistoryShift[] = collapseContinuityHistoryShifts(shifts)
        .map((shift) => {
            const countedStartAt = resolveCountedStartAt(shift);
            const countedEndAt = resolveCountedEndAt(shift);
            const { scheduledStartAt, scheduledEndAt } = resolveScheduledWindow(shift);
            const metrics = resolveBankHoursMetrics(shift, countedStartAt, countedEndAt, scheduledStartAt, scheduledEndAt);
            const hasCorrectionHistory = shift.auditTrail.some((entry) => entry.action.endsWith(".corrected")) || shift.manualBalanceMinutes !== null;
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
                proof: buildBankHoursProof(resolvedShift),
                flags: {
                    hasCorrectionHistory,
                    hasHandoffOverride: Boolean(shift.actualEndedAt && countedEndAt && !sameInstant(shift.actualEndedAt, countedEndAt)),
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

    const doctors = Array.from(doctorsMap.values()).sort(compareDoctors);

    return {
        generatedAt: new Date().toISOString(),
        summary: {
            doctorCount: doctors.length,
            shiftCount: normalizedShifts.length,
            workedMinutes: normalizedShifts.reduce((total, shift) => total + (shift.workedMinutes ?? 0), 0),
            balanceMinutes: normalizedShifts.reduce((total, shift) => total + (shift.balanceMinutes ?? 0), 0),
            lateArrivalCount: normalizedShifts.filter((shift) => shift.flags.hasLateArrival).length,
            handoffOverrideCount: normalizedShifts.filter((shift) => shift.flags.hasHandoffOverride).length,
            correctionCount: normalizedShifts.filter((shift) => shift.flags.hasCorrectionHistory).length,
        },
        doctors,
    };
}
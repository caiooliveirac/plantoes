/**
 * Os plantões que sustentam o saldo de um médico, já contados em português.
 *
 * Fonte única dos avisos que falam de bônus/punição — o do Telegram das 8h e o
 * do WhatsApp da coordenação. Antes cada aviso trazia só o total ("ganhou 12h"),
 * e não dava para desconfiar de um crédito nascido de registro errado sem abrir
 * a tela e ler linha a linha.
 */
import {
    buildBankHoursStory,
    renderBankHoursStoryText,
} from "@/modules/reporting/bank-hours-story";
import { getBankHoursHistory } from "@/services/bank-hours-history.service";

/** Quantos plantões cabem num aviso antes dele virar parede de texto. */
export const MAX_STORY_SHIFTS = 3;

export async function loadDoctorBankHoursStoryLines(
    doctorId: string,
    direction: "bonus" | "penalty",
    limit = MAX_STORY_SHIFTS,
): Promise<string[]> {
    const history = await getBankHoursHistory({ doctorId });
    const doctor = history.doctors.find((row) => row.doctorId === doctorId);
    if (!doctor) {
        return [];
    }

    return doctor.shifts
        .filter((shift) => (direction === "bonus"
            ? (shift.balanceMinutes ?? 0) > 0
            : (shift.balanceMinutes ?? 0) < 0))
        .sort((left, right) => Math.abs(right.balanceMinutes ?? 0) - Math.abs(left.balanceMinutes ?? 0))
        .slice(0, limit)
        .map((shift) => renderBankHoursStoryText(buildBankHoursStory({
            doctorName: shift.displayName ?? shift.doctorName,
            targetCode: shift.targetCode,
            shiftLabel: shift.shiftLabel,
            notes: shift.notes,
            scheduledStartAt: shift.bankScheduledStartAt,
            scheduledEndAt: shift.bankScheduledEndAt,
            startedAt: shift.startedAt,
            actualEndedAt: shift.actualEndedAt,
            handoffEndedAt: shift.handoffEndedAt,
            countedEndAt: shift.countedEndAt,
            arrivalDelayMinutes: shift.arrivalDelayMinutes,
            overtimeMinutes: shift.overtimeMinutes,
            creditedOvertimeMinutes: shift.creditedOvertimeMinutes,
            balanceMinutes: shift.balanceMinutes,
            lateDeparture: shift.lateDeparture ?? null,
            successorDoctorName: shift.successorDoctorName,
            successorTookOverAt: shift.successorTookOverAt,
            approvalLabel: shift.approval.label,
            approvalPending: shift.approval.tone === "pending" || shift.approval.tone === "warn",
        })).replaceAll("\n", " — "));
}

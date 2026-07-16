import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { doctors, interventionBases, interventionOccupancies } from "@/db/schema";
import {
    LATE_HALF_SHIFT_CUTOFF_HOUR,
    LATE_HALF_SHIFT_PAY_END_HOUR,
    LATE_HALF_SHIFT_PAY_START_HOUR,
    formatCarryoverLabel,
    isLateHalfShiftCandidate,
    resolveBahiaHour,
    resolveLateHalfShiftWindowFor,
} from "@/modules/bank-hours/late-arrival";
import { sendMessage } from "@/modules/telegram/api";

function formatLocalTime(value: Date | string): string {
    const date = value instanceof Date ? value : new Date(value);
    return date.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit", timeZone: "America/Bahia" });
}

/** When an intervention SD arrival lands at or after 9h (Bahia), publish a
 *  one-shot informative message in the chat explaining the coordination rule.
 *  The doctor doesn't have to do anything — the chefe/admin will acknowledge
 *  the case via /meioplantao or the drawer. This message is purely orientative.
 */
export async function maybeSendInterventionLateArrivalOrientation(params: {
    chatId: string | number;
    occupancyId: string;
    replyToMessageId?: number;
}): Promise<{ sent: boolean }> {
    const db = getDb();
    const occupancy = await db.query.interventionOccupancies.findFirst({
        where: eq(interventionOccupancies.id, params.occupancyId),
    });
    if (!occupancy) {
        return { sent: false };
    }
    if (!isLateHalfShiftCandidate(occupancy)) {
        return { sent: false };
    }

    const [base, doctor] = await Promise.all([
        db.query.interventionBases.findFirst({ where: eq(interventionBases.id, occupancy.baseId) }),
        db.query.doctors.findFirst({ where: eq(doctors.id, occupancy.doctorId) }),
    ]);
    if (!base || !doctor) {
        return { sent: false };
    }

    const startedAt = occupancy.startedAt instanceof Date ? occupancy.startedAt : new Date(occupancy.startedAt);
    const { scheduledStartAt } = resolveLateHalfShiftWindowFor(startedAt);
    const carryoverMs = Math.max(0, scheduledStartAt.getTime() - startedAt.getTime());
    const carryoverMinutes = Math.floor(carryoverMs / 60000);
    const carryoverLabel = formatCarryoverLabel(carryoverMinutes);
    const doctorSurfaceName = doctor.displayName ?? doctor.fullName;

    const lines = [
        `⚠️ *${doctorSurfaceName}* chegou em *${base.code}* às *${formatLocalTime(startedAt)}* — depois das ${LATE_HALF_SHIFT_CUTOFF_HOUR}h.`,
        `Pode virar *meio plantão* (${LATE_HALF_SHIFT_PAY_START_HOUR}:00–${LATE_HALF_SHIFT_PAY_END_HOUR}:00) se chefe/admin reconhecer: \`/meioplantao ${base.code}\`.`,
        carryoverMinutes > 0
            ? `Reconhecendo, ${carryoverLabel} antes das ${LATE_HALF_SHIFT_PAY_START_HOUR}:00 viram crédito no banco de horas.`
            : `Sem crédito de banco de horas (chegada depois das ${LATE_HALF_SHIFT_PAY_START_HOUR}:00).`,
    ];

    await sendMessage(String(params.chatId), lines.join("\n"), params.replyToMessageId);
    return { sent: true };
}

export function buildLateArrivalAcknowledgementAnnouncement(params: {
    doctorName: string;
    baseCode: string;
    actualStartLabel: string;
    carryoverMinutes: number;
    markedByLabel: string;
    markedByChefe: boolean;
    source: "telegram_command" | "drawer";
}): string {
    const sourceLabel =
        params.source === "telegram_command" ? "via comando /meioplantao no Telegram"
        : "via quadro operacional";
    const actorRole = params.markedByChefe ? "chefe" : "admin";
    const carryoverLabel = params.carryoverMinutes > 0
        ? formatCarryoverLabel(params.carryoverMinutes)
        : `sem crédito (chegada após as ${LATE_HALF_SHIFT_PAY_START_HOUR}:00)`;
    return [
        "✅ *Meio plantão por atraso reconhecido*",
        `*Médico:* ${params.doctorName}`,
        `*Base:* ${params.baseCode}`,
        `*Chegada efetiva:* ${params.actualStartLabel}`,
        `*Pagamento:* MEIO PLANTÃO (${LATE_HALF_SHIFT_PAY_START_HOUR}:00–${LATE_HALF_SHIFT_PAY_END_HOUR}:00)`,
        `*Crédito no banco de horas:* ${carryoverLabel}`,
        `*Reconhecido por:* ${params.markedByLabel} (${actorRole})`,
        `*Como:* ${sourceLabel}`,
        "Este aviso fica registrado no histórico público e pode ser auditado pela chefia a qualquer momento.",
    ].join("\n");
}

/** Re-exported so the service can pick the Bahia-local hour from the
 *  intervention arrival without re-importing the bank-hours module. */
export { resolveBahiaHour };

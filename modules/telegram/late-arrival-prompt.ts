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
        "📋 *Regra da coordenacao: chegada apos 9h em intervencao*",
        "━━━━━━━━━━━━━━━━━━━━",
        `*${doctorSurfaceName}* registrou chegada em *${base.code}* as *${formatLocalTime(startedAt)}*.`,
        "",
        `Pela regra atual da coordenacao, chegadas a partir das *${LATE_HALF_SHIFT_CUTOFF_HOUR}h* em intervencao SD passam a contar como *MEIO PLANTAO* para pagamento (janela *${LATE_HALF_SHIFT_PAY_START_HOUR}:00*–*${LATE_HALF_SHIFT_PAY_END_HOUR}:00*).`,
        "",
        carryoverMinutes > 0
            ? `O tempo trabalhado entre *${formatLocalTime(startedAt)}* e *${LATE_HALF_SHIFT_PAY_START_HOUR}:00* (${carryoverLabel}) sera creditado no *banco de horas* assim que o chefe ou admin reconhecer a conversao.`
            : `Como a chegada foi as ${formatLocalTime(startedAt)} (apos as ${LATE_HALF_SHIFT_PAY_START_HOUR}:00), nao havera carryover de banco — apenas o pagamento do meio plantao.`,
        "",
        "👉 O *chefe* ou *admin* faz o reconhecimento via comando `/meioplantao <base>` no Telegram ou pelo botão no quadro operacional.",
        "📌 Esta mensagem e orientativa: a conversao so se efetiva apos o reconhecimento.",
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
    const carryoverLabel = formatCarryoverLabel(params.carryoverMinutes);
    return [
        "🟡 *MEIO PLANTAO POR ATRASO RECONHECIDO* 🟡",
        "━━━━━━━━━━━━━━━━━━━━",
        `*Medico:* ${params.doctorName}`,
        `*Base:* ${params.baseCode}`,
        `*Chegada efetiva:* ${params.actualStartLabel}`,
        `*Pagamento:* MEIO PLANTAO (${LATE_HALF_SHIFT_PAY_START_HOUR}:00–${LATE_HALF_SHIFT_PAY_END_HOUR}:00)`,
        `*Carryover banco de horas:* ${carryoverLabel}`,
        `*Reconhecido por:* ${params.markedByLabel} (${actorRole})`,
        `*Como:* ${sourceLabel}`,
        "━━━━━━━━━━━━━━━━━━━━",
        "📋 Este aviso fica registrado no historico publico e pode ser auditado pela chefia a qualquer momento.",
    ].join("\n");
}

/** Re-exported so the service can pick the Bahia-local hour from the
 *  intervention arrival without re-importing the bank-hours module. */
export { resolveBahiaHour };

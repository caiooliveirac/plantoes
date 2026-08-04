import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { doctors, interventionBases, regulationPosts } from "@/db/schema";
import { sendMessage } from "@/modules/telegram/api";
import { getTelegramAnnouncementChatIds } from "@/modules/telegram/config";
import { buildChiefKickAnnouncement, buildDeactivationDepartureAnnouncement } from "@/modules/telegram/replies";
import { isStoredEarlyDepartureOutcome } from "@/modules/operational/early-departure";
import { buildEarlyDepartureSummary } from "@/modules/operational/early-departure-copy";

function formatSaoPauloTime(date: Date) {
    return date.toLocaleTimeString("pt-BR", {
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
        timeZone: "America/Sao_Paulo",
    });
}

export async function announceChiefKickDeparture(params: {
    seed: string;
    doctorId: string;
    targetCode: string;
    endedAt: Date;
    /** Desfecho da régua de saída antecipada, quando aplicada — entra no anúncio. */
    earlyDepartureOutcome?: string | null;
}) {
    const groupChatIds = getTelegramAnnouncementChatIds();
    if (groupChatIds.length === 0) return;

    const db = getDb();
    const doctor = await db.query.doctors.findFirst({ where: eq(doctors.id, params.doctorId) });
    const name = doctor?.displayName?.trim() || doctor?.fullName || "Médico";
    const time = formatSaoPauloTime(params.endedAt);
    let text = buildChiefKickAnnouncement(params.seed, { name, target: params.targetCode, time });
    if (isStoredEarlyDepartureOutcome(params.earlyDepartureOutcome)) {
        text += `\n${buildEarlyDepartureSummary(params.earlyDepartureOutcome, { name })}`;
    }

    const results = await Promise.allSettled(groupChatIds.map((chatId) => sendMessage(chatId, text)));
    for (const result of results) {
        if (result.status === "rejected") {
            console.error("chief kick announcement failed", result.reason);
        }
    }
}

/**
 * Anuncia no grupo as ocupações fechadas por uma desativação de posto/base.
 * Desativar com ocupante é uma retirada decidida pela chefia — o grupo precisa
 * ficar sabendo da saída e do desfecho de pagamento/banco, como no "Retirar".
 */
export async function announceDeactivationDepartures(params: {
    domain: "regulation" | "intervention";
    targetId: number;
    closedOccupancies: Array<{ id: string; doctorId: string; endedAt: Date; earlyDepartureOutcome: string | null }>;
}) {
    if (params.closedOccupancies.length === 0) return;

    const groupChatIds = getTelegramAnnouncementChatIds();
    if (groupChatIds.length === 0) return;

    const db = getDb();
    const target = params.domain === "regulation"
        ? await db.query.regulationPosts.findFirst({ where: eq(regulationPosts.id, params.targetId) })
        : await db.query.interventionBases.findFirst({ where: eq(interventionBases.id, params.targetId) });
    const targetCode = target?.code ?? String(params.targetId);

    for (const occupancy of params.closedOccupancies) {
        const doctor = await db.query.doctors.findFirst({ where: eq(doctors.id, occupancy.doctorId) });
        const name = doctor?.displayName?.trim() || doctor?.fullName || "Médico";
        const time = formatSaoPauloTime(occupancy.endedAt);
        let text = buildDeactivationDepartureAnnouncement(occupancy.id, { name, target: targetCode, time });
        if (isStoredEarlyDepartureOutcome(occupancy.earlyDepartureOutcome)) {
            text += `\n${buildEarlyDepartureSummary(occupancy.earlyDepartureOutcome, { name })}`;
        }

        const results = await Promise.allSettled(groupChatIds.map((chatId) => sendMessage(chatId, text)));
        for (const result of results) {
            if (result.status === "rejected") {
                console.error("deactivation departure announcement failed", result.reason);
            }
        }
    }
}

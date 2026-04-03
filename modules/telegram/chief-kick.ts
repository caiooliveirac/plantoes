import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { doctors, interventionBases, regulationPosts } from "@/db/schema";
import { sendMessage } from "@/modules/telegram/api";
import { getTelegramAnnouncementChatIds } from "@/modules/telegram/config";
import { buildChiefKickAnnouncement } from "@/modules/telegram/replies";

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
}) {
    const groupChatIds = getTelegramAnnouncementChatIds();
    if (groupChatIds.length === 0) return;

    const db = getDb();
    const doctor = await db.query.doctors.findFirst({ where: eq(doctors.id, params.doctorId) });
    const name = doctor?.displayName?.trim() || doctor?.fullName || "Médico";
    const time = formatSaoPauloTime(params.endedAt);
    const text = buildChiefKickAnnouncement(params.seed, { name, target: params.targetCode, time });

    const results = await Promise.allSettled(groupChatIds.map((chatId) => sendMessage(chatId, text)));
    for (const result of results) {
        if (result.status === "rejected") {
            console.error("chief kick announcement failed", result.reason);
        }
    }
}

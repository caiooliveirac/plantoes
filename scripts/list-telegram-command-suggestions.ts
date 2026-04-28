import { and, desc, eq, gte, lt } from "drizzle-orm";
import { closeDb, getDb } from "@/db";
import { telegramIngestedMessages } from "@/db/schema";
import { suggestTelegramCommandHelp, type TelegramRecentSenderMessage } from "@/modules/telegram/command-suggestions";

function getFlagValue(flag: string) {
    const prefix = `${flag}=`;
    return process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length) ?? null;
}

function parsePositiveInt(raw: string | null, fallback: number) {
    if (!raw) {
        return fallback;
    }

    const parsed = Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new Error(`Valor invalido: ${raw}`);
    }

    return parsed;
}

function parseDateStart(raw: string | null) {
    if (!raw) {
        const now = new Date();
        now.setHours(0, 0, 0, 0);
        return now;
    }

    const parsed = new Date(`${raw}T00:00:00-03:00`);
    if (Number.isNaN(parsed.getTime())) {
        throw new Error(`Data invalida: ${raw}`);
    }
    return parsed;
}

async function main() {
    const sender = getFlagValue("--sender");
    if (!sender) {
        throw new Error("Use --sender='2031 CHEFE'");
    }

    const limit = parsePositiveInt(getFlagValue("--limit"), 50);
    const dayStart = parseDateStart(getFlagValue("--date"));
    const db = getDb();

    const rows = await db.select()
        .from(telegramIngestedMessages)
        .where(and(
            eq(telegramIngestedMessages.senderName, sender),
            gte(telegramIngestedMessages.createdAt, dayStart),
        ))
        .orderBy(desc(telegramIngestedMessages.createdAt))
        .limit(limit);

    const items: Array<Record<string, unknown>> = [];

    for (const row of rows.reverse()) {
        if (row.status === "accepted" && !row.errorMessage) {
            continue;
        }

        const recent = await db.select({
            rawText: telegramIngestedMessages.rawText,
            parsedAction: telegramIngestedMessages.parsedAction,
            parsedTargetCode: telegramIngestedMessages.parsedTargetCode,
            parsedDoctorName: telegramIngestedMessages.parsedDoctorName,
            status: telegramIngestedMessages.status,
            errorMessage: telegramIngestedMessages.errorMessage,
        })
            .from(telegramIngestedMessages)
            .where(and(
                eq(telegramIngestedMessages.chatId, row.chatId),
                eq(telegramIngestedMessages.senderName, sender),
                lt(telegramIngestedMessages.createdAt, row.createdAt),
            ))
            .orderBy(desc(telegramIngestedMessages.createdAt))
            .limit(5);

        const suggestion = suggestTelegramCommandHelp({
            text: row.rawText,
            recentMessages: recent as TelegramRecentSenderMessage[],
        });

        items.push({
            createdAt: row.createdAt.toISOString(),
            rawText: row.rawText,
            status: row.status,
            errorMessage: row.errorMessage,
            suggestion,
        });
    }

    console.log(JSON.stringify({ sender, dayStart: dayStart.toISOString(), items }, null, 2));
}

main()
    .catch((error) => {
        console.error(error instanceof Error ? error.message : error);
        process.exitCode = 1;
    })
    .finally(async () => {
        await closeDb();
    });
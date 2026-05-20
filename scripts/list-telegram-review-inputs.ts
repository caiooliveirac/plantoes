import { desc } from "drizzle-orm";
import { closeDb, getDb } from "@/db";
import { telegramIngestedMessages } from "@/db/schema";

const DEFAULT_FETCH_LIMIT = 300;
const DEFAULT_OUTPUT_LIMIT = 50;

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
        throw new Error(`Valor invalido para ${raw}. Use inteiro positivo.`);
    }

    return parsed;
}

function isReviewRequired(value: unknown) {
    if (!value || typeof value !== "object") {
        return false;
    }

    return (value as Record<string, unknown>).reviewRequired === true;
}

async function main() {
    const fetchLimit = parsePositiveInt(getFlagValue("--fetch"), DEFAULT_FETCH_LIMIT);
    const outputLimit = parsePositiveInt(getFlagValue("--limit"), DEFAULT_OUTPUT_LIMIT);
    const db = getDb();

    const rows = await db.query.telegramIngestedMessages.findMany({
        orderBy: [desc(telegramIngestedMessages.createdAt)],
        limit: fetchLimit,
    });

    const items = rows
        .filter((row) => isReviewRequired(row.resolutionData))
        .slice(0, outputLimit)
        .map((row) => {
            const resolutionData = row.resolutionData && typeof row.resolutionData === "object"
                ? row.resolutionData as Record<string, unknown>
                : {};

            return {
                createdAt: row.createdAt.toISOString(),
                status: row.status,
                chatId: row.chatId,
                senderName: row.senderName,
                parsedDomain: row.parsedDomain,
                parsedTargetCode: row.parsedTargetCode,
                parsedAction: row.parsedAction,
                reviewReason: resolutionData.reviewReason ?? null,
                reviewSummary: resolutionData.reviewSummary ?? null,
                reviewDoctorQuery: resolutionData.reviewDoctorQuery ?? null,
                reviewSuggestedFormat: resolutionData.reviewSuggestedFormat ?? null,
                rawText: row.rawText,
            };
        });

    console.log(JSON.stringify({
        fetched: rows.length,
        returned: items.length,
        items,
    }, null, 2));
}

main()
    .catch((error) => {
        console.error(error instanceof Error ? error.message : error);
        process.exitCode = 1;
    })
    .finally(async () => {
        await closeDb();
    });
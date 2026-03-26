import { eq } from "drizzle-orm";
import { closeDb, getDb } from "@/db";
import { interventionOccupancies, regulationOccupancies, telegramIngestedMessages } from "@/db/schema";
import { correctInterventionOccupancy, correctRegulationOccupancy } from "@/modules/operational/corrections";
import { resolveTelegramEventTime } from "@/modules/operational/rules";
import { parseMessageMulti } from "@/modules/telegram/parser";

type Mismatch = {
    logId: string;
    occupancyId: string;
    domain: "INTERVENTION" | "REGULATION";
    doctorName: string | null;
    targetCode: string;
    rawText: string;
    createdAt: string;
    expectedStartedAt: string;
    actualStartedAt: string;
};

function hasApplyFlag() {
    return process.argv.includes("--apply");
}

async function collectArrivalMismatches(limit = 300) {
    const db = getDb();
    const logs = await db.query.telegramIngestedMessages.findMany({
        where: eq(telegramIngestedMessages.status, "accepted"),
        orderBy: (table, { desc }) => [desc(table.createdAt)],
        limit,
    });

    const mismatches: Mismatch[] = [];
    for (const log of logs) {
        if (!log.relatedOccupancyId) {
            continue;
        }

        const parsed = parseMessageMulti(log.rawText).find((entry) => entry.baseCode && entry.sector);
        if (!parsed || parsed.isDeparture || !parsed.arrivalTime) {
            continue;
        }

        const expectedStartedAt = resolveTelegramEventTime(log.createdAt, parsed.arrivalTime);
        if (parsed.sector === "REGULATION") {
            const occupancy = await db.query.regulationOccupancies.findFirst({
                where: eq(regulationOccupancies.id, log.relatedOccupancyId),
            });
            if (!occupancy) {
                continue;
            }

            if (occupancy.startedAt.getTime() !== expectedStartedAt.getTime()) {
                mismatches.push({
                    logId: log.id,
                    occupancyId: occupancy.id,
                    domain: "REGULATION",
                    doctorName: log.parsedDoctorName,
                    targetCode: parsed.baseCode!,
                    rawText: log.rawText,
                    createdAt: log.createdAt.toISOString(),
                    expectedStartedAt: expectedStartedAt.toISOString(),
                    actualStartedAt: occupancy.startedAt.toISOString(),
                });
            }
            continue;
        }

        const occupancy = await db.query.interventionOccupancies.findFirst({
            where: eq(interventionOccupancies.id, log.relatedOccupancyId),
        });
        if (!occupancy) {
            continue;
        }

        if (occupancy.startedAt.getTime() !== expectedStartedAt.getTime()) {
            mismatches.push({
                logId: log.id,
                occupancyId: occupancy.id,
                domain: "INTERVENTION",
                doctorName: log.parsedDoctorName,
                targetCode: parsed.baseCode!,
                rawText: log.rawText,
                createdAt: log.createdAt.toISOString(),
                expectedStartedAt: expectedStartedAt.toISOString(),
                actualStartedAt: occupancy.startedAt.toISOString(),
            });
        }
    }

    return mismatches;
}

async function applyArrivalMismatch(mismatch: Mismatch) {
    const nextStartedAt = new Date(mismatch.expectedStartedAt);
    if (mismatch.domain === "REGULATION") {
        await correctRegulationOccupancy(mismatch.occupancyId, {
            startedAt: nextStartedAt,
            boardStartedAt: nextStartedAt,
        }, null);
        return;
    }

    await correctInterventionOccupancy(mismatch.occupancyId, {
        startedAt: nextStartedAt,
        boardStartedAt: nextStartedAt,
    }, null);
}

async function main() {
    const apply = hasApplyFlag();
    const mismatches = await collectArrivalMismatches();
    console.log(JSON.stringify({ count: mismatches.length, mismatches }, null, 2));

    if (!apply || mismatches.length === 0) {
        await closeDb();
        return;
    }

    for (const mismatch of mismatches) {
        await applyArrivalMismatch(mismatch);
    }

    console.log(JSON.stringify({ applied: mismatches.length }, null, 2));
    await closeDb();
}

main().catch(async (error) => {
    console.error(error);
    await closeDb().catch(() => undefined);
    process.exitCode = 1;
});
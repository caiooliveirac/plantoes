import { and, eq, inArray, lt, or } from "drizzle-orm";
import { closeDb, getDb } from "@/db";
import { interventionOccupancies, regulationOccupancies } from "@/db/schema";
import { syncBankHoursByContinuityGroup } from "@/modules/bank-hours/service";
import { inferInterventionCoverageWindow, inferRegulationCoverageWindow } from "@/modules/operational/rules";

type BrokenOccupancyPreview = {
    domain: "regulation" | "intervention";
    occupancyId: string;
    targetCode: string;
    doctorId: string;
    continuityGroupId: string;
    shiftLabel: "SD" | "SN";
    startedAt: string;
    storedScheduledStartAt: string | null;
    storedScheduledEndAt: string | null;
    desiredScheduledStartAt: string | null;
    desiredScheduledEndAt: string | null;
};

function hasFlag(flag: string) {
    return process.argv.includes(flag);
}

function getFlagValue(flag: string) {
    const prefix = `${flag}=`;
    return process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length) ?? null;
}

function parseSinceDate() {
    const raw = getFlagValue("--since");
    if (!raw) {
        return null;
    }

    const normalized = raw.length === 10 ? `${raw}T00:00:00.000Z` : raw;
    const parsed = new Date(normalized);
    if (Number.isNaN(parsed.getTime())) {
        throw new Error(`Data invalida para --since: ${raw}`);
    }

    return parsed;
}

function normalizeShiftLabel(value: string | null | undefined): "SD" | "SN" | null {
    return value === "SD" || value === "SN" ? value : null;
}

function buildRegulationWindow(startedAt: Date, shiftLabel: "SD" | "SN") {
    return inferRegulationCoverageWindow({
        startedAt,
        shiftLabel,
        explicitScheduledStartAt: null,
        explicitScheduledEndAt: null,
    });
}

function buildInterventionWindow(startedAt: Date, shiftLabel: "SD" | "SN") {
    return inferInterventionCoverageWindow({
        startedAt,
        shiftLabel,
        explicitScheduledStartAt: null,
        explicitScheduledEndAt: null,
    });
}

async function listBrokenRegulationOccupancies(since: Date | null) {
    const db = getDb();
    return db.query.regulationOccupancies.findMany({
        where: and(
            or(eq(regulationOccupancies.shiftLabel, "SD"), eq(regulationOccupancies.shiftLabel, "SN")),
            lt(regulationOccupancies.scheduledEndAt, regulationOccupancies.startedAt),
            since ? lt(regulationOccupancies.startedAt, new Date("9999-12-31T00:00:00.000Z")) : undefined,
            since ? inArray(regulationOccupancies.id, (await db.query.regulationOccupancies.findMany({
                where: and(
                    or(eq(regulationOccupancies.shiftLabel, "SD"), eq(regulationOccupancies.shiftLabel, "SN")),
                    lt(regulationOccupancies.scheduledEndAt, regulationOccupancies.startedAt),
                ),
                columns: { id: true, startedAt: true },
            })).filter((row) => row.startedAt >= since).map((row) => row.id)) : undefined,
        ),
    });
}

async function listBrokenInterventionOccupancies(since: Date | null) {
    const db = getDb();
    return db.query.interventionOccupancies.findMany({
        where: and(
            or(eq(interventionOccupancies.shiftLabel, "SD"), eq(interventionOccupancies.shiftLabel, "SN")),
            lt(interventionOccupancies.scheduledEndAt, interventionOccupancies.startedAt),
            since ? lt(interventionOccupancies.startedAt, new Date("9999-12-31T00:00:00.000Z")) : undefined,
            since ? inArray(interventionOccupancies.id, (await db.query.interventionOccupancies.findMany({
                where: and(
                    or(eq(interventionOccupancies.shiftLabel, "SD"), eq(interventionOccupancies.shiftLabel, "SN")),
                    lt(interventionOccupancies.scheduledEndAt, interventionOccupancies.startedAt),
                ),
                columns: { id: true, startedAt: true },
            })).filter((row) => row.startedAt >= since).map((row) => row.id)) : undefined,
        ),
    });
}

async function buildPreview(since: Date | null) {
    const db = getDb();
    const [regulationPosts, interventionBases, regulationRows, interventionRows] = await Promise.all([
        db.query.regulationPosts.findMany({ columns: { id: true, code: true } }),
        db.query.interventionBases.findMany({ columns: { id: true, code: true } }),
        listBrokenRegulationOccupancies(since),
        listBrokenInterventionOccupancies(since),
    ]);
    const regulationCodeById = new Map(regulationPosts.map((row) => [row.id, row.code]));
    const interventionCodeById = new Map(interventionBases.map((row) => [row.id, row.code]));

    const preview: BrokenOccupancyPreview[] = [];

    for (const row of regulationRows) {
        const shiftLabel = normalizeShiftLabel(row.shiftLabel);
        if (!shiftLabel || !row.continuityGroupId) {
            continue;
        }

        const desired = buildRegulationWindow(row.startedAt, shiftLabel);
        preview.push({
            domain: "regulation",
            occupancyId: row.id,
            targetCode: regulationCodeById.get(row.postId) ?? String(row.postId),
            doctorId: row.doctorId,
            continuityGroupId: row.continuityGroupId,
            shiftLabel,
            startedAt: row.startedAt.toISOString(),
            storedScheduledStartAt: row.scheduledStartAt?.toISOString() ?? null,
            storedScheduledEndAt: row.scheduledEndAt?.toISOString() ?? null,
            desiredScheduledStartAt: desired.scheduledStartAt?.toISOString() ?? null,
            desiredScheduledEndAt: desired.scheduledEndAt?.toISOString() ?? null,
        });
    }

    for (const row of interventionRows) {
        const shiftLabel = normalizeShiftLabel(row.shiftLabel);
        if (!shiftLabel || !row.continuityGroupId) {
            continue;
        }

        const desired = buildInterventionWindow(row.startedAt, shiftLabel);
        preview.push({
            domain: "intervention",
            occupancyId: row.id,
            targetCode: interventionCodeById.get(row.baseId) ?? String(row.baseId),
            doctorId: row.doctorId,
            continuityGroupId: row.continuityGroupId,
            shiftLabel,
            startedAt: row.startedAt.toISOString(),
            storedScheduledStartAt: row.scheduledStartAt?.toISOString() ?? null,
            storedScheduledEndAt: row.scheduledEndAt?.toISOString() ?? null,
            desiredScheduledStartAt: desired.scheduledStartAt?.toISOString() ?? null,
            desiredScheduledEndAt: desired.scheduledEndAt?.toISOString() ?? null,
        });
    }

    return preview.sort((left, right) => left.startedAt.localeCompare(right.startedAt, "pt-BR"));
}

async function applyRepair(preview: BrokenOccupancyPreview[]) {
    const db = getDb();
    const touchedGroups = new Set<string>();

    for (const row of preview) {
        if (row.domain === "regulation") {
            await db.update(regulationOccupancies)
                .set({
                    scheduledStartAt: row.desiredScheduledStartAt ? new Date(row.desiredScheduledStartAt) : null,
                    scheduledEndAt: row.desiredScheduledEndAt ? new Date(row.desiredScheduledEndAt) : null,
                    updatedAt: new Date(),
                })
                .where(eq(regulationOccupancies.id, row.occupancyId));
        } else {
            await db.update(interventionOccupancies)
                .set({
                    scheduledStartAt: row.desiredScheduledStartAt ? new Date(row.desiredScheduledStartAt) : null,
                    scheduledEndAt: row.desiredScheduledEndAt ? new Date(row.desiredScheduledEndAt) : null,
                    updatedAt: new Date(),
                })
                .where(eq(interventionOccupancies.id, row.occupancyId));
        }

        touchedGroups.add(row.continuityGroupId);
    }

    for (const continuityGroupId of touchedGroups) {
        await syncBankHoursByContinuityGroup(db, continuityGroupId);
    }

    return {
        repairedOccupancies: preview.length,
        rebuiltContinuityGroups: touchedGroups.size,
        continuityGroupIds: [...touchedGroups],
    };
}

async function main() {
    const since = parseSinceDate();
    const apply = hasFlag("--apply");
    const preview = await buildPreview(since);

    console.log(JSON.stringify({
        mode: apply ? "apply" : "preview",
        since: since?.toISOString() ?? null,
        brokenCount: preview.length,
        preview: preview.slice(0, 100),
    }, null, 2));

    if (!apply || preview.length === 0) {
        await closeDb();
        return;
    }

    const result = await applyRepair(preview);
    console.log(JSON.stringify(result, null, 2));
    await closeDb();
}

main().catch(async (error) => {
    console.error(error);
    await closeDb().catch(() => undefined);
    process.exitCode = 1;
});
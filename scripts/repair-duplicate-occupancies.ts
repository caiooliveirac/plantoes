import { closeDb, getDb } from "@/db";
import { interventionBases, interventionOccupancies, regulationOccupancies, regulationPosts } from "@/db/schema";
import { removeInterventionOccupancyRecord, removeRegulationOccupancyRecord } from "@/modules/operational/corrections";

type DuplicateSnapshot = {
    domain: "regulation" | "intervention";
    occupancyId: string;
    doctorId: string;
    targetCode: string;
    startedAt: string;
    endedAt: string | null;
    actualEndedAt: string | null;
    continuityGroupId: string;
    notes: string | null;
};

type DuplicatePreview = {
    domain: "regulation" | "intervention";
    doctorId: string;
    targetCode: string;
    startedAt: string;
    keepOccupancyId: string;
    removeOccupancyIds: string[];
    reasons: string[];
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

function resolveEffectiveEndedAt(row: DuplicateSnapshot) {
    return row.actualEndedAt ?? row.endedAt ?? null;
}

function resolveDurationMinutes(row: DuplicateSnapshot) {
    const effectiveEndedAt = resolveEffectiveEndedAt(row);
    if (!effectiveEndedAt) {
        return null;
    }

    return Math.round((new Date(effectiveEndedAt).getTime() - new Date(row.startedAt).getTime()) / 60000);
}

function rankDuplicateCandidate(row: DuplicateSnapshot) {
    let score = 0;
    if (!resolveEffectiveEndedAt(row)) {
        score += 1000;
    }

    const durationMinutes = resolveDurationMinutes(row);
    if (durationMinutes === null) {
        score += 200;
    } else if (durationMinutes > 0) {
        score += 100 + Math.min(durationMinutes, 1440);
    } else {
        score -= 500;
    }

    if ((row.notes ?? "").toLowerCase().includes("debug command correction")) {
        score -= 300;
    }

    return score;
}

function explainGhost(row: DuplicateSnapshot) {
    const durationMinutes = resolveDurationMinutes(row);
    if (durationMinutes !== null && durationMinutes <= 0) {
        return durationMinutes === 0 ? "duracao_zero" : "cronologia_invalida";
    }

    if ((row.notes ?? "").toLowerCase().includes("debug command correction")) {
        return "debug_correction";
    }

    if (!resolveEffectiveEndedAt(row)) {
        return "aberta_duplicada_perdida_no_desempate";
    }

    return "duplicata_mesmo_inicio";
}

async function listDuplicateSnapshots(since: Date | null) {
    const db = getDb();
    const [posts, bases, regulation, intervention] = await Promise.all([
        db.query.regulationPosts.findMany({ columns: { id: true, code: true } }),
        db.query.interventionBases.findMany({ columns: { id: true, code: true } }),
        db.query.regulationOccupancies.findMany({
            where: (fields, operators) => since ? operators.gte(fields.startedAt, since) : undefined,
        }),
        db.query.interventionOccupancies.findMany({
            where: (fields, operators) => since ? operators.gte(fields.startedAt, since) : undefined,
        }),
    ]);
    const postCodeById = new Map(posts.map((row) => [row.id, row.code]));
    const baseCodeById = new Map(bases.map((row) => [row.id, row.code]));

    return [
        ...regulation.map((row: typeof regulationOccupancies.$inferSelect) => ({
            domain: "regulation" as const,
            occupancyId: row.id,
            doctorId: row.doctorId,
            targetCode: postCodeById.get(row.postId) ?? String(row.postId),
            startedAt: row.startedAt.toISOString(),
            endedAt: row.endedAt?.toISOString() ?? null,
            actualEndedAt: row.actualEndedAt?.toISOString() ?? null,
            continuityGroupId: row.continuityGroupId,
            notes: row.notes,
        })),
        ...intervention.map((row: typeof interventionOccupancies.$inferSelect) => ({
            domain: "intervention" as const,
            occupancyId: row.id,
            doctorId: row.doctorId,
            targetCode: baseCodeById.get(row.baseId) ?? String(row.baseId),
            startedAt: row.startedAt.toISOString(),
            endedAt: row.endedAt?.toISOString() ?? null,
            actualEndedAt: row.actualEndedAt?.toISOString() ?? null,
            continuityGroupId: row.continuityGroupId,
            notes: row.notes,
        })),
    ] satisfies DuplicateSnapshot[];
}

function buildPreview(rows: DuplicateSnapshot[]) {
    const grouped = new Map<string, DuplicateSnapshot[]>();
    for (const row of rows) {
        const key = [row.domain, row.doctorId, row.targetCode, row.startedAt].join("|");
        const current = grouped.get(key) ?? [];
        current.push(row);
        grouped.set(key, current);
    }

    const preview: DuplicatePreview[] = [];
    for (const bucket of grouped.values()) {
        if (bucket.length < 2) {
            continue;
        }

        const ranked = [...bucket].sort((left, right) => rankDuplicateCandidate(right) - rankDuplicateCandidate(left));
        const keep = ranked[0] as DuplicateSnapshot;
        const remove = ranked.slice(1);
        if (remove.length === 0) {
            continue;
        }

        preview.push({
            domain: keep.domain,
            doctorId: keep.doctorId,
            targetCode: keep.targetCode,
            startedAt: keep.startedAt,
            keepOccupancyId: keep.occupancyId,
            removeOccupancyIds: remove.map((row) => row.occupancyId),
            reasons: remove.map(explainGhost),
        });
    }

    return preview.sort((left, right) => left.startedAt.localeCompare(right.startedAt, "pt-BR"));
}

async function applyPreview(preview: DuplicatePreview[]) {
    const removedIds: string[] = [];

    for (const item of preview) {
        for (const occupancyId of item.removeOccupancyIds) {
            if (item.domain === "regulation") {
                await removeRegulationOccupancyRecord(occupancyId, null);
            } else {
                await removeInterventionOccupancyRecord(occupancyId, null);
            }

            removedIds.push(occupancyId);
        }
    }

    return {
        removedCount: removedIds.length,
        removedIds,
    };
}

async function main() {
    const since = parseSinceDate();
    const apply = hasFlag("--apply");
    const rows = await listDuplicateSnapshots(since);
    const preview = buildPreview(rows);

    console.log(JSON.stringify({
        mode: apply ? "apply" : "preview",
        since: since?.toISOString() ?? null,
        duplicateGroupCount: preview.length,
        preview,
    }, null, 2));

    if (!apply || preview.length === 0) {
        await closeDb();
        return;
    }

    const result = await applyPreview(preview);
    console.log(JSON.stringify(result, null, 2));
    await closeDb();
}

main().catch(async (error) => {
    console.error(error);
    await closeDb().catch(() => undefined);
    process.exitCode = 1;
});
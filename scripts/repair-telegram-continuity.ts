import { eq, gte } from "drizzle-orm";
import { closeDb, getDb } from "@/db";
import { doctors, interventionBases, interventionOccupancies, regulationOccupancies, regulationPosts } from "@/db/schema";
import { syncBankHoursByContinuityGroup } from "@/modules/bank-hours/service";

const REPAIR_LINK_WINDOW_MS = 30 * 60 * 1000;
const CONTINUATION_NOTE_PATTERN = /continu|permane/i;

type OperationalOccupancySnapshot = {
    domain: "regulation" | "intervention";
    occupancyId: string;
    doctorId: string;
    doctorName: string;
    targetCode: string;
    continuityGroupId: string | null;
    startedAt: Date;
    endedAt: Date | null;
    actualEndedAt: Date | null;
    shiftLabel: "SD" | "SN" | "P" | null;
    source: string | null;
    notes: string | null;
};

type ProposedMerge = {
    doctorId: string;
    doctorName: string;
    previousOccupancyId: string;
    nextOccupancyId: string;
    previousTargetCode: string;
    nextTargetCode: string;
    previousShiftLabel: string | null;
    nextShiftLabel: string | null;
    previousGroupId: string;
    nextGroupId: string;
    resultingGroupId: string;
    gapMinutes: number;
    evidence: string[];
};

function normalizeShiftLabel(value: string | null): OperationalOccupancySnapshot["shiftLabel"] {
    return value === "SD" || value === "SN" || value === "P" ? value : null;
}

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

function resolveEndedAt(occupancy: OperationalOccupancySnapshot) {
    return occupancy.actualEndedAt ?? occupancy.endedAt;
}

function findGroupRoot(groupId: string, aliases: Map<string, string>): string {
    const parent = aliases.get(groupId);
    if (!parent) {
        return groupId;
    }

    const root = findGroupRoot(parent, aliases);
    if (root !== parent) {
        aliases.set(groupId, root);
    }

    return root;
}

function inspectRepairCandidate(previous: OperationalOccupancySnapshot, next: OperationalOccupancySnapshot) {
    const previousEndedAt = resolveEndedAt(previous);
    if (!previousEndedAt || !previous.continuityGroupId || !next.continuityGroupId) {
        return null;
    }

    const gapMs = next.startedAt.getTime() - previousEndedAt.getTime();
    if (gapMs < 0 || gapMs > REPAIR_LINK_WINDOW_MS) {
        return null;
    }

    const evidence: string[] = [];
    if (previous.shiftLabel && next.shiftLabel && previous.shiftLabel !== next.shiftLabel) {
        evidence.push(`virada-${previous.shiftLabel}-${next.shiftLabel}`);
    }

    if (previous.shiftLabel === "P" || next.shiftLabel === "P") {
        evidence.push("shift-p");
    }

    if (CONTINUATION_NOTE_PATTERN.test(next.notes ?? "")) {
        evidence.push("nota-continuacao");
    }

    if (evidence.length === 0) {
        return null;
    }

    return {
        gapMinutes: Number((gapMs / 60000).toFixed(1)),
        evidence,
    };
}

async function listTelegramOperationalOccupancies(since: Date | null) {
    const db = getDb();
    const [doctorRows, postRows, baseRows, regulation, intervention] = await Promise.all([
        db.query.doctors.findMany(),
        db.query.regulationPosts.findMany(),
        db.query.interventionBases.findMany(),
        db.query.regulationOccupancies.findMany({
            where: since ? gte(regulationOccupancies.startedAt, since) : undefined,
            orderBy: (fields, operators) => [
                operators.asc(fields.doctorId),
                operators.asc(fields.startedAt),
            ],
        }),
        db.query.interventionOccupancies.findMany({
            where: since ? gte(interventionOccupancies.startedAt, since) : undefined,
            orderBy: (fields, operators) => [
                operators.asc(fields.doctorId),
                operators.asc(fields.startedAt),
            ],
        }),
    ]);
    const doctorNameById = new Map(doctorRows.map((doctor: typeof doctors.$inferSelect) => [doctor.id, doctor.fullName]));
    const postCodeById = new Map(postRows.map((post: typeof regulationPosts.$inferSelect) => [post.id, post.code]));
    const baseCodeById = new Map(baseRows.map((base: typeof interventionBases.$inferSelect) => [base.id, base.code]));

    return [
        ...regulation
            .filter((occupancy: typeof regulationOccupancies.$inferSelect) => occupancy.source === "telegram")
            .map((occupancy: typeof regulationOccupancies.$inferSelect) => ({
                domain: "regulation" as const,
                occupancyId: occupancy.id,
                doctorId: occupancy.doctorId,
                doctorName: doctorNameById.get(occupancy.doctorId) ?? occupancy.doctorId,
                targetCode: postCodeById.get(occupancy.postId) ?? String(occupancy.postId),
                continuityGroupId: occupancy.continuityGroupId,
                startedAt: occupancy.startedAt,
                endedAt: occupancy.endedAt,
                actualEndedAt: occupancy.actualEndedAt,
                shiftLabel: normalizeShiftLabel(occupancy.shiftLabel),
                source: occupancy.source,
                notes: occupancy.notes,
            })),
        ...intervention
            .filter((occupancy: typeof interventionOccupancies.$inferSelect) => occupancy.source === "telegram")
            .map((occupancy: typeof interventionOccupancies.$inferSelect) => ({
                domain: "intervention" as const,
                occupancyId: occupancy.id,
                doctorId: occupancy.doctorId,
                doctorName: doctorNameById.get(occupancy.doctorId) ?? occupancy.doctorId,
                targetCode: baseCodeById.get(occupancy.baseId) ?? String(occupancy.baseId),
                continuityGroupId: occupancy.continuityGroupId,
                startedAt: occupancy.startedAt,
                endedAt: occupancy.endedAt,
                actualEndedAt: occupancy.actualEndedAt,
                shiftLabel: normalizeShiftLabel(occupancy.shiftLabel),
                source: occupancy.source,
                notes: occupancy.notes,
            })),
    ].sort((left, right) => {
        const byDoctor = left.doctorId.localeCompare(right.doctorId, "pt-BR");
        if (byDoctor !== 0) {
            return byDoctor;
        }

        const byStartedAt = left.startedAt.getTime() - right.startedAt.getTime();
        if (byStartedAt !== 0) {
            return byStartedAt;
        }

        return left.occupancyId.localeCompare(right.occupancyId, "pt-BR");
    });
}

function buildRepairPlan(occupancies: OperationalOccupancySnapshot[]) {
    const aliases = new Map<string, string>();
    const merges: ProposedMerge[] = [];

    const occupanciesByDoctor = new Map<string, OperationalOccupancySnapshot[]>();
    for (const occupancy of occupancies) {
        const current = occupanciesByDoctor.get(occupancy.doctorId) ?? [];
        current.push(occupancy);
        occupanciesByDoctor.set(occupancy.doctorId, current);
    }

    for (const doctorOccupancies of occupanciesByDoctor.values()) {
        const ordered = [...doctorOccupancies].sort((left, right) => left.startedAt.getTime() - right.startedAt.getTime());
        for (let index = 1; index < ordered.length; index += 1) {
            const previous = ordered[index - 1] as OperationalOccupancySnapshot;
            const next = ordered[index] as OperationalOccupancySnapshot;
            if (!previous.continuityGroupId || !next.continuityGroupId) {
                continue;
            }

            const previousGroupId = findGroupRoot(previous.continuityGroupId, aliases);
            const nextGroupId = findGroupRoot(next.continuityGroupId, aliases);
            if (previousGroupId === nextGroupId) {
                continue;
            }

            const candidate = inspectRepairCandidate(previous, next);
            if (!candidate) {
                continue;
            }

            aliases.set(nextGroupId, previousGroupId);
            merges.push({
                doctorId: next.doctorId,
                doctorName: next.doctorName,
                previousOccupancyId: previous.occupancyId,
                nextOccupancyId: next.occupancyId,
                previousTargetCode: previous.targetCode,
                nextTargetCode: next.targetCode,
                previousShiftLabel: previous.shiftLabel,
                nextShiftLabel: next.shiftLabel,
                previousGroupId,
                nextGroupId,
                resultingGroupId: previousGroupId,
                gapMinutes: candidate.gapMinutes,
                evidence: candidate.evidence,
            });
        }
    }

    const replacements = new Map<string, string>();
    for (const groupId of aliases.keys()) {
        const root = findGroupRoot(groupId, aliases);
        if (root !== groupId) {
            replacements.set(groupId, root);
        }
    }

    return {
        merges,
        replacements,
    };
}

async function applyRepairPlan(replacements: Map<string, string>) {
    const db = getDb();
    const rebuiltGroups = new Set<string>();

    for (const [fromGroupId, toGroupId] of replacements.entries()) {
        await db.update(regulationOccupancies)
            .set({ continuityGroupId: toGroupId, updatedAt: new Date() })
            .where(eq(regulationOccupancies.continuityGroupId, fromGroupId));
        await db.update(interventionOccupancies)
            .set({ continuityGroupId: toGroupId, updatedAt: new Date() })
            .where(eq(interventionOccupancies.continuityGroupId, fromGroupId));
        rebuiltGroups.add(toGroupId);
    }

    for (const continuityGroupId of rebuiltGroups) {
        await syncBankHoursByContinuityGroup(db, continuityGroupId);
    }

    return {
        replacedGroups: replacements.size,
        rebuiltGroups: [...rebuiltGroups],
    };
}

async function main() {
    const since = parseSinceDate();
    const apply = hasFlag("--apply");
    const occupancies = await listTelegramOperationalOccupancies(since);
    const plan = buildRepairPlan(occupancies);

    console.log(JSON.stringify({
        mode: apply ? "apply" : "preview",
        since: since?.toISOString() ?? null,
        linkWindowMinutes: REPAIR_LINK_WINDOW_MS / 60000,
        telegramOccupancyCount: occupancies.length,
        mergeCount: plan.merges.length,
        replacementCount: plan.replacements.size,
        preview: plan.merges.slice(0, 100),
    }, null, 2));

    if (!apply || plan.replacements.size === 0) {
        await closeDb();
        return;
    }

    const applied = await applyRepairPlan(plan.replacements);
    console.log(JSON.stringify(applied, null, 2));
    await closeDb();
}

main().catch(async (error) => {
    console.error(error);
    await closeDb().catch(() => undefined);
    process.exitCode = 1;
});
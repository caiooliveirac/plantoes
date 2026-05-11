// Saneamento dos registros afetados pelo continuation bug (audit Mai/2026).
//
// Bug original: em modules/telegram/service.ts, ao processar "Caio continua PR03"
// vindo de outro posto, o INSERT do novo registro recebia started_at do ANCHOR
// (07:10 — chegada original do médico no posto anterior) em vez do eventAt
// (20:03 — momento da mensagem). board_started_at já carrega o anchor
// corretamente; é o started_at que estava errado.
//
// Esse script identifica os registros afetados (telegram, shift_label="P",
// gap created_at - started_at > 6h, e que pertencem a uma cadeia de
// continuity_group_id que atravessa targets), e os corrige movendo o
// started_at para o created_at (o instante real em que o médico passou a
// ocupar este alvo). board_started_at permanece intacto, preservando a
// exibição da chegada original no painel e o cálculo do banco de horas.
//
// Uso:
//   npx tsx scripts/repair-continuation-startedat.ts             # preview
//   npx tsx scripts/repair-continuation-startedat.ts --since=2026-04-01
//   npx tsx scripts/repair-continuation-startedat.ts --apply     # executa
//
// Append-only-friendly: usamos UPDATE pontual no started_at e gravamos um
// shift_event de auditoria para cada correção.

import { and, eq, gte, sql } from "drizzle-orm";
import { closeDb, getDb } from "@/db";
import {
    doctors,
    interventionBases,
    interventionOccupancies,
    regulationOccupancies,
    regulationPosts,
    shiftEvents,
} from "@/db/schema";
import { syncBankHoursByContinuityGroup } from "@/modules/bank-hours/service";

const BACKDATE_THRESHOLD_MS = 6 * 60 * 60 * 1000;

type Candidate = {
    domain: "regulation" | "intervention";
    occupancyId: string;
    doctorId: string;
    doctorName: string;
    targetCode: string;
    continuityGroupId: string | null;
    startedAt: Date;
    createdAt: Date;
    boardStartedAt: Date | null;
    shiftLabel: string | null;
    notes: string | null;
    backdateHours: number;
    sourceTargetCode: string | null;
    sourceStartedAt: Date | null;
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

async function loadCandidates(since: Date | null): Promise<Candidate[]> {
    const db = getDb();
    const sinceFilter = since ?? new Date(0);

    const [doctorRows, postRows, baseRows, regulation, intervention] = await Promise.all([
        db.query.doctors.findMany(),
        db.query.regulationPosts.findMany(),
        db.query.interventionBases.findMany(),
        db.query.regulationOccupancies.findMany({
            where: and(
                eq(regulationOccupancies.source, "telegram"),
                gte(regulationOccupancies.startedAt, sinceFilter),
            ),
        }),
        db.query.interventionOccupancies.findMany({
            where: and(
                eq(interventionOccupancies.source, "telegram"),
                gte(interventionOccupancies.startedAt, sinceFilter),
            ),
        }),
    ]);

    const doctorNameById = new Map(doctorRows.map((row: typeof doctors.$inferSelect) => [row.id, row.fullName]));
    const postCodeById = new Map(postRows.map((row: typeof regulationPosts.$inferSelect) => [row.id, row.code]));
    const baseCodeById = new Map(baseRows.map((row: typeof interventionBases.$inferSelect) => [row.id, row.code]));

    const everyOccupancy: Array<Omit<Candidate, "backdateHours" | "sourceTargetCode" | "sourceStartedAt"> & { source: string | null }> = [];

    for (const occupancy of regulation) {
        everyOccupancy.push({
            domain: "regulation",
            occupancyId: occupancy.id,
            doctorId: occupancy.doctorId,
            doctorName: doctorNameById.get(occupancy.doctorId) ?? occupancy.doctorId,
            targetCode: postCodeById.get(occupancy.postId) ?? String(occupancy.postId),
            continuityGroupId: occupancy.continuityGroupId,
            startedAt: occupancy.startedAt,
            createdAt: occupancy.createdAt,
            boardStartedAt: occupancy.boardStartedAt,
            shiftLabel: occupancy.shiftLabel,
            notes: occupancy.notes,
            source: occupancy.source,
        });
    }
    for (const occupancy of intervention) {
        everyOccupancy.push({
            domain: "intervention",
            occupancyId: occupancy.id,
            doctorId: occupancy.doctorId,
            doctorName: doctorNameById.get(occupancy.doctorId) ?? occupancy.doctorId,
            targetCode: baseCodeById.get(occupancy.baseId) ?? String(occupancy.baseId),
            continuityGroupId: occupancy.continuityGroupId,
            startedAt: occupancy.startedAt,
            createdAt: occupancy.createdAt,
            boardStartedAt: occupancy.boardStartedAt,
            shiftLabel: occupancy.shiftLabel,
            notes: occupancy.notes,
            source: occupancy.source,
        });
    }

    const byGroup = new Map<string, typeof everyOccupancy>();
    for (const occupancy of everyOccupancy) {
        if (!occupancy.continuityGroupId) continue;
        const bucket = byGroup.get(occupancy.continuityGroupId) ?? [];
        bucket.push(occupancy);
        byGroup.set(occupancy.continuityGroupId, bucket);
    }

    const candidates: Candidate[] = [];
    for (const occupancy of everyOccupancy) {
        const backdateMs = occupancy.createdAt.getTime() - occupancy.startedAt.getTime();
        if (backdateMs <= BACKDATE_THRESHOLD_MS) continue;
        if (occupancy.shiftLabel !== "P") continue;
        if (!occupancy.continuityGroupId) continue;

        const groupSiblings = byGroup.get(occupancy.continuityGroupId) ?? [];
        // Cross-target signature: the bug ALWAYS leaves a sibling at a different
        // target_code in the same continuity_group. We pick the sibling with the
        // smallest backdate gap as the "original" arrival (or the earliest
        // started_at as a tiebreaker) — that's what would have happened without
        // the bug. The ghost is the current `occupancy`.
        const siblingsAtDifferentTarget = groupSiblings
            .filter((sibling) => (
                sibling.occupancyId !== occupancy.occupancyId
                && sibling.targetCode !== occupancy.targetCode
            ));
        if (siblingsAtDifferentTarget.length === 0) continue;

        const earlierSiblingAtDifferentTarget = siblingsAtDifferentTarget
            .slice()
            .sort((left, right) => left.startedAt.getTime() - right.startedAt.getTime())[0]!;

        candidates.push({
            domain: occupancy.domain,
            occupancyId: occupancy.occupancyId,
            doctorId: occupancy.doctorId,
            doctorName: occupancy.doctorName,
            targetCode: occupancy.targetCode,
            continuityGroupId: occupancy.continuityGroupId,
            startedAt: occupancy.startedAt,
            createdAt: occupancy.createdAt,
            boardStartedAt: occupancy.boardStartedAt,
            shiftLabel: occupancy.shiftLabel,
            notes: occupancy.notes,
            backdateHours: Number((backdateMs / (60 * 60 * 1000)).toFixed(2)),
            sourceTargetCode: earlierSiblingAtDifferentTarget.targetCode,
            sourceStartedAt: earlierSiblingAtDifferentTarget.startedAt,
        });
    }

    candidates.sort((left, right) => left.startedAt.getTime() - right.startedAt.getTime());
    return candidates;
}

async function applyRepair(candidate: Candidate) {
    const db = getDb();
    const newStartedAt = candidate.createdAt;
    const oldStartedAt = candidate.startedAt;

    if (candidate.domain === "regulation") {
        await db.update(regulationOccupancies)
            .set({
                startedAt: newStartedAt,
                updatedAt: new Date(),
                notes: appendRepairNote(candidate.notes, oldStartedAt),
            })
            .where(eq(regulationOccupancies.id, candidate.occupancyId));
    } else {
        await db.update(interventionOccupancies)
            .set({
                startedAt: newStartedAt,
                updatedAt: new Date(),
                notes: appendRepairNote(candidate.notes, oldStartedAt),
            })
            .where(eq(interventionOccupancies.id, candidate.occupancyId));
    }

    await db.insert(shiftEvents).values({
        domain: candidate.domain,
        entityId: candidate.occupancyId,
        entityType: candidate.domain === "regulation" ? "regulation_occupancy" : "intervention_occupancy",
        eventType: "continuation_startedat_repaired",
        actorLabel: "scripts/repair-continuation-startedat",
        occurredAt: new Date(),
        payload: sql`${JSON.stringify({
            previousStartedAt: oldStartedAt.toISOString(),
            newStartedAt: newStartedAt.toISOString(),
            boardStartedAt: candidate.boardStartedAt?.toISOString() ?? null,
            doctorId: candidate.doctorId,
            targetCode: candidate.targetCode,
            sourceTargetCode: candidate.sourceTargetCode,
            sourceStartedAt: candidate.sourceStartedAt?.toISOString() ?? null,
            continuityGroupId: candidate.continuityGroupId,
            backdateHours: candidate.backdateHours,
            note: "Saneamento do continuation bug — started_at movido para created_at (eventAt real). board_started_at intacto.",
        })}::jsonb`,
    });

    if (candidate.continuityGroupId) {
        await syncBankHoursByContinuityGroup(db, candidate.continuityGroupId);
    }
}

function appendRepairNote(existing: string | null, oldStartedAt: Date) {
    const tag = `[saneamento-continuation-bug: started_at antigo ${oldStartedAt.toISOString()}]`;
    if (!existing) return tag;
    if (existing.includes("saneamento-continuation-bug")) return existing;
    return `${existing}\n${tag}`;
}

async function main() {
    const since = parseSinceDate();
    const apply = hasFlag("--apply");
    const candidates = await loadCandidates(since);

    console.log(JSON.stringify({
        mode: apply ? "apply" : "preview",
        since: since?.toISOString() ?? null,
        backdateThresholdHours: BACKDATE_THRESHOLD_MS / (60 * 60 * 1000),
        candidateCount: candidates.length,
        preview: candidates.map((candidate) => ({
            domain: candidate.domain,
            occupancyId: candidate.occupancyId,
            doctorName: candidate.doctorName,
            targetCode: candidate.targetCode,
            sourceTargetCode: candidate.sourceTargetCode,
            shiftLabel: candidate.shiftLabel,
            startedAt: candidate.startedAt.toISOString(),
            createdAt: candidate.createdAt.toISOString(),
            boardStartedAt: candidate.boardStartedAt?.toISOString() ?? null,
            backdateHours: candidate.backdateHours,
            continuityGroupId: candidate.continuityGroupId,
        })),
    }, null, 2));

    if (!apply || candidates.length === 0) {
        await closeDb();
        return;
    }

    let repaired = 0;
    for (const candidate of candidates) {
        await applyRepair(candidate);
        repaired += 1;
    }

    console.log(JSON.stringify({ repaired }, null, 2));
    await closeDb();
}

main().catch(async (error) => {
    console.error(error);
    await closeDb().catch(() => undefined);
    process.exitCode = 1;
});

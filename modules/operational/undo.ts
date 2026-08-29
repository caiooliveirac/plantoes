/**
 * Operational Undo
 *
 * Purpose: Safely reverse the most recent correction, start, deletion, or transfer
 * performed by a chief within a short time window.
 *
 * Safety constraints:
 *   - 30-minute window: only undo actions created within the last 30 min
 *   - Own actions only: actor must match the requesting user
 *   - Most recent only: no later audit entry can exist for the same entity
 *   - Board conflict guard: target slot must not have been modified since the action
 *   - No undo of undo: actions with ".undone" suffix are not undoable
 *   - Mandatory reason: undo requires a written note
 *
 * Side effects:
 *   - Bank hours recalculation
 *   - Board state reconciliation
 *   - Live board event emission
 *   - Audit log entry with ".undone" action
 */
import { and, desc, eq, gt, isNull, ne } from "drizzle-orm";
import { getDb } from "@/db";
import {
    auditLogs,
    bankHoursEntries,
    interventionOccupancies,
    regulationOccupancies,
} from "@/db/schema";
import { publishBoardUpdate } from "@/lib/board-live";
import { syncBankHoursByContinuityGroup, syncInterventionBankHours, syncRegulationBankHours } from "@/modules/bank-hours/service";

export const UNDO_WINDOW_MS = 30 * 60 * 1000;

/** Admin undo window: 12 hours (Telegram private chat). */
export const ADMIN_UNDO_WINDOW_MS = 12 * 60 * 60 * 1000;

/** Options that relax safety constraints for admin-level undo (Telegram). */
export interface AdminUndoOptions {
    /** Use ADMIN_UNDO_WINDOW_MS instead of UNDO_WINDOW_MS. */
    adminWindow?: boolean;
    /** Skip the "own actions only" check — admin can undo any actor. */
    skipOwnerCheck?: boolean;
}

/** Actions that can be undone. */
const UNDOABLE_ACTIONS = [
    "regulation_occupancy.started",
    "regulation_occupancy.corrected",
    "regulation_occupancy.deleted",
    "intervention_occupancy.started",
    "intervention_occupancy.corrected",
    "intervention_occupancy.deleted",
    "operational_occupancy.transferred",
] as const;

type UndoableAction = typeof UNDOABLE_ACTIONS[number];

function isUndoableAction(action: string): action is UndoableAction {
    return (UNDOABLE_ACTIONS as readonly string[]).includes(action);
}

export interface UndoableEntry {
    auditLogId: string;
    action: string;
    entityType: string;
    entityId: string;
    createdAt: string;
    details: Record<string, unknown>;
}

export interface UndoEligibility {
    eligible: boolean;
    reason?: string;
    entry?: UndoableEntry;
}

export interface UndoResult {
    success: boolean;
    message: string;
    undoneAuditLogId: string;
}

type DbClient = ReturnType<typeof getDb>;
type DbTx = Parameters<Parameters<DbClient["transaction"]>[0]>[0];
type DbExecutor = DbClient | DbTx;

// ─── Eligibility Check ──────────────────────────────────────────────────

export async function checkUndoEligibility(
    auditLogId: string,
    userId: string,
    options?: AdminUndoOptions,
): Promise<UndoEligibility> {
    const db = getDb();

    const entry = await db.query.auditLogs.findFirst({
        where: eq(auditLogs.id, auditLogId),
    });

    if (!entry) {
        return { eligible: false, reason: "Registro de auditoria não encontrado." };
    }

    // Must be an undoable action type
    if (!isUndoableAction(entry.action)) {
        return { eligible: false, reason: "Este tipo de ação não pode ser desfeito." };
    }

    // No undo of undo
    if (entry.action.endsWith(".undone")) {
        return { eligible: false, reason: "Ações de desfazer não podem ser desfeitas novamente." };
    }

    // Must be own action (unless admin override)
    if (!options?.skipOwnerCheck && entry.actorUserId !== userId) {
        return { eligible: false, reason: "Você só pode desfazer suas próprias ações." };
    }

    // Must be within time window
    const windowMs = options?.adminWindow ? ADMIN_UNDO_WINDOW_MS : UNDO_WINDOW_MS;
    const elapsedMs = Date.now() - entry.createdAt.getTime();
    if (elapsedMs > windowMs) {
        const minutesAgo = Math.ceil(elapsedMs / 60_000);
        const limitLabel = options?.adminWindow ? "12h" : "30 min";
        return {
            eligible: false,
            reason: `Ação realizada há ${minutesAgo} min. O limite para desfazer é ${limitLabel}. Use correção manual.`,
        };
    }

    // Must be the most recent action on this entity
    const laterEntry = await db.query.auditLogs.findFirst({
        where: and(
            eq(auditLogs.entityType, entry.entityType),
            eq(auditLogs.entityId, entry.entityId),
            // ne(id) é obrigatório: created_at tem microssegundos no Postgres e
            // chega ao JS truncado no milissegundo, então gt(created_at, própria
            // data) casa com a PRÓPRIA linha. Sem isto, toda entrada era
            // considerada "superada por uma ação mais nova" — por si mesma — e o
            // /desfazer nunca listava nada.
            ne(auditLogs.id, entry.id),
            gt(auditLogs.createdAt, entry.createdAt),
        ),
        orderBy: [desc(auditLogs.createdAt)],
    });

    if (laterEntry) {
        return {
            eligible: false,
            reason: "Essa ocupação foi modificada após essa ação. Desfazer não é possível — use correção manual.",
        };
    }

    const details = (entry.details ?? {}) as Record<string, unknown>;

    return {
        eligible: true,
        entry: {
            auditLogId: entry.id,
            action: entry.action,
            entityType: entry.entityType,
            entityId: entry.entityId,
            createdAt: entry.createdAt.toISOString(),
            details,
        },
    };
}

// ─── Get Undoable Actions for a User ────────────────────────────────────

export async function getUndoableActions(userId: string, options?: AdminUndoOptions): Promise<UndoableEntry[]> {
    const db = getDb();
    const windowMs = options?.adminWindow ? ADMIN_UNDO_WINDOW_MS : UNDO_WINDOW_MS;
    const cutoff = new Date(Date.now() - windowMs);

    const conditions = [gt(auditLogs.createdAt, cutoff)];
    if (!options?.skipOwnerCheck) {
        conditions.push(eq(auditLogs.actorUserId, userId));
    }

    const recentEntries = await db
        .select()
        .from(auditLogs)
        .where(and(...conditions))
        .orderBy(desc(auditLogs.createdAt))
        .limit(20);

    const results: UndoableEntry[] = [];

    for (const entry of recentEntries) {
        if (!isUndoableAction(entry.action)) continue;

        // Check no later action on same entity
        const laterEntry = await db.query.auditLogs.findFirst({
            where: and(
                eq(auditLogs.entityType, entry.entityType),
                eq(auditLogs.entityId, entry.entityId),
                // Ver a nota em checkUndoEligibility: sem ne(id) a linha supera
                // a si mesma por causa dos microssegundos do Postgres.
                ne(auditLogs.id, entry.id),
                gt(auditLogs.createdAt, entry.createdAt),
            ),
        });

        if (laterEntry) continue;

        const details = (entry.details ?? {}) as Record<string, unknown>;
        results.push({
            auditLogId: entry.id,
            action: entry.action,
            entityType: entry.entityType,
            entityId: entry.entityId,
            createdAt: entry.createdAt.toISOString(),
            details,
        });
    }

    return results;
}

// ─── Undo Execution ─────────────────────────────────────────────────────

export async function undoAction(
    auditLogId: string,
    userId: string,
    notes: string,
    options?: AdminUndoOptions,
): Promise<UndoResult> {
    const eligibility = await checkUndoEligibility(auditLogId, userId, options);
    if (!eligibility.eligible || !eligibility.entry) {
        return {
            success: false,
            message: eligibility.reason ?? "Ação não pode ser desfeita.",
            undoneAuditLogId: auditLogId,
        };
    }

    const entry = eligibility.entry;
    const action = entry.action as UndoableAction;

    switch (action) {
        case "regulation_occupancy.started":
            return undoRegulationStart(entry, userId, notes);
        case "regulation_occupancy.corrected":
            return undoRegulationCorrection(entry, userId, notes);
        case "regulation_occupancy.deleted":
            return undoRegulationDeletion(entry, userId, notes);
        case "intervention_occupancy.started":
            return undoInterventionStart(entry, userId, notes);
        case "intervention_occupancy.corrected":
            return undoInterventionCorrection(entry, userId, notes);
        case "intervention_occupancy.deleted":
            return undoInterventionDeletion(entry, userId, notes);
        case "operational_occupancy.transferred":
            return undoTransfer(entry, userId, notes);
        default:
            return { success: false, message: "Tipo de ação não suportado para undo.", undoneAuditLogId: auditLogId };
    }
}

// ─── Undo: Regulation Start ────────────────────────────────────────────

async function undoRegulationStart(
    entry: UndoableEntry,
    userId: string,
    notes: string,
): Promise<UndoResult> {
    const db = getDb();
    const occupancyId = entry.entityId;

    const result = await db.transaction(async (tx) => {
        const occupancy = await tx.query.regulationOccupancies.findFirst({
            where: eq(regulationOccupancies.id, occupancyId),
        });

        if (!occupancy) {
            return { success: false, message: "Ocupação não encontrada — pode já ter sido removida." };
        }

        // Detect who was displaced: occupancy at same post closed exactly at this occupancy's startedAt
        const displaced = await tx.query.regulationOccupancies.findFirst({
            where: and(
                eq(regulationOccupancies.postId, occupancy.postId),
                eq(regulationOccupancies.endedAt, occupancy.startedAt),
                ne(regulationOccupancies.id, occupancy.id),
            ),
            orderBy: [desc(regulationOccupancies.startedAt)],
        });

        // Board conflict check: has someone ELSE been placed here since?
        const currentOccupant = await tx.query.regulationOccupancies.findFirst({
            where: and(
                eq(regulationOccupancies.postId, occupancy.postId),
                isNull(regulationOccupancies.endedAt),
                ne(regulationOccupancies.id, occupancy.id),
            ),
            orderBy: [desc(regulationOccupancies.startedAt)],
        });

        if (currentOccupant && currentOccupant.startedAt.getTime() > occupancy.startedAt.getTime()) {
            return {
                success: false,
                message: `O ramal foi ocupado por outro profissional após sua ação. Desfazer bloqueado.`,
            };
        }

        // Delete the occupancy and its bank hours
        await tx.delete(bankHoursEntries).where(eq(bankHoursEntries.regulationOccupancyId, occupancyId));
        await tx.delete(regulationOccupancies).where(eq(regulationOccupancies.id, occupancyId));

        // Restore displaced occupancy if found
        if (displaced) {
            await tx.update(regulationOccupancies)
                .set({
                    endedAt: null,
                    actualEndedAt: null,
                    updatedByUserId: userId,
                    updatedAt: new Date(),
                })
                .where(eq(regulationOccupancies.id, displaced.id));

            await syncRegulationBankHours(tx, displaced.id);
        }

        return { success: true, displacedId: displaced?.id ?? null };
    });

    if (!result.success) {
        return { success: false, message: result.message!, undoneAuditLogId: entry.auditLogId };
    }

    // Audit the undo
    await db.insert(auditLogs).values({
        actorUserId: userId,
        action: "regulation_occupancy.started.undone",
        entityType: "regulation_occupancy",
        entityId: occupancyId,
        details: {
            undoneAuditLogId: entry.auditLogId,
            notes,
            restoredDisplacedOccupancyId: result.displacedId ?? null,
        },
    });

    publishBoardUpdate("undo");
    return {
        success: true,
        message: result.displacedId
            ? "Ocupação removida e profissional anterior restaurado."
            : "Ocupação removida com sucesso.",
        undoneAuditLogId: entry.auditLogId,
    };
}

// ─── Undo: Regulation Correction ───────────────────────────────────────

async function undoRegulationCorrection(
    entry: UndoableEntry,
    userId: string,
    notes: string,
): Promise<UndoResult> {
    const db = getDb();
    const occupancyId = entry.entityId;
    const details = entry.details;

    // Check we have the beforeSnapshot or at least previous* fields
    const beforeSnapshot = details.beforeSnapshot as Record<string, unknown> | undefined;
    const hasPreviousFields = details.previousDoctorId || details.previousStartedAt || details.previousPostId;

    if (!beforeSnapshot && !hasPreviousFields) {
        return {
            success: false,
            message: "Dados insuficientes para desfazer esta correção. Use correção manual.",
            undoneAuditLogId: entry.auditLogId,
        };
    }

    await db.transaction(async (tx) => {
        const occupancy = await tx.query.regulationOccupancies.findFirst({
            where: eq(regulationOccupancies.id, occupancyId),
        });

        if (!occupancy) {
            throw new Error("Ocupação não encontrada — pode já ter sido removida.");
        }

        if (beforeSnapshot) {
            // Full snapshot available — restore all fields
            await tx.update(regulationOccupancies)
                .set({
                    doctorId: beforeSnapshot.doctorId as string,
                    postId: beforeSnapshot.postId as number,
                    startedAt: new Date(beforeSnapshot.startedAt as string),
                    boardStartedAt: new Date(beforeSnapshot.boardStartedAt as string),
                    endedAt: beforeSnapshot.endedAt ? new Date(beforeSnapshot.endedAt as string) : null,
                    actualEndedAt: beforeSnapshot.actualEndedAt ? new Date(beforeSnapshot.actualEndedAt as string) : null,
                    scheduledStartAt: beforeSnapshot.scheduledStartAt ? new Date(beforeSnapshot.scheduledStartAt as string) : null,
                    scheduledEndAt: beforeSnapshot.scheduledEndAt ? new Date(beforeSnapshot.scheduledEndAt as string) : null,
                    shiftLabel: (beforeSnapshot.shiftLabel as string | null) ?? null,
                    roleLabel: (beforeSnapshot.roleLabel as string | null) ?? null,
                    ramalLabel: (beforeSnapshot.ramalLabel as string | null) ?? null,
                    notes: (beforeSnapshot.notes as string | null) ?? null,
                    updatedByUserId: userId,
                    updatedAt: new Date(),
                })
                .where(eq(regulationOccupancies.id, occupancyId));
        } else {
            // Partial previous fields — restore what we have
            const updates: Record<string, unknown> = {
                updatedByUserId: userId,
                updatedAt: new Date(),
            };
            if (details.previousDoctorId) updates.doctorId = details.previousDoctorId;
            if (details.previousPostId) updates.postId = details.previousPostId;
            if (details.previousStartedAt) updates.startedAt = new Date(details.previousStartedAt as string);

            await tx.update(regulationOccupancies)
                .set(updates)
                .where(eq(regulationOccupancies.id, occupancyId));
        }

        await syncRegulationBankHours(tx, occupancyId);
    });

    await db.insert(auditLogs).values({
        actorUserId: userId,
        action: "regulation_occupancy.corrected.undone",
        entityType: "regulation_occupancy",
        entityId: occupancyId,
        details: {
            undoneAuditLogId: entry.auditLogId,
            notes,
        },
    });

    publishBoardUpdate("undo");
    return {
        success: true,
        message: "Correção desfeita — valores anteriores restaurados.",
        undoneAuditLogId: entry.auditLogId,
    };
}

// ─── Undo: Regulation Deletion ─────────────────────────────────────────

async function undoRegulationDeletion(
    entry: UndoableEntry,
    userId: string,
    notes: string,
): Promise<UndoResult> {
    const db = getDb();
    const details = entry.details;

    // Need enough info to recreate the occupancy
    if (!details.doctorId || !details.startedAt) {
        return {
            success: false,
            message: "Dados insuficientes para restaurar esta ocupação. Use cadastro manual.",
            undoneAuditLogId: entry.auditLogId,
        };
    }

    const beforeSnapshot = details.beforeSnapshot as Record<string, unknown> | undefined;
    const postId = (beforeSnapshot?.postId ?? details.postId) as number | undefined;

    if (!postId) {
        return {
            success: false,
            message: "Ramal original não identificado no registro. Use cadastro manual.",
            undoneAuditLogId: entry.auditLogId,
        };
    }

    // Check the target slot is not already occupied
    const currentOccupant = await db.query.regulationOccupancies.findFirst({
        where: and(
            eq(regulationOccupancies.postId, postId),
            isNull(regulationOccupancies.endedAt),
        ),
        orderBy: [desc(regulationOccupancies.startedAt)],
    });

    if (currentOccupant) {
        return {
            success: false,
            message: "O ramal já está ocupado. Desfazer remoção bloqueado para não gerar conflito.",
            undoneAuditLogId: entry.auditLogId,
        };
    }

    const result = await db.transaction(async (tx) => {
        const [created] = await tx.insert(regulationOccupancies)
            .values({
                doctorId: details.doctorId as string,
                continuityGroupId: (beforeSnapshot?.continuityGroupId ?? details.continuityGroupId) as string,
                postId,
                scheduledStartAt: beforeSnapshot?.scheduledStartAt ? new Date(beforeSnapshot.scheduledStartAt as string) : null,
                scheduledEndAt: beforeSnapshot?.scheduledEndAt ? new Date(beforeSnapshot.scheduledEndAt as string) : null,
                startedAt: new Date(details.startedAt as string),
                boardStartedAt: new Date((beforeSnapshot?.boardStartedAt ?? details.boardStartedAt ?? details.startedAt) as string),
                endedAt: details.endedAt ? new Date(details.endedAt as string) : null,
                actualEndedAt: details.actualEndedAt ? new Date(details.actualEndedAt as string) : null,
                shiftLabel: (beforeSnapshot?.shiftLabel ?? details.shiftLabel ?? null) as string | null,
                roleLabel: (beforeSnapshot?.roleLabel ?? details.roleLabel ?? null) as string | null,
                ramalLabel: (beforeSnapshot?.ramalLabel ?? details.ramalLabel ?? null) as string | null,
                source: "admin_correction" as const,
                notes: `[Restaurado via desfazer] ${notes}`,
                createdByUserId: userId,
                updatedByUserId: userId,
                updatedAt: new Date(),
            })
            .returning();

        await syncRegulationBankHours(tx, created.id);
        return created;
    });

    await db.insert(auditLogs).values({
        actorUserId: userId,
        action: "regulation_occupancy.deleted.undone",
        entityType: "regulation_occupancy",
        entityId: result.id,
        details: {
            undoneAuditLogId: entry.auditLogId,
            originalEntityId: entry.entityId,
            notes,
        },
    });

    publishBoardUpdate("undo");
    return {
        success: true,
        message: "Ocupação restaurada com sucesso.",
        undoneAuditLogId: entry.auditLogId,
    };
}

// ─── Undo: Intervention Start ──────────────────────────────────────────

async function undoInterventionStart(
    entry: UndoableEntry,
    userId: string,
    notes: string,
): Promise<UndoResult> {
    const db = getDb();
    const occupancyId = entry.entityId;

    const result = await db.transaction(async (tx) => {
        const occupancy = await tx.query.interventionOccupancies.findFirst({
            where: eq(interventionOccupancies.id, occupancyId),
        });

        if (!occupancy) {
            return { success: false, message: "Ocupação não encontrada — pode já ter sido removida." };
        }

        // Detect displaced: occupancy at same base closed exactly at this occupancy's startedAt
        const displaced = await tx.query.interventionOccupancies.findFirst({
            where: and(
                eq(interventionOccupancies.baseId, occupancy.baseId),
                eq(interventionOccupancies.endedAt, occupancy.startedAt),
                ne(interventionOccupancies.id, occupancy.id),
            ),
            orderBy: [desc(interventionOccupancies.startedAt)],
        });

        // Board conflict check
        const currentOccupant = await tx.query.interventionOccupancies.findFirst({
            where: and(
                eq(interventionOccupancies.baseId, occupancy.baseId),
                isNull(interventionOccupancies.endedAt),
                ne(interventionOccupancies.id, occupancy.id),
            ),
            orderBy: [desc(interventionOccupancies.startedAt)],
        });

        if (currentOccupant && currentOccupant.startedAt.getTime() > occupancy.startedAt.getTime()) {
            return {
                success: false,
                message: "A base foi ocupada por outro profissional após sua ação. Desfazer bloqueado.",
            };
        }

        // Delete the occupancy and its bank hours
        await tx.delete(bankHoursEntries).where(eq(bankHoursEntries.interventionOccupancyId, occupancyId));
        await tx.delete(interventionOccupancies).where(eq(interventionOccupancies.id, occupancyId));

        // Restore displaced
        if (displaced) {
            await tx.update(interventionOccupancies)
                .set({
                    endedAt: null,
                    actualEndedAt: null,
                    boardStartedAt: displaced.boardStartedAt ?? displaced.startedAt,
                    updatedByUserId: userId,
                    updatedAt: new Date(),
                })
                .where(eq(interventionOccupancies.id, displaced.id));

            await syncInterventionBankHours(tx, displaced.id);
        }

        return { success: true, displacedId: displaced?.id ?? null };
    });

    if (!result.success) {
        return { success: false, message: result.message!, undoneAuditLogId: entry.auditLogId };
    }

    await db.insert(auditLogs).values({
        actorUserId: userId,
        action: "intervention_occupancy.started.undone",
        entityType: "intervention_occupancy",
        entityId: occupancyId,
        details: {
            undoneAuditLogId: entry.auditLogId,
            notes,
            restoredDisplacedOccupancyId: result.displacedId ?? null,
        },
    });

    publishBoardUpdate("undo");
    return {
        success: true,
        message: result.displacedId
            ? "Ocupação removida e profissional anterior restaurado."
            : "Ocupação removida com sucesso.",
        undoneAuditLogId: entry.auditLogId,
    };
}

// ─── Undo: Intervention Correction ─────────────────────────────────────

async function undoInterventionCorrection(
    entry: UndoableEntry,
    userId: string,
    notes: string,
): Promise<UndoResult> {
    const db = getDb();
    const occupancyId = entry.entityId;
    const details = entry.details;

    const beforeSnapshot = details.beforeSnapshot as Record<string, unknown> | undefined;
    const hasPreviousFields = details.previousDoctorId || details.previousStartedAt;

    if (!beforeSnapshot && !hasPreviousFields) {
        return {
            success: false,
            message: "Dados insuficientes para desfazer esta correção. Use correção manual.",
            undoneAuditLogId: entry.auditLogId,
        };
    }

    await db.transaction(async (tx) => {
        const occupancy = await tx.query.interventionOccupancies.findFirst({
            where: eq(interventionOccupancies.id, occupancyId),
        });

        if (!occupancy) {
            throw new Error("Ocupação não encontrada — pode já ter sido removida.");
        }

        if (beforeSnapshot) {
            await tx.update(interventionOccupancies)
                .set({
                    doctorId: beforeSnapshot.doctorId as string,
                    baseId: beforeSnapshot.baseId as number,
                    startedAt: new Date(beforeSnapshot.startedAt as string),
                    boardStartedAt: beforeSnapshot.boardStartedAt ? new Date(beforeSnapshot.boardStartedAt as string) : null,
                    endedAt: beforeSnapshot.endedAt ? new Date(beforeSnapshot.endedAt as string) : null,
                    actualEndedAt: beforeSnapshot.actualEndedAt ? new Date(beforeSnapshot.actualEndedAt as string) : null,
                    scheduledStartAt: beforeSnapshot.scheduledStartAt ? new Date(beforeSnapshot.scheduledStartAt as string) : null,
                    scheduledEndAt: beforeSnapshot.scheduledEndAt ? new Date(beforeSnapshot.scheduledEndAt as string) : null,
                    shiftLabel: (beforeSnapshot.shiftLabel as string | null) ?? null,
                    roleLabel: (beforeSnapshot.roleLabel as string | null) ?? null,
                    notes: (beforeSnapshot.notes as string | null) ?? null,
                    updatedByUserId: userId,
                    updatedAt: new Date(),
                })
                .where(eq(interventionOccupancies.id, occupancyId));
        } else {
            const updates: Record<string, unknown> = {
                updatedByUserId: userId,
                updatedAt: new Date(),
            };
            if (details.previousDoctorId) updates.doctorId = details.previousDoctorId;
            if (details.previousStartedAt) updates.startedAt = new Date(details.previousStartedAt as string);

            await tx.update(interventionOccupancies)
                .set(updates)
                .where(eq(interventionOccupancies.id, occupancyId));
        }

        await syncInterventionBankHours(tx, occupancyId);
    });

    await db.insert(auditLogs).values({
        actorUserId: userId,
        action: "intervention_occupancy.corrected.undone",
        entityType: "intervention_occupancy",
        entityId: occupancyId,
        details: {
            undoneAuditLogId: entry.auditLogId,
            notes,
        },
    });

    publishBoardUpdate("undo");
    return {
        success: true,
        message: "Correção desfeita — valores anteriores restaurados.",
        undoneAuditLogId: entry.auditLogId,
    };
}

// ─── Undo: Intervention Deletion ───────────────────────────────────────

async function undoInterventionDeletion(
    entry: UndoableEntry,
    userId: string,
    notes: string,
): Promise<UndoResult> {
    const db = getDb();
    const details = entry.details;

    if (!details.doctorId || !details.startedAt) {
        return {
            success: false,
            message: "Dados insuficientes para restaurar esta ocupação. Use cadastro manual.",
            undoneAuditLogId: entry.auditLogId,
        };
    }

    const beforeSnapshot = details.beforeSnapshot as Record<string, unknown> | undefined;
    const baseId = (beforeSnapshot?.baseId ?? details.baseId) as number | undefined;

    if (!baseId) {
        return {
            success: false,
            message: "Base original não identificada no registro. Use cadastro manual.",
            undoneAuditLogId: entry.auditLogId,
        };
    }

    // Check the target slot is not already occupied
    const currentOccupant = await db.query.interventionOccupancies.findFirst({
        where: and(
            eq(interventionOccupancies.baseId, baseId),
            isNull(interventionOccupancies.endedAt),
        ),
        orderBy: [desc(interventionOccupancies.startedAt)],
    });

    if (currentOccupant) {
        return {
            success: false,
            message: "A base já está ocupada. Desfazer remoção bloqueado para não gerar conflito.",
            undoneAuditLogId: entry.auditLogId,
        };
    }

    const result = await db.transaction(async (tx) => {
        const [created] = await tx.insert(interventionOccupancies)
            .values({
                doctorId: details.doctorId as string,
                continuityGroupId: (beforeSnapshot?.continuityGroupId ?? details.continuityGroupId) as string,
                baseId,
                scheduledStartAt: beforeSnapshot?.scheduledStartAt ? new Date(beforeSnapshot.scheduledStartAt as string) : null,
                scheduledEndAt: beforeSnapshot?.scheduledEndAt ? new Date(beforeSnapshot.scheduledEndAt as string) : null,
                startedAt: new Date(details.startedAt as string),
                boardStartedAt: beforeSnapshot?.boardStartedAt
                    ? new Date(beforeSnapshot.boardStartedAt as string)
                    : new Date(details.startedAt as string),
                endedAt: details.endedAt ? new Date(details.endedAt as string) : null,
                actualEndedAt: details.actualEndedAt ? new Date(details.actualEndedAt as string) : null,
                shiftLabel: (beforeSnapshot?.shiftLabel ?? details.shiftLabel ?? null) as string | null,
                roleLabel: (beforeSnapshot?.roleLabel ?? details.roleLabel ?? null) as string | null,
                source: "admin_correction" as const,
                notes: `[Restaurado via desfazer] ${notes}`,
                createdByUserId: userId,
                updatedByUserId: userId,
                updatedAt: new Date(),
            })
            .returning();

        await syncInterventionBankHours(tx, created.id);
        return created;
    });

    if (!result?.id) {
        return {
            success: false,
            message: "Nao foi possivel restaurar a ocupacao removida.",
            undoneAuditLogId: entry.auditLogId,
        };
    }

    await db.insert(auditLogs).values({
        actorUserId: userId,
        action: "intervention_occupancy.deleted.undone",
        entityType: "intervention_occupancy",
        entityId: result.id,
        details: {
            undoneAuditLogId: entry.auditLogId,
            originalEntityId: entry.entityId,
            notes,
        },
    });

    publishBoardUpdate("undo");
    return {
        success: true,
        message: "Ocupação restaurada com sucesso.",
        undoneAuditLogId: entry.auditLogId,
    };
}

// ─── Undo: Transfer ────────────────────────────────────────────────────

async function undoTransfer(
    entry: UndoableEntry,
    userId: string,
    notes: string,
): Promise<UndoResult> {
    const db = getDb();
    const details = entry.details;
    const sourceSnapshot = parseUndoOccupancySnapshot(details.sourceSnapshot);
    const movedSnapshot = parseUndoOccupancySnapshot(details.movedSnapshot);
    const displacedData = parseUndoDisplacedData(details.displaced);

    if (!sourceSnapshot || !movedSnapshot) {
        return {
            success: false,
            message: "Este remanejamento foi registrado sem snapshot completo. Desfazer automatico bloqueado para evitar inconsistencias; use correção manual.",
            undoneAuditLogId: entry.auditLogId,
        };
    }

    const result = await db.transaction(async (tx) => {
        const touchedInterventionBases = new Set<number>();
        const touchedContinuityGroups = new Set<string>([
            sourceSnapshot.continuityGroupId,
            movedSnapshot.continuityGroupId,
            displacedData?.removedSnapshot.continuityGroupId,
            displacedData?.createdSnapshot?.continuityGroupId,
        ].filter((value): value is string => Boolean(value)));

        const movedExists = await findOccupancyBySnapshot(tx, movedSnapshot);
        if (!movedExists) {
            return { success: false, message: "A ocupação remanejada já não existe mais. Desfazer automático bloqueado." };
        }

        if (await hasOpenConflictAtTarget(tx, sourceSnapshot, [])) {
            return { success: false, message: "O posto/base de origem já foi reutilizado após o remanejamento. Desfazer automático bloqueado." };
        }

        if (displacedData && await hasOpenConflictAtTarget(tx, displacedData.removedSnapshot, [movedSnapshot.id])) {
            return { success: false, message: "O destino original já foi alterado depois do remanejamento. Desfazer automático bloqueado." };
        }

        if (displacedData?.createdSnapshot) {
            const relocatedExists = await findOccupancyBySnapshot(tx, displacedData.createdSnapshot);
            if (!relocatedExists) {
                return { success: false, message: "A ocupação remanejada do destino já foi alterada. Desfazer automático bloqueado." };
            }

            if (await hasOpenConflictAtTarget(tx, displacedData.createdSnapshot, [displacedData.createdSnapshot.id])) {
                return { success: false, message: "O destino alternativo do ocupante deslocado já mudou. Desfazer automático bloqueado." };
            }
        }

        await deleteOccupancyBySnapshot(tx, movedSnapshot);
        if (movedSnapshot.domain === "intervention") {
            touchedInterventionBases.add(movedSnapshot.targetId);
        }

        if (displacedData?.createdSnapshot) {
            await deleteOccupancyBySnapshot(tx, displacedData.createdSnapshot);
            if (displacedData.createdSnapshot.domain === "intervention") {
                touchedInterventionBases.add(displacedData.createdSnapshot.targetId);
            }
        }

        await restoreOccupancySnapshot(tx, sourceSnapshot, userId);
        if (sourceSnapshot.domain === "intervention") {
            touchedInterventionBases.add(sourceSnapshot.targetId);
        }

        if (displacedData) {
            await restoreOccupancySnapshot(tx, displacedData.removedSnapshot, userId);
            if (displacedData.removedSnapshot.domain === "intervention") {
                touchedInterventionBases.add(displacedData.removedSnapshot.targetId);
            }
        }

        for (const baseId of touchedInterventionBases) {
            await reconcileInterventionBoardStateForUndo(tx, baseId, userId);
        }

        for (const continuityGroupId of touchedContinuityGroups) {
            await syncBankHoursByContinuityGroup(tx, continuityGroupId);
        }

        return { success: true, movedOccupancyId: movedSnapshot.id };
    });

    if (!result.success) {
        return { success: false, message: result.message!, undoneAuditLogId: entry.auditLogId };
    }

    const movedOccupancyId = result.movedOccupancyId;
    if (!movedOccupancyId) {
        return {
            success: false,
            message: "Nao foi possivel identificar a ocupacao restaurada do remanejamento.",
            undoneAuditLogId: entry.auditLogId,
        };
    }

    await db.insert(auditLogs).values({
        actorUserId: userId,
        action: "operational_occupancy.transferred.undone",
        entityType: "operational_transfer",
        entityId: movedOccupancyId,
        details: {
            undoneAuditLogId: entry.auditLogId,
            notes,
        },
    });

    publishBoardUpdate("undo");
    return {
        success: true,
        message: "Remanejamento desfeito com restauração completa do estado anterior.",
        undoneAuditLogId: entry.auditLogId,
    };
}

interface UndoOccupancySnapshot {
    id: string;
    domain: "regulation" | "intervention";
    doctorId: string;
    continuityGroupId: string;
    source: string | null;
    targetId: number;
    startedAt: string;
    boardStartedAt: string | null;
    endedAt: string | null;
    actualEndedAt: string | null;
    scheduledStartAt: string | null;
    scheduledEndAt: string | null;
    shiftLabel: string | null;
    roleLabel: string | null;
    ramalLabel: string | null;
    notes: string | null;
}

function parseUndoOccupancySnapshot(value: unknown): UndoOccupancySnapshot | null {
    if (!value || typeof value !== "object") {
        return null;
    }

    const candidate = value as Record<string, unknown>;
    if ((candidate.domain !== "regulation" && candidate.domain !== "intervention") || typeof candidate.id !== "string") {
        return null;
    }

    return {
        id: candidate.id,
        domain: candidate.domain,
        doctorId: String(candidate.doctorId ?? ""),
        continuityGroupId: String(candidate.continuityGroupId ?? ""),
        source: typeof candidate.source === "string" ? candidate.source : null,
        targetId: Number(candidate.targetId),
        startedAt: String(candidate.startedAt ?? ""),
        boardStartedAt: typeof candidate.boardStartedAt === "string" ? candidate.boardStartedAt : null,
        endedAt: typeof candidate.endedAt === "string" ? candidate.endedAt : null,
        actualEndedAt: typeof candidate.actualEndedAt === "string" ? candidate.actualEndedAt : null,
        scheduledStartAt: typeof candidate.scheduledStartAt === "string" ? candidate.scheduledStartAt : null,
        scheduledEndAt: typeof candidate.scheduledEndAt === "string" ? candidate.scheduledEndAt : null,
        shiftLabel: typeof candidate.shiftLabel === "string" ? candidate.shiftLabel : null,
        roleLabel: typeof candidate.roleLabel === "string" ? candidate.roleLabel : null,
        ramalLabel: typeof candidate.ramalLabel === "string" ? candidate.ramalLabel : null,
        notes: typeof candidate.notes === "string" ? candidate.notes : null,
    };
}

function parseUndoDisplacedData(value: unknown) {
    if (!value || typeof value !== "object") {
        return null;
    }

    const candidate = value as Record<string, unknown>;
    const removedSnapshot = parseUndoOccupancySnapshot(candidate.removedSnapshot);
    if (!removedSnapshot) {
        return null;
    }

    return {
        removedSnapshot,
        createdSnapshot: parseUndoOccupancySnapshot(candidate.createdSnapshot),
    };
}

async function findOccupancyBySnapshot(tx: DbExecutor, snapshot: UndoOccupancySnapshot) {
    if (snapshot.domain === "regulation") {
        return tx.query.regulationOccupancies.findFirst({
            where: eq(regulationOccupancies.id, snapshot.id),
        });
    }

    return tx.query.interventionOccupancies.findFirst({
        where: eq(interventionOccupancies.id, snapshot.id),
    });
}

async function hasOpenConflictAtTarget(
    tx: DbExecutor,
    snapshot: UndoOccupancySnapshot,
    excludeIds: string[],
) {
    if (snapshot.domain === "regulation") {
        const conflict = await tx.query.regulationOccupancies.findFirst({
            where: and(
                eq(regulationOccupancies.postId, snapshot.targetId),
                isNull(regulationOccupancies.endedAt),
                ...excludeIds.map((id) => ne(regulationOccupancies.id, id)),
            ),
        });
        return Boolean(conflict);
    }

    const conflict = await tx.query.interventionOccupancies.findFirst({
        where: and(
            eq(interventionOccupancies.baseId, snapshot.targetId),
            isNull(interventionOccupancies.endedAt),
            ...excludeIds.map((id) => ne(interventionOccupancies.id, id)),
        ),
    });
    return Boolean(conflict);
}

async function deleteOccupancyBySnapshot(tx: DbExecutor, snapshot: UndoOccupancySnapshot) {
    if (snapshot.domain === "regulation") {
        await tx.delete(bankHoursEntries).where(eq(bankHoursEntries.regulationOccupancyId, snapshot.id));
        await tx.delete(regulationOccupancies).where(eq(regulationOccupancies.id, snapshot.id));
        return;
    }

    await tx.delete(bankHoursEntries).where(eq(bankHoursEntries.interventionOccupancyId, snapshot.id));
    await tx.delete(interventionOccupancies).where(eq(interventionOccupancies.id, snapshot.id));
}

async function restoreOccupancySnapshot(
    tx: DbExecutor,
    snapshot: UndoOccupancySnapshot,
    userId: string,
) {
    if (snapshot.domain === "regulation") {
        await tx.insert(regulationOccupancies).values({
            id: snapshot.id,
            doctorId: snapshot.doctorId,
            continuityGroupId: snapshot.continuityGroupId,
            postId: snapshot.targetId,
            scheduledStartAt: snapshot.scheduledStartAt ? new Date(snapshot.scheduledStartAt) : null,
            scheduledEndAt: snapshot.scheduledEndAt ? new Date(snapshot.scheduledEndAt) : null,
            startedAt: new Date(snapshot.startedAt),
            boardStartedAt: snapshot.boardStartedAt ? new Date(snapshot.boardStartedAt) : new Date(snapshot.startedAt),
            endedAt: snapshot.endedAt ? new Date(snapshot.endedAt) : null,
            actualEndedAt: snapshot.actualEndedAt ? new Date(snapshot.actualEndedAt) : null,
            shiftLabel: snapshot.shiftLabel,
            roleLabel: snapshot.roleLabel,
            ramalLabel: snapshot.ramalLabel,
            source: (snapshot.source as typeof regulationOccupancies.$inferInsert.source) ?? "admin_correction",
            notes: snapshot.notes,
            createdByUserId: null,
            updatedByUserId: userId,
            updatedAt: new Date(),
        });
        return;
    }

    await tx.insert(interventionOccupancies).values({
        id: snapshot.id,
        doctorId: snapshot.doctorId,
        continuityGroupId: snapshot.continuityGroupId,
        baseId: snapshot.targetId,
        scheduledStartAt: snapshot.scheduledStartAt ? new Date(snapshot.scheduledStartAt) : null,
        scheduledEndAt: snapshot.scheduledEndAt ? new Date(snapshot.scheduledEndAt) : null,
        startedAt: new Date(snapshot.startedAt),
        boardStartedAt: snapshot.boardStartedAt ? new Date(snapshot.boardStartedAt) : null,
        endedAt: snapshot.endedAt ? new Date(snapshot.endedAt) : null,
        actualEndedAt: snapshot.actualEndedAt ? new Date(snapshot.actualEndedAt) : null,
        shiftLabel: snapshot.shiftLabel,
        roleLabel: snapshot.roleLabel,
        source: (snapshot.source as typeof interventionOccupancies.$inferInsert.source) ?? "admin_correction",
        notes: snapshot.notes,
        createdByUserId: null,
        updatedByUserId: userId,
        updatedAt: new Date(),
    });
}

async function reconcileInterventionBoardStateForUndo(
    tx: DbExecutor,
    baseId: number,
    userId: string,
) {
    const openOccupancies = await tx.query.interventionOccupancies.findMany({
        where: and(
            eq(interventionOccupancies.baseId, baseId),
            isNull(interventionOccupancies.endedAt),
        ),
        orderBy: [desc(interventionOccupancies.boardStartedAt), desc(interventionOccupancies.startedAt)],
    });

    if (openOccupancies.length === 0) {
        return;
    }

    const carrier = openOccupancies.find((occupancy) => occupancy.boardStartedAt !== null) ?? openOccupancies[0];
    for (const occupancy of openOccupancies) {
        const nextBoardStartedAt = occupancy.id === carrier.id
            ? occupancy.boardStartedAt ?? occupancy.startedAt
            : null;
        await tx.update(interventionOccupancies)
            .set({
                boardStartedAt: nextBoardStartedAt,
                updatedByUserId: userId,
                updatedAt: new Date(),
            })
            .where(eq(interventionOccupancies.id, occupancy.id));
    }
}

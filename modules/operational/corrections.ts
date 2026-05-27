/**
 * Operational Occupancy Corrections
 *
 * Purpose: Correct, remove, and transfer regulation/intervention occupancies.
 * Used by chief-access UI and Telegram /corrigir commands.
 *
 * Source of truth for: occupancy time corrections, cross-target transfers,
 * and occupancy removal with proper bank-hours recalculation.
 *
 * DANGER: Zero test coverage (P0). Side effects include:
 *   - Bank hours recalculation (syncBankHoursByContinuityGroup)
 *   - Board state reconciliation (displacement, deactivation sync)
 *   - Live board event emission (publishBoardUpdate)
 *
 * Invariants:
 *   - startedAt < endedAt always (validated by validateChronology)
 *   - Transfers displace any existing open occupancy at the target
 *   - Removal cascades to bank-hours entries for that occupancy
 *   - actualEndedAt tracks the real departure; endedAt tracks scheduled handoff
 */
import { and, asc, desc, eq, isNull, ne, notInArray } from "drizzle-orm";
import { getDb } from "@/db";
import {
    bankHoursEntries,
    interventionBaseDeactivations,
    interventionBases,
    interventionOccupancies,
    regulationPostDeactivations,
    regulationOccupancies,
    regulationPosts,
} from "@/db/schema";
import { publishBoardUpdate } from "@/lib/board-live";
import { syncBankHoursByContinuityGroup, syncInterventionBankHours, syncRegulationBankHours } from "@/modules/bank-hours/service";
import { isInterventionBaseDeactivationActive } from "@/modules/intervention/service";
import { applyOperationalRoleShiftPolicy } from "@/modules/operational/roles";
import { resolveArrivalShiftLabel, resolveOperationalShiftWindow } from "@/modules/operational/board-rules";
import { inferInterventionCoverageWindow, inferRegulationCoverageWindow } from "@/modules/operational/rules";
import { normalizeRegulationRamalLabel } from "@/modules/regulation/ramal-label";
import { expireStaleRegulationOccupancies, isRegulationPostDeactivationActive } from "@/modules/regulation/service";

type OptionalDate = Date | null | undefined;
type Executor = any;
type OperationalDomain = "regulation" | "intervention";

interface OperationalTransferTargetInput {
    domain: OperationalDomain;
    targetId: number;
}

interface OccupancySnapshot {
    id: string;
    domain: OperationalDomain;
    doctorId: string;
    continuityGroupId: string;
    source: string | null;
    targetId: number;
    startedAt: Date;
    boardStartedAt: Date | null;
    endedAt: Date | null;
    actualEndedAt: Date | null;
    scheduledStartAt: Date | null;
    scheduledEndAt: Date | null;
    shiftLabel: string | null;
    roleLabel: string | null;
    ramalLabel: string | null;
    notes: string | null;
}

interface TargetMetadata extends OperationalTransferTargetInput {
    code: string;
    label: string;
}

interface TransferShiftWindow {
    shiftLabel: "SD" | "SN";
    startedAt: Date;
}

export interface TransferOperationalOccupancyInput {
    sourceDomain: OperationalDomain;
    destination: OperationalTransferTargetInput;
    roleLabel?: string | null;
    notes?: string | null;
    conflictResolution?: {
        strategy: "remove_destination" | "move_destination";
        relocationTarget?: OperationalTransferTargetInput | null;
    } | null;
}

export interface RegulationOccupancyCorrectionInput {
    postId?: number;
    doctorId?: string;
    startedAt?: Date;
    boardStartedAt?: Date;
    endedAt?: OptionalDate;
    actualEndedAt?: OptionalDate;
    shiftLabel?: string | null;
    roleLabel?: string | null;
    ramalLabel?: string | null;
    notes?: string | null;
    chiefConfirmed?: boolean;
}

export interface InterventionOccupancyCorrectionInput {
    doctorId?: string;
    startedAt?: Date;
    boardStartedAt?: OptionalDate;
    endedAt?: OptionalDate;
    actualEndedAt?: OptionalDate;
    shiftLabel?: string | null;
    roleLabel?: string | null;
    notes?: string | null;
    chiefConfirmed?: boolean;
}

// Departure confirmation policy for corrections:
//   - chiefConfirmed: true   → mark as freshly confirmed now
//   - chiefConfirmed: false  → revert to unconfirmed (pending chief review)
//   - chiefConfirmed: undef, actualEndedAt changed → revert (any silent time edit
//                              invalidates the prior confirmation)
//   - chiefConfirmed: undef, actualEndedAt unchanged → preserve existing
function resolveDepartureConfirmationOnCorrection(params: {
    chiefConfirmed: boolean | undefined;
    actualEndedAtChanged: boolean;
    existingConfirmedAt: Date | null;
}): Date | null {
    if (params.chiefConfirmed === true) {
        return new Date();
    }
    if (params.chiefConfirmed === false) {
        return null;
    }
    if (params.actualEndedAtChanged) {
        return null;
    }
    return params.existingConfirmedAt;
}

function resolveDepartureConfirmationByOnCorrection(params: {
    chiefConfirmed: boolean | undefined;
    actualEndedAtChanged: boolean;
    existingConfirmedBy: string | null;
    updatedByUserId: string | null;
}): string | null {
    if (params.chiefConfirmed === true) {
        return params.updatedByUserId;
    }
    if (params.chiefConfirmed === false) {
        return null;
    }
    if (params.actualEndedAtChanged) {
        return null;
    }
    return params.existingConfirmedBy;
}

function sameTarget(left: OperationalTransferTargetInput, right: OperationalTransferTargetInput) {
    return left.domain === right.domain && left.targetId === right.targetId;
}

export function mergeOperationalNotes(...segments: Array<string | null | undefined>) {
    const normalized = segments
        .map((segment) => segment?.trim())
        .filter((segment): segment is string => Boolean(segment));

    return normalized.length > 0 ? normalized.join("\n\n") : null;
}

function transferNoteLine(params: {
    source: TargetMetadata;
    destination: TargetMetadata;
    reason?: string | null;
}) {
    const reasonSuffix = params.reason?.trim() ? ` Motivo: ${params.reason.trim()}` : "";
    return `Remanejado de ${params.source.code} para ${params.destination.code}.${reasonSuffix}`;
}

function displaceNoteLine(params: {
    source: TargetMetadata;
    destination: TargetMetadata;
    reason?: string | null;
}) {
    const reasonSuffix = params.reason?.trim() ? ` Motivo: ${params.reason.trim()}` : "";
    return `Remanejado por conflito operacional de ${params.source.code} para ${params.destination.code}.${reasonSuffix}`;
}

function hasOwn<T extends object, K extends PropertyKey>(value: T, key: K): value is T & Record<K, unknown> {
    return Object.prototype.hasOwnProperty.call(value, key);
}

export function resolveTransferShiftWindow(referenceAt: Date): TransferShiftWindow {
    const currentWindow = resolveOperationalShiftWindow(referenceAt);
    const targetShiftLabel = resolveArrivalShiftLabel(referenceAt);
    if (targetShiftLabel === currentWindow.shiftLabel) {
        return {
            shiftLabel: currentWindow.shiftLabel,
            startedAt: currentWindow.startedAt,
        };
    }

    const nextWindow = resolveOperationalShiftWindow(currentWindow.nextBoundaryAt);
    return {
        shiftLabel: nextWindow.shiftLabel,
        startedAt: nextWindow.startedAt,
    };
}

export function filterTransferConflictsToShiftWindow<T extends {
    id: string;
    startedAt: Date;
    boardStartedAt: Date | null;
    scheduledStartAt: Date | null;
}>(occupancies: T[], transferShiftStartAt: Date) {
    return occupancies.filter((occupancy) => {
        const referenceStart = occupancy.scheduledStartAt ?? occupancy.boardStartedAt ?? occupancy.startedAt;
        return referenceStart.getTime() >= transferShiftStartAt.getTime();
    });
}

export function validateChronology(startedAt: Date, boardStartedAt: Date | null, endedAt: Date | null, actualEndedAt: Date | null) {
    if (boardStartedAt && boardStartedAt.getTime() < startedAt.getTime()) {
        throw new Error("Board start cannot be before the recorded arrival.");
    }
    if (endedAt && endedAt.getTime() < startedAt.getTime()) {
        throw new Error("Board end cannot be before the recorded arrival.");
    }
    if (actualEndedAt && actualEndedAt.getTime() < startedAt.getTime()) {
        throw new Error("Actual end cannot be before the recorded arrival.");
    }
    if (endedAt && boardStartedAt && endedAt.getTime() < boardStartedAt.getTime()) {
        throw new Error("Board end cannot be before the board start.");
    }
}

export function validateCorrectionChronology(params: {
    startedAt: Date;
    boardStartedAt: Date | null;
    endedAt: Date | null;
    actualEndedAt: Date | null;
    startedAtChanged?: boolean;
    boardStartedAtChanged?: boolean;
    endedAtChanged?: boolean;
    actualEndedAtChanged?: boolean;
}) {
    if ((params.startedAtChanged || params.boardStartedAtChanged) && params.boardStartedAt && params.boardStartedAt.getTime() < params.startedAt.getTime()) {
        throw new Error("Board start cannot be before the recorded arrival.");
    }
    if ((params.startedAtChanged || params.endedAtChanged) && params.endedAt && params.endedAt.getTime() < params.startedAt.getTime()) {
        throw new Error("Board end cannot be before the recorded arrival.");
    }
    if ((params.startedAtChanged || params.actualEndedAtChanged) && params.actualEndedAt && params.actualEndedAt.getTime() < params.startedAt.getTime()) {
        throw new Error("Actual end cannot be before the recorded arrival.");
    }
    if ((params.endedAtChanged || params.boardStartedAtChanged) && params.endedAt && params.boardStartedAt && params.endedAt.getTime() < params.boardStartedAt.getTime()) {
        throw new Error("Board end cannot be before the board start.");
    }
}

async function reconcileInterventionBoardState(tx: Executor, baseId: number, updatedByUserId?: string | null) {
    const openOccupancies: Array<typeof interventionOccupancies.$inferSelect> = await tx.query.interventionOccupancies.findMany({
        where: and(
            eq(interventionOccupancies.baseId, baseId),
            isNull(interventionOccupancies.endedAt),
        ),
        orderBy: [asc(interventionOccupancies.startedAt)],
    });

    if (openOccupancies.length === 0) {
        return;
    }

    const currentCarrier = openOccupancies.find((occupancy) => occupancy.boardStartedAt !== null) ?? null;
    if (currentCarrier) {
        for (const occupancy of openOccupancies) {
            const nextBoardStartedAt = occupancy.id === currentCarrier.id ? occupancy.boardStartedAt : null;
            if ((occupancy.boardStartedAt?.getTime() ?? null) !== (nextBoardStartedAt?.getTime() ?? null)) {
                await tx.update(interventionOccupancies)
                    .set({
                        boardStartedAt: nextBoardStartedAt,
                        updatedAt: new Date(),
                        updatedByUserId: updatedByUserId ?? null,
                    })
                    .where(eq(interventionOccupancies.id, occupancy.id));
            }
        }
        return;
    }

    const latestEnded: typeof interventionOccupancies.$inferSelect | undefined = await tx.query.interventionOccupancies.findFirst({
        where: and(
            eq(interventionOccupancies.baseId, baseId),
        ),
        orderBy: [desc(interventionOccupancies.endedAt), asc(interventionOccupancies.startedAt)],
    });

    const nextCarrier = latestEnded?.endedAt
        ? openOccupancies.find((occupancy) => occupancy.startedAt.getTime() <= latestEnded.endedAt!.getTime()) ?? openOccupancies[0]
        : openOccupancies[0];

    for (const occupancy of openOccupancies) {
        const nextBoardStartedAt = occupancy.id === nextCarrier.id
            ? latestEnded?.endedAt ?? occupancy.startedAt
            : null;
        if ((occupancy.boardStartedAt?.getTime() ?? null) !== (nextBoardStartedAt?.getTime() ?? null)) {
            await tx.update(interventionOccupancies)
                .set({
                    boardStartedAt: nextBoardStartedAt,
                    updatedAt: new Date(),
                    updatedByUserId: updatedByUserId ?? null,
                })
                .where(eq(interventionOccupancies.id, occupancy.id));
        }
    }
}

async function loadOccupancySnapshot(tx: Executor, params: {
    domain: OperationalDomain;
    occupancyId: string;
}) {
    if (params.domain === "regulation") {
        const occupancy = await tx.query.regulationOccupancies.findFirst({
            where: eq(regulationOccupancies.id, params.occupancyId),
        });

        if (!occupancy) {
            throw new Error("Regulation occupancy not found.");
        }

        return {
            id: occupancy.id,
            domain: "regulation",
            doctorId: occupancy.doctorId,
            continuityGroupId: occupancy.continuityGroupId,
            source: occupancy.source,
            targetId: occupancy.postId,
            startedAt: occupancy.startedAt,
            boardStartedAt: occupancy.boardStartedAt,
            endedAt: occupancy.endedAt,
            actualEndedAt: occupancy.actualEndedAt,
            scheduledStartAt: occupancy.scheduledStartAt,
            scheduledEndAt: occupancy.scheduledEndAt,
            shiftLabel: occupancy.shiftLabel,
            roleLabel: occupancy.roleLabel,
            ramalLabel: occupancy.ramalLabel,
            notes: occupancy.notes,
        } satisfies OccupancySnapshot;
    }

    const occupancy = await tx.query.interventionOccupancies.findFirst({
        where: eq(interventionOccupancies.id, params.occupancyId),
    });

    if (!occupancy) {
        throw new Error("Intervention occupancy not found.");
    }

    return {
        id: occupancy.id,
        domain: "intervention",
        doctorId: occupancy.doctorId,
        continuityGroupId: occupancy.continuityGroupId,
        source: occupancy.source,
        targetId: occupancy.baseId,
        startedAt: occupancy.startedAt,
        boardStartedAt: occupancy.boardStartedAt,
        endedAt: occupancy.endedAt,
        actualEndedAt: occupancy.actualEndedAt,
        scheduledStartAt: occupancy.scheduledStartAt,
        scheduledEndAt: occupancy.scheduledEndAt,
        shiftLabel: occupancy.shiftLabel,
        roleLabel: occupancy.roleLabel,
        ramalLabel: null,
        notes: occupancy.notes,
    } satisfies OccupancySnapshot;
}

async function resolveTargetMetadata(tx: Executor, target: OperationalTransferTargetInput) {
    if (target.domain === "regulation") {
        const post = await tx.query.regulationPosts.findFirst({
            where: eq(regulationPosts.id, target.targetId),
        });

        if (!post || !post.isActive) {
            throw new Error("Ramal de destino indisponivel para este remanejamento.");
        }

        const activeDeactivation = await tx.query.regulationPostDeactivations.findFirst({
            where: and(
                eq(regulationPostDeactivations.postId, target.targetId),
                isNull(regulationPostDeactivations.reactivatedAt),
            ),
            orderBy: [desc(regulationPostDeactivations.deactivatedAt)],
        });

        if (activeDeactivation && isRegulationPostDeactivationActive({
            deactivatedAt: activeDeactivation.deactivatedAt,
            reactivatedAt: activeDeactivation.reactivatedAt,
            referenceAt: new Date(),
        })) {
            throw new Error(`O ramal ${post.code} esta desativado e nao pode receber remanejamento agora.`);
        }

        return {
            domain: "regulation",
            targetId: post.id,
            code: post.code,
            label: post.label,
        } satisfies TargetMetadata;
    }

    const base = await tx.query.interventionBases.findFirst({
        where: eq(interventionBases.id, target.targetId),
    });

    if (!base || !base.isActive) {
        throw new Error("Base de destino indisponivel para este remanejamento.");
    }

    const openDeactivation = await tx.query.interventionBaseDeactivations.findFirst({
        where: and(
            eq(interventionBaseDeactivations.baseId, target.targetId),
            isNull(interventionBaseDeactivations.reactivatedAt),
        ),
        orderBy: [desc(interventionBaseDeactivations.deactivatedAt)],
    });

    if (openDeactivation && isInterventionBaseDeactivationActive({
        deactivatedAt: openDeactivation.deactivatedAt,
        reactivatedAt: openDeactivation.reactivatedAt,
        referenceAt: new Date(),
    })) {
        throw new Error(`A base ${base.code} esta desativada e nao pode receber remanejamento agora.`);
    }

    return {
        domain: "intervention",
        targetId: base.id,
        code: base.code,
        label: base.label,
    } satisfies TargetMetadata;
}

async function findOpenTargetOccupancies(tx: Executor, params: {
    target: OperationalTransferTargetInput;
    excludeOccupancyIds?: string[];
}) {
    const excludeIds = [...new Set((params.excludeOccupancyIds ?? []).filter(Boolean))];

    if (params.target.domain === "regulation") {
        return tx.query.regulationOccupancies.findMany({
            where: and(
                eq(regulationOccupancies.postId, params.target.targetId),
                isNull(regulationOccupancies.endedAt),
                excludeIds.length > 0 ? notInArray(regulationOccupancies.id, excludeIds) : undefined,
            ),
            orderBy: [asc(regulationOccupancies.startedAt)],
        });
    }

    return tx.query.interventionOccupancies.findMany({
        where: and(
            eq(interventionOccupancies.baseId, params.target.targetId),
            isNull(interventionOccupancies.endedAt),
            excludeIds.length > 0 ? notInArray(interventionOccupancies.id, excludeIds) : undefined,
        ),
        orderBy: [asc(interventionOccupancies.startedAt)],
    });
}

async function deleteRegulationOccupancyTx(tx: Executor, occupancy: typeof regulationOccupancies.$inferSelect) {
    await tx.delete(bankHoursEntries).where(eq(bankHoursEntries.regulationOccupancyId, occupancy.id));
    const [deleted] = await tx.delete(regulationOccupancies)
        .where(eq(regulationOccupancies.id, occupancy.id))
        .returning();

    return deleted;
}

async function deleteInterventionOccupancyTx(tx: Executor, occupancy: typeof interventionOccupancies.$inferSelect) {
    await tx.delete(bankHoursEntries).where(eq(bankHoursEntries.interventionOccupancyId, occupancy.id));
    const [deleted] = await tx.delete(interventionOccupancies)
        .where(eq(interventionOccupancies.id, occupancy.id))
        .returning();

    return deleted;
}

async function cloneOccupancyIntoTarget(tx: Executor, params: {
    source: OccupancySnapshot;
    destination: TargetMetadata;
    roleLabel?: string | null;
    notes?: string | null;
    updatedByUserId?: string | null;
}) {
    if (params.destination.domain === "regulation") {
        const [created] = await tx.insert(regulationOccupancies)
            .values({
                doctorId: params.source.doctorId,
                continuityGroupId: params.source.continuityGroupId,
                postId: params.destination.targetId,
                scheduledStartAt: params.source.scheduledStartAt,
                scheduledEndAt: params.source.scheduledEndAt,
                startedAt: params.source.startedAt,
                boardStartedAt: params.source.boardStartedAt ?? params.source.startedAt,
                shiftLabel: params.source.shiftLabel,
                roleLabel: applyOperationalRoleShiftPolicy({
                    shiftLabel: params.source.shiftLabel === "SD" || params.source.shiftLabel === "SN" || params.source.shiftLabel === "P"
                        ? params.source.shiftLabel
                        : null,
                    roleLabel: params.roleLabel ?? params.source.roleLabel,
                }),
                ramalLabel: params.destination.code,
                source: "admin_correction",
                notes: params.notes ?? null,
                createdByUserId: params.updatedByUserId ?? null,
                updatedByUserId: params.updatedByUserId ?? null,
                updatedAt: new Date(),
            })
            .returning();

        return {
            id: created.id,
            domain: "regulation" as const,
            continuityGroupId: created.continuityGroupId,
            targetId: created.postId,
        };
    }

    const [created] = await tx.insert(interventionOccupancies)
        .values({
            doctorId: params.source.doctorId,
            continuityGroupId: params.source.continuityGroupId,
            baseId: params.destination.targetId,
            scheduledStartAt: params.source.scheduledStartAt,
            scheduledEndAt: params.source.scheduledEndAt,
            startedAt: params.source.startedAt,
            boardStartedAt: params.source.boardStartedAt ?? params.source.startedAt,
            shiftLabel: params.source.shiftLabel,
            roleLabel: applyOperationalRoleShiftPolicy({
                shiftLabel: params.source.shiftLabel === "SD" || params.source.shiftLabel === "SN" || params.source.shiftLabel === "P"
                    ? params.source.shiftLabel
                    : null,
                roleLabel: params.roleLabel ?? params.source.roleLabel,
            }),
            source: "admin_correction",
            notes: params.notes ?? null,
            createdByUserId: params.updatedByUserId ?? null,
            updatedByUserId: params.updatedByUserId ?? null,
            updatedAt: new Date(),
        })
        .returning();

    return {
        id: created.id,
        domain: "intervention" as const,
        continuityGroupId: created.continuityGroupId,
        targetId: created.baseId,
    };
}

export async function correctRegulationOccupancy(
    id: string,
    input: RegulationOccupancyCorrectionInput,
    updatedByUserId?: string | null,
) {
    const db = getDb();
    const updated = await db.transaction(async (tx) => {
        const existing = await tx.query.regulationOccupancies.findFirst({ where: eq(regulationOccupancies.id, id) });
        if (!existing) {
            throw new Error("Regulation occupancy not found.");
        }

        const startedAt = hasOwn(input, "startedAt") ? input.startedAt as Date : existing.startedAt;
        const boardStartedAt = hasOwn(input, "boardStartedAt") ? input.boardStartedAt as Date : existing.boardStartedAt;
        const endedAt = hasOwn(input, "endedAt") ? (input.endedAt ?? null) : existing.endedAt;
        const actualEndedAt = hasOwn(input, "actualEndedAt") ? (input.actualEndedAt ?? null) : existing.actualEndedAt;
        const postId = hasOwn(input, "postId") ? input.postId ?? existing.postId : existing.postId;
        const targetPost = await tx.query.regulationPosts.findFirst({
            where: eq(regulationPosts.id, postId),
            columns: {
                id: true,
                code: true,
                isActive: true,
            },
        });

        if (!targetPost || !targetPost.isActive) {
            throw new Error("Ramal de destino indisponivel para esta troca.");
        }

        // Only validate chronology when a temporal field is being edited.
        // Continuity occupancies legitimately have boardStartedAt < startedAt
        // (boardStartedAt = original arrival from previous shift, startedAt = continuation
        // entry on the new shift). Non-temporal corrections (roleLabel, notes) must not
        // trigger validation on pre-existing temporal state.
        const startedAtChanged = hasOwn(input, "startedAt");
        const boardStartedAtChanged = hasOwn(input, "boardStartedAt");
        const endedAtChanged = hasOwn(input, "endedAt");
        const actualEndedAtChanged = hasOwn(input, "actualEndedAt");
        if (startedAtChanged || boardStartedAtChanged || endedAtChanged || actualEndedAtChanged) {
            validateCorrectionChronology({
                startedAt,
                boardStartedAt,
                endedAt,
                actualEndedAt,
                startedAtChanged,
                boardStartedAtChanged,
                endedAtChanged,
                actualEndedAtChanged,
            });
        }

        // Recalculate scheduled window whenever startedAt or shiftLabel is corrected.
        // Without this, /corrigir would leave stale scheduled_start_at/scheduled_end_at
        // pointing at the wrong shift after an arrival-time or shift-label edit.
        // For continuity entries (boardStartedAt > startedAt), use boardStartedAt as
        // the window reference so the scheduled window matches the current shift.
        const nextShiftLabel = hasOwn(input, "shiftLabel") ? input.shiftLabel ?? null : existing.shiftLabel;
        const scheduledWindowChanged = hasOwn(input, "startedAt") || hasOwn(input, "shiftLabel") || hasOwn(input, "boardStartedAt");
        const windowReferenceAt = boardStartedAt && boardStartedAt.getTime() > startedAt.getTime()
            ? boardStartedAt
            : startedAt;
        const { scheduledStartAt: newScheduledStart, scheduledEndAt: newScheduledEnd } = scheduledWindowChanged
            ? inferRegulationCoverageWindow({
                startedAt: windowReferenceAt,
                shiftLabel: nextShiftLabel,
                postCode: targetPost.code,
                explicitScheduledStartAt: null,
                explicitScheduledEndAt: null,
            })
            : { scheduledStartAt: existing.scheduledStartAt, scheduledEndAt: existing.scheduledEndAt };

        if (postId !== existing.postId) {
            if (!endedAt) {
                const conflicting = await tx.query.regulationOccupancies.findFirst({
                    where: and(
                        eq(regulationOccupancies.postId, postId),
                        isNull(regulationOccupancies.endedAt),
                        ne(regulationOccupancies.id, id),
                    ),
                });

                if (conflicting) {
                    throw new Error(`O ramal ${targetPost.code} ja esta ocupado. Encerre ou mova a cobertura atual antes de reutilizar este posto.`);
                }
            }
        }

        const requestedRoleLabel = hasOwn(input, "roleLabel") ? input.roleLabel ?? null : existing.roleLabel;
        const sanitizedRoleLabel = applyOperationalRoleShiftPolicy({
            shiftLabel: nextShiftLabel === "SD" || nextShiftLabel === "SN" || nextShiftLabel === "P"
                ? nextShiftLabel
                : null,
            roleLabel: requestedRoleLabel,
        });

        const actualEndedAtTimeChanged = actualEndedAtChanged
            && (actualEndedAt?.getTime() ?? null) !== (existing.actualEndedAt?.getTime() ?? null);
        const departureConfirmedAtNext = resolveDepartureConfirmationOnCorrection({
            chiefConfirmed: input.chiefConfirmed,
            actualEndedAtChanged: actualEndedAtTimeChanged,
            existingConfirmedAt: existing.departureConfirmedAt,
        });
        const departureConfirmedByNext = resolveDepartureConfirmationByOnCorrection({
            chiefConfirmed: input.chiefConfirmed,
            actualEndedAtChanged: actualEndedAtTimeChanged,
            existingConfirmedBy: existing.departureConfirmedByUserId,
            updatedByUserId: updatedByUserId ?? null,
        });

        const [updated] = await tx.update(regulationOccupancies)
            .set({
                postId,
                doctorId: hasOwn(input, "doctorId") ? input.doctorId ?? existing.doctorId : existing.doctorId,
                startedAt,
                boardStartedAt,
                scheduledStartAt: newScheduledStart,
                scheduledEndAt: newScheduledEnd,
                endedAt,
                actualEndedAt,
                shiftLabel: nextShiftLabel,
                roleLabel: sanitizedRoleLabel,
                ramalLabel: normalizeRegulationRamalLabel({
                    actualPostCode: targetPost.code,
                    requestedRamalLabel: hasOwn(input, "ramalLabel") ? input.ramalLabel ?? null : existing.ramalLabel,
                }),
                notes: hasOwn(input, "notes") ? input.notes ?? null : existing.notes,
                updatedByUserId: updatedByUserId ?? null,
                updatedAt: new Date(),
                departureConfirmedAt: departureConfirmedAtNext,
                departureConfirmedByUserId: departureConfirmedByNext,
            })
            .where(eq(regulationOccupancies.id, id))
            .returning();

        await syncRegulationBankHours(tx, id);
        return updated;
    });

    publishBoardUpdate(`regulation:correct:${id}`);
    return updated;
}

export async function correctInterventionOccupancy(
    id: string,
    input: InterventionOccupancyCorrectionInput,
    updatedByUserId?: string | null,
) {
    const db = getDb();
    const updated = await db.transaction(async (tx) => {
        const existing = await tx.query.interventionOccupancies.findFirst({ where: eq(interventionOccupancies.id, id) });
        if (!existing) {
            throw new Error("Intervention occupancy not found.");
        }

        const startedAt = hasOwn(input, "startedAt") ? input.startedAt as Date : existing.startedAt;
        const boardStartedAt = hasOwn(input, "boardStartedAt") ? (input.boardStartedAt ?? null) : existing.boardStartedAt;
        const endedAt = hasOwn(input, "endedAt") ? (input.endedAt ?? null) : existing.endedAt;
        const actualEndedAt = hasOwn(input, "actualEndedAt") ? (input.actualEndedAt ?? null) : existing.actualEndedAt;

        const startedAtChanged = hasOwn(input, "startedAt");
        const boardStartedAtChanged = hasOwn(input, "boardStartedAt");
        const endedAtChanged = hasOwn(input, "endedAt");
        const actualEndedAtChanged = hasOwn(input, "actualEndedAt");
        if (startedAtChanged || boardStartedAtChanged || endedAtChanged || actualEndedAtChanged) {
            validateCorrectionChronology({
                startedAt,
                boardStartedAt,
                endedAt,
                actualEndedAt,
                startedAtChanged,
                boardStartedAtChanged,
                endedAtChanged,
                actualEndedAtChanged,
            });
        }

        const nextShiftLabel = hasOwn(input, "shiftLabel") ? input.shiftLabel ?? null : existing.shiftLabel;
        const scheduledWindowChanged = startedAtChanged || boardStartedAtChanged || hasOwn(input, "shiftLabel");
        const windowReferenceAt = boardStartedAt && boardStartedAt.getTime() > startedAt.getTime()
            ? boardStartedAt
            : startedAt;
        const { scheduledStartAt: newScheduledStart, scheduledEndAt: newScheduledEnd } = scheduledWindowChanged
            ? inferInterventionCoverageWindow({
                startedAt: windowReferenceAt,
                shiftLabel: nextShiftLabel,
                explicitScheduledStartAt: null,
                explicitScheduledEndAt: null,
            })
            : { scheduledStartAt: existing.scheduledStartAt, scheduledEndAt: existing.scheduledEndAt };

        const requestedRoleLabel = hasOwn(input, "roleLabel") ? input.roleLabel ?? null : existing.roleLabel;
        const sanitizedRoleLabel = applyOperationalRoleShiftPolicy({
            shiftLabel: nextShiftLabel === "SD" || nextShiftLabel === "SN" || nextShiftLabel === "P"
                ? nextShiftLabel
                : null,
            roleLabel: requestedRoleLabel,
        });

        const actualEndedAtTimeChanged = actualEndedAtChanged
            && (actualEndedAt?.getTime() ?? null) !== (existing.actualEndedAt?.getTime() ?? null);
        const departureConfirmedAtNext = resolveDepartureConfirmationOnCorrection({
            chiefConfirmed: input.chiefConfirmed,
            actualEndedAtChanged: actualEndedAtTimeChanged,
            existingConfirmedAt: existing.departureConfirmedAt,
        });
        const departureConfirmedByNext = resolveDepartureConfirmationByOnCorrection({
            chiefConfirmed: input.chiefConfirmed,
            actualEndedAtChanged: actualEndedAtTimeChanged,
            existingConfirmedBy: existing.departureConfirmedByUserId,
            updatedByUserId: updatedByUserId ?? null,
        });

        const [updated] = await tx.update(interventionOccupancies)
            .set({
                doctorId: hasOwn(input, "doctorId") ? input.doctorId ?? existing.doctorId : existing.doctorId,
                startedAt,
                boardStartedAt,
                scheduledStartAt: newScheduledStart,
                scheduledEndAt: newScheduledEnd,
                endedAt,
                actualEndedAt,
                shiftLabel: nextShiftLabel,
                roleLabel: sanitizedRoleLabel,
                notes: hasOwn(input, "notes") ? input.notes ?? null : existing.notes,
                updatedByUserId: updatedByUserId ?? null,
                updatedAt: new Date(),
                departureConfirmedAt: departureConfirmedAtNext,
                departureConfirmedByUserId: departureConfirmedByNext,
            })
            .where(eq(interventionOccupancies.id, id))
            .returning();

        await reconcileInterventionBoardState(tx, existing.baseId, updatedByUserId);
        await syncInterventionBankHours(tx, id);
        return updated;
    });

    publishBoardUpdate(`intervention:correct:${id}`);
    return updated;
}

export async function removeRegulationOccupancyRecord(id: string, updatedByUserId?: string | null) {
    const db = getDb();
    const deleted = await db.transaction(async (tx) => {
        const existing = await tx.query.regulationOccupancies.findFirst({ where: eq(regulationOccupancies.id, id) });
        if (!existing) {
            throw new Error("Regulation occupancy not found.");
        }

        const deleted = await deleteRegulationOccupancyTx(tx, existing);

        await syncBankHoursByContinuityGroup(tx, existing.continuityGroupId);

        return {
            ...deleted,
            updatedByUserId: updatedByUserId ?? null,
        };
    });

    publishBoardUpdate(`regulation:remove:${id}`);
    return deleted;
}

export async function removeInterventionOccupancyRecord(id: string, updatedByUserId?: string | null) {
    const db = getDb();
    const deleted = await db.transaction(async (tx) => {
        const existing = await tx.query.interventionOccupancies.findFirst({ where: eq(interventionOccupancies.id, id) });
        if (!existing) {
            throw new Error("Intervention occupancy not found.");
        }

        const deleted = await deleteInterventionOccupancyTx(tx, existing);

        await reconcileInterventionBoardState(tx, existing.baseId, updatedByUserId);
        await syncBankHoursByContinuityGroup(tx, existing.continuityGroupId);
        return {
            ...deleted,
            updatedByUserId: updatedByUserId ?? null,
        };
    });

    publishBoardUpdate(`intervention:remove:${id}`);
    return deleted;
}

export async function transferOperationalOccupancy(
    sourceOccupancyId: string,
    input: TransferOperationalOccupancyInput,
    updatedByUserId?: string | null,
) {
    await expireStaleRegulationOccupancies(new Date());

    const db = getDb();
    const result = await db.transaction(async (tx) => {
        const source = await loadOccupancySnapshot(tx, {
            domain: input.sourceDomain,
            occupancyId: sourceOccupancyId,
        });

        if (source.endedAt) {
            throw new Error("So ocupacoes ativas podem ser remanejadas.");
        }

        const sourceTarget = await resolveTargetMetadata(tx, {
            domain: source.domain,
            targetId: source.targetId,
        });
        const destinationTarget = await resolveTargetMetadata(tx, input.destination);

        if (sameTarget(sourceTarget, destinationTarget)) {
            throw new Error("Escolha um destino diferente do posto/base atual para remanejar.");
        }

        const transferShiftWindow = resolveTransferShiftWindow(new Date());
        const destinationConflicts = filterTransferConflictsToShiftWindow(await findOpenTargetOccupancies(tx, {
            target: destinationTarget,
            excludeOccupancyIds: [source.id],
        }), transferShiftWindow.startedAt);
        if (destinationConflicts.length > 1) {
            throw new Error(`O destino ${destinationTarget.code} tem multiplas ocupacoes abertas. Limpe o destino antes de remanejar.`);
        }

        const destinationConflict = destinationConflicts[0] ?? null;
        const conflictResolution = input.conflictResolution ?? null;
        let relocationTarget: TargetMetadata | null = null;

        if (destinationConflict && !conflictResolution) {
            throw new Error(`O destino ${destinationTarget.code} ja esta ocupado. Escolha se a chefia vai retirar ou remanejar quem esta la.`);
        }

        if (destinationConflict && conflictResolution?.strategy === "move_destination") {
            if (!conflictResolution.relocationTarget) {
                throw new Error("Escolha para onde o ocupante do destino deve ser remanejado.");
            }

            relocationTarget = await resolveTargetMetadata(tx, conflictResolution.relocationTarget);
            if (sameTarget(relocationTarget, destinationTarget)) {
                throw new Error("O novo destino do ocupante atual nao pode ser o mesmo destino principal do remanejamento.");
            }
        }

        const touchedContinuityGroups = new Set<string>([source.continuityGroupId]);
        const affectedInterventionBases = new Set<number>();

        if (source.domain === "regulation") {
            const sourceRecord = await tx.query.regulationOccupancies.findFirst({ where: eq(regulationOccupancies.id, source.id) });
            if (!sourceRecord) {
                throw new Error("Regulation occupancy not found.");
            }
            await deleteRegulationOccupancyTx(tx, sourceRecord);
        } else {
            const sourceRecord = await tx.query.interventionOccupancies.findFirst({ where: eq(interventionOccupancies.id, source.id) });
            if (!sourceRecord) {
                throw new Error("Intervention occupancy not found.");
            }
            await deleteInterventionOccupancyTx(tx, sourceRecord);
            affectedInterventionBases.add(source.targetId);
        }

        let displaced:
            | {
                removedSnapshot: OccupancySnapshot;
                createdSnapshot: OccupancySnapshot | null;
                relocationTarget: TargetMetadata | null;
            }
            | null = null;

        if (destinationConflict) {
            const displacedSnapshot = await loadOccupancySnapshot(tx, {
                domain: destinationTarget.domain,
                occupancyId: destinationConflict.id,
            });
            touchedContinuityGroups.add(displacedSnapshot.continuityGroupId);

            if (conflictResolution?.strategy === "move_destination") {
                const relocationConflict = await findOpenTargetOccupancies(tx, {
                    target: relocationTarget!,
                    excludeOccupancyIds: [source.id, displacedSnapshot.id],
                });

                if (relocationConflict.length > 0) {
                    throw new Error(`O destino alternativo ${relocationTarget!.code} ja esta ocupado. Escolha um posto/base vazio para quem esta no destino atual.`);
                }

                const relocated = await cloneOccupancyIntoTarget(tx, {
                    source: displacedSnapshot,
                    destination: relocationTarget!,
                    roleLabel: displacedSnapshot.roleLabel,
                    notes: mergeOperationalNotes(
                        displacedSnapshot.notes,
                        displaceNoteLine({
                            source: destinationTarget,
                            destination: relocationTarget!,
                            reason: input.notes,
                        }),
                    ),
                    updatedByUserId,
                });

                if (relocated.domain === "intervention") {
                    affectedInterventionBases.add(relocated.targetId);
                }

                const relocatedSnapshot = await loadOccupancySnapshot(tx, {
                    domain: relocated.domain,
                    occupancyId: relocated.id,
                });

                displaced = {
                    removedSnapshot: displacedSnapshot,
                    createdSnapshot: relocatedSnapshot,
                    relocationTarget: relocationTarget,
                };
            } else {
                displaced = {
                    removedSnapshot: displacedSnapshot,
                    createdSnapshot: null,
                    relocationTarget: null,
                };
            }

            if (displacedSnapshot.domain === "regulation") {
                const displacedRecord = await tx.query.regulationOccupancies.findFirst({ where: eq(regulationOccupancies.id, displacedSnapshot.id) });
                if (!displacedRecord) {
                    throw new Error("Regulation occupancy not found.");
                }
                await deleteRegulationOccupancyTx(tx, displacedRecord);
            } else {
                const displacedRecord = await tx.query.interventionOccupancies.findFirst({ where: eq(interventionOccupancies.id, displacedSnapshot.id) });
                if (!displacedRecord) {
                    throw new Error("Intervention occupancy not found.");
                }
                await deleteInterventionOccupancyTx(tx, displacedRecord);
                affectedInterventionBases.add(displacedSnapshot.targetId);
            }
        }

        const created = await cloneOccupancyIntoTarget(tx, {
            source,
            destination: destinationTarget,
            roleLabel: input.roleLabel ?? source.roleLabel,
            notes: mergeOperationalNotes(
                source.notes,
                transferNoteLine({
                    source: sourceTarget,
                    destination: destinationTarget,
                    reason: input.notes,
                }),
            ),
            updatedByUserId,
        });

        if (created.domain === "intervention") {
            affectedInterventionBases.add(created.targetId);
        }

        for (const baseId of affectedInterventionBases) {
            await reconcileInterventionBoardState(tx, baseId, updatedByUserId);
        }

        for (const continuityGroupId of touchedContinuityGroups) {
            await syncBankHoursByContinuityGroup(tx, continuityGroupId);
        }

        const movedSnapshot = await loadOccupancySnapshot(tx, {
            domain: created.domain,
            occupancyId: created.id,
        });

        return {
            movedOccupancyId: created.id,
            movedDomain: created.domain,
            displaced,
            sourceSnapshot: source,
            sourceTarget,
            movedSnapshot,
            sourceContinuityGroupId: source.continuityGroupId,
            destination: destinationTarget,
        };
    });

    publishBoardUpdate(`operational:transfer:${sourceOccupancyId}`);
    return result;
}
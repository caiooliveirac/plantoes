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
import { and, asc, desc, eq, isNotNull, isNull, ne, notInArray } from "drizzle-orm";
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
import { isBeforeHalfShiftWindow, isHalfShiftRoleLabel, isHalfShiftScheduledWindow, resolveHalfShiftScheduledWindow } from "@/modules/operational/half-shift";
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
    // Define explicitamente se o ocupante no DESTINO é sombra:
    //   true  → sombra (coexiste; board nulo; marcador nas notas)
    //   false → titular/médico (board setado; marcador removido das notas)
    //   undefined → preserva o estado de origem (transfer "neutro")
    // Cobre os 4 casos: sombra→médica, médico→sombra, sombra→sombra, médico→médico.
    asShadow?: boolean | null;
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

// Sombra (e deslocado) vivem fora do quadro com board_started_at nulo. Corrigir a
// chegada não pode dar titularidade a eles: o índice único de um titular por posto/base
// rejeitaria o update (23505) e a correção morreria com erro cru. Quem está fora do
// quadro continua fora; só a chegada (started_at) muda.
export function resolveCorrectedBoardStartedAt(
    existingBoardStartedAt: Date | null,
    boardStartedAtProvided: boolean,
    requestedBoardStartedAt: Date | null,
): Date | null {
    if (existingBoardStartedAt === null) {
        return null;
    }
    return boardStartedAtProvided ? requestedBoardStartedAt : existingBoardStartedAt;
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

// Resolve os metadados da ORIGEM de um remanejamento. Diferente do destino, a origem
// NUNCA é bloqueada por posto/base inativo ou desativado: remanejar alguém para FORA de
// um posto/base que caiu é justamente o que a chefia precisa fazer quando ele é
// desativado. Só precisamos de código/rótulo para a nota e a comparação com o destino.
// (Bug histórico: reaproveitar resolveTargetMetadata aqui travava a saída de uma base
// com janela de desativação aberta — inclusive órfã — com a mensagem sem sentido "a
// base X está desativada e não pode receber remanejamento", sendo X a origem.)
async function resolveSourceTargetMetadata(tx: Executor, target: OperationalTransferTargetInput) {
    if (target.domain === "regulation") {
        const post = await tx.query.regulationPosts.findFirst({
            where: eq(regulationPosts.id, target.targetId),
        });

        if (!post) {
            throw new Error("Posto de origem nao encontrado para o remanejamento.");
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

    if (!base) {
        throw new Error("Base de origem nao encontrada para o remanejamento.");
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

    // Só um BOARD CARRIER (board_started_at não nulo) ocupa de fato o destino. Ocupações
    // com board nulo coexistem fora do quadro — deslocados aguardando redeclarar (regulação)
    // e sombras de intervenção — e NÃO contam como conflito de remanejamento. Isso alinha o
    // transfer com o handshake de tomada, o painel ao vivo e o índice único de board por posto;
    // sem isso, quem assume um posto via tomada ainda recebe "destino já ocupado" pelo
    // ocupante que acabou de ser deslocado.
    if (params.target.domain === "regulation") {
        return tx.query.regulationOccupancies.findMany({
            where: and(
                eq(regulationOccupancies.postId, params.target.targetId),
                isNull(regulationOccupancies.endedAt),
                isNotNull(regulationOccupancies.boardStartedAt),
                excludeIds.length > 0 ? notInArray(regulationOccupancies.id, excludeIds) : undefined,
            ),
            orderBy: [asc(regulationOccupancies.startedAt)],
        });
    }

    return tx.query.interventionOccupancies.findMany({
        where: and(
            eq(interventionOccupancies.baseId, params.target.targetId),
            isNull(interventionOccupancies.endedAt),
            isNotNull(interventionOccupancies.boardStartedAt),
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

const ADMIN_SHADOW_MARKER = "[sombra]";

function operationalNotesIndicateShadow(notes: string | null | undefined) {
    const normalized = (notes ?? "")
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .toUpperCase();
    return normalized.includes("[TELEGRAM SOMBRA]") || /\bSOMBRA\b/.test(normalized);
}

// Ajusta as notas para refletir o status de sombra desejado, de forma idempotente.
// asShadow=true  garante um marcador de sombra; asShadow=false remove marcadores e
// o token "sombra"/"shadow" solto (a detecção em todo o sistema é por notas).
export function applyShadowMarkerToOccupancyNotes(notes: string | null | undefined, asShadow: boolean): string | null {
    const base = (notes ?? "").trim();
    if (asShadow) {
        return operationalNotesIndicateShadow(base) ? (base || null) : `${ADMIN_SHADOW_MARKER} ${base}`.trim();
    }
    const cleaned = base
        .replace(/\[telegram sombra\]/gi, "")
        .replace(/\[sombra\]/gi, "")
        .replace(/\bsombras?\b/gi, "")
        .replace(/\bshadow\b/gi, "")
        .replace(/[ \t]{2,}/g, " ")
        .replace(/^[\s\-–—]+|[\s\-–—]+$/g, "")
        .trim();
    return cleaned.length > 0 ? cleaned : null;
}

async function cloneOccupancyIntoTarget(tx: Executor, params: {
    source: OccupancySnapshot;
    destination: TargetMetadata;
    roleLabel?: string | null;
    notes?: string | null;
    asShadow?: boolean | null;
    updatedByUserId?: string | null;
}) {
    // Resolve notas e board conforme o status de sombra desejado no destino.
    const resolvedNotes = (params.asShadow === true || params.asShadow === false)
        ? applyShadowMarkerToOccupancyNotes(params.notes, params.asShadow)
        : (params.notes ?? null);
    // Sombra coexiste com board nulo (fica fora do índice one-active-board-per-target);
    // titular/neutro recebe o board (setado a partir da origem ou da chegada).
    const resolvedBoardStartedAt = params.asShadow === true
        ? null
        : (params.source.boardStartedAt ?? params.source.startedAt);
    if (params.destination.domain === "regulation") {
        const [created] = await tx.insert(regulationOccupancies)
            .values({
                doctorId: params.source.doctorId,
                continuityGroupId: params.source.continuityGroupId,
                postId: params.destination.targetId,
                scheduledStartAt: params.source.scheduledStartAt,
                scheduledEndAt: params.source.scheduledEndAt,
                startedAt: params.source.startedAt,
                boardStartedAt: resolvedBoardStartedAt,
                shiftLabel: params.source.shiftLabel,
                roleLabel: applyOperationalRoleShiftPolicy({
                    shiftLabel: params.source.shiftLabel === "SD" || params.source.shiftLabel === "SN" || params.source.shiftLabel === "P"
                        ? params.source.shiftLabel
                        : null,
                    roleLabel: params.roleLabel ?? params.source.roleLabel,
                }),
                ramalLabel: params.destination.code,
                source: "admin_correction",
                notes: resolvedNotes,
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
            boardStartedAt: resolvedBoardStartedAt,
            shiftLabel: params.source.shiftLabel,
            roleLabel: applyOperationalRoleShiftPolicy({
                shiftLabel: params.source.shiftLabel === "SD" || params.source.shiftLabel === "SN" || params.source.shiftLabel === "P"
                    ? params.source.shiftLabel
                    : null,
                roleLabel: params.roleLabel ?? params.source.roleLabel,
            }),
            source: "admin_correction",
            notes: resolvedNotes,
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

interface CorrectedScheduledWindow {
    scheduledStartAt: Date | null;
    scheduledEndAt: Date | null;
}

interface CorrectedHalfShiftState extends CorrectedScheduledWindow {
    roleLabel: string | null;
}

/**
 * Decide FUNÇÃO e janela agendada (scheduled_start_at/scheduled_end_at) depois de
 * uma correção. É essa janela que o banco de horas usa como baseline de atraso e
 * de hora extra, então meio plantão não é só um rótulo: muda o plantão inteiro.
 *
 * Só existem DUAS formas de tirar o meio plantão de alguém:
 *
 *  1. Trocar a função — pelo quadro ou pelo `/ramal`. MEIO_PLANTAO → outra função
 *     devolve a janela do turno (SD 07:00–19:15 na regulação, 07:00–19:00 na
 *     intervenção) e o atraso passa a ser medido a partir das 07:00: quem chegou
 *     10:38 leva o débito cheio de ~3h38 (caso Vanessa Brito, jul/2026).
 *  2. Corrigir a chegada para antes das 11:10 — fora da janela de reconhecimento,
 *     a meia jornada não se sustenta. A função é REBAIXADA junto com a janela;
 *     manter o rótulo faria o payment-closing pagar 0,5 de um plantão inteiro.
 *
 * Corrigir só o horário DENTRO da janela (11:10–17:00) mantém a meia jornada:
 * antes deste fix, ajustar a chegada de 11:59 para 11:50 reescrevia a janela como
 * turno inteiro e inventava ~4h50 de atraso (caso Cecilia Veiga, 26/07/2026).
 *
 * AUTO-CURA nas duas direções: função e janela em desacordo é estado incoerente,
 * sobra das versões anteriores deste código. Nesse estado QUALQUER correção na
 * ocupação refaz a janela, mesmo sem cruzar fronteira nenhuma — sem isso o passivo
 * fica travado, porque trocar COI→COI (ou MEIO→MEIO) não cruza nada e a janela
 * errada sobreviveria para sempre. As duas incoerências curadas:
 *   - função inteira sobre a janela canônica de meia jornada (caso Vanessa);
 *   - meio plantão sobre janela que COMEÇA antes das 11:10, ou seja a janela do
 *     turno inteiro (caso Cecilia).
 * Meia jornada declarada tarde, com janela própria (ex.: 13:13–17:00), NÃO é
 * incoerente e fica como está: encaixá-la à força em 11:30 inventaria atraso.
 *
 * O pagamento não precisa de nada além da função: payment-closing deriva a unidade
 * (0,5 ou 1) do próprio role_label em tempo de leitura.
 */
export function resolveCorrectedHalfShiftState(params: {
    existingRoleLabel: string | null;
    nextRoleLabel: string | null;
    roleLabelProvided: boolean;
    temporalFieldsChanged: boolean;
    windowReferenceAt: Date;
    existingWindow: CorrectedScheduledWindow;
    inferFullShiftWindow: () => CorrectedScheduledWindow;
}): CorrectedHalfShiftState {
    const demoted = isHalfShiftRoleLabel(params.nextRoleLabel)
        && isBeforeHalfShiftWindow(params.windowReferenceAt);
    const roleLabel = demoted ? null : params.nextRoleLabel;

    const nextIsHalfShift = isHalfShiftRoleLabel(roleLabel);
    const halfShiftBoundaryCrossed = (params.roleLabelProvided || demoted)
        && isHalfShiftRoleLabel(params.existingRoleLabel) !== nextIsHalfShift;

    if (nextIsHalfShift) {
        // A janela de meia jornada só é (re)escrita quando a gravada não serve:
        // ou a função acabou de virar meio plantão, ou o que está lá é janela de
        // turno inteiro (começa antes das 11:10). Meia jornada declarada tarde,
        // com janela própria (13:13–17:00, do bot antigo), fica como está —
        // encaixá-la em 11:30 inventaria atraso numa correção de horário.
        const storedStartAt = params.existingWindow.scheduledStartAt;
        const storedWindowServes = !halfShiftBoundaryCrossed
            && storedStartAt !== null
            && !isBeforeHalfShiftWindow(storedStartAt);

        return {
            roleLabel,
            ...(storedWindowServes
                ? params.existingWindow
                : resolveHalfShiftScheduledWindow(params.windowReferenceAt)),
        };
    }

    const staleHalfShiftWindow = isHalfShiftScheduledWindow(params.existingWindow);
    if (!params.temporalFieldsChanged && !halfShiftBoundaryCrossed && !staleHalfShiftWindow) {
        return { roleLabel, ...params.existingWindow };
    }

    return { roleLabel, ...params.inferFullShiftWindow() };
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
        const boardStartedAt = resolveCorrectedBoardStartedAt(
            existing.boardStartedAt,
            hasOwn(input, "boardStartedAt"),
            input.boardStartedAt ?? null,
        );
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

        const nextShiftLabel = hasOwn(input, "shiftLabel") ? input.shiftLabel ?? null : existing.shiftLabel;
        const requestedRoleLabel = hasOwn(input, "roleLabel") ? input.roleLabel ?? null : existing.roleLabel;
        const sanitizedRoleLabel = applyOperationalRoleShiftPolicy({
            shiftLabel: nextShiftLabel === "SD" || nextShiftLabel === "SN" || nextShiftLabel === "P"
                ? nextShiftLabel
                : null,
            roleLabel: requestedRoleLabel,
        });

        // Recalculate scheduled window whenever startedAt, shiftLabel or the
        // half-shift role boundary is corrected. Without this, /corrigir would
        // leave stale scheduled_start_at/scheduled_end_at pointing at the wrong
        // shift after an arrival-time, shift-label or função edit.
        // For continuity entries (boardStartedAt > startedAt), use boardStartedAt as
        // the window reference so the scheduled window matches the current shift.
        const windowReferenceAt = boardStartedAt && boardStartedAt.getTime() > startedAt.getTime()
            ? boardStartedAt
            : startedAt;
        const {
            roleLabel: nextRoleLabel,
            scheduledStartAt: newScheduledStart,
            scheduledEndAt: newScheduledEnd,
        } = resolveCorrectedHalfShiftState({
            existingRoleLabel: existing.roleLabel,
            nextRoleLabel: sanitizedRoleLabel,
            roleLabelProvided: hasOwn(input, "roleLabel"),
            temporalFieldsChanged: hasOwn(input, "startedAt") || hasOwn(input, "shiftLabel") || hasOwn(input, "boardStartedAt"),
            windowReferenceAt,
            existingWindow: { scheduledStartAt: existing.scheduledStartAt, scheduledEndAt: existing.scheduledEndAt },
            inferFullShiftWindow: () => inferRegulationCoverageWindow({
                startedAt: windowReferenceAt,
                shiftLabel: nextShiftLabel,
                postCode: targetPost.code,
                explicitScheduledStartAt: null,
                explicitScheduledEndAt: null,
            }),
        });

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
                roleLabel: nextRoleLabel,
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
        const boardStartedAt = resolveCorrectedBoardStartedAt(
            existing.boardStartedAt,
            hasOwn(input, "boardStartedAt"),
            input.boardStartedAt ?? null,
        );
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
        const requestedRoleLabel = hasOwn(input, "roleLabel") ? input.roleLabel ?? null : existing.roleLabel;
        const sanitizedRoleLabel = applyOperationalRoleShiftPolicy({
            shiftLabel: nextShiftLabel === "SD" || nextShiftLabel === "SN" || nextShiftLabel === "P"
                ? nextShiftLabel
                : null,
            roleLabel: requestedRoleLabel,
        });

        const windowReferenceAt = boardStartedAt && boardStartedAt.getTime() > startedAt.getTime()
            ? boardStartedAt
            : startedAt;
        const {
            roleLabel: nextRoleLabel,
            scheduledStartAt: newScheduledStart,
            scheduledEndAt: newScheduledEnd,
        } = resolveCorrectedHalfShiftState({
            existingRoleLabel: existing.roleLabel,
            nextRoleLabel: sanitizedRoleLabel,
            roleLabelProvided: hasOwn(input, "roleLabel"),
            temporalFieldsChanged: startedAtChanged || boardStartedAtChanged || hasOwn(input, "shiftLabel"),
            windowReferenceAt,
            existingWindow: { scheduledStartAt: existing.scheduledStartAt, scheduledEndAt: existing.scheduledEndAt },
            inferFullShiftWindow: () => inferInterventionCoverageWindow({
                startedAt: windowReferenceAt,
                shiftLabel: nextShiftLabel,
                explicitScheduledStartAt: null,
                explicitScheduledEndAt: null,
            }),
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
                roleLabel: nextRoleLabel,
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

        const sourceTarget = await resolveSourceTargetMetadata(tx, {
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
            asShadow: input.asShadow ?? undefined,
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
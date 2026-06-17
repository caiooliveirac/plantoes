import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, isNotNull, isNull, lte, ne } from "drizzle-orm";
import { getDb } from "@/db";
import { doctors, interventionOccupancies, regulationOccupancies, regulationPostDeactivations, regulationPosts } from "@/db/schema";
import { extractDoctorPreferredOperationalRole } from "@/modules/doctors/directory";
import { publishBoardUpdate } from "@/lib/board-live";
import { syncInterventionBankHours, syncRegulationBankHours } from "@/modules/bank-hours/service";
import { isHalfShiftRoleLabel } from "@/modules/operational/half-shift";
import { resolveOperationalRoleLabel } from "@/modules/operational/roles";
import { resolveOperationalShiftWindow } from "@/modules/operational/board-rules";
import { inferOperationalScheduledStartAt, inferRegulationCoverageWindow, resolveRegulationBoardEndAt } from "@/modules/operational/rules";
import { normalizeRegulationRamalLabel } from "@/modules/regulation/ramal-label";

export interface StartRegulationOccupancyInput {
    doctorId: string;
    postId: number;
    continuityGroupId?: string | null;
    previousOccupancyId?: string | null;
    isContinuityEntry?: boolean;
    startedAt: Date;
    boardStartedAt?: Date | null;
    scheduledStartAt?: Date | null;
    scheduledEndAt?: Date | null;
    shiftLabel?: string | null;
    roleLabel?: string | null;
    ramalLabel?: string | null;
    source: "manual" | "telegram" | "import" | "admin_correction";
    notes?: string | null;
    isShadow?: boolean | null;
    createdByUserId?: string | null;
}

export interface DeactivateRegulationPostInput {
    postId: number;
    deactivatedAt: Date;
    notes?: string | null;
    createdByUserId?: string | null;
}

export interface ReactivateRegulationPostInput {
    postId: number;
    reactivatedAt?: Date | null;
    updatedByUserId?: string | null;
}

export function resolveHistoricalAdminCorrectionEndAt(params: {
    source: StartRegulationOccupancyInput["source"];
    startedAt: Date;
    inferredScheduledEndAt: Date | null;
    now: Date;
}) {
    if (params.source !== "admin_correction") {
        return null;
    }

    if (!params.inferredScheduledEndAt) {
        return null;
    }

    if (params.inferredScheduledEndAt.getTime() > params.now.getTime()) {
        return null;
    }

    if (params.inferredScheduledEndAt.getTime() <= params.startedAt.getTime()) {
        return null;
    }

    return params.inferredScheduledEndAt;
}

type Executor = any;
const AUTO_CONTINUITY_RECENT_CLOSED_WINDOW_MS = 2 * 60 * 60 * 1000;

export function isRegulationPostDeactivationActive(params: {
    deactivatedAt: Date;
    reactivatedAt?: Date | null;
    referenceAt: Date;
}) {
    if (params.referenceAt.getTime() < params.deactivatedAt.getTime()) {
        return false;
    }

    return !params.reactivatedAt || params.referenceAt.getTime() < params.reactivatedAt.getTime();
}

async function assertRegulationPostExists(postId: number) {
    const db = getDb();
    const post = await db.query.regulationPosts.findFirst({
        where: eq(regulationPosts.id, postId),
    });

    if (!post) {
        throw new Error("Regulation post not found.");
    }

    return post;
}

async function findActiveRegulationPostDeactivation(tx: Executor, params: {
    postId: number;
    referenceAt: Date;
}) {
    return tx.query.regulationPostDeactivations.findFirst({
        where: and(
            eq(regulationPostDeactivations.postId, params.postId),
            isNull(regulationPostDeactivations.reactivatedAt),
            lte(regulationPostDeactivations.deactivatedAt, params.referenceAt),
        ),
        orderBy: [desc(regulationPostDeactivations.deactivatedAt)],
    });
}

function resolveRegulationContinuationBoardStartedAt(params: {
    startedAt: Date;
    boardStartedAt: Date | null;
    continuedAt: Date;
}) {
    // Always preserve the earliest boardStartedAt. When a doctor continues across
    // shifts (SD→SN, P→SN), the board must reflect their original arrival time so
    // that operational priority correctly shows who has been present longer.
    return params.boardStartedAt;
}

function normalizeRegulationOperationalNotes(value: string | null | undefined) {
    return (value ?? "")
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .toUpperCase();
}

export function isRegulationShadowOccupancyNotes(notes: string | null | undefined) {
    const normalized = normalizeRegulationOperationalNotes(notes);
    return normalized.includes("[TELEGRAM SOMBRA]") || /\bSOMBRA\b/.test(normalized);
}

// Marcador de ocupação "deslocada": médico que tinha o ramal mas perdeu o board numa
// tomada confirmada. Ele NÃO é fechado — fica ativo fora do quadro (board_started_at
// nulo, fora do índice de board único) com a chegada original preservada, podendo
// redeclarar uma nova posição (vira remanejamento/move que preserva started_at).
export const REGULATION_DISPLACED_NOTE_MARKER = "[DESLOCADO]";

export function isRegulationDisplacedOccupancyNotes(notes: string | null | undefined) {
    return normalizeRegulationOperationalNotes(notes).includes(REGULATION_DISPLACED_NOTE_MARKER);
}

// Ao atualizar/continuar uma ocupação deslocada, garante que o marcador [DESLOCADO]
// sobreviva à reescrita das notas — senão o médico (board nulo + marcador apagado) some
// das duas queries do painel. Preserva a linha original do marcador anexando-a às notas
// novas. Idempotente: se as notas novas já têm o marcador, retorna-as inalteradas.
export function preserveRegulationDisplacedMarker(
    existingNotes: string | null | undefined,
    nextNotes: string | null | undefined,
): string | null {
    if (isRegulationDisplacedOccupancyNotes(existingNotes) && !isRegulationDisplacedOccupancyNotes(nextNotes)) {
        const displacedLine = (existingNotes ?? "")
            .split("\n")
            .find((line) => line.includes(REGULATION_DISPLACED_NOTE_MARKER));
        if (displacedLine) {
            return nextNotes ? `${nextNotes}\n${displacedLine}` : displacedLine;
        }
    }
    return nextNotes ?? null;
}

// A "sombra" (shadow) doctor observes/accompanies the active titular on the same
// ramal without owning it. A shadow arrival must NEVER displace the active doctor,
// and a real arrival must NEVER displace a shadow — the two coexist on the ramal.
// Mirrors the intervention-domain rule (shouldCloseInterventionBoardCarrierOnArrival).
export function shouldCloseRegulationOccupantOnArrival(params: {
    currentOccupantDoctorId: string;
    arrivingDoctorId: string;
    arrivingIsShadow: boolean;
    currentOccupantNotes: string | null | undefined;
}) {
    if (params.currentOccupantDoctorId === params.arrivingDoctorId) {
        return false;
    }

    if (params.arrivingIsShadow) {
        return false;
    }

    // Um ocupante "deslocado" (perdeu o board numa tomada confirmada) coexiste fora do
    // quadro — a chegada que assume o board NÃO o fecha; ele segue ativo até redeclarar.
    if (isRegulationDisplacedOccupancyNotes(params.currentOccupantNotes)) {
        return false;
    }

    return !isRegulationShadowOccupancyNotes(params.currentOccupantNotes);
}

// Desloca um ocupante de ramal numa tomada confirmada: tira o board (board_started_at
// nulo, sai do índice one-active-board-per-post) sem fechar a ocupação, preservando a
// chegada. Marca a nota para coexistir e ser exibido como "deslocado" no painel.
export async function displaceRegulationOccupant(
    occupancyId: string,
    input: { displacedAt: Date; takenByDoctorName?: string | null },
    updatedByUserId?: string | null,
) {
    const db = getDb();
    const updated = await db.transaction(async (tx) => {
        const existing = await tx.query.regulationOccupancies.findFirst({
            where: eq(regulationOccupancies.id, occupancyId),
        });
        if (!existing) {
            throw new Error("Regulation occupancy not found.");
        }
        if (existing.endedAt) {
            throw new Error("Only active regulation occupancies can be displaced.");
        }
        if (isRegulationDisplacedOccupancyNotes(existing.notes)) {
            return existing;
        }

        const stamp = input.displacedAt.toISOString();
        const by = input.takenByDoctorName ? ` por ${input.takenByDoctorName}` : "";
        const marker = `${REGULATION_DISPLACED_NOTE_MARKER} ${stamp}${by}`.trim();
        const nextNotes = existing.notes ? `${existing.notes}\n${marker}` : marker;

        const [row] = await tx.update(regulationOccupancies)
            .set({
                boardStartedAt: null,
                notes: nextNotes,
                updatedByUserId: updatedByUserId ?? null,
                updatedAt: new Date(),
            })
            .where(eq(regulationOccupancies.id, occupancyId))
            .returning();
        return row;
    });

    publishBoardUpdate(`regulation:displace:${updated.postId}`);
    return updated;
}

// Whether an arrival should take the board immediately. A shadow takes the board
// ONLY when no titular currently holds it (lone arrival); when a titular is present
// the shadow coexists with board_started_at = NULL, staying outside the
// one-active-board-per-post unique index. Mirrors the intervention rule
// (resolveInterventionArrivalBoardPolicy).
export function resolveRegulationArrivalBoardPolicy(params: {
    source: StartRegulationOccupancyInput["source"];
    isShadow?: boolean | null;
    hasCurrentBoardCarrier: boolean;
}) {
    return {
        shouldTakeBoardImmediately: params.source !== "import"
            && (!params.isShadow || !params.hasCurrentBoardCarrier),
    };
}

export function shouldReuseImplicitRegulationContinuitySource(referenceAt: Date, sourceEndedAt?: Date | null) {
    if (!sourceEndedAt) {
        return true;
    }

    return Math.abs(referenceAt.getTime() - sourceEndedAt.getTime()) <= AUTO_CONTINUITY_RECENT_CLOSED_WINDOW_MS;
}

export function shouldReopenStaleSameDoctorRegulationOccupancy(params: {
    existingStartedAt: Date;
    existingBoardStartedAt: Date;
    incomingStartedAt: Date;
}) {
    const currentShiftStart = resolveOperationalShiftWindow(params.incomingStartedAt).startedAt;
    const preShiftToleranceMs = 60 * 60 * 1000;
    const existingAnchorIsStale = params.existingBoardStartedAt.getTime() < (currentShiftStart.getTime() - preShiftToleranceMs);

    return existingAnchorIsStale && params.incomingStartedAt.getTime() > params.existingStartedAt.getTime();
}

export function resolveRegulationContinuationExplicitScheduledEndAt(params: {
    existingScheduledEndAt?: Date | null;
    continuationAt: Date;
}) {
    const existingScheduledEndAt = params.existingScheduledEndAt ?? null;
    if (!existingScheduledEndAt) {
        return null;
    }

    return existingScheduledEndAt.getTime() > params.continuationAt.getTime()
        ? existingScheduledEndAt
        : null;
}

export function resolveRegulationContinuationScheduledEndAt(params: {
    existingStartedAt: Date;
    continuationAt: Date;
    postCode?: string | null;
    inferredScheduledStartAt?: Date | null;
    explicitScheduledEndAt?: Date | null;
}) {
    const fromExisting = inferRegulationCoverageWindow({
        startedAt: params.existingStartedAt,
        shiftLabel: "P",
        postCode: params.postCode ?? null,
        explicitScheduledStartAt: params.inferredScheduledStartAt ?? null,
        explicitScheduledEndAt: params.explicitScheduledEndAt ?? null,
    }).scheduledEndAt;

    const fromContinuation = inferRegulationCoverageWindow({
        startedAt: params.continuationAt,
        shiftLabel: "P",
        postCode: params.postCode ?? null,
        explicitScheduledStartAt: null,
        explicitScheduledEndAt: null,
    }).scheduledEndAt;

    if (!fromExisting) {
        return fromContinuation;
    }

    if (!fromContinuation) {
        return fromExisting;
    }

    // Uma mensagem de continuidade DENTRO da janela ja coberta pelo plantao
    // (ex.: medico de P desde 07h mandando "P" de novo as 19h apenas
    // reforcando) e so um reforco — nao estende a cobertura. A extensao para
    // 36h+ so acontece quando a continuidade ocorre no fim da janela ou
    // depois: atraso/reforco nao significa um novo turno.
    if (params.continuationAt.getTime() < fromExisting.getTime()) {
        return fromExisting;
    }

    return fromContinuation.getTime() > fromExisting.getTime()
        ? fromContinuation
        : fromExisting;
}

export async function startRegulationOccupancy(input: StartRegulationOccupancyInput) {
    const db = getDb();
    const now = new Date();
    let autoReactivated = false;
    const created = await db.transaction(async (tx) => {
        const doctor = await tx.query.doctors.findFirst({
            where: eq(doctors.id, input.doctorId),
            columns: { metadata: true },
        });
        const defaultDoctorRoleLabel = input.roleLabel ?? extractDoctorPreferredOperationalRole(doctor?.metadata);

        // --- Continuity group resolution ---
        let resolvedContinuityGroupId = input.continuityGroupId ?? null;
        let resolvedBoardStartedAt: Date | null = input.boardStartedAt ?? null;

        // Step 1: resolve from explicit previousOccupancyId
        if (!resolvedContinuityGroupId && input.previousOccupancyId) {
            const previous = await tx.query.regulationOccupancies.findFirst({
                where: eq(regulationOccupancies.id, input.previousOccupancyId),
                columns: { continuityGroupId: true },
            });
            if (!previous) {
                const previousInt = await tx.query.interventionOccupancies.findFirst({
                    where: eq(interventionOccupancies.id, input.previousOccupancyId),
                    columns: { continuityGroupId: true },
                });
                resolvedContinuityGroupId = previousInt?.continuityGroupId ?? null;
            } else {
                resolvedContinuityGroupId = previous.continuityGroupId ?? null;
            }
        }

        // Step 2: auto-resolve for continuity entries — find doctor's most recent occupancy
        if (input.isContinuityEntry && !resolvedContinuityGroupId) {
            const latestReg = await tx.query.regulationOccupancies.findFirst({
                where: eq(regulationOccupancies.doctorId, input.doctorId),
                orderBy: [desc(regulationOccupancies.startedAt)],
                columns: { continuityGroupId: true, boardStartedAt: true, startedAt: true, endedAt: true },
            });
            const latestInt = await tx.query.interventionOccupancies.findFirst({
                where: eq(interventionOccupancies.doctorId, input.doctorId),
                orderBy: [desc(interventionOccupancies.startedAt)],
                columns: { continuityGroupId: true, boardStartedAt: true, startedAt: true, endedAt: true },
            });
            const latest = latestReg && latestInt
                ? (latestReg.startedAt.getTime() >= latestInt.startedAt.getTime() ? latestReg : latestInt)
                : (latestReg ?? latestInt);
            if (latest && shouldReuseImplicitRegulationContinuitySource(input.startedAt, latest.endedAt ?? null)) {
                resolvedContinuityGroupId = latest.continuityGroupId;
            }
        }

        // Step 3: walk the continuity chain to find the earliest boardStartedAt
        if (input.isContinuityEntry && resolvedContinuityGroupId && !input.boardStartedAt) {
            const earliestReg = await tx.query.regulationOccupancies.findFirst({
                where: and(
                    eq(regulationOccupancies.doctorId, input.doctorId),
                    eq(regulationOccupancies.continuityGroupId, resolvedContinuityGroupId),
                ),
                orderBy: [asc(regulationOccupancies.boardStartedAt)],
                columns: { boardStartedAt: true, startedAt: true },
            });
            const earliestInt = await tx.query.interventionOccupancies.findFirst({
                where: and(
                    eq(interventionOccupancies.doctorId, input.doctorId),
                    eq(interventionOccupancies.continuityGroupId, resolvedContinuityGroupId),
                ),
                orderBy: [asc(interventionOccupancies.boardStartedAt)],
                columns: { boardStartedAt: true, startedAt: true },
            });
            const candidates = [earliestReg, earliestInt].filter(Boolean) as { boardStartedAt: Date; startedAt: Date }[];
            if (candidates.length > 0) {
                const earliest = candidates.reduce((best, current) => {
                    const bestTime = (best.boardStartedAt ?? best.startedAt).getTime();
                    const curTime = (current.boardStartedAt ?? current.startedAt).getTime();
                    return curTime < bestTime ? current : best;
                });
                resolvedBoardStartedAt = earliest.boardStartedAt ?? earliest.startedAt;
            }
        }

        const effectiveBoardStartedAt = resolvedBoardStartedAt ?? input.startedAt;

        const targetPost = await tx.query.regulationPosts.findFirst({
            where: eq(regulationPosts.id, input.postId),
            columns: { code: true, defaultRole: true },
        });
        const targetPostCode = targetPost?.code;
        if (!targetPostCode) {
            throw new Error("Ramal de destino indisponivel para esta abertura.");
        }

        const windowReferenceAt = effectiveBoardStartedAt.getTime() > input.startedAt.getTime()
            ? effectiveBoardStartedAt
            : input.startedAt;
        const {
            baseShiftLabel,
            scheduledStartAt: inferredScheduledStartAt,
            scheduledEndAt: inferredScheduledEndAt,
        } = inferRegulationCoverageWindow({
            startedAt: windowReferenceAt,
            shiftLabel: input.shiftLabel ?? null,
            postCode: targetPostCode,
            explicitScheduledStartAt: input.scheduledStartAt ?? null,
            explicitScheduledEndAt: input.scheduledEndAt ?? null,
        });
        const resolvedRoleLabel = resolveOperationalRoleLabel({
            domain: "regulation",
            code: targetPostCode,
            shiftLabel: baseShiftLabel,
            roleLabel: defaultDoctorRoleLabel,
            defaultRole: targetPost.defaultRole,
        });
        const historicalCorrectionEndAt = resolveHistoricalAdminCorrectionEndAt({
            source: input.source,
            startedAt: input.startedAt,
            inferredScheduledEndAt,
            now,
        });
        const activationReferenceAt = inferredScheduledStartAt && inferredScheduledStartAt.getTime() > input.startedAt.getTime()
            ? inferredScheduledStartAt
            : input.startedAt;
        const activeDeactivation = await findActiveRegulationPostDeactivation(tx, {
            postId: input.postId,
            referenceAt: activationReferenceAt,
        });

        if (activeDeactivation) {
            // Auto-reactivate: doctor arrival implicitly reactivates the post
            await tx.update(regulationPostDeactivations)
                .set({
                    reactivatedAt: input.startedAt,
                    updatedByUserId: input.createdByUserId ?? null,
                    updatedAt: new Date(),
                })
                .where(eq(regulationPostDeactivations.id, activeDeactivation.id));
            autoReactivated = true;
        }

        const duplicated = await tx.query.regulationOccupancies.findFirst({
            where: and(
                eq(regulationOccupancies.postId, input.postId),
                eq(regulationOccupancies.doctorId, input.doctorId),
                eq(regulationOccupancies.startedAt, input.startedAt),
                isNull(regulationOccupancies.endedAt),
            ),
        });

        if (duplicated && (duplicated.shiftLabel ?? null) === (input.shiftLabel ?? null)) {
            return duplicated;
        }

        const arrivingIsShadow = Boolean(input.isShadow ?? isRegulationShadowOccupancyNotes(input.notes));

        // The arriving doctor's own open occupancy on this post, if any (re-arrival →
        // update in place). Looked up explicitly by doctor so that a coexisting shadow
        // sitting "on top" of the post (most recent startedAt) can't shadow-hide the
        // titular's own record and cause a duplicate insert.
        const sameDoctorActive = await tx.query.regulationOccupancies.findFirst({
            where: and(
                eq(regulationOccupancies.postId, input.postId),
                eq(regulationOccupancies.doctorId, input.doctorId),
                isNull(regulationOccupancies.endedAt),
            ),
            orderBy: [desc(regulationOccupancies.startedAt)],
        });

        // Active occupants held by OTHER doctors on this post. With shadow coexistence
        // there can be more than one open at once (titular + sombra). Prefer the real
        // titular as the takeover target so a substitute hands over from the titular,
        // never from a shadow.
        const otherActiveOccupancies = await tx.query.regulationOccupancies.findMany({
            where: and(
                eq(regulationOccupancies.postId, input.postId),
                ne(regulationOccupancies.doctorId, input.doctorId),
                isNull(regulationOccupancies.endedAt),
            ),
            orderBy: [desc(regulationOccupancies.startedAt)],
        });
        const takeoverTarget = otherActiveOccupancies.find(
            (occupancy) => !isRegulationShadowOccupancyNotes(occupancy.notes),
        ) ?? otherActiveOccupancies[0] ?? null;

        const existing = sameDoctorActive ?? takeoverTarget;

        let reopenedFromStaleSameDoctor = false;

        if (existing && existing.doctorId === input.doctorId) {
            // Same doctor on same post: update in place instead of close+create.
            // This prevents zero-duration ghost records and preserves the earliest boardStartedAt —
            // BUT only if that anchor is still from the current operational shift context.
            // If the existing boardStartedAt is from a past shift (i.e., more than 60 min before the
            // current shift start), carrying it forward would make the occupancy invisible on the board.
            const shouldReopenStale = shouldReopenStaleSameDoctorRegulationOccupancy({
                existingStartedAt: existing.startedAt,
                existingBoardStartedAt: existing.boardStartedAt ?? existing.startedAt,
                incomingStartedAt: input.startedAt,
            });

            if (shouldReopenStale) {
                const closeAt = existing.scheduledEndAt && existing.scheduledEndAt.getTime() <= input.startedAt.getTime()
                    ? existing.scheduledEndAt
                    : input.startedAt;
                const resultingDurationMs = closeAt.getTime() - existing.startedAt.getTime();

                if (resultingDurationMs >= 60_000) {
                    await tx.update(regulationOccupancies)
                        .set({
                            endedAt: closeAt,
                            actualEndedAt: existing.actualEndedAt ?? closeAt,
                            updatedByUserId: input.createdByUserId ?? null,
                            updatedAt: new Date(),
                        })
                        .where(eq(regulationOccupancies.id, existing.id));

                    await syncRegulationBankHours(tx, existing.id);
                }

                reopenedFromStaleSameDoctor = true;
            }

            if (!shouldReopenStale) {
                const currentShiftStart = resolveOperationalShiftWindow(input.startedAt).startedAt;
                const PRE_SHIFT_TOLERANCE_MS = 60 * 60 * 1000;
                const existingBoardStartedAt = existing.boardStartedAt;
                // A shadow re-arrival (board anchor null) must stay board-null so it
                // keeps coexisting without entering the one-active-board-per-post index.
                const existingAnchorIsStale = existingBoardStartedAt !== null
                    && existingBoardStartedAt.getTime() < (currentShiftStart.getTime() - PRE_SHIFT_TOLERANCE_MS);
                const keptBoardStartedAt = existingBoardStartedAt === null
                    ? null
                    : ((existingAnchorIsStale || effectiveBoardStartedAt.getTime() < existingBoardStartedAt.getTime())
                        ? effectiveBoardStartedAt
                        : existingBoardStartedAt);

                const keptContinuityGroupId = resolvedContinuityGroupId ?? existing.continuityGroupId;

                // F2 safety: never allow started_at to advance forward past the existing value.
                // A re-arrival (same doctor, same post) should only move started_at EARLIER (correction),
                // never later — a later time is likely a meal-break or typo (e.g. "12:30" = lunch, not arrival).
                const keptStartedAt = input.startedAt.getTime() < existing.startedAt.getTime()
                    ? input.startedAt
                    : existing.startedAt;

                const windowRef = keptBoardStartedAt !== null && keptBoardStartedAt.getTime() > keptStartedAt.getTime()
                    ? keptBoardStartedAt : keptStartedAt;
                const requestedRoleLabel = input.roleLabel !== undefined ? input.roleLabel : (existing.roleLabel ?? resolvedRoleLabel);
                // Meio plantão tem fim canônico 17:00. Se o re-arrival mantém o role
                // (mesmo doutor, mesma posição, ainda half-shift), preserva o
                // scheduledEndAt original em vez de recalcular como SD/P (19:15).
                const preserveHalfShiftEnd = isHalfShiftRoleLabel(requestedRoleLabel)
                    && Boolean(input.scheduledEndAt ?? existing.scheduledEndAt);
                const {
                    baseShiftLabel: recalcBaseShiftLabel,
                    scheduledStartAt: recalcStart,
                    scheduledEndAt: recalcEndCandidate,
                } = inferRegulationCoverageWindow({
                    startedAt: windowRef,
                    shiftLabel: input.shiftLabel ?? existing.shiftLabel,
                    postCode: targetPostCode,
                    explicitScheduledStartAt: null,
                    explicitScheduledEndAt: preserveHalfShiftEnd
                        ? (input.scheduledEndAt ?? existing.scheduledEndAt ?? null)
                        : null,
                });
                const recalcEnd = recalcEndCandidate;
                const nextRoleLabel = resolveOperationalRoleLabel({
                    domain: "regulation",
                    code: targetPostCode,
                    shiftLabel: recalcBaseShiftLabel,
                    roleLabel: requestedRoleLabel,
                    defaultRole: targetPost.defaultRole,
                });

                const [updated] = await tx.update(regulationOccupancies)
                    .set({
                        startedAt: keptStartedAt,
                        boardStartedAt: keptBoardStartedAt,
                        continuityGroupId: keptContinuityGroupId,
                        scheduledStartAt: recalcStart,
                        scheduledEndAt: recalcEnd,
                        shiftLabel: input.shiftLabel ?? existing.shiftLabel,
                        roleLabel: nextRoleLabel,
                        ramalLabel: normalizeRegulationRamalLabel({
                            actualPostCode: targetPostCode,
                            requestedRamalLabel: input.ramalLabel ?? existing.ramalLabel,
                        }),
                        notes: input.notes ? `${existing.notes ?? ""}\n${input.notes}`.trim() : existing.notes,
                        updatedByUserId: input.createdByUserId ?? null,
                        updatedAt: new Date(),
                    })
                    .where(eq(regulationOccupancies.id, existing.id))
                    .returning();

                await syncRegulationBankHours(tx, existing.id);
                return updated;
            }
        }

        const shouldPreserveCurrentTargetOccupancy = Boolean(
            historicalCorrectionEndAt
            && existing
            && input.startedAt.getTime() < existing.startedAt.getTime(),
        );

        const shouldCloseExistingOnTakeover = Boolean(
            existing
            && shouldCloseRegulationOccupantOnArrival({
                currentOccupantDoctorId: existing.doctorId,
                arrivingDoctorId: input.doctorId,
                arrivingIsShadow,
                currentOccupantNotes: existing.notes,
            }),
        );

        if (existing && !reopenedFromStaleSameDoctor && !shouldPreserveCurrentTargetOccupancy && shouldCloseExistingOnTakeover) {
            const closeAt = input.startedAt.getTime() >= existing.startedAt.getTime()
                ? resolveRegulationBoardEndAt(input.startedAt, existing.scheduledEndAt)
                : existing.startedAt;

            // P2: guard against zero-duration occupancies caused by retroactive or duplicate arrivals.
            const resultingDurationMs = closeAt.getTime() - existing.startedAt.getTime();
            if (resultingDurationMs < 60_000) {
                throw new Error("arrival_conflicts_with_active_occupancy");
            }

            await tx.update(regulationOccupancies)
                .set({
                    endedAt: closeAt,
                    actualEndedAt: existing.actualEndedAt ?? closeAt,
                    updatedByUserId: input.createdByUserId ?? null,
                    updatedAt: new Date(),
                })
                .where(eq(regulationOccupancies.id, existing.id));

            await syncRegulationBankHours(tx, existing.id);
        }

        // Close any active occupancy the same doctor holds on a DIFFERENT ramal.
        // This handles ramal switches (e.g. doctor moves from 2034 to 1362) where
        // the old occupancy would otherwise remain open as an orphan.
        const otherRamalOccupancy = await tx.query.regulationOccupancies.findFirst({
            where: and(
                eq(regulationOccupancies.doctorId, input.doctorId),
                ne(regulationOccupancies.postId, input.postId),
                isNull(regulationOccupancies.endedAt),
            ),
            orderBy: [desc(regulationOccupancies.startedAt)],
        });

        const shouldPreserveDoctorCurrentOtherRamal = Boolean(
            historicalCorrectionEndAt
            && otherRamalOccupancy
            && input.startedAt.getTime() < otherRamalOccupancy.startedAt.getTime(),
        );

        if (otherRamalOccupancy && !shouldPreserveDoctorCurrentOtherRamal) {
            const otherCloseAt = input.startedAt.getTime() >= otherRamalOccupancy.startedAt.getTime()
                ? resolveRegulationBoardEndAt(input.startedAt, otherRamalOccupancy.scheduledEndAt)
                : otherRamalOccupancy.startedAt;

            // Guard against zero-duration artifacts when ramal switch timestamp ≈ previous start.
            const otherResultingDurationMs = otherCloseAt.getTime() - otherRamalOccupancy.startedAt.getTime();
            if (otherResultingDurationMs >= 60_000) {
                await tx.update(regulationOccupancies)
                    .set({
                        endedAt: otherCloseAt,
                        actualEndedAt: otherRamalOccupancy.actualEndedAt ?? otherCloseAt,
                        updatedByUserId: input.createdByUserId ?? null,
                        updatedAt: new Date(),
                    })
                    .where(eq(regulationOccupancies.id, otherRamalOccupancy.id));

                await syncRegulationBankHours(tx, otherRamalOccupancy.id);
            }

            // Inherit continuity group from the previous ramal if not already set
            if (!resolvedContinuityGroupId) {
                resolvedContinuityGroupId = otherRamalOccupancy.continuityGroupId;
            }
        }

        // Cross-domain cleanup: close open intervention occupancy when doctor moves to a regulation post.
        // Covers the case where a doctor was DESLOCADO at an intervention base and then declared at regulation
        // without the intervention occupancy ever being closed (no same-domain trigger exists for this path).
        const otherInterventionOccupancy = await tx.query.interventionOccupancies.findFirst({
            where: and(
                eq(interventionOccupancies.doctorId, input.doctorId),
                isNull(interventionOccupancies.endedAt),
            ),
            orderBy: [desc(interventionOccupancies.startedAt)],
        });
        const shouldPreserveCrossIntervention = Boolean(
            historicalCorrectionEndAt
            && otherInterventionOccupancy
            && input.startedAt.getTime() < otherInterventionOccupancy.startedAt.getTime(),
        );
        if (otherInterventionOccupancy && !shouldPreserveCrossIntervention) {
            const crossCloseMs = input.startedAt.getTime() - otherInterventionOccupancy.startedAt.getTime();
            if (crossCloseMs >= 60_000) {
                await tx.update(interventionOccupancies)
                    .set({
                        endedAt: input.startedAt,
                        actualEndedAt: otherInterventionOccupancy.actualEndedAt ?? input.startedAt,
                        updatedByUserId: input.createdByUserId ?? null,
                        updatedAt: new Date(),
                    })
                    .where(eq(interventionOccupancies.id, otherInterventionOccupancy.id));
                await syncInterventionBankHours(tx, otherInterventionOccupancy.id);
            }
        }

        // A coexisting shadow (titular already holds the board) is stored without a
        // board anchor so it stays outside the one-active-board-per-post unique index
        // and never displaces the titular. A lone arrival (no current carrier) takes
        // the board normally — including a shadow that arrives to an empty post.
        const hasCurrentBoardCarrier = otherActiveOccupancies.some(
            (occupancy) => occupancy.boardStartedAt !== null,
        );
        const { shouldTakeBoardImmediately } = resolveRegulationArrivalBoardPolicy({
            source: input.source,
            isShadow: arrivingIsShadow,
            hasCurrentBoardCarrier,
        });
        const insertBoardStartedAt = shouldTakeBoardImmediately ? effectiveBoardStartedAt : null;

        const [created] = await tx.insert(regulationOccupancies).values({
            doctorId: input.doctorId,
            postId: input.postId,
            continuityGroupId: resolvedContinuityGroupId ?? randomUUID(),
            scheduledStartAt: inferredScheduledStartAt,
            scheduledEndAt: inferredScheduledEndAt,
            startedAt: input.startedAt,
            boardStartedAt: insertBoardStartedAt,
            shiftLabel: input.shiftLabel ?? null,
            roleLabel: resolvedRoleLabel,
            ramalLabel: normalizeRegulationRamalLabel({
                actualPostCode: targetPostCode,
                requestedRamalLabel: input.ramalLabel ?? null,
            }),
            source: input.source,
            notes: input.notes ?? null,
            endedAt: historicalCorrectionEndAt,
            actualEndedAt: historicalCorrectionEndAt,
            createdByUserId: input.createdByUserId ?? null,
            updatedByUserId: input.createdByUserId ?? null,
        }).returning();

        // When this arrival takes the board, it must be the only board carrier on
        // the post (one-active-board-per-post unique index). A real handoff already
        // closed the predecessor, but a coexisting shadow that previously held the
        // board (e.g. a shadow that had arrived to an empty post) is NOT closed —
        // demote its board anchor to NULL so it keeps coexisting without conflicting.
        if (shouldTakeBoardImmediately && !historicalCorrectionEndAt) {
            await tx.update(regulationOccupancies)
                .set({ boardStartedAt: null, updatedAt: new Date() })
                .where(and(
                    eq(regulationOccupancies.postId, input.postId),
                    isNull(regulationOccupancies.endedAt),
                    isNotNull(regulationOccupancies.boardStartedAt),
                    ne(regulationOccupancies.id, created.id),
                ));
        }

        if (historicalCorrectionEndAt) {
            await syncRegulationBankHours(tx, created.id);
        }

        return created;
    });

    publishBoardUpdate(`regulation:start:${input.postId}`);
    if (autoReactivated) {
        publishBoardUpdate(`regulation:reactivate:${input.postId}`);
    }
    return { ...created, autoReactivated };
}

export async function deactivateRegulationPost(input: DeactivateRegulationPostInput) {
    await assertRegulationPostExists(input.postId);

    const db = getDb();
    const result = await db.transaction(async (tx) => {
        const activeDeactivation = await findActiveRegulationPostDeactivation(tx, {
            postId: input.postId,
            referenceAt: input.deactivatedAt,
        });

        if (activeDeactivation) {
            throw new Error("Este ramal ja esta desativado.");
        }

        const openOccupancies = await tx.query.regulationOccupancies.findMany({
            where: and(
                eq(regulationOccupancies.postId, input.postId),
                isNull(regulationOccupancies.endedAt),
            ),
            orderBy: [asc(regulationOccupancies.startedAt)],
        });

        const [state] = await tx.insert(regulationPostDeactivations).values({
            postId: input.postId,
            deactivatedAt: input.deactivatedAt,
            notes: input.notes ?? null,
            createdByUserId: input.createdByUserId ?? null,
            updatedByUserId: input.createdByUserId ?? null,
        }).returning();

        const closedOccupancyIds: string[] = [];
        for (const occupancy of openOccupancies) {
            const endedAt = input.deactivatedAt.getTime() < occupancy.startedAt.getTime()
                ? occupancy.startedAt
                : input.deactivatedAt;

            await tx.update(regulationOccupancies)
                .set({
                    endedAt,
                    actualEndedAt: endedAt,
                    updatedByUserId: input.createdByUserId ?? null,
                    updatedAt: new Date(),
                })
                .where(eq(regulationOccupancies.id, occupancy.id));

            await syncRegulationBankHours(tx, occupancy.id);
            closedOccupancyIds.push(occupancy.id);
        }

        return { state, closedOccupancyIds };
    });

    publishBoardUpdate(`regulation:deactivate:${input.postId}`);
    return result;
}

export async function reactivateRegulationPost(input: ReactivateRegulationPostInput) {
    await assertRegulationPostExists(input.postId);

    const db = getDb();
    const state = await db.transaction(async (tx) => {
        const reactivatedAt = input.reactivatedAt ?? new Date();
        const activeDeactivation = await findActiveRegulationPostDeactivation(tx, {
            postId: input.postId,
            referenceAt: reactivatedAt,
        });

        if (!activeDeactivation) {
            throw new Error("Este ramal nao esta desativado.");
        }

        if (reactivatedAt.getTime() < activeDeactivation.deactivatedAt.getTime()) {
            throw new Error("A reativacao nao pode ser anterior a desativacao.");
        }

        const [updated] = await tx.update(regulationPostDeactivations)
            .set({
                reactivatedAt,
                updatedByUserId: input.updatedByUserId ?? null,
                updatedAt: new Date(),
            })
            .where(eq(regulationPostDeactivations.id, activeDeactivation.id))
            .returning();

        return updated;
    });

    publishBoardUpdate(`regulation:reactivate:${input.postId}`);
    return state;
}

export async function expireStaleRegulationOccupancies(referenceAt = new Date()) {
    const db = getDb();
    const expiredIds: string[] = [];

    await db.transaction(async (tx) => {
        const staleOpen = await tx.query.regulationOccupancies.findMany({
            where: isNull(regulationOccupancies.endedAt),
            orderBy: [desc(regulationOccupancies.startedAt)],
        });

        for (const occupancy of staleOpen) {
            if (!occupancy.scheduledEndAt) {
                continue;
            }

            if (occupancy.shiftLabel === "P") {
                continue;
            }

            if (occupancy.scheduledEndAt.getTime() > referenceAt.getTime()) {
                continue;
            }

            const actualEndedAt = occupancy.actualEndedAt ?? occupancy.scheduledEndAt;
            await tx.update(regulationOccupancies)
                .set({
                    endedAt: occupancy.scheduledEndAt,
                    actualEndedAt,
                    updatedAt: new Date(),
                })
                .where(eq(regulationOccupancies.id, occupancy.id));

            await syncRegulationBankHours(tx, occupancy.id);
            expiredIds.push(occupancy.id);
        }
    });

    if (expiredIds.length > 0) {
        publishBoardUpdate(`regulation:expire:${expiredIds.join(",")}`);
    }

    return expiredIds;
}

export async function continueRegulationOccupancy(
    id: string,
    input?: { notes?: string | null; continuedAt?: Date | null },
    updatedByUserId?: string | null,
) {
    const db = getDb();
    const updated = await db.transaction(async (tx) => {
        const existing = await tx.query.regulationOccupancies.findFirst({
            where: eq(regulationOccupancies.id, id),
        });

        if (!existing) {
            throw new Error("Regulation occupancy not found.");
        }

        if (existing.endedAt) {
            throw new Error("Only active regulation occupancies can be continued.");
        }

        const baseNextNotes = input?.notes?.trim()
            ? input.notes.trim()
            : existing.notes;
        // Deslocado redeclarando o mesmo posto: a continuação substitui as notas e
        // apagaria o marcador [DESLOCADO], somindo o médico do painel (board nulo +
        // sem marcador = não aparece em nenhuma das duas queries). Preserva a linha do
        // marcador para ele seguir visível como deslocado até assumir uma PA.
        const nextNotes = preserveRegulationDisplacedMarker(existing.notes, baseNextNotes);
        const postCode = (await tx.query.regulationPosts.findFirst({
            where: eq(regulationPosts.id, existing.postId),
            columns: { code: true },
        }))?.code ?? null;
        const continuationAt = input?.continuedAt ?? new Date();
        const explicitContinuationScheduledEndAt = resolveRegulationContinuationExplicitScheduledEndAt({
            existingScheduledEndAt: existing.scheduledEndAt,
            continuationAt,
        });
        const baseShiftLabel = existing.shiftLabel && existing.shiftLabel !== "P"
            ? existing.shiftLabel
            : resolveOperationalShiftWindow(existing.startedAt).shiftLabel;
        const inferredScheduledStartAt = existing.scheduledStartAt
            ?? inferOperationalScheduledStartAt(existing.startedAt, baseShiftLabel, null, postCode);
        // Meio plantão é definido pelo fim 17:00. Continuação não estende um meio
        // plantão para janela P (05:00 do dia seguinte) — preserva o scheduledEndAt
        // original para a auto-checkout das 17h continuar funcionando.
        const isHalfShiftContinuation = isHalfShiftRoleLabel(existing.roleLabel) && Boolean(existing.scheduledEndAt);
        const nextScheduledEndAt = isHalfShiftContinuation
            ? existing.scheduledEndAt
            : resolveRegulationContinuationScheduledEndAt({
                existingStartedAt: existing.startedAt,
                continuationAt,
                postCode,
                inferredScheduledStartAt,
                explicitScheduledEndAt: explicitContinuationScheduledEndAt,
            });
        const nextBoardStartedAt = resolveRegulationContinuationBoardStartedAt({
            startedAt: existing.startedAt,
            boardStartedAt: existing.boardStartedAt,
            continuedAt: continuationAt,
        });

        const [updated] = await tx.update(regulationOccupancies)
            .set({
                boardStartedAt: nextBoardStartedAt,
                shiftLabel: "P",
                scheduledStartAt: inferredScheduledStartAt,
                scheduledEndAt: nextScheduledEndAt,
                notes: nextNotes ?? null,
                updatedByUserId: updatedByUserId ?? null,
                updatedAt: new Date(),
            })
            .where(eq(regulationOccupancies.id, id))
            .returning();

        await syncRegulationBankHours(tx, id);
        return updated;
    });

    publishBoardUpdate(`regulation:continue:${id}`);
    return updated;
}

export async function endRegulationOccupancy(
    id: string,
    input: { endedAt: Date; actualEndedAt?: Date | null; chiefConfirmed?: boolean; handoffClosure?: boolean },
    updatedByUserId?: string | null,
) {
    const db = getDb();
    const updated = await db.transaction(async (tx) => {
        const existing = await tx.query.regulationOccupancies.findFirst({
            where: eq(regulationOccupancies.id, id),
        });

        if (!existing) {
            throw new Error("Regulation occupancy not found.");
        }

        const boardEndedAt = resolveRegulationBoardEndAt(input.endedAt, existing.scheduledEndAt);
        // Fechamento por rendição: grava só endedAt e deixa actualEndedAt nulo, para que o banco
        // feche autoritativamente no horário do handoff sem cair na fila de confirmação do chefe.
        // Um aviso de saída tardia posterior (ocorrência) preenche actualEndedAt e aí sim exige confirmação.
        const actualEndedAt = input.handoffClosure ? null : (input.actualEndedAt ?? input.endedAt);
        if (actualEndedAt && actualEndedAt.getTime() < existing.startedAt.getTime()) {
            throw new Error("Actual end cannot be before the recorded arrival.");
        }

        const now = new Date();
        const departureConfirmedAt = input.chiefConfirmed ? now : existing.departureConfirmedAt;
        const departureConfirmedByUserId = input.chiefConfirmed
            ? (updatedByUserId ?? null)
            : existing.departureConfirmedByUserId;

        const [updated] = await tx
            .update(regulationOccupancies)
            .set({
                endedAt: boardEndedAt,
                actualEndedAt,
                updatedByUserId: updatedByUserId ?? null,
                updatedAt: now,
                departureConfirmedAt,
                departureConfirmedByUserId,
            })
            .where(eq(regulationOccupancies.id, id))
            .returning();

        await syncRegulationBankHours(tx, id);
        return updated;
    });

    publishBoardUpdate(`regulation:end:${id}`);
    return updated;
}

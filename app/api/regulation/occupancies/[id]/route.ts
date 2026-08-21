import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { getDb, hasDatabaseUrl } from "@/db";
import { auditLogs, doctors, regulationOccupancies, regulationPosts } from "@/db/schema";
import { AuthError, requireAuthenticatedSession } from "@/lib/auth/server";
import { correctRegulationOccupancy, removeRegulationOccupancyRecord, transferOperationalOccupancy } from "@/modules/operational/corrections";
import { avisarSecretario } from "@/lib/avisos/secretario";
import {
    buildChiefArrivalBlockNotice,
    CHIEF_ARRIVAL_ADMIN_ONLY_CODE,
    CHIEF_ARRIVAL_ADMIN_ONLY_MESSAGE,
    shouldBlockChiefArrivalEdit,
    touchesArrival,
} from "@/modules/operational/chief-arrival-guard";

function serializeOccupancySnapshot(snapshot: {
    id: string;
    domain: "regulation" | "intervention";
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
}) {
    return {
        id: snapshot.id,
        domain: snapshot.domain,
        doctorId: snapshot.doctorId,
        continuityGroupId: snapshot.continuityGroupId,
        source: snapshot.source,
        targetId: snapshot.targetId,
        startedAt: snapshot.startedAt.toISOString(),
        boardStartedAt: snapshot.boardStartedAt?.toISOString() ?? null,
        endedAt: snapshot.endedAt?.toISOString() ?? null,
        actualEndedAt: snapshot.actualEndedAt?.toISOString() ?? null,
        scheduledStartAt: snapshot.scheduledStartAt?.toISOString() ?? null,
        scheduledEndAt: snapshot.scheduledEndAt?.toISOString() ?? null,
        shiftLabel: snapshot.shiftLabel,
        roleLabel: snapshot.roleLabel,
        ramalLabel: snapshot.ramalLabel,
        notes: snapshot.notes,
    };
}

const schema = z.object({
    postId: z.number().int().positive().optional(),
    doctorId: z.string().uuid().optional(),
    startedAt: z.string().datetime().optional(),
    boardStartedAt: z.string().datetime().optional(),
    endedAt: z.union([z.string().datetime(), z.null()]).optional(),
    actualEndedAt: z.union([z.string().datetime(), z.null()]).optional(),
    shiftLabel: z.union([z.string().trim().max(100), z.null()]).optional(),
    roleLabel: z.union([z.string().trim().max(100), z.null()]).optional(),
    ramalLabel: z.union([z.string().trim().max(50), z.null()]).optional(),
    notes: z.union([z.string().trim().max(2000), z.null()]).optional(),
});

const deleteSchema = z.object({
    notes: z.string().trim().min(8).max(2000),
});

export async function PATCH(request: NextRequest, context: RouteContext<"/api/regulation/occupancies/[id]">) {
    if (!hasDatabaseUrl()) {
        return NextResponse.json({ error: "DATABASE_URL is not configured for operations-v2." }, { status: 503 });
    }

    let session;
    try {
        session = await requireAuthenticatedSession(["admin", "chief"]);
    } catch (error) {
        const status = error instanceof AuthError ? error.status : 500;
        return NextResponse.json({ error: error instanceof Error ? error.message : "Unauthorized." }, { status });
    }

    const parsed = schema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
        return NextResponse.json({ error: "Invalid correction payload." }, { status: 400 });
    }

    const { id } = await context.params;
    try {
        const existing = await getDb().query.regulationOccupancies.findFirst({
            where: eq(regulationOccupancies.id, id),
        });
        if (!existing) {
            return NextResponse.json({ error: "Regulation occupancy not found." }, { status: 404 });
        }

        const currentPost = await getDb().query.regulationPosts.findFirst({
            where: eq(regulationPosts.id, existing.postId),
            columns: {
                id: true,
                code: true,
            },
        });
        if (!currentPost) {
            return NextResponse.json({ error: "Current regulation post not found." }, { status: 404 });
        }

        let requestedPostId = parsed.data.postId ?? null;
        const requestedRamalLabel = parsed.data.ramalLabel?.trim() ?? null;
        if (!requestedPostId && requestedRamalLabel && requestedRamalLabel !== currentPost.code) {
            const requestedPost = await getDb().query.regulationPosts.findFirst({
                where: eq(regulationPosts.code, requestedRamalLabel),
                columns: {
                    id: true,
                    code: true,
                    isActive: true,
                },
            });

            if (!requestedPost || !requestedPost.isActive) {
                return NextResponse.json({ error: "Ramal de destino indisponivel para este remanejamento." }, { status: 400 });
            }

            requestedPostId = requestedPost.id;
        }

        const nextStartedAt = parsed.data.startedAt ? new Date(parsed.data.startedAt) : null;
        const startedAtChanged = Boolean(nextStartedAt && nextStartedAt.getTime() !== existing.startedAt.getTime());

        // Chegada da chefia (2031) só muda com login de admin. Quem não é admin
        // deixa um pedido registrado e a coordenação recebe o aviso.
        const arrivalChanged = touchesArrival({
            requestedStartedAt: nextStartedAt,
            requestedBoardStartedAt: parsed.data.boardStartedAt ? new Date(parsed.data.boardStartedAt) : null,
            existingStartedAt: existing.startedAt,
            existingBoardStartedAt: existing.boardStartedAt,
        });
        if (shouldBlockChiefArrivalEdit({
            postCode: currentPost.code,
            isAdmin: session.user.roles.includes("admin"),
            arrivalChanged,
        })) {
            const doctor = await getDb().query.doctors.findFirst({
                where: eq(doctors.id, existing.doctorId),
                columns: { fullName: true, displayName: true },
            });
            const requestedAt = nextStartedAt ?? (parsed.data.boardStartedAt ? new Date(parsed.data.boardStartedAt) : null);

            await getDb().insert(auditLogs).values({
                actorUserId: session.user.id,
                action: "chief_arrival_change.requested",
                entityType: "regulation_occupancy",
                entityId: id,
                details: {
                    postCode: currentPost.code,
                    doctorId: existing.doctorId,
                    doctorName: doctor?.displayName ?? doctor?.fullName ?? null,
                    currentStartedAt: existing.startedAt.toISOString(),
                    requestedStartedAt: requestedAt?.toISOString() ?? null,
                    note: parsed.data.notes ?? null,
                    channel: "quadro",
                    actorEmail: session.user.email,
                },
            });

            await avisarSecretario(buildChiefArrivalBlockNotice({
                doctorName: doctor?.displayName ?? doctor?.fullName ?? null,
                actorLabel: session.user.email,
                postCode: currentPost.code,
                currentArrivalAt: existing.startedAt,
                requestedArrivalAt: requestedAt,
                note: parsed.data.notes ?? null,
                channel: "quadro",
            }));

            return NextResponse.json(
                { error: CHIEF_ARRIVAL_ADMIN_ONLY_MESSAGE, code: CHIEF_ARRIVAL_ADMIN_ONLY_CODE },
                { status: 403 },
            );
        }
        const postChanged = Boolean(requestedPostId && requestedPostId !== existing.postId);
        const doctorChanged = Boolean(parsed.data.doctorId && parsed.data.doctorId !== existing.doctorId);
        if (startedAtChanged && !parsed.data.notes?.trim()) {
            return NextResponse.json({ error: "Motivo obrigatorio ao corrigir horario de regulacao." }, { status: 400 });
        }
        if (postChanged && !parsed.data.notes?.trim()) {
            return NextResponse.json({ error: "Motivo obrigatorio ao trocar o ramal da regulacao." }, { status: 400 });
        }
        if (doctorChanged && !parsed.data.notes?.trim()) {
            return NextResponse.json({ error: "Motivo obrigatorio ao trocar o medico da regulacao." }, { status: 400 });
        }

        if (postChanged) {
            const transfer = await transferOperationalOccupancy(id, {
                sourceDomain: "regulation",
                destination: {
                    domain: "regulation",
                    targetId: requestedPostId as number,
                },
                roleLabel: Object.prototype.hasOwnProperty.call(parsed.data, "roleLabel")
                    ? parsed.data.roleLabel ?? null
                    : existing.roleLabel,
                notes: parsed.data.notes ?? null,
                conflictResolution: null,
            }, session.user.id);

            await getDb().insert(auditLogs).values({
                actorUserId: session.user.id,
                action: "operational_occupancy.transferred",
                entityType: "operational_transfer",
                entityId: transfer.movedOccupancyId,
                details: {
                    sourceDomain: "regulation",
                    sourceOccupancyId: id,
                    legacyRequestedRamalLabel: requestedRamalLabel,
                    destination: {
                        domain: "regulation",
                        targetId: requestedPostId,
                    },
                    roleLabel: Object.prototype.hasOwnProperty.call(parsed.data, "roleLabel")
                        ? parsed.data.roleLabel ?? null
                        : existing.roleLabel,
                    notes: parsed.data.notes ?? null,
                    movedOccupancyId: transfer.movedOccupancyId,
                    movedDomain: transfer.movedDomain,
                    sourceSnapshot: serializeOccupancySnapshot(transfer.sourceSnapshot),
                    sourceTarget: transfer.sourceTarget,
                    movedSnapshot: serializeOccupancySnapshot(transfer.movedSnapshot),
                    displaced: transfer.displaced ? {
                        removedSnapshot: serializeOccupancySnapshot(transfer.displaced.removedSnapshot),
                        createdSnapshot: transfer.displaced.createdSnapshot
                            ? serializeOccupancySnapshot(transfer.displaced.createdSnapshot)
                            : null,
                        relocationTarget: transfer.displaced.relocationTarget,
                    } : null,
                    sourceContinuityGroupId: transfer.sourceContinuityGroupId,
                    compatibilityMode: "legacy_ramalLabel_patch",
                },
            });

            return NextResponse.json({ transfer });
        }

        const updated = await correctRegulationOccupancy(id, {
            ...(requestedPostId ? { postId: requestedPostId } : {}),
            ...(parsed.data.doctorId ? { doctorId: parsed.data.doctorId } : {}),
            ...(parsed.data.startedAt ? { startedAt: new Date(parsed.data.startedAt) } : {}),
            ...(parsed.data.boardStartedAt ? { boardStartedAt: new Date(parsed.data.boardStartedAt) } : {}),
            ...(Object.prototype.hasOwnProperty.call(parsed.data, "endedAt")
                ? { endedAt: parsed.data.endedAt ? new Date(parsed.data.endedAt) : null }
                : {}),
            ...(Object.prototype.hasOwnProperty.call(parsed.data, "actualEndedAt")
                ? { actualEndedAt: parsed.data.actualEndedAt ? new Date(parsed.data.actualEndedAt) : null }
                : {}),
            ...(Object.prototype.hasOwnProperty.call(parsed.data, "shiftLabel") ? { shiftLabel: parsed.data.shiftLabel ?? null } : {}),
            ...(Object.prototype.hasOwnProperty.call(parsed.data, "roleLabel") ? { roleLabel: parsed.data.roleLabel ?? null } : {}),
            ...(Object.prototype.hasOwnProperty.call(parsed.data, "ramalLabel") ? { ramalLabel: parsed.data.ramalLabel ?? null } : {}),
            ...(Object.prototype.hasOwnProperty.call(parsed.data, "notes") ? { notes: parsed.data.notes ?? null } : {}),
            chiefConfirmed: true,
        }, session.user.id);

        await getDb().insert(auditLogs).values({
            actorUserId: session.user.id,
            action: "regulation_occupancy.corrected",
            entityType: "regulation_occupancy",
            entityId: updated.id,
            details: {
                ...parsed.data,
                previousPostId: existing.postId,
                nextPostId: updated.postId,
                previousDoctorId: existing.doctorId,
                nextDoctorId: updated.doctorId,
                previousStartedAt: existing.startedAt.toISOString(),
                nextStartedAt: updated.startedAt.toISOString(),
                beforeSnapshot: {
                    doctorId: existing.doctorId,
                    postId: existing.postId,
                    startedAt: existing.startedAt.toISOString(),
                    boardStartedAt: existing.boardStartedAt?.toISOString() ?? null,
                    endedAt: existing.endedAt?.toISOString() ?? null,
                    actualEndedAt: existing.actualEndedAt?.toISOString() ?? null,
                    scheduledStartAt: existing.scheduledStartAt?.toISOString() ?? null,
                    scheduledEndAt: existing.scheduledEndAt?.toISOString() ?? null,
                    shiftLabel: existing.shiftLabel,
                    roleLabel: existing.roleLabel,
                    ramalLabel: existing.ramalLabel,
                    notes: existing.notes,
                    continuityGroupId: existing.continuityGroupId,
                },
            },
        });

        return NextResponse.json({ occupancy: updated });
    } catch (error) {
        return NextResponse.json(
            { error: error instanceof Error ? error.message : "Unable to correct regulation occupancy." },
            { status: 400 },
        );
    }
}

export async function DELETE(request: NextRequest, context: RouteContext<"/api/regulation/occupancies/[id]">) {
    if (!hasDatabaseUrl()) {
        return NextResponse.json({ error: "DATABASE_URL is not configured for operations-v2." }, { status: 503 });
    }

    let session;
    try {
        session = await requireAuthenticatedSession(["admin"]);
    } catch (error) {
        const status = error instanceof AuthError ? error.status : 500;
        return NextResponse.json({ error: error instanceof Error ? error.message : "Unauthorized." }, { status });
    }

    const parsed = deleteSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
        return NextResponse.json({ error: "Motivo obrigatorio para apagar ocupacao de regulacao." }, { status: 400 });
    }

    const { id } = await context.params;
    try {
        const existing = await getDb().query.regulationOccupancies.findFirst({
            where: eq(regulationOccupancies.id, id),
        });
        if (!existing) {
            return NextResponse.json({ error: "Regulation occupancy not found." }, { status: 404 });
        }

        const deleted = await removeRegulationOccupancyRecord(id, session.user.id);

        await getDb().insert(auditLogs).values({
            actorUserId: session.user.id,
            action: "regulation_occupancy.deleted",
            entityType: "regulation_occupancy",
            entityId: id,
            details: {
                notes: parsed.data.notes,
                doctorId: existing.doctorId,
                postId: existing.postId,
                startedAt: existing.startedAt.toISOString(),
                endedAt: existing.endedAt?.toISOString() ?? null,
                actualEndedAt: existing.actualEndedAt?.toISOString() ?? null,
                shiftLabel: existing.shiftLabel,
                continuityGroupId: existing.continuityGroupId,
                beforeSnapshot: {
                    doctorId: existing.doctorId,
                    postId: existing.postId,
                    startedAt: existing.startedAt.toISOString(),
                    boardStartedAt: existing.boardStartedAt?.toISOString() ?? null,
                    endedAt: existing.endedAt?.toISOString() ?? null,
                    actualEndedAt: existing.actualEndedAt?.toISOString() ?? null,
                    scheduledStartAt: existing.scheduledStartAt?.toISOString() ?? null,
                    scheduledEndAt: existing.scheduledEndAt?.toISOString() ?? null,
                    shiftLabel: existing.shiftLabel,
                    roleLabel: existing.roleLabel,
                    ramalLabel: existing.ramalLabel,
                    notes: existing.notes,
                    continuityGroupId: existing.continuityGroupId,
                },
            },
        });

        return NextResponse.json({ occupancy: deleted });
    } catch (error) {
        return NextResponse.json(
            { error: error instanceof Error ? error.message : "Unable to delete regulation occupancy." },
            { status: 400 },
        );
    }
}
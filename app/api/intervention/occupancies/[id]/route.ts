import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { getDb, hasDatabaseUrl } from "@/db";
import { auditLogs, interventionOccupancies } from "@/db/schema";
import { AuthError, requireAuthenticatedSession } from "@/lib/auth/server";
import { correctInterventionOccupancy } from "@/modules/operational/corrections";

const schema = z.object({
    doctorId: z.string().uuid().optional(),
    startedAt: z.string().datetime().optional(),
    boardStartedAt: z.union([z.string().datetime(), z.null()]).optional(),
    endedAt: z.union([z.string().datetime(), z.null()]).optional(),
    actualEndedAt: z.union([z.string().datetime(), z.null()]).optional(),
    shiftLabel: z.union([z.string().trim().max(100), z.null()]).optional(),
    roleLabel: z.union([z.string().trim().max(100), z.null()]).optional(),
    notes: z.union([z.string().trim().max(2000), z.null()]).optional(),
});

export async function PATCH(request: NextRequest, context: RouteContext<"/api/intervention/occupancies/[id]">) {
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
        const existing = await getDb().query.interventionOccupancies.findFirst({
            where: eq(interventionOccupancies.id, id),
        });
        if (!existing) {
            return NextResponse.json({ error: "Intervention occupancy not found." }, { status: 404 });
        }

        const nextStartedAt = parsed.data.startedAt ? new Date(parsed.data.startedAt) : null;
        const startedAtChanged = Boolean(nextStartedAt && nextStartedAt.getTime() !== existing.startedAt.getTime());
        if (startedAtChanged && !parsed.data.notes?.trim()) {
            return NextResponse.json({ error: "Motivo obrigatorio ao corrigir horario de intervencao." }, { status: 400 });
        }

        const updated = await correctInterventionOccupancy(id, {
            ...(parsed.data.doctorId ? { doctorId: parsed.data.doctorId } : {}),
            ...(parsed.data.startedAt ? { startedAt: new Date(parsed.data.startedAt) } : {}),
            ...(Object.prototype.hasOwnProperty.call(parsed.data, "boardStartedAt")
                ? { boardStartedAt: parsed.data.boardStartedAt ? new Date(parsed.data.boardStartedAt) : null }
                : {}),
            ...(Object.prototype.hasOwnProperty.call(parsed.data, "endedAt")
                ? { endedAt: parsed.data.endedAt ? new Date(parsed.data.endedAt) : null }
                : {}),
            ...(Object.prototype.hasOwnProperty.call(parsed.data, "actualEndedAt")
                ? { actualEndedAt: parsed.data.actualEndedAt ? new Date(parsed.data.actualEndedAt) : null }
                : {}),
            ...(Object.prototype.hasOwnProperty.call(parsed.data, "shiftLabel") ? { shiftLabel: parsed.data.shiftLabel ?? null } : {}),
            ...(Object.prototype.hasOwnProperty.call(parsed.data, "roleLabel") ? { roleLabel: parsed.data.roleLabel ?? null } : {}),
            ...(Object.prototype.hasOwnProperty.call(parsed.data, "notes") ? { notes: parsed.data.notes ?? null } : {}),
        }, session.user.id);

        await getDb().insert(auditLogs).values({
            actorUserId: session.user.id,
            action: "intervention_occupancy.corrected",
            entityType: "intervention_occupancy",
            entityId: updated.id,
            details: parsed.data,
        });

        return NextResponse.json({ occupancy: updated });
    } catch (error) {
        return NextResponse.json(
            { error: error instanceof Error ? error.message : "Unable to correct intervention occupancy." },
            { status: 400 },
        );
    }
}
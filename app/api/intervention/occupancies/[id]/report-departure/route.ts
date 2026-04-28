import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { getDb, hasDatabaseUrl } from "@/db";
import { auditLogs, interventionOccupancies } from "@/db/schema";
import { AuthError, requireAuthenticatedSession } from "@/lib/auth/server";
import { endInterventionOccupancy } from "@/modules/intervention/service";
import { requiresOvertimeJustification } from "@/modules/operational/board-rules";

const schema = z.object({
    endedAt: z.string().datetime(),
    actualEndedAt: z.string().datetime().optional().nullable(),
    notes: z.union([z.string().trim().max(2000), z.null()]).optional(),
});

export async function POST(request: NextRequest, context: RouteContext<"/api/intervention/occupancies/[id]/report-departure">) {
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
        return NextResponse.json({ error: "Invalid departure payload." }, { status: 400 });
    }

    const { id } = await context.params;
    try {
        const existing = await getDb().query.interventionOccupancies.findFirst({
            where: eq(interventionOccupancies.id, id),
        });
        if (!existing) {
            return NextResponse.json({ error: "Intervention occupancy not found." }, { status: 404 });
        }

        const effectiveEndedAt = parsed.data.actualEndedAt ? new Date(parsed.data.actualEndedAt) : new Date(parsed.data.endedAt);
        if (requiresOvertimeJustification(existing.startedAt, effectiveEndedAt) && !parsed.data.notes?.trim()) {
            return NextResponse.json(
                { error: "Justificativa obrigatoria para registrar saida apos 07:15 ou 19:15." },
                { status: 400 },
            );
        }

        const updated = await endInterventionOccupancy(id, {
            endedAt: new Date(parsed.data.endedAt),
            actualEndedAt: parsed.data.actualEndedAt ? new Date(parsed.data.actualEndedAt) : null,
            chiefConfirmed: true,
        }, session.user.id);

        await getDb().insert(auditLogs).values({
            actorUserId: session.user.id,
            action: "intervention_occupancy.departure_reported",
            entityType: "intervention_occupancy",
            entityId: updated.id,
            details: {
                endedAt: updated.endedAt,
                actualEndedAt: updated.actualEndedAt,
                startedAt: updated.startedAt,
                boardStartedAt: updated.boardStartedAt,
                scheduledStartAt: updated.scheduledStartAt,
                scheduledEndAt: updated.scheduledEndAt,
                notes: parsed.data.notes ?? null,
            },
        });

        return NextResponse.json({ occupancy: updated });
    } catch (error) {
        return NextResponse.json(
            { error: error instanceof Error ? error.message : "Unable to report intervention departure." },
            { status: 400 },
        );
    }
}
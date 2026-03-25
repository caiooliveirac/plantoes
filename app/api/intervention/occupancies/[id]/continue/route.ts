import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { getDb, hasDatabaseUrl } from "@/db";
import { auditLogs, interventionOccupancies } from "@/db/schema";
import { AuthError, requireAuthenticatedSession } from "@/lib/auth/server";
import { continueInterventionOccupancy } from "@/modules/intervention/service";
import { requiresOvertimeJustification } from "@/modules/operational/board-rules";

const schema = z.object({
    notes: z.union([z.string().trim().max(2000), z.null()]).optional(),
});

export async function POST(request: NextRequest, context: RouteContext<"/api/intervention/occupancies/[id]/continue">) {
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

    const parsed = schema.safeParse(await request.json().catch(() => null) ?? {});
    if (!parsed.success) {
        return NextResponse.json({ error: "Invalid continuation payload." }, { status: 400 });
    }

    const { id } = await context.params;
    try {
        const existing = await getDb().query.interventionOccupancies.findFirst({
            where: eq(interventionOccupancies.id, id),
        });
        if (!existing) {
            return NextResponse.json({ error: "Intervention occupancy not found." }, { status: 404 });
        }

        if (requiresOvertimeJustification(existing.startedAt, new Date()) && !parsed.data.notes?.trim()) {
            return NextResponse.json(
                { error: "Justificativa obrigatoria para liberar continuidade apos 07:15 ou 19:15." },
                { status: 400 },
            );
        }

        const updated = await continueInterventionOccupancy(id, {
            notes: parsed.data.notes ?? null,
        }, session.user.id);

        await getDb().insert(auditLogs).values({
            actorUserId: session.user.id,
            action: "intervention_occupancy.continuation_confirmed",
            entityType: "intervention_occupancy",
            entityId: updated.id,
            details: {
                shiftLabel: updated.shiftLabel,
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
            { error: error instanceof Error ? error.message : "Unable to confirm intervention continuation." },
            { status: 400 },
        );
    }
}
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { hasDatabaseUrl, getDb } from "@/db";
import { auditLogs } from "@/db/schema";
import { AuthError, requireAuthenticatedSession } from "@/lib/auth/server";
import { endInterventionOccupancy } from "@/modules/intervention/service";

const schema = z.object({
    endedAt: z.string().datetime(),
    actualEndedAt: z.string().datetime().optional().nullable(),
});

export async function POST(request: NextRequest, context: RouteContext<"/api/intervention/occupancies/[id]/end">) {
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
        return NextResponse.json({ error: "Invalid end payload." }, { status: 400 });
    }

    const { id } = await context.params;
    try {
        const updated = await endInterventionOccupancy(id, {
            endedAt: new Date(parsed.data.endedAt),
            actualEndedAt: parsed.data.actualEndedAt ? new Date(parsed.data.actualEndedAt) : null,
        }, session.user.id);
        await getDb().insert(auditLogs).values({
            actorUserId: session.user.id,
            action: "intervention_occupancy.ended",
            entityType: "intervention_occupancy",
            entityId: updated.id,
            details: { endedAt: updated.endedAt, actualEndedAt: updated.actualEndedAt },
        });
        return NextResponse.json({ occupancy: updated });
    } catch (error) {
        return NextResponse.json(
            { error: error instanceof Error ? error.message : "Unable to end intervention occupancy." },
            { status: 400 },
        );
    }
}
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { hasDatabaseUrl, getDb } from "@/db";
import { auditLogs, interventionBases, interventionOccupancies } from "@/db/schema";
import { AuthError, requireAuthenticatedSession } from "@/lib/auth/server";
import { endInterventionOccupancy } from "@/modules/intervention/service";
import { announceChiefKickDeparture } from "@/modules/telegram/chief-kick";

const schema = z.object({
    endedAt: z.string().datetime(),
    actualEndedAt: z.string().datetime().optional().nullable(),
    notes: z.string().optional().nullable(),
    chiefKick: z.boolean().optional(),
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
        const db = getDb();
        const endedAt = new Date(parsed.data.endedAt);
        const updated = await endInterventionOccupancy(id, {
            endedAt,
            actualEndedAt: parsed.data.actualEndedAt ? new Date(parsed.data.actualEndedAt) : null,
            chiefConfirmed: true,
        }, session.user.id);
        await db.insert(auditLogs).values({
            actorUserId: session.user.id,
            action: "intervention_occupancy.ended",
            entityType: "intervention_occupancy",
            entityId: updated.id,
            details: { endedAt: updated.endedAt, actualEndedAt: updated.actualEndedAt, notes: parsed.data.notes ?? null },
        });
        if (parsed.data.chiefKick) {
            const base = await db.query.interventionBases.findFirst({ where: eq(interventionBases.id, updated.baseId) });
            void announceChiefKickDeparture({
                seed: updated.id,
                doctorId: updated.doctorId,
                targetCode: base?.code ?? String(updated.baseId),
                endedAt,
            });
        }
        return NextResponse.json({ occupancy: updated });
    } catch (error) {
        return NextResponse.json(
            { error: error instanceof Error ? error.message : "Unable to end intervention occupancy." },
            { status: 400 },
        );
    }
}
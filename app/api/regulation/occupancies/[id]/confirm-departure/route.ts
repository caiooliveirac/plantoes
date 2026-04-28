import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { getDb, hasDatabaseUrl } from "@/db";
import { auditLogs, regulationOccupancies } from "@/db/schema";
import { AuthError, requireAuthenticatedSession } from "@/lib/auth/server";
import { correctRegulationOccupancy } from "@/modules/operational/corrections";

const schema = z.object({
    actualEndedAt: z.string().datetime().optional(),
    note: z.union([z.string().trim().max(2000), z.null()]).optional(),
});

export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
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
        return NextResponse.json({ error: "Payload de confirmacao invalido." }, { status: 400 });
    }

    const { id } = await context.params;
    const db = getDb();
    const existing = await db.query.regulationOccupancies.findFirst({
        where: eq(regulationOccupancies.id, id),
    });
    if (!existing) {
        return NextResponse.json({ error: "Regulation occupancy not found." }, { status: 404 });
    }
    if (!existing.actualEndedAt) {
        return NextResponse.json({ error: "Esta ocupacao ainda nao tem saida registrada para confirmar." }, { status: 400 });
    }

    const nextActualEndedAt = parsed.data.actualEndedAt ? new Date(parsed.data.actualEndedAt) : existing.actualEndedAt;
    if (nextActualEndedAt.getTime() < existing.startedAt.getTime()) {
        return NextResponse.json({ error: "Horario de saida nao pode ser anterior a chegada." }, { status: 400 });
    }

    try {
        const updated = await correctRegulationOccupancy(id, {
            actualEndedAt: nextActualEndedAt,
            chiefConfirmed: true,
        }, session.user.id);

        if (parsed.data.note) {
            await db.update(regulationOccupancies)
                .set({ departureConfirmedNote: parsed.data.note })
                .where(eq(regulationOccupancies.id, id));
        }

        await db.insert(auditLogs).values({
            actorUserId: session.user.id,
            action: "regulation_occupancy.departure_confirmed",
            entityType: "regulation_occupancy",
            entityId: updated.id,
            details: {
                previousActualEndedAt: existing.actualEndedAt.toISOString(),
                confirmedActualEndedAt: nextActualEndedAt.toISOString(),
                edited: nextActualEndedAt.getTime() !== existing.actualEndedAt.getTime(),
                note: parsed.data.note ?? null,
            },
        });

        return NextResponse.json({ occupancy: updated });
    } catch (error) {
        return NextResponse.json(
            { error: error instanceof Error ? error.message : "Unable to confirm regulation departure." },
            { status: 400 },
        );
    }
}

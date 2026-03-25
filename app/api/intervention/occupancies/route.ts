import { NextRequest, NextResponse } from "next/server";
import { desc, eq } from "drizzle-orm";
import { z } from "zod";
import { hasDatabaseUrl, getDb } from "@/db";
import { auditLogs, doctors, interventionBases, interventionOccupancies } from "@/db/schema";
import { AuthError, requireAuthenticatedSession } from "@/lib/auth/server";
import { startInterventionOccupancy } from "@/modules/intervention/service";

const schema = z.object({
    doctorId: z.string().uuid(),
    baseId: z.number().int().positive(),
    startedAt: z.string().datetime(),
    scheduledStartAt: z.string().datetime().optional().nullable(),
    scheduledEndAt: z.string().datetime().optional().nullable(),
    shiftLabel: z.string().trim().max(100).optional().nullable(),
    roleLabel: z.string().trim().max(100).optional().nullable(),
    source: z.enum(["manual", "telegram", "import", "admin_correction"]),
    notes: z.string().trim().max(2000).optional().nullable(),
});

export async function GET() {
    if (!hasDatabaseUrl()) {
        return NextResponse.json({ error: "DATABASE_URL is not configured for operations-v2." }, { status: 503 });
    }

    try {
        await requireAuthenticatedSession(["admin", "chief"]);
    } catch (error) {
        const status = error instanceof AuthError ? error.status : 500;
        return NextResponse.json({ error: error instanceof Error ? error.message : "Unauthorized." }, { status });
    }

    const db = getDb();
    const rows = await db
        .select({
            id: interventionOccupancies.id,
            doctorId: interventionOccupancies.doctorId,
            doctorName: doctors.fullName,
            baseId: interventionOccupancies.baseId,
            baseCode: interventionBases.code,
            baseLabel: interventionBases.label,
            startedAt: interventionOccupancies.startedAt,
            boardStartedAt: interventionOccupancies.boardStartedAt,
            endedAt: interventionOccupancies.endedAt,
            actualEndedAt: interventionOccupancies.actualEndedAt,
            shiftLabel: interventionOccupancies.shiftLabel,
            roleLabel: interventionOccupancies.roleLabel,
            source: interventionOccupancies.source,
        })
        .from(interventionOccupancies)
        .innerJoin(doctors, eq(doctors.id, interventionOccupancies.doctorId))
        .innerJoin(interventionBases, eq(interventionBases.id, interventionOccupancies.baseId))
        .orderBy(desc(interventionOccupancies.startedAt));

    return NextResponse.json({ occupancies: rows });
}

export async function POST(request: NextRequest) {
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
        return NextResponse.json({ error: "Invalid intervention occupancy payload." }, { status: 400 });
    }

    try {
        const created = await startInterventionOccupancy({
            doctorId: parsed.data.doctorId,
            baseId: parsed.data.baseId,
            startedAt: new Date(parsed.data.startedAt),
            scheduledStartAt: parsed.data.scheduledStartAt ? new Date(parsed.data.scheduledStartAt) : null,
            scheduledEndAt: parsed.data.scheduledEndAt ? new Date(parsed.data.scheduledEndAt) : null,
            shiftLabel: parsed.data.shiftLabel ?? null,
            roleLabel: parsed.data.roleLabel ?? null,
            source: parsed.data.source,
            notes: parsed.data.notes ?? null,
            createdByUserId: session.user.id,
        });

        await getDb().insert(auditLogs).values({
            actorUserId: session.user.id,
            action: "intervention_occupancy.started",
            entityType: "intervention_occupancy",
            entityId: created.id,
            details: {
                doctorId: created.doctorId,
                baseId: created.baseId,
                startedAt: created.startedAt,
            },
        });

        return NextResponse.json({ occupancy: created });
    } catch (error) {
        return NextResponse.json(
            { error: error instanceof Error ? error.message : "Unable to start intervention occupancy." },
            { status: 400 },
        );
    }
}
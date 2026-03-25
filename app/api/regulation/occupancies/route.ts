import { NextRequest, NextResponse } from "next/server";
import { and, desc, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { hasDatabaseUrl, getDb } from "@/db";
import { auditLogs, doctors, regulationOccupancies, regulationPosts } from "@/db/schema";
import { AuthError, requireAuthenticatedSession } from "@/lib/auth/server";
import { startRegulationOccupancy } from "@/modules/regulation/service";

const schema = z.object({
    doctorId: z.string().uuid(),
    postId: z.number().int().positive(),
    startedAt: z.string().datetime(),
    scheduledStartAt: z.string().datetime().optional().nullable(),
    scheduledEndAt: z.string().datetime().optional().nullable(),
    shiftLabel: z.string().trim().max(100).optional().nullable(),
    roleLabel: z.string().trim().max(100).optional().nullable(),
    ramalLabel: z.string().trim().max(50).optional().nullable(),
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
            id: regulationOccupancies.id,
            doctorId: regulationOccupancies.doctorId,
            doctorName: doctors.fullName,
            postId: regulationOccupancies.postId,
            postCode: regulationPosts.code,
            postLabel: regulationPosts.label,
            startedAt: regulationOccupancies.startedAt,
            boardStartedAt: regulationOccupancies.boardStartedAt,
            endedAt: regulationOccupancies.endedAt,
            actualEndedAt: regulationOccupancies.actualEndedAt,
            shiftLabel: regulationOccupancies.shiftLabel,
            roleLabel: regulationOccupancies.roleLabel,
            ramalLabel: regulationOccupancies.ramalLabel,
            source: regulationOccupancies.source,
        })
        .from(regulationOccupancies)
        .innerJoin(doctors, eq(doctors.id, regulationOccupancies.doctorId))
        .innerJoin(regulationPosts, eq(regulationPosts.id, regulationOccupancies.postId))
        .orderBy(desc(regulationOccupancies.startedAt));

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
        return NextResponse.json({ error: "Invalid regulation occupancy payload." }, { status: 400 });
    }

    try {
        const created = await startRegulationOccupancy({
            doctorId: parsed.data.doctorId,
            postId: parsed.data.postId,
            startedAt: new Date(parsed.data.startedAt),
            scheduledStartAt: parsed.data.scheduledStartAt ? new Date(parsed.data.scheduledStartAt) : null,
            scheduledEndAt: parsed.data.scheduledEndAt ? new Date(parsed.data.scheduledEndAt) : null,
            shiftLabel: parsed.data.shiftLabel ?? null,
            roleLabel: parsed.data.roleLabel ?? null,
            ramalLabel: parsed.data.ramalLabel ?? null,
            source: parsed.data.source,
            notes: parsed.data.notes ?? null,
            createdByUserId: session.user.id,
        });

        await getDb().insert(auditLogs).values({
            actorUserId: session.user.id,
            action: "regulation_occupancy.started",
            entityType: "regulation_occupancy",
            entityId: created.id,
            details: {
                doctorId: created.doctorId,
                postId: created.postId,
                startedAt: created.startedAt,
            },
        });

        return NextResponse.json({ occupancy: created });
    } catch (error) {
        return NextResponse.json(
            { error: error instanceof Error ? error.message : "Unable to start regulation occupancy." },
            { status: 400 },
        );
    }
}
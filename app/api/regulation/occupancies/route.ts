import { NextRequest, NextResponse } from "next/server";
import { and, desc, eq, isNull, ne } from "drizzle-orm";
import { z } from "zod";
import { hasDatabaseUrl, getDb } from "@/db";
import { auditLogs, doctors, regulationOccupancies, regulationPosts } from "@/db/schema";
import { AuthError, requireAuthenticatedSession } from "@/lib/auth/server";
import { describeConflicts, findSameDayOccupancies } from "@/services/duplicate-occupancy-guard";
import { startRegulationOccupancy } from "@/modules/regulation/service";

const schema = z.object({
    doctorId: z.string().uuid(),
    postId: z.number().int().positive(),
    continuityGroupId: z.string().uuid().optional().nullable(),
    previousOccupancyId: z.string().uuid().optional().nullable(),
    isContinuityEntry: z.boolean().optional(),
    startedAt: z.string().datetime(),
    boardStartedAt: z.string().datetime().optional().nullable(),
    scheduledStartAt: z.string().datetime().optional().nullable(),
    scheduledEndAt: z.string().datetime().optional().nullable(),
    shiftLabel: z.string().trim().max(100).optional().nullable(),
    roleLabel: z.string().trim().max(100).optional().nullable(),
    ramalLabel: z.string().trim().max(50).optional().nullable(),
    source: z.enum(["manual", "telegram", "import", "admin_correction"]),
    notes: z.string().trim().max(2000).optional().nullable(),
    /** Marcado pelo admin depois de ver o aviso de plantão duplicado. */
    confirmDuplicate: z.boolean().optional(),
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

    // Plantão duplicado no mesmo dia e turno infla o valor da nota e costuma
    // passar despercebido até o fechamento. Avisa e exige confirmação.
    if (!parsed.data.confirmDuplicate) {
        const conflitos = await findSameDayOccupancies({
            doctorId: parsed.data.doctorId,
            startedAt: new Date(parsed.data.startedAt),
            shiftLabel: parsed.data.shiftLabel ?? null,
            continuityGroupId: parsed.data.continuityGroupId ?? null,
        });
        if (conflitos.length > 0) {
            return NextResponse.json({
                error: describeConflicts(conflitos),
                needsDuplicateConfirmation: true,
                conflicts: conflitos,
            }, { status: 409 });
        }
    }

    try {
        const created = await startRegulationOccupancy({
            doctorId: parsed.data.doctorId,
            postId: parsed.data.postId,
            continuityGroupId: parsed.data.continuityGroupId ?? null,
            previousOccupancyId: parsed.data.previousOccupancyId ?? null,
            isContinuityEntry: parsed.data.isContinuityEntry ?? false,
            startedAt: new Date(parsed.data.startedAt),
            boardStartedAt: parsed.data.boardStartedAt ? new Date(parsed.data.boardStartedAt) : null,
            scheduledStartAt: parsed.data.scheduledStartAt ? new Date(parsed.data.scheduledStartAt) : null,
            scheduledEndAt: parsed.data.scheduledEndAt ? new Date(parsed.data.scheduledEndAt) : null,
            shiftLabel: parsed.data.shiftLabel ?? null,
            roleLabel: parsed.data.roleLabel ?? null,
            ramalLabel: parsed.data.ramalLabel ?? null,
            source: parsed.data.source,
            notes: parsed.data.notes ?? null,
            createdByUserId: session.user.id,
        });

        // Detect if the start displaced someone (for undo support)
        const displacedOccupancy = await getDb().query.regulationOccupancies.findFirst({
            where: and(
                eq(regulationOccupancies.postId, created.postId),
                eq(regulationOccupancies.endedAt, created.startedAt),
                ne(regulationOccupancies.id, created.id),
            ),
            orderBy: [desc(regulationOccupancies.startedAt)],
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
                shiftLabel: created.shiftLabel,
                displacedOccupancyId: displacedOccupancy?.id ?? null,
                displacedDoctorId: displacedOccupancy?.doctorId ?? null,
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
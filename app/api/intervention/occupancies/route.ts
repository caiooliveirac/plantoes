import { NextRequest, NextResponse } from "next/server";
import { and, desc, eq, isNull, ne } from "drizzle-orm";
import { z } from "zod";
import { hasDatabaseUrl, getDb } from "@/db";
import { auditLogs, doctors, interventionBases, interventionOccupancies } from "@/db/schema";
import { AuthError, requireAuthenticatedSession } from "@/lib/auth/server";
import {
    describeConflicts,
    describeMergeable,
    findMergeableOccupancy,
    findSameDayOccupancies,
} from "@/services/duplicate-occupancy-guard";
import { startInterventionOccupancy } from "@/modules/intervention/service";

const schema = z.object({
    doctorId: z.string().uuid(),
    baseId: z.number().int().positive(),
    continuityGroupId: z.string().uuid().optional().nullable(),
    previousOccupancyId: z.string().uuid().optional().nullable(),
    isContinuityEntry: z.boolean().optional(),
    startedAt: z.string().datetime(),
    boardStartedAt: z.string().datetime().optional().nullable(),
    scheduledStartAt: z.string().datetime().optional().nullable(),
    scheduledEndAt: z.string().datetime().optional().nullable(),
    shiftLabel: z.string().trim().max(100).optional().nullable(),
    roleLabel: z.string().trim().max(100).optional().nullable(),
    source: z.enum(["manual", "telegram", "import", "admin_correction"]),
    notes: z.string().trim().max(2000).optional().nullable(),
    /** Marcado pelo admin depois de ver o aviso de plantão duplicado. */
    confirmDuplicate: z.boolean().optional(),
    /**
     * Marcado depois de ver o plantão que já existe nesta janela e informar o
     * horário verdadeiro de chegada: a chegada JUNTA com ele em vez de criar
     * uma segunda linha.
     */
    confirmMerge: z.boolean().optional(),
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

    // Mesmo médico, mesma base, janela ainda aberta para esta chegada: não é
    // plantão novo. Mostra o que existe e pede o horário verdadeiro antes de juntar.
    if (!parsed.data.confirmMerge) {
        const mergeable = await findMergeableOccupancy({
            domain: "intervention",
            targetId: parsed.data.baseId,
            doctorId: parsed.data.doctorId,
            startedAt: new Date(parsed.data.startedAt),
        });
        if (mergeable) {
            return NextResponse.json({
                error: describeMergeable(mergeable),
                needsMergeConfirmation: true,
                mergeable,
            }, { status: 409 });
        }
    }

    try {
        const created = await startInterventionOccupancy({
            doctorId: parsed.data.doctorId,
            baseId: parsed.data.baseId,
            continuityGroupId: parsed.data.continuityGroupId ?? null,
            previousOccupancyId: parsed.data.previousOccupancyId ?? null,
            isContinuityEntry: parsed.data.isContinuityEntry ?? false,
            startedAt: new Date(parsed.data.startedAt),
            boardStartedAt: parsed.data.boardStartedAt ? new Date(parsed.data.boardStartedAt) : null,
            scheduledStartAt: parsed.data.scheduledStartAt ? new Date(parsed.data.scheduledStartAt) : null,
            scheduledEndAt: parsed.data.scheduledEndAt ? new Date(parsed.data.scheduledEndAt) : null,
            shiftLabel: parsed.data.shiftLabel ?? null,
            roleLabel: parsed.data.roleLabel ?? null,
            source: parsed.data.source,
            notes: parsed.data.notes ?? null,
            createdByUserId: session.user.id,
        });

        // Detect if the start displaced someone (for undo support)
        const displacedOccupancy = await getDb().query.interventionOccupancies.findFirst({
            where: and(
                eq(interventionOccupancies.baseId, created.baseId),
                eq(interventionOccupancies.endedAt, created.startedAt),
                ne(interventionOccupancies.id, created.id),
            ),
            orderBy: [desc(interventionOccupancies.startedAt)],
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
                shiftLabel: created.shiftLabel,
                displacedOccupancyId: displacedOccupancy?.id ?? null,
                displacedDoctorId: displacedOccupancy?.doctorId ?? null,
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
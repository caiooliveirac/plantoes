import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getDb, hasDatabaseUrl } from "@/db";
import { auditLogs } from "@/db/schema";
import { AuthError, requireAuthenticatedSession } from "@/lib/auth/server";
import { transferOperationalOccupancy } from "@/modules/operational/corrections";

const targetSchema = z.object({
    domain: z.enum(["regulation", "intervention"]),
    targetId: z.number().int().positive(),
});

const schema = z.object({
    sourceDomain: z.enum(["regulation", "intervention"]),
    sourceOccupancyId: z.string().uuid(),
    destination: targetSchema,
    roleLabel: z.union([z.string().trim().max(100), z.null()]).optional(),
    notes: z.string().trim().min(8).max(2000),
    conflictResolution: z.object({
        strategy: z.enum(["remove_destination", "move_destination"]),
        relocationTarget: targetSchema.optional().nullable(),
    }).optional().nullable(),
});

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
        return NextResponse.json({ error: "Payload invalido para remanejamento operacional." }, { status: 400 });
    }

    if (
        parsed.data.conflictResolution?.strategy === "move_destination"
        && !parsed.data.conflictResolution.relocationTarget
    ) {
        return NextResponse.json({ error: "Escolha o destino alternativo de quem esta lotado no destino atual." }, { status: 400 });
    }

    try {
        const transfer = await transferOperationalOccupancy(parsed.data.sourceOccupancyId, {
            sourceDomain: parsed.data.sourceDomain,
            destination: parsed.data.destination,
            roleLabel: parsed.data.roleLabel ?? null,
            notes: parsed.data.notes,
            conflictResolution: parsed.data.conflictResolution
                ? {
                    strategy: parsed.data.conflictResolution.strategy,
                    relocationTarget: parsed.data.conflictResolution.relocationTarget ?? null,
                }
                : null,
        }, session.user.id);

        await getDb().insert(auditLogs).values({
            actorUserId: session.user.id,
            action: "operational_occupancy.transferred",
            entityType: "operational_transfer",
            entityId: transfer.movedOccupancyId,
            details: {
                sourceDomain: parsed.data.sourceDomain,
                sourceOccupancyId: parsed.data.sourceOccupancyId,
                destination: parsed.data.destination,
                roleLabel: parsed.data.roleLabel ?? null,
                notes: parsed.data.notes,
                conflictResolution: parsed.data.conflictResolution ?? null,
                movedOccupancyId: transfer.movedOccupancyId,
                movedDomain: transfer.movedDomain,
                displaced: transfer.displaced,
                sourceContinuityGroupId: transfer.sourceContinuityGroupId,
            },
        });

        return NextResponse.json({ transfer });
    } catch (error) {
        return NextResponse.json(
            { error: error instanceof Error ? error.message : "Nao foi possivel remanejar a ocupacao operacional." },
            { status: 400 },
        );
    }
}
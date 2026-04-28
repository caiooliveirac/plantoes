import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getDb, hasDatabaseUrl } from "@/db";
import { auditLogs } from "@/db/schema";
import { AuthError, requireAuthenticatedSession } from "@/lib/auth/server";
import { deactivateInterventionBase, reactivateInterventionBase } from "@/modules/intervention/service";

const schema = z.object({
    action: z.enum(["deactivate", "reactivate"]),
    effectiveAt: z.string().datetime().optional().nullable(),
    notes: z.string().trim().max(2000).optional().nullable(),
});

export async function POST(request: NextRequest, context: RouteContext<"/api/intervention/bases/[id]/state">) {
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
        return NextResponse.json({ error: "Invalid intervention base state payload." }, { status: 400 });
    }

    const params = await context.params;
    const baseId = Number(params.id);
    if (!Number.isInteger(baseId) || baseId <= 0) {
        return NextResponse.json({ error: "Invalid intervention base id." }, { status: 400 });
    }

    try {
        if (parsed.data.action === "deactivate") {
            const result = await deactivateInterventionBase({
                baseId,
                deactivatedAt: parsed.data.effectiveAt ? new Date(parsed.data.effectiveAt) : new Date(),
                notes: parsed.data.notes ?? null,
                createdByUserId: session.user.id,
            });

            await getDb().insert(auditLogs).values({
                actorUserId: session.user.id,
                action: "intervention_base.deactivated",
                entityType: "intervention_base",
                entityId: String(baseId),
                details: {
                    deactivatedAt: result.state.deactivatedAt,
                    notes: result.state.notes,
                    closedOccupancyIds: result.closedOccupancyIds,
                },
            });

            return NextResponse.json({
                state: result.state,
                closedOccupancyIds: result.closedOccupancyIds,
            });
        }

        const state = await reactivateInterventionBase({
            baseId,
            reactivatedAt: parsed.data.effectiveAt ? new Date(parsed.data.effectiveAt) : new Date(),
            updatedByUserId: session.user.id,
        });

        await getDb().insert(auditLogs).values({
            actorUserId: session.user.id,
            action: "intervention_base.reactivated",
            entityType: "intervention_base",
            entityId: String(baseId),
            details: {
                deactivatedAt: state.deactivatedAt,
                reactivatedAt: state.reactivatedAt,
                notes: parsed.data.notes ?? null,
            },
        });

        return NextResponse.json({ state });
    } catch (error) {
        return NextResponse.json(
            { error: error instanceof Error ? error.message : "Unable to update intervention base state." },
            { status: 400 },
        );
    }
}
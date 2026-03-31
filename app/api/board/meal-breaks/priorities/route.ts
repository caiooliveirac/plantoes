import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { hasDatabaseUrl, getDb } from "@/db";
import { auditLogs } from "@/db/schema";
import { AuthError, requireAuthenticatedSession } from "@/lib/auth/server";
import { getCurrentMealBreakPriorityView, updateMealBreakPriorityOrder } from "@/modules/telegram/meal-breaks";

const patchSchema = z.object({
    ramal: z.string().trim().regex(/^\d{4}$/),
    targetIndex: z.number().int().min(0),
    notes: z.string().trim().min(3).max(500),
    referenceAt: z.string().datetime().optional(),
});

async function requireChiefSession() {
    return requireAuthenticatedSession(["admin", "chief"]);
}

export async function GET(request: NextRequest) {
    if (!hasDatabaseUrl()) {
        return NextResponse.json({ error: "DATABASE_URL is not configured for operations-v2." }, { status: 503 });
    }

    try {
        await requireChiefSession();
        const referenceAt = request.nextUrl.searchParams.get("referenceAt");
        const priorities = await getCurrentMealBreakPriorityView({
            referenceAt: referenceAt ? new Date(referenceAt) : new Date(),
        });
        return NextResponse.json({ priorities });
    } catch (error) {
        const status = error instanceof AuthError ? error.status : 400;
        if (status === 400) {
            return NextResponse.json(
                { error: error instanceof Error ? error.message : "Unable to load meal-break priorities." },
                { status },
            );
        }

        return NextResponse.json(
            { error: error instanceof Error ? error.message : "Unauthorized." },
            { status },
        );
    }
}

export async function PATCH(request: NextRequest) {
    if (!hasDatabaseUrl()) {
        return NextResponse.json({ error: "DATABASE_URL is not configured for operations-v2." }, { status: 503 });
    }

    let session;
    try {
        session = await requireChiefSession();
    } catch (error) {
        const status = error instanceof AuthError ? error.status : 401;
        return NextResponse.json({ error: error instanceof Error ? error.message : "Unauthorized." }, { status });
    }

    const parsed = patchSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
        return NextResponse.json({ error: "Invalid meal-break priority payload." }, { status: 400 });
    }

    const referenceAt = parsed.data.referenceAt ? new Date(parsed.data.referenceAt) : new Date();

    try {
        const priorities = await updateMealBreakPriorityOrder({
            ramal: parsed.data.ramal,
            targetIndex: parsed.data.targetIndex,
            notes: parsed.data.notes,
            referenceAt,
            actorUserId: session.user.id,
        });

        await getDb().insert(auditLogs).values({
            actorUserId: session.user.id,
            action: "meal_break.priority_reordered",
            entityType: "telegram_meal_break_priority_overrides",
            entityId: `${priorities.operationalDate}:${priorities.mode}`,
            details: {
                ramal: parsed.data.ramal,
                targetIndex: parsed.data.targetIndex,
                notes: parsed.data.notes,
                updatedAt: priorities.updatedAt,
            },
        });

        return NextResponse.json({ priorities });
    } catch (error) {
        return NextResponse.json(
            { error: error instanceof Error ? error.message : "Unable to update meal-break priorities." },
            { status: 400 },
        );
    }
}
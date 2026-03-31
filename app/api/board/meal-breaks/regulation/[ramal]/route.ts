import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { hasDatabaseUrl, getDb } from "@/db";
import { auditLogs } from "@/db/schema";
import { AuthError, requireAuthenticatedSession } from "@/lib/auth/server";
import { updateDayMealBreakEligibility, updateNightMealBreakAssignment } from "@/modules/telegram/meal-breaks";

const schema = z.object({
    nightWorkSlot: z.union([z.enum(["23:00", "03:00"]), z.null()]).optional(),
    dinnerSlot: z.union([z.enum(["20:30", "21:00", "21:30", "22:00", "22:30"]), z.null()]).optional(),
    lunchExcluded: z.boolean().optional(),
    restExcluded: z.boolean().optional(),
    referenceAt: z.string().datetime().optional(),
    notes: z.union([z.string().trim().max(500), z.null()]).optional(),
});

export async function PATCH(request: NextRequest, context: RouteContext<"/api/board/meal-breaks/regulation/[ramal]">) {
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
        return NextResponse.json({ error: "Invalid meal-break correction payload." }, { status: 400 });
    }

    const { ramal } = await context.params;
    const referenceAt = parsed.data.referenceAt ? new Date(parsed.data.referenceAt) : new Date();
    const hasDayPayload = Object.prototype.hasOwnProperty.call(parsed.data, "lunchExcluded") || Object.prototype.hasOwnProperty.call(parsed.data, "restExcluded");
    const hasNightPayload = Object.prototype.hasOwnProperty.call(parsed.data, "nightWorkSlot") || Object.prototype.hasOwnProperty.call(parsed.data, "dinnerSlot");

    if (!hasDayPayload && !hasNightPayload) {
        return NextResponse.json({ error: "Invalid meal-break correction payload." }, { status: 400 });
    }

    try {
        if (hasDayPayload) {
            const result = await updateDayMealBreakEligibility({
                ramal,
                referenceAt,
                actorTelegramId: session.user.id,
                ...(Object.prototype.hasOwnProperty.call(parsed.data, "lunchExcluded") ? { lunchExcluded: parsed.data.lunchExcluded } : {}),
                ...(Object.prototype.hasOwnProperty.call(parsed.data, "restExcluded") ? { restExcluded: parsed.data.restExcluded } : {}),
            });

            await getDb().insert(auditLogs).values({
                actorUserId: session.user.id,
                action: "meal_break.day_eligibility_corrected",
                entityType: "telegram_meal_break_eligibility_overrides",
                entityId: `${result.overrides.operationalDate}:day`,
                details: {
                    ramal,
                    lunchExcluded: Object.prototype.hasOwnProperty.call(parsed.data, "lunchExcluded") ? parsed.data.lunchExcluded : undefined,
                    restExcluded: Object.prototype.hasOwnProperty.call(parsed.data, "restExcluded") ? parsed.data.restExcluded : undefined,
                    notes: parsed.data.notes ?? null,
                    sessionStage: result.session?.stage ?? null,
                    updatedAt: result.overrides.updatedAt,
                },
            });

            return NextResponse.json({ session: result.session, overrides: result.overrides });
        }

        const updatedSession = await updateNightMealBreakAssignment({
            ramal,
            referenceAt,
            actorTelegramId: session.user.id,
            ...(Object.prototype.hasOwnProperty.call(parsed.data, "nightWorkSlot") ? { nightWorkSlot: parsed.data.nightWorkSlot ?? null } : {}),
            ...(Object.prototype.hasOwnProperty.call(parsed.data, "dinnerSlot") ? { dinnerSlot: parsed.data.dinnerSlot ?? null } : {}),
        });

        await getDb().insert(auditLogs).values({
            actorUserId: session.user.id,
            action: "meal_break.night_assignment_corrected",
            entityType: "telegram_meal_break_session",
            entityId: `${updatedSession.operationalDate}:night`,
            details: {
                ramal,
                nightWorkSlot: Object.prototype.hasOwnProperty.call(parsed.data, "nightWorkSlot") ? parsed.data.nightWorkSlot ?? null : undefined,
                dinnerSlot: Object.prototype.hasOwnProperty.call(parsed.data, "dinnerSlot") ? parsed.data.dinnerSlot ?? null : undefined,
                notes: parsed.data.notes ?? null,
                stage: updatedSession.stage,
                updatedAt: updatedSession.updatedAt,
            },
        });

        return NextResponse.json({ session: updatedSession });
    } catch (error) {
        return NextResponse.json(
            { error: error instanceof Error ? error.message : "Unable to update meal-break assignment." },
            { status: 400 },
        );
    }
}
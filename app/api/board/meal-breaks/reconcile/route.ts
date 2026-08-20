import { NextRequest, NextResponse } from "next/server";
import { hasDatabaseUrl, getDb } from "@/db";
import { auditLogs } from "@/db/schema";
import { AuthError, requireAuthenticatedSession } from "@/lib/auth/server";
import { maybeReconcileLiveMealBreakSession } from "@/modules/telegram/meal-breaks";

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

    const body = await request.json().catch(() => null) as { referenceAt?: string } | null;
    const referenceAt = body?.referenceAt ? new Date(body.referenceAt) : new Date();

    try {
        const result = await maybeReconcileLiveMealBreakSession({
            trigger: "manual",
            actorTelegramId: session.user.id,
            referenceAt,
        });

        if (result.session) {
            await getDb().insert(auditLogs).values({
                actorUserId: session.user.id,
                action: "meal_break.session_reconciled",
                entityType: "telegram_meal_break_session",
                entityId: `${result.session.operationalDate}:${result.session.mode}`,
                details: {
                    kind: result.evaluation?.kind ?? null,
                    stage: result.session.stage,
                    rosterCount: result.session.roster.length,
                    source: "panel",
                },
            });
        }

        return NextResponse.json({
            session: result.session,
            evaluation: result.evaluation,
        });
    } catch (error) {
        return NextResponse.json(
            { error: error instanceof Error ? error.message : "Não consegui atualizar a divisão." },
            { status: 400 },
        );
    }
}

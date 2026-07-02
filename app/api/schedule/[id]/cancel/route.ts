import { NextRequest, NextResponse } from "next/server";
import { hasDatabaseUrl } from "@/db";
import { AuthError, requireAuthenticatedSession } from "@/lib/auth/server";
import { cancelScheduledShift } from "@/services/schedule.service";

export async function POST(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    if (!hasDatabaseUrl()) {
        return NextResponse.json({ error: "database_unavailable" }, { status: 503 });
    }

    try {
        const session = await requireAuthenticatedSession(["admin", "chief"]);
        const { id } = await params;
        const cancelled = await cancelScheduledShift(id, session.user.id);
        return NextResponse.json({ shift: cancelled });
    } catch (error) {
        if (error instanceof AuthError) {
            return NextResponse.json({ error: error.message }, { status: error.status });
        }
        if (error instanceof Error) {
            return NextResponse.json({ error: error.message }, { status: 409 });
        }
        throw error;
    }
}

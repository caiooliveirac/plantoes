import { NextResponse } from "next/server";
import { hasDatabaseUrl } from "@/db";
import { AuthError, requireAuthenticatedSession } from "@/lib/auth/server";
import { getUndoableActions } from "@/modules/operational/undo";

export async function GET() {
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

    try {
        const actions = await getUndoableActions(session.user.id);
        return NextResponse.json({ actions });
    } catch (error) {
        return NextResponse.json(
            { error: error instanceof Error ? error.message : "Falha ao buscar ações desfazíveis." },
            { status: 400 },
        );
    }
}

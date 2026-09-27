import { NextResponse } from "next/server";
import { hasDatabaseUrl } from "@/db";
import { AuthError, requireSessionForRead } from "@/lib/auth/server";
import { getOperationalBoard } from "@/services/board.service";

export async function GET() {
    if (!hasDatabaseUrl()) {
        return NextResponse.json(
            {
                error: "DATABASE_URL is not configured for operations-v2.",
            },
            { status: 503 },
        );
    }

    // Quadro fechado (lib/auth/portao.ts): nomes por ramal/base só com sessão.
    try {
        await requireSessionForRead();
    } catch (error) {
        const status = error instanceof AuthError ? error.status : 401;
        return NextResponse.json({ error: error instanceof Error ? error.message : "Unauthorized." }, { status });
    }

    const board = await getOperationalBoard();
    return NextResponse.json(board);
}

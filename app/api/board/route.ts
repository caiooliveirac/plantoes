import { NextResponse } from "next/server";
import { hasDatabaseUrl } from "@/db";
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

    const board = await getOperationalBoard();
    return NextResponse.json(board);
}

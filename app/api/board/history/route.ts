import { NextRequest, NextResponse } from "next/server";
import { hasDatabaseUrl } from "@/db";
import { AuthError, requireAuthenticatedSession } from "@/lib/auth/server";
import { getHistoricalOperationalBoard } from "@/services/operational-history.service";

export async function GET(request: NextRequest) {
    if (!hasDatabaseUrl()) {
        return NextResponse.json(
            { error: "DATABASE_URL is not configured for operations-v2." },
            { status: 503 },
        );
    }

    try {
        await requireAuthenticatedSession(["admin", "chief"]);
    } catch (error) {
        const status = error instanceof AuthError ? error.status : 500;
        return NextResponse.json({ error: error instanceof Error ? error.message : "Unauthorized." }, { status });
    }

    const date = request.nextUrl.searchParams.get("date");
    const shift = request.nextUrl.searchParams.get("shift");

    if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        return NextResponse.json({ error: "date must use YYYY-MM-DD." }, { status: 400 });
    }

    if (shift && shift !== "SD" && shift !== "SN") {
        return NextResponse.json({ error: "shift must be SD or SN." }, { status: 400 });
    }

    if ((date && !shift) || (!date && shift)) {
        return NextResponse.json({ error: "date and shift must be informed together." }, { status: 400 });
    }

    try {
        const board = await getHistoricalOperationalBoard({
            operationalDate: date,
            shiftLabel: (shift as "SD" | "SN" | null) ?? null,
        });
        return NextResponse.json(board);
    } catch (error) {
        return NextResponse.json(
            { error: error instanceof Error ? error.message : "Unable to load historical operational board." },
            { status: 400 },
        );
    }
}
import { NextRequest, NextResponse } from "next/server";
import { hasDatabaseUrl } from "@/db";
import { AuthError, requireAuthenticatedSession } from "@/lib/auth/server";
import { getCoverageReport } from "@/services/shift-swaps.service";

export async function GET(request: NextRequest) {
    if (!hasDatabaseUrl()) {
        return NextResponse.json({ error: "database_unavailable" }, { status: 503 });
    }

    try {
        await requireAuthenticatedSession(["admin", "chief"]);
        const date = request.nextUrl.searchParams.get("date");
        if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
            return NextResponse.json({ error: "invalid_date" }, { status: 400 });
        }

        const rows = await getCoverageReport(date);
        return NextResponse.json({ date, rows });
    } catch (error) {
        if (error instanceof AuthError) {
            return NextResponse.json({ error: error.message }, { status: error.status });
        }
        throw error;
    }
}

import { NextResponse } from "next/server";
import { hasDatabaseUrl } from "@/db";
import { readAuthenticatedSession } from "@/lib/auth/server";

export async function GET() {
    if (!hasDatabaseUrl()) {
        return NextResponse.json({ error: "DATABASE_URL is not configured for operations-v2." }, { status: 503 });
    }

    const session = await readAuthenticatedSession();
    if (!session) {
        return NextResponse.json({ error: "not_authenticated" }, { status: 401 });
    }

    return NextResponse.json({ session });
}
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { hasDatabaseUrl } from "@/db";
import { AuthError, requireAuthenticatedSession } from "@/lib/auth/server";
import { listChiefAccessRequests, listChiefAssignments, submitChiefAccessRequest } from "@/services/chief-access.service";

const schema = z.object({
    token: z.string().min(1),
    doctorId: z.string().uuid(),
    requestedEmail: z.string().email(),
    phone: z.string().trim().min(10).max(30),
    registrationNumber: z.string().trim().min(1).max(100),
    selfieUrl: z.string().trim().min(1),
    password: z.string().min(8),
});

export async function GET() {
    if (!hasDatabaseUrl()) {
        return NextResponse.json({ error: "DATABASE_URL is not configured for operations-v2." }, { status: 503 });
    }

    try {
        await requireAuthenticatedSession(["admin"]);
    } catch (error) {
        const status = error instanceof AuthError ? error.status : 500;
        return NextResponse.json({ error: error instanceof Error ? error.message : "Unauthorized." }, { status });
    }

    const [requests, assignments] = await Promise.all([
        listChiefAccessRequests(),
        listChiefAssignments(),
    ]);

    return NextResponse.json({ requests, assignments });
}

export async function POST(request: NextRequest) {
    if (!hasDatabaseUrl()) {
        return NextResponse.json({ error: "DATABASE_URL is not configured for operations-v2." }, { status: 503 });
    }

    const parsed = schema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
        return NextResponse.json({ error: "Invalid chief access payload." }, { status: 400 });
    }

    try {
        const created = await submitChiefAccessRequest(parsed.data);
        return NextResponse.json({ request: created });
    } catch (error) {
        return NextResponse.json(
            { error: error instanceof Error ? error.message : "Unable to submit chief request." },
            { status: 400 },
        );
    }
}
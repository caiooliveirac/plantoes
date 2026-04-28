import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { hasDatabaseUrl } from "@/db";
import { AuthError, requireAuthenticatedSession } from "@/lib/auth/server";
import { reviewChiefAccessRequest } from "@/services/chief-access.service";

const schema = z.object({
    decision: z.enum(["approved", "rejected"]),
    reviewNotes: z.string().trim().max(1000).optional(),
});

export async function POST(request: NextRequest, context: RouteContext<"/api/chief/requests/[id]/review">) {
    if (!hasDatabaseUrl()) {
        return NextResponse.json({ error: "DATABASE_URL is not configured for operations-v2." }, { status: 503 });
    }

    let session;
    try {
        session = await requireAuthenticatedSession(["admin"]);
    } catch (error) {
        const status = error instanceof AuthError ? error.status : 500;
        return NextResponse.json({ error: error instanceof Error ? error.message : "Unauthorized." }, { status });
    }

    const parsed = schema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
        return NextResponse.json({ error: "Invalid review payload." }, { status: 400 });
    }

    const { id } = await context.params;
    try {
        const updated = await reviewChiefAccessRequest(
            {
                requestId: id,
                decision: parsed.data.decision,
                reviewNotes: parsed.data.reviewNotes,
            },
            session.user.id,
        );

        return NextResponse.json({ request: updated });
    } catch (error) {
        return NextResponse.json(
            { error: error instanceof Error ? error.message : "Unable to review chief access request." },
            { status: 400 },
        );
    }
}
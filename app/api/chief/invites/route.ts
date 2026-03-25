import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { hasDatabaseUrl } from "@/db";
import { AuthError, requireAuthenticatedSession } from "@/lib/auth/server";
import { createChiefInvite, listChiefInvites } from "@/services/chief-access.service";

const schema = z.object({
    email: z.string().email().optional(),
    inviteMode: z.enum(["email", "bearer"]),
    expiresAt: z.string().datetime(),
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

    const invites = await listChiefInvites();
    return NextResponse.json({ invites });
}

export async function POST(request: NextRequest) {
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
        return NextResponse.json({ error: "Invalid invite payload." }, { status: 400 });
    }

    try {
        const invite = await createChiefInvite(
            {
                email: parsed.data.email,
                inviteMode: parsed.data.inviteMode,
                expiresAt: new Date(parsed.data.expiresAt),
            },
            session.user.id,
        );

        return NextResponse.json({
            invite,
            invitePath: `/api/chief/invites/${invite.token}`,
        });
    } catch (error) {
        return NextResponse.json(
            { error: error instanceof Error ? error.message : "Unable to create chief invite." },
            { status: 400 },
        );
    }
}
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { hasDatabaseUrl } from "@/db";
import { authenticateWithPassword } from "@/services/auth.service";
import { writeSessionCookie } from "@/lib/auth/server";

const schema = z.object({
    email: z.string().email(),
    password: z.string().min(1),
});

const statusCodeByError = {
    invalid_credentials: 401,
    inactive_account: 403,
    no_roles_assigned: 403,
    pending_chief_approval: 403,
    rejected_chief_approval: 403,
} as const;

export async function POST(request: NextRequest) {
    if (!hasDatabaseUrl()) {
        return NextResponse.json({ error: "DATABASE_URL is not configured for operations-v2." }, { status: 503 });
    }

    const parsed = schema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
        return NextResponse.json({ error: "email and password are required." }, { status: 400 });
    }

    const result = await authenticateWithPassword(parsed.data.email, parsed.data.password);
    if (result.status !== "success") {
        return NextResponse.json({ error: result.status }, { status: statusCodeByError[result.status] });
    }

    const expiresAt = await writeSessionCookie(result.user.id);
    return NextResponse.json({
        session: {
            user: result.user,
            expiresAt: expiresAt.toISOString(),
        },
    });
}
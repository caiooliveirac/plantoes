import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { hasDatabaseUrl } from "@/db";
import { consumePasswordReset, getPasswordResetToken } from "@/services/auth.service";

const schema = z.object({
    password: z.string().min(8),
});

export async function GET(_request: NextRequest, context: RouteContext<"/api/auth/password-reset/[token]">) {
    if (!hasDatabaseUrl()) {
        return NextResponse.json({ error: "DATABASE_URL is not configured for operations-v2." }, { status: 503 });
    }

    const { token } = await context.params;
    const resetToken = await getPasswordResetToken(token);
    if (!resetToken) {
        return NextResponse.json({ error: "invalid_token" }, { status: 404 });
    }

    return NextResponse.json({ email: resetToken.email });
}

export async function POST(request: NextRequest, context: RouteContext<"/api/auth/password-reset/[token]">) {
    if (!hasDatabaseUrl()) {
        return NextResponse.json({ error: "DATABASE_URL is not configured for operations-v2." }, { status: 503 });
    }

    const parsed = schema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
        return NextResponse.json({ error: "A password with at least 8 characters is required." }, { status: 400 });
    }

    const { token } = await context.params;

    try {
        await consumePasswordReset(token, parsed.data.password);
        return NextResponse.json({ ok: true });
    } catch (error) {
        return NextResponse.json(
            { error: error instanceof Error ? error.message : "Unable to reset password." },
            { status: 400 },
        );
    }
}
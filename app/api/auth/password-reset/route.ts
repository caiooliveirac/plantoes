import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { hasDatabaseUrl } from "@/db";
import { createPasswordReset } from "@/services/auth.service";

const schema = z.object({
    email: z.string().email(),
});

export async function POST(request: NextRequest) {
    if (!hasDatabaseUrl()) {
        return NextResponse.json({ error: "DATABASE_URL is not configured for operations-v2." }, { status: 503 });
    }

    const parsed = schema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
        return NextResponse.json({ error: "A valid email is required." }, { status: 400 });
    }

    const result = await createPasswordReset(parsed.data.email);
    return NextResponse.json({
        ok: true,
        token: process.env.NODE_ENV === "production" ? null : result.token,
    });
}
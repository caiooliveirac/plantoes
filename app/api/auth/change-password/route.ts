import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { hasDatabaseUrl } from "@/db";
import { AuthError, requireAuthenticatedSession } from "@/lib/auth/server";
import { changeOwnPassword } from "@/services/auth.service";

const schema = z.object({
    currentPassword: z.string().min(1),
    nextPassword: z.string().min(10),
});

export async function POST(request: NextRequest) {
    if (!hasDatabaseUrl()) {
        return NextResponse.json({ error: "DATABASE_URL is not configured for operations-v2." }, { status: 503 });
    }

    let session;
    try {
        session = await requireAuthenticatedSession(undefined, { allowPasswordChange: true });
    } catch (error) {
        const status = error instanceof AuthError ? error.status : 500;
        return NextResponse.json({ error: error instanceof Error ? error.message : "Unauthorized." }, { status });
    }

    const parsed = schema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
        return NextResponse.json({ error: "Senha atual e nova senha valida sao obrigatorias." }, { status: 400 });
    }

    try {
        await changeOwnPassword(session.user.id, parsed.data.currentPassword, parsed.data.nextPassword);
        return NextResponse.json({ ok: true });
    } catch (error) {
        return NextResponse.json(
            { error: error instanceof Error ? error.message : "Nao foi possivel atualizar a senha." },
            { status: 400 },
        );
    }
}
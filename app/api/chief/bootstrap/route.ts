import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { hasDatabaseUrl } from "@/db";
import { AuthError, requireAuthenticatedSession } from "@/lib/auth/server";
import { provisionChiefBootstrapAccess } from "@/services/chief-access.service";

const schema = z.object({
    doctorId: z.string().uuid(),
    email: z.string().email(),
    temporaryPassword: z.string().min(1),
});

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
        return NextResponse.json({ error: "Payload invalido para criar acesso chief." }, { status: 400 });
    }

    try {
        const assignment = await provisionChiefBootstrapAccess(parsed.data, session.user.id);
        return NextResponse.json({ assignment });
    } catch (error) {
        return NextResponse.json(
            { error: error instanceof Error ? error.message : "Nao foi possivel provisionar o acesso chief." },
            { status: 400 },
        );
    }
}
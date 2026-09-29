import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { hasDatabaseUrl } from "@/db";
import { AuthError, requireAuthenticatedSession } from "@/lib/auth/server";
import { extrairCaso } from "@/services/extrator-caso.service";

const payloadSchema = z.object({
    medicoId: z.string().uuid(),
    mes: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),
    comTextos: z.boolean().default(true),
});

/**
 * Caso desidentificado de um médico num mês (docs/extrator-caso.md). Só admin:
 * a resposta traz a legenda que desfaz os pseudônimos.
 */
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

    const parsed = payloadSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
        return NextResponse.json({ error: "Escolha o médico e o mês." }, { status: 400 });
    }

    const caso = await extrairCaso({ ...parsed.data, atorUserId: session.user.id });
    if (!caso) {
        return NextResponse.json({ error: "Médico não encontrado." }, { status: 404 });
    }
    return NextResponse.json(caso, { headers: { "Cache-Control": "no-store" } });
}

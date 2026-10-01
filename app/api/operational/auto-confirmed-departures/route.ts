import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { hasDatabaseUrl } from "@/db";
import { AuthError, requireMesaEscrita, requireMesaSession } from "@/lib/auth/server";
import { resolveSaidasAutonomasMode } from "@/modules/telegram/saidas-autonomas-cycle";
import { listSystemConfirmedDepartures, undoSystemDepartureConfirmation } from "@/services/departure-autonomy.service";

/**
 * Saídas que o sistema confirmou sozinho (docs/saidas-a-confirmar.md).
 * GET: as das últimas 24h + se o automático está ligado (o rail só promete
 * "confirma sozinho" quando está). POST: Desfazer — volta para a fila da chefia.
 */

async function session(escrita = false) {
    return escrita ? requireMesaEscrita(["admin", "chief"]) : requireMesaSession(["admin", "chief"]);
}

function authError(error: unknown) {
    const status = error instanceof AuthError ? error.status : 500;
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unauthorized." }, { status });
}

export async function GET() {
    if (!hasDatabaseUrl()) {
        return NextResponse.json({ error: "DATABASE_URL is not configured for operations-v2." }, { status: 503 });
    }
    try {
        await session();
    } catch (error) {
        return authError(error);
    }
    return NextResponse.json({
        mode: resolveSaidasAutonomasMode(),
        items: await listSystemConfirmedDepartures(),
    });
}

const schema = z.object({
    domain: z.enum(["regulation", "intervention"]),
    occupancyId: z.string().uuid(),
});

export async function POST(request: NextRequest) {
    if (!hasDatabaseUrl()) {
        return NextResponse.json({ error: "DATABASE_URL is not configured for operations-v2." }, { status: 503 });
    }
    let user;
    try {
        user = (await session(true)).user;
    } catch (error) {
        return authError(error);
    }
    const parsed = schema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
        return NextResponse.json({ error: "Pedido inválido." }, { status: 400 });
    }
    try {
        await undoSystemDepartureConfirmation({ ...parsed.data, userId: user.id });
        return NextResponse.json({ ok: true });
    } catch (error) {
        return NextResponse.json({ error: error instanceof Error ? error.message : "Falha ao desfazer." }, { status: 409 });
    }
}

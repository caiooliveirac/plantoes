import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { hasDatabaseUrl } from "@/db";
import { AuthError, requireAuthenticatedSession } from "@/lib/auth/server";
import { correctOccupancyShiftAndDeparture, OCCUPANCY_FIX_SHIFT_LABELS } from "@/modules/operational/corrections";

// Correção de turno e saída de UM plantão, pela alocação de pagamento. Só admin:
// é o reparo que antes saía como script em scripts/repair-*.ts.
const schema = z.object({
    domain: z.enum(["regulation", "intervention"]),
    occupancyId: z.string().uuid(),
    shiftLabel: z.enum(OCCUPANCY_FIX_SHIFT_LABELS),
    departureAt: z.string().datetime(),
    reason: z.string().trim().min(8).max(2000),
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
        return NextResponse.json({ error: "Payload invalido: turno (SD/SN/P), saida e motivo (minimo 8 caracteres) sao obrigatorios." }, { status: 400 });
    }

    try {
        const occupancy = await correctOccupancyShiftAndDeparture({
            domain: parsed.data.domain,
            occupancyId: parsed.data.occupancyId,
            shiftLabel: parsed.data.shiftLabel,
            departureAt: new Date(parsed.data.departureAt),
            reason: parsed.data.reason,
            actorUserId: session.user.id,
        });
        return NextResponse.json({ occupancy });
    } catch (error) {
        return NextResponse.json(
            { error: error instanceof Error ? error.message : "Nao foi possivel corrigir turno e saida." },
            { status: 400 },
        );
    }
}

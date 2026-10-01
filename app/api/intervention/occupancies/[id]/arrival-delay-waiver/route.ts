import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getDb, hasDatabaseUrl } from "@/db";
import { AuthError, requireMesaEscrita } from "@/lib/auth/server";
import { publishBoardUpdate } from "@/lib/board-live";
import { setArrivalDelayWaiver } from "@/modules/operational/atraso-desconsiderado";

// Atraso desconsiderado pela chefia: marcar exige motivo (os chips da Mesa,
// como "Avisou antes da chegada", já cumprem o mínimo); desmarcar não.
// Sem a trava da 2031: chefia de plantão é ramal da regulação.
const schema = z.object({
    waived: z.boolean(),
    note: z.string().trim().optional(),
}).refine((value) => !value.waived || (value.note?.length ?? 0) >= 8, {
    message: "Motivo obrigatório (mínimo 8 caracteres) para desconsiderar o atraso.",
    path: ["note"],
});

export async function POST(request: NextRequest, context: RouteContext<"/api/intervention/occupancies/[id]/arrival-delay-waiver">) {
    if (!hasDatabaseUrl()) {
        return NextResponse.json({ error: "DATABASE_URL is not configured for operations-v2." }, { status: 503 });
    }

    let session;
    try {
        session = await requireMesaEscrita(["admin", "chief"]);
    } catch (error) {
        const status = error instanceof AuthError ? error.status : 500;
        return NextResponse.json({ error: error instanceof Error ? error.message : "Unauthorized." }, { status });
    }

    const parsed = schema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
        return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid arrival delay waiver payload." }, { status: 400 });
    }

    const { id } = await context.params;
    try {
        const { occupancy } = await setArrivalDelayWaiver(getDb(), {
            domain: "intervention",
            occupancyId: id,
            waived: parsed.data.waived,
            note: parsed.data.note ?? null,
            actorUserId: session.user.id,
        });
        publishBoardUpdate("arrival-delay-waiver");
        return NextResponse.json({
            ok: true,
            occupancy: {
                id: occupancy.id,
                arrivalDelayWaivedAt: occupancy.arrivalDelayWaivedAt,
                arrivalDelayWaiverNote: occupancy.arrivalDelayWaiverNote,
            },
        });
    } catch (error) {
        return NextResponse.json(
            { error: error instanceof Error ? error.message : "Unable to update arrival delay waiver." },
            { status: 400 },
        );
    }
}

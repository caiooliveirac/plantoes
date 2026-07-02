import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { hasDatabaseUrl } from "@/db";
import { AuthError, requireAuthenticatedSession } from "@/lib/auth/server";
import { placeBid } from "@/services/shift-offers.service";

const schema = z.object({
    kind: z.enum(["take", "counter"]),
    counterShiftId: z.string().uuid().nullable().optional(),
    note: z.string().trim().max(500).nullable().optional(),
});

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    if (!hasDatabaseUrl()) {
        return NextResponse.json({ error: "database_unavailable" }, { status: 503 });
    }

    try {
        const session = await requireAuthenticatedSession(["admin", "chief", "doctor"]);
        if (!session.user.doctorId) {
            return NextResponse.json({ error: "Conta sem médico vinculado não dá lance." }, { status: 403 });
        }

        const parsed = schema.safeParse(await request.json());
        if (!parsed.success) {
            return NextResponse.json({ error: "invalid_payload", issues: parsed.error.issues }, { status: 400 });
        }

        const { id } = await params;
        const created = await placeBid({
            offerId: id,
            kind: parsed.data.kind,
            counterShiftId: parsed.data.counterShiftId ?? null,
            note: parsed.data.note ?? null,
            actorDoctorId: session.user.doctorId,
            actorUserId: session.user.id,
        });
        return NextResponse.json({ bid: created }, { status: 201 });
    } catch (error) {
        if (error instanceof AuthError) {
            return NextResponse.json({ error: error.message }, { status: error.status });
        }
        if (error instanceof Error) {
            return NextResponse.json({ error: error.message }, { status: 409 });
        }
        throw error;
    }
}

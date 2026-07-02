import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { hasDatabaseUrl } from "@/db";
import { AuthError, requireAuthenticatedSession } from "@/lib/auth/server";
import { createOffer, getSwapBoard } from "@/services/shift-offers.service";

const createSchema = z.object({
    shiftId: z.string().uuid(),
    bonusBrl: z.number().int().min(0).max(5000),
    note: z.string().trim().max(500).nullable().optional(),
});

export async function GET(request: NextRequest) {
    if (!hasDatabaseUrl()) {
        return NextResponse.json({ error: "database_unavailable" }, { status: 503 });
    }

    try {
        await requireAuthenticatedSession(["admin", "chief", "doctor"]);
        const from = request.nextUrl.searchParams.get("from");
        const fromDate = from && /^\d{4}-\d{2}-\d{2}$/.test(from)
            ? from
            : new Date(Date.now() - 3 * 3600000).toISOString().slice(0, 10);
        const board = await getSwapBoard(fromDate, 14);
        return NextResponse.json({ fromDate, board });
    } catch (error) {
        if (error instanceof AuthError) {
            return NextResponse.json({ error: error.message }, { status: error.status });
        }
        throw error;
    }
}

export async function POST(request: NextRequest) {
    if (!hasDatabaseUrl()) {
        return NextResponse.json({ error: "database_unavailable" }, { status: 503 });
    }

    try {
        const session = await requireAuthenticatedSession(["admin", "chief", "doctor"]);
        if (!session.user.doctorId) {
            return NextResponse.json({ error: "Conta sem médico vinculado não oferta plantões." }, { status: 403 });
        }

        const parsed = createSchema.safeParse(await request.json());
        if (!parsed.success) {
            return NextResponse.json({ error: "invalid_payload", issues: parsed.error.issues }, { status: 400 });
        }

        const created = await createOffer({
            shiftId: parsed.data.shiftId,
            bonusBrl: parsed.data.bonusBrl,
            note: parsed.data.note ?? null,
            actorDoctorId: session.user.doctorId,
            actorUserId: session.user.id,
        });
        return NextResponse.json({ offer: created }, { status: 201 });
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

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { hasDatabaseUrl } from "@/db";
import { AuthError, requireAuthenticatedSession } from "@/lib/auth/server";
import { chooseBid } from "@/services/shift-offers.service";

const schema = z.object({ bidId: z.string().uuid() });

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    if (!hasDatabaseUrl()) {
        return NextResponse.json({ error: "database_unavailable" }, { status: 503 });
    }

    try {
        const session = await requireAuthenticatedSession(["admin", "chief", "doctor"]);
        if (!session.user.doctorId) {
            return NextResponse.json({ error: "Conta sem médico vinculado." }, { status: 403 });
        }

        const parsed = schema.safeParse(await request.json());
        if (!parsed.success) {
            return NextResponse.json({ error: "invalid_payload" }, { status: 400 });
        }

        const { id } = await params;
        const swap = await chooseBid({
            offerId: id,
            bidId: parsed.data.bidId,
            actorDoctorId: session.user.doctorId,
            actorUserId: session.user.id,
        });
        return NextResponse.json({ swap });
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

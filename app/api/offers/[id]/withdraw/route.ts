import { NextRequest, NextResponse } from "next/server";
import { hasDatabaseUrl } from "@/db";
import { AuthError, requireAuthenticatedSession } from "@/lib/auth/server";
import { withdrawOffer } from "@/services/shift-offers.service";

export async function POST(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    if (!hasDatabaseUrl()) {
        return NextResponse.json({ error: "database_unavailable" }, { status: 503 });
    }

    try {
        const session = await requireAuthenticatedSession(["admin", "chief", "doctor"]);
        if (!session.user.doctorId) {
            return NextResponse.json({ error: "Conta sem médico vinculado." }, { status: 403 });
        }

        const { id } = await params;
        const offer = await withdrawOffer(id, session.user.doctorId);
        return NextResponse.json({ offer });
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

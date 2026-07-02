import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { hasDatabaseUrl } from "@/db";
import { AuthError, requireAuthenticatedSession } from "@/lib/auth/server";
import { transitionSwap } from "@/services/shift-swaps.service";

const schema = z.object({
    action: z.enum(["accept", "approve", "reject", "cancel"]),
});

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    if (!hasDatabaseUrl()) {
        return NextResponse.json({ error: "database_unavailable" }, { status: 503 });
    }

    try {
        const session = await requireAuthenticatedSession(["admin", "chief", "doctor"]);
        const parsed = schema.safeParse(await request.json());
        if (!parsed.success) {
            return NextResponse.json({ error: "invalid_payload" }, { status: 400 });
        }

        const { id } = await params;
        const updated = await transitionSwap({
            swapId: id,
            action: parsed.data.action,
            actorUserId: session.user.id,
            actorDoctorId: session.user.doctorId,
            actorIsChief: session.user.roles.includes("admin") || session.user.roles.includes("chief"),
        });
        return NextResponse.json({ swap: updated });
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

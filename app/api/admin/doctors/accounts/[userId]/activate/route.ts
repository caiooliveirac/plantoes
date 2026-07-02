import { NextRequest, NextResponse } from "next/server";
import { hasDatabaseUrl } from "@/db";
import { AuthError, requireAuthenticatedSession } from "@/lib/auth/server";
import { activateDoctorAccount } from "@/services/doctor-admin.service";

export async function POST(_request: NextRequest, { params }: { params: Promise<{ userId: string }> }) {
    if (!hasDatabaseUrl()) {
        return NextResponse.json({ error: "database_unavailable" }, { status: 503 });
    }

    try {
        await requireAuthenticatedSession(["admin", "chief"]);
        const { userId } = await params;
        const user = await activateDoctorAccount(userId);
        return NextResponse.json({ userId: user.id, isActive: user.isActive });
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

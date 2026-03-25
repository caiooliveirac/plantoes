import { NextResponse } from "next/server";
import { hasDatabaseUrl } from "@/db";
import { getValidChiefInvite, listDoctorsForChiefInvite } from "@/services/chief-access.service";

export async function GET(_request: Request, context: RouteContext<"/api/chief/invites/[token]">) {
    if (!hasDatabaseUrl()) {
        return NextResponse.json({ error: "DATABASE_URL is not configured for operations-v2." }, { status: 503 });
    }

    const { token } = await context.params;
    const invite = await getValidChiefInvite(token);
    if (!invite) {
        return NextResponse.json({ error: "invalid_invite" }, { status: 404 });
    }

    const doctors = await listDoctorsForChiefInvite();
    return NextResponse.json({
        invite: {
            id: invite.id,
            inviteMode: invite.inviteMode,
            email: invite.email,
            expiresAt: invite.expiresAt,
        },
        doctors,
    });
}
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getDb, hasDatabaseUrl } from "@/db";
import { auditLogs } from "@/db/schema";
import { AuthError, requireAuthenticatedSession } from "@/lib/auth/server";
import { applyBankHoursBalanceOverride } from "@/modules/bank-hours/service";

const schema = z.object({
    domain: z.enum(["regulation", "intervention"]),
    occupancyId: z.string().uuid(),
    balanceMinutes: z.number().int().min(-1440).max(1440),
    notes: z.string().trim().min(8).max(2000),
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
        return NextResponse.json({ error: "Payload invalido para ajuste manual do banco." }, { status: 400 });
    }

    try {
        const result = await applyBankHoursBalanceOverride({
            domain: parsed.data.domain,
            occupancyId: parsed.data.occupancyId,
            balanceMinutes: parsed.data.balanceMinutes,
            notes: parsed.data.notes,
            actorUserId: session.user.id,
        });

        await getDb().insert(auditLogs).values({
            actorUserId: session.user.id,
            action: "bank_hours.override_set",
            entityType: "bank_hours_balance_override",
            entityId: result.continuityGroupId,
            details: {
                domain: parsed.data.domain,
                occupancyId: parsed.data.occupancyId,
                balanceMinutes: parsed.data.balanceMinutes,
                notes: parsed.data.notes,
            },
        });

        return NextResponse.json({
            continuityGroupId: result.continuityGroupId,
            balanceMinutes: parsed.data.balanceMinutes,
        });
    } catch (error) {
        return NextResponse.json(
            { error: error instanceof Error ? error.message : "Nao foi possivel ajustar o banco de horas." },
            { status: 400 },
        );
    }
}
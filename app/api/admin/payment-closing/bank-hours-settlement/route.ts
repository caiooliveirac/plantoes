import { NextRequest, NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getDb, hasDatabaseUrl } from "@/db";
import { auditLogs } from "@/db/schema";
import { AuthError, requireAuthenticatedSession } from "@/lib/auth/server";
import { getDoctorBankHoursEffectiveBalances } from "@/services/bank-hours-history.service";
import {
    BANK_HOURS_SETTLEMENT_THRESHOLD_MINUTES,
    settleBankHours,
} from "@/services/bank-hours-settlements.service";

const payloadSchema = z.object({
    doctorId: z.string().uuid(),
    monthKey: z.string().regex(/^\d{4}-\d{2}$/),
    kind: z.enum(["bonus", "penalty"]),
    note: z.string().trim().max(120).nullish(),
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

    const parsed = payloadSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
        return NextResponse.json({ error: "Payload inválido para acerto do banco de horas." }, { status: 400 });
    }

    try {
        // Confirma o gatilho no servidor: bônus exige saldo >= +12h; punição <= -12h.
        const balances = await getDoctorBankHoursEffectiveBalances();
        const balanceMinutes = balances.get(parsed.data.doctorId) ?? 0;
        if (parsed.data.kind === "bonus" && balanceMinutes < BANK_HOURS_SETTLEMENT_THRESHOLD_MINUTES) {
            return NextResponse.json(
                { error: "Saldo do banco de horas não chegou a +12h para bonificar." },
                { status: 409 },
            );
        }
        if (parsed.data.kind === "penalty" && balanceMinutes > -BANK_HOURS_SETTLEMENT_THRESHOLD_MINUTES) {
            return NextResponse.json(
                { error: "Saldo do banco de horas não chegou a -12h para debitar." },
                { status: 409 },
            );
        }

        const result = await settleBankHours({
            doctorId: parsed.data.doctorId,
            monthKey: parsed.data.monthKey,
            kind: parsed.data.kind,
            note: parsed.data.note ?? null,
            actorUserId: session.user.id,
        });

        await getDb().insert(auditLogs).values({
            actorUserId: session.user.id,
            action: "payment_closing.bank_hours_settlement.apply",
            entityType: "bank_hours_settlement",
            entityId: result.settlementId,
            details: {
                doctorId: result.doctorId,
                monthKey: result.monthKey,
                kind: result.kind,
                deltaMinutes: result.deltaMinutes,
                operationalDate: result.operationalDate,
                adminExtraShiftId: result.adminExtraShiftId,
                balanceBeforeMinutes: balanceMinutes,
            },
        });

        revalidatePath("/admin/payment-closing");
        revalidatePath("/admin/bank-hours");
        return NextResponse.json({ settlement: result });
    } catch (error) {
        return NextResponse.json(
            { error: error instanceof Error ? error.message : "Não foi possível lançar o acerto do banco de horas." },
            { status: 400 },
        );
    }
}

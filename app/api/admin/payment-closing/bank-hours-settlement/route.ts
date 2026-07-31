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
import { syncContractLedgerForMonth } from "@/services/contract-ledger.service";

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
        // Confirma o gatilho no servidor com a régua de elegibilidade: só horas
        // desde mai/2025 pagam/punem, e dívida anterior a mai/2025 precisa ser
        // amortizada antes de qualquer bônus.
        const balances = await getDoctorBankHoursEffectiveBalances();
        const balance = balances.get(parsed.data.doctorId)
            ?? { totalMinutes: 0, oldMinutes: 0, recentMinutes: 0, bonusEligibleMinutes: 0, penaltyEligibleMinutes: 0 };
        if (parsed.data.kind === "bonus" && balance.bonusEligibleMinutes < BANK_HOURS_SETTLEMENT_THRESHOLD_MINUTES) {
            const amortizing = balance.oldMinutes < 0 && balance.recentMinutes >= BANK_HOURS_SETTLEMENT_THRESHOLD_MINUTES;
            return NextResponse.json(
                {
                    error: amortizing
                        ? "As horas formadas desde mai/2025 ainda amortizam a dívida anterior a mai/2025 — sem bônus até quitá-la."
                        : "Saldo elegível (desde mai/2025, descontada dívida antiga) não chegou a +12h para bonificar.",
                },
                { status: 409 },
            );
        }
        if (parsed.data.kind === "penalty" && balance.penaltyEligibleMinutes > -BANK_HOURS_SETTLEMENT_THRESHOLD_MINUTES) {
            return NextResponse.json(
                { error: "Saldo desde mai/2025 não chegou a -12h para debitar (dívida anterior a mai/2025 não gera punição)." },
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
                balanceBeforeMinutes: balance.totalMinutes,
                balanceCompositionBefore: {
                    oldMinutes: balance.oldMinutes,
                    recentMinutes: balance.recentMinutes,
                    bonusEligibleMinutes: balance.bonusEligibleMinutes,
                    penaltyEligibleMinutes: balance.penaltyEligibleMinutes,
                },
            },
        });

        revalidatePath("/admin/payment-closing");
        revalidatePath("/admin/bank-hours");
        // O acerto gera um plantão verde/vermelho, então mexe no total do mês.
        await syncContractLedgerForMonth({
            doctorId: result.doctorId,
            monthKey: result.monthKey,
            actorUserId: session.user.id,
        });

        return NextResponse.json({ settlement: result });
    } catch (error) {
        return NextResponse.json(
            { error: error instanceof Error ? error.message : "Não foi possível lançar o acerto do banco de horas." },
            { status: 400 },
        );
    }
}

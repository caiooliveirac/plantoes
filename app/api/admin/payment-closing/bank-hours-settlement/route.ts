import { NextRequest, NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { getDb, hasDatabaseUrl } from "@/db";
import { auditLogs, doctors } from "@/db/schema";
import { notifyDoctorBankHoursSettlement } from "@/modules/telegram/bank-hours-doctor-notice";
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
    // Dia/turno do plantão verde/vermelho. Sem dia, mantém o comportamento
    // antigo (dia útil sorteado no mês, turno SD).
    operationalDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    shiftLabel: z.enum(["SD", "SN"]).optional(),
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

        if (parsed.data.operationalDate && !parsed.data.operationalDate.startsWith(`${parsed.data.monthKey}-`)) {
            return NextResponse.json(
                { error: "O dia do acerto precisa estar dentro do mês do fechamento." },
                { status: 400 },
            );
        }

        const result = await settleBankHours({
            doctorId: parsed.data.doctorId,
            monthKey: parsed.data.monthKey,
            kind: parsed.data.kind,
            note: parsed.data.note ?? null,
            actorUserId: session.user.id,
            operationalDate: parsed.data.operationalDate,
            shiftLabel: parsed.data.shiftLabel,
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

        // Aviso privado ao médico (best-effort: falha de Telegram nunca desfaz o
        // acerto; sem chat conhecido fica registrado como não entregue).
        const [doctorRow] = await getDb()
            .select({ fullName: doctors.fullName, displayName: doctors.displayName })
            .from(doctors)
            .where(eq(doctors.id, result.doctorId))
            .limit(1);
        const firstName = (doctorRow?.displayName?.trim() || doctorRow?.fullName || "doutor(a)").split(/\s+/)[0];
        const residualMinutes = parsed.data.kind === "bonus"
            ? balance.bonusEligibleMinutes - Math.abs(result.deltaMinutes)
            : balance.penaltyEligibleMinutes + Math.abs(result.deltaMinutes);
        const notice = await notifyDoctorBankHoursSettlement({
            settlementId: result.settlementId,
            doctorId: result.doctorId,
            doctorFirstName: firstName,
            monthKey: result.monthKey,
            kind: result.kind,
            residualMinutes,
        });

        return NextResponse.json({ settlement: result, doctorNotice: notice });
    } catch (error) {
        return NextResponse.json(
            { error: error instanceof Error ? error.message : "Não foi possível lançar o acerto do banco de horas." },
            { status: 400 },
        );
    }
}

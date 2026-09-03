import { NextRequest, NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { getDb, hasDatabaseUrl } from "@/db";
import { auditLogs, doctors } from "@/db/schema";
import { AuthError, requireAuthenticatedSession } from "@/lib/auth/server";
import { notifyDoctorBankHoursSettlement } from "@/modules/telegram/bank-hours-doctor-notice";
import { reverseBankHoursSettlement } from "@/services/bank-hours-settlements.service";
import { syncContractLedgerForMonth } from "@/services/contract-ledger.service";

const payloadSchema = z.object({
    settlementId: z.string().uuid(),
    reason: z.string().trim().min(3).max(200),
});

/**
 * Estorno formal de um acerto de banco de horas: só admin, exige justificativa,
 * nunca apaga nada (par compensatório em services/bank-hours-settlements).
 */
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
        return NextResponse.json({ error: "Estorno exige settlementId e uma justificativa (3–200 caracteres)." }, { status: 400 });
    }

    try {
        const result = await reverseBankHoursSettlement({
            settlementId: parsed.data.settlementId,
            actorUserId: session.user.id,
            reason: parsed.data.reason,
        });

        await getDb().insert(auditLogs).values({
            actorUserId: session.user.id,
            action: "payment_closing.bank_hours_settlement.reverse",
            entityType: "bank_hours_settlement",
            entityId: result.reversedSettlementId,
            details: {
                reversalSettlementId: result.settlementId,
                doctorId: result.doctorId,
                monthKey: result.monthKey,
                deltaMinutes: result.deltaMinutes,
                reason: parsed.data.reason,
            },
        });

        revalidatePath("/admin/payment-closing");
        revalidatePath("/admin/bank-hours");
        // Abatimento em folha não tem plantão casado: nada muda no total do mês.
        if (result.kind !== "payroll") {
            await syncContractLedgerForMonth({
                doctorId: result.doctorId,
                monthKey: result.monthKey,
                actorUserId: session.user.id,
            });
        }

        const [doctorRow] = await getDb()
            .select({ fullName: doctors.fullName, displayName: doctors.displayName })
            .from(doctors)
            .where(eq(doctors.id, result.doctorId))
            .limit(1);
        const firstName = (doctorRow?.displayName?.trim() || doctorRow?.fullName || "doutor(a)").split(/\s+/)[0];
        const notice = await notifyDoctorBankHoursSettlement({
            settlementId: result.reversedSettlementId,
            doctorId: result.doctorId,
            doctorFirstName: firstName,
            monthKey: result.monthKey,
            // O aviso fala do acerto ORIGINAL que foi estornado.
            kind: result.kind === "payroll" ? "payroll" : result.kind === "bonus" ? "penalty" : "bonus",
            residualMinutes: null,
            payrollMinutes: result.kind === "payroll" ? Math.abs(result.deltaMinutes) : null,
            reversal: true,
        });

        return NextResponse.json({ reversal: result, doctorNotice: notice });
    } catch (error) {
        return NextResponse.json(
            { error: error instanceof Error ? error.message : "Não foi possível estornar o acerto." },
            { status: 409 },
        );
    }
}

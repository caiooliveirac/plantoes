import { NextRequest, NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getDb, hasDatabaseUrl } from "@/db";
import { auditLogs } from "@/db/schema";
import { AuthError, requireAuthenticatedSession } from "@/lib/auth/server";
import { resolvePayrollDeductionForDoctorMonth } from "@/modules/bank-hours/payroll";
import { notifyDoctorBankHoursSettlement } from "@/modules/telegram/bank-hours-doctor-notice";
import { getBankHoursHistory } from "@/services/bank-hours-history.service";
import { settleBankHoursPayroll } from "@/services/bank-hours-settlements.service";

const payloadSchema = z.object({
    doctorId: z.string().uuid(),
    monthKey: z.string().regex(/^\d{4}-\d{2}$/),
});

/**
 * Abatimento em folha (estatutário): grava que os atrasos do mês foram levados
 * à folha de pagamento/ponto. O valor NÃO vem do cliente — é recalculado aqui
 * sobre o histórico, para o admin nunca abater mais do que o mês deve.
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
        return NextResponse.json({ error: "Payload inválido para abatimento em folha." }, { status: 400 });
    }

    try {
        const history = await getBankHoursHistory({ balancesOnly: true, doctorId: parsed.data.doctorId });
        const doctor = history.doctors.find((row) => row.doctorId === parsed.data.doctorId);
        if (!doctor) {
            return NextResponse.json({ error: "Médico sem histórico de banco de horas." }, { status: 404 });
        }
        if (doctor.employmentType !== "estatutario") {
            return NextResponse.json(
                { error: "Abatimento em folha só vale para estatutário — o PJ acerta com plantão verde/vermelho no fechamento." },
                { status: 409 },
            );
        }

        const deduction = resolvePayrollDeductionForDoctorMonth({
            monthKey: parsed.data.monthKey,
            legacyMinutes: doctor.legacy?.totalMinutes ?? 0,
            shifts: doctor.shifts,
            settlements: doctor.settlements,
        });
        if (!deduction.pending) {
            return NextResponse.json(
                { error: "Nada a abater em folha neste mês — sem atraso, ou o banco positivo absorveu tudo." },
                { status: 409 },
            );
        }

        const result = await settleBankHoursPayroll({
            doctorId: doctor.doctorId,
            monthKey: parsed.data.monthKey,
            deltaMinutes: -deduction.remainingMinutes,
            negativeShiftCount: deduction.negativeShiftCount,
            absorbedMinutes: deduction.absorbedMinutes,
            actorUserId: session.user.id,
        });

        await getDb().insert(auditLogs).values({
            actorUserId: session.user.id,
            action: "bank_hours.payroll_settlement.apply",
            entityType: "bank_hours_settlement",
            entityId: result.settlementId,
            details: {
                doctorId: result.doctorId,
                monthKey: result.monthKey,
                deltaMinutes: result.deltaMinutes,
                negativeShiftCount: deduction.negativeShiftCount,
                negativeMinutes: deduction.negativeMinutes,
                openingBalanceMinutes: deduction.openingBalanceMinutes,
                creditMinutes: deduction.creditMinutes,
                absorbedMinutes: deduction.absorbedMinutes,
                payrollMinutes: deduction.payrollMinutes,
                abatedBeforeMinutes: deduction.abatedMinutes,
                balanceBeforeMinutes: doctor.balanceMinutes,
            },
        });

        revalidatePath("/admin/bank-hours");
        revalidatePath("/admin/payment-closing");

        const firstName = (doctor.displayName?.trim() || doctor.doctorName || "doutor(a)").split(/\s+/)[0];
        const notice = await notifyDoctorBankHoursSettlement({
            settlementId: result.settlementId,
            doctorId: result.doctorId,
            doctorFirstName: firstName,
            monthKey: result.monthKey,
            kind: "payroll",
            residualMinutes: doctor.balanceMinutes + result.deltaMinutes,
            payrollMinutes: result.deltaMinutes,
        });

        return NextResponse.json({ settlement: result, doctorNotice: notice });
    } catch (error) {
        return NextResponse.json(
            { error: error instanceof Error ? error.message : "Não foi possível abater em folha." },
            { status: 400 },
        );
    }
}

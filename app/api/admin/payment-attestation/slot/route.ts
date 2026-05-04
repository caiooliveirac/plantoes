import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getDb, hasDatabaseUrl } from "@/db";
import { auditLogs } from "@/db/schema";
import { AuthError, requireAuthenticatedSession } from "@/lib/auth/server";
import {
    applyManualDisableCorrection,
    applyManualPaymentAttestationCorrection,
    applyManualRemoveAssignment,
    approvePaymentAttestationSlot,
    getPaymentAttestationSlotView,
    refreshPaymentAttestationSlot,
    reopenPaymentAttestationSlot,
    setDoctorPaymentSpecialistProfile,
} from "@/services/payment-attestation.service";

const actionSchema = z.object({
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    shift: z.enum(["SD", "SN"]).optional(),
    action: z.enum(["refresh", "approve", "reopen", "manual_assign", "manual_disable", "manual_remove", "set_doctor_payment_profile"]),
    domain: z.enum(["regulation", "intervention"]).optional(),
    targetCode: z.string().trim().min(1).max(32).optional(),
    doctorName: z.string().trim().min(3).max(255).optional(),
    disabledReason: z.string().trim().min(3).max(255).optional(),
    doctorId: z.string().uuid().optional(),
    isSpecialist: z.boolean().optional(),
    occupancyId: z.string().uuid().optional(),
});

function getRequestParams(request: NextRequest) {
    const date = request.nextUrl.searchParams.get("date");
    const shift = request.nextUrl.searchParams.get("shift");

    if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        throw new Error("date must use YYYY-MM-DD.");
    }

    if (shift && shift !== "SD" && shift !== "SN") {
        throw new Error("shift must be SD or SN.");
    }

    if (date && !shift) {
        throw new Error("shift is required when date is informed.");
    }

    return {
        operationalDate: date,
        shiftLabel: (shift as "SD" | "SN" | null) ?? null,
    };
}

export async function GET(request: NextRequest) {
    if (!hasDatabaseUrl()) {
        return NextResponse.json({ error: "DATABASE_URL is not configured for operations-v2." }, { status: 503 });
    }

    try {
        await requireAuthenticatedSession(["admin"]);
    } catch (error) {
        const status = error instanceof AuthError ? error.status : 500;
        return NextResponse.json({ error: error instanceof Error ? error.message : "Unauthorized." }, { status });
    }

    try {
        const params = getRequestParams(request);
        const view = await getPaymentAttestationSlotView(params);
        return NextResponse.json(view);
    } catch (error) {
        return NextResponse.json(
            { error: error instanceof Error ? error.message : "Unable to load payment attestation slot." },
            { status: 400 },
        );
    }
}

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

    const parsed = actionSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
        return NextResponse.json({ error: "Payload invalido para o fechamento de pagamento." }, { status: 400 });
    }

    const params = {
        operationalDate: parsed.data.date ?? null,
        shiftLabel: parsed.data.shift ?? null,
    };

    if (parsed.data.action === "manual_assign") {
        if (!parsed.data.date || !parsed.data.shift || !parsed.data.domain || !parsed.data.targetCode || !parsed.data.doctorName) {
            return NextResponse.json({ error: "Para correção manual informe data, turno, domínio, alvo e médico." }, { status: 400 });
        }
    }

    if (parsed.data.action === "manual_disable") {
        if (!parsed.data.date || !parsed.data.shift || !parsed.data.domain || !parsed.data.targetCode || !parsed.data.disabledReason) {
            return NextResponse.json({ error: "Para desativação manual informe data, turno, domínio, alvo e motivo." }, { status: 400 });
        }
    }

    if (parsed.data.action === "manual_remove") {
        if (!parsed.data.date || !parsed.data.shift || !parsed.data.domain || !parsed.data.targetCode) {
            return NextResponse.json({ error: "Para remover plantão informe data, turno, domínio e alvo." }, { status: 400 });
        }
    }

    if (parsed.data.action === "set_doctor_payment_profile") {
        if (!parsed.data.doctorId || parsed.data.isSpecialist === undefined) {
            return NextResponse.json({ error: "Para atualizar perfil de pagamento informe medico e flag especialista." }, { status: 400 });
        }
    }

    try {
        if (parsed.data.action === "set_doctor_payment_profile") {
            const doctor = await setDoctorPaymentSpecialistProfile({
                doctorId: parsed.data.doctorId as string,
                isSpecialist: parsed.data.isSpecialist as boolean,
            });

            await getDb().insert(auditLogs).values({
                actorUserId: session.user.id,
                action: `payment_attestation.${parsed.data.action}`,
                entityType: "doctor",
                entityId: doctor.id,
                details: {
                    doctorName: doctor.fullName,
                    isSpecialist: doctor.isSpecialist,
                    paymentProfile: doctor.paymentProfile,
                },
            });

            return NextResponse.json({ ok: true, doctor });
        }

        if (parsed.data.action === "manual_remove") {
            const result = await applyManualRemoveAssignment({
                operationalDate: parsed.data.date as string,
                shiftLabel: parsed.data.shift as "SD" | "SN",
                domain: parsed.data.domain as "regulation" | "intervention",
                targetCode: parsed.data.targetCode as string,
                occupancyId: parsed.data.occupancyId ?? null,
                actorUserId: session.user.id,
            });
            await getDb().insert(auditLogs).values({
                actorUserId: session.user.id,
                action: "payment_attestation.manual_remove",
                entityType: "payment_attestation_slot",
                entityId: `${result.operationalDate}|${result.shiftLabel}|${result.domain}|${result.targetCode}`,
                details: result,
            });
            return NextResponse.json({ ok: true, ...result });
        }

        const slot = parsed.data.action === "refresh"
            ? await refreshPaymentAttestationSlot({ ...params, actorUserId: session.user.id })
            : parsed.data.action === "approve"
                ? await approvePaymentAttestationSlot({ ...params, actorUserId: session.user.id })
                : parsed.data.action === "reopen"
                    ? await reopenPaymentAttestationSlot(params)
                    : parsed.data.action === "manual_disable"
                        ? await applyManualDisableCorrection({
                            operationalDate: parsed.data.date as string,
                            shiftLabel: parsed.data.shift as "SD" | "SN",
                            domain: parsed.data.domain as "regulation" | "intervention",
                            targetCode: parsed.data.targetCode as string,
                            disabledReason: parsed.data.disabledReason as string,
                            actorUserId: session.user.id,
                        })
                        : await applyManualPaymentAttestationCorrection({
                            operationalDate: parsed.data.date as string,
                            shiftLabel: parsed.data.shift as "SD" | "SN",
                            domain: parsed.data.domain as "regulation" | "intervention",
                            targetCode: parsed.data.targetCode as string,
                            doctorName: parsed.data.doctorName as string,
                            actorUserId: session.user.id,
                        });

        await getDb().insert(auditLogs).values({
            actorUserId: session.user.id,
            action: `payment_attestation.${parsed.data.action}`,
            entityType: "payment_attestation_slot",
            entityId: slot.id ?? `${slot.operationalDate}|${slot.shiftLabel}`,
            details: {
                operationalDate: slot.operationalDate,
                shiftLabel: slot.shiftLabel,
                status: slot.status,
                readyCount: slot.summary.readyCount,
                needsReviewCount: slot.summary.needsReviewCount,
            },
        });

        const view = await getPaymentAttestationSlotView({
            operationalDate: slot.operationalDate.slice(0, 10),
            shiftLabel: slot.shiftLabel,
        });
        return NextResponse.json(view);
    } catch (error) {
        return NextResponse.json(
            { error: error instanceof Error ? error.message : "Nao foi possivel atualizar o fechamento de pagamento." },
            { status: 400 },
        );
    }
}
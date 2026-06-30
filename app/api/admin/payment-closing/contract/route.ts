import { NextRequest, NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getDb, hasDatabaseUrl } from "@/db";
import { auditLogs } from "@/db/schema";
import { AuthError, requireAuthenticatedSession } from "@/lib/auth/server";
import { setDoctorContract } from "@/services/doctor-contracts.service";

const payloadSchema = z.object({
    doctorId: z.string().uuid(),
    ceilingBrl: z.number().finite().positive(),
    seedMonth: z.string().regex(/^\d{4}-\d{2}$/),
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
        return NextResponse.json({ error: "Informe um teto de contrato (R$) e o mês inicial." }, { status: 400 });
    }

    try {
        const contract = await setDoctorContract({
            doctorId: parsed.data.doctorId,
            ceilingBrl: parsed.data.ceilingBrl,
            seedMonth: parsed.data.seedMonth,
            actorUserId: session.user.id,
        });

        await getDb().insert(auditLogs).values({
            actorUserId: session.user.id,
            action: "payment_closing.contract.set",
            entityType: "doctor_contract",
            entityId: parsed.data.doctorId,
            details: {
                doctorId: contract.doctorId,
                ceilingBrl: contract.ceilingBrl,
                seedMonth: contract.seedMonth,
            },
        });

        revalidatePath("/admin/payment-closing");
        return NextResponse.json({ contract });
    } catch (error) {
        return NextResponse.json(
            { error: error instanceof Error ? error.message : "Não foi possível salvar o contrato." },
            { status: 400 },
        );
    }
}

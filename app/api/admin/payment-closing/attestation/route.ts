import { NextRequest, NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getDb, hasDatabaseUrl } from "@/db";
import { auditLogs } from "@/db/schema";
import { AuthError, requireAuthenticatedSession } from "@/lib/auth/server";
import { setDoctorMonthAttestation } from "@/services/payment-closing-attestation.service";

const payloadSchema = z.object({
    doctorId: z.string().uuid(),
    monthKey: z.string().regex(/^\d{4}-\d{2}$/),
    attested: z.boolean(),
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
        return NextResponse.json({ error: "Payload invalido para atestacao." }, { status: 400 });
    }

    try {
        const result = await setDoctorMonthAttestation({
            doctorId: parsed.data.doctorId,
            monthKey: parsed.data.monthKey,
            attested: parsed.data.attested,
            actorUserId: session.user.id,
        });

        await getDb().insert(auditLogs).values({
            actorUserId: session.user.id,
            action: parsed.data.attested ? "payment_closing.attestation.sign" : "payment_closing.attestation.unsign",
            entityType: "payment_closing_attestation",
            entityId: `${parsed.data.doctorId}|${parsed.data.monthKey}`,
            details: {
                doctorId: parsed.data.doctorId,
                monthKey: parsed.data.monthKey,
                attested: parsed.data.attested,
            },
        });

        revalidatePath("/admin/payment-closing");
        return NextResponse.json({ attestedAt: result.attestedAt });
    } catch (error) {
        return NextResponse.json(
            { error: error instanceof Error ? error.message : "Nao foi possivel salvar a atestacao." },
            { status: 400 },
        );
    }
}

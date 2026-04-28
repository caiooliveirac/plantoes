import { NextRequest, NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getDb, hasDatabaseUrl } from "@/db";
import { auditLogs } from "@/db/schema";
import { AuthError, requireAuthenticatedSession } from "@/lib/auth/server";
import { setPaymentClosingMeta } from "@/services/payment-closing-meta.service";

const payloadSchema = z.object({
    doctorId: z.string().uuid(),
    monthKey: z.string().regex(/^\d{4}-\d{2}$/),
    invoiceNumber: z.string().trim().max(60).nullish(),
    paymentProcessNumber: z.string().trim().max(60).nullish(),
});

export async function POST(request: NextRequest) {
    if (!hasDatabaseUrl()) {
        return NextResponse.json({ error: "DATABASE_URL is not configured for operations-v2." }, { status: 503 });
    }

    let session;
    try {
        session = await requireAuthenticatedSession(["admin", "payment_closing_limited"]);
    } catch (error) {
        const status = error instanceof AuthError ? error.status : 500;
        return NextResponse.json({ error: error instanceof Error ? error.message : "Unauthorized." }, { status });
    }

    const parsed = payloadSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
        return NextResponse.json({ error: "Payload inválido para nota fiscal / processo." }, { status: 400 });
    }

    try {
        const meta = await setPaymentClosingMeta({
            doctorId: parsed.data.doctorId,
            monthKey: parsed.data.monthKey,
            invoiceNumber: parsed.data.invoiceNumber ?? null,
            paymentProcessNumber: parsed.data.paymentProcessNumber ?? null,
            actorUserId: session.user.id,
        });

        await getDb().insert(auditLogs).values({
            actorUserId: session.user.id,
            action: "payment_closing.meta.set",
            entityType: "payment_closing_meta",
            entityId: `${parsed.data.doctorId}:${parsed.data.monthKey}`,
            details: {
                doctorId: parsed.data.doctorId,
                monthKey: parsed.data.monthKey,
                invoiceNumber: meta.invoiceNumber,
                paymentProcessNumber: meta.paymentProcessNumber,
            },
        });

        revalidatePath("/admin/payment-closing");
        return NextResponse.json({ meta });
    } catch (error) {
        return NextResponse.json(
            { error: error instanceof Error ? error.message : "Não foi possível salvar a nota fiscal / processo." },
            { status: 400 },
        );
    }
}

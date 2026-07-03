import { NextRequest, NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getDb, hasDatabaseUrl } from "@/db";
import { auditLogs } from "@/db/schema";
import { AuthError, requireAuthenticatedSession } from "@/lib/auth/server";
import { createAdminExtraShift, removeAdminExtraShift } from "@/services/admin-extra-shifts.service";

const payloadSchema = z.discriminatedUnion("action", [
    z.object({
        action: z.literal("add"),
        doctorId: z.string().uuid(),
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        shift: z.enum(["SD", "SN"]),
        coverage: z.enum(["full", "half"]).optional(),
        label: z.string().trim().min(2, "Descreva o plantão extra com pelo menos 2 caracteres.").max(40),
    }),
    z.object({
        action: z.literal("remove"),
        id: z.string().uuid(),
    }),
]);

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
        return NextResponse.json({ error: "Payload invalido para plantao extra." }, { status: 400 });
    }

    try {
        if (parsed.data.action === "add") {
            const extra = await createAdminExtraShift({
                doctorId: parsed.data.doctorId,
                operationalDate: parsed.data.date,
                shiftLabel: parsed.data.shift,
                coverage: parsed.data.coverage ?? "full",
                label: parsed.data.label,
                actorUserId: session.user.id,
            });

            await getDb().insert(auditLogs).values({
                actorUserId: session.user.id,
                action: "payment_closing.extra_shift.add",
                entityType: "admin_extra_shift",
                entityId: extra.id,
                details: {
                    doctorId: extra.doctorId,
                    doctorName: extra.doctorName,
                    operationalDate: extra.operationalDate,
                    shiftLabel: extra.shiftLabel,
                    coverage: parsed.data.coverage ?? "full",
                    label: extra.label,
                },
            });

            revalidatePath("/admin/payment-closing");
            return NextResponse.json({ extra });
        }

        const result = await removeAdminExtraShift({ id: parsed.data.id });
        if (!result.removed) {
            return NextResponse.json({ error: "Plantao extra nao encontrado." }, { status: 404 });
        }

        await getDb().insert(auditLogs).values({
            actorUserId: session.user.id,
            action: "payment_closing.extra_shift.remove",
            entityType: "admin_extra_shift",
            entityId: parsed.data.id,
            details: { id: parsed.data.id },
        });

        revalidatePath("/admin/payment-closing");
        return NextResponse.json({ removed: true });
    } catch (error) {
        return NextResponse.json(
            { error: error instanceof Error ? error.message : "Nao foi possivel salvar o plantao extra." },
            { status: 400 },
        );
    }
}

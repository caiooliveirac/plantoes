import { NextRequest, NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getDb, hasDatabaseUrl } from "@/db";
import { auditLogs } from "@/db/schema";
import { AuthError, requireAuthenticatedSession } from "@/lib/auth/server";
import { MANUAL_SHIFT_LABELS } from "@/modules/operational/manual-shift";
import { createManualShift, previewManualShift } from "@/services/admin-manual-shift.service";

// Lançamento de plantão passado (qualquer médico, qualquer ramal/base, sombra ou
// titular) com prévia do banco de horas. Só admin. `mode: "preview"` não grava.
const schema = z.object({
    mode: z.enum(["preview", "create"]),
    doctorId: z.string().uuid(),
    domain: z.enum(["regulation", "intervention"]),
    targetId: z.number().int().positive(),
    operationalDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    shiftLabel: z.enum(MANUAL_SHIFT_LABELS),
    arrivalTime: z.string().regex(/^\d{2}:\d{2}$/),
    departureTime: z.string().regex(/^\d{2}:\d{2}$/),
    isShadow: z.boolean(),
    reason: z.string().trim().max(2000).default(""),
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

    const parsed = schema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
        return NextResponse.json({ error: "Preencha medico, local, dia, turno, chegada e saida." }, { status: 400 });
    }
    const { mode, ...input } = parsed.data;

    try {
        if (mode === "preview") {
            return NextResponse.json({ preview: await previewManualShift(input) }, { headers: { "Cache-Control": "no-store" } });
        }
        const result = await createManualShift(input, session.user.id);
        await getDb().insert(auditLogs).values({
            actorUserId: session.user.id,
            action: "admin.manual_shift.create",
            entityType: `${input.domain}_occupancy`,
            entityId: result.occupancyId,
            details: { ...input, bankEntry: result.bankEntry },
        });
        revalidatePath("/admin/payment-closing");
        revalidatePath("/admin/bank-hours");
        return NextResponse.json(result);
    } catch (error) {
        return NextResponse.json(
            { error: error instanceof Error ? error.message : "Nao foi possivel lancar o plantao." },
            { status: 400 },
        );
    }
}

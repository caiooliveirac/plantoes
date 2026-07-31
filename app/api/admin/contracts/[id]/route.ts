import { NextRequest, NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { getDb, hasDatabaseUrl } from "@/db";
import { auditLogs, contracts } from "@/db/schema";
import { AuthError, requireAuthenticatedSession } from "@/lib/auth/server";
import { loadContractLedger } from "@/services/contract-balance.service";

const patchSchema = z.object({
    // Teto e janela do ciclo mudam só por ação explícita de admin, nunca por
    // rotina automática (SPEC §12, decisão travada 3).
    ceilingBrl: z.number().positive().nullable().optional(),
    cycleStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    cycleEnd: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    endedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
    status: z.enum(["active", "suspended", "terminated"]).optional(),
    weeklyHours: z.number().positive().max(168).nullable().optional(),
    companyName: z.string().trim().max(255).nullable().optional(),
    notes: z.string().trim().max(2000).nullable().optional(),
}).refine((value) => Object.keys(value).length > 0, { message: "Nada para alterar." });

export async function GET(_request: NextRequest, context: { params: Promise<{ id: string }> }) {
    if (!hasDatabaseUrl()) {
        return NextResponse.json({ error: "DATABASE_URL is not configured for operations-v2." }, { status: 503 });
    }

    try {
        await requireAuthenticatedSession(["admin", "payment_closing_limited"]);
    } catch (error) {
        const status = error instanceof AuthError ? error.status : 500;
        return NextResponse.json({ error: error instanceof Error ? error.message : "Unauthorized." }, { status });
    }

    const { id } = await context.params;
    const entries = await loadContractLedger(id);
    return NextResponse.json({ entries, computedAt: new Date().toISOString() });
}

export async function PATCH(request: NextRequest, context: { params: Promise<{ id: string }> }) {
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

    const { id } = await context.params;
    const parsed = patchSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
        return NextResponse.json({ error: "Dados inválidos para alterar o contrato." }, { status: 400 });
    }
    const data = parsed.data;

    try {
        const db = getDb();
        const [updated] = await db.update(contracts)
            .set({
                ...(data.ceilingBrl !== undefined
                    ? { ceilingAmount: data.ceilingBrl === null ? null : data.ceilingBrl.toFixed(2) }
                    : {}),
                ...(data.cycleStart !== undefined ? { cycleStart: data.cycleStart } : {}),
                ...(data.cycleEnd !== undefined ? { cycleEnd: data.cycleEnd } : {}),
                ...(data.endedAt !== undefined ? { endedAt: data.endedAt } : {}),
                ...(data.status !== undefined ? { status: data.status } : {}),
                ...(data.weeklyHours !== undefined
                    ? { weeklyHours: data.weeklyHours === null ? null : String(data.weeklyHours) }
                    : {}),
                ...(data.companyName !== undefined ? { companyName: data.companyName } : {}),
                ...(data.notes !== undefined ? { notes: data.notes } : {}),
                updatedAt: new Date(),
            })
            .where(eq(contracts.id, id))
            .returning({ id: contracts.id });

        if (!updated) {
            return NextResponse.json({ error: "Contrato não encontrado." }, { status: 404 });
        }

        await db.insert(auditLogs).values({
            actorUserId: session.user.id,
            action: "contract.update",
            entityType: "contract",
            entityId: id,
            details: { ...data },
        });

        revalidatePath("/admin/payment-closing");
        return NextResponse.json({ contractId: id });
    } catch (error) {
        return NextResponse.json(
            { error: error instanceof Error ? error.message : "Não foi possível alterar o contrato." },
            { status: 400 },
        );
    }
}

import { NextRequest, NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { hasDatabaseUrl } from "@/db";
import { AuthError, requireAuthenticatedSession } from "@/lib/auth/server";
import { registerDoctor } from "@/services/doctor-admin.service";

// Cadastro rápido do admin (botão "Cadastrar médico"): médico + vínculo + contrato.
const registerSchema = z.object({
    fullName: z.string().trim().min(5).max(255),
    displayName: z.string().trim().max(255).nullable().optional(),
    employmentType: z.enum(["pj", "estatutario"]),
    isSpecialist: z.boolean(),
    ceilingBrl: z.number().positive().nullable().optional(),
    weeklyHours: z.number().positive().max(168).nullable().optional(),
});

export async function POST(request: NextRequest) {
    if (!hasDatabaseUrl()) {
        return NextResponse.json({ error: "database_unavailable" }, { status: 503 });
    }

    let session;
    try {
        // Cria contrato (dinheiro): só admin, como POST /api/admin/contracts.
        session = await requireAuthenticatedSession(["admin"]);
    } catch (error) {
        const status = error instanceof AuthError ? error.status : 500;
        return NextResponse.json({ error: error instanceof Error ? error.message : "Unauthorized." }, { status });
    }

    const parsed = registerSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
        return NextResponse.json({ error: "Dados do cadastro inválidos." }, { status: 400 });
    }

    try {
        const { doctor, contractId } = await registerDoctor({
            ...parsed.data,
            displayName: parsed.data.displayName ?? null,
            ceilingBrl: parsed.data.employmentType === "pj" ? parsed.data.ceilingBrl ?? null : null,
            weeklyHours: parsed.data.employmentType === "pj" ? parsed.data.weeklyHours ?? null : null,
            actorUserId: session.user.id,
        });
        revalidatePath("/admin/payment-closing");
        revalidatePath("/admin/medicos");
        return NextResponse.json({ doctorId: doctor.id, contractId }, { status: 201 });
    } catch (error) {
        return NextResponse.json(
            { error: error instanceof Error ? error.message : "Não foi possível cadastrar o médico." },
            { status: 409 },
        );
    }
}

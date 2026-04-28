import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { getDb, hasDatabaseUrl } from "@/db";
import { auditLogs, doctors, userRoles, users } from "@/db/schema";
import { getPasswordPolicyError } from "@/modules/auth/password-policy";
import { normalizeDoctorName } from "@/modules/doctors/importer";
import { hashPassword } from "@/services/auth.service";

const schema = z.object({
    fullName: z.string().trim().min(5).max(255),
    email: z.string().trim().email().max(255),
    password: z.string().min(1).max(200),
});

/**
 * Autocadastro do médico para operar a interface web de trocas/escala.
 * A conta nasce INATIVA (is_active = false) com role 'doctor' e só passa a
 * logar depois que a chefia ativar — mesmo gate de "inactive_account" que o
 * login já aplica hoje. Nada do fluxo do bot/Telegram é tocado.
 */
export async function POST(request: NextRequest) {
    if (!hasDatabaseUrl()) {
        return NextResponse.json({ error: "database_unavailable" }, { status: 503 });
    }

    const parsed = schema.safeParse(await request.json());
    if (!parsed.success) {
        return NextResponse.json({ error: "invalid_payload", issues: parsed.error.issues }, { status: 400 });
    }

    const passwordError = getPasswordPolicyError(parsed.data.password);
    if (passwordError) {
        return NextResponse.json({ error: passwordError }, { status: 400 });
    }

    const db = getDb();
    const normalizedName = normalizeDoctorName(parsed.data.fullName);
    const doctor = await db.query.doctors.findFirst({
        where: eq(doctors.normalizedName, normalizedName),
    });

    if (!doctor || !doctor.isActive) {
        return NextResponse.json(
            { error: "Nome não encontrado no cadastro de médicos. Confira a grafia exata usada na escala ou fale com a chefia." },
            { status: 404 },
        );
    }

    const email = parsed.data.email.trim().toLowerCase();
    const existingByEmail = await db.query.users.findFirst({ where: eq(users.email, email) });
    if (existingByEmail) {
        return NextResponse.json({ error: "Já existe uma conta com este e-mail." }, { status: 409 });
    }

    const existingByDoctor = await db.query.users.findFirst({ where: eq(users.doctorId, doctor.id) });
    if (existingByDoctor) {
        return NextResponse.json({ error: "Este médico já possui conta no sistema." }, { status: 409 });
    }

    const passwordHash = await hashPassword(parsed.data.password);
    const created = await db.transaction(async (tx) => {
        const [user] = await tx.insert(users).values({
            doctorId: doctor.id,
            email,
            passwordHash,
            isActive: false,
        }).returning();

        await tx.insert(userRoles).values({ userId: user.id, role: "doctor" });
        await tx.insert(auditLogs).values({
            actorUserId: user.id,
            action: "doctor_self_register",
            entityType: "user",
            entityId: user.id,
            details: { doctorId: doctor.id, email },
        });

        return user;
    });

    return NextResponse.json({
        status: "pending_activation",
        message: "Cadastro recebido. A chefia precisa ativar sua conta antes do primeiro login.",
        userId: created.id,
    }, { status: 201 });
}

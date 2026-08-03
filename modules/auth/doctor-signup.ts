import { createHmac, randomInt } from "node:crypto";
import { hash } from "bcryptjs";
import { and, desc, eq, isNull } from "drizzle-orm";
import { getDb } from "@/db";
import { auditLogs, doctorSignupEmailVerifications, doctors, userRoles, users } from "@/db/schema";
import { getPasswordPolicyError } from "@/modules/auth/password-policy";
import { resolveDoctorIdByCodename } from "@/modules/telegram/payment-access";

/**
 * Autocadastro do médico por codinome + verificação de posse do email.
 *
 * Passo 1 (start): codinome prova a identidade; enviamos um código de 6 dígitos
 * para o email informado. A conta ainda NÃO existe.
 * Passo 2 (complete): código + senha criam a conta já ATIVA com role 'doctor'.
 * Errar o email no passo 1 é inofensivo: o código nunca chega e nada foi criado.
 */
export const SIGNUP_CODE_TTL_MS = 15 * 60 * 1000;
export const SIGNUP_CODE_RESEND_COOLDOWN_MS = 60 * 1000;
export const SIGNUP_CODE_ATTEMPT_LIMIT = 5;

type ExistingAccount = { id: string; email: string };

// Conta já vinculada ao médico (seed de mar/2026 com email fake ou cadastro
// real anterior). O cadastro sempre re-vincula em cima dela — nunca bloqueia.
async function loadDoctorAccount(doctorId: string): Promise<ExistingAccount | null> {
    const db = getDb();
    const [user] = await db
        .select({ id: users.id, email: users.email })
        .from(users)
        .where(eq(users.doctorId, doctorId))
        .limit(1);
    return user ?? null;
}

export function normalizeSignupEmail(email: string) {
    return email.trim().toLowerCase();
}

function getPepper() {
    const secret = process.env.AUTH_SECRET?.trim();
    if (!secret) {
        throw new Error("AUTH_SECRET is required for doctor signup codes.");
    }
    return secret;
}

// 6 dígitos, com zeros à esquerda ("042137" é válido).
export function generateSignupCode() {
    return String(randomInt(0, 1_000_000)).padStart(6, "0");
}

// HMAC amarrado ao email: o mesmo código não vale para outro endereço.
export function hashSignupCode(code: string, email: string) {
    return createHmac("sha256", getPepper())
        .update(`${normalizeSignupEmail(email)}:${code.trim()}`)
        .digest("hex");
}

export type DoctorSignupStartResult =
    | { status: "invalid_codename" }
    | { status: "email_taken" }
    | { status: "cooldown"; retryInSeconds: number }
    | { status: "sent"; doctorId: string; email: string; code: string; fullName: string };

/**
 * Valida codinome + email e registra a verificação pendente. O ENVIO do email é
 * responsabilidade do chamador (rota), para manter este módulo testável sem SMTP.
 */
export async function startDoctorSignup(codename: string, rawEmail: string, now = new Date()): Promise<DoctorSignupStartResult> {
    const db = getDb();
    const email = normalizeSignupEmail(rawEmail);

    const doctorId = await resolveDoctorIdByCodename(codename);
    if (!doctorId) {
        return { status: "invalid_codename" };
    }

    // Conta existente do PRÓPRIO médico nunca bloqueia: o cadastro re-vincula
    // email+senha na mesma conta (decisão do coordenador — codinome + posse do
    // email são a prova). Só barra se o email pertencer a OUTRO usuário.
    const account = await loadDoctorAccount(doctorId);
    const [existingByEmail] = await db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.email, email))
        .limit(1);
    if (existingByEmail && existingByEmail.id !== account?.id) {
        return { status: "email_taken" };
    }

    // Cooldown de reenvio por médico: evita rajada de emails (e spam de códigos).
    const [latest] = await db
        .select({ createdAt: doctorSignupEmailVerifications.createdAt })
        .from(doctorSignupEmailVerifications)
        .where(eq(doctorSignupEmailVerifications.doctorId, doctorId))
        .orderBy(desc(doctorSignupEmailVerifications.createdAt))
        .limit(1);
    if (latest) {
        const elapsed = now.getTime() - latest.createdAt.getTime();
        if (elapsed < SIGNUP_CODE_RESEND_COOLDOWN_MS) {
            return { status: "cooldown", retryInSeconds: Math.ceil((SIGNUP_CODE_RESEND_COOLDOWN_MS - elapsed) / 1000) };
        }
    }

    const [doctor] = await db
        .select({ fullName: doctors.fullName })
        .from(doctors)
        .where(eq(doctors.id, doctorId))
        .limit(1);

    const code = generateSignupCode();
    await db.insert(doctorSignupEmailVerifications).values({
        doctorId,
        email,
        codeHmac: hashSignupCode(code, email),
        expiresAt: new Date(now.getTime() + SIGNUP_CODE_TTL_MS),
    });

    return { status: "sent", doctorId, email, code, fullName: doctor?.fullName ?? "" };
}

export type DoctorSignupCompleteResult =
    | { status: "invalid_codename" }
    | { status: "code_expired" }
    | { status: "too_many_attempts" }
    | { status: "invalid_code" }
    | { status: "weak_password"; message: string }
    | { status: "email_taken" }
    | { status: "created"; userId: string };

/** Passo 2: confere o código e cria a conta ativa com role 'doctor'. */
export async function completeDoctorSignup(
    codename: string,
    rawEmail: string,
    code: string,
    password: string,
    now = new Date(),
): Promise<DoctorSignupCompleteResult> {
    const db = getDb();
    const email = normalizeSignupEmail(rawEmail);

    const doctorId = await resolveDoctorIdByCodename(codename);
    if (!doctorId) {
        return { status: "invalid_codename" };
    }

    const [verification] = await db
        .select()
        .from(doctorSignupEmailVerifications)
        .where(and(
            eq(doctorSignupEmailVerifications.doctorId, doctorId),
            eq(doctorSignupEmailVerifications.email, email),
            isNull(doctorSignupEmailVerifications.consumedAt),
        ))
        .orderBy(desc(doctorSignupEmailVerifications.createdAt))
        .limit(1);

    if (!verification || verification.expiresAt.getTime() <= now.getTime()) {
        return { status: "code_expired" };
    }
    if (verification.attemptCount >= SIGNUP_CODE_ATTEMPT_LIMIT) {
        return { status: "too_many_attempts" };
    }

    if (hashSignupCode(code, email) !== verification.codeHmac) {
        await db
            .update(doctorSignupEmailVerifications)
            .set({ attemptCount: verification.attemptCount + 1 })
            .where(eq(doctorSignupEmailVerifications.id, verification.id));
        return { status: "invalid_code" };
    }

    const passwordError = getPasswordPolicyError(password);
    if (passwordError) {
        return { status: "weak_password", message: passwordError };
    }

    // Conta existente do próprio médico é re-vinculada; só barra email de terceiro.
    const account = await loadDoctorAccount(doctorId);
    const [existingByEmail] = await db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.email, email))
        .limit(1);
    if (existingByEmail && existingByEmail.id !== account?.id) {
        return { status: "email_taken" };
    }

    const passwordHash = await hash(password, 10);
    const userId = await db.transaction(async (tx) => {
        let userId: string;
        if (account) {
            // Re-vincula a conta existente: mesmo users.id (preserva FKs e roles),
            // email + senha novos por cima — placeholder do seed ou conta real,
            // codinome + código no email valem como prova (decisão do coordenador).
            await tx
                .update(users)
                .set({ email, passwordHash, isActive: true, mustChangePassword: false, updatedAt: new Date() })
                .where(eq(users.id, account.id));
            userId = account.id;
        } else {
            const [user] = await tx.insert(users).values({
                doctorId,
                email,
                passwordHash,
                isActive: true,
            }).returning({ id: users.id });
            userId = user.id;
        }

        await tx.insert(userRoles).values({ userId, role: "doctor" }).onConflictDoNothing();
        await tx
            .update(doctorSignupEmailVerifications)
            .set({ consumedAt: now })
            .where(eq(doctorSignupEmailVerifications.id, verification.id));
        await tx.insert(auditLogs).values({
            actorUserId: userId,
            action: account ? "doctor_signup_rebound_account" : "doctor_signup_email_verified",
            entityType: "user",
            entityId: userId,
            details: { doctorId, email, ...(account ? { previousEmail: account.email } : {}) },
        });

        return userId;
    });

    return { status: "created", userId };
}

export function buildSignupCodeEmail(params: { code: string; fullName: string }) {
    return {
        subject: `${params.code} é seu código de confirmação — Plantões SAMU`,
        text: [
            `Olá, ${params.fullName || "doutor(a)"}!`,
            "",
            `Seu código de confirmação de cadastro é: ${params.code}`,
            "",
            "Digite esse código na tela de cadastro para confirmar que este email é seu.",
            "Ele vale por 15 minutos.",
            "",
            "Se você não pediu este cadastro, ignore esta mensagem — nenhuma conta foi criada.",
        ].join("\n"),
    };
}

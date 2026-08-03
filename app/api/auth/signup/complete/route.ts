import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { hasDatabaseUrl } from "@/db";
import { writeSessionCookie } from "@/lib/auth/server";
import { completeDoctorSignup } from "@/modules/auth/doctor-signup";
import { getRequestIp, isSignupRateLimited } from "@/modules/auth/signup-rate-limit";

const schema = z.object({
    codename: z.string().trim().min(3).max(100),
    email: z.string().trim().email().max(255),
    code: z.string().trim().regex(/^\d{6}$/, "O código tem 6 dígitos."),
    password: z.string().min(1).max(200),
});

/**
 * Passo 2 do autocadastro: código de 6 dígitos + senha → cria a conta ativa com
 * role 'doctor' e já abre a sessão (cookie).
 */
export async function POST(request: NextRequest) {
    if (!hasDatabaseUrl()) {
        return NextResponse.json({ error: "database_unavailable" }, { status: 503 });
    }
    if (isSignupRateLimited(getRequestIp(request.headers))) {
        return NextResponse.json({ error: "Muitas tentativas. Aguarde alguns minutos e tente de novo." }, { status: 429 });
    }

    const parsed = schema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
        return NextResponse.json({ error: "Dados incompletos. Confira codinome, email, código de 6 dígitos e senha." }, { status: 400 });
    }

    const { codename, email, code, password } = parsed.data;
    const result = await completeDoctorSignup(codename, email, code, password);
    switch (result.status) {
        case "invalid_codename":
            return NextResponse.json({ error: "Codinome não confere. Confira com a coordenação." }, { status: 404 });
        case "code_expired":
            return NextResponse.json({ error: "Código expirado ou não encontrado. Volte e peça um novo código." }, { status: 410 });
        case "too_many_attempts":
            return NextResponse.json({ error: "Muitas tentativas erradas com este código. Peça um novo código." }, { status: 429 });
        case "invalid_code":
            return NextResponse.json({ error: "Código incorreto. Confira os 6 dígitos do email." }, { status: 400 });
        case "weak_password":
            return NextResponse.json({ error: result.message }, { status: 400 });
        case "doctor_already_registered":
            return NextResponse.json({ error: "Você já tem conta no sistema." }, { status: 409 });
        case "email_taken":
            return NextResponse.json({ error: "Já existe uma conta com este email." }, { status: 409 });
        case "created": {
            await writeSessionCookie(result.userId);
            return NextResponse.json({ ok: true }, { status: 201 });
        }
    }
}

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { hasDatabaseUrl } from "@/db";
import { isEmailConfigured, sendEmail } from "@/lib/email";
import { buildSignupCodeEmail, startDoctorSignup } from "@/modules/auth/doctor-signup";
import { getRequestIp, isSignupRateLimited } from "@/modules/auth/signup-rate-limit";

const schema = z.object({
    codename: z.string().trim().min(3).max(100),
    email: z.string().trim().email().max(255),
});

/**
 * Passo 1 do autocadastro do médico: codinome + email → envia código de 6
 * dígitos para provar a posse do endereço. Nenhuma conta é criada aqui.
 */
export async function POST(request: NextRequest) {
    if (!hasDatabaseUrl()) {
        return NextResponse.json({ error: "database_unavailable" }, { status: 503 });
    }
    if (!isEmailConfigured()) {
        return NextResponse.json({ error: "Envio de email não configurado no servidor. Avise a coordenação." }, { status: 503 });
    }
    if (isSignupRateLimited(getRequestIp(request.headers))) {
        return NextResponse.json({ error: "Muitas tentativas. Aguarde alguns minutos e tente de novo." }, { status: 429 });
    }

    const parsed = schema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
        return NextResponse.json({ error: "Informe codinome e um email válido." }, { status: 400 });
    }

    const result = await startDoctorSignup(parsed.data.codename, parsed.data.email);
    switch (result.status) {
        case "invalid_codename":
            return NextResponse.json({ error: "Codinome não confere. Confira com a coordenação." }, { status: 404 });
        case "email_taken":
            return NextResponse.json({ error: "Este email já está em uso por outra conta. Use outro email." }, { status: 409 });
        case "cooldown":
            return NextResponse.json({ error: `Código já enviado há pouco. Aguarde ${result.retryInSeconds}s para reenviar.` }, { status: 429 });
        case "sent":
            break;
    }

    try {
        const email = buildSignupCodeEmail({ code: result.code, fullName: result.fullName });
        await sendEmail({ to: result.email, subject: email.subject, text: email.text });
    } catch (error) {
        console.error("[signup] falha ao enviar código", error);
        return NextResponse.json({ error: "Não consegui enviar o email. Confira o endereço e tente de novo." }, { status: 502 });
    }

    return NextResponse.json({ ok: true, message: "Código enviado. Confira sua caixa de entrada (e o spam)." });
}

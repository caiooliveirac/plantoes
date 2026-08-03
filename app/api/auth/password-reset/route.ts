import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { hasDatabaseUrl } from "@/db";
import { isEmailConfigured, sendEmail } from "@/lib/email";
import { getRequestIp, isSignupRateLimited } from "@/modules/auth/signup-rate-limit";
import { createPasswordReset } from "@/services/auth.service";

const schema = z.object({
    email: z.string().email(),
});

export async function POST(request: NextRequest) {
    if (!hasDatabaseUrl()) {
        return NextResponse.json({ error: "DATABASE_URL is not configured for operations-v2." }, { status: 503 });
    }
    if (isSignupRateLimited(getRequestIp(request.headers))) {
        return NextResponse.json({ error: "Muitas tentativas. Aguarde alguns minutos." }, { status: 429 });
    }

    const parsed = schema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
        return NextResponse.json({ error: "A valid email is required." }, { status: 400 });
    }

    const result = await createPasswordReset(parsed.data.email);

    // Email desconhecido/inativo devolve o MESMO ok (sem enumeração de contas).
    // O link só é enviado quando o token existe e o SMTP está configurado.
    if (result.created && result.token && isEmailConfigured()) {
        const baseUrl = process.env.AUTH_URL?.trim()?.replace(/\/$/, "") || "https://plantoes.mnrs.com.br";
        try {
            await sendEmail({
                to: parsed.data.email.trim().toLowerCase(),
                subject: "Redefinição de senha — Plantões SAMU",
                text: [
                    "Recebemos um pedido para redefinir sua senha.",
                    "",
                    `Abra este link para escolher uma nova senha (vale por 2 horas):`,
                    `${baseUrl}/redefinir-senha/${result.token}`,
                    "",
                    "Se você não pediu a redefinição, ignore esta mensagem — sua senha continua a mesma.",
                ].join("\n"),
            });
        } catch (error) {
            console.error("[password-reset] falha ao enviar email", error);
        }
    }

    return NextResponse.json({
        ok: true,
        token: process.env.NODE_ENV === "production" ? null : result.token,
    });
}
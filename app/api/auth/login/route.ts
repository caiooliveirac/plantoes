import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { hasDatabaseUrl } from "@/db";
import { lerContextoRequisicao } from "@/lib/acessos/contexto";
import { depoisDaResposta } from "@/lib/acessos/depois";
import { authenticateWithPassword } from "@/services/auth.service";
import { registrarTentativaDeSenha } from "@/services/acessos.service";
import { writeSessionCookie } from "@/lib/auth/server";
import {
    LOGIN_RATE_LIMIT_MESSAGE,
    clearLoginFailures,
    getLoginClientIp,
    isLoginRateLimited,
    loginRateLimitKeys,
    registerLoginFailure,
} from "@/modules/auth/login-rate-limit";

const schema = z.object({
    email: z.string().email(),
    password: z.string().min(1),
});

const statusCodeByError = {
    invalid_credentials: 401,
    inactive_account: 403,
    no_roles_assigned: 403,
    pending_chief_approval: 403,
    rejected_chief_approval: 403,
} as const;

export async function POST(request: NextRequest) {
    if (!hasDatabaseUrl()) {
        return NextResponse.json({ error: "DATABASE_URL is not configured for operations-v2." }, { status: 503 });
    }

    const parsed = schema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
        return NextResponse.json({ error: "email and password are required." }, { status: 400 });
    }

    const rateLimitKeys = loginRateLimitKeys(getLoginClientIp(request.headers), parsed.data.email);
    if (isLoginRateLimited(rateLimitKeys)) {
        return NextResponse.json({ error: "too_many_attempts", message: LOGIN_RATE_LIMIT_MESSAGE }, { status: 429 });
    }

    const result = await authenticateWithPassword(parsed.data.email, parsed.data.password);
    if (result.status === "invalid_credentials") {
        registerLoginFailure(rateLimitKeys);
    }
    // Monitor de acessos: senha digitada, certa ou errada, com de onde veio.
    const contexto = lerContextoRequisicao(request.headers);
    const email = parsed.data.email;
    const userId = result.status === "success" ? result.user.id : null;
    const motivo = result.status === "success" ? undefined : result.status;
    depoisDaResposta(() => registrarTentativaDeSenha({ email, ok: userId !== null, via: "login", contexto, userId, motivo }));
    if (result.status !== "success") {
        return NextResponse.json({ error: result.status }, { status: statusCodeByError[result.status] });
    }

    clearLoginFailures(parsed.data.email);
    const expiresAt = await writeSessionCookie(result.user.id, { origem: "login" });
    return NextResponse.json({
        session: {
            user: result.user,
            expiresAt: expiresAt.toISOString(),
        },
    });
}
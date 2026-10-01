import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { hasDatabaseUrl } from "@/db";
import { lerContextoRequisicao } from "@/lib/acessos/contexto";
import { depoisDaResposta } from "@/lib/acessos/depois";
import { AuthError, contaNaMesa, requireAuthenticatedSession } from "@/lib/auth/server";
import {
    LOGIN_RATE_LIMIT_MESSAGE,
    clearLoginFailures,
    getLoginClientIp,
    isLoginRateLimited,
    loginRateLimitKeys,
    registerLoginFailure,
} from "@/modules/auth/login-rate-limit";
import { registrarTentativaDeSenha } from "@/services/acessos.service";
import { authenticateWithPassword } from "@/services/auth.service";
import { modoPresenca } from "@/modules/acessos/presenca";
import { assumirMesa } from "@/services/mesa-presenca.service";

/* "Usar aqui" na tela "aberto em outro dispositivo" (docs/presenca-mesa.md):
   com a senha da própria conta, este aparelho pega a Mesa na hora e o outro
   trava até alguém digitar a senha nele. Mesmo limite de tentativas do login
   (10 erradas em 15 min por IP e por e-mail). Senha nunca é gravada. */
const schema = z.object({ senha: z.string().min(1).max(200) });

export async function POST(request: NextRequest) {
    if (!hasDatabaseUrl()) return NextResponse.json({ error: "DATABASE_URL is not configured." }, { status: 503 });
    let session;
    try {
        session = await requireAuthenticatedSession(undefined, { allowPasswordChange: true });
    } catch (error) {
        const status = error instanceof AuthError ? error.status : 401;
        return NextResponse.json({ error: "sem_sessao" }, { status });
    }
    const parsed = schema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: "Digite a senha." }, { status: 400 });

    const email = session.user.email;
    const chaves = loginRateLimitKeys(getLoginClientIp(request.headers), email);
    if (isLoginRateLimited(chaves)) {
        return NextResponse.json({ error: LOGIN_RATE_LIMIT_MESSAGE }, { status: 429 });
    }

    const resultado = await authenticateWithPassword(email, parsed.data.senha);
    const ok = resultado.status === "success" && resultado.user.id === session.user.id;
    const contexto = lerContextoRequisicao(request.headers);
    const userId = session.user.id;
    depoisDaResposta(() => registrarTentativaDeSenha({ email, ok, via: "login", contexto, userId, motivo: "assumir_mesa" }));
    if (!ok) {
        registerLoginFailure(chaves);
        return NextResponse.json({ error: "Senha incorreta." }, { status: 401 });
    }
    clearLoginFailures(email);
    const conta = await contaNaMesa(session);
    try {
        if (conta) await assumirMesa(conta, modoPresenca());
    } catch (erro) {
        console.error("[presenca] assumir", erro);
        return NextResponse.json({ error: "Não foi possível usar a Mesa aqui agora." }, { status: 503 });
    }
    return NextResponse.json({ ok: true });
}

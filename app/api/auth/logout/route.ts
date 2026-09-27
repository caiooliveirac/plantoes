import { NextResponse, type NextRequest } from "next/server";
import { lerContextoRequisicao } from "@/lib/acessos/contexto";
import { depoisDaResposta } from "@/lib/acessos/depois";
import { SESSION_COOKIE_NAME, clearSessionCookie } from "@/lib/auth/server";
import { sessionIdOf, verifySessionToken } from "@/lib/auth/token";
import { registrarSaida } from "@/services/acessos.service";

export async function POST(request: NextRequest) {
    // Monitor de acessos: "Sair" encerra a sessão deste aparelho (auth_sessions.revoked_at).
    const raw = request.cookies.get(SESSION_COOKIE_NAME)?.value;
    const secret = process.env.AUTH_SECRET;
    const parsed = raw && secret ? verifySessionToken(raw, secret) : null;
    if (raw && parsed) {
        const sessaoId = sessionIdOf(parsed, raw);
        const contexto = lerContextoRequisicao(request.headers);
        depoisDaResposta(() => registrarSaida(sessaoId, parsed.sub, contexto));
    }
    await clearSessionCookie();
    return NextResponse.json({ ok: true });
}

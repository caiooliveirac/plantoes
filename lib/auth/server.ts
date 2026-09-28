import { randomUUID } from "node:crypto";
import { cookies, headers } from "next/headers";
import { and, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { userRoles, users } from "@/db/schema";
import { lerContextoRequisicao } from "@/lib/acessos/contexto";
import { depoisDaResposta } from "@/lib/acessos/depois";
import { rolesDoPlantoes, type UserRole } from "@/modules/auth/contracts";
import { createSessionToken, isSessionVersionCurrent, sessionIdOf, verifySessionToken, type SessionTokenPayload } from "@/lib/auth/token";
import { MENSAGEM_FORA_DO_PLANTAO } from "@/modules/acessos/portao";
import { conferirPortaoDeTurno, vigiarLugares } from "@/services/acessos-portao.service";
import {
    atualizarRedeDoContexto,
    registrarAcesso,
    registrarNovaSessao,
    renovarVersaoDaSessao,
    sessaoFoiEncerrada,
    type OrigemSessao,
} from "@/services/acessos.service";

export const SESSION_COOKIE_NAME = "operations_v2_session";
/* 30 dias, renovada a cada uso (proxy.ts). Com 12 h a sessão morria entre um
   plantão e o seguinte e o médico redigitava e-mail e senha no celular a cada
   turno — o log do escala mostrava o mesmo médico 4 a 6 vezes por semana
   (15/09/2026). "Sair" continua um clique. */
export const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 30;
/** Idade a partir da qual o portão reemite o cookie: uma vez por dia. */
export const SESSION_RENEW_AFTER_MS = 1000 * 60 * 60 * 24;

export class AuthError extends Error {
    status: number;

    constructor(status: number, message: string) {
        super(message);
        this.status = status;
    }
}

export interface AuthenticatedSession {
    user: {
        id: string;
        email: string;
        doctorId: string | null;
        roles: UserRole[];
        mustChangePassword: boolean;
    };
    expiresAt: string;
    /** Id da sessão no monitor de acessos (auth_sessions). Vazio só em loadUserSession sem id. */
    sessionId: string;
}

export function getAuthSecret() {
    const secret = process.env.AUTH_SECRET;
    if (!secret) {
        throw new Error("AUTH_SECRET is required to use authenticated operations.");
    }
    return secret;
}

/** Como a sessão nasce: um login/SSO/cadastro abre sessão nova (sid novo, linha
    em auth_sessions); a troca de senha continua a sessão de quem trocou, só com
    a versão nova — os outros aparelhos caem pela session_version. */
export type SessaoDoCookie =
    | { origem: OrigemSessao; detalhes?: Record<string, unknown> }
    | { continuarSessao: string };

/** Lê a session_version atual do banco: login, SSO, cadastro e troca de senha
    são raros, a consulta a mais só acontece neles. */
export async function writeSessionCookie(userId: string, sessao: SessaoDoCookie, expiresAt = new Date(Date.now() + SESSION_TTL_MS)) {
    const [row] = await getDb()
        .select({ sessionVersion: users.sessionVersion })
        .from(users)
        .where(eq(users.id, userId))
        .limit(1);
    const versao = row?.sessionVersion ?? 0;
    const sessionId = "continuarSessao" in sessao ? sessao.continuarSessao : randomUUID();
    const token = createSessionToken(
        {
            sub: userId,
            exp: expiresAt.getTime(),
            sv: versao,
            sid: sessionId,
        },
        getAuthSecret(),
    );

    const contexto = lerContextoRequisicao(await headers());
    if ("continuarSessao" in sessao) {
        depoisDaResposta(() => renovarVersaoDaSessao(sessionId, userId, versao, contexto));
    } else {
        // Antes de responder: o próximo pedido deste navegador já acha a sessão (monitor de acessos).
        await registrarNovaSessao({ sessaoId: sessionId, userId, origem: sessao.origem, versao, contexto, detalhes: sessao.detalhes });
        depoisDaResposta(() => atualizarRedeDoContexto(contexto));
    }

    const cookieStore = await cookies();
    cookieStore.set(SESSION_COOKIE_NAME, token, {
        httpOnly: true,
        sameSite: "lax",
        secure: process.env.NODE_ENV === "production",
        path: "/",
        expires: expiresAt,
    });

    return expiresAt;
}

export async function clearSessionCookie() {
    const cookieStore = await cookies();
    cookieStore.set(SESSION_COOKIE_NAME, "", {
        httpOnly: true,
        sameSite: "lax",
        secure: process.env.NODE_ENV === "production",
        path: "/",
        expires: new Date(0),
    });
}

/** Exportada para os testes (tests/contas-portal-db.test.ts); a app usa readAuthenticatedSession.
    Com `sessionId`, sessão encerrada pelo admin ou por "Sair" (auth_sessions.revoked_at) não vale. */
export async function loadUserSession(token: SessionTokenPayload, sessionId?: string): Promise<AuthenticatedSession | null> {
    const db = getDb();
    const [user] = await db
        .select({
            id: users.id,
            email: users.email,
            doctorId: users.doctorId,
            mustChangePassword: users.mustChangePassword,
            isActive: users.isActive,
            sessionVersion: users.sessionVersion,
        })
        .from(users)
        .where(eq(users.id, token.sub))
        .limit(1);

    if (!user || !user.isActive || !isSessionVersionCurrent(token, user.sessionVersion)) {
        return null;
    }

    if (sessionId && await sessaoFoiEncerrada(sessionId)) {
        return null;
    }

    const rolesRows = await db
        .select({ role: userRoles.role })
        .from(userRoles)
        .where(and(eq(userRoles.userId, user.id)));

    // `portal` não abre nada aqui (modules/auth/contracts.ts): conta só com ele
    // fica sem sessão, igual a conta sem papel; e ele nunca aparece em roles.
    const roles: UserRole[] = rolesDoPlantoes(rolesRows.map((row) => row.role));

    if (roles.length === 0) {
        return null;
    }

    return {
        user: {
            id: user.id,
            email: user.email,
            doctorId: user.doctorId,
            roles,
            mustChangePassword: user.mustChangePassword,
        },
        expiresAt: new Date(token.exp).toISOString(),
        sessionId: sessionId ?? "",
    };
}

/* Um pedido chama o portão às vezes mais de uma vez (página + componente); o
   registro de acesso sai uma vez só por pedido — o objeto de headers é o mesmo. */
const pedidosRegistrados = new WeakSet<object>();

export async function readAuthenticatedSession(): Promise<AuthenticatedSession | null> {
    const cookieStore = await cookies();
    const rawToken = cookieStore.get(SESSION_COOKIE_NAME)?.value;
    if (!rawToken) {
        return null;
    }

    const parsed = verifySessionToken(rawToken, getAuthSecret());
    if (!parsed) {
        return null;
    }

    const sessionId = sessionIdOf(parsed, rawToken);
    const session = await loadUserSession(parsed, sessionId);
    if (!session) {
        return null;
    }

    // Monitor de acessos (docs/monitor-acessos.md): o contexto é lido agora — em
    // Server Component, headers() não pode ser chamado dentro do after().
    const requestHeaders = await headers();
    if (!pedidosRegistrados.has(requestHeaders)) {
        pedidosRegistrados.add(requestHeaders);
        const contexto = lerContextoRequisicao(requestHeaders);
        depoisDaResposta(async () => {
            await registrarAcesso({ sessaoId: sessionId, userId: session.user.id, versao: parsed.sv ?? 0, contexto });
            await vigiarLugares(session.user.id, sessionId, contexto.ip);
        });
    }
    return session;
}

export async function requireAuthenticatedSession(requiredRoles?: UserRole[], options?: { allowPasswordChange?: boolean }) {
    const session = await readAuthenticatedSession();
    if (!session) {
        throw new AuthError(401, "Authentication required.");
    }

    if (!options?.allowPasswordChange && session.user.mustChangePassword) {
        throw new AuthError(403, "Password change required before accessing protected operations.");
    }

    if (requiredRoles && !requiredRoles.some((role) => session.user.roles.includes(role))) {
        throw new AuthError(403, "You do not have permission to perform this action.");
    }

    return session;
}
/** Leitura do quadro: qualquer papel, inclusive com senha provisória — a pessoa
    precisa ver a tela para trocar a senha no popover. */
export async function requireSessionForRead() {
    return requireAuthenticatedSession(undefined, { allowPasswordChange: true });
}

/* Mesa operacional (quadro, ações do quadro, histórico): só de plantão, na
   Central ou admin — portão de turno, docs/monitor-acessos.md. Folha de
   ponto, banco de horas, dados do médico e senha seguem abertos. */
export async function mesaLiberadaPara(session: AuthenticatedSession) {
    const portao = await conferirPortaoDeTurno(
        { userId: session.user.id, doctorId: session.user.doctorId, roles: session.user.roles },
        lerContextoRequisicao(await headers()),
        "mesa",
    );
    return portao.liberado;
}

export async function requireMesaSession(requiredRoles?: UserRole[], options?: { allowPasswordChange?: boolean }) {
    const session = await requireAuthenticatedSession(requiredRoles, options);
    if (!(await mesaLiberadaPara(session))) throw new AuthError(403, MENSAGEM_FORA_DO_PLANTAO);
    return session;
}

export async function requireMesaSessionForRead() {
    return requireMesaSession(undefined, { allowPasswordChange: true });
}

/* Conexão longa (SSE do quadro): o portão roda na abertura e depois de novo a
   cada consulta desta função, sem cookies()/headers() — que não valem fora do
   pedido. Pega o fim do turno, "Sair", sessão encerrada pelo admin, senha
   trocada e conta suspensa com o stream já aberto. Erro de banco deixa passar,
   como no portão. */
export async function abrirVigiaDaMesa(): Promise<() => Promise<boolean>> {
    const session = await requireMesaSessionForRead();
    const rawToken = (await cookies()).get(SESSION_COOKIE_NAME)?.value ?? "";
    const contexto = lerContextoRequisicao(await headers());
    return async () => {
        try {
            const parsed = verifySessionToken(rawToken, getAuthSecret());
            if (!parsed) return false;
            const atual = await loadUserSession(parsed, session.sessionId);
            if (!atual) return false;
            const portao = await conferirPortaoDeTurno(
                { userId: atual.user.id, doctorId: atual.user.doctorId, roles: atual.user.roles },
                contexto,
                "mesa",
            );
            return portao.liberado;
        } catch (erro) {
            console.error("[acessos] vigia do stream", erro);
            return true;
        }
    };
}

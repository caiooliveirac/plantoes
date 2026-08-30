import { cookies } from "next/headers";
import { and, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { userRoles, users } from "@/db/schema";
import { USER_ROLES, type UserRole } from "@/modules/auth/contracts";
import {
    KAIROS_SESSION_COOKIE,
    introspectKairosSession,
    isKairosIntegrationConfigured,
} from "@/lib/auth/kairos";
import { createSessionToken, verifySessionToken } from "@/lib/auth/token";

const SESSION_COOKIE_NAME = "operations_v2_session";
const SESSION_TTL_MS = 1000 * 60 * 60 * 12;

/**
 * Horizonte NOMINAL da sessão apoiada no Kairós. Não há cookie local: a
 * validade real é a sessão de lá, reconferida a CADA requisição — revogar no
 * Kairós corta o acesso aqui no instante seguinte, que é o motivo de o ADR
 * 0002 de lá ter recusado JWT verificado localmente.
 */
const KAIROS_SESSION_HORIZON_MS = 1000 * 60 * 5;

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
}

function getAuthSecret() {
    const secret = process.env.AUTH_SECRET;
    if (!secret) {
        throw new Error("AUTH_SECRET is required to use authenticated operations.");
    }
    return secret;
}

export async function writeSessionCookie(userId: string, expiresAt = new Date(Date.now() + SESSION_TTL_MS)) {
    const token = createSessionToken(
        {
            sub: userId,
            exp: expiresAt.getTime(),
        },
        getAuthSecret(),
    );

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

async function loadUserSession(userId: string, expiresAt: number): Promise<AuthenticatedSession | null> {
    const db = getDb();
    const [user] = await db
        .select({
            id: users.id,
            email: users.email,
            doctorId: users.doctorId,
            mustChangePassword: users.mustChangePassword,
            isActive: users.isActive,
        })
        .from(users)
        .where(eq(users.id, userId))
        .limit(1);

    if (!user || !user.isActive) {
        return null;
    }

    const rolesRows = await db
        .select({ role: userRoles.role })
        .from(userRoles)
        .where(and(eq(userRoles.userId, user.id)));

    const roles = rolesRows
        .map((row) => row.role)
        .filter((role): role is UserRole => USER_ROLES.includes(role));

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
        expiresAt: new Date(expiresAt).toISOString(),
    };
}

/**
 * Sessão apoiada no cookie do Kairós (`kairos_sessao`, emitido no domínio pai
 * `.mnrs.com.br` — chega aqui sozinho). É a transição "aceitar as duas" do
 * contrato de integração: o login local continua inteiro; este caminho só
 * soma. Desligado sem KAIROS_URL + KAIROS_SERVICO_TOKEN.
 */
async function readKairosBackedSession(
    cookieStore: Awaited<ReturnType<typeof cookies>>,
): Promise<AuthenticatedSession | null> {
    if (!isKairosIntegrationConfigured()) {
        return null;
    }
    const kairosCookie = cookieStore.get(KAIROS_SESSION_COOKIE)?.value;
    if (!kairosCookie) {
        return null;
    }

    const result = await introspectKairosSession(kairosCookie);
    if (!result.ok) {
        return null;
    }

    /* A ponte de identidade é o e-mail, enquanto a `legacy_ref` do Kairós não
       cobre este sistema: pessoa do Kairós sem e-mail (médico importado do
       cadastro antigo) ou sem conta local ativa aqui simplesmente não entra
       por este caminho — o login local continua disponível. Nenhuma conta é
       criada: sem conta cá, sem acesso, que é a regra do parque. */
    const email = result.person.email?.trim().toLowerCase();
    if (!email) {
        return null;
    }

    const db = getDb();
    const [user] = await db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.email, email))
        .limit(1);
    if (!user) {
        console.log(
            `[auth-kairos] ${new Date().toISOString()} sem_conta_local ${JSON.stringify({ pessoaId: result.person.id })}`,
        );
        return null;
    }

    const session = await loadUserSession(user.id, Date.now() + KAIROS_SESSION_HORIZON_MS);
    if (!session) {
        return null;
    }

    /* `mustChangePassword` é estado da senha LOCAL, que este caminho não usa:
       quem entra pelo Kairós já passou pela troca obrigatória de lá (regra 2
       da introspecção). Barrar aqui mandaria a pessoa trocar uma senha que
       ela não digitou — beco sem saída, não segurança. */
    return { ...session, user: { ...session.user, mustChangePassword: false } };
}

export async function readAuthenticatedSession(): Promise<AuthenticatedSession | null> {
    const cookieStore = await cookies();
    const rawToken = cookieStore.get(SESSION_COOKIE_NAME)?.value;
    if (rawToken) {
        const parsed = verifySessionToken(rawToken, getAuthSecret());
        if (parsed) {
            const session = await loadUserSession(parsed.sub, parsed.exp);
            if (session) {
                return session;
            }
        }
    }

    return readKairosBackedSession(cookieStore);
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
import { cookies } from "next/headers";
import { and, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { userRoles, users } from "@/db/schema";
import { USER_ROLES, type UserRole } from "@/modules/auth/contracts";
import { createSessionToken, verifySessionToken } from "@/lib/auth/token";

const SESSION_COOKIE_NAME = "operations_v2_session";
const SESSION_TTL_MS = 1000 * 60 * 60 * 12;

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
        },
        expiresAt: new Date(expiresAt).toISOString(),
    };
}

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

    return loadUserSession(parsed.sub, parsed.exp);
}

export async function requireAuthenticatedSession(requiredRoles?: UserRole[]) {
    const session = await readAuthenticatedSession();
    if (!session) {
        throw new AuthError(401, "Authentication required.");
    }

    if (requiredRoles && !requiredRoles.some((role) => session.user.roles.includes(role))) {
        throw new AuthError(403, "You do not have permission to perform this action.");
    }

    return session;
}
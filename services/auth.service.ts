import { compare, hash } from "bcryptjs";
import { and, desc, eq, gt, isNull } from "drizzle-orm";
import { getDb } from "@/db";
import { passwordResetTokens, chiefAccessRequests, userRoles, users } from "@/db/schema";
import { USER_ROLES, type UserRole } from "@/modules/auth/contracts";

export type CredentialsStatus =
    | "success"
    | "invalid_credentials"
    | "inactive_account"
    | "no_roles_assigned"
    | "pending_chief_approval"
    | "rejected_chief_approval";

export interface AuthenticatedUser {
    id: string;
    email: string;
    doctorId: string | null;
    roles: UserRole[];
}

export type CredentialsResult =
    | { status: Exclude<CredentialsStatus, "success"> }
    | { status: "success"; user: AuthenticatedUser };

function normalizeEmail(email: string) {
    return email.trim().toLowerCase();
}

export async function hashPassword(value: string) {
    return hash(value, 10);
}

export async function authenticateWithPassword(email: string, password: string): Promise<CredentialsResult> {
    const db = getDb();
    const normalizedEmail = normalizeEmail(email);

    const [user] = await db
        .select({
            id: users.id,
            email: users.email,
            doctorId: users.doctorId,
            passwordHash: users.passwordHash,
            isActive: users.isActive,
        })
        .from(users)
        .where(eq(users.email, normalizedEmail))
        .limit(1);

    if (user) {
        const passwordMatches = await compare(password, user.passwordHash);
        if (passwordMatches) {
            if (!user.isActive) {
                return { status: "inactive_account" };
            }

            const rolesRows = await db
                .select({ role: userRoles.role })
                .from(userRoles)
                .where(eq(userRoles.userId, user.id));

            const roles = rolesRows
                .map((row) => row.role)
                .filter((role): role is UserRole => USER_ROLES.includes(role));

            if (roles.length === 0) {
                return { status: "no_roles_assigned" };
            }

            return {
                status: "success",
                user: {
                    id: user.id,
                    email: user.email,
                    doctorId: user.doctorId,
                    roles,
                },
            };
        }
    }

    const [request] = await db
        .select({
            passwordHash: chiefAccessRequests.passwordHash,
            status: chiefAccessRequests.status,
        })
        .from(chiefAccessRequests)
        .where(eq(chiefAccessRequests.requestedEmail, normalizedEmail))
        .orderBy(desc(chiefAccessRequests.createdAt))
        .limit(1);

    if (request) {
        const passwordMatches = await compare(password, request.passwordHash);
        if (passwordMatches) {
            if (request.status === "pending") {
                return { status: "pending_chief_approval" };
            }

            if (request.status === "rejected") {
                return { status: "rejected_chief_approval" };
            }
        }
    }

    return { status: "invalid_credentials" };
}

export async function createPasswordReset(email: string) {
    const db = getDb();
    const normalizedEmail = normalizeEmail(email);
    const [user] = await db
        .select({ id: users.id, email: users.email, isActive: users.isActive })
        .from(users)
        .where(eq(users.email, normalizedEmail))
        .limit(1);

    if (!user || !user.isActive) {
        return { created: false, token: null as string | null };
    }

    const token = crypto.randomUUID().replace(/-/g, "");
    const expiresAt = new Date(Date.now() + 1000 * 60 * 60 * 2);

    await db.insert(passwordResetTokens).values({
        userId: user.id,
        token,
        expiresAt,
    });

    return { created: true, token };
}

export async function getPasswordResetToken(token: string) {
    const db = getDb();
    const [resetToken] = await db
        .select({
            id: passwordResetTokens.id,
            token: passwordResetTokens.token,
            userId: passwordResetTokens.userId,
            email: users.email,
        })
        .from(passwordResetTokens)
        .innerJoin(users, eq(users.id, passwordResetTokens.userId))
        .where(and(
            eq(passwordResetTokens.token, token),
            isNull(passwordResetTokens.usedAt),
            gt(passwordResetTokens.expiresAt, new Date()),
        ))
        .limit(1);

    return resetToken ?? null;
}

export async function consumePasswordReset(token: string, password: string) {
    const db = getDb();
    const resetToken = await getPasswordResetToken(token);
    if (!resetToken) {
        throw new Error("Password reset token is invalid or expired.");
    }

    const passwordHash = await hashPassword(password);

    await db.transaction(async (tx) => {
        await tx
            .update(users)
            .set({
                passwordHash,
                updatedAt: new Date(),
            })
            .where(eq(users.id, resetToken.userId));

        await tx
            .update(passwordResetTokens)
            .set({ usedAt: new Date() })
            .where(eq(passwordResetTokens.id, resetToken.id));
    });

    return { ok: true };
}
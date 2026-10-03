import { compare, hash } from "bcryptjs";
import { and, desc, eq, gt, isNull, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { auditLogs, passwordResetTokens, chiefAccessRequests, userRoles, users } from "@/db/schema";
import { USER_ROLES, ehSoInterno, rolesDoPlantoes, type UserRole } from "@/modules/auth/contracts";
import { getPasswordPolicyError } from "@/modules/auth/password-policy";

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
    mustChangePassword: boolean;
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

/**
 * Onde a credencial vai valer:
 * - "plantoes" (padrão): login no próprio app. Papel `portal` NÃO conta — conta
 *   só com `portal` volta `no_roles_assigned`, e `roles` sai sem `portal`.
 * - "portal": verificar-escala (porteiro do mnrs.com.br). Qualquer papel vale,
 *   inclusive `portal`.
 * O padrão é o restrito de propósito: chamador novo que esquecer o parâmetro
 * não abre o app para conta de portal.
 */
export type EscopoCredencial = "plantoes" | "portal";

export async function authenticateWithPassword(
    email: string,
    password: string,
    options: { escopo?: EscopoCredencial } = {},
): Promise<CredentialsResult> {
    const escopo = options.escopo ?? "plantoes";
    const db = getDb();
    const normalizedEmail = normalizeEmail(email);

    const [user] = await db
        .select({
            id: users.id,
            email: users.email,
            doctorId: users.doctorId,
            passwordHash: users.passwordHash,
            mustChangePassword: users.mustChangePassword,
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

            const todos = rolesRows
                .map((row) => row.role)
                .filter((role): role is UserRole => USER_ROLES.includes(role));
            const roles: UserRole[] = escopo === "portal" ? todos : rolesDoPlantoes(todos);

            // Interno(a) do GOA nunca entra por senha, nem no portal: só pelo
            // SkyRescue (docs/internos-goa.md). A senha dele é aleatória; isto
            // vale também se alguém definir uma à mão.
            if (roles.length === 0 || ehSoInterno(todos)) {
                return { status: "no_roles_assigned" };
            }

            return {
                status: "success",
                user: {
                    id: user.id,
                    email: user.email,
                    doctorId: user.doctorId,
                    roles,
                    mustChangePassword: user.mustChangePassword,
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

    const token = await createPasswordResetTokenForUser(user.id, PASSWORD_RESET_TTL_MS);
    return { created: true, token };
}

/** "Esqueci a senha": o link vale 2 horas. */
export const PASSWORD_RESET_TTL_MS = 1000 * 60 * 60 * 2;

/**
 * Grava um token de /redefinir-senha/<token> para a conta. O mesmo mecanismo
 * serve ao "esqueci a senha" (2 h) e ao boas-vindas da conta de portal, que
 * precisa de mais prazo (7 dias — services/portal-accounts.service.ts).
 */
export async function createPasswordResetTokenForUser(
    userId: string,
    ttlMs: number,
    db: Pick<ReturnType<typeof getDb>, "insert"> = getDb(),
) {
    const token = crypto.randomUUID().replace(/-/g, "");
    await db.insert(passwordResetTokens).values({
        userId,
        token,
        expiresAt: new Date(Date.now() + ttlMs),
    });
    return token;
}

export async function getPasswordResetToken(token: string) {
    const db = getDb();
    const [resetToken] = await db
        .select({
            id: passwordResetTokens.id,
            token: passwordResetTokens.token,
            userId: passwordResetTokens.userId,
            email: users.email,
            // Conta que só tem o papel `portal`: depois de definir a senha, a
            // tela manda para https://mnrs.com.br, não para o login daqui.
            somentePortal: sql<boolean>`not exists (
                select 1 from ${userRoles}
                where ${userRoles.userId} = ${users.id} and ${userRoles.role} <> 'portal'
            ) and exists (
                select 1 from ${userRoles}
                where ${userRoles.userId} = ${users.id} and ${userRoles.role} = 'portal'
            )`,
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

    const passwordPolicyError = getPasswordPolicyError(password);
    if (passwordPolicyError) {
        throw new Error(passwordPolicyError);
    }

    const passwordHash = await hashPassword(password);

    await db.transaction(async (tx) => {
        await tx
            .update(users)
            .set({
                passwordHash,
                mustChangePassword: false,
                // Derruba as sessões abertas com a senha antiga (lib/auth/server.ts).
                sessionVersion: sql`${users.sessionVersion} + 1`,
                updatedAt: new Date(),
            })
            .where(eq(users.id, resetToken.userId));

        await tx
            .update(passwordResetTokens)
            .set({ usedAt: new Date() })
            .where(eq(passwordResetTokens.id, resetToken.id));

        // Entra no cálculo de "senhaAlteradaEm" do verificar-escala
        // (SENHA_DEFINIDA_ACTIONS). Ator = a própria conta: quem tem o link é ela.
        await tx.insert(auditLogs).values({
            actorUserId: resetToken.userId,
            action: "auth.password_reset_completed",
            entityType: "user",
            entityId: resetToken.userId,
            details: { resetTokenId: resetToken.id },
        });
    });

    return { ok: true, somentePortal: Boolean(resetToken.somentePortal) };
}

export async function changeOwnPassword(userId: string, currentPassword: string, nextPassword: string) {
    const db = getDb();
    const [user] = await db
        .select({
            id: users.id,
            passwordHash: users.passwordHash,
            mustChangePassword: users.mustChangePassword,
        })
        .from(users)
        .where(eq(users.id, userId))
        .limit(1);

    if (!user) {
        throw new Error("User not found.");
    }

    const passwordMatches = await compare(currentPassword, user.passwordHash);
    if (!passwordMatches) {
        throw new Error("Senha atual incorreta.");
    }

    const passwordPolicyError = getPasswordPolicyError(nextPassword, currentPassword);
    if (passwordPolicyError) {
        throw new Error(passwordPolicyError);
    }

    const passwordHash = await hashPassword(nextPassword);

    await db.transaction(async (tx) => {
        await tx
            .update(users)
            .set({
                passwordHash,
                mustChangePassword: false,
                // Derruba as sessões abertas com a senha antiga (lib/auth/server.ts).
                sessionVersion: sql`${users.sessionVersion} + 1`,
                updatedAt: new Date(),
            })
            .where(eq(users.id, userId));

        await tx.insert(auditLogs).values({
            actorUserId: userId,
            action: user.mustChangePassword ? "auth.password_changed_first_login" : "auth.password_changed",
            entityType: "user",
            entityId: userId,
            details: {
                mustChangePasswordCleared: user.mustChangePassword,
            },
        });
    });

    return { ok: true };
}
/* ==========================================================================
   Por que o login falhou — para o porteiro do mnrs.com.br explicar à pessoa
   (verificar-escala). Só é consultado DEPOIS de authenticateWithPassword ter
   devolvido invalid_credentials.
   ========================================================================== */

/**
 * Ações de audit_logs que gravam (ou regravam) a senha de uma conta, com
 * entity_type = 'user' e entity_id = users.id. `chief_request.approved` fica de
 * fora da lista porque o entity dele é a solicitação — é tratado à parte, pelo
 * details.approvedUserId.
 */
/** Monitor de acessos: admin trocou a senha por uma aleatória e mandou o link de redefinição. */
export const REDEFINICAO_PELO_ADMIN = "auth.password_revoked_by_admin";

export const SENHA_DEFINIDA_ACTIONS = [
    "auth.password_changed",
    "auth.password_changed_first_login",
    "auth.password_reset_completed",
    "chief_access.bootstrap_created",
    "chief_access.bootstrap_rotated",
    "doctor_signup_email_verified",
    "doctor_signup_rebound_account",
    "portal_account.created",
    REDEFINICAO_PELO_ADMIN,
] as const;

export interface SituacaoConta {
    conta: "inexistente" | "existente";
    /** Só com conta "existente": último momento conhecido em que a senha foi definida. */
    senhaAlteradaEm?: string | null;
}

function paraIso(valor: unknown): string | null {
    if (valor === null || valor === undefined) return null;
    const data = valor instanceof Date ? valor : new Date(String(valor));
    return Number.isNaN(data.getTime()) ? null : data.toISOString();
}

/**
 * "inexistente": nenhuma linha em users nem em chief_access_requests com o
 * e-mail. Caso contrário "existente", com `senhaAlteradaEm` = o mais recente
 * entre as ações de SENHA_DEFINIDA_ACTIONS, a aprovação de chefia que criou/
 * regravou a conta e o uso de link de redefinição (password_reset_tokens.used_at,
 * que cobre os resets anteriores a auth.password_reset_completed existir).
 * Sem nada disso, null. Sem users mas com solicitação de chefia, vale a data
 * da solicitação mais recente (é quando aquela senha foi escolhida).
 *
 * Calculado do que já existe no banco, sem coluna nova: as gravações de senha
 * já deixam rastro, e uma coluna exigiria backfill aproximado do mesmo rastro.
 */
export async function consultarSituacaoConta(email: string): Promise<SituacaoConta> {
    const db = getDb();
    const normalizedEmail = normalizeEmail(email);

    const [user] = await db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.email, normalizedEmail))
        .limit(1);

    if (user) {
        const rows = await db.execute<{ em: unknown }>(sql`
            select greatest(
                (select max(al.created_at) from ${auditLogs} al
                  where al.entity_type = 'user'
                    and al.entity_id = ${user.id}
                    and al.action in (${sql.join(SENHA_DEFINIDA_ACTIONS.map((a) => sql`${a}`), sql`, `)})),
                (select max(al.created_at) from ${auditLogs} al
                  where al.action = 'chief_request.approved'
                    and al.details->>'approvedUserId' = ${user.id}),
                (select max(prt.used_at) from ${passwordResetTokens} prt
                  where prt.user_id = ${user.id})
            ) as em
        `);
        return { conta: "existente", senhaAlteradaEm: paraIso(rows[0]?.em) };
    }

    const [request] = await db
        .select({ createdAt: chiefAccessRequests.createdAt })
        .from(chiefAccessRequests)
        .where(eq(chiefAccessRequests.requestedEmail, normalizedEmail))
        .orderBy(desc(chiefAccessRequests.createdAt))
        .limit(1);

    if (request) {
        return { conta: "existente", senhaAlteradaEm: paraIso(request.createdAt) };
    }

    return { conta: "inexistente" };
}

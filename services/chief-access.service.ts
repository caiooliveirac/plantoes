import { randomUUID } from "node:crypto";
import { hash } from "bcryptjs";
import { and, asc, desc, eq, gt, isNull, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { auditLogs, chiefAccessRequests, chiefInvites, doctors, userRoles, users } from "@/db/schema";
import { getPasswordPolicyError } from "@/modules/auth/password-policy";
import { hashPassword } from "@/services/auth.service";
import {
    validateChiefBootstrapAccessInput,
    type BootstrapChiefAccessInput,
    validateChiefAccessRequestInput,
    validateChiefAccessReviewInput,
    validateChiefInviteInput,
    type CreateChiefInviteInput,
    type ReviewChiefAccessRequestInput,
    type SubmitChiefAccessRequestInput,
} from "@/modules/chiefs/service";

function normalizeEmail(email: string) {
    return email.trim().toLowerCase();
}

function createInviteToken() {
    return randomUUID().replace(/-/g, "");
}

export async function createChiefInvite(input: CreateChiefInviteInput, actorUserId: string) {
    const db = getDb();
    const parsed = validateChiefInviteInput(input);
    const inviteEmail = parsed.email ? normalizeEmail(parsed.email) : null;

    if (parsed.inviteMode === "email" && !inviteEmail) {
        throw new Error("Email invite mode requires an email address.");
    }

    const [invite] = await db.insert(chiefInvites).values({
        token: createInviteToken(),
        email: inviteEmail,
        inviteMode: parsed.inviteMode,
        invitedByUserId: actorUserId,
        expiresAt: parsed.expiresAt,
    }).returning();

    await db.insert(auditLogs).values({
        actorUserId,
        action: "chief_invite.created",
        entityType: "chief_invite",
        entityId: invite.id,
        details: {
            inviteMode: invite.inviteMode,
            email: invite.email,
            expiresAt: invite.expiresAt,
        },
    });

    return invite;
}

export async function listChiefInvites() {
    const db = getDb();
    const rows = await db.execute(sql`
        select
          ci.id,
          ci.token,
          ci.email,
          ci.invite_mode,
          ci.expires_at,
          ci.used_at,
          ci.created_at,
          u.email as invited_by_email
        from chief_invites ci
        left join users u
          on u.id = ci.invited_by_user_id
        order by ci.created_at desc
    `);

    return rows as unknown as Array<{
        id: string;
        token: string;
        email: string | null;
        invite_mode: "email" | "bearer";
        expires_at: string;
        used_at: string | null;
        created_at: string;
        invited_by_email: string | null;
    }>;
}

export async function getValidChiefInvite(token: string) {
    const db = getDb();
    const [invite] = await db
        .select()
        .from(chiefInvites)
        .where(and(
            eq(chiefInvites.token, token),
            isNull(chiefInvites.usedAt),
            gt(chiefInvites.expiresAt, new Date()),
        ))
        .limit(1);

    return invite ?? null;
}

export async function listDoctorsForChiefInvite() {
    const db = getDb();
    const rows = await db
        .select({
            id: doctors.id,
            fullName: doctors.fullName,
            displayName: doctors.displayName,
        })
        .from(doctors)
        .where(eq(doctors.isActive, true))
        .orderBy(asc(doctors.fullName));

    return rows;
}

export async function submitChiefAccessRequest(input: Omit<SubmitChiefAccessRequestInput, "inviteId" | "passwordHash"> & { token: string; password: string }) {
    const db = getDb();
    const invite = await getValidChiefInvite(input.token);
    if (!invite) {
        throw new Error("Chief invite is invalid or expired.");
    }

    const requestedEmail = normalizeEmail(input.requestedEmail);
    if (invite.inviteMode === "email" && invite.email !== requestedEmail) {
        throw new Error("Requested email does not match the email bound to this invite.");
    }

    const doctor = await db.query.doctors.findFirst({
        where: eq(doctors.id, input.doctorId),
    });

    if (!doctor || !doctor.isActive) {
        throw new Error("Selected doctor was not found in the official directory.");
    }

    const passwordHash = await hash(input.password, 10);
    const parsed = validateChiefAccessRequestInput({
        inviteId: invite.id,
        doctorId: input.doctorId,
        requestedEmail,
        phone: input.phone,
        registrationNumber: input.registrationNumber,
        selfieUrl: input.selfieUrl,
        passwordHash,
    });

    const [request] = await db.transaction(async (tx) => {
        const [created] = await tx.insert(chiefAccessRequests).values({
            inviteId: parsed.inviteId,
            doctorId: parsed.doctorId,
            requestedEmail: parsed.requestedEmail,
            phone: parsed.phone,
            registrationNumber: parsed.registrationNumber,
            selfieUrl: parsed.selfieUrl,
            passwordHash: parsed.passwordHash,
        }).returning();

        await tx
            .update(chiefInvites)
            .set({ usedAt: new Date() })
            .where(eq(chiefInvites.id, invite.id));

        await tx.insert(auditLogs).values({
            actorUserId: null,
            action: "chief_request.submitted",
            entityType: "chief_access_request",
            entityId: created.id,
            details: {
                doctorId: created.doctorId,
                requestedEmail: created.requestedEmail,
            },
        });

        return [created] as const;
    });

    return request;
}

export async function listChiefAccessRequests() {
    const db = getDb();
    const rows = await db.execute(sql`
        select
          car.id,
          car.invite_id,
          car.requested_email,
          car.phone,
          car.registration_number,
          car.selfie_url,
          car.status,
          car.review_notes,
          car.reviewed_at,
          car.created_at,
          d.id as doctor_id,
          d.full_name as doctor_name,
          reviewer.email as reviewer_email,
          approved.email as approved_email
        from chief_access_requests car
        join doctors d
          on d.id = car.doctor_id
        left join users reviewer
          on reviewer.id = car.reviewed_by_user_id
        left join users approved
          on approved.id = car.approved_user_id
        order by car.created_at desc
    `);

    return rows as unknown as Array<{
        id: string;
        invite_id: string;
        requested_email: string;
        phone: string | null;
        registration_number: string | null;
        selfie_url: string;
        status: "pending" | "approved" | "rejected";
        review_notes: string | null;
        reviewed_at: string | null;
        created_at: string;
        doctor_id: string;
        doctor_name: string;
        reviewer_email: string | null;
        approved_email: string | null;
    }>;
}

export async function listChiefAssignments() {
    const db = getDb();
    const rows = await db.execute(sql`
        select
          u.id,
          u.email,
          u.is_active,
                    u.must_change_password,
          d.id as doctor_id,
          d.full_name,
          d.display_name
        from users u
        join user_roles ur
          on ur.user_id = u.id
        left join doctors d
          on d.id = u.doctor_id
        where ur.role = 'chief'
        order by d.full_name asc nulls last, u.email asc
    `);

    return rows as unknown as Array<{
        id: string;
        email: string;
        is_active: boolean;
        must_change_password: boolean;
        doctor_id: string | null;
        full_name: string | null;
        display_name: string | null;
    }>;
}

export async function provisionChiefBootstrapAccess(input: BootstrapChiefAccessInput, actorUserId: string) {
    const db = getDb();
    const parsed = validateChiefBootstrapAccessInput(input);
    const requestedEmail = normalizeEmail(parsed.email);
    const passwordPolicyError = getPasswordPolicyError(parsed.temporaryPassword);

    if (passwordPolicyError) {
        throw new Error(passwordPolicyError);
    }

    const doctor = await db.query.doctors.findFirst({
        where: eq(doctors.id, parsed.doctorId),
    });

    if (!doctor || !doctor.isActive) {
        throw new Error("Medico nao encontrado no diretorio oficial.");
    }

    const passwordHash = await hashPassword(parsed.temporaryPassword);

    return db.transaction(async (tx) => {
        const existingUser = await tx.query.users.findFirst({
            where: eq(users.email, requestedEmail),
        });

        if (existingUser?.doctorId && existingUser.doctorId !== doctor.id) {
            throw new Error("Este email ja esta vinculado a outro medico. Use outro login para a chefia.");
        }

        if (existingUser) {
            const existingRoles = await tx
                .select({ role: userRoles.role })
                .from(userRoles)
                .where(eq(userRoles.userId, existingUser.id));

            if (existingRoles.some((row) => row.role === "admin")) {
                throw new Error("Este email ja pertence a uma conta admin. Use outro login para a chefia.");
            }
        }

        const [user] = existingUser
            ? await tx
                .update(users)
                .set({
                    doctorId: doctor.id,
                    passwordHash,
                    mustChangePassword: true,
                    isActive: true,
                    updatedAt: new Date(),
                })
                .where(eq(users.id, existingUser.id))
                .returning()
            : await tx
                .insert(users)
                .values({
                    doctorId: doctor.id,
                    email: requestedEmail,
                    passwordHash,
                    mustChangePassword: true,
                    isActive: true,
                })
                .returning();

        await tx.insert(userRoles).values({
            userId: user.id,
            role: "chief",
        }).onConflictDoNothing();

        await tx.insert(auditLogs).values({
            actorUserId,
            action: existingUser ? "chief_access.bootstrap_rotated" : "chief_access.bootstrap_created",
            entityType: "user",
            entityId: user.id,
            details: {
                email: requestedEmail,
                doctorId: doctor.id,
                mustChangePassword: true,
            },
        });

        return {
            id: user.id,
            email: user.email,
            isActive: user.isActive,
            mustChangePassword: user.mustChangePassword,
            doctorId: doctor.id,
            fullName: doctor.fullName,
            displayName: doctor.displayName,
            wasExistingUser: Boolean(existingUser),
        };
    });
}

export async function reviewChiefAccessRequest(input: ReviewChiefAccessRequestInput, reviewerUserId: string) {
    const db = getDb();
    const parsed = validateChiefAccessReviewInput(input);
    const request = await db.query.chiefAccessRequests.findFirst({
        where: eq(chiefAccessRequests.id, parsed.requestId),
    });

    if (!request) {
        throw new Error("Chief access request not found.");
    }

    if (request.status !== "pending") {
        throw new Error("Only pending chief access requests can be reviewed.");
    }

    if (parsed.decision === "rejected") {
        const [updated] = await db
            .update(chiefAccessRequests)
            .set({
                status: "rejected",
                reviewedByUserId: reviewerUserId,
                reviewedAt: new Date(),
                reviewNotes: parsed.reviewNotes ?? null,
                updatedAt: new Date(),
            })
            .where(eq(chiefAccessRequests.id, request.id))
            .returning();

        await db.insert(auditLogs).values({
            actorUserId: reviewerUserId,
            action: "chief_request.rejected",
            entityType: "chief_access_request",
            entityId: request.id,
            details: { reviewNotes: parsed.reviewNotes ?? null },
        });

        return updated;
    }

    const [approvedRequest] = await db.transaction(async (tx) => {
        const existingUser = await tx.query.users.findFirst({
            where: eq(users.email, request.requestedEmail),
        });

        const [upsertedUser] = existingUser
            ? await tx
                .update(users)
                .set({
                    doctorId: request.doctorId,
                    passwordHash: request.passwordHash,
                    mustChangePassword: false,
                    isActive: true,
                    updatedAt: new Date(),
                })
                .where(eq(users.id, existingUser.id))
                .returning()
            : await tx.insert(users).values({
                doctorId: request.doctorId,
                email: request.requestedEmail,
                passwordHash: request.passwordHash,
                mustChangePassword: false,
                isActive: true,
            }).returning();

        await tx.insert(userRoles).values({
            userId: upsertedUser.id,
            role: "chief",
        }).onConflictDoNothing();

        const [updatedRequest] = await tx
            .update(chiefAccessRequests)
            .set({
                status: "approved",
                reviewedByUserId: reviewerUserId,
                reviewedAt: new Date(),
                reviewNotes: parsed.reviewNotes ?? null,
                approvedUserId: upsertedUser.id,
                updatedAt: new Date(),
            })
            .where(eq(chiefAccessRequests.id, request.id))
            .returning();

        await tx.insert(auditLogs).values({
            actorUserId: reviewerUserId,
            action: "chief_request.approved",
            entityType: "chief_access_request",
            entityId: request.id,
            details: {
                approvedUserId: upsertedUser.id,
                doctorId: request.doctorId,
                reviewNotes: parsed.reviewNotes ?? null,
            },
        });

        return [updatedRequest] as const;
    });

    return approvedRequest;
}
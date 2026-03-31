import { z } from "zod";

export const createChiefInviteSchema = z.object({
    email: z.string().email().optional(),
    inviteMode: z.enum(["email", "bearer"]),
    expiresAt: z.coerce.date(),
});

export const submitChiefAccessRequestSchema = z.object({
    inviteId: z.string().uuid(),
    doctorId: z.string().uuid(),
    requestedEmail: z.string().email(),
    phone: z.string().trim().min(10).max(30),
    registrationNumber: z.string().trim().min(1).max(100),
    selfieUrl: z.string().trim().min(1),
    passwordHash: z.string().trim().min(1),
});

export const reviewChiefAccessRequestSchema = z.object({
    requestId: z.string().uuid(),
    decision: z.enum(["approved", "rejected"]),
    reviewNotes: z.string().trim().max(1000).optional(),
});

export const bootstrapChiefAccessSchema = z.object({
    doctorId: z.string().uuid(),
    email: z.string().email(),
    temporaryPassword: z.string().trim().min(1),
});

export type CreateChiefInviteInput = z.infer<typeof createChiefInviteSchema>;
export type SubmitChiefAccessRequestInput = z.infer<typeof submitChiefAccessRequestSchema>;
export type ReviewChiefAccessRequestInput = z.infer<typeof reviewChiefAccessRequestSchema>;
export type BootstrapChiefAccessInput = z.infer<typeof bootstrapChiefAccessSchema>;

export function validateChiefInviteInput(input: unknown) {
    return createChiefInviteSchema.parse(input);
}

export function validateChiefAccessRequestInput(input: unknown) {
    return submitChiefAccessRequestSchema.parse(input);
}

export function validateChiefAccessReviewInput(input: unknown) {
    return reviewChiefAccessRequestSchema.parse(input);
}

export function validateChiefBootstrapAccessInput(input: unknown) {
    return bootstrapChiefAccessSchema.parse(input);
}

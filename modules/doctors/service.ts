import { eq } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "@/db";
import { auditLogs, doctors } from "@/db/schema";
import { normalizeDoctorName } from "@/modules/doctors/importer";

const doctorDirectoryInputSchema = z.object({
    fullName: z.string().trim().min(3).max(255),
    displayName: z.string().trim().max(255).optional(),
    externalCode: z.string().trim().max(64).optional(),
});

export interface DoctorDirectoryAuditContext {
    actorUserId?: string | null;
    source?: string;
    details?: Record<string, unknown>;
}

export function validateDoctorDirectoryInput(input: unknown) {
    const parsed = doctorDirectoryInputSchema.parse(input);
    const fullName = parsed.fullName.trim();
    const normalizedName = normalizeDoctorName(fullName);

    if (!normalizedName) {
        throw new Error("Nome completo do medico invalido.");
    }

    return {
        fullName,
        displayName: parsed.displayName?.trim() || null,
        externalCode: parsed.externalCode?.trim() || null,
        normalizedName,
    };
}

export async function createDoctorDirectoryEntry(input: unknown, auditContext: DoctorDirectoryAuditContext = {}) {
    const db = getDb();
    const parsed = validateDoctorDirectoryInput(input);
    const existing = await db.query.doctors.findFirst({
        where: eq(doctors.normalizedName, parsed.normalizedName),
    });

    if (existing?.isActive) {
        return {
            status: "already_exists" as const,
            doctor: existing,
        };
    }

    return db.transaction(async (tx) => {
        const now = new Date();
        const action = existing ? "doctor.reactivated" : "doctor.created";

        const [doctor] = existing
            ? await tx
                .update(doctors)
                .set({
                    fullName: parsed.fullName,
                    displayName: parsed.displayName,
                    externalCode: parsed.externalCode,
                    normalizedName: parsed.normalizedName,
                    isActive: true,
                    updatedAt: now,
                })
                .where(eq(doctors.id, existing.id))
                .returning()
            : await tx
                .insert(doctors)
                .values({
                    fullName: parsed.fullName,
                    displayName: parsed.displayName,
                    externalCode: parsed.externalCode,
                    normalizedName: parsed.normalizedName,
                    isActive: true,
                    metadata: {},
                    updatedAt: now,
                })
                .returning();

        await tx.insert(auditLogs).values({
            actorUserId: auditContext.actorUserId ?? null,
            action,
            entityType: "doctor",
            entityId: doctor.id,
            details: {
                source: auditContext.source ?? "manual",
                fullName: doctor.fullName,
                displayName: doctor.displayName,
                externalCode: doctor.externalCode,
                normalizedName: doctor.normalizedName,
                ...auditContext.details,
            },
        });

        return {
            status: existing ? "reactivated" as const : "created" as const,
            doctor,
        };
    });
}
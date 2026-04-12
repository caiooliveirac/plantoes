import { and, eq, ne } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "@/db";
import { auditLogs, doctors } from "@/db/schema";
import { extractDoctorAliases, listDoctorSearchTerms, mergeDoctorMetadataAliases, parseDoctorAliasesInput } from "@/modules/doctors/directory";
import { normalizeDoctorName } from "@/modules/doctors/importer";

const doctorAliasesSchema = z.union([
    z.string(),
    z.array(z.string().trim().max(255)),
]);

const doctorDirectoryInputSchema = z.object({
    fullName: z.string().trim().min(3).max(255),
    displayName: z.string().trim().max(255).optional(),
    externalCode: z.string().trim().max(64).optional(),
    aliases: doctorAliasesSchema.optional(),
});

const doctorDirectoryUpdateSchema = z.object({
    lookup: z.string().trim().min(2).max(255),
    fullName: z.string().trim().min(3).max(255),
    displayName: z.string().trim().max(255).nullable().optional(),
    externalCode: z.string().trim().max(64).nullable().optional(),
    aliases: doctorAliasesSchema.optional(),
    hasDisplayName: z.boolean().optional(),
    hasExternalCode: z.boolean().optional(),
    hasAliases: z.boolean().optional(),
});

export interface DoctorDirectoryAuditContext {
    actorUserId?: string | null;
    source?: string;
    details?: Record<string, unknown>;
}

function normalizeDirectoryEntry(parsed: z.infer<typeof doctorDirectoryInputSchema>) {
    const fullName = parsed.fullName.trim();
    const normalizedName = normalizeDoctorName(fullName);

    if (!normalizedName) {
        throw new Error("Nome completo do medico invalido.");
    }

    const displayName = parsed.displayName?.trim() || null;
    const aliases = parseDoctorAliasesInput(parsed.aliases);
    const normalizedDisplayName = displayName ? normalizeDoctorName(displayName) : "";

    return {
        fullName,
        displayName,
        externalCode: parsed.externalCode?.trim() || null,
        aliases: aliases.filter((alias) => {
            const normalizedAlias = normalizeDoctorName(alias);
            return normalizedAlias !== normalizedName && normalizedAlias !== normalizedDisplayName;
        }),
        normalizedName,
    };
}

function buildDoctorDirectoryReplySummary(doctor: {
    id: string;
    fullName: string;
    displayName: string | null;
    externalCode: string | null;
    metadata: unknown;
    isActive: boolean;
}) {
    return {
        id: doctor.id,
        fullName: doctor.fullName,
        displayName: doctor.displayName,
        externalCode: doctor.externalCode,
        aliases: extractDoctorAliases(doctor.metadata),
        isActive: doctor.isActive,
    };
}

function matchesDoctorLookup(lookup: string, doctor: {
    fullName: string;
    displayName: string | null;
    externalCode: string | null;
    metadata: unknown;
}) {
    const trimmedLookup = lookup.trim();
    const normalizedLookup = normalizeDoctorName(trimmedLookup);
    if (!normalizedLookup) {
        return false;
    }

    if (doctor.externalCode && doctor.externalCode.trim().toLowerCase() === trimmedLookup.toLowerCase()) {
        return true;
    }

    return listDoctorSearchTerms(doctor).some((term) => normalizeDoctorName(term) === normalizedLookup);
}

async function findDoctorsByLookup(lookup: string) {
    const db = getDb();
    const directory = await db.query.doctors.findMany();

    return directory
        .filter((doctor) => matchesDoctorLookup(lookup, doctor))
        .sort((left, right) => {
            const activeDiff = Number(right.isActive) - Number(left.isActive);
            if (activeDiff !== 0) {
                return activeDiff;
            }

            return left.fullName.localeCompare(right.fullName, "pt-BR");
        });
}

export function validateDoctorDirectoryInput(input: unknown) {
    return normalizeDirectoryEntry(doctorDirectoryInputSchema.parse(input));
}

export function validateDoctorDirectoryUpdateInput(input: unknown) {
    const parsed = doctorDirectoryUpdateSchema.parse(input);
    const normalized = normalizeDirectoryEntry({
        fullName: parsed.fullName,
        displayName: parsed.hasDisplayName ? parsed.displayName ?? undefined : undefined,
        externalCode: parsed.hasExternalCode ? parsed.externalCode ?? undefined : undefined,
        aliases: parsed.hasAliases ? parsed.aliases : undefined,
    });

    return {
        lookup: parsed.lookup.trim(),
        fullName: normalized.fullName,
        normalizedName: normalized.normalizedName,
        displayName: parsed.hasDisplayName ? normalized.displayName : undefined,
        externalCode: parsed.hasExternalCode ? normalized.externalCode : undefined,
        aliases: parsed.hasAliases ? normalized.aliases : undefined,
        hasDisplayName: Boolean(parsed.hasDisplayName),
        hasExternalCode: Boolean(parsed.hasExternalCode),
        hasAliases: Boolean(parsed.hasAliases),
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
                    metadata: mergeDoctorMetadataAliases(existing.metadata, parsed.aliases),
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
                    metadata: mergeDoctorMetadataAliases({}, parsed.aliases),
                    updatedAt: now,
                })
                .returning();

        const replyDoctor = buildDoctorDirectoryReplySummary(doctor);

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
                aliases: replyDoctor.aliases,
                ...auditContext.details,
            },
        });

        return {
            status: existing ? "reactivated" as const : "created" as const,
            doctor,
        };
    });
}

export async function updateDoctorDirectoryEntry(input: unknown, auditContext: DoctorDirectoryAuditContext = {}) {
    const db = getDb();
    const parsed = validateDoctorDirectoryUpdateInput(input);
    const matches = await findDoctorsByLookup(parsed.lookup);

    if (matches.length === 0) {
        return {
            status: "not_found" as const,
            matches: [] as Array<ReturnType<typeof buildDoctorDirectoryReplySummary>>,
        };
    }

    if (matches.length > 1) {
        return {
            status: "ambiguous" as const,
            matches: matches.slice(0, 5).map(buildDoctorDirectoryReplySummary),
        };
    }

    const target = matches[0];
    const conflictingDoctor = await db.query.doctors.findFirst({
        where: and(
            eq(doctors.normalizedName, parsed.normalizedName),
            ne(doctors.id, target.id),
        ),
    });

    if (conflictingDoctor?.isActive) {
        throw new Error(`Ja existe outro medico ativo com o nome ${conflictingDoctor.fullName}.`);
    }

    return db.transaction(async (tx) => {
        const now = new Date();
        const previousDoctor = buildDoctorDirectoryReplySummary(target);
        const [doctor] = await tx
            .update(doctors)
            .set({
                fullName: parsed.fullName,
                normalizedName: parsed.normalizedName,
                displayName: parsed.hasDisplayName ? parsed.displayName ?? null : target.displayName,
                externalCode: parsed.hasExternalCode ? parsed.externalCode ?? null : target.externalCode,
                metadata: parsed.hasAliases
                    ? mergeDoctorMetadataAliases(target.metadata, parsed.aliases ?? [])
                    : target.metadata,
                isActive: true,
                updatedAt: now,
            })
            .where(eq(doctors.id, target.id))
            .returning();

        const nextDoctor = buildDoctorDirectoryReplySummary(doctor);

        await tx.insert(auditLogs).values({
            actorUserId: auditContext.actorUserId ?? null,
            action: target.isActive ? "doctor.updated" : "doctor.reactivated_and_updated",
            entityType: "doctor",
            entityId: doctor.id,
            details: {
                source: auditContext.source ?? "manual",
                lookup: parsed.lookup,
                previous: previousDoctor,
                next: nextDoctor,
                ...auditContext.details,
            },
        });

        return {
            status: target.isActive ? "updated" as const : "reactivated_and_updated" as const,
            doctor,
        };
    });
}
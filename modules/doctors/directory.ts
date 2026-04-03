import { normalizeDoctorName } from "@/modules/doctors/importer";
import { normalizeOperationalRoleLabel } from "@/modules/operational/roles";

const DOCTOR_METADATA_PREFERRED_ROLE_KEY = "preferredOperationalRole";

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function parseDoctorAliasesInput(input: string | string[] | null | undefined) {
    const rawValues = Array.isArray(input)
        ? input
        : typeof input === "string"
            ? input.split(/[;,\n]/)
            : [];

    const aliases: string[] = [];
    const seen = new Set<string>();

    for (const rawValue of rawValues) {
        const alias = rawValue.trim();
        const normalizedAlias = normalizeDoctorName(alias);
        if (!normalizedAlias || seen.has(normalizedAlias)) {
            continue;
        }

        seen.add(normalizedAlias);
        aliases.push(alias);
    }

    return aliases;
}

export function extractDoctorAliases(metadata: unknown) {
    if (!isPlainObject(metadata)) {
        return [] as string[];
    }

    return parseDoctorAliasesInput(metadata.aliases as string | string[] | null | undefined);
}

export function mergeDoctorMetadataAliases(metadata: unknown, aliases: string[]) {
    return mergeDoctorDirectoryMetadata(metadata, { aliases });
}

export function extractDoctorPreferredOperationalRole(metadata: unknown) {
    if (!isPlainObject(metadata)) {
        return null;
    }

    return normalizeOperationalRoleLabel(metadata[DOCTOR_METADATA_PREFERRED_ROLE_KEY] as string | null | undefined);
}

export function mergeDoctorDirectoryMetadata(
    metadata: unknown,
    params: {
        aliases?: string[];
        preferredOperationalRole?: string | null;
    },
) {
    const nextMetadata = isPlainObject(metadata) ? { ...metadata } : {};

    if (params.aliases && params.aliases.length > 0) {
        nextMetadata.aliases = params.aliases;
    } else if (params.aliases) {
        delete nextMetadata.aliases;
    }

    const preferredOperationalRole = normalizeOperationalRoleLabel(params.preferredOperationalRole);
    if (preferredOperationalRole) {
        nextMetadata[DOCTOR_METADATA_PREFERRED_ROLE_KEY] = preferredOperationalRole;
    } else if (params.preferredOperationalRole !== undefined) {
        delete nextMetadata[DOCTOR_METADATA_PREFERRED_ROLE_KEY];
    }

    return nextMetadata;
}

export function formatDoctorSurfaceName(params: {
    fullName?: string | null;
    displayName?: string | null;
    fallback?: string;
}) {
    return params.displayName?.trim() || params.fullName?.trim() || params.fallback || "medico nao identificado";
}

export function formatDoctorBackofficeName(params: {
    fullName?: string | null;
    displayName?: string | null;
    fallback?: string;
}) {
    return params.fullName?.trim() || params.displayName?.trim() || params.fallback || "medico nao identificado";
}

export function listDoctorSearchTerms(doctor: {
    fullName: string;
    displayName?: string | null;
    metadata?: unknown;
    aliases?: readonly string[] | null;
}) {
    const aliases = doctor.aliases ? [...doctor.aliases] : extractDoctorAliases(doctor.metadata);
    const terms = [doctor.fullName, doctor.displayName ?? "", ...aliases]
        .map((value) => value.trim())
        .filter(Boolean);

    const uniqueTerms: string[] = [];
    const seen = new Set<string>();

    for (const term of terms) {
        const normalizedTerm = normalizeDoctorName(term);
        if (!normalizedTerm || seen.has(normalizedTerm)) {
            continue;
        }

        seen.add(normalizedTerm);
        uniqueTerms.push(term);
    }

    return uniqueTerms;
}
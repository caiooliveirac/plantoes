export const STANDARD_OPERATIONAL_ROLE_CODES = ["CP", "MRV", "RECIP", "COI", "IES", "RMT", "PSIQ", "PIAM"] as const;

export type StandardOperationalRoleCode = (typeof STANDARD_OPERATIONAL_ROLE_CODES)[number];

const COI_REGULATION_CODES = new Set(["1367", "1368"]);
const RMT_DEFAULT_REGULATION_CODES = new Set(["1366"]);
const MRV_REGULATION_CODES = new Set(["2032", "2151"]);
const REMOTE_PRIORITY_REGULATION_CODES = new Set(["1321", "1322", "1323", "1325", "1361", "1362", "1363", "1364", "1365"]);

export function normalizeOperationalRoleLabel(value: string | null | undefined) {
    const normalized = value?.trim().toUpperCase() ?? "";
    return normalized.length > 0 ? normalized : null;
}

export function applyOperationalRoleShiftPolicy(params: {
    shiftLabel: "SD" | "SN" | "P" | null;
    roleLabel: string | null | undefined;
}) {
    const normalizedRole = normalizeOperationalRoleLabel(params.roleLabel);
    if (normalizedRole === "MRV" && params.shiftLabel === "SN") {
        return null;
    }

    return normalizedRole;
}

export function isRemotePriorityRegulationCode(code: string) {
    return REMOTE_PRIORITY_REGULATION_CODES.has(code.trim().toUpperCase());
}

export function isStandardOperationalRoleCode(value: string | null | undefined): value is StandardOperationalRoleCode {
    return STANDARD_OPERATIONAL_ROLE_CODES.includes((value ?? "") as StandardOperationalRoleCode);
}

export function resolveFixedOperationalRole(params: {
    domain: "regulation" | "intervention";
    code: string;
    shiftLabel: "SD" | "SN" | "P" | null;
}) {
    if (params.domain === "regulation" && params.code === "2031") {
        return "CP";
    }

    if (params.domain === "regulation" && COI_REGULATION_CODES.has(params.code)) {
        return "COI";
    }

    if (params.domain === "regulation" && params.shiftLabel !== "SN" && MRV_REGULATION_CODES.has(params.code)) {
        return "MRV";
    }

    return null;
}

export function resolveOperationalRoleLabel(params: {
    domain: "regulation" | "intervention";
    code: string;
    shiftLabel: "SD" | "SN" | "P" | null;
    roleLabel?: string | null;
    defaultRole?: string | null;
}) {
    const explicitRole = applyOperationalRoleShiftPolicy({
        shiftLabel: params.shiftLabel,
        roleLabel: params.roleLabel,
    });

    // Meio plantao precisa prevalecer mesmo em ramais com papel fixo (ex.: 2032/2151 MRV, 1367/1368 COI).
    if (explicitRole === "MEIO_PLANTAO") {
        return explicitRole;
    }

    const defaultRole = applyOperationalRoleShiftPolicy({
        shiftLabel: params.shiftLabel,
        roleLabel: params.defaultRole,
    });
    const codeDefault = params.domain === "regulation" && RMT_DEFAULT_REGULATION_CODES.has(params.code)
        ? "RMT"
        : null;
    const resolved = resolveFixedOperationalRole(params)
        ?? explicitRole
        ?? defaultRole
        ?? codeDefault
        ?? null;

    if (resolved === "MRV" && params.shiftLabel === "SN") {
        return null;
    }

    // "MR" (médico regulador) é o papel genérico padrão: não é função especial,
    // então normalizamos para null para não vazar como rótulo nem ganhar tratamento de papel.
    if (resolved === "MR") {
        return null;
    }

    return resolved;
}

export function isRemoteOperationalRole(roleLabel: string | null | undefined) {
    return normalizeOperationalRoleLabel(roleLabel) === "RMT";
}

export function buildOperationalRoleChoices(values: Array<string | null | undefined>) {
    const normalizedValues = values
        .map((value) => normalizeOperationalRoleLabel(value))
        .filter((value): value is string => Boolean(value));
    const extraValues = normalizedValues.filter((value) => !isStandardOperationalRoleCode(value));

    return [...new Set([...normalizedValues, ...STANDARD_OPERATIONAL_ROLE_CODES, ...extraValues])];
}

export function getOperationalRoleTone(roleLabel: string | null | undefined) {
    const normalized = normalizeOperationalRoleLabel(roleLabel);
    if (normalized === "MRV") {
        return "mrv" as const;
    }
    if (normalized === "RECIP") {
        return "recip" as const;
    }
    if (normalized === "COI") {
        return "coi" as const;
    }
    if (normalized === "CP") {
        return "cp" as const;
    }
    if (normalized === "IES") {
        return "ies" as const;
    }
    if (normalized === "RMT") {
        return "rmt" as const;
    }
    if (normalized === "PSIQ") {
        return "psiq" as const;
    }
    if (normalized === "PIAM") {
        return "piam" as const;
    }

    return "neutral" as const;
}
export const STANDARD_OPERATIONAL_ROLE_CODES = ["CP", "MRV", "RECIP", "COI", "IES", "RMT", "PSIQ", "PIAM"] as const;
export const OPERATIONAL_ROLE_REMOVED_SENTINEL = "SEM_FUNCAO";

export type StandardOperationalRoleCode = (typeof STANDARD_OPERATIONAL_ROLE_CODES)[number];

const COI_REGULATION_CODES = new Set(["2262", "2263"]);
const RMT_DEFAULT_REGULATION_CODES = new Set(["1366"]);
const DAY_MRV_BASAL_REGULATION_CODES = new Set(["2032", "2151"]);
const REMOTE_PRIORITY_REGULATION_CODES = new Set(["1321", "1322", "1323", "1325", "1361", "1362", "1363", "1364", "1365"]);

export function normalizeOperationalRoleLabel(value: string | null | undefined) {
    const normalized = value?.trim().toUpperCase() ?? "";
    return normalized.length > 0 ? normalized : null;
}

export function isOperationalRoleRemovalSentinel(value: string | null | undefined) {
    return normalizeOperationalRoleLabel(value) === OPERATIONAL_ROLE_REMOVED_SENTINEL;
}

export function resolveRoleLabelForExplicitRemoval(value: string | null | undefined) {
    return value ?? OPERATIONAL_ROLE_REMOVED_SENTINEL;
}

export function applyOperationalRoleShiftPolicy(params: {
    shiftLabel: "SD" | "SN" | "P" | null;
    roleLabel: string | null | undefined;
}) {
    const normalizedRole = normalizeOperationalRoleLabel(params.roleLabel);
    if (normalizedRole === OPERATIONAL_ROLE_REMOVED_SENTINEL) {
        return OPERATIONAL_ROLE_REMOVED_SENTINEL;
    }
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

/**
 * Ramal da chefia de plantão. Diferente das outras PAs, o chefe só sai quando o
 * substituto chega — e o substituto frequentemente esquece de avisar. Por isso a
 * chegada aqui não se autoedita (só admin) e a saída do antecessor é perguntada
 * de forma obrigatória, nunca deixada na fila comum. Ver
 * modules/operational/chief-arrival-guard.ts.
 */
export const CHIEF_REGULATION_POST_CODE = "2031";

export function isChiefRegulationPostCode(code: string | null | undefined) {
    return (code ?? "").trim().toUpperCase() === CHIEF_REGULATION_POST_CODE;
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

    return null;
}

// Papeis que cobrem remotamente (nao presencial) e por isso saem da fila de
// refeicao presencial. Mantido alinhado com isPresentialRole em meal-breaks.ts.
const REMOTE_MEAL_COVERAGE_ROLES = new Set(["COI", "RMT", "IES"]);

// Descreve o impacto de remanejar um medico para um ramal de papel fixo
// (ex.: 2262/2263 -> COI, 2031 -> CP). Retorna null quando o destino nao forca
// papel ou quando o papel forcado e o mesmo que o medico ja tem — nesses casos
// nao ha surpresa a sinalizar. Helper puro para alimentar o aviso da UI e testes.
export function describeFixedRoleTransferImpact(params: {
    targetDomain: "regulation" | "intervention";
    targetCode: string;
    shiftLabel: "SD" | "SN" | "P" | null;
    currentRole: string | null | undefined;
}): { forcedRole: string; leavesPresentialMealQueue: boolean } | null {
    const forcedRole = resolveFixedOperationalRole({
        domain: params.targetDomain,
        code: params.targetCode,
        shiftLabel: params.shiftLabel,
    });
    if (!forcedRole) {
        return null;
    }

    if (normalizeOperationalRoleLabel(params.currentRole) === forcedRole) {
        return null;
    }

    return {
        forcedRole,
        leavesPresentialMealQueue: REMOTE_MEAL_COVERAGE_ROLES.has(forcedRole),
    };
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

    if (explicitRole === OPERATIONAL_ROLE_REMOVED_SENTINEL) {
        return null;
    }

    // Meio plantao precisa prevalecer mesmo em ramais com papel fixo (ex.: 2262/2263 COI).
    if (explicitRole === "MEIO_PLANTAO") {
        return explicitRole;
    }

    const defaultRole = applyOperationalRoleShiftPolicy({
        shiftLabel: params.shiftLabel,
        roleLabel: params.defaultRole,
    });
    const basalDayRole = params.domain === "regulation"
        && params.shiftLabel === "SD"
        && DAY_MRV_BASAL_REGULATION_CODES.has(params.code)
        ? "MRV"
        : null;
    const codeDefault = params.domain === "regulation" && RMT_DEFAULT_REGULATION_CODES.has(params.code)
        ? "RMT"
        : null;
    const resolved = resolveFixedOperationalRole(params)
        ?? explicitRole
        ?? basalDayRole
        ?? defaultRole
        ?? codeDefault
        ?? null;

    if (resolved === "MRV" && params.shiftLabel === "SN") {
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
        .filter((value): value is string => Boolean(value) && value !== OPERATIONAL_ROLE_REMOVED_SENTINEL);
    const extraValues = normalizedValues.filter((value) => !isStandardOperationalRoleCode(value));

    return [...new Set([...normalizedValues, ...STANDARD_OPERATIONAL_ROLE_CODES, ...extraValues])];
}

export function dedupeOperationalIdentityLabels(values: Array<string | null | undefined>) {
    const labels: string[] = [];
    const seen = new Set<string>();

    for (const value of values) {
        const normalized = normalizeOperationalRoleLabel(value);
        if (!normalized || seen.has(normalized)) {
            continue;
        }
        seen.add(normalized);
        labels.push(normalized);
    }

    return labels;
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
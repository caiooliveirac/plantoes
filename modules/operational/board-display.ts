function normalizeOperationalCode(value: string) {
    return value.trim().toUpperCase();
}

function extractNumericPortion(value: string) {
    const match = normalizeOperationalCode(value).match(/(\d+)/);
    return match ? Number(match[1]) : Number.NaN;
}

export function isNucleoRegulationPost(code: string) {
    return normalizeOperationalCode(code) === "NUCLEO";
}

export function isPiamRegulationPost(code: string) {
    return normalizeOperationalCode(code) === "PIAM";
}

export function resolvePendingRegulationOccupantLabel(code: string) {
    if (isNucleoRegulationPost(code)) {
        return "REMANEJADO PARA CRU";
    }

    return "Aguardando confirmação";
}

export function shouldShowRegulationCardOnRootBoard(params: {
    postCode: string;
    status: "active" | "waiting" | "disabled";
    doctorId: string | null;
    shiftLabel: string;
}) {
    if (params.status === "disabled") {
        return true;
    }

    if (isNucleoRegulationPost(params.postCode) && params.shiftLabel !== "SD") {
        return false;
    }

    if (params.status === "active" && Boolean(params.doctorId)) {
        return true;
    }

    if (params.status !== "waiting") {
        return false;
    }

    return isPiamRegulationPost(params.postCode) || isNucleoRegulationPost(params.postCode);
}

// Ordem: CP(0) → MRV(1) → RECIP(2) → PSIQ(3) → normais "2"(4) → COI/"1"(5) → outros(6) → NUCLEO(98) → PIAM(99)
// Quando roleLabel é fornecido, a ordenação usa o papel real da ocupação (que pode divergir do ramal
// padrão — ex.: chefe/bot mudam MRV para um ramal diferente de 2032/2151, ou 2032 recebe RECIP).
// Quando roleLabel é undefined (chamadas sem contexto de papel, ex.: testes com código puro),
// aplica-se o fallback por código para manter compatibilidade.
function regulationSortBucket(code: string, shiftLabel: string, roleLabel?: string | null) {
    const normalized = normalizeOperationalCode(code);
    const role = roleLabel !== undefined ? (roleLabel?.trim().toUpperCase() ?? null) : undefined;

    if (normalized === "2031" || role === "CP") return 0;
    if (isNucleoRegulationPost(normalized)) return 98;
    if (isPiamRegulationPost(normalized)) return 99;

    if (role !== undefined) {
        if (role === "MRV") return 1;
        if (role === "RECIP") return 2;
        if (role === "PSIQ") return 3;
        if (role === "COI") return 5;
        // Papel nulo em ramais MRV canônicos: trata como MRV (comportamento base)
        if (role === null && shiftLabel !== "SN" && (normalized === "2151" || normalized === "2032")) return 1;
        if (normalized.startsWith("1")) return 5;
        if (normalized.startsWith("2")) return 4;
        return 6;
    }

    // Fallback por código (sem contexto de papel — compatibilidade com testes e uso legado)
    if (shiftLabel !== "SN" && normalized === "2151") return 1;
    if (shiftLabel !== "SN" && normalized === "2032") return 2;
    if (normalized.startsWith("1")) return 5;
    if (normalized.startsWith("2")) return 4;
    return 6;
}

type SortKey = string | { code: string; roleLabel?: string | null };

function extractSortKey(v: SortKey): { code: string; roleLabel?: string | null } {
    return typeof v === "string" ? { code: v } : v;
}

export function compareRootBoardRegulationCodes(left: SortKey, right: SortKey, shiftLabel: string) {
    const lk = extractSortKey(left);
    const rk = extractSortKey(right);
    const normalizedLeft = normalizeOperationalCode(lk.code);
    const normalizedRight = normalizeOperationalCode(rk.code);
    const bucketDiff = regulationSortBucket(normalizedLeft, shiftLabel, lk.roleLabel)
        - regulationSortBucket(normalizedRight, shiftLabel, rk.roleLabel);

    if (bucketDiff !== 0) {
        return bucketDiff;
    }

    const leftNumeric = extractNumericPortion(normalizedLeft);
    const rightNumeric = extractNumericPortion(normalizedRight);
    const hasLeftNumeric = Number.isFinite(leftNumeric);
    const hasRightNumeric = Number.isFinite(rightNumeric);

    if (hasLeftNumeric && hasRightNumeric && leftNumeric !== rightNumeric) {
        return leftNumeric - rightNumeric;
    }

    if (hasLeftNumeric !== hasRightNumeric) {
        return hasLeftNumeric ? -1 : 1;
    }

    return normalizedLeft.localeCompare(normalizedRight, "pt-BR", { numeric: true });
}
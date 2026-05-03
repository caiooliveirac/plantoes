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

function regulationSortBucket(code: string, shiftLabel: string) {
    const normalized = normalizeOperationalCode(code);

    if (normalized === "2031") {
        return 0;
    }

    if (shiftLabel !== "SN" && normalized === "2151") {
        return 1;
    }

    if (shiftLabel !== "SN" && normalized === "2032") {
        return 2;
    }

    if (isNucleoRegulationPost(normalized)) {
        return 98;
    }

    if (isPiamRegulationPost(normalized)) {
        return 99;
    }

    if (normalized.startsWith("1")) {
        return 4;
    }

    if (normalized.startsWith("2")) {
        return 3;
    }

    return 5;
}

export function compareRootBoardRegulationCodes(left: string, right: string, shiftLabel: string) {
    const normalizedLeft = normalizeOperationalCode(left);
    const normalizedRight = normalizeOperationalCode(right);
    const bucketDiff = regulationSortBucket(normalizedLeft, shiftLabel) - regulationSortBucket(normalizedRight, shiftLabel);

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
const INTERVENTION_PRESENTATION_ORDER = [
    "SM01",
    "CB02",
    "PR03",
    "PM04",
    "BR05",
    "CN10",
    "PP20",
    "IT30",
    "PM40",
    "CZ50",
    "BR60",
    "CC70",
    "GOA",
] as const;

const interventionOrderIndex = new Map<string, number>(
    INTERVENTION_PRESENTATION_ORDER.map((code, index) => [code, index]),
);

function normalizeCode(value: string) {
    return value.trim().toUpperCase();
}

function extractNumericPortion(value: string) {
    const match = normalizeCode(value).match(/(\d+)/);
    return match ? Number(match[1]) : Number.POSITIVE_INFINITY;
}

export function compareTelegramInterventionCodes(left: string, right: string) {
    const normalizedLeft = normalizeCode(left);
    const normalizedRight = normalizeCode(right);
    const leftIndex = interventionOrderIndex.get(normalizedLeft);
    const rightIndex = interventionOrderIndex.get(normalizedRight);

    if (leftIndex !== undefined || rightIndex !== undefined) {
        if (leftIndex === undefined) {
            return 1;
        }
        if (rightIndex === undefined) {
            return -1;
        }
        if (leftIndex !== rightIndex) {
            return leftIndex - rightIndex;
        }
    }

    const numericDiff = extractNumericPortion(normalizedLeft) - extractNumericPortion(normalizedRight);
    if (numericDiff !== 0) {
        return numericDiff;
    }

    return normalizedLeft.localeCompare(normalizedRight, "pt-BR", { numeric: true });
}

function resolveRegulationOrderBucket(value: string) {
    const normalized = normalizeCode(value);
    if (normalized === "2031") {
        return 0;
    }
    if (normalized.startsWith("2")) {
        return 1;
    }
    if (normalized.startsWith("1")) {
        return 2;
    }
    // PIAM precisa vir antes de NUCLEO (nunca apresentar NUCLEO → PIAM nessa ordem).
    if (normalized === "PIAM") {
        return 3;
    }
    if (normalized === "NUCLEO") {
        return 4;
    }
    return 5;
}

export function compareTelegramRegulationCodes(left: string, right: string) {
    const normalizedLeft = normalizeCode(left);
    const normalizedRight = normalizeCode(right);
    const bucketDiff = resolveRegulationOrderBucket(normalizedLeft) - resolveRegulationOrderBucket(normalizedRight);
    if (bucketDiff !== 0) {
        return bucketDiff;
    }

    const numericDiff = extractNumericPortion(normalizedLeft) - extractNumericPortion(normalizedRight);
    if (numericDiff !== 0) {
        return numericDiff;
    }

    return normalizedLeft.localeCompare(normalizedRight, "pt-BR", { numeric: true });
}

function sortRowsByCode<T>(rows: T[], readCode: (row: T) => string, compare: (left: string, right: string) => number) {
    return [...rows].sort((left, right) => compare(readCode(left), readCode(right)));
}

export function sortTelegramInterventionRows<T extends { baseCode: string }>(rows: T[]) {
    return sortRowsByCode(rows, (row) => row.baseCode, compareTelegramInterventionCodes);
}

export function sortTelegramRegulationRows<T extends { postCode: string }>(rows: T[]) {
    return sortRowsByCode(rows, (row) => row.postCode, compareTelegramRegulationCodes);
}

export function sortTelegramInterventionTargetRows<T extends { targetCode: string }>(rows: T[]) {
    return sortRowsByCode(rows, (row) => row.targetCode, compareTelegramInterventionCodes);
}

export function sortTelegramRegulationTargetRows<T extends { targetCode: string }>(rows: T[]) {
    return sortRowsByCode(rows, (row) => row.targetCode, compareTelegramRegulationCodes);
}

export function sortTelegramInterventionCodes(values: string[]) {
    return [...values].sort(compareTelegramInterventionCodes);
}

export function sortTelegramRegulationCodes(values: string[]) {
    return [...values].sort(compareTelegramRegulationCodes);
}
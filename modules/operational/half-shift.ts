export const HALF_SHIFT_ROLE_LABEL = "MEIO_PLANTAO";
export const HALF_SHIFT_DISPLAY_LABEL = "Meio Plantao";
export const HALF_SHIFT_TAG_LABEL = "MEIO";

export function isHalfShiftRoleLabel(value: string | null | undefined) {
    if (!value) {
        return false;
    }

    const normalized = value
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .toUpperCase()
        .trim();

    return normalized === HALF_SHIFT_ROLE_LABEL
        || normalized === "MEIO PLANTAO"
        || normalized === "MEIO_PLANTAO_TARDE"
        || normalized === "MEIO"
        || normalized.includes("MEIO PLANTAO");
}

export function resolvePaymentUnitFromRole(roleLabel: string | null | undefined) {
    return isHalfShiftRoleLabel(roleLabel) ? 0.5 : 1;
}
import { resolveForcedDayEventTime } from "@/modules/operational/rules";

export const HALF_SHIFT_ROLE_LABEL = "MEIO_PLANTAO";
export const HALF_SHIFT_DISPLAY_LABEL = "Meio Plantao";
export const HALF_SHIFT_TAG_LABEL = "MEIO";

// Janela canônica do meio plantão da tarde, no relógio local de Salvador.
// Início esperado 11:30 (piso do banco de horas: chegar antes não credita,
// chegar depois da tolerância de 15 min debita) e saída 17:00.
// Fonte única: o bot usa na chegada e as correções usam quando a chefia
// TROCA a função para/de meio plantão no quadro.
export const HALF_SHIFT_EXPECTED_START_HHMM = "11:30";
export const HALF_SHIFT_AUTO_END_HHMM = "17:00";

// Janela em que um aviso de meio plantão é honrado como meia jornada — pela
// hora declarada, ou, na ausência dela, pela hora da própria mensagem.
// 11:10 (inclusive) até 17:00 (exclusive). Antes das 11:10 é chegada atrasada
// de plantão INTEIRO, não meio plantão: quem chega 10:38 devia estar às 07:00
// e o débito é dele (caso Vanessa Brito, jul/2026).
export const HALF_SHIFT_WINDOW_START_MINUTE = (11 * 60) + 10;
export const HALF_SHIFT_WINDOW_END_MINUTE = 17 * 60;

export function isWithinHalfShiftWindow(minuteOfDay: number) {
    return minuteOfDay >= HALF_SHIFT_WINDOW_START_MINUTE
        && minuteOfDay < HALF_SHIFT_WINDOW_END_MINUTE;
}

/** Janela agendada (scheduled_start_at / scheduled_end_at) de um meio plantão
 *  ancorado no dia operacional de `referenceAt`. */
export function resolveHalfShiftScheduledWindow(referenceAt: Date) {
    return {
        scheduledStartAt: resolveForcedDayEventTime(referenceAt, HALF_SHIFT_EXPECTED_START_HHMM, 0),
        scheduledEndAt: resolveForcedDayEventTime(referenceAt, HALF_SHIFT_AUTO_END_HHMM, 0),
    };
}

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
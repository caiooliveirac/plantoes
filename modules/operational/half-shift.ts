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

function toSaoPauloHHMM(date: Date) {
    return new Intl.DateTimeFormat("en-GB", {
        timeZone: "America/Sao_Paulo",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
    }).format(date);
}

/** Chegada anterior ao início da janela de reconhecimento (11:10 local).
 *  Quem chegou antes disso devia estar no posto às 07:00: é plantão INTEIRO
 *  atrasado, não meia jornada. É essa a segunda forma de tirar o meio plantão
 *  de alguém — corrigir a chegada para antes das 11:10 (a primeira é trocar a
 *  função, pelo quadro ou pelo /ramal). */
export function isBeforeHalfShiftWindow(date: Date) {
    const [hour, minute] = toSaoPauloHHMM(date).split(":").map(Number);
    return ((hour * 60) + minute) < HALF_SHIFT_WINDOW_START_MINUTE;
}

/** A janela agendada é a de meia jornada (11:30–17:00 no relógio local)?
 *  Usado para detectar ocupação incoerente: função de plantão inteiro sobre
 *  janela de meio plantão. Compara pelo relógio local, não pelo instante, para
 *  valer em qualquer dia. */
export function isHalfShiftScheduledWindow(window: {
    scheduledStartAt: Date | null;
    scheduledEndAt: Date | null;
}) {
    if (!window.scheduledStartAt || !window.scheduledEndAt) {
        return false;
    }

    return toSaoPauloHHMM(window.scheduledStartAt) === HALF_SHIFT_EXPECTED_START_HHMM
        && toSaoPauloHHMM(window.scheduledEndAt) === HALF_SHIFT_AUTO_END_HHMM;
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
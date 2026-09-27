export function nowUtc() {
    return new Date();
}

export function toDate(value: Date | string) {
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) {
        throw new Error("Invalid date value.");
    }
    return date;
}

/**
 * Fuso operacional (America/Bahia): UTC-3 fixo, sem horário de verão. Não
 * depende do TZ do processo — o PM2 não define TZ e a máquina pode estar em UTC.
 */
export const BAHIA_OFFSET_MINUTES = -180;

function toBahiaClock(value: Date | string) {
    return new Date(toDate(value).getTime() + (BAHIA_OFFSET_MINUTES * 60000));
}

/** Data civil (AAAA-MM-DD) em Bahia. Sem argumento: "hoje" em Bahia. */
export function bahiaDateIso(value: Date | string = nowUtc()) {
    return toBahiaClock(value).toISOString().slice(0, 10);
}

/** Hora de relógio "HH:MM" em Bahia. */
export function bahiaClockHHMM(value: Date | string) {
    return toBahiaClock(value).toISOString().slice(11, 16);
}

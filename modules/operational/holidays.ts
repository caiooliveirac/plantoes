// Feriados oficiais para fins de pagamento de plantão SAMU.
// Datas aqui pagam tarifa de fim de semana, independente do dia da semana.

// Feriados de data fixa, todo ano (nacionais + Bahia/Salvador).
export const FIXED_HOLIDAYS_MM_DD: ReadonlySet<string> = new Set<string>([
    "01-01", // Confraternização Universal
    "04-21", // Tiradentes
    "05-01", // Dia do Trabalho
    "07-02", // Independência da Bahia
    "09-07", // Independência do Brasil
    "10-12", // Nossa Senhora Aparecida
    "11-02", // Finados
    "11-15", // Proclamação da República
    "11-20", // Consciência Negra
    "12-25", // Natal
]);

// Feriados móveis e feriados SAMU avulsos, datados.
export const SAMU_HOLIDAYS: ReadonlySet<string> = new Set<string>([
    "2026-04-03", // feriado SAMU (abril/2026)
    "2026-06-04", // Corpus Christi
    "2026-06-24", // feriado SAMU (junho/2026)
]);

export function isSamuHolidayDate(operationalDate: string): boolean {
    return FIXED_HOLIDAYS_MM_DD.has(operationalDate.slice(5)) || SAMU_HOLIDAYS.has(operationalDate);
}

export function isWeekendDate(operationalDate: string): boolean {
    const reference = new Date(`${operationalDate}T12:00:00-03:00`);
    const day = reference.getUTCDay();
    return day === 0 || day === 6;
}

// Verdadeiro quando a data deve receber tarifa de fim de semana
// (sábado, domingo ou feriado SAMU).
export function isPremiumRateDate(operationalDate: string): boolean {
    return isWeekendDate(operationalDate) || isSamuHolidayDate(operationalDate);
}

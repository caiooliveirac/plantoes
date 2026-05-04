// Feriados oficiais para fins de pagamento de plantão SAMU.
// Datas neste conjunto pagam tarifa de fim de semana, independente do dia da semana.
export const SAMU_HOLIDAYS: ReadonlySet<string> = new Set<string>([
    "2026-04-03", // feriado SAMU (abril/2026)
    "2026-04-21", // Tiradentes
]);

export function isSamuHolidayDate(operationalDate: string): boolean {
    return SAMU_HOLIDAYS.has(operationalDate);
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

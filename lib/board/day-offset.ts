/**
 * Marca de virada de dia entre dois horários exibidos.
 *
 * A fila mostra chegada e saída em HH:MM, e um plantão que atravessa a noite
 * produz dois números IGUAIS ("chegou 07:00 → saiu 07:00") sem nada dizendo que
 * são dias diferentes. Foi o que a primeira leitura da tela nova revelou: o
 * chefe não tinha como ver que aquilo era um turno emendado.
 */
export function resolveDayOffsetLabel(fromIso: string, toIso: string): string | null {
    const from = new Date(fromIso);
    const to = new Date(toIso);
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
        return null;
    }

    // Dias de calendário LOCAIS (o navegador do chefe está em São Paulo), não
    // diferença de 24h: sair 20h depois de chegar às 23:00 é o dia seguinte.
    const startOfDay = (date: Date) => new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
    const days = Math.round((startOfDay(to) - startOfDay(from)) / 86400000);
    if (days === 0) {
        return null;
    }

    return days > 0 ? `+${days}d` : `${days}d`;
}

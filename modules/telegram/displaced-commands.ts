/**
 * Comandos e regras para ocupações "deslocadas": médico que perdeu o quadro numa
 * tomada confirmada e segue ativo fora do board (chegada preservada).
 *
 * A chefia precisa listar (/deslocados) e agir (/retirar Nome alvo HH:MM) sem
 * acertar o titular por engano.
 */

const DISPLACED_COMMAND_PREFIX = /^\/deslocados?(?:@\w+)?\b/i;

export interface DisplacedListItem {
    domain: "regulation" | "intervention";
    targetCode: string;
    occupancyId: string;
    doctorName: string;
    displayName: string | null;
    startedAt: string | null;
    scheduledEndAt: string | null;
}

export type CommandOccupancyPick =
    | { kind: "titular"; occupancyId: string }
    | { kind: "off_board"; occupancyId: string }
    | { kind: "missing" }
    | { kind: "name_mismatch" };

export function isTelegramDisplacedCommandText(text: string) {
    return DISPLACED_COMMAND_PREFIX.test(text.trim());
}

export function parseTelegramDisplacedCommand(text: string): { name: "deslocados" } | null {
    const match = text.trim().match(/^\/deslocados?(?:@\w+)?\s*([\s\S]*)$/i);
    if (!match) {
        return null;
    }
    const rawBody = match[1]?.trim() ?? "";
    if (rawBody && !/^(agora|atual|lista)$/i.test(rawBody)) {
        return null;
    }
    return { name: "deslocados" };
}

export function surfaceDoctorName(item: { displayName: string | null; doctorName: string }) {
    return item.displayName?.trim() || item.doctorName;
}

export function isStaleOpenOccupancy(scheduledEndAt: Date | string | null | undefined, referenceAt: Date) {
    if (!scheduledEndAt) {
        return false;
    }
    const end = scheduledEndAt instanceof Date ? scheduledEndAt : new Date(scheduledEndAt);
    if (Number.isNaN(end.getTime())) {
        return false;
    }
    return end.getTime() < referenceAt.getTime();
}

/**
 * Padrão de horário ao encerrar um deslocado: se o plantão previsto já passou,
 * NÃO usar "agora" (inventaria horas extras). Usa o fim previsto. No turno
 * corrente, usa agora.
 */
export function resolveDisplacedDepartureDefault(params: {
    scheduledEndAt: Date | string | null | undefined;
    now: Date;
}): Date {
    if (params.scheduledEndAt) {
        const scheduled = params.scheduledEndAt instanceof Date
            ? params.scheduledEndAt
            : new Date(params.scheduledEndAt);
        if (!Number.isNaN(scheduled.getTime()) && scheduled.getTime() < params.now.getTime()) {
            return scheduled;
        }
    }
    return params.now;
}

/**
 * /retirar com nome tem que acertar o ocupante nomeado, não o titular do quadro.
 * Sem nome, o alvo continua sendo o titular.
 */
export function pickCommandOccupancyTarget(params: {
    namedDoctorId: string | null;
    titular: { id: string; doctorId: string } | null;
    offBoard: { id: string; doctorId: string } | null;
}): CommandOccupancyPick {
    const { namedDoctorId, titular, offBoard } = params;

    if (namedDoctorId) {
        if (titular && namedDoctorId === titular.doctorId) {
            return { kind: "titular", occupancyId: titular.id };
        }
        if (offBoard && namedDoctorId === offBoard.doctorId) {
            return { kind: "off_board", occupancyId: offBoard.id };
        }
        if (titular || offBoard) {
            return { kind: "name_mismatch" };
        }
        return { kind: "missing" };
    }

    if (titular) {
        return { kind: "titular", occupancyId: titular.id };
    }
    return { kind: "missing" };
}

function formatSaoPauloClock(value: Date) {
    return value.toLocaleTimeString("pt-BR", {
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
        timeZone: "America/Sao_Paulo",
    });
}

function formatSaoPauloDay(value: Date) {
    return value.toLocaleDateString("pt-BR", {
        day: "2-digit",
        month: "2-digit",
        timeZone: "America/Sao_Paulo",
    });
}

function sameSaoPauloDay(a: Date, b: Date) {
    return formatSaoPauloDay(a) === formatSaoPauloDay(b);
}

export function buildDisplacedListReply(items: DisplacedListItem[], referenceAt = new Date()) {
    if (items.length === 0) {
        return "✅ Ninguém fora do quadro agora.";
    }

    const lines = [
        `🔁 Fora do quadro (${items.length})`,
        "",
    ];

    for (const item of items) {
        const name = surfaceDoctorName(item);
        const started = item.startedAt ? new Date(item.startedAt) : null;
        const scheduledEnd = item.scheduledEndAt ? new Date(item.scheduledEndAt) : null;
        const arrival = started && !Number.isNaN(started.getTime())
            ? `${formatSaoPauloClock(started)}${sameSaoPauloDay(started, referenceAt) ? "" : ` (${formatSaoPauloDay(started)})`}`
            : "--:--";
        const suggestedTime = scheduledEnd && !Number.isNaN(scheduledEnd.getTime())
            ? formatSaoPauloClock(scheduledEnd)
            : "19:00";

        lines.push(`• ${item.targetCode} · ${name} · chegada ${arrival}`);
        lines.push(`  Retirar: /retirar ${name} ${item.targetCode} ${suggestedTime}`);
        lines.push(`  Nova posição: ${name} <ramal ou base>`);
    }

    lines.push(
        "",
        "Para remanejar, declare o destino (a chegada original fica). Para encerrar um erro, use /retirar com o horário real da saída — não use a hora atual se o plantão já virou.",
    );
    return lines.join("\n");
}

export function buildDisplacedStaleTimePrompt(params: {
    doctorName: string;
    targetCode: string;
    startedAt: Date;
    scheduledEndAt: Date | null;
    referenceAt: Date;
}) {
    const arrival = `${formatSaoPauloClock(params.startedAt)}${sameSaoPauloDay(params.startedAt, params.referenceAt) ? "" : ` (${formatSaoPauloDay(params.startedAt)})`}`;
    const suggested = params.scheduledEndAt
        ? formatSaoPauloClock(params.scheduledEndAt)
        : "19:00";
    return `⛔ ${params.doctorName} está fora do quadro em ${params.targetCode} (chegada ${arrival}). O plantão previsto já passou — informe o horário real da saída, senão o banco de horas conta até agora.`
        + `\nEx.: /retirar ${params.doctorName} ${params.targetCode} ${suggested}`;
}

export function buildDisplacedNameMismatchReply(params: {
    queriedName: string;
    targetCode: string;
    titularName: string | null;
    offBoardName: string | null;
}) {
    const bits: string[] = [];
    if (params.titularName) {
        bits.push(`titular ${params.titularName}`);
    }
    if (params.offBoardName) {
        bits.push(`fora do quadro ${params.offBoardName}`);
    }
    const who = bits.length > 0 ? bits.join("; ") : "ninguém";
    return `⛔ ${params.queriedName} não está em ${params.targetCode} (${who}). Para listar quem ficou fora do quadro: /deslocados`;
}

export function buildDisplacedMissingOccupancyReply(params: {
    targetCode: string;
    offBoardNames: string[];
}) {
    if (params.offBoardNames.length === 0) {
        return `⛔ Não encontrei ocupação ativa em ${params.targetCode} para aplicar retirar.`;
    }
    const names = params.offBoardNames.join(", ");
    return `⛔ ${params.targetCode} não tem titular no quadro. Fora do quadro: ${names}.`
        + `\nUse /retirar <nome> ${params.targetCode} HH:MM — ou /deslocados para a lista.`;
}

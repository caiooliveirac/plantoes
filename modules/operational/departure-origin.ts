/**
 * De onde veio a "saída" que está na fila do chefe.
 *
 * Em 30 dias (ago–set/2026) só 518 de 1306 saídas com hora registrada foram
 * avisadas pelo médico. O resto o sistema escreveu sozinho: outro médico
 * assumiu o ramal/base e o ocupante foi encerrado naquela hora; o próprio
 * médico chegou em outro lugar; a janela venceu. A tela mostrava todas como se
 * o médico tivesse dito "saí às 07:16" — e o chefe julgava um horário que
 * ninguém declarou (caso 2152, 07:05→07:16, encerrado "só para o banco").
 *
 * A origem muda a pergunta, não só o texto: mudança de posto do próprio
 * médico nem entra na fila (nada a decidir — ele continua trabalhando), e
 * "outro assumiu" pergunta se a rendição foi real, não se "ele saiu".
 */

export type DepartureOrigin =
    /** O médico avisou a saída no Telegram. */
    | "verbalized"
    /** Outro médico chegou no mesmo alvo e o registro foi encerrado nessa hora. */
    | "successor"
    /** O próprio médico chegou em outro ramal/base; o registro anterior fechou. */
    | "own_move"
    /** Janela venceu sem aviso; o sistema encerrou no fim previsto. */
    | "window"
    /** Encerrado pelo sistema por outro caminho, sem aviso do médico. */
    | "system";

/** Janela em que uma chegada "explica" o encerramento (mesmo instante, com folga). */
export const DEPARTURE_ORIGIN_MATCH_TOLERANCE_MS = 2 * 60 * 1000;

export interface DepartureOriginInput {
    hasDepartureMessage: boolean;
    actualEndedAt: Date | string;
    scheduledEndAt?: Date | string | null;
    /** Outro médico que chegou neste alvo na hora do encerramento. */
    successorStartedAt?: Date | string | null;
    /** Chegada do próprio médico em outro alvo na hora do encerramento. */
    movedToStartedAt?: Date | string | null;
}

function toMs(value: Date | string | null | undefined) {
    if (!value) return null;
    const ms = (value instanceof Date ? value : new Date(value)).getTime();
    return Number.isNaN(ms) ? null : ms;
}

function matches(anchor: number, candidate: Date | string | null | undefined) {
    const ms = toMs(candidate);
    return ms !== null && Math.abs(ms - anchor) <= DEPARTURE_ORIGIN_MATCH_TOLERANCE_MS;
}

export function resolveDepartureOrigin(input: DepartureOriginInput): DepartureOrigin {
    if (input.hasDepartureMessage) return "verbalized";
    const endedMs = toMs(input.actualEndedAt);
    if (endedMs === null) return "system";
    // Mudança de posto vem antes do sucessor: quem chegou em outro lugar saiu
    // daqui por isso, mesmo que alguém tenha assumido no mesmo minuto.
    if (matches(endedMs, input.movedToStartedAt)) return "own_move";
    if (matches(endedMs, input.successorStartedAt)) return "successor";
    const scheduledMs = toMs(input.scheduledEndAt);
    if (scheduledMs !== null && scheduledMs === endedMs) return "window";
    return "system";
}

/** Só o que o próprio médico ou outra pessoa fez cabe na fila do chefe. */
export function shouldQueueDepartureForChief(origin: DepartureOrigin) {
    return origin !== "own_move";
}

/** Uma linha, lida às 7h: o fato que gerou a saída, sem régua nem instrução. */
export function describeDepartureOrigin(params: {
    origin: DepartureOrigin;
    doctorName: string;
    targetCode: string;
    actualEndedAt: Date | string;
    successorName?: string | null;
    movedToCode?: string | null;
}) {
    const hora = formatHourMinute(params.actualEndedAt);
    switch (params.origin) {
        case "verbalized":
            return `Avisou a saída às ${hora}.`;
        case "successor":
            return `${params.successorName ?? "Outro médico"} chegou no ${params.targetCode} às ${hora} e assumiu; `
                + `o registro de ${params.doctorName} foi encerrado nessa hora, sem aviso de saída.`;
        case "own_move":
            return `Chegou em ${params.movedToCode ?? "outro posto/base"} às ${hora}; o registro do ${params.targetCode} fechou por isso.`;
        case "window":
            return `Janela venceu às ${hora} sem aviso de saída; o sistema encerrou no horário previsto.`;
        case "system":
            return `Encerrado pelo sistema às ${hora}, sem aviso de saída.`;
    }
}

function formatHourMinute(value: Date | string) {
    return new Intl.DateTimeFormat("pt-BR", {
        hour: "2-digit", minute: "2-digit", timeZone: "America/Sao_Paulo",
    }).format(value instanceof Date ? value : new Date(value));
}

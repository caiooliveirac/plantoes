/**
 * "ELE/ELA NÃO SAIU": o chefe contesta a saída em vez de decidir o pagamento dela.
 *
 * A fila de saídas só oferecia desfechos de PAGAMENTO (inteiro, MEIO, banco).
 * Quando o registro de saída era falso — o caso Maria Juliana, BR05 14/08, em que
 * a chegada de outro médico na base errada encerrou o plantão dela às 19:41 —
 * o chefe não tinha como dizer isso. Clicava no menos errado dos botões e o
 * sistema gravava um desfecho de pagamento sobre um evento que não aconteceu.
 *
 * Duas coisas que este módulo NÃO faz, de propósito:
 *
 *   1. Não cria ocupação nova. Contestar reabre a linha que já existe; se o
 *      médico está em outro alvo, isso é remanejamento da MESMA ocupação.
 *   2. Não toma o que o chefe diz como verdade. Ele responde o que tem a
 *      responder, e pode estar reconstruindo de memória horas depois. Por isso a
 *      contestação nunca derruba quem está no quadro: se outro médico assumiu o
 *      alvo, a ocupação volta FORA do quadro e o conflito é mostrado com nome e
 *      hora, para um humano resolver a chegada que está errada.
 */

/** Onde o médico ficou depois da saída que o chefe está contestando. */
export type ContestedDepartureContinuation =
    /** Seguiu no mesmo ramal/base. */
    | "same_target"
    /** Foi para outro ramal/base — a MESMA ocupação vai ser remanejada. */
    | "other_target"
    /** O chefe não sabe dizer. Reabre fora do quadro e espera declaração. */
    | "unknown";

export interface ContestedBoardDecision {
    /** Âncora de quadro ao reabrir; nulo = volta ativo, mas fora do quadro. */
    boardStartedAt: Date | null;
    /** Por que ficou fora do quadro — texto para a tela, nulo quando voltou. */
    outOfBoardReason: string | null;
}

export function resolveContestedBoardDecision(params: {
    continuation: ContestedDepartureContinuation;
    /** Ocupante atual do alvo, quando existe. */
    boardHeldByOther: { doctorName: string; since: Date } | null;
    previousBoardStartedAt: Date | null;
    startedAt: Date;
}): ContestedBoardDecision {
    if (params.boardHeldByOther) {
        const hora = formatHourMinute(params.boardHeldByOther.since);
        return {
            boardStartedAt: null,
            outOfBoardReason: `${params.boardHeldByOther.doctorName} está no quadro deste alvo desde ${hora}.`
                + " A ocupação voltou ativa fora do quadro: se a chegada dele é que está errada,"
                + " corrija a chegada dele — este botão não tira ninguém do quadro.",
        };
    }

    if (params.continuation === "same_target") {
        return {
            boardStartedAt: params.previousBoardStartedAt ?? params.startedAt,
            outOfBoardReason: null,
        };
    }

    return {
        boardStartedAt: null,
        outOfBoardReason: params.continuation === "other_target"
            ? "Volta fora do quadro até o remanejamento apontar o alvo novo — é a mesma ocupação que muda de lugar."
            : "Volta fora do quadro: ninguém informou onde o médico ficou.",
    };
}

/**
 * Marcador gravado na nota de toda ocupação reaberta por contestação. É por ele
 * que a varredura reconhece um registro reaberto FORA do quadro e o fecha no fim
 * da janela — sem isso ficava aberto para sempre (incidente IT30 2026-09-15).
 */
export const CONTESTED_DEPARTURE_NOTE_MARKER = "[NÃO SAIU]";

export function isContestedDepartureNotes(notes: string | null | undefined) {
    return (notes ?? "").includes(CONTESTED_DEPARTURE_NOTE_MARKER);
}

/** Chegada do mesmo médico registrada depois da saída contestada. */
export interface LaterArrival {
    targetCode: string;
    startedAt: Date;
}

/**
 * Se o médico já registrou chegada em outro lugar depois da saída, a saída
 * ACONTECEU — foi rendição/passagem, não erro de registro. Reabrir aqui criaria
 * um plantão paralelo eterno (caso Laisse IT30→CZ50, 2026-09-15). O chefe que
 * clicou "não saiu" querendo dizer "continuou trabalhando" recebe o caminho certo.
 */
export function describeContestBlockedByLaterArrival(params: {
    doctorName: string;
    targetCode: string;
    contestedDepartureAt: Date;
    laterArrival: LaterArrival;
}) {
    const chegada = formatHourMinute(params.laterArrival.startedAt);
    const saida = formatHourMinute(params.contestedDepartureAt);
    return `${params.doctorName} já registrou chegada em ${params.laterArrival.targetCode} às ${chegada}. `
        + `A saída de ${params.targetCode} às ${saida} aconteceu (passou para ${params.laterArrival.targetCode}), `
        + `não é erro de registro. Confirme a saída — ou corrija o horário para ${chegada} se saiu junto com a chegada lá.`;
}

/** Nota de auditoria da contestação: o que foi desmentido, e o que o chefe disse. */
export function describeContestedDeparture(params: {
    contestedDepartureAt: Date;
    continuation: ContestedDepartureContinuation;
    /** Alvo informado pelo chefe, quando ele disse que o médico foi para outro. */
    continuedAtLabel?: string | null;
}) {
    const onde = params.continuation === "same_target"
        ? "seguiu no mesmo posto/base"
        : params.continuation === "other_target"
            ? `seguiu em ${params.continuedAtLabel?.trim() || "outro posto/base"}`
            : "sem informação de onde ficou";

    return `${CONTESTED_DEPARTURE_NOTE_MARKER} chefia contestou a saída registrada às ${formatHourMinute(params.contestedDepartureAt)}: `
        + `${onde}. Registro reaberto — nenhuma ocupação nova foi criada.`;
}

function formatHourMinute(value: Date) {
    return new Intl.DateTimeFormat("pt-BR", {
        hour: "2-digit", minute: "2-digit", timeZone: "America/Sao_Paulo",
    }).format(value);
}

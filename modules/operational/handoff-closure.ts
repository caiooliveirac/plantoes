/**
 * Fechamento de uma ocupação que já foi rendida.
 *
 * Quando o médico avisa a saída e OUTRO já está com a base/posto aberto, a
 * responsabilidade mudou de mãos na hora em que o sucessor chegou — não na hora
 * em que a mensagem chegou. Fechar no instante da mensagem escondia dois fatos
 * de uma vez: a rendição aparecia tarde demais, e o tempo entre a rendição e o
 * aviso (tipicamente uma ocorrência que prendeu a viatura) sumia — sem saída
 * física registrada, o banco de horas nem calcula.
 *
 * Caso Murilo Damasceno (PR03, 22/08/2026): Gabriel assumiu às 07:01, Murilo
 * avisou "saindo da PR03, motivo: ocorrência 0126" às 08:27, e o registro ficou
 * com `ended_at` 08:27 e `actual_ended_at` nulo — nada de crédito, nada na fila
 * da chefia, e a resposta do bot dizia "Saída registrada" como se estivesse tudo
 * certo.
 *
 * Puro: recebe datas, devolve datas.
 */

/** Folga entre a rendição e o aviso que não merece fila de validação. */
export const HANDOFF_LATE_DEPARTURE_TOLERANCE_MINUTES = 15;

export interface HandoffClosure {
    /** Quando a responsabilidade passou (é o que o banco de horas usa). */
    endedAt: Date;
    /**
     * Saída física declarada, quando ficou tempo relevante além da rendição.
     * Preenchida = a chefia precisa validar antes de virar crédito.
     */
    actualEndedAt: Date | null;
}

export function resolveHandoffClosure(params: {
    /** Chegada do médico que está saindo — o fechamento nunca é anterior a ela. */
    startedAt: Date;
    /** Chegada de quem assumiu; null quando não dá para identificar. */
    successorStartedAt: Date | null;
    /** Instante do aviso de saída. */
    eventAt: Date;
    toleranceMinutes?: number;
}): HandoffClosure {
    const tolerance = (params.toleranceMinutes ?? HANDOFF_LATE_DEPARTURE_TOLERANCE_MINUTES) * 60000;

    if (!params.successorStartedAt) {
        return { endedAt: params.eventAt, actualEndedAt: null };
    }

    // A rendição não pode ser antes da chegada de quem sai, nem depois do aviso:
    // fora desse intervalo, o dado do sucessor não descreve esta saída.
    const handoffAt = new Date(Math.min(
        Math.max(params.successorStartedAt.getTime(), params.startedAt.getTime()),
        params.eventAt.getTime(),
    ));

    return {
        endedAt: handoffAt,
        actualEndedAt: params.eventAt.getTime() - handoffAt.getTime() > tolerance
            ? params.eventAt
            : null,
    };
}

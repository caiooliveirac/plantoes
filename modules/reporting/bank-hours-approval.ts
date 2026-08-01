/**
 * Estado de aprovação da saída tardia, do ponto de vista do médico.
 *
 * O médico avisa no bot que saiu depois do horário — "saindo da CN10 agora
 * porque estava em ocorrência" — e isso abre um modal para o chefe logado
 * validar. Até agora o médico nunca ficava sabendo o desfecho, e é daí que vêm
 * os questionamentos. Este módulo transforma os dados crus em uma resposta:
 * validaram, ninguém olhou ainda, ou o horário foi corrigido para menos.
 *
 * Quando ninguém validou, o responsável não é anônimo: identificamos quem estava
 * no ramal 2031 (chefia de plantão) no momento da saída. Não é acusação — é
 * saber a quem perguntar.
 *
 * Puro de propósito: recebe fatos, devolve rótulo. Sem I/O, sem data de hoje.
 */

export type BankHoursApprovalState =
    /** Não houve saída tardia reivindicada: não há o que aprovar. */
    | "sem_pendencia"
    /** Saída tardia registrada e ninguém da chefia se manifestou. */
    | "aguardando_chefia"
    /** A chefia confirmou a saída. */
    | "validado"
    /** O médico alegou ocorrência mas não informou o número dela. */
    | "ocorrencia_nao_informada"
    /** A chefia corrigiu o horário para menos — recusa na prática. */
    | "corrigido_pela_chefia"
    /**
     * Hora extra registrada mas crédito zerado por regra de anomalia, à espera
     * de revisão manual. É o caso mais comum de "meu bônus não entrou": a saída
     * foi até confirmada, mas o crédito ficou retido — e ninguém avisava o médico.
     */
    | "credito_retido_para_revisao";

export interface BankHoursApproval {
    state: BankHoursApprovalState;
    /** Cor/ícone da UI. Nunca só cor: sempre acompanhado de rótulo e detalhe. */
    tone: "ok" | "pending" | "warn" | "neutral";
    label: string;
    detail: string;
    /** Quem validou; ou, se ninguém validou, quem estava na 2031 na hora. */
    chiefName: string | null;
    at: string | null;
    note: string | null;
}

export interface BankHoursApprovalInput {
    /** Minutos de crédito que este plantão gerou (já aplicadas as regras). */
    creditedOvertimeMinutes: number | null;
    /** Saída física registrada pelo médico. */
    actualEndedAt: string | null;
    /** Fim programado do plantão. */
    handoffEndedAt: string | null;
    departureConfirmedAt: string | null;
    departureConfirmedByName: string | null;
    departureConfirmedNote: string | null;
    /** Justificativa que o médico mandou pelo bot, quando houve. */
    lateDeparture: { reasonCode: string; occurrenceNumber: string | null } | null;
    /** Quem estava na chefia (ramal 2031) no momento da saída. */
    chiefOnDutyAtDeparture: string | null;
    /**
     * Quem estava na 2031 no momento do CLIQUE de validação.
     *
     * A conta que valida costuma ser compartilhada (chefe@samu.local), então o
     * e-mail não identifica ninguém. Os chefes avisam na 2031 assim que chegam,
     * justamente porque vale banco de horas — então o ramal sabe quem estava lá
     * na hora. É o mesmo critério que a view interna já usa.
     */
    chiefOnDutyAtConfirmation: string | null;
    /** Hora extra apurada antes de qualquer corte de regra. */
    overtimeMinutes: number | null;
    /** Regra aplicada pelo cálculo do banco de horas. */
    ruleCode: string | null;
    /** Correções administrativas do plantão, da mais antiga para a mais nova. */
    corrections: { chiefOnDutyName: string | null; createdAt: string; undone: boolean }[];
    /** Uma correção reduziu a saída registrada? Calculado por quem chama. */
    departureReducedByCorrection: boolean;
}

const RAZAO_LEGIVEL: Record<string, string> = {
    occurrence: "ocorrência em andamento",
    hygienization: "higienização da viatura",
    chief_release: "liberação da chefia",
    handoff: "rendição atrasada",
};

/**
 * Nome de quem validou. A conta usada no clique é compartilhada
 * (chefe@samu.local), então o e-mail não diz nada: vale mais quem estava na 2031
 * naquele instante. Só cai para o e-mail quando o ramal não identifica ninguém.
 */
function identificaQuemValidou(input: BankHoursApprovalInput): string | null {
    return input.chiefOnDutyAtConfirmation
        ?? (ehContaCompartilhada(input.departureConfirmedByName) ? null : input.departureConfirmedByName)
        ?? input.chiefOnDutyAtDeparture
        ?? input.departureConfirmedByName;
}

/** Conta genérica de chefia: e-mail em vez de nome de pessoa. */
function ehContaCompartilhada(valor: string | null): boolean {
    return Boolean(valor && valor.includes("@"));
}

function descreveRazao(lateDeparture: BankHoursApprovalInput["lateDeparture"]): string {
    if (!lateDeparture) return "saída após o horário previsto";
    const razao = RAZAO_LEGIVEL[lateDeparture.reasonCode] ?? lateDeparture.reasonCode;
    return lateDeparture.occurrenceNumber
        ? `${razao} (ocorrência ${lateDeparture.occurrenceNumber})`
        : razao;
}

/** Houve saída depois do previsto? É o que dispara a necessidade de validação. */
function saiuDepoisDoPrevisto(input: BankHoursApprovalInput): boolean {
    if ((input.creditedOvertimeMinutes ?? 0) > 0) return true;
    if (input.lateDeparture) return true;
    if (!input.actualEndedAt || !input.handoffEndedAt) return false;
    return new Date(input.actualEndedAt).getTime() > new Date(input.handoffEndedAt).getTime();
}

export function resolveBankHoursApproval(input: BankHoursApprovalInput): BankHoursApproval {
    if (!saiuDepoisDoPrevisto(input)) {
        return {
            state: "sem_pendencia",
            tone: "neutral",
            label: "Sem pendência",
            detail: "Você saiu no horário previsto — não havia nada para a chefia validar.",
            chiefName: null,
            at: null,
            note: null,
        };
    }

    // Vem ANTES de "validado": confirmar a saída e liberar o crédito são coisas
    // diferentes, e é justamente aí que o médico se perdia. A saída pode estar
    // confirmada e o bônus continuar retido.
    if ((input.overtimeMinutes ?? 0) > 0
        && (input.creditedOvertimeMinutes ?? 0) === 0
        && input.ruleCode?.startsWith("ANOMALY")) {
        return {
            state: "credito_retido_para_revisao",
            tone: "warn",
            label: "Crédito retido para revisão",
            detail: "O sistema registrou hora extra neste plantão, mas o valor ficou fora do padrão esperado"
                + " e o crédito foi retido até alguém da coordenação revisar à mão. Ele não foi recusado — está parado.",
            chiefName: identificaQuemValidou(input),
            at: input.departureConfirmedAt ?? input.actualEndedAt,
            note: input.departureConfirmedNote,
        };
    }

    if (input.departureConfirmedAt) {
        return {
            state: "validado",
            tone: "ok",
            label: "Validado pela chefia",
            detail: `A chefia confirmou sua saída por ${descreveRazao(input.lateDeparture)}.`,
            chiefName: identificaQuemValidou(input),
            at: input.departureConfirmedAt,
            note: input.departureConfirmedNote,
        };
    }

    // Correção que encurtou a saída é recusa na prática: o crédito foi cortado
    // por decisão de alguém, e esse alguém tem nome no histórico.
    if (input.departureReducedByCorrection) {
        const ultima = input.corrections.filter((c) => !c.undone).at(-1) ?? null;
        return {
            state: "corrigido_pela_chefia",
            tone: "warn",
            label: "Horário corrigido pela chefia",
            detail: "Sua saída foi ajustada para um horário anterior ao que você registrou, e o crédito seguiu o horário corrigido.",
            chiefName: ultima?.chiefOnDutyName ?? input.chiefOnDutyAtDeparture,
            at: ultima?.createdAt ?? null,
            note: null,
        };
    }

    // Alegou ocorrência sem número: falta o dado que permite a chefia conferir.
    if (input.lateDeparture?.reasonCode === "occurrence" && !input.lateDeparture.occurrenceNumber) {
        return {
            state: "ocorrencia_nao_informada",
            tone: "warn",
            label: "Falta o número da ocorrência",
            detail: "Você informou que saiu depois por causa de uma ocorrência, mas não passou o número dela. Sem isso a chefia não tem como conferir e validar o crédito.",
            chiefName: input.chiefOnDutyAtDeparture,
            at: input.actualEndedAt,
            note: null,
        };
    }

    return {
        state: "aguardando_chefia",
        tone: "pending",
        label: "Aguardando a chefia",
        detail: `Sua saída por ${descreveRazao(input.lateDeparture)} ainda não foi validada por ninguém.`
            + (input.chiefOnDutyAtDeparture
                ? ` Quem estava na chefia (2031) no horário era ${input.chiefOnDutyAtDeparture}.`
                : " Não foi possível identificar quem estava na chefia (2031) nesse horário."),
        chiefName: input.chiefOnDutyAtDeparture,
        at: input.actualEndedAt,
        note: null,
    };
}

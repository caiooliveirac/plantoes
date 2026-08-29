import {
    classifyEarlyDeparture,
    isEarlyDepartureEligible,
    type EarlyDepartureClassification,
} from "@/modules/operational/early-departure";
import {
    classifyExtendedStay,
    describeExtendedStay,
    isPayableExtendedStay,
    type ExtendedStayClassification,
} from "@/modules/operational/extended-stay";
import { DEPARTURE_GRACE_MINUTES } from "@/modules/bank-hours/calculator";

/**
 * Triagem das "saídas a confirmar": separa o que exige DECISÃO do chefe
 * (pagamento ou banco de horas em jogo) do que é rotina confirmável em lote.
 *
 * Fonte única para o AuditRail e o DepartureVerifier — os dois precisam
 * concordar sobre qual caso é qual, senão o card promete um botão que o
 * modal não mostra.
 *
 * As frases (`headline`) são escritas para serem lidas de relance por um chefe
 * às 7h da manhã: uma linha, o fato e o que está em jogo. O QUE fazer é o texto
 * dos botões, não da frase — repetir a decisão aqui só produz parede de texto.
 */

export type DepartureTriageKind =
    /** Saída registrada minutos depois da chegada: quase certamente conflito/erro, não saída real. */
    | "short_anomaly"
    /** Saiu antes de 6h de janela: lançar só banco, ou pagar MEIO/INTEIRO com justificativa. */
    | "early_bank_only"
    /** Saiu na faixa 6h–10h: pagar inteiro ou MEIO. */
    | "early_half"
    /** Saiu antes do fim mas faltando 2h ou menos (10h–12h de janela): chefe decide inteiro ou MEIO. */
    | "early_full"
    /** Ficou 6h ou mais além da janela: emendou turno (P) — plantão a assinar, não banco. */
    | "extended_stay"
    /** Saiu depois da janela além da tolerância: crédito de banco em jogo. */
    | "late_credit"
    /** Alegou ocorrência sem o número de 4 dígitos. */
    | "occurrence_missing"
    /** Mesma justificativa repetida ≥3x em 30 dias. */
    | "pattern"
    /** Saída dentro do previsto — nada muda em pagamento nem banco. */
    | "routine";

export interface DepartureTriageInput {
    actualEndedAt: Date | string;
    scheduledStartAt?: Date | string | null;
    scheduledEndAt?: Date | string | null;
    startedAt?: Date | string | null;
    roleLabel?: string | null;
    /** Minutos entre scheduledEndAt e actualEndedAt (positivo = saiu depois). */
    delayMinutes?: number | null;
    /**
     * Motivo detectado na mensagem/notas ("handoff" = rendido/troca). Rendição é
     * evento padrão: quem foi rendido NUNCA entra na régua de MEIO+banco — a
     * régua existe para liberação, retirada pela chefia e abandono avisado.
     */
    reasonCode?: string | null;
    occurrenceNumberMissing?: boolean;
    reasonOccurrenceCount30d?: number;
}

export interface DepartureTriageResult {
    kind: DepartureTriageKind;
    /** true = exige clique/decisão individual do chefe; false = rotina. */
    attention: boolean;
    /** Frase em português explicando POR QUE o caso está na fila. Uma linha. */
    headline: string;
    /** Régua de saída antecipada, quando a ocupação é elegível. */
    classification: EarlyDepartureClassification | null;
    /**
     * Régua da permanência longa (espelho da anterior), quando a sobra chega a
     * 6h. É o que diz que a saída é P e quantos plantões ela vale.
     */
    extendedStay: ExtendedStayClassification | null;
}

/** Repetição da mesma justificativa que acende o sinal de padrão. */
export const PATTERN_ATTENTION_THRESHOLD = 3;

/**
 * Saída registrada até este tanto de minutos depois da CHEGADA é tratada como
 * anomalia (conflito de posto, tomada mal resolvida, erro de registro) — não
 * como saída real a confirmar. Caso Yngra 13/08: ocupação encerrada 17min
 * depois da chegada por uma entrada de outra médica no mesmo ramal.
 */
export const SHORT_ANOMALY_MAX_WORKED_MINUTES = 30;

/**
 * Bônus tardio abaixo de 1h é fluxo normal e confirma em lote — só saída com
 * mais de 60min além da janela pede clique individual do chefe.
 */
export const LATE_CREDIT_ATTENTION_THRESHOLD_MINUTES = 60;

/**
 * Nota obrigatória para decisões que pagam MAIS do que a régua manda
 * (pagar MEIO/INTEIRO em saída <6h) e para recusar crédito de banco.
 * Espaços internos contam; só as bordas são aparadas.
 */
export const OVERRIDE_NOTE_MIN_LENGTH = 8;

export function isValidOverrideNote(note: string | null | undefined): boolean {
    return typeof note === "string" && note.trim().length >= OVERRIDE_NOTE_MIN_LENGTH;
}

function formatHoursShort(minutes: number) {
    const hours = Math.floor(minutes / 60);
    const rest = minutes % 60;
    if (hours === 0) return `${rest}min`;
    return rest === 0 ? `${hours}h` : `${hours}h${String(rest).padStart(2, "0")}`;
}

function toMs(value: Date | string | null | undefined): number | null {
    if (!value) return null;
    const time = (value instanceof Date ? value : new Date(value)).getTime();
    return Number.isNaN(time) ? null : time;
}

export function triagePendingDeparture(input: DepartureTriageInput): DepartureTriageResult {
    const classification = isEarlyDepartureEligible({ roleLabel: input.roleLabel })
        ? classifyEarlyDeparture({
            departureAt: input.actualEndedAt,
            scheduledStartAt: input.scheduledStartAt,
            scheduledEndAt: input.scheduledEndAt,
            startedAt: input.startedAt,
        })
        : null;

    // Permanência longa: mesma régua do banco de horas (applyAnomalyGuard), para
    // que a tela não prometa um crédito que o sistema não vai conceder.
    const extendedStay = classifyExtendedStay(input.delayMinutes ?? 0);
    const payableExtendedStay = isPayableExtendedStay(extendedStay) ? extendedStay : null;

    // Anomalia antes de qualquer régua: saída minutos depois da chegada não é
    // uma saída real — é rastro de conflito de posto ou erro de registro.
    const startedMs = toMs(input.startedAt);
    const endedMs = toMs(input.actualEndedAt);
    if (startedMs !== null && endedMs !== null) {
        const minutesOnDuty = Math.trunc((endedMs - startedMs) / 60000);
        if (minutesOnDuty >= 0 && minutesOnDuty <= SHORT_ANOMALY_MAX_WORKED_MINUTES) {
            return {
                kind: "short_anomaly",
                attention: true,
                classification,
                extendedStay: payableExtendedStay,
                headline: `Saída ${minutesOnDuty}min depois da chegada — provável conflito de posto `
                    + `ou erro de registro, não saída real.`,
            };
        }
    }

    /**
     * Emendou o turno seguinte. Vem ANTES de late_credit porque é o mesmo fato
     * visto por duas réguas, e a de banco é a errada: 6h ou mais de sobra é
     * plantão prestado na posição (um "P"), e plantão prestado se assina na
     * folha. Enquanto isto não existia aqui, a fila oferecia ao chefe
     * "confirmar 12h de banco de horas" para quem tinha ficado o turno inteiro
     * — número que o servidor nunca gravou (applyAnomalyGuard corta o crédito
     * em 6h) e que escondia o P. Caso Felipe Carneiro.
     */
    if (payableExtendedStay) {
        const proposal = describeExtendedStay(payableExtendedStay);
        return {
            kind: "extended_stay",
            attention: true,
            classification,
            extendedStay: payableExtendedStay,
            headline: `Ficou ${formatHoursShort(payableExtendedStay.overtimeMinutes)} além da janela — `
                + `emendou o turno seguinte (P): ${proposal} a assinar na posição, não banco de horas.`
                + (payableExtendedStay.bankMinutes > 0
                    ? ` Sobram ${formatHoursShort(payableExtendedStay.bankMinutes)} para o banco.`
                    : ""),
        };
    }

    // Rendição é padrão: a saída antecipada foi causada pela chegada de outro
    // médico, não por decisão de pagamento. Nada de propor MEIO+banco — mesmo
    // que a conta de horas desse menos de 12h (ex.: atrasou 1h e foi rendido 1h
    // antes das 7h). Segue para as checagens de bônus/ocorrência/padrão.
    const isHandoff = input.reasonCode === "handoff";

    if (!isHandoff && classification?.outcome === "bank_only") {
        return {
            kind: "early_bank_only",
            attention: true,
            classification,
            extendedStay: null,
            headline: `Cumpriu ${formatHoursShort(classification.workedMinutes)} da janela — `
                + `menos das 6h que assinam MEIO plantão.`,
        };
    }

    if (!isHandoff && classification?.outcome === "half_shift") {
        return {
            kind: "early_half",
            attention: true,
            classification,
            extendedStay: null,
            headline: `Cumpriu ${formatHoursShort(classification.workedMinutes)} da janela — faixa de MEIO plantão.`,
        };
    }

    // Saiu antes do fim mas com 10h+ de janela (faltando ≤2h): a régua diria
    // "assina inteiro", mas a coordenação não paga mais inteiro sempre — o chefe
    // decide. Tolerância de 15min para não transformar toda saída pontual em clique.
    if (!isHandoff && classification?.outcome === "full_shift"
        && classification.remainingMinutes > DEPARTURE_GRACE_MINUTES) {
        return {
            kind: "early_full",
            attention: true,
            classification,
            extendedStay: null,
            headline: `Saiu faltando ${formatHoursShort(classification.remainingMinutes)} para o fim, `
                + `com ${formatHoursShort(classification.workedMinutes)} de janela cumpridos.`,
        };
    }

    if ((input.delayMinutes ?? 0) > LATE_CREDIT_ATTENTION_THRESHOLD_MINUTES) {
        return {
            kind: "late_credit",
            attention: true,
            classification,
            extendedStay: null,
            headline: `Ficou ${formatHoursShort(input.delayMinutes!)} além da janela — gera crédito no banco de horas.`,
        };
    }

    if (input.occurrenceNumberMissing) {
        return {
            kind: "occurrence_missing",
            attention: true,
            classification,
            extendedStay: null,
            headline: "Alegou ocorrência sem informar o número de 4 dígitos.",
        };
    }

    if ((input.reasonOccurrenceCount30d ?? 0) >= PATTERN_ATTENTION_THRESHOLD) {
        return {
            kind: "pattern",
            attention: true,
            classification,
            extendedStay: null,
            headline: `${input.reasonOccurrenceCount30d}ª vez em 30 dias com a mesma justificativa.`,
        };
    }

    return {
        kind: "routine",
        attention: false,
        classification,
        extendedStay: null,
        headline: "Saída dentro do previsto — sem impacto em pagamento ou banco de horas.",
    };
}

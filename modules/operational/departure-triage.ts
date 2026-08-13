import {
    classifyEarlyDeparture,
    isEarlyDepartureEligible,
    type EarlyDepartureClassification,
} from "@/modules/operational/early-departure";
import { DEPARTURE_GRACE_MINUTES } from "@/modules/bank-hours/calculator";

/**
 * Triagem das "saídas a confirmar": separa o que exige DECISÃO do chefe
 * (pagamento ou banco de horas em jogo) do que é rotina confirmável em lote.
 *
 * Fonte única para o AuditRail e o DepartureVerifier — os dois precisam
 * concordar sobre qual caso é qual, senão o card promete um botão que o
 * modal não mostra.
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
    /** Frase em português explicando POR QUE o caso está na fila. */
    headline: string;
    /** Régua de saída antecipada, quando a ocupação é elegível. */
    classification: EarlyDepartureClassification | null;
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
                headline: `Saída registrada ${minutesOnDuty}min depois da chegada — quase certamente um conflito `
                    + `de posto ou erro de registro, não uma saída real. Investigue antes de confirmar qualquer coisa.`,
            };
        }
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
            headline: `Saiu com ${formatHoursShort(classification.workedMinutes)} trabalhadas — menos de 6h de janela: `
                + `decidir entre lançar só no banco de horas ou pagar com justificativa.`,
        };
    }

    if (!isHandoff && classification?.outcome === "half_shift") {
        return {
            kind: "early_half",
            attention: true,
            classification,
            headline: `Saiu com ${formatHoursShort(classification.workedMinutes)} trabalhadas — faixa de MEIO plantão: `
                + `decidir entre pagar inteiro ou MEIO (excedente de 6h vira banco).`,
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
            headline: `Saiu faltando ${formatHoursShort(classification.remainingMinutes)} para o fim, com `
                + `${formatHoursShort(classification.workedMinutes)} trabalhadas — decidir entre pagar inteiro ou MEIO.`,
        };
    }

    if ((input.delayMinutes ?? 0) > LATE_CREDIT_ATTENTION_THRESHOLD_MINUTES) {
        return {
            kind: "late_credit",
            attention: true,
            classification,
            headline: `Saiu ${formatHoursShort(input.delayMinutes!)} depois da janela — `
                + `confirmar gera crédito no banco de horas.`,
        };
    }

    if (input.occurrenceNumberMissing) {
        return {
            kind: "occurrence_missing",
            attention: true,
            classification,
            headline: "Alegou ocorrência sem informar o número de 4 dígitos — conferir antes de validar.",
        };
    }

    if ((input.reasonOccurrenceCount30d ?? 0) >= PATTERN_ATTENTION_THRESHOLD) {
        return {
            kind: "pattern",
            attention: true,
            classification,
            headline: `${input.reasonOccurrenceCount30d}ª vez em 30 dias com a mesma justificativa — atenção ao padrão.`,
        };
    }

    return {
        kind: "routine",
        attention: false,
        classification,
        headline: "Saída dentro do previsto — sem impacto em pagamento ou banco de horas.",
    };
}

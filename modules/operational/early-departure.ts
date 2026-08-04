import { resolveOperationalShiftWindow } from "@/modules/operational/board-rules";
import { isHalfShiftRoleLabel } from "@/modules/operational/half-shift";

/**
 * Retirada/saída antecipada decidida pela chefia — faixas de pagamento.
 *
 * Tudo é medido a partir da JANELA do turno (a agendada da ocupação, recortada
 * pelo turno operacional em que a saída acontece), nunca da chegada do médico:
 *
 *   - saiu antes de completar 6h de janela  -> "bank_only": não assina o
 *     plantão; as horas efetivamente trabalhadas viram crédito no banco.
 *   - completou 6h mas saiu faltando mais de 2h para o fim -> "half_shift":
 *     assina MEIO plantão; o que passar de 6h trabalhadas vira crédito.
 *   - saiu faltando 2h ou menos para o fim  -> "full_shift": assina inteiro.
 *
 * "Horas trabalhadas" começam em max(chegada, início da janela): chegar muito
 * cedo não infla o crédito, e chegar atrasado só credita o que foi cumprido.
 *
 * Este conceito é INDEPENDENTE do meio plantão declarado na chegada
 * (roleLabel MEIO_PLANTAO, janela 11:30–17:00): aquele é uma função com janela
 * própria; este é um desfecho de pagamento decidido na saída. Uma ocupação de
 * meio plantão nunca entra nesta régua (isEarlyDepartureEligible).
 */

export type EarlyDepartureOutcome = "bank_only" | "half_shift" | "full_shift";

export const EARLY_DEPARTURE_HALF_THRESHOLD_MINUTES = 6 * 60;
export const EARLY_DEPARTURE_FULL_REMAINING_MINUTES = 2 * 60;

export interface EarlyDepartureClassification {
    outcome: EarlyDepartureOutcome;
    windowStartAt: Date;
    windowEndAt: Date;
    /** Minutos de janela decorridos até a saída (>= 0). */
    elapsedMinutes: number;
    /** Minutos de janela restantes na saída (>= 0). */
    remainingMinutes: number;
    /** Minutos trabalhados dentro da janela: de max(chegada, início) até a saída. */
    workedMinutes: number;
    /** Crédito de banco resultante do desfecho (0 para full_shift). */
    bankCreditMinutes: number;
}

function toDate(value: Date | string) {
    return value instanceof Date ? value : new Date(value);
}

function toDateOrNull(value: Date | string | null | undefined) {
    if (!value) {
        return null;
    }
    const date = toDate(value);
    return Number.isNaN(date.getTime()) ? null : date;
}

function diffMinutes(start: Date, end: Date) {
    return Math.trunc((end.getTime() - start.getTime()) / 60000);
}

/**
 * Ocupações fora da régua: meio plantão declarado na chegada tem janela e
 * fração próprias e não pode ganhar um segundo desfecho por cima.
 */
export function isEarlyDepartureEligible(params: { roleLabel: string | null | undefined }) {
    return !isHalfShiftRoleLabel(params.roleLabel);
}

/**
 * Classifica uma saída antecipada contra a janela do turno em que ela ocorre.
 *
 * A janela efetiva é a interseção entre o turno operacional da saída
 * (07:00–19:00 / 19:00–07:00) e a janela agendada da ocupação, quando houver:
 * um posto núcleo (08:00) conta a partir das 08:00; um "P" que atravessou a
 * virada é medido só no segmento do turno corrente — os turnos anteriores da
 * cadeia já são plantões completos e não entram nesta régua.
 */
export function classifyEarlyDeparture(params: {
    departureAt: Date | string;
    scheduledStartAt?: Date | string | null;
    scheduledEndAt?: Date | string | null;
    /** Chegada real (startedAt). Sem ela, o trabalhado é medido da janela. */
    startedAt?: Date | string | null;
}): EarlyDepartureClassification {
    const departureAt = toDate(params.departureAt);
    const scheduledStartAt = toDateOrNull(params.scheduledStartAt);
    const scheduledEndAt = toDateOrNull(params.scheduledEndAt);
    const startedAt = toDateOrNull(params.startedAt);

    const operationalWindow = resolveOperationalShiftWindow(departureAt);

    const windowStartAt = scheduledStartAt && scheduledStartAt.getTime() > operationalWindow.startedAt.getTime()
        && scheduledStartAt.getTime() < operationalWindow.nextBoundaryAt.getTime()
        ? scheduledStartAt
        : operationalWindow.startedAt;

    const windowEndAt = scheduledEndAt
        && scheduledEndAt.getTime() > windowStartAt.getTime()
        && scheduledEndAt.getTime() < operationalWindow.nextBoundaryAt.getTime()
        ? scheduledEndAt
        : operationalWindow.nextBoundaryAt;

    const elapsedMinutes = Math.max(0, diffMinutes(windowStartAt, departureAt));
    const remainingMinutes = Math.max(0, diffMinutes(departureAt, windowEndAt));

    const workedFrom = startedAt && startedAt.getTime() > windowStartAt.getTime() ? startedAt : windowStartAt;
    const workedMinutes = Math.max(0, diffMinutes(workedFrom, departureAt));

    // Saída fora (depois) da janela agendada da ocupação: encerramento normal,
    // sem faixa — inclui a retirada de sobra do turno anterior após a virada.
    if (scheduledEndAt && departureAt.getTime() >= scheduledEndAt.getTime()) {
        return {
            outcome: "full_shift",
            windowStartAt,
            windowEndAt,
            elapsedMinutes,
            remainingMinutes: 0,
            workedMinutes,
            bankCreditMinutes: 0,
        };
    }

    let outcome: EarlyDepartureOutcome;
    if (remainingMinutes <= EARLY_DEPARTURE_FULL_REMAINING_MINUTES) {
        outcome = "full_shift";
    } else if (elapsedMinutes < EARLY_DEPARTURE_HALF_THRESHOLD_MINUTES) {
        outcome = "bank_only";
    } else {
        outcome = "half_shift";
    }

    const bankCreditMinutes = outcome === "bank_only"
        ? workedMinutes
        : outcome === "half_shift"
            ? Math.max(0, workedMinutes - EARLY_DEPARTURE_HALF_THRESHOLD_MINUTES)
            : 0;

    return {
        outcome,
        windowStartAt,
        windowEndAt,
        elapsedMinutes,
        remainingMinutes,
        workedMinutes,
        bankCreditMinutes,
    };
}

export function isStoredEarlyDepartureOutcome(value: string | null | undefined): value is EarlyDepartureOutcome {
    return value === "bank_only" || value === "half_shift" || value === "full_shift";
}

/** Desfechos que alteram pagamento/banco (full_shift é só registro de auditoria). */
export function isPaymentAffectingEarlyDepartureOutcome(
    value: string | null | undefined,
): value is "bank_only" | "half_shift" {
    return value === "bank_only" || value === "half_shift";
}

export function resolveEarlyDeparturePaymentUnit(value: string | null | undefined): number | null {
    if (value === "bank_only") {
        return 0;
    }
    if (value === "half_shift") {
        return 0.5;
    }
    return null;
}

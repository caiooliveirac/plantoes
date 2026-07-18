export type OperationalShiftLabel = "SD" | "SN";
export type OccupancyShiftLabel = OperationalShiftLabel | "P" | null;

const SAO_PAULO_OFFSET_MINUTES = -180;
const PRE_SHIFT_TOLERANCE_MINUTES = 60;
// Early-arrival detection window: arrivals within 3 h before the next boundary
// are classified as belonging to the upcoming shift (04:00→SD, 16:00→SN).
const EARLY_ARRIVAL_WINDOW_MINUTES = 180;
const VERIFICATION_GRACE_MINUTES = 15;
const OVERTIME_JUSTIFICATION_MINUTES = 15;

interface SaoPauloParts {
    year: number;
    month: number;
    day: number;
    hour: number;
    minute: number;
}

function toSaoPauloDate(value: string | Date) {
    const date = value instanceof Date ? value : new Date(value);
    return new Date(date.getTime() + (SAO_PAULO_OFFSET_MINUTES * 60000));
}

function fromSaoPauloClockParts(year: number, month: number, day: number, hour: number, minute: number) {
    return new Date(Date.UTC(year, month - 1, day, hour - (SAO_PAULO_OFFSET_MINUTES / 60), minute, 0, 0));
}

function addDays(date: Date, days: number) {
    return new Date(date.getTime() + (days * 86400000));
}

function addMinutes(date: Date, minutes: number) {
    return new Date(date.getTime() + (minutes * 60000));
}

export function getSaoPauloParts(value: string | Date): SaoPauloParts {
    const local = toSaoPauloDate(value);
    return {
        year: local.getUTCFullYear(),
        month: local.getUTCMonth() + 1,
        day: local.getUTCDate(),
        hour: local.getUTCHours(),
        minute: local.getUTCMinutes(),
    };
}

export function resolveOperationalShiftLabel(reference: string | Date): OperationalShiftLabel {
    return resolveOperationalShiftWindow(reference).shiftLabel;
}

export function resolveOperationalShiftWindow(reference: string | Date) {
    const parts = getSaoPauloParts(reference);

    if (parts.hour >= 7 && parts.hour < 19) {
        const startedAt = fromSaoPauloClockParts(parts.year, parts.month, parts.day, 7, 0);
        const nextBoundaryAt = fromSaoPauloClockParts(parts.year, parts.month, parts.day, 19, 0);
        const previousBoundaryAt = addDays(nextBoundaryAt, -1);
        return {
            shiftLabel: "SD" as const,
            startedAt,
            nextBoundaryAt,
            previousBoundaryAt,
        };
    }

    if (parts.hour >= 19) {
        const startedAt = fromSaoPauloClockParts(parts.year, parts.month, parts.day, 19, 0);
        const nextBoundaryAt = addDays(fromSaoPauloClockParts(parts.year, parts.month, parts.day, 7, 0), 1);
        const previousBoundaryAt = fromSaoPauloClockParts(parts.year, parts.month, parts.day, 7, 0);
        return {
            shiftLabel: "SN" as const,
            startedAt,
            nextBoundaryAt,
            previousBoundaryAt,
        };
    }

    const startedAt = addDays(fromSaoPauloClockParts(parts.year, parts.month, parts.day, 19, 0), -1);
    const nextBoundaryAt = fromSaoPauloClockParts(parts.year, parts.month, parts.day, 7, 0);
    const previousBoundaryAt = addDays(nextBoundaryAt, -1);
    return {
        shiftLabel: "SN" as const,
        startedAt,
        nextBoundaryAt,
        previousBoundaryAt,
    };
}

/**
 * When no explicit shift label is provided, resolve the shift for a new arrival.
 * If the arrival falls within EARLY_ARRIVAL_WINDOW_MINUTES (3 h) before the next boundary,
 * classify it as the upcoming shift rather than the current one.
 * Examples: arrival at 04:00 (3 h before SD) → "SD"; arrival at 16:00 (3 h before SN) → "SN".
 */
export function resolveArrivalShiftLabel(arrivalAt: string | Date): OperationalShiftLabel {
    const window = resolveOperationalShiftWindow(arrivalAt);
    const msToNextBoundary = window.nextBoundaryAt.getTime() - new Date(arrivalAt).getTime();
    if (msToNextBoundary > 0 && msToNextBoundary <= EARLY_ARRIVAL_WINDOW_MINUTES * 60000) {
        return window.shiftLabel === "SD" ? "SN" : "SD";
    }
    return window.shiftLabel;
}

// Tomada de posto/base só vale DENTRO do mesmo turno operacional. Uma chegada para o
// PRÓXIMO turno (relevo de fim de plantão, ~17h→19h / ~05h→07h) que assume um posto
// ainda ocupado pelo médico do turno que está acabando é rendição normal — não tomada:
// fecha o anterior com saída inicial (que ele pode justificar como saída tardia) e NÃO
// dispara confirmação nem deslocamento. Sem isso, quem chega 18:50 para a noite é
// avisado de "posição ocupada" por quem chegou 07:00 para o dia — 12h antes, sem sentido.
export function isSameOperationalShiftArrival(occupantStartedAt: string | Date, arrivalAt: string | Date): boolean {
    return resolveArrivalShiftLabel(occupantStartedAt) === resolveArrivalShiftLabel(arrivalAt);
}

export function isBeforeCurrentOperationalShift(startedAt: string | Date | null, reference: string | Date) {
    if (!startedAt) {
        return false;
    }

    const currentShiftStart = resolveOperationalShiftWindow(reference).startedAt;
    const toleratedShiftStart = addMinutes(currentShiftStart, -PRE_SHIFT_TOLERANCE_MINUTES);
    return new Date(startedAt).getTime() < toleratedShiftStart.getTime();
}

export function shouldHighlightInterventionVerification(
    startedAt: string | Date | null,
    reference: string | Date,
    shiftLabel: OccupancyShiftLabel = null,
) {
    if (!isBeforeCurrentOperationalShift(startedAt, reference)) {
        return false;
    }

    if (shiftLabel !== "P") {
        return true;
    }

    const boundary = resolveInterventionVerificationBoundary(startedAt, reference, shiftLabel);
    if (!boundary) {
        return true;
    }

    return new Date(reference).getTime() >= addMinutes(boundary, VERIFICATION_GRACE_MINUTES).getTime();
}

export function hasPlannedInterventionCoverageForCurrentShift(params: {
    shiftLabel: OccupancyShiftLabel;
    scheduledEndAt: string | Date | null;
    reference: string | Date;
}) {
    if (params.shiftLabel !== "P" || !params.scheduledEndAt) {
        return false;
    }

    const currentShiftStart = resolveOperationalShiftWindow(params.reference).startedAt;
    return new Date(params.scheduledEndAt).getTime() > currentShiftStart.getTime();
}

/**
 * Chegada adiantada declarada para o TURNO ATUAL (caso Caio 2152, jul/2026:
 * "Caio 2152 SD" às 05:07). O label explícito do turno corrente + cobertura
 * agendada que entra no turno corrente fazem dele o titular do turno — por mais
 * cedo que tenha chegado, ele NÃO é sobra da virada: nada de "VERIFICAR"/Retirar
 * às 07:00. A exigência de scheduledEndAt dentro do turno protege o caso oposto
 * (um SD de ONTEM ainda aberto às 08:00 de hoje tem o mesmo label do turno
 * corrente, mas cobertura vencida → segue "saindo").
 */
export function isDeclaredCurrentShiftArrival(params: {
    shiftLabel: OccupancyShiftLabel;
    scheduledEndAt?: string | Date | null;
    reference: string | Date;
}) {
    if (!params.shiftLabel || params.shiftLabel === "P" || !params.scheduledEndAt) {
        return false;
    }

    const window = resolveOperationalShiftWindow(params.reference);
    return params.shiftLabel === window.shiftLabel
        && new Date(params.scheduledEndAt).getTime() > window.startedAt.getTime();
}

export type OccupancyDirection = "entrando" | "saindo";

/**
 * Fonte de verdade única (compartilhada pelas duas colunas do quadro) para decidir
 * se uma ocupação está ENTRANDO (chegou para o turno atual/entrante) ou SAINDO
 * (pertence ao turno que já encerrou e ainda aparece no quadro).
 *
 * Critério temporal (relativo a `reference` = "agora", no fuso UTC−3 fixo deste módulo):
 *  - SAINDO ⟺ o início da ocupação é anterior ao turno atual
 *    (`isBeforeCurrentOperationalShift`, que tolera adiantamentos de até 60 min)
 *    E a pessoa não tem cobertura planejada para o turno atual
 *    (`hasPlannedInterventionCoverageForCurrentShift`, que indica permanência por shiftLabel "P").
 *  - ENTRANDO ⟺ todo o resto.
 *
 * `shiftEndAt` é o instante em que o turno da pessoa que está saindo encerrou —
 * ou seja, a fronteira de turno que acabou de passar (= início do turno atual).
 * É esse o `endedAt` correto ao retirar alguém por encerramento de turno.
 */
export function resolveOccupancyDirection(params: {
    startedAt: string | Date | null;
    scheduledEndAt?: string | Date | null;
    shiftLabel: OccupancyShiftLabel;
    reference: string | Date;
}): { status: OccupancyDirection; shiftEndAt: string } {
    const { startedAt, scheduledEndAt = null, shiftLabel, reference } = params;
    const window = resolveOperationalShiftWindow(reference);

    const leaving = startedAt != null
        && isBeforeCurrentOperationalShift(startedAt, reference)
        && !isDeclaredCurrentShiftArrival({ shiftLabel, scheduledEndAt, reference })
        && !hasPlannedInterventionCoverageForCurrentShift({ shiftLabel, scheduledEndAt, reference });

    return {
        status: leaving ? "saindo" : "entrando",
        shiftEndAt: window.startedAt.toISOString(),
    };
}

export type InterventionLineState =
    | { kind: "continua" }
    | { kind: "saindo"; shiftEndAt: string }
    | { kind: "none" };

/**
 * Máquina de estados única (compartilhada) para cada linha ATIVA da coluna INTERVENÇÃO.
 * Avalia nesta ordem (fuso UTC−3 fixo deste módulo; `reference` = "agora"):
 *
 *  PRÉ-REQUISITO — só quem COMEÇOU ANTES do turno atual
 *  (`isBeforeCurrentOperationalShift`, tolerância de 60 min) pode "continuar" ou
 *  "sair". Quem chegou DENTRO do turno corrente apenas chegou: não tem nada a
 *  continuar, por mais distante que seja seu `scheduledEndAt` → "none".
 *
 *  1. "continua" — começou num turno anterior E atravessou a virada permanecendo
 *     (cobertura "P" que se estende ao turno atual, via
 *     `hasPlannedInterventionCoverageForCurrentShift`). É um carry-over → badge
 *     "Continua" (sem horário: a hora não agrega e confunde).
 *  2. "saindo"  — começou num turno anterior, sem cobertura válida para o atual →
 *     "VERIFICAR" + "Retirar". `shiftEndAt` = fronteira que acabou de passar
 *     (= início do turno atual), o `endedAt` correto na retirada.
 *  3. "none"    — chegou para o turno atual → sem ação.
 */
export function resolveInterventionLineState(params: {
    startedAt: string | Date | null;
    boardStartedAt?: string | Date | null;
    scheduledEndAt?: string | Date | null;
    shiftLabel: OccupancyShiftLabel;
    reference: string | Date;
}): InterventionLineState {
    const { startedAt, boardStartedAt = null, scheduledEndAt = null, shiftLabel, reference } = params;
    const anchor = boardStartedAt ?? startedAt;

    if (anchor == null || !isBeforeCurrentOperationalShift(anchor, reference)) {
        return { kind: "none" };
    }

    // Chegada adiantada declarada para o turno atual ("2152 SD" às 05:07): é o
    // titular do turno corrente, não carry-over — nem "continua" nem "saindo".
    if (isDeclaredCurrentShiftArrival({ shiftLabel, scheduledEndAt, reference })) {
        return { kind: "none" };
    }

    if (hasPlannedInterventionCoverageForCurrentShift({ shiftLabel, scheduledEndAt, reference })) {
        return { kind: "continua" };
    }

    return { kind: "saindo", shiftEndAt: resolveOperationalShiftWindow(reference).startedAt.toISOString() };
}

export function resolveFirstVerificationBoundary(startedAt: string | Date | null) {
    if (!startedAt) {
        return null;
    }

    const parts = getSaoPauloParts(startedAt);
    if (parts.hour < 7) {
        return fromSaoPauloClockParts(parts.year, parts.month, parts.day, 7, 0);
    }
    if (parts.hour < 19) {
        return fromSaoPauloClockParts(parts.year, parts.month, parts.day, 19, 0);
    }

    return addDays(fromSaoPauloClockParts(parts.year, parts.month, parts.day, 7, 0), 1);
}

export function resolveOvertimeJustificationThreshold(startedAt: string | Date | null) {
    const boundary = resolveFirstVerificationBoundary(startedAt);
    if (!boundary) {
        return null;
    }

    return addMinutes(boundary, OVERTIME_JUSTIFICATION_MINUTES);
}

export function requiresOvertimeJustification(startedAt: string | Date | null, reference: string | Date | null) {
    if (!reference) {
        return false;
    }

    const threshold = resolveOvertimeJustificationThreshold(startedAt);
    if (!threshold) {
        return false;
    }

    return new Date(reference).getTime() >= threshold.getTime();
}

export function resolveProlongedShiftExpiry(startedAt: string | Date | null, shiftLabel: OccupancyShiftLabel) {
    if (!startedAt || shiftLabel !== "P") {
        return null;
    }

    const parts = getSaoPauloParts(startedAt);
    const sameDaySeven = fromSaoPauloClockParts(parts.year, parts.month, parts.day, 7, 0);
    return addDays(sameDaySeven, 1);
}

export function resolveImplicitOccupancyExpiry(startedAt: string | Date | null, shiftLabel: OccupancyShiftLabel) {
    if (!startedAt) {
        return null;
    }

    if (shiftLabel === "P") {
        return resolveProlongedShiftExpiry(startedAt, shiftLabel);
    }

    return resolveFirstVerificationBoundary(startedAt);
}

function resolveInterventionVerificationBoundary(
    startedAt: string | Date | null,
    reference: string | Date,
    shiftLabel: OccupancyShiftLabel,
) {
    if (!startedAt) {
        return null;
    }

    if (shiftLabel !== "P") {
        return resolveFirstVerificationBoundary(startedAt);
    }

    const currentShiftStart = resolveOperationalShiftWindow(reference).startedAt;
    if (new Date(startedAt).getTime() < currentShiftStart.getTime()) {
        return currentShiftStart;
    }

    return resolveFirstVerificationBoundary(startedAt);
}

export function shouldKeepRegulationOccupancyVisible(params: {
    startedAt: string | Date | null;
    boardStartedAt?: string | Date | null;
    scheduledEndAt?: string | Date | null;
    shiftLabel: OccupancyShiftLabel;
    reference: string | Date;
}) {
    const { startedAt, shiftLabel, reference } = params;
    if (!startedAt) {
        return true;
    }

    // For cross-shift continuity, boardStartedAt may intentionally remain anchored to
    // the original arrival (previous shift) while startedAt reflects the current shift
    // takeover. In that case, never hide the active occupancy.
    if (!isBeforeCurrentOperationalShift(startedAt, reference)) {
        return true;
    }

    const visibilityAnchorAt = params.boardStartedAt ?? startedAt;

    if (!isBeforeCurrentOperationalShift(visibilityAnchorAt, reference)) {
        return true;
    }

    // Honor explicit operational commitment: if scheduledEndAt was set (e.g. via a
    // continuation event extending coverage to the next shift boundary), keep the
    // occupancy visible until that scheduled end + grace. This prevents the implicit
    // P-shift expiry from hiding a continuation that was just confirmed.
    if (params.scheduledEndAt) {
        const scheduledEndAt = new Date(params.scheduledEndAt);
        if (new Date(reference).getTime() < addMinutes(scheduledEndAt, VERIFICATION_GRACE_MINUTES).getTime()) {
            return true;
        }
    }

    const expiresAt = resolveImplicitOccupancyExpiry(visibilityAnchorAt, shiftLabel);
    if (!expiresAt) {
        return false;
    }

    return new Date(reference).getTime() < addMinutes(expiresAt, VERIFICATION_GRACE_MINUTES).getTime();
}

export function resolveContinuationBadgeLabel(params: {
    startedAt: string | Date | null;
    shiftLabel: OccupancyShiftLabel;
    reference: string | Date;
}) {
    const { startedAt, shiftLabel, reference } = params;
    if (!startedAt || shiftLabel !== "P") {
        return null;
    }

    const boundary = resolveInterventionVerificationBoundary(startedAt, reference, shiftLabel);
    if (!boundary) {
        return null;
    }

    const now = new Date(reference).getTime();
    const boundaryTime = boundary.getTime();
    const graceLimit = addMinutes(boundary, VERIFICATION_GRACE_MINUTES).getTime();
    if (now < boundaryTime || now >= graceLimit) {
        return null;
    }

    return `Continua as ${boundary.toLocaleTimeString("pt-BR", {
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
        timeZone: "America/Sao_Paulo",
    })}`;
}
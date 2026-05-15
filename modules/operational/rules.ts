import { resolveOperationalShiftWindow } from "@/modules/operational/board-rules";
import { isNucleoRegulationPost } from "@/modules/operational/board-display";

const OPERATIONAL_LOCAL_OFFSET_MINUTES = -180;
// Arrivals within 3 hours before the next shift boundary (04:00–06:59 for SD, 16:00–18:59 for SN)
// are treated as early arrivals for the upcoming shift rather than the current one.
const EARLY_ARRIVAL_WINDOW_MS = 3 * 60 * 60 * 1000;
const NUCLEO_SD_START_HOUR = 8;

function resolvePShiftAwareBaseShiftLabel(startedAt: Date, normalizedShiftLabel: string | null) {
    const window = resolveOperationalShiftWindow(startedAt);
    const msToNextBoundary = window.nextBoundaryAt.getTime() - startedAt.getTime();
    if (msToNextBoundary > 0 && msToNextBoundary <= EARLY_ARRIVAL_WINDOW_MS) {
        const nextShiftLabel = window.shiftLabel === "SD" ? "SN" as const : "SD" as const;
        // Flip to the upcoming shift when the label is:
        //   - null  (no label in the message — let time rule)
        //   - "P"   (continuation — base shift comes from the upcoming window)
        //   - same as the current window's shift  (auto-populated from board state, e.g. the
        //     drawer defaulting to "SN" when a doctor arrives at 06:47 for the morning SD shift)
        if (
            normalizedShiftLabel === null
            || normalizedShiftLabel === "P"
            || normalizedShiftLabel === window.shiftLabel
        ) {
            return nextShiftLabel;
        }
    }
    if (normalizedShiftLabel === "SD" || normalizedShiftLabel === "SN") {
        return normalizedShiftLabel;
    }
    return window.shiftLabel;
}

function toOperationalLocalClock(date: Date) {
    return new Date(date.getTime() + (OPERATIONAL_LOCAL_OFFSET_MINUTES * 60000));
}

function fromOperationalLocalClockParts(year: number, month: number, day: number, hour: number, minute: number) {
    return new Date(Date.UTC(year, month - 1, day, hour - (OPERATIONAL_LOCAL_OFFSET_MINUTES / 60), minute, 0, 0));
}

function addOperationalLocalDays(date: Date, days: number) {
    return new Date(date.getTime() + (days * 86400000));
}

function resolveClosestScheduledStart(startedAt: Date, hour: number, minute: number) {
    const local = toOperationalLocalClock(startedAt);
    const year = local.getUTCFullYear();
    const month = local.getUTCMonth() + 1;
    const day = local.getUTCDate();
    const currentDay = fromOperationalLocalClockParts(year, month, day, hour, minute);
    const previousDay = addOperationalLocalDays(currentDay, -1);

    return Math.abs(currentDay.getTime() - startedAt.getTime()) <= Math.abs(previousDay.getTime() - startedAt.getTime())
        ? currentDay
        : previousDay;
}

export function inferOperationalScheduledStartAt(startedAt: Date, shiftLabel?: string | null, explicitScheduledStartAt?: Date | null, postCode?: string | null) {
    if (explicitScheduledStartAt) {
        return explicitScheduledStartAt;
    }

    const normalized = shiftLabel?.trim().toUpperCase();
    if (!normalized || (normalized !== "SD" && normalized !== "SN")) {
        return null;
    }

    if (normalized === "SD") {
        const hour = postCode && isNucleoRegulationPost(postCode) ? NUCLEO_SD_START_HOUR : 7;
        return resolveClosestScheduledStart(startedAt, hour, 0);
    }

    return resolveClosestScheduledStart(startedAt, 19, 0);
}

export function inferInterventionScheduledEndAt(startedAt: Date, shiftLabel?: string | null, explicitScheduledEndAt?: Date | null) {
    if (explicitScheduledEndAt) {
        return explicitScheduledEndAt;
    }

    const normalized = shiftLabel?.trim().toUpperCase();
    if (!normalized || (normalized !== "SD" && normalized !== "SN")) {
        return null;
    }

    if (normalized === "SD") {
        const scheduledStartAt = inferOperationalScheduledStartAt(startedAt, normalized, null);
        return scheduledStartAt ? fromOperationalLocalClockParts(
            toOperationalLocalClock(scheduledStartAt).getUTCFullYear(),
            toOperationalLocalClock(scheduledStartAt).getUTCMonth() + 1,
            toOperationalLocalClock(scheduledStartAt).getUTCDate(),
            19,
            0,
        ) : null;
    }

    const scheduledStartAt = inferOperationalScheduledStartAt(startedAt, normalized, null);
    if (!scheduledStartAt) {
        return null;
    }

    const nextDay = addOperationalLocalDays(toOperationalLocalClock(scheduledStartAt), 1);
    return fromOperationalLocalClockParts(
        nextDay.getUTCFullYear(),
        nextDay.getUTCMonth() + 1,
        nextDay.getUTCDate(),
        7,
        0,
    );
}

export function inferInterventionCoverageWindow(params: {
    startedAt: Date;
    shiftLabel?: string | null;
    explicitScheduledStartAt?: Date | null;
    explicitScheduledEndAt?: Date | null;
}) {
    const normalized = params.shiftLabel?.trim().toUpperCase() ?? null;
    const baseShiftLabel = resolvePShiftAwareBaseShiftLabel(params.startedAt, normalized);
    const scheduledStartAt = inferOperationalScheduledStartAt(
        params.startedAt,
        baseShiftLabel,
        params.explicitScheduledStartAt ?? null,
    );
    let scheduledEndAt = inferInterventionScheduledEndAt(
        params.startedAt,
        baseShiftLabel,
        params.explicitScheduledEndAt ?? null,
    );

    if (normalized === "P" && scheduledEndAt && !params.explicitScheduledEndAt) {
        const extendedBoundary = resolveOperationalShiftWindow(new Date(scheduledEndAt.getTime() + 60000)).nextBoundaryAt;
        if (extendedBoundary.getTime() > scheduledEndAt.getTime()) {
            scheduledEndAt = extendedBoundary;
        }
    }

    return {
        baseShiftLabel,
        scheduledStartAt,
        scheduledEndAt,
    };
}

export function inferRegulationCoverageWindow(params: {
    startedAt: Date;
    shiftLabel?: string | null;
    postCode?: string | null;
    explicitScheduledStartAt?: Date | null;
    explicitScheduledEndAt?: Date | null;
}) {
    const normalized = params.shiftLabel?.trim().toUpperCase() ?? null;
    const baseShiftLabel = resolvePShiftAwareBaseShiftLabel(params.startedAt, normalized);
    const scheduledStartAt = inferOperationalScheduledStartAt(
        params.startedAt,
        baseShiftLabel,
        params.explicitScheduledStartAt ?? null,
        params.postCode ?? null,
    );
    let scheduledEndAt = inferRegulationScheduledEndAt(
        params.startedAt,
        baseShiftLabel,
        params.explicitScheduledEndAt ?? null,
    );

    if (normalized === "P" && scheduledEndAt && !params.explicitScheduledEndAt) {
        const extendedReference = new Date(scheduledEndAt.getTime() + 60000);
        const nextShiftLabel = resolveOperationalShiftWindow(extendedReference).shiftLabel;
        const extendedScheduledEndAt = inferRegulationScheduledEndAt(extendedReference, nextShiftLabel, null);
        if (extendedScheduledEndAt && extendedScheduledEndAt.getTime() > scheduledEndAt.getTime()) {
            scheduledEndAt = extendedScheduledEndAt;
        }
    }

    return {
        baseShiftLabel,
        scheduledStartAt,
        scheduledEndAt,
    };
}

export function inferRegulationScheduledEndAt(startedAt: Date, shiftLabel?: string | null, explicitScheduledEndAt?: Date | null) {
    if (explicitScheduledEndAt) {
        return explicitScheduledEndAt;
    }

    const normalized = shiftLabel?.trim().toUpperCase();
    if (!normalized || (normalized !== "SD" && normalized !== "SN")) {
        return null;
    }

    if (normalized === "SD") {
        const scheduledStartAt = inferOperationalScheduledStartAt(startedAt, normalized, null);
        return scheduledStartAt ? fromOperationalLocalClockParts(
            toOperationalLocalClock(scheduledStartAt).getUTCFullYear(),
            toOperationalLocalClock(scheduledStartAt).getUTCMonth() + 1,
            toOperationalLocalClock(scheduledStartAt).getUTCDate(),
            19,
            15,
        ) : null;
    }

    const scheduledStartAt = inferOperationalScheduledStartAt(startedAt, normalized, null);
    if (!scheduledStartAt) {
        return null;
    }

    const nextDay = addOperationalLocalDays(toOperationalLocalClock(scheduledStartAt), 1);
    return fromOperationalLocalClockParts(
        nextDay.getUTCFullYear(),
        nextDay.getUTCMonth() + 1,
        nextDay.getUTCDate(),
        7,
        15,
    );
}

// ─── Continuação de plantão ────────────────────────────────────────────────
//
// "Continua" é uma INTENÇÃO TEMPORAL DISCRETA sobre o turno seguinte — nunca
// uma extensão infinita do plantão atual. Ausência de saída NÃO significa
// permanência indefinida.
//
// Auditoria 2026-05 (caso Manuella Barreto): a lógica antiga recalculava a
// continuidade como um plantão P inteiro de 24h NOVO ancorado na HORA da
// mensagem. Uma mensagem de "reforço" enviada dentro da janela já coberta
// (ex.: médica de P desde 07:00 recebendo "continua" às 19:00 do mesmo dia)
// empurrava o scheduled_end para ~36h e o painel exibia presença inflada.
//
// Regra canônica — ver resolveRegulationContinuationScheduledEndAt (regulação)
// e resolveInterventionContinuationScheduledEndAt (intervenção):
//   • Continuidade DENTRO da janela já coberta = apenas reforço. Não estende.
//   • Continuidade avisada APÓS o fim da janela = emenda do próximo bloco
//     discreto (turno seguinte). Só aqui a cobertura se estende.
//   • Continuidade nunca encurta a cobertura e nunca pula mais de um bloco.
//   • Cobertura > 25h aciona o alerta de plantão prolongado (isExtendedLongShift
//     em modules/telegram/service.ts) para um humano confirmar/corrigir.

/**
 * Fim agendado de uma continuação de intervenção.
 *
 * Extraído da lógica inline de continueInterventionOccupancy para dar paridade
 * estrutural e testabilidade ao lado de resolveRegulationContinuationScheduledEndAt.
 * Comportamento idêntico ao anterior: a cobertura é emendada apenas até a
 * PRÓXIMA virada de turno após o aviso (bloco discreto), nunca além — e nunca
 * encurta um fim já agendado mais distante.
 */
export function resolveInterventionContinuationScheduledEndAt(params: {
    existingScheduledEndAt: Date | null;
    continuationAt: Date;
}): Date {
    const continuationBoundary = resolveOperationalShiftWindow(params.continuationAt).nextBoundaryAt;
    return params.existingScheduledEndAt
        && params.existingScheduledEndAt.getTime() > continuationBoundary.getTime()
        ? params.existingScheduledEndAt
        : continuationBoundary;
}

export function resolveRegulationBoardEndAt(proposedEndAt: Date, scheduledEndAt?: Date | null) {
    if (!scheduledEndAt) {
        return proposedEndAt;
    }

    return proposedEndAt.getTime() <= scheduledEndAt.getTime() ? proposedEndAt : scheduledEndAt;
}

// Audit 2026-05: medicos digitando "chegada 08h10" as 20:20 ou "na 1367 07:16"
// as 19:37 (back-correction de chegada no dia) caiam num empate de 12h em
// resolveTelegramEventTime, onde o candidato FUTURO ficava cerca de 20 min
// mais perto que o passado e ganhava por desempate. Resultado: chegada
// registrada AMANHA HH:mm, e a saida real no dia seguinte falhava com
// "Actual end cannot be before the recorded arrival" (Briang 2032, Matheus
// 1367, Luiz Eduardo 2031, Viviane).
//
// Chegadas raramente sao pre-anunciadas: medicos avisam quando ja estao
// no posto. Acima de 4h de futuro tratamos como back-correction (HH:mm de
// hoje) em vez de pre-anuncio (HH:mm de amanha).
const ARRIVAL_FUTURE_TOLERANCE_MS = 4 * 60 * 60 * 1000;

export function normalizeArrivalEventTime(eventAt: Date, referenceAt: Date) {
    const skewMs = eventAt.getTime() - referenceAt.getTime();
    if (skewMs > ARRIVAL_FUTURE_TOLERANCE_MS) {
        return new Date(eventAt.getTime() - 86400000);
    }
    return eventAt;
}

export function resolveTelegramEventTime(referenceDate: Date, hhmm?: string | null) {
    if (!hhmm) {
        return referenceDate;
    }

    const [hoursRaw, minutesRaw] = hhmm.split(":");
    const hours = Number(hoursRaw);
    const minutes = Number(minutesRaw);
    if (!Number.isInteger(hours) || !Number.isInteger(minutes)) {
        return referenceDate;
    }

    const local = toOperationalLocalClock(referenceDate);
    const resolved = fromOperationalLocalClockParts(
        local.getUTCFullYear(),
        local.getUTCMonth() + 1,
        local.getUTCDate(),
        hours,
        minutes,
    );

    const candidates = [
        new Date(resolved.getTime() - 86400000),
        resolved,
        new Date(resolved.getTime() + 86400000),
    ];

    return candidates.reduce((closest, candidate) => {
        const candidateDistance = Math.abs(candidate.getTime() - referenceDate.getTime());
        const closestDistance = Math.abs(closest.getTime() - referenceDate.getTime());
        return candidateDistance < closestDistance ? candidate : closest;
    });
}

export function resolveForcedDayEventTime(referenceDate: Date, hhmm: string, dayOffset: number) {
    const [hoursRaw, minutesRaw] = hhmm.split(":");
    const hours = Number(hoursRaw);
    const minutes = Number(minutesRaw);
    if (!Number.isInteger(hours) || !Number.isInteger(minutes)) {
        return referenceDate;
    }

    const local = toOperationalLocalClock(referenceDate);
    const shifted = new Date(local.getTime() + dayOffset * 86400000);
    return fromOperationalLocalClockParts(
        shifted.getUTCFullYear(),
        shifted.getUTCMonth() + 1,
        shifted.getUTCDate(),
        hours,
        minutes,
    );
}
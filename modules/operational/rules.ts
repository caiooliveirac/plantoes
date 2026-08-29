import { resolveOperationalShiftWindow } from "@/modules/operational/board-rules";
import { isNucleoRegulationPost } from "@/modules/operational/board-display";

const OPERATIONAL_LOCAL_OFFSET_MINUTES = -180;
// Arrivals within 3 hours before the next shift boundary (04:00–06:59 for SD, 16:00–18:59 for SN)
// are treated as early arrivals for the upcoming shift rather than the current one.
const EARLY_ARRIVAL_WINDOW_MS = 3 * 60 * 60 * 1000;
const NUCLEO_SD_START_HOUR = 8;

export function resolvePShiftAwareBaseShiftLabel(startedAt: Date, normalizedShiftLabel: string | null) {
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

/**
 * Sobra a partir da qual a permanência é, sozinha, prova de continuação.
 *
 * É o mesmo 10h que a régua da sobra já usa para assinar plantão INTEIRO
 * (EXTENDED_STAY_FULL_THRESHOLD_MINUTES): abaixo disso ainda cabe conversa,
 * acima não cabe. Quem saiu 10h ou mais depois do fim previsto emendou o turno
 * seguinte, e isso não é uma pergunta a fazer ao chefe — é uma conta a fazer.
 */
export const UNDECLARED_CONTINUATION_OVERTIME_MINUTES = 10 * 60;

/**
 * Janela que a continuação NÃO DECLARADA deveria ter tido.
 *
 * Estende o fim previsto bloco a bloco — a mesma aritmética de
 * resolveRegulationContinuationScheduledEndAt — até cobrir a hora em que o
 * médico de fato saiu. É o "continua" que ele esqueceu de mandar, escrito
 * depois pela evidência de que ele ficou.
 *
 * Devolve null quando não há nada a estender (saiu dentro da janela, ou a sobra
 * ainda não chega ao limite em que a permanência fala por si).
 */
export function resolveUndeclaredContinuationScheduledEndAt(params: {
    domain: "REGULATION" | "INTERVENTION";
    scheduledEndAt: Date;
    departureAt: Date;
}) {
    const overtimeMinutes = Math.trunc(
        (params.departureAt.getTime() - params.scheduledEndAt.getTime()) / 60000,
    );
    if (overtimeMinutes < UNDECLARED_CONTINUATION_OVERTIME_MINUTES) {
        return null;
    }

    let endAt = params.scheduledEndAt;
    // Um turno operacional por volta; o teto existe só para nunca girar à toa.
    for (let block = 0; block < 8 && endAt.getTime() < params.departureAt.getTime(); block += 1) {
        const reference = new Date(endAt.getTime() + 60000);
        const shiftLabel = resolveOperationalShiftWindow(reference).shiftLabel;
        const next = params.domain === "REGULATION"
            ? inferRegulationScheduledEndAt(reference, shiftLabel, null)
            : inferInterventionScheduledEndAt(reference, shiftLabel, null);
        if (!next || next.getTime() <= endAt.getTime()) {
            break;
        }
        endAt = next;
    }

    return endAt.getTime() > params.scheduledEndAt.getTime() ? endAt : null;
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
//   • Um aviso de continuidade referencia a VIRADA DE TURNO mais próxima da
//     mensagem (resolveContinuationReferenceBoundary), nunca a hora em que a
//     mensagem foi enviada: "continua" às 06:41, 07:30 ou 10:15 fala da virada
//     das 07:00; às 17:00 ou 19:30, da das 19:00.
//   • A cobertura passa a incluir o bloco SEGUINTE à virada referenciada — um
//     único bloco discreto, nunca mais que um.
//   • Se esse bloco já estava coberto, o aviso é apenas reforço (caso Manuella
//     2026-05: "continua" às 19:00 de um P 07h→07h não infla para 36h).
//   • Continuidade nunca encurta uma cobertura já agendada mais distante.
//   • Cobertura > 25h aciona o alerta de plantão prolongado (isExtendedLongShift
//     em modules/telegram/service.ts) para um humano confirmar/corrigir.

/**
 * Quão perto da virada o aviso precisa ser dito para valer como promessa do turno
 * SEGUINTE. Fora dessa janela, "continua" só amarra o plantão ao anterior.
 * 2h cobre o relevo real (o médico avisa quando o rendedor está a caminho) sem
 * deixar um aviso de meio de plantão comprometer as 12h seguintes.
 */
const CONTINUATION_NEXT_BOUNDARY_WINDOW_MS = 2 * 60 * 60 * 1000;

/**
 * A virada de turno que um aviso de continuidade referencia: a seguinte quando o
 * aviso é dito perto dela, senão a do turno corrente. Toda a semântica de
 * continuidade (extensão de cobertura, vínculo com plantão anterior, âncora)
 * deriva desta fronteira, para que o resultado NÃO dependa de o médico avisar
 * antes ou depois da virada (casos Uenderson 06:41/08:12 e Luiz Alvarez 10:15,
 * jul/2026).
 */
export function resolveContinuationReferenceBoundary(eventAt: Date): Date {
    const window = resolveOperationalShiftWindow(eventAt);
    const toNextMs = window.nextBoundaryAt.getTime() - eventAt.getTime();
    // Só é promessa do PRÓXIMO turno quando dita perto da virada. Um "continuando"
    // falado ao chegar, ou no meio do plantão, diz de onde o médico VEM — comprometer
    // o turno seguinte com ele estende a cobertura por 12h que ninguém prometeu
    // (caso Uenderson 05/07/2026: "continuando 1363" às 07:03, ao chegar).
    if (toNextMs <= CONTINUATION_NEXT_BOUNDARY_WINDOW_MS) {
        return window.nextBoundaryAt;
    }
    return window.startedAt;
}

/**
 * Rótulo resultante de uma continuação IN-PLACE (mesmo posto, ocupação ativa).
 *
 * "P" só quando a linha atravessa a virada referenciada desde ANTES dela —
 * chegada de manhã que segue para a noite (caso Manuella). Um "continua"
 * repetido encontra como ativa a linha do BLOCO NOVO (started_at >= virada):
 * rebatizá-la de "P" dava cobertura de 24h a partir da noite (pagamento do
 * turno seguinte não trabalhado — classe Ana Beatriz, reintroduzida via
 * repetição em 03/08/2026). Reforço mantém o rótulo do bloco.
 */
export function resolveContinuationInPlaceShiftLabel(params: {
    existingStartedAt: Date;
    existingShiftLabel: string | null;
    fallbackShiftLabel: string;
    continuationAt: Date;
}) {
    return params.existingStartedAt.getTime() < resolveContinuationReferenceBoundary(params.continuationAt).getTime()
        ? "P"
        : (params.existingShiftLabel ?? params.fallbackShiftLabel);
}

/**
 * Fim agendado de uma continuação de intervenção.
 *
 * Extraído da lógica inline de continueInterventionOccupancy para dar paridade
 * estrutural e testabilidade ao lado de resolveRegulationContinuationScheduledEndAt.
 * A cobertura é emendada até o fim do bloco seguinte à virada referenciada pelo
 * aviso (um bloco discreto, nunca além). Nunca encurta um fim já agendado mais
 * distante.
 */
export function resolveInterventionContinuationScheduledEndAt(params: {
    existingScheduledEndAt: Date | null;
    continuationAt: Date;
}): Date {
    const referenceBoundary = resolveContinuationReferenceBoundary(params.continuationAt);
    const requiredEndAt = resolveOperationalShiftWindow(referenceBoundary).nextBoundaryAt;
    return params.existingScheduledEndAt
        && params.existingScheduledEndAt.getTime() > requiredEndAt.getTime()
        ? params.existingScheduledEndAt
        : requiredEndAt;
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
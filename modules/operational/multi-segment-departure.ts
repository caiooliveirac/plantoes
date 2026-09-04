import { resolveOperationalShiftWindow } from "@/modules/operational/board-rules";
import { EARLY_DEPARTURE_HALF_THRESHOLD_MINUTES } from "@/modules/operational/early-departure";
import { inferInterventionScheduledEndAt, inferRegulationScheduledEndAt } from "@/modules/operational/rules";

/**
 * Saída de um "P" antes de completar 6h do turno seguinte: o P não se cumpriu.
 *
 * O médico que declarou P às 07:15 e saiu 19:07 (ou 20:30) fez um SD e uma
 * sobra — não "um SN retirado com 7 min". Tratar a saída pela régua de
 * retirada do segundo turno produzia um SN "só banco de horas" na fila da
 * chefia e uma linha BANCO x0 no fechamento, que o admin apagava sem entender
 * e levava o SD junto (Gabriel Divino, 2033, 27/08/2026).
 *
 * Aqui a ocupação volta a ser o turno que foi cumprido: janela recortada no
 * fim do último segmento completo (19:15/07:15 na regulação, 19:00/07:00 na
 * intervenção) e rótulo do segmento quando só sobrou um. A sobra abaixo de 6h
 * vira banco pela matemática normal; 6h ou mais é plantão prestado e fica na
 * régua de meio/inteiro (classifyEarlyDeparture), por isso não recorta.
 *
 * Retorna null quando não há o que recortar: ocupação de um turno só, saída
 * no fim (ou depois) da janela, ou já com 6h+ no segmento corrente.
 */
export function resolveMultiSegmentDepartureTrim(params: {
    domain: "regulation" | "intervention";
    scheduledStartAt: Date | null | undefined;
    scheduledEndAt: Date | null | undefined;
    departureAt: Date;
}): { shiftLabel: "SD" | "SN" | "P"; scheduledEndAt: Date } | null {
    const { scheduledStartAt, scheduledEndAt, departureAt } = params;
    if (!scheduledStartAt || !scheduledEndAt) {
        return null;
    }
    if (departureAt.getTime() >= scheduledEndAt.getTime()) {
        return null;
    }

    const current = resolveOperationalShiftWindow(departureAt);
    // Segmento corrente é o primeiro da janela: ocupação de um turno só.
    if (scheduledStartAt.getTime() >= current.startedAt.getTime()) {
        return null;
    }

    const elapsedMinutes = Math.trunc((departureAt.getTime() - current.startedAt.getTime()) / 60000);
    if (elapsedMinutes >= EARLY_DEPARTURE_HALF_THRESHOLD_MINUTES) {
        return null;
    }

    const previousReference = new Date(current.startedAt.getTime() - 60000);
    const previous = resolveOperationalShiftWindow(previousReference);
    const previousLabel = previous.shiftLabel === "SD" || previous.shiftLabel === "SN" ? previous.shiftLabel : null;
    if (!previousLabel) {
        return null;
    }
    const trimmedEndAt = params.domain === "regulation"
        ? inferRegulationScheduledEndAt(previousReference, previousLabel, null)
        : inferInterventionScheduledEndAt(previousReference, previousLabel, null);
    if (!trimmedEndAt || trimmedEndAt.getTime() <= scheduledStartAt.getTime()) {
        return null;
    }
    if (trimmedEndAt.getTime() >= scheduledEndAt.getTime()) {
        return null;
    }

    // Sobrou só o primeiro segmento: vira SD/SN. Mais de um segmento completo
    // (P estendido por "continua") continua P, apenas mais curto.
    const singleSegmentLeft = scheduledStartAt.getTime() >= previous.startedAt.getTime();
    return {
        shiftLabel: singleSegmentLeft ? previousLabel : "P",
        scheduledEndAt: trimmedEndAt,
    };
}

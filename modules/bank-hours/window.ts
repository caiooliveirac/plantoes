import { DEPARTURE_GRACE_MINUTES } from "@/modules/bank-hours/calculator";
import { resolveOperationalShiftWindow } from "@/modules/operational/board-rules";
import {
    inferInterventionCoverageWindow,
    inferRegulationCoverageWindow,
} from "@/modules/operational/rules";

type Domain = "regulation" | "intervention";

function asDate(value: string | Date | null | undefined) {
    if (!value) {
        return null;
    }

    return value instanceof Date ? value : new Date(value);
}

// Formatter cacheado: construir Intl.DateTimeFormat por chamada dominava o CPU
// do fechamento mensal (perfil de 2026-07). Reuso é seguro — o objeto é imutável.
const SAO_PAULO_HOUR_MINUTE_FORMAT = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Sao_Paulo",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
});

function getSaoPauloHourMinute(date: Date) {
    const parts = SAO_PAULO_HOUR_MINUTE_FORMAT.formatToParts(date);

    const hour = Number(parts.find((part) => part.type === "hour")?.value ?? "0");
    const minute = Number(parts.find((part) => part.type === "minute")?.value ?? "0");

    return { hour, minute };
}

function normalizeRegulationBankHoursEnd(params: {
    resolvedScheduledEndAt: Date | null;
    operationalScheduledEndAt: Date | null;
}) {
    const { resolvedScheduledEndAt, operationalScheduledEndAt } = params;
    if (!resolvedScheduledEndAt || !operationalScheduledEndAt) {
        return resolvedScheduledEndAt;
    }

    if (resolvedScheduledEndAt.getTime() !== operationalScheduledEndAt.getTime()) {
        const localClock = getSaoPauloHourMinute(resolvedScheduledEndAt);
        const isOperationalQuarterBoundary = localClock.minute === 15 && (localClock.hour === 7 || localClock.hour === 19);
        if (!isOperationalQuarterBoundary) {
            return resolvedScheduledEndAt;
        }
    }

    return new Date(resolvedScheduledEndAt.getTime() - (DEPARTURE_GRACE_MINUTES * 60000));
}

/**
 * O "P" promete um turno a mais: a janela prevista vai até a virada seguinte. Quando
 * o plantão fecha antes dessa virada, a promessa não se cumpriu — e manter o previsto
 * lá na frente esconde a permanência extra (a saída cai "dentro do previsto" e não
 * gera hora extra em dobro). Aqui o previsto recua para a última virada operacional
 * que a saída de fato alcançou, nunca abaixo do fim do turno-base.
 *
 * Isso só mexe em crédito: saída antecipada não gera débito no calculator.
 */
function clampScheduledEndToDeparture(params: {
    scheduledEndAt: Date | null;
    baseScheduledEndAt: Date | null;
    actualEndAt: Date | null;
}) {
    const { scheduledEndAt, baseScheduledEndAt, actualEndAt } = params;
    if (!scheduledEndAt || !actualEndAt) {
        return scheduledEndAt;
    }

    const toleratedEndAt = new Date(actualEndAt.getTime() + (DEPARTURE_GRACE_MINUTES * 60000));
    if (scheduledEndAt.getTime() <= toleratedEndAt.getTime()) {
        return scheduledEndAt;
    }

    const reachedBoundary = resolveOperationalShiftWindow(toleratedEndAt).startedAt;
    const floor = baseScheduledEndAt ?? scheduledEndAt;
    const clamped = Math.min(scheduledEndAt.getTime(), Math.max(floor.getTime(), reachedBoundary.getTime()));
    return new Date(clamped);
}

export function resolveBankHoursScheduledWindow(params: {
    domain: Domain;
    startedAt: string | Date;
    shiftLabel: string | null;
    scheduledStartAt: string | Date | null;
    scheduledEndAt: string | Date | null;
    postCode?: string | null;
    /** Saída efetiva do plantão; presente, recorta a extensão do "P" não cumprida. */
    actualEndAt?: string | Date | null;
}) {
    const startedAt = asDate(params.startedAt);
    if (!startedAt) {
        throw new Error("Bank-hours window requires a valid startedAt.");
    }

    const explicitScheduledStartAt = asDate(params.scheduledStartAt);
    const explicitScheduledEndAt = asDate(params.scheduledEndAt);

    const actualEndAt = asDate(params.actualEndAt);

    if (params.domain === "intervention") {
        const window = inferInterventionCoverageWindow({
            startedAt,
            shiftLabel: params.shiftLabel,
            explicitScheduledStartAt,
            explicitScheduledEndAt,
        });
        // Sem rótulo: a janela do turno-base, sem a extensão do "P" — é o piso do recorte.
        const baseWindow = inferInterventionCoverageWindow({
            startedAt,
            shiftLabel: null,
            explicitScheduledStartAt,
            explicitScheduledEndAt: null,
        });

        return {
            ...window,
            scheduledEndAt: clampScheduledEndToDeparture({
                scheduledEndAt: window.scheduledEndAt,
                baseScheduledEndAt: baseWindow.scheduledEndAt,
                actualEndAt,
            }),
        };
    }

    const operationalWindow = inferRegulationCoverageWindow({
        startedAt,
        shiftLabel: params.shiftLabel,
        postCode: params.postCode ?? null,
        explicitScheduledStartAt,
        explicitScheduledEndAt: null,
    });
    const resolvedScheduledEndAt = normalizeRegulationBankHoursEnd({
        resolvedScheduledEndAt: explicitScheduledEndAt ?? operationalWindow.scheduledEndAt,
        operationalScheduledEndAt: operationalWindow.scheduledEndAt,
    });
    // Sem rótulo: a janela do turno-base, sem a extensão do "P" — é o piso do recorte.
    const baseWindow = inferRegulationCoverageWindow({
        startedAt,
        shiftLabel: null,
        postCode: params.postCode ?? null,
        explicitScheduledStartAt,
        explicitScheduledEndAt: null,
    });

    return {
        baseShiftLabel: operationalWindow.baseShiftLabel,
        scheduledStartAt: explicitScheduledStartAt ?? operationalWindow.scheduledStartAt,
        scheduledEndAt: clampScheduledEndToDeparture({
            scheduledEndAt: resolvedScheduledEndAt,
            baseScheduledEndAt: normalizeRegulationBankHoursEnd({
                resolvedScheduledEndAt: baseWindow.scheduledEndAt,
                operationalScheduledEndAt: baseWindow.scheduledEndAt,
            }),
            actualEndAt,
        }),
    };
}
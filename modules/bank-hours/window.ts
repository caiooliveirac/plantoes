import { DEPARTURE_GRACE_MINUTES } from "@/modules/bank-hours/calculator";
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

function getSaoPauloHourMinute(date: Date) {
    const parts = new Intl.DateTimeFormat("en-US", {
        timeZone: "America/Sao_Paulo",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
    }).formatToParts(date);

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

export function resolveBankHoursScheduledWindow(params: {
    domain: Domain;
    startedAt: string | Date;
    shiftLabel: string | null;
    scheduledStartAt: string | Date | null;
    scheduledEndAt: string | Date | null;
    postCode?: string | null;
}) {
    const startedAt = asDate(params.startedAt);
    if (!startedAt) {
        throw new Error("Bank-hours window requires a valid startedAt.");
    }

    const explicitScheduledStartAt = asDate(params.scheduledStartAt);
    const explicitScheduledEndAt = asDate(params.scheduledEndAt);

    if (params.domain === "intervention") {
        return inferInterventionCoverageWindow({
            startedAt,
            shiftLabel: params.shiftLabel,
            explicitScheduledStartAt,
            explicitScheduledEndAt,
        });
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

    return {
        baseShiftLabel: operationalWindow.baseShiftLabel,
        scheduledStartAt: explicitScheduledStartAt ?? operationalWindow.scheduledStartAt,
        scheduledEndAt: resolvedScheduledEndAt,
    };
}
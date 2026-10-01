/**
 * Lançamento administrativo de plantão passado (tela /admin/lancar-plantao).
 *
 * Módulo puro: resolve chegada/saída em instantes e calcula, com a MESMA régua
 * que o servidor grava (calculateGuardedBankHours), o que o banco de horas vai
 * ganhar ou perder — para o admin ver o número antes de confirmar.
 */
import { calculateGuardedBankHours, type BankHoursCalculationResult } from "@/modules/bank-hours/calculator";
import { inferInterventionCoverageWindow, inferRegulationCoverageWindow } from "@/modules/operational/rules";

export const MANUAL_SHIFT_LABELS = ["SD", "SN"] as const;
export type ManualShiftLabel = typeof MANUAL_SHIFT_LABELS[number];

/** Horário padrão de cada turno, para pré-preencher a tela. */
export const MANUAL_SHIFT_DEFAULT_TIMES: Record<ManualShiftLabel, { arrival: string; departure: string }> = {
    SD: { arrival: "07:00", departure: "19:00" },
    SN: { arrival: "19:00", departure: "07:00" },
};

function toInstant(date: string, time: string) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(time)) {
        throw new Error(`Use data AAAA-MM-DD e hora HH:MM (recebido: ${date} ${time}).`);
    }
    const instant = new Date(`${date}T${time}:00-03:00`);
    if (Number.isNaN(instant.getTime())) {
        throw new Error(`Data/hora invalida: ${date} ${time}.`);
    }
    return instant;
}

/**
 * Chegada no dia operacional; a saída é a primeira ocorrência da hora informada
 * DEPOIS da chegada (SN 19:00 → 07:00 cai no dia seguinte).
 */
export function resolveManualShiftInstants(params: { date: string; arrivalTime: string; departureTime: string }) {
    const startedAt = toInstant(params.date, params.arrivalTime);
    let departureAt = toInstant(params.date, params.departureTime);
    if (departureAt.getTime() <= startedAt.getTime()) {
        departureAt = new Date(departureAt.getTime() + 24 * 60 * 60 * 1000);
    }
    return { startedAt, departureAt };
}

export function previewManualShiftBankHours(params: {
    domain: "regulation" | "intervention";
    targetCode: string;
    shiftLabel: ManualShiftLabel;
    startedAt: Date;
    departureAt: Date;
}): {
    scheduledStartAt: Date;
    scheduledEndAt: Date;
    calculation: BankHoursCalculationResult;
} {
    const window = params.domain === "regulation"
        ? inferRegulationCoverageWindow({ startedAt: params.startedAt, shiftLabel: params.shiftLabel, postCode: params.targetCode })
        : inferInterventionCoverageWindow({ startedAt: params.startedAt, shiftLabel: params.shiftLabel });
    if (!window.scheduledStartAt || !window.scheduledEndAt) {
        throw new Error("Nao consegui inferir a janela prevista deste turno.");
    }
    return {
        scheduledStartAt: window.scheduledStartAt,
        scheduledEndAt: window.scheduledEndAt,
        calculation: calculateGuardedBankHours({
            scheduledStartAt: window.scheduledStartAt,
            scheduledEndAt: window.scheduledEndAt,
            actualStartAt: params.startedAt,
            actualEndAt: params.departureAt,
        }),
    };
}

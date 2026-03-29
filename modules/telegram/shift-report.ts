import { resolveOperationalShiftWindow } from "@/modules/operational/board-rules";
import type { InterventionBoardRow, RegulationBoardRow } from "@/services/board.service";

export interface TelegramShiftReportBoard {
    intervention: InterventionBoardRow[];
    regulation: RegulationBoardRow[];
}

type ShiftReportStatus = "confirmed" | "carryover_pending" | "waiting";

interface ShiftReportInterventionRow {
    row: InterventionBoardRow;
    status: ShiftReportStatus;
}

interface ShiftReportRegulationRow {
    row: RegulationBoardRow;
    status: ShiftReportStatus;
}

interface ShiftReportModel {
    shiftLabel: "SD" | "SN";
    generatedAt: string;
    intervention: ShiftReportInterventionRow[];
    regulation: ShiftReportRegulationRow[];
}

function formatDateTime(value: string | Date) {
    return new Intl.DateTimeFormat("pt-BR", {
        dateStyle: "short",
        timeStyle: "short",
        timeZone: "America/Sao_Paulo",
    }).format(new Date(value));
}

function formatHour(value: string | Date | null) {
    if (!value) {
        return "--:--";
    }

    return new Intl.DateTimeFormat("pt-BR", {
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
        timeZone: "America/Sao_Paulo",
    }).format(new Date(value));
}

function resolveInterventionShiftStatus(row: InterventionBoardRow, currentShiftLabel: "SD" | "SN"): ShiftReportStatus {
    if (row.status === "waiting") {
        return "waiting";
    }

    if (row.shiftLabel === currentShiftLabel || row.shiftLabel === "P") {
        return "confirmed";
    }

    return "carryover_pending";
}

function resolveRegulationShiftStatus(row: RegulationBoardRow, currentShiftLabel: "SD" | "SN"): ShiftReportStatus {
    if (row.status === "waiting") {
        return "waiting";
    }

    if (row.shiftLabel === currentShiftLabel || row.shiftLabel === "P") {
        return "confirmed";
    }

    return "carryover_pending";
}

function buildShiftReportModel(board: TelegramShiftReportBoard, reference: Date): ShiftReportModel {
    const shiftWindow = resolveOperationalShiftWindow(reference);

    return {
        shiftLabel: shiftWindow.shiftLabel,
        generatedAt: reference.toISOString(),
        intervention: board.intervention.map((row) => ({
            row,
            status: resolveInterventionShiftStatus(row, shiftWindow.shiftLabel),
        })),
        regulation: board.regulation.map((row) => ({
            row,
            status: resolveRegulationShiftStatus(row, shiftWindow.shiftLabel),
        })),
    };
}

function buildInterventionConfirmedLine(item: ShiftReportInterventionRow, currentShiftLabel: "SD" | "SN") {
    const name = item.row.doctorName ?? item.row.displayName ?? "médico não identificado";
    if (item.row.shiftLabel === "P") {
        return `✅ ${item.row.baseCode} - ${name} | P | chegada original ${formatHour(item.row.startedAt)} | cobre ${currentShiftLabel}`;
    }

    return `✅ ${item.row.baseCode} - ${name} | chegada ${formatHour(item.row.startedAt)} | ${item.row.shiftLabel ?? currentShiftLabel}`;
}

function buildInterventionCarryoverLine(item: ShiftReportInterventionRow, currentShiftLabel: "SD" | "SN") {
    const name = item.row.doctorName ?? item.row.displayName ?? "médico não identificado";
    return `🟡 ${item.row.baseCode} - ${name} | ${item.row.shiftLabel ?? "turno anterior"} desde ${formatHour(item.row.startedAt)} | ainda no quadro, mas não confirmado para ${currentShiftLabel}`;
}

function buildRegulationConfirmedLine(item: ShiftReportRegulationRow, currentShiftLabel: "SD" | "SN") {
    const name = item.row.doctorName ?? item.row.displayName ?? "médico não identificado";
    if (item.row.shiftLabel === "P") {
        return `✅ ${item.row.postCode} - ${name} | P | chegada original ${formatHour(item.row.startedAt)} | cobre ${currentShiftLabel}`;
    }

    return `✅ ${item.row.postCode} - ${name} | chegada ${formatHour(item.row.startedAt)} | ${item.row.shiftLabel ?? currentShiftLabel}`;
}

function buildRegulationCarryoverLine(item: ShiftReportRegulationRow, currentShiftLabel: "SD" | "SN") {
    const name = item.row.doctorName ?? item.row.displayName ?? "médico não identificado";
    return `🟡 ${item.row.postCode} - ${name} | ${item.row.shiftLabel ?? "turno anterior"} desde ${formatHour(item.row.startedAt)} | ainda visível no quadro, mas não confirmado para ${currentShiftLabel}`;
}

function listWaitingCodes(values: string[]) {
    if (values.length === 0) {
        return "- nenhum alvo pendente";
    }

    return values.join(", ");
}

export function buildTelegramShiftReport(params: {
    board: TelegramShiftReportBoard;
    reference: Date;
}) {
    const model = buildShiftReportModel(params.board, params.reference);
    const confirmedIntervention = model.intervention.filter((item) => item.status === "confirmed");
    const carryoverIntervention = model.intervention.filter((item) => item.status === "carryover_pending");
    const waitingIntervention = model.intervention.filter((item) => item.status === "waiting").map((item) => item.row.baseCode);
    const confirmedRegulation = model.regulation.filter((item) => item.status === "confirmed");
    const carryoverRegulation = model.regulation.filter((item) => item.status === "carryover_pending");
    const waitingRegulation = model.regulation.filter((item) => item.status === "waiting").map((item) => item.row.postCode);

    return [
        `📋 Relato do plantão ${model.shiftLabel} em ${formatDateTime(model.generatedAt)}.`,
        "Leitura por regra de negócio: quem ainda aparece no quadro vindo do turno anterior fica como pendência, não como entrada confirmada deste turno.",
        "",
        `Intervenção confirmada ${confirmedIntervention.length}/${model.intervention.length}:`,
        confirmedIntervention.length > 0
            ? confirmedIntervention.map((item) => buildInterventionConfirmedLine(item, model.shiftLabel)).join("\n")
            : "- nenhuma avançada confirmada para este turno",
        ...(carryoverIntervention.length > 0
            ? [
                "",
                "Intervenção ainda pendente por herança do turno anterior:",
                carryoverIntervention.map((item) => buildInterventionCarryoverLine(item, model.shiftLabel)).join("\n"),
            ]
            : []),
        ...(waitingIntervention.length > 0
            ? [
                "",
                `Intervenção sem aviso para ${model.shiftLabel}:`,
                `🔴 ${listWaitingCodes(waitingIntervention)}`,
            ]
            : []),
        "",
        `Regulação confirmada ${confirmedRegulation.length}/${model.regulation.length}:`,
        confirmedRegulation.length > 0
            ? confirmedRegulation.map((item) => buildRegulationConfirmedLine(item, model.shiftLabel)).join("\n")
            : "- nenhum ramal confirmado para este turno",
        ...(carryoverRegulation.length > 0
            ? [
                "",
                "Regulação ainda pendente por herança do turno anterior:",
                carryoverRegulation.map((item) => buildRegulationCarryoverLine(item, model.shiftLabel)).join("\n"),
            ]
            : []),
        ...(waitingRegulation.length > 0
            ? [
                "",
                `Regulação sem aviso para ${model.shiftLabel}:`,
                `🔴 ${listWaitingCodes(waitingRegulation)}`,
            ]
            : []),
    ].join("\n");
}
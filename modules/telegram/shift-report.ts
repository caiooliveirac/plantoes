import { isBeforeCurrentOperationalShift, resolveOperationalShiftWindow } from "@/modules/operational/board-rules";
import { formatDoctorSurfaceName } from "@/modules/doctors/directory";
import {
    compareTelegramInterventionCodes,
    compareTelegramRegulationCodes,
    sortTelegramInterventionCodes,
    sortTelegramRegulationCodes,
} from "@/modules/telegram/presentation-order";
import type { InterventionBoardRow, RegulationBoardRow } from "@/services/board.service";

export interface TelegramShiftReportBoard {
    intervention: InterventionBoardRow[];
    regulation: RegulationBoardRow[];
}

type ShiftReportStatus = "confirmed" | "carryover_pending" | "awaiting_news" | "waiting" | "disabled";

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

function compactDoctorName(input: { fullName?: string | null; displayName?: string | null; fallback?: string }) {
    const full = formatDoctorSurfaceName(input);
    const tokens = full.split(/\s+/).filter(Boolean);
    if (tokens.length <= 1) {
        return full;
    }

    const particles = new Set(["de", "da", "do", "dos", "das", "e"]);
    const suffixes = new Set(["Filho", "Neto", "Junior", "Jr", "Sobrinho"]);
    const first = tokens[0] ?? full;
    const filtered = tokens.filter((token) => !particles.has(token.toLowerCase()));
    const last = filtered[filtered.length - 1] ?? tokens[tokens.length - 1] ?? first;
    const previous = filtered[filtered.length - 2] ?? tokens[tokens.length - 2] ?? null;

    if (suffixes.has(last) && previous) {
        return `${first} ${previous} ${last}`;
    }

    return first === last ? first : `${first} ${last}`;
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

function resolveInterventionShiftStatus(row: InterventionBoardRow, currentShiftLabel: "SD" | "SN", reference: Date): ShiftReportStatus {
    if (row.status === "disabled") {
        return "disabled";
    }

    if (row.status === "waiting") {
        return "waiting";
    }

    if (row.shiftLabel === currentShiftLabel || row.shiftLabel === "P") {
        return "confirmed";
    }

    if (row.shiftLabel === null && !isBeforeCurrentOperationalShift(row.boardStartedAt ?? row.startedAt, reference)) {
        return "confirmed";
    }

    return "awaiting_news";
}

function resolveRegulationShiftStatus(row: RegulationBoardRow, currentShiftLabel: "SD" | "SN", reference: Date): ShiftReportStatus {
    if (row.status === "waiting") {
        return "waiting";
    }

    if (row.shiftLabel === currentShiftLabel || row.shiftLabel === "P") {
        return "confirmed";
    }

    if (row.shiftLabel === null && !isBeforeCurrentOperationalShift(row.boardStartedAt ?? row.startedAt, reference)) {
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
            status: resolveInterventionShiftStatus(row, shiftWindow.shiftLabel, reference),
        })),
        regulation: board.regulation.map((row) => ({
            row,
            status: resolveRegulationShiftStatus(row, shiftWindow.shiftLabel, reference),
        })),
    };
}

function buildInterventionConfirmedLine(item: ShiftReportInterventionRow, currentShiftLabel: "SD" | "SN") {
    const name = compactDoctorName({ fullName: item.row.doctorName, displayName: item.row.displayName, fallback: "médico não identificado" });
    if (item.row.shiftLabel === "P") {
        return `✅ ${item.row.baseCode} - ${name} | P desde ${formatHour(item.row.startedAt)}`;
    }

    return `✅ ${item.row.baseCode} - ${name} | chegada ${formatHour(item.row.startedAt)} | ${item.row.shiftLabel ?? currentShiftLabel}`;
}

function buildInterventionCarryoverLine(item: ShiftReportInterventionRow, currentShiftLabel: "SD" | "SN") {
    const name = compactDoctorName({ fullName: item.row.doctorName, displayName: item.row.displayName, fallback: "médico não identificado" });
    return `🟡 ${item.row.baseCode} - ${name} | ${item.row.shiftLabel ?? "turno anterior"} desde ${formatHour(item.row.startedAt)} | não confirmado para ${currentShiftLabel}`;
}

function buildInterventionAwaitingNewsLine(item: ShiftReportInterventionRow, currentShiftLabel: "SD" | "SN") {
    const name = compactDoctorName({ fullName: item.row.doctorName, displayName: item.row.displayName, fallback: "médico não identificado" });
    const lastShiftLabel = item.row.shiftLabel ?? "turno anterior";
    const since = item.row.startedAt ? ` desde ${formatHour(item.row.startedAt)}` : "";
    return `🔴 ${item.row.baseCode} - ${name} | ${lastShiftLabel}${since} | sem confirmação para ${currentShiftLabel}`;
}

function buildInterventionDisabledLine(item: ShiftReportInterventionRow) {
    const disabledAt = item.row.disabledAt ? ` às ${formatHour(item.row.disabledAt)}` : "";
    const reason = item.row.disabledReason?.trim() ? ` | ${item.row.disabledReason.trim()}` : "";
    return `⚫ ${item.row.baseCode} - desativada${disabledAt}${reason}`;
}

function buildRegulationConfirmedLine(item: ShiftReportRegulationRow, currentShiftLabel: "SD" | "SN") {
    const name = compactDoctorName({ fullName: item.row.doctorName, displayName: item.row.displayName, fallback: "médico não identificado" });
    if (item.row.shiftLabel === "P") {
        return `✅ ${item.row.postCode} - ${name} | P desde ${formatHour(item.row.startedAt)}`;
    }

    return `✅ ${item.row.postCode} - ${name} | chegada ${formatHour(item.row.startedAt)} | ${item.row.shiftLabel ?? currentShiftLabel}`;
}

function buildRegulationCarryoverLine(item: ShiftReportRegulationRow, currentShiftLabel: "SD" | "SN") {
    const name = compactDoctorName({ fullName: item.row.doctorName, displayName: item.row.displayName, fallback: "médico não identificado" });
    return `🟡 ${item.row.postCode} - ${name} | ${item.row.shiftLabel ?? "turno anterior"} desde ${formatHour(item.row.startedAt)} | não confirmado para ${currentShiftLabel}`;
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
    const confirmedIntervention = model.intervention
        .filter((item) => item.status === "confirmed")
        .sort((left, right) => compareTelegramInterventionCodes(left.row.baseCode, right.row.baseCode));
    const awaitingNewsIntervention = model.intervention
        .filter((item) => item.status === "awaiting_news")
        .sort((left, right) => compareTelegramInterventionCodes(left.row.baseCode, right.row.baseCode));
    const disabledIntervention = model.intervention
        .filter((item) => item.status === "disabled")
        .sort((left, right) => compareTelegramInterventionCodes(left.row.baseCode, right.row.baseCode));
    const waitingIntervention = sortTelegramInterventionCodes(model.intervention.filter((item) => item.status === "waiting").map((item) => item.row.baseCode));
    const confirmedRegulation = model.regulation
        .filter((item) => item.status === "confirmed")
        .sort((left, right) => compareTelegramRegulationCodes(left.row.postCode, right.row.postCode));
    const carryoverRegulation = model.regulation
        .filter((item) => item.status === "carryover_pending")
        .sort((left, right) => compareTelegramRegulationCodes(left.row.postCode, right.row.postCode));
    const waitingRegulation = sortTelegramRegulationCodes(model.regulation.filter((item) => item.status === "waiting").map((item) => item.row.postCode));
    const interventionOperationalTotal = model.intervention.length - disabledIntervention.length;

    const hasCarryover = awaitingNewsIntervention.length > 0 || carryoverRegulation.length > 0;

    return [
        `📋 Plantão ${model.shiftLabel} — ${formatDateTime(model.generatedAt)}`,
        ...(hasCarryover ? ["Herança do turno anterior = pendência, não entrada confirmada."] : []),
        "",
        `🚑 Intervenção ${confirmedIntervention.length}/${interventionOperationalTotal} confirmadas | ${awaitingNewsIntervention.length} herança | ${waitingIntervention.length} sem aviso | ${disabledIntervention.length} desativadas`,
        "",
        confirmedIntervention.length > 0
            ? confirmedIntervention.map((item) => buildInterventionConfirmedLine(item, model.shiftLabel)).join("\n")
            : "- nenhuma avançada confirmada para este turno",
        ...(awaitingNewsIntervention.length > 0
            ? [
                "",
                "Herança sem confirmação:",
                awaitingNewsIntervention.map((item) => buildInterventionAwaitingNewsLine(item, model.shiftLabel)).join("\n"),
            ]
            : []),
        ...(waitingIntervention.length > 0
            ? [
                "",
                `Sem aviso (${waitingIntervention.length}):`,
                `🔴 ${listWaitingCodes(waitingIntervention)}`,
            ]
            : []),
        ...(disabledIntervention.length > 0
            ? [
                "",
                "Desativadas:",
                disabledIntervention.map((item) => buildInterventionDisabledLine(item)).join("\n"),
            ]
            : []),
        "",
        `📞 Regulação ${confirmedRegulation.length}/${model.regulation.length} confirmados | ${carryoverRegulation.length} herança | ${waitingRegulation.length} sem aviso`,
        "",
        confirmedRegulation.length > 0
            ? confirmedRegulation.map((item) => buildRegulationConfirmedLine(item, model.shiftLabel)).join("\n")
            : "- nenhum ramal confirmado para este turno",
        ...(carryoverRegulation.length > 0
            ? [
                "",
                "Herança sem confirmação:",
                carryoverRegulation.map((item) => buildRegulationCarryoverLine(item, model.shiftLabel)).join("\n"),
            ]
            : []),
        ...(waitingRegulation.length > 0
            ? [
                "",
                `Sem aviso (${waitingRegulation.length}):`,
                `🔴 ${listWaitingCodes(waitingRegulation)}`,
            ]
            : []),
    ].join("\n");
}
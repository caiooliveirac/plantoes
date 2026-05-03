/**
 * Telegram Bot Processing Service (god module — extraction in progress)
 *
 * Purpose: Processes all Telegram webhook messages, dispatching arrivals,
 * departures, continuations, commands, name resolution, batch processing,
 * departure corrections, meal break routing, and admin commands.
 *
 * Source of truth for: Telegram message lifecycle (ingest → parse → resolve → apply → reply).
 *
 * Key flows:
 *   1. processTelegramUpdate() — webhook entry point, routes to handlers
 *   2. applyParsedEntry() — writes regulation/intervention occupancies
 *   3. queuePendingNameSelection/DepartureJustification/DepartureCorrection — async resolution
 *   4. handlePendingNameSelectionReply/DepartureJustificationReply/DepartureCorrectionReply — reply processing
 *
 * Extracted submodules:
 *   - departure-flow.ts: Late departure reasons, correction candidates, batch keywords
 *   - name-resolution.ts: Doctor name matching algorithms
 *   - parser.ts: Message text parsing (arrival/departure/continuation)
 *   - commands.ts: Command text detection and parsing
 *   - replies.ts: Reply text generation
 *   - meal-breaks.ts: Meal break scheduling and management
 *
 * DANGER: This file still holds ~5600 lines. Changes here risk silent regressions.
 * Always run the full test suite after modifications.
 *
 * Invariants:
 *   - Every Telegram message gets exactly one status: applied, pending_*, superseded, ignored, error
 *   - Departure corrections require justification if the event time exceeds scheduled shift end
 *   - Continuations preserve the original arrival time and create a new occupancy window
 */
import { and, desc, eq, gte, inArray, isNull, lte, lt, ne } from "drizzle-orm";
import { getDb } from "@/db";
import {
    doctors,
    interventionBases,
    interventionOccupancies,
    regulationOccupancies,
    regulationPosts,
    telegramIngestedMessages,
    userRoles,
    users,
} from "@/db/schema";
import { applyBankHoursBalanceOverride, syncBankHoursByContinuityGroup } from "@/modules/bank-hours/service";
import { extractDoctorAliases, formatDoctorSurfaceName } from "@/modules/doctors/directory";
import { normalizeDoctorName } from "@/modules/doctors/importer";
import { createDoctorDirectoryEntry, updateDoctorDirectoryEntry } from "@/modules/doctors/service";
import { continueInterventionOccupancy, deactivateInterventionBase, endInterventionOccupancy, reactivateInterventionBase, startInterventionOccupancy } from "@/modules/intervention/service";
import { getSaoPauloParts, requiresOvertimeJustification, resolveImplicitOccupancyExpiry, resolveOperationalShiftWindow, resolveProlongedShiftExpiry } from "@/modules/operational/board-rules";
import type { OccupancyShiftLabel } from "@/modules/operational/board-rules";
import { HALF_SHIFT_ROLE_LABEL, isHalfShiftRoleLabel } from "@/modules/operational/half-shift";
import { correctInterventionOccupancy, correctRegulationOccupancy, removeInterventionOccupancyRecord, removeRegulationOccupancyRecord, transferOperationalOccupancy } from "@/modules/operational/corrections";
import { normalizeOperationalRoleLabel, resolveFixedOperationalRole } from "@/modules/operational/roles";
import { resolveTelegramEventTime, resolveForcedDayEventTime } from "@/modules/operational/rules";
import { continueRegulationOccupancy, deactivateRegulationPost, endRegulationOccupancy, reactivateRegulationPost, startRegulationOccupancy } from "@/modules/regulation/service";
import {
    compareDepartureCorrectionCandidates,
    deserializeDepartureCorrectionCandidate,
    getPendingDepartureJustificationAttemptCount,
    normalizeTelegramReasonText,
    resolveDepartureCorrectionReferenceAt,
    resolveDepartureJustificationPromptKind,
    serializeDepartureCorrectionCandidate,
    stripTelegramOperationalFragments,
    TELEGRAM_DEPARTURE_CORRECTION_WINDOW_MS,
    type TelegramDepartureCorrectionCandidate,
    type SerializedTelegramDepartureCorrectionCandidate,
} from "@/modules/telegram/departure-flow";
import {
    isTelegramDoctorAdminCommandText,
    parseTelegramDoctorAdminCommand,
    TELEGRAM_DOCTOR_ADMIN_COMMAND_USAGE,
    isTelegramUndoCommandText,
    parseTelegramUndoCommand,
} from "@/modules/telegram/admin-commands";
import { getUndoableActions, undoAction, type UndoableEntry } from "@/modules/operational/undo";
import {
    buildDeparturePriorityCommandUsageReply,
    isTelegramDeparturePriorityCommandText,
    parseTelegramDeparturePriorityCommand,
    runTelegramDeparturePriorityCommand,
} from "@/modules/telegram/departure-priority";
import {
    isTelegramShiftReportCommandText,
    parseTelegramShiftReportCommand,
} from "@/modules/telegram/shift-report-commands";
import {
    isTelegramSummaryReportCommandText,
    parseTelegramSummaryReportCommand,
    TELEGRAM_SUMMARY_REPORT_USAGE,
} from "@/modules/telegram/summary-report-commands";
import {
    isTelegramBankHoursCommandText,
    parseTelegramBankHoursCommand,
    TELEGRAM_BANK_HOURS_USAGE,
} from "@/modules/telegram/bank-hours-commands";
import {
    isTelegramDepartureReportCommandText,
    parseTelegramDepartureReportCommand,
    TELEGRAM_DEPARTURE_REPORT_USAGE,
} from "@/modules/telegram/departure-report-commands";
import {
    isTelegramSlotAuditCommandText,
    parseTelegramSlotAuditCommand,
    TELEGRAM_SLOT_AUDIT_USAGE,
} from "@/modules/telegram/slot-audit-commands";
import {
    isTelegramPaymentAdminCommandText,
    parseTelegramPaymentAdminCommand,
    TELEGRAM_PAYMENT_CORRECTION_USAGE,
    TELEGRAM_PAYMENT_REPORT_USAGE,
} from "@/modules/telegram/payment-commands";
import { buildTelegramDepartureReport, resolveTelegramDepartureReportRequest } from "@/modules/telegram/departure-report";
import { buildTelegramSlotAuditMessages } from "@/modules/telegram/slot-audit-report";
import { buildTelegramSummaryReport } from "@/modules/telegram/summary-report";
import {
    buildMealBreakConsistencyAdminReply,
    buildMealBreakCommandUsageReply,
    buildMealBreakExcludeCommandUsageReply,
    buildMealBreakPriorityCommandUsageReply,
    buildMealBreakErrorReply,
    buildMealBreakStageKeyboard,
    getCurrentOperationalMealBreakSession,
    handleTelegramMealBreakReply,
    isTelegramMealBreakCommandText,
    isTelegramMealBreakExcludeCommandText,
    isTelegramMealBreakPriorityCommandText,
    parseTelegramMealBreakCommand,
    parseTelegramMealBreakExcludeCommand,
    parseTelegramMealBreakPriorityCommand,
    resolveMealBreakLogDetails,
    shouldPrioritizeTelegramMealBreakReply,
    resolveTelegramMealBreakSenderId,
    runTelegramMealBreakCommand,
    runTelegramMealBreakExcludeCommand,
    runTelegramMealBreakPriorityCommand,
    sendTelegramMealBreakMessages,
} from "@/modules/telegram/meal-breaks";
import { buildTelegramShiftReport } from "@/modules/telegram/shift-report";
import { getTelegramAdminUserIds, getTelegramAnnouncementChatIds, getTelegramChiefUserIds, isTelegramChatAllowed, isTelegramPrivateControlUserId } from "@/modules/telegram/config";
import {
    isTelegramAdminOnlyCommand,
    isTelegramDepartureCorrectionCommandText,
    parseTelegramCommand,
    parseTelegramDepartureCorrectionCommand,
} from "@/modules/telegram/commands";
import { buildTelegramCommandSuggestionReply, suggestTelegramCommandHelp, type TelegramRecentSenderMessage } from "@/modules/telegram/command-suggestions";
import { isCasualTelegramMessage, looksLikeDepartureMessage, looksLikeMealBreakMessage, looksLikeOperationalMetaConversation, parseMessage, parseMessageMulti, parseTelegramBatchLines, type ParsedMessage } from "@/modules/telegram/parser";
import type { TelegramUpdate } from "@/modules/telegram/api";
import { buildChoiceKeyboard, REMOVE_KEYBOARD, sendMessage } from "@/modules/telegram/api";
import { pickCandidateFromReply, pickConfidentDoctorCandidate, resolveDoctorCandidates, type TelegramDoctorCandidate, type TelegramDoctorDirectoryEntry } from "@/modules/telegram/name-resolution";
import { buildCandidatePromptReply, buildGroupCorrectionAnnouncement, buildNameUnresolvedReply, buildTelegramBatchApplyReply, buildTelegramBatchReviewReply, pickTelegramReply } from "@/modules/telegram/replies";
import { getOperationalBoard, getPaymentAllocationBoard, type PaymentAllocationBoard, type PaymentAllocationRow } from "@/services/board.service";
import { getOperationalSlotAuditReport } from "@/services/slot-audit.service";

import {
    isBatchConfirmationKeyword,
    isBatchCancelKeyword,
    parseTelegramStandaloneTime,
    pickLikelyDepartureCorrectionCandidate,
    resolveTelegramEligibleLateDepartureReason,
    requiresTelegramDepartureAdjustmentJustification,
} from "@/modules/telegram/departure-flow";
import { compareTelegramInterventionCodes } from "@/modules/telegram/presentation-order";

// Re-export from departure-flow so existing imports from "@/modules/telegram/service" keep working
export {
    isBatchConfirmationKeyword,
    isBatchCancelKeyword,
    parseTelegramStandaloneTime,
    pickLikelyDepartureCorrectionCandidate,
    resolveTelegramEligibleLateDepartureReason,
    requiresTelegramDepartureAdjustmentJustification,
} from "@/modules/telegram/departure-flow";

interface PendingNameResolutionData {
    parsed: {
        sector: "REGULATION" | "INTERVENTION";
        baseCode: string;
        arrivalTime: string | null;
        shiftType: "SD" | "SN" | "P" | null;
        roleFunction: string | null;
        isShadow?: boolean;
        isDeparture: boolean;
        isContinuation: boolean;
        isReassignment: boolean;
    };
    candidates: Array<{ id: string; fullName: string; displayName: string | null; normalizedName: string }>;
    originalText: string;
    originalEventAt: string;
    originalReferenceAt?: string;
}

interface PendingDepartureJustificationData {
    parsed: {
        sector: "REGULATION" | "INTERVENTION";
        baseCode: string;
        arrivalTime: string | null;
        shiftType: "SD" | "SN" | "P" | null;
        roleFunction: string | null;
        isShadow?: boolean;
        isDeparture: boolean;
        isContinuation: boolean;
        isReassignment: boolean;
    };
    resolvedDoctor: ResolvedTelegramDoctorRef;
    originalText: string;
    originalEventAt: string;
    originalReferenceAt?: string;
    invalidJustificationAttempts?: number;
}

interface PendingDepartureCorrectionData {
    resolvedDoctor: ResolvedTelegramDoctorRef;
    candidate: SerializedTelegramDepartureCorrectionCandidate;
    originalText: string;
}

interface PendingCruCoiRamalData {
    location: "CRU" | "COI";
    originalText: string;
    originalEventAt: string;
    originalReferenceAt?: string;
    senderName: string | null;
}

interface PendingBatchConfirmationEntry {
    lineNumber: number;
    rawLine: string;
    parsed: OperationalParsedEntry;
    resolvedDoctor: ResolvedTelegramDoctorRef;
    eventAt: string;
}

interface PendingBatchConfirmationData {
    entries: PendingBatchConfirmationEntry[];
    originalText: string;
    originalMessageId: number;
}

interface TelegramBatchReviewIssue {
    lineNumber: number;
    rawLine: string;
    reason: string;
}

interface PreparedBatchEntry {
    lineNumber: number;
    rawLine: string;
    parsed: OperationalParsedEntry;
    resolvedDoctor: ResolvedTelegramDoctorRef;
    eventAt: Date;
}

interface ResolvedTelegramDoctorRef {
    id: string;
    fullName: string;
    displayName: string | null;
}

type OperationalParsedEntry = PendingNameResolutionData["parsed"];

interface TelegramOperationalContinuityOccupancy {
    domain: "regulation" | "intervention";
    occupancyId: string;
    continuityGroupId: string;
    doctorId: string;
    startedAt: Date;
    boardStartedAt: Date | null;
    endedAt: Date | null;
    actualEndedAt: Date | null;
    shiftLabel: string | null;
}

const TELEGRAM_CONTINUITY_LINK_WINDOW_MS = 18 * 60 * 60 * 1000;
const TELEGRAM_RECENT_CLOSED_CONTINUITY_LINK_WINDOW_MS = 2 * 60 * 60 * 1000;
const TELEGRAM_HALF_SHIFT_AUTO_END_HHMM = "17:00";
const TELEGRAM_HALF_SHIFT_ALREADY_CLOSED_ERROR = "half_shift_already_closed";

interface TelegramCommandActor {
    userId: string | null;
    roles: Array<"admin" | "chief">;
    senderName: string;
    senderTelegramId: string | null;
}

type TelegramReviewReason =
    | "command_parse_failed"
    | "departure_low_confidence_rephrase_required"
    | "departure_justification_required"
    | "doctor_not_resolved"
    | "location_without_ramal"
    | "low_confidence_no_name"
    | "meal_break_outside_flow"
    | "no_operational_match"
    | "pending_name_selection";

const TELEGRAM_REVIEW_QUEUE = "telegram_input_format_review";

function canManageTelegramBatch(message: TelegramUpdate["message"]) {
    return message?.chat.type === "private" && isTelegramPrivateControlUserId(message.from?.id);
}

async function canManagePrivateMealBreak(message: TelegramUpdate["message"]) {
    if (message?.chat.type !== "private") {
        return true;
    }

    const actor = await resolveTelegramCommandActor(message);
    return Boolean(actor?.roles.includes("admin"));
}

function canRunPrivateAdminSlotAudit(message: TelegramUpdate["message"]) {
    if (message?.chat.type !== "private") {
        return false;
    }

    const senderTelegramId = message.from?.id ? String(message.from.id) : null;
    return Boolean(senderTelegramId && getTelegramAdminUserIds().includes(senderTelegramId));
}

function isPendingBatchConfirmationData(value: unknown): value is PendingBatchConfirmationData {
    if (!value || typeof value !== "object") {
        return false;
    }

    const candidate = value as Record<string, unknown>;
    return Array.isArray(candidate.entries) && typeof candidate.originalText === "string";
}

function isTelegramJustificationRequiredError(errorMessage: string) {
    return errorMessage.includes("Justificativa obrigatoria");
}

function buildBatchIssueReason(params: {
    parsed: ParsedMessage;
    doctorQuery: string | null;
    candidates: TelegramDoctorCandidate[];
}) {
    if (!params.parsed.baseCode) {
        return "faltou base ou ramal";
    }

    if (params.parsed.isDeparture) {
        return "saida em lote ainda pede ajuste individual";
    }

    if (!params.doctorQuery) {
        return "faltou nome do medico";
    }

    if (params.candidates.length > 0) {
        const suggestions = params.candidates.slice(0, 2).map((candidate) => candidate.fullName).join(" ou ");
        return `nome ambiguo, confirme como ${suggestions}`;
    }

    return "nome do medico nao reconhecido";
}

async function findPendingBatchConfirmation(chatId: string, senderTelegramId: string) {
    const db = getDb();
    return db.query.telegramIngestedMessages.findFirst({
        where: and(
            eq(telegramIngestedMessages.chatId, chatId),
            eq(telegramIngestedMessages.senderTelegramId, senderTelegramId),
            eq(telegramIngestedMessages.status, "pending_batch_confirmation"),
        ),
        orderBy: [desc(telegramIngestedMessages.createdAt)],
    });
}

function isTelegramContinuationEntry(parsed: OperationalParsedEntry) {
    return !parsed.isDeparture && parsed.isContinuation;
}

function isTelegramContinuationIntent(parsed: OperationalParsedEntry) {
    return !parsed.isDeparture && (parsed.isContinuation || parsed.shiftType === "P");
}

export function shouldTreatTelegramArrivalAsContinuation(params: {
    sector: "REGULATION" | "INTERVENTION";
    isDeparture: boolean;
    isContinuation: boolean;
    incomingShiftLabel?: string | null;
    activeShiftLabel?: string | null;
}) {
    if (params.isDeparture) {
        return false;
    }

    if (params.isContinuation) {
        return true;
    }

    if (params.sector === "REGULATION") {
        if (params.incomingShiftLabel === "P") {
            return params.activeShiftLabel === "SD"
                || params.activeShiftLabel === "SN"
                || params.activeShiftLabel === "P";
        }

        // Explicit cross-shift updates in regulation must keep continuity instead of opening
        // a brand-new arrival (ex.: SD→SN, P→SN, SN→SD, P→SD).
        if (
            (params.incomingShiftLabel === "SN" && (params.activeShiftLabel === "SD" || params.activeShiftLabel === "P"))
            || (params.incomingShiftLabel === "SD" && (params.activeShiftLabel === "SN" || params.activeShiftLabel === "P"))
        ) {
            return true;
        }

        return false;
    }

    if (params.incomingShiftLabel === "P") {
        return params.activeShiftLabel === "SD"
            || params.activeShiftLabel === "SN"
            || params.activeShiftLabel === "P";
    }

    if (
        params.incomingShiftLabel
        && params.activeShiftLabel
        && params.incomingShiftLabel !== params.activeShiftLabel
    ) {
        return true;
    }

    return params.activeShiftLabel === "P";
}

export function shouldTreatTelegramArrivalAsImplicitReassignment(params: {
    sector: "REGULATION" | "INTERVENTION";
    baseCode: string | null;
    arrivalTime?: string | null;
    shiftType?: string | null;
    roleFunction?: string | null;
    isDeparture: boolean;
    isContinuation: boolean;
    isReassignment?: boolean;
    activeSector?: "REGULATION" | "INTERVENTION" | null;
    activeBaseCode?: string | null;
}) {
    if (!params.baseCode) {
        return false;
    }

    if (params.isDeparture || params.isContinuation || params.isReassignment) {
        return false;
    }

    if (params.arrivalTime || params.shiftType || params.roleFunction) {
        return false;
    }

    if (!params.activeSector || !params.activeBaseCode) {
        return false;
    }

    // Keep implicit remanejamento conservative: same domain, only target switch.
    return params.activeSector === params.sector && params.activeBaseCode !== params.baseCode;
}

export function shouldLinkTelegramArrivalToContinuitySource(params: {
    parsed: OperationalParsedEntry;
    sourceShiftLabel?: string | null;
}) {
    return shouldTreatTelegramArrivalAsContinuation({
        sector: params.parsed.sector,
        isDeparture: params.parsed.isDeparture,
        isContinuation: params.parsed.isContinuation,
        incomingShiftLabel: params.parsed.shiftType,
        activeShiftLabel: params.sourceShiftLabel,
    });
}

function resolveTelegramParsedAction(parsed: OperationalParsedEntry) {
    if (parsed.isDeparture) {
        return "departure";
    }

    return isTelegramContinuationEntry(parsed) ? "continuation" : "arrival";
}

function resolveTelegramContinuationMode(parsed: OperationalParsedEntry) {
    if (!isTelegramContinuationIntent(parsed)) {
        return "none";
    }

    if (parsed.shiftType === "P" && parsed.isContinuation) {
        return "explicit_p_with_wording";
    }

    if (parsed.shiftType === "P") {
        return "explicit_p";
    }

    return "wording";
}

export function resolveTelegramSuccessReplyKind(params: {
    parsed: OperationalParsedEntry;
    successKind?: "standard" | "departure_adjusted";
    forceContinuation?: boolean;
    forceReassignment?: boolean;
    forceHalfShift?: boolean;
}) {
    if (params.forceReassignment || params.parsed.isReassignment) {
        return "reassignment_recorded";
    }

    if (params.parsed.isDeparture) {
        return params.successKind === "departure_adjusted" ? "departure_adjusted" : "departure_recorded";
    }

    if (params.forceContinuation || isTelegramContinuationEntry(params.parsed)) {
        return "continuation_recorded";
    }

    if (params.forceHalfShift) {
        return "half_shift_assumed";
    }

    if (params.parsed.sector === "INTERVENTION" && params.parsed.shiftType === "P") {
        return "arrival_p_recorded";
    }

    return "arrival_recorded";
}

export function buildTelegramContinuationSourceHint(params: {
    continuationFrom?: string | null;
    targetCode?: string | null;
    isContinuationReply: boolean;
}) {
    if (!params.isContinuationReply) {
        return "";
    }

    const sourceCode = params.continuationFrom?.trim() || null;
    const targetCode = params.targetCode?.trim() || null;
    if (!sourceCode || !targetCode || sourceCode === targetCode) {
        return "";
    }

    return `\n\n🔁 Mudanca confirmada: *${sourceCode}* → *${targetCode}* mantendo a mesma continuidade.`;
}

export function resolveTelegramShadowFlag(parsed: Pick<OperationalParsedEntry, "isDeparture" | "isShadow">, messageText: string) {
    if (parsed.isDeparture) {
        return false;
    }

    if (parsed.isShadow) {
        return true;
    }

    const normalized = messageText
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .toUpperCase();
    return /\b(?:SOMBRA|SHADOW)\b/.test(normalized);
}

function resolveHalfShiftScheduledEndAt(referenceAt: Date) {
    return resolveForcedDayEventTime(referenceAt, TELEGRAM_HALF_SHIFT_AUTO_END_HHMM, 0);
}

function shouldAssumeTelegramHalfShift(params: {
    parsed: OperationalParsedEntry;
    eventAt: Date;
    effectiveShiftType: string | null;
}) {
    if (params.parsed.sector !== "REGULATION" || params.parsed.isDeparture || params.parsed.isContinuation) {
        return false;
    }

    const normalizedShift = (params.effectiveShiftType ?? "").toUpperCase();
    if (normalizedShift && normalizedShift !== "SD") {
        return false;
    }

    const parts = getSaoPauloParts(params.eventAt);
    const minuteOfDay = (parts.hour * 60) + parts.minute;
    return minuteOfDay >= (10 * 60 + 30) && minuteOfDay < (17 * 60);
}

function appendTelegramOperationalNote(existingNotes: string | null | undefined, marker: string, messageText: string) {
    const nextEntry = `[${marker}] ${messageText}`;
    return [existingNotes?.trim(), nextEntry].filter(Boolean).join("\n");
}

function buildTelegramArrivalExample(params: {
    doctorName?: string | null;
    target?: string | null;
    time?: string | null;
}) {
    const compactName = params.doctorName?.trim() || "Vagner";
    const target = params.target?.trim() || "USB-01";
    const time = params.time?.trim() || "07:00";
    return `${compactName} ${target} ${time}`;
}

function buildTelegramDepartureExample(params: {
    doctorName?: string | null;
    target?: string | null;
    time?: string | null;
}) {
    const compactName = params.doctorName?.trim() || "Vagner";
    const target = params.target?.trim() || "PR03";
    const time = params.time?.trim() || "19:20";
    return `${compactName} saindo ${target} ${time} porque fui liberado pela chefia`;
}

function buildStructuredTelegramDepartureHint(params: {
    doctorName?: string | null;
    target?: string | null;
    time?: string | null;
}) {
    return `\n\nFormato mais seguro para saída: ${buildTelegramDepartureExample(params)}`;
}

const CRU_COI_LOCATION_PATTERN = /\b(CRU|COI)\b/i;

const COI_EXAMPLE_RAMAIS = ["1366", "1367", "1368"];
const CRU_EXAMPLE_RAMAIS = ["1321", "1361", "2031"];

export function detectLocationWithoutRamal(text: string): { location: "CRU" | "COI" } | null {
    const normalized = text.toUpperCase().replace(/[^A-Z0-9\s]/g, " ");
    const match = normalized.match(CRU_COI_LOCATION_PATTERN);
    if (!match) return null;
    const hasRamal = /\b\d{4}\b/.test(normalized);
    const hasBase = /\b[A-Z]{2}\d{2}\b/.test(normalized);
    if (hasRamal || hasBase) return null;
    return { location: match[1].toUpperCase() as "CRU" | "COI" };
}

export function buildLocationWithoutRamalReply(params: {
    senderName: string;
    location: "CRU" | "COI";
    shiftLabel: string | null;
    time: string | null;
    interactive?: boolean;
}) {
    const name = params.senderName || "Fulano";
    const locationFull = params.location === "COI"
        ? "Centro de Operações Integrado (COI)"
        : "Central de Regulação Urbana (CRU)";
    const exampleRamais = params.location === "COI" ? COI_EXAMPLE_RAMAIS : CRU_EXAMPLE_RAMAIS;
    const exampleRamal = exampleRamais[Math.floor(Math.random() * exampleRamais.length)];
    const shift = params.shiftLabel || "SD";
    const time = params.time || "07:00";

    return [
        `⚠️🏢 Recebi sua mensagem, mas "${params.location}" sozinho não é suficiente para eu registrar.`,
        ``,
        `O ${locationFull} tem vários ramais.`,
        `Eu preciso saber *exatamente em qual ramal* o médico vai ficar.`,
        ``,
        `🚫 Assim NÃO funciona:`,
        `  _${name} ${params.location} ${shift} ${time}_`,
        ``,
        `✅ Assim FUNCIONA:`,
        `  _${name} ${exampleRamal} ${shift} ${time}_`,
        ``,
        `📋 Ramais do ${params.location}:`,
        ...exampleRamais.map((r) => `  • ${r}`),
        ``,
        `👉 TARM ou chefia: perguntem ao médico em qual ramal ele está sentado e reenviem a mensagem com o número do ramal no lugar de "${params.location}".`,
        ``,
        `Exemplo pronto para copiar e ajustar:`,
        `_${name} ${exampleRamal} ${shift} ${time}_`,
        ...(params.interactive
            ? [``, `💡 Ou responda *apenas* com o número do ramal (ex: _${exampleRamal}_) que eu completo o registro automaticamente.`]
            : []),
    ].join("\n");
}

function toTelegramReviewParsedSnapshot(parsed: OperationalParsedEntry | null | undefined) {
    if (!parsed) {
        return null;
    }

    return {
        sector: parsed.sector,
        baseCode: parsed.baseCode,
        arrivalTime: parsed.arrivalTime,
        shiftType: parsed.shiftType,
        roleFunction: parsed.roleFunction,
        isShadow: parsed.isShadow ?? false,
        isDeparture: parsed.isDeparture,
        isContinuation: parsed.isContinuation,
        isReassignment: parsed.isReassignment ?? false,
    };
}

function resolveTelegramReviewSummary(reason: TelegramReviewReason) {
    switch (reason) {
        case "command_parse_failed":
            return "comando fora do formato esperado";
        case "departure_low_confidence_rephrase_required":
            return "mensagem parecia saída, mas faltou contexto seguro";
        case "departure_justification_required":
            return "saída registrada sem justificativa obrigatória";
        case "doctor_not_resolved":
            return "não foi possível identificar o médico com segurança";
        case "location_without_ramal":
            return "mensagem com CRU/COI mas sem ramal específico";
        case "no_operational_match":
            return "mensagem operacional não bateu no parser atual";
        case "pending_name_selection":
            return "mensagem operacional precisou confirmação manual do nome";
        default:
            return "mensagem fora do padrão exato";
    }
}

export function buildTelegramReviewLogData(params: {
    reason: TelegramReviewReason;
    parsed?: OperationalParsedEntry | null;
    doctorQuery?: string | null;
    candidates?: Array<{ fullName: string }>;
    example?: string | null;
    looksLikeDeparture?: boolean;
    trainingCandidate?: boolean;
}) {
    const data: Record<string, unknown> = {
        reviewRequired: true,
        reviewQueue: TELEGRAM_REVIEW_QUEUE,
        reviewReason: params.reason,
        reviewSummary: resolveTelegramReviewSummary(params.reason),
    };

    if (params.trainingCandidate) {
        data.trainingCandidate = true;
        data.trainingReason = params.reason;
    }

    const parsedSnapshot = toTelegramReviewParsedSnapshot(params.parsed);
    if (parsedSnapshot) {
        data.reviewParsed = parsedSnapshot;
    }

    const doctorQuery = params.doctorQuery?.trim();
    if (doctorQuery) {
        data.reviewDoctorQuery = doctorQuery;
    }

    if (params.candidates && params.candidates.length > 0) {
        data.reviewCandidates = params.candidates.slice(0, 3).map((candidate) => candidate.fullName);
    }

    if (typeof params.looksLikeDeparture === "boolean") {
        data.reviewLooksLikeDeparture = params.looksLikeDeparture;
    }

    const example = params.example?.trim();
    if (example) {
        data.reviewSuggestedFormat = example;
    }

    return data;
}

export function buildTelegramJustificationFollowUpText(originalText: string, justificationText: string) {
    const normalizedOriginal = originalText.trim();
    const normalizedJustification = justificationText.trim();

    if (!normalizedOriginal) {
        return normalizedJustification;
    }

    if (!normalizedJustification) {
        return normalizedOriginal;
    }

    return `${normalizedOriginal}\n[motivo complementar] ${normalizedJustification}`;
}

async function findRecentClosedInterventionOccupancy(params: {
    baseId: number;
    doctorId: string;
    eventAt: Date;
}) {
    const db = getDb();
    const recent = await db.query.interventionOccupancies.findMany({
        where: and(
            eq(interventionOccupancies.baseId, params.baseId),
            eq(interventionOccupancies.doctorId, params.doctorId),
        ),
        orderBy: [desc(interventionOccupancies.endedAt), desc(interventionOccupancies.actualEndedAt), desc(interventionOccupancies.startedAt)],
        limit: 5,
    });

    const maxWindowMs = 18 * 60 * 60 * 1000;
    return recent.find((occupancy) => {
        if (!occupancy.endedAt) {
            return false;
        }

        return Math.abs(params.eventAt.getTime() - occupancy.endedAt.getTime()) <= maxWindowMs;
    }) ?? null;
}

async function findRecentClosedRegulationOccupancy(params: {
    postId: number;
    doctorId: string;
    eventAt: Date;
}) {
    const db = getDb();
    const recent = await db.query.regulationOccupancies.findMany({
        where: and(
            eq(regulationOccupancies.postId, params.postId),
            eq(regulationOccupancies.doctorId, params.doctorId),
        ),
        orderBy: [desc(regulationOccupancies.endedAt), desc(regulationOccupancies.actualEndedAt), desc(regulationOccupancies.startedAt)],
        limit: 5,
    });

    const maxWindowMs = 18 * 60 * 60 * 1000;
    return recent.find((occupancy) => {
        if (!occupancy.endedAt) {
            return false;
        }

        return Math.abs(params.eventAt.getTime() - occupancy.endedAt.getTime()) <= maxWindowMs;
    }) ?? null;
}

async function hasRegulationDepartureHandoff(params: {
    postId: number;
    doctorId: string;
    occupancyId: string;
    endedAt: Date;
    eventAt: Date;
}) {
    const db = getDb();
    const successor = await db.query.regulationOccupancies.findFirst({
        where: and(
            eq(regulationOccupancies.postId, params.postId),
            ne(regulationOccupancies.id, params.occupancyId),
            ne(regulationOccupancies.doctorId, params.doctorId),
            gte(regulationOccupancies.startedAt, params.endedAt),
            lte(regulationOccupancies.startedAt, params.eventAt),
        ),
        orderBy: [desc(regulationOccupancies.startedAt)],
    });

    return Boolean(successor);
}

async function hasInterventionDepartureHandoff(params: {
    baseId: number;
    doctorId: string;
    occupancyId: string;
    endedAt: Date;
    eventAt: Date;
}) {
    const db = getDb();
    const successor = await db.query.interventionOccupancies.findFirst({
        where: and(
            eq(interventionOccupancies.baseId, params.baseId),
            ne(interventionOccupancies.id, params.occupancyId),
            ne(interventionOccupancies.doctorId, params.doctorId),
            gte(interventionOccupancies.startedAt, params.endedAt),
            lte(interventionOccupancies.startedAt, params.eventAt),
        ),
        orderBy: [desc(interventionOccupancies.startedAt)],
    });

    return Boolean(successor);
}

function resolveTelegramOperationalEndedAt(occupancy: TelegramOperationalContinuityOccupancy) {
    return occupancy.actualEndedAt ?? occupancy.endedAt;
}

function compareTelegramContinuitySource(left: TelegramOperationalContinuityOccupancy, right: TelegramOperationalContinuityOccupancy) {
    const leftEndedAt = resolveTelegramOperationalEndedAt(left)?.getTime() ?? Number.MAX_SAFE_INTEGER;
    const rightEndedAt = resolveTelegramOperationalEndedAt(right)?.getTime() ?? Number.MAX_SAFE_INTEGER;
    if (rightEndedAt !== leftEndedAt) {
        return rightEndedAt - leftEndedAt;
    }

    return right.startedAt.getTime() - left.startedAt.getTime();
}

async function listTelegramDoctorOperationalOccupancies(doctorId: string) {
    const db = getDb();
    const [regulation, intervention] = await Promise.all([
        db.query.regulationOccupancies.findMany({
            where: eq(regulationOccupancies.doctorId, doctorId),
        }),
        db.query.interventionOccupancies.findMany({
            where: eq(interventionOccupancies.doctorId, doctorId),
        }),
    ]);

    return [
        ...regulation.map((occupancy) => ({
            domain: "regulation" as const,
            occupancyId: occupancy.id,
            continuityGroupId: occupancy.continuityGroupId,
            doctorId: occupancy.doctorId,
            startedAt: occupancy.startedAt,
            boardStartedAt: occupancy.boardStartedAt,
            endedAt: occupancy.endedAt,
            actualEndedAt: occupancy.actualEndedAt,
            shiftLabel: occupancy.shiftLabel,
        })),
        ...intervention.map((occupancy) => ({
            domain: "intervention" as const,
            occupancyId: occupancy.id,
            continuityGroupId: occupancy.continuityGroupId,
            doctorId: occupancy.doctorId,
            startedAt: occupancy.startedAt,
            boardStartedAt: occupancy.boardStartedAt,
            endedAt: occupancy.endedAt,
            actualEndedAt: occupancy.actualEndedAt,
            shiftLabel: occupancy.shiftLabel,
        })),
    ] satisfies TelegramOperationalContinuityOccupancy[];
}

async function findTelegramContinuityContext(params: {
    doctorId: string;
    eventAt: Date;
}) {
    const occupancies = await listTelegramDoctorOperationalOccupancies(params.doctorId);
    const eligible = occupancies.filter((occupancy) => occupancy.startedAt.getTime() <= params.eventAt.getTime() + 900000);
    const activeOccupancies = eligible
        .filter((occupancy) => !occupancy.endedAt)
        .filter((occupancy) => shouldLinkActiveTelegramContinuitySource({
            activeStartedAt: occupancy.startedAt,
            activeShiftLabel: occupancy.shiftLabel,
            eventAt: params.eventAt,
        }))
        .sort(compareTelegramContinuitySource);
    const recentClosed = eligible
        .filter((occupancy) => {
            const endedAt = resolveTelegramOperationalEndedAt(occupancy);
            return Boolean(
                endedAt
                && shouldLinkRecentClosedTelegramContinuity(params.eventAt, endedAt),
            );
        })
        .sort(compareTelegramContinuitySource);
    const source = activeOccupancies[0] ?? recentClosed[0] ?? null;
    const continuityChain = source
        ? eligible
            .filter((occupancy) => occupancy.continuityGroupId === source.continuityGroupId)
            .sort((left, right) => left.startedAt.getTime() - right.startedAt.getTime())
        : [];
    const carrier = continuityChain[0] ?? source;
    const continuityStartedAt = carrier
        ? (carrier.boardStartedAt ?? carrier.startedAt)
        : null;

    return {
        source,
        continuityStartedAt,
        activeOccupancies,
    };
}

const P_SHIFT_PRE_BOUNDARY_TOLERANCE_MS = 15 * 60 * 1000;
const TELEGRAM_EXPLICIT_SHIFT_BOUNDARY_TOLERANCE_MS = 60 * 60 * 1000;

/**
 * Active occupancy só serve como fonte de continuidade enquanto sua janela de cobertura
 * esperada ainda não expirou. P expira no 7h do dia seguinte; SD/SN expiram no próximo
 * boundary operacional. Fora disso a "ativa" é só um plantão antigo que ninguém fechou —
 * uma chegada nova nunca deve herdar continuidade dele.
 */
export function shouldLinkActiveTelegramContinuitySource(params: {
    activeStartedAt: Date;
    activeShiftLabel: string | null;
    eventAt: Date;
}) {
    if (params.eventAt.getTime() < params.activeStartedAt.getTime()) {
        return true;
    }

    const normalized = (params.activeShiftLabel ?? "").toUpperCase();
    const shiftLabel: OccupancyShiftLabel = normalized === "P" || normalized === "SD" || normalized === "SN"
        ? normalized
        : null;
    const expiry = resolveImplicitOccupancyExpiry(params.activeStartedAt, shiftLabel);
    if (!expiry) {
        return true;
    }

    return params.eventAt.getTime() < expiry.getTime();
}

export function shouldLinkRecentClosedTelegramContinuity(eventAt: Date, endedAt: Date) {
    const elapsedMs = eventAt.getTime() - endedAt.getTime();
    if (elapsedMs < 0) {
        return false;
    }

    // Linkar "recent closed" só vale enquanto ainda dá pra entender como saída-e-volta-rápida
    // dentro do mesmo turno. Se um turno operacional inteiro passou com o medico fora do quadro,
    // a próxima chegada é plantão novo — quem realmente esticou precisa mandar "continuando".
    if (elapsedMs > TELEGRAM_RECENT_CLOSED_CONTINUITY_LINK_WINDOW_MS) {
        return false;
    }

    const endedShift = resolveOperationalShiftWindow(endedAt);
    const eventShift = resolveOperationalShiftWindow(eventAt);
    return endedShift.shiftLabel === eventShift.shiftLabel
        && endedShift.startedAt.getTime() === eventShift.startedAt.getTime();
}

export function shouldReopenStaleTelegramRegulationContinuation(params: {
    activeShiftLabel?: string | null;
    activeStartedAt?: Date | null;
    eventAt: Date;
}) {
    if (params.activeShiftLabel !== "P" || !params.activeStartedAt) {
        return false;
    }

    const expiryAt = resolveProlongedShiftExpiry(params.activeStartedAt, "P");
    return Boolean(expiryAt && expiryAt.getTime() <= params.eventAt.getTime());
}

export function shouldReopenStaleTelegramInterventionContinuation(params: {
    activeShiftLabel?: string | null;
    activeStartedAt?: Date | null;
    eventAt: Date;
}) {
    if (params.activeShiftLabel !== "P" || !params.activeStartedAt) {
        return false;
    }

    const expiryAt = resolveProlongedShiftExpiry(params.activeStartedAt, "P");
    return Boolean(expiryAt && expiryAt.getTime() <= params.eventAt.getTime());
}

export function resolveContinuationShiftStart(eventAt: Date, shiftType: string | null | undefined): Date {
    const window = resolveOperationalShiftWindow(eventAt);
    const normalizedShiftType = shiftType?.toUpperCase();

    if (normalizedShiftType === "P") {
        const msToNextBoundary = window.nextBoundaryAt.getTime() - eventAt.getTime();
        if (msToNextBoundary > 0 && msToNextBoundary <= P_SHIFT_PRE_BOUNDARY_TOLERANCE_MS) {
            return window.nextBoundaryAt;
        }
    }

    if ((normalizedShiftType === "SD" || normalizedShiftType === "SN") && normalizedShiftType !== window.shiftLabel) {
        const expectedBoundary = window.nextBoundaryAt;
        const boundaryDistanceMs = Math.abs(expectedBoundary.getTime() - eventAt.getTime());
        if (boundaryDistanceMs <= TELEGRAM_EXPLICIT_SHIFT_BOUNDARY_TOLERANCE_MS) {
            return expectedBoundary;
        }

        return eventAt;
    }

    return window.startedAt;
}

export function resolveTelegramContinuationStartedAt(params: {
    eventAt: Date;
    shiftType: string | null | undefined;
    continuityStartedAt?: Date | null;
    sourceStartedAt?: Date | null;
}) {
    const continuityAnchor = params.continuityStartedAt ?? params.sourceStartedAt ?? null;
    if (continuityAnchor && continuityAnchor.getTime() <= params.eventAt.getTime() + 900000) {
        return new Date(continuityAnchor);
    }

    return resolveContinuationShiftStart(params.eventAt, params.shiftType);
}

async function closeTelegramActiveContinuityOccupancies(params: {
    doctorId: string;
    eventAt: Date;
    excludeOccupancyId?: string | null;
}) {
    const occupancies = await listTelegramDoctorOperationalOccupancies(params.doctorId);
    const activeOccupancies = occupancies
        .filter((occupancy) => !occupancy.endedAt && occupancy.occupancyId !== params.excludeOccupancyId)
        .sort(compareTelegramContinuitySource);

    const MIN_CLOSE_DURATION_MS = 60_000;

    for (const occupancy of activeOccupancies) {
        // Skip closing if it would create a zero-duration artifact (endedAt ≈ startedAt).
        // These phantoms corrupt bank hours entries and payment allocation.
        const startedAtMs = new Date(occupancy.startedAt).getTime();
        const resultingDurationMs = params.eventAt.getTime() - startedAtMs;
        if (resultingDurationMs < MIN_CLOSE_DURATION_MS) {
            continue;
        }

        if (occupancy.domain === "regulation") {
            await endRegulationOccupancy(occupancy.occupancyId, {
                endedAt: params.eventAt,
                actualEndedAt: params.eventAt,
            });
        } else {
            await endInterventionOccupancy(occupancy.occupancyId, {
                endedAt: params.eventAt,
                actualEndedAt: params.eventAt,
            });
        }
    }

    return activeOccupancies;
}

async function listRecentDepartureCorrectionCandidates(params: {
    doctorId: string;
    referenceAt: Date;
}) {
    const db = getDb();
    const [recentRegulation, recentIntervention] = await Promise.all([
        db.query.regulationOccupancies.findMany({
            where: eq(regulationOccupancies.doctorId, params.doctorId),
            orderBy: [desc(regulationOccupancies.endedAt), desc(regulationOccupancies.actualEndedAt), desc(regulationOccupancies.startedAt)],
            limit: 8,
        }),
        db.query.interventionOccupancies.findMany({
            where: eq(interventionOccupancies.doctorId, params.doctorId),
            orderBy: [desc(interventionOccupancies.endedAt), desc(interventionOccupancies.actualEndedAt), desc(interventionOccupancies.startedAt)],
            limit: 8,
        }),
    ]);

    const postIds = [...new Set(recentRegulation.map((occupancy) => occupancy.postId))];
    const baseIds = [...new Set(recentIntervention.map((occupancy) => occupancy.baseId))];
    const [posts, bases] = await Promise.all([
        postIds.length > 0
            ? db.query.regulationPosts.findMany({ where: inArray(regulationPosts.id, postIds) })
            : Promise.resolve([]),
        baseIds.length > 0
            ? db.query.interventionBases.findMany({ where: inArray(interventionBases.id, baseIds) })
            : Promise.resolve([]),
    ]);

    const postById = new Map(posts.map((post) => [post.id, post.code]));
    const baseById = new Map(bases.map((base) => [base.id, base.code]));
    const minimumRelevantAt = params.referenceAt.getTime() - TELEGRAM_DEPARTURE_CORRECTION_WINDOW_MS;

    return [
        ...recentRegulation.flatMap((occupancy) => {
            const targetCode = postById.get(occupancy.postId);
            if (!targetCode) {
                return [];
            }

            const anchorAt = resolveDepartureCorrectionReferenceAt({
                occupancyId: occupancy.id,
                domain: "REGULATION",
                targetCode,
                shiftLabel: (occupancy.shiftLabel === "SD" || occupancy.shiftLabel === "SN" || occupancy.shiftLabel === "P") ? occupancy.shiftLabel : null,
                roleLabel: occupancy.roleLabel,
                startedAt: occupancy.startedAt,
                endedAt: occupancy.endedAt,
                actualEndedAt: occupancy.actualEndedAt,
                isActive: !occupancy.endedAt,
            });
            if (anchorAt.getTime() < minimumRelevantAt && occupancy.startedAt.getTime() < minimumRelevantAt) {
                return [];
            }

            return [{
                occupancyId: occupancy.id,
                domain: "REGULATION" as const,
                targetCode,
                shiftLabel: (occupancy.shiftLabel === "SD" || occupancy.shiftLabel === "SN" || occupancy.shiftLabel === "P") ? occupancy.shiftLabel : null,
                roleLabel: occupancy.roleLabel,
                startedAt: occupancy.startedAt,
                endedAt: occupancy.endedAt,
                actualEndedAt: occupancy.actualEndedAt,
                isActive: !occupancy.endedAt,
            } satisfies TelegramDepartureCorrectionCandidate];
        }),
        ...recentIntervention.flatMap((occupancy) => {
            const targetCode = baseById.get(occupancy.baseId);
            if (!targetCode) {
                return [];
            }

            const anchorAt = resolveDepartureCorrectionReferenceAt({
                occupancyId: occupancy.id,
                domain: "INTERVENTION",
                targetCode,
                shiftLabel: (occupancy.shiftLabel === "SD" || occupancy.shiftLabel === "SN" || occupancy.shiftLabel === "P") ? occupancy.shiftLabel : null,
                roleLabel: occupancy.roleLabel,
                startedAt: occupancy.startedAt,
                endedAt: occupancy.endedAt,
                actualEndedAt: occupancy.actualEndedAt,
                isActive: !occupancy.endedAt,
            });
            if (anchorAt.getTime() < minimumRelevantAt && occupancy.startedAt.getTime() < minimumRelevantAt) {
                return [];
            }

            return [{
                occupancyId: occupancy.id,
                domain: "INTERVENTION" as const,
                targetCode,
                shiftLabel: (occupancy.shiftLabel === "SD" || occupancy.shiftLabel === "SN" || occupancy.shiftLabel === "P") ? occupancy.shiftLabel : null,
                roleLabel: occupancy.roleLabel,
                startedAt: occupancy.startedAt,
                endedAt: occupancy.endedAt,
                actualEndedAt: occupancy.actualEndedAt,
                isActive: !occupancy.endedAt,
            } satisfies TelegramDepartureCorrectionCandidate];
        }),
    ].sort(compareDepartureCorrectionCandidates);
}

function formatDepartureCorrectionCandidateSummary(candidate: TelegramDepartureCorrectionCandidate) {
    const startedAt = formatTelegramReplyTime(candidate.startedAt);
    const endedReference = candidate.actualEndedAt ?? candidate.endedAt;
    const endedLabel = endedReference ? formatTelegramReplyTime(endedReference) : "ativo";
    const domainLabel = candidate.domain === "REGULATION" ? "regulação" : "intervenção";
    const shiftLabel = candidate.shiftLabel ? ` ${candidate.shiftLabel}` : "";
    return `${candidate.targetCode} | ${domainLabel}${shiftLabel} | chegada ${startedAt} | saída ${endedLabel}`;
}

async function sendTelegramDepartureFailureReply(params: {
    chatId: number;
    replyToMessageId: number;
    seed: number;
    parsed: OperationalParsedEntry;
    doctorName: string;
    errorMessage: string;
}) {
    if (!params.parsed.isDeparture) {
        return;
    }

    const example = buildTelegramDepartureExample({
        doctorName: params.doctorName,
        target: params.parsed.baseCode,
        time: params.parsed.arrivalTime,
    });

    let kind: "departure_justification_required" | "departure_not_found" | "departure_time_conflict" | "half_shift_already_closed" | null = null;
    if (isTelegramJustificationRequiredError(params.errorMessage)) {
        kind = "departure_justification_required";
    } else if (params.errorMessage === TELEGRAM_HALF_SHIFT_ALREADY_CLOSED_ERROR) {
        kind = "half_shift_already_closed";
    } else if (params.errorMessage.includes("No active") || params.errorMessage.includes("not found")) {
        kind = "departure_not_found";
    } else if (params.errorMessage.includes("Actual end cannot be before the recorded arrival.")) {
        kind = "departure_time_conflict";
    }

    if (!kind) {
        return;
    }

    await sendMessage(
        params.chatId,
        pickTelegramReply(kind, params.seed, {
            name: params.doctorName,
            target: params.parsed.baseCode ?? "plantao",
            time: params.parsed.arrivalTime ?? "",
            example,
        }),
        params.replyToMessageId,
    );
}

async function sendTelegramArrivalFailureReply(params: {
    chatId: number;
    replyToMessageId: number;
    parsed: OperationalParsedEntry;
    errorMessage: string;
}) {
    if (params.parsed.isDeparture) {
        return;
    }

    const userMessage = params.errorMessage === "arrival_conflicts_with_active_occupancy"
        ? `⚠️ Já há alguém ativo em *${params.parsed.baseCode}* com horário igual ou posterior. Use /retirar ${params.parsed.baseCode} antes de registrar nova chegada.`
        : `⚠️ Não consegui registrar essa chegada. ${params.errorMessage}`;

    await sendMessage(
        params.chatId,
        userMessage,
        params.replyToMessageId,
    );
}

function isOperationalParsedEntry(entry: ParsedMessage): entry is ParsedMessage & OperationalParsedEntry {
    return Boolean(entry.baseCode && entry.sector);
}

async function findActiveOccupancyByDoctorId(doctorId: string): Promise<{
    sector: "REGULATION" | "INTERVENTION";
    baseCode: string;
    occupancyId: string;
    startedAt: Date;
    shiftLabel: string | null;
    continuityGroupId: string | null;
    boardStartedAt: Date | null;
} | null> {
    const db = getDb();

    const regOcc = await db
        .select({
            id: regulationOccupancies.id,
            postId: regulationOccupancies.postId,
            startedAt: regulationOccupancies.startedAt,
            shiftLabel: regulationOccupancies.shiftLabel,
            continuityGroupId: regulationOccupancies.continuityGroupId,
            boardStartedAt: regulationOccupancies.boardStartedAt,
        })
        .from(regulationOccupancies)
        .where(and(eq(regulationOccupancies.doctorId, doctorId), isNull(regulationOccupancies.endedAt)))
        .orderBy(desc(regulationOccupancies.startedAt))
        .limit(1);

    if (regOcc.length > 0) {
        const post = await db.query.regulationPosts.findFirst({ where: eq(regulationPosts.id, regOcc[0].postId) });
        if (post) {
            return {
                sector: "REGULATION",
                baseCode: post.code,
                occupancyId: regOcc[0].id,
                startedAt: regOcc[0].startedAt,
                shiftLabel: regOcc[0].shiftLabel,
                continuityGroupId: regOcc[0].continuityGroupId,
                boardStartedAt: regOcc[0].boardStartedAt,
            };
        }
    }

    const intOcc = await db
        .select({
            id: interventionOccupancies.id,
            baseId: interventionOccupancies.baseId,
            startedAt: interventionOccupancies.startedAt,
            shiftLabel: interventionOccupancies.shiftLabel,
            continuityGroupId: interventionOccupancies.continuityGroupId,
            boardStartedAt: interventionOccupancies.boardStartedAt,
        })
        .from(interventionOccupancies)
        .where(and(eq(interventionOccupancies.doctorId, doctorId), isNull(interventionOccupancies.endedAt)))
        .orderBy(desc(interventionOccupancies.startedAt))
        .limit(1);

    if (intOcc.length > 0) {
        const base = await db.query.interventionBases.findFirst({ where: eq(interventionBases.id, intOcc[0].baseId) });
        if (base) {
            return {
                sector: "INTERVENTION",
                baseCode: base.code,
                occupancyId: intOcc[0].id,
                startedAt: intOcc[0].startedAt,
                shiftLabel: intOcc[0].shiftLabel,
                continuityGroupId: intOcc[0].continuityGroupId,
                boardStartedAt: intOcc[0].boardStartedAt,
            };
        }
    }

    return null;
}

async function resolveTelegramContinuitySourceCode(source: TelegramOperationalContinuityOccupancy | null | undefined) {
    if (!source) {
        return null;
    }

    const db = getDb();
    if (source.domain === "regulation") {
        const occupancy = await db.query.regulationOccupancies.findFirst({
            where: eq(regulationOccupancies.id, source.occupancyId),
        });
        if (!occupancy) {
            return null;
        }

        const post = await db.query.regulationPosts.findFirst({
            where: eq(regulationPosts.id, occupancy.postId),
        });
        return post?.code ?? null;
    }

    const occupancy = await db.query.interventionOccupancies.findFirst({
        where: eq(interventionOccupancies.id, source.occupancyId),
    });
    if (!occupancy) {
        return null;
    }

    const base = await db.query.interventionBases.findFirst({
        where: eq(interventionBases.id, occupancy.baseId),
    });
    return base?.code ?? null;
}

async function resolveContinuationWithoutBase(rawParsed: ParsedMessage, messageText: string, senderName: string | null, referenceAt: Date): Promise<{
    parsed: OperationalParsedEntry;
    resolvedDoctor: ResolvedTelegramDoctorRef;
} | null> {
    if (!rawParsed.isContinuation || rawParsed.baseCode) {
        return null;
    }

    const doctorQuery = rawParsed.extractedNames[0] ?? null;
    const lookupQuery = doctorQuery || (shouldUseTelegramSenderNameFallback(messageText, senderName) ? senderName : null);
    if (!lookupQuery) {
        return null;
    }

    const resolved = await resolveDoctorWithFallback(lookupQuery);
    const resolvedDoctor = resolved.doctor ?? (resolved.candidates.length === 1
        ? {
            id: resolved.candidates[0].id,
            fullName: resolved.candidates[0].fullName,
            displayName: resolved.candidates[0].displayName ?? null,
        }
        : null);
    if (!resolvedDoctor) {
        return null;
    }

    const eventAt = resolveTelegramEventTime(referenceAt, rawParsed.arrivalTime);
    const activeOcc = await findActiveOccupancyByDoctorId(resolvedDoctor.id);
    let recoveredSector: "REGULATION" | "INTERVENTION" | null = activeOcc?.sector ?? null;
    let recoveredBaseCode: string | null = activeOcc?.baseCode ?? null;
    let recoveredShiftLabel: string | null = activeOcc?.shiftLabel ?? null;

    if (!recoveredBaseCode) {
        const continuityContext = await findTelegramContinuityContext({ doctorId: resolvedDoctor.id, eventAt });
        const source = continuityContext?.source;
        if (!source) {
            return null;
        }

        if (source.domain === "regulation") {
            const sourceReg = await getDb().query.regulationOccupancies.findFirst({
                where: eq(regulationOccupancies.id, source.occupancyId),
            });
            if (!sourceReg) {
                return null;
            }

            const post = await getDb().query.regulationPosts.findFirst({ where: eq(regulationPosts.id, sourceReg.postId) });
            recoveredSector = "REGULATION";
            recoveredBaseCode = post?.code ?? null;
            recoveredShiftLabel = sourceReg.shiftLabel ?? source.shiftLabel;
        } else {
            const sourceInt = await getDb().query.interventionOccupancies.findFirst({
                where: eq(interventionOccupancies.id, source.occupancyId),
            });
            if (!sourceInt) {
                return null;
            }

            const base = await getDb().query.interventionBases.findFirst({ where: eq(interventionBases.id, sourceInt.baseId) });
            recoveredSector = "INTERVENTION";
            recoveredBaseCode = base?.code ?? null;
            recoveredShiftLabel = sourceInt.shiftLabel ?? source.shiftLabel;
        }
    }

    if (!recoveredSector || !recoveredBaseCode) {
        return null;
    }

    return {
        parsed: {
            sector: recoveredSector,
            baseCode: recoveredBaseCode,
            arrivalTime: rawParsed.arrivalTime,
            shiftType: rawParsed.shiftType ?? (recoveredShiftLabel as ParsedMessage["shiftType"]),
            roleFunction: rawParsed.roleFunction,
            isDeparture: false,
            isContinuation: true,
            isReassignment: false,
        },
        resolvedDoctor: {
            id: resolvedDoctor.id,
            fullName: resolvedDoctor.fullName,
            displayName: resolvedDoctor.displayName,
        },
    };
}

/**
 * Resolve departure messages that have no base code — e.g. "alexandre faria saindo"
 * or "Leo Morais saindo do SN no COI as 07:22".
 * Looks up the doctor's active occupancy to fill in the missing base code.
 */
async function resolveDepartureWithoutBase(rawParsed: ParsedMessage, messageText: string, senderName: string | null): Promise<{
    parsed: OperationalParsedEntry;
    resolvedDoctor: ResolvedTelegramDoctorRef;
} | null> {
    if (!rawParsed.isDeparture || rawParsed.baseCode) {
        return null;
    }

    const doctorQuery = rawParsed.extractedNames[0] ?? null;
    const lookupQuery = doctorQuery || (shouldUseTelegramSenderNameFallback(messageText, senderName) ? senderName : null);
    if (!lookupQuery) {
        return null;
    }

    const resolved = await resolveDoctorWithFallback(lookupQuery);
    if (!resolved.doctor) {
        return null;
    }

    const activeOcc = await findActiveOccupancyByDoctorId(resolved.doctor.id);
    if (!activeOcc) {
        return null;
    }

    return {
        parsed: {
            sector: activeOcc.sector,
            baseCode: activeOcc.baseCode,
            arrivalTime: rawParsed.arrivalTime,
            shiftType: rawParsed.shiftType ?? (activeOcc.shiftLabel as ParsedMessage["shiftType"]),
            roleFunction: rawParsed.roleFunction,
            isDeparture: true,
            isContinuation: false,
            isReassignment: false,
        },
        resolvedDoctor: {
            id: resolved.doctor.id,
            fullName: resolved.doctor.fullName,
            displayName: resolved.doctor.displayName,
        },
    };
}

async function resolveDoctorId(rawName: string) {
    const normalizedName = normalizeDoctorName(rawName);
    if (!normalizedName) {
        return null;
    }

    const directory = await listDirectoryEntries();
    const matches = directory.filter((doctor) => {
        return normalizedName === normalizeDoctorName(doctor.fullName)
            || normalizedName === normalizeDoctorName(doctor.displayName ?? "")
            || extractDoctorAliases(doctor.metadata).some((alias) => normalizeDoctorName(alias) === normalizedName)
            || normalizedName === doctor.normalizedName;
    });

    return matches.length === 1 ? matches[0] : null;
}

async function listDirectoryEntries() {
    const db = getDb();
    const rows = await db.select({
        id: doctors.id,
        fullName: doctors.fullName,
        displayName: doctors.displayName,
        metadata: doctors.metadata,
        normalizedName: doctors.normalizedName,
        isActive: doctors.isActive,
    }).from(doctors).where(eq(doctors.isActive, true));

    return rows.map((row) => ({
        ...row,
        aliases: extractDoctorAliases(row.metadata),
    }));
}

export function isSharedAccountSender(senderName: string | null): boolean {
    if (!senderName) return false;
    const normalized = senderName.toUpperCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
    return /\b\d{4}\b.*(?:MEDICO|CHEFE|MRV)/i.test(normalized)
        || /\b(?:COI|CRU)\s*\d{4}\b/i.test(normalized)
        || /\bMR\s+COI\b/i.test(normalized);
}

export function shouldUseTelegramSenderNameFallback(messageText: string, senderName?: string | null) {
    if (/@\w+/i.test(messageText)) return false;
    if (senderName && isSharedAccountSender(senderName)) return false;
    return true;
}

export function shouldRejectLowConfidenceTelegramArrival(params: {
    chatType: string;
    confidence: "LOW" | "MEDIUM" | "HIGH";
    extractedNamesCount: number;
    isDeparture: boolean;
    messageText: string;
    senderName?: string | null;
}) {
    if (params.chatType === "private") {
        return false;
    }

    if (params.confidence === "HIGH" || params.extractedNamesCount > 0 || params.isDeparture) {
        return false;
    }

    const senderName = params.senderName?.trim() ?? "";
    if (senderName && shouldUseTelegramSenderNameFallback(params.messageText, senderName)) {
        return false;
    }

    return true;
}

export function resolveOperationalDoctorLookupQuery(params: {
    doctorQuery: string | null;
    senderName?: string | null;
    messageText: string;
}) {
    if (params.doctorQuery) {
        return params.doctorQuery;
    }

    return shouldUseTelegramSenderNameFallback(params.messageText, params.senderName)
        ? (params.senderName ?? null)
        : null;
}

async function resolveDoctorWithFallback(rawName: string) {
    const exact = await resolveDoctorId(rawName);
    if (exact) {
        return { doctor: exact, candidates: [] as TelegramDoctorCandidate[], matchedBy: "exact" as const };
    }

    const directory = await listDirectoryEntries();
    const candidates = resolveDoctorCandidates(rawName, directory as TelegramDoctorDirectoryEntry[]);
    const confidentCandidate = pickConfidentDoctorCandidate(rawName, candidates);
    if (confidentCandidate) {
        return {
            doctor: directory.find((entry) => entry.id === confidentCandidate.id) ?? null,
            candidates,
            matchedBy: "candidate" as const,
        };
    }

    return {
        doctor: null,
        candidates,
        matchedBy: "none" as const,
    };
}

function isExactDoctorMatch(query: string | null, doctor: { fullName: string; displayName: string | null; metadata?: unknown } | null) {
    if (!query || !doctor) {
        return false;
    }

    const normalizedQuery = normalizeDoctorName(query);
    if (!normalizedQuery) {
        return false;
    }

    return normalizedQuery === normalizeDoctorName(doctor.fullName)
        || normalizedQuery === normalizeDoctorName(doctor.displayName ?? "")
        || extractDoctorAliases(doctor.metadata).some((alias) => normalizeDoctorName(alias) === normalizedQuery);
}

function resolveTelegramDoctorSurfaceName(doctor: { fullName: string; displayName?: string | null } | null | undefined) {
    return formatDoctorSurfaceName({
        fullName: doctor?.fullName,
        displayName: doctor?.displayName ?? null,
        fallback: "medico nao identificado",
    });
}

function buildApproximateMatchHint(params: {
    doctorQuery: string | null;
    doctorName: string;
}) {
    if (!params.doctorQuery || isExactDoctorMatch(params.doctorQuery, { fullName: params.doctorName, displayName: params.doctorName })) {
        return "";
    }

    return `\nSe eu associei \"${params.doctorQuery}\" a ${params.doctorName} e nao era essa pessoa, me corrija com o nome completo.`;
}

async function prepareTelegramBatchEntries(message: TelegramUpdate["message"]) {
    const batchLines = parseTelegramBatchLines(message?.text ?? "");
    const entries: PreparedBatchEntry[] = [];
    const issues: TelegramBatchReviewIssue[] = [];
    const referenceDate = new Date((message?.date ?? Math.floor(Date.now() / 1000)) * 1000);

    for (const batchLine of batchLines) {
        const parsed = batchLine.parsed;
        const doctorQuery = parsed.extractedNames[0] ?? null;

        if (!parsed.baseCode || parsed.isDeparture || !doctorQuery) {
            issues.push({
                lineNumber: batchLine.lineNumber,
                rawLine: batchLine.rawLine,
                reason: buildBatchIssueReason({ parsed, doctorQuery, candidates: [] }),
            });
            continue;
        }

        const { doctor, candidates } = await resolveDoctorWithFallback(doctorQuery);
        if (!doctor) {
            issues.push({
                lineNumber: batchLine.lineNumber,
                rawLine: batchLine.rawLine,
                reason: buildBatchIssueReason({ parsed, doctorQuery, candidates }),
            });
            continue;
        }

        entries.push({
            lineNumber: batchLine.lineNumber,
            rawLine: batchLine.rawLine,
            parsed: {
                sector: parsed.sector as OperationalParsedEntry["sector"],
                baseCode: parsed.baseCode,
                arrivalTime: parsed.arrivalTime,
                shiftType: parsed.shiftType,
                roleFunction: parsed.roleFunction,
                isShadow: parsed.isShadow ?? false,
                isDeparture: parsed.isDeparture,
                isContinuation: parsed.isContinuation,
                isReassignment: parsed.isReassignment ?? false,
            },
            resolvedDoctor: {
                id: doctor.id,
                fullName: doctor.fullName,
                displayName: doctor.displayName ?? null,
            },
            eventAt: resolveTelegramEventTime(referenceDate, parsed.arrivalTime),
        });
    }

    return { batchLines, entries, issues };
}

async function queuePendingBatchConfirmation(
    logId: string,
    message: TelegramUpdate["message"],
    entries: PreparedBatchEntry[],
) {
    await markTelegramProcessed(logId, {
        status: "pending_batch_confirmation",
        parsedAction: "batch_arrival",
        resolutionData: {
            entries: entries.map((entry) => ({
                lineNumber: entry.lineNumber,
                rawLine: entry.rawLine,
                parsed: entry.parsed,
                resolvedDoctor: entry.resolvedDoctor,
                eventAt: entry.eventAt.toISOString(),
            })),
            originalText: message?.text ?? "",
            originalMessageId: message?.message_id ?? 0,
        },
    });
}

async function tryHandlePendingBatchConfirmation(update: TelegramUpdate, logId: string) {
    const message = update.message;
    if (!message?.text || !message.from?.id) {
        return null;
    }

    if (!canManageTelegramBatch(message)) {
        return null;
    }

    const pending = await findPendingBatchConfirmation(String(message.chat.id), String(message.from.id));
    if (!pending || !isPendingBatchConfirmationData(pending.resolutionData)) {
        return null;
    }

    const normalizedText = message.text.trim();
    if (isBatchCancelKeyword(normalizedText)) {
        await markTelegramProcessed(pending.id, {
            status: "superseded",
            errorMessage: "batch_confirmation_cancelled",
        });
        await markTelegramProcessed(logId, {
            status: "accepted",
            parsedAction: "batch_cancelled",
            errorMessage: null,
        });
        await sendMessage(message.chat.id, ":| Lote descartado. Quando quiser, pode colar uma nova escala para eu conferir de novo.", message.message_id, REMOVE_KEYBOARD);
        return { ok: true, ignored: true };
    }

    if (!isBatchConfirmationKeyword(normalizedText)) {
        const replacementLines = parseTelegramBatchLines(message.text);
        if (replacementLines.length > 1) {
            await markTelegramProcessed(pending.id, {
                status: "superseded",
                errorMessage: "batch_confirmation_replaced",
            });
            return null;
        }

        await markTelegramProcessed(logId, {
            status: "ignored",
            parsedAction: "batch_confirmation_pending",
            errorMessage: "batch_confirmation_pending",
        });
        await sendMessage(
            message.chat.id,
            ":| Tenho um lote pronto para confirmar. Responda CONFIRMAR para gravar tudo ou CANCELAR para descartar.",
            message.message_id,
            buildChoiceKeyboard([["✅ CONFIRMAR", "❌ CANCELAR"]]),
        );
        return { ok: true, ignored: true, pending: true };
    }

    const failed: Array<{ lineNumber: number; reason: string }> = [];
    const relatedOccupancyIds: string[] = [];

    for (const entry of pending.resolutionData.entries) {
        try {
            const result = await applyParsedEntry({
                parsed: entry.parsed,
                resolvedDoctor: entry.resolvedDoctor,
                eventAt: new Date(entry.eventAt),
                referenceAt: new Date(entry.eventAt),
                messageText: entry.rawLine,
            });
            if (result.occupancyId) {
                relatedOccupancyIds.push(result.occupancyId);
            }
        } catch (error) {
            failed.push({
                lineNumber: entry.lineNumber,
                reason: error instanceof Error ? error.message : "falha inesperada ao gravar",
            });
        }
    }

    await markTelegramProcessed(pending.id, {
        status: failed.length === 0 ? "accepted" : "error",
        relatedOccupancyId: relatedOccupancyIds[0] ?? null,
        errorMessage: failed.length === 0 ? null : "batch_apply_partial_failure",
        resolutionData: buildResolutionData(pending.resolutionData, {
            appliedCount: relatedOccupancyIds.length,
            failed,
            relatedOccupancyIds,
        }),
    });
    await markTelegramProcessed(logId, {
        status: failed.length === 0 ? "accepted" : "error",
        parsedAction: "batch_confirmed",
        relatedOccupancyId: relatedOccupancyIds[0] ?? null,
        errorMessage: failed.length === 0 ? null : "batch_apply_partial_failure",
        resolutionData: {
            sourceBatchLogId: pending.id,
            appliedCount: relatedOccupancyIds.length,
            failed,
        },
    });

    await sendMessage(
        message.chat.id,
        buildTelegramBatchApplyReply({
            appliedCount: relatedOccupancyIds.length,
            failed,
        }),
        message.message_id,
        REMOVE_KEYBOARD,
    );

    if (relatedOccupancyIds.length > 0) {
        await announcePrivateBatchToGroups(message.message_id, {
            appliedCount: relatedOccupancyIds.length,
        });
    }

    return { ok: true, occupancyIds: relatedOccupancyIds, failed };
}

async function logTelegramMessage(update: TelegramUpdate) {
    const message = update.message;
    if (!message?.text) {
        return null;
    }

    const db = getDb();
    const [row] = await db.insert(telegramIngestedMessages)
        .values({
            telegramUpdateId: update.update_id,
            telegramMessageId: message.message_id,
            chatId: String(message.chat.id),
            senderTelegramId: message.from?.id ? String(message.from.id) : null,
            senderName: [message.from?.first_name, message.from?.last_name].filter(Boolean).join(" ") || null,
            rawText: message.text,
            status: "pending",
        })
        .onConflictDoNothing()
        .returning();

    return row ?? db.query.telegramIngestedMessages.findFirst({
        where: and(
            eq(telegramIngestedMessages.chatId, String(message.chat.id)),
            eq(telegramIngestedMessages.telegramMessageId, message.message_id),
        ),
    });
}

async function markTelegramProcessed(id: string, patch: Partial<typeof telegramIngestedMessages.$inferInsert>) {
    const db = getDb();
    await db.update(telegramIngestedMessages)
        .set({
            ...patch,
            processedAt: new Date(),
        })
        .where(eq(telegramIngestedMessages.id, id));
}

function buildResolutionData(current: unknown, patch: Record<string, unknown>) {
    const base = current && typeof current === "object" ? current as Record<string, unknown> : {};
    return {
        ...base,
        ...patch,
    };
}

function isLembretesCommandText(text: string) {
    return /^\/lembretes(?:@\w+)?$/i.test(text.trim());
}

function buildLembretesCommandText(params: {
    shiftLabel: "SD" | "SN";
    regulationRows: Array<{ postCode: string; status: "active" | "waiting" | "disabled"; doctorName: string | null; displayName: string | null }>;
    interventionRows: Array<{ baseCode: string; status: "active" | "waiting" | "disabled"; doctorName: string | null; displayName: string | null }>;
}) {
    const normalizeCode = (value: string) => value.trim().toUpperCase();
    const isChiefPost = (code: string) => normalizeCode(code) === "2031";
    const isNucleo = (code: string) => normalizeCode(code) === "NUCLEO";
    const isPiam = (code: string) => normalizeCode(code) === "PIAM";
    const doctorLabel = (fullName: string | null, displayName: string | null) => formatDoctorSurfaceName({
        fullName,
        displayName,
        fallback: "medico nao identificado",
    });

    const regularRegulationRows = params.regulationRows.filter((row) => !isChiefPost(row.postCode) && !isNucleo(row.postCode) && !isPiam(row.postCode));
    const regularActiveRegulationRows = regularRegulationRows
        .filter((row) => row.status === "active")
        .sort((left, right) => doctorLabel(left.doctorName, left.displayName).localeCompare(doctorLabel(right.doctorName, right.displayName), "pt-BR"));

    const regulationHeadcount = regularActiveRegulationRows.length;

    const regulationLines = regularActiveRegulationRows.length > 0
        ? regularActiveRegulationRows.map((row) => `✅ ${doctorLabel(row.doctorName, row.displayName)} — ${row.postCode}`).join("\n")
        : "⚠️ Nenhum regulador (fora 2031/NUCLEO/PIAM) confirmado.";

    const nucleoRow = params.regulationRows.find((row) => isNucleo(row.postCode));
    const piamRow = params.regulationRows.find((row) => isPiam(row.postCode));

    const specialRegulationLines: string[] = [];
    if (params.shiftLabel === "SD") {
        specialRegulationLines.push(
            nucleoRow?.status === "active"
                ? `✅ NUCLEO — ${doctorLabel(nucleoRow.doctorName, nucleoRow.displayName)}`
                : "⚠️ NUCLEO — sem confirmacao",
        );
    }
    specialRegulationLines.push(
        piamRow?.status === "active"
            ? `✅ PIAM — ${doctorLabel(piamRow.doctorName, piamRow.displayName)}`
            : "⚠️ PIAM — sem confirmacao",
    );

    const interventionLines = [...params.interventionRows]
        .sort((left, right) => compareTelegramInterventionCodes(left.baseCode, right.baseCode))
        .map((row) => {
            if (row.status === "active") {
                return `✅ ${row.baseCode} — ${doctorLabel(row.doctorName, row.displayName)}`;
            }
            if (row.status === "disabled") {
                return `⚫ ${row.baseCode} — desativada`;
            }
            return `🚨 ${row.baseCode} — sem informacao`;
        })
        .join("\n");

    return [
        "📣👨‍✈️ CHEFIA, confere pra mim?",
        "",
        `☎️ Reguladores no quadro agora: ${regulationHeadcount}`,
        regulationLines,
        "",
        ...specialRegulationLines,
        "",
        `🚑 USA ${params.shiftLabel} (quem esta onde):`,
        interventionLines,
        "",
        "❓ Certeza que nao falta alguem?",
        "⚡ Se faltou, avisem agora: Nome + base/ramal + SD/SN/P + horario.",
    ].join("\n");
}

async function markTelegramTrainingCandidate(
    id: string,
    current: unknown,
    reason: string,
    details: Record<string, unknown> = {},
) {
    await markTelegramProcessed(id, {
        resolutionData: buildResolutionData(current, {
            ...buildTelegramReviewLogData({
                reason: reason as TelegramReviewReason,
                trainingCandidate: true,
            }),
            ...details,
        }),
    });
}

async function resolveTelegramCommandActor(message: TelegramUpdate["message"]): Promise<TelegramCommandActor | null> {
    const senderTelegramId = message?.from?.id ? String(message.from.id) : null;
    const senderName = [message?.from?.first_name, message?.from?.last_name].filter(Boolean).join(" ").trim();

    if (senderTelegramId && getTelegramAdminUserIds().includes(senderTelegramId)) {
        return { userId: null, roles: ["admin"], senderName, senderTelegramId };
    }
    if (senderTelegramId && getTelegramChiefUserIds().includes(senderTelegramId)) {
        return { userId: null, roles: ["chief"], senderName, senderTelegramId };
    }

    if (!senderName) {
        return null;
    }

    const doctor = await resolveDoctorId(senderName);
    if (!doctor) {
        return null;
    }

    const db = getDb();
    const rows = await db
        .select({ userId: users.id, role: userRoles.role })
        .from(users)
        .innerJoin(userRoles, eq(userRoles.userId, users.id))
        .where(and(eq(users.doctorId, doctor.id), eq(users.isActive, true), inArray(userRoles.role, ["admin", "chief"])));

    if (rows.length === 0) {
        return null;
    }

    return {
        userId: rows[0].userId,
        roles: [...new Set(rows.map((row) => row.role))] as Array<"admin" | "chief">,
        senderName: doctor.fullName,
        senderTelegramId,
    };
}

async function isTelegramMessageAllowed(message: TelegramUpdate["message"]) {
    if (!message) {
        return false;
    }

    if (isTelegramChatAllowed(message.chat.id)) {
        return true;
    }

    if (message.chat.type !== "private") {
        return false;
    }

    if (isTelegramPrivateControlUserId(message.from?.id)) {
        return true;
    }

    const actor = await resolveTelegramCommandActor(message);
    return Boolean(actor && actor.roles.some((role) => role === "admin" || role === "chief"));
}

async function announcePrivateCorrectionToGroups(seed: number, params: { name: string; target: string; time: string }) {
    const groupChatIds = getTelegramAnnouncementChatIds();
    if (groupChatIds.length === 0) {
        return;
    }

    const text = buildGroupCorrectionAnnouncement(seed, params);
    const results = await Promise.allSettled(groupChatIds.map((chatId) => sendMessage(chatId, text)));
    for (const result of results) {
        if (result.status === "rejected") {
            console.error("telegram group correction announcement failed", result.reason);
        }
    }
}

async function announcePrivateBatchToGroups(seed: number, params: { appliedCount: number }) {
    const groupChatIds = getTelegramAnnouncementChatIds();
    if (groupChatIds.length === 0) {
        return;
    }

    const appUrl = (process.env.AUTH_URL?.trim() || "https://plantoes.mnrs.com.br").replace(/\/$/, "");
    const text = [
        ":)",
        `Atualizei em lote ${params.appliedCount} chegadas pelo bot privado.`,
        `Confiram quadro e horarios de chegada em ${appUrl}`,
    ].join("\n");

    const results = await Promise.allSettled(groupChatIds.map((chatId) => sendMessage(chatId, text)));
    for (const result of results) {
        if (result.status === "rejected") {
            console.error("telegram batch announcement failed", result.reason);
        }
    }
}

async function findActiveOccupancyByTarget(parsed: OperationalParsedEntry) {
    const db = getDb();
    if (parsed.sector === "REGULATION") {
        const post = await db.query.regulationPosts.findFirst({ where: eq(regulationPosts.code, parsed.baseCode) });
        if (!post) {
            throw new Error("Regulation post not found.");
        }

        const occupancy = await db.query.regulationOccupancies.findFirst({
            where: and(
                eq(regulationOccupancies.postId, post.id),
                isNull(regulationOccupancies.endedAt),
            ),
        });
        return { post, occupancy, base: null };
    }

    const base = await db.query.interventionBases.findFirst({ where: eq(interventionBases.code, parsed.baseCode) });
    if (!base) {
        throw new Error("Intervention base not found.");
    }

    const occupancy = await db.query.interventionOccupancies.findFirst({
        where: and(
            eq(interventionOccupancies.baseId, base.id),
            isNull(interventionOccupancies.endedAt),
        ),
        orderBy: [desc(interventionOccupancies.boardStartedAt), desc(interventionOccupancies.startedAt)],
    });
    return { base, occupancy, post: null };
}

async function findInterventionBaseByCode(code: string) {
    return getDb().query.interventionBases.findFirst({
        where: eq(interventionBases.code, code),
    });
}

async function findRegulationPostByCode(code: string) {
    return getDb().query.regulationPosts.findFirst({
        where: eq(regulationPosts.code, code),
    });
}

// ─── /desfazer Handler ─────────────────────────────────────────────────

async function handleTelegramUndoCommand(params: {
    message: TelegramUpdate["message"];
    logId: string;
    actor: TelegramCommandActor;
    undoCommand: NonNullable<ReturnType<typeof parseTelegramUndoCommand>>;
}) {
    const { message, logId, actor, undoCommand } = params;
    if (!message) return { ok: true, ignored: true };

    const adminOpts = { adminWindow: true, skipOwnerCheck: true } as const;

    if (undoCommand.name === "undo_list") {
        // List recent undoable actions (all users, 12h window)
        const actions = await getUndoableActions("__admin__", adminOpts);
        if (actions.length === 0) {
            await markTelegramProcessed(logId, {
                status: "accepted",
                parsedAction: "undo_list",
                resolutionData: { count: 0 },
            });
            await sendMessage(message.chat.id, "Nenhuma ação desfeível nas últimas 12h.", message.message_id);
            return { ok: true };
        }

        const lines = await Promise.all(actions.map(async (a, i) => {
            const label = await buildUndoActionLabel(a);
            const ago = Math.ceil((Date.now() - new Date(a.createdAt).getTime()) / 60_000);
            return `${i + 1}. ${label} (${ago} min atrás)`;
        }));

        const header = `📋 Ações desfeíveis (${actions.length}):\n\n`;
        const footer = "\n\nPara desfazer, envie /desfazer N (ex: /desfazer 1)";
        await markTelegramProcessed(logId, {
            status: "accepted",
            parsedAction: "undo_list",
            resolutionData: { count: actions.length },
        });
        await sendMessage(message.chat.id, header + lines.join("\n") + footer, message.message_id);
        return { ok: true };
    }

    // undo_confirm — execute the undo
    const actions = await getUndoableActions("__admin__", adminOpts);
    const idx = undoCommand.index! - 1;

    if (idx < 0 || idx >= actions.length) {
        await markTelegramProcessed(logId, {
            status: "ignored",
            errorMessage: "undo_index_out_of_range",
            parsedAction: "undo_confirm",
            resolutionData: { index: undoCommand.index, available: actions.length },
        });
        await sendMessage(
            message.chat.id,
            actions.length === 0
                ? "Nenhuma ação desfeível no momento."
                : `Número inválido. Disponíveis: 1 a ${actions.length}. Envie /desfazer para listar.`,
            message.message_id,
        );
        return { ok: true, ignored: true };
    }

    const target = actions[idx];
    const result = await undoAction(
        target.auditLogId,
        actor.userId ?? "__telegram_admin__",
        `[telegram /desfazer] ${message.text}`,
        adminOpts,
    );

    if (!result.success) {
        await markTelegramProcessed(logId, {
            status: "error",
            errorMessage: result.message,
            parsedAction: "undo_confirm",
            resolutionData: { auditLogId: target.auditLogId, action: target.action },
        });
        await sendMessage(message.chat.id, `:/ ${result.message}`, message.message_id);
        return { ok: true, ignored: true };
    }

    const label = await buildUndoActionLabel(target);
    await markTelegramProcessed(logId, {
        status: "accepted",
        parsedAction: "undo_confirm",
        resolutionData: { auditLogId: target.auditLogId, action: target.action },
    });
    await sendMessage(message.chat.id, `✅ Desfeito: ${label}\n${result.message}`, message.message_id);
    return { ok: true };
}

async function buildUndoActionLabel(entry: UndoableEntry): Promise<string> {
    const db = getDb();
    const details = entry.details;
    const doctorId = (details.beforeSnapshot as Record<string, unknown> | undefined)?.doctorId as string
        ?? details.doctorId as string
        ?? null;

    let doctorName = "?";
    if (doctorId) {
        const doc = await db.query.doctors.findFirst({ where: eq(doctors.id, doctorId) });
        if (doc) doctorName = doc.displayName ?? doc.fullName;
    }

    const postId = (details.beforeSnapshot as Record<string, unknown> | undefined)?.postId as number
        ?? details.postId as number
        ?? null;
    const baseId = (details.beforeSnapshot as Record<string, unknown> | undefined)?.baseId as number
        ?? details.baseId as number
        ?? null;

    let targetLabel = "";
    if (postId) {
        const post = await db.query.regulationPosts.findFirst({ where: eq(regulationPosts.id, postId) });
        if (post) targetLabel = post.code;
    } else if (baseId) {
        const base = await db.query.interventionBases.findFirst({ where: eq(interventionBases.id, baseId) });
        if (base) targetLabel = base.code;
    }

    const actionLabels: Record<string, string> = {
        "regulation_occupancy.started": "Início regulação",
        "regulation_occupancy.corrected": "Correção regulação",
        "regulation_occupancy.deleted": "Remoção regulação",
        "intervention_occupancy.started": "Início intervenção",
        "intervention_occupancy.corrected": "Correção intervenção",
        "intervention_occupancy.deleted": "Remoção intervenção",
        "operational_occupancy.transferred": "Remanejamento",
    };

    const actionLabel = actionLabels[entry.action] ?? entry.action;
    const parts = [actionLabel];
    if (targetLabel) parts.push(targetLabel);
    if (doctorName !== "?") parts.push(doctorName);
    return parts.join(" — ");
}

async function handleOperationalBaseStateCommand(params: {
    message: TelegramUpdate["message"];
    logId: string;
    actor: TelegramCommandActor;
    command: NonNullable<ReturnType<typeof parseTelegramCommand>>;
}) {
    const { message, logId, actor, command } = params;
    if (!message) {
        return { ok: true, ignored: true };
    }

    const usage = "/desativar PM40 | /desativar PM40 19:00 | /ativar PM40 | /ativar PM40 19:10 | /desativar 2031 | /ativar 2031 19:10";
    const isRegulation = command.sector === "REGULATION";
    const target = isRegulation
        ? await findRegulationPostByCode(command.targetCode)
        : await findInterventionBaseByCode(command.targetCode);

    if (!target) {
        await markTelegramProcessed(logId, {
            status: "ignored",
            errorMessage: "command_target_not_found",
            parsedDomain: command.sector,
            parsedTargetCode: command.targetCode,
            parsedAction: command.name,
            resolutionData: { commandName: command.name, commandBody: command.rawBody },
        });
        await sendMessage(message.chat.id, `:/ Nao encontrei ${isRegulation ? "o ramal" : "a base"} ${command.targetCode} para aplicar ${command.name}.`, message.message_id);
        return { ok: true, ignored: true };
    }

    const eventAt = resolveTelegramEventTime(new Date(message.date * 1000), command.time);

    try {
        if (command.name === "desativar") {
            const result = isRegulation
                ? await deactivateRegulationPost({
                    postId: target.id,
                    deactivatedAt: eventAt,
                    notes: `[telegram /desativar] ${message.text}`,
                    createdByUserId: actor.userId,
                })
                : await deactivateInterventionBase({
                    baseId: target.id,
                    deactivatedAt: eventAt,
                    notes: `[telegram /desativar] ${message.text}`,
                    createdByUserId: actor.userId,
                });

            await markTelegramProcessed(logId, {
                status: "accepted",
                parsedDomain: command.sector,
                parsedTargetCode: command.targetCode,
                parsedAction: command.name,
                relatedOccupancyId: result.closedOccupancyIds[0] ?? null,
                resolutionData: {
                    actorRoles: actor.roles,
                    commandName: command.name,
                    targetId: target.id,
                    effectiveAt: eventAt.toISOString(),
                    closedOccupancyIds: result.closedOccupancyIds,
                },
            });
            await sendMessage(
                message.chat.id,
                `${isRegulation ? "Ramal" : "Base"} ${command.targetCode} ${isRegulation ? "desativado" : "desativada"} às ${formatTelegramReplyTime(eventAt)}.${result.closedOccupancyIds.length > 0 ? ` ${result.closedOccupancyIds.length} cobertura${result.closedOccupancyIds.length > 1 ? "s foram" : " foi"} encerrada${result.closedOccupancyIds.length > 1 ? "s" : ""} com auditoria.` : " Quadro atualizado."}`,
                message.message_id,
            );
            return { ok: true, updated: true };
        }

        const state = isRegulation
            ? await reactivateRegulationPost({
                postId: target.id,
                reactivatedAt: eventAt,
                updatedByUserId: actor.userId,
            })
            : await reactivateInterventionBase({
                baseId: target.id,
                reactivatedAt: eventAt,
                updatedByUserId: actor.userId,
            });

        await markTelegramProcessed(logId, {
            status: "accepted",
            parsedDomain: command.sector,
            parsedTargetCode: command.targetCode,
            parsedAction: command.name,
            relatedOccupancyId: null,
            resolutionData: {
                actorRoles: actor.roles,
                commandName: command.name,
                targetId: target.id,
                deactivatedAt: state.deactivatedAt,
                reactivatedAt: state.reactivatedAt,
            },
        });
        await sendMessage(message.chat.id, `${isRegulation ? "Ramal" : "Base"} ${command.targetCode} ${isRegulation ? "reativado" : "reativada"} às ${formatTelegramReplyTime(eventAt)} e ${isRegulation ? "liberado" : "liberada"} para nova cobertura.`, message.message_id);
        return { ok: true, updated: true };
    } catch (error) {
        await markTelegramProcessed(logId, {
            status: "error",
            parsedDomain: command.sector,
            parsedTargetCode: command.targetCode,
            parsedAction: command.name,
            errorMessage: error instanceof Error ? error.message : "command_base_state_failed",
            resolutionData: {
                actorRoles: actor.roles,
                commandName: command.name,
                targetId: target.id,
            },
        });
        await sendMessage(message.chat.id, `:/ Nao consegui ${command.name} ${command.targetCode}. ${error instanceof Error ? error.message : "Falha inesperada."}`, message.message_id);
        return { ok: true, ignored: true };
    }
}

interface HistoricalRemovableOccupancy {
    occupancyId: string;
    doctorId: string;
    startedAt: Date;
    shiftLabel: "SD" | "SN" | "P" | null;
}

function normalizeHistoricalShiftLabel(value: string | null): HistoricalRemovableOccupancy["shiftLabel"] {
    return value === "SD" || value === "SN" || value === "P" ? value : null;
}

function resolveHistoricalRemovalLookback(referenceAt: Date) {
    const shiftWindow = resolveOperationalShiftWindow(referenceAt);
    return new Date(shiftWindow.startedAt.getTime() - (72 * 60 * 60 * 1000));
}

function formatHistoricalRemovalReference(occupancy: HistoricalRemovableOccupancy) {
    return `${occupancy.shiftLabel ?? "--"} ${formatTelegramReplyTime(occupancy.startedAt)}`;
}

async function findHistoricalRemovableOccupancies(params: {
    parsed: OperationalParsedEntry;
    doctorId: string;
    shiftLabel?: "SD" | "SN" | "P" | null;
    referenceAt: Date;
}) {
    const db = getDb();
    const lookbackStartedAt = resolveHistoricalRemovalLookback(params.referenceAt);

    if (params.parsed.sector === "REGULATION") {
        const post = await db.query.regulationPosts.findFirst({ where: eq(regulationPosts.code, params.parsed.baseCode) });
        if (!post) {
            throw new Error("Regulation post not found.");
        }

        const rows = await db.query.regulationOccupancies.findMany({
            where: and(
                eq(regulationOccupancies.postId, post.id),
                eq(regulationOccupancies.doctorId, params.doctorId),
                gte(regulationOccupancies.startedAt, lookbackStartedAt),
                params.shiftLabel ? eq(regulationOccupancies.shiftLabel, params.shiftLabel) : undefined,
            ),
            orderBy: [desc(regulationOccupancies.startedAt)],
            limit: 5,
            columns: {
                id: true,
                doctorId: true,
                startedAt: true,
                shiftLabel: true,
            },
        });

        return rows.map((row) => ({
            occupancyId: row.id,
            doctorId: row.doctorId,
            startedAt: row.startedAt,
            shiftLabel: normalizeHistoricalShiftLabel(row.shiftLabel),
        } satisfies HistoricalRemovableOccupancy));
    }

    const base = await db.query.interventionBases.findFirst({ where: eq(interventionBases.code, params.parsed.baseCode) });
    if (!base) {
        throw new Error("Intervention base not found.");
    }

    const rows = await db.query.interventionOccupancies.findMany({
        where: and(
            eq(interventionOccupancies.baseId, base.id),
            eq(interventionOccupancies.doctorId, params.doctorId),
            gte(interventionOccupancies.startedAt, lookbackStartedAt),
            params.shiftLabel ? eq(interventionOccupancies.shiftLabel, params.shiftLabel) : undefined,
        ),
        orderBy: [desc(interventionOccupancies.startedAt)],
        limit: 5,
        columns: {
            id: true,
            doctorId: true,
            startedAt: true,
            shiftLabel: true,
        },
    });

    return rows.map((row) => ({
        occupancyId: row.id,
        doctorId: row.doctorId,
        startedAt: row.startedAt,
        shiftLabel: normalizeHistoricalShiftLabel(row.shiftLabel),
    } satisfies HistoricalRemovableOccupancy));
}

async function tryHandleHistoricalRemovalCommand(params: {
    message: TelegramUpdate["message"];
    logId: string;
    actor: TelegramCommandActor;
    command: NonNullable<ReturnType<typeof parseTelegramCommand>>;
}) {
    const { message, logId, actor, command } = params;
    if (!message) {
        return { ok: true, ignored: true };
    }

    if (!command.doctorName) {
        await markTelegramProcessed(logId, {
            status: "ignored",
            errorMessage: "command_remove_historical_usage_invalid",
            parsedDomain: command.sector,
            parsedTargetCode: command.targetCode,
            parsedAction: command.name,
            resolutionData: { commandName: command.name, commandBody: command.rawBody },
        });
        await sendMessage(message.chat.id, `:/ ${command.targetCode} não tem ocupação ativa agora. Para apagar um registro já fechado do banco, informe também o médico. Ex.: /remover Aline ${command.targetCode} SD.`, message.message_id);
        return { ok: true, ignored: true };
    }

    const resolved = await resolveDoctorWithFallback(command.doctorName);
    if (!resolved.doctor) {
        await markTelegramProcessed(logId, {
            status: "ignored",
            errorMessage: "command_doctor_not_resolved",
            parsedDomain: command.sector,
            parsedTargetCode: command.targetCode,
            parsedAction: command.name,
            resolutionData: {
                doctorQuery: command.doctorName,
                candidates: resolved.candidates.slice(0, 3),
                historicalRemoval: true,
            },
        });
        await sendMessage(message.chat.id, buildNameUnresolvedReply(message.message_id, resolved.candidates), message.message_id);
        return { ok: true, ignored: true };
    }

    const parsedEntry: OperationalParsedEntry = {
        sector: command.sector,
        baseCode: command.targetCode,
        arrivalTime: command.time,
        shiftType: command.shiftLabel,
        roleFunction: command.roleLabel,
        isDeparture: command.isDeparture,
        isContinuation: false,
        isReassignment: false,
    };

    const candidates = await findHistoricalRemovableOccupancies({
        parsed: parsedEntry,
        doctorId: resolved.doctor.id,
        shiftLabel: command.shiftLabel,
        referenceAt: new Date(message.date * 1000),
    });

    if (candidates.length === 0) {
        await markTelegramProcessed(logId, {
            status: "ignored",
            errorMessage: "command_historical_record_not_found",
            parsedDomain: command.sector,
            parsedTargetCode: command.targetCode,
            parsedAction: command.name,
            parsedDoctorName: resolved.doctor.fullName,
            resolutionData: {
                historicalRemoval: true,
                requestedShiftLabel: command.shiftLabel,
            },
        });
        await sendMessage(message.chat.id, `:/ Não encontrei registro recente de ${resolved.doctor.fullName} em ${command.targetCode}${command.shiftLabel ? ` no ${command.shiftLabel}` : ""} para apagar.`, message.message_id);
        return { ok: true, ignored: true };
    }

    if (candidates.length > 1 && !command.shiftLabel) {
        await markTelegramProcessed(logId, {
            status: "ignored",
            errorMessage: "command_historical_record_ambiguous",
            parsedDomain: command.sector,
            parsedTargetCode: command.targetCode,
            parsedAction: command.name,
            parsedDoctorName: resolved.doctor.fullName,
            resolutionData: {
                historicalRemoval: true,
                candidates: candidates.map((candidate) => formatHistoricalRemovalReference(candidate)),
            },
        });
        await sendMessage(message.chat.id, `:/ Achei mais de um registro recente de ${resolved.doctor.fullName} em ${command.targetCode}. Acrescente o turno para apagar o certo. Recentes: ${candidates.map((candidate) => formatHistoricalRemovalReference(candidate)).join(" | ")}.`, message.message_id);
        return { ok: true, ignored: true };
    }

    const target = candidates[0] as HistoricalRemovableOccupancy;
    const deleted = command.sector === "REGULATION"
        ? await removeRegulationOccupancyRecord(target.occupancyId, resolveCommandAuditUserId(actor.userId))
        : await removeInterventionOccupancyRecord(target.occupancyId, resolveCommandAuditUserId(actor.userId));

    await markTelegramProcessed(logId, {
        status: "accepted",
        parsedDomain: command.sector,
        parsedTargetCode: command.targetCode,
        parsedAction: command.name,
        parsedDoctorName: resolved.doctor.fullName,
        relatedOccupancyId: null,
        resolutionData: {
            actorRoles: actor.roles,
            commandName: command.name,
            historicalRemoval: true,
            removedStartedAt: deleted.startedAt,
            removedShiftLabel: deleted.shiftLabel,
        },
    });
    await sendMessage(message.chat.id, `Registro apagado de ${command.targetCode}: ${resolveTelegramDoctorSurfaceName(resolved.doctor)} (${deleted.shiftLabel ?? "--"} ${formatTelegramReplyTime(deleted.startedAt)}). O plantão foi removido do banco.`, message.message_id);
    return { ok: true, removed: true };
}

async function loadDoctorFullName(doctorId: string) {
    const db = getDb();
    const doctor = await db.query.doctors.findFirst({ where: eq(doctors.id, doctorId) });
    return doctor?.fullName ?? "Medico nao identificado";
}

async function loadDoctorSurfaceName(doctorId: string) {
    const doctor = await loadDoctorById(doctorId);
    return resolveTelegramDoctorSurfaceName(doctor);
}

async function loadDoctorById(doctorId: string | null | undefined) {
    if (!doctorId) {
        return null;
    }

    const db = getDb();
    return db.query.doctors.findFirst({ where: eq(doctors.id, doctorId) });
}

function resolveCommandAuditUserId(actorUserId: string | null | undefined) {
    return actorUserId ?? null;
}

function doctorMatchesCommandQuery(query: string, doctor: { fullName: string; displayName: string | null; metadata?: unknown }) {
    const normalizedQuery = normalizeDoctorName(query);
    if (!normalizedQuery) {
        return false;
    }

    const queryTokens = normalizedQuery.split(/\s+/).filter(Boolean);
    if (queryTokens.length === 0) {
        return false;
    }

    const doctorTokens = new Set(normalizeDoctorName(doctor.fullName).split(/\s+/).filter(Boolean));
    const displayTokens = new Set(normalizeDoctorName(doctor.displayName ?? "").split(/\s+/).filter(Boolean));
    const aliasTokens = new Set(
        extractDoctorAliases(doctor.metadata)
            .flatMap((alias) => normalizeDoctorName(alias).split(/\s+/).filter(Boolean)),
    );

    return queryTokens.every((token) => doctorTokens.has(token) || displayTokens.has(token) || aliasTokens.has(token));
}

async function resolveCommandDoctor(params: {
    doctorQuery: string | null;
    activeDoctorId: string | null | undefined;
}) {
    const activeDoctor = await loadDoctorById(params.activeDoctorId);

    if (!params.doctorQuery) {
        return {
            doctor: activeDoctor,
            candidates: [] as TelegramDoctorCandidate[],
            usedActiveDoctorFallback: Boolean(activeDoctor),
        };
    }

    const exact = await resolveDoctorId(params.doctorQuery);
    if (exact) {
        return {
            doctor: exact,
            candidates: [] as TelegramDoctorCandidate[],
            usedActiveDoctorFallback: false,
        };
    }

    if (activeDoctor && doctorMatchesCommandQuery(params.doctorQuery, activeDoctor)) {
        return {
            doctor: activeDoctor,
            candidates: [] as TelegramDoctorCandidate[],
            usedActiveDoctorFallback: true,
        };
    }

    const { doctor, candidates } = await resolveDoctorWithFallback(params.doctorQuery);
    if (doctor) {
        return {
            doctor,
            candidates,
            usedActiveDoctorFallback: false,
        };
    }

    const confidentCandidate = pickConfidentDoctorCandidate(params.doctorQuery, candidates);
    if (confidentCandidate) {
        const inferredDoctor = await loadDoctorById(confidentCandidate.id);
        if (inferredDoctor) {
            return {
                doctor: inferredDoctor,
                candidates,
                usedActiveDoctorFallback: false,
            };
        }
    }

    if (candidates.length === 1 && candidates[0].score >= 180) {
        const singleCandidate = await loadDoctorById(candidates[0].id);
        if (singleCandidate) {
            return {
                doctor: singleCandidate,
                candidates,
                usedActiveDoctorFallback: false,
            };
        }
    }

    if (activeDoctor) {
        const activeCandidate = candidates.find((candidate) => candidate.id === activeDoctor.id);
        if (activeCandidate && activeCandidate.score >= 140) {
            return {
                doctor: activeDoctor,
                candidates,
                usedActiveDoctorFallback: true,
            };
        }
    }

    return {
        doctor: null,
        candidates,
        usedActiveDoctorFallback: false,
    };
}

async function resolveOperationalDoctorFromSenderRecentHistory(params: {
    chatId: string;
    senderTelegramId: string;
    referenceAt: Date;
}) {
    const db = getDb();
    const lookback = new Date(params.referenceAt.getTime() - (36 * 60 * 60 * 1000));

    const recentMessages = await db.query.telegramIngestedMessages.findMany({
        where: and(
            eq(telegramIngestedMessages.chatId, params.chatId),
            eq(telegramIngestedMessages.senderTelegramId, params.senderTelegramId),
            eq(telegramIngestedMessages.status, "accepted"),
            gte(telegramIngestedMessages.createdAt, lookback),
        ),
        orderBy: [desc(telegramIngestedMessages.createdAt)],
        limit: 12,
        columns: {
            relatedOccupancyId: true,
        },
    });

    const occupancyIds = [...new Set(
        recentMessages
            .map((message) => message.relatedOccupancyId)
            .filter((value): value is string => Boolean(value)),
    )];
    if (occupancyIds.length === 0) {
        return null;
    }

    const [regOccupancies, intOccupancies] = await Promise.all([
        db.query.regulationOccupancies.findMany({
            where: inArray(regulationOccupancies.id, occupancyIds),
            columns: { id: true, doctorId: true },
        }),
        db.query.interventionOccupancies.findMany({
            where: inArray(interventionOccupancies.id, occupancyIds),
            columns: { id: true, doctorId: true },
        }),
    ]);

    const doctorByOccupancyId = new Map<string, string>([
        ...regOccupancies.map((occupancy) => [occupancy.id, occupancy.doctorId] as const),
        ...intOccupancies.map((occupancy) => [occupancy.id, occupancy.doctorId] as const),
    ]);

    const orderedDoctorIds = recentMessages
        .map((message) => message.relatedOccupancyId ? doctorByOccupancyId.get(message.relatedOccupancyId) ?? null : null)
        .filter((value): value is string => Boolean(value));
    if (orderedDoctorIds.length === 0) {
        return null;
    }

    // Conservative guard: only infer when sender recent history points to a single doctor.
    const uniqueDoctorIds = [...new Set(orderedDoctorIds.slice(0, 5))];
    if (uniqueDoctorIds.length !== 1) {
        return null;
    }

    return db.query.doctors.findFirst({ where: eq(doctors.id, uniqueDoctorIds[0]) });
}

export function shouldAttemptSenderHistoryContinuationFallback(params: {
    parsed: OperationalParsedEntry;
    doctorQuery: string | null;
    senderName: string | null;
    messageText: string;
    chatId?: string | null;
    senderTelegramId?: string | null;
}) {
    return Boolean(
        !params.parsed.isDeparture
        && params.parsed.isContinuation
        && !params.doctorQuery
        && params.chatId
        && params.senderTelegramId
        && shouldUseTelegramSenderNameFallback(params.messageText, params.senderName),
    );
}

async function resolveOperationalDoctor(params: {
    parsed: OperationalParsedEntry;
    doctorQuery: string | null;
    senderName: string | null;
    messageText: string;
    chatId?: string | null;
    senderTelegramId?: string | null;
    referenceAt?: Date;
}) {
    const active = params.parsed.baseCode ? await findActiveOccupancyByTarget(params.parsed) : null;
    const activeDoctorId = active?.occupancy?.doctorId;

    if (params.parsed.isDeparture) {
        if (params.doctorQuery) {
            return {
                ...(await resolveCommandDoctor({
                    doctorQuery: params.doctorQuery,
                    activeDoctorId,
                })),
                matchedBy: "command" as const,
                active,
            };
        }

        const lookupQuery = resolveOperationalDoctorLookupQuery({
            doctorQuery: null,
            senderName: params.senderName,
            messageText: params.messageText,
        });
        const resolved = lookupQuery
            ? await resolveDoctorWithFallback(lookupQuery)
            : { doctor: null, candidates: [] as TelegramDoctorCandidate[], matchedBy: "none" as const };

        return {
            doctor: resolved.doctor,
            candidates: resolved.candidates,
            usedActiveDoctorFallback: false,
            matchedBy: resolved.matchedBy,
            active,
        };
    }

    const lookupQuery = resolveOperationalDoctorLookupQuery({
        doctorQuery: params.doctorQuery,
        senderName: params.senderName,
        messageText: params.messageText,
    });
    const resolved = lookupQuery
        ? await resolveDoctorWithFallback(lookupQuery)
        : { doctor: null, candidates: [] as TelegramDoctorCandidate[], matchedBy: "none" as const };

    if (
        !resolved.doctor
        && params.referenceAt
        && shouldAttemptSenderHistoryContinuationFallback({
            parsed: params.parsed,
            doctorQuery: params.doctorQuery,
            senderName: params.senderName,
            messageText: params.messageText,
            chatId: params.chatId,
            senderTelegramId: params.senderTelegramId,
        })
    ) {
        const inferredDoctor = await resolveOperationalDoctorFromSenderRecentHistory({
            chatId: params.chatId!,
            senderTelegramId: params.senderTelegramId!,
            referenceAt: params.referenceAt,
        });
        if (inferredDoctor) {
            return {
                doctor: inferredDoctor,
                candidates: resolved.candidates,
                usedActiveDoctorFallback: false,
                matchedBy: "sender_history" as const,
                active,
            };
        }
    }

    return {
        doctor: resolved.doctor,
        candidates: resolved.candidates,
        usedActiveDoctorFallback: false,
        matchedBy: resolved.matchedBy,
        active,
    };
}

function buildDoctorDirectoryUsageReply() {
    return `:/ Use ${TELEGRAM_DOCTOR_ADMIN_COMMAND_USAGE}. Para corrigir cadastro existente: /medico atualizar Busca Atual | Nome Completo Correto | Nome de exibicao | codigo | alias 1, alias 2.`;
}

function buildDoctorDirectorySummary(doctor: {
    fullName: string;
    displayName: string | null;
    externalCode: string | null;
    metadata?: unknown;
    aliases?: string[];
}) {
    const details: string[] = [];
    const aliases = doctor.aliases ?? extractDoctorAliases(doctor.metadata);

    if (doctor.displayName && normalizeDoctorName(doctor.displayName) !== normalizeDoctorName(doctor.fullName)) {
        details.push(`exibicao ${doctor.displayName}`);
    }

    if (doctor.externalCode) {
        details.push(`codigo ${doctor.externalCode}`);
    }

    if (aliases.length > 0) {
        details.push(`aliases ${aliases.join(", ")}`);
    }

    return details.length > 0 ? ` (${details.join(", ")})` : "";
}

function buildPaymentCommandUsageReply() {
    return `:/ Use ${TELEGRAM_PAYMENT_REPORT_USAGE} para conferir e ${TELEGRAM_PAYMENT_CORRECTION_USAGE} para corrigir o médico escolhido para pagamento.`;
}

function buildDepartureReportCommandUsageReply() {
    return `:/ Use ${TELEGRAM_DEPARTURE_REPORT_USAGE}. Se mandar só /saidas, eu trago o turno anterior.`;
}

function buildShiftReportCommandUsageReply() {
    return ":/ Use /plantao para pedir o relato do turno atual. Se quiser, pode escrever /plantao agora, mas não precisa de mais nada.";
}

function buildSummaryReportCommandUsageReply() {
    return `:/ Use ${TELEGRAM_SUMMARY_REPORT_USAGE}. Se quiser, pode escrever /resumo agora, mas não precisa de mais nada.`;
}

export function buildPublicTelegramCommandHelpReply() {
    return [
        "⚠️ Não reconheci esse comando.",
        "",
        "Comandos disponíveis para qualquer pessoa:",
        "• /plantao -> mostra o relato do turno atual (quem está em cada base e ramal).",
        "• /resumo -> mostra um resumo rápido da operação (contagens e status geral).",
        "• /saidas -> mostra o relatório de saídas do turno (quem saiu e horários).",
    ].join("\n");
}

async function listRecentTelegramSenderMessages(params: {
    chatId: string;
    senderTelegramId?: string | null;
    senderName?: string | null;
    currentLogId: string;
    limit?: number;
}) {
    const db = getDb();
    const limit = params.limit ?? 5;

    if (!params.senderTelegramId && !params.senderName) {
        return [] as TelegramRecentSenderMessage[];
    }

    const senderFilter = params.senderTelegramId
        ? eq(telegramIngestedMessages.senderTelegramId, params.senderTelegramId)
        : eq(telegramIngestedMessages.senderName, params.senderName ?? "");

    return db.select({
        rawText: telegramIngestedMessages.rawText,
        parsedAction: telegramIngestedMessages.parsedAction,
        parsedTargetCode: telegramIngestedMessages.parsedTargetCode,
        parsedDoctorName: telegramIngestedMessages.parsedDoctorName,
        status: telegramIngestedMessages.status,
        errorMessage: telegramIngestedMessages.errorMessage,
    })
        .from(telegramIngestedMessages)
        .where(and(
            eq(telegramIngestedMessages.chatId, params.chatId),
            senderFilter,
            ne(telegramIngestedMessages.id, params.currentLogId),
        ))
        .orderBy(desc(telegramIngestedMessages.createdAt))
        .limit(limit);
}

function buildBankHoursCommandUsageReply() {
    return `:/ Use ${TELEGRAM_BANK_HOURS_USAGE}. Ex.: /banco Aline SN 0`;
}

function formatOperationalDateKey(value: Date) {
    const parts = getSaoPauloParts(value);
    return `${String(parts.year).padStart(4, "0")}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
}

function formatTelegramBankMinutes(value: number) {
    const sign = value > 0 ? "+" : value < 0 ? "-" : "";
    return `${sign}${Math.abs(value)} min`;
}

export function resolveLatestClosedShiftRequest(referenceAt: Date, targetShiftLabel: "SD" | "SN") {
    let probe = new Date(referenceAt);

    for (let attempt = 0; attempt < 8; attempt += 1) {
        const window = resolveOperationalShiftWindow(probe);
        if (window.shiftLabel === targetShiftLabel && window.nextBoundaryAt.getTime() <= referenceAt.getTime()) {
            return {
                operationalDate: formatOperationalDateKey(window.startedAt),
                shiftLabel: targetShiftLabel,
            };
        }

        probe = new Date(window.startedAt.getTime() - 60000);
    }

    throw new Error(`Nao encontrei um plantao ${targetShiftLabel} encerrado para revisar o banco.`);
}

async function sendTelegramReplyBatch(
    chatId: string | number,
    texts: string[],
    replyToMessageId?: number,
    session?: Parameters<typeof buildMealBreakStageKeyboard>[0] | null,
) {
    await sendTelegramMealBreakMessages({
        chatId,
        messages: texts,
        replyToMessageId,
        replyMarkup: session ? (buildMealBreakStageKeyboard(session) ?? undefined) : undefined,
    });
}

async function sendPrivateAdminAlert(text: string, excludeChatIds: string[] = []) {
    const adminChatIds = [...new Set(getTelegramAdminUserIds())].filter((chatId) => chatId && !excludeChatIds.includes(chatId));
    if (adminChatIds.length === 0) {
        return;
    }

    await Promise.allSettled(adminChatIds.map((chatId) => sendMessage(chatId, text)));
}

function normalizePaymentTargetCode(value: string) {
    return value.trim().toUpperCase().replace(/\s+/g, "");
}

function formatPaymentAllocationDateLabel(operationalDateIso: string) {
    return new Intl.DateTimeFormat("pt-BR", {
        dateStyle: "short",
        timeZone: "America/Sao_Paulo",
    }).format(new Date(operationalDateIso));
}

function summarizePaymentAllocationIssues(issues: string[]) {
    return issues.slice(0, 2).join("; ");
}

export function shouldDeferPendingNameSelectionToFreshParsing(text: string, candidates: TelegramDoctorCandidate[]) {
    const cleaned = text.trim();
    if (!cleaned) {
        return false;
    }

    if (parseMessageMulti(cleaned).some(isOperationalParsedEntry)) {
        return true;
    }

    if (/^([1-9]\d*)$/.test(cleaned)) {
        return false;
    }

    if (pickCandidateFromReply(cleaned, candidates)) {
        return false;
    }

    return false;
}

export function shouldDeferPendingDepartureJustificationToFreshParsing(text: string) {
    const cleaned = text.trim();
    if (!cleaned) {
        return false;
    }

    const parsedEntries = parseMessageMulti(cleaned).filter(isOperationalParsedEntry);
    if (parsedEntries.length === 0) {
        return false;
    }

    const normalized = cleaned.toUpperCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
    const hasArrivalIntent = /\b(?:CHEGUEI|CHEGANDO|CHEGADA|PRESENTE|ASSUMINDO|ASSUMI|RENDENDO|RENDI|CONT\.?|CONTINUA|CONTINUO|CONTINUANDO|CONTINUAR|SEGUINDO|SEGUIR|SIGO|FICO|FICANDO|FIQUEI|FICAR|PERMANECO|PERMANECENDO|PERMANECE|PERMANECER|EMENDO|EMENDANDO|EMENDA|EMENDAR|PROSSIGO|PROSSEGUINDO|PROSSEGUIR)\b/.test(normalized)
        || /\b(?:VOU|VAI|VAMOS)\s+(?:CONTINUAR|FICAR|PERMANECER|SEGUIR|EMENDAR|PROSSEGUIR)\b/.test(normalized);

    return parsedEntries.some((entry) => entry.isDeparture || entry.isContinuation || Boolean(entry.arrivalTime) || Boolean(entry.shiftType))
        || hasArrivalIntent;
}

export function shouldDeferPendingDepartureCorrectionToFreshParsing(text: string) {
    const cleaned = text.trim();
    if (!cleaned) {
        return false;
    }

    if (cleaned.startsWith("/")) {
        return true;
    }

    return parseMessageMulti(cleaned).some(isOperationalParsedEntry);
}

function buildPaymentAllocationReportLine(row: PaymentAllocationRow) {
    if (row.disabledEntireShift) {
        return `DSV ${row.targetCode} - base desativada`;
    }

    if (!row.occupancyId) {
        return `VAZ ${row.targetCode} - sem ocupacao`;
    }

    const name = formatDoctorSurfaceName({
        fullName: row.doctorName,
        displayName: row.displayName,
        fallback: "medico nao identificado",
    });
    const halfTag = isHalfShiftRoleLabel(row.roleLabel) ? " [MEIO]" : "";
    if (row.paymentStatus === "ready_for_payment") {
        return `OK ${row.targetCode} - ${name}${halfTag}`;
    }

    return `REV ${row.targetCode} - ${name}${halfTag} | ${summarizePaymentAllocationIssues(row.issues)}`;
}

function buildPaymentAllocationReportReply(board: PaymentAllocationBoard) {
    const header = [
        `:) Conferencia de pagamento ${formatPaymentAllocationDateLabel(board.operationalDate)} ${board.shiftLabel}.`,
        `Prontos ${board.summary.readyForPaymentCount} | revisar ${board.summary.needsReviewCount} | vazios ${board.summary.unassignedCount} | desativadas ${board.summary.disabledCount ?? 0}`,
    ].join("\n");

    const regulationBlock = board.regulation.length > 0
        ? `\n\nRegulacao:\n${board.regulation.map(buildPaymentAllocationReportLine).join("\n")}`
        : "";
    const interventionBlock = board.intervention.length > 0
        ? `\n\nIntervencao:\n${board.intervention.map(buildPaymentAllocationReportLine).join("\n")}`
        : "";

    return `${header}${regulationBlock}${interventionBlock}`;
}

function findPaymentAllocationRow(board: PaymentAllocationBoard, targetCode: string) {
    const normalizedTargetCode = normalizePaymentTargetCode(targetCode);
    return [...board.regulation, ...board.intervention].find((row) => normalizePaymentTargetCode(row.targetCode) === normalizedTargetCode) ?? null;
}

function describePaymentAllocationOutcome(row: PaymentAllocationRow | null) {
    if (!row) {
        return "nao consegui reavaliar o alvo depois da correcao";
    }

    if (!row.occupancyId) {
        return "o alvo ficou sem ocupacao identificada";
    }

    if (row.paymentStatus === "ready_for_payment") {
        return "o alvo ficou pronto para pagamento";
    }

    return `o alvo ainda precisa revisao: ${summarizePaymentAllocationIssues(row.issues)}`;
}

async function handleTelegramCommand(update: TelegramUpdate, logId: string) {
    const message = update.message;
    if (!message?.text) {
        return null;
    }

    const slotAuditCommand = parseTelegramSlotAuditCommand(message.text, new Date(message.date * 1000));
    if (slotAuditCommand || isTelegramSlotAuditCommandText(message.text)) {
        if (!slotAuditCommand) {
            await markTelegramProcessed(logId, {
                status: "ignored",
                errorMessage: "slot_audit_usage_invalid",
                parsedAction: "slot_audit_command",
                resolutionData: { rawCommand: message.text },
            });
            await sendMessage(message.chat.id, `:/ Use ${TELEGRAM_SLOT_AUDIT_USAGE}. Sem argumentos eu trago os ultimos 7 dias.`, message.message_id);
            return { ok: true, ignored: true };
        }

        if (!canRunPrivateAdminSlotAudit(message)) {
            await markTelegramProcessed(logId, {
                status: "ignored",
                errorMessage: "slot_audit_private_admin_forbidden",
                parsedAction: "slot_audit_command",
                resolutionData: { rawCommand: message.text },
            });
            await sendMessage(message.chat.id, ":/ Auditoria de slots so roda no privado para o admin configurado do bot.", message.message_id);
            return { ok: true, ignored: true };
        }

        try {
            const report = await getOperationalSlotAuditReport({
                startDate: slotAuditCommand.startDate,
                endDate: slotAuditCommand.endDate,
                shiftLabel: slotAuditCommand.shiftLabel,
                reference: new Date(message.date * 1000),
            });
            const messages = buildTelegramSlotAuditMessages(report);

            await markTelegramProcessed(logId, {
                status: "accepted",
                parsedAction: "slot_audit_command",
                resolutionData: {
                    commandName: slotAuditCommand.name,
                    startDate: report.startDate,
                    endDate: report.endDate,
                    shiftLabel: report.shiftLabel,
                    slotCount: report.summary.slotCount,
                    emptyCount: report.summary.emptyCount,
                    occupiedCount: report.summary.occupiedCount,
                    disabledCount: report.summary.disabledCount,
                },
            });
            await sendTelegramReplyBatch(message.chat.id, messages, message.message_id);
            return { ok: true, slotAudit: true };
        } catch (error) {
            await markTelegramProcessed(logId, {
                status: "error",
                errorMessage: error instanceof Error ? error.message : "slot_audit_failed",
                parsedAction: "slot_audit_command",
                resolutionData: { rawCommand: message.text },
            });
            await sendMessage(message.chat.id, error instanceof Error ? error.message : `:/ Use ${TELEGRAM_SLOT_AUDIT_USAGE}.`, message.message_id);
            return { ok: true, ignored: true };
        }
    }

    const mealBreakExcludeCommand = parseTelegramMealBreakExcludeCommand(message.text);
    if (mealBreakExcludeCommand || isTelegramMealBreakExcludeCommandText(message.text)) {
        if (!mealBreakExcludeCommand) {
            await markTelegramProcessed(logId, {
                status: "ignored",
                errorMessage: "meal_break_exclude_usage_invalid",
                parsedAction: "meal_break_exclude_command",
                resolutionData: { rawCommand: message.text },
            });
            await sendMessage(message.chat.id, buildMealBreakExcludeCommandUsageReply(), message.message_id);
            return { ok: true, ignored: true };
        }

        const actor = await resolveTelegramCommandActor(message);
        if (!actor?.roles.includes("admin") && !actor?.roles.includes("chief")) {
            await markTelegramProcessed(logId, {
                status: "ignored",
                errorMessage: "meal_break_exclude_forbidden",
                parsedAction: "meal_break_exclude_command",
                resolutionData: { rawCommand: message.text },
            });
            await sendMessage(message.chat.id, ":/ Apenas chefes e admins podem excluir ou incluir medicos na divisao.", message.message_id);
            return { ok: true, ignored: true };
        }

        const exclude = /^\/excluir/i.test(message.text.trim());
        try {
            const result = await runTelegramMealBreakExcludeCommand({
                ramal: mealBreakExcludeCommand.ramal,
                exclude,
                referenceAt: new Date(message.date * 1000),
                actorTelegramId: resolveTelegramMealBreakSenderId(update),
            });

            await markTelegramProcessed(logId, {
                status: "accepted",
                parsedAction: "meal_break_exclude_command",
                resolutionData: {
                    ramal: mealBreakExcludeCommand.ramal,
                    exclude,
                    resultStatus: result.status,
                },
            });
            await sendTelegramReplyBatch(message.chat.id, result.messages, message.message_id);
            return { ok: true, mealBreakExclude: true };
        } catch (error) {
            await markTelegramProcessed(logId, {
                status: "error",
                errorMessage: error instanceof Error ? error.message : "meal_break_exclude_failed",
                parsedAction: "meal_break_exclude_command",
                resolutionData: { rawCommand: message.text },
            });
            await sendMessage(message.chat.id, buildMealBreakErrorReply(error), message.message_id);
            return { ok: true, ignored: true };
        }
    }

    const mealBreakPriorityCommand = parseTelegramMealBreakPriorityCommand(message.text);
    if (mealBreakPriorityCommand || isTelegramMealBreakPriorityCommandText(message.text)) {
        if (!mealBreakPriorityCommand) {
            await markTelegramProcessed(logId, {
                status: "ignored",
                errorMessage: "meal_break_priority_usage_invalid",
                parsedAction: "meal_break_priority_command",
                resolutionData: { rawCommand: message.text },
            });
            await sendMessage(message.chat.id, buildMealBreakPriorityCommandUsageReply(), message.message_id);
            return { ok: true, ignored: true };
        }

        try {
            const result = await runTelegramMealBreakPriorityCommand({
                referenceAt: new Date(message.date * 1000),
            });

            await markTelegramProcessed(logId, {
                status: "accepted",
                parsedAction: "meal_break_priority_command",
                resolutionData: {
                    commandName: mealBreakPriorityCommand.name,
                    mealBreakMode: result.view.mode,
                    operationalDate: result.view.operationalDate,
                    rosterSize: result.view.entries.length,
                    updatedAt: result.view.updatedAt,
                },
            });
            await sendTelegramReplyBatch(message.chat.id, result.messages, message.message_id);
            return { ok: true, mealBreakPriority: true };
        } catch (error) {
            await markTelegramProcessed(logId, {
                status: "error",
                errorMessage: error instanceof Error ? error.message : "meal_break_priority_failed",
                parsedAction: "meal_break_priority_command",
                resolutionData: { rawCommand: message.text },
            });
            const adminReply = buildMealBreakConsistencyAdminReply(error);
            if (adminReply) {
                const requester = [message.from?.first_name, message.from?.last_name].filter(Boolean).join(" ").trim() || "alguem do grupo";
                const origin = message.chat.type === "private" ? "privado" : `chat ${message.chat.title?.trim() || String(message.chat.id)}`;
                await sendPrivateAdminAlert(
                    [
                        `📛 /prioridade acusou inconsistência para ${requester} em ${origin}.`,
                        adminReply,
                    ].join("\n\n"),
                    message.chat.type === "private" ? [String(message.chat.id)] : [],
                );
            }
            await sendMessage(message.chat.id, buildMealBreakErrorReply(error), message.message_id);
            return { ok: true, ignored: true };
        }
    }

    const mealBreakCommand = parseTelegramMealBreakCommand(message.text);
    if (mealBreakCommand || isTelegramMealBreakCommandText(message.text)) {
        if (!mealBreakCommand) {
            await markTelegramProcessed(logId, {
                status: "ignored",
                errorMessage: "meal_break_command_usage_invalid",
                parsedAction: "meal_break_command",
                resolutionData: { rawCommand: message.text },
            });
            await sendMessage(message.chat.id, buildMealBreakCommandUsageReply(), message.message_id);
            return { ok: true, ignored: true };
        }

        if (message.chat.type === "private" && !await canManagePrivateMealBreak(message)) {
            await markTelegramProcessed(logId, {
                status: "ignored",
                errorMessage: "meal_break_private_forbidden",
                parsedAction: "meal_break_command",
                resolutionData: { rawCommand: message.text },
            });
            await sendMessage(message.chat.id, ":/ Almoco e jantar no privado ficam restritos a usuarios admin do bot. No grupo, a divisao continua aberta aos demais participantes.", message.message_id);
            return { ok: true, ignored: true };
        }

        try {
            const result = await runTelegramMealBreakCommand({
                chatId: String(message.chat.id),
                referenceAt: new Date(message.date * 1000),
                trigger: "manual",
                mode: mealBreakCommand.mode,
                forceRestart: mealBreakCommand.forceRestart,
                actorTelegramId: resolveTelegramMealBreakSenderId(update),
            });

            await markTelegramProcessed(logId, {
                status: "accepted",
                parsedAction: "meal_break_command",
                resolutionData: {
                    commandName: mealBreakCommand.name,
                    mealBreakMode: mealBreakCommand.mode,
                    forceRestart: mealBreakCommand.forceRestart,
                    resultStatus: result.status,
                    ...resolveMealBreakLogDetails(result.session),
                },
            });
            await sendTelegramReplyBatch(message.chat.id, result.messages, message.message_id, result.session);
            return { ok: true, mealBreak: true };
        } catch (error) {
            await markTelegramProcessed(logId, {
                status: "error",
                errorMessage: error instanceof Error ? error.message : "meal_break_command_failed",
                parsedAction: "meal_break_command",
                resolutionData: { rawCommand: message.text },
            });
            await sendMessage(message.chat.id, buildMealBreakErrorReply(error), message.message_id);
            return { ok: true, ignored: true };
        }
    }

    // ─── /desfazer — Admin Undo (private only) ─────────────────────────
    if (isTelegramUndoCommandText(message.text)) {
        const actor = await resolveTelegramCommandActor(message);
        if (!actor || !actor.roles.includes("admin")) {
            await markTelegramProcessed(logId, {
                status: "ignored",
                errorMessage: "undo_command_forbidden",
                parsedAction: "undo",
                resolutionData: { rawCommand: message.text },
            });
            await sendMessage(message.chat.id, ":/ O comando /desfazer fica restrito a admin.", message.message_id);
            return { ok: true, ignored: true };
        }

        if (message.chat.type !== "private") {
            await markTelegramProcessed(logId, {
                status: "ignored",
                errorMessage: "undo_command_private_only",
                parsedAction: "undo",
                resolutionData: { rawCommand: message.text },
            });
            await sendMessage(message.chat.id, ":/ O /desfazer funciona só no privado do bot.", message.message_id);
            return { ok: true, ignored: true };
        }

        const undoCommand = parseTelegramUndoCommand(message.text);
        if (!undoCommand) {
            await markTelegramProcessed(logId, {
                status: "ignored",
                errorMessage: "undo_command_usage_invalid",
                parsedAction: "undo",
                resolutionData: { rawCommand: message.text },
            });
            await sendMessage(message.chat.id, "Uso: /desfazer (listar) ou /desfazer N (confirmar undo do item N)", message.message_id);
            return { ok: true, ignored: true };
        }

        return handleTelegramUndoCommand({
            message,
            logId,
            actor,
            undoCommand,
        });
    }

    const doctorDirectoryCommand = parseTelegramDoctorAdminCommand(message.text);
    if (doctorDirectoryCommand || isTelegramDoctorAdminCommandText(message.text)) {
        const actor = await resolveTelegramCommandActor(message);
        if (!actor || !actor.roles.includes("admin")) {
            await markTelegramProcessed(logId, {
                status: "ignored",
                errorMessage: "doctor_command_forbidden",
                parsedAction: "doctor_create",
                resolutionData: { commandBody: doctorDirectoryCommand?.rawBody ?? message.text },
            });
            await sendMessage(message.chat.id, ":/ Esse comando de diretorio fica restrito a admin.", message.message_id);
            return { ok: true, ignored: true };
        }

        if (message.chat.type !== "private") {
            await markTelegramProcessed(logId, {
                status: "ignored",
                errorMessage: "doctor_command_private_only",
                parsedAction: "doctor_create",
                resolutionData: { commandBody: doctorDirectoryCommand?.rawBody ?? message.text },
            });
            await sendMessage(message.chat.id, ":/ Cadastro de medico pelo Telegram fica so no privado do bot, para evitar ruido no grupo.", message.message_id);
            return { ok: true, ignored: true };
        }

        if (!doctorDirectoryCommand) {
            await markTelegramProcessed(logId, {
                status: "ignored",
                errorMessage: "doctor_command_usage_invalid",
                parsedAction: "doctor_create",
                resolutionData: { rawCommand: message.text },
            });
            await sendMessage(message.chat.id, buildDoctorDirectoryUsageReply(), message.message_id);
            return { ok: true, ignored: true };
        }

        try {
            const auditContext = {
                actorUserId: actor.userId,
                source: "telegram_command",
                details: {
                    telegramActorId: actor.senderTelegramId,
                    telegramActorName: actor.senderName,
                    telegramCommand: message.text,
                },
            };

            if (doctorDirectoryCommand.name === "doctor_update") {
                const result = await updateDoctorDirectoryEntry({
                    lookup: doctorDirectoryCommand.lookup,
                    fullName: doctorDirectoryCommand.fullName,
                    displayName: doctorDirectoryCommand.displayName,
                    externalCode: doctorDirectoryCommand.externalCode,
                    aliases: doctorDirectoryCommand.aliases,
                    hasDisplayName: doctorDirectoryCommand.hasDisplayName,
                    hasExternalCode: doctorDirectoryCommand.hasExternalCode,
                    hasAliases: doctorDirectoryCommand.hasAliases,
                }, auditContext);

                await markTelegramProcessed(logId, {
                    status: result.status === "updated" || result.status === "reactivated_and_updated" ? "accepted" : "ignored",
                    parsedAction: doctorDirectoryCommand.name,
                    parsedDoctorName: result.status === "updated" || result.status === "reactivated_and_updated"
                        ? result.doctor.fullName
                        : doctorDirectoryCommand.lookup,
                    resolutionData: {
                        actorRoles: actor.roles,
                        resultStatus: result.status,
                        lookup: doctorDirectoryCommand.lookup,
                        matches: result.status === "ambiguous" ? result.matches : undefined,
                    },
                });

                if (result.status === "not_found") {
                    await sendMessage(
                        message.chat.id,
                        `:/ Nao achei medico com "${doctorDirectoryCommand.lookup}" para atualizar.`,
                        message.message_id,
                    );
                    return { ok: true, ignored: true };
                }

                if (result.status === "ambiguous") {
                    await sendMessage(
                        message.chat.id,
                        [
                            `:/ Achei mais de um medico para "${doctorDirectoryCommand.lookup}".`,
                            ...result.matches.map((doctor, index) => `${index + 1}. ${resolveTelegramDoctorSurfaceName(doctor)}${buildDoctorDirectorySummary(doctor)}`),
                            "",
                            "Use um identificador mais especifico, como nome completo atual, codigo ou alias unico.",
                        ].join("\n"),
                        message.message_id,
                    );
                    return { ok: true, ignored: true };
                }

                await sendMessage(
                    message.chat.id,
                    result.status === "updated"
                        ? `:) Diretorio atualizado. Corrigi ${resolveTelegramDoctorSurfaceName(result.doctor)}${buildDoctorDirectorySummary(result.doctor)}.`
                        : `:) Diretorio atualizado. Reativei e corrigi ${resolveTelegramDoctorSurfaceName(result.doctor)}${buildDoctorDirectorySummary(result.doctor)}.`,
                    message.message_id,
                );
                return { ok: true, doctorId: result.doctor.id };
            }

            const result = await createDoctorDirectoryEntry({
                fullName: doctorDirectoryCommand.fullName,
                displayName: doctorDirectoryCommand.displayName,
                externalCode: doctorDirectoryCommand.externalCode,
                aliases: doctorDirectoryCommand.aliases,
            }, auditContext);

            await markTelegramProcessed(logId, {
                status: "accepted",
                parsedAction: doctorDirectoryCommand.name,
                parsedDoctorName: result.doctor.fullName,
                resolutionData: {
                    actorRoles: actor.roles,
                    resultStatus: result.status,
                    externalCode: result.doctor.externalCode,
                    displayName: result.doctor.displayName,
                    aliases: extractDoctorAliases(result.doctor.metadata),
                },
            });

            if (result.status === "already_exists") {
                await sendMessage(
                    message.chat.id,
                    `:| Ja existe um medico ativo com esse nome: ${result.doctor.fullName}${buildDoctorDirectorySummary(result.doctor)}.`,
                    message.message_id,
                );
                return { ok: true, ignored: true };
            }

            await sendMessage(
                message.chat.id,
                result.status === "created"
                    ? `:) Diretorio atualizado. Criei ${result.doctor.fullName}${buildDoctorDirectorySummary(result.doctor)}.`
                    : `:) Diretorio atualizado. Reativei ${result.doctor.fullName}${buildDoctorDirectorySummary(result.doctor)}.`,
                message.message_id,
            );
            return { ok: true, doctorId: result.doctor.id };
        } catch (error) {
            await markTelegramProcessed(logId, {
                status: "error",
                errorMessage: error instanceof Error ? error.message : "doctor_command_failed",
                parsedAction: doctorDirectoryCommand.name,
                resolutionData: { rawCommand: message.text },
            });
            await sendMessage(
                message.chat.id,
                `:/ Nao consegui atualizar esse medico. ${error instanceof Error ? error.message : "Falha inesperada."}`,
                message.message_id,
            );
            return { ok: true, ignored: true };
        }
    }

    const paymentCommand = parseTelegramPaymentAdminCommand(message.text);
    if (paymentCommand || isTelegramPaymentAdminCommandText(message.text)) {
        const actor = await resolveTelegramCommandActor(message);
        if (!actor || !actor.roles.some((role) => role === "admin" || role === "chief")) {
            await markTelegramProcessed(logId, {
                status: "ignored",
                errorMessage: "payment_command_forbidden",
                parsedAction: paymentCommand?.name ?? "payment_command",
                resolutionData: { rawCommand: message.text },
            });
            await sendMessage(message.chat.id, pickTelegramReply("command_forbidden", message.message_id, {}), message.message_id);
            return { ok: true, ignored: true };
        }

        if (message.chat.type !== "private") {
            await markTelegramProcessed(logId, {
                status: "ignored",
                errorMessage: "payment_command_private_only",
                parsedAction: paymentCommand?.name ?? "payment_command",
                resolutionData: { rawCommand: message.text },
            });
            await sendMessage(message.chat.id, ":/ Conferencia e correcao de pagamento ficam no privado do bot, para nao poluir o grupo operacional.", message.message_id);
            return { ok: true, ignored: true };
        }

        if (!paymentCommand) {
            await markTelegramProcessed(logId, {
                status: "ignored",
                errorMessage: "payment_command_usage_invalid",
                parsedAction: "payment_command",
                resolutionData: { rawCommand: message.text },
            });
            await sendMessage(message.chat.id, buildPaymentCommandUsageReply(), message.message_id);
            return { ok: true, ignored: true };
        }

        if (paymentCommand.name === "payment_report") {
            try {
                const board = await getPaymentAllocationBoard({
                    operationalDate: paymentCommand.operationalDate,
                    shiftLabel: paymentCommand.shiftLabel,
                });

                await markTelegramProcessed(logId, {
                    status: "accepted",
                    parsedAction: paymentCommand.name,
                    resolutionData: {
                        actorRoles: actor.roles,
                        operationalDate: board.operationalDate,
                        shiftLabel: board.shiftLabel,
                        readyForPaymentCount: board.summary.readyForPaymentCount,
                        needsReviewCount: board.summary.needsReviewCount,
                        unassignedCount: board.summary.unassignedCount,
                    },
                });
                await sendMessage(message.chat.id, buildPaymentAllocationReportReply(board), message.message_id);
                return { ok: true, reported: true };
            } catch (error) {
                await markTelegramProcessed(logId, {
                    status: "error",
                    errorMessage: error instanceof Error ? error.message : "payment_report_failed",
                    parsedAction: paymentCommand.name,
                    resolutionData: { rawCommand: message.text },
                });
                await sendMessage(message.chat.id, `:/ Nao consegui montar a conferencia de pagamento. ${error instanceof Error ? error.message : "Falha inesperada."}`, message.message_id);
                return { ok: true, ignored: true };
            }
        }

        try {
            const board = await getPaymentAllocationBoard({
                operationalDate: paymentCommand.operationalDate,
                shiftLabel: paymentCommand.shiftLabel,
            });
            const targetRow = findPaymentAllocationRow(board, paymentCommand.targetCode);
            if (!targetRow) {
                await markTelegramProcessed(logId, {
                    status: "ignored",
                    errorMessage: "payment_target_not_found",
                    parsedAction: paymentCommand.name,
                    parsedTargetCode: paymentCommand.targetCode,
                });
                await sendMessage(message.chat.id, `:/ Nao encontrei ${paymentCommand.targetCode} na conferencia de ${formatPaymentAllocationDateLabel(board.operationalDate)} ${board.shiftLabel}.`, message.message_id);
                return { ok: true, ignored: true };
            }

            if (!targetRow.occupancyId) {
                await markTelegramProcessed(logId, {
                    status: "ignored",
                    errorMessage: "payment_target_without_occupancy",
                    parsedAction: paymentCommand.name,
                    parsedTargetCode: paymentCommand.targetCode,
                });
                await sendMessage(message.chat.id, `:/ ${targetRow.targetCode} ainda esta sem ocupacao identificada nesse turno. Primeiro ajuste o lancamento operacional e depois refaça a conferencia.`, message.message_id);
                return { ok: true, ignored: true };
            }

            const { doctor, candidates } = await resolveDoctorWithFallback(paymentCommand.doctorName);
            if (!doctor) {
                await markTelegramProcessed(logId, {
                    status: "ignored",
                    errorMessage: "payment_doctor_not_resolved",
                    parsedAction: paymentCommand.name,
                    parsedTargetCode: paymentCommand.targetCode,
                    resolutionData: {
                        doctorQuery: paymentCommand.doctorName,
                        candidates: candidates.slice(0, 3),
                    },
                });
                await sendMessage(message.chat.id, buildNameUnresolvedReply(message.message_id, candidates), message.message_id);
                return { ok: true, ignored: true };
            }

            if (doctor.id === targetRow.doctorId) {
                await markTelegramProcessed(logId, {
                    status: "accepted",
                    parsedAction: paymentCommand.name,
                    parsedTargetCode: targetRow.targetCode,
                    parsedDoctorName: doctor.fullName,
                    relatedOccupancyId: targetRow.occupancyId,
                    resolutionData: {
                        actorRoles: actor.roles,
                        noOp: true,
                        operationalDate: board.operationalDate,
                        shiftLabel: board.shiftLabel,
                    },
                });
                await sendMessage(message.chat.id, `:) ${resolveTelegramDoctorSurfaceName(doctor)} ja estava alocado em ${targetRow.targetCode} para ${formatPaymentAllocationDateLabel(board.operationalDate)} ${board.shiftLabel}.`, message.message_id);
                return { ok: true, occupancyId: targetRow.occupancyId };
            }

            const db = getDb();
            const existingOccupancy = targetRow.domain === "regulation"
                ? await db.query.regulationOccupancies.findFirst({ where: eq(regulationOccupancies.id, targetRow.occupancyId) })
                : await db.query.interventionOccupancies.findFirst({ where: eq(interventionOccupancies.id, targetRow.occupancyId) });
            const nextNotes = `${existingOccupancy?.notes ?? ""}\n[telegram /pagamento corrigir] ${message.text}${paymentCommand.note ? `\n[motivo] ${paymentCommand.note}` : ""}`.trim();

            const updated = targetRow.domain === "regulation"
                ? await correctRegulationOccupancy(targetRow.occupancyId, {
                    doctorId: doctor.id,
                    notes: nextNotes,
                }, resolveCommandAuditUserId(actor.userId))
                : await correctInterventionOccupancy(targetRow.occupancyId, {
                    doctorId: doctor.id,
                    notes: nextNotes,
                }, resolveCommandAuditUserId(actor.userId));

            const refreshedBoard = await getPaymentAllocationBoard({
                operationalDate: board.operationalDate.slice(0, 10),
                shiftLabel: board.shiftLabel,
            });
            const refreshedRow = findPaymentAllocationRow(refreshedBoard, targetRow.targetCode);

            await markTelegramProcessed(logId, {
                status: "accepted",
                parsedAction: paymentCommand.name,
                parsedTargetCode: targetRow.targetCode,
                parsedDoctorName: doctor.fullName,
                relatedOccupancyId: updated.id,
                resolutionData: {
                    actorRoles: actor.roles,
                    operationalDate: board.operationalDate,
                    shiftLabel: board.shiftLabel,
                    note: paymentCommand.note,
                    finalStatus: refreshedRow?.paymentStatus ?? null,
                    finalIssues: refreshedRow?.issues ?? [],
                },
            });
            await sendMessage(
                message.chat.id,
                `:) Corrigi ${targetRow.targetCode} para ${resolveTelegramDoctorSurfaceName(doctor)} em ${formatPaymentAllocationDateLabel(board.operationalDate)} ${board.shiftLabel}. Agora ${describePaymentAllocationOutcome(refreshedRow)}.`,
                message.message_id,
            );
            return { ok: true, occupancyId: updated.id };
        } catch (error) {
            await markTelegramProcessed(logId, {
                status: "error",
                errorMessage: error instanceof Error ? error.message : "payment_correction_failed",
                parsedAction: paymentCommand.name,
                resolutionData: { rawCommand: message.text },
            });
            await sendMessage(message.chat.id, `:/ Nao consegui corrigir essa alocacao de pagamento. ${error instanceof Error ? error.message : "Falha inesperada."}`, message.message_id);
            return { ok: true, ignored: true };
        }
    }

    const bankHoursCommand = parseTelegramBankHoursCommand(message.text);
    if (bankHoursCommand || isTelegramBankHoursCommandText(message.text)) {
        const actor = await resolveTelegramCommandActor(message);
        if (!actor || !actor.roles.includes("admin")) {
            await markTelegramProcessed(logId, {
                status: "ignored",
                errorMessage: "bank_hours_command_forbidden",
                parsedAction: bankHoursCommand?.name ?? "bank_hours_override",
                resolutionData: { rawCommand: message.text },
            });
            await sendMessage(message.chat.id, ":/ O comando /banco fica restrito a admin porque altera o saldo auditado do plantao.", message.message_id);
            return { ok: true, ignored: true };
        }

        if (message.chat.type !== "private") {
            await markTelegramProcessed(logId, {
                status: "ignored",
                errorMessage: "bank_hours_command_private_only",
                parsedAction: bankHoursCommand?.name ?? "bank_hours_override",
                resolutionData: { rawCommand: message.text },
            });
            await sendMessage(message.chat.id, ":/ O ajuste de banco fica no privado do bot, para nao poluir o grupo operacional.", message.message_id);
            return { ok: true, ignored: true };
        }

        if (!bankHoursCommand) {
            await markTelegramProcessed(logId, {
                status: "ignored",
                errorMessage: "bank_hours_command_usage_invalid",
                parsedAction: "bank_hours_override",
                resolutionData: { rawCommand: message.text },
            });
            await sendMessage(message.chat.id, buildBankHoursCommandUsageReply(), message.message_id);
            return { ok: true, ignored: true };
        }

        const resolvedDoctor = await resolveDoctorWithFallback(bankHoursCommand.doctorName);
        if (!resolvedDoctor.doctor) {
            await markTelegramProcessed(logId, {
                status: "ignored",
                errorMessage: "bank_hours_doctor_not_resolved",
                parsedAction: bankHoursCommand.name,
                parsedDoctorName: bankHoursCommand.doctorName,
                resolutionData: { candidates: resolvedDoctor.candidates.slice(0, 3) },
            });
            await sendMessage(message.chat.id, buildNameUnresolvedReply(message.message_id, resolvedDoctor.candidates), message.message_id);
            return { ok: true, ignored: true };
        }

        try {
            const referenceAt = new Date(message.date * 1000);
            const shiftRequest = resolveLatestClosedShiftRequest(referenceAt, bankHoursCommand.shiftLabel);
            const board = await getPaymentAllocationBoard({
                operationalDate: shiftRequest.operationalDate,
                shiftLabel: shiftRequest.shiftLabel,
                reference: referenceAt,
            });
            const matches = [...board.regulation, ...board.intervention].filter((row) => row.doctorId === resolvedDoctor.doctor?.id && Boolean(row.occupancyId));

            if (matches.length === 0) {
                throw new Error(`Nao encontrei plantao fechado de ${resolvedDoctor.doctor.fullName} no ${bankHoursCommand.shiftLabel} de ${shiftRequest.operationalDate}.`);
            }

            if (matches.length > 1) {
                throw new Error(`Achei mais de um alvo para ${resolvedDoctor.doctor.fullName}: ${matches.map((row) => row.targetCode).join(", ")}. Use a tela admin do banco para escolher o plantao exato.`);
            }

            const match = matches[0]!;
            const result = await applyBankHoursBalanceOverride({
                domain: match.domain,
                occupancyId: match.occupancyId!,
                balanceMinutes: bankHoursCommand.balanceMinutes,
                notes: `[telegram /banco] ${message.text}`,
                actorUserId: actor.userId,
            });

            await markTelegramProcessed(logId, {
                status: "accepted",
                parsedAction: bankHoursCommand.name,
                parsedDoctorName: resolvedDoctor.doctor.fullName,
                parsedTargetCode: match.targetCode,
                relatedOccupancyId: match.occupancyId,
                resolutionData: {
                    actorRoles: actor.roles,
                    operationalDate: shiftRequest.operationalDate,
                    shiftLabel: shiftRequest.shiftLabel,
                    balanceMinutes: bankHoursCommand.balanceMinutes,
                    continuityGroupId: result.continuityGroupId,
                },
            });
            await sendMessage(
                message.chat.id,
                `Banco ajustado em ${match.targetCode}: ${resolvedDoctor.doctor.fullName} no ${shiftRequest.shiftLabel} de ${shiftRequest.operationalDate} agora fecha com ${formatTelegramBankMinutes(bankHoursCommand.balanceMinutes)}.`,
                message.message_id,
            );
            return { ok: true, adjusted: true };
        } catch (error) {
            await markTelegramProcessed(logId, {
                status: "error",
                errorMessage: error instanceof Error ? error.message : "bank_hours_override_failed",
                parsedAction: bankHoursCommand.name,
                parsedDoctorName: resolvedDoctor.doctor.fullName,
                resolutionData: { rawCommand: message.text },
            });
            await sendMessage(message.chat.id, `:/ Nao consegui ajustar o banco. ${error instanceof Error ? error.message : "Falha inesperada."}`, message.message_id);
            return { ok: true, ignored: true };
        }
    }

    const departureReportCommand = parseTelegramDepartureReportCommand(message.text, new Date(message.date * 1000));
    if (departureReportCommand || isTelegramDepartureReportCommandText(message.text)) {
        if (!departureReportCommand) {
            await markTelegramProcessed(logId, {
                status: "ignored",
                errorMessage: "departure_report_command_usage_invalid",
                parsedAction: "departure_report",
                resolutionData: { rawCommand: message.text },
            });
            await sendMessage(message.chat.id, buildDepartureReportCommandUsageReply(), message.message_id);
            return { ok: true, ignored: true };
        }

        try {
            const referenceAt = new Date(message.date * 1000);
            const request = resolveTelegramDepartureReportRequest({
                operationalDate: departureReportCommand.operationalDate,
                shiftLabel: departureReportCommand.shiftLabel,
                reference: referenceAt,
            });
            const board = await getPaymentAllocationBoard({
                operationalDate: request.operationalDate,
                shiftLabel: request.shiftLabel,
                reference: referenceAt,
            });
            const report = buildTelegramDepartureReport(board);

            await markTelegramProcessed(logId, {
                status: "accepted",
                parsedAction: departureReportCommand.name,
                resolutionData: {
                    operationalDate: board.operationalDate,
                    shiftLabel: board.shiftLabel,
                    assignedCount: board.summary.assignedCount,
                    needsReviewCount: board.summary.needsReviewCount,
                },
            });
            await sendMessage(message.chat.id, report, message.message_id);
            return { ok: true, reported: true };
        } catch (error) {
            await markTelegramProcessed(logId, {
                status: "error",
                errorMessage: error instanceof Error ? error.message : "departure_report_failed",
                parsedAction: "departure_report",
                resolutionData: { rawCommand: message.text },
            });
            await sendMessage(message.chat.id, `:/ Não consegui montar o relatório de saídas. ${error instanceof Error ? error.message : "Falha inesperada."}`, message.message_id);
            return { ok: true, ignored: true };
        }
    }

    const departurePriorityCommand = parseTelegramDeparturePriorityCommand(message.text);
    if (departurePriorityCommand || isTelegramDeparturePriorityCommandText(message.text)) {
        if (!departurePriorityCommand) {
            await markTelegramProcessed(logId, {
                status: "ignored",
                errorMessage: "departure_priority_command_usage_invalid",
                parsedAction: "departure_priority",
                resolutionData: { rawCommand: message.text },
            });
            await sendMessage(message.chat.id, buildDeparturePriorityCommandUsageReply(), message.message_id);
            return { ok: true, ignored: true };
        }

        try {
            const result = await runTelegramDeparturePriorityCommand({
                referenceAt: new Date(message.date * 1000),
            });

            await markTelegramProcessed(logId, {
                status: "accepted",
                parsedAction: departurePriorityCommand.name,
                resolutionData: {
                    shiftLabel: result.view.shiftLabel,
                    rosterSize: result.view.entries.length,
                    generatedAt: result.view.generatedAt,
                },
            });
            await sendMessage(message.chat.id, result.message, message.message_id);
            return { ok: true, reported: true };
        } catch (error) {
            await markTelegramProcessed(logId, {
                status: "error",
                errorMessage: error instanceof Error ? error.message : "departure_priority_failed",
                parsedAction: "departure_priority",
                resolutionData: { rawCommand: message.text },
            });
            await sendMessage(message.chat.id, `:/ Nao consegui montar a prioridade de saida. ${error instanceof Error ? error.message : "Falha inesperada."}`, message.message_id);
            return { ok: true, ignored: true };
        }
    }

    const shiftReportCommand = parseTelegramShiftReportCommand(message.text);
    if (shiftReportCommand || isTelegramShiftReportCommandText(message.text)) {
        if (!shiftReportCommand) {
            await markTelegramProcessed(logId, {
                status: "ignored",
                errorMessage: "shift_report_command_usage_invalid",
                parsedAction: "shift_report",
                resolutionData: { rawCommand: message.text },
            });
            await sendMessage(message.chat.id, buildShiftReportCommandUsageReply(), message.message_id);
            return { ok: true, ignored: true };
        }

        try {
            const referenceAt = new Date(message.date * 1000);
            const board = await getOperationalBoard();
            const report = buildTelegramShiftReport({
                board,
                reference: referenceAt,
            });

            await markTelegramProcessed(logId, {
                status: "accepted",
                parsedAction: shiftReportCommand.name,
                resolutionData: {
                    requestedAt: referenceAt.toISOString(),
                    interventionCount: board.intervention.length,
                    regulationCount: board.regulation.length,
                },
            });
            await sendMessage(message.chat.id, report, message.message_id);
            return { ok: true, reported: true };
        } catch (error) {
            await markTelegramProcessed(logId, {
                status: "error",
                errorMessage: error instanceof Error ? error.message : "shift_report_failed",
                parsedAction: "shift_report",
                resolutionData: { rawCommand: message.text },
            });
            await sendMessage(message.chat.id, `:/ Não consegui montar o relato do plantão. ${error instanceof Error ? error.message : "Falha inesperada."}`, message.message_id);
            return { ok: true, ignored: true };
        }
    }

    const summaryReportCommand = parseTelegramSummaryReportCommand(message.text);
    if (summaryReportCommand || isTelegramSummaryReportCommandText(message.text)) {
        if (!summaryReportCommand) {
            await markTelegramProcessed(logId, {
                status: "ignored",
                errorMessage: "summary_report_command_usage_invalid",
                parsedAction: "summary_report",
                resolutionData: { rawCommand: message.text },
            });
            await sendMessage(message.chat.id, buildSummaryReportCommandUsageReply(), message.message_id);
            return { ok: true, ignored: true };
        }

        try {
            const referenceAt = new Date(message.date * 1000);
            const departureRequest = resolveTelegramDepartureReportRequest({
                operationalDate: null,
                shiftLabel: null,
                reference: referenceAt,
            });
            const [departureBoard, currentBoard, mealBreakSession] = await Promise.all([
                getPaymentAllocationBoard({
                    operationalDate: departureRequest.operationalDate,
                    shiftLabel: departureRequest.shiftLabel,
                    reference: referenceAt,
                }),
                getOperationalBoard(),
                getCurrentOperationalMealBreakSession(referenceAt),
            ]);
            const report = buildTelegramSummaryReport({
                data: {
                    departureBoard,
                    currentBoard,
                    mealBreakSession,
                },
                reference: referenceAt,
            });

            await markTelegramProcessed(logId, {
                status: "accepted",
                parsedAction: summaryReportCommand.name,
                resolutionData: {
                    requestedAt: referenceAt.toISOString(),
                    departureOperationalDate: departureBoard.operationalDate,
                    departureShiftLabel: departureBoard.shiftLabel,
                    currentInterventionCount: currentBoard.intervention.length,
                    currentRegulationCount: currentBoard.regulation.length,
                    mealBreakMode: mealBreakSession?.mode ?? null,
                },
            });
            await sendMessage(message.chat.id, report, message.message_id);
            return { ok: true, reported: true };
        } catch (error) {
            await markTelegramProcessed(logId, {
                status: "error",
                errorMessage: error instanceof Error ? error.message : "summary_report_failed",
                parsedAction: "summary_report",
                resolutionData: { rawCommand: message.text },
            });
            await sendMessage(message.chat.id, `:/ Nao consegui montar o resumo. ${error instanceof Error ? error.message : "Falha inesperada."}`, message.message_id);
            return { ok: true, ignored: true };
        }
    }

    const normalizedText = message.text.trim().toLowerCase();
    if (normalizedText === "/ajuda" || normalizedText === "/help") {
        const helpText = [
            "📋 *Guia rápido do bot*",
            "",
            "▸ *CHEGADA* — avise no grupo:",
            `  _${buildTelegramArrivalExample({})}_`,
            `  _Vagner USB-01 07:00 P_  (se for plantão P)`,
            "",
            "▸ *SAÍDA* — avise no grupo:",
            `  _${buildTelegramDepartureExample({})}_`,
            "",
            "▸ *CONTINUAÇÃO* — se emenda o próximo turno:",
            "  _Vagner continuo USB-01_",
            "",
            "▸ *TROCA de ramal/base* — mande nova chegada:",
            "  _Vagner USB-03 08:30_",
            "",
            "━━━━━━━━━━━━━━━━━━",
            "📌 Para ver *todos* os comandos com exemplos:",
            "  /comandos",
            "",
            "💡 Em caso de dúvida, mande /ajuda novamente.",
        ].join("\n");

        await markTelegramProcessed(logId, {
            status: "accepted",
            parsedAction: "help_command",
        });
        await sendMessage(message.chat.id, helpText, message.message_id);
        return { ok: true, help: true };
    }

    if (normalizedText === "/comandos") {
        const isPrivate = message.chat.type === "private";
        const actor = await resolveTelegramCommandActor(message);
        const isAdmin = actor?.roles.includes("admin") ?? false;
        const isChief = actor?.roles.some((r) => r === "admin" || r === "chief") ?? false;

        const sections: string[] = [];

        sections.push(
            "📖 *TUTORIAL COMPLETO DE COMANDOS*",
            "",
            "━━━━━━━━━━━━━━━━━━",
            "📥 *CHEGADA / SAÍDA (mensagem livre no grupo)*",
            "",
            "▸ Chegada:",
            `  _${buildTelegramArrivalExample({})}_`,
            "  _Vagner USB-01 07:00 P_ (plantão P)",
            "",
            "▸ Saída:",
            `  _${buildTelegramDepartureExample({})}_`,
            "",
            "▸ Continuação (emenda turno):",
            "  _Vagner continuo USB-01_",
            "",
            "▸ Troca de base/ramal:",
            "  _Vagner USB-03 08:30_ (nova msg de chegada)",
        );

        sections.push(
            "",
            "━━━━━━━━━━━━━━━━━━",
            "🔧 *CORREÇÕES (comandos /)*",
            "",
            "▸ /corrigir — corrige hora de chegada:",
            "  _/corrigir PM04 20:00_",
            "  _/corrigir PM04 Karen 20:00_ (troca médico + hora)",
            "",
            "▸ /corrigirsaida — corrige saída anterior:",
            "  _/corrigirsaida Nome Sobrenome_",
            "  _/corrigirsaida Nome Sobrenome 2035_ (se tiver base)",
            "",
            "▸ /ontem — fixa horário em ontem:",
            "  _/ontem PM04 20:00_",
            "",
            "▸ /hoje — fixa horário em hoje:",
            "  _/hoje PM04 07:00_",
            "",
            "▸ /retirar — registra saída/encerramento:",
            "  _/retirar PM04 19:00_",
            "  (sinônimos: /saiu, /saindo, /saida)",
            "",
            "▸ /ramal — altera função do ramal:",
            "  _/ramal Emily 1363 RMT_",
            "  _/ramal Emily 1363 PSIQ_",
        );

        sections.push(
            "",
            "━━━━━━━━━━━━━━━━━━",
            "🍽️ *ALMOÇO / JANTAR*",
            "",
            "▸ /almoco — inicia divisão de almoço (SD)",
            "  _/almoco reiniciar_ (recomeça do zero)",
            "",
            "▸ /jantar — inicia divisão de jantar (SN)",
            "  _/jantar reiniciar_",
            "",
            "▸ /prioridade — mostra ordem de escolha",
            "",
            "▸ /excluir — retira médico da divisão:",
            "  _/excluir 2041_",
            "",
            "▸ /incluir — recoloca médico na divisão:",
            "  _/incluir 2041_",
        );

        sections.push(
            "",
            "━━━━━━━━━━━━━━━━━━",
            "📊 *RELATÓRIOS*",
            "",
            "▸ /plantao — relatório do turno atual",
            "",
            "▸ /resumo — resumo operacional (contagem + refeição)",
            "",
            "▸ /saidas — relatório de saídas:",
            "  _/saidas_ (turno atual)",
            "  _/saidas ontem SD_",
            "  _/saidas 2026-04-07 SN_",
            "",
            "▸ /prioridadesaida — quem pode sair primeiro",
            "",
            "▸ /status ou /meuturno — meu lançamento atual",
        );

        sections.push(
            "",
            "━━━━━━━━━━━━━━━━━━",
            "📢 *UTILIDADES*",
            "",
            "▸ /cobrar — lembrete para equipe informar chegada no formato certo",
            "▸ /lembretes — cobra chefia com USA sem informacao + total de reguladores",
            "▸ /ajuda — guia rápido",
        );

        sections.push(
            "",
            "━━━━━━━━━━━━━━━━━━",
            "🔐 *CHEFIA (grupo)*",
            "",
            "▸ /remover — apaga plantão (⚠️ só admin):",
            "  _/remover PM04_",
            "  _/remover Nome PM04 SD_",
            "",
            "▸ /ativar — reativa base/ramal:",
            "  _/ativar PM40_",
            "  _/ativar PM40 19:10_",
            "  _/ativar 2031_ (regulação)",
            "",
            "▸ /desativar — desativa base/ramal:",
            "  _/desativar PM40_",
            "  _/desativar 2031 19:00_",
            "",
            `ℹ️ Acesso atual: ${isChief ? "chefia" : "usuário comum"}.`,
        );

        sections.push(
            "",
            "━━━━━━━━━━━━━━━━━━",
            "🔑 *CHEFIA (privado do bot)*",
            "",
            "▸ /pagamento conferir — confere alocação de pagamento:",
            "  _/pagamento conferir_ (turno atual)",
            "  _/pagamento conferir 2026-04-07 SD_",
            "",
            "▸ /pagamento corrigir — corrige pagamento:",
            "  _/pagamento corrigir PM04 | Karen | 2026-04-07 | SD | motivo_",
            "",
            `ℹ️ Requer chat privado + chefia (agora: ${isPrivate ? "privado" : "grupo"}).`,
        );

        sections.push(
            "",
            "━━━━━━━━━━━━━━━━━━",
            "👑 *ADMIN (privado do bot)*",
            "",
            "▸ /desfazer — lista e desfaz ações (12h):",
            "  _/desfazer_ (listar)",
            "  _/desfazer 1_ (confirma undo #1)",
            "",
            "▸ /slots — auditoria de ocupação:",
            "  _/slots_ (turno atual)",
            "  _/slots 2026-04-07 SD_",
            "  _/slots 2026-04-01 2026-04-07 SN_",
            "",
            "▸ /medico — cadastro/edição de médico:",
            "  _/medico cadastrar Nome | Exibição | código | alias1, alias2_",
            "  _/medico atualizar Busca | Novo Nome_",
            "",
            "▸ /banco — ajusta banco de horas:",
            "  _/banco Nome Completo SD 0_",
            "",
            `ℹ️ Requer chat privado + admin (agora: ${isAdmin ? "admin" : "não admin"}; ${isPrivate ? "privado" : "grupo"}).`,
        );

        sections.push(
            "",
            "━━━━━━━━━━━━━━━━━━",
            "💡 Dica: mande /comandos a qualquer momento para rever este tutorial.",
        );

        await markTelegramProcessed(logId, {
            status: "accepted",
            parsedAction: "comandos_tutorial",
            resolutionData: { isAdmin, isChief, isPrivate },
        });
        await sendMessage(message.chat.id, sections.join("\n"), message.message_id);
        return { ok: true, help: true };
    }

    if (normalizedText === "/cobrar") {
        const cobrarText = [
            "📢 *Atenção equipe!*",
            "",
            "Para eu preencher certo no sistema, por favor *sempre* avisem:",
            "  ▸ Nome completo",
            "  ▸ Base ou ramal",
            "  ▸ SD, SN ou P",
            "  ▸ Horário",
            "",
            "━━━━━━━━━━━━━━━━━━",
            "📌 *Exemplos:*",
            "",
            "▸ Intervenção:",
            "  _Felipe Carvalho PM04 SN 19:00_",
            "",
            "▸ Regulação:",
            "  _Luana Bordoni 2031 SN 19:00_",
            "",
            "▸ Se continua no posto:",
            "  _Karla Pinto BR05 continua P 19:00_",
            "",
            "━━━━━━━━━━━━━━━━━━",
            "⚠️ Se a pessoa *segue* no posto, escrevam *continua*.",
            "Se *assumiu agora*, escrevam *SD*, *SN* ou *P* na mesma linha.",
            "",
            "Sem aviso de continua/P ou ajuste da chefia,",
            "a posição fica como *sem médico confirmado* no grupo.",
        ].join("\n");

        await markTelegramProcessed(logId, {
            status: "accepted",
            parsedAction: "cobrar_command",
        });
        await sendMessage(message.chat.id, cobrarText);
        return { ok: true, cobrar: true };
    }

    if (isLembretesCommandText(message.text)) {
        const board = await getOperationalBoard();
        const shiftLabel = resolveOperationalShiftWindow(new Date()).shiftLabel;
        const regulationRows = board.regulation.map((row) => ({
            postCode: row.postCode,
            status: row.status,
            doctorName: row.doctorName,
            displayName: row.displayName,
        }));
        const interventionRows = board.intervention.map((row) => ({
            baseCode: row.baseCode,
            status: row.status,
            doctorName: row.doctorName,
            displayName: row.displayName,
        }));

        const lembretesText = buildLembretesCommandText({
            shiftLabel,
            regulationRows,
            interventionRows,
        });

        const regulationHeadcount = regulationRows.filter((row) => {
            const code = row.postCode.trim().toUpperCase();
            return row.status === "active" && code !== "2031" && code !== "NUCLEO" && code !== "PIAM";
        }).length;
        const interventionWaitingCount = interventionRows.filter((row) => row.status === "waiting").length;

        await markTelegramProcessed(logId, {
            status: "accepted",
            parsedAction: "lembretes_command",
            resolutionData: {
                shiftLabel,
                regulationHeadcount,
                interventionWaitingCount,
            },
        });
        await sendMessage(message.chat.id, lembretesText);
        return { ok: true, lembretes: true };
    }

    if (normalizedText === "/status" || normalizedText === "/meuturno") {
        const senderTelegramId = message.from?.id ? String(message.from.id) : null;
        if (!senderTelegramId) {
            await markTelegramProcessed(logId, {
                status: "ignored",
                parsedAction: "status_command",
                errorMessage: "no_sender_id",
            });
            await sendMessage(message.chat.id, "❓ Não consegui identificar quem mandou essa mensagem.", message.message_id);
            return { ok: true, ignored: true };
        }

        const db = getDb();
        const recentEntry = await db.query.telegramIngestedMessages.findFirst({
            where: and(
                eq(telegramIngestedMessages.senderTelegramId, senderTelegramId),
                eq(telegramIngestedMessages.status, "accepted"),
                gte(telegramIngestedMessages.createdAt, new Date(Date.now() - 36 * 60 * 60 * 1000)),
            ),
            orderBy: [desc(telegramIngestedMessages.createdAt)],
        });

        if (!recentEntry || !recentEntry.relatedOccupancyId) {
            await markTelegramProcessed(logId, {
                status: "accepted",
                parsedAction: "status_command",
                resolutionData: { found: false },
            });
            await sendMessage(
                message.chat.id,
                "📋 Não encontrei nenhum lançamento seu nas últimas horas.\n\nSe você já está no plantão, avise sua chegada no grupo.",
                message.message_id,
            );
            return { ok: true, status: true };
        }

        const board = await getOperationalBoard();
        const allRows = [
            ...board.regulation.map((r) => ({ ...r, domain: "REG" as const })),
            ...board.intervention.map((r) => ({ ...r, domain: "INT" as const })),
        ];
        const myRow = allRows.find((r) =>
            r.occupancyId === recentEntry.relatedOccupancyId,
        );

        if (myRow && myRow.doctorName) {
            const startTime = myRow.startedAt
                ? new Date(myRow.startedAt).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "America/Sao_Paulo" })
                : "—";
            const targetCode = "baseCode" in myRow ? myRow.baseCode : "postCode" in myRow ? myRow.postCode : "—";
            const shiftInfo = myRow.shiftLabel ? ` (${myRow.shiftLabel})` : "";

            const statusLines = [
                `📋 *Sua situação no quadro:*`,
                ``,
                `▸ Nome: ${myRow.doctorName}`,
                `▸ Posto: ${targetCode}${shiftInfo}`,
                `▸ Chegada: ${startTime}`,
                `▸ Status: ativo no quadro`,
            ];

            await markTelegramProcessed(logId, {
                status: "accepted",
                parsedAction: "status_command",
                resolutionData: {
                    found: true,
                    occupancyId: recentEntry.relatedOccupancyId,
                    targetCode,
                    doctorName: myRow.doctorName,
                },
            });
            await sendMessage(message.chat.id, statusLines.join("\n"), message.message_id);
        } else {
            const statusLines = [
                `📋 *Seu último lançamento:*`,
                ``,
                `▸ ${recentEntry.parsedDoctorName ?? "—"} em ${recentEntry.parsedTargetCode ?? "—"}`,
                `▸ Esse registro não está mais ativo no quadro atual.`,
                ``,
                `Se você está no plantão agora, avise sua chegada normalmente.`,
            ];

            await markTelegramProcessed(logId, {
                status: "accepted",
                parsedAction: "status_command",
                resolutionData: {
                    found: true,
                    occupancyId: recentEntry.relatedOccupancyId,
                    active: false,
                },
            });
            await sendMessage(message.chat.id, statusLines.join("\n"), message.message_id);
        }
        return { ok: true, status: true };
    }

    const departureCorrectionCommand = parseTelegramDepartureCorrectionCommand(message.text);
    if (departureCorrectionCommand || isTelegramDepartureCorrectionCommandText(message.text)) {
        const actor = await resolveTelegramCommandActor(message);
        if (!actor || !actor.roles.some((role) => role === "admin" || role === "chief")) {
            await markTelegramProcessed(logId, {
                status: "ignored",
                errorMessage: "command_forbidden",
                parsedAction: "corrigirsaida",
                resolutionData: { rawCommand: message.text },
            });
            await sendMessage(message.chat.id, pickTelegramReply("command_forbidden", message.message_id, {}), message.message_id);
            return { ok: true, ignored: true };
        }

        if (!departureCorrectionCommand?.doctorName) {
            await markTelegramProcessed(logId, {
                status: "ignored",
                errorMessage: "command_usage_invalid",
                parsedAction: "corrigirsaida",
                resolutionData: { rawCommand: message.text },
            });
            await sendMessage(message.chat.id, pickTelegramReply("command_usage", message.message_id, {
                usage: "/corrigirsaida Nome Sobrenome | /corrigirsaida Nome Sobrenome 2035",
            }), message.message_id);
            return { ok: true, ignored: true };
        }

        const { doctor, candidates } = await resolveCommandDoctor({
            doctorQuery: departureCorrectionCommand.doctorName,
            activeDoctorId: null,
        });
        if (!doctor) {
            await markTelegramProcessed(logId, {
                status: "ignored",
                errorMessage: "command_doctor_not_resolved",
                parsedAction: "corrigirsaida",
                parsedDoctorName: departureCorrectionCommand.doctorName,
                parsedTargetCode: departureCorrectionCommand.targetCode,
                resolutionData: {
                    doctorQuery: departureCorrectionCommand.doctorName,
                    candidates: candidates.slice(0, 3),
                },
            });
            await sendMessage(message.chat.id, buildNameUnresolvedReply(message.message_id, candidates), message.message_id);
            return { ok: true, ignored: true };
        }

        const recentCandidates = await listRecentDepartureCorrectionCandidates({
            doctorId: doctor.id,
            referenceAt: new Date(message.date * 1000),
        });
        const resolution = pickLikelyDepartureCorrectionCandidate({
            candidates: recentCandidates,
            targetCode: departureCorrectionCommand.targetCode,
        });

        if (!resolution.candidate && resolution.ambiguousCandidates.length === 0) {
            await markTelegramProcessed(logId, {
                status: "ignored",
                errorMessage: "departure_correction_target_not_found",
                parsedAction: "corrigirsaida",
                parsedDoctorName: doctor.fullName,
                parsedTargetCode: departureCorrectionCommand.targetCode,
            });
            await sendMessage(
                message.chat.id,
                departureCorrectionCommand.targetCode
                    ? `:/ Nao encontrei plantão recente de ${resolveTelegramDoctorSurfaceName(doctor)} em ${departureCorrectionCommand.targetCode} para corrigir a saída.`
                    : `:/ Nao encontrei plantão recente de ${resolveTelegramDoctorSurfaceName(doctor)} para corrigir a saída.`,
                message.message_id,
            );
            return { ok: true, ignored: true };
        }

        if (!resolution.candidate) {
            await markTelegramProcessed(logId, {
                status: "ignored",
                errorMessage: "departure_correction_ambiguous",
                parsedAction: "corrigirsaida",
                parsedDoctorName: doctor.fullName,
                parsedTargetCode: departureCorrectionCommand.targetCode,
                resolutionData: {
                    ambiguousCandidates: resolution.ambiguousCandidates.map((candidate) => formatDepartureCorrectionCandidateSummary(candidate)),
                },
            });
            await sendMessage(
                message.chat.id,
                [
                    `:/ Achei mais de um plantão recente de ${resolveTelegramDoctorSurfaceName(doctor)}.`,
                    ...resolution.ambiguousCandidates.map((candidate, index) => `${index + 1}. ${formatDepartureCorrectionCandidateSummary(candidate)}`),
                    "",
                    `Reenvie com o alvo para eu travar o plantão certo. Ex.: /corrigirsaida ${resolveTelegramDoctorSurfaceName(doctor)} ${resolution.ambiguousCandidates[0]?.targetCode ?? "2035"}`,
                ].join("\n"),
                message.message_id,
            );
            return { ok: true, ignored: true };
        }

        await queuePendingDepartureCorrection({
            logId,
            message,
            resolvedDoctor: { id: doctor.id, fullName: doctor.fullName, displayName: doctor.displayName ?? null },
            candidate: resolution.candidate,
            originalText: message.text,
        });
        return { ok: true, ignored: true, pending: true };
    }

    const command = parseTelegramCommand(message.text);
    if (!command) {
        if (message.text.trim().startsWith("/")) {
            const recentMessages = await listRecentTelegramSenderMessages({
                chatId: String(message.chat.id),
                senderTelegramId: message.from?.id ? String(message.from.id) : null,
                senderName: [message.from?.first_name, message.from?.last_name].filter(Boolean).join(" ") || null,
                currentLogId: logId,
            });
            const suggestion = suggestTelegramCommandHelp({
                text: message.text,
                recentMessages,
            });
            await markTelegramProcessed(logId, {
                status: "ignored",
                errorMessage: "command_parse_failed",
                resolutionData: {
                    ...buildTelegramReviewLogData({
                        reason: "command_parse_failed",
                        trainingCandidate: true,
                    }),
                    rawCommand: message.text,
                    suggestionKind: suggestion?.kind ?? null,
                    suggestedCommands: suggestion?.suggestions.map((item) => item.usage) ?? [],
                },
            });
            await sendMessage(
                message.chat.id,
                suggestion ? buildTelegramCommandSuggestionReply(suggestion) : buildPublicTelegramCommandHelpReply(),
                message.message_id,
            );
            return { ok: true, ignored: true };
        }
        return null;
    }

    const actor = await resolveTelegramCommandActor(message);
    if (!actor || !actor.roles.some((role) => role === "admin" || role === "chief")) {
        await markTelegramProcessed(logId, {
            status: "ignored",
            errorMessage: "command_forbidden",
            parsedDomain: command.sector,
            parsedTargetCode: command.targetCode,
            parsedAction: command.name,
            resolutionData: { commandName: command.name, commandBody: command.rawBody },
        });
        await sendMessage(message.chat.id, pickTelegramReply("command_forbidden", message.message_id, {}), message.message_id);
        return { ok: true, ignored: true };
    }

    if (isTelegramAdminOnlyCommand(command.name) && !actor.roles.includes("admin")) {
        await markTelegramProcessed(logId, {
            status: "ignored",
            errorMessage: "command_admin_only",
            parsedDomain: command.sector,
            parsedTargetCode: command.targetCode,
            parsedAction: command.name,
            resolutionData: { commandName: command.name, commandBody: command.rawBody },
        });
        await sendMessage(
            message.chat.id,
            command.name === "remover"
                ? ":/ O comando /remover fica restrito a admin porque apaga o plantão do banco e da trilha operacional."
                : ":/ Os comandos /ativar e /desativar ficam restritos a admin porque alteram o estado operacional auditado da base ou do ramal.",
            message.message_id,
        );
        return { ok: true, ignored: true };
    }

    if (command.name === "ativar" || command.name === "desativar") {
        return handleOperationalBaseStateCommand({
            message,
            logId,
            actor,
            command,
        });
    }

    const parsedEntry: OperationalParsedEntry = {
        sector: command.sector,
        baseCode: command.targetCode,
        arrivalTime: command.time,
        shiftType: command.shiftLabel,
        roleFunction: command.roleLabel,
        isDeparture: command.isDeparture,
        isContinuation: false,
        isReassignment: false,
    };

    const active = await findActiveOccupancyByTarget(parsedEntry);
    if (!active.occupancy) {
        if (command.name === "remover") {
            return tryHandleHistoricalRemovalCommand({
                message,
                logId,
                actor,
                command,
            });
        }

        await markTelegramProcessed(logId, {
            status: "error",
            errorMessage: "command_target_not_found",
            parsedDomain: command.sector,
            parsedTargetCode: command.targetCode,
            parsedAction: command.name,
        });
        await sendMessage(message.chat.id, `:/ Nao encontrei ocupacao ativa em ${command.targetCode} para aplicar ${command.name}.`, message.message_id);
        return { ok: true, ignored: true };
    }

    if (command.name === "corrigir" && !command.isDeparture) {
        if (!command.time) {
            await markTelegramProcessed(logId, {
                status: "ignored",
                errorMessage: "command_usage_invalid",
                parsedDomain: command.sector,
                parsedTargetCode: command.targetCode,
                parsedAction: command.name,
            });
            await sendMessage(message.chat.id, pickTelegramReply("command_usage", message.message_id, {
                usage: "/corrigir PM04 20:00 | /corrigir PM04 Nome Completo 20:00",
            }), message.message_id);
            return { ok: true, ignored: true };
        }

        const { doctor, candidates, usedActiveDoctorFallback } = await resolveCommandDoctor({
            doctorQuery: command.doctorName,
            activeDoctorId: active.occupancy.doctorId,
        });
        if (!doctor) {
            await markTelegramProcessed(logId, {
                status: "ignored",
                errorMessage: "command_doctor_not_resolved",
                parsedDomain: command.sector,
                parsedTargetCode: command.targetCode,
                parsedAction: command.name,
                resolutionData: {
                    doctorQuery: command.doctorName,
                    activeDoctorId: active.occupancy.doctorId,
                    candidates: candidates.slice(0, 3),
                },
            });
            await sendMessage(message.chat.id, buildNameUnresolvedReply(message.message_id, candidates), message.message_id);
            return { ok: true, ignored: true };
        }

        try {
            const eventAt = resolveTelegramEventTime(new Date(message.date * 1000), command.time);

            // Preserve boardStartedAt when it differs from startedAt (continuity record).
            // The hasOwn check in correctRegulationOccupancy / correctInterventionOccupancy
            // keeps the existing value when boardStartedAt is omitted from input.
            const existingBoardStartedAt = active.occupancy!.boardStartedAt;
            const existingStartedAt = active.occupancy!.startedAt;
            const isContinuityRecord = existingBoardStartedAt
                && existingStartedAt
                && existingBoardStartedAt.getTime() !== existingStartedAt.getTime();

            const correctionBase = {
                doctorId: doctor.id,
                startedAt: eventAt,
                notes: `${active.occupancy!.notes ?? ""}\n[telegram /corrigir] ${message.text}`.trim(),
                ...(isContinuityRecord ? {} : { boardStartedAt: eventAt }),
            };

            const updated = command.sector === "REGULATION"
                ? await correctRegulationOccupancy(active.occupancy!.id, correctionBase, resolveCommandAuditUserId(null))
                : await correctInterventionOccupancy(active.occupancy!.id, correctionBase, resolveCommandAuditUserId(null));

            await markTelegramProcessed(logId, {
                status: "accepted",
                parsedDomain: command.sector,
                parsedTargetCode: command.targetCode,
                parsedAction: command.name,
                parsedDoctorName: doctor.fullName,
                relatedOccupancyId: updated.id,
                resolutionData: {
                    actorRoles: actor.roles,
                    commandName: command.name,
                    usedActiveDoctorFallback,
                },
            });
            await sendMessage(message.chat.id, pickTelegramReply("command_corrected", message.message_id, {
                target: command.targetCode,
                name: doctor.fullName,
                time: formatTelegramReplyTime(eventAt),
            }), message.message_id);

            if (message.chat.type === "private") {
                await announcePrivateCorrectionToGroups(message.message_id, {
                    target: command.targetCode,
                    name: doctor.fullName,
                    time: formatTelegramReplyTime(eventAt),
                });
            }

            return { ok: true, occupancyId: updated.id };
        } catch (error) {
            await markTelegramProcessed(logId, {
                status: "error",
                parsedDomain: command.sector,
                parsedTargetCode: command.targetCode,
                parsedAction: command.name,
                parsedDoctorName: doctor.fullName,
                errorMessage: error instanceof Error ? error.message : "command_correction_failed",
                resolutionData: {
                    actorRoles: actor.roles,
                    commandName: command.name,
                    usedActiveDoctorFallback,
                },
            });
            await sendMessage(message.chat.id, `:/ Nao consegui corrigir ${command.targetCode}. ${error instanceof Error ? error.message : "Falha inesperada."}`, message.message_id);
            return { ok: true, ignored: true };
        }
    }

    if ((command.name === "ontem" || command.name === "hoje") && !command.isDeparture) {
        if (!command.time) {
            await markTelegramProcessed(logId, {
                status: "ignored",
                errorMessage: "command_usage_invalid",
                parsedDomain: command.sector,
                parsedTargetCode: command.targetCode,
                parsedAction: command.name,
            });
            await sendMessage(message.chat.id, pickTelegramReply("command_usage", message.message_id, {
                usage: `/${command.name} PM04 20:00 | /${command.name} PM04 Nome 20:00`,
            }), message.message_id);
            return { ok: true, ignored: true };
        }

        const { doctor, candidates, usedActiveDoctorFallback } = await resolveCommandDoctor({
            doctorQuery: command.doctorName,
            activeDoctorId: active.occupancy.doctorId,
        });
        if (!doctor) {
            await markTelegramProcessed(logId, {
                status: "ignored",
                errorMessage: "command_doctor_not_resolved",
                parsedDomain: command.sector,
                parsedTargetCode: command.targetCode,
                parsedAction: command.name,
                resolutionData: {
                    doctorQuery: command.doctorName,
                    activeDoctorId: active.occupancy.doctorId,
                    candidates: candidates.slice(0, 3),
                },
            });
            await sendMessage(message.chat.id, buildNameUnresolvedReply(message.message_id, candidates), message.message_id);
            return { ok: true, ignored: true };
        }

        try {
            const dayOffset = command.name === "ontem" ? -1 : 0;
            const eventAt = resolveForcedDayEventTime(new Date(message.date * 1000), command.time, dayOffset);

            const existingBoardStartedAt = active.occupancy!.boardStartedAt;
            const existingStartedAt = active.occupancy!.startedAt;
            const isContinuityRecord = existingBoardStartedAt
                && existingStartedAt
                && existingBoardStartedAt.getTime() !== existingStartedAt.getTime();

            const correctionBase = {
                doctorId: doctor.id,
                startedAt: eventAt,
                notes: `${active.occupancy!.notes ?? ""}\n[telegram /${command.name}] ${message.text}`.trim(),
                ...(isContinuityRecord ? {} : { boardStartedAt: eventAt }),
            };

            const updated = command.sector === "REGULATION"
                ? await correctRegulationOccupancy(active.occupancy!.id, correctionBase, resolveCommandAuditUserId(null))
                : await correctInterventionOccupancy(active.occupancy!.id, correctionBase, resolveCommandAuditUserId(null));

            await markTelegramProcessed(logId, {
                status: "accepted",
                parsedDomain: command.sector,
                parsedTargetCode: command.targetCode,
                parsedAction: command.name,
                parsedDoctorName: doctor.fullName,
                relatedOccupancyId: updated.id,
                resolutionData: {
                    actorRoles: actor.roles,
                    commandName: command.name,
                    usedActiveDoctorFallback,
                    dayOffset,
                },
            });
            await sendMessage(message.chat.id, pickTelegramReply("command_corrected", message.message_id, {
                target: command.targetCode,
                name: doctor.fullName,
                time: formatTelegramReplyTime(eventAt),
            }), message.message_id);

            if (message.chat.type === "private") {
                await announcePrivateCorrectionToGroups(message.message_id, {
                    target: command.targetCode,
                    name: doctor.fullName,
                    time: formatTelegramReplyTime(eventAt),
                });
            }

            return { ok: true, occupancyId: updated.id };
        } catch (error) {
            await markTelegramProcessed(logId, {
                status: "error",
                parsedDomain: command.sector,
                parsedTargetCode: command.targetCode,
                parsedAction: command.name,
                parsedDoctorName: doctor.fullName,
                errorMessage: error instanceof Error ? error.message : "command_day_correction_failed",
                resolutionData: {
                    actorRoles: actor.roles,
                    commandName: command.name,
                    usedActiveDoctorFallback,
                },
            });
            await sendMessage(message.chat.id, `:/ Nao consegui corrigir ${command.targetCode}. ${error instanceof Error ? error.message : "Falha inesperada."}`, message.message_id);
            return { ok: true, ignored: true };
        }
    }

    if (command.name === "ramal") {
        if (command.sector !== "REGULATION") {
            await markTelegramProcessed(logId, {
                status: "ignored",
                errorMessage: "command_usage_invalid",
                parsedDomain: command.sector,
                parsedTargetCode: command.targetCode,
                parsedAction: command.name,
            });
            await sendMessage(message.chat.id, pickTelegramReply("command_usage", message.message_id, {
                usage: "/ramal Nome Sobrenome 1363 RMT | /ramal Nome Sobrenome 1363 PSIQ | /ramal Nome Sobrenome 1363",
            }), message.message_id);
            return { ok: true, ignored: true };
        }

        const { doctor, candidates, usedActiveDoctorFallback } = await resolveCommandDoctor({
            doctorQuery: command.doctorName,
            activeDoctorId: active.occupancy.doctorId,
        });
        if (!doctor) {
            await markTelegramProcessed(logId, {
                status: "ignored",
                errorMessage: "command_doctor_not_resolved",
                parsedDomain: command.sector,
                parsedTargetCode: command.targetCode,
                parsedAction: command.name,
                resolutionData: {
                    doctorQuery: command.doctorName,
                    activeDoctorId: active.occupancy.doctorId,
                    candidates: candidates.slice(0, 3),
                },
            });
            await sendMessage(message.chat.id, buildNameUnresolvedReply(message.message_id, candidates), message.message_id);
            return { ok: true, ignored: true };
        }

        if (doctor.id !== active.occupancy.doctorId) {
            const activeDoctorName = await loadDoctorSurfaceName(active.occupancy.doctorId);
            await markTelegramProcessed(logId, {
                status: "ignored",
                errorMessage: "command_role_doctor_mismatch",
                parsedDomain: command.sector,
                parsedTargetCode: command.targetCode,
                parsedAction: command.name,
                parsedDoctorName: doctor.fullName,
                resolutionData: {
                    activeDoctorId: active.occupancy.doctorId,
                    activeDoctorName,
                    usedActiveDoctorFallback,
                },
            });
            await sendMessage(message.chat.id, `:/ ${command.targetCode} está com ${activeDoctorName} no plantão ativo. O comando /ramal só troca a função sem mexer no médico nem no horário.`, message.message_id);
            return { ok: true, ignored: true };
        }

        const fixedRole = resolveFixedOperationalRole({
            domain: "regulation",
            code: command.targetCode,
            shiftLabel: active.occupancy.shiftLabel === "SD" || active.occupancy.shiftLabel === "SN" || active.occupancy.shiftLabel === "P"
                ? active.occupancy.shiftLabel
                : null,
        });
        const nextRoleLabel = normalizeOperationalRoleLabel(command.roleLabel);
        if (fixedRole) {
            await markTelegramProcessed(logId, {
                status: "ignored",
                errorMessage: "command_role_fixed",
                parsedDomain: command.sector,
                parsedTargetCode: command.targetCode,
                parsedAction: command.name,
                parsedDoctorName: doctor.fullName,
                resolutionData: {
                    fixedRole,
                    requestedRole: nextRoleLabel,
                },
            });
            await sendMessage(message.chat.id, `:/ ${command.targetCode} tem função fixa ${fixedRole} neste turno. Esse ramal não aceita troca manual de função.`, message.message_id);
            return { ok: true, ignored: true };
        }

        try {
            const updated = await correctRegulationOccupancy(active.occupancy.id, {
                roleLabel: nextRoleLabel,
                notes: `${active.occupancy.notes ?? ""}\n[telegram /ramal] ${message.text}`.trim(),
            }, resolveCommandAuditUserId(actor.userId));

            await markTelegramProcessed(logId, {
                status: "accepted",
                parsedDomain: command.sector,
                parsedTargetCode: command.targetCode,
                parsedAction: command.name,
                parsedDoctorName: doctor.fullName,
                relatedOccupancyId: updated.id,
                resolutionData: {
                    actorRoles: actor.roles,
                    commandName: command.name,
                    previousRoleLabel: active.occupancy.roleLabel,
                    nextRoleLabel,
                    usedActiveDoctorFallback,
                },
            });

            await sendMessage(
                message.chat.id,
                nextRoleLabel
                    ? `Função atualizada em ${command.targetCode}: ${resolveTelegramDoctorSurfaceName(doctor)} segue no mesmo plantão, agora como ${nextRoleLabel}. Chegada e meal break foram preservados.`
                    : `Função removida em ${command.targetCode}: ${resolveTelegramDoctorSurfaceName(doctor)} segue no mesmo plantão sem função operacional extra. Chegada e meal break foram preservados.`,
                message.message_id,
            );
            return { ok: true, occupancyId: updated.id };
        } catch (error) {
            await markTelegramProcessed(logId, {
                status: "error",
                parsedDomain: command.sector,
                parsedTargetCode: command.targetCode,
                parsedAction: command.name,
                parsedDoctorName: doctor.fullName,
                errorMessage: error instanceof Error ? error.message : "command_role_update_failed",
                resolutionData: {
                    actorRoles: actor.roles,
                    commandName: command.name,
                    nextRoleLabel,
                    usedActiveDoctorFallback,
                },
            });
            await sendMessage(message.chat.id, `:/ Nao consegui atualizar a função em ${command.targetCode}. ${error instanceof Error ? error.message : "Falha inesperada."}`, message.message_id);
            return { ok: true, ignored: true };
        }
    }

    if (command.name === "retirar" || command.isDeparture) {
        const eventAt = resolveTelegramEventTime(new Date(message.date * 1000), command.time);
        const { doctor, candidates, usedActiveDoctorFallback } = await resolveCommandDoctor({
            doctorQuery: command.doctorName,
            activeDoctorId: active.occupancy.doctorId,
        });
        if (!doctor) {
            await markTelegramProcessed(logId, {
                status: "ignored",
                errorMessage: "command_doctor_not_resolved",
                parsedDomain: command.sector,
                parsedTargetCode: command.targetCode,
                parsedAction: "departure",
                resolutionData: {
                    doctorQuery: command.doctorName,
                    activeDoctorId: active.occupancy.doctorId,
                    candidates: candidates.slice(0, 3),
                },
            });
            await sendMessage(message.chat.id, buildNameUnresolvedReply(message.message_id, candidates), message.message_id);
            return { ok: true, ignored: true };
        }

        const updated = command.sector === "REGULATION"
            ? await endRegulationOccupancy(active.occupancy.id, { endedAt: eventAt, actualEndedAt: eventAt }, resolveCommandAuditUserId(null))
            : await endInterventionOccupancy(active.occupancy.id, { endedAt: eventAt, actualEndedAt: eventAt }, resolveCommandAuditUserId(null));
        const doctorName = doctor.fullName;

        await markTelegramProcessed(logId, {
            status: "accepted",
            parsedDomain: command.sector,
            parsedTargetCode: command.targetCode,
            parsedAction: "departure",
            parsedDoctorName: doctorName,
            relatedOccupancyId: updated.id,
            resolutionData: { actorRoles: actor.roles, commandName: command.name, usedActiveDoctorFallback },
        });
        await sendMessage(message.chat.id, pickTelegramReply("command_removed", message.message_id, {
            target: command.targetCode,
            name: doctorName,
            time: formatTelegramReplyTime(eventAt),
        }), message.message_id);
        return { ok: true, occupancyId: updated.id };
    }

    const deleted = command.sector === "REGULATION"
        ? await removeRegulationOccupancyRecord(active.occupancy.id, resolveCommandAuditUserId(null))
        : await removeInterventionOccupancyRecord(active.occupancy.id, resolveCommandAuditUserId(null));
    const doctorName = await loadDoctorSurfaceName(deleted.doctorId);

    await markTelegramProcessed(logId, {
        status: "accepted",
        parsedDomain: command.sector,
        parsedTargetCode: command.targetCode,
        parsedAction: command.name,
        parsedDoctorName: doctorName,
        relatedOccupancyId: null,
        resolutionData: { actorRoles: actor.roles, commandName: command.name },
    });
    await sendMessage(message.chat.id, pickTelegramReply("command_deleted", message.message_id, {
        target: command.targetCode,
        name: doctorName,
        time: "",
    }), message.message_id);
    return { ok: true, removed: true };
}

async function tryHandleMealBreakReply(update: TelegramUpdate, logId: string) {
    const message = update.message;
    if (!message?.text) {
        return null;
    }

    const referenceAt = new Date(message.date * 1000);
    const shouldPrioritize = await shouldPrioritizeTelegramMealBreakReply({
        chatId: String(message.chat.id),
        text: message.text,
        referenceAt,
    });
    if (!shouldPrioritize) {
        // If the message parses as an operational arrival/departure, let normal
        // processing handle it instead of consuming it as a meal-break reply.
        const operationalEntries = parseMessageMulti(message.text).filter(isOperationalParsedEntry);
        if (operationalEntries.length > 0) {
            return null;
        }
        if (looksLikeDepartureMessage(message.text)) {
            return null;
        }
    }

    try {
        const result = await handleTelegramMealBreakReply({
            chatId: String(message.chat.id),
            text: message.text,
            senderTelegramId: resolveTelegramMealBreakSenderId(update),
            referenceAt,
        });
        if (!result) {
            return null;
        }

        await markTelegramProcessed(logId, {
            status: result.status === "invalid" ? "ignored" : "accepted",
            parsedAction: "meal_break_reply",
            errorMessage: result.status === "invalid" ? "meal_break_reply_invalid" : null,
            resolutionData: {
                resultStatus: result.status,
                ...resolveMealBreakLogDetails(result.session),
            },
        });
        await sendTelegramReplyBatch(message.chat.id, result.messages, message.message_id, result.session);
        return { ok: true, mealBreak: true };
    } catch (error) {
        await markTelegramProcessed(logId, {
            status: "error",
            parsedAction: "meal_break_reply",
            errorMessage: error instanceof Error ? error.message : "meal_break_reply_failed",
        });
        await sendMessage(message.chat.id, buildMealBreakErrorReply(error), message.message_id);
        return { ok: true, ignored: true };
    }
}

const PENDING_TTL_MS = 30 * 60 * 1000; // 30 minutes
const GLOBAL_EXPIRY_INTERVAL_MS = 5 * 60 * 1000; // run global cleanup at most every 5 minutes
let lastGlobalExpiryAt = 0;

async function expireAllStalePendingsGlobal() {
    const now = Date.now();
    if (now - lastGlobalExpiryAt < GLOBAL_EXPIRY_INTERVAL_MS) return;
    lastGlobalExpiryAt = now;
    const db = getDb();
    const cutoff = new Date(now - PENDING_TTL_MS);
    await db.update(telegramIngestedMessages)
        .set({
            status: "superseded",
            errorMessage: "pending_expired",
            processedAt: new Date(),
        })
        .where(and(
            inArray(telegramIngestedMessages.status, [
                "pending_name_selection",
                "pending_departure_justification",
                "pending_departure_correction",
                "pending_cru_coi_ramal",
            ]),
            lt(telegramIngestedMessages.createdAt, cutoff),
        ));
}

async function findPendingRamalSelection(chatId: string, senderTelegramId: string) {
    const db = getDb();
    const cutoff = new Date(Date.now() - PENDING_TTL_MS);
    const fresh = await db.query.telegramIngestedMessages.findFirst({
        where: and(
            eq(telegramIngestedMessages.chatId, chatId),
            eq(telegramIngestedMessages.senderTelegramId, senderTelegramId),
            eq(telegramIngestedMessages.status, "pending_cru_coi_ramal"),
            gte(telegramIngestedMessages.createdAt, cutoff),
        ),
        orderBy: [desc(telegramIngestedMessages.createdAt)],
    });
    if (!fresh) {
        await expireStalependings(chatId, senderTelegramId, "pending_cru_coi_ramal");
    }
    return fresh ?? null;
}

async function expireStalependings(
    chatId: string,
    senderTelegramId: string,
    status: "pending_name_selection" | "pending_departure_justification" | "pending_departure_correction" | "pending_cru_coi_ramal",
) {
    const db = getDb();
    const cutoff = new Date(Date.now() - PENDING_TTL_MS);
    await db.update(telegramIngestedMessages)
        .set({
            status: "superseded",
            errorMessage: "pending_expired",
            processedAt: new Date(),
        })
        .where(and(
            eq(telegramIngestedMessages.chatId, chatId),
            eq(telegramIngestedMessages.senderTelegramId, senderTelegramId),
            eq(telegramIngestedMessages.status, status),
            lt(telegramIngestedMessages.createdAt, cutoff),
        ));
}

async function findPendingNameSelection(chatId: string, senderTelegramId: string) {
    const db = getDb();
    const cutoff = new Date(Date.now() - PENDING_TTL_MS);
    const fresh = await db.query.telegramIngestedMessages.findFirst({
        where: and(
            eq(telegramIngestedMessages.chatId, chatId),
            eq(telegramIngestedMessages.senderTelegramId, senderTelegramId),
            eq(telegramIngestedMessages.status, "pending_name_selection"),
            gte(telegramIngestedMessages.createdAt, cutoff),
        ),
        orderBy: [desc(telegramIngestedMessages.createdAt)],
    });
    if (!fresh) {
        await expireStalependings(chatId, senderTelegramId, "pending_name_selection");
    }
    return fresh ?? null;
}

async function findPendingDepartureJustification(chatId: string, senderTelegramId: string) {
    const db = getDb();
    const cutoff = new Date(Date.now() - PENDING_TTL_MS);
    const fresh = await db.query.telegramIngestedMessages.findFirst({
        where: and(
            eq(telegramIngestedMessages.chatId, chatId),
            eq(telegramIngestedMessages.senderTelegramId, senderTelegramId),
            eq(telegramIngestedMessages.status, "pending_departure_justification"),
            gte(telegramIngestedMessages.createdAt, cutoff),
        ),
        orderBy: [desc(telegramIngestedMessages.createdAt)],
    });
    if (!fresh) {
        await expireStalependings(chatId, senderTelegramId, "pending_departure_justification");
    }
    return fresh ?? null;
}

async function findPendingDepartureCorrection(chatId: string, senderTelegramId: string) {
    const db = getDb();
    const cutoff = new Date(Date.now() - PENDING_TTL_MS);
    const fresh = await db.query.telegramIngestedMessages.findFirst({
        where: and(
            eq(telegramIngestedMessages.chatId, chatId),
            eq(telegramIngestedMessages.senderTelegramId, senderTelegramId),
            eq(telegramIngestedMessages.status, "pending_departure_correction"),
            gte(telegramIngestedMessages.createdAt, cutoff),
        ),
        orderBy: [desc(telegramIngestedMessages.createdAt)],
    });
    if (!fresh) {
        await expireStalependings(chatId, senderTelegramId, "pending_departure_correction");
    }
    return fresh ?? null;
}

async function supersedePendingDepartureJustification(chatId: string, senderTelegramId: string, reason = "departure_justification_superseded") {
    const pending = await findPendingDepartureJustification(chatId, senderTelegramId);
    if (!pending) {
        return;
    }

    await markTelegramProcessed(pending.id, {
        status: "superseded",
        errorMessage: reason,
    });
}

async function supersedePendingDepartureCorrection(chatId: string, senderTelegramId: string, reason = "departure_correction_superseded") {
    const pending = await findPendingDepartureCorrection(chatId, senderTelegramId);
    if (!pending) {
        return;
    }

    await markTelegramProcessed(pending.id, {
        status: "superseded",
        errorMessage: reason,
    });
}

function isPendingResolutionData(value: unknown): value is PendingNameResolutionData {
    if (!value || typeof value !== "object") {
        return false;
    }

    const candidate = value as Record<string, unknown>;
    return Boolean(
        candidate.parsed
        && candidate.candidates
        && candidate.originalEventAt,
    );
}

function isPendingDepartureJustificationData(value: unknown): value is PendingDepartureJustificationData {
    if (!value || typeof value !== "object") {
        return false;
    }

    const candidate = value as Record<string, unknown>;
    return Boolean(
        candidate.parsed
        && candidate.resolvedDoctor
        && candidate.originalText
        && candidate.originalEventAt,
    );
}

function isPendingDepartureCorrectionData(value: unknown): value is PendingDepartureCorrectionData {
    if (!value || typeof value !== "object") {
        return false;
    }

    const candidate = value as Record<string, unknown>;
    return Boolean(
        candidate.resolvedDoctor
        && candidate.candidate
        && candidate.originalText,
    );
}

function isPendingCruCoiRamalData(value: unknown): value is PendingCruCoiRamalData {
    if (!value || typeof value !== "object") {
        return false;
    }

    const candidate = value as Record<string, unknown>;
    return Boolean(
        candidate.location
        && (candidate.location === "CRU" || candidate.location === "COI")
        && typeof candidate.originalText === "string"
        && typeof candidate.originalEventAt === "string",
    );
}

async function queuePendingDepartureJustification(params: {
    logId: string;
    message: TelegramUpdate["message"];
    parsed: OperationalParsedEntry;
    resolvedDoctor: ResolvedTelegramDoctorRef;
    eventAt: Date;
    referenceAt: Date;
    originalText: string;
}) {
    const senderTelegramId = params.message?.from?.id ? String(params.message.from.id) : null;
    if (senderTelegramId) {
        await supersedePendingDepartureJustification(String(params.message!.chat.id), senderTelegramId, "departure_justification_replaced");
    }

    const departureExample = buildTelegramDepartureExample({
        doctorName: params.resolvedDoctor.fullName,
        target: params.parsed.baseCode,
        time: params.parsed.arrivalTime ?? formatTelegramReplyTime(params.eventAt),
    });

    await markTelegramProcessed(params.logId, {
        status: "pending_departure_justification",
        parsedDomain: params.parsed.sector,
        parsedTargetCode: params.parsed.baseCode,
        parsedAction: resolveTelegramParsedAction(params.parsed),
        parsedDoctorName: params.resolvedDoctor.fullName,
        errorMessage: "departure_justification_required",
        resolutionData: {
            ...buildTelegramReviewLogData({
                reason: "departure_justification_required",
                parsed: params.parsed,
                doctorQuery: params.resolvedDoctor.fullName,
                example: departureExample,
                looksLikeDeparture: true,
            }),
            parsed: {
                sector: params.parsed.sector,
                baseCode: params.parsed.baseCode,
                arrivalTime: params.parsed.arrivalTime,
                shiftType: params.parsed.shiftType,
                roleFunction: params.parsed.roleFunction,
                isDeparture: params.parsed.isDeparture,
                isContinuation: params.parsed.isContinuation,
                isReassignment: params.parsed.isReassignment ?? false,
            },
            resolvedDoctor: params.resolvedDoctor,
            originalText: params.originalText,
            originalEventAt: params.eventAt.toISOString(),
            originalReferenceAt: params.referenceAt.toISOString(),
            invalidJustificationAttempts: 0,
        },
    });

    await sendMessage(
        params.message!.chat.id,
        pickTelegramReply("departure_justification_required", params.message!.message_id, {
            name: resolveTelegramDoctorSurfaceName(params.resolvedDoctor),
            target: params.parsed.baseCode ?? "plantao",
            time: params.parsed.arrivalTime ?? formatTelegramReplyTime(params.eventAt),
            example: departureExample,
        }),
        params.message!.message_id,
    );
}

async function queuePendingDepartureCorrection(params: {
    logId: string;
    message: TelegramUpdate["message"];
    resolvedDoctor: ResolvedTelegramDoctorRef;
    candidate: TelegramDepartureCorrectionCandidate;
    originalText: string;
}) {
    const senderTelegramId = params.message?.from?.id ? String(params.message.from.id) : null;
    if (senderTelegramId) {
        await supersedePendingDepartureCorrection(String(params.message!.chat.id), senderTelegramId, "departure_correction_replaced");
        await supersedePendingDepartureJustification(String(params.message!.chat.id), senderTelegramId, "departure_justification_superseded_by_departure_correction");
    }

    await markTelegramProcessed(params.logId, {
        status: "pending_departure_correction",
        parsedDomain: params.candidate.domain,
        parsedTargetCode: params.candidate.targetCode,
        parsedAction: "departure_correction_request",
        parsedDoctorName: params.resolvedDoctor.fullName,
        resolutionData: {
            resolvedDoctor: params.resolvedDoctor,
            candidate: serializeDepartureCorrectionCandidate(params.candidate),
            originalText: params.originalText,
        },
    });

    const startedAt = formatTelegramReplyTime(params.candidate.startedAt);
    const currentExit = params.candidate.actualEndedAt ?? params.candidate.endedAt;
    const currentExitLabel = currentExit ? formatTelegramReplyTime(currentExit) : "ainda ativo";
    const targetLabel = params.candidate.shiftLabel ? `${params.candidate.targetCode} ${params.candidate.shiftLabel}` : params.candidate.targetCode;
    const domainLabel = params.candidate.domain === "REGULATION" ? "ramal" : "base";
    const currentSituation = params.candidate.isActive
        ? `Ele ainda aparece ativo em ${targetLabel}.`
        : `Hoje o sistema está com saída ${currentExitLabel} em ${targetLabel}.`;

    await sendMessage(
        params.message!.chat.id,
        [
            `Achei o plantão de ${resolveTelegramDoctorSurfaceName(params.resolvedDoctor)}.`,
            `${domainLabel} ${targetLabel} | chegada ${startedAt}`,
            currentSituation,
            "",
            "Responda agora só com a hora correta da saída no formato HH:MM.",
            "Ex.: 19:05",
            "Se quiser cancelar, mande CANCELAR.",
        ].join("\n"),
        params.message!.message_id,
    );
}

async function queuePendingNameSelection(
    logId: string,
    message: TelegramUpdate["message"],
    parsed: OperationalParsedEntry,
    doctorQuery: string | null,
    referenceAt: Date,
    eventAt: Date,
    candidates: TelegramDoctorCandidate[],
) {
    await markTelegramProcessed(logId, {
        status: "pending_name_selection",
        parsedDomain: parsed.sector,
        parsedTargetCode: parsed.baseCode,
        parsedAction: resolveTelegramParsedAction(parsed),
        resolutionData: {
            ...buildTelegramReviewLogData({
                reason: "pending_name_selection",
                parsed,
                doctorQuery,
                candidates,
                looksLikeDeparture: parsed.isDeparture,
                example: parsed.isDeparture
                    ? buildTelegramDepartureExample({
                        doctorName: doctorQuery,
                        target: parsed.baseCode,
                        time: parsed.arrivalTime,
                    })
                    : null,
            }),
            parsed: {
                sector: parsed.sector,
                baseCode: parsed.baseCode,
                arrivalTime: parsed.arrivalTime,
                shiftType: parsed.shiftType,
                roleFunction: parsed.roleFunction,
                isShadow: parsed.isShadow ?? false,
                isDeparture: parsed.isDeparture,
                isContinuation: parsed.isContinuation,
                isReassignment: parsed.isReassignment ?? false,
            },
            candidates: candidates.slice(0, 3).map((candidate) => ({
                id: candidate.id,
                fullName: candidate.fullName,
                displayName: candidate.displayName,
                normalizedName: candidate.normalizedName,
            })),
            originalText: message?.text ?? "",
            originalEventAt: eventAt.toISOString(),
            originalReferenceAt: referenceAt.toISOString(),
            continuationMode: resolveTelegramContinuationMode(parsed),
        },
    });

    const departureHint = parsed.isDeparture || looksLikeDepartureMessage(message?.text ?? "")
        ? buildStructuredTelegramDepartureHint({
            doctorName: candidates[0]?.fullName ?? doctorQuery,
            target: parsed.baseCode,
            time: parsed.arrivalTime,
        })
        : "";

    const candidateButtons = candidates.slice(0, 3).map((_, i) => `${i + 1}`);
    const keyboard = buildChoiceKeyboard([candidateButtons]);

    await sendMessage(
        message!.chat.id,
        `${buildCandidatePromptReply(message!.message_id, candidates, { target: parsed.baseCode, time: parsed.arrivalTime, shift: parsed.shiftType })}\n\n${isTelegramContinuationIntent(parsed) ? "Se isso for continuidade, vou manter a chegada original e registrar apenas a confirmacao da passagem para o proximo plantao." : "Vou manter o horario da primeira mensagem."}${departureHint}`,
        message!.message_id,
        keyboard,
    );
}

async function handleTelegramReassignment(params: {
    parsed: OperationalParsedEntry;
    resolvedDoctor: ResolvedTelegramDoctorRef;
    eventAt: Date;
    messageText: string;
    activeOcc?: {
        sector: "REGULATION" | "INTERVENTION";
        baseCode: string;
        occupancyId: string;
        startedAt: Date;
        shiftLabel: string | null;
        continuityGroupId: string | null;
        boardStartedAt: Date | null;
    } | null;
}) {
    const db = getDb();
    const { parsed, resolvedDoctor, eventAt, messageText } = params;

    // Step 1: Find the doctor's current active occupancy (any domain)
    const activeOcc = params.activeOcc ?? await findActiveOccupancyByDoctorId(resolvedDoctor.id);
    if (!activeOcc) {
        throw new Error("Medico nao tem ocupacao ativa para remanejar. Registre a chegada normalmente.");
    }

    // Step 2: Resolve the target post/base
    const targetCode = parsed.baseCode as string;
    const sourceDomain = activeOcc.sector;
    const sourceCode = activeOcc.baseCode;
    const sourceOccupancyId = activeOcc.occupancyId;

    if (sourceDomain === parsed.sector && sourceCode === targetCode) {
        throw new Error(`Medico ja esta em ${targetCode}. Nao e necessario remanejar.`);
    }

    // Step 3: Check if the target has a conflicting occupancy from another doctor
    let destination: { domain: "regulation" | "intervention"; targetId: number };
    if (parsed.sector === "REGULATION") {
        const post = await db.query.regulationPosts.findFirst({
            where: eq(regulationPosts.code, targetCode),
        });
        if (!post) {
            throw new Error("Ramal de destino nao encontrado.");
        }

        const targetConflict = await db.query.regulationOccupancies.findFirst({
            where: and(
                eq(regulationOccupancies.postId, post.id),
                isNull(regulationOccupancies.endedAt),
            ),
        });
        if (targetConflict && targetConflict.doctorId !== resolvedDoctor.id) {
            throw new Error(`Ramal ${targetCode} ja esta ocupado por outro medico. Resolva o conflito pelo site da chefia.`);
        }
        destination = {
            domain: "regulation",
            targetId: post.id,
        };
    } else {
        const base = await db.query.interventionBases.findFirst({
            where: eq(interventionBases.code, targetCode),
        });
        if (!base) {
            throw new Error("Base de destino nao encontrada.");
        }

        const targetConflict = await db.query.interventionOccupancies.findFirst({
            where: and(
                eq(interventionOccupancies.baseId, base.id),
                isNull(interventionOccupancies.endedAt),
            ),
        });
        if (targetConflict && targetConflict.doctorId !== resolvedDoctor.id) {
            throw new Error(`Base ${targetCode} ja esta ocupada por outro medico. Resolva o conflito pelo site da chefia.`);
        }
        destination = {
            domain: "intervention",
            targetId: base.id,
        };
    }

    const transferResult = await transferOperationalOccupancy(
        sourceOccupancyId,
        {
            sourceDomain: sourceDomain === "REGULATION" ? "regulation" : "intervention",
            destination,
            roleLabel: parsed.roleFunction ?? undefined,
            notes: `Remanejado via Telegram de ${sourceCode} para ${targetCode}. ${messageText}`.trim(),
            conflictResolution: null,
        },
        null,
    );

    const preservedArrivalAt = activeOcc.boardStartedAt ?? activeOcc.startedAt;

    return {
        occupancyId: transferResult.movedOccupancyId,
        successKind: "standard" as const,
        treatedAsContinuation: false,
        replyTimeAt: preservedArrivalAt,
        autoReactivated: false,
        effectiveShiftType: transferResult.movedSnapshot.shiftLabel ?? activeOcc.shiftLabel ?? null,
        reassignedFrom: sourceCode,
        assumedHalfShift: false,
        continuationFrom: null as string | null,
    };
}

async function applyParsedEntry(params: {
    parsed: OperationalParsedEntry;
    resolvedDoctor: ResolvedTelegramDoctorRef;
    eventAt: Date;
    referenceAt: Date;
    messageText: string;
}) {
    const db = getDb();
    const { parsed, resolvedDoctor, eventAt, referenceAt, messageText } = params;

    const activeOcc = !parsed.isDeparture
        ? await findActiveOccupancyByDoctorId(resolvedDoctor.id)
        : null;

    const implicitReassignment = shouldTreatTelegramArrivalAsImplicitReassignment({
        sector: parsed.sector,
        baseCode: parsed.baseCode,
        arrivalTime: parsed.arrivalTime,
        shiftType: parsed.shiftType,
        roleFunction: parsed.roleFunction,
        isDeparture: parsed.isDeparture,
        isContinuation: parsed.isContinuation,
        isReassignment: parsed.isReassignment,
        activeSector: activeOcc?.sector,
        activeBaseCode: activeOcc?.baseCode,
    });

    // Handle reassignment as a special case (end source + start target)
    if (parsed.isReassignment || implicitReassignment) {
        return handleTelegramReassignment({ parsed, resolvedDoctor, eventAt, messageText, activeOcc });
    }

    let occupancyId: string | null = null;
    let successKind: "standard" | "departure_adjusted" = "standard";
    let treatedAsContinuation = false;
    let autoReactivated = false;
    let replyTimeAt = eventAt;
    let effectiveShiftType: string | null = parsed.shiftType ?? null;
    if (!parsed.isDeparture && parsed.isContinuation) {
        // Continuation wording must always stay in P mode; keeping SD/SN/null can make
        // the occupancy disappear from shift-scoped board/payment/meal-break panels.
        effectiveShiftType = "P";
    }
    let continuationFrom: string | null = null;
    const isShadowArrival = resolveTelegramShadowFlag(parsed, messageText);

    // When no explicit shift is provided and the arrival time is near a shift boundary,
    // use the message timestamp's shift to disambiguate.
    // Example: arrival 18:55 (technically SD) but message sent 20:06 (SN) → doctor is arriving for SN.
    if (!effectiveShiftType && !parsed.isDeparture) {
        const arrivalShiftWindow = resolveOperationalShiftWindow(eventAt);
        const messageShiftWindow = resolveOperationalShiftWindow(referenceAt);
        if (arrivalShiftWindow.shiftLabel !== messageShiftWindow.shiftLabel) {
            const minutesToBoundary = (arrivalShiftWindow.nextBoundaryAt.getTime() - eventAt.getTime()) / 60000;
            if (minutesToBoundary >= 0 && minutesToBoundary <= 60) {
                effectiveShiftType = messageShiftWindow.shiftLabel;
            }
        }
    }

    if (parsed.sector === "REGULATION") {
        const post = await db.query.regulationPosts.findFirst({
            where: eq(regulationPosts.code, parsed.baseCode as string),
        });
        if (!post) {
            throw new Error("Regulation post not found.");
        }

        if (parsed.isDeparture) {
            const occupancy = await db.query.regulationOccupancies.findFirst({
                where: and(
                    eq(regulationOccupancies.postId, post.id),
                    eq(regulationOccupancies.doctorId, resolvedDoctor.id),
                    isNull(regulationOccupancies.endedAt),
                ),
            });
            if (occupancy) {
                occupancyId = (await endRegulationOccupancy(occupancy.id, {
                    endedAt: eventAt,
                    actualEndedAt: eventAt,
                })).id;
            } else {
                const recentClosed = await findRecentClosedRegulationOccupancy({
                    postId: post.id,
                    doctorId: resolvedDoctor.id,
                    eventAt,
                });
                if (!recentClosed) {
                    throw new Error("No active regulation occupancy found for this doctor/post.");
                }

                if (isHalfShiftRoleLabel(recentClosed.roleLabel)) {
                    const autoEndedAt = recentClosed.endedAt ?? recentClosed.actualEndedAt ?? resolveHalfShiftScheduledEndAt(eventAt);
                    if (eventAt.getTime() >= autoEndedAt.getTime()) {
                        throw new Error(TELEGRAM_HALF_SHIFT_ALREADY_CLOSED_ERROR);
                    }
                }

                const hasHandoff = recentClosed.endedAt
                    ? await hasRegulationDepartureHandoff({
                        postId: post.id,
                        doctorId: resolvedDoctor.id,
                        occupancyId: recentClosed.id,
                        endedAt: recentClosed.endedAt,
                        eventAt,
                    })
                    : false;

                if (
                    requiresTelegramDepartureAdjustmentJustification({
                        domain: "REGULATION",
                        startedAt: recentClosed.startedAt,
                        scheduledEndAt: recentClosed.scheduledEndAt,
                        endedAt: recentClosed.endedAt,
                        eventAt,
                        hasSuccessorOccupancy: hasHandoff,
                    })
                    && !resolveTelegramEligibleLateDepartureReason(messageText, [parsed.baseCode, resolvedDoctor.fullName, parsed.arrivalTime])
                ) {
                    throw new Error("Justificativa obrigatoria para ajustar saida apos 07:15/19:15. So aceito ocorrencia ou higienizacao para credito automatico.");
                }

                occupancyId = (await correctRegulationOccupancy(recentClosed.id, {
                    actualEndedAt: eventAt,
                    notes: appendTelegramOperationalNote(recentClosed.notes, "telegram saida ajustada", messageText),
                }, null)).id;
                successKind = "departure_adjusted";
            }
        } else {
            const activeOccupancy = await db.query.regulationOccupancies.findFirst({
                where: and(
                    eq(regulationOccupancies.postId, post.id),
                    eq(regulationOccupancies.doctorId, resolvedDoctor.id),
                    isNull(regulationOccupancies.endedAt),
                ),
                orderBy: [desc(regulationOccupancies.boardStartedAt), desc(regulationOccupancies.startedAt)],
            });

            // When the message carries an explicit continuation intent (e.g. "continua 2153"),
            // never treat the existing active P-shift as stale: the operator/chief is confirming
            // continuity and we must update the existing occupancy in place instead of closing
            // it and opening a new one (which would shift started_at to eventAt and break
            // downstream displays — board, meal break panel, shift report, reminders).
            const shouldReopenStaleContinuation = !parsed.isContinuation && shouldReopenStaleTelegramRegulationContinuation({
                activeShiftLabel: activeOccupancy?.shiftLabel,
                activeStartedAt: activeOccupancy?.startedAt,
                eventAt,
            });

            const shouldContinueActiveOccupancy = Boolean(activeOccupancy) && !shouldReopenStaleContinuation && shouldTreatTelegramArrivalAsContinuation({
                sector: parsed.sector,
                isDeparture: parsed.isDeparture,
                isContinuation: parsed.isContinuation,
                incomingShiftLabel: parsed.shiftType,
                activeShiftLabel: activeOccupancy?.shiftLabel,
            });

            if (shouldContinueActiveOccupancy && activeOccupancy) {
                occupancyId = (await continueRegulationOccupancy(activeOccupancy.id, {
                    notes: messageText,
                    continuedAt: eventAt.getTime() > referenceAt.getTime() ? referenceAt : eventAt,
                }, null)).id;
                treatedAsContinuation = true;
                replyTimeAt = activeOccupancy.startedAt;
                effectiveShiftType = "P";
            } else {
                const assumedHalfShift = shouldAssumeTelegramHalfShift({
                    parsed,
                    eventAt,
                    effectiveShiftType,
                });
                const halfShiftScheduledEndAt = assumedHalfShift ? resolveHalfShiftScheduledEndAt(eventAt) : null;
                const continuityContext = parsed.isDeparture
                    ? null
                    : await findTelegramContinuityContext({ doctorId: resolvedDoctor.id, eventAt });
                const sourceShiftLabelForLink = continuityContext?.source
                    ? (continuityContext.source.shiftLabel
                        ?? resolveOperationalShiftWindow(continuityContext.source.boardStartedAt ?? continuityContext.source.startedAt).shiftLabel)
                    : undefined;
                const inferredCrossShiftContinuation = Boolean(
                    continuityContext?.source
                    && !parsed.shiftType
                    && !parsed.isContinuation
                    && sourceShiftLabelForLink
                    && sourceShiftLabelForLink !== resolveOperationalShiftWindow(eventAt).shiftLabel,
                );
                const shouldUseContinuityContext = Boolean(
                    continuityContext?.source
                    && (
                        shouldLinkTelegramArrivalToContinuitySource({
                            parsed,
                            sourceShiftLabel: sourceShiftLabelForLink,
                        })
                        || inferredCrossShiftContinuation
                    ),
                );

                if (shouldUseContinuityContext) {
                    await closeTelegramActiveContinuityOccupancies({
                        doctorId: resolvedDoctor.id,
                        eventAt,
                        excludeOccupancyId: activeOccupancy?.id ?? null,
                    });

                    const sourceCode = activeOcc?.baseCode ?? await resolveTelegramContinuitySourceCode(continuityContext?.source);
                    if (sourceCode && sourceCode !== parsed.baseCode) {
                        continuationFrom = sourceCode;
                    }
                }

                const continuationStartedAt = shouldUseContinuityContext
                    ? resolveTelegramContinuationStartedAt({
                        eventAt,
                        shiftType: parsed.shiftType,
                        continuityStartedAt: continuityContext?.continuityStartedAt,
                        sourceStartedAt: continuityContext?.source?.startedAt,
                    })
                    : eventAt;
                const continuationBoardStartedAt = shouldUseContinuityContext && continuityContext?.source
                    ? new Date(continuityContext.continuityStartedAt ?? continuityContext.source.startedAt)
                    : undefined;

                // Any continuity link means the doctor is crossing from a previous shift
                // occupation into this one — the effective shift is always P (24h coverage).
                // This covers: SD→SN, P→SN, null→SN, SN→SD, and any other cross-shift combination.
                if (shouldUseContinuityContext && continuityContext?.source) {
                    effectiveShiftType = "P";
                }

                // When the continuity anchor is from a previous P-shift window that has
                // already expired (e.g. cross-domain CZ50 SN 21:53 → 2153 SD at 08:00),
                // shouldKeepRegulationOccupancyVisible would hide the new occupancy immediately.
                // In that case anchor startedAt to eventAt so the occupancy is visible.
                // boardStartedAt keeps the historical anchor for priority ordering.
                const crossShiftExpiry = shouldUseContinuityContext
                    ? resolveProlongedShiftExpiry(continuationStartedAt, "P")
                    : null;
                const effectiveContinuationStartedAt = crossShiftExpiry && crossShiftExpiry.getTime() <= eventAt.getTime()
                    ? eventAt
                    : continuationStartedAt;

                const regResult = await startRegulationOccupancy({
                    doctorId: resolvedDoctor.id,
                    postId: post.id,
                    continuityGroupId: shouldUseContinuityContext ? continuityContext?.source?.continuityGroupId ?? null : null,
                    startedAt: effectiveContinuationStartedAt,
                    boardStartedAt: continuationBoardStartedAt,
                    scheduledStartAt: assumedHalfShift ? eventAt : undefined,
                    scheduledEndAt: halfShiftScheduledEndAt ?? undefined,
                    shiftLabel: effectiveShiftType,
                    roleLabel: assumedHalfShift ? HALF_SHIFT_ROLE_LABEL : parsed.roleFunction,
                    ramalLabel: parsed.baseCode,
                    source: "telegram",
                    notes: messageText,
                    createdByUserId: null,
                });
                occupancyId = regResult.id;
                if (regResult.autoReactivated) autoReactivated = true;

                if (shouldUseContinuityContext && continuityContext?.source) {
                    treatedAsContinuation = true;
                    replyTimeAt = continuityContext.continuityStartedAt ?? continuityContext.source.startedAt;
                    await syncBankHoursByContinuityGroup(db, continuityContext.source.continuityGroupId);
                }
            }
        }
    } else {
        const base = await db.query.interventionBases.findFirst({
            where: eq(interventionBases.code, parsed.baseCode as string),
        });
        if (!base) {
            throw new Error("Intervention base not found.");
        }

        if (parsed.isDeparture) {
            const occupancy = await db.query.interventionOccupancies.findFirst({
                where: and(
                    eq(interventionOccupancies.baseId, base.id),
                    eq(interventionOccupancies.doctorId, resolvedDoctor.id),
                    isNull(interventionOccupancies.endedAt),
                ),
            });
            if (occupancy) {
                occupancyId = (await endInterventionOccupancy(occupancy.id, {
                    endedAt: eventAt,
                    actualEndedAt: eventAt,
                })).id;
            } else {
                const recentClosed = await findRecentClosedInterventionOccupancy({
                    baseId: base.id,
                    doctorId: resolvedDoctor.id,
                    eventAt,
                });
                if (!recentClosed) {
                    throw new Error("No active intervention occupancy found for this doctor/base.");
                }

                if (
                    requiresTelegramDepartureAdjustmentJustification({
                        domain: "INTERVENTION",
                        startedAt: recentClosed.startedAt,
                        scheduledEndAt: recentClosed.scheduledEndAt,
                        endedAt: recentClosed.endedAt,
                        eventAt,
                        hasSuccessorOccupancy: recentClosed.endedAt
                            ? await hasInterventionDepartureHandoff({
                                baseId: base.id,
                                doctorId: resolvedDoctor.id,
                                occupancyId: recentClosed.id,
                                endedAt: recentClosed.endedAt,
                                eventAt,
                            })
                            : false,
                    })
                    && !resolveTelegramEligibleLateDepartureReason(messageText, [parsed.baseCode, resolvedDoctor.fullName, parsed.arrivalTime])
                ) {
                    throw new Error("Justificativa obrigatoria para ajustar saida apos 07:15/19:15. So aceito ocorrencia ou higienizacao para credito automatico.");
                }

                occupancyId = (await correctInterventionOccupancy(recentClosed.id, {
                    actualEndedAt: eventAt,
                    notes: appendTelegramOperationalNote(recentClosed.notes, "telegram saida ajustada", messageText),
                }, null)).id;
                successKind = "departure_adjusted";
            }
        } else {
            const activeOccupancy = await db.query.interventionOccupancies.findFirst({
                where: and(
                    eq(interventionOccupancies.baseId, base.id),
                    eq(interventionOccupancies.doctorId, resolvedDoctor.id),
                    isNull(interventionOccupancies.endedAt),
                ),
                orderBy: [desc(interventionOccupancies.boardStartedAt), desc(interventionOccupancies.startedAt)],
            });

            // Mirror the regulation guard: explicit "continua" intent forces continuation of the
            // existing P occupancy instead of opening a new one with eventAt as started_at.
            const shouldReopenStaleContinuation = !parsed.isContinuation && shouldReopenStaleTelegramInterventionContinuation({
                activeShiftLabel: activeOccupancy?.shiftLabel,
                activeStartedAt: activeOccupancy?.startedAt,
                eventAt,
            });

            const shouldContinueActiveOccupancy = Boolean(activeOccupancy) && !shouldReopenStaleContinuation && shouldTreatTelegramArrivalAsContinuation({
                sector: parsed.sector,
                isDeparture: parsed.isDeparture,
                isContinuation: parsed.isContinuation,
                incomingShiftLabel: parsed.shiftType,
                activeShiftLabel: activeOccupancy?.shiftLabel,
            });

            if (shouldContinueActiveOccupancy && activeOccupancy) {
                if (
                    requiresOvertimeJustification(activeOccupancy.startedAt, eventAt)
                    && !hasTelegramOperationalJustification(messageText, [parsed.baseCode, resolvedDoctor.fullName, parsed.arrivalTime, parsed.shiftType])
                ) {
                    throw new Error("Justificativa obrigatoria para liberar continuidade apos 07:15 ou 19:15. Inclua motivo por escrito na mensagem.");
                }

                occupancyId = (await continueInterventionOccupancy(activeOccupancy.id, {
                    notes: messageText,
                    continuedAt: eventAt.getTime() > referenceAt.getTime() ? referenceAt : eventAt,
                }, null)).id;
                treatedAsContinuation = true;
                replyTimeAt = activeOccupancy.startedAt;
                effectiveShiftType = "P";
            } else {
                const continuityContext = parsed.isDeparture
                    ? null
                    : await findTelegramContinuityContext({ doctorId: resolvedDoctor.id, eventAt });
                const sourceShiftLabelForLink = continuityContext?.source
                    ? (continuityContext.source.shiftLabel
                        ?? resolveOperationalShiftWindow(continuityContext.source.boardStartedAt ?? continuityContext.source.startedAt).shiftLabel)
                    : undefined;
                const inferredCrossShiftContinuation = Boolean(
                    continuityContext?.source
                    && !parsed.shiftType
                    && !parsed.isContinuation
                    && sourceShiftLabelForLink
                    && sourceShiftLabelForLink !== resolveOperationalShiftWindow(eventAt).shiftLabel,
                );
                const shouldUseContinuityContext = Boolean(
                    continuityContext?.source
                    && (
                        shouldLinkTelegramArrivalToContinuitySource({
                            parsed,
                            sourceShiftLabel: sourceShiftLabelForLink,
                        })
                        || inferredCrossShiftContinuation
                    ),
                );

                if (shouldUseContinuityContext) {
                    await closeTelegramActiveContinuityOccupancies({
                        doctorId: resolvedDoctor.id,
                        eventAt,
                        excludeOccupancyId: activeOccupancy?.id ?? null,
                    });

                    const sourceCode = activeOcc?.baseCode ?? await resolveTelegramContinuitySourceCode(continuityContext?.source);
                    if (sourceCode && sourceCode !== parsed.baseCode) {
                        continuationFrom = sourceCode;
                    }
                }

                const continuationStartedAt = shouldUseContinuityContext
                    ? resolveTelegramContinuationStartedAt({
                        eventAt,
                        shiftType: parsed.shiftType,
                        continuityStartedAt: continuityContext?.continuityStartedAt,
                        sourceStartedAt: continuityContext?.source?.startedAt,
                    })
                    : eventAt;
                const continuationBoardStartedAtIntv = shouldUseContinuityContext && continuityContext?.source
                    ? new Date(continuityContext.continuityStartedAt ?? continuityContext.source.startedAt)
                    : undefined;

                // Any continuity link means the doctor is crossing from a previous shift
                // occupation into this one — the effective shift is always P (24h coverage).
                if (shouldUseContinuityContext && continuityContext?.source) {
                    effectiveShiftType = "P";
                }

                // Same guard as the regulation branch: if the continuity anchor is from an
                // already-expired P-shift window, anchor startedAt to eventAt so the occupancy
                // is not treated as stale on arrival. boardStartedAt keeps the historical anchor.
                const crossShiftExpiryIntv = shouldUseContinuityContext
                    ? resolveProlongedShiftExpiry(continuationStartedAt, "P")
                    : null;
                const effectiveContinuationStartedAtIntv = crossShiftExpiryIntv && crossShiftExpiryIntv.getTime() <= eventAt.getTime()
                    ? eventAt
                    : continuationStartedAt;

                const intResult = await startInterventionOccupancy({
                    doctorId: resolvedDoctor.id,
                    baseId: base.id,
                    continuityGroupId: shouldUseContinuityContext ? continuityContext?.source?.continuityGroupId ?? null : null,
                    startedAt: effectiveContinuationStartedAtIntv,
                    boardStartedAt: continuationBoardStartedAtIntv,
                    shiftLabel: effectiveShiftType,
                    roleLabel: parsed.roleFunction,
                    isShadow: isShadowArrival,
                    source: "telegram",
                    notes: isShadowArrival
                        ? appendTelegramOperationalNote(null, "telegram sombra", messageText)
                        : messageText,
                    createdByUserId: null,
                });
                occupancyId = intResult.id;
                if (intResult.autoReactivated) autoReactivated = true;

                if (shouldUseContinuityContext && continuityContext?.source) {
                    treatedAsContinuation = true;
                    replyTimeAt = continuityContext.continuityStartedAt ?? continuityContext.source.startedAt;
                    await syncBankHoursByContinuityGroup(db, continuityContext.source.continuityGroupId);
                }
            }
        }
    }

    const assumedHalfShift = shouldAssumeTelegramHalfShift({
        parsed,
        eventAt,
        effectiveShiftType,
    }) && parsed.sector === "REGULATION" && !parsed.isDeparture;

    return {
        occupancyId,
        successKind,
        treatedAsContinuation,
        replyTimeAt,
        autoReactivated,
        effectiveShiftType,
        reassignedFrom: null as string | null,
        assumedHalfShift,
        continuationFrom,
    };
}

async function sendSuccessReply(
    chatId: number,
    replyToMessageId: number,
    seed: number,
    parsed: OperationalParsedEntry,
    doctorName: string,
    eventAt: Date,
    successKind: "standard" | "departure_adjusted" = "standard",
    approximateMatchHint = "",
    forceContinuation = false,
    replyTimeAt?: Date,
    autoReactivated = false,
    effectiveShiftType?: string | null,
    reassignedFrom?: string | null,
    assumedHalfShift = false,
    continuationFrom?: string | null,
) {
    const time = (replyTimeAt ?? eventAt).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "America/Sao_Paulo" });
    const replyKind = resolveTelegramSuccessReplyKind({
        parsed,
        successKind,
        forceContinuation,
        forceReassignment: Boolean(reassignedFrom),
        forceHalfShift: assumedHalfShift,
    });
    const text = pickTelegramReply(
        replyKind,
        seed,
        {
            name: doctorName,
            target: parsed.baseCode ?? "plantao",
            time,
        },
    );

    let timeContextHint = "";
    if (reassignedFrom) {
        timeContextHint = `\n\n⏱ Mantido o horário original de chegada em *${time}* para banco de horas e prioridades.`;
    } else if (replyKind === "continuation_recorded" || forceContinuation) {
        timeContextHint = `\n\n🔗 Continuação detectada — computado desde *${time}* (turno anterior), sem atraso.`;
    } else if (replyKind === "arrival_recorded" || replyKind === "arrival_p_recorded") {
        // Resolve the TARGET shift, not the clock-based current shift.
        // Pre-shift windows: 05:00–06:59 → target SD; 17:00–18:59 → target SN.
        // Explicit shiftType from the parser always overrides clock inference.
        const clockShiftWindow = resolveOperationalShiftWindow(eventAt);
        const eventParts = getSaoPauloParts(eventAt);
        const isTargetSN = parsed.shiftType === "SN"
            || (parsed.shiftType !== "SD" && eventParts.hour >= 17 && eventParts.hour < 19);
        const isTargetSD = parsed.shiftType === "SD"
            || (parsed.shiftType !== "SN" && eventParts.hour >= 5 && eventParts.hour < 7);
        let targetShiftWindow = clockShiftWindow;
        if (isTargetSN && clockShiftWindow.shiftLabel === "SD") {
            targetShiftWindow = resolveOperationalShiftWindow(clockShiftWindow.nextBoundaryAt);
        } else if (isTargetSD && clockShiftWindow.shiftLabel === "SN") {
            targetShiftWindow = resolveOperationalShiftWindow(clockShiftWindow.nextBoundaryAt);
        }

        const shiftStartTime = targetShiftWindow.startedAt.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "America/Sao_Paulo" });
        const delayMs = eventAt.getTime() - targetShiftWindow.startedAt.getTime();
        const delayMin = Math.round(delayMs / 60000);
        if (delayMin < 0) {
            // Arrived BEFORE the target shift start — early arrival, no delay hint needed
            timeContextHint = `\n\n⏱ Registrado às *${time}* — ${Math.abs(delayMin)}min antes do início do turno ${targetShiftWindow.shiftLabel} (${shiftStartTime}).`;
        } else if (delayMin > 0) {
            const target = parsed.baseCode ?? "RAMAL/BASE";
            timeContextHint = `\n\n⏱ Registrado às *${time}* — ${delayMin}min após o início do turno (${shiftStartTime}).`
                + `\nSe está *continuando* do turno anterior, corrija:`
                + `\n_${doctorName} continuando ${target}_`;
        }
    }

    const resolvedShift = effectiveShiftType ?? parsed.shiftType;
    const shiftHint = resolvedShift
        ? `\n📋 Turno: *${resolvedShift === "SD" ? "SD (diurno)" : resolvedShift === "SN" ? "SN (noturno)" : "P (plantao 24h)"}*`
        : "";

    const halfShiftHint = assumedHalfShift
        ? "\n\n🟠 Tipo de cobertura: *Meio Plantao da Tarde* (ate 17:00)."
        : "";

    const reactivationHint = autoReactivated
        ? `\n\n🔄 ${parsed.sector === "REGULATION" ? "Ramal" : "Base"} *${parsed.baseCode}* estava desativad${parsed.sector === "REGULATION" ? "o" : "a"} — reativad${parsed.sector === "REGULATION" ? "o" : "a"} automaticamente com a chegada.`
        : "";

    const reassignmentHint = reassignedFrom
        ? `\n\n🔀 Remanejado de *${reassignedFrom}* para *${parsed.baseCode}*. Ocupação anterior encerrada.`
        : "";

    const continuationTargetHint = buildTelegramContinuationSourceHint({
        continuationFrom,
        targetCode: parsed.baseCode,
        isContinuationReply: replyKind === "continuation_recorded" || forceContinuation,
    });

    const arrivalHint = (replyKind === "arrival_recorded" || replyKind === "arrival_p_recorded") && !timeContextHint && !autoReactivated
        ? "\n\n💡 Se for o mesmo médico mudando de ramal/base, pode mandar só o novo destino que registro como remanejamento sem mexer na chegada original."
        : "";
    const shadowHint = parsed.isShadow && !parsed.isDeparture
        ? "\n\n🫥 Cobertura marcada como *sombra*. Titular atual mantido no quadro."
        : "";
    await sendMessage(chatId, `${text}${approximateMatchHint}${shiftHint}${halfShiftHint}${reactivationHint}${reassignmentHint}${continuationTargetHint}${timeContextHint}${shadowHint}${arrivalHint}`, replyToMessageId);
}

function formatTelegramReplyTime(value: Date) {
    return value.toLocaleTimeString("pt-BR", {
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
        timeZone: "America/Sao_Paulo",
    });
}

export function hasTelegramOperationalJustification(text: string, fragments: Array<string | null | undefined>) {
    const normalized = normalizeTelegramReasonText(text);
    const reduced = stripTelegramOperationalFragments(text, fragments);

    const meaningfulTokens = reduced
        .split(/\s+/)
        .map((token) => token.trim())
        .filter((token) => token.length >= 3);

    return meaningfulTokens.length >= 2 || /MOTIVO/i.test(normalized);
}

async function tryHandlePendingNameSelection(update: TelegramUpdate, logId: string) {
    const message = update.message;
    if (!message?.text || !message.from?.id) {
        return null;
    }

    const pending = await findPendingNameSelection(String(message.chat.id), String(message.from.id));
    if (!pending || !isPendingResolutionData(pending.resolutionData)) {
        return null;
    }

    const replyCandidates = pending.resolutionData.candidates.map((candidate) => ({
        ...candidate,
        score: 0,
    }));

    if (shouldDeferPendingNameSelectionToFreshParsing(message.text, replyCandidates)) {
        return null;
    }

    let selected = pickCandidateFromReply(message.text, replyCandidates);

    if (!selected) {
        const directory = await listDirectoryEntries();
        const refreshedCandidates = resolveDoctorCandidates(message.text, directory as TelegramDoctorDirectoryEntry[]);
        if (refreshedCandidates.length > 0) {
            if (refreshedCandidates.length === 1 || (refreshedCandidates[0].score >= (refreshedCandidates[1]?.score ?? 0) + 40)) {
                selected = refreshedCandidates[0];
            } else {
                await markTelegramProcessed(pending.id, {
                    status: "superseded",
                    errorMessage: "pending_name_selection_replaced",
                });
                await queuePendingNameSelection(
                    logId,
                    message,
                    pending.resolutionData.parsed,
                    null,
                    new Date(pending.resolutionData.originalReferenceAt ?? pending.resolutionData.originalEventAt),
                    new Date(pending.resolutionData.originalEventAt),
                    refreshedCandidates,
                );
                return { ok: true, ignored: true, pending: true };
            }
        }
    }

    if (!selected) {
        const directory = await listDirectoryEntries();
        const nearbyCandidates = resolveDoctorCandidates(message.text, directory as TelegramDoctorDirectoryEntry[], 3);

        if (isCasualTelegramMessage(message.text)) {
            await markTelegramProcessed(logId, {
                status: "ignored",
                errorMessage: "casual_smalltalk_pending",
                resolutionData: { casual: true, pendingSelectionKept: true },
            });
            await sendMessage(
                message.chat.id,
                pickTelegramReply("casual_smalltalk", message.message_id, {}),
                message.message_id,
            );
            return { ok: true, ignored: true, pending: true };
        }

        await sendMessage(
            message.chat.id,
            buildNameUnresolvedReply(message.message_id, nearbyCandidates),
            message.message_id,
        );
        await markTelegramProcessed(logId, {
            status: "ignored",
            errorMessage: "pending_name_selection_unresolved",
        });
        return { ok: true, ignored: true };
    }

    try {
        const result = await applyParsedEntry({
            parsed: pending.resolutionData.parsed,
            resolvedDoctor: { id: selected.id, fullName: selected.fullName, displayName: selected.displayName ?? null },
            eventAt: new Date(pending.resolutionData.originalEventAt),
            referenceAt: new Date(pending.resolutionData.originalReferenceAt ?? pending.resolutionData.originalEventAt),
            messageText: pending.resolutionData.originalText,
        });

        await supersedePendingDepartureJustification(String(message.chat.id), String(message.from.id));

        await markTelegramProcessed(pending.id, {
            status: "accepted",
            parsedDoctorName: selected.fullName,
            relatedOccupancyId: result.occupancyId,
            errorMessage: null,
        });
        await markTelegramProcessed(logId, {
            status: "accepted",
            parsedDomain: pending.resolutionData.parsed.sector,
            parsedTargetCode: pending.resolutionData.parsed.baseCode,
            parsedAction: resolveTelegramParsedAction(pending.resolutionData.parsed),
            parsedDoctorName: selected.fullName,
            relatedOccupancyId: result.occupancyId,
            errorMessage: null,
            resolutionData: {
                continuationMode: resolveTelegramContinuationMode(pending.resolutionData.parsed),
            },
        });
        await sendSuccessReply(
            message.chat.id,
            message.message_id,
            message.message_id,
            pending.resolutionData.parsed,
            resolveTelegramDoctorSurfaceName(selected),
            new Date(pending.resolutionData.originalEventAt),
            result.successKind,
            "",
            result.treatedAsContinuation,
            result.replyTimeAt,
            result.autoReactivated,
            result.effectiveShiftType,
            result.reassignedFrom,
            result.assumedHalfShift,
            result.continuationFrom,
        );
        return { ok: true, occupancyId: result.occupancyId };
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : "telegram_processing_failed";
        if (isTelegramJustificationRequiredError(errorMessage)) {
            await markTelegramProcessed(pending.id, {
                status: "superseded",
                errorMessage: "pending_name_selection_resolved_to_departure_justification",
            });
            await queuePendingDepartureJustification({
                logId,
                message,
                parsed: pending.resolutionData.parsed,
                resolvedDoctor: { id: selected.id, fullName: selected.fullName, displayName: selected.displayName ?? null },
                eventAt: new Date(pending.resolutionData.originalEventAt),
                referenceAt: new Date(pending.resolutionData.originalReferenceAt ?? pending.resolutionData.originalEventAt),
                originalText: pending.resolutionData.originalText,
            });
            return { ok: true, ignored: true, pending: true };
        }

        await markTelegramProcessed(logId, {
            status: "error",
            parsedDomain: pending.resolutionData.parsed.sector,
            parsedTargetCode: pending.resolutionData.parsed.baseCode,
            parsedAction: resolveTelegramParsedAction(pending.resolutionData.parsed),
            parsedDoctorName: selected.fullName,
            errorMessage,
            resolutionData: {
                continuationMode: resolveTelegramContinuationMode(pending.resolutionData.parsed),
            },
        });
        await sendTelegramDepartureFailureReply({
            chatId: message.chat.id,
            replyToMessageId: message.message_id,
            seed: message.message_id,
            parsed: pending.resolutionData.parsed,
            doctorName: selected.fullName,
            errorMessage,
        });
        await sendTelegramArrivalFailureReply({
            chatId: message.chat.id,
            replyToMessageId: message.message_id,
            parsed: pending.resolutionData.parsed,
            errorMessage,
        });
        return { ok: true, ignored: true, processingError: true };
    }
}

async function tryHandlePendingDepartureJustification(update: TelegramUpdate, logId: string) {
    const message = update.message;
    if (!message?.text || !message.from?.id) {
        return null;
    }

    const pending = await findPendingDepartureJustification(String(message.chat.id), String(message.from.id));
    if (!pending || !isPendingDepartureJustificationData(pending.resolutionData)) {
        return null;
    }

    const pendingAttemptCount = getPendingDepartureJustificationAttemptCount(pending.resolutionData);
    const promptKind = resolveDepartureJustificationPromptKind(pendingAttemptCount);
    const replyTime = pending.resolutionData.parsed.arrivalTime ?? formatTelegramReplyTime(new Date(pending.resolutionData.originalEventAt));
    const replyExample = buildTelegramDepartureExample({
        doctorName: pending.resolutionData.resolvedDoctor.fullName,
        target: pending.resolutionData.parsed.baseCode,
        time: replyTime,
    });

    if (shouldDeferPendingDepartureJustificationToFreshParsing(message.text)) {
        await markTelegramProcessed(pending.id, {
            status: "superseded",
            errorMessage: "departure_justification_deferred_to_fresh_parsing",
        });
        return null;
    }

    if (isBatchCancelKeyword(message.text)) {
        await markTelegramProcessed(pending.id, {
            status: "ignored",
            errorMessage: "departure_justification_cancelled",
        });
        await markTelegramProcessed(logId, {
            status: "accepted",
            parsedDomain: pending.resolutionData.parsed.sector,
            parsedTargetCode: pending.resolutionData.parsed.baseCode,
            parsedAction: "departure_justification_cancelled",
            parsedDoctorName: pending.resolutionData.resolvedDoctor.fullName,
            errorMessage: null,
        });
        await sendMessage(
            message.chat.id,
            `⚠️ Cancelado por aqui. A saida de ${pending.resolutionData.resolvedDoctor.fullName} em ${pending.resolutionData.parsed.baseCode} continua sem justificativa salva. Se precisar, reenvie a saida completa depois.`,
            message.message_id,
        );
        return { ok: true, ignored: true };
    }

    if (isCasualTelegramMessage(message.text)) {
        await markTelegramProcessed(logId, {
            status: "ignored",
            parsedDomain: pending.resolutionData.parsed.sector,
            parsedTargetCode: pending.resolutionData.parsed.baseCode,
            parsedAction: "departure_justification_pending",
            parsedDoctorName: pending.resolutionData.resolvedDoctor.fullName,
            errorMessage: "departure_justification_pending",
            resolutionData: { pendingJustificationKept: true },
        });
        await sendMessage(
            message.chat.id,
            pickTelegramReply(promptKind, message.message_id, {
                name: pending.resolutionData.resolvedDoctor.fullName,
                target: pending.resolutionData.parsed.baseCode,
                time: replyTime,
                example: replyExample,
            }),
            message.message_id,
        );
        return { ok: true, ignored: true, pending: true };
    }

    const eligibleReason = resolveTelegramEligibleLateDepartureReason(message.text);
    if (!eligibleReason) {
        if (pendingAttemptCount < 1) {
            await markTelegramProcessed(pending.id, {
                resolutionData: buildResolutionData(pending.resolutionData, {
                    invalidJustificationAttempts: pendingAttemptCount + 1,
                    latestInvalidJustificationReplyText: message.text,
                }),
            });
            await markTelegramProcessed(logId, {
                status: "ignored",
                parsedDomain: pending.resolutionData.parsed.sector,
                parsedTargetCode: pending.resolutionData.parsed.baseCode,
                parsedAction: "departure_justification_pending",
                parsedDoctorName: pending.resolutionData.resolvedDoctor.fullName,
                errorMessage: "departure_justification_invalid_retry",
                resolutionData: {
                    pendingJustificationKept: true,
                    invalidJustificationAttempts: pendingAttemptCount + 1,
                },
            });
            await sendMessage(
                message.chat.id,
                pickTelegramReply("departure_justification_retry", message.message_id, {
                    name: pending.resolutionData.resolvedDoctor.fullName,
                    target: pending.resolutionData.parsed.baseCode,
                    time: replyTime,
                    example: replyExample,
                }),
                message.message_id,
            );
            return { ok: true, ignored: true, pending: true };
        }

        const eventAt = new Date(pending.resolutionData.originalEventAt);
        const mergedText = buildTelegramJustificationFollowUpText(
            pending.resolutionData.originalText,
            message.text,
        );

        try {
            let relatedOccupancyId: string;
            if (pending.resolutionData.parsed.sector === "REGULATION") {
                const post = await getDb().query.regulationPosts.findFirst({
                    where: eq(regulationPosts.code, pending.resolutionData.parsed.baseCode),
                });
                if (!post) {
                    throw new Error("Regulation post not found.");
                }

                const recentClosed = await findRecentClosedRegulationOccupancy({
                    postId: post.id,
                    doctorId: pending.resolutionData.resolvedDoctor.id,
                    eventAt,
                });
                if (!recentClosed) {
                    throw new Error("No active regulation occupancy found for this doctor/post.");
                }

                relatedOccupancyId = (await correctRegulationOccupancy(recentClosed.id, {
                    notes: appendTelegramOperationalNote(recentClosed.notes, "telegram saida sem credito automatico", mergedText),
                }, null)).id;
            } else {
                const base = await getDb().query.interventionBases.findFirst({
                    where: eq(interventionBases.code, pending.resolutionData.parsed.baseCode),
                });
                if (!base) {
                    throw new Error("Intervention base not found.");
                }

                const recentClosed = await findRecentClosedInterventionOccupancy({
                    baseId: base.id,
                    doctorId: pending.resolutionData.resolvedDoctor.id,
                    eventAt,
                });
                if (!recentClosed) {
                    throw new Error("No active intervention occupancy found for this doctor/base.");
                }

                relatedOccupancyId = (await correctInterventionOccupancy(recentClosed.id, {
                    notes: appendTelegramOperationalNote(recentClosed.notes, "telegram saida sem credito automatico", mergedText),
                }, null)).id;
            }

            await markTelegramProcessed(pending.id, {
                status: "accepted",
                relatedOccupancyId,
                errorMessage: null,
                resolutionData: buildResolutionData(pending.resolutionData, {
                    invalidJustificationAttempts: pendingAttemptCount + 1,
                    finalJustificationReplyText: message.text,
                    automaticCreditGranted: false,
                    manualReviewOnly: true,
                }),
            });
            await markTelegramProcessed(logId, {
                status: "accepted",
                parsedDomain: pending.resolutionData.parsed.sector,
                parsedTargetCode: pending.resolutionData.parsed.baseCode,
                parsedAction: "departure_justification_manual_review",
                parsedDoctorName: pending.resolutionData.resolvedDoctor.fullName,
                relatedOccupancyId,
                errorMessage: null,
                resolutionData: {
                    justificationFromPending: true,
                    automaticCreditGranted: false,
                    manualReviewOnly: true,
                },
            });
            await sendMessage(
                message.chat.id,
                pickTelegramReply("departure_justification_manual_review", message.message_id, {
                    name: pending.resolutionData.resolvedDoctor.fullName,
                    target: pending.resolutionData.parsed.baseCode,
                    time: formatTelegramReplyTime(eventAt),
                }),
                message.message_id,
            );
            return { ok: true, occupancyId: relatedOccupancyId };
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : "telegram_processing_failed";
            await markTelegramProcessed(pending.id, {
                status: "error",
                errorMessage,
            });
            await markTelegramProcessed(logId, {
                status: "error",
                parsedDomain: pending.resolutionData.parsed.sector,
                parsedTargetCode: pending.resolutionData.parsed.baseCode,
                parsedAction: "departure_justification_manual_review",
                parsedDoctorName: pending.resolutionData.resolvedDoctor.fullName,
                errorMessage,
                resolutionData: {
                    justificationFromPending: true,
                    automaticCreditGranted: false,
                    manualReviewOnly: true,
                },
            });
            await sendTelegramDepartureFailureReply({
                chatId: message.chat.id,
                replyToMessageId: message.message_id,
                seed: message.message_id,
                parsed: pending.resolutionData.parsed,
                doctorName: pending.resolutionData.resolvedDoctor.fullName,
                errorMessage,
            });
            return { ok: true, ignored: true, processingError: true };
        }
    }

    const mergedText = buildTelegramJustificationFollowUpText(
        pending.resolutionData.originalText,
        message.text,
    );

    // Only occurrence/hygienization grant automatic bank-hour credit.
    // Other accepted reasons (chefia/handoff) stop the loop but stay manual-review only.
    if (eligibleReason.code !== "occurrence" && eligibleReason.code !== "hygienization") {
        const eventAt = new Date(pending.resolutionData.originalEventAt);
        try {
            let relatedOccupancyId: string;
            if (pending.resolutionData.parsed.sector === "REGULATION") {
                const post = await getDb().query.regulationPosts.findFirst({
                    where: eq(regulationPosts.code, pending.resolutionData.parsed.baseCode),
                });
                if (!post) throw new Error("Regulation post not found.");
                const recentClosed = await findRecentClosedRegulationOccupancy({
                    postId: post.id,
                    doctorId: pending.resolutionData.resolvedDoctor.id,
                    eventAt,
                });
                if (!recentClosed) throw new Error("No active regulation occupancy found for this doctor/post.");
                relatedOccupancyId = (await correctRegulationOccupancy(recentClosed.id, {
                    notes: appendTelegramOperationalNote(recentClosed.notes, "telegram saida liberada pela chefia", mergedText),
                }, null)).id;
            } else {
                const base = await getDb().query.interventionBases.findFirst({
                    where: eq(interventionBases.code, pending.resolutionData.parsed.baseCode),
                });
                if (!base) throw new Error("Intervention base not found.");
                const recentClosed = await findRecentClosedInterventionOccupancy({
                    baseId: base.id,
                    doctorId: pending.resolutionData.resolvedDoctor.id,
                    eventAt,
                });
                if (!recentClosed) throw new Error("No active intervention occupancy found for this doctor/base.");
                relatedOccupancyId = (await correctInterventionOccupancy(recentClosed.id, {
                    notes: appendTelegramOperationalNote(recentClosed.notes, "telegram saida liberada pela chefia", mergedText),
                }, null)).id;
            }
            await markTelegramProcessed(pending.id, {
                status: "accepted",
                relatedOccupancyId,
                errorMessage: null,
                resolutionData: buildResolutionData(pending.resolutionData, {
                    justificationReplyText: message.text,
                    matchedReasonCode: eligibleReason.code,
                    automaticCreditGranted: false,
                    manualReviewOnly: true,
                }),
            });
            await markTelegramProcessed(logId, {
                status: "accepted",
                parsedDomain: pending.resolutionData.parsed.sector,
                parsedTargetCode: pending.resolutionData.parsed.baseCode,
                parsedAction: "departure_justification_manual_review",
                parsedDoctorName: pending.resolutionData.resolvedDoctor.fullName,
                relatedOccupancyId,
                errorMessage: null,
                resolutionData: { justificationFromPending: true, automaticCreditGranted: false, manualReviewOnly: true },
            });
            await sendMessage(
                message.chat.id,
                pickTelegramReply("departure_justification_manual_review", message.message_id, {
                    name: pending.resolutionData.resolvedDoctor.fullName,
                    target: pending.resolutionData.parsed.baseCode,
                    time: formatTelegramReplyTime(eventAt),
                }),
                message.message_id,
            );
            return { ok: true, occupancyId: relatedOccupancyId };
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : "telegram_processing_failed";
            await markTelegramProcessed(pending.id, { status: "error", errorMessage });
            await markTelegramProcessed(logId, {
                status: "error",
                parsedDomain: pending.resolutionData.parsed.sector,
                parsedTargetCode: pending.resolutionData.parsed.baseCode,
                parsedAction: "departure_justification_manual_review",
                parsedDoctorName: pending.resolutionData.resolvedDoctor.fullName,
                errorMessage,
                resolutionData: { justificationFromPending: true },
            });
            await sendTelegramDepartureFailureReply({
                chatId: message.chat.id,
                replyToMessageId: message.message_id,
                seed: message.message_id,
                parsed: pending.resolutionData.parsed,
                doctorName: pending.resolutionData.resolvedDoctor.fullName,
                errorMessage,
            });
            return { ok: true, ignored: true, processingError: true };
        }
    }

    try {
        const eventAt = new Date(pending.resolutionData.originalEventAt);
        const result = await applyParsedEntry({
            parsed: pending.resolutionData.parsed,
            resolvedDoctor: pending.resolutionData.resolvedDoctor,
            eventAt,
            referenceAt: new Date(pending.resolutionData.originalReferenceAt ?? pending.resolutionData.originalEventAt),
            messageText: mergedText,
        });

        await markTelegramProcessed(pending.id, {
            status: "accepted",
            relatedOccupancyId: result.occupancyId,
            errorMessage: null,
            resolutionData: buildResolutionData(pending.resolutionData, {
                justificationReplyText: message.text,
                matchedReasonCode: eligibleReason.code,
                automaticCreditGranted: true,
            }),
        });
        await markTelegramProcessed(logId, {
            status: "accepted",
            parsedDomain: pending.resolutionData.parsed.sector,
            parsedTargetCode: pending.resolutionData.parsed.baseCode,
            parsedAction: "departure_justification_recorded",
            parsedDoctorName: pending.resolutionData.resolvedDoctor.fullName,
            relatedOccupancyId: result.occupancyId,
            errorMessage: null,
            resolutionData: {
                justificationFromPending: true,
            },
        });
        await sendMessage(
            message.chat.id,
            pickTelegramReply("departure_justification_recorded", message.message_id, {
                name: pending.resolutionData.resolvedDoctor.fullName,
                target: pending.resolutionData.parsed.baseCode,
                time: formatTelegramReplyTime(eventAt),
            }),
            message.message_id,
        );
        return { ok: true, occupancyId: result.occupancyId };
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : "telegram_processing_failed";
        if (isTelegramJustificationRequiredError(errorMessage)) {
            await markTelegramProcessed(logId, {
                status: "ignored",
                parsedDomain: pending.resolutionData.parsed.sector,
                parsedTargetCode: pending.resolutionData.parsed.baseCode,
                parsedAction: "departure_justification_pending",
                parsedDoctorName: pending.resolutionData.resolvedDoctor.fullName,
                errorMessage: "departure_justification_still_missing",
                resolutionData: {
                    pendingJustificationKept: true,
                },
            });
            await sendMessage(
                message.chat.id,
                pickTelegramReply(promptKind, message.message_id, {
                    name: pending.resolutionData.resolvedDoctor.fullName,
                    target: pending.resolutionData.parsed.baseCode,
                    time: replyTime,
                    example: replyExample,
                }),
                message.message_id,
            );
            return { ok: true, ignored: true, pending: true };
        }

        await markTelegramProcessed(pending.id, {
            status: "error",
            errorMessage,
        });
        await markTelegramProcessed(logId, {
            status: "error",
            parsedDomain: pending.resolutionData.parsed.sector,
            parsedTargetCode: pending.resolutionData.parsed.baseCode,
            parsedAction: "departure_justification_recorded",
            parsedDoctorName: pending.resolutionData.resolvedDoctor.fullName,
            errorMessage,
            resolutionData: {
                justificationFromPending: true,
            },
        });
        await sendTelegramDepartureFailureReply({
            chatId: message.chat.id,
            replyToMessageId: message.message_id,
            seed: message.message_id,
            parsed: pending.resolutionData.parsed,
            doctorName: pending.resolutionData.resolvedDoctor.fullName,
            errorMessage,
        });
        return { ok: true, ignored: true, processingError: true };
    }
}

async function applyPendingDepartureCorrection(params: {
    candidate: TelegramDepartureCorrectionCandidate;
    correctedTime: string;
    messageText: string;
    actorUserId?: string | null;
}) {
    const eventAt = resolveTelegramEventTime(resolveDepartureCorrectionReferenceAt(params.candidate), params.correctedTime);
    if (eventAt.getTime() < params.candidate.startedAt.getTime()) {
        throw new Error("Actual end cannot be before the recorded arrival.");
    }

    if (params.candidate.domain === "REGULATION") {
        const existing = await getDb().query.regulationOccupancies.findFirst({
            where: eq(regulationOccupancies.id, params.candidate.occupancyId),
        });
        if (!existing) {
            throw new Error("Regulation occupancy not found.");
        }

        if (!existing.endedAt) {
            const updated = await endRegulationOccupancy(existing.id, {
                endedAt: eventAt,
                actualEndedAt: eventAt,
            }, resolveCommandAuditUserId(params.actorUserId));
            return {
                occupancyId: updated.id,
                eventAt,
                adjustedClosed: false,
            };
        }

        const updated = await correctRegulationOccupancy(existing.id, {
            actualEndedAt: eventAt,
            notes: appendTelegramOperationalNote(existing.notes, "telegram corrigir saida", params.messageText),
        }, resolveCommandAuditUserId(params.actorUserId));
        return {
            occupancyId: updated.id,
            eventAt,
            adjustedClosed: true,
        };
    }

    const existing = await getDb().query.interventionOccupancies.findFirst({
        where: eq(interventionOccupancies.id, params.candidate.occupancyId),
    });
    if (!existing) {
        throw new Error("Intervention occupancy not found.");
    }

    if (!existing.endedAt) {
        const updated = await endInterventionOccupancy(existing.id, {
            endedAt: eventAt,
            actualEndedAt: eventAt,
        }, resolveCommandAuditUserId(params.actorUserId));
        return {
            occupancyId: updated.id,
            eventAt,
            adjustedClosed: false,
        };
    }

    const updated = await correctInterventionOccupancy(existing.id, {
        actualEndedAt: eventAt,
        notes: appendTelegramOperationalNote(existing.notes, "telegram corrigir saida", params.messageText),
    }, resolveCommandAuditUserId(params.actorUserId));
    return {
        occupancyId: updated.id,
        eventAt,
        adjustedClosed: true,
    };
}

async function tryHandlePendingDepartureCorrection(update: TelegramUpdate, logId: string) {
    const message = update.message;
    if (!message?.text || !message.from?.id) {
        return null;
    }

    const pending = await findPendingDepartureCorrection(String(message.chat.id), String(message.from.id));
    if (!pending || !isPendingDepartureCorrectionData(pending.resolutionData)) {
        return null;
    }

    if (shouldDeferPendingDepartureCorrectionToFreshParsing(message.text)) {
        await markTelegramProcessed(pending.id, {
            status: "superseded",
            errorMessage: "departure_correction_deferred_to_fresh_parsing",
        });
        return null;
    }

    const candidate = deserializeDepartureCorrectionCandidate(pending.resolutionData.candidate);

    if (isBatchCancelKeyword(message.text)) {
        await markTelegramProcessed(pending.id, {
            status: "ignored",
            errorMessage: "departure_correction_cancelled",
        });
        await markTelegramProcessed(logId, {
            status: "accepted",
            parsedDomain: candidate.domain,
            parsedTargetCode: candidate.targetCode,
            parsedAction: "departure_correction_cancelled",
            parsedDoctorName: pending.resolutionData.resolvedDoctor.fullName,
            errorMessage: null,
        });
        await sendMessage(
            message.chat.id,
            `⚠️ Cancelado. A correção de saída de ${pending.resolutionData.resolvedDoctor.fullName} em ${candidate.targetCode} não foi aplicada.`,
            message.message_id,
        );
        return { ok: true, ignored: true };
    }

    if (isCasualTelegramMessage(message.text)) {
        await markTelegramProcessed(logId, {
            status: "ignored",
            parsedDomain: candidate.domain,
            parsedTargetCode: candidate.targetCode,
            parsedAction: "departure_correction_pending",
            parsedDoctorName: pending.resolutionData.resolvedDoctor.fullName,
            errorMessage: "departure_correction_pending",
            resolutionData: { pendingDepartureCorrectionKept: true },
        });
        await sendMessage(
            message.chat.id,
            `Ainda estou aguardando só o horário correto da saída de ${pending.resolutionData.resolvedDoctor.fullName} em ${candidate.targetCode}. Responda em HH:MM, por exemplo 19:05.`,
            message.message_id,
        );
        return { ok: true, ignored: true, pending: true };
    }

    const correctedTime = parseTelegramStandaloneTime(message.text);
    if (!correctedTime) {
        await markTelegramProcessed(logId, {
            status: "ignored",
            parsedDomain: candidate.domain,
            parsedTargetCode: candidate.targetCode,
            parsedAction: "departure_correction_pending",
            parsedDoctorName: pending.resolutionData.resolvedDoctor.fullName,
            errorMessage: "departure_correction_time_missing",
            resolutionData: { pendingDepartureCorrectionKept: true },
        });
        await sendMessage(
            message.chat.id,
            `Preciso só da hora correta da saída em HH:MM para ${pending.resolutionData.resolvedDoctor.fullName} em ${candidate.targetCode}. Ex.: 19:05.`,
            message.message_id,
        );
        return { ok: true, ignored: true, pending: true };
    }

    const actor = await resolveTelegramCommandActor(message);

    try {
        const result = await applyPendingDepartureCorrection({
            candidate,
            correctedTime,
            messageText: `${pending.resolutionData.originalText}\n[hora corrigida] ${message.text}`,
            actorUserId: actor?.userId,
        });

        await markTelegramProcessed(pending.id, {
            status: "accepted",
            relatedOccupancyId: result.occupancyId,
            errorMessage: null,
            resolutionData: buildResolutionData(pending.resolutionData, {
                correctedTime,
                correctedAt: result.eventAt.toISOString(),
                correctionReplyText: message.text,
            }),
        });
        await markTelegramProcessed(logId, {
            status: "accepted",
            parsedDomain: candidate.domain,
            parsedTargetCode: candidate.targetCode,
            parsedAction: "departure_correction_recorded",
            parsedDoctorName: pending.resolutionData.resolvedDoctor.fullName,
            relatedOccupancyId: result.occupancyId,
            errorMessage: null,
            resolutionData: {
                correctedTime,
                adjustedClosed: result.adjustedClosed,
            },
        });
        await sendMessage(
            message.chat.id,
            result.adjustedClosed
                ? `Saída real corrigida: ${pending.resolutionData.resolvedDoctor.fullName} ficou com ${correctedTime} em ${candidate.targetCode}. Painel preservado e banco de horas atualizado.`
                : `Saída corrigida: considerei ${correctedTime} como horário real de saída de ${pending.resolutionData.resolvedDoctor.fullName} em ${candidate.targetCode}.`,
            message.message_id,
        );
        return { ok: true, occupancyId: result.occupancyId };
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : "departure_correction_failed";
        const isChronologyError = errorMessage.includes("Actual end cannot be before the recorded arrival.");

        if (!isChronologyError) {
            await markTelegramProcessed(pending.id, {
                status: "error",
                errorMessage,
            });
        }

        await markTelegramProcessed(logId, {
            status: isChronologyError ? "ignored" : "error",
            parsedDomain: candidate.domain,
            parsedTargetCode: candidate.targetCode,
            parsedAction: "departure_correction_recorded",
            parsedDoctorName: pending.resolutionData.resolvedDoctor.fullName,
            errorMessage,
            resolutionData: {
                correctedTime,
                pendingDepartureCorrectionKept: isChronologyError,
            },
        });

        await sendMessage(
            message.chat.id,
            isChronologyError
                ? `Esse horário ficou antes da chegada registrada de ${pending.resolutionData.resolvedDoctor.fullName} em ${candidate.targetCode}. Responda com outra hora em HH:MM.`
                : `:/ Nao consegui corrigir a saída de ${pending.resolutionData.resolvedDoctor.fullName} em ${candidate.targetCode}. ${errorMessage}`,
            message.message_id,
        );
        return { ok: true, ignored: true, processingError: !isChronologyError };
    }
}

async function tryHandlePendingRamalSelection(update: TelegramUpdate, logId: string) {
    const message = update.message;
    if (!message?.text || !message.from?.id) {
        return null;
    }

    const pending = await findPendingRamalSelection(String(message.chat.id), String(message.from.id));
    if (!pending || !isPendingCruCoiRamalData(pending.resolutionData)) {
        return null;
    }

    // Only treat as a ramal reply when the message contains a 4-digit number
    const ramalMatch = message.text.match(/\b(\d{4})\b/);
    if (!ramalMatch) {
        // Not a ramal reply — fall through to normal processing and keep the pending alive
        return null;
    }

    const ramal = ramalMatch[1];
    const location = pending.resolutionData.location;
    const reconstructedText = pending.resolutionData.originalText.replace(new RegExp(`\\b${location}\\b`, "i"), ramal);

    const parsedEntries = parseMessageMulti(reconstructedText);
    const firstParsed = parsedEntries.find((e) => !e.isDeparture) ?? parsedEntries[0];

    if (!firstParsed?.baseCode || !firstParsed.sector) {
        await markTelegramProcessed(logId, {
            status: "ignored",
            errorMessage: "cru_coi_ramal_parse_failed",
        });
        await sendMessage(
            message.chat.id,
            `⚠️ Recebi o ramal *${ramal}*, mas não consegui montar o registro. Reenvie a mensagem completa: _${reconstructedText}_`,
            message.message_id,
        );
        return { ok: true, ignored: true };
    }

    const parsedEntry = {
        ...firstParsed,
        sector: firstParsed.sector,
    } as OperationalParsedEntry;

    const senderName = pending.resolutionData.senderName
        ?? [message.from.first_name, message.from.last_name].filter(Boolean).join(" ");
    const doctorQuery = firstParsed.extractedNames[0] ?? null;
    const { doctor: resolvedDoctor, candidates, matchedBy } = await resolveOperationalDoctor({
        parsed: parsedEntry,
        doctorQuery,
        senderName,
        messageText: reconstructedText,
        chatId: String(message.chat.id),
        senderTelegramId: message.from?.id ? String(message.from.id) : null,
        referenceAt: new Date(message.date * 1000),
    });

    const originalEventAt = new Date(pending.resolutionData.originalEventAt);
    const eventAt = resolveTelegramEventTime(originalEventAt, parsedEntry.arrivalTime);

    if (!resolvedDoctor) {
        if (candidates.length > 0) {
            await markTelegramProcessed(pending.id, {
                status: "superseded",
                errorMessage: "cru_coi_ramal_resolved_pending_name",
            });
            await queuePendingNameSelection(logId, message, parsedEntry, doctorQuery, originalEventAt, eventAt, candidates);
            return { ok: true, ignored: true, pending: true };
        }
        await markTelegramProcessed(pending.id, { status: "superseded", errorMessage: "cru_coi_ramal_doctor_not_resolved" });
        await markTelegramProcessed(logId, {
            status: "ignored",
            parsedDomain: parsedEntry.sector,
            parsedTargetCode: parsedEntry.baseCode,
            parsedAction: "arrival",
            errorMessage: "doctor_not_resolved",
            resolutionData: buildTelegramReviewLogData({
                reason: "doctor_not_resolved",
                parsed: parsedEntry,
                doctorQuery: doctorQuery || senderName,
                trainingCandidate: true,
            }),
        });
        await sendMessage(
            message.chat.id,
            buildNameUnresolvedReply(message.message_id, candidates),
            message.message_id,
        );
        return { ok: true, ignored: true };
    }

    try {
        const result = await applyParsedEntry({
            parsed: parsedEntry,
            resolvedDoctor: { id: resolvedDoctor.id, fullName: resolvedDoctor.fullName, displayName: resolvedDoctor.displayName ?? null },
            eventAt,
            referenceAt: originalEventAt,
            messageText: reconstructedText,
        });
        await markTelegramProcessed(pending.id, {
            status: "accepted",
            parsedDoctorName: resolvedDoctor.fullName,
            relatedOccupancyId: result.occupancyId,
            errorMessage: null,
        });
        await markTelegramProcessed(logId, {
            status: "accepted",
            parsedDomain: parsedEntry.sector,
            parsedTargetCode: parsedEntry.baseCode,
            parsedAction: resolveTelegramParsedAction(parsedEntry),
            parsedDoctorName: resolvedDoctor.fullName,
            relatedOccupancyId: result.occupancyId,
            errorMessage: null,
            resolutionData: {
                continuationMode: resolveTelegramContinuationMode(parsedEntry),
                ramalResolvedFrom: location,
            },
        });
        await sendSuccessReply(
            message.chat.id,
            message.message_id,
            update.update_id,
            parsedEntry,
            resolveTelegramDoctorSurfaceName(resolvedDoctor),
            eventAt,
            result.successKind,
            matchedBy === "candidate"
                ? buildApproximateMatchHint({ doctorQuery, doctorName: resolveTelegramDoctorSurfaceName(resolvedDoctor) })
                : "",
            result.treatedAsContinuation,
            result.replyTimeAt,
            result.autoReactivated,
            result.effectiveShiftType,
            result.reassignedFrom,
            result.assumedHalfShift,
            result.continuationFrom,
        );
        return { ok: true, occupancyId: result.occupancyId };
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : "cru_coi_ramal_apply_failed";
        await markTelegramProcessed(pending.id, { status: "error", errorMessage });
        await markTelegramProcessed(logId, {
            status: "error",
            parsedDomain: parsedEntry.sector,
            parsedTargetCode: parsedEntry.baseCode,
            parsedAction: "arrival",
            parsedDoctorName: resolvedDoctor.fullName,
            errorMessage,
        });
        await sendMessage(
            message.chat.id,
            `:/ Não consegui registrar com o ramal ${ramal}. Reenvie a mensagem completa: _${reconstructedText}_`,
            message.message_id,
        );
        return { ok: true, ignored: true, processingError: true };
    }
}

export async function processTelegramUpdate(update: TelegramUpdate) {
    const message = update.message;
    if (!message?.text) {
        return { ok: true, ignored: true };
    }

    // Housekeeping: expire zombie pendings globally (debounced, at most every 5 min)
    await expireAllStalePendingsGlobal();

    const log = await logTelegramMessage(update);
    if (!(await isTelegramMessageAllowed(message))) {
        if (log) {
            await markTelegramProcessed(log.id, { status: "ignored", errorMessage: "chat_not_allowed" });
        }
        return { ok: true, ignored: true };
    }
    if (log) {
        try {
            const commandResult = await handleTelegramCommand(update, log.id);
            if (commandResult) {
                return commandResult;
            }

            const mealBreakReplyResult = await tryHandleMealBreakReply(update, log.id);
            if (mealBreakReplyResult) {
                return mealBreakReplyResult;
            }

            if (message.from?.id) {
                const pendingBatchResult = await tryHandlePendingBatchConfirmation(update, log.id);
                if (pendingBatchResult) {
                    return pendingBatchResult;
                }

                const pendingRamalResult = await tryHandlePendingRamalSelection(update, log.id);
                if (pendingRamalResult) {
                    return pendingRamalResult;
                }

                const pendingDepartureCorrectionResult = await tryHandlePendingDepartureCorrection(update, log.id);
                if (pendingDepartureCorrectionResult) {
                    return pendingDepartureCorrectionResult;
                }

                const pendingDepartureJustificationResult = await tryHandlePendingDepartureJustification(update, log.id);
                if (pendingDepartureJustificationResult) {
                    return pendingDepartureJustificationResult;
                }
            }

            if (message.from?.id) {
                const pendingResult = await tryHandlePendingNameSelection(update, log.id);
                if (pendingResult) {
                    return pendingResult;
                }
            }

            // P3d: Solo digits without active pending are stale pending replies — ignore silently.
            // In group chats, "1", "2", "3" are never intentional base registrations.
            if (message.chat.type !== "private" && /^\d{1,2}$/.test(message.text.trim())) {
                await markTelegramProcessed(log.id, {
                    status: "ignored",
                    errorMessage: "stale_pending_reply",
                    resolutionData: { staleDigitReply: true },
                });
                return { ok: true, ignored: true };
            }

            // P3c: Messages with inline @mentions (not commands) are conversational — ignore silently.
            if (message.chat.type !== "private" && /@\w+/.test(message.text) && !message.text.startsWith("/")) {
                await markTelegramProcessed(log.id, {
                    status: "ignored",
                    errorMessage: "casual_at_mention",
                    resolutionData: { casualAtMention: true },
                });
                return { ok: true, ignored: true };
            }

            if (message.chat.type === "private") {
                const { batchLines, entries, issues } = await prepareTelegramBatchEntries(message);
                if (batchLines.length > 1) {
                    if (!canManageTelegramBatch(message)) {
                        await markTelegramProcessed(log.id, {
                            status: "ignored",
                            parsedAction: "batch_forbidden",
                            errorMessage: "batch_forbidden",
                        });
                        await sendMessage(
                            message.chat.id,
                            ":/ Lancamento em lote no privado fica restrito ao ID autorizado da chefia. Para os demais casos, envie os registros individualmente.",
                            message.message_id,
                        );
                        return { ok: true, ignored: true };
                    }

                    if (entries.length === 0 || issues.length > 0) {
                        await markTelegramProcessed(log.id, {
                            status: "ignored",
                            parsedAction: "batch_review_failed",
                            errorMessage: "batch_review_requires_correction",
                            resolutionData: {
                                readyCount: entries.length,
                                issueCount: issues.length,
                                issues,
                            },
                        });
                        await sendMessage(
                            message.chat.id,
                            buildTelegramBatchReviewReply({
                                entries: entries.map((entry) => ({
                                    lineNumber: entry.lineNumber,
                                    doctorName: entry.resolvedDoctor.displayName ?? entry.resolvedDoctor.fullName,
                                    targetCode: entry.parsed.baseCode,
                                    timeLabel: entry.parsed.arrivalTime ?? "continua",
                                    sector: entry.parsed.sector,
                                    mode: isTelegramContinuationEntry(entry.parsed) ? "continuation" : "arrival",
                                })),
                                issues,
                            }),
                            message.message_id,
                        );
                        return { ok: true, ignored: true, pending: false };
                    }

                    await queuePendingBatchConfirmation(log.id, message, entries);
                    await sendMessage(
                        message.chat.id,
                        buildTelegramBatchReviewReply({
                            entries: entries.map((entry) => ({
                                lineNumber: entry.lineNumber,
                                doctorName: entry.resolvedDoctor.displayName ?? entry.resolvedDoctor.fullName,
                                targetCode: entry.parsed.baseCode,
                                timeLabel: entry.parsed.arrivalTime ?? "continua",
                                sector: entry.parsed.sector,
                                mode: isTelegramContinuationEntry(entry.parsed) ? "continuation" : "arrival",
                            })),
                            issues: [],
                        }),
                        message.message_id,
                        buildChoiceKeyboard([["✅ CONFIRMAR", "❌ CANCELAR"]]),
                    );
                    return { ok: true, ignored: true, pending: true };
                }
            }

            // F5: Intercept meal-break-related messages BEFORE operational parsing.
            // Messages like "1368 ALMOÇO 12:30" or "MARIANA ALMOÇO 1368" contain a ramal
            // and would be parsed as arrivals, but the intent is meal-break scheduling.
            if (looksLikeMealBreakMessage(message.text)) {
                await markTelegramProcessed(log.id, {
                    status: "ignored",
                    errorMessage: "meal_break_outside_flow",
                    resolutionData: buildTelegramReviewLogData({
                        reason: "meal_break_outside_flow",
                        trainingCandidate: false,
                    }),
                });
                await sendMessage(
                    message.chat.id,
                    "Essa mensagem parece ser sobre almoço/descanso. Para dividir almoço, use /almoco — o bot vai guiar passo a passo.",
                    message.message_id,
                );
                return { ok: true, ignored: true };
            }

            const parsedEntries = parseMessageMulti(message.text).filter(isOperationalParsedEntry);
            if (parsedEntries.length === 0) {
                // Continuation without base code: doctor says "Ana Luiza continua SN" without
                // specifying the ramal/base. Look up the doctor's current active occupancy and
                // auto-fill the target so the continuation can proceed normally.
                const rawParsedForContinuation = parseMessage(message.text);
                if (rawParsedForContinuation.isContinuation && !rawParsedForContinuation.baseCode) {
                    const senderName = [message.from?.first_name, message.from?.last_name].filter(Boolean).join(" ") || null;
                    const continuationResolved = await resolveContinuationWithoutBase(rawParsedForContinuation, message.text, senderName, new Date(message.date * 1000));
                    if (continuationResolved) {
                        const eventAt = resolveTelegramEventTime(new Date(message.date * 1000), continuationResolved.parsed.arrivalTime);
                        try {
                            const result = await applyParsedEntry({
                                parsed: continuationResolved.parsed,
                                resolvedDoctor: continuationResolved.resolvedDoctor,
                                eventAt,
                                referenceAt: new Date(message.date * 1000),
                                messageText: message.text,
                            });

                            if (message.from?.id) {
                                await supersedePendingDepartureJustification(String(message.chat.id), String(message.from.id));
                            }

                            await markTelegramProcessed(log.id, {
                                status: "accepted",
                                parsedDomain: continuationResolved.parsed.sector,
                                parsedTargetCode: continuationResolved.parsed.baseCode,
                                parsedAction: resolveTelegramParsedAction(continuationResolved.parsed),
                                parsedDoctorName: continuationResolved.resolvedDoctor.fullName,
                                relatedOccupancyId: result.occupancyId,
                                errorMessage: null,
                                resolutionData: {
                                    continuationMode: resolveTelegramContinuationMode(continuationResolved.parsed),
                                    resolvedBaseFromActiveOccupancy: true,
                                },
                            });

                            const doctorSurfaceName = continuationResolved.resolvedDoctor.displayName ?? continuationResolved.resolvedDoctor.fullName;
                            await sendSuccessReply(
                                message.chat.id,
                                message.message_id,
                                update.update_id,
                                continuationResolved.parsed,
                                doctorSurfaceName,
                                eventAt,
                                result.successKind,
                                "",
                                result.treatedAsContinuation,
                                result.replyTimeAt,
                                result.autoReactivated,
                                result.effectiveShiftType,
                                result.reassignedFrom,
                                result.assumedHalfShift,
                                result.continuationFrom,
                            );
                            return { ok: true, occupancyId: result.occupancyId };
                        } catch (error) {
                            const errorMsg = error instanceof Error ? error.message : "unknown_error";
                            if (isTelegramJustificationRequiredError(errorMsg)) {
                                await queuePendingDepartureJustification({
                                    logId: log.id,
                                    message,
                                    parsed: continuationResolved.parsed,
                                    resolvedDoctor: continuationResolved.resolvedDoctor,
                                    eventAt,
                                    referenceAt: new Date(message.date * 1000),
                                    originalText: message.text,
                                });
                                return { ok: true, ignored: true, pending: true };
                            }

                            await markTelegramProcessed(log.id, {
                                status: "error",
                                parsedDomain: continuationResolved.parsed.sector,
                                parsedTargetCode: continuationResolved.parsed.baseCode,
                                parsedAction: resolveTelegramParsedAction(continuationResolved.parsed),
                                parsedDoctorName: continuationResolved.resolvedDoctor.fullName,
                                errorMessage: errorMsg,
                            });
                            await sendTelegramDepartureFailureReply({
                                chatId: message.chat.id,
                                replyToMessageId: message.message_id,
                                seed: update.update_id,
                                parsed: continuationResolved.parsed,
                                doctorName: continuationResolved.resolvedDoctor.fullName,
                                errorMessage: errorMsg,
                            });
                            return { ok: true, ignored: true, processingError: true };
                        }
                    }
                }

                // Departure without base code: doctor says "alexandre faria saindo" or
                // "Leo Morais saindo do SN no COI as 07:22" without a specific ramal/base.
                // Look up the doctor's active occupancy and auto-fill the target.
                const rawParsedForDeparture = parseMessage(message.text);
                if (rawParsedForDeparture.isDeparture && !rawParsedForDeparture.baseCode) {
                    const senderName = [message.from?.first_name, message.from?.last_name].filter(Boolean).join(" ") || null;
                    const departureResolved = await resolveDepartureWithoutBase(rawParsedForDeparture, message.text, senderName);
                    if (departureResolved) {
                        const eventAt = resolveTelegramEventTime(new Date(message.date * 1000), departureResolved.parsed.arrivalTime);
                        try {
                            const result = await applyParsedEntry({
                                parsed: departureResolved.parsed,
                                resolvedDoctor: departureResolved.resolvedDoctor,
                                eventAt,
                                referenceAt: new Date(message.date * 1000),
                                messageText: message.text,
                            });

                            if (message.from?.id) {
                                await supersedePendingDepartureJustification(String(message.chat.id), String(message.from.id));
                            }

                            await markTelegramProcessed(log.id, {
                                status: "accepted",
                                parsedDomain: departureResolved.parsed.sector,
                                parsedTargetCode: departureResolved.parsed.baseCode,
                                parsedAction: resolveTelegramParsedAction(departureResolved.parsed),
                                parsedDoctorName: departureResolved.resolvedDoctor.fullName,
                                relatedOccupancyId: result.occupancyId,
                                errorMessage: null,
                                resolutionData: {
                                    resolvedBaseFromActiveOccupancy: true,
                                },
                            });

                            const doctorSurfaceName = departureResolved.resolvedDoctor.displayName ?? departureResolved.resolvedDoctor.fullName;
                            await sendSuccessReply(
                                message.chat.id,
                                message.message_id,
                                update.update_id,
                                departureResolved.parsed,
                                doctorSurfaceName,
                                eventAt,
                                result.successKind,
                                "",
                                result.treatedAsContinuation,
                                result.replyTimeAt,
                                result.autoReactivated,
                                result.effectiveShiftType,
                                result.reassignedFrom,
                            );
                            return { ok: true, occupancyId: result.occupancyId };
                        } catch (error) {
                            const errorMsg = error instanceof Error ? error.message : "unknown_error";
                            if (isTelegramJustificationRequiredError(errorMsg)) {
                                await queuePendingDepartureJustification({
                                    logId: log.id,
                                    message,
                                    parsed: departureResolved.parsed,
                                    resolvedDoctor: departureResolved.resolvedDoctor,
                                    eventAt,
                                    referenceAt: new Date(message.date * 1000),
                                    originalText: message.text,
                                });
                                return { ok: true, ignored: true, pending: true };
                            }

                            await markTelegramProcessed(log.id, {
                                status: "error",
                                parsedDomain: departureResolved.parsed.sector,
                                parsedTargetCode: departureResolved.parsed.baseCode,
                                parsedAction: resolveTelegramParsedAction(departureResolved.parsed),
                                parsedDoctorName: departureResolved.resolvedDoctor.fullName,
                                errorMessage: errorMsg,
                            });
                            await sendTelegramDepartureFailureReply({
                                chatId: message.chat.id,
                                replyToMessageId: message.message_id,
                                seed: update.update_id,
                                parsed: departureResolved.parsed,
                                doctorName: departureResolved.resolvedDoctor.fullName,
                                errorMessage: errorMsg,
                            });
                            return { ok: true, ignored: true, processingError: true };
                        }
                    }
                }

                if (isCasualTelegramMessage(message.text)) {
                    await markTelegramProcessed(log.id, {
                        status: "ignored",
                        errorMessage: "casual_smalltalk",
                        resolutionData: { casual: true },
                    });
                    // P5a: Only reply to casual messages in private chat. In groups, stay silent.
                    if (message.chat.type === "private") {
                        await sendMessage(
                            message.chat.id,
                            pickTelegramReply("casual_smalltalk", message.message_id, {}),
                            message.message_id,
                        );
                    }
                    return { ok: true, ignored: true };
                }

                const locationHint = detectLocationWithoutRamal(message.text);
                if (locationHint) {
                    const senderName = [message.from?.first_name, message.from?.last_name].filter(Boolean).join(" ") || null;
                    const rawParsed = parseMessageMulti(message.text)[0];
                    const originalEventAt = new Date(message.date * 1000);
                    await markTelegramProcessed(log.id, {
                        status: message.from?.id ? "pending_cru_coi_ramal" : "ignored",
                        errorMessage: message.from?.id ? null : "location_without_ramal",
                        resolutionData: message.from?.id
                            ? {
                                location: locationHint.location,
                                originalText: message.text,
                                originalEventAt: originalEventAt.toISOString(),
                                senderName,
                            } satisfies PendingCruCoiRamalData
                            : buildTelegramReviewLogData({ reason: "location_without_ramal", trainingCandidate: true }),
                    });
                    await sendMessage(
                        message.chat.id,
                        buildLocationWithoutRamalReply({
                            senderName: rawParsed?.extractedNames[0] ?? senderName ?? "",
                            location: locationHint.location,
                            shiftLabel: rawParsed?.shiftType ?? null,
                            time: rawParsed?.arrivalTime ?? null,
                            interactive: Boolean(message.from?.id),
                        }),
                        message.message_id,
                    );
                    return { ok: true, ignored: true };
                }

                if (looksLikeOperationalMetaConversation(message.text)) {
                    await markTelegramProcessed(log.id, {
                        status: "ignored",
                        errorMessage: "operational_meta_conversation",
                        resolutionData: {
                            casual: true,
                            metaConversation: true,
                            metaConversationKind: "vacancy_or_coverage",
                        },
                    });
                    // Keep group noise low; in private, return a short guidance.
                    if (message.chat.type === "private") {
                        await sendMessage(
                            message.chat.id,
                            "📌 Recebi como conversa operacional (vaga/cobertura), não como registro de chegada/saída. Se quiser registrar, use: _Nome Ramal/Base Horário Turno_.",
                            message.message_id,
                        );
                    }
                    return { ok: true, ignored: true };
                }

                const looksLikeDeparture = looksLikeDepartureMessage(message.text);

                await markTelegramProcessed(log.id, {
                    status: "ignored",
                    errorMessage: "no_operational_match",
                    resolutionData: buildTelegramReviewLogData({
                        reason: "no_operational_match",
                        trainingCandidate: true,
                        looksLikeDeparture,
                        example: looksLikeDeparture ? buildTelegramDepartureExample({}) : null,
                    }),
                });
                const recentMessages = await listRecentTelegramSenderMessages({
                    chatId: String(message.chat.id),
                    senderTelegramId: message.from?.id ? String(message.from.id) : null,
                    senderName: [message.from?.first_name, message.from?.last_name].filter(Boolean).join(" ") || null,
                    currentLogId: log.id,
                });
                const suggestion = suggestTelegramCommandHelp({
                    text: message.text,
                    recentMessages,
                });
                if (suggestion) {
                    await sendMessage(
                        message.chat.id,
                        buildTelegramCommandSuggestionReply(suggestion),
                        message.message_id,
                    );
                    return { ok: true, ignored: true };
                }
                if (looksLikeDeparture) {
                    await sendMessage(
                        message.chat.id,
                        pickTelegramReply("departure_missing_context", message.message_id, {
                            example: buildTelegramDepartureExample({}),
                        }),
                        message.message_id,
                    );
                } else {
                    const rawPartial = parseMessage(message.text);
                    const partialParts: string[] = [];
                    if (rawPartial.baseCode) partialParts.push(`base/ramal *${rawPartial.baseCode}*`);
                    if (rawPartial.arrivalTime) partialParts.push(`horário *${rawPartial.arrivalTime}*`);
                    if (rawPartial.shiftType) partialParts.push(`turno *${rawPartial.shiftType}*`);
                    if (rawPartial.extractedNames.length > 0) partialParts.push(`nome *${rawPartial.extractedNames[0]}*`);
                    const partialHint = partialParts.length > 0
                        ? `\n\n🔍 Detectei: ${partialParts.join(", ")}${!rawPartial.baseCode ? " — faltou a *base ou ramal*" : !rawPartial.extractedNames.length ? " — faltou o *nome do médico*" : !rawPartial.sector ? " — não identifiquei se é regulação ou intervenção" : ""}.`
                        : "";
                    await sendMessage(
                        message.chat.id,
                        pickTelegramReply("no_operational_match", message.message_id, {
                            arrivalExample: buildTelegramArrivalExample({}),
                            departureExample: buildTelegramDepartureExample({}),
                        }) + partialHint,
                        message.message_id,
                    );
                }
                return { ok: true, ignored: true };
            }

            const firstParsed = parsedEntries.find((entry) => entry.isDeparture) ?? parsedEntries[0];

            // F3 safety: reject low-confidence entries without extracted names in group chats.
            // These are typically casual messages that accidentally contain a base/ramal number.
            // In private chats (batch mode from chefia), this gate is skipped.
            if (shouldRejectLowConfidenceTelegramArrival({
                chatType: message.chat.type,
                confidence: firstParsed.confidence,
                extractedNamesCount: firstParsed.extractedNames.length,
                isDeparture: firstParsed.isDeparture,
                messageText: message.text,
                senderName: [message.from?.first_name, message.from?.last_name].filter(Boolean).join(" ") || null,
            })) {
                await markTelegramProcessed(log.id, {
                    status: "ignored",
                    parsedDomain: firstParsed.sector,
                    parsedTargetCode: firstParsed.baseCode,
                    parsedAction: "arrival",
                    errorMessage: "low_confidence_no_name",
                    resolutionData: buildTelegramReviewLogData({
                        reason: "low_confidence_no_name",
                        parsed: firstParsed,
                        trainingCandidate: true,
                    }),
                });
                await sendMessage(
                    message.chat.id,
                    pickTelegramReply("no_operational_match", message.message_id, {
                        arrivalExample: buildTelegramArrivalExample({}),
                        departureExample: buildTelegramDepartureExample({}),
                    }) + `\n\n🔍 Detectei base/ramal *${firstParsed.baseCode}* mas não identifiquei o nome do médico.`,
                    message.message_id,
                );
                return { ok: true, ignored: true };
            }

            if (!firstParsed.isDeparture && looksLikeDepartureMessage(message.text)) {
                const departureExample = buildTelegramDepartureExample({
                    doctorName: firstParsed.extractedNames[0] ?? ([message.from?.first_name, message.from?.last_name].filter(Boolean).join(" ") || null),
                    target: firstParsed.baseCode,
                    time: firstParsed.arrivalTime,
                });

                await markTelegramProcessed(log.id, {
                    status: "ignored",
                    parsedDomain: firstParsed.sector,
                    parsedTargetCode: firstParsed.baseCode,
                    parsedAction: "departure_rephrase_required",
                    errorMessage: "departure_low_confidence_rephrase_required",
                    resolutionData: buildTelegramReviewLogData({
                        reason: "departure_low_confidence_rephrase_required",
                        parsed: firstParsed,
                        trainingCandidate: true,
                        looksLikeDeparture: true,
                        example: departureExample,
                    }),
                });
                await sendMessage(
                    message.chat.id,
                    `${pickTelegramReply("departure_missing_context", message.message_id, {
                        example: departureExample,
                    })}${buildStructuredTelegramDepartureHint({
                        doctorName: firstParsed.extractedNames[0] ?? ([message.from?.first_name, message.from?.last_name].filter(Boolean).join(" ") || null),
                        target: firstParsed.baseCode,
                        time: firstParsed.arrivalTime,
                    })}`,
                    message.message_id,
                );
                return { ok: true, ignored: true };
            }

            const senderName = [message.from?.first_name, message.from?.last_name].filter(Boolean).join(" ");
            const doctorQuery = firstParsed.extractedNames[0] ?? null;
            const { doctor: resolvedDoctor, candidates, matchedBy } = await resolveOperationalDoctor({
                parsed: firstParsed,
                doctorQuery,
                senderName,
                messageText: message.text,
                chatId: String(message.chat.id),
                senderTelegramId: message.from?.id ? String(message.from.id) : null,
                referenceAt: new Date(message.date * 1000),
            });
            if (!resolvedDoctor) {
                const eventAt = resolveTelegramEventTime(new Date(message.date * 1000), firstParsed.arrivalTime);
                if (candidates.length > 0) {
                    await queuePendingNameSelection(log.id, message, firstParsed, doctorQuery, new Date(message.date * 1000), eventAt, candidates);
                    return { ok: true, ignored: true, pending: true };
                }

                const looksLikeDeparture = firstParsed.isDeparture || looksLikeDepartureMessage(message.text);
                const departureExample = looksLikeDeparture
                    ? buildTelegramDepartureExample({
                        doctorName: doctorQuery || senderName,
                        target: firstParsed.baseCode,
                        time: firstParsed.arrivalTime,
                    })
                    : null;

                await markTelegramProcessed(log.id, {
                    status: "ignored",
                    parsedDomain: firstParsed.sector,
                    parsedTargetCode: firstParsed.baseCode,
                    parsedAction: resolveTelegramParsedAction(firstParsed),
                    errorMessage: "doctor_not_resolved",
                    resolutionData: buildTelegramReviewLogData({
                        reason: "doctor_not_resolved",
                        parsed: firstParsed,
                        doctorQuery: doctorQuery || senderName,
                        trainingCandidate: true,
                        looksLikeDeparture,
                        example: departureExample,
                    }),
                });
                await sendMessage(
                    message.chat.id,
                    `${buildNameUnresolvedReply(message.message_id, candidates)}${looksLikeDeparture
                        ? buildStructuredTelegramDepartureHint({
                            doctorName: doctorQuery || senderName,
                            target: firstParsed.baseCode,
                            time: firstParsed.arrivalTime,
                        })
                        : ""}`,
                    message.message_id,
                );
                return { ok: true, ignored: true };
            }

            const eventAt = resolveTelegramEventTime(new Date(message.date * 1000), firstParsed.arrivalTime);

            try {
                const { occupancyId, successKind, treatedAsContinuation, replyTimeAt, autoReactivated, effectiveShiftType, reassignedFrom, assumedHalfShift, continuationFrom } = await applyParsedEntry({
                    parsed: firstParsed,
                    resolvedDoctor: { id: resolvedDoctor.id, fullName: resolvedDoctor.fullName, displayName: resolvedDoctor.displayName ?? null },
                    eventAt,
                    referenceAt: new Date(message.date * 1000),
                    messageText: message.text,
                });

                if (message.from?.id) {
                    await supersedePendingDepartureJustification(String(message.chat.id), String(message.from.id));
                }

                await markTelegramProcessed(log.id, {
                    status: "accepted",
                    parsedDomain: firstParsed.sector,
                    parsedTargetCode: firstParsed.baseCode,
                    parsedAction: resolveTelegramParsedAction(firstParsed),
                    parsedDoctorName: resolvedDoctor.fullName,
                    relatedOccupancyId: occupancyId,
                    errorMessage: null,
                    resolutionData: {
                        continuationMode: resolveTelegramContinuationMode(firstParsed),
                    },
                });

                await sendSuccessReply(
                    message.chat.id,
                    message.message_id,
                    update.update_id,
                    firstParsed,
                    resolveTelegramDoctorSurfaceName(resolvedDoctor),
                    eventAt,
                    successKind,
                    matchedBy === "candidate"
                        ? buildApproximateMatchHint({ doctorQuery, doctorName: resolveTelegramDoctorSurfaceName(resolvedDoctor) })
                        : "",
                    treatedAsContinuation,
                    replyTimeAt,
                    autoReactivated,
                    effectiveShiftType,
                    reassignedFrom,
                    assumedHalfShift,
                    continuationFrom,
                );

                return { ok: true, occupancyId };
            } catch (error) {
                const errorMessage = error instanceof Error ? error.message : "telegram_processing_failed";
                if (isTelegramJustificationRequiredError(errorMessage)) {
                    await queuePendingDepartureJustification({
                        logId: log.id,
                        message,
                        parsed: firstParsed,
                        resolvedDoctor: { id: resolvedDoctor.id, fullName: resolvedDoctor.fullName, displayName: resolvedDoctor.displayName ?? null },
                        eventAt,
                        referenceAt: new Date(message.date * 1000),
                        originalText: message.text,
                    });
                    return { ok: true, ignored: true, pending: true };
                }

                await markTelegramProcessed(log.id, {
                    status: "error",
                    parsedDomain: firstParsed.sector,
                    parsedTargetCode: firstParsed.baseCode,
                    parsedAction: resolveTelegramParsedAction(firstParsed),
                    parsedDoctorName: resolvedDoctor.fullName,
                    errorMessage,
                    resolutionData: {
                        continuationMode: resolveTelegramContinuationMode(firstParsed),
                    },
                });
                await sendTelegramDepartureFailureReply({
                    chatId: message.chat.id,
                    replyToMessageId: message.message_id,
                    seed: update.update_id,
                    parsed: firstParsed,
                    doctorName: resolvedDoctor.fullName,
                    errorMessage,
                });
                await sendTelegramArrivalFailureReply({
                    chatId: message.chat.id,
                    replyToMessageId: message.message_id,
                    parsed: firstParsed,
                    errorMessage,
                });
                return { ok: true, ignored: true, processingError: true };
            }
        } catch (error) {
            await markTelegramProcessed(log.id, {
                status: "error",
                errorMessage: error instanceof Error ? error.message : "telegram_processing_failed",
            });
            return { ok: true, ignored: true, processingError: true };
        }
    }

    return { ok: true, ignored: true };
}
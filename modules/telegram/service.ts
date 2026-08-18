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
import { and, desc, eq, gte, inArray, isNotNull, isNull, lte, lt, ne } from "drizzle-orm";
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
import { extractDoctorAliases, extractDoctorPreferredOperationalRole, formatDoctorSurfaceName } from "@/modules/doctors/directory";
import { normalizeDoctorName } from "@/modules/doctors/importer";
import { checklistHintForConfirmation, fetchChecklistKeyHint } from "@/modules/telegram/checklist-key";
import { buildUpaRestrictionsCommandReply, fetchUpaRestrictions, upaRestrictionsHintForConfirmation } from "@/modules/telegram/upa-restrictions";
import {
    createDoctorDirectoryEntry,
    listDoctorsByPreferredOperationalRole,
    setDoctorPreferredOperationalRole,
    updateDoctorDirectoryEntry,
} from "@/modules/doctors/service";
import { isStoredEarlyDepartureOutcome } from "@/modules/operational/early-departure";
import { buildEarlyDepartureSummary } from "@/modules/operational/early-departure-copy";
import { announceDeactivationDepartures } from "@/modules/telegram/chief-kick";
import { continueInterventionOccupancy, deactivateInterventionBase, displaceInterventionOccupant, endInterventionOccupancy, reactivateInterventionBase, startInterventionOccupancy } from "@/modules/intervention/service";
import { getSaoPauloParts, isSameOperationalShiftArrival, resolveArrivalShiftLabel, resolveImplicitOccupancyExpiry, resolveOperationalShiftWindow, resolveProlongedShiftExpiry } from "@/modules/operational/board-rules";
import type { OccupancyShiftLabel } from "@/modules/operational/board-rules";
import {
    HALF_SHIFT_ROLE_LABEL,
    isHalfShiftRoleLabel,
    isWithinHalfShiftWindow,
    resolveHalfShiftScheduledWindow,
} from "@/modules/operational/half-shift";
import { correctInterventionOccupancy, correctRegulationOccupancy, removeInterventionOccupancyRecord, removeRegulationOccupancyRecord, transferOperationalOccupancy } from "@/modules/operational/corrections";
import { normalizeOperationalRoleLabel, resolveFixedOperationalRole, resolveRoleLabelForExplicitRemoval } from "@/modules/operational/roles";
import { resolveContinuationReferenceBoundary, resolvePShiftAwareBaseShiftLabel, resolveTelegramEventTime, resolveForcedDayEventTime, normalizeArrivalEventTime } from "@/modules/operational/rules";
import { continueRegulationOccupancy, deactivateRegulationPost, displaceRegulationOccupant, endRegulationOccupancy, isRegulationShadowOccupancyNotes, reactivateRegulationPost, startRegulationOccupancy } from "@/modules/regulation/service";
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
import {
    isTelegramRoleCommandText,
    parseTelegramRoleCommand,
    resolveTelegramRoleCommandConfig,
} from "@/modules/telegram/role-commands";
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
    isTelegramResetCodinomeCommandText,
    parseTelegramPaymentAdminCommand,
    parseTelegramPaymentCodenameAdminCommand,
    parseTelegramPaymentDigestCommand,
    parseTelegramPaymentListCommand,
    parseTelegramPaymentProfileSetupCommand,
    parseTelegramPaymentResetAllCommand,
    parseTelegramPaymentSelfServiceCommand,
    parseTelegramResetCodinomeCommand,
    TELEGRAM_PAYMENT_CODENAME_USAGE,
    TELEGRAM_PAYMENT_CORRECTION_USAGE,
    TELEGRAM_PAYMENT_DIGEST_USAGE,
    TELEGRAM_PAYMENT_PROFILE_SETUP_USAGE,
    TELEGRAM_PAYMENT_REPORT_USAGE,
    TELEGRAM_RESET_CODINOME_USAGE,
} from "@/modules/telegram/payment-commands";
import { buildDoctorPayrollEmptyMessage, buildDoctorPayrollMessages, buildPaymentDigestMessages } from "@/modules/telegram/payment-digest";
import {
    ATTEMPT_LIMIT,
    checkAttemptLock,
    clearAttempts,
    isLikelyValidCnpj,
    listDoctorCodenames,
    normalizeCnpj,
    normalizeCompanyName,
    registerFailedAttempt,
    resetAllDoctorCodenames,
    resetDoctorCodename,
    resolveDoctorIdByCodename,
    upsertDoctorFiscalProfile,
    upsertDoctorCodename,
} from "@/modules/telegram/payment-access";
import { createFolhaToken } from "@/lib/folha-ponto/token";
import { getChiefPayableShiftsBoard } from "@/services/payable-shifts.service";
import { buildTelegramDepartureReport, buildTelegramDepartureReportSummary, resolveTelegramDepartureReportRequest } from "@/modules/telegram/departure-report";
import { buildTelegramSlotAuditMessages } from "@/modules/telegram/slot-audit-report";
import { buildTelegramSummaryReport } from "@/modules/telegram/summary-report";
import {
    buildMealBreakConsistencyAdminReply,
    buildMealBreakCommandUsageReply,
    CONFIRM_TEXT as MEAL_BREAK_CONFIRM_BUTTON_TEXT,
    UNDO_TEXT as MEAL_BREAK_UNDO_BUTTON_TEXT,
    buildMealBreakExcludeCommandUsageReply,
    buildMealBreakPriorityCommandUsageReply,
    buildMealBreakErrorReply,
    buildMealBreakStageKeyboard,
    getCurrentOperationalMealBreakSession,
    handleTelegramMealBreakReply,
    MEAL_BREAK_FORMAT_OPTIONS,
    resolveMealBreakTechnicalErrorDetail,
    isTelegramMealBreakCommandText,
    isTelegramMealBreakExcludeCommandText,
    ensureArrivalInCurrentMealBreakSession,
    isTelegramMealBreakPriorityCommandText,
    looksLikeMealBreakButtonReply,
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
import { getTelegramAdminUserIds, getTelegramAnnouncementChatIds, getTelegramChiefUserIds, getTelegramRegulationAlertUserIds, isTelegramChatAllowed, isTelegramPrivateControlUserId, resolveArrivalPhase } from "@/modules/telegram/config";
import { buildChiefPrivateRegulationAlertPlan } from "@/modules/telegram/reminders";
import {
    isTelegramAdminOnlyCommand,
    isTelegramDepartureCorrectionCommandText,
    parseTelegramCommand,
    parseTelegramDepartureCorrectionCommand,
} from "@/modules/telegram/commands";
import { buildTelegramCommandSuggestionReply, suggestTelegramCommandHelp, type TelegramRecentSenderMessage } from "@/modules/telegram/command-suggestions";
import { isCasualTelegramMessage, looksLikeDepartureMessage, looksLikeMealBreakMessage, looksLikeOperationalMetaConversation, parseMessage, parseMessageMulti, parseTelegramBatchLines, type ParsedMessage } from "@/modules/telegram/parser";
import type { TelegramCallbackQuery, TelegramFormatOptions, TelegramUpdate } from "@/modules/telegram/api";
import { answerCallbackQuery, buildChoiceKeyboard, buildInlineKeyboard, editMessageText, escapeTelegramMarkdown, getBotUsername, REMOVE_KEYBOARD, sendMessage, type TelegramReplyMarkup } from "@/modules/telegram/api";
import {
    formatTelegramErrorForUser,
    resolveTelegramErrorText,
    TelegramUserFacingError,
} from "@/modules/telegram/errors";
import {
    buildContinuityRevertCallbackData,
    type ContinuityRevertDomain,
    evaluateContinuityRevert,
    parseContinuityRevertCallbackData,
    resolveContinuityRevertTarget,
} from "@/modules/telegram/continuity-revert";
import {
    buildFiscalSuggestionCallbackData,
    parseFiscalSuggestionCallbackData,
    resolveFiscalSuggestion,
} from "@/modules/telegram/fiscal-confirmation";
import {
    buildCoiRamalKeyboard,
    buildCoiRamalPromptText,
    buildDepartureJustificationKeyboard,
    buildDestinationSelectionKeyboard,
    buildExpiredPendingAlertText,
    buildNameSelectionKeyboard,
    buildPiamShiftKeyboard,
    buildPiamShiftPromptText,
    buildResetAllConfirmationKeyboard,
    buildResetAllConfirmationPromptText,
    buildShiftSelectionKeyboard,
    buildShiftSelectionPromptText,
    buildTakeoverDecisionKeyboard,
    buildThirdPartyPressAlertText,
    buildUnknownDestinationReplyText,
    classifyPendingShortReply,
    classifyPiamShiftTextReply,
    parseCoiRamalCallbackData,
    parseDepartureJustificationCallbackData,
    parseDestinationSelectionCallbackData,
    parseNameSelectionCallbackData,
    parsePiamShiftCallbackData,
    parseResetAllCallbackData,
    parseShiftSelectionCallbackData,
    parseTakeoverDecisionCallbackData,
    PENDING_REOPEN_WINDOW_MS,
    replaceUnknownTargetToken,
    RESET_ALL_CONFIRM_TTL_MS,
    resolvePendingPresserPermission,
    resolvePendingReopenState,
    sanitizeTelegramCodeSpan,
    suggestNearestTargetCodes,
    type ExpiredPendingKind,
    type PendingShiftChoice,
} from "@/modules/telegram/pending-buttons";

/** Botão de reversão rápida de um P forward. Null = sem botão. */
type ForwardContinuityPrompt = {
    occupancyId: string;
    domain: ContinuityRevertDomain;
    /** Turno-base real do P: "SN" (19h→19h) ou "SD" (07h→07h, chegada adiantada). */
    baseShiftLabel: "SD" | "SN";
} | null;
import { pickCandidateFromReply, pickConfidentDoctorCandidate, resolveDoctorCandidates, type TelegramDoctorCandidate, type TelegramDoctorDirectoryEntry } from "@/modules/telegram/name-resolution";
import { buildCandidatePromptReply, buildGroupCorrectionAnnouncement, buildNameUnresolvedReply, buildTelegramBatchApplyReply, buildTelegramBatchReviewReply, pickTelegramReply } from "@/modules/telegram/replies";
import { getOperationalBoard, getPaymentAllocationBoard, type PaymentAllocationBoard, type PaymentAllocationRow } from "@/services/board.service";
import { getOperationalSlotAuditReport } from "@/services/slot-audit.service";

import {
    computeLevenshteinDistance,
    isBatchConfirmationKeyword,
    isBatchCancelKeyword,
    parseTelegramStandaloneTime,
    pickLikelyDepartureCorrectionCandidate,
    resolveTelegramEligibleLateDepartureReason,
    extractTelegramOccurrenceNumber,
    resolveTelegramLateDepartureClaim,
    isTelegramCreditEligibleClaim,
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
    extractTelegramOccurrenceNumber,
    resolveTelegramLateDepartureClaim,
    isTelegramCreditEligibleClaim,
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
    /** Set when the pending claim is an "occurrence" still missing its 4-digit number. */
    occurrenceNumberRequired?: boolean;
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

// F6 sem turno (auditoria §3.1#1): chegada com nome+local mas sem SD/SN/P vira
// pendência com botões em vez de rejeição seca. O parse fica salvo aqui e o
// callback/resposta curta completa o registro pelo MESMO caminho do fluxo normal.
interface PendingShiftSelectionData {
    kind: "shift_selection";
    parsed: OperationalParsedEntry;
    doctorQuery: string | null;
    senderName: string | null;
    senderTelegramId: string;
    originalText: string;
    originalReferenceAt: string;
}

// PIAM SD/SN (auditoria §3.1#12): a pergunta binária vira pendência com botões;
// o médico já foi resolvido antes do erro, então guardamos a referência dele.
interface PendingPiamShiftData {
    kind: "piam_shift";
    parsed: OperationalParsedEntry;
    resolvedDoctor: ResolvedTelegramDoctorRef;
    senderTelegramId: string;
    originalText: string;
    originalReferenceAt: string;
    /** message_id do balão-pergunta: permite responder "SD"/"SN" como reply. */
    promptMessageId?: number;
}

// Destino desconhecido (auditoria §3.1#9 / §5#7): a chegada falhou porque o token
// não é ramal/base conhecido, mas nome+turno estavam presentes — vira pendência com
// botões dos códigos REAIS mais próximos (query ao banco, nunca hardcode).
interface PendingDestinationSelectionData {
    kind: "destination_selection";
    token: string;
    suggestions: string[];
    senderTelegramId: string;
    senderName: string | null;
    originalText: string;
    originalReferenceAt: string;
}

// Reset geral de codinomes (auditoria §3.4#15): confirmação destrutiva com botões,
// TTL curto de 5 min e re-validação de admin no callback.
interface PendingResetAllConfirmationData {
    kind: "reset_all_confirmation";
    count: number;
    senderTelegramId: string;
    requestedAt: string;
}

interface PendingPaymentProfileData {
    stage: "awaiting_codename" | "awaiting_company_name" | "awaiting_cnpj" | "awaiting_suggestion_confirmation";
    doctorId?: string;
    companyName?: string;
    /** Só presente no estágio awaiting_suggestion_confirmation (sugestão importada da planilha oficial). */
    suggestedRazaoSocial?: string;
    suggestedCnpj?: string;
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

interface PendingAlertaConfirmationData {
    alertText: string;
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
// Tolerância de fechamento da fonte de continuidade explícita: rendição, expiry
// e saída antecipada fecham a ocupação do bloco anterior de ~2h antes da virada
// até depois dela — o médico ainda "estava lá na virada" para fins de vínculo.
const TELEGRAM_CONTINUATION_SOURCE_CLOSURE_TOLERANCE_MS = 2 * 60 * 60 * 1000;
const TELEGRAM_FORCED_TAKEOVER_MIN_DURATION_MS = 60 * 1000;
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
    | "meal_break_button_outside_flow"
    | "arrival_missing_name_or_shift"
    | "late_arrival_acknowledgement_required"
    | "no_operational_match"
    | "unknown_destination"
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

function isPendingAlertaConfirmationData(value: unknown): value is PendingAlertaConfirmationData {
    if (!value || typeof value !== "object") {
        return false;
    }
    const candidate = value as Record<string, unknown>;
    return typeof candidate.alertText === "string";
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

async function findPendingAlertaConfirmation(chatId: string, senderTelegramId: string) {
    const db = getDb();
    return db.query.telegramIngestedMessages.findFirst({
        where: and(
            eq(telegramIngestedMessages.chatId, chatId),
            eq(telegramIngestedMessages.senderTelegramId, senderTelegramId),
            eq(telegramIngestedMessages.status, "pending_alerta_confirmation"),
        ),
        orderBy: [desc(telegramIngestedMessages.createdAt)],
    });
}

async function queuePendingAlertaConfirmation(
    logId: string,
    message: TelegramUpdate["message"],
    alertText: string,
) {
    await markTelegramProcessed(logId, {
        status: "pending_alerta_confirmation",
        parsedAction: "alerta_command",
        resolutionData: { alertText },
    });
    const preview = `📋 *Prévia do alerta que será enviado à chefia:*\n\n${alertText}\n\nResponda *CONFIRMAR* para disparar ou *CANCELAR* para desistir.`;
    await sendMessage(message!.chat.id, preview, message!.message_id, buildChoiceKeyboard([["✅ CONFIRMAR", "❌ CANCELAR"]]));
}

function isTelegramContinuationEntry(parsed: OperationalParsedEntry) {
    return !parsed.isDeparture && parsed.isContinuation;
}

function isTelegramContinuationIntent(parsed: OperationalParsedEntry) {
    return !parsed.isDeparture && (parsed.isContinuation || parsed.shiftType === "P");
}

// Um aviso de continuidade ("continua" e sinonimos: sigo, permaneco, vou ficar,
// emendar, prosseguir...) NUNCA pode ser respondido como saida — continuar nao e
// sair. Se um erro de "Justificativa obrigatoria" borbulhar para uma entrada de
// continuidade, isso e uma inconsistencia interna: tratamos como erro generico
// em vez de abrir o fluxo de "saida tardia" (caso Uemerson Alcantara, SM01).
export function shouldRouteToDepartureJustification(errorMessage: string, parsed: OperationalParsedEntry) {
    return isTelegramJustificationRequiredError(errorMessage) && !isTelegramContinuationEntry(parsed);
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

// Um plantao P normal cobre 24h (com ~15min de folga). Quando a continuidade
// estende a cobertura bem alem disso, o medico esta de fato emendando um
// terceiro turno (~36h+) — caso em que o bot alerta na resposta.
const EXTENDED_LONG_SHIFT_THRESHOLD_MS = 25 * 60 * 60 * 1000;

function isExtendedLongShift(boardStartedAt?: Date | null, scheduledEndAt?: Date | null) {
    if (!boardStartedAt || !scheduledEndAt) {
        return false;
    }
    return scheduledEndAt.getTime() - boardStartedAt.getTime() > EXTENDED_LONG_SHIFT_THRESHOLD_MS;
}

export interface ContinuityInterpretation {
    /**
     * reinforcement      = só reforço do turno atual, cobertura não estendida.
     * extended_next_block = emenda discreta para o próximo turno.
     * extended_long_shift = plantão prolongado (~36h), médico emendando 3o turno.
     */
    classification: "reinforcement" | "extended_next_block" | "extended_long_shift";
    /** Turno (SD/SN) em que o médico já estava antes do aviso de continuidade. */
    anchorShiftLabel: string;
    scheduledEndBeforeIso: string | null;
    scheduledEndAfterIso: string | null;
    /** Horas entre o início no quadro e o fim agendado após a continuidade. */
    coverageHours: number;
    /** Frase verbosa para o audit trail e para a resposta do bot. */
    explanation: string;
}

function formatSaoPauloClock(value: Date | null | undefined): string {
    if (!value) {
        return "—";
    }
    return value.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "America/Sao_Paulo" });
}

// Classifica uma continuidade JÁ aplicada, para o audit trail
// (telegram_ingested_messages.resolution_data) e para a resposta verbosa do bot.
// Trabalha só com os snapshots antes/depois da ocupação — não decide cobertura,
// que continua centralizada em modules/operational/rules.ts.
export function buildContinuityInterpretation(params: {
    doctorSurfaceName: string;
    anchorStartedAt: Date;
    scheduledEndBefore: Date | null;
    continuedBoardStartedAt: Date | null;
    continuedScheduledEndAt: Date | null;
    extendedLongShift: boolean;
}): ContinuityInterpretation {
    const anchorShiftLabel = resolveOperationalShiftWindow(params.anchorStartedAt).shiftLabel;
    const before = params.scheduledEndBefore;
    const after = params.continuedScheduledEndAt;
    const didExtend = Boolean(after && before && after.getTime() > before.getTime());
    const classification = !didExtend
        ? "reinforcement" as const
        : params.extendedLongShift
            ? "extended_long_shift" as const
            : "extended_next_block" as const;
    const coverageHours = params.continuedBoardStartedAt && after
        ? Math.round(((after.getTime() - params.continuedBoardStartedAt.getTime()) / 3_600_000) * 10) / 10
        : 0;

    const name = params.doctorSurfaceName;
    const endBefore = formatSaoPauloClock(before);
    const endAfter = formatSaoPauloClock(after);
    let explanation: string;
    if (classification === "reinforcement") {
        explanation = `Interpretei a mensagem como reforço do plantão atual de ${name} (turno ${anchorShiftLabel}). `
            + `A cobertura já estava registrada até ${endBefore} e não foi estendida — sem novo turno.`;
    } else if (classification === "extended_next_block") {
        explanation = `Interpretei como continuidade de ${name} do turno ${anchorShiftLabel} para o turno seguinte. `
            + `Registrei o próximo turno como bloco discreto, com cobertura até ${endAfter}; o turno anterior não ficou aberto.`;
    } else {
        explanation = `Interpretei que ${name} está emendando mais um turno — plantão prolongado (~${coverageHours}h), `
            + `pois já estava de plantão nos turnos anteriores. Cobertura estendida até ${endAfter}.`;
    }

    return {
        classification,
        anchorShiftLabel,
        scheduledEndBeforeIso: before ? before.toISOString() : null,
        scheduledEndAfterIso: after ? after.toISOString() : null,
        coverageHours,
        explanation,
    };
}

// Normaliza um rótulo de turno para SD/SN concretos. P e nulos viram null porque
// só uma troca explícita SD↔SN sinaliza "plantão novo" — P/ausente é ambíguo
// (continuidade/24h) e não deve bloquear o remanejamento implícito.
function normalizeConcreteShift(value: string | null | undefined): "SD" | "SN" | null {
    const normalized = (value ?? "").trim().toUpperCase();
    return normalized === "SD" || normalized === "SN" ? normalized : null;
}

export function shouldTreatTelegramArrivalAsImplicitReassignment(params: {
    sector: "REGULATION" | "INTERVENTION";
    baseCode: string | null;
    arrivalTime?: string | null;
    shiftType?: string | null;
    roleFunction?: string | null;
    isShadow?: boolean;
    isDeparture: boolean;
    isContinuation: boolean;
    isReassignment?: boolean;
    activeSector?: "REGULATION" | "INTERVENTION" | null;
    activeBaseCode?: string | null;
    activeShiftLabel?: string | null;
}) {
    if (!params.baseCode) {
        return false;
    }

    if (params.isDeparture || params.isContinuation || params.isReassignment) {
        return false;
    }

    // Uma chegada de "sombra" é uma coexistência própria no novo ramal, não uma
    // mudança de posição do titular — nunca move a ocupação existente.
    if (params.isShadow) {
        return false;
    }

    if (!params.activeSector || !params.activeBaseCode) {
        return false;
    }

    // Mesma posição (mesmo domínio + mesmo código) não é remanejamento.
    if (params.activeSector === params.sector && params.activeBaseCode === params.baseCode) {
        return false;
    }

    // Um médico que já está no plantão e avisa chegada em OUTRA posição — ramal ou
    // ambulância, inclusive cross-domínio — está mudando de posto, não começando
    // um plantão novo. O sistema preserva o 1º horário de chegada (handled pelo
    // transfer, que clona started_at/boardStartedAt) em vez de marcá-lo atrasado.
    // A única exceção é declarar um turno concreto DIFERENTE do atual (SD↔SN):
    // isso sinaliza um plantão novo de verdade, então trata como chegada nova.
    const declaredShift = normalizeConcreteShift(params.shiftType);
    const activeShift = normalizeConcreteShift(params.activeShiftLabel);
    if (declaredShift && activeShift && declaredShift !== activeShift) {
        return false;
    }

    return true;
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

    return `\n🔁 Mudanca confirmada: *${sourceCode}* → *${targetCode}* mantendo a mesma continuidade.`;
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
    return resolveHalfShiftScheduledWindow(referenceAt).scheduledEndAt;
}

// Início agendado (esperado) do meio plantão da tarde. Fixo às 11:30 no relógio
// local, independente de quando o médico avisou. É o que o banco de horas usa
// como baseline de atraso. Ver HALF_SHIFT_EXPECTED_START_HHMM.
function resolveHalfShiftScheduledStartAt(referenceAt: Date) {
    return resolveHalfShiftScheduledWindow(referenceAt).scheduledStartAt;
}

// Gate de chegada (F6): um meio plantão explícito ("meio plantão", "tarde",
// "meio turno", "MP/MT") conta como *turno* informado, evitando o aviso de
// "faltou turno". Só liberamos quando o aviso será de fato honrado como meia
// jornada da tarde a jusante (regulação, sem turno explícito, dentro da janela
// 11:10–17:00). O médico NÃO precisa informar horário: se não declarar uma hora,
// usamos o relógio da própria mensagem (referenceAt) para a janela — o mesmo
// instante que shouldAssumeTelegramHalfShift consome como eventAt a jusante.
export function arrivalHalfShiftSatisfiesShiftGate(
    parsed: Pick<ParsedMessage, "sector" | "shiftType" | "roleFunction" | "isDeparture" | "isContinuation" | "arrivalTime">,
    referenceAt: Date,
): boolean {
    if (parsed.sector !== "REGULATION") return false;
    if (parsed.isDeparture || parsed.isContinuation) return false;
    if (parsed.shiftType) return false;
    if (!isHalfShiftRoleLabel(parsed.roleFunction)) return false;

    if (parsed.arrivalTime) {
        const match = /^(\d{1,2}):(\d{2})$/.exec(parsed.arrivalTime.trim());
        if (!match) return false;
        // A hora declarada já está no relógio local de Salvador.
        const minuteOfDay = (Number(match[1]) * 60) + Number(match[2]);
        return isWithinHalfShiftWindow(minuteOfDay);
    }

    // Sem hora declarada: cai para o relógio da mensagem (igual ao eventAt usado
    // por shouldAssumeTelegramHalfShift), para que aviso sem horário seja aceito.
    const parts = getSaoPauloParts(referenceAt);
    return isWithinHalfShiftWindow((parts.hour * 60) + parts.minute);
}

export function shouldAssumeTelegramHalfShift(params: {
    parsed: Pick<ParsedMessage, "sector" | "isDeparture" | "isContinuation">;
    eventAt: Date;
    effectiveShiftType: string | null;
}) {
    if (params.parsed.sector !== "REGULATION" || params.parsed.isDeparture || params.parsed.isContinuation) {
        return false;
    }

    const parts = getSaoPauloParts(params.eventAt);
    return isWithinHalfShiftWindow((parts.hour * 60) + parts.minute);
}

function appendTelegramOperationalNote(existingNotes: string | null | undefined, marker: string, messageText: string) {
    const nextEntry = `[${marker}] ${messageText}`;
    return [existingNotes?.trim(), nextEntry].filter(Boolean).join("\n");
}

function buildTelegramArrivalExample(params: {
    doctorName?: string | null;
    target?: string | null;
    time?: string | null;
    shiftLabel?: string | null;
}) {
    const compactName = params.doctorName?.trim() || "Vagner Costa";
    const target = params.target?.trim() || "PM04";
    // O exemplo canônico SEMPRE inclui o turno: sem SD/SN/P o próprio gate de
    // chegada rejeita quem copia o exemplo (auditoria comunicação §5#3).
    const shiftLabel = params.shiftLabel?.trim() || "SD";
    const time = params.time?.trim() || "07:00";
    return `${compactName} ${target} ${shiftLabel} ${time}`;
}

function buildTelegramDepartureExample(params: {
    doctorName?: string | null;
    target?: string | null;
    time?: string | null;
}) {
    const compactName = params.doctorName?.trim() || "Vagner Costa";
    const target = params.target?.trim() || "PR03";
    const time = params.time?.trim() || "19:20";
    // Sem justificativa no exemplo genérico: saída normal não precisa de motivo, e o
    // "porque fui liberado..." induzia justificativa desnecessária (auditoria §3.1#16).
    return `${compactName} saindo ${target} ${time}`;
}

function buildStructuredTelegramDepartureHint(params: {
    doctorName?: string | null;
    target?: string | null;
    time?: string | null;
}) {
    return `\n\nFormato mais seguro para saída: ${buildTelegramDepartureExample(params)}`;
}

const CRU_COI_LOCATION_PATTERN = /\b(CRU|COI)\b/i;

const COI_EXAMPLE_RAMAIS = ["1367", "1368"];
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
        `⚠️ ${locationFull} tem mais de um ramal — em qual ${name} está?`,
        `Ramais: ${exampleRamais.join(" · ")}`,
        params.interactive
            ? `Responda só o número (ex.: _${exampleRamal}_) que eu completo o registro.`
            : `Reenvie com o ramal no lugar de "${params.location}". Ex.: _${name} ${exampleRamal} ${shift} ${time}_`,
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
        case "meal_break_outside_flow":
            return "mensagem de almoço/descanso/jantar fora do fluxo /almoco";
        case "meal_break_button_outside_flow":
            return "botão de divisão de almoço acionado fora da sessão ativa";
        case "arrival_missing_name_or_shift":
            return "chegada sem nome do médico nem turno (SD/SN/P)";
        case "late_arrival_acknowledgement_required":
            return "chegada após 9h em intervenção SD aguardando reconhecimento de meio plantão";
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
    explicitContinuation?: boolean;
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
            if (!endedAt) {
                return false;
            }

            // Continuidade explícita usa a regra da fronteira (independe da hora do
            // aviso); a saída-e-volta-rápida implícita continua valendo em paralelo.
            if (
                params.explicitContinuation
                && shouldLinkExplicitContinuationClosedSource({
                    eventAt: params.eventAt,
                    sourceStartedAt: occupancy.startedAt,
                    sourceEndedAt: endedAt,
                })
            ) {
                return true;
            }

            return shouldLinkRecentClosedTelegramContinuity(params.eventAt, endedAt);
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

/**
 * Vínculo de continuidade EXPLÍCITA ("continua"/"continuando") com um plantão já
 * fechado. Deriva da virada de turno que a mensagem referencia (a mais próxima),
 * não da hora do aviso: a fonte é a ocupação que cobria o bloco ANTERIOR à
 * virada — começou antes dela e permaneceu até perto dela (fechamentos por
 * rendição/expiry/saída acontecem de ~2h antes da virada até depois).
 *
 * Vale para qualquer par origem→destino, inclusive entre domínios (ramal 2032 →
 * base CB02 e vice-versa): a listagem de fontes cobre regulação e intervenção.
 * Caso Luiz Alvarez (jul/2026): SN na BR05 rendido 07:20, "continuando na cb02"
 * às 10:15 — referencia a virada das 07:00 e linka, ganhando o badge Continua e
 * a âncora de prioridade da véspera.
 */
export function shouldLinkExplicitContinuationClosedSource(params: {
    eventAt: Date;
    sourceStartedAt: Date;
    sourceEndedAt: Date;
}) {
    const referenceBoundary = resolveContinuationReferenceBoundary(params.eventAt);
    if (params.sourceStartedAt.getTime() >= referenceBoundary.getTime()) {
        return false;
    }

    return params.sourceEndedAt.getTime() >= referenceBoundary.getTime() - TELEGRAM_CONTINUATION_SOURCE_CLOSURE_TOLERANCE_MS;
}

export function shouldLinkRecentClosedTelegramContinuity(eventAt: Date, endedAt: Date) {
    const elapsedMs = eventAt.getTime() - endedAt.getTime();
    if (elapsedMs < 0) {
        return false;
    }

    // Linkar "recent closed" só vale enquanto ainda dá pra entender como saída-e-volta-rápida
    // dentro do mesmo turno. Se um turno operacional inteiro passou com o medico fora do quadro,
    // a próxima chegada é plantão novo — quem realmente esticou precisa mandar "continuando"
    // (aí vale a regra da fronteira: shouldLinkExplicitContinuationClosedSource).
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

/**
 * Bloco de turno que uma continuação EXPLÍCITA ("continua"/"continuando") abre.
 *
 * Regra canônica (modules/operational/rules.ts): a mensagem referencia a virada
 * de turno mais próxima (resolveContinuationReferenceBoundary) e o bloco novo é
 * o turno DEPOIS dessa virada — começa na virada, com o rótulo desse turno.
 *
 * Derivar rótulo/janela do âncora da manhã (started_at herdado da chegada
 * original) fazia a ocupação nova nascer no bloco ANTERIOR, já expirado: a
 * varredura de auto-close fechava a linha segundos depois de criada e o médico
 * sumia do painel e da divisão do jantar, com resposta de sucesso no grupo
 * (casos Claudio Azoubel / Matheus Mendonça / Rafaela Menoita / Acacio Junio,
 * 03/08/2026). O horário de chegada original segue preservado no
 * boardStartedAt e no continuityGroup — nunca no started_at do bloco novo.
 */
export function resolveTelegramExplicitContinuationBlock(eventAt: Date) {
    const blockStartAt = resolveContinuationReferenceBoundary(eventAt);
    const blockProbe = new Date(blockStartAt.getTime() + 60000);
    return {
        blockStartAt,
        shiftLabel: resolveOperationalShiftWindow(blockProbe).shiftLabel,
    };
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

// Ocupante ativo com titularidade de quadro num ramal/base — usado só para
// ENRIQUECER a mensagem de conflito de chegada (auditoria §3.1#7: mostrar QUEM
// ocupa e desde quando). Sem filtro de turno: o conflito pode ser cross-turno.
async function findActiveBoardOccupantOnTarget(params: {
    sector: "REGULATION" | "INTERVENTION";
    targetCode: string;
}): Promise<{ doctorName: string; sinceTime: string } | null> {
    const db = getDb();
    if (params.sector === "REGULATION") {
        const post = await db.query.regulationPosts.findFirst({ where: eq(regulationPosts.code, params.targetCode) });
        if (!post) {
            return null;
        }
        const occ = await db.query.regulationOccupancies.findFirst({
            where: and(
                eq(regulationOccupancies.postId, post.id),
                isNull(regulationOccupancies.endedAt),
                isNotNull(regulationOccupancies.boardStartedAt),
            ),
            orderBy: [desc(regulationOccupancies.boardStartedAt)],
        });
        if (!occ) {
            return null;
        }
        const doc = await db.query.doctors.findFirst({ where: eq(doctors.id, occ.doctorId) });
        return {
            doctorName: resolveTelegramDoctorSurfaceName(doc),
            sinceTime: formatTelegramReplyTime(occ.boardStartedAt ?? occ.startedAt),
        };
    }
    const base = await db.query.interventionBases.findFirst({ where: eq(interventionBases.code, params.targetCode) });
    if (!base) {
        return null;
    }
    const occ = await db.query.interventionOccupancies.findFirst({
        where: and(
            eq(interventionOccupancies.baseId, base.id),
            isNull(interventionOccupancies.endedAt),
            isNotNull(interventionOccupancies.boardStartedAt),
        ),
        orderBy: [desc(interventionOccupancies.boardStartedAt)],
    });
    if (!occ) {
        return null;
    }
    const doc = await db.query.doctors.findFirst({ where: eq(doctors.id, occ.doctorId) });
    return {
        doctorName: resolveTelegramDoctorSurfaceName(doc),
        sinceTime: formatTelegramReplyTime(occ.boardStartedAt ?? occ.startedAt),
    };
}

function isTelegramPrivilegedSender(senderTelegramId: string | null | undefined) {
    if (!senderTelegramId) {
        return false;
    }
    const normalized = String(senderTelegramId);
    return getTelegramAdminUserIds().includes(normalized) || getTelegramChiefUserIds().includes(normalized);
}

async function sendTelegramArrivalFailureReply(params: {
    chatId: number;
    replyToMessageId: number;
    parsed: OperationalParsedEntry;
    errorMessage: string;
    /** Autor da mensagem (quando conhecido): médico comum não recebe dica de /retirar. */
    senderTelegramId?: string | null;
}) {
    if (params.parsed.isDeparture) {
        return;
    }

    // Conflito de ocupação: mostra QUEM ocupa e desde quando (auditoria §3.1#7).
    let occupant: { name: string; sinceTime: string } | null = null;
    if (
        params.errorMessage === "arrival_conflicts_with_active_occupancy"
        && !params.parsed.isContinuation
        && params.parsed.baseCode
        && params.parsed.sector
    ) {
        try {
            const found = await findActiveBoardOccupantOnTarget({
                sector: params.parsed.sector,
                targetCode: params.parsed.baseCode,
            });
            occupant = found ? { name: found.doctorName, sinceTime: found.sinceTime } : null;
        } catch {
            occupant = null;
        }
    }

    const userMessage = buildTelegramArrivalConflictMessage({
        parsed: params.parsed,
        errorMessage: params.errorMessage,
        occupant,
        senderIsPrivileged: isTelegramPrivilegedSender(params.senderTelegramId),
    });

    await sendMessage(
        params.chatId,
        userMessage,
        params.replyToMessageId,
        undefined,
        { parseMode: "Markdown" },
    );
}

/**
 * Constrói o texto de erro para chegada que falhou. Função pura — testável sem I/O.
 * Erros técnicos desconhecidos NÃO vazam cru: passam pela tabela de tradução /
 * allowlist (auditoria §3.1#11); conflito de ocupação mostra o ocupante quando
 * conhecido e a dica de /retirar sai só para chefe/admin (auditoria §3.1#7).
 * Interpolações escapadas — a mensagem sobe com parseMode Markdown.
 */
export function buildTelegramArrivalConflictMessage(params: {
    parsed: Pick<OperationalParsedEntry, "baseCode" | "isDeparture" | "isContinuation">;
    errorMessage: string;
    occupant?: { name: string; sinceTime: string } | null;
    senderIsPrivileged?: boolean;
}): string {
    if (params.errorMessage !== "arrival_conflicts_with_active_occupancy") {
        return `⚠️ Não consegui registrar essa chegada. ${escapeTelegramMarkdown(formatTelegramErrorForUser(params.errorMessage))}`;
    }
    const isContinuationConflict = shouldForceTelegramTakeoverOnContinuationConflict({
        parsed: params.parsed,
        errorMessage: params.errorMessage,
    });
    if (isContinuationConflict) {
        return `⚠️ Sua continuidade em *${escapeTelegramMarkdown(params.parsed.baseCode)}* entrou em conflito de horário e não consegui concluir a troca automática agora. Reenvie a mensagem em instantes para eu retirar o ocupante atual e te colocar no posto.`;
    }
    const target = escapeTelegramMarkdown(params.parsed.baseCode ?? "esse destino");
    const occupantLine = params.occupant
        ? `⛔ *${target}* já está com *${escapeTelegramMarkdown(params.occupant.name)}* desde *${params.occupant.sinceTime}*, com horário igual ou posterior ao seu.`
        : `⛔ Já há alguém ativo em *${target}* com horário igual ou posterior.`;
    const action = params.senderIsPrivileged
        ? `\nSe for assumir mesmo, use /retirar ${params.parsed.baseCode ?? ""} antes de registrar a nova chegada.`
        : "\nConfira o número — se estiver certo e você for assumir, chame a chefia (o /retirar é restrito a chefe/admin).";
    return `${occupantLine}${action}`;
}

/** Constrói o aviso de substituição forçada para inserção no reply de sucesso. Função pura — testável sem I/O. */
export function buildForcedTakeoverHint(params: {
    displacedDoctorName: string | null | undefined;
    baseCode: string;
}): string {
    if (!params.displacedDoctorName) return "";
    // 🔁 (remanejo/troca) no lugar do 🚨 *ATENÇÃO* e frase sem particípio flexionado
    // ("foi retirado" não funciona para todo nome) — auditoria §2 e §3.1#18.
    return `\n🔁 Retirei *${escapeTelegramMarkdown(params.displacedDoctorName)}* de *${escapeTelegramMarkdown(params.baseCode)}* automaticamente para você assumir este posto.`;
}

export function shouldForceTelegramTakeoverOnContinuationConflict(params: {
    parsed: Pick<OperationalParsedEntry, "isDeparture" | "isContinuation">;
    errorMessage: string;
}) {
    return params.errorMessage === "arrival_conflicts_with_active_occupancy"
        && !params.parsed.isDeparture
        && params.parsed.isContinuation;
}

// Rendição legítima tem tolerância: o sucessor pode ter chegado minutos antes
// de a saída do rendido ser registrada.
const TELEGRAM_SUCCESSOR_TAKEOVER_TOLERANCE_MS = 15 * 60 * 1000;

/**
 * Bloqueia o takeover forçado quando o ocupante atual é o SUCESSOR do próprio
 * continuador: A rendido por B que manda "continua" no MESMO posto derrubava B
 * (fechado por handoff) e se reinstalava — nenhuma checagem existia. Só vale
 * para continuação no mesmo alvo (cross-target segue com a semântica antiga de
 * assumir o posto novo); fonte ainda aberta ou ocupante mais antigo que o fim
 * da fonte = takeover legítimo de ocupação velha/esquecida.
 */
export function shouldBlockTelegramContinuationTakeoverBySuccessor(params: {
    isCrossTargetContinuation: boolean;
    sourceEndedAt: Date | null;
    conflictingStartedAt: Date;
}) {
    if (params.isCrossTargetContinuation || !params.sourceEndedAt) {
        return false;
    }

    return params.conflictingStartedAt.getTime() >= params.sourceEndedAt.getTime() - TELEGRAM_SUCCESSOR_TAKEOVER_TOLERANCE_MS;
}

export function resolveTelegramForcedTakeoverAt(params: {
    eventAt: Date;
    conflictedStartedAt: Date;
}) {
    return new Date(Math.max(
        params.eventAt.getTime(),
        params.conflictedStartedAt.getTime() + TELEGRAM_FORCED_TAKEOVER_MIN_DURATION_MS,
    ));
}

/**
 * Decide se o fechamento de uma ocupação deve ser tratado como RENDIÇÃO (handoff).
 * Rendição = já existe um sucessor (outro médico) ocupando o mesmo posto/base. Nesse caso
 * fechamos só com `endedAt` (sem `actualEndedAt`), o que mantém o médico anterior fora da fila
 * de confirmação finalizadora e fecha o banco no horário do handoff. Saída solo (sem sucessor)
 * continua gravando `actualEndedAt` e exigindo verificação do chefe.
 */
export function shouldCloseAsHandoff(params: { hasSuccessor: boolean }) {
    return params.hasSuccessor;
}

function isOperationalParsedEntry(entry: ParsedMessage): entry is ParsedMessage & OperationalParsedEntry {
    return Boolean(entry.baseCode && entry.sector);
}

// Até onde a mensagem de HOJE pode enxergar um plantão aberto do médico. Uma
// ocupação aberta antiga NÃO é "o plantão atual dele": é lixo que escapou do
// reaper (P sem saída, janela não expirada ainda). Sem esta trava, uma chegada
// digitada dias depois virava remanejamento retroativo — movia a ocupação
// ANTIGA para o ramal novo, preservando o started_at original e reescrevendo o
// passado (incidente 08/07/2026: "CAROLINA TANAJURA 2031 P" levou o plantão
// dela de 01/07 do 1366 para o 2031 e derrubou a Bruna do SD da chefia).
// O critério é a JANELA da ocupação, não a idade dela: vale enquanto o plantão
// ainda cobre o agora (com 3h de folga para a mensagem que chega atrasada).
// Continuidade declarada estende o scheduledEndAt e por isso continua alcançável
// mesmo com started_at de dois dias atrás; plantão que passou da janela e ficou
// aberto por silêncio, não.
const ACTIVE_OCCUPANCY_GRACE_MS = 3 * 60 * 60 * 1000;

export function resolveActiveOccupancyCoverageFloor(referenceAt: Date): Date {
    return new Date(referenceAt.getTime() - ACTIVE_OCCUPANCY_GRACE_MS);
}

async function findActiveOccupancyByDoctorId(doctorId: string, referenceAt = new Date()): Promise<{
    sector: "REGULATION" | "INTERVENTION";
    baseCode: string;
    occupancyId: string;
    startedAt: Date;
    shiftLabel: string | null;
    continuityGroupId: string | null;
    boardStartedAt: Date | null;
} | null> {
    const db = getDb();
    const coverageFloor = resolveActiveOccupancyCoverageFloor(referenceAt);

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
        .where(and(
            eq(regulationOccupancies.doctorId, doctorId),
            isNull(regulationOccupancies.endedAt),
            gte(regulationOccupancies.scheduledEndAt, coverageFloor),
        ))
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
        .where(and(
            eq(interventionOccupancies.doctorId, doctorId),
            isNull(interventionOccupancies.endedAt),
            gte(interventionOccupancies.scheduledEndAt, coverageFloor),
        ))
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

// Procura a ocupacao mais recentemente fechada do medico (regulation ou
// intervention) ate `maxWindowMs` antes de `referenceAt`. Usado quando o
// medico declara saida ja sem ocupacao ativa (auto-close pegou primeiro),
// caso "Jose Marini saida 19:26" / "Stephane saida 19:00" do audit 2026-05:
// occupancy fechou as 19:11/19:15 e a declaracao chegou ~15min depois.
async function findRecentClosedOccupancyByDoctorId(doctorId: string, referenceAt: Date, maxWindowMs = 4 * 60 * 60 * 1000): Promise<{
    sector: "REGULATION" | "INTERVENTION";
    baseCode: string;
    occupancyId: string;
    startedAt: Date;
    endedAt: Date;
    shiftLabel: string | null;
} | null> {
    const db = getDb();
    const cutoff = new Date(referenceAt.getTime() - maxWindowMs);

    const regOcc = await db.query.regulationOccupancies.findFirst({
        where: and(
            eq(regulationOccupancies.doctorId, doctorId),
            isNotNull(regulationOccupancies.endedAt),
            gte(regulationOccupancies.endedAt, cutoff),
            lte(regulationOccupancies.endedAt, referenceAt),
        ),
        orderBy: [desc(regulationOccupancies.endedAt)],
    });

    const intOcc = await db.query.interventionOccupancies.findFirst({
        where: and(
            eq(interventionOccupancies.doctorId, doctorId),
            isNotNull(interventionOccupancies.endedAt),
            gte(interventionOccupancies.endedAt, cutoff),
            lte(interventionOccupancies.endedAt, referenceAt),
        ),
        orderBy: [desc(interventionOccupancies.endedAt)],
    });

    const pickRegulation = regOcc && (!intOcc || (regOcc.endedAt && intOcc.endedAt && regOcc.endedAt.getTime() >= intOcc.endedAt.getTime()));
    if (pickRegulation && regOcc?.endedAt) {
        const post = await db.query.regulationPosts.findFirst({ where: eq(regulationPosts.id, regOcc.postId) });
        if (post) {
            return {
                sector: "REGULATION",
                baseCode: post.code,
                occupancyId: regOcc.id,
                startedAt: regOcc.startedAt,
                endedAt: regOcc.endedAt,
                shiftLabel: regOcc.shiftLabel,
            };
        }
    }

    if (intOcc?.endedAt) {
        const base = await db.query.interventionBases.findFirst({ where: eq(interventionBases.id, intOcc.baseId) });
        if (base) {
            return {
                sector: "INTERVENTION",
                baseCode: base.code,
                occupancyId: intOcc.id,
                startedAt: intOcc.startedAt,
                endedAt: intOcc.endedAt,
                shiftLabel: intOcc.shiftLabel,
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
    const activeOcc = await findActiveOccupancyByDoctorId(resolvedDoctor.id, eventAt);
    let recoveredSector: "REGULATION" | "INTERVENTION" | null = activeOcc?.sector ?? null;
    let recoveredBaseCode: string | null = activeOcc?.baseCode ?? null;
    let recoveredShiftLabel: string | null = activeOcc?.shiftLabel ?? null;

    if (!recoveredBaseCode) {
        // rawParsed.isContinuation é garantido true aqui (guard no topo da função).
        const continuityContext = await findTelegramContinuityContext({
            doctorId: resolvedDoctor.id,
            eventAt,
            explicitContinuation: true,
        });
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
async function resolveDepartureWithoutBase(rawParsed: ParsedMessage, messageText: string, senderName: string | null, referenceAt?: Date): Promise<{
    parsed: OperationalParsedEntry;
    resolvedDoctor: ResolvedTelegramDoctorRef;
} | null> {
    if (!rawParsed.isDeparture || rawParsed.baseCode) {
        return null;
    }

    const doctorQuery = rawParsed.extractedNames[0] ?? null;
    const senderFallbackQuery = shouldUseTelegramSenderNameFallback(messageText, senderName) ? senderName : null;
    const lookupQuery = doctorQuery || senderFallbackQuery;
    if (!lookupQuery) {
        return null;
    }

    let resolved = await resolveDoctorWithFallback(lookupQuery);
    // Mensagens multi-linha como "Bom dia informo\nSaida da BR60" deixam
    // resto-de-saudacao (informo, pessoal) como extractedNames[0]. Se essa
    // query nao resolver, cair pro senderName antes de desistir (audit 2026-05).
    if (!resolved.doctor && doctorQuery && senderFallbackQuery && doctorQuery !== senderFallbackQuery) {
        resolved = await resolveDoctorWithFallback(senderFallbackQuery);
    }
    if (!resolved.doctor) {
        return null;
    }

    const activeOcc = await findActiveOccupancyByDoctorId(resolved.doctor.id, referenceAt ?? new Date());
    // Fallback p/ ocupacoes recem-fechadas (audit 2026-05): medico declara
    // saida apos o auto-close, ex.: Jose Marini saida 19:26 com auto-close
    // 19:11. Sem este fallback caia em no_operational_match.
    const fallbackOcc = activeOcc ? null : await findRecentClosedOccupancyByDoctorId(resolved.doctor.id, referenceAt ?? new Date());
    const resolvedOcc = activeOcc ?? fallbackOcc;
    if (!resolvedOcc) {
        return null;
    }

    return {
        parsed: {
            sector: resolvedOcc.sector,
            baseCode: resolvedOcc.baseCode,
            arrivalTime: rawParsed.arrivalTime,
            shiftType: rawParsed.shiftType ?? (resolvedOcc.shiftLabel as ParsedMessage["shiftType"]),
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
        fallback: "médico não identificado",
    });
}

function buildApproximateMatchHint(params: {
    doctorQuery: string | null;
    doctorName: string;
}) {
    if (!params.doctorQuery || isExactDoctorMatch(params.doctorQuery, { fullName: params.doctorName, displayName: params.doctorName })) {
        return "";
    }

    // doctorQuery é texto cru do plantonista — escapa, senão um `*` solto quebra
    // o Markdown do balão inteiro de chegada.
    return `\nSe eu associei "${escapeTelegramMarkdown(params.doctorQuery)}" a ${escapeTelegramMarkdown(params.doctorName)} e não era essa pessoa, me corrija com o nome completo.`;
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

async function tryHandlePendingAlertaConfirmation(update: TelegramUpdate, logId: string) {
    const message = update.message;
    if (!message?.text || !message.from?.id) {
        return null;
    }

    if (!canRunPrivateAdminSlotAudit(message)) {
        return null;
    }

    const pending = await findPendingAlertaConfirmation(String(message.chat.id), String(message.from.id));
    if (!pending || !isPendingAlertaConfirmationData(pending.resolutionData)) {
        return null;
    }

    const pendingData = pending.resolutionData as PendingAlertaConfirmationData;
    const normalizedText = message.text.trim();

    if (isBatchCancelKeyword(normalizedText)) {
        await markTelegramProcessed(pending.id, {
            status: "superseded",
            errorMessage: "alerta_confirmation_cancelled",
        });
        await markTelegramProcessed(logId, {
            status: "accepted",
            parsedAction: "alerta_cancelled",
        });
        await sendMessage(message.chat.id, ":| Alerta cancelado.", message.message_id, REMOVE_KEYBOARD);
        return { ok: true, ignored: true };
    }

    if (!isBatchConfirmationKeyword(normalizedText)) {
        await markTelegramProcessed(logId, {
            status: "ignored",
            parsedAction: "alerta_confirmation_pending",
            errorMessage: "alerta_confirmation_pending",
        });
        await sendMessage(
            message.chat.id,
            ":| Alerta pronto para envio. Responda CONFIRMAR para disparar ou CANCELAR para desistir.",
            message.message_id,
            buildChoiceKeyboard([["✅ CONFIRMAR", "❌ CANCELAR"]]),
        );
        return { ok: true, ignored: true, pending: true };
    }

    const recipientIds = getTelegramRegulationAlertUserIds().length > 0
        ? getTelegramRegulationAlertUserIds()
        : getTelegramChiefUserIds();
    const uniqueRecipients = [...new Set(recipientIds)];
    await Promise.all(uniqueRecipients.map((recipientId) => sendMessage(Number(recipientId), pendingData.alertText)));

    await markTelegramProcessed(pending.id, {
        status: "accepted",
        parsedAction: "alerta_command",
        resolutionData: { alertSent: true, recipientCount: uniqueRecipients.length },
    });
    await markTelegramProcessed(logId, {
        status: "accepted",
        parsedAction: "alerta_confirmed",
        resolutionData: { recipientCount: uniqueRecipients.length },
    });
    await sendMessage(message.chat.id, `✅ Alerta enviado para ${uniqueRecipients.length} destinatário(s).`, message.message_id, REMOVE_KEYBOARD);
    return { ok: true, alerta: true };
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

// Normaliza errorMessage antes de gravar: Drizzle embute o SQL+params no .message
// quando uma UPDATE falha. Se gravarmos isso cru, na proxima tentativa o param
// $errorMessage anterior aparece dentro do novo errorMessage e cresce recursivamente
// (visto em audit 2026-05: linhas com 1KB+ poluindo o log).
function sanitizeErrorMessage(value: unknown): string | null | undefined {
    if (value === null || value === undefined) return value as null | undefined;
    if (typeof value !== "string") return String(value).slice(0, 240);
    const trimmed = value.trim();
    if (!trimmed) return null;
    // Drizzle prefixa erros de query com "Failed query: ..." e dump dos params na linha seguinte.
    const firstLine = trimmed.split(/\r?\n/, 1)[0] ?? trimmed;
    const cleaned = firstLine.startsWith("Failed query:")
        ? "db_update_failed"
        : firstLine;
    return cleaned.slice(0, 240);
}

async function markTelegramProcessed(id: string, patch: Partial<typeof telegramIngestedMessages.$inferInsert>) {
    const db = getDb();
    const normalizedPatch = Object.prototype.hasOwnProperty.call(patch, "errorMessage")
        ? { ...patch, errorMessage: sanitizeErrorMessage(patch.errorMessage) }
        : patch;
    await db.update(telegramIngestedMessages)
        .set({
            ...normalizedPatch,
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
        fallback: "médico não identificado",
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
                : "⚠️ NUCLEO — sem confirmação",
        );
    }
    specialRegulationLines.push(
        piamRow?.status === "active"
            ? `✅ PIAM — ${doctorLabel(piamRow.doctorName, piamRow.displayName)}`
            : "⚠️ PIAM — sem confirmação",
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
            return `⚠️ ${row.baseCode} — sem informação`;
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
        `🚑 USA ${params.shiftLabel} (quem está onde):`,
        interventionLines,
        "",
        "❓ Certeza que não falta alguém?",
        "⚡ Se faltou, avisem agora: Nome + base/ramal + SD/SN/P + horário.",
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

    // Autoatendimento de pagamento: qualquer médico pode consultar o PRÓPRIO
    // pagamento no privado com /pagamento <codinome>. Liberamos só este comando
    // para não-controladores; handleTelegramCommand valida codinome + cooldown e
    // não expõe os subcomandos de admin (conferir/corrigir/codinome/resetar-todos).
    if (isTelegramPaymentAdminCommandText(message.text ?? "")) {
        return true;
    }

    // Cadastro guiado de empresa/CNPJ (/pagamento cadastro) segue com respostas em
    // texto livre (codinome, razão social, CNPJ) que não batem no regex acima — sem
    // isto, um médico comum é barrado no meio do fluxo e cai no fallback do tutorial.
    if (message.from?.id) {
        const pendingProfile = await findPendingPaymentProfile(String(message.chat.id), String(message.from.id));
        if (pendingProfile) {
            return true;
        }
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
        "✅",
        `Atualizei em lote ${params.appliedCount} chegadas pelo bot privado.`,
        `Confiram quadro e horários de chegada em ${appUrl}`,
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
                isNotNull(regulationOccupancies.boardStartedAt),
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
            isNotNull(interventionOccupancies.boardStartedAt),
        ),
        orderBy: [desc(interventionOccupancies.boardStartedAt), desc(interventionOccupancies.startedAt)],
    });
    return { base, occupancy, post: null };
}

// Ocupações que dividem o posto/base com o titular sem estar no quadro: sombra e
// deslocado (board_started_at nulo). Só alcançáveis pelo nome, já que o quadro tem
// um titular por alvo.
async function findOffBoardOccupancyOnTarget(params: {
    sector: "REGULATION" | "INTERVENTION";
    targetId: number;
    doctorId: string;
}) {
    const db = getDb();
    if (params.sector === "REGULATION") {
        return (await db.query.regulationOccupancies.findFirst({
            where: and(
                eq(regulationOccupancies.postId, params.targetId),
                eq(regulationOccupancies.doctorId, params.doctorId),
                isNull(regulationOccupancies.endedAt),
                isNull(regulationOccupancies.boardStartedAt),
            ),
            orderBy: [desc(regulationOccupancies.startedAt)],
        })) ?? null;
    }

    return (await db.query.interventionOccupancies.findFirst({
        where: and(
            eq(interventionOccupancies.baseId, params.targetId),
            eq(interventionOccupancies.doctorId, params.doctorId),
            isNull(interventionOccupancies.endedAt),
            isNull(interventionOccupancies.boardStartedAt),
        ),
        orderBy: [desc(interventionOccupancies.startedAt)],
    })) ?? null;
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
        await sendMessage(message.chat.id, `⛔ ${result.message}`, message.message_id);
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
        await sendMessage(message.chat.id, `⛔ Não encontrei ${isRegulation ? "o ramal" : "a base"} ${command.targetCode} para aplicar ${command.name}.`, message.message_id);
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
            // Anúncio da retirada (com o desfecho da régua) nos chats de anúncio.
            void announceDeactivationDepartures({
                domain: isRegulation ? "regulation" : "intervention",
                targetId: target.id,
                closedOccupancies: result.closedOccupancies,
            });
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
        await sendMessage(message.chat.id, `⛔ Não consegui ${command.name} ${command.targetCode}. ${resolveTelegramErrorText(error)}`, message.message_id);
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
        await sendMessage(message.chat.id, `⛔ ${command.targetCode} não tem ocupação ativa agora. Para apagar um registro já fechado do banco, informe também o médico. Ex.: /remover Aline ${command.targetCode} SD.`, message.message_id);
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
        await sendMessage(message.chat.id, `⛔ Não encontrei registro recente de ${resolved.doctor.fullName} em ${command.targetCode}${command.shiftLabel ? ` no ${command.shiftLabel}` : ""} para apagar.`, message.message_id);
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
        await sendMessage(message.chat.id, `⛔ Achei mais de um registro recente de ${resolved.doctor.fullName} em ${command.targetCode}. Acrescente o turno para apagar o certo. Recentes: ${candidates.map((candidate) => formatHistoricalRemovalReference(candidate)).join(" | ")}.`, message.message_id);
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
    return `⛔ Use ${TELEGRAM_DOCTOR_ADMIN_COMMAND_USAGE}. Para corrigir cadastro existente: /medico atualizar Busca Atual | Nome Completo Correto | Nome de exibição | código | alias 1, alias 2.`;
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

// Empacota um cabeçalho + várias linhas em mensagens do Telegram sob o limite,
// numerando quando há mais de uma.
function chunkTelegramLines(header: string, lines: string[], maxChars = 3500): string[] {
    const chunks: string[] = [];
    let current = header;
    for (const line of lines) {
        const candidate = `${current}\n${line}`;
        if (candidate.length <= maxChars) {
            current = candidate;
            continue;
        }
        chunks.push(current);
        current = line;
    }
    chunks.push(current);
    if (chunks.length <= 1) {
        return chunks;
    }
    const total = chunks.length;
    return chunks.map((chunk, index) => `(${index + 1}/${total})\n${chunk}`);
}

// Rede de segurança da ajuda (auditoria comunicação §5#2): quem pede /ajuda ou
// /comandos nunca pode ficar no silêncio. Se o Telegram rejeitar o balão por
// tamanho ("message is too long"), mandamos um fallback curto. Restrito a esses
// caminhos — NÃO é um catch global do webhook.
async function sendTelegramHelpMessage(chatId: string | number, text: string, replyToMessageId?: number) {
    try {
        await sendMessage(chatId, text, replyToMessageId);
    } catch (error) {
        if (error instanceof Error && error.message.toLowerCase().includes("message is too long")) {
            await sendMessage(
                chatId,
                "⚠️ A lista completa não coube aqui. Me chame no privado ou mande /ajuda.",
                replyToMessageId,
            );
            return;
        }
        throw error;
    }
}

// Tutorial curto de autoatendimento (médico comum no privado): só o que ele pode
// fazer. Usado como resposta a /ajuda e a qualquer mensagem fora do esperado.
function buildPaymentSelfServiceTutorial() {
    return [
        "👋 Aqui você consulta o SEU pagamento.",
        "",
        "Envie o seu codinome assim:",
        "   /pagamento SEU-CODINOME",
        "",
        "Exemplos:",
        "   /pagamento falcao-jade-734       → mês atual",
        "   /pagamento falcao-jade-734 05    → mês 05 (ou: maio)",
        "",
        "Você recebe seus plantões, o total em R$ e o link da folha de ponto. 📄",
        "",
        "Para cadastrar/atualizar empresa e CNPJ da folha:",
        "   /pagamento cadastro",
        "",
        "🔑 Não tem o codinome? Peça à coordenação.",
    ].join("\n");
}

// Copy canônica de entrega de codinome (auditoria §3.4#10): /resetcodinome e
// /pagamento codinome respondem com o MESMO texto. O aviso sobre o anterior só
// aparece quando havia codinome antes.
function buildCodenameDeliveryReply(params: { fullName: string; codename: string; previous: string | null; hadPrevious: boolean }) {
    const lines = [
        `✅ Codinome de ${params.fullName}: ${params.codename}`,
        `Entregue no privado. Para consultar o próprio pagamento, a pessoa manda no privado do bot: /pagamento ${params.codename}`,
        `O codinome também serve para criar a conta no site (com email próprio): https://plantoes.mnrs.com.br/cadastro-medico`,
    ];
    if (params.hadPrevious) {
        lines.push(params.previous
            ? `⚠️ O codinome anterior (${params.previous}) parou de valer.`
            : "⚠️ O codinome anterior parou de valer.");
    }
    return lines.join("\n");
}

function buildPaymentCommandUsageReply(isAdmin: boolean) {
    const lines = [
        "⛔ Não entendi esse /pagamento. Formas de usar (no privado):",
        "",
        "📊 Relatório do mês por médico",
        "   /pagamento",
        "   /pagamento 05   (ou: /pagamento maio)",
        "",
        "🧾 Cadastrar dados da folha (empresa + CNPJ)",
        `   ${TELEGRAM_PAYMENT_PROFILE_SETUP_USAGE}`,
        "",
        "🔎 Conferir um turno",
        "   /pagamento conferir",
        "   /pagamento conferir 2026-04-07 SD",
        "",
        "✏️ Corrigir o médico de um plantão",
        "   /pagamento corrigir PM04 | Karen | 2026-04-07 | SD | motivo",
        "",
        "🪪 Codinome de UM médico (autoatendimento)",
        "   /pagamento codinome João Silva",
    ];
    if (isAdmin) {
        lines.push(
            "",
            "🔐 Resetar TODOS os codinomes (admin)",
            "   /pagamento resetar-todos",
            "   depois: /pagamento resetar-todos CONFIRMO",
        );
    }
    return lines.join("\n");
}

function buildDepartureReportCommandUsageReply() {
    return `⛔ Use ${TELEGRAM_DEPARTURE_REPORT_USAGE}. Se mandar só /saidas, eu trago o turno anterior.`;
}

function buildShiftReportCommandUsageReply() {
    return "⛔ Use /plantao para pedir o relato do turno atual. Se quiser, pode escrever /plantao agora, mas não precisa de mais nada.";
}

function buildSummaryReportCommandUsageReply() {
    return `⛔ Use ${TELEGRAM_SUMMARY_REPORT_USAGE}. Se quiser, pode escrever /resumo agora, mas não precisa de mais nada.`;
}

export function buildPublicTelegramCommandHelpReply() {
    return [
        "⚠️ Não reconheci esse comando.",
        "",
        "Comandos disponíveis para qualquer pessoa:",
        "• /plantao -> mostra o relato do turno atual (quem está em cada base e ramal).",
        "• /resumo -> mostra um resumo rápido da operação (contagens e status geral).",
        "• /saidas -> mostra o relatório de saídas do turno (quem saiu e horários).",
        "• /ajuda -> guia rápido com os formatos de chegada e saída.",
    ].join("\n");
}

// Comandos reais aceitos pelo bot (sem a barra), usados no fuzzy do fallback de
// comando desconhecido (auditoria comunicação §3.4#1 / §5#5).
const KNOWN_TELEGRAM_COMMANDS = [
    "plantao", "resumo", "saidas", "prioridadesaida", "prioridade", "ajuda", "help",
    "comandos", "cobrar", "lembretes", "status", "meuturno", "almoco", "jantar",
    "excluir", "incluir", "corrigir", "corrigirsaida", "retirar", "remover", "ramal",
    "ativar", "desativar", "ontem", "hoje", "pagamento", "resetcodinome", "rc",
    "desfazer", "slots", "medico", "piam", "banco", "alerta", "saiu", "saindo", "saida",
];

// Aliases/erros de digitação frequentes → comando real. Resolvidos ANTES do fuzzy
// para evitar colisões (ex.: "ordem" está a 2 edições de "ontem").
// NÃO mapear /saida → /prioridadesaida: /saida é alias documentado de /retirar.
const TELEGRAM_COMMAND_TYPO_ALIASES: Record<string, string> = {
    refazerjantar: "jantar",
    ordemdesaida: "prioridadesaida",
    ordem: "prioridadesaida",
    prioridadesaidas: "prioridadesaida",
    plantoa: "plantao",
};

// Sugere o comando real mais próximo para um "/comando" desconhecido: primeiro o
// mapa de aliases, depois Levenshtein ≤ 2 contra a lista de comandos reais.
// Retorna null quando o token já é um comando conhecido (falhou por outro motivo)
// ou quando nada fica perto o suficiente.
export function suggestTelegramCommandForTypo(rawText: string): string | null {
    const firstToken = rawText.trim().split(/\s+/)[0] ?? "";
    if (!firstToken.startsWith("/")) {
        return null;
    }
    const token = firstToken
        .slice(1)
        .replace(/@\w+$/, "")
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase();
    if (!token) {
        return null;
    }

    // /janta, /jantando, /jantarr... → /jantar (mesma tolerância do parser de refeição).
    if (token !== "jantar" && /^jant\w*$/.test(token)) {
        return "/jantar";
    }

    const alias = TELEGRAM_COMMAND_TYPO_ALIASES[token];
    if (alias) {
        return `/${alias}`;
    }

    if (KNOWN_TELEGRAM_COMMANDS.includes(token)) {
        return null;
    }

    let best: { command: string; distance: number } | null = null;
    for (const command of KNOWN_TELEGRAM_COMMANDS) {
        const distance = computeLevenshteinDistance(token, command);
        if (distance <= 2 && (!best || distance < best.distance)) {
            best = { command, distance };
        }
    }
    return best ? `/${best.command}` : null;
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
    return `⛔ Use ${TELEGRAM_BANK_HOURS_USAGE}. Ex.: /banco Aline SN 0`;
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

    // User-facing por definição (auditoria §3.4#6): o mold do /banco pode ecoar.
    throw new TelegramUserFacingError(`Nao encontrei um plantao ${targetShiftLabel} encerrado para revisar o banco.`);
}

async function sendTelegramReplyBatch(
    chatId: string | number,
    texts: string[],
    replyToMessageId?: number,
    session?: Parameters<typeof buildMealBreakStageKeyboard>[0] | null,
    options?: TelegramFormatOptions,
) {
    await sendTelegramMealBreakMessages({
        chatId,
        messages: texts,
        replyToMessageId,
        replyMarkup: session ? (buildMealBreakStageKeyboard(session) ?? undefined) : undefined,
        options,
    });
}

// Falha TÉCNICA no fluxo de refeição (não é erro de negócio user-facing): o
// grupo já recebeu a mensagem genérica curta; o detalhe cru vai só para o
// privado dos admins.
async function alertAdminsOnMealBreakTechnicalError(context: string, error: unknown) {
    const technicalDetail = resolveMealBreakTechnicalErrorDetail(error);
    if (!technicalDetail) {
        return;
    }
    await sendPrivateAdminAlert(`⚠️ Falha técnica no fluxo de refeição (${context}): ${technicalDetail}`);
}

async function sendPrivateAdminAlert(text: string, excludeChatIds: string[] = []) {
    const adminChatIds = [...new Set(getTelegramAdminUserIds())].filter((chatId) => chatId && !excludeChatIds.includes(chatId));
    if (adminChatIds.length === 0) {
        return;
    }

    await Promise.allSettled(adminChatIds.map((chatId) => sendMessage(chatId, text)));
}

// Aviso no privado da CHEFIA (TELEGRAM_CHIEF_IDS), mesmo padrão do sendPrivateAdminAlert.
// Só chega a chefe que já abriu conversa com o bot — limitação conhecida do Telegram.
async function sendPrivateChiefAlert(text: string, options?: TelegramFormatOptions) {
    const chiefChatIds = [...new Set(getTelegramChiefUserIds())].filter(Boolean);
    if (chiefChatIds.length === 0) {
        return;
    }

    await Promise.allSettled(chiefChatIds.map((chatId) => sendMessage(chatId, text, undefined, undefined, options)));
}

// Botão-url para o privado do bot (auditoria §3.4#9): usado nos redirecionamentos
// de /pagamento e /resetcodinome no grupo. Null quando o username não está
// disponível (sem env e getMe falhou) — aí o texto atual segue sozinho.
async function buildOpenBotPrivateChatKeyboard(): Promise<TelegramReplyMarkup | undefined> {
    try {
        const username = await getBotUsername();
        return buildInlineKeyboard([[{ text: "💬 Abrir o privado do bot", url: `https://t.me/${username}` }]]);
    } catch {
        return undefined;
    }
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

export function buildPaymentAllocationReportLine(row: PaymentAllocationRow, domainTag?: string) {
    const tag = domainTag ? `${domainTag} ` : "";
    if (row.disabledEntireShift) {
        return `DSV ${tag}${row.targetCode} - desativada`;
    }

    if (!row.occupancyId) {
        return `VAZ ${tag}${row.targetCode} - sem ocupação`;
    }

    const name = formatDoctorSurfaceName({
        fullName: row.doctorName,
        displayName: row.displayName,
        fallback: "médico não identificado",
    });
    const halfTag = isHalfShiftRoleLabel(row.roleLabel) ? " [MEIO]" : "";
    const conflictDetail = row.hasDoctorOverlapConflict && row.conflictCandidateLabels.length > 0
        ? ` | conflito titulares: ${row.conflictCandidateLabels.join(" x ")}`
        : "";
    if (row.paymentStatus === "ready_for_payment") {
        return `OK ${tag}${row.targetCode} - ${name}${halfTag}`;
    }

    return `REV ${tag}${row.targetCode} - ${name}${halfTag} | ${summarizePaymentAllocationIssues(row.issues)}${conflictDetail}`;
}

// Conferência de pagamento REV-first (auditoria §3.4#8): o que precisa de ação vem
// PRIMEIRO, com legenda dos códigos e chunking ≤3.500. Mantém 1 linha por entrada
// pronta com nome + [MEIO] (é o dado que o comando confere) e o bucket de desativadas.
export function buildPaymentAllocationReportMessages(board: PaymentAllocationBoard): string[] {
    const rows = [
        ...board.regulation.map((row) => ({ row, domainTag: "☎️" })),
        ...board.intervention.map((row) => ({ row, domainTag: "🚑" })),
    ];
    const review = rows.filter(({ row }) => !row.disabledEntireShift && row.occupancyId && row.paymentStatus !== "ready_for_payment");
    const ready = rows.filter(({ row }) => !row.disabledEntireShift && row.occupancyId && row.paymentStatus === "ready_for_payment");
    const empty = rows.filter(({ row }) => !row.disabledEntireShift && !row.occupancyId);
    const disabled = rows.filter(({ row }) => row.disabledEntireShift);

    const header = [
        `🔎 Conferência de pagamento ${formatPaymentAllocationDateLabel(board.operationalDate)} ${board.shiftLabel}`,
        `Revisar ${board.summary.needsReviewCount} | prontos ${board.summary.readyForPaymentCount} | vazios ${board.summary.unassignedCount} | desativadas ${board.summary.disabledCount ?? 0}`,
        "Legenda: REV = revisar antes de pagar · OK = pronto · VAZ = sem ocupação · DSV = desativada · [MEIO] = meio plantão · ☎️ regulação · 🚑 intervenção",
    ].join("\n");

    const lines: string[] = [];
    if (review.length > 0) {
        lines.push("", `REVISAR PRIMEIRO (${review.length}):`);
        lines.push(...review.map(({ row, domainTag }) => buildPaymentAllocationReportLine(row, domainTag)));
    }
    if (ready.length > 0) {
        lines.push("", `Prontos (${ready.length}):`);
        lines.push(...ready.map(({ row, domainTag }) => buildPaymentAllocationReportLine(row, domainTag)));
    }
    if (empty.length > 0) {
        lines.push("", `Sem ocupação (${empty.length}):`);
        lines.push(...empty.map(({ row, domainTag }) => buildPaymentAllocationReportLine(row, domainTag)));
    }
    if (disabled.length > 0) {
        lines.push("", `Desativadas (${disabled.length}):`);
        lines.push(...disabled.map(({ row, domainTag }) => buildPaymentAllocationReportLine(row, domainTag)));
    }

    return chunkTelegramLines(header, lines);
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
            await sendMessage(message.chat.id, `⛔ Use ${TELEGRAM_SLOT_AUDIT_USAGE}. Sem argumentos eu trago os últimos 7 dias.`, message.message_id);
            return { ok: true, ignored: true };
        }

        if (!canRunPrivateAdminSlotAudit(message)) {
            await markTelegramProcessed(logId, {
                status: "ignored",
                errorMessage: "slot_audit_private_admin_forbidden",
                parsedAction: "slot_audit_command",
                resolutionData: { rawCommand: message.text },
            });
            await sendMessage(message.chat.id, "⛔ Auditoria de slots só roda no privado para o admin configurado do bot.", message.message_id);
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
            await sendMessage(message.chat.id, error instanceof Error ? error.message : `⛔ Use ${TELEGRAM_SLOT_AUDIT_USAGE}.`, message.message_id);
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
            await sendMessage(message.chat.id, "⛔ Apenas chefes e admins podem excluir ou incluir médicos na divisão.", message.message_id);
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
            await sendTelegramReplyBatch(message.chat.id, result.messages, message.message_id, undefined, MEAL_BREAK_FORMAT_OPTIONS);
            return { ok: true, mealBreakExclude: true };
        } catch (error) {
            await markTelegramProcessed(logId, {
                status: "error",
                errorMessage: error instanceof Error ? error.message : "meal_break_exclude_failed",
                parsedAction: "meal_break_exclude_command",
                resolutionData: { rawCommand: message.text },
            });
            await sendMessage(message.chat.id, buildMealBreakErrorReply(error), message.message_id);
            await alertAdminsOnMealBreakTechnicalError("/excluir|/incluir", error);
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
            await sendTelegramReplyBatch(message.chat.id, result.messages, message.message_id, undefined, MEAL_BREAK_FORMAT_OPTIONS);
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
            await alertAdminsOnMealBreakTechnicalError("/prioridade", error);
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
            await sendMessage(message.chat.id, "⛔ Almoço e jantar no privado ficam restritos a usuários admin do bot. No grupo, a divisão continua aberta aos demais participantes.", message.message_id);
            return { ok: true, ignored: true };
        }

        try {
            const result = await runTelegramMealBreakCommand({
                chatId: String(message.chat.id),
                referenceAt: new Date(message.date * 1000),
                trigger: "manual",
                mode: mealBreakCommand.mode,
                forceRestart: mealBreakCommand.forceRestart,
                action: mealBreakCommand.action,
                restorePosition: mealBreakCommand.restorePosition,
                actorTelegramId: resolveTelegramMealBreakSenderId(update),
            });

            await markTelegramProcessed(logId, {
                status: "accepted",
                parsedAction: "meal_break_command",
                resolutionData: {
                    commandName: mealBreakCommand.name,
                    mealBreakMode: mealBreakCommand.mode,
                    forceRestart: mealBreakCommand.forceRestart,
                    mealBreakAction: mealBreakCommand.action,
                    restorePosition: mealBreakCommand.restorePosition,
                    resultStatus: result.status,
                    ...resolveMealBreakLogDetails(result.session),
                },
            });
            await sendTelegramReplyBatch(message.chat.id, result.messages, message.message_id, result.session, MEAL_BREAK_FORMAT_OPTIONS);
            return { ok: true, mealBreak: true };
        } catch (error) {
            await markTelegramProcessed(logId, {
                status: "error",
                errorMessage: error instanceof Error ? error.message : "meal_break_command_failed",
                parsedAction: "meal_break_command",
                resolutionData: { rawCommand: message.text },
            });
            await sendMessage(message.chat.id, buildMealBreakErrorReply(error), message.message_id);
            await alertAdminsOnMealBreakTechnicalError("/almoco|/jantar", error);
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
            await sendMessage(message.chat.id, "⛔ O comando /desfazer fica restrito a admin.", message.message_id);
            return { ok: true, ignored: true };
        }

        if (message.chat.type !== "private") {
            await markTelegramProcessed(logId, {
                status: "ignored",
                errorMessage: "undo_command_private_only",
                parsedAction: "undo",
                resolutionData: { rawCommand: message.text },
            });
            await sendMessage(message.chat.id, "⛔ O /desfazer funciona só no privado do bot.", message.message_id);
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
            await sendMessage(message.chat.id, "⛔ Esse comando de diretório fica restrito a admin.", message.message_id);
            return { ok: true, ignored: true };
        }

        if (message.chat.type !== "private") {
            await markTelegramProcessed(logId, {
                status: "ignored",
                errorMessage: "doctor_command_private_only",
                parsedAction: "doctor_create",
                resolutionData: { commandBody: doctorDirectoryCommand?.rawBody ?? message.text },
            });
            await sendMessage(message.chat.id, "⛔ Cadastro de médico pelo Telegram fica só no privado do bot, para evitar ruído no grupo.", message.message_id);
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
                        `⛔ Não achei médico com "${doctorDirectoryCommand.lookup}" para atualizar.`,
                        message.message_id,
                    );
                    return { ok: true, ignored: true };
                }

                if (result.status === "ambiguous") {
                    await sendMessage(
                        message.chat.id,
                        [
                            `⛔ Achei mais de um médico para "${doctorDirectoryCommand.lookup}".`,
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
                        ? `✅ Diretório atualizado. Corrigi ${resolveTelegramDoctorSurfaceName(result.doctor)}${buildDoctorDirectorySummary(result.doctor)}.`
                        : `✅ Diretório atualizado. Reativei e corrigi ${resolveTelegramDoctorSurfaceName(result.doctor)}${buildDoctorDirectorySummary(result.doctor)}.`,
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
                    ? `✅ Diretório atualizado. Criei ${result.doctor.fullName}${buildDoctorDirectorySummary(result.doctor)}.`
                    : `✅ Diretório atualizado. Reativei ${result.doctor.fullName}${buildDoctorDirectorySummary(result.doctor)}.`,
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
                `⛔ Não consegui atualizar esse médico. ${resolveTelegramErrorText(error)}`,
                message.message_id,
            );
            return { ok: true, ignored: true };
        }
    }

    if (isTelegramRoleCommandText(message.text)) {
        const commandConfig = resolveTelegramRoleCommandConfig(message.text)!;
        const commandName = commandConfig.command;
        const actor = await resolveTelegramCommandActor(message);
        if (!actor || !actor.roles.includes("admin")) {
            await markTelegramProcessed(logId, {
                status: "ignored",
                errorMessage: `${commandName}_command_forbidden`,
                parsedAction: `${commandName}_command`,
                resolutionData: { rawCommand: message.text },
            });
            await sendMessage(message.chat.id, `⛔ /${commandName} fica restrito a admin.`, message.message_id);
            return { ok: true, ignored: true };
        }

        const roleCommand = parseTelegramRoleCommand(message.text);
        if (!roleCommand) {
            await markTelegramProcessed(logId, {
                status: "ignored",
                errorMessage: `${commandName}_command_usage_invalid`,
                parsedAction: `${commandName}_command`,
                resolutionData: { rawCommand: message.text },
            });
            await sendMessage(message.chat.id, `⛔ Uso: ${commandConfig.usage}`, message.message_id);
            return { ok: true, ignored: true };
        }

        const parsedAction = `${commandName}_${roleCommand.action}`;

        try {
            if (roleCommand.action === "list") {
                const roleDoctors = await listDoctorsByPreferredOperationalRole(commandConfig.role);
                await markTelegramProcessed(logId, {
                    status: "accepted",
                    parsedAction,
                    resolutionData: { actorRoles: actor.roles, count: roleDoctors.length },
                });
                if (roleDoctors.length === 0) {
                    await sendMessage(message.chat.id, commandConfig.listEmptyText, message.message_id);
                } else {
                    const lines = roleDoctors.map((doctor, index) =>
                        `${index + 1}. ${doctor.displayName?.trim() || doctor.fullName}`,
                    );
                    await sendMessage(
                        message.chat.id,
                        [commandConfig.listHeading(roleDoctors.length), ...lines].join("\n"),
                        message.message_id,
                    );
                }
                return { ok: true };
            }

            const nextRole = roleCommand.action === "assign" ? commandConfig.role : null;
            const result = await setDoctorPreferredOperationalRole({
                lookup: roleCommand.lookup,
                role: nextRole,
            }, {
                actorUserId: actor.userId,
                source: "telegram_command",
                details: {
                    telegramActorId: actor.senderTelegramId,
                    telegramActorName: actor.senderName,
                    telegramCommand: message.text,
                },
            });

            if (result.status === "not_found") {
                await markTelegramProcessed(logId, {
                    status: "ignored",
                    errorMessage: `${commandName}_doctor_not_found`,
                    parsedAction,
                    resolutionData: { actorRoles: actor.roles, lookup: roleCommand.lookup },
                });
                await sendMessage(message.chat.id, `⛔ Não achei médico com "${roleCommand.lookup}".`, message.message_id);
                return { ok: true, ignored: true };
            }

            if (result.status === "ambiguous") {
                await markTelegramProcessed(logId, {
                    status: "ignored",
                    errorMessage: `${commandName}_doctor_ambiguous`,
                    parsedAction,
                    resolutionData: { actorRoles: actor.roles, lookup: roleCommand.lookup, matches: result.matches },
                });
                await sendMessage(
                    message.chat.id,
                    [
                        `⛔ Achei mais de um médico para "${roleCommand.lookup}".`,
                        ...result.matches.map((doctor, index) => `${index + 1}. ${doctor.fullName}`),
                        "",
                        "Use o nome completo.",
                    ].join("\n"),
                    message.message_id,
                );
                return { ok: true, ignored: true };
            }

            await markTelegramProcessed(logId, {
                status: "accepted",
                parsedAction,
                parsedDoctorName: result.doctor.fullName,
                resolutionData: {
                    actorRoles: actor.roles,
                    previousRole: result.previousRole,
                    nextRole: result.nextRole,
                },
            });

            if (result.status === "unchanged") {
                const stateText = roleCommand.action === "assign"
                    ? commandConfig.alreadyAssignedText(result.doctor.fullName)
                    : commandConfig.alreadyUnassignedText(result.doctor.fullName);
                await sendMessage(message.chat.id, `:| ${stateText}`, message.message_id);
                return { ok: true, doctorId: result.doctor.id };
            }

            const reply = roleCommand.action === "assign"
                ? commandConfig.assignReply(result.doctor.fullName)
                : commandConfig.unassignReply(result.doctor.fullName);
            await sendMessage(message.chat.id, reply, message.message_id);
            return { ok: true, doctorId: result.doctor.id };
        } catch (error) {
            await markTelegramProcessed(logId, {
                status: "error",
                errorMessage: error instanceof Error ? error.message : `${commandName}_command_failed`,
                parsedAction,
                resolutionData: { rawCommand: message.text },
            });
            await sendMessage(
                message.chat.id,
                `⛔ Não consegui aplicar /${commandName}. ${resolveTelegramErrorText(error)}`,
                message.message_id,
            );
            return { ok: true, ignored: true };
        }
    }

    if (isTelegramResetCodinomeCommandText(message.text)) {
        if (message.chat.type !== "private") {
            await markTelegramProcessed(logId, { status: "ignored", errorMessage: "reset_codinome_private_only", parsedAction: "reset_codinome" });
            // Botão-url para o privado (auditoria §3.4#9); sem username, só o texto.
            await sendMessage(
                message.chat.id,
                "⛔ /rc fica no privado do bot.",
                message.message_id,
                await buildOpenBotPrivateChatKeyboard(),
            );
            return { ok: true, ignored: true };
        }
        const actor = await resolveTelegramCommandActor(message);
        if (!actor || !actor.roles.some((role) => role === "admin" || role === "chief")) {
            await markTelegramProcessed(logId, { status: "ignored", errorMessage: "reset_codinome_forbidden", parsedAction: "reset_codinome" });
            await sendMessage(message.chat.id, "⛔ /rc é exclusivo de admin/chefia.", message.message_id);
            return { ok: true, ignored: true };
        }
        const resetCmd = parseTelegramResetCodinomeCommand(message.text);
        if (!resetCmd) {
            await markTelegramProcessed(logId, { status: "ignored", errorMessage: "reset_codinome_usage", parsedAction: "reset_codinome" });
            await sendMessage(message.chat.id, `⛔ Use: ${TELEGRAM_RESET_CODINOME_USAGE}`, message.message_id);
            return { ok: true, ignored: true };
        }
        try {
            // Resolve por codinome atual primeiro; se não achar, por nome completo.
            let doctorId = await resolveDoctorIdByCodename(resetCmd.query);
            if (!doctorId) {
                const { doctor, candidates } = await resolveDoctorWithFallback(resetCmd.query);
                if (!doctor) {
                    await markTelegramProcessed(logId, {
                        status: "ignored",
                        errorMessage: "reset_codinome_not_resolved",
                        parsedAction: "reset_codinome",
                        resolutionData: { query: resetCmd.query, candidates: candidates.slice(0, 3) },
                    });
                    await sendMessage(message.chat.id, buildNameUnresolvedReply(message.message_id, candidates), message.message_id);
                    return { ok: true, ignored: true };
                }
                doctorId = doctor.id;
            }
            const result = await resetDoctorCodename(doctorId);
            await markTelegramProcessed(logId, {
                status: "accepted",
                parsedAction: "reset_codinome",
                parsedDoctorName: result.fullName,
                resolutionData: { actorRoles: actor.roles, doctorId },
            });
            await sendMessage(message.chat.id, buildCodenameDeliveryReply(result), message.message_id);
            return { ok: true, reported: true };
        } catch (error) {
            await markTelegramProcessed(logId, {
                status: "error",
                errorMessage: error instanceof Error ? error.message : "reset_codinome_failed",
                parsedAction: "reset_codinome",
            });
            await sendMessage(message.chat.id, `⛔ Não consegui resetar o codinome. ${resolveTelegramErrorText(error)}`, message.message_id);
            return { ok: true, ignored: true };
        }
    }

    const paymentCommand = parseTelegramPaymentAdminCommand(message.text);
    if (paymentCommand || isTelegramPaymentAdminCommandText(message.text)) {
        if (message.chat.type !== "private") {
            await markTelegramProcessed(logId, {
                status: "ignored",
                errorMessage: "payment_command_private_only",
                parsedAction: paymentCommand?.name ?? "payment_command",
                resolutionData: { rawCommand: message.text },
            });
            // Botão-url para o privado (auditoria §3.4#9); sem username, só o texto.
            await sendMessage(
                message.chat.id,
                "⛔ /pagamento fica no privado do bot, para não poluir o grupo operacional.",
                message.message_id,
                await buildOpenBotPrivateChatKeyboard(),
            );
            return { ok: true, ignored: true };
        }

        const actor = await resolveTelegramCommandActor(message);
        if (!actor || !actor.roles.some((role) => role === "admin" || role === "chief")) {
            // Médico comum: autoatendimento por codinome (consulta o próprio pagamento).
            const fromId = message.from?.id ? String(message.from.id) : null;
            if (!fromId) {
                await markTelegramProcessed(logId, { status: "ignored", errorMessage: "payment_self_no_sender", parsedAction: "payment_self" });
                await sendMessage(message.chat.id, "⛔ Não consegui identificar sua conta de Telegram.", message.message_id);
                return { ok: true, ignored: true };
            }

            const profileSetupCommand = parseTelegramPaymentProfileSetupCommand(message.text);
            if (profileSetupCommand) {
                await supersedePendingPaymentProfile(String(message.chat.id), fromId, "payment_profile_restarted");

                if (profileSetupCommand.codename) {
                    const lock = await checkAttemptLock(fromId);
                    if (lock.locked) {
                        await markTelegramProcessed(logId, { status: "ignored", errorMessage: "payment_profile_locked", parsedAction: "payment_profile_setup" });
                        await sendMessage(message.chat.id, ":/ Muitas tentativas com codinome incorreto. Aguarde um pouco e tente de novo, ou peça um novo codinome à coordenação.", message.message_id);
                        return { ok: true, ignored: true };
                    }

                    const doctorId = await resolveDoctorIdByCodename(profileSetupCommand.codename);
                    if (!doctorId) {
                        const next = await registerFailedAttempt(fromId);
                        await markTelegramProcessed(logId, {
                            status: "pending_payment_profile",
                            parsedAction: "payment_profile_setup",
                            errorMessage: "payment_profile_codename_invalid",
                            resolutionData: { stage: "awaiting_codename" },
                        });
                        const suffix = next.locked ? " Você excedeu as tentativas; aguarde antes de tentar de novo." : "";
                        await sendMessage(message.chat.id, `:/ Codinome não confere.${suffix}\nEnvie seu codinome para continuar.`, message.message_id);
                        return { ok: true, ignored: true, pending: true };
                    }

                    await clearAttempts(fromId);
                    const companyStepPrompt = await buildCompanyNameStepPrompt(doctorId);
                    await markTelegramProcessed(logId, {
                        status: "pending_payment_profile",
                        parsedAction: "payment_profile_setup",
                        errorMessage: null,
                        resolutionData: {
                            stage: companyStepPrompt.stage,
                            doctorId,
                            ...companyStepPrompt.extra,
                        },
                    });
                    await sendMessage(message.chat.id, companyStepPrompt.text, message.message_id, companyStepPrompt.replyMarkup);
                    return { ok: true, pending: true };
                }

                await markTelegramProcessed(logId, {
                    status: "pending_payment_profile",
                    parsedAction: "payment_profile_setup",
                    errorMessage: null,
                    resolutionData: {
                        stage: "awaiting_codename",
                    },
                });
                await sendMessage(
                    message.chat.id,
                    [
                        "🙂 Vamos cadastrar os dados da sua folha de ponto.",
                        "Responda com seu *codinome* para eu identificar seu cadastro.",
                        "Se quiser cancelar, envie CANCELAR.",
                    ].join("\n"),
                    message.message_id,
                );
                return { ok: true, pending: true };
            }

            const lock = await checkAttemptLock(fromId);
            if (lock.locked) {
                await markTelegramProcessed(logId, { status: "ignored", errorMessage: "payment_self_locked", parsedAction: "payment_self" });
                // Comunica QUANDO destrava (horário de SP), em vez de "aguarde um pouco".
                await sendMessage(
                    message.chat.id,
                    lock.lockedUntil
                        ? `⛔ Tentativas esgotadas. Libera às *${formatTelegramReplyTime(lock.lockedUntil)}*.`
                        : "⛔ Tentativas esgotadas. Tente de novo em 1h.",
                    message.message_id,
                );
                return { ok: true, ignored: true };
            }

            const selfCommand = parseTelegramPaymentSelfServiceCommand(message.text);
            if (!selfCommand || !selfCommand.codename) {
                await markTelegramProcessed(logId, { status: "ignored", errorMessage: "payment_self_identify", parsedAction: "payment_self" });
                await sendMessage(message.chat.id, buildPaymentSelfServiceTutorial(), message.message_id);
                return { ok: true, ignored: true };
            }

            const selfDoctorId = await resolveDoctorIdByCodename(selfCommand.codename);
            if (!selfDoctorId) {
                const next = await registerFailedAttempt(fromId);
                await markTelegramProcessed(logId, { status: "ignored", errorMessage: "payment_self_codename_invalid", parsedAction: "payment_self" });
                // Regras de cooldown em payment-access.ts:9-11 (5 tentativas / trava de 1h),
                // agora comunicadas: contador de tentativas e horário de liberação (SP).
                const reply = next.locked
                    ? `⛔ Codinome não confere. Tentativas esgotadas — libera às *${next.lockedUntil ? formatTelegramReplyTime(next.lockedUntil) : "daqui a 1h"}*.`
                    : `⛔ Codinome não confere — tentativa *${next.failedCount} de ${ATTEMPT_LIMIT}* (na ${ATTEMPT_LIMIT}ª, trava por 1h).`;
                await sendMessage(message.chat.id, reply, message.message_id);
                return { ok: true, ignored: true };
            }

            try {
                await clearAttempts(fromId);
                const board = await getChiefPayableShiftsBoard(selfCommand.monthKey);
                const [yearStr, monthStr] = board.monthKey.split("-");
                const year = Number(yearStr);
                const month = Number(monthStr);
                const appUrl = (process.env.AUTH_URL?.trim() || "https://plantoes.mnrs.com.br").replace(/\/$/, "");
                const folhaToken = createFolhaToken({ medicoId: selfDoctorId, ano: year, mes: month });
                const folhaUrl = `${appUrl}/folha-ponto/${selfDoctorId}/${year}/${String(month).padStart(2, "0")}?t=${folhaToken}`;
                // Mesmo token assina a visão do banco de horas do próprio médico.
                const bankHoursUrl = `${appUrl}/banco-de-horas/${selfDoctorId}/${year}/${String(month).padStart(2, "0")}?t=${folhaToken}`;

                await markTelegramProcessed(logId, {
                    status: "accepted",
                    parsedAction: "payment_self",
                    resolutionData: { doctorId: selfDoctorId, monthKey: board.monthKey },
                });

                const row = board.doctors.find((doctor) => doctor.doctorId === selfDoctorId);
                if (!row) {
                    // Variante vazia unificada (auditoria §3.4#7): sem link de folha vazia.
                    await sendMessage(message.chat.id, buildDoctorPayrollEmptyMessage(board.monthLabel), message.message_id);
                    return { ok: true, reported: true };
                }

                const messages = buildDoctorPayrollMessages(row, board, folhaUrl, bankHoursUrl);
                for (const [index, text] of messages.entries()) {
                    await sendMessage(message.chat.id, text, index === 0 ? message.message_id : undefined);
                }
                return { ok: true, reported: true };
            } catch (error) {
                await markTelegramProcessed(logId, {
                    status: "error",
                    errorMessage: error instanceof Error ? error.message : "payment_self_failed",
                    parsedAction: "payment_self",
                });
                await sendMessage(message.chat.id, `⛔ Não consegui montar o seu pagamento. ${resolveTelegramErrorText(error)}`, message.message_id);
                return { ok: true, ignored: true };
            }
        }

        const profileSetupCommand = parseTelegramPaymentProfileSetupCommand(message.text);
        if (profileSetupCommand) {
            if (!profileSetupCommand.codename) {
                await markTelegramProcessed(logId, {
                    status: "ignored",
                    errorMessage: "payment_profile_admin_missing_codename",
                    parsedAction: "payment_profile_setup",
                    resolutionData: { actorRoles: actor.roles },
                });
                await sendMessage(
                    message.chat.id,
                    `:/ Para cadastro fiscal como admin, use ${TELEGRAM_PAYMENT_PROFILE_SETUP_USAGE}. Ex.: /pagamento cadastro falcao-jade-734`,
                    message.message_id,
                );
                return { ok: true, ignored: true };
            }

            const doctorId = await resolveDoctorIdByCodename(profileSetupCommand.codename);
            if (!doctorId) {
                await markTelegramProcessed(logId, {
                    status: "ignored",
                    errorMessage: "payment_profile_codename_invalid",
                    parsedAction: "payment_profile_setup",
                    resolutionData: { actorRoles: actor.roles },
                });
                await sendMessage(message.chat.id, ":/ Codinome não confere. Confirme o codinome do médico e tente novamente.", message.message_id);
                return { ok: true, ignored: true };
            }

            const senderId = message.from?.id ? String(message.from.id) : null;
            if (senderId) {
                await supersedePendingPaymentProfile(String(message.chat.id), senderId, "payment_profile_restarted");
            }

            const adminCompanyStepPrompt = await buildCompanyNameStepPrompt(doctorId);
            await markTelegramProcessed(logId, {
                status: "pending_payment_profile",
                parsedAction: "payment_profile_setup",
                errorMessage: null,
                resolutionData: {
                    actorRoles: actor.roles,
                    stage: adminCompanyStepPrompt.stage,
                    doctorId,
                    ...adminCompanyStepPrompt.extra,
                },
            });
            await sendMessage(message.chat.id, adminCompanyStepPrompt.text, message.message_id, adminCompanyStepPrompt.replyMarkup);
            return { ok: true, pending: true };
        }

        if (parseTelegramPaymentListCommand(message.text)) {
            if (!actor.roles.includes("admin")) {
                await markTelegramProcessed(logId, { status: "ignored", errorMessage: "payment_list_forbidden", parsedAction: "payment_list" });
                await sendMessage(message.chat.id, "⛔ /pagamento listar é exclusivo de admin.", message.message_id);
                return { ok: true, ignored: true };
            }
            try {
                const all = await listDoctorCodenames();
                await markTelegramProcessed(logId, { status: "accepted", parsedAction: "payment_list", resolutionData: { count: all.length } });
                const header = `📋 Codinomes (${all.length} médicos)\n"(sem registro)" = codinome antigo, de antes de eu guardar o texto — para gerar um novo, use /rc Nome Completo.`;
                const lines = all.map((r) => `${r.fullName} — ${r.codename ?? "(sem registro)"}`);
                const messages = chunkTelegramLines(header, lines);
                for (const [index, text] of messages.entries()) {
                    await sendMessage(message.chat.id, text, index === 0 ? message.message_id : undefined);
                }
                return { ok: true, reported: true };
            } catch (error) {
                await markTelegramProcessed(logId, { status: "error", errorMessage: error instanceof Error ? error.message : "payment_list_failed", parsedAction: "payment_list" });
                await sendMessage(message.chat.id, `⛔ Não consegui listar os codinomes. ${resolveTelegramErrorText(error)}`, message.message_id);
                return { ok: true, ignored: true };
            }
        }

        const resetAllCommand = parseTelegramPaymentResetAllCommand(message.text);
        if (resetAllCommand) {
            if (!actor.roles.includes("admin")) {
                await markTelegramProcessed(logId, { status: "ignored", errorMessage: "payment_reset_all_forbidden", parsedAction: "payment_reset_all" });
                await sendMessage(message.chat.id, "⛔ /pagamento resetar-todos é exclusivo de admin do bot.", message.message_id);
                return { ok: true, ignored: true };
            }
            if (!resetAllCommand.confirmed) {
                // Confirmação destrutiva com botões + contagem (auditoria §3.4#15):
                // expira em 5 min, re-valida admin no callback e marca consumo antes
                // de executar. O fallback textual CONFIRMO continua valendo.
                const resetSenderId = message.from?.id ? String(message.from.id) : null;
                if (!resetSenderId) {
                    await markTelegramProcessed(logId, { status: "ignored", errorMessage: "payment_reset_all_unconfirmed", parsedAction: "payment_reset_all" });
                    await sendMessage(message.chat.id, "⚠️ Isso gera codinomes NOVOS para TODOS os médicos ativos e invalida os atuais de uma vez.\nPara confirmar, envie: /pagamento resetar-todos CONFIRMO", message.message_id);
                    return { ok: true, ignored: true };
                }
                const activeDoctorCount = (await listDoctorCodenames()).length;
                await markTelegramProcessed(logId, {
                    status: "pending_reset_all_confirmation",
                    errorMessage: "payment_reset_all_unconfirmed",
                    parsedAction: "payment_reset_all",
                    resolutionData: {
                        kind: "reset_all_confirmation",
                        count: activeDoctorCount,
                        senderTelegramId: resetSenderId,
                        requestedAt: new Date().toISOString(),
                    } satisfies PendingResetAllConfirmationData,
                });
                await sendMessage(
                    message.chat.id,
                    buildResetAllConfirmationPromptText(activeDoctorCount),
                    message.message_id,
                    buildResetAllConfirmationKeyboard(activeDoctorCount, logId),
                    { parseMode: "Markdown" },
                );
                return { ok: true, ignored: true, pending: true };
            }
            try {
                const results = await resetAllDoctorCodenames();
                await markTelegramProcessed(logId, {
                    status: "accepted",
                    parsedAction: "payment_reset_all",
                    resolutionData: { actorRoles: actor.roles, count: results.length },
                });
                const header = `🔐 Codinomes resetados — ${results.length} médicos. Os anteriores não valem mais.\nEntregue cada codinome no privado do médico.`;
                const lines = results.map((r) => `${r.fullName} — ${r.codename}`);
                const messages = chunkTelegramLines(header, lines);
                for (const [index, text] of messages.entries()) {
                    await sendMessage(message.chat.id, text, index === 0 ? message.message_id : undefined);
                }
                return { ok: true, reported: true };
            } catch (error) {
                await markTelegramProcessed(logId, {
                    status: "error",
                    errorMessage: error instanceof Error ? error.message : "payment_reset_all_failed",
                    parsedAction: "payment_reset_all",
                });
                await sendMessage(message.chat.id, `⛔ Não consegui resetar os codinomes. ${resolveTelegramErrorText(error)}`, message.message_id);
                return { ok: true, ignored: true };
            }
        }

        const codenameCommand = parseTelegramPaymentCodenameAdminCommand(message.text);
        if (codenameCommand) {
            try {
                const { doctor, candidates } = await resolveDoctorWithFallback(codenameCommand.doctorName);
                if (!doctor) {
                    await markTelegramProcessed(logId, {
                        status: "ignored",
                        errorMessage: "payment_codename_doctor_not_resolved",
                        parsedAction: codenameCommand.name,
                        resolutionData: { doctorQuery: codenameCommand.doctorName, candidates: candidates.slice(0, 3) },
                    });
                    await sendMessage(message.chat.id, buildNameUnresolvedReply(message.message_id, candidates), message.message_id);
                    return { ok: true, ignored: true };
                }
                // resetDoctorCodename (não upsert direto) para saber se havia codinome
                // anterior — a copy canônica avisa que ele parou de valer.
                const result = await resetDoctorCodename(doctor.id);
                await markTelegramProcessed(logId, {
                    status: "accepted",
                    parsedAction: codenameCommand.name,
                    parsedDoctorName: doctor.fullName,
                    resolutionData: { actorRoles: actor.roles, doctorId: doctor.id },
                });
                await sendMessage(
                    message.chat.id,
                    buildCodenameDeliveryReply({ ...result, fullName: resolveTelegramDoctorSurfaceName(doctor) }),
                    message.message_id,
                );
                return { ok: true, reported: true };
            } catch (error) {
                await markTelegramProcessed(logId, {
                    status: "error",
                    errorMessage: error instanceof Error ? error.message : "payment_codename_failed",
                    parsedAction: codenameCommand.name,
                    resolutionData: { rawCommand: message.text },
                });
                await sendMessage(message.chat.id, `⛔ Não consegui gerar o codinome. ${resolveTelegramErrorText(error)}`, message.message_id);
                return { ok: true, ignored: true };
            }
        }

        if (!paymentCommand) {
            const digestCommand = parseTelegramPaymentDigestCommand(message.text);
            if (digestCommand) {
                try {
                    const board = await getChiefPayableShiftsBoard(digestCommand.monthKey);
                    const messages = buildPaymentDigestMessages(board, new Date());

                    await markTelegramProcessed(logId, {
                        status: "accepted",
                        parsedAction: "payment_digest",
                        resolutionData: {
                            actorRoles: actor.roles,
                            monthKey: board.monthKey,
                            doctorCount: board.summary.doctorCount,
                            messageCount: messages.length,
                        },
                    });

                    if (messages.length === 0) {
                        await sendMessage(message.chat.id, `✅ Nenhum plantão registrado em ${board.monthLabel} ainda.`, message.message_id);
                        return { ok: true, reported: true };
                    }

                    for (const [index, text] of messages.entries()) {
                        await sendMessage(message.chat.id, text, index === 0 ? message.message_id : undefined);
                    }
                    return { ok: true, reported: true };
                } catch (error) {
                    await markTelegramProcessed(logId, {
                        status: "error",
                        errorMessage: error instanceof Error ? error.message : "payment_digest_failed",
                        parsedAction: "payment_digest",
                        resolutionData: { rawCommand: message.text },
                    });
                    await sendMessage(message.chat.id, `⛔ Não consegui montar o relatório mensal. ${resolveTelegramErrorText(error)}`, message.message_id);
                    return { ok: true, ignored: true };
                }
            }

            // Admin/chefe também pode puxar a folha de um médico pelo codinome
            // (útil para suporte/teste). Ex.: /pagamento tigre-azul-958 [mês].
            const adminSelfCommand = parseTelegramPaymentSelfServiceCommand(message.text);
            if (adminSelfCommand?.codename) {
                const adminDoctorId = await resolveDoctorIdByCodename(adminSelfCommand.codename);
                if (adminDoctorId) {
                    try {
                        const board = await getChiefPayableShiftsBoard(adminSelfCommand.monthKey);
                        const [yearStr, monthStr] = board.monthKey.split("-");
                        const year = Number(yearStr);
                        const month = Number(monthStr);
                        const appUrl = (process.env.AUTH_URL?.trim() || "https://plantoes.mnrs.com.br").replace(/\/$/, "");
                        const folhaToken = createFolhaToken({ medicoId: adminDoctorId, ano: year, mes: month });
                        const folhaUrl = `${appUrl}/folha-ponto/${adminDoctorId}/${year}/${String(month).padStart(2, "0")}?t=${folhaToken}`;
                        const bankHoursUrl = `${appUrl}/banco-de-horas/${adminDoctorId}/${year}/${String(month).padStart(2, "0")}?t=${folhaToken}`;
                        await markTelegramProcessed(logId, {
                            status: "accepted",
                            parsedAction: "payment_self_admin",
                            resolutionData: { actorRoles: actor.roles, doctorId: adminDoctorId, monthKey: board.monthKey },
                        });
                        const row = board.doctors.find((doctor) => doctor.doctorId === adminDoctorId);
                        if (!row) {
                            // Variante vazia unificada (auditoria §3.4#7): sem link de folha vazia.
                            await sendMessage(message.chat.id, buildDoctorPayrollEmptyMessage(board.monthLabel), message.message_id);
                            return { ok: true, reported: true };
                        }
                        const messages = buildDoctorPayrollMessages(row, board, folhaUrl, bankHoursUrl);
                        for (const [index, text] of messages.entries()) {
                            await sendMessage(message.chat.id, text, index === 0 ? message.message_id : undefined);
                        }
                        return { ok: true, reported: true };
                    } catch (error) {
                        await markTelegramProcessed(logId, {
                            status: "error",
                            errorMessage: error instanceof Error ? error.message : "payment_self_admin_failed",
                            parsedAction: "payment_self_admin",
                        });
                        await sendMessage(message.chat.id, `⛔ Não consegui montar o pagamento. ${resolveTelegramErrorText(error)}`, message.message_id);
                        return { ok: true, ignored: true };
                    }
                }
            }

            await markTelegramProcessed(logId, {
                status: "ignored",
                errorMessage: "payment_command_usage_invalid",
                parsedAction: "payment_command",
                resolutionData: { rawCommand: message.text },
            });
            await sendMessage(message.chat.id, buildPaymentCommandUsageReply(actor.roles.includes("admin")), message.message_id);
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
                const reportMessages = buildPaymentAllocationReportMessages(board);
                for (const [index, text] of reportMessages.entries()) {
                    await sendMessage(message.chat.id, text, index === 0 ? message.message_id : undefined);
                }
                return { ok: true, reported: true };
            } catch (error) {
                await markTelegramProcessed(logId, {
                    status: "error",
                    errorMessage: error instanceof Error ? error.message : "payment_report_failed",
                    parsedAction: paymentCommand.name,
                    resolutionData: { rawCommand: message.text },
                });
                await sendMessage(message.chat.id, `⛔ Não consegui montar a conferência de pagamento. ${resolveTelegramErrorText(error)}`, message.message_id);
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
                await sendMessage(message.chat.id, `⛔ Não encontrei ${paymentCommand.targetCode} na conferência de ${formatPaymentAllocationDateLabel(board.operationalDate)} ${board.shiftLabel}.`, message.message_id);
                return { ok: true, ignored: true };
            }

            if (!targetRow.occupancyId) {
                await markTelegramProcessed(logId, {
                    status: "ignored",
                    errorMessage: "payment_target_without_occupancy",
                    parsedAction: paymentCommand.name,
                    parsedTargetCode: paymentCommand.targetCode,
                });
                await sendMessage(message.chat.id, `⛔ ${targetRow.targetCode} ainda está sem ocupação identificada nesse turno. Primeiro ajuste o lançamento operacional e depois refaça a conferência.`, message.message_id);
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
                await sendMessage(message.chat.id, `✅ ${resolveTelegramDoctorSurfaceName(doctor)} já estava alocado em ${targetRow.targetCode} para ${formatPaymentAllocationDateLabel(board.operationalDate)} ${board.shiftLabel}.`, message.message_id);
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
                `✅ Corrigi ${targetRow.targetCode} para ${resolveTelegramDoctorSurfaceName(doctor)} em ${formatPaymentAllocationDateLabel(board.operationalDate)} ${board.shiftLabel}. Agora ${describePaymentAllocationOutcome(refreshedRow)}.`,
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
            await sendMessage(message.chat.id, `⛔ Não consegui corrigir essa alocação de pagamento. ${resolveTelegramErrorText(error)}`, message.message_id);
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
            await sendMessage(message.chat.id, "⛔ O comando /banco fica restrito a admin porque altera o saldo auditado do plantão.", message.message_id);
            return { ok: true, ignored: true };
        }

        if (message.chat.type !== "private") {
            await markTelegramProcessed(logId, {
                status: "ignored",
                errorMessage: "bank_hours_command_private_only",
                parsedAction: bankHoursCommand?.name ?? "bank_hours_override",
                resolutionData: { rawCommand: message.text },
            });
            await sendMessage(message.chat.id, "⛔ O ajuste de banco fica no privado do bot, para não poluir o grupo operacional.", message.message_id);
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
            await sendMessage(message.chat.id, `⛔ Não consegui ajustar o banco. ${resolveTelegramErrorText(error)}`, message.message_id);
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

            // Auditoria §3.3#9: no GRUPO sai só o resumo de 3 linhas; a íntegra
            // (~1.870 chars de dados financeiros) vai ao privado de quem pediu.
            // Se o privado falhar (403 — nunca abriu o bot), o resumo instrui a
            // chamar no privado. No privado, a íntegra sai direto, como antes.
            const isGroupChat = message.chat.type !== "private";
            let privateDelivered = false;
            if (isGroupChat && message.from?.id) {
                try {
                    await sendMessage(message.from.id, report, undefined, undefined, { parseMode: "Markdown" });
                    privateDelivered = true;
                } catch {
                    privateDelivered = false;
                }
            }

            await markTelegramProcessed(logId, {
                status: "accepted",
                parsedAction: departureReportCommand.name,
                resolutionData: {
                    operationalDate: board.operationalDate,
                    shiftLabel: board.shiftLabel,
                    assignedCount: board.summary.assignedCount,
                    needsReviewCount: board.summary.needsReviewCount,
                    ...(isGroupChat ? { departureReportPrivateDelivered: privateDelivered } : {}),
                },
            });
            await sendMessage(
                message.chat.id,
                isGroupChat ? buildTelegramDepartureReportSummary(board, { privateDelivered }) : report,
                message.message_id,
                undefined,
                { parseMode: "Markdown" },
            );
            return { ok: true, reported: true };
        } catch (error) {
            await markTelegramProcessed(logId, {
                status: "error",
                errorMessage: error instanceof Error ? error.message : "departure_report_failed",
                parsedAction: "departure_report",
                resolutionData: { rawCommand: message.text },
            });
            await sendMessage(message.chat.id, `⛔ Não consegui montar o relatório de saídas. ${resolveTelegramErrorText(error)}`, message.message_id);
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
            await sendMessage(message.chat.id, `⛔ Não consegui montar a prioridade de saída. ${resolveTelegramErrorText(error)}`, message.message_id);
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
            await sendMessage(message.chat.id, `⛔ Não consegui montar o relato do plantão. ${resolveTelegramErrorText(error)}`, message.message_id);
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
            await sendMessage(message.chat.id, `⛔ Não consegui montar o resumo. ${resolveTelegramErrorText(error)}`, message.message_id);
            return { ok: true, ignored: true };
        }
    }

    // Sufixo @bot: "/ajuda@MeuBot" vale como "/ajuda" — mesmo padrão (?:@\w+)? já
    // usado nos matchers regex do repo, aplicado aos matchers de igualdade estrita.
    const normalizedText = message.text.trim().toLowerCase().replace(/^(\/[a-z_]+)@\w+$/, "$1");
    if (normalizedText === "/ajuda" || normalizedText === "/help") {
        const helpActor = await resolveTelegramCommandActor(message);
        const helpIsAdmin = helpActor?.roles.includes("admin") ?? false;
        const helpIsChief = helpActor?.roles.some((r) => r === "admin" || r === "chief") ?? false;

        // Guia enxuto (auditoria comunicação §3.4#4): 1 exemplo copiável por ação,
        // todos com turno. Pitfalls e lista completa ficam no /comandos.
        const helpLines = [
            "📋 *Guia rápido do bot*",
            "",
            `▸ Chegada: \`${buildTelegramArrivalExample({})}\``,
            `▸ Saída: \`${buildTelegramDepartureExample({})}\``,
            "▸ Emenda (segue no posto): `Vagner Costa continuo PM04`",
            "",
            "Sempre nome *e* sobrenome + local + turno (SD, SN ou P) na mesma mensagem.",
            "Refeição: /almoco ou /jantar · UPAs restritas: /upas · Todos: /comandos",
        ];

        if (helpIsChief) {
            helpLines.push(
                "",
                "🔑 *Chefia (privado):* /pagamento · /pagamento conferir · /pagamento corrigir",
                "   /rc <Nome ou codinome> — reseta o codinome de um médico",
            );
        }
        if (helpIsAdmin) {
            helpLines.push(
                "👑 *Admin (privado):* /desfazer · /slots · /medico · /piam · /psiq · /banco · /pagamento listar",
            );
        }

        const helpText = helpLines.join("\n");

        await markTelegramProcessed(logId, {
            status: "accepted",
            parsedAction: "help_command",
        });
        await sendTelegramHelpMessage(message.chat.id, helpText, message.message_id);
        return { ok: true, help: true };
    }

    // /upas — UPAs restritas pela chefia (fonte: painel /tabela). Aberto a
    // qualquer um: é informação de conduta, não de gestão.
    if (normalizedText === "/upas") {
        const entries = await fetchUpaRestrictions();
        await markTelegramProcessed(logId, {
            status: "accepted",
            parsedAction: "upa_restrictions_command",
        });
        await sendMessage(
            message.chat.id,
            buildUpaRestrictionsCommandReply(entries),
            message.message_id,
            undefined,
            { parseMode: "Markdown" },
        );
        return { ok: true, ignored: true };
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
            "📥 *CHEGADA / SAÍDA (mensagem livre no grupo)*",
            "",
            "▸ Chegada:",
            `  _${buildTelegramArrivalExample({})}_`,
            "  _Vagner Costa 1363 SD 07:00_ (ramal de regulação)",
            "  _Vagner Costa PM04 P 07:00_ (plantão P)",
            "",
            "▸ Saída:",
            `  _${buildTelegramDepartureExample({})}_`,
            "",
            "▸ Continuação (emenda turno):",
            "  _Vagner Costa continuo PM04_",
            "",
            "▸ Troca de base/ramal:",
            "  _Vagner Costa trocando de PM04 para PR03 SD 08:30_",
            "",
            "⚠️ Sempre nome *e* sobrenome + local + turno + horário na mesma mensagem.",
            "",
            "⚠️ O que trava o registro:",
            "• só o primeiro nome → mande nome *e* sobrenome",
            "• \"bom dia\" sem dados → saudação não registra",
            "• \"24h\" como hora → significa plantão P, não meia-noite",
            "• nome e local em mensagens separadas → junte tudo",
        );

        sections.push(
            "",
            "📍 *BASES E RAMAIS VÁLIDOS*",
            "",
            "▸ Bases de intervenção:",
            "  SM01 · CB02 · PR03 · PM04 · BR05 · CN10",
            "  PP20 · IT30 · PM40 · CZ50 · BR60 · CC70 · GOA",
            "",
            "▸ Ramais de regulação:",
            "  1321–1329 · 1361–1368 · 1476",
            "  2031–2035 · 2151–2154 · 2377 · NUCLEO · PIAM",
            "",
            "ℹ️ 2031 entra como CP; 1367/1368 entram como COI (função automática).",
        );

        sections.push(
            "",
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
            "📢 *UTILIDADES*",
            "",
            "▸ /cobrar — lembrete para equipe informar chegada no formato certo",
            "▸ /lembretes — cobra chefia com USA sem informação + total de reguladores",
            "▸ /ajuda — guia rápido",
        );

        if (isChief) {
            sections.push(
                "",
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
            );

            sections.push(
                "",
                "🔑 *CHEFIA (privado do bot)*",
                "",
                "▸ /pagamento — relatório do mês por médico (plantão a plantão):",
                "  _/pagamento_ (mês atual)",
                "  _/pagamento 05_ ou _/pagamento maio_ (mês escolhido)",
                "",
                "▸ /pagamento conferir — confere alocação de pagamento:",
                "  _/pagamento conferir_ (turno atual)",
                "  _/pagamento conferir 2026-04-07 SD_",
                "",
                "▸ /pagamento corrigir — corrige pagamento:",
                "  _/pagamento corrigir PM04 | Karen | 2026-04-07 | SD | motivo_",
                "",
                "▸ /rc — gera/reseta o codinome de UM médico (por nome OU codinome):",
                "  _/rc João Silva_  ou  _/rc tigre-azul-958_  (alias: /resetcodinome)",
                "  → responde com o codinome novo p/ você entregar no particular.",
                "",
                "▸ Você também pode puxar a folha de um médico pelo codinome:",
                "  _/pagamento tigre-azul-958_ ou _/pagamento tigre-azul-958 05_",
                "",
                `ℹ️ Requer chat privado + chefia (agora: ${isPrivate ? "privado" : "grupo"}).`,
            );
        }

        if (isAdmin) {
            sections.push(
                "",
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
                "▸ /piam — atribui/remove médico do PIAM:",
                "  _/piam Nome_ · _/piam remover Nome_ · _/piam listar_",
                "",
                "▸ /psiq — marca/remove médico como psiquiatra (PSIQ):",
                "  _/psiq Nome_ · _/psiq remover Nome_ · _/psiq listar_",
                "",
                "▸ /banco — ajusta banco de horas:",
                "  _/banco Nome Completo SD 0_",
                "",
                "▸ /pagamento listar — exporta a lista atual nome → codinome",
                "",
                "▸ /pagamento resetar-todos — ⚠️ reset GERAL dos codinomes (todos de uma vez):",
                "  _/pagamento resetar-todos_ (pede confirmação) → _/pagamento resetar-todos CONFIRMO_",
                "",
                "ℹ️ Requer chat privado + admin de verdade.",
            );
        }

        if (!isChief) {
            sections.push(
                "",
                "🔒 Comandos de chefia/admin aparecem aqui quando você tiver acesso.",
            );
        }

        sections.push(
            "",
            "💡 Dica: mande /comandos a qualquer momento para rever este tutorial.",
        );

        await markTelegramProcessed(logId, {
            status: "accepted",
            parsedAction: "comandos_tutorial",
            resolutionData: { isAdmin, isChief, isPrivate },
        });
        // A variante admin passa do limite de 4096 chars do Telegram — sem o
        // particionamento a API rejeitava e o pedido de ajuda ficava mudo
        // (auditoria comunicação §3.1#2). Blocos de até 3500 chars, numerados.
        const comandosMessages = chunkTelegramLines(sections[0], sections.slice(1));
        for (const [index, text] of comandosMessages.entries()) {
            await sendTelegramHelpMessage(message.chat.id, text, index === 0 ? message.message_id : undefined);
        }
        return { ok: true, help: true };
    }

    if (normalizedText === "/cobrar") {
        // Copy enxuta com nomes FICTÍCIOS (auditoria §3.4#14) — nunca usar nomes
        // reais de médicos em exemplo. A linha final de consequência fica.
        const cobrarText = [
            "📢 *Atenção equipe!* Avisem sempre *nome completo + base/ramal + turno (SD, SN ou P) + horário*, tudo na mesma mensagem.",
            "",
            "▸ Intervenção: _Vagner Costa PM04 SN 19:00_",
            "▸ Regulação: _Ana Souza 2031 SN 19:00_",
            "▸ Segue no posto: _Bruno Lima BR05 continua P 19:00_",
            "",
            "Sem aviso de continua/P ou ajuste da chefia, a posição fica como *sem médico confirmado* no grupo.",
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
                    ? `⛔ Não encontrei plantão recente de ${resolveTelegramDoctorSurfaceName(doctor)} em ${departureCorrectionCommand.targetCode} para corrigir a saída.`
                    : `⛔ Não encontrei plantão recente de ${resolveTelegramDoctorSurfaceName(doctor)} para corrigir a saída.`,
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
                    `⛔ Achei mais de um plantão recente de ${resolveTelegramDoctorSurfaceName(doctor)}.`,
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

    const normalizedAlertaText = message.text.trim().split("@")[0].toLowerCase();
    if (normalizedAlertaText === "/alerta") {
        if (!canRunPrivateAdminSlotAudit(message)) {
            await markTelegramProcessed(logId, {
                status: "ignored",
                errorMessage: "alerta_command_forbidden",
                parsedAction: "alerta_command",
            });
            await sendMessage(message.chat.id, "⛔ O comando /alerta só roda no privado para o admin configurado do bot.", message.message_id);
            return { ok: true, ignored: true };
        }

        const alertBoard = await getOperationalBoard();
        const alertPlan = buildChiefPrivateRegulationAlertPlan({ now: new Date(), board: alertBoard });

        if (!alertPlan) {
            await markTelegramProcessed(logId, {
                status: "accepted",
                parsedAction: "alerta_command",
                resolutionData: { alertSent: false, reason: "no_alert_needed" },
            });
            await sendMessage(message.chat.id, "✅ Tudo ok no momento, nenhum alerta necessário.", message.message_id);
            return { ok: true, alerta: true };
        }

        await queuePendingAlertaConfirmation(logId, message, alertPlan.text);
        return { ok: true, alerta: true, pending: true };
    }

    const command = parseTelegramCommand(message.text);
    if (!command) {
        if (message.text.trim().startsWith("/")) {
            // Comando desconhecido a poucas letras de um comando real: sugere o
            // provável em vez do genérico (auditoria comunicação §3.4#1). Só
            // sugere — nunca executa automaticamente comando restrito.
            const typoSuggestion = suggestTelegramCommandForTypo(message.text);
            if (typoSuggestion) {
                const typedCommand = message.text.trim().split(/\s+/)[0];
                await markTelegramProcessed(logId, {
                    status: "ignored",
                    errorMessage: "command_parse_failed",
                    resolutionData: {
                        ...buildTelegramReviewLogData({
                            reason: "command_parse_failed",
                            trainingCandidate: true,
                        }),
                        rawCommand: message.text,
                        suggestionKind: "command_typo",
                        suggestedCommands: [typoSuggestion],
                    },
                });
                await sendMessage(
                    message.chat.id,
                    `⚠️ Não reconheci ${typedCommand}. Você quis dizer ${typoSuggestion}? (toque para ver)`,
                    message.message_id,
                );
                return { ok: true, ignored: true };
            }

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
        // "/saida PM04 19:00" de médico comum (alias de /retirar): em vez de só
        // negar, ensina o formato texto-livre já semeado com o que a pessoa deu
        // (auditoria comunicação §3.4#2). Demais comandos restritos: texto fixo.
        const forbiddenReply = command.name === "retirar"
            ? `⛔ /retirar é da chefia. Para registrar sua saída, mande: \`${command.doctorName?.trim() || "Seu Nome"} saindo ${command.targetCode} ${command.time ?? "19:00"}\``
            : pickTelegramReply("command_forbidden", message.message_id, {});
        await sendMessage(message.chat.id, forbiddenReply, message.message_id);
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
                ? "⛔ O comando /remover fica restrito a admin porque apaga o plantão do banco e da trilha operacional."
                : "⛔ Os comandos /ativar e /desativar ficam restritos a admin porque alteram o estado operacional auditado da base ou do ramal.",
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
        await sendMessage(message.chat.id, `⛔ Não encontrei ocupação ativa em ${command.targetCode} para aplicar ${command.name}.`, message.message_id);
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

            // findActiveOccupancyByTarget só enxerga o titular do quadro. Se o nome dado é de
            // alguém que divide o ramal/base fora do quadro (sombra ou deslocado), a correção
            // é dele — sem isso, /corrigir trocava o médico do titular pela sombra.
            const offBoardOccupancy = doctor.id !== active.occupancy!.doctorId
                ? await findOffBoardOccupancyOnTarget({
                    sector: command.sector,
                    targetId: command.sector === "REGULATION" ? active.post!.id : active.base!.id,
                    doctorId: doctor.id,
                })
                : null;
            const targetOccupancy = offBoardOccupancy ?? active.occupancy!;

            // Só espelha boardStartedAt quando ele hoje coincide com startedAt. Continuidade
            // (board < started) e sombra (board nulo) mantêm o valor que já têm.
            const existingBoardStartedAt = targetOccupancy.boardStartedAt;
            const existingStartedAt = targetOccupancy.startedAt;
            const mirrorsBoardStartedAt = Boolean(existingBoardStartedAt
                && existingStartedAt
                && existingBoardStartedAt.getTime() === existingStartedAt.getTime());

            const correctionBase = {
                doctorId: doctor.id,
                startedAt: eventAt,
                notes: `${targetOccupancy.notes ?? ""}\n[telegram /corrigir] ${message.text}`.trim(),
                ...(mirrorsBoardStartedAt ? { boardStartedAt: eventAt } : {}),
            };

            const updated = command.sector === "REGULATION"
                ? await correctRegulationOccupancy(targetOccupancy.id, correctionBase, resolveCommandAuditUserId(null))
                : await correctInterventionOccupancy(targetOccupancy.id, correctionBase, resolveCommandAuditUserId(null));

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
            }) + (command.sector === "REGULATION" ? "" : await fetchChecklistKeyHint(command.targetCode)), message.message_id);

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
            await sendMessage(message.chat.id, `⛔ Não consegui corrigir ${command.targetCode}. ${resolveTelegramErrorText(error)}`, message.message_id);
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
            }) + (command.sector === "REGULATION" ? "" : await fetchChecklistKeyHint(command.targetCode)), message.message_id);

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
            await sendMessage(message.chat.id, `⛔ Não consegui corrigir ${command.targetCode}. ${resolveTelegramErrorText(error)}`, message.message_id);
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
            await sendMessage(message.chat.id, `⛔ ${command.targetCode} está com ${activeDoctorName} no plantão ativo. O comando /ramal só troca a função sem mexer no médico nem no horário.`, message.message_id);
            return { ok: true, ignored: true };
        }

        const fixedRole = resolveFixedOperationalRole({
            domain: "regulation",
            code: command.targetCode,
            shiftLabel: active.occupancy.shiftLabel === "SD" || active.occupancy.shiftLabel === "SN" || active.occupancy.shiftLabel === "P"
                ? active.occupancy.shiftLabel
                : null,
        });
        const nextRoleLabel = normalizeOperationalRoleLabel(resolveRoleLabelForExplicitRemoval(command.roleLabel));
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
            await sendMessage(message.chat.id, `⛔ ${command.targetCode} tem função fixa ${fixedRole} neste turno. Esse ramal não aceita troca manual de função.`, message.message_id);
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
                    appliedRoleLabel: updated.roleLabel,
                    usedActiveDoctorFallback,
                },
            });

            // A função manda na janela agendada, e é ela que o banco de horas usa
            // como baseline. Duas situações precisam ser ditas em voz alta:
            // meio plantão pedido para quem chegou antes das 11:10 NÃO cola, e
            // cruzar a fronteira meio<->inteiro muda a jornada, não só o rótulo.
            const halfShiftRefused = isHalfShiftRoleLabel(nextRoleLabel) && !isHalfShiftRoleLabel(updated.roleLabel);
            const halfShiftBoundaryCrossed = isHalfShiftRoleLabel(active.occupancy.roleLabel)
                !== isHalfShiftRoleLabel(updated.roleLabel);
            const doctorSurfaceName = resolveTelegramDoctorSurfaceName(doctor);
            const roleReply = halfShiftRefused
                ? `⛔ ${doctorSurfaceName} chegou em ${command.targetCode} às ${formatSaoPauloClock(active.occupancy.startedAt)}, antes das 11:10 — não dá pra marcar meio plantão. Segue como plantão INTEIRO (07:00–19:15) e o atraso conta a partir das 07:00. Para virar meia jornada, corrija a chegada primeiro.`
                : updated.roleLabel
                    ? `Função atualizada em ${command.targetCode}: ${doctorSurfaceName} segue no mesmo plantão, agora como ${updated.roleLabel}. Chegada e meal break foram preservados.`
                    : `Função removida em ${command.targetCode}: ${doctorSurfaceName} segue no mesmo plantão sem função operacional extra. Chegada e meal break foram preservados.`;
            const windowNote = !halfShiftRefused && halfShiftBoundaryCrossed
                ? isHalfShiftRoleLabel(updated.roleLabel)
                    ? "\n\n⏱️ Vira meia jornada: jornada prevista 11:30–17:00 e pagamento 0,5."
                    : "\n\n⏱️ Volta a ser plantão inteiro: jornada prevista 07:00–19:15, o atraso passa a contar das 07:00 e o pagamento volta a 1."
                : "";

            await sendMessage(message.chat.id, `${roleReply}${windowNote}`, message.message_id);
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
            await sendMessage(message.chat.id, `⛔ Não consegui atualizar a função em ${command.targetCode}. ${resolveTelegramErrorText(error)}`, message.message_id);
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

        // /retirar é decisão da chefia: aplica a régua de saída antecipada
        // (early-departure.ts) e o desfecho entra no aviso do grupo.
        const updated = command.sector === "REGULATION"
            ? await endRegulationOccupancy(active.occupancy.id, { endedAt: eventAt, actualEndedAt: eventAt, chiefWithdrawal: true }, resolveCommandAuditUserId(null))
            : await endInterventionOccupancy(active.occupancy.id, { endedAt: eventAt, actualEndedAt: eventAt, chiefWithdrawal: true }, resolveCommandAuditUserId(null));
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
        const removedReply = pickTelegramReply("command_removed", message.message_id, {
            target: command.targetCode,
            name: doctorName,
            time: formatTelegramReplyTime(eventAt),
        });
        const removedOutcomeLine = isStoredEarlyDepartureOutcome(updated.earlyDepartureOutcome)
            ? `\n${buildEarlyDepartureSummary(updated.earlyDepartureOutcome, { name: doctorName })}`
            : "";
        await sendMessage(message.chat.id, `${removedReply}${removedOutcomeLine}`, message.message_id);
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
        await sendTelegramReplyBatch(
            message.chat.id,
            result.messages,
            message.message_id,
            // "Fora da vez"/dedupe saem SEM teclado: o teclado da vez pertence a
            // outra pessoa e reanexá-lo aqui era o que gerava toques errados.
            result.suppressKeyboard ? null : result.session,
            MEAL_BREAK_FORMAT_OPTIONS,
        );
        return { ok: true, mealBreak: true };
    } catch (error) {
        await markTelegramProcessed(logId, {
            status: "error",
            parsedAction: "meal_break_reply",
            errorMessage: error instanceof Error ? error.message : "meal_break_reply_failed",
        });
        await sendMessage(message.chat.id, buildMealBreakErrorReply(error), message.message_id);
        await alertAdminsOnMealBreakTechnicalError("resposta de divisão", error);
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
                "pending_shift_selection",
                "pending_piam_shift",
                "pending_payment_profile",
            ]),
            lt(telegramIngestedMessages.createdAt, cutoff),
        ));
}

async function findPendingRamalSelection(chatId: string, senderTelegramId: string, includeExpired = false) {
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
    if (fresh) {
        return fresh;
    }
    await expireStalependings(chatId, senderTelegramId, "pending_cru_coi_ramal");
    if (!includeExpired) {
        return null;
    }
    return findExpiredReopenablePending(chatId, senderTelegramId, (row) => isPendingCruCoiRamalData(row.resolutionData), new Date());
}

async function expireStalependings(
    chatId: string,
    senderTelegramId: string,
    status: "pending_name_selection" | "pending_departure_justification" | "pending_departure_correction" | "pending_cru_coi_ramal" | "pending_shift_selection" | "pending_piam_shift" | "pending_payment_profile",
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

async function findPendingPaymentProfile(chatId: string, senderTelegramId: string) {
    const db = getDb();
    const cutoff = new Date(Date.now() - PENDING_TTL_MS);
    const fresh = await db.query.telegramIngestedMessages.findFirst({
        where: and(
            eq(telegramIngestedMessages.chatId, chatId),
            eq(telegramIngestedMessages.senderTelegramId, senderTelegramId),
            eq(telegramIngestedMessages.status, "pending_payment_profile"),
            gte(telegramIngestedMessages.createdAt, cutoff),
        ),
        orderBy: [desc(telegramIngestedMessages.createdAt)],
    });
    if (!fresh) {
        await expireStalependings(chatId, senderTelegramId, "pending_payment_profile");
    }
    return fresh ?? null;
}

async function findPendingNameSelection(chatId: string, senderTelegramId: string, includeExpired = false) {
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
    if (fresh) {
        return fresh;
    }
    await expireStalependings(chatId, senderTelegramId, "pending_name_selection");
    if (!includeExpired) {
        return null;
    }
    return findExpiredReopenablePending(chatId, senderTelegramId, (row) => isPendingResolutionData(row.resolutionData), new Date());
}

async function findPendingShiftSelection(chatId: string, senderTelegramId: string) {
    const db = getDb();
    const cutoff = new Date(Date.now() - PENDING_TTL_MS);
    const fresh = await db.query.telegramIngestedMessages.findFirst({
        where: and(
            eq(telegramIngestedMessages.chatId, chatId),
            eq(telegramIngestedMessages.senderTelegramId, senderTelegramId),
            eq(telegramIngestedMessages.status, "pending_shift_selection"),
            gte(telegramIngestedMessages.createdAt, cutoff),
        ),
        orderBy: [desc(telegramIngestedMessages.createdAt)],
    });
    if (!fresh) {
        await expireStalependings(chatId, senderTelegramId, "pending_shift_selection");
    }
    return fresh ?? null;
}

async function findPendingPiamShift(chatId: string, senderTelegramId: string) {
    const db = getDb();
    const cutoff = new Date(Date.now() - PENDING_TTL_MS);
    const fresh = await db.query.telegramIngestedMessages.findFirst({
        where: and(
            eq(telegramIngestedMessages.chatId, chatId),
            eq(telegramIngestedMessages.senderTelegramId, senderTelegramId),
            eq(telegramIngestedMessages.status, "pending_piam_shift"),
            gte(telegramIngestedMessages.createdAt, cutoff),
        ),
        orderBy: [desc(telegramIngestedMessages.createdAt)],
    });
    if (!fresh) {
        await expireStalependings(chatId, senderTelegramId, "pending_piam_shift");
    }
    return fresh ?? null;
}

// PIAM: acha a pendência do chat cujo balão-pergunta é o alvo do reply. Permite
// que a chefia (ou o próprio autor) responda "SD"/"SN" citando a pergunta.
async function findPendingPiamShiftByPrompt(chatId: string, promptMessageId: number) {
    const db = getDb();
    const cutoff = new Date(Date.now() - PENDING_TTL_MS);
    const rows = await db.query.telegramIngestedMessages.findMany({
        where: and(
            eq(telegramIngestedMessages.chatId, chatId),
            eq(telegramIngestedMessages.status, "pending_piam_shift"),
            gte(telegramIngestedMessages.createdAt, cutoff),
        ),
        orderBy: [desc(telegramIngestedMessages.createdAt)],
        limit: 5,
    });
    return rows.find((row) => isPendingPiamShiftData(row.resolutionData)
        && row.resolutionData.promptMessageId === promptMessageId) ?? null;
}

// Reabertura por resposta curta (auditoria §5#6): pendência já EXPIRADA (virou
// superseded/pending_expired) do mesmo autor no mesmo chat, dentro da janela de
// 2h. A aplicação sempre revalida contra o estado atual do quadro.
async function findExpiredReopenablePending(
    chatId: string,
    senderTelegramId: string,
    matches: (row: { resolutionData: unknown }) => boolean,
    now: Date,
) {
    const db = getDb();
    const cutoff = new Date(now.getTime() - PENDING_REOPEN_WINDOW_MS);
    const rows = await db.query.telegramIngestedMessages.findMany({
        where: and(
            eq(telegramIngestedMessages.chatId, chatId),
            eq(telegramIngestedMessages.senderTelegramId, senderTelegramId),
            eq(telegramIngestedMessages.status, "superseded"),
            eq(telegramIngestedMessages.errorMessage, "pending_expired"),
            gte(telegramIngestedMessages.createdAt, cutoff),
        ),
        orderBy: [desc(telegramIngestedMessages.createdAt)],
        limit: 5,
    });
    return rows.find(matches) ?? null;
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

async function findPendingDepartureCorrection(chatId: string, senderTelegramId: string, includeExpired = false) {
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
    if (fresh) {
        return fresh;
    }
    await expireStalependings(chatId, senderTelegramId, "pending_departure_correction");
    if (!includeExpired) {
        return null;
    }
    return findExpiredReopenablePending(chatId, senderTelegramId, (row) => isPendingDepartureCorrectionData(row.resolutionData), new Date());
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

async function supersedePendingPaymentProfile(chatId: string, senderTelegramId: string, reason = "payment_profile_superseded") {
    const pending = await findPendingPaymentProfile(chatId, senderTelegramId);
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

function isPendingShiftSelectionData(value: unknown): value is PendingShiftSelectionData {
    if (!value || typeof value !== "object") {
        return false;
    }
    const candidate = value as Record<string, unknown>;
    return candidate.kind === "shift_selection"
        && Boolean(candidate.parsed)
        && typeof candidate.senderTelegramId === "string"
        && typeof candidate.originalText === "string"
        && typeof candidate.originalReferenceAt === "string";
}

function isPendingPiamShiftData(value: unknown): value is PendingPiamShiftData {
    if (!value || typeof value !== "object") {
        return false;
    }
    const candidate = value as Record<string, unknown>;
    return candidate.kind === "piam_shift"
        && Boolean(candidate.parsed)
        && Boolean(candidate.resolvedDoctor)
        && typeof candidate.senderTelegramId === "string"
        && typeof candidate.originalReferenceAt === "string";
}

function isPendingDestinationSelectionData(value: unknown): value is PendingDestinationSelectionData {
    if (!value || typeof value !== "object") {
        return false;
    }
    const candidate = value as Record<string, unknown>;
    return candidate.kind === "destination_selection"
        && typeof candidate.token === "string"
        && Array.isArray(candidate.suggestions)
        && typeof candidate.senderTelegramId === "string"
        && typeof candidate.originalText === "string"
        && typeof candidate.originalReferenceAt === "string";
}

function isPendingResetAllConfirmationData(value: unknown): value is PendingResetAllConfirmationData {
    if (!value || typeof value !== "object") {
        return false;
    }
    const candidate = value as Record<string, unknown>;
    return candidate.kind === "reset_all_confirmation"
        && typeof candidate.count === "number"
        && typeof candidate.senderTelegramId === "string"
        && typeof candidate.requestedAt === "string";
}

function isPendingPaymentProfileData(value: unknown): value is PendingPaymentProfileData {
    if (!value || typeof value !== "object") {
        return false;
    }

    const candidate = value as Record<string, unknown>;
    const stage = candidate.stage;
    return stage === "awaiting_codename" || stage === "awaiting_company_name" || stage === "awaiting_cnpj" || stage === "awaiting_suggestion_confirmation";
}

/**
 * Monta o próximo passo do wizard depois do codinome confirmado: se já existe
 * uma sugestão de razão social/CNPJ importada da planilha oficial (e o médico
 * ainda não confirmou dados fiscais antes), oferece botões "Está certo?" em vez
 * de pedir para digitar do zero.
 */
async function buildCompanyNameStepPrompt(doctorId: string): Promise<{
    stage: "awaiting_company_name" | "awaiting_suggestion_confirmation";
    extra: Partial<PendingPaymentProfileData>;
    text: string;
    replyMarkup?: ReturnType<typeof buildInlineKeyboard>;
}> {
    const [doctor] = await getDb()
        .select({ metadata: doctors.metadata })
        .from(doctors)
        .where(eq(doctors.id, doctorId))
        .limit(1);

    const suggestion = resolveFiscalSuggestion(doctor?.metadata);
    if (suggestion) {
        return {
            stage: "awaiting_suggestion_confirmation",
            extra: { suggestedRazaoSocial: suggestion.razaoSocial, suggestedCnpj: suggestion.cnpj },
            text: [
                "✅ Codinome confirmado.",
                "Já tenho estes dados fiscais no cadastro da prefeitura:",
                `🏢 Empresa: ${suggestion.razaoSocial}`,
                `🧾 CNPJ: ${suggestion.cnpj}`,
                "Está correto?",
            ].join("\n"),
            replyMarkup: buildInlineKeyboard([[
                { text: "✅ Está certo", callback_data: buildFiscalSuggestionCallbackData(true) },
                { text: "✏️ Corrigir", callback_data: buildFiscalSuggestionCallbackData(false) },
            ]]),
        };
    }

    return {
        stage: "awaiting_company_name",
        extra: {},
        text: "✅ Codinome confirmado.\nAgora me diga o *nome completo da empresa* (razão social).",
    };
}

async function tryHandlePendingPaymentProfile(update: TelegramUpdate, logId: string) {
    const message = update.message;
    if (!message?.text || !message.from?.id || message.chat.type !== "private") {
        return null;
    }

    const chatId = String(message.chat.id);
    const senderTelegramId = String(message.from.id);
    const pending = await findPendingPaymentProfile(chatId, senderTelegramId);
    if (!pending || !isPendingPaymentProfileData(pending.resolutionData)) {
        return null;
    }

    const input = message.text.trim();
    if (!input) {
        return { ok: true, ignored: true };
    }

    if (isBatchCancelKeyword(input)) {
        await markTelegramProcessed(pending.id, {
            status: "superseded",
            errorMessage: "payment_profile_cancelled",
        });
        await markTelegramProcessed(logId, {
            status: "accepted",
            parsedAction: "payment_profile_setup_cancelled",
        });
        await sendMessage(message.chat.id, ":| Cadastro cancelado. Se quiser retomar, envie /pagamento cadastro.", message.message_id);
        return { ok: true, ignored: true };
    }

    const data = pending.resolutionData;

    if (data.stage === "awaiting_suggestion_confirmation") {
        await markTelegramProcessed(logId, { status: "ignored", errorMessage: "payment_profile_awaiting_button", parsedAction: "payment_profile_setup" });
        await sendMessage(message.chat.id, ":/ Toque em um dos botões da mensagem anterior para confirmar ou corrigir os dados.", message.message_id);
        return { ok: true, ignored: true };
    }

    if (data.stage === "awaiting_codename") {
        const lock = await checkAttemptLock(senderTelegramId);
        if (lock.locked) {
            await markTelegramProcessed(logId, { status: "ignored", errorMessage: "payment_profile_locked", parsedAction: "payment_profile_setup" });
            await sendMessage(message.chat.id, ":/ Muitas tentativas com codinome incorreto. Aguarde um pouco e tente de novo, ou peça um novo codinome à coordenação.", message.message_id);
            return { ok: true, ignored: true };
        }

        const doctorId = await resolveDoctorIdByCodename(input);
        if (!doctorId) {
            const next = await registerFailedAttempt(senderTelegramId);
            await markTelegramProcessed(logId, { status: "ignored", errorMessage: "payment_profile_codename_invalid", parsedAction: "payment_profile_setup" });
            const suffix = next.locked ? " Você excedeu as tentativas; aguarde antes de tentar de novo." : "";
            await sendMessage(message.chat.id, `:/ Codinome não confere.${suffix}`, message.message_id);
            return { ok: true, ignored: true };
        }

        await clearAttempts(senderTelegramId);
        const codenameCompanyStepPrompt = await buildCompanyNameStepPrompt(doctorId);
        await markTelegramProcessed(pending.id, {
            status: "pending_payment_profile",
            parsedAction: "payment_profile_setup",
            resolutionData: {
                stage: codenameCompanyStepPrompt.stage,
                doctorId,
                ...codenameCompanyStepPrompt.extra,
            },
            errorMessage: null,
        });
        await markTelegramProcessed(logId, {
            status: "accepted",
            parsedAction: "payment_profile_setup",
            resolutionData: { stage: codenameCompanyStepPrompt.stage },
        });
        await sendMessage(message.chat.id, codenameCompanyStepPrompt.text, message.message_id, codenameCompanyStepPrompt.replyMarkup);
        return { ok: true, pending: true };
    }

    if (data.stage === "awaiting_company_name") {
        const companyName = normalizeCompanyName(input);
        if (companyName.length < 3) {
            await markTelegramProcessed(logId, { status: "ignored", errorMessage: "payment_profile_company_invalid", parsedAction: "payment_profile_setup" });
            await sendMessage(message.chat.id, ":/ Nome de empresa muito curto. Envie a razão social completa, por favor.", message.message_id);
            return { ok: true, ignored: true };
        }

        await markTelegramProcessed(pending.id, {
            status: "pending_payment_profile",
            parsedAction: "payment_profile_setup",
            resolutionData: {
                stage: "awaiting_cnpj",
                doctorId: data.doctorId,
                companyName,
            },
            errorMessage: null,
        });
        await markTelegramProcessed(logId, {
            status: "accepted",
            parsedAction: "payment_profile_setup",
            resolutionData: { stage: "awaiting_cnpj" },
        });
        await sendMessage(message.chat.id, "Perfeito.\nAgora envie o *CNPJ* (com ou sem pontuação).", message.message_id);
        return { ok: true, pending: true };
    }

    if (!data.doctorId || !data.companyName) {
        await markTelegramProcessed(pending.id, {
            status: "superseded",
            errorMessage: "payment_profile_missing_context",
        });
        return null;
    }

    if (!isLikelyValidCnpj(input)) {
        await markTelegramProcessed(logId, { status: "ignored", errorMessage: "payment_profile_cnpj_invalid", parsedAction: "payment_profile_setup" });
        await sendMessage(message.chat.id, ":/ CNPJ inválido. Envie os 14 dígitos (com ou sem pontuação).", message.message_id);
        return { ok: true, ignored: true };
    }

    const normalizedCnpj = normalizeCnpj(input);
    if (!normalizedCnpj) {
        await markTelegramProcessed(logId, { status: "ignored", errorMessage: "payment_profile_cnpj_invalid", parsedAction: "payment_profile_setup" });
        await sendMessage(message.chat.id, ":/ CNPJ inválido. Envie os 14 dígitos (com ou sem pontuação).", message.message_id);
        return { ok: true, ignored: true };
    }

    const saved = await upsertDoctorFiscalProfile({
        doctorId: data.doctorId,
        razaoSocial: data.companyName,
        cnpj: normalizedCnpj,
    });

    await markTelegramProcessed(pending.id, {
        status: "accepted",
        parsedAction: "payment_profile_setup",
        parsedDoctorName: saved.fullName,
        resolutionData: {
            doctorId: saved.doctorId,
            companyName: saved.razaoSocial,
            cnpj: saved.cnpj,
        },
        errorMessage: null,
    });
    await markTelegramProcessed(logId, {
        status: "accepted",
        parsedAction: "payment_profile_setup",
        parsedDoctorName: saved.fullName,
        resolutionData: {
            doctorId: saved.doctorId,
            companyName: saved.razaoSocial,
            cnpj: saved.cnpj,
        },
    });
    await sendMessage(
        message.chat.id,
        [
            "✅ Cadastro fiscal atualizado.",
            `👤 Médico: ${saved.fullName}`,
            `🏢 Empresa: ${saved.razaoSocial}`,
            `🧾 CNPJ: ${saved.cnpj}`,
            "A folha de ponto já vai sair com esses dados.",
        ].join("\n"),
        message.message_id,
    );
    return { ok: true, reported: true };
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

    // When the doctor already stated an "occurrence" reason but omitted the mandatory
    // 4-digit occurrence number, the very first prompt charges for the number instead
    // of asking for a (already-given) reason.
    const inlineClaim = resolveTelegramLateDepartureClaim(params.originalText, [
        params.parsed.baseCode,
        params.resolvedDoctor.fullName,
        params.parsed.arrivalTime,
    ]);
    const occurrenceNumberRequired = inlineClaim?.missingOccurrenceNumber ?? false;

    await markTelegramProcessed(params.logId, {
        status: "pending_departure_justification",
        parsedDomain: params.parsed.sector,
        parsedTargetCode: params.parsed.baseCode,
        parsedAction: resolveTelegramParsedAction(params.parsed),
        parsedDoctorName: params.resolvedDoctor.fullName,
        errorMessage: occurrenceNumberRequired ? "departure_occurrence_number_required" : "departure_justification_required",
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
            occurrenceNumberRequired,
        },
    });

    // Botões [🚑 Ocorrência] [🧼 Higienização] [Sem motivo] (auditoria §3.1#6) —
    // só quando o motivo ainda está em aberto; se já sabemos que é ocorrência sem
    // número, o balão pede apenas os 4 dígitos e botão nenhum ajuda.
    await sendMessage(
        params.message!.chat.id,
        pickTelegramReply(occurrenceNumberRequired ? "departure_occurrence_number_required" : "departure_justification_required", params.message!.message_id, {
            name: resolveTelegramDoctorSurfaceName(params.resolvedDoctor),
            target: params.parsed.baseCode ?? "plantao",
            time: params.parsed.arrivalTime ?? formatTelegramReplyTime(params.eventAt),
            example: departureExample,
        }),
        params.message!.message_id,
        occurrenceNumberRequired ? undefined : buildDepartureJustificationKeyboard(params.logId),
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

    // Candidatos como botões inline com o nome completo (auditoria §3.1#5).
    // Resposta textual 1/2/3 continua valendo como fallback.
    const keyboard = buildNameSelectionKeyboard(candidates, logId);

    await sendMessage(
        message!.chat.id,
        `${buildCandidatePromptReply(message!.message_id, candidates, { target: parsed.baseCode, time: parsed.arrivalTime, shift: parsed.shiftType })}\n\n${isTelegramContinuationIntent(parsed) ? "Se isso for continuidade, vou manter a chegada original e registrar apenas a confirmação da passagem para o próximo plantão." : "Vou manter o horário da primeira mensagem."}${departureHint}`,
        message!.message_id,
        keyboard,
    );
}

// F6 sem turno vira pendência com botões [☀️ SD] [🌙 SN] [🕐 P 24h] em vez de
// rejeição seca (auditoria §3.1#1 — 138 casos/mês). O parse fica salvo e o botão
// (ou resposta curta "SD"/"SN"/"P") completa o registro pelo MESMO caminho do
// fluxo normal, com as mesmas validações de tomada/conflito.
async function queuePendingShiftSelection(params: {
    logId: string;
    message: NonNullable<TelegramUpdate["message"]>;
    parsed: ParsedMessage & OperationalParsedEntry;
    senderTelegramId: string;
}) {
    const senderName = [params.message.from?.first_name, params.message.from?.last_name].filter(Boolean).join(" ") || null;
    const doctorQuery = params.parsed.extractedNames[0] ?? null;
    const snapshot: OperationalParsedEntry = {
        sector: params.parsed.sector,
        baseCode: params.parsed.baseCode,
        arrivalTime: params.parsed.arrivalTime,
        shiftType: null,
        roleFunction: params.parsed.roleFunction,
        isShadow: params.parsed.isShadow ?? false,
        isDeparture: params.parsed.isDeparture,
        isContinuation: params.parsed.isContinuation,
        isReassignment: params.parsed.isReassignment ?? false,
    };
    const data: PendingShiftSelectionData = {
        kind: "shift_selection",
        parsed: snapshot,
        doctorQuery,
        senderName,
        senderTelegramId: params.senderTelegramId,
        originalText: params.message.text ?? "",
        originalReferenceAt: new Date(params.message.date * 1000).toISOString(),
    };

    await markTelegramProcessed(params.logId, {
        status: "pending_shift_selection",
        parsedDomain: snapshot.sector,
        parsedTargetCode: snapshot.baseCode,
        parsedAction: "arrival",
        errorMessage: null,
        resolutionData: {
            ...buildTelegramReviewLogData({
                reason: "arrival_missing_name_or_shift",
                parsed: snapshot,
                doctorQuery,
                trainingCandidate: true,
            }),
            ...data,
        },
    });

    await sendMessage(
        params.message.chat.id,
        buildShiftSelectionPromptText({
            doctorLabel: doctorQuery ?? senderName ?? "o médico",
            targetLabel: snapshot.baseCode,
        }),
        params.message.message_id,
        buildShiftSelectionKeyboard(params.logId),
        { parseMode: "Markdown" },
    );
}

// PIAM SD/SN vira pendência com botões [☀️ SD 07h–19h] [🌙 SN 19h–07h]
// (auditoria §3.1#12). Também aceita "SD"/"SN" por texto — solto (pendência do
// mesmo autor) ou como reply ao balão-pergunta (promptMessageId).
async function queuePendingPiamShift(params: {
    logId: string;
    parsed: OperationalParsedEntry;
    resolvedDoctor: ResolvedTelegramDoctorRef;
    senderTelegramId: string;
    originalText: string;
    referenceAt: Date;
    delivery:
        | { via: "message"; chatId: number; replyToMessageId: number }
        | { via: "edit"; chatId: number; messageId: number; callbackQueryId: string };
}) {
    const snapshot: OperationalParsedEntry = {
        sector: params.parsed.sector,
        baseCode: params.parsed.baseCode,
        arrivalTime: params.parsed.arrivalTime,
        shiftType: null,
        roleFunction: params.parsed.roleFunction,
        isShadow: params.parsed.isShadow ?? false,
        isDeparture: params.parsed.isDeparture,
        isContinuation: params.parsed.isContinuation,
        isReassignment: params.parsed.isReassignment ?? false,
    };
    const data: PendingPiamShiftData = {
        kind: "piam_shift",
        parsed: snapshot,
        resolvedDoctor: params.resolvedDoctor,
        senderTelegramId: params.senderTelegramId,
        originalText: params.originalText,
        originalReferenceAt: params.referenceAt.toISOString(),
    };

    await markTelegramProcessed(params.logId, {
        status: "pending_piam_shift",
        parsedDomain: snapshot.sector,
        parsedTargetCode: snapshot.baseCode,
        parsedAction: resolveTelegramParsedAction(snapshot),
        parsedDoctorName: params.resolvedDoctor.fullName,
        errorMessage: null,
        resolutionData: { ...data },
    });

    const promptText = buildPiamShiftPromptText(resolveTelegramDoctorSurfaceName(params.resolvedDoctor));
    const keyboard = buildPiamShiftKeyboard(params.logId);
    let promptMessageId: number | null = null;
    if (params.delivery.via === "message") {
        const sent = await sendMessage(params.delivery.chatId, promptText, params.delivery.replyToMessageId, keyboard, { parseMode: "Markdown" });
        promptMessageId = sent && typeof sent === "object" ? sent.message_id : null;
    } else {
        await editMessageText(params.delivery.chatId, params.delivery.messageId, promptText, keyboard, { parseMode: "Markdown" });
        await answerCallbackQuery(params.delivery.callbackQueryId, "PIAM: confirme o turno (SD ou SN).");
        promptMessageId = params.delivery.messageId;
    }

    if (promptMessageId) {
        await markTelegramProcessed(params.logId, {
            resolutionData: { ...data, promptMessageId },
        });
    }
}

// ── Conflito de destino no remanejamento ──────────────────────────────────────────
// Fim de cobertura de um ocupante do destino: scheduledEndAt quando existe, senão a
// expiração implícita do turno (SD/SN = próxima virada; P = 07:00 do dia seguinte).
export function resolveReassignmentConflictCoverageEndAt(params: {
    startedAt: Date;
    boardStartedAt: Date | null;
    scheduledEndAt: Date | null;
    shiftLabel: string | null;
}): Date | null {
    if (params.scheduledEndAt) {
        return params.scheduledEndAt;
    }
    const anchor = params.boardStartedAt ?? params.startedAt;
    const shiftLabel: OccupancyShiftLabel = params.shiftLabel === "P" || params.shiftLabel === "SD" || params.shiftLabel === "SN"
        ? params.shiftLabel
        : null;
    return resolveImplicitOccupancyExpiry(anchor, shiftLabel);
}

// Ocupante cuja cobertura já venceu (ex.: P da véspera que o painel esconde às 07:15
// mas nunca fecha) é um fantasma: rendemos automaticamente em vez de bloquear o
// remanejamento — mesmo tratamento que uma chegada comum dá ao carry-over.
export function isExpiredReassignmentConflict(coverageEndAt: Date | null, eventAt: Date) {
    return Boolean(coverageEndAt && coverageEndAt.getTime() <= eventAt.getTime());
}

// Mensagem curta para conflito real (ocupante com cobertura vigente). Vai atrás do
// prefixo "Não consegui registrar essa chegada." em sendTelegramArrivalFailureReply.
export function buildReassignmentTargetOccupiedMessage(params: {
    occupantName: string;
    targetLabel: string;
}) {
    return `Encontrei *${params.occupantName}* em *${params.targetLabel}*. Se essa pessoa já saiu, declare a saída dela (ex.: \`${params.occupantName} saiu ${params.targetLabel}\`) e depois reenvie sua chegada.`;
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
    piamRouting?: { applied: boolean; originalCode: string | null };
}) {
    const db = getDb();
    const { parsed, resolvedDoctor, eventAt, messageText } = params;
    const piamRouting = params.piamRouting ?? { applied: false, originalCode: null };

    // Step 1: Find the doctor's current active occupancy (any domain)
    const activeOcc = params.activeOcc ?? await findActiveOccupancyByDoctorId(resolvedDoctor.id, eventAt);
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
    let renderedGhostDoctorName: string | null = null;
    if (parsed.sector === "REGULATION") {
        const post = await db.query.regulationPosts.findFirst({
            where: eq(regulationPosts.code, targetCode),
        });
        if (!post) {
            throw new Error("Ramal de destino nao encontrado.");
        }

        // Só um BOARD CARRIER (board_started_at não nulo) bloqueia o destino. Um
        // ocupante já deslocado (board nulo, aguardando redeclarar) coexiste e não
        // conflita — é justamente esse o estado deixado por uma tomada confirmada.
        const targetConflict = await db.query.regulationOccupancies.findFirst({
            where: and(
                eq(regulationOccupancies.postId, post.id),
                isNull(regulationOccupancies.endedAt),
                isNotNull(regulationOccupancies.boardStartedAt),
            ),
        });
        if (targetConflict && targetConflict.doctorId !== resolvedDoctor.id) {
            const coverageEndAt = resolveReassignmentConflictCoverageEndAt(targetConflict);
            const occupantDoc = await db.query.doctors.findFirst({ where: eq(doctors.id, targetConflict.doctorId) });
            const occupantName = resolveTelegramDoctorSurfaceName(occupantDoc);
            if (!isExpiredReassignmentConflict(coverageEndAt, eventAt)) {
                throw new Error(buildReassignmentTargetOccupiedMessage({ occupantName, targetLabel: targetCode }));
            }
            // Cobertura vencida: rendição automática. endRegulationOccupancy capa o
            // endedAt no scheduledEndAt do fantasma (ex.: P da véspera fecha às 07:15).
            await endRegulationOccupancy(targetConflict.id, { endedAt: eventAt, handoffClosure: true });
            renderedGhostDoctorName = occupantName;
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
                isNotNull(interventionOccupancies.boardStartedAt),
            ),
        });
        if (targetConflict && targetConflict.doctorId !== resolvedDoctor.id) {
            const coverageEndAt = resolveReassignmentConflictCoverageEndAt(targetConflict);
            const occupantDoc = await db.query.doctors.findFirst({ where: eq(doctors.id, targetConflict.doctorId) });
            const occupantName = resolveTelegramDoctorSurfaceName(occupantDoc);
            if (!isExpiredReassignmentConflict(coverageEndAt, eventAt)) {
                throw new Error(buildReassignmentTargetOccupiedMessage({ occupantName, targetLabel: targetCode }));
            }
            // Cobertura vencida: rendição automática, fechando no fim da cobertura do
            // fantasma (endInterventionOccupancy não capa sozinho no scheduledEndAt).
            const ghostEndedAt = coverageEndAt && coverageEndAt.getTime() < eventAt.getTime() ? coverageEndAt : eventAt;
            await endInterventionOccupancy(targetConflict.id, { endedAt: ghostEndedAt, handoffClosure: true });
            renderedGhostDoctorName = occupantName;
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
        displacedDoctorName: renderedGhostDoctorName,
        extendedLongShift: false,
        continuityInterpretation: null as ContinuityInterpretation | null,
        piamAutoAllocated: piamRouting.applied,
        piamOriginalCode: piamRouting.originalCode,
        forwardContinuityPrompt: null as ForwardContinuityPrompt,
    };
}

// ── Tomada de ramal/base ocupado no mesmo turno (confirmação por reenvio) ──────────
// Comportamento basal mudou: declarar chegada num ramal/ambulância já ocupado por
// OUTRO médico NO MESMO TURNO não desloca mais ninguém automaticamente. O bot avisa
// quem ocupa e pede o reenvio EXATO da mensagem para confirmar. Só então o ocupante
// é "deslocado" (sai do quadro, chegada preservada, pode redeclarar nova posição).
// Rendição normal cross-turno (carry-over do turno anterior) segue automática.
const TAKEOVER_CONFIRMATION_WINDOW_MS = 30 * 60 * 1000;

type TakeoverPendingData = {
    kind: "takeover_confirmation";
    sector: "REGULATION" | "INTERVENTION";
    targetCode: string;
    arrivingDoctorId: string;
    occupantDoctorId: string;
    occupantOccupancyId: string;
    // Texto original da chegada que disparou a tomada. Permite confirmar com o atalho
    // curto "confirmo NNNN" (ou o botão ✅) reprocessando exatamente a intenção original.
    arrivingMessageText?: string;
    // Autor da chegada que disparou a tomada — valida quem toca no botão
    // (autor ou chefia/admin; terceiro leva alert). Aditivo (auditoria §3.1#4).
    senderTelegramId?: string;
    // Quem confirmou/cancelou via botão (auditoria — pode ser chefia, não o autor).
    pressedByTelegramId?: string;
};

function isTakeoverPendingData(value: unknown): value is TakeoverPendingData {
    return Boolean(value)
        && typeof value === "object"
        && (value as { kind?: unknown }).kind === "takeover_confirmation";
}

export function takeoverPendingMatches(data: TakeoverPendingData, incoming: {
    sector: "REGULATION" | "INTERVENTION";
    targetCode: string;
    arrivingDoctorId: string;
    occupantDoctorId: string;
}) {
    return data.sector === incoming.sector
        && data.targetCode.trim().toUpperCase() === incoming.targetCode.trim().toUpperCase()
        && data.arrivingDoctorId === incoming.arrivingDoctorId
        && data.occupantDoctorId === incoming.occupantDoctorId;
}

export function isWithinTakeoverConfirmationWindow(pendingCreatedAt: Date, referenceAt: Date) {
    return referenceAt.getTime() - pendingCreatedAt.getTime() <= TAKEOVER_CONFIRMATION_WINDOW_MS;
}

// Balão de tomada (auditoria §3.1#4): botões + janela de *30 min* explícita, com os
// fallbacks textuais preservados (`confirmo NNNN` e reenvio exato). Enviado com
// parseMode Markdown — TODA interpolação passa por escapeTelegramMarkdown.
export function buildTakeoverWarningReply(params: {
    occupantName: string;
    targetLabel: string;
    shiftLabel: string | null;
    sinceTime: string;
}) {
    const occupant = escapeTelegramMarkdown(params.occupantName);
    const occupantLoud = escapeTelegramMarkdown(params.occupantName.toUpperCase());
    const target = escapeTelegramMarkdown(params.targetLabel);
    const turno = params.shiftLabel ? ` (${escapeTelegramMarkdown(params.shiftLabel)})` : "";
    // Barulhento de propósito: quem chega num posto ocupado precisa VER quem está
    // lá e entender a consequência de insistir — nada de deslocar em silêncio.
    return `🚨🚨 *ATENÇÃO — POSTO OCUPADO* 🚨🚨`
        + `\n\n⚠️ *${target}* já está ocupado por *${occupant}*${turno}, desde *${params.sinceTime}*.`
        + `\n\n👉 Se você confirmar, *${occupantLoud} SERÁ RETIRADO(A) DO QUADRO* deste posto.`
        + `\n\nVai assumir no lugar? Toque abaixo — ou responda \`confirmo ${sanitizeTelegramCodeSpan(params.targetLabel)}\` (ou reenvie a chegada exata) em até *30 min*.`
        + `\n🔁 A chegada de ${occupant} fica preservada: dá para declarar uma nova posição depois, sem contar atraso.`;
}

export function buildTakeoverDisplacedAnnouncement(params: {
    arrivingName: string;
    occupantName: string;
    targetLabel: string;
    sinceTime: string;
}) {
    // Forma neutra ("ficou fora do quadro", não "foi deslocado") + exemplo de como
    // declarar a nova posição (auditoria §3.1#18). Interpolações escapadas —
    // enviado com parseMode Markdown, como reply da mensagem que confirmou.
    const arriving = escapeTelegramMarkdown(params.arrivingName);
    const occupant = escapeTelegramMarkdown(params.occupantName);
    const target = escapeTelegramMarkdown(params.targetLabel);
    return `🔁 *${arriving}* assumiu *${target}*. *${occupant}* ficou fora do quadro (chegada preservada desde *${params.sinceTime}*) e precisa declarar uma nova posição.`
        + `\nEx.: _${occupant} <ramal ou base destino>_`;
}

async function findActiveSameTurnoBoardCarrierOnTarget(params: {
    sector: "REGULATION" | "INTERVENTION";
    targetCode: string;
    eventAt: Date;
    excludeDoctorId: string;
}): Promise<{ occupancyId: string; doctorId: string; doctorName: string; startedAt: Date; shiftLabel: string | null } | null> {
    const db = getDb();
    const windowStart = resolveOperationalShiftWindow(params.eventAt).startedAt;

    if (params.sector === "REGULATION") {
        const post = await db.query.regulationPosts.findFirst({
            where: eq(regulationPosts.code, params.targetCode),
        });
        if (!post) {
            return null;
        }
        const occ = await db.query.regulationOccupancies.findFirst({
            where: and(
                eq(regulationOccupancies.postId, post.id),
                isNull(regulationOccupancies.endedAt),
                isNotNull(regulationOccupancies.boardStartedAt),
                ne(regulationOccupancies.doctorId, params.excludeDoctorId),
            ),
            orderBy: [desc(regulationOccupancies.boardStartedAt)],
        });
        if (!occ) {
            return null;
        }
        const occupancyAnchorAt = occ.boardStartedAt ?? occ.startedAt;

        // "Mesmo turno": o ocupante chegou DENTRO da janela de turno atual. Carry-over
        // do turno anterior (started_at antes da janela) é rendição normal, não tomada.
        // Também não é tomada quando a chegada é para o PRÓXIMO turno (relevo de fim de
        // plantão ~17h/05h): o ocupante do turno que acaba é rendido normalmente.
        if (occupancyAnchorAt.getTime() < windowStart.getTime()
            || !isSameOperationalShiftArrival(occupancyAnchorAt, params.eventAt)) {
            return null;
        }
        const doc = await db.query.doctors.findFirst({ where: eq(doctors.id, occ.doctorId) });
        return {
            occupancyId: occ.id,
            doctorId: occ.doctorId,
            doctorName: resolveTelegramDoctorSurfaceName(doc),
            startedAt: occupancyAnchorAt,
            shiftLabel: occ.shiftLabel,
        };
    }

    const base = await db.query.interventionBases.findFirst({
        where: eq(interventionBases.code, params.targetCode),
    });
    if (!base) {
        return null;
    }
    const occ = await db.query.interventionOccupancies.findFirst({
        where: and(
            eq(interventionOccupancies.baseId, base.id),
            isNull(interventionOccupancies.endedAt),
            isNotNull(interventionOccupancies.boardStartedAt),
            ne(interventionOccupancies.doctorId, params.excludeDoctorId),
        ),
        orderBy: [desc(interventionOccupancies.boardStartedAt)],
    });
    if (!occ) {
        return null;
    }
    const occupancyAnchorAt = occ.boardStartedAt ?? occ.startedAt;
    if (occupancyAnchorAt.getTime() < windowStart.getTime()
        || !isSameOperationalShiftArrival(occupancyAnchorAt, params.eventAt)) {
        return null;
    }
    const doc = await db.query.doctors.findFirst({ where: eq(doctors.id, occ.doctorId) });
    return {
        occupancyId: occ.id,
        doctorId: occ.doctorId,
        doctorName: resolveTelegramDoctorSurfaceName(doc),
        startedAt: occupancyAnchorAt,
        shiftLabel: occ.shiftLabel,
    };
}

// Códigos REAIS ativos de ramais e bases — fonte para as sugestões de destino
// desconhecido (auditoria §3.1#9: nunca hardcode na copy).
async function listActiveTargetCodes(): Promise<string[]> {
    const db = getDb();
    const posts = await db
        .select({ code: regulationPosts.code })
        .from(regulationPosts)
        .where(eq(regulationPosts.isActive, true));
    const bases = await db
        .select({ code: interventionBases.code })
        .from(interventionBases)
        .where(eq(interventionBases.isActive, true));
    return [...posts, ...bases].map((row) => row.code);
}

// Destino desconhecido com diagnóstico (auditoria §3.1#9 / §5#7): nomeia o token
// rejeitado e sugere até 3 códigos reais próximos. Com nome+turno presentes, as
// sugestões viram botões que completam o registro (senão encadearia com o F6 —
// nesse caso, só texto). Retorna null quando não há candidato a destino.
async function respondUnknownDestination(params: {
    logId: string;
    message: NonNullable<TelegramUpdate["message"]>;
    rawPartial: ParsedMessage;
}) {
    const token = params.rawPartial.unknownTargetToken?.trim().toUpperCase();
    if (!token) {
        return null;
    }
    const { message, rawPartial } = params;

    const suggestions = suggestNearestTargetCodes(token, await listActiveTargetCodes());
    const senderTelegramId = message.from?.id ? String(message.from.id) : null;
    const hasShift = Boolean(rawPartial.shiftType);
    const hasName = rawPartial.extractedNames.length > 0;

    // Botões só quando a reconstrução com o código sugerido volta a parsear —
    // sugestão que o parser não conhece não pode virar botão (completaria em erro).
    const interactive: string[] = [];
    if (hasShift && hasName && senderTelegramId) {
        for (const code of suggestions) {
            const reconstructed = replaceUnknownTargetToken(message.text!, token, code);
            if (!reconstructed) {
                continue;
            }
            const reparsed = parseMessageMulti(reconstructed).find((entry) => !entry.isDeparture);
            if (reparsed?.baseCode === code && reparsed.sector) {
                interactive.push(code);
            }
        }
    }

    if (interactive.length > 0 && senderTelegramId) {
        await markTelegramProcessed(params.logId, {
            status: "pending_destination_selection",
            parsedAction: "arrival",
            errorMessage: "unknown_destination",
            resolutionData: {
                kind: "destination_selection",
                token,
                suggestions: interactive,
                senderTelegramId,
                senderName: [message.from?.first_name, message.from?.last_name].filter(Boolean).join(" ") || null,
                originalText: message.text!,
                originalReferenceAt: new Date(message.date * 1000).toISOString(),
            } satisfies PendingDestinationSelectionData,
        });
        await sendMessage(
            message.chat.id,
            buildUnknownDestinationReplyText({ token, suggestions: interactive, interactive: true }),
            message.message_id,
            buildDestinationSelectionKeyboard(interactive, params.logId),
            { parseMode: "Markdown" },
        );
        return { ok: true, ignored: true, pending: true };
    }

    await markTelegramProcessed(params.logId, {
        status: "ignored",
        errorMessage: "unknown_destination",
        resolutionData: {
            ...buildTelegramReviewLogData({ reason: "unknown_destination", trainingCandidate: true }),
            unknownDestinationToken: token,
            suggestions,
        },
    });
    await sendMessage(
        message.chat.id,
        buildUnknownDestinationReplyText({ token, suggestions, interactive: false }),
        message.message_id,
        undefined,
        { parseMode: "Markdown" },
    );
    return { ok: true, ignored: true };
}

async function findPendingTakeoverConfirmation(chatId: string, senderTelegramId: string) {
    const db = getDb();
    return db.query.telegramIngestedMessages.findFirst({
        where: and(
            eq(telegramIngestedMessages.chatId, chatId),
            eq(telegramIngestedMessages.senderTelegramId, senderTelegramId),
            eq(telegramIngestedMessages.status, "pending_takeover_confirmation"),
        ),
        orderBy: [desc(telegramIngestedMessages.createdAt)],
    });
}

// Atalho curto de confirmação de tomada: "confirmo NNNN" (ou XX99 / NUCLEO / PIAM).
// Em vez de exigir reenvio EXATO da chegada, o ocupante/chefia confirma com uma linha
// curta. Casamos a tomada pendente do remetente pelo destino + janela e reprocessamos
// o texto ORIGINAL da chegada (guardado na pendência), que então segue o fluxo normal
// e confirma a tomada (desloca ocupante + registra a chegada de quem assumiu).
const TAKEOVER_CONFIRM_SHORTCUT_RE = /^\s*confirm[oa]\b[\s:]*(?:a|o|que|no|na|posto|ramal|base|assumir|tomada)?\s*([A-Za-z]{2}\s?-?\s?\d{2}|\d{4}|nucleo|n[úu]cleo|piam)\b/i;

function normalizeTakeoverTargetCode(value: string) {
    return value
        .normalize("NFD")
        .replace(/[̀-ͯ]/g, "")
        .replace(/[\s-]/g, "")
        .toUpperCase();
}

// Reconhece o atalho curto de confirmação de tomada ("confirmo NNNN" / "confirmo PM04"
// / "confirmo nucleo") e devolve o código-alvo normalizado, ou null se não casar.
export function parseTakeoverConfirmShortcut(text: string | null | undefined): string | null {
    if (!text) {
        return null;
    }
    const match = text.match(TAKEOVER_CONFIRM_SHORTCUT_RE);
    return match ? normalizeTakeoverTargetCode(match[1]) : null;
}

async function tryHandlePendingTakeoverConfirmation(update: TelegramUpdate, logId: string) {
    const message = update.message;
    if (!message?.text || !message.from?.id) {
        return null;
    }

    const requestedTarget = parseTakeoverConfirmShortcut(message.text);
    if (!requestedTarget) {
        return null;
    }

    const pending = await findPendingTakeoverConfirmation(String(message.chat.id), String(message.from.id));
    const data = pending && isTakeoverPendingData(pending.resolutionData)
        ? (pending.resolutionData as TakeoverPendingData)
        : null;
    const referenceAt = new Date(message.date * 1000);
    const valid = Boolean(pending) && Boolean(data)
        && Boolean(data!.arrivingMessageText)
        && normalizeTakeoverTargetCode(data!.targetCode) === requestedTarget
        && isWithinTakeoverConfirmationWindow(pending!.createdAt, referenceAt);

    if (!valid) {
        await markTelegramProcessed(logId, {
            status: "ignored",
            parsedTargetCode: requestedTarget,
            errorMessage: "takeover_confirmation_no_pending",
        });
        await sendMessage(
            message.chat.id,
            `🤔 Não encontrei uma tomada pendente para *${requestedTarget}* no seu nome (a confirmação expira em alguns minutos). Reenvie a chegada que você quer registrar e eu peço a confirmação de novo.`,
            message.message_id,
        );
        return { ok: true, ignored: true };
    }

    // Reescreve o texto efetivo para a chegada original e devolve null: o fluxo principal
    // segue, reencontra a tomada pendente e a confirma. A pendência só é marcada como
    // aceita lá; aqui apenas traduzimos "confirmo NNNN" -> intenção original.
    message.text = data!.arrivingMessageText!;
    return null;
}

async function applyParsedEntry(params: {
    parsed: OperationalParsedEntry;
    resolvedDoctor: ResolvedTelegramDoctorRef;
    eventAt: Date;
    referenceAt: Date;
    messageText: string;
}) {
    const db = getDb();
    const { parsed, resolvedDoctor, referenceAt, messageText } = params;
    // Back-correction guard: HH:mm > 4h no futuro em chegadas vira HH:mm de
    // ontem (ver normalizeArrivalEventTime). Saidas e continuacoes/reassignments
    // mantem o evento como veio porque preannouncement de saida noturna e legitimo.
    const eventAt = parsed.isDeparture || parsed.isContinuation || parsed.isReassignment
        ? params.eventAt
        : normalizeArrivalEventTime(params.eventAt, referenceAt);

    // PIAM auto-routing: doctors marked with preferredOperationalRole=PIAM are always
    // allocated to the PIAM regulation slot on arrival, regardless of the code they typed.
    // For PIAM, the bot also forces 07:00/19:00 bounds and closes the plantao immediately
    // so payment closing already sees a finished, no-bank-hours shift.
    const piamRouting = !parsed.isDeparture
        ? await maybeApplyPiamRouting(parsed, resolvedDoctor.id)
        : { applied: false, originalCode: null as string | null };

    if (piamRouting.applied && !parsed.isDeparture && (parsed.shiftType === "SD" || parsed.shiftType === "SN")) {
        return handlePiamAutoArrival({
            parsed,
            doctorId: resolvedDoctor.id,
            shiftLabel: parsed.shiftType,
            eventAt,
            messageText,
            originalCode: piamRouting.originalCode,
        });
    }

    const activeOcc = !parsed.isDeparture
        ? await findActiveOccupancyByDoctorId(resolvedDoctor.id, eventAt)
        : null;

    const implicitReassignment = shouldTreatTelegramArrivalAsImplicitReassignment({
        sector: parsed.sector,
        baseCode: parsed.baseCode,
        arrivalTime: parsed.arrivalTime,
        shiftType: parsed.shiftType,
        roleFunction: parsed.roleFunction,
        isShadow: parsed.isShadow,
        isDeparture: parsed.isDeparture,
        isContinuation: parsed.isContinuation,
        isReassignment: parsed.isReassignment,
        activeSector: activeOcc?.sector,
        activeBaseCode: activeOcc?.baseCode,
        activeShiftLabel: activeOcc?.shiftLabel,
    });

    // Handle reassignment as a special case (end source + start target)
    if (parsed.isReassignment || implicitReassignment) {
        return handleTelegramReassignment({ parsed, resolvedDoctor, eventAt, messageText, activeOcc, piamRouting });
    }

    let occupancyId: string | null = null;
    let successKind: "standard" | "departure_adjusted" = "standard";
    let treatedAsContinuation = false;
    let autoReactivated = false;
    let replyTimeAt = eventAt;
    let effectiveShiftType: string | null = parsed.shiftType ?? null;
    if (!parsed.isDeparture && parsed.isContinuation) {
        // "continua" diz de onde o médico VEM, não que ele promete mais 24h. O rótulo
        // aqui é o turno em que ele está chegando — nunca "P", que daria a este registro
        // cobertura de 24h e, com ela, pagamento do turno seguinte sem tê-lo trabalhado
        // (doesCandidateCoverPaymentSlot) e a tag "Continua" travada no lugar do botão de
        // retirar (continuesBeyondShift).
        //
        // O rótulo continua preenchido — a preocupação original de não deixar SD/SN/null
        // sumir de painéis com escopo de turno segue atendida, agora com o turno certo.
        // Continuidade no MESMO posto é outro caminho (continueRegulation/Intervention
        // Occupancy), que estende a ocupação existente em um bloco de 12h e mantém "P".
        effectiveShiftType = resolveArrivalShiftLabel(eventAt);
    }
    let continuationFrom: string | null = null;
    let displacedDoctorName: string | null = null;
    // Marca quando uma continuidade estendeu a cobertura alem de 24h (plantao
    // prolongado ~36h+). Usado so para alertar o medico na resposta.
    let extendedLongShift = false;
    // Interpretacao auditavel da continuidade (classificacao + explicacao
    // verbosa). Persistida em telegram_ingested_messages.resolution_data.
    let continuityInterpretation: ContinuityInterpretation | null = null;
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
                // Se já há um sucessor (outro médico) com ocupação aberta no mesmo posto, A foi rendido:
                // fecha como handoff (só endedAt) para não cair na fila finalizadora do chefe.
                const openSuccessor = await db.query.regulationOccupancies.findFirst({
                    where: and(
                        eq(regulationOccupancies.postId, post.id),
                        isNull(regulationOccupancies.endedAt),
                        ne(regulationOccupancies.id, occupancy.id),
                        ne(regulationOccupancies.doctorId, resolvedDoctor.id),
                    ),
                });
                const handoffClosure = shouldCloseAsHandoff({ hasSuccessor: Boolean(openSuccessor) });
                occupancyId = (await endRegulationOccupancy(occupancy.id, handoffClosure
                    ? { endedAt: eventAt, handoffClosure: true }
                    : { endedAt: eventAt, actualEndedAt: eventAt })).id;
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
                    && !isTelegramCreditEligibleClaim(messageText, [parsed.baseCode, resolvedDoctor.fullName, parsed.arrivalTime])
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
                const continued = await continueRegulationOccupancy(activeOccupancy.id, {
                    notes: messageText,
                    continuedAt: eventAt.getTime() > referenceAt.getTime() ? referenceAt : eventAt,
                }, null);
                occupancyId = continued.id;
                treatedAsContinuation = true;
                // Resposta e interpretação sempre com a chegada ORIGINAL da cadeia:
                // num "continua" repetido a ativa é o bloco novo (started 19:00+) e
                // responder com o started dele fazia o bot "esquecer" que o médico
                // estava desde a manhã (queixa recorrente dos plantonistas de P).
                replyTimeAt = activeOccupancy.boardStartedAt ?? activeOccupancy.startedAt;
                effectiveShiftType = continued.shiftLabel ?? "P";
                extendedLongShift = isExtendedLongShift(continued.boardStartedAt, continued.scheduledEndAt);
                continuityInterpretation = buildContinuityInterpretation({
                    doctorSurfaceName: resolvedDoctor.displayName ?? resolvedDoctor.fullName,
                    anchorStartedAt: activeOccupancy.boardStartedAt ?? activeOccupancy.startedAt,
                    scheduledEndBefore: activeOccupancy.scheduledEndAt,
                    continuedBoardStartedAt: continued.boardStartedAt,
                    continuedScheduledEndAt: continued.scheduledEndAt,
                    extendedLongShift,
                });
            } else {
                const assumedHalfShift = shouldAssumeTelegramHalfShift({
                    parsed,
                    eventAt,
                    effectiveShiftType,
                });
                const halfShiftScheduledEndAt = assumedHalfShift ? resolveHalfShiftScheduledEndAt(eventAt) : null;
                // O início agendado do meio plantão é SEMPRE a hora esperada (11:30),
                // não o instante em que o médico avisou. Assim o banco de horas mede
                // atraso a partir das 11:30 (com a mesma tolerância de 15 min) em vez
                // de tratar todo aviso como pontual.
                const halfShiftScheduledStartAt = assumedHalfShift ? resolveHalfShiftScheduledStartAt(eventAt) : null;
                const continuityContext = parsed.isDeparture
                    ? null
                    : await findTelegramContinuityContext({
                        doctorId: resolvedDoctor.id,
                        eventAt,
                        explicitContinuation: Boolean(parsed.isContinuation),
                    });
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

                let isCrossTargetContinuation = false;
                if (shouldUseContinuityContext) {
                    await closeTelegramActiveContinuityOccupancies({
                        doctorId: resolvedDoctor.id,
                        eventAt,
                        excludeOccupancyId: activeOccupancy?.id ?? null,
                    });

                    const sourceCode = activeOcc?.baseCode ?? await resolveTelegramContinuitySourceCode(continuityContext?.source);
                    if (sourceCode && sourceCode !== parsed.baseCode) {
                        continuationFrom = sourceCode;
                        isCrossTargetContinuation = true;
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

                // Continuidade NÃO é promessa de mais 24h. Quem vinha do turno anterior e
                // avisa que segue em OUTRO posto abre um bloco novo de 12h: o turno em que
                // está chegando. O vínculo com o plantão anterior vive no continuityGroupId
                // e no boardStartedAt — não no rótulo.
                //
                // Marcar esse registro como "P" dava a ele cobertura de 24h, e a cobertura
                // é o que decide pagamento (doesCandidateCoverPaymentSlot) e a tag "Continua"
                // no quadro (continuesBeyondShift): o médico era pago pelo turno seguinte sem
                // tê-lo trabalhado e ficava presa a tag em vez do botão de retirar.
                // Caso Ana Beatriz 31/07: SN na 2031 → continua na CZ50 e aparece pago no SN
                // do dia seguinte.

                // CROSS-TARGET CONTINUATION FIX (continuation-bug audit, May/2026):
                // When the doctor is moving from one post/base to another between shifts
                // (e.g. 2153 SD → PR03 P), startedAt must reflect when they actually arrived
                // at the NEW target (eventAt), not the original anchor of the previous
                // post. boardStartedAt keeps the historical anchor so the panel still
                // shows the early-morning arrival and bank hours sum the full continuity
                // chain — but the projection sees the real arrival window at this target
                // and stops truncating the displaced doctor as micro-coverage.
                //
                // The cross-shift expiry guard remains for same-target continuations whose
                // anchor falls in an already-expired P window.
                // Âncora numa janela P já expirada: o started_at não pode retroagir ao
                // plantão anterior, mas também não é a hora da mensagem — a continuidade
                // diz que o médico está no posto desde o início do turno corrente
                // (caso Uenderson 08:12, jul/2026: mensagem das 08:12 não é chegada).
                const crossShiftExpiry = shouldUseContinuityContext
                    ? resolveProlongedShiftExpiry(continuationStartedAt, "P")
                    : null;
                // Continuação explícita: o bloco novo começa na virada referenciada
                // (nunca no âncora da manhã — ver resolveTelegramExplicitContinuationBlock).
                // Se o âncora já cai dentro do bloco novo (chegada real depois da
                // virada), ele prevalece para não creditar tempo não trabalhado.
                const explicitContinuationBlock = shouldUseContinuityContext && parsed.isContinuation
                    ? resolveTelegramExplicitContinuationBlock(eventAt)
                    : null;
                const effectiveContinuationStartedAt = isCrossTargetContinuation
                    ? eventAt
                    : explicitContinuationBlock
                        ? new Date(Math.max(explicitContinuationBlock.blockStartAt.getTime(), continuationStartedAt.getTime()))
                        : (crossShiftExpiry && crossShiftExpiry.getTime() <= eventAt.getTime()
                            ? resolveContinuationShiftStart(eventAt, parsed.shiftType)
                            : continuationStartedAt);
                if (shouldUseContinuityContext && continuityContext?.source) {
                    // O bloco novo é o turno da chegada (resolveArrivalShiftLabel já vira para o
                    // turno seguinte quando o médico avisa pouco antes da virada).
                    effectiveShiftType = explicitContinuationBlock?.shiftLabel
                        ?? resolveArrivalShiftLabel(effectiveContinuationStartedAt);
                }

                const createRegulationArrival = (startedAtOverride?: Date) => startRegulationOccupancy({
                    doctorId: resolvedDoctor.id,
                    postId: post.id,
                    continuityGroupId: shouldUseContinuityContext ? continuityContext?.source?.continuityGroupId ?? null : null,
                    startedAt: startedAtOverride ?? effectiveContinuationStartedAt,
                    boardStartedAt: continuationBoardStartedAt,
                    scheduledStartAt: assumedHalfShift ? (halfShiftScheduledStartAt ?? undefined) : undefined,
                    scheduledEndAt: halfShiftScheduledEndAt ?? undefined,
                    shiftLabel: effectiveShiftType,
                    roleLabel: assumedHalfShift ? HALF_SHIFT_ROLE_LABEL : parsed.roleFunction,
                    ramalLabel: parsed.baseCode,
                    isShadow: isShadowArrival,
                    source: "telegram",
                    notes: isShadowArrival
                        ? appendTelegramOperationalNote(null, "telegram sombra", messageText)
                        : messageText,
                    createdByUserId: null,
                });

                let regResult: Awaited<ReturnType<typeof startRegulationOccupancy>>;
                try {
                    regResult = await createRegulationArrival();
                } catch (error) {
                    const errorMessage = error instanceof Error ? error.message : "telegram_processing_failed";
                    if (!shouldForceTelegramTakeoverOnContinuationConflict({ parsed, errorMessage })) {
                        throw error;
                    }

                    const conflictingOccupancy = await db.query.regulationOccupancies.findFirst({
                        where: and(
                            eq(regulationOccupancies.postId, post.id),
                            isNull(regulationOccupancies.endedAt),
                            ne(regulationOccupancies.doctorId, resolvedDoctor.id),
                        ),
                        orderBy: [desc(regulationOccupancies.boardStartedAt), desc(regulationOccupancies.startedAt)],
                    });

                    if (!conflictingOccupancy) {
                        throw error;
                    }

                    // A rendido que manda "continua" no mesmo posto não pode derrubar
                    // o próprio rendedor (risco P0.2 do estudo de continuidade).
                    if (shouldBlockTelegramContinuationTakeoverBySuccessor({
                        isCrossTargetContinuation,
                        sourceEndedAt: continuityContext?.source ? resolveTelegramOperationalEndedAt(continuityContext.source) : null,
                        conflictingStartedAt: conflictingOccupancy.startedAt,
                    })) {
                        throw new Error("Posto ja rendido por outro medico apos a sua saida — continuidade nao registrada. Se for engano, procure a chefia.");
                    }

                    const takeoverAt = resolveTelegramForcedTakeoverAt({
                        eventAt,
                        conflictedStartedAt: conflictingOccupancy.startedAt,
                    });
                    const displacedDoctor = await db.query.doctors.findFirst({
                        where: eq(doctors.id, conflictingOccupancy.doctorId),
                    });

                    // Rendição: B assume o posto de A. Fecha A só com endedAt (handoffClosure),
                    // sem actualEndedAt, para não gerar clique finalizador na fila do chefe e
                    // deixar o banco fechar no horário do handoff. A pode avisar ocorrência depois.
                    await endRegulationOccupancy(conflictingOccupancy.id, {
                        endedAt: takeoverAt,
                        handoffClosure: true,
                    });

                    regResult = await createRegulationArrival(takeoverAt);
                    displacedDoctorName = resolveTelegramDoctorSurfaceName(displacedDoctor);
                }
                occupancyId = regResult.id;
                if (regResult.autoReactivated) autoReactivated = true;

                // Uma continuação nunca pode materializar uma janela já vencida:
                // a varredura de auto-close fecharia a linha em segundos e o bot
                // teria respondido sucesso (bug de 03/08/2026). Vale também para a
                // continuidade IMPLÍCITA (rótulo P / troca SD↔SN sem a palavra
                // "continua") — mesma classe de falha, mesmo erro alto (risco P1.6
                // do estudo). Compara com eventAt, então chegada retroativa legítima
                // não dispara.
                if (
                    shouldUseContinuityContext
                    && regResult.scheduledEndAt
                    && regResult.scheduledEndAt.getTime() <= eventAt.getTime()
                ) {
                    throw new Error("Continuacao caiu numa janela de turno ja encerrada — registro nao efetivado, avise a regulacao.");
                }

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
                // Se já há um sucessor (outro médico) com ocupação aberta na mesma base, A foi rendido:
                // fecha como handoff (só endedAt) para não cair na fila finalizadora do chefe.
                const openSuccessor = await db.query.interventionOccupancies.findFirst({
                    where: and(
                        eq(interventionOccupancies.baseId, base.id),
                        isNull(interventionOccupancies.endedAt),
                        ne(interventionOccupancies.id, occupancy.id),
                        ne(interventionOccupancies.doctorId, resolvedDoctor.id),
                    ),
                });
                const handoffClosure = shouldCloseAsHandoff({ hasSuccessor: Boolean(openSuccessor) });
                occupancyId = (await endInterventionOccupancy(occupancy.id, handoffClosure
                    ? { endedAt: eventAt, handoffClosure: true }
                    : { endedAt: eventAt, actualEndedAt: eventAt })).id;
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
                    && !isTelegramCreditEligibleClaim(messageText, [parsed.baseCode, resolvedDoctor.fullName, parsed.arrivalTime])
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
                // Continuidade genuina AVISADA ("continua") estende o plantao P sem
                // exigir justificativa de saida tardia — paridade com a regulacao.
                // O guard antigo de requiresOvertimeJustification fazia "continua"
                // depois das 19:15 cair no fluxo de "saida tardia" e pedir motivo
                // de ocorrencia/higienizacao (caso Uemerson Alcantara, SM01).
                const continued = await continueInterventionOccupancy(activeOccupancy.id, {
                    notes: messageText,
                    continuedAt: eventAt.getTime() > referenceAt.getTime() ? referenceAt : eventAt,
                }, null);
                occupancyId = continued.id;
                treatedAsContinuation = true;
                // Paridade com a regulação: resposta/interpretação ancoradas na
                // chegada original da cadeia, e rótulo devolvido pelo service
                // (reforço repetido mantém o rótulo do bloco, não vira "P").
                replyTimeAt = activeOccupancy.boardStartedAt ?? activeOccupancy.startedAt;
                effectiveShiftType = continued.shiftLabel ?? "P";
                extendedLongShift = isExtendedLongShift(continued.boardStartedAt, continued.scheduledEndAt);
                continuityInterpretation = buildContinuityInterpretation({
                    doctorSurfaceName: resolvedDoctor.displayName ?? resolvedDoctor.fullName,
                    anchorStartedAt: activeOccupancy.boardStartedAt ?? activeOccupancy.startedAt,
                    scheduledEndBefore: activeOccupancy.scheduledEndAt,
                    continuedBoardStartedAt: continued.boardStartedAt,
                    continuedScheduledEndAt: continued.scheduledEndAt,
                    extendedLongShift,
                });
            } else {
                const continuityContext = parsed.isDeparture
                    ? null
                    : await findTelegramContinuityContext({
                        doctorId: resolvedDoctor.id,
                        eventAt,
                        explicitContinuation: Boolean(parsed.isContinuation),
                    });
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

                let isCrossTargetContinuation = false;
                if (shouldUseContinuityContext) {
                    await closeTelegramActiveContinuityOccupancies({
                        doctorId: resolvedDoctor.id,
                        eventAt,
                        excludeOccupancyId: activeOccupancy?.id ?? null,
                    });

                    const sourceCode = activeOcc?.baseCode ?? await resolveTelegramContinuitySourceCode(continuityContext?.source);
                    if (sourceCode && sourceCode !== parsed.baseCode) {
                        continuationFrom = sourceCode;
                        isCrossTargetContinuation = true;
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

                // Mesma regra da regulação: continuidade abre um bloco de 12h (o turno da
                // chegada), não mais 24h. Ver o comentário longo no branch de regulação.

                // Cross-target continuation: same rationale as the regulation branch above.
                // startedAt = eventAt (real arrival at this base); boardStartedAt holds the
                // historical anchor for panel display, priority ordering and bank hours.
                // Âncora numa janela P já expirada: mesmo racional da regulação — a
                // continuidade ancora no início do turno corrente, não na hora da mensagem.
                const crossShiftExpiryIntv = shouldUseContinuityContext
                    ? resolveProlongedShiftExpiry(continuationStartedAt, "P")
                    : null;
                // Mesma regra da regulação: continuação explícita abre o bloco
                // depois da virada referenciada (resolveTelegramExplicitContinuationBlock).
                const explicitContinuationBlockIntv = shouldUseContinuityContext && parsed.isContinuation
                    ? resolveTelegramExplicitContinuationBlock(eventAt)
                    : null;
                const effectiveContinuationStartedAtIntv = isCrossTargetContinuation
                    ? eventAt
                    : explicitContinuationBlockIntv
                        ? new Date(Math.max(explicitContinuationBlockIntv.blockStartAt.getTime(), continuationStartedAt.getTime()))
                        : (crossShiftExpiryIntv && crossShiftExpiryIntv.getTime() <= eventAt.getTime()
                            ? resolveContinuationShiftStart(eventAt, parsed.shiftType)
                            : continuationStartedAt);
                if (shouldUseContinuityContext && continuityContext?.source) {
                    effectiveShiftType = explicitContinuationBlockIntv?.shiftLabel
                        ?? resolveArrivalShiftLabel(effectiveContinuationStartedAtIntv);
                }

                const createInterventionArrival = (startedAtOverride?: Date) => startInterventionOccupancy({
                    doctorId: resolvedDoctor.id,
                    baseId: base.id,
                    continuityGroupId: shouldUseContinuityContext ? continuityContext?.source?.continuityGroupId ?? null : null,
                    startedAt: startedAtOverride ?? effectiveContinuationStartedAtIntv,
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

                let intResult: Awaited<ReturnType<typeof startInterventionOccupancy>>;
                try {
                    intResult = await createInterventionArrival();
                } catch (error) {
                    const errorMessage = error instanceof Error ? error.message : "telegram_processing_failed";
                    if (!shouldForceTelegramTakeoverOnContinuationConflict({ parsed, errorMessage })) {
                        throw error;
                    }

                    const conflictingOccupancy = await db.query.interventionOccupancies.findFirst({
                        where: and(
                            eq(interventionOccupancies.baseId, base.id),
                            isNull(interventionOccupancies.endedAt),
                            ne(interventionOccupancies.doctorId, resolvedDoctor.id),
                        ),
                        orderBy: [desc(interventionOccupancies.boardStartedAt), desc(interventionOccupancies.startedAt)],
                    });

                    if (!conflictingOccupancy) {
                        throw error;
                    }

                    // Paridade com a regulação: rendido não derruba o próprio rendedor.
                    if (shouldBlockTelegramContinuationTakeoverBySuccessor({
                        isCrossTargetContinuation,
                        sourceEndedAt: continuityContext?.source ? resolveTelegramOperationalEndedAt(continuityContext.source) : null,
                        conflictingStartedAt: conflictingOccupancy.startedAt,
                    })) {
                        throw new Error("Base ja rendida por outro medico apos a sua saida — continuidade nao registrada. Se for engano, procure a chefia.");
                    }

                    const takeoverAt = resolveTelegramForcedTakeoverAt({
                        eventAt,
                        conflictedStartedAt: conflictingOccupancy.startedAt,
                    });
                    const displacedDoctor = await db.query.doctors.findFirst({
                        where: eq(doctors.id, conflictingOccupancy.doctorId),
                    });

                    // Rendição: B assume a base de A. Fecha A só com endedAt (handoffClosure),
                    // sem actualEndedAt, para não gerar clique finalizador na fila do chefe e
                    // deixar o banco fechar no horário do handoff. A pode avisar ocorrência depois.
                    await endInterventionOccupancy(conflictingOccupancy.id, {
                        endedAt: takeoverAt,
                        handoffClosure: true,
                    });

                    intResult = await createInterventionArrival(takeoverAt);
                    displacedDoctorName = resolveTelegramDoctorSurfaceName(displacedDoctor);
                }
                occupancyId = intResult.id;
                if (intResult.autoReactivated) autoReactivated = true;

                // Paridade com a regulação: janela já vencida = erro alto, nunca
                // sucesso silencioso seguido de auto-close — inclusive continuidade
                // implícita (risco P1.6 do estudo).
                if (
                    shouldUseContinuityContext
                    && intResult.scheduledEndAt
                    && intResult.scheduledEndAt.getTime() <= eventAt.getTime()
                ) {
                    throw new Error("Continuacao caiu numa janela de turno ja encerrada — registro nao efetivado, avise a regulacao.");
                }

                if (shouldUseContinuityContext && continuityContext?.source) {
                    treatedAsContinuation = true;
                    replyTimeAt = continuityContext.continuityStartedAt ?? continuityContext.source.startedAt;
                    await syncBankHoursByContinuityGroup(db, continuityContext.source.continuityGroupId);
                }
            }
        }
    }

    // Retardatário na divisão de refeições: chegada/continuação de regulação
    // registrada com a sessão do turno JÁ montada entra no roster na hora, sem
    // esperar a chefia editar o ramal nem "/jantar reiniciar" (incidente de
    // 03/08/2026). Best-effort: falha aqui nunca derruba o registro da chegada.
    if (parsed.sector === "REGULATION" && !parsed.isDeparture && occupancyId && parsed.baseCode) {
        try {
            await ensureArrivalInCurrentMealBreakSession({ ramal: parsed.baseCode });
        } catch (error) {
            console.error("[telegram] falha ao incluir retardatario na sessao de refeicoes", error);
        }
    }

    const assumedHalfShift = shouldAssumeTelegramHalfShift({
        parsed,
        eventAt,
        effectiveShiftType,
    }) && parsed.sector === "REGULATION" && !parsed.isDeparture;

    // "P forward": chegada registrada como P que vai cobrir também o turno seguinte.
    // Só oferecemos o botão de reverter quando NÃO é continuidade do dia
    // (treatedAsContinuation) — espelha a regra do pagamento: quem tem SD no dia
    // fecha às 07h e não avança (ver board.service.ts). Backward não ganha botão.
    // O turno-base vem de resolveContinuityRevertTarget (mesma regra da cobertura),
    // não do relógio: quem chega 06:xx declarando P é P do DIA, 07h→07h de amanhã.
    const isForwardP = effectiveShiftType === "P"
        && !parsed.isDeparture
        && !treatedAsContinuation
        && occupancyId !== null;
    const forwardContinuityPrompt: ForwardContinuityPrompt = isForwardP && occupancyId
        ? {
            occupancyId,
            domain: parsed.sector === "REGULATION" ? "regulation" : "intervention",
            baseShiftLabel: resolveContinuityRevertTarget(eventAt),
        }
        : null;

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
        displacedDoctorName,
        extendedLongShift,
        continuityInterpretation,
        piamAutoAllocated: piamRouting.applied,
        piamOriginalCode: piamRouting.originalCode,
        forwardContinuityPrompt,
    };
}

export const TELEGRAM_PIAM_SHIFT_REQUIRED_ERROR = "telegram_piam_shift_required";

export function isTelegramPiamShiftRequiredError(errorMessage: string | null | undefined) {
    return errorMessage === TELEGRAM_PIAM_SHIFT_REQUIRED_ERROR;
}

export function resolvePiamShiftBounds(eventAt: Date, shiftLabel: "SD" | "SN") {
    const window = resolveOperationalShiftWindow(eventAt);
    if (window.shiftLabel === shiftLabel) {
        return { scheduledStartAt: window.startedAt, scheduledEndAt: window.nextBoundaryAt };
    }
    const nextWindow = resolveOperationalShiftWindow(window.nextBoundaryAt);
    return { scheduledStartAt: nextWindow.startedAt, scheduledEndAt: nextWindow.nextBoundaryAt };
}

async function isPiamPreferredDoctor(doctorId: string) {
    const db = getDb();
    const doctor = await db.query.doctors.findFirst({ where: eq(doctors.id, doctorId) });
    if (!doctor) {
        return false;
    }
    return extractDoctorPreferredOperationalRole(doctor.metadata) === "PIAM";
}

export type PiamAlreadyPresentInfo = {
    role: string;
    shiftLabel: "SD" | "SN";
    isShadow: boolean;
};

async function handlePiamAutoArrival(params: {
    parsed: OperationalParsedEntry;
    doctorId: string;
    shiftLabel: "SD" | "SN";
    eventAt: Date;
    messageText: string;
    originalCode: string | null;
}) {
    const db = getDb();
    const bounds = resolvePiamShiftBounds(params.eventAt, params.shiftLabel);
    const post = await db.query.regulationPosts.findFirst({
        where: eq(regulationPosts.code, "PIAM"),
    });
    if (!post) {
        throw new Error("Ramal PIAM nao cadastrado no sistema.");
    }

    // Reflect the forced PIAM placement on the parsed entry so downstream replies and
    // logs show the final ramal/shift instead of whatever the doctor typed.
    params.parsed.sector = "REGULATION";
    params.parsed.baseCode = "PIAM";
    params.parsed.shiftType = params.shiftLabel;
    params.parsed.arrivalTime = params.shiftLabel === "SD" ? "07:00" : "19:00";

    const arrivalIsShadow = isRegulationShadowOccupancyNotes(params.messageText);

    // Idempotency guard: a doctor already registered on PIAM for THIS shift window
    // (matched by the fixed scheduled start) must never spawn a second occupancy nor
    // open a departure. Re-announcing the same arrival — even from a second person —
    // gets a didactic reply, no mutation. This covers both the still-open shadow and
    // the titular that was already closed at the fixed scheduled end.
    const existingThisShift = await db.query.regulationOccupancies.findFirst({
        where: and(
            eq(regulationOccupancies.postId, post.id),
            eq(regulationOccupancies.doctorId, params.doctorId),
            eq(regulationOccupancies.scheduledStartAt, bounds.scheduledStartAt),
        ),
        orderBy: [desc(regulationOccupancies.startedAt)],
    });
    if (existingThisShift) {
        return {
            occupancyId: existingThisShift.id,
            successKind: "standard" as const,
            treatedAsContinuation: false,
            replyTimeAt: bounds.scheduledStartAt,
            autoReactivated: false,
            effectiveShiftType: params.shiftLabel,
            reassignedFrom: null as string | null,
            assumedHalfShift: false,
            continuationFrom: null as string | null,
            displacedDoctorName: null as string | null,
            extendedLongShift: false,
            continuityInterpretation: null as ContinuityInterpretation | null,
            piamAutoAllocated: true,
            piamOriginalCode: params.originalCode,
            forwardContinuityPrompt: null as ForwardContinuityPrompt,
            alreadyPresent: {
                role: "PIAM",
                shiftLabel: params.shiftLabel,
                isShadow: isRegulationShadowOccupancyNotes(existingThisShift.notes),
            } as PiamAlreadyPresentInfo,
        };
    }

    const reg = await startRegulationOccupancy({
        doctorId: params.doctorId,
        postId: post.id,
        startedAt: bounds.scheduledStartAt,
        boardStartedAt: bounds.scheduledStartAt,
        scheduledStartAt: bounds.scheduledStartAt,
        scheduledEndAt: bounds.scheduledEndAt,
        shiftLabel: params.shiftLabel,
        roleLabel: "PIAM",
        ramalLabel: "PIAM",
        source: "telegram",
        notes: `[PIAM auto ${params.shiftLabel}] ${params.messageText}`.trim(),
        createdByUserId: null,
    });

    // A PIAM "sombra" coexists with the titular and must stay OPEN (ended_at null) so
    // the live board renders it through the shadow query — exactly like a regular
    // (non-PIAM) shadow. Only the TITULAR keeps the fixed-window behaviour of closing
    // immediately so payment closing already sees a finished, no-bank-hours shift.
    let occupancyId = reg.id;
    if (!arrivalIsShadow) {
        const closed = await endRegulationOccupancy(reg.id, {
            endedAt: bounds.scheduledEndAt,
            actualEndedAt: bounds.scheduledEndAt,
        });
        occupancyId = closed.id;
    }

    return {
        occupancyId,
        successKind: "standard" as const,
        treatedAsContinuation: false,
        replyTimeAt: bounds.scheduledStartAt,
        autoReactivated: false,
        effectiveShiftType: params.shiftLabel,
        reassignedFrom: null as string | null,
        assumedHalfShift: false,
        continuationFrom: null as string | null,
        displacedDoctorName: null as string | null,
        extendedLongShift: false,
        continuityInterpretation: null as ContinuityInterpretation | null,
        piamAutoAllocated: true,
        piamOriginalCode: params.originalCode,
        forwardContinuityPrompt: null as ForwardContinuityPrompt,
        alreadyPresent: null as PiamAlreadyPresentInfo | null,
    };
}

function hasExplicitOperationalSignal(parsed: OperationalParsedEntry) {
    // Sinais que indicam intencao operacional clara — somente nesses casos justifica
    // forcar uma rota e pedir SD/SN ao medico PIAM. Mensagens vagas ("Leonardo Lopes",
    // "2") nao devem disparar o erro PIAM_SHIFT_REQUIRED (audit 2026-05).
    return Boolean(
        parsed.baseCode
        || parsed.isDeparture
        || parsed.isReassignment
        || parsed.isContinuation
        || parsed.arrivalTime,
    );
}

async function maybeApplyPiamRouting(
    parsed: OperationalParsedEntry,
    doctorId: string,
): Promise<{ applied: boolean; originalCode: string | null }> {
    if (!(await isPiamPreferredDoctor(doctorId))) {
        return { applied: false, originalCode: null };
    }

    if (!hasExplicitOperationalSignal(parsed)) {
        // Sem ramal, verbo ou horario: nao e uma tentativa de registro. Deixa o
        // fluxo casual decidir (provavelmente cai em no_operational_match / smalltalk).
        return { applied: false, originalCode: null };
    }

    if (parsed.shiftType !== "SD" && parsed.shiftType !== "SN") {
        // PIAM doctors must declare SD/SN/dia/noite/diurno/noturno. Bot stops processing
        // and asks for an explicit shift declaration.
        throw new Error(TELEGRAM_PIAM_SHIFT_REQUIRED_ERROR);
    }

    if (parsed.sector === "REGULATION" && parsed.baseCode === "PIAM") {
        return { applied: true, originalCode: null };
    }

    const originalCode = parsed.baseCode;
    parsed.sector = "REGULATION";
    parsed.baseCode = "PIAM";
    return { applied: true, originalCode };
}

async function maybeSendContinuityForwardPrompt(
    chatId: number,
    replyToMessageId: number,
    prompt: ForwardContinuityPrompt,
) {
    if (!prompt) {
        return;
    }

    // O balão de sucesso logo acima já explicou o P — aqui só o dado novo (até
    // quando cobre) e a ação, sem repetir a explicação (auditoria §3.1#19).
    const isNight = prompt.baseShiftLabel === "SN";
    await sendMessage(
        chatId,
        `⚠️ Entendi como *P* — cobre até as *${isNight ? "19h" : "7h"} de amanhã*.`
        + `\nSe foi só ${isNight ? "esta noite" : "este dia"}, toque abaixo nos próximos 2 min.`,
        replyToMessageId,
        buildInlineKeyboard([[{
            text: isNight ? "Foi só esta noite (SN)" : "Foi só este dia (SD)",
            callback_data: buildContinuityRevertCallbackData(prompt.domain, prompt.occupancyId),
        }]]),
    );
}

export function buildPiamAlreadyPresentReply(doctorName: string, info: PiamAlreadyPresentInfo) {
    const turnoLabel = info.shiftLabel === "SD" ? "SD (diurno)" : "SN (noturno)";
    const coverage = info.isShadow ? " na cobertura *sombra*" : "";
    return `🩺 *${doctorName}* já está no plantão como *${info.role}* — ${turnoLabel}${coverage}.`
        + `\nNão registrei de novo: reinformar a mesma chegada não cria duplicata nem abre saída.`
        + `\n\nSe a intenção for outra, me diga assim:`
        + `\n• *Saída*: _${doctorName} saída HH:mm_ — se for saída atrasada, mande o motivo (ex.: _em ocorrência 0729_ ou _higienizando_).`
        + `\n• *Remanejamento*: _${doctorName} <RAMAL destino>_ — movo para a nova posição preservando a chegada original.`;
}

async function sendPiamAlreadyPresentReply(
    chatId: number,
    replyToMessageId: number,
    doctorName: string,
    info: PiamAlreadyPresentInfo,
) {
    await sendMessage(chatId, buildPiamAlreadyPresentReply(doctorName, info), replyToMessageId);
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
    piamAutoAllocated = false,
    piamOriginalCode?: string | null,
    extendedLongShift = false,
    displacedDoctorName?: string | null,
    // Regra de chegada por timestamp (FASE 1/FASE 2): quando informados, a confirmação
    // de chegada genuína (não-PIAM) usa o texto fixo que avisa/aplica a hora do aviso.
    messageReferenceAt?: Date,
    declaredArrivalTime?: string | null,
) {
    const time = (replyTimeAt ?? eventAt).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "America/Sao_Paulo" });
    const replyKind = resolveTelegramSuccessReplyKind({
        parsed,
        successKind,
        forceContinuation,
        forceReassignment: Boolean(reassignedFrom),
        forceHalfShift: assumedHalfShift,
    });
    // PIAM mantém o fluxo/copy próprio (07:00/19:00 forçado). A regra nova de chegada
    // só substitui o texto das chegadas comuns (arrival_recorded / arrival_p_recorded).
    const useArrivalRuleCopy = Boolean(messageReferenceAt)
        && !piamAutoAllocated
        && (replyKind === "arrival_recorded" || replyKind === "arrival_p_recorded");
    // Markdown ligado (com escape dos textos livres): sem parse_mode os `*` dos
    // hints apareciam crus no balão de chegada — era metade da ilegibilidade.
    const safeName = escapeTelegramMarkdown(doctorName);
    const safeTarget = escapeTelegramMarkdown(parsed.baseCode ?? "plantao");
    const text = useArrivalRuleCopy
        ? buildArrivalRuleReply({
            name: safeName,
            base: safeTarget,
            messageReferenceAt: messageReferenceAt as Date,
            declaredArrivalTime,
            isPcoverage: replyKind === "arrival_p_recorded",
        })
        : pickTelegramReply(
            replyKind,
            seed,
            {
                name: safeName,
                target: safeTarget,
                time,
            },
        );

    // Remanejamento e continuidade já dizem "chegada original mantida, sem
    // atraso" no corpo — o hint de horário aqui só duplicava (auditoria de UX).
    let timeContextHint = "";
    if (!reassignedFrom
        && replyKind !== "continuation_recorded"
        && !forceContinuation
        && (replyKind === "arrival_recorded" || replyKind === "arrival_p_recorded")
        && !useArrivalRuleCopy) {
        // Turno-ALVO, nunca o do relógio: a janela de chegada adiantada é de 3h
        // (04:00–06:59 → SD; 16:00–18:59 → SN), a MESMA que rules.ts usa para montar
        // a cobertura. Esta cópia tinha uma régua própria de 5/17h — quem chegava
        // 04:30 ou 16:30 recebia "⏱ 570min após as 19:00", medindo o atraso contra o
        // turno que está ACABANDO. Turno explícito na mensagem continua mandando.
        const clockShiftWindow = resolveOperationalShiftWindow(eventAt);
        const targetShiftLabel = resolvePShiftAwareBaseShiftLabel(eventAt, parsed.shiftType ?? null);
        const targetShiftWindow = targetShiftLabel === clockShiftWindow.shiftLabel
            ? clockShiftWindow
            : resolveOperationalShiftWindow(clockShiftWindow.nextBoundaryAt);

        const shiftStartTime = targetShiftWindow.startedAt.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "America/Sao_Paulo" });
        const delayMs = eventAt.getTime() - targetShiftWindow.startedAt.getTime();
        const delayMin = Math.round(delayMs / 60000);
        if (delayMin > 0) {
            const target = parsed.baseCode ?? "RAMAL/BASE";
            timeContextHint = `\n⏱ ${delayMin}min após as ${shiftStartTime} — se é continuação, responda "continuando ${target}".`;
        }
    }

    const resolvedShift = effectiveShiftType ?? parsed.shiftType;
    // arrival_p_recorded (e o pNote da regra de chegada) já explicam o P no corpo do
    // balão — repetir "P (plantão 24h)" aqui era a frase duplicada no ✅ (auditoria §3.1#19).
    // ☀️/🌙 substituem o "(diurno)"/"(noturno)" escrito: mesmo significado, e é o
    // vocabulário visual já definido em replies.ts.
    const shiftIcon = resolvedShift === "SD" ? "☀️" : resolvedShift === "SN" ? "🌙" : "🔁";
    // Turno explícito na mensagem: só confirma. Turno inferido: confirma e abre
    // espaço para o médico corrigir respondendo SD/SN/P.
    const shiftHint = resolvedShift && replyKind !== "arrival_p_recorded"
        ? parsed.shiftType
            ? `\n${shiftIcon} Turno *${resolvedShift}*`
            : `\n${shiftIcon} Turno *${resolvedShift}* — outro? responda SD, SN ou P.`
        : "";

    // A variante half_shift_assumed já explica o meio plantão no corpo do balão —
    // sem esta guarda o hint duplicava a mesma informação (auditoria §3.1#14).
    const halfShiftHint = assumedHalfShift && replyKind !== "half_shift_assumed"
        ? "\n🟠 *Meio Plantão da Tarde* (até 17:00)."
        : "";

    const reactivationHint = autoReactivated
        ? `\n🔄 *${safeTarget}* estava desativad${parsed.sector === "REGULATION" ? "o" : "a"} — reativei com a sua chegada.`
        : "";

    // Uma linha só: o horário original preservado é a informação que importa do
    // remanejamento (antes vinha repetida num segundo hint de horário).
    const reassignmentHint = reassignedFrom
        ? `\n🔀 Remanejado *${escapeTelegramMarkdown(reassignedFrom)}* → *${safeTarget}* — chegada original *${time}* mantida, sem atraso.`
        : "";
    const forcedTakeoverHint = buildForcedTakeoverHint({
        displacedDoctorName,
        baseCode: parsed.baseCode,
    });

    const continuationTargetHint = buildTelegramContinuationSourceHint({
        continuationFrom,
        targetCode: parsed.baseCode,
        isContinuationReply: replyKind === "continuation_recorded" || forceContinuation,
    });

    // Dica permanente de remanejamento removida — bloco de chegada agora é enxuto:
    // confirmação + turno + chave do checklist (auditoria de UX 2026-07-17).
    const arrivalHint = "";
    const shadowHint = parsed.isShadow && !parsed.isDeparture
        ? "\n🫥 Cobertura *sombra* — titular atual mantido no quadro."
        : "";
    const piamHint = piamAutoAllocated
        ? (() => {
            const overrideSuffix = piamOriginalCode && piamOriginalCode !== "PIAM"
                ? ` (em vez de ${escapeTelegramMarkdown(piamOriginalCode)})`
                : "";
            return `\n🩺 Alocado como *PIAM*${overrideSuffix}.`;
        })()
        : "";
    const longShiftHint = extendedLongShift
        ? "\n⏰ Plantão prolongado (*~36h*): entendi que você emendou mais um turno. Se não for, avise."
        : "";
    // Chegada em base de intervenção (USA): anexa a chave do dia do checklist
    // (checklist.mnrs.com.br). Fail-soft — sem config/serviço, segue sem a chave.
    const checklistKeyHint = await checklistHintForConfirmation(parsed, replyKind);
    // UPAs restritas pela chefia (fonte: /tabela). Só na chegada de quem assume
    // ramal de regulação — é quem decide para onde o paciente vai. Fail-soft.
    const upaRestrictionsHint = await upaRestrictionsHintForConfirmation(parsed, replyKind);
    await sendMessage(
        chatId,
        `${text}${approximateMatchHint}${shiftHint}${halfShiftHint}${reactivationHint}${reassignmentHint}${forcedTakeoverHint}${continuationTargetHint}${timeContextHint}${shadowHint}${piamHint}${longShiftHint}${arrivalHint}${checklistKeyHint}${upaRestrictionsHint}`,
        replyToMessageId,
        undefined,
        { parseMode: "Markdown" },
    );
}

function formatTelegramReplyTime(value: Date) {
    return value.toLocaleTimeString("pt-BR", {
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
        timeZone: "America/Sao_Paulo",
    });
}

// FASE 2 da regra de chegada: para chegadas genuínas (não saída/continuação/
// remanejamento), ignora a hora declarada pelo plantonista e registra o timestamp
// da mensagem (referenceAt = primeira mensagem daquele aviso). Na FASE 1 mantém o
// comportamento atual (resolve a hora declarada). PIAM não passa por aqui: continua
// sendo forçado para 07:00/19:00 em handlePiamAutoArrival, independente do aviso.
export function resolveArrivalEventTimeForPhase(
    referenceAt: Date,
    declaredArrivalTime: string | null | undefined,
    isGenuineArrival: boolean,
) {
    if (isGenuineArrival && resolveArrivalPhase(referenceAt) === "phase2") {
        return resolveTelegramEventTime(referenceAt, null);
    }
    return resolveTelegramEventTime(referenceAt, declaredArrivalTime);
}

// Monta a confirmação de chegada com texto fixo (FASE 1 avisa que a regra muda;
// FASE 2 deixa explícito que só vale a hora do aviso). Mensagens curtas e diretas.
export function buildArrivalRuleReply(params: {
    name: string;
    base: string;
    messageReferenceAt: Date;
    declaredArrivalTime: string | null | undefined;
    isPcoverage: boolean;
}) {
    const msgTime = formatTelegramReplyTime(params.messageReferenceAt);
    const phase = resolveArrivalPhase(params.messageReferenceAt);
    const declared = params.declaredArrivalTime?.trim() || null;
    const hasDeclared = Boolean(declared) && declared !== msgTime;
    const pNote = params.isPcoverage
        ? "\n🔁 Cobertura *P*: vale este plantão e o próximo."
        : "";

    if (phase === "phase1") {
        // Legado: só alcançável antes do ARRIVAL_TIME_CUTOFF. Mantido curto —
        // o aviso da mudança de regra cabe em uma linha.
        const registrada = hasDeclared ? declared : msgTime;
        const msgNote = hasDeclared ? ` (msg ${msgTime})` : "";
        return `✅ ${params.name} na ${params.base} desde ${registrada}${msgNote}\n`
            + `⚠️ A partir de amanhã vale a HORA DO AVISO, não a hora informada.${pNote}`;
    }

    // FASE 2 — confirmação direta, sem sermão: vale a hora do aviso e ponto.
    const ignoredNote = hasDeclared
        ? ` — vale a hora do aviso (você citou ${declared})`
        : "";
    return `✅ ${params.name} na ${params.base} desde ${msgTime}${ignoredNote}${pNote}`;
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

async function tryHandlePendingNameSelection(update: TelegramUpdate, logId: string, options?: { includeExpired?: boolean }) {
    const message = update.message;
    if (!message?.text || !message.from?.id) {
        return null;
    }

    const pending = await findPendingNameSelection(String(message.chat.id), String(message.from.id), options?.includeExpired ?? false);
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
            // Com pendência de nome aberta, o lembrete curto vale mais que o
            // smalltalk — sem ele a pendência morria em silêncio (auditoria §3.1#17).
            await sendMessage(
                message.chat.id,
                "⚠️ Ainda falta confirmar o nome do médico — responda *1*, *2* ou *3*, ou mande nome e sobrenome.",
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

    const nameSelectionFirstMsgAt = new Date(pending.resolutionData.originalReferenceAt ?? pending.resolutionData.originalEventAt);
    const nameSelectionIsArrival = !pending.resolutionData.parsed.isDeparture
        && !pending.resolutionData.parsed.isContinuation
        && !pending.resolutionData.parsed.isReassignment;
    const nameSelectionEventAt = resolveArrivalEventTimeForPhase(
        nameSelectionFirstMsgAt,
        pending.resolutionData.parsed.arrivalTime,
        nameSelectionIsArrival,
    );
    try {
        const result = await applyParsedEntry({
            parsed: pending.resolutionData.parsed,
            resolvedDoctor: { id: selected.id, fullName: selected.fullName, displayName: selected.displayName ?? null },
            eventAt: nameSelectionEventAt,
            referenceAt: nameSelectionFirstMsgAt,
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
            nameSelectionEventAt,
            result.successKind,
            "",
            result.treatedAsContinuation,
            result.replyTimeAt,
            result.autoReactivated,
            result.effectiveShiftType,
            result.reassignedFrom,
            result.assumedHalfShift,
            result.continuationFrom,
            result.piamAutoAllocated,
            result.piamOriginalCode,
            result.extendedLongShift,
            result.displacedDoctorName,
            nameSelectionFirstMsgAt,
            pending.resolutionData.parsed.arrivalTime,
        );
        await maybeSendContinuityForwardPrompt(message.chat.id, message.message_id, result.forwardContinuityPrompt);
        return { ok: true, occupancyId: result.occupancyId };
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : "telegram_processing_failed";
        if (shouldRouteToDepartureJustification(errorMessage, pending.resolutionData.parsed)) {
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
            senderTelegramId: message.from?.id ? String(message.from.id) : null,
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
    const occurrenceNumberPending = pending.resolutionData.occurrenceNumberRequired ?? false;
    const promptKind = occurrenceNumberPending
        ? (pendingAttemptCount > 0 ? "departure_occurrence_number_retry" as const : "departure_occurrence_number_required" as const)
        : resolveDepartureJustificationPromptKind(pendingAttemptCount);
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
        // Prefixo neutro de propósito: ⚠️ soaria como pendência e ✅ como crédito
        // registrado — cancelamento é só um desfecho informativo (auditoria §3.3#14).
        await sendMessage(
            message.chat.id,
            `OK, cancelado por aqui. A saída de ${pending.resolutionData.resolvedDoctor.fullName} em ${pending.resolutionData.parsed.baseCode} continua sem justificativa salva. Se precisar, reenvie a saída completa depois.`,
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
        // Mensagem casual durante a pendência → lembrete de 1 linha, não o balão
        // inteiro de novo (auditoria §3.1#6; mesmo padrão da pendência de nome).
        await sendMessage(
            message.chat.id,
            occurrenceNumberPending
                ? "⚠️ Ainda falta o *número da ocorrência* — responda só os *4 dígitos* (ex.: `4521`)."
                : `⚠️ Ainda falta o *motivo* da saída de *${escapeTelegramMarkdown(resolveTelegramDoctorSurfaceName(pending.resolutionData.resolvedDoctor))}* em *${escapeTelegramMarkdown(pending.resolutionData.parsed.baseCode)}* — toque num botão acima ou responda o motivo.`,
            message.message_id,
            undefined,
            { parseMode: "Markdown" },
        );
        return { ok: true, ignored: true, pending: true };
    }

    const mergedText = buildTelegramJustificationFollowUpText(
        pending.resolutionData.originalText,
        message.text,
    );
    // Evaluate reason AND the occurrence-number rule on the merged text, so a reason
    // stated in the original message combines with a number sent in the reply.
    const claim = resolveTelegramLateDepartureClaim(mergedText, [
        pending.resolutionData.parsed.baseCode,
        pending.resolutionData.resolvedDoctor.fullName,
        pending.resolutionData.parsed.arrivalTime,
    ]);
    // "occurrence" recognized but still missing its mandatory 4-digit number.
    const needsOccurrenceNumber = claim?.missingOccurrenceNumber ?? false;
    // Credit-eligible only when a reason matched AND (if occurrence) the number is present.
    const eligibleReason = claim && !claim.missingOccurrenceNumber ? claim : null;

    if (!eligibleReason) {
        if (pendingAttemptCount < 1) {
            await markTelegramProcessed(pending.id, {
                resolutionData: buildResolutionData(pending.resolutionData, {
                    invalidJustificationAttempts: pendingAttemptCount + 1,
                    latestInvalidJustificationReplyText: message.text,
                    occurrenceNumberRequired: needsOccurrenceNumber,
                }),
            });
            await markTelegramProcessed(logId, {
                status: "ignored",
                parsedDomain: pending.resolutionData.parsed.sector,
                parsedTargetCode: pending.resolutionData.parsed.baseCode,
                parsedAction: "departure_justification_pending",
                parsedDoctorName: pending.resolutionData.resolvedDoctor.fullName,
                errorMessage: needsOccurrenceNumber ? "departure_occurrence_number_missing" : "departure_justification_invalid_retry",
                resolutionData: {
                    pendingJustificationKept: true,
                    invalidJustificationAttempts: pendingAttemptCount + 1,
                },
            });
            await sendMessage(
                message.chat.id,
                pickTelegramReply(needsOccurrenceNumber ? "departure_occurrence_number_retry" : "departure_justification_retry", message.message_id, {
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

        // Exhausted retries. A missing occurrence number still surfaces the late
        // departure to the chefe (actual_ended_at = verbalized time) for adjudication,
        // but without automatic credit and flagged "sem numero". An unrecognized reason
        // keeps the legacy note-only behavior (no window extension).
        const noteMarker = needsOccurrenceNumber
            ? "telegram ocorrencia sem numero - revisar chefia"
            : "telegram saida sem credito automatico";
        const exhaustionCorrection = needsOccurrenceNumber ? { actualEndedAt: eventAt } : {};

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
                    ...exhaustionCorrection,
                    notes: appendTelegramOperationalNote(recentClosed.notes, noteMarker, mergedText),
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
                    ...exhaustionCorrection,
                    notes: appendTelegramOperationalNote(recentClosed.notes, noteMarker, mergedText),
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
                    occurrenceNumberMissing: needsOccurrenceNumber,
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
                    occurrenceNumberMissing: needsOccurrenceNumber,
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
                occurrenceNumber: eligibleReason.occurrenceNumber ?? null,
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

async function tryHandlePendingDepartureCorrection(update: TelegramUpdate, logId: string, options?: { includeExpired?: boolean }) {
    const message = update.message;
    if (!message?.text || !message.from?.id) {
        return null;
    }

    const pending = await findPendingDepartureCorrection(String(message.chat.id), String(message.from.id), options?.includeExpired ?? false);
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
                : `⛔ Não consegui corrigir a saída de ${pending.resolutionData.resolvedDoctor.fullName} em ${candidate.targetCode}. ${errorMessage}`,
            message.message_id,
        );
        return { ok: true, ignored: true, processingError: !isChronologyError };
    }
}

async function tryHandlePendingRamalSelection(update: TelegramUpdate, logId: string, options?: { includeExpired?: boolean }) {
    const message = update.message;
    if (!message?.text || !message.from?.id) {
        return null;
    }

    const pending = await findPendingRamalSelection(String(message.chat.id), String(message.from.id), options?.includeExpired ?? false);
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

    const originalEventAt = new Date(pending.resolutionData.originalReferenceAt ?? pending.resolutionData.originalEventAt);
    const ramalIsArrival = !parsedEntry.isDeparture && !parsedEntry.isContinuation && !parsedEntry.isReassignment;
    const eventAt = resolveArrivalEventTimeForPhase(originalEventAt, parsedEntry.arrivalTime, ramalIsArrival);

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

    // Mesma validação de tomada do fluxo normal (caso Yngra, 13/08): destino
    // ocupado no mesmo turno NÃO desloca nem encerra ninguém automaticamente —
    // vira pendência de confirmação explícita, com aviso de quem está lá.
    const takeoverSenderId = String(message.from.id);
    const wantsBoardOnRamal = !parsedEntry.isDeparture
        && !parsedEntry.isContinuation
        && !resolveTelegramShadowFlag(parsedEntry, reconstructedText)
        && Boolean(parsedEntry.baseCode);
    if (wantsBoardOnRamal && parsedEntry.baseCode) {
        const occupant = await findActiveSameTurnoBoardCarrierOnTarget({
            sector: parsedEntry.sector,
            targetCode: parsedEntry.baseCode,
            eventAt,
            excludeDoctorId: resolvedDoctor.id,
        });
        if (occupant) {
            await markTelegramProcessed(pending.id, {
                status: "pending_takeover_confirmation",
                parsedDomain: parsedEntry.sector,
                parsedTargetCode: parsedEntry.baseCode,
                parsedAction: resolveTelegramParsedAction(parsedEntry),
                parsedDoctorName: resolvedDoctor.fullName,
                errorMessage: "takeover_confirmation_required",
                resolutionData: {
                    kind: "takeover_confirmation",
                    sector: parsedEntry.sector,
                    targetCode: parsedEntry.baseCode,
                    arrivingDoctorId: resolvedDoctor.id,
                    occupantDoctorId: occupant.doctorId,
                    occupantOccupancyId: occupant.occupancyId,
                    arrivingMessageText: reconstructedText,
                    senderTelegramId: takeoverSenderId,
                } satisfies TakeoverPendingData,
            });
            await markTelegramProcessed(logId, {
                status: "ignored",
                parsedDomain: parsedEntry.sector,
                parsedTargetCode: parsedEntry.baseCode,
                parsedAction: resolveTelegramParsedAction(parsedEntry),
                parsedDoctorName: resolvedDoctor.fullName,
                errorMessage: "takeover_confirmation_required",
            });
            await sendMessage(
                message.chat.id,
                buildTakeoverWarningReply({
                    occupantName: occupant.doctorName,
                    targetLabel: parsedEntry.baseCode,
                    shiftLabel: occupant.shiftLabel,
                    sinceTime: formatTelegramReplyTime(occupant.startedAt),
                }),
                message.message_id,
                buildTakeoverDecisionKeyboard(parsedEntry.baseCode, pending.id),
                { parseMode: "Markdown" },
            );
            return { ok: true, ignored: true, pending: true };
        }
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
            result.piamAutoAllocated,
            result.piamOriginalCode,
            result.extendedLongShift,
            result.displacedDoctorName,
            originalEventAt,
            parsedEntry.arrivalTime,
        );
        await maybeSendContinuityForwardPrompt(message.chat.id, message.message_id, result.forwardContinuityPrompt);
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
            `⛔ Não consegui registrar com o ramal ${ramal}. Reenvie a mensagem completa: _${reconstructedText}_`,
            message.message_id,
        );
        return { ok: true, ignored: true, processingError: true };
    }
}

// ── Completação de pendências com botões (Onda 2 §6) ──────────────────────────────
// As pendências F6/PIAM/COI/nome podem ser completadas por botão inline (callback)
// ou por resposta curta de texto (inclusive reabrindo pendência expirada ≤2h).
// O contexto abaixo abstrai só o CANAL da resposta; a aplicação passa sempre pelo
// mesmo caminho do fluxo normal (resolução de médico, tomada, applyParsedEntry).

type TelegramIngestedMessageRow = typeof telegramIngestedMessages.$inferSelect;

type PendingButtonCompletionCtx =
    | { via: "text"; message: NonNullable<TelegramUpdate["message"]>; logId: string }
    | { via: "callback"; callbackQueryId: string; chatId: number; promptMessageId: number };

// Texto compacto de sucesso usado ao EDITAR o balão-prompt após um callback.
// (No canal de texto usamos o sendSuccessReply completo, como no fluxo normal.)
async function buildCallbackSuccessEditText(params: {
    parsed: OperationalParsedEntry;
    doctorName: string;
    timeAt: Date;
    effectiveShiftType?: string | null;
    piamAutoAllocated?: boolean;
}) {
    const time = formatTelegramReplyTime(params.timeAt);
    const kind = resolveTelegramSuccessReplyKind({ parsed: params.parsed, successKind: "standard" });
    const base = pickTelegramReply(kind, params.parsed.baseCode ?? "pending", {
        name: escapeTelegramMarkdown(params.doctorName),
        target: escapeTelegramMarkdown(params.parsed.baseCode ?? "plantão"),
        time,
    });
    const shift = params.effectiveShiftType ?? params.parsed.shiftType;
    const shiftHint = shift && kind !== "arrival_p_recorded"
        ? `\nTurno: *${shift === "SD" ? "SD (diurno)" : shift === "SN" ? "SN (noturno)" : "P (plantão 24h)"}*`
        : "";
    const piamHint = params.piamAutoAllocated ? "\n🩺 Alocado como *PIAM*." : "";
    // Completação por botão também é confirmação de chegada — entrega a chave
    // do checklist igual ao fluxo de texto (caso Taiane/SB02, 2026-07-17).
    const checklistHint = await checklistHintForConfirmation(params.parsed, kind);
    return `${base}${shiftHint}${piamHint}${checklistHint}`;
}

// Falha genérica na completação: reusa as MESMAS replies de falha do fluxo de
// texto (chegada/saída), ancoradas na mensagem original do autor.
async function notifyPendingCompletionFailure(params: {
    ctx: PendingButtonCompletionCtx;
    pending: TelegramIngestedMessageRow;
    parsedEntry: OperationalParsedEntry;
    doctorName: string;
    errorMessage: string;
}) {
    if (params.ctx.via === "text") {
        await sendTelegramDepartureFailureReply({
            chatId: params.ctx.message.chat.id,
            replyToMessageId: params.ctx.message.message_id,
            seed: params.ctx.message.message_id,
            parsed: params.parsedEntry,
            doctorName: params.doctorName,
            errorMessage: params.errorMessage,
        });
        await sendTelegramArrivalFailureReply({
            chatId: params.ctx.message.chat.id,
            replyToMessageId: params.ctx.message.message_id,
            parsed: params.parsedEntry,
            errorMessage: params.errorMessage,
            senderTelegramId: params.ctx.message.from?.id ? String(params.ctx.message.from.id) : params.pending.senderTelegramId,
        });
        return;
    }

    const anchorMessageId = params.pending.telegramMessageId ?? params.ctx.promptMessageId;
    await editMessageText(
        params.ctx.chatId,
        params.ctx.promptMessageId,
        "⛔ Não consegui concluir o registro por aqui — detalhes abaixo.",
    );
    await sendTelegramDepartureFailureReply({
        chatId: params.ctx.chatId,
        replyToMessageId: anchorMessageId,
        seed: anchorMessageId,
        parsed: params.parsedEntry,
        doctorName: params.doctorName,
        errorMessage: params.errorMessage,
    });
    await sendTelegramArrivalFailureReply({
        chatId: params.ctx.chatId,
        replyToMessageId: anchorMessageId,
        parsed: params.parsedEntry,
        errorMessage: params.errorMessage,
        senderTelegramId: params.pending.senderTelegramId,
    });
    await answerCallbackQuery(params.ctx.callbackQueryId, "Não consegui registrar.");
}

// Núcleo compartilhado de F6 (turno escolhido) e COI (ramal escolhido): resolve o
// médico, aplica as MESMAS validações de tomada do fluxo normal e grava via
// applyParsedEntry — revalidando conflito mesmo quando a pendência foi reaberta.
async function completeArrivalFromPendingSelection(params: {
    pending: TelegramIngestedMessageRow;
    parsedEntry: OperationalParsedEntry;
    doctorQuery: string | null;
    senderName: string | null;
    reconstructedText: string;
    referenceAt: Date;
    supersededErrorPrefix: string;
    resolutionExtra?: Record<string, unknown>;
    ctx: PendingButtonCompletionCtx;
}) {
    const { pending, parsedEntry, ctx } = params;
    const chatIdStr = pending.chatId;
    const chatIdNum = ctx.via === "text" ? ctx.message.chat.id : ctx.chatId;
    const senderTelegramId = pending.senderTelegramId;
    const anchorMessageId = ctx.via === "text"
        ? ctx.message.message_id
        : (pending.telegramMessageId ?? ctx.promptMessageId);

    const { doctor: resolvedDoctor, candidates, matchedBy } = await resolveOperationalDoctor({
        parsed: parsedEntry,
        doctorQuery: params.doctorQuery,
        senderName: params.senderName,
        messageText: params.reconstructedText,
        chatId: chatIdStr,
        senderTelegramId,
        referenceAt: params.referenceAt,
    });

    const isGenuineArrival = !parsedEntry.isDeparture && !parsedEntry.isContinuation && !parsedEntry.isReassignment;
    const eventAt = resolveArrivalEventTimeForPhase(params.referenceAt, parsedEntry.arrivalTime, isGenuineArrival);

    if (!resolvedDoctor) {
        if (candidates.length > 0) {
            // Vira pendência de nome (com botões) — mesma mecânica do fluxo CRU/COI.
            if (ctx.via === "text") {
                await markTelegramProcessed(pending.id, {
                    status: "superseded",
                    errorMessage: `${params.supersededErrorPrefix}_resolved_pending_name`,
                });
                await queuePendingNameSelection(ctx.logId, ctx.message, parsedEntry, params.doctorQuery, params.referenceAt, eventAt, candidates);
            } else {
                const syntheticMessage = {
                    message_id: anchorMessageId,
                    chat: { id: chatIdNum, type: "group" },
                    date: Math.floor(params.referenceAt.getTime() / 1000),
                    text: params.reconstructedText,
                } as NonNullable<TelegramUpdate["message"]>;
                await queuePendingNameSelection(pending.id, syntheticMessage, parsedEntry, params.doctorQuery, params.referenceAt, eventAt, candidates);
                await editMessageText(ctx.chatId, ctx.promptMessageId, "⚠️ Falta confirmar o *nome* do médico — veja a mensagem abaixo.", undefined, { parseMode: "Markdown" });
                await answerCallbackQuery(ctx.callbackQueryId, "Falta confirmar o nome do médico.");
            }
            return { ok: true, ignored: true, pending: true };
        }

        await markTelegramProcessed(pending.id, {
            status: "superseded",
            errorMessage: `${params.supersededErrorPrefix}_doctor_not_resolved`,
        });
        if (ctx.via === "text") {
            await markTelegramProcessed(ctx.logId, {
                status: "ignored",
                parsedDomain: parsedEntry.sector,
                parsedTargetCode: parsedEntry.baseCode,
                parsedAction: resolveTelegramParsedAction(parsedEntry),
                errorMessage: "doctor_not_resolved",
                resolutionData: buildTelegramReviewLogData({
                    reason: "doctor_not_resolved",
                    parsed: parsedEntry,
                    doctorQuery: params.doctorQuery || params.senderName,
                    trainingCandidate: true,
                }),
            });
            await sendMessage(ctx.message.chat.id, buildNameUnresolvedReply(ctx.message.message_id, []), ctx.message.message_id);
        } else {
            await editMessageText(ctx.chatId, ctx.promptMessageId, buildNameUnresolvedReply(ctx.promptMessageId, []));
            await answerCallbackQuery(ctx.callbackQueryId, "Não reconheci o nome do médico.");
        }
        return { ok: true, ignored: true };
    }

    // Mesma validação de tomada do fluxo normal: destino ocupado no mesmo turno
    // NÃO desloca automaticamente — vira pendência de confirmação.
    const wantsBoard = !parsedEntry.isDeparture
        && !parsedEntry.isContinuation
        && !parsedEntry.isShadow
        && Boolean(parsedEntry.baseCode);
    if (wantsBoard && senderTelegramId && parsedEntry.baseCode) {
        const occupant = await findActiveSameTurnoBoardCarrierOnTarget({
            sector: parsedEntry.sector,
            targetCode: parsedEntry.baseCode,
            eventAt,
            excludeDoctorId: resolvedDoctor.id,
        });
        if (occupant) {
            await markTelegramProcessed(pending.id, {
                status: "pending_takeover_confirmation",
                parsedDomain: parsedEntry.sector,
                parsedTargetCode: parsedEntry.baseCode,
                parsedAction: resolveTelegramParsedAction(parsedEntry),
                parsedDoctorName: resolvedDoctor.fullName,
                errorMessage: "takeover_confirmation_required",
                resolutionData: {
                    kind: "takeover_confirmation",
                    sector: parsedEntry.sector,
                    targetCode: parsedEntry.baseCode,
                    arrivingDoctorId: resolvedDoctor.id,
                    occupantDoctorId: occupant.doctorId,
                    occupantOccupancyId: occupant.occupancyId,
                    arrivingMessageText: params.reconstructedText,
                    ...(senderTelegramId ? { senderTelegramId } : {}),
                } satisfies TakeoverPendingData,
            });
            const warning = buildTakeoverWarningReply({
                occupantName: occupant.doctorName,
                targetLabel: parsedEntry.baseCode,
                shiftLabel: occupant.shiftLabel,
                sinceTime: formatTelegramReplyTime(occupant.startedAt),
            });
            const takeoverKeyboard = buildTakeoverDecisionKeyboard(parsedEntry.baseCode, pending.id);
            if (ctx.via === "text") {
                await markTelegramProcessed(ctx.logId, {
                    status: "ignored",
                    parsedDomain: parsedEntry.sector,
                    parsedTargetCode: parsedEntry.baseCode,
                    parsedAction: resolveTelegramParsedAction(parsedEntry),
                    parsedDoctorName: resolvedDoctor.fullName,
                    errorMessage: "takeover_confirmation_required",
                });
                await sendMessage(ctx.message.chat.id, warning, ctx.message.message_id, takeoverKeyboard, { parseMode: "Markdown" });
            } else {
                await editMessageText(ctx.chatId, ctx.promptMessageId, warning, takeoverKeyboard, { parseMode: "Markdown" });
                await answerCallbackQuery(ctx.callbackQueryId, `${parsedEntry.baseCode} já está ocupado — confirme para assumir.`);
            }
            return { ok: true, ignored: true, pending: true };
        }
    }

    try {
        const result = await applyParsedEntry({
            parsed: parsedEntry,
            resolvedDoctor: { id: resolvedDoctor.id, fullName: resolvedDoctor.fullName, displayName: resolvedDoctor.displayName ?? null },
            eventAt,
            referenceAt: params.referenceAt,
            messageText: params.reconstructedText,
        });

        if (senderTelegramId) {
            await supersedePendingDepartureJustification(chatIdStr, senderTelegramId);
        }

        const acceptedPatch = {
            status: "accepted",
            parsedDomain: parsedEntry.sector,
            parsedTargetCode: parsedEntry.baseCode,
            parsedAction: resolveTelegramParsedAction(parsedEntry),
            parsedDoctorName: resolvedDoctor.fullName,
            relatedOccupancyId: result.occupancyId,
            errorMessage: null,
            resolutionData: {
                continuationMode: resolveTelegramContinuationMode(parsedEntry),
                ...params.resolutionExtra,
            },
        } satisfies Partial<typeof telegramIngestedMessages.$inferInsert>;

        await markTelegramProcessed(pending.id, acceptedPatch);

        const doctorSurfaceName = resolveTelegramDoctorSurfaceName(resolvedDoctor);
        if (ctx.via === "text") {
            await markTelegramProcessed(ctx.logId, acceptedPatch);
            await sendSuccessReply(
                ctx.message.chat.id,
                ctx.message.message_id,
                ctx.message.message_id,
                parsedEntry,
                doctorSurfaceName,
                eventAt,
                result.successKind,
                matchedBy === "candidate"
                    ? buildApproximateMatchHint({ doctorQuery: params.doctorQuery, doctorName: doctorSurfaceName })
                    : "",
                result.treatedAsContinuation,
                result.replyTimeAt,
                result.autoReactivated,
                result.effectiveShiftType,
                result.reassignedFrom,
                result.assumedHalfShift,
                result.continuationFrom,
                result.piamAutoAllocated,
                result.piamOriginalCode,
                result.extendedLongShift,
                result.displacedDoctorName,
                params.referenceAt,
                parsedEntry.arrivalTime,
            );
            await maybeSendContinuityForwardPrompt(ctx.message.chat.id, ctx.message.message_id, result.forwardContinuityPrompt);
        } else {
            await editMessageText(
                ctx.chatId,
                ctx.promptMessageId,
                await buildCallbackSuccessEditText({
                    parsed: parsedEntry,
                    doctorName: doctorSurfaceName,
                    timeAt: result.replyTimeAt ?? eventAt,
                    effectiveShiftType: result.effectiveShiftType,
                    piamAutoAllocated: result.piamAutoAllocated,
                }),
                undefined,
                { parseMode: "Markdown" },
            );
            await answerCallbackQuery(ctx.callbackQueryId, "✅ Registrado!");
            await maybeSendContinuityForwardPrompt(ctx.chatId, anchorMessageId, result.forwardContinuityPrompt);
        }
        return { ok: true, occupancyId: result.occupancyId };
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : "telegram_processing_failed";

        if (isTelegramPiamShiftRequiredError(errorMessage)) {
            // Médico PIAM escolheu P (só SD/SN valem): transiciona para a pergunta
            // binária do PIAM em vez de morrer em erro.
            if (senderTelegramId) {
                await queuePendingPiamShift({
                    logId: pending.id,
                    parsed: { ...parsedEntry, shiftType: null },
                    resolvedDoctor: { id: resolvedDoctor.id, fullName: resolvedDoctor.fullName, displayName: resolvedDoctor.displayName ?? null },
                    senderTelegramId,
                    originalText: params.reconstructedText,
                    referenceAt: params.referenceAt,
                    delivery: ctx.via === "text"
                        ? { via: "message", chatId: ctx.message.chat.id, replyToMessageId: ctx.message.message_id }
                        : { via: "edit", chatId: ctx.chatId, messageId: ctx.promptMessageId, callbackQueryId: ctx.callbackQueryId },
                });
                if (ctx.via === "text") {
                    await markTelegramProcessed(ctx.logId, {
                        status: "ignored",
                        errorMessage: "piam_shift_selection_pending",
                    });
                }
                return { ok: true, ignored: true, pending: true };
            }
        }

        const errorPatch = {
            status: "error",
            parsedDomain: parsedEntry.sector,
            parsedTargetCode: parsedEntry.baseCode,
            parsedAction: resolveTelegramParsedAction(parsedEntry),
            parsedDoctorName: resolvedDoctor.fullName,
            errorMessage,
        } satisfies Partial<typeof telegramIngestedMessages.$inferInsert>;
        await markTelegramProcessed(pending.id, errorPatch);
        if (ctx.via === "text") {
            await markTelegramProcessed(ctx.logId, errorPatch);
        }
        await notifyPendingCompletionFailure({
            ctx,
            pending,
            parsedEntry,
            doctorName: resolvedDoctor.fullName,
            errorMessage,
        });
        return { ok: true, ignored: true, processingError: true };
    }
}

// F6: aplica o turno escolhido (botão ou resposta curta) ao parse salvo.
async function completeShiftSelectionPending(params: {
    pending: TelegramIngestedMessageRow;
    data: PendingShiftSelectionData;
    shift: PendingShiftChoice;
    ctx: PendingButtonCompletionCtx;
}) {
    const parsedEntry: OperationalParsedEntry = { ...params.data.parsed, shiftType: params.shift };
    return completeArrivalFromPendingSelection({
        pending: params.pending,
        parsedEntry,
        doctorQuery: params.data.doctorQuery,
        senderName: params.data.senderName,
        reconstructedText: `${params.data.originalText} ${params.shift}`.trim(),
        referenceAt: new Date(params.data.originalReferenceAt),
        supersededErrorPrefix: "shift_selection",
        resolutionExtra: { shiftResolvedFromPending: params.shift },
        ctx: params.ctx,
    });
}

// PIAM: aplica SD/SN escolhido (botão, resposta solta ou reply à pergunta). O
// médico já estava resolvido quando a pendência nasceu — não re-resolve nome.
async function completePiamShiftPending(params: {
    pending: TelegramIngestedMessageRow;
    data: PendingPiamShiftData;
    shift: "SD" | "SN";
    ctx: PendingButtonCompletionCtx;
}) {
    const { pending, data, ctx } = params;
    const parsedEntry: OperationalParsedEntry = { ...data.parsed, shiftType: params.shift };
    const referenceAt = new Date(data.originalReferenceAt);
    const isGenuineArrival = !parsedEntry.isDeparture && !parsedEntry.isContinuation && !parsedEntry.isReassignment;
    const eventAt = resolveArrivalEventTimeForPhase(referenceAt, parsedEntry.arrivalTime, isGenuineArrival);
    const doctorSurfaceName = resolveTelegramDoctorSurfaceName(data.resolvedDoctor);

    try {
        const result = await applyParsedEntry({
            parsed: parsedEntry,
            resolvedDoctor: data.resolvedDoctor,
            eventAt,
            referenceAt,
            messageText: data.originalText,
        });

        if (pending.senderTelegramId) {
            await supersedePendingDepartureJustification(pending.chatId, pending.senderTelegramId);
        }

        const acceptedPatch = {
            status: "accepted",
            parsedDomain: parsedEntry.sector,
            parsedTargetCode: parsedEntry.baseCode,
            parsedAction: resolveTelegramParsedAction(parsedEntry),
            parsedDoctorName: data.resolvedDoctor.fullName,
            relatedOccupancyId: result.occupancyId,
            errorMessage: null,
            resolutionData: {
                continuationMode: resolveTelegramContinuationMode(parsedEntry),
                piamShiftResolved: params.shift,
            },
        } satisfies Partial<typeof telegramIngestedMessages.$inferInsert>;
        await markTelegramProcessed(pending.id, acceptedPatch);

        if (ctx.via === "text") {
            await markTelegramProcessed(ctx.logId, acceptedPatch);
            await sendSuccessReply(
                ctx.message.chat.id,
                ctx.message.message_id,
                ctx.message.message_id,
                parsedEntry,
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
                result.piamAutoAllocated,
                result.piamOriginalCode,
                result.extendedLongShift,
                result.displacedDoctorName,
            );
            await maybeSendContinuityForwardPrompt(ctx.message.chat.id, ctx.message.message_id, result.forwardContinuityPrompt);
        } else {
            await editMessageText(
                ctx.chatId,
                ctx.promptMessageId,
                await buildCallbackSuccessEditText({
                    parsed: parsedEntry,
                    doctorName: doctorSurfaceName,
                    timeAt: result.replyTimeAt ?? eventAt,
                    effectiveShiftType: result.effectiveShiftType,
                    piamAutoAllocated: result.piamAutoAllocated,
                }),
                undefined,
                { parseMode: "Markdown" },
            );
            await answerCallbackQuery(ctx.callbackQueryId, "✅ Registrado!");
            await maybeSendContinuityForwardPrompt(ctx.chatId, pending.telegramMessageId ?? ctx.promptMessageId, result.forwardContinuityPrompt);
        }
        return { ok: true, occupancyId: result.occupancyId };
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : "telegram_processing_failed";
        const errorPatch = {
            status: "error",
            parsedDomain: parsedEntry.sector,
            parsedTargetCode: parsedEntry.baseCode,
            parsedAction: resolveTelegramParsedAction(parsedEntry),
            parsedDoctorName: data.resolvedDoctor.fullName,
            errorMessage,
        } satisfies Partial<typeof telegramIngestedMessages.$inferInsert>;
        await markTelegramProcessed(pending.id, errorPatch);
        if (ctx.via === "text") {
            await markTelegramProcessed(ctx.logId, errorPatch);
        }
        await notifyPendingCompletionFailure({
            ctx,
            pending,
            parsedEntry,
            doctorName: data.resolvedDoctor.fullName,
            errorMessage,
        });
        return { ok: true, ignored: true, processingError: true };
    }
}

// Candidato de nome escolhido por BOTÃO (o caminho textual 1/2/3 continua em
// tryHandlePendingNameSelection). Mesmo miolo: applyParsedEntry + rotas de erro.
async function completeNameSelectionFromCallback(params: {
    pending: TelegramIngestedMessageRow;
    data: PendingNameResolutionData;
    selected: PendingNameResolutionData["candidates"][number];
    ctx: { callbackQueryId: string; chatId: number; promptMessageId: number };
}) {
    const { pending, data, selected, ctx } = params;
    const firstMsgAt = new Date(data.originalReferenceAt ?? data.originalEventAt);
    const isArrival = !data.parsed.isDeparture && !data.parsed.isContinuation && !data.parsed.isReassignment;
    const eventAt = resolveArrivalEventTimeForPhase(firstMsgAt, data.parsed.arrivalTime, isArrival);
    const anchorMessageId = pending.telegramMessageId ?? ctx.promptMessageId;
    const resolvedDoctor: ResolvedTelegramDoctorRef = {
        id: selected.id,
        fullName: selected.fullName,
        displayName: selected.displayName ?? null,
    };

    try {
        const result = await applyParsedEntry({
            parsed: data.parsed,
            resolvedDoctor,
            eventAt,
            referenceAt: firstMsgAt,
            messageText: data.originalText,
        });

        if (pending.senderTelegramId) {
            await supersedePendingDepartureJustification(pending.chatId, pending.senderTelegramId);
        }

        await markTelegramProcessed(pending.id, {
            status: "accepted",
            parsedDoctorName: selected.fullName,
            relatedOccupancyId: result.occupancyId,
            errorMessage: null,
        });
        await editMessageText(
            ctx.chatId,
            ctx.promptMessageId,
            await buildCallbackSuccessEditText({
                parsed: data.parsed,
                doctorName: resolveTelegramDoctorSurfaceName(selected),
                timeAt: result.replyTimeAt ?? eventAt,
                effectiveShiftType: result.effectiveShiftType,
                piamAutoAllocated: result.piamAutoAllocated,
            }),
            undefined,
            { parseMode: "Markdown" },
        );
        await answerCallbackQuery(ctx.callbackQueryId, "✅ Registrado!");
        await maybeSendContinuityForwardPrompt(ctx.chatId, anchorMessageId, result.forwardContinuityPrompt);
        return { ok: true, occupancyId: result.occupancyId };
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : "telegram_processing_failed";
        if (shouldRouteToDepartureJustification(errorMessage, data.parsed)) {
            // Saída tardia exige justificativa POR TEXTO: transiciona a pendência e
            // manda o prompt de justificativa ancorado na mensagem original.
            const syntheticMessage = {
                message_id: anchorMessageId,
                chat: { id: ctx.chatId, type: "group" },
                date: Math.floor(Date.now() / 1000),
                ...(pending.senderTelegramId ? { from: { id: Number(pending.senderTelegramId), first_name: pending.senderName ?? "" } } : {}),
                text: data.originalText,
            } as NonNullable<TelegramUpdate["message"]>;
            await queuePendingDepartureJustification({
                logId: pending.id,
                message: syntheticMessage,
                parsed: data.parsed,
                resolvedDoctor,
                eventAt,
                referenceAt: firstMsgAt,
                originalText: data.originalText,
            });
            await editMessageText(ctx.chatId, ctx.promptMessageId, "⚠️ Nome confirmado — falta a *justificativa* da saída (veja abaixo).", undefined, { parseMode: "Markdown" });
            await answerCallbackQuery(ctx.callbackQueryId, "Falta a justificativa da saída.");
            return { ok: true, ignored: true, pending: true };
        }

        await markTelegramProcessed(pending.id, {
            status: "error",
            parsedDomain: data.parsed.sector,
            parsedTargetCode: data.parsed.baseCode,
            parsedAction: resolveTelegramParsedAction(data.parsed),
            parsedDoctorName: selected.fullName,
            errorMessage,
        });
        await notifyPendingCompletionFailure({
            ctx: { via: "callback", callbackQueryId: ctx.callbackQueryId, chatId: ctx.chatId, promptMessageId: ctx.promptMessageId },
            pending,
            parsedEntry: data.parsed,
            doctorName: selected.fullName,
            errorMessage,
        });
        return { ok: true, ignored: true, processingError: true };
    }
}

// Carrega e valida a pendência apontada por um callback_data: registro existe,
// pertence ao chat do botão, está no status esperado, dentro do TTL, e quem tocou
// é o autor ou chefia/admin (auditoria — validação de presser).
async function loadPendingForCallback(params: {
    logId: string;
    expectedStatus: string;
    chatId: number;
    presserTelegramId: string;
    /** TTL específico da pendência (default: PENDING_TTL_MS de 30 min). */
    ttlMs?: number;
}): Promise<
    | { outcome: "ok"; pending: TelegramIngestedMessageRow }
    | { outcome: "denied" | "expired" | "already_resolved" | "not_found" }
> {
    const db = getDb();
    const row = await db.query.telegramIngestedMessages.findFirst({
        where: eq(telegramIngestedMessages.id, params.logId),
    });
    if (!row || row.chatId !== String(params.chatId)) {
        return { outcome: "not_found" };
    }
    if (row.status === "accepted") {
        return { outcome: "already_resolved" };
    }
    if (row.status !== params.expectedStatus) {
        return { outcome: "expired" };
    }
    const permission = resolvePendingPresserPermission({
        presserTelegramId: params.presserTelegramId,
        pendingSenderTelegramId: row.senderTelegramId,
        chiefTelegramIds: getTelegramChiefUserIds(),
        adminTelegramIds: getTelegramAdminUserIds(),
    });
    if (permission === "denied") {
        return { outcome: "denied" };
    }
    if (resolvePendingReopenState({ createdAt: row.createdAt, now: new Date(), ttlMs: params.ttlMs ?? PENDING_TTL_MS }) !== "active") {
        await markTelegramProcessed(row.id, { status: "superseded", errorMessage: "pending_expired" });
        return { outcome: "expired" };
    }
    return { outcome: "ok", pending: row };
}

async function answerPendingCallbackShortfall(
    callbackQueryId: string,
    outcome: "denied" | "expired" | "already_resolved" | "not_found",
    kind: ExpiredPendingKind,
) {
    if (outcome === "denied") {
        await answerCallbackQuery(callbackQueryId, buildThirdPartyPressAlertText(), true);
    } else if (outcome === "already_resolved") {
        await answerCallbackQuery(callbackQueryId, "✅ Esse registro já foi concluído.");
    } else {
        await answerCallbackQuery(callbackQueryId, buildExpiredPendingAlertText(kind), true);
    }
    return { ok: true, ignored: true };
}

async function handleShiftSelectionCallback(
    callbackQuery: TelegramCallbackQuery,
    parsed: NonNullable<ReturnType<typeof parseShiftSelectionCallbackData>>,
) {
    const chat = callbackQuery.message?.chat;
    const promptMessageId = callbackQuery.message?.message_id;
    if (!chat || !promptMessageId) {
        await answerCallbackQuery(callbackQuery.id);
        return { ok: true, ignored: true };
    }
    const loaded = await loadPendingForCallback({
        logId: parsed.logId,
        expectedStatus: "pending_shift_selection",
        chatId: chat.id,
        presserTelegramId: String(callbackQuery.from.id),
    });
    if (loaded.outcome !== "ok") {
        return answerPendingCallbackShortfall(callbackQuery.id, loaded.outcome, "shift_selection");
    }
    if (!isPendingShiftSelectionData(loaded.pending.resolutionData)) {
        return answerPendingCallbackShortfall(callbackQuery.id, "not_found", "shift_selection");
    }
    return completeShiftSelectionPending({
        pending: loaded.pending,
        data: loaded.pending.resolutionData,
        shift: parsed.shift,
        ctx: { via: "callback", callbackQueryId: callbackQuery.id, chatId: chat.id, promptMessageId },
    });
}

async function handleNameSelectionCallback(
    callbackQuery: TelegramCallbackQuery,
    parsed: NonNullable<ReturnType<typeof parseNameSelectionCallbackData>>,
) {
    const chat = callbackQuery.message?.chat;
    const promptMessageId = callbackQuery.message?.message_id;
    if (!chat || !promptMessageId) {
        await answerCallbackQuery(callbackQuery.id);
        return { ok: true, ignored: true };
    }
    const loaded = await loadPendingForCallback({
        logId: parsed.logId,
        expectedStatus: "pending_name_selection",
        chatId: chat.id,
        presserTelegramId: String(callbackQuery.from.id),
    });
    if (loaded.outcome !== "ok") {
        return answerPendingCallbackShortfall(callbackQuery.id, loaded.outcome, "name_selection");
    }
    if (!isPendingResolutionData(loaded.pending.resolutionData)) {
        return answerPendingCallbackShortfall(callbackQuery.id, "not_found", "name_selection");
    }
    const selected = loaded.pending.resolutionData.candidates[parsed.position - 1];
    if (!selected) {
        return answerPendingCallbackShortfall(callbackQuery.id, "not_found", "name_selection");
    }
    return completeNameSelectionFromCallback({
        pending: loaded.pending,
        data: loaded.pending.resolutionData,
        selected,
        ctx: { callbackQueryId: callbackQuery.id, chatId: chat.id, promptMessageId },
    });
}

async function handlePiamShiftCallback(
    callbackQuery: TelegramCallbackQuery,
    parsed: NonNullable<ReturnType<typeof parsePiamShiftCallbackData>>,
) {
    const chat = callbackQuery.message?.chat;
    const promptMessageId = callbackQuery.message?.message_id;
    if (!chat || !promptMessageId) {
        await answerCallbackQuery(callbackQuery.id);
        return { ok: true, ignored: true };
    }
    const loaded = await loadPendingForCallback({
        logId: parsed.logId,
        expectedStatus: "pending_piam_shift",
        chatId: chat.id,
        presserTelegramId: String(callbackQuery.from.id),
    });
    if (loaded.outcome !== "ok") {
        return answerPendingCallbackShortfall(callbackQuery.id, loaded.outcome, "piam_shift");
    }
    if (!isPendingPiamShiftData(loaded.pending.resolutionData)) {
        return answerPendingCallbackShortfall(callbackQuery.id, "not_found", "piam_shift");
    }
    return completePiamShiftPending({
        pending: loaded.pending,
        data: loaded.pending.resolutionData,
        shift: parsed.shift,
        ctx: { via: "callback", callbackQueryId: callbackQuery.id, chatId: chat.id, promptMessageId },
    });
}

async function handleCoiRamalCallback(
    callbackQuery: TelegramCallbackQuery,
    parsed: NonNullable<ReturnType<typeof parseCoiRamalCallbackData>>,
) {
    const chat = callbackQuery.message?.chat;
    const promptMessageId = callbackQuery.message?.message_id;
    if (!chat || !promptMessageId) {
        await answerCallbackQuery(callbackQuery.id);
        return { ok: true, ignored: true };
    }
    const loaded = await loadPendingForCallback({
        logId: parsed.logId,
        expectedStatus: "pending_cru_coi_ramal",
        chatId: chat.id,
        presserTelegramId: String(callbackQuery.from.id),
    });
    if (loaded.outcome !== "ok") {
        return answerPendingCallbackShortfall(callbackQuery.id, loaded.outcome, "coi_ramal");
    }
    if (!isPendingCruCoiRamalData(loaded.pending.resolutionData)) {
        return answerPendingCallbackShortfall(callbackQuery.id, "not_found", "coi_ramal");
    }

    const data = loaded.pending.resolutionData;
    const reconstructedText = data.originalText.replace(new RegExp(`\\b${data.location}\\b`, "i"), parsed.ramal);
    const parsedEntries = parseMessageMulti(reconstructedText);
    const firstParsed = parsedEntries.find((entry) => !entry.isDeparture) ?? parsedEntries[0];
    if (!firstParsed?.baseCode || !firstParsed.sector) {
        await answerCallbackQuery(
            callbackQuery.id,
            `⚠️ Não consegui montar o registro com o ramal ${parsed.ramal}. Reenvie a mensagem completa.`,
            true,
        );
        return { ok: true, ignored: true };
    }
    const parsedEntry = { ...firstParsed, sector: firstParsed.sector } as OperationalParsedEntry;
    const referenceAt = new Date(data.originalReferenceAt ?? data.originalEventAt);
    return completeArrivalFromPendingSelection({
        pending: loaded.pending,
        parsedEntry,
        doctorQuery: firstParsed.extractedNames[0] ?? null,
        senderName: data.senderName,
        reconstructedText,
        referenceAt,
        supersededErrorPrefix: "cru_coi_ramal",
        resolutionExtra: { ramalResolvedFrom: data.location },
        ctx: { via: "callback", callbackQueryId: callbackQuery.id, chatId: chat.id, promptMessageId },
    });
}

// Update sintético para reprocessar a INTENÇÃO original de uma pendência a partir
// de um callback: mesmo padrão do atalho "confirmo NNNN" (que reescreve o texto e
// deixa o fluxo normal seguir). O from é o AUTOR da pendência — mesmo quando quem
// tocou foi a chefia — para os finders por (chat, sender) casarem. O message_id é
// o do balão-prompt do bot (id real no chat, nunca logado antes), então o registro
// de auditoria em telegram_ingested_messages não colide com mensagem existente.
function buildSyntheticPendingReplyUpdate(params: {
    chat: NonNullable<TelegramUpdate["message"]>["chat"];
    messageId: number;
    senderTelegramId: string;
    senderName: string | null;
    text: string;
}): TelegramUpdate {
    return {
        update_id: 0,
        message: {
            message_id: params.messageId,
            chat: params.chat,
            date: Math.floor(Date.now() / 1000),
            from: { id: Number(params.senderTelegramId), first_name: params.senderName ?? "" },
            text: params.text,
        },
    };
}

// Resultado genérico de um handler que reprocessa via processTelegramUpdate —
// anotação explícita para quebrar o ciclo de inferência (recursão de tipos).
type TelegramCallbackHandlerResult = { ok: boolean; [key: string]: unknown };

// Botões da tomada de ramal/base (auditoria §3.1#4): [✅ Assumir NNNN] confirma
// reprocessando a chegada original (mesmo caminho do "confirmo NNNN"); [❌ Era
// outro ramal] cancela a pendência. Fallbacks textuais continuam valendo.
async function handleTakeoverDecisionCallback(
    callbackQuery: TelegramCallbackQuery,
    parsed: NonNullable<ReturnType<typeof parseTakeoverDecisionCallbackData>>,
): Promise<TelegramCallbackHandlerResult> {
    const chat = callbackQuery.message?.chat;
    const promptMessageId = callbackQuery.message?.message_id;
    if (!chat || !promptMessageId) {
        await answerCallbackQuery(callbackQuery.id);
        return { ok: true, ignored: true };
    }
    const loaded = await loadPendingForCallback({
        logId: parsed.logId,
        expectedStatus: "pending_takeover_confirmation",
        chatId: chat.id,
        presserTelegramId: String(callbackQuery.from.id),
    });
    if (loaded.outcome !== "ok") {
        return answerPendingCallbackShortfall(callbackQuery.id, loaded.outcome, "takeover");
    }
    if (!isTakeoverPendingData(loaded.pending.resolutionData)) {
        return answerPendingCallbackShortfall(callbackQuery.id, "not_found", "takeover");
    }
    const data = loaded.pending.resolutionData as TakeoverPendingData;
    const targetLabel = escapeTelegramMarkdown(data.targetCode);

    if (parsed.decision === "reject") {
        await markTelegramProcessed(loaded.pending.id, {
            status: "superseded",
            errorMessage: "takeover_cancelled_by_button",
            resolutionData: buildResolutionData(data, { pressedByTelegramId: String(callbackQuery.from.id) }),
        });
        await editMessageText(
            chat.id,
            promptMessageId,
            `⛔ Tomada de *${targetLabel}* cancelada — nada mudou no quadro.\nOk, reenvie a chegada com o ramal certo.`,
            undefined,
            { parseMode: "Markdown" },
        );
        await answerCallbackQuery(callbackQuery.id, "Cancelado — reenvie a chegada com o ramal certo.");
        return { ok: true, ignored: true };
    }

    const senderTelegramId = data.senderTelegramId ?? loaded.pending.senderTelegramId;
    if (!data.arrivingMessageText || !senderTelegramId) {
        await answerCallbackQuery(callbackQuery.id, "Não achei a chegada original — reenvie a mensagem completa.", true);
        return { ok: true, ignored: true };
    }

    // Registra quem confirmou ANTES do reprocesso (o fluxo normal só troca status).
    await markTelegramProcessed(loaded.pending.id, {
        resolutionData: buildResolutionData(data, { pressedByTelegramId: String(callbackQuery.from.id) }),
    });

    // Mesmo caminho da confirmação textual: reprocessa a chegada original; o fluxo
    // reencontra a pendência, desloca o ocupante e registra quem assumiu.
    const result = await processTelegramUpdate(buildSyntheticPendingReplyUpdate({
        chat,
        messageId: promptMessageId,
        senderTelegramId,
        senderName: loaded.pending.senderName,
        text: data.arrivingMessageText,
    }));

    // Copy neutra: se a aplicação falhou, o balão logo abaixo explica o motivo.
    await editMessageText(
        chat.id,
        promptMessageId,
        `✅ Confirmação de *${targetLabel}* recebida — veja o registro abaixo.`,
        undefined,
        { parseMode: "Markdown" },
    );
    await answerCallbackQuery(callbackQuery.id, `Confirmação de ${data.targetCode} recebida.`);
    return result;
}

// Fecha a saída tardia SEM crédito automático (semântica do manual_review) a partir
// do botão [Sem motivo] — e avisa a chefia no privado (auditoria §3.1#6: hoje
// ninguém era avisado).
async function completeDepartureJustificationWithoutReason(params: {
    pending: TelegramIngestedMessageRow;
    data: PendingDepartureJustificationData;
    pressedByTelegramId: string;
    chatId: number;
    promptMessageId: number;
    callbackQueryId: string;
}) {
    const { pending, data } = params;
    const eventAt = new Date(data.originalEventAt);
    const mergedText = buildTelegramJustificationFollowUpText(data.originalText, "[botão] sem motivo");

    try {
        let relatedOccupancyId: string;
        if (data.parsed.sector === "REGULATION") {
            const post = await getDb().query.regulationPosts.findFirst({
                where: eq(regulationPosts.code, data.parsed.baseCode),
            });
            if (!post) {
                throw new Error("Regulation post not found.");
            }
            const recentClosed = await findRecentClosedRegulationOccupancy({
                postId: post.id,
                doctorId: data.resolvedDoctor.id,
                eventAt,
            });
            if (!recentClosed) {
                throw new Error("No active regulation occupancy found for this doctor/post.");
            }
            relatedOccupancyId = (await correctRegulationOccupancy(recentClosed.id, {
                notes: appendTelegramOperationalNote(recentClosed.notes, "telegram saida sem motivo declarado - sem credito automatico", mergedText),
            }, null)).id;
        } else {
            const base = await getDb().query.interventionBases.findFirst({
                where: eq(interventionBases.code, data.parsed.baseCode),
            });
            if (!base) {
                throw new Error("Intervention base not found.");
            }
            const recentClosed = await findRecentClosedInterventionOccupancy({
                baseId: base.id,
                doctorId: data.resolvedDoctor.id,
                eventAt,
            });
            if (!recentClosed) {
                throw new Error("No active intervention occupancy found for this doctor/base.");
            }
            relatedOccupancyId = (await correctInterventionOccupancy(recentClosed.id, {
                notes: appendTelegramOperationalNote(recentClosed.notes, "telegram saida sem motivo declarado - sem credito automatico", mergedText),
            }, null)).id;
        }

        await markTelegramProcessed(pending.id, {
            status: "accepted",
            relatedOccupancyId,
            errorMessage: null,
            resolutionData: buildResolutionData(data, {
                justificationButtonChoice: "none",
                pressedByTelegramId: params.pressedByTelegramId,
                automaticCreditGranted: false,
                manualReviewOnly: true,
            }),
        });

        const doctorName = resolveTelegramDoctorSurfaceName(data.resolvedDoctor);
        await editMessageText(
            params.chatId,
            params.promptMessageId,
            pickTelegramReply("departure_justification_manual_review", params.promptMessageId, {
                name: doctorName,
                target: data.parsed.baseCode,
                time: formatTelegramReplyTime(eventAt),
            }),
        );
        await answerCallbackQuery(params.callbackQueryId, "Fechei sem crédito automático — a chefia foi avisada.");

        // Aviso à chefia no privado — hoje ninguém era avisado quando a saída
        // tardia ficava sem motivo.
        await sendPrivateChiefAlert(
            `🔎 Saída tardia sem motivo: *${escapeTelegramMarkdown(doctorName)}* em *${escapeTelegramMarkdown(data.parsed.baseCode)}* às *${formatTelegramReplyTime(eventAt)}* fechou sem crédito automático (escolheu "Sem motivo" no grupo). Se os minutos extras valerem, lance manualmente.`,
            { parseMode: "Markdown" },
        );
        return { ok: true, occupancyId: relatedOccupancyId };
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : "telegram_processing_failed";
        await markTelegramProcessed(pending.id, { status: "error", errorMessage });
        await answerCallbackQuery(params.callbackQueryId, formatTelegramErrorForUser(errorMessage), true);
        return { ok: true, ignored: true, processingError: true };
    }
}

// Botões da justificativa de saída tardia (auditoria §3.1#6): 🚑 pede só os 4
// dígitos, 🧼 credita higienização pelo MESMO caminho do texto, [Sem motivo]
// fecha em manual_review + aviso privado à chefia. Texto livre continua valendo.
async function handleDepartureJustificationCallback(
    callbackQuery: TelegramCallbackQuery,
    parsed: NonNullable<ReturnType<typeof parseDepartureJustificationCallbackData>>,
): Promise<TelegramCallbackHandlerResult> {
    const chat = callbackQuery.message?.chat;
    const promptMessageId = callbackQuery.message?.message_id;
    if (!chat || !promptMessageId) {
        await answerCallbackQuery(callbackQuery.id);
        return { ok: true, ignored: true };
    }
    const loaded = await loadPendingForCallback({
        logId: parsed.logId,
        expectedStatus: "pending_departure_justification",
        chatId: chat.id,
        presserTelegramId: String(callbackQuery.from.id),
    });
    if (loaded.outcome !== "ok") {
        return answerPendingCallbackShortfall(callbackQuery.id, loaded.outcome, "departure_justification");
    }
    if (!isPendingDepartureJustificationData(loaded.pending.resolutionData)) {
        return answerPendingCallbackShortfall(callbackQuery.id, "not_found", "departure_justification");
    }
    const data = loaded.pending.resolutionData;

    if (parsed.choice === "none") {
        return completeDepartureJustificationWithoutReason({
            pending: loaded.pending,
            data,
            pressedByTelegramId: String(callbackQuery.from.id),
            chatId: chat.id,
            promptMessageId,
            callbackQueryId: callbackQuery.id,
        });
    }

    if (parsed.choice === "occurrence") {
        // Marca o motivo como ocorrência e passa a cobrar SÓ o número (4 dígitos).
        // O "[botão] estava em ocorrência" anexado ao texto original faz o merge
        // com a resposta numérica resolver o claim pelo caminho normal.
        await markTelegramProcessed(loaded.pending.id, {
            errorMessage: "departure_occurrence_number_required",
            resolutionData: buildResolutionData(data, {
                occurrenceNumberRequired: true,
                originalText: `${data.originalText}\n[botão] estava em ocorrência`,
                justificationButtonChoice: "occurrence",
                pressedByTelegramId: String(callbackQuery.from.id),
            }),
        });
        await editMessageText(
            chat.id,
            promptMessageId,
            "🚑 Ocorrência — agora só falta o número dela: responda com os *4 dígitos*. Ex.: `4521`",
            undefined,
            { parseMode: "Markdown" },
        );
        await answerCallbackQuery(callbackQuery.id, "Me responda só os 4 dígitos da ocorrência.");
        return { ok: true, ignored: true, pending: true };
    }

    // 🧼 Higienização: reprocessa como se o autor tivesse respondido o motivo por
    // texto — cai em tryHandlePendingDepartureJustification e credita pelo mesmo
    // caminho (registro de auditoria incluso).
    const senderTelegramId = loaded.pending.senderTelegramId;
    if (!senderTelegramId) {
        await answerCallbackQuery(callbackQuery.id, "Não achei o autor da pendência — responda o motivo por texto.", true);
        return { ok: true, ignored: true };
    }
    await markTelegramProcessed(loaded.pending.id, {
        resolutionData: buildResolutionData(data, {
            justificationButtonChoice: "hygienization",
            pressedByTelegramId: String(callbackQuery.from.id),
        }),
    });
    const result = await processTelegramUpdate(buildSyntheticPendingReplyUpdate({
        chat,
        messageId: promptMessageId,
        senderTelegramId,
        senderName: loaded.pending.senderName,
        text: "[botão] estava higienizando a viatura",
    }));
    // Copy neutra: se a aplicação falhou, o balão logo abaixo explica o motivo.
    await editMessageText(
        chat.id,
        promptMessageId,
        "🧼 Higienização — veja o resultado abaixo.",
    );
    await answerCallbackQuery(callbackQuery.id, "Anotado: higienização.");
    return result;
}

// Botões de destino desconhecido (auditoria §3.1#9): completa a chegada trocando o
// token rejeitado pelo código real escolhido — mesmo caminho do COI (reconstrução
// + completeArrivalFromPendingSelection, que revalida conflito/tomada).
async function handleDestinationSelectionCallback(
    callbackQuery: TelegramCallbackQuery,
    parsed: NonNullable<ReturnType<typeof parseDestinationSelectionCallbackData>>,
) {
    const chat = callbackQuery.message?.chat;
    const promptMessageId = callbackQuery.message?.message_id;
    if (!chat || !promptMessageId) {
        await answerCallbackQuery(callbackQuery.id);
        return { ok: true, ignored: true };
    }
    const loaded = await loadPendingForCallback({
        logId: parsed.logId,
        expectedStatus: "pending_destination_selection",
        chatId: chat.id,
        presserTelegramId: String(callbackQuery.from.id),
    });
    if (loaded.outcome !== "ok") {
        return answerPendingCallbackShortfall(callbackQuery.id, loaded.outcome, "destination_selection");
    }
    if (!isPendingDestinationSelectionData(loaded.pending.resolutionData)) {
        return answerPendingCallbackShortfall(callbackQuery.id, "not_found", "destination_selection");
    }
    const data = loaded.pending.resolutionData;
    if (!data.suggestions.some((code) => code.trim().toUpperCase() === parsed.code)) {
        // callback_data forjado com código fora das sugestões gravadas: ignora.
        return answerPendingCallbackShortfall(callbackQuery.id, "not_found", "destination_selection");
    }

    const reconstructedText = replaceUnknownTargetToken(data.originalText, data.token, parsed.code);
    if (!reconstructedText) {
        await answerCallbackQuery(callbackQuery.id, "Não consegui montar o registro — reenvie a mensagem completa.", true);
        return { ok: true, ignored: true };
    }
    const parsedEntries = parseMessageMulti(reconstructedText);
    const firstParsed = parsedEntries.find((entry) => !entry.isDeparture) ?? parsedEntries[0];
    if (!firstParsed?.baseCode || !firstParsed.sector) {
        await answerCallbackQuery(callbackQuery.id, `Não consegui montar o registro com ${parsed.code}. Reenvie a mensagem completa.`, true);
        return { ok: true, ignored: true };
    }
    const parsedEntry = { ...firstParsed, sector: firstParsed.sector } as OperationalParsedEntry;
    return completeArrivalFromPendingSelection({
        pending: loaded.pending,
        parsedEntry,
        doctorQuery: firstParsed.extractedNames[0] ?? null,
        senderName: data.senderName,
        reconstructedText,
        referenceAt: new Date(data.originalReferenceAt),
        supersededErrorPrefix: "destination_selection",
        resolutionExtra: { destinationResolvedFrom: data.token },
        ctx: { via: "callback", callbackQueryId: callbackQuery.id, chatId: chat.id, promptMessageId },
    });
}

// Botões do reset geral de codinomes (auditoria §3.4#15): TTL de 5 min, re-validação
// de ADMIN no callback e consumo marcado ANTES de executar (anti double-tap).
async function handleResetAllCallback(
    callbackQuery: TelegramCallbackQuery,
    parsed: NonNullable<ReturnType<typeof parseResetAllCallbackData>>,
) {
    const chat = callbackQuery.message?.chat;
    const promptMessageId = callbackQuery.message?.message_id;
    if (!chat || !promptMessageId) {
        await answerCallbackQuery(callbackQuery.id);
        return { ok: true, ignored: true };
    }
    const loaded = await loadPendingForCallback({
        logId: parsed.logId,
        expectedStatus: "pending_reset_all_confirmation",
        chatId: chat.id,
        presserTelegramId: String(callbackQuery.from.id),
        ttlMs: RESET_ALL_CONFIRM_TTL_MS,
    });
    if (loaded.outcome !== "ok") {
        return answerPendingCallbackShortfall(callbackQuery.id, loaded.outcome, "reset_all");
    }
    if (!isPendingResetAllConfirmationData(loaded.pending.resolutionData)) {
        return answerPendingCallbackShortfall(callbackQuery.id, "not_found", "reset_all");
    }
    // Re-validação: reset geral é EXCLUSIVO de admin — chefia não confirma.
    if (!getTelegramAdminUserIds().includes(String(callbackQuery.from.id))) {
        await answerCallbackQuery(callbackQuery.id, "⛔ Só admin do bot pode confirmar esse reset.", true);
        return { ok: true, ignored: true };
    }
    const data = loaded.pending.resolutionData;

    if (parsed.decision === "cancel") {
        await markTelegramProcessed(loaded.pending.id, {
            status: "ignored",
            errorMessage: "payment_reset_all_cancelled",
            resolutionData: buildResolutionData(data, { pressedByTelegramId: String(callbackQuery.from.id) }),
        });
        await editMessageText(chat.id, promptMessageId, "OK — cancelado. Nenhum codinome foi alterado.");
        await answerCallbackQuery(callbackQuery.id, "Cancelado.");
        return { ok: true, ignored: true };
    }

    // Anti double-tap: consome a pendência ANTES de executar — o segundo toque
    // encontra status accepted e recebe "já foi concluído".
    await markTelegramProcessed(loaded.pending.id, {
        status: "accepted",
        parsedAction: "payment_reset_all",
        errorMessage: "payment_reset_all_confirmed_button",
        resolutionData: buildResolutionData(data, { pressedByTelegramId: String(callbackQuery.from.id) }),
    });

    try {
        const results = await resetAllDoctorCodenames();
        await editMessageText(
            chat.id,
            promptMessageId,
            `🔐 Codinomes resetados — *${results.length}* médicos. Os anteriores não valem mais.\nEntregue cada codinome no privado do médico.`,
            undefined,
            { parseMode: "Markdown" },
        );
        const header = `🔐 Codinomes novos (${results.length}):`;
        const lines = results.map((r) => `${r.fullName} — ${r.codename}`);
        for (const text of chunkTelegramLines(header, lines)) {
            await sendMessage(chat.id, text);
        }
        await answerCallbackQuery(callbackQuery.id, "Reset concluído.");
        return { ok: true, reported: true };
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : "payment_reset_all_failed";
        await markTelegramProcessed(loaded.pending.id, { status: "error", errorMessage });
        await editMessageText(chat.id, promptMessageId, "⛔ Não consegui resetar os codinomes. Envie /pagamento resetar-todos para tentar de novo.");
        await answerCallbackQuery(callbackQuery.id, "Falhou — tente de novo.", true);
        return { ok: true, ignored: true, processingError: true };
    }
}

// Resposta textual "SD"/"SN" (ou "dia"/"noite") para a pergunta do PIAM: vale a
// pendência do próprio autor, ou o reply de chefia/admin ao balão-pergunta.
async function tryHandlePendingPiamShiftReply(update: TelegramUpdate, logId: string) {
    const message = update.message;
    if (!message?.text || !message.from?.id) {
        return null;
    }
    const choice = classifyPiamShiftTextReply(message.text);
    if (!choice) {
        return null;
    }

    const chatId = String(message.chat.id);
    const senderId = String(message.from.id);
    let pending = await findPendingPiamShift(chatId, senderId);

    if (!pending && message.reply_to_message?.message_id) {
        const byPrompt = await findPendingPiamShiftByPrompt(chatId, message.reply_to_message.message_id);
        if (byPrompt) {
            const permission = resolvePendingPresserPermission({
                presserTelegramId: senderId,
                pendingSenderTelegramId: byPrompt.senderTelegramId,
                chiefTelegramIds: getTelegramChiefUserIds(),
                adminTelegramIds: getTelegramAdminUserIds(),
            });
            if (permission === "denied") {
                await markTelegramProcessed(logId, {
                    status: "ignored",
                    errorMessage: "piam_shift_reply_denied",
                });
                await sendMessage(message.chat.id, buildThirdPartyPressAlertText(), message.message_id);
                return { ok: true, ignored: true };
            }
            pending = byPrompt;
        }
    }

    if (!pending || !isPendingPiamShiftData(pending.resolutionData)) {
        return null;
    }

    return completePiamShiftPending({
        pending,
        data: pending.resolutionData,
        shift: choice,
        ctx: { via: "text", message, logId },
    });
}

// Reabertura de pendência por resposta curta órfã (auditoria §5#6): "SD"/"SN"/"P",
// "1/2/3", ramal de 4 dígitos ou "HH:MM" do MESMO autor no MESMO chat encontram a
// pendência recente (ativa ou expirada ≤2h) em vez de morrer em no_operational_match.
// A aplicação revalida contra o estado atual (tomada/conflito) — se falhar, sai o
// erro normal do fluxo.
async function tryHandleShortReplyToRecentPending(update: TelegramUpdate, logId: string) {
    const message = update.message;
    if (!message?.text || !message.from?.id) {
        return null;
    }
    const reply = classifyPendingShortReply(message.text);
    if (!reply) {
        return null;
    }

    const chatId = String(message.chat.id);
    const senderId = String(message.from.id);
    const now = new Date(message.date * 1000);

    if (reply.kind === "shift") {
        const activeShift = await findPendingShiftSelection(chatId, senderId);
        if (activeShift && isPendingShiftSelectionData(activeShift.resolutionData)) {
            return completeShiftSelectionPending({
                pending: activeShift,
                data: activeShift.resolutionData,
                shift: reply.shift,
                ctx: { via: "text", message, logId },
            });
        }
        const expiredShift = await findExpiredReopenablePending(
            chatId,
            senderId,
            (row) => isPendingShiftSelectionData(row.resolutionData),
            now,
        );
        if (expiredShift && isPendingShiftSelectionData(expiredShift.resolutionData)) {
            return completeShiftSelectionPending({
                pending: expiredShift,
                data: expiredShift.resolutionData,
                shift: reply.shift,
                ctx: { via: "text", message, logId },
            });
        }
        if (reply.shift !== "P") {
            const expiredPiam = await findExpiredReopenablePending(
                chatId,
                senderId,
                (row) => isPendingPiamShiftData(row.resolutionData),
                now,
            );
            if (expiredPiam && isPendingPiamShiftData(expiredPiam.resolutionData)) {
                return completePiamShiftPending({
                    pending: expiredPiam,
                    data: expiredPiam.resolutionData,
                    shift: reply.shift,
                    ctx: { via: "text", message, logId },
                });
            }
        }
        return null;
    }

    if (reply.kind === "option") {
        return tryHandlePendingNameSelection(update, logId, { includeExpired: true });
    }

    if (reply.kind === "ramal") {
        return tryHandlePendingRamalSelection(update, logId, { includeExpired: true });
    }

    // "HH:MM" órfão: única pendência que consome hora solta é a correção de saída.
    return tryHandlePendingDepartureCorrection(update, logId, { includeExpired: true });
}

async function handleFiscalSuggestionCallback(callbackQuery: TelegramCallbackQuery, confirm: boolean) {
    const chat = callbackQuery.message?.chat;
    const messageId = callbackQuery.message?.message_id;
    const allowed = chat
        ? await isTelegramMessageAllowed({
            message_id: messageId ?? 0,
            chat,
            from: callbackQuery.from,
            date: 0,
        } as TelegramUpdate["message"])
        : false;
    if (!chat || !allowed) {
        await answerCallbackQuery(callbackQuery.id);
        return { ok: true, ignored: true };
    }

    const chatId = String(chat.id);
    const senderTelegramId = String(callbackQuery.from.id);
    const pending = await findPendingPaymentProfile(chatId, senderTelegramId);
    if (!pending || !isPendingPaymentProfileData(pending.resolutionData) || pending.resolutionData.stage !== "awaiting_suggestion_confirmation") {
        await answerCallbackQuery(callbackQuery.id, "Esse cadastro já não está mais em andamento. Envie /pagamento cadastro para recomeçar.", true);
        return { ok: true, ignored: true };
    }

    const data = pending.resolutionData;
    if (!data.doctorId || !data.suggestedRazaoSocial || !data.suggestedCnpj) {
        await markTelegramProcessed(pending.id, { status: "superseded", errorMessage: "payment_profile_missing_suggestion_context" });
        await answerCallbackQuery(callbackQuery.id, "Deu ruim aqui — envie /pagamento cadastro para recomeçar.", true);
        return { ok: true, ignored: true };
    }

    if (confirm) {
        const saved = await upsertDoctorFiscalProfile({
            doctorId: data.doctorId,
            razaoSocial: data.suggestedRazaoSocial,
            cnpj: data.suggestedCnpj,
        });
        await markTelegramProcessed(pending.id, {
            status: "accepted",
            parsedAction: "payment_profile_setup",
            parsedDoctorName: saved.fullName,
            resolutionData: { doctorId: saved.doctorId, companyName: saved.razaoSocial, cnpj: saved.cnpj },
            errorMessage: null,
        });
        await answerCallbackQuery(callbackQuery.id, "Confirmado!");
        if (messageId) {
            await editMessageText(
                chat.id,
                messageId,
                [
                    "✅ Cadastro fiscal confirmado.",
                    `🏢 Empresa: ${saved.razaoSocial}`,
                    `🧾 CNPJ: ${saved.cnpj}`,
                    "A folha de ponto já vai sair com esses dados.",
                ].join("\n"),
            );
        }
        return { ok: true, reported: true };
    }

    await markTelegramProcessed(pending.id, {
        status: "pending_payment_profile",
        parsedAction: "payment_profile_setup",
        resolutionData: { stage: "awaiting_company_name", doctorId: data.doctorId },
        errorMessage: null,
    });
    await answerCallbackQuery(callbackQuery.id);
    if (messageId) {
        await editMessageText(chat.id, messageId, "Sem problema. Me diga o *nome completo da empresa* (razão social) correto.");
    }
    return { ok: true, pending: true };
}

// Dispatcher único de callback_query, com dispatch por PREFIXO do callback_data
// (padrão parseContinuityRevertCallbackData): pSN = reverter P→SN; f6 = turno da
// chegada F6; nm = candidato de nome; pi = PIAM SD/SN; coi = ramal do COI;
// tk = tomada de ramal; dj = justificativa de saída; dst = destino desconhecido;
// rta = reset geral de codinomes; fsg = confirmação de dados fiscais sugeridos.
async function handleTelegramCallbackQuery(callbackQuery: TelegramCallbackQuery) {
    const fiscalConfirm = parseFiscalSuggestionCallbackData(callbackQuery.data);
    if (fiscalConfirm !== null) {
        return handleFiscalSuggestionCallback(callbackQuery, fiscalConfirm);
    }

    const shiftSelection = parseShiftSelectionCallbackData(callbackQuery.data);
    const nameSelection = parseNameSelectionCallbackData(callbackQuery.data);
    const piamShift = parsePiamShiftCallbackData(callbackQuery.data);
    const coiRamal = parseCoiRamalCallbackData(callbackQuery.data);
    const takeoverDecision = parseTakeoverDecisionCallbackData(callbackQuery.data);
    const departureJustification = parseDepartureJustificationCallbackData(callbackQuery.data);
    const destinationSelection = parseDestinationSelectionCallbackData(callbackQuery.data);
    const resetAll = parseResetAllCallbackData(callbackQuery.data);
    const parsed = parseContinuityRevertCallbackData(callbackQuery.data);
    if (!parsed && !shiftSelection && !nameSelection && !piamShift && !coiRamal
        && !takeoverDecision && !departureJustification && !destinationSelection && !resetAll) {
        // Callback desconhecido: encerra o "loading" do cliente e ignora.
        await answerCallbackQuery(callbackQuery.id);
        return { ok: true, ignored: true };
    }

    const chat = callbackQuery.message?.chat;
    const messageId = callbackQuery.message?.message_id;
    const allowed = chat
        ? await isTelegramMessageAllowed({
            message_id: messageId ?? 0,
            chat,
            from: callbackQuery.from,
            date: 0,
        } as TelegramUpdate["message"])
        : false;
    if (!allowed) {
        await answerCallbackQuery(callbackQuery.id);
        return { ok: true, ignored: true };
    }

    if (shiftSelection) {
        return handleShiftSelectionCallback(callbackQuery, shiftSelection);
    }
    if (nameSelection) {
        return handleNameSelectionCallback(callbackQuery, nameSelection);
    }
    if (piamShift) {
        return handlePiamShiftCallback(callbackQuery, piamShift);
    }
    if (coiRamal) {
        return handleCoiRamalCallback(callbackQuery, coiRamal);
    }
    if (takeoverDecision) {
        return handleTakeoverDecisionCallback(callbackQuery, takeoverDecision);
    }
    if (departureJustification) {
        return handleDepartureJustificationCallback(callbackQuery, departureJustification);
    }
    if (destinationSelection) {
        return handleDestinationSelectionCallback(callbackQuery, destinationSelection);
    }
    if (resetAll) {
        return handleResetAllCallback(callbackQuery, resetAll);
    }
    if (!parsed) {
        await answerCallbackQuery(callbackQuery.id);
        return { ok: true, ignored: true };
    }

    const db = getDb();
    const occupancy = parsed.domain === "regulation"
        ? await db.query.regulationOccupancies.findFirst({ where: eq(regulationOccupancies.id, parsed.occupancyId) })
        : await db.query.interventionOccupancies.findFirst({ where: eq(interventionOccupancies.id, parsed.occupancyId) });

    const outcome = evaluateContinuityRevert({
        occupancy: occupancy ? { shiftLabel: occupancy.shiftLabel, createdAt: occupancy.createdAt } : null,
        now: new Date(),
    });

    if (outcome !== "ok") {
        const text = outcome === "expired"
            ? "Tempo esgotado: a janela de 2 min para reverter já passou. Se precisar, avise a chefia."
            : outcome === "already_changed"
                ? "Já estava ajustado — nada a reverter."
                : "Não encontrei esse registro para reverter.";
        await answerCallbackQuery(callbackQuery.id, text, true);
        return { ok: true, reverted: false, outcome };
    }

    // Rebaixa P -> turno-base real da chegada (SN para P noturno; SD para chegada
    // adiantada de madrugada, que é P do dia). correctXxxOccupancy recalcula a
    // janela agendada. Marcar SN aqui de forma fixa jogava a chegada das 06:xx
    // para a noite (caso Syone BR60, 07/08/2026).
    const target = resolveContinuityRevertTarget(occupancy!.startedAt);
    if (parsed.domain === "regulation") {
        await correctRegulationOccupancy(parsed.occupancyId, { shiftLabel: target }, null);
    } else {
        await correctInterventionOccupancy(parsed.occupancyId, { shiftLabel: target }, null);
    }

    const scope = target === "SN" ? "só esta noite" : "só este dia";
    await answerCallbackQuery(callbackQuery.id, `Pronto! Marquei como ${target} — cobre ${scope}.`);
    if (chat && messageId) {
        await editMessageText(
            chat.id,
            messageId,
            `✅ Corrigido para *${target === "SN" ? "SN (noturno)" : "SD (diurno)"}* — cobre ${scope}, sem o turno seguinte.`,
        );
    }
    return { ok: true, reverted: true };
}

export async function processTelegramUpdate(update: TelegramUpdate) {
    if (update.callback_query) {
        return handleTelegramCallbackQuery(update.callback_query);
    }

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
        // No privado, um não-controlador (ex.: médico) que mandar /ajuda ou qualquer
        // coisa fora do esperado recebe o tutorial curto de autoatendimento — não fica
        // no silêncio. (Em grupos não respondemos para não poluir.)
        if (message?.chat.type === "private") {
            await sendMessage(message.chat.id, buildPaymentSelfServiceTutorial(), message.message_id);
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
                // "confirmo NNNN": confirma uma tomada pendente e reescreve o texto para a
                // chegada original (cai no fluxo normal). Vem antes dos demais pendings para
                // reivindicar o atalho; só termina aqui quando NÃO há tomada pendente válida.
                const pendingTakeoverResult = await tryHandlePendingTakeoverConfirmation(update, log.id);
                if (pendingTakeoverResult) {
                    return pendingTakeoverResult;
                }

                const pendingAlertaResult = await tryHandlePendingAlertaConfirmation(update, log.id);
                if (pendingAlertaResult) {
                    return pendingAlertaResult;
                }

                const pendingBatchResult = await tryHandlePendingBatchConfirmation(update, log.id);
                if (pendingBatchResult) {
                    return pendingBatchResult;
                }

                const pendingPaymentProfileResult = await tryHandlePendingPaymentProfile(update, log.id);
                if (pendingPaymentProfileResult) {
                    return pendingPaymentProfileResult;
                }

                const pendingRamalResult = await tryHandlePendingRamalSelection(update, log.id);
                if (pendingRamalResult) {
                    return pendingRamalResult;
                }

                // "SD"/"SN" (ou "dia"/"noite") respondendo a pergunta do PIAM —
                // solto (pendência do autor) ou como reply ao balão-pergunta.
                const pendingPiamShiftResult = await tryHandlePendingPiamShiftReply(update, log.id);
                if (pendingPiamShiftResult) {
                    return pendingPiamShiftResult;
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

                // Reabertura por resposta curta (auditoria §5#6): DEPOIS dos handlers
                // de meal-break (colisão "12:30" com slot) e das pendências ativas;
                // ANTES da guarda de dígito solto e do parser operacional.
                const shortReplyResult = await tryHandleShortReplyToRecentPending(update, log.id);
                if (shortReplyResult) {
                    return shortReplyResult;
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
                            "⛔ Lançamento em lote no privado fica restrito ao ID autorizado da chefia. Para os demais casos, envie os registros individualmente.",
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

            // Toque nos botões literais da divisão de refeição ("↩️ Desfazer" /
            // "✅ Confirmar") sem sessão ativa tratando: sem esta guarda o texto
            // caía no parser de chegada e virava no_operational_match (~50/mês,
            // auditoria comunicação §5#4). Fica DEPOIS dos handlers de meal-break
            // (fluxo ativo tem prioridade) e ANTES do parser operacional.
            const staleMealBreakButtonText = message.text.trim();
            if (staleMealBreakButtonText === MEAL_BREAK_UNDO_BUTTON_TEXT || staleMealBreakButtonText === MEAL_BREAK_CONFIRM_BUTTON_TEXT) {
                await markTelegramProcessed(log.id, {
                    status: "ignored",
                    errorMessage: "meal_break_button_stale",
                    resolutionData: { staleMealBreakButton: staleMealBreakButtonText },
                });
                await sendMessage(
                    message.chat.id,
                    "⛔ Esse botão era da divisão de refeição, que já encerrou. Para outra coisa, mande a mensagem por extenso.",
                    message.message_id,
                );
                return { ok: true, ignored: true };
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
                                result.piamAutoAllocated,
                                result.piamOriginalCode,
                                result.extendedLongShift,
                                result.displacedDoctorName,
                            );
                            await maybeSendContinuityForwardPrompt(message.chat.id, message.message_id, result.forwardContinuityPrompt);
                            return { ok: true, occupancyId: result.occupancyId };
                        } catch (error) {
                            const errorMsg = error instanceof Error ? error.message : "unknown_error";
                            if (shouldRouteToDepartureJustification(errorMsg, continuationResolved.parsed)) {
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
                    const departureResolved = await resolveDepartureWithoutBase(rawParsedForDeparture, message.text, senderName, new Date(message.date * 1000));
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
                            await maybeSendContinuityForwardPrompt(message.chat.id, message.message_id, result.forwardContinuityPrompt);
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
                    // COI = escolha binária (1367/1368): balão curto + botões que
                    // completam o pending_cru_coi_ramal via callback (auditoria
                    // §3.1#10). CRU tem muitos ramais e continua digitado.
                    const coiButtons = Boolean(message.from?.id) && locationHint.location === "COI";
                    await sendMessage(
                        message.chat.id,
                        coiButtons
                            ? buildCoiRamalPromptText()
                            : buildLocationWithoutRamalReply({
                                senderName: rawParsed?.extractedNames[0] ?? senderName ?? "",
                                location: locationHint.location,
                                shiftLabel: rawParsed?.shiftType ?? null,
                                time: rawParsed?.arrivalTime ?? null,
                                interactive: Boolean(message.from?.id),
                            }),
                        message.message_id,
                        coiButtons ? buildCoiRamalKeyboard(log.id) : undefined,
                        coiButtons ? { parseMode: "Markdown" } : undefined,
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

                    // Destino desconhecido (auditoria §3.1#9): antes do "não entendi"
                    // genérico, diagnostica o código rejeitado e sugere os reais.
                    if (rawPartial.unknownTargetToken
                        && (rawPartial.extractedNames.length > 0 || rawPartial.shiftType || rawPartial.arrivalTime)) {
                        const unknownDestinationResult = await respondUnknownDestination({
                            logId: log.id,
                            message,
                            rawPartial,
                        });
                        if (unknownDestinationResult) {
                            return unknownDestinationResult;
                        }
                    }

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

            // F6: Arrivals must carry both an explicit doctor name AND an explicit shift
            // type (SD/SN/P). A bare "NNNN HH:MM" — the literal text emitted by
            // buildMealBreakStageKeyboard buttons — must never be promoted to an
            // operational arrival, even when the chat's meal-break session is already
            // closed. Departures and continuations keep their own rules.
            if (
                message.chat.type !== "private"
                && !firstParsed.isDeparture
                && !isTelegramContinuationEntry(firstParsed)
            ) {
                const hasName = firstParsed.extractedNames.length > 0;
                const hasShift = Boolean(firstParsed.shiftType)
                    || arrivalHalfShiftSatisfiesShiftGate(firstParsed, new Date(message.date * 1000));
                const isBareButtonPayload = looksLikeMealBreakButtonReply(message.text);
                // Remanejamento (mudou/trocou/remanejado PARA NNNN): o médico já está em
                // plantão, então a mensagem de relocação naturalmente não traz SD/SN/P. Exige
                // o nome (para saber QUEM move), mas NÃO o turno — ele é herdado da ocupação
                // de origem em handleTelegramReassignment.
                const shiftRequired = !firstParsed.isReassignment;
                if (isBareButtonPayload || !hasName || (shiftRequired && !hasShift)) {
                    // Finding 1 (138 casos/mês — o maior bucket de chegada rejeitada):
                    // nome+local presentes e faltou SÓ o turno → vira pendência com
                    // botões [☀️ SD] [🌙 SN] [🕐 P 24h] em vez de rejeição seca. O
                    // caminho de meio plantão (arrivalHalfShiftSatisfiesShiftGate) já
                    // liberou hasShift antes e não passa por aqui.
                    const shiftSelectionSenderId = message.from?.id ? String(message.from.id) : null;
                    if (!isBareButtonPayload && hasName && shiftRequired && !hasShift && shiftSelectionSenderId) {
                        await queuePendingShiftSelection({
                            logId: log.id,
                            message,
                            parsed: firstParsed,
                            senderTelegramId: shiftSelectionSenderId,
                        });
                        return { ok: true, ignored: true, pending: true };
                    }

                    const reason: TelegramReviewReason = isBareButtonPayload
                        ? "meal_break_button_outside_flow"
                        : "arrival_missing_name_or_shift";
                    await markTelegramProcessed(log.id, {
                        status: "ignored",
                        parsedDomain: firstParsed.sector,
                        parsedTargetCode: firstParsed.baseCode,
                        parsedAction: "arrival",
                        errorMessage: reason,
                        resolutionData: buildTelegramReviewLogData({
                            reason,
                            parsed: firstParsed,
                            trainingCandidate: !isBareButtonPayload,
                        }),
                    });

                    const senderFullName = [message.from?.first_name, message.from?.last_name].filter(Boolean).join(" ") || null;
                    const guessedName = firstParsed.extractedNames[0] ?? senderFullName ?? "Vagner Costa";
                    const guessedTarget = firstParsed.baseCode ?? "1363";
                    const guessedTime = firstParsed.arrivalTime ?? "07:00";
                    const guessedShift = firstParsed.shiftType ?? "SD";
                    const exampleArrival = `${guessedName} ${guessedTarget} ${guessedShift} ${guessedTime}`;

                    const detected: string[] = [];
                    if (firstParsed.baseCode) detected.push(`base/ramal *${firstParsed.baseCode}*`);
                    if (firstParsed.arrivalTime) detected.push(`horário *${firstParsed.arrivalTime}*`);
                    if (hasName) detected.push(`nome *${firstParsed.extractedNames[0]}*`);
                    if (hasShift) detected.push(`turno *${firstParsed.shiftType}*`);

                    const missing: string[] = [];
                    if (!hasName) missing.push("*nome do médico*");
                    if (shiftRequired && !hasShift) missing.push("*turno* (SD, SN ou P)");

                    let body: string;
                    if (isBareButtonPayload) {
                        body = [
                            "⛔ `ramal HH:MM` é o botão da divisão de almoço, e ela não está em curso agora.",
                            `Pra registrar chegada, mande nome + ramal + turno + horário. Ex.: _${exampleArrival}_`,
                        ].join("\n");
                    } else {
                        const detectedLine = detected.length > 0
                            ? `Entendi: ${detected.join(", ")}.`
                            : "Não consegui montar a chegada com o que veio.";
                        const missingLine = `Faltou: ${missing.join(" e ")}.`;
                        body = [
                            `⚠️ ${detectedLine} ${missingLine}`,
                            `Manda tudo numa mensagem só. Ex.: _${exampleArrival}_`,
                        ].join("\n");
                    }

                    await sendMessage(message.chat.id, body, message.message_id);
                    return { ok: true, ignored: true };
                }
            }

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
                // A reply de departure_missing_context já interpola {example}; anexar o
                // hint estruturado repetia o MESMO exemplo no mesmo balão (auditoria §3.1#16).
                await sendMessage(
                    message.chat.id,
                    pickTelegramReply("departure_missing_context", message.message_id, {
                        example: departureExample,
                    }),
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

                // Auditoria §3.3#15: typo que o resolver rejeitou ainda pode ter
                // candidatos fuzzy próximos — em vez do beco doctor_not_resolved,
                // oferece-os como pendência com botões (cap 3, mesmo fluxo do
                // candidate_prompt). Só com nome explícito na mensagem: não vale
                // adivinhar pelo perfil do remetente.
                if (doctorQuery) {
                    const directory = await listDirectoryEntries();
                    const nearbyCandidates = resolveDoctorCandidates(doctorQuery, directory as TelegramDoctorDirectoryEntry[], 3);
                    if (nearbyCandidates.length > 0) {
                        await queuePendingNameSelection(log.id, message, firstParsed, doctorQuery, new Date(message.date * 1000), eventAt, nearbyCandidates);
                        return { ok: true, ignored: true, pending: true };
                    }
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

            const messageReferenceAt = new Date(message.date * 1000);
            const isGenuineArrival = !firstParsed.isDeparture && !firstParsed.isContinuation && !firstParsed.isReassignment;
            const eventAt = resolveArrivalEventTimeForPhase(messageReferenceAt, firstParsed.arrivalTime, isGenuineArrival);

            // Tomada de ramal/base ocupado no mesmo turno: avisa quem ocupa e exige
            // reenvio EXATO para confirmar. Só então desloca o ocupante (preservando a
            // chegada dele). Vale para chegada nova e para move (remanejamento).
            let takeoverDisplaced: { occupantName: string; targetLabel: string; sinceTime: string } | null = null;
            const takeoverSenderId = message.from?.id ? String(message.from.id) : null;
            const isShadowTakeoverInput = resolveTelegramShadowFlag(firstParsed, message.text);
            const takeoverWantsBoard = !firstParsed.isDeparture
                && !firstParsed.isContinuation
                && !isShadowTakeoverInput
                && Boolean(firstParsed.baseCode);
            if (takeoverWantsBoard && takeoverSenderId && firstParsed.baseCode) {
                const occupant = await findActiveSameTurnoBoardCarrierOnTarget({
                    sector: firstParsed.sector,
                    targetCode: firstParsed.baseCode,
                    eventAt,
                    excludeDoctorId: resolvedDoctor.id,
                });
                if (occupant) {
                    const incoming = {
                        sector: firstParsed.sector,
                        targetCode: firstParsed.baseCode,
                        arrivingDoctorId: resolvedDoctor.id,
                        occupantDoctorId: occupant.doctorId,
                    };
                    const pending = await findPendingTakeoverConfirmation(String(message.chat.id), takeoverSenderId);
                    const confirmed = Boolean(pending)
                        && isTakeoverPendingData(pending!.resolutionData)
                        && takeoverPendingMatches(pending!.resolutionData as TakeoverPendingData, incoming)
                        && isWithinTakeoverConfirmationWindow(pending!.createdAt, messageReferenceAt);

                    if (!confirmed) {
                        await markTelegramProcessed(log.id, {
                            status: "pending_takeover_confirmation",
                            parsedDomain: firstParsed.sector,
                            parsedTargetCode: firstParsed.baseCode,
                            parsedAction: resolveTelegramParsedAction(firstParsed),
                            parsedDoctorName: resolvedDoctor.fullName,
                            errorMessage: "takeover_confirmation_required",
                            resolutionData: {
                                kind: "takeover_confirmation",
                                sector: firstParsed.sector,
                                targetCode: firstParsed.baseCode,
                                arrivingDoctorId: resolvedDoctor.id,
                                occupantDoctorId: occupant.doctorId,
                                occupantOccupancyId: occupant.occupancyId,
                                arrivingMessageText: message.text,
                                senderTelegramId: takeoverSenderId,
                            } satisfies TakeoverPendingData,
                        });
                        await sendMessage(
                            message.chat.id,
                            buildTakeoverWarningReply({
                                occupantName: occupant.doctorName,
                                targetLabel: firstParsed.baseCode,
                                shiftLabel: occupant.shiftLabel,
                                sinceTime: formatTelegramReplyTime(occupant.startedAt),
                            }),
                            message.message_id,
                            buildTakeoverDecisionKeyboard(firstParsed.baseCode, log.id),
                            { parseMode: "Markdown" },
                        );
                        return { ok: true, ignored: true, pending: true };
                    }

                    // Confirmado: desloca o ocupante (board nulo, chegada preservada) ANTES
                    // de criar a chegada — assim o caminho normal não o fecha (guard de
                    // coexistência) e o que chega assume o board.
                    if (firstParsed.sector === "REGULATION") {
                        await displaceRegulationOccupant(occupant.occupancyId, {
                            displacedAt: eventAt,
                            takenByDoctorName: resolveTelegramDoctorSurfaceName(resolvedDoctor),
                        });
                    } else {
                        await displaceInterventionOccupant(occupant.occupancyId, {
                            displacedAt: eventAt,
                            takenByDoctorName: resolveTelegramDoctorSurfaceName(resolvedDoctor),
                        });
                    }
                    await markTelegramProcessed(pending!.id, {
                        status: "accepted",
                        errorMessage: "takeover_confirmed",
                    });
                    takeoverDisplaced = {
                        occupantName: occupant.doctorName,
                        targetLabel: firstParsed.baseCode,
                        sinceTime: formatTelegramReplyTime(occupant.startedAt),
                    };
                }
            }

            try {
                const applyResult = await applyParsedEntry({
                    parsed: firstParsed,
                    resolvedDoctor: { id: resolvedDoctor.id, fullName: resolvedDoctor.fullName, displayName: resolvedDoctor.displayName ?? null },
                    eventAt,
                    referenceAt: new Date(message.date * 1000),
                    messageText: message.text,
                });
                const { occupancyId, successKind, treatedAsContinuation, replyTimeAt, autoReactivated, effectiveShiftType, reassignedFrom, assumedHalfShift, continuationFrom, extendedLongShift, piamAutoAllocated, piamOriginalCode, displacedDoctorName, forwardContinuityPrompt } = applyResult;
                const alreadyPresent = (applyResult as { alreadyPresent?: PiamAlreadyPresentInfo | null }).alreadyPresent ?? null;

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

                if (alreadyPresent) {
                    // Re-announcement of a doctor already on shift: never opens a departure
                    // nor duplicates the occupancy — just a didactic reply pointing to the
                    // saída / remanejamento flows.
                    await sendPiamAlreadyPresentReply(
                        message.chat.id,
                        message.message_id,
                        resolveTelegramDoctorSurfaceName(resolvedDoctor),
                        alreadyPresent,
                    );
                    return { ok: true, occupancyId };
                }

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
                    piamAutoAllocated,
                    piamOriginalCode,
                    extendedLongShift,
                    displacedDoctorName,
                    messageReferenceAt,
                    firstParsed.arrivalTime,
                );
                await maybeSendContinuityForwardPrompt(message.chat.id, message.message_id, forwardContinuityPrompt);

                if (takeoverDisplaced) {
                    // Avisa o grupo que o ocupante ficou fora do quadro e precisa
                    // redeclarar posição (chegada preservada). Sai como REPLY da
                    // mensagem que confirmou a tomada, para dar contexto de quem
                    // assumiu (auditoria §3.1#4).
                    await sendMessage(
                        message.chat.id,
                        buildTakeoverDisplacedAnnouncement({
                            arrivingName: resolveTelegramDoctorSurfaceName(resolvedDoctor),
                            occupantName: takeoverDisplaced.occupantName,
                            targetLabel: takeoverDisplaced.targetLabel,
                            sinceTime: takeoverDisplaced.sinceTime,
                        }),
                        message.message_id,
                        undefined,
                        { parseMode: "Markdown" },
                    );
                }

                // A regra "chegada em intervenção depois das 9h vira meio plantão
                // 13–19 com carryover no banco" foi APOSENTADA (jul/2026). Chegar
                // atrasado num SD é atraso: a janela continua sendo a do turno
                // inteiro e o débito é do plantonista. Meia jornada agora só existe
                // quando declarada (janela 11:10–17:00) ou quando a chefia troca a
                // função no quadro — ver modules/operational/half-shift.ts.
                return { ok: true, occupancyId };
            } catch (error) {
                const errorMessage = error instanceof Error ? error.message : "telegram_processing_failed";
                if (shouldRouteToDepartureJustification(errorMessage, firstParsed)) {
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

                if (isTelegramPiamShiftRequiredError(errorMessage)) {
                    // Auditoria §3.1#12: a pergunta binária vira PENDÊNCIA com botões
                    // [☀️ SD] [🌙 SN]; "SD"/"SN" por texto (solto ou como reply)
                    // continua valendo via tryHandlePendingPiamShiftReply.
                    if (message.from?.id) {
                        await queuePendingPiamShift({
                            logId: log.id,
                            parsed: firstParsed,
                            resolvedDoctor: { id: resolvedDoctor.id, fullName: resolvedDoctor.fullName, displayName: resolvedDoctor.displayName ?? null },
                            senderTelegramId: String(message.from.id),
                            originalText: message.text,
                            referenceAt: new Date(message.date * 1000),
                            delivery: { via: "message", chatId: message.chat.id, replyToMessageId: message.message_id },
                        });
                        return { ok: true, ignored: true, pending: true };
                    }

                    await markTelegramProcessed(log.id, {
                        status: "ignored",
                        parsedDomain: firstParsed.sector,
                        parsedTargetCode: firstParsed.baseCode,
                        parsedAction: resolveTelegramParsedAction(firstParsed),
                        parsedDoctorName: resolvedDoctor.fullName,
                        errorMessage,
                    });
                    await sendMessage(
                        message.chat.id,
                        `🩺 ${resolveTelegramDoctorSurfaceName(resolvedDoctor)} esta marcado como PIAM. Me confirma o turno: responde *SD* (ou *dia*) para 07:00-19:00, *SN* (ou *noite*) para 19:00-07:00.`,
                        message.message_id,
                    );
                    return { ok: true, ignored: true };
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
                    senderTelegramId: message.from?.id ? String(message.from.id) : null,
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
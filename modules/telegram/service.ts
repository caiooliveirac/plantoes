import { and, desc, eq, inArray, isNull } from "drizzle-orm";
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
import { syncBankHoursByContinuityGroup } from "@/modules/bank-hours/service";
import { normalizeDoctorName } from "@/modules/doctors/importer";
import { createDoctorDirectoryEntry } from "@/modules/doctors/service";
import { continueInterventionOccupancy, endInterventionOccupancy, startInterventionOccupancy } from "@/modules/intervention/service";
import { requiresOvertimeJustification } from "@/modules/operational/board-rules";
import { correctInterventionOccupancy, correctRegulationOccupancy, removeInterventionOccupancyRecord, removeRegulationOccupancyRecord } from "@/modules/operational/corrections";
import { resolveTelegramEventTime } from "@/modules/operational/rules";
import { continueRegulationOccupancy, endRegulationOccupancy, startRegulationOccupancy } from "@/modules/regulation/service";
import {
    isTelegramDoctorAdminCommandText,
    parseTelegramDoctorAdminCommand,
    TELEGRAM_DOCTOR_ADMIN_COMMAND_USAGE,
} from "@/modules/telegram/admin-commands";
import {
    isTelegramShiftReportCommandText,
    parseTelegramShiftReportCommand,
} from "@/modules/telegram/shift-report-commands";
import {
    isTelegramDepartureReportCommandText,
    parseTelegramDepartureReportCommand,
    TELEGRAM_DEPARTURE_REPORT_USAGE,
} from "@/modules/telegram/departure-report-commands";
import {
    isTelegramPaymentAdminCommandText,
    parseTelegramPaymentAdminCommand,
    TELEGRAM_PAYMENT_CORRECTION_USAGE,
    TELEGRAM_PAYMENT_REPORT_USAGE,
} from "@/modules/telegram/payment-commands";
import { buildTelegramDepartureReport, resolveTelegramDepartureReportRequest } from "@/modules/telegram/departure-report";
import {
    buildMealBreakCommandUsageReply,
    buildMealBreakErrorReply,
    handleTelegramMealBreakReply,
    isTelegramMealBreakCommandText,
    parseTelegramMealBreakCommand,
    resolveMealBreakLogDetails,
    resolveTelegramMealBreakSenderId,
    runTelegramMealBreakCommand,
    sendTelegramMealBreakMessages,
} from "@/modules/telegram/meal-breaks";
import { buildTelegramShiftReport } from "@/modules/telegram/shift-report";
import { getTelegramAdminUserIds, getTelegramAnnouncementChatIds, getTelegramChiefUserIds, isTelegramChatAllowed, isTelegramPrivateControlUserId } from "@/modules/telegram/config";
import { parseTelegramCommand } from "@/modules/telegram/commands";
import { isCasualTelegramMessage, looksLikeDepartureMessage, parseMessageMulti, parseTelegramBatchLines, type ParsedMessage } from "@/modules/telegram/parser";
import type { TelegramUpdate } from "@/modules/telegram/api";
import { sendMessage } from "@/modules/telegram/api";
import { pickCandidateFromReply, pickConfidentDoctorCandidate, resolveDoctorCandidates, type TelegramDoctorCandidate, type TelegramDoctorDirectoryEntry } from "@/modules/telegram/name-resolution";
import { buildCandidatePromptReply, buildGroupCorrectionAnnouncement, buildNameUnresolvedReply, buildTelegramBatchApplyReply, buildTelegramBatchReviewReply, pickTelegramReply } from "@/modules/telegram/replies";
import { getOperationalBoard, getPaymentAllocationBoard, type PaymentAllocationBoard, type PaymentAllocationRow } from "@/services/board.service";

interface PendingNameResolutionData {
    parsed: {
        sector: "REGULATION" | "INTERVENTION";
        baseCode: string;
        arrivalTime: string | null;
        shiftType: "SD" | "SN" | "P" | null;
        roleFunction: string | null;
        isDeparture: boolean;
        isContinuation: boolean;
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
        isDeparture: boolean;
        isContinuation: boolean;
    };
    resolvedDoctor: { id: string; fullName: string };
    originalText: string;
    originalEventAt: string;
    originalReferenceAt?: string;
}

interface PendingBatchConfirmationEntry {
    lineNumber: number;
    rawLine: string;
    parsed: OperationalParsedEntry;
    resolvedDoctor: { id: string; fullName: string };
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
    resolvedDoctor: { id: string; fullName: string };
    eventAt: Date;
}

type OperationalParsedEntry = PendingNameResolutionData["parsed"];

interface TelegramOperationalContinuityOccupancy {
    domain: "regulation" | "intervention";
    occupancyId: string;
    continuityGroupId: string;
    doctorId: string;
    startedAt: Date;
    endedAt: Date | null;
    actualEndedAt: Date | null;
    shiftLabel: string | null;
}

const TELEGRAM_CONTINUITY_LINK_WINDOW_MS = 18 * 60 * 60 * 1000;

interface TelegramCommandActor {
    userId: string | null;
    roles: Array<"admin" | "chief">;
    senderName: string;
    senderTelegramId: string | null;
}

function normalizeBatchKeyword(text: string) {
    return normalizeDoctorName(text)
        .replace(/\s+/g, " ")
        .trim();
}

export function isBatchConfirmationKeyword(text: string) {
    const normalized = normalizeBatchKeyword(text);
    return normalized === "CONFIRMAR"
        || normalized === "CONFIRMAR SIM"
        || normalized === "CONFIRMO"
        || normalized === "CONFIRMADO"
        || normalized === "CONFIRMA"
        || normalized === "OK CONFIRMAR"
        || normalized === "OK PODE LANCAR"
        || normalized === "OK LANCAR"
        || normalized === "PODE LANCAR"
        || normalized === "LANCAR TUDO";
}

export function isBatchCancelKeyword(text: string) {
    const normalized = normalizeBatchKeyword(text);
    return normalized === "CANCELAR"
        || normalized === "CANCELA"
        || normalized === "DESCARTAR LOTE";
}

function canManageTelegramBatch(message: TelegramUpdate["message"]) {
    return message?.chat.type === "private" && isTelegramPrivateControlUserId(message.from?.id);
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
    return !parsed.isDeparture && parsed.sector === "INTERVENTION" && parsed.isContinuation;
}

function isTelegramContinuationIntent(parsed: OperationalParsedEntry) {
    return !parsed.isDeparture && (parsed.isContinuation || parsed.shiftType === "P");
}

export function shouldTreatTelegramArrivalAsContinuation(params: {
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
}) {
    if (params.parsed.isDeparture) {
        return params.successKind === "departure_adjusted" ? "departure_adjusted" : "departure_recorded";
    }

    if (params.forceContinuation || isTelegramContinuationEntry(params.parsed)) {
        return "continuation_recorded";
    }

    if (params.parsed.sector === "INTERVENTION" && params.parsed.shiftType === "P") {
        return "arrival_p_recorded";
    }

    return "arrival_recorded";
}

function appendTelegramOperationalNote(existingNotes: string | null | undefined, marker: string, messageText: string) {
    const nextEntry = `[${marker}] ${messageText}`;
    return [existingNotes?.trim(), nextEntry].filter(Boolean).join("\n");
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

export function requiresTelegramDepartureAdjustmentJustification(params: {
    startedAt: string | Date | null;
    endedAt: string | Date | null;
    eventAt: string | Date | null;
}) {
    if (!params.eventAt || !params.endedAt) {
        return false;
    }

    const eventTime = new Date(params.eventAt).getTime();
    const handoffTime = new Date(params.endedAt).getTime();
    if (eventTime <= handoffTime) {
        return false;
    }

    return requiresOvertimeJustification(params.startedAt, params.eventAt);
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
        .sort(compareTelegramContinuitySource);
    const recentClosed = eligible
        .filter((occupancy) => {
            const endedAt = resolveTelegramOperationalEndedAt(occupancy);
            return Boolean(
                endedAt
                && Math.abs(params.eventAt.getTime() - endedAt.getTime()) <= TELEGRAM_CONTINUITY_LINK_WINDOW_MS,
            );
        })
        .sort(compareTelegramContinuitySource);
    const source = activeOccupancies[0] ?? recentClosed[0] ?? null;
    const continuityStartedAt = source
        ? eligible
            .filter((occupancy) => occupancy.continuityGroupId === source.continuityGroupId)
            .sort((left, right) => left.startedAt.getTime() - right.startedAt.getTime())[0]?.startedAt ?? source.startedAt
        : null;

    return {
        source,
        continuityStartedAt,
        activeOccupancies,
    };
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

    for (const occupancy of activeOccupancies) {
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

    let kind: "departure_justification_required" | "departure_not_found" | "departure_time_conflict" | null = null;
    if (isTelegramJustificationRequiredError(params.errorMessage)) {
        kind = "departure_justification_required";
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

function isOperationalParsedEntry(entry: ParsedMessage): entry is ParsedMessage & OperationalParsedEntry {
    return Boolean(entry.baseCode && entry.sector);
}

async function resolveDoctorId(rawName: string) {
    const db = getDb();
    const normalizedName = normalizeDoctorName(rawName);
    if (!normalizedName) {
        return null;
    }

    const doctor = await db.query.doctors.findFirst({
        where: eq(doctors.normalizedName, normalizedName),
    });

    return doctor ?? null;
}

async function listDirectoryEntries() {
    const db = getDb();
    return db.select({
        id: doctors.id,
        fullName: doctors.fullName,
        displayName: doctors.displayName,
        normalizedName: doctors.normalizedName,
        isActive: doctors.isActive,
    }).from(doctors);
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

function isExactDoctorMatch(query: string | null, doctor: { fullName: string; displayName: string | null } | null) {
    if (!query || !doctor) {
        return false;
    }

    const normalizedQuery = normalizeDoctorName(query);
    if (!normalizedQuery) {
        return false;
    }

    return normalizedQuery === normalizeDoctorName(doctor.fullName)
        || normalizedQuery === normalizeDoctorName(doctor.displayName ?? "");
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
                isDeparture: parsed.isDeparture,
                isContinuation: parsed.isContinuation,
            },
            resolvedDoctor: {
                id: doctor.id,
                fullName: doctor.fullName,
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
        await sendMessage(message.chat.id, ":| Lote descartado. Quando quiser, pode colar uma nova escala para eu conferir de novo.", message.message_id);
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
        await sendMessage(message.chat.id, ":| Tenho um lote pronto para confirmar. Responda CONFIRMAR para gravar tudo ou CANCELAR para descartar.", message.message_id);
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

async function markTelegramTrainingCandidate(
    id: string,
    current: unknown,
    reason: string,
    details: Record<string, unknown> = {},
) {
    await markTelegramProcessed(id, {
        resolutionData: buildResolutionData(current, {
            trainingCandidate: true,
            trainingReason: reason,
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

async function loadDoctorFullName(doctorId: string) {
    const db = getDb();
    const doctor = await db.query.doctors.findFirst({ where: eq(doctors.id, doctorId) });
    return doctor?.fullName ?? "Medico nao identificado";
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

function doctorMatchesCommandQuery(query: string, doctor: { fullName: string; displayName: string | null }) {
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

    return queryTokens.every((token) => doctorTokens.has(token) || displayTokens.has(token));
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

async function resolveOperationalDoctor(params: {
    parsed: OperationalParsedEntry;
    doctorQuery: string | null;
    senderName: string | null;
}) {
    const active = params.parsed.baseCode ? await findActiveOccupancyByTarget(params.parsed) : null;
    const activeDoctorId = active?.occupancy?.doctorId;

    if (params.parsed.isDeparture) {
        return {
            ...(await resolveCommandDoctor({
                doctorQuery: params.doctorQuery,
                activeDoctorId,
            })),
            matchedBy: params.doctorQuery ? "command" as const : "none" as const,
            active,
        };
    }

    const lookupQuery = params.doctorQuery || params.senderName;
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

function buildDoctorDirectoryUsageReply() {
    return `:/ Para cadastrar um medico, use ${TELEGRAM_DOCTOR_ADMIN_COMMAND_USAGE}. Apelido e codigo sao opcionais; para informar so o codigo, mande /medico cadastrar Nome Completo | | crm-123.`;
}

function buildDoctorDirectorySummary(doctor: {
    fullName: string;
    displayName: string | null;
    externalCode: string | null;
}) {
    const details: string[] = [];

    if (doctor.displayName && normalizeDoctorName(doctor.displayName) !== normalizeDoctorName(doctor.fullName)) {
        details.push(`exibicao ${doctor.displayName}`);
    }

    if (doctor.externalCode) {
        details.push(`codigo ${doctor.externalCode}`);
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

async function sendTelegramReplyBatch(chatId: string | number, texts: string[], replyToMessageId?: number) {
    await sendTelegramMealBreakMessages({
        chatId,
        messages: texts,
        replyToMessageId,
    });
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

function buildPaymentAllocationReportLine(row: PaymentAllocationRow) {
    if (!row.occupancyId) {
        return `VAZ ${row.targetCode} - sem ocupacao`;
    }

    const name = row.displayName ?? row.doctorName ?? "medico nao identificado";
    if (row.paymentStatus === "ready_for_payment") {
        return `OK ${row.targetCode} - ${name}`;
    }

    return `REV ${row.targetCode} - ${name} | ${summarizePaymentAllocationIssues(row.issues)}`;
}

function buildPaymentAllocationReportReply(board: PaymentAllocationBoard) {
    const header = [
        `:) Conferencia de pagamento ${formatPaymentAllocationDateLabel(board.operationalDate)} ${board.shiftLabel}.`,
        `Prontos ${board.summary.readyForPaymentCount} | revisar ${board.summary.needsReviewCount} | vazios ${board.summary.unassignedCount}`,
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

        if (message.chat.type === "private" && !canManageTelegramBatch(message)) {
            await markTelegramProcessed(logId, {
                status: "ignored",
                errorMessage: "meal_break_private_forbidden",
                parsedAction: "meal_break_command",
                resolutionData: { rawCommand: message.text },
            });
            await sendMessage(message.chat.id, ":/ O teste privado do almoço fica restrito a admin ou chief autorizado no bot.", message.message_id);
            return { ok: true, ignored: true };
        }

        try {
            const result = await runTelegramMealBreakCommand({
                chatId: String(message.chat.id),
                referenceAt: new Date(message.date * 1000),
                trigger: "manual",
                forceRestart: mealBreakCommand.forceRestart,
                actorTelegramId: resolveTelegramMealBreakSenderId(update),
            });

            await markTelegramProcessed(logId, {
                status: "accepted",
                parsedAction: "meal_break_command",
                resolutionData: {
                    commandName: mealBreakCommand.name,
                    forceRestart: mealBreakCommand.forceRestart,
                    resultStatus: result.status,
                    ...resolveMealBreakLogDetails(result.session),
                },
            });
            await sendTelegramReplyBatch(message.chat.id, result.messages, message.message_id);
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
            const result = await createDoctorDirectoryEntry({
                fullName: doctorDirectoryCommand.fullName,
                displayName: doctorDirectoryCommand.displayName,
                externalCode: doctorDirectoryCommand.externalCode,
            }, {
                actorUserId: actor.userId,
                source: "telegram_command",
                details: {
                    telegramActorId: actor.senderTelegramId,
                    telegramActorName: actor.senderName,
                    telegramCommand: message.text,
                },
            });

            await markTelegramProcessed(logId, {
                status: "accepted",
                parsedAction: doctorDirectoryCommand.name,
                parsedDoctorName: result.doctor.fullName,
                resolutionData: {
                    actorRoles: actor.roles,
                    resultStatus: result.status,
                    externalCode: result.doctor.externalCode,
                    displayName: result.doctor.displayName,
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
                parsedAction: "doctor_create",
                resolutionData: { rawCommand: message.text },
            });
            await sendMessage(
                message.chat.id,
                `:/ Nao consegui cadastrar esse medico. ${error instanceof Error ? error.message : "Falha inesperada."}`,
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
                await sendMessage(message.chat.id, `:) ${doctor.fullName} ja estava alocado em ${targetRow.targetCode} para ${formatPaymentAllocationDateLabel(board.operationalDate)} ${board.shiftLabel}.`, message.message_id);
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
                `:) Corrigi ${targetRow.targetCode} para ${doctor.fullName} em ${formatPaymentAllocationDateLabel(board.operationalDate)} ${board.shiftLabel}. Agora ${describePaymentAllocationOutcome(refreshedRow)}.`,
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

    const command = parseTelegramCommand(message.text);
    if (!command) {
        if (message.text.trim().startsWith("/")) {
            await markTelegramProcessed(logId, {
                status: "ignored",
                errorMessage: "command_parse_failed",
                resolutionData: { trainingCandidate: true, trainingReason: "command_parse_failed", rawCommand: message.text },
            });
            await sendMessage(message.chat.id, pickTelegramReply("command_usage", message.message_id, {
                usage: "/corrigir PM04 20:00 | /corrigir PM04 Nome Completo 20:00 | /retirar PM04 19:00 | /remover PM04",
            }), message.message_id);
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

    const parsedEntry: OperationalParsedEntry = {
        sector: command.sector,
        baseCode: command.targetCode,
        arrivalTime: command.time,
        shiftType: null,
        roleFunction: null,
        isDeparture: command.isDeparture,
        isContinuation: false,
    };

    const active = await findActiveOccupancyByTarget(parsedEntry);
    if (!active.occupancy) {
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
            const updated = command.sector === "REGULATION"
                ? await correctRegulationOccupancy(active.occupancy.id, {
                    doctorId: doctor.id,
                    startedAt: eventAt,
                    boardStartedAt: eventAt,
                    notes: `${active.occupancy.notes ?? ""}\n[telegram /corrigir] ${message.text}`.trim(),
                }, resolveCommandAuditUserId(null))
                : await correctInterventionOccupancy(active.occupancy.id, {
                    doctorId: doctor.id,
                    startedAt: eventAt,
                    boardStartedAt: eventAt,
                    notes: `${active.occupancy.notes ?? ""}\n[telegram /corrigir] ${message.text}`.trim(),
                }, resolveCommandAuditUserId(null));

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

        if (
            command.sector === "INTERVENTION"
            && requiresOvertimeJustification(active.occupancy.startedAt, eventAt)
            && !hasTelegramOperationalJustification(message.text, [command.targetCode, command.doctorName, command.time])
        ) {
            await markTelegramProcessed(logId, {
                status: "ignored",
                errorMessage: "departure_justification_required",
                parsedDomain: command.sector,
                parsedTargetCode: command.targetCode,
                parsedAction: "departure",
            });
            await sendMessage(
                message.chat.id,
                ":| Depois de 07:15 ou 19:15 eu preciso da justificativa por escrito. Pode ser liberado pela chefia, ocorrencia 0729 ou atraso de quem veio render. Ex.: /saiu PP20 19:20 porque fui liberado pela chefia.",
                message.message_id,
            );
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
    const doctorName = await loadDoctorFullName(deleted.doctorId);

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

    try {
        const result = await handleTelegramMealBreakReply({
            chatId: String(message.chat.id),
            text: message.text,
            senderTelegramId: resolveTelegramMealBreakSenderId(update),
            referenceAt: new Date(message.date * 1000),
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
        await sendTelegramReplyBatch(message.chat.id, result.messages, message.message_id);
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

async function findPendingNameSelection(chatId: string, senderTelegramId: string) {
    const db = getDb();
    return db.query.telegramIngestedMessages.findFirst({
        where: and(
            eq(telegramIngestedMessages.chatId, chatId),
            eq(telegramIngestedMessages.senderTelegramId, senderTelegramId),
            eq(telegramIngestedMessages.status, "pending_name_selection"),
        ),
        orderBy: [desc(telegramIngestedMessages.createdAt)],
    });
}

async function findPendingDepartureJustification(chatId: string, senderTelegramId: string) {
    const db = getDb();
    return db.query.telegramIngestedMessages.findFirst({
        where: and(
            eq(telegramIngestedMessages.chatId, chatId),
            eq(telegramIngestedMessages.senderTelegramId, senderTelegramId),
            eq(telegramIngestedMessages.status, "pending_departure_justification"),
        ),
        orderBy: [desc(telegramIngestedMessages.createdAt)],
    });
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

async function queuePendingDepartureJustification(params: {
    logId: string;
    message: TelegramUpdate["message"];
    parsed: OperationalParsedEntry;
    resolvedDoctor: { id: string; fullName: string };
    eventAt: Date;
    referenceAt: Date;
    originalText: string;
}) {
    const senderTelegramId = params.message?.from?.id ? String(params.message.from.id) : null;
    if (senderTelegramId) {
        await supersedePendingDepartureJustification(String(params.message!.chat.id), senderTelegramId, "departure_justification_replaced");
    }

    await markTelegramProcessed(params.logId, {
        status: "pending_departure_justification",
        parsedDomain: params.parsed.sector,
        parsedTargetCode: params.parsed.baseCode,
        parsedAction: resolveTelegramParsedAction(params.parsed),
        parsedDoctorName: params.resolvedDoctor.fullName,
        errorMessage: "departure_justification_required",
        resolutionData: {
            parsed: {
                sector: params.parsed.sector,
                baseCode: params.parsed.baseCode,
                arrivalTime: params.parsed.arrivalTime,
                shiftType: params.parsed.shiftType,
                roleFunction: params.parsed.roleFunction,
                isDeparture: params.parsed.isDeparture,
                isContinuation: params.parsed.isContinuation,
            },
            resolvedDoctor: params.resolvedDoctor,
            originalText: params.originalText,
            originalEventAt: params.eventAt.toISOString(),
            originalReferenceAt: params.referenceAt.toISOString(),
        },
    });

    await sendMessage(
        params.message!.chat.id,
        pickTelegramReply("departure_justification_required", params.message!.message_id, {
            name: params.resolvedDoctor.fullName,
            target: params.parsed.baseCode ?? "plantao",
            time: params.parsed.arrivalTime ?? formatTelegramReplyTime(params.eventAt),
            example: buildTelegramDepartureExample({
                doctorName: params.resolvedDoctor.fullName,
                target: params.parsed.baseCode,
                time: params.parsed.arrivalTime ?? formatTelegramReplyTime(params.eventAt),
            }),
        }),
        params.message!.message_id,
    );
}

async function queuePendingNameSelection(
    logId: string,
    message: TelegramUpdate["message"],
    parsed: OperationalParsedEntry,
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
            parsed: {
                sector: parsed.sector,
                baseCode: parsed.baseCode,
                arrivalTime: parsed.arrivalTime,
                shiftType: parsed.shiftType,
                roleFunction: parsed.roleFunction,
                isDeparture: parsed.isDeparture,
                isContinuation: parsed.isContinuation,
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

    await sendMessage(
        message!.chat.id,
        `${buildCandidatePromptReply(message!.message_id, candidates)}\n\n${isTelegramContinuationIntent(parsed) ? "Se isso for continuidade, vou manter a chegada original e registrar apenas a confirmacao da passagem para o proximo plantao." : "Vou manter o horario da primeira mensagem."}`,
        message!.message_id,
    );
}

async function applyParsedEntry(params: {
    parsed: OperationalParsedEntry;
    resolvedDoctor: { id: string; fullName: string };
    eventAt: Date;
    referenceAt: Date;
    messageText: string;
}) {
    const db = getDb();
    const { parsed, resolvedDoctor, eventAt, referenceAt, messageText } = params;
    let occupancyId: string | null = null;
    let successKind: "standard" | "departure_adjusted" = "standard";
    let treatedAsContinuation = false;
    let replyTimeAt = eventAt;

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
            if (!occupancy) {
                throw new Error("No active regulation occupancy found for this doctor/post.");
            }

            occupancyId = (await endRegulationOccupancy(occupancy.id, {
                endedAt: eventAt,
                actualEndedAt: eventAt,
            })).id;
        } else {
            const activeOccupancy = await db.query.regulationOccupancies.findFirst({
                where: and(
                    eq(regulationOccupancies.postId, post.id),
                    eq(regulationOccupancies.doctorId, resolvedDoctor.id),
                    isNull(regulationOccupancies.endedAt),
                ),
                orderBy: [desc(regulationOccupancies.boardStartedAt), desc(regulationOccupancies.startedAt)],
            });

            const shouldContinueActiveOccupancy = Boolean(activeOccupancy) && shouldTreatTelegramArrivalAsContinuation({
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
            } else {
                const continuityContext = isTelegramContinuationIntent(parsed)
                    ? await findTelegramContinuityContext({ doctorId: resolvedDoctor.id, eventAt })
                    : null;

                if (continuityContext?.source) {
                    await closeTelegramActiveContinuityOccupancies({
                        doctorId: resolvedDoctor.id,
                        eventAt,
                        excludeOccupancyId: activeOccupancy?.id ?? null,
                    });
                }

                occupancyId = (await startRegulationOccupancy({
                    doctorId: resolvedDoctor.id,
                    postId: post.id,
                    continuityGroupId: continuityContext?.source?.continuityGroupId ?? null,
                    startedAt: eventAt,
                    shiftLabel: parsed.shiftType,
                    roleLabel: parsed.roleFunction,
                    ramalLabel: parsed.baseCode,
                    source: "telegram",
                    notes: messageText,
                    createdByUserId: null,
                })).id;

                if (continuityContext?.source) {
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
                if (
                    requiresOvertimeJustification(occupancy.startedAt, eventAt)
                    && !hasTelegramOperationalJustification(messageText, [parsed.baseCode, resolvedDoctor.fullName, parsed.arrivalTime])
                ) {
                    throw new Error("Justificativa obrigatoria para registrar saida apos 07:15 ou 19:15. Inclua motivo por escrito na mensagem.");
                }

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
                        startedAt: recentClosed.startedAt,
                        endedAt: recentClosed.endedAt,
                        eventAt,
                    })
                    && !hasTelegramOperationalJustification(messageText, [parsed.baseCode, resolvedDoctor.fullName, parsed.arrivalTime])
                ) {
                    throw new Error("Justificativa obrigatoria para ajustar saida apos 07:15/19:15. Inclua horario e motivo por escrito na mensagem.");
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

            const shouldContinueActiveOccupancy = Boolean(activeOccupancy) && shouldTreatTelegramArrivalAsContinuation({
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
            } else {
                const continuityContext = isTelegramContinuationIntent(parsed)
                    ? await findTelegramContinuityContext({ doctorId: resolvedDoctor.id, eventAt })
                    : null;

                if (continuityContext?.source) {
                    await closeTelegramActiveContinuityOccupancies({
                        doctorId: resolvedDoctor.id,
                        eventAt,
                        excludeOccupancyId: activeOccupancy?.id ?? null,
                    });
                }

                occupancyId = (await startInterventionOccupancy({
                    doctorId: resolvedDoctor.id,
                    baseId: base.id,
                    continuityGroupId: continuityContext?.source?.continuityGroupId ?? null,
                    startedAt: eventAt,
                    shiftLabel: parsed.shiftType,
                    roleLabel: parsed.roleFunction,
                    source: "telegram",
                    notes: messageText,
                    createdByUserId: null,
                })).id;

                if (continuityContext?.source) {
                    treatedAsContinuation = true;
                    replyTimeAt = continuityContext.continuityStartedAt ?? continuityContext.source.startedAt;
                    await syncBankHoursByContinuityGroup(db, continuityContext.source.continuityGroupId);
                }
            }
        }
    }

    return { occupancyId, successKind, treatedAsContinuation, replyTimeAt };
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
) {
    const time = (replyTimeAt ?? eventAt).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "America/Sao_Paulo" });
    const text = pickTelegramReply(
        resolveTelegramSuccessReplyKind({
            parsed,
            successKind,
            forceContinuation,
        }),
        seed,
        {
            name: doctorName,
            target: parsed.baseCode ?? "plantao",
            time,
        },
    );
    await sendMessage(chatId, `${text}${approximateMatchHint}`, replyToMessageId);
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
    const normalized = text
        .toUpperCase()
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, " ");

    let reduced = normalized.replace(/^\s*\/(?:CORRIGIR|RETIRAR|REMOVER|SAIU|SAINDO|SAIDA)\b/i, " ");
    for (const fragment of fragments) {
        if (!fragment) {
            continue;
        }

        const escaped = fragment
            .toUpperCase()
            .normalize("NFD")
            .replace(/[\u0300-\u036f]/g, " ")
            .replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        reduced = reduced.replace(new RegExp(escaped, "gi"), " ");
    }

    reduced = reduced
        .replace(/\b\d{1,2}[:.]\d{2}\b/g, " ")
        .replace(/\b\d{1,2}H(?:\d{2})?\b/g, " ")
        .replace(/\b(?:SD|SN|P|CHEGUEI|CHEGANDO|CHEGADA|PRESENTE|ASSUMINDO|ASSUMI|RENDENDO|RENDI|CONTINUO|CONTINUA|SEGUINDO|SIGO|SAINDO|SAIU|SAI|SAIDA|ENCERRANDO|ENCERREI|FINALIZANDO|FINALIZEI|LIBEREI|MOTIVO)\b/g, " ");

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
            resolvedDoctor: { id: selected.id, fullName: selected.fullName },
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
            selected.fullName,
            new Date(pending.resolutionData.originalEventAt),
            result.successKind,
            "",
            result.treatedAsContinuation,
            result.replyTimeAt,
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
                resolvedDoctor: { id: selected.id, fullName: selected.fullName },
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

    if (looksLikeDepartureMessage(message.text) && parseMessageMulti(message.text).some(isOperationalParsedEntry)) {
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
            pickTelegramReply("departure_justification_required", message.message_id, {
                name: pending.resolutionData.resolvedDoctor.fullName,
                target: pending.resolutionData.parsed.baseCode,
                time: pending.resolutionData.parsed.arrivalTime ?? formatTelegramReplyTime(new Date(pending.resolutionData.originalEventAt)),
                example: buildTelegramDepartureExample({
                    doctorName: pending.resolutionData.resolvedDoctor.fullName,
                    target: pending.resolutionData.parsed.baseCode,
                    time: pending.resolutionData.parsed.arrivalTime ?? formatTelegramReplyTime(new Date(pending.resolutionData.originalEventAt)),
                }),
            }),
            message.message_id,
        );
        return { ok: true, ignored: true, pending: true };
    }

    const mergedText = buildTelegramJustificationFollowUpText(
        pending.resolutionData.originalText,
        message.text,
    );

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
                pickTelegramReply("departure_justification_required", message.message_id, {
                    name: pending.resolutionData.resolvedDoctor.fullName,
                    target: pending.resolutionData.parsed.baseCode,
                    time: pending.resolutionData.parsed.arrivalTime ?? formatTelegramReplyTime(new Date(pending.resolutionData.originalEventAt)),
                    example: buildTelegramDepartureExample({
                        doctorName: pending.resolutionData.resolvedDoctor.fullName,
                        target: pending.resolutionData.parsed.baseCode,
                        time: pending.resolutionData.parsed.arrivalTime ?? formatTelegramReplyTime(new Date(pending.resolutionData.originalEventAt)),
                    }),
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

export async function processTelegramUpdate(update: TelegramUpdate) {
    const message = update.message;
    if (!message?.text) {
        return { ok: true, ignored: true };
    }

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
                                    doctorName: entry.resolvedDoctor.fullName,
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
                                doctorName: entry.resolvedDoctor.fullName,
                                targetCode: entry.parsed.baseCode,
                                timeLabel: entry.parsed.arrivalTime ?? "continua",
                                sector: entry.parsed.sector,
                                mode: isTelegramContinuationEntry(entry.parsed) ? "continuation" : "arrival",
                            })),
                            issues: [],
                        }),
                        message.message_id,
                    );
                    return { ok: true, ignored: true, pending: true };
                }
            }

            const parsedEntries = parseMessageMulti(message.text).filter(isOperationalParsedEntry);
            if (parsedEntries.length === 0) {
                if (isCasualTelegramMessage(message.text)) {
                    await markTelegramProcessed(log.id, {
                        status: "ignored",
                        errorMessage: "casual_smalltalk",
                        resolutionData: { casual: true },
                    });
                    await sendMessage(
                        message.chat.id,
                        pickTelegramReply("casual_smalltalk", message.message_id, {}),
                        message.message_id,
                    );
                    return { ok: true, ignored: true };
                }

                await markTelegramProcessed(log.id, {
                    status: "ignored",
                    errorMessage: "no_operational_match",
                    resolutionData: { trainingCandidate: true, trainingReason: "no_operational_match" },
                });
                if (looksLikeDepartureMessage(message.text)) {
                    await sendMessage(
                        message.chat.id,
                        pickTelegramReply("departure_missing_context", message.message_id, {
                            example: buildTelegramDepartureExample({}),
                        }),
                        message.message_id,
                    );
                }
                return { ok: true, ignored: true };
            }

            const firstParsed = parsedEntries[0];
            const senderName = [message.from?.first_name, message.from?.last_name].filter(Boolean).join(" ");
            const doctorQuery = firstParsed.extractedNames[0] ?? null;
            const { doctor: resolvedDoctor, candidates, matchedBy } = await resolveOperationalDoctor({
                parsed: firstParsed,
                doctorQuery,
                senderName,
            });
            if (!resolvedDoctor) {
                const eventAt = resolveTelegramEventTime(new Date(message.date * 1000), firstParsed.arrivalTime);
                if (candidates.length > 0) {
                    await queuePendingNameSelection(log.id, message, firstParsed, new Date(message.date * 1000), eventAt, candidates);
                    return { ok: true, ignored: true, pending: true };
                }

                await markTelegramProcessed(log.id, {
                    status: "ignored",
                    parsedDomain: firstParsed.sector,
                    parsedTargetCode: firstParsed.baseCode,
                    parsedAction: resolveTelegramParsedAction(firstParsed),
                    errorMessage: "doctor_not_resolved",
                    resolutionData: { trainingCandidate: true, trainingReason: "doctor_not_resolved", doctorQuery: doctorQuery || senderName },
                });
                await sendMessage(message.chat.id, buildNameUnresolvedReply(message.message_id, candidates), message.message_id);
                return { ok: true, ignored: true };
            }

            const eventAt = resolveTelegramEventTime(new Date(message.date * 1000), firstParsed.arrivalTime);

            try {
                const { occupancyId, successKind, treatedAsContinuation, replyTimeAt } = await applyParsedEntry({
                    parsed: firstParsed,
                    resolvedDoctor: { id: resolvedDoctor.id, fullName: resolvedDoctor.fullName },
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
                    resolvedDoctor.fullName,
                    eventAt,
                    successKind,
                    matchedBy === "candidate"
                        ? buildApproximateMatchHint({ doctorQuery, doctorName: resolvedDoctor.fullName })
                        : "",
                    treatedAsContinuation,
                    replyTimeAt,
                );

                return { ok: true, occupancyId };
            } catch (error) {
                const errorMessage = error instanceof Error ? error.message : "telegram_processing_failed";
                if (isTelegramJustificationRequiredError(errorMessage)) {
                    await queuePendingDepartureJustification({
                        logId: log.id,
                        message,
                        parsed: firstParsed,
                        resolvedDoctor: { id: resolvedDoctor.id, fullName: resolvedDoctor.fullName },
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
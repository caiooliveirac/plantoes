import { and, desc, eq, gte, inArray } from "drizzle-orm";
import { getDb } from "@/db";
import { doctors, telegramBotNotices, telegramIngestedMessages } from "@/db/schema";
import { formatDoctorSurfaceName } from "@/modules/doctors/directory";
import { isHalfShiftRoleLabel } from "@/modules/operational/half-shift";
import {
    getSaoPauloParts,
    hasPlannedInterventionCoverageForCurrentShift,
    resolveOperationalShiftWindow,
    shouldHighlightInterventionVerification,
} from "@/modules/operational/board-rules";
import { resolveForcedDayEventTime } from "@/modules/operational/rules";
import { endRegulationOccupancy } from "@/modules/regulation/service";
import { escapeTelegramMarkdown, sendMessage } from "@/modules/telegram/api";
import { getTelegramAdminUserIds, getTelegramAnnouncementChatIds, getTelegramChiefUserIds, getTelegramRegulationAlertUserIds, getTelegramReminderChatIds } from "@/modules/telegram/config";
import {
    getOperationalBoard,
    getPaymentAllocationBoard,
    type InterventionBoardRow,
    type PaymentAllocationBoard,
    type RegulationBoardRow,
} from "@/services/board.service";
import {
    sortTelegramInterventionCodes,
    sortTelegramInterventionRows,
    sortTelegramRegulationCodes,
    sortTelegramRegulationRows,
} from "@/modules/telegram/presentation-order";

export interface ReminderBoardSnapshot {
    generatedAt: string;
    regulation: RegulationBoardRow[];
    intervention: InterventionBoardRow[];
}

export interface ReminderPlan {
    noticeKey: string;
    stage: "instruction" | "coverage_snapshot" | "coverage_checkpoint" | "payment_checkpoint" | "payment_checkpoint_public" | "payment_conflict_alert" | "takeover_conflict_alert" | "regulation_confirmation" | "regulation_confirmation_private";
    text: string;
    payload: Record<string, unknown>;
    /**
     * Opt-in de formatação: o texto está pronto para Markdown v1 (interpolações
     * escapadas via escapeTelegramMarkdown). O envio degrada para texto puro se a
     * API rejeitar as entidades (fallback do sendMessage).
     */
    parseMode?: "Markdown";
}

/**
 * Resumo persistível das pendências de um snapshot de cobertura. Gravado no
 * payload jsonb do notice (telegramBotNotices) para o snapshot seguinte do mesmo
 * turno comparar e enviar só o delta (auditoria comunicação §3.3#1).
 */
export interface CoverageSnapshotPendingState {
    shiftStartedAt: string;
    bucketAt: string;
    awaitingInterventionCodes: string[];
    missingInterventionCodes: string[];
    disabledInterventionCodes: string[];
    missingRegulationCodes: string[];
}

export interface CoverageSnapshotDelta {
    changed: boolean;
    /** Códigos que eram pendência e saíram (sem terem virado base desativada). */
    resolvedCodes: string[];
    /** Códigos que viraram pendência desde o snapshot anterior. */
    addedCodes: string[];
}

interface ReminderPlanningParams {
    now: Date;
    board: ReminderBoardSnapshot;
    /** Estado do último snapshot enviado neste turno (null/ausente = 1º snapshot → quadro completo). */
    previousCoverageState?: CoverageSnapshotPendingState | null;
}

const TEN_MINUTES = 10 * 60 * 1000;
const ONE_HOUR = 60 * 60 * 1000;
const PAYMENT_CONFLICT_ALERT_BUCKET = 2 * ONE_HOUR;

function floorToBucket(date: Date, bucketMs: number) {
    return new Date(Math.floor(date.getTime() / bucketMs) * bucketMs);
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

function formatCheckpointLabel(hour: number) {
    return `${String(hour).padStart(2, "0")}:00`;
}

// Todos os balões deste módulo saem com parseMode Markdown: qualquer interpolação
// de dado externo (nome, código, motivo) passa por md()/formatReminderDoctorName.
function md(value: string) {
    return escapeTelegramMarkdown(value);
}

function formatReminderDoctorName(fullName: string | null, displayName: string | null) {
    return md(formatDoctorSurfaceName({ fullName, displayName, fallback: "médico ainda não identificado" }));
}

function renderSection(text: string, fallback: string) {
    return text.trim() ? text : fallback;
}

function uniqueChatIds(values: string[]) {
    return [...new Set(values.filter(Boolean))];
}

function resolveReminderChatIds() {
    const announcementChats = getTelegramAnnouncementChatIds();
    if (announcementChats.length > 0) {
        return uniqueChatIds(announcementChats);
    }

    return uniqueChatIds(getTelegramReminderChatIds());
}

interface PendingTakeoverConflict {
    id: string;
    createdAt: Date;
    chatId: string;
    sector: "REGULATION" | "INTERVENTION";
    targetCode: string;
    arrivingDoctorId: string;
    occupantDoctorId: string;
    arrivingDoctorName: string | null;
    occupantDoctorName: string | null;
}

function isTakeoverResolutionData(value: unknown): value is {
    kind: "takeover_confirmation";
    sector: "REGULATION" | "INTERVENTION";
    targetCode: string;
    arrivingDoctorId: string;
    occupantDoctorId: string;
} {
    if (!value || typeof value !== "object") return false;
    const data = value as Record<string, unknown>;
    return data.kind === "takeover_confirmation"
        && (data.sector === "REGULATION" || data.sector === "INTERVENTION")
        && typeof data.targetCode === "string"
        && typeof data.arrivingDoctorId === "string"
        && typeof data.occupantDoctorId === "string";
}

async function loadPendingTakeoverConflicts(referenceDate: Date): Promise<PendingTakeoverConflict[]> {
    const db = getDb();
    const lowerBound = new Date(referenceDate.getTime() - (35 * 60 * 1000));
    const rows = await db
        .select({
            id: telegramIngestedMessages.id,
            createdAt: telegramIngestedMessages.createdAt,
            chatId: telegramIngestedMessages.chatId,
            resolutionData: telegramIngestedMessages.resolutionData,
            parsedDoctorName: telegramIngestedMessages.parsedDoctorName,
        })
        .from(telegramIngestedMessages)
        .where(and(
            eq(telegramIngestedMessages.status, "pending_takeover_confirmation"),
            gte(telegramIngestedMessages.createdAt, lowerBound),
        ));

    const validRows = rows.filter((row) => isTakeoverResolutionData(row.resolutionData));
    const occupantDoctorIds = uniqueChatIds(validRows.map((row) => (
        isTakeoverResolutionData(row.resolutionData) ? row.resolutionData.occupantDoctorId : ""
    )));

    const occupantNameById = new Map<string, string>();
    if (occupantDoctorIds.length > 0) {
        const doctorRows = await db
            .select({ id: doctors.id, fullName: doctors.fullName })
            .from(doctors)
            .where(inArray(doctors.id, occupantDoctorIds));
        for (const doctorRow of doctorRows) {
            occupantNameById.set(doctorRow.id, doctorRow.fullName);
        }
    }

    const conflicts: PendingTakeoverConflict[] = [];
    for (const row of validRows) {
        if (!isTakeoverResolutionData(row.resolutionData)) {
            continue;
        }

        conflicts.push({
            id: row.id,
            createdAt: row.createdAt,
            chatId: row.chatId,
            sector: row.resolutionData.sector,
            targetCode: row.resolutionData.targetCode,
            arrivingDoctorId: row.resolutionData.arrivingDoctorId,
            occupantDoctorId: row.resolutionData.occupantDoctorId,
            arrivingDoctorName: row.parsedDoctorName ?? null,
            occupantDoctorName: occupantNameById.get(row.resolutionData.occupantDoctorId) ?? null,
        });
    }

    return conflicts;
}

/**
 * Alerta de tomada de ramal pendente — só no privado de chefes/admins
 * (auditoria §3.3#5): 1 linha por conflito com os dois nomes + minutos.
 */
export function buildTakeoverConflictPlan(params: {
    now: Date;
    conflict: Pick<PendingTakeoverConflict, "id" | "createdAt" | "chatId" | "sector" | "targetCode" | "arrivingDoctorName" | "occupantDoctorName">;
}): ReminderPlan {
    const bucket = floorToBucket(params.now, TEN_MINUTES);
    const elapsedMinutes = Math.max(0, Math.floor((params.now.getTime() - params.conflict.createdAt.getTime()) / 60000));
    const domainLabel = params.conflict.sector === "REGULATION" ? "Regulação" : "Intervenção";
    const arrivingName = md(params.conflict.arrivingDoctorName?.trim() || "médico chegando");
    const occupantName = md(params.conflict.occupantDoctorName?.trim() || "ocupante atual");
    const code = params.conflict.targetCode;

    return {
        noticeKey: `takeover-conflict:${params.conflict.id}:${bucket.toISOString()}`,
        stage: "takeover_conflict_alert",
        parseMode: "Markdown",
        payload: {
            conflictId: params.conflict.id,
            bucketAt: bucket.toISOString(),
            chatId: params.conflict.chatId,
            sector: params.conflict.sector,
            targetCode: code,
            elapsedMinutes,
        },
        text: [
            `⚠️ Tomada pendente em ${domainLabel} *${md(code)}*: *${arrivingName}* × *${occupantName}* há *${elapsedMinutes} min*.`,
            `Quem assume confirma no grupo: ${codeSpan(`confirmo ${code}`)} — ou ajuste em /admin/payment-attestation/audit.`,
        ].join("\n"),
    };
}

/**
 * Roteia cada plano para os chats certos (auditoria §3.3#2/#3/#5):
 * - payment_checkpoint (íntegra) → só privado dos admins;
 * - payment_checkpoint_public (resumo 12:00) → grupo;
 * - conflitos (pagamento/tomada) → só privado de admins + chefes;
 * - regulation_confirmation_private → só privado da chefia;
 * - demais planos → chats de lembrete (grupo).
 */
export function resolveReminderRecipientsForPlan(params: {
    plan: ReminderPlan;
    reminderChatIds: string[];
    adminChatIds: string[];
    chiefPrivateAlertRecipients: string[];
}) {
    switch (params.plan.stage) {
        case "payment_checkpoint":
            return uniqueChatIds(params.adminChatIds);
        case "payment_conflict_alert":
        case "takeover_conflict_alert":
            return uniqueChatIds([...params.adminChatIds, ...params.chiefPrivateAlertRecipients]);
        case "regulation_confirmation_private":
            return uniqueChatIds(params.chiefPrivateAlertRecipients);
        default:
            return uniqueChatIds(params.reminderChatIds);
    }
}

function isInterventionAwaitingNews(row: InterventionBoardRow, reference: Date) {
    const currentShiftLabel = resolveOperationalShiftWindow(reference).shiftLabel;

    if (row.shiftLabel === currentShiftLabel) {
        return false;
    }

    const hasPlannedCoverage = hasPlannedInterventionCoverageForCurrentShift({
        shiftLabel: row.shiftLabel,
        scheduledEndAt: row.scheduledEndAt,
        reference,
    });

    return row.status === "active"
        && !hasPlannedCoverage
        && shouldHighlightInterventionVerification(row.boardStartedAt ?? row.startedAt, reference, row.shiftLabel);
}

function describeInterventionAwaitingNews(row: InterventionBoardRow, currentShiftLabel: string) {
    const name = formatReminderDoctorName(row.doctorName, row.displayName);
    const lastShiftLabel = row.shiftLabel ?? "?";
    const since = row.startedAt ? ` ${formatHour(row.startedAt)}` : "";
    return `${name} (${lastShiftLabel}${since}) | sem confirmação p/ ${currentShiftLabel}`;
}

function summarizeCoverage(board: ReminderBoardSnapshot, reference: Date) {
    const confirmedIntervention = sortTelegramInterventionRows(board.intervention.filter((row) => row.status === "active" && !isInterventionAwaitingNews(row, reference)));
    const awaitingIntervention = sortTelegramInterventionRows(board.intervention.filter((row) => row.status === "active" && isInterventionAwaitingNews(row, reference)));
    const missingIntervention = sortTelegramInterventionRows(board.intervention.filter((row) => row.status === "waiting"));
    const disabledIntervention = sortTelegramInterventionRows(board.intervention.filter((row) => row.status === "disabled"));
    const confirmedRegulation = sortTelegramRegulationRows(board.regulation.filter((row) => row.status === "active"));
    const missingRegulation = sortTelegramRegulationRows(board.regulation.filter((row) => row.status === "waiting"));

    return {
        confirmedIntervention,
        awaitingIntervention,
        missingIntervention,
        disabledIntervention,
        confirmedRegulation,
        missingRegulation,
        unresolvedCount: awaitingIntervention.length + missingIntervention.length + missingRegulation.length,
    };
}

type CoverageSummary = ReturnType<typeof summarizeCoverage>;

function buildInterventionLine(row: InterventionBoardRow, reference: Date, options: { includeArrival?: boolean; currentShiftLabel?: string } = {}) {
    const name = formatReminderDoctorName(row.doctorName, row.displayName);
    const arrival = options.includeArrival && row.startedAt ? ` | ${formatHour(row.startedAt)}` : "";

    if (row.status === "disabled") {
        const disabledAt = row.disabledAt ? ` às ${formatHour(row.disabledAt)}` : "";
        const reason = row.disabledReason?.trim() ? ` | ${md(row.disabledReason.trim())}` : "";
        return `⚫ ${md(row.baseCode)} - Desativada${disabledAt}${reason}`;
    }

    if (row.status === "waiting") {
        return `🔴 ${md(row.baseCode)} - Aguardando avançada`;
    }

    if (isInterventionAwaitingNews(row, reference)) {
        const shiftLabel = options.currentShiftLabel ?? resolveOperationalShiftWindow(reference).shiftLabel;
        return `🟡 ${md(row.baseCode)} - ${describeInterventionAwaitingNews(row, shiftLabel)}`;
    }

    return `✅ ${md(row.baseCode)} - ${name}${arrival}`;
}

function buildRegulationLine(row: RegulationBoardRow, includeArrival = false) {
    const name = formatReminderDoctorName(row.doctorName, row.displayName);
    const arrival = includeArrival && row.startedAt ? ` | ${formatHour(row.startedAt)}` : "";

    if (row.status === "waiting") {
        return `🔴 ${md(row.postCode)} - Aguardando ramal`;
    }

    return `✅ ${md(row.postCode)} - ${name}${arrival}`;
}

function buildInterventionSection(rows: InterventionBoardRow[], reference: Date, options: { includeArrival?: boolean; currentShiftLabel?: string } = {}) {
    return sortTelegramInterventionRows(rows).map((row) => buildInterventionLine(row, reference, options)).join("\n");
}

function buildRegulationSection(rows: RegulationBoardRow[], includeArrival = false) {
    return sortTelegramRegulationRows(rows).map((row) => buildRegulationLine(row, includeArrival)).join("\n");
}

function joinPendingCodes(values: string[]) {
    return values.map(md).join(", ");
}

function joinAlertCodes(values: string[]) {
    const escaped = values.map(md);
    if (escaped.length <= 1) {
        return escaped.join("");
    }

    if (escaped.length === 2) {
        return escaped.join(" e ");
    }

    return `${escaped.slice(0, -1).join(", ")} e ${escaped[escaped.length - 1]}`;
}

/**
 * Trecho copiável em Markdown v1. Dentro de crases o Telegram não processa
 * escapes, então removemos a própria crase do conteúdo em vez de escapá-la.
 */
function codeSpan(value: string) {
    return `\`${value.replace(/[`\n]/g, " ").trim()}\``;
}

function buildArrivalExampleLines(shiftLabel: string, arrivalHour: string) {
    return [
        `Chegada: ${codeSpan(`Vagner Costa 1363 ${shiftLabel} ${arrivalHour}`)}`,
        `Continuação: ${codeSpan(`Vagner Costa 1363 continuando ${shiftLabel}`)}`,
    ];
}

function normalizeOperationalCode(value: string) {
    return value.trim().toUpperCase();
}

function isChiefRegulationCode(code: string) {
    return normalizeOperationalCode(code) === "2031";
}

function isNucleoRegulationCode(code: string) {
    return normalizeOperationalCode(code) === "NUCLEO";
}

function isPiamRegulationCode(code: string) {
    return normalizeOperationalCode(code) === "PIAM";
}

function resolveRegulationConfirmationMetrics(params: ReminderPlanningParams) {
    const parts = getSaoPauloParts(params.now);
    const slot = resolveRegulationConfirmationSlot(parts);
    if (!slot) {
        return null;
    }

    const confirmedRegulation = sortTelegramRegulationRows(params.board.regulation.filter((row) => row.status === "active"));
    const nonChiefRegulationCount = confirmedRegulation.filter((row) => {
        const normalizedCode = normalizeOperationalCode(row.postCode);
        return !isChiefRegulationCode(normalizedCode) && !isNucleoRegulationCode(normalizedCode) && !isPiamRegulationCode(normalizedCode);
    }).length;

    const activeIntervention = sortTelegramInterventionRows(params.board.intervention.filter((row) => row.status === "active"));
    const waitingInterventionCodes = sortTelegramInterventionCodes(
        params.board.intervention
            .filter((row) => row.status === "waiting")
            .map((row) => row.baseCode),
    );
    const waitingRegulationCodes = sortTelegramRegulationCodes(
        params.board.regulation
            .filter((row) => row.status === "waiting")
            .map((row) => row.postCode),
    );
    const disabledInterventionCodes = sortTelegramInterventionCodes(
        params.board.intervention
            .filter((row) => row.status === "disabled")
            .map((row) => row.baseCode),
    );
    const dateLabel = `${parts.year}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;

    return {
        slot,
        dateLabel,
        nonChiefRegulationCount,
        activeUsaCount: activeIntervention.length,
        waitingUsaCount: waitingInterventionCodes.length,
        waitingInterventionCodes,
        waitingRegulationCodes,
        disabledInterventionCodes,
    };
}

function buildGroupedPendingLines(params: {
    awaitingIntervention: InterventionBoardRow[];
    missingIntervention: InterventionBoardRow[];
    disabledIntervention: InterventionBoardRow[];
    missingRegulation: RegulationBoardRow[];
}) {
    const lines: string[] = [];

    if (params.awaitingIntervention.length > 0) {
        lines.push(
            `🔴 Intervenção sem confirmação (${params.awaitingIntervention.length}): ${joinPendingCodes(sortTelegramInterventionCodes(params.awaitingIntervention.map((row) => row.baseCode)))}`,
        );
    }

    if (params.missingIntervention.length > 0) {
        lines.push(
            `🚑 Avançadas sem aviso (${params.missingIntervention.length}): ${joinPendingCodes(sortTelegramInterventionCodes(params.missingIntervention.map((row) => row.baseCode)))}`,
        );
    }

    if (params.disabledIntervention.length > 0) {
        lines.push(
            `⚫ Bases desativadas (${params.disabledIntervention.length}): ${joinPendingCodes(sortTelegramInterventionCodes(params.disabledIntervention.map((row) => row.baseCode)))}`,
        );
    }

    if (params.missingRegulation.length > 0) {
        lines.push(
            `☎️ Ramais sem aviso (${params.missingRegulation.length}): ${joinPendingCodes(sortTelegramRegulationCodes(params.missingRegulation.map((row) => row.postCode)))}`,
        );
    }

    return lines;
}

function resolveCoverageFooter(params: {
    now: Date;
    unresolvedCount: number;
    missingRegulationCount: number;
}) {
    if (params.unresolvedCount === 0) {
        return "✅ Cobertura fechada.";
    }

    const elapsedMs = params.now.getTime() - resolveOperationalShiftWindow(params.now).startedAt.getTime();
    if (elapsedMs < 20 * 60 * 1000) {
        return params.missingRegulationCount > 0
            ? "⚠️ Regulação: avisem ramal e turno. TARM precisa dos ramais."
            : "⚠️ Quem continuou: avisem continua/P para confirmar posição.";
    }

    if (elapsedMs < 40 * 60 * 1000) {
        return params.missingRegulationCount > 0
            ? "⚠️ TARM segue sem todos os ramais. Regulação: avisem agora."
            : "⚠️ Posições sem continua/P seguem sem médico confirmado. Avisem agora.";
    }

    return params.missingRegulationCount > 0
        ? "⚠️ Sem ramal informado não fecho cobertura nem folha. Regulação: avisem agora."
        : "⚠️ Sem continua/P ou ajuste da chefia, posição fica sem médico na cobertura e folha.";
}

function buildPreShiftInstructionPlan(now: Date): ReminderPlan | null {
    const window = resolveOperationalShiftWindow(now);
    const nextBoundaryAt = window.nextBoundaryAt;
    const deltaMs = nextBoundaryAt.getTime() - now.getTime();
    if (deltaMs <= 0 || deltaMs > TEN_MINUTES) {
        return null;
    }

    const nextShiftLabel = getSaoPauloParts(nextBoundaryAt).hour === 7 ? "SD" : "SN";
    const boundaryHour = formatHour(nextBoundaryAt);

    return {
        noticeKey: `instruction:${nextBoundaryAt.toISOString()}`,
        stage: "instruction",
        parseMode: "Markdown",
        payload: {
            boundaryAt: nextBoundaryAt.toISOString(),
            shiftLabel: nextShiftLabel,
        },
        text: [
            `⏰ Plantão ${nextShiftLabel} abre às ${boundaryHour}.`,
            "Avisem nome completo + ramal ou base + turno (SD, SN ou P).",
            ...buildArrivalExampleLines(nextShiftLabel, boundaryHour),
            "Sem aviso, a posição fica sem médico no quadro.",
        ].join("\n"),
    };
}

function buildCoverageSnapshotPendingState(params: {
    shiftStartedAt: Date;
    bucketAt: Date;
    coverage: CoverageSummary;
}): CoverageSnapshotPendingState {
    return {
        shiftStartedAt: params.shiftStartedAt.toISOString(),
        bucketAt: params.bucketAt.toISOString(),
        awaitingInterventionCodes: sortTelegramInterventionCodes(params.coverage.awaitingIntervention.map((row) => row.baseCode)),
        missingInterventionCodes: sortTelegramInterventionCodes(params.coverage.missingIntervention.map((row) => row.baseCode)),
        disabledInterventionCodes: sortTelegramInterventionCodes(params.coverage.disabledIntervention.map((row) => row.baseCode)),
        missingRegulationCodes: sortTelegramRegulationCodes(params.coverage.missingRegulation.map((row) => row.postCode)),
    };
}

function isStringArray(value: unknown): value is string[] {
    return Array.isArray(value) && value.every((item) => typeof item === "string");
}

export function isCoverageSnapshotPendingState(value: unknown): value is CoverageSnapshotPendingState {
    if (!value || typeof value !== "object") {
        return false;
    }

    const data = value as Record<string, unknown>;
    return typeof data.shiftStartedAt === "string"
        && typeof data.bucketAt === "string"
        && isStringArray(data.awaitingInterventionCodes)
        && isStringArray(data.missingInterventionCodes)
        && isStringArray(data.disabledInterventionCodes)
        && isStringArray(data.missingRegulationCodes);
}

// Entradas rotuladas por categoria: mudança de categoria (ex.: sem aviso → desativada)
// conta como mudança de estado, mas não vira "resolvida" no texto.
function toLabeledPendingEntries(state: CoverageSnapshotPendingState) {
    return [
        ...state.awaitingInterventionCodes.map((code) => `awaiting-int:${code}`),
        ...state.missingInterventionCodes.map((code) => `missing-int:${code}`),
        ...state.missingRegulationCodes.map((code) => `missing-reg:${code}`),
        ...state.disabledInterventionCodes.map((code) => `disabled-int:${code}`),
    ];
}

function pendingOnlyCodes(state: CoverageSnapshotPendingState) {
    return new Set([
        ...state.awaitingInterventionCodes,
        ...state.missingInterventionCodes,
        ...state.missingRegulationCodes,
    ]);
}

/**
 * Delta puro entre dois estados de pendência de cobertura (helper testável).
 * `changed` compara as entradas rotuladas por categoria; `resolvedCodes`/`addedCodes`
 * olham só as pendências reais (herança + sem aviso), ignorando desativadas.
 */
export function diffCoverageSnapshotStates(
    previous: CoverageSnapshotPendingState,
    current: CoverageSnapshotPendingState,
): CoverageSnapshotDelta {
    const previousLabels = new Set(toLabeledPendingEntries(previous));
    const currentLabels = new Set(toLabeledPendingEntries(current));
    const changed = previousLabels.size !== currentLabels.size
        || [...previousLabels].some((label) => !currentLabels.has(label));

    const previousPending = pendingOnlyCodes(previous);
    const currentPending = pendingOnlyCodes(current);
    const currentDisabled = new Set(current.disabledInterventionCodes);

    const resolvedCodes = [...previousPending]
        .filter((code) => !currentPending.has(code) && !currentDisabled.has(code));
    const addedCodes = [...currentPending]
        .filter((code) => !previousPending.has(code));

    return { changed, resolvedCodes, addedCodes };
}

function buildCoverageSnapshotPlan(params: ReminderPlanningParams): ReminderPlan | null {
    const shiftWindow = resolveOperationalShiftWindow(params.now);
    const bucket = floorToBucket(params.now, TEN_MINUTES);
    if (bucket.getTime() < shiftWindow.startedAt.getTime() || bucket.getTime() >= shiftWindow.startedAt.getTime() + ONE_HOUR) {
        return null;
    }

    const coverage = summarizeCoverage(params.board, params.now);
    const coverageState = buildCoverageSnapshotPendingState({
        shiftStartedAt: shiftWindow.startedAt,
        bucketAt: bucket,
        coverage,
    });
    const previousState = params.previousCoverageState && params.previousCoverageState.shiftStartedAt === coverageState.shiftStartedAt
        ? params.previousCoverageState
        : null;

    const footer = resolveCoverageFooter({
        now: params.now,
        unresolvedCount: coverage.unresolvedCount,
        missingRegulationCount: coverage.missingRegulation.length,
    });
    const exampleLines = coverage.unresolvedCount > 0
        ? buildArrivalExampleLines(shiftWindow.shiftLabel, formatHour(shiftWindow.startedAt))
        : [];

    const basePayload = {
        bucketAt: bucket.toISOString(),
        shiftLabel: shiftWindow.shiftLabel,
        confirmedInterventionCount: coverage.confirmedIntervention.length,
        confirmedRegulationCount: coverage.confirmedRegulation.length,
        unresolvedCount: coverage.unresolvedCount,
        coverageState: coverageState as unknown as Record<string, unknown>,
    };

    // Do 2º snapshot do turno em diante, só o delta de pendências — e se nada
    // mudou desde o último snapshot enviado, não manda nada (§3.3#1).
    if (previousState) {
        const delta = diffCoverageSnapshotStates(previousState, coverageState);
        if (!delta.changed) {
            return null;
        }

        const pendingLines = buildGroupedPendingLines({
            awaitingIntervention: coverage.awaitingIntervention,
            missingIntervention: coverage.missingIntervention,
            disabledIntervention: coverage.disabledIntervention,
            missingRegulation: coverage.missingRegulation,
        });

        return {
            noticeKey: `coverage:${bucket.toISOString()}`,
            stage: "coverage_snapshot",
            parseMode: "Markdown",
            payload: { ...basePayload, mode: "delta" },
            text: [
                `📋 *Quadro ${shiftWindow.shiftLabel} ${formatHour(bucket)}* — o que mudou desde ${formatHour(previousState.bucketAt)}:`,
                ...(delta.resolvedCodes.length > 0 ? [`✅ Resolvidas: ${joinPendingCodes(delta.resolvedCodes)}`] : []),
                ...(delta.addedCodes.length > 0 ? [`⚠️ Novas pendências: ${joinPendingCodes(delta.addedCodes)}`] : []),
                ...pendingLines,
                footer,
                ...exampleLines,
            ].join("\n"),
        };
    }

    const interventionOperationalTotal = params.board.intervention.length - coverage.disabledIntervention.length;
    const hasAwaitingNews = coverage.awaitingIntervention.length > 0;
    const regulationLines = [
        renderSection(buildRegulationSection(coverage.confirmedRegulation, true), "- Nenhum ramal confirmado até aqui"),
        coverage.missingRegulation.length > 0
            ? `Sem aviso (${coverage.missingRegulation.length}): ${joinPendingCodes(sortTelegramRegulationCodes(coverage.missingRegulation.map((row) => row.postCode)))}`
            : null,
    ].filter((line): line is string => Boolean(line));

    return {
        noticeKey: `coverage:${bucket.toISOString()}`,
        stage: "coverage_snapshot",
        parseMode: "Markdown",
        payload: { ...basePayload, mode: "full" },
        text: [
            `📋 *Quadro ${shiftWindow.shiftLabel} ${formatHour(bucket)}* | Intervenção *${coverage.confirmedIntervention.length}/${interventionOperationalTotal}* | Regulação *${coverage.confirmedRegulation.length}/${params.board.regulation.length}*`,
            "",
            "🚑 Intervenção:",
            buildInterventionSection(params.board.intervention, params.now, { includeArrival: true, currentShiftLabel: shiftWindow.shiftLabel }),
            "",
            "☎️ Regulação:",
            regulationLines.join("\n"),
            "",
            footer,
            ...(hasAwaitingNews ? ["🟡 = turno anterior sem confirmar continua/P"] : []),
            ...exampleLines,
        ].join("\n"),
    };
}

/**
 * Fechamento das 08:00/20:00 — fundido com o snapshot (auditoria §3.3#4):
 * pendências primeiro, confirmados como contagem, lista completa no /plantao.
 */
function buildCoverageCheckpointPlan(params: ReminderPlanningParams): ReminderPlan | null {
    const parts = getSaoPauloParts(params.now);
    if (!((parts.hour === 8 || parts.hour === 20) && parts.minute < 10)) {
        return null;
    }

    const checkpointLabel = formatCheckpointLabel(parts.hour);
    const shiftLabel = resolveOperationalShiftWindow(params.now).shiftLabel;
    const coverage = summarizeCoverage(params.board, params.now);
    const pendingLines = buildGroupedPendingLines({
        awaitingIntervention: coverage.awaitingIntervention,
        missingIntervention: coverage.missingIntervention,
        disabledIntervention: coverage.disabledIntervention,
        missingRegulation: coverage.missingRegulation,
    });
    const confirmedSummary = `Confirmados: 🚑 *${coverage.confirmedIntervention.length}* avançadas · ☎️ *${coverage.confirmedRegulation.length}* ramais — lista completa no /plantao.`;

    return {
        noticeKey: `checkpoint:${parts.year}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}T${checkpointLabel}`,
        stage: "coverage_checkpoint",
        parseMode: "Markdown",
        payload: {
            checkpointLabel,
            confirmedInterventionCount: coverage.confirmedIntervention.length,
            confirmedRegulationCount: coverage.confirmedRegulation.length,
            pendingCount: pendingLines.length,
        },
        text: [
            `📋 *Fechamento ${checkpointLabel}* (${shiftLabel}).`,
            ...(pendingLines.length > 0
                ? [
                    "🟠 Pendências ainda abertas:",
                    pendingLines.join("\n"),
                    "⚠️ Quem não avisou base ou ramal, informe agora para fechar a cobertura.",
                    ...buildArrivalExampleLines(shiftLabel, formatHour(resolveOperationalShiftWindow(params.now).startedAt)),
                ]
                : ["✅ Cobertura confirmada neste fechamento."]),
            confirmedSummary,
        ].join("\n"),
    };
}

/**
 * Íntegra do registro de pagamento (00:00/12:00) — só no privado dos admins
 * (auditoria §3.3#2). O grupo recebe no máximo o resumo das 12:00
 * (buildPaymentCheckpointPublicPlan).
 */
function buildPaymentCheckpointPlan(params: ReminderPlanningParams): ReminderPlan | null {
    const parts = getSaoPauloParts(params.now);
    if (!((parts.hour === 0 || parts.hour === 12) && parts.minute < 10)) {
        return null;
    }

    const checkpointLabel = formatCheckpointLabel(parts.hour);
    const shiftLabel = resolveOperationalShiftWindow(params.now).shiftLabel;
    const coverage = summarizeCoverage(params.board, params.now);
    const confirmedIntervention = coverage.confirmedIntervention.map((row) => `- ${md(row.baseCode)} - *${formatReminderDoctorName(row.doctorName, row.displayName)}* | chegada ${formatHour(row.startedAt)} | ${row.shiftLabel ?? shiftLabel}`);
    const confirmedRegulation = coverage.confirmedRegulation.map((row) => `- ${md(row.postCode)} - *${formatReminderDoctorName(row.doctorName, row.displayName)}* | chegada ${formatHour(row.startedAt)} | ${row.shiftLabel ?? shiftLabel}`);
    const pendingLines = buildGroupedPendingLines({
        awaitingIntervention: coverage.awaitingIntervention,
        missingIntervention: coverage.missingIntervention,
        disabledIntervention: coverage.disabledIntervention,
        missingRegulation: coverage.missingRegulation,
    });

    return {
        noticeKey: `payment:${parts.year}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}T${checkpointLabel}`,
        stage: "payment_checkpoint",
        parseMode: "Markdown",
        payload: {
            checkpointLabel,
            confirmedInterventionCount: confirmedIntervention.length,
            confirmedRegulationCount: confirmedRegulation.length,
            pendingCount: pendingLines.length,
        },
        text: [
            `💰 Registro ${checkpointLabel} para pagamento e banco de horas (${shiftLabel}).`,
            "",
            "🚑 Intervenção confirmada:",
            confirmedIntervention.length > 0 ? confirmedIntervention.join("\n") : "- Nenhuma avançada confirmada neste recorte",
            "",
            "☎️ Regulação confirmada:",
            confirmedRegulation.length > 0 ? confirmedRegulation.join("\n") : "- Nenhum ramal confirmado neste recorte",
            ...(pendingLines.length > 0
                ? ["", "🟠 Pendências que exigem conferência:", pendingLines.join("\n")]
                : []),
        ].join("\n"),
    };
}

/**
 * Resumo público das 12:00: só sai se houver pendência, ≤160 chars, com um
 * exemplo copiável (auditoria §3.3#2). Às 00:00 o grupo não recebe nada.
 */
function buildPaymentCheckpointPublicPlan(params: ReminderPlanningParams): ReminderPlan | null {
    const parts = getSaoPauloParts(params.now);
    if (!(parts.hour === 12 && parts.minute < 10)) {
        return null;
    }

    const coverage = summarizeCoverage(params.board, params.now);
    const pendingCodes = [
        ...sortTelegramRegulationCodes(coverage.missingRegulation.map((row) => row.postCode)),
        ...sortTelegramInterventionCodes(coverage.awaitingIntervention.map((row) => row.baseCode)),
        ...sortTelegramInterventionCodes(coverage.missingIntervention.map((row) => row.baseCode)),
    ];

    if (pendingCodes.length === 0) {
        return null;
    }

    const shiftWindow = resolveOperationalShiftWindow(params.now);
    const shownCodes = pendingCodes.slice(0, 4);
    const remainder = pendingCodes.length - shownCodes.length;
    const pendingLabel = pendingCodes.length === 1 ? "pendência" : "pendências";
    const dateLabel = `${parts.year}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;

    return {
        noticeKey: `payment-public:${dateLabel}T12:00`,
        stage: "payment_checkpoint_public",
        parseMode: "Markdown",
        payload: {
            checkpointLabel: "12:00",
            pendingCount: pendingCodes.length,
        },
        text: [
            `💰 12:00: *${pendingCodes.length}* ${pendingLabel} p/ pagamento: ${joinPendingCodes(shownCodes)}${remainder > 0 ? ` +${remainder}` : ""}.`,
            `Regularize: ${codeSpan(`Vagner Costa 1363 ${shiftWindow.shiftLabel} ${formatHour(shiftWindow.startedAt)}`)}`,
        ].join("\n"),
    };
}

function resolveRegulationConfirmationSlot(parts: ReturnType<typeof getSaoPauloParts>) {
    if (parts.hour === 11 && parts.minute < 10) {
        return "11:00";
    }

    if (parts.hour === 13 && parts.minute < 10) {
        return "13:00";
    }

    if (parts.hour === 15 && parts.minute < 10) {
        return "15:00";
    }

    if (parts.hour === 21 && parts.minute >= 30 && parts.minute < 40) {
        return "21:30";
    }

    if (parts.hour === 22 && parts.minute < 10) {
        return "22:00";
    }

    if (parts.hour === 22 && parts.minute >= 30 && parts.minute < 40) {
        return "22:30";
    }

    return null;
}

/**
 * Checagem da Regulação no grupo (auditoria §3.3#7): só quando falta gente,
 * 1 linha de status + 1 ação. Contagens e regra interna foram para o privado
 * da chefia (buildChiefPrivateRegulationAlertPlan).
 */
function buildRegulationConfirmationPlan(params: ReminderPlanningParams): ReminderPlan | null {
    const metrics = resolveRegulationConfirmationMetrics(params);
    if (!metrics) {
        return null;
    }

    const missingParts: string[] = [];
    if (metrics.waitingRegulationCodes.length > 0) {
        missingParts.push(`ramais ${joinPendingCodes(metrics.waitingRegulationCodes)}`);
    }

    if (metrics.waitingInterventionCodes.length > 0) {
        missingParts.push(`USAs ${joinPendingCodes(metrics.waitingInterventionCodes)}`);
    }

    if (missingParts.length === 0) {
        return null;
    }

    const shiftLabel = resolveOperationalShiftWindow(params.now).shiftLabel;
    const exampleCode = metrics.waitingRegulationCodes[0] ?? metrics.waitingInterventionCodes[0] ?? "1363";

    return {
        noticeKey: `reg-confirm:${metrics.dateLabel}T${metrics.slot}`,
        stage: "regulation_confirmation",
        parseMode: "Markdown",
        payload: {
            checkpointLabel: metrics.slot,
            nonChiefRegulationCount: metrics.nonChiefRegulationCount,
            activeUsaCount: metrics.activeUsaCount,
            waitingUsaCount: metrics.waitingUsaCount,
        },
        text: [
            `☎️ Checagem ${metrics.slot}: sem médico em ${missingParts.join(" e ")}.`,
            `Se você está aí, avise agora: ${codeSpan(`Vagner Costa ${exampleCode} ${shiftLabel} ${metrics.slot}`)}`,
        ].join("\n"),
    };
}

/**
 * Variante privada da checagem (chefia): contagens, regra interna e piso.
 * Gatilho de headcount é ≤8 → o texto fala do mínimo de 9 (auditoria §3.3#7).
 */
export function buildChiefPrivateRegulationAlertPlan(params: ReminderPlanningParams): ReminderPlan | null {
    const metrics = resolveRegulationConfirmationMetrics(params);
    if (!metrics) {
        return null;
    }

    const hasLowRegulationHeadcount = metrics.nonChiefRegulationCount <= 8;
    const hasMissingCoverage = metrics.waitingInterventionCodes.length > 0 || metrics.waitingRegulationCodes.length > 0;

    if (!hasMissingCoverage && !hasLowRegulationHeadcount) {
        return null;
    }

    const shiftLabel = resolveOperationalShiftWindow(params.now).shiftLabel;
    const lines: string[] = [`☎️ Checagem interna ${metrics.slot} (${shiftLabel})`];
    if (metrics.waitingInterventionCodes.length > 0) {
        lines.push(`⚠️ USAs sem médico p/ pagamento: ${joinAlertCodes(metrics.waitingInterventionCodes)}.`);
    }

    if (metrics.waitingRegulationCodes.length > 0) {
        lines.push(`⚠️ Ramais sem médico na regulação: ${joinAlertCodes(metrics.waitingRegulationCodes)}.`);
    }

    if (hasLowRegulationHeadcount) {
        lines.push(`👥 Só *${metrics.nonChiefRegulationCount}* reguladores logados além da chefia — o mínimo é *9*. Confere?`);
    }

    lines.push("ℹ️ Não conto 2031, NUCLEO nem PIAM na contagem.");
    lines.push("Se faltou gente, cobre no grupo: nome completo + ramal + turno.");

    return {
        noticeKey: `reg-confirm-private:${metrics.dateLabel}T${metrics.slot}`,
        stage: "regulation_confirmation_private",
        parseMode: "Markdown",
        payload: {
            checkpointLabel: metrics.slot,
            nonChiefRegulationCount: metrics.nonChiefRegulationCount,
            waitingInterventionCodes: metrics.waitingInterventionCodes,
            waitingRegulationCodes: metrics.waitingRegulationCodes,
            hasLowRegulationHeadcount,
        },
        text: lines.join("\n"),
    };
}

function resolveChiefPrivateAlertRecipients() {
    const explicitRecipients = uniqueChatIds(getTelegramRegulationAlertUserIds());
    if (explicitRecipients.length > 0) {
        return explicitRecipients;
    }

    return uniqueChatIds(getTelegramChiefUserIds());
}

export function buildReminderPlans(params: ReminderPlanningParams) {
    return [
        buildPreShiftInstructionPlan(params.now),
        buildCoverageSnapshotPlan(params),
        buildCoverageCheckpointPlan(params),
        buildPaymentCheckpointPlan(params),
        buildPaymentCheckpointPublicPlan(params),
        buildRegulationConfirmationPlan(params),
    ].filter((plan): plan is ReminderPlan => Boolean(plan));
}

/**
 * Conflito de alocação para pagamento — só no privado de admins/chefes
 * (auditoria §3.3#3): 1 linha por conflito com os nomes em disputa.
 */
function buildPaymentConflictAlertPlan(params: {
    now: Date;
    paymentBoard: PaymentAllocationBoard;
}): ReminderPlan | null {
    const bucket = floorToBucket(params.now, PAYMENT_CONFLICT_ALERT_BUCKET);
    const conflictRows = [...params.paymentBoard.regulation, ...params.paymentBoard.intervention]
        .filter((row) => row.hasDoctorOverlapConflict);

    if (conflictRows.length === 0) {
        return null;
    }

    const lines = conflictRows
        .slice(0, 12)
        .map((row) => {
            const domainIcon = row.domain === "regulation" ? "☎️" : "🚑";
            const pair = row.conflictCandidateLabels.length > 0
                ? row.conflictCandidateLabels.map((label) => `*${md(label)}*`).join(" × ")
                : `*${md(row.doctorName?.trim() || "sem escolhido")}* × candidato não detalhado`;
            return `- ${domainIcon} ${md(row.targetCode)} ${row.shiftLabel}: ${pair}`;
        });

    const operationalDate = params.paymentBoard.operationalDate.slice(0, 10);
    return {
        noticeKey: `payment-conflict:${operationalDate}:${params.paymentBoard.shiftLabel}:${bucket.toISOString()}`,
        stage: "payment_conflict_alert",
        parseMode: "Markdown",
        payload: {
            bucketAt: bucket.toISOString(),
            operationalDate,
            shiftLabel: params.paymentBoard.shiftLabel,
            conflictCount: conflictRows.length,
        },
        text: [
            `⚠️ Conflito de alocação p/ pagamento (${params.paymentBoard.shiftLabel} ${formatHour(bucket)}): entrada por cima de outro titular no mesmo alvo/turno.`,
            ...lines,
            ...(conflictRows.length > lines.length ? [`- ... e mais ${conflictRows.length - lines.length} conflito(s)`] : []),
            "🔎 Revise em /admin/payment-attestation/audit ou no modal do fechamento.",
        ].join("\n"),
    };
}

async function markNoticeSent(plan: ReminderPlan, chatId: string) {
    const db = getDb();
    const [inserted] = await db.insert(telegramBotNotices)
        .values({
            noticeKey: `${chatId}:${plan.noticeKey}`,
            chatId,
            stage: plan.stage,
            payload: plan.payload,
        })
        .onConflictDoNothing()
        .returning();

    return inserted ?? null;
}

async function rollbackNotice(chatId: string, plan: ReminderPlan) {
    const db = getDb();
    await db.delete(telegramBotNotices).where(eq(telegramBotNotices.noticeKey, `${chatId}:${plan.noticeKey}`));
}

/**
 * Estado do último snapshot de cobertura ENVIADO no turno atual (persistido no
 * payload do notice). Null quando o turno ainda não teve snapshot (→ quadro completo).
 */
async function loadPreviousCoverageSnapshotState(referenceDate: Date): Promise<CoverageSnapshotPendingState | null> {
    const shiftWindow = resolveOperationalShiftWindow(referenceDate);
    const db = getDb();
    const rows = await db
        .select({ payload: telegramBotNotices.payload })
        .from(telegramBotNotices)
        .where(and(
            eq(telegramBotNotices.stage, "coverage_snapshot"),
            gte(telegramBotNotices.createdAt, shiftWindow.startedAt),
        ))
        .orderBy(desc(telegramBotNotices.createdAt))
        .limit(1);

    const payload = rows[0]?.payload;
    const state = payload && typeof payload === "object"
        ? (payload as Record<string, unknown>).coverageState
        : null;

    if (!isCoverageSnapshotPendingState(state) || state.shiftStartedAt !== shiftWindow.startedAt.toISOString()) {
        return null;
    }

    return state;
}

async function deliverReminderPlan(plan: ReminderPlan, recipients: string[]) {
    let sent = 0;
    for (const chatId of recipients) {
        const inserted = await markNoticeSent(plan, chatId);
        if (!inserted) {
            continue;
        }

        try {
            await sendMessage(chatId, plan.text, undefined, undefined, plan.parseMode ? { parseMode: plan.parseMode } : undefined);
            sent += 1;
        } catch (error) {
            await rollbackNotice(chatId, plan);
            console.error(`telegram reminder failed for ${chatId} ${plan.noticeKey}`, error);
        }
    }

    return sent;
}

export async function sendTelegramReminderCycle(referenceDate = new Date()) {
    const reminderChatIds = resolveReminderChatIds();
    const adminChatIds = uniqueChatIds(getTelegramAdminUserIds());
    const chiefPrivateAlertRecipients = resolveChiefPrivateAlertRecipients();

    if ((reminderChatIds.length === 0 && chiefPrivateAlertRecipients.length === 0) || !process.env.TELEGRAM_BOT_TOKEN?.trim()) {
        return { sent: 0, evaluated: 0 };
    }

    let board = await getOperationalBoard();
    const halfShiftAutoCheckoutSent = await runHalfShiftAutoCheckout(referenceDate, board);
    if (halfShiftAutoCheckoutSent > 0) {
        board = await getOperationalBoard();
    }

    let previousCoverageState: CoverageSnapshotPendingState | null = null;
    try {
        previousCoverageState = await loadPreviousCoverageSnapshotState(referenceDate);
    } catch (error) {
        console.error("telegram coverage snapshot state load failed", error);
    }

    const plans = buildReminderPlans({
        now: referenceDate,
        board,
        previousCoverageState,
    });

    const chiefPrivateAlertPlan = buildChiefPrivateRegulationAlertPlan({
        now: referenceDate,
        board,
    });

    if (chiefPrivateAlertPlan) {
        plans.push(chiefPrivateAlertPlan);
    }

    let sent = 0;
    let evaluated = 0;

    for (const plan of plans) {
        const recipients = resolveReminderRecipientsForPlan({
            plan,
            reminderChatIds,
            adminChatIds,
            chiefPrivateAlertRecipients,
        });

        evaluated += recipients.length;
        sent += await deliverReminderPlan(plan, recipients);
    }

    try {
        const pendingTakeovers = await loadPendingTakeoverConflicts(referenceDate);
        for (const conflict of pendingTakeovers) {
            const plan = buildTakeoverConflictPlan({ now: referenceDate, conflict });
            const recipients = resolveReminderRecipientsForPlan({
                plan,
                reminderChatIds,
                adminChatIds,
                chiefPrivateAlertRecipients,
            });

            evaluated += recipients.length;
            sent += await deliverReminderPlan(plan, recipients);
        }
    } catch (error) {
        console.error("telegram takeover conflict alerts failed", error);
    }

    try {
        const paymentBoard = await getPaymentAllocationBoard({
            reference: referenceDate,
            expireDeactivations: false,
        });
        const paymentConflictPlan = buildPaymentConflictAlertPlan({ now: referenceDate, paymentBoard });
        if (paymentConflictPlan) {
            const recipients = resolveReminderRecipientsForPlan({
                plan: paymentConflictPlan,
                reminderChatIds,
                adminChatIds,
                chiefPrivateAlertRecipients,
            });

            evaluated += recipients.length;
            sent += await deliverReminderPlan(paymentConflictPlan, recipients);
        }
    } catch (error) {
        console.error("telegram payment conflict alert failed", error);
    }

    return { sent: sent + halfShiftAutoCheckoutSent, evaluated };
}

function formatHalfShiftAutoCheckoutText(params: {
    doctorName: string | null;
    displayName: string | null;
    targetCode: string;
    endedAt: Date;
}) {
    const name = formatReminderDoctorName(params.doctorName, params.displayName);
    return `⏰ *Meio plantão encerrado:* *${name}* saiu de *${md(params.targetCode)}* às *${formatHour(params.endedAt)}* (automático). Já registrei para pagamento como MEIO.`;
}

async function runHalfShiftAutoCheckout(referenceDate: Date, board: ReminderBoardSnapshot) {
    const chatIds = resolveReminderChatIds();
    if (chatIds.length === 0) {
        return 0;
    }

    const sentAt = 17 * 60;
    const nowParts = getSaoPauloParts(referenceDate);
    const nowMinutes = nowParts.hour * 60 + nowParts.minute;
    if (nowMinutes < sentAt) {
        return 0;
    }

    // Meio plantao SEMPRE encerra as 17:00 — é a regra que define o tipo.
    // Não confiamos em row.scheduledEndAt aqui porque continuações/re-arrivals
    // podem reescrever o fim para 19:15/05:00 mantendo a roleLabel MEIO_PLANTAO,
    // o que esconderia a ocupação da auto-checkout. Já gateamos em nowMinutes >= 17:00,
    // então qualquer half-shift ativa neste ponto deve sair.
    const dueRows = board.regulation.filter((row) => {
        return row.status === "active"
            && Boolean(row.occupancyId)
            && isHalfShiftRoleLabel(row.roleLabel);
    });

    if (dueRows.length === 0) {
        return 0;
    }

    const halfShiftEndAt = resolveForcedDayEventTime(referenceDate, "17:00", 0);

    let sent = 0;
    for (const row of dueRows) {
        const scheduledEndAt = row.scheduledEndAt ? new Date(row.scheduledEndAt) : null;
        const endedAt = scheduledEndAt && scheduledEndAt.getTime() < halfShiftEndAt.getTime()
            ? scheduledEndAt
            : halfShiftEndAt;

        try {
            // Half-shift auto-checkout: system-initiated at the scheduled
            // boundary, not a verbalized late departure.
            await endRegulationOccupancy(row.occupancyId as string, {
                endedAt,
                actualEndedAt: endedAt,
                chiefConfirmed: true,
            });
        } catch (error) {
            console.error("telegram half-shift auto checkout failed", row.occupancyId, error);
            continue;
        }

        const text = formatHalfShiftAutoCheckoutText({
            doctorName: row.doctorName,
            displayName: row.displayName,
            targetCode: row.postCode,
            endedAt,
        });

        const results = await Promise.allSettled(chatIds.map((chatId) => sendMessage(chatId, text, undefined, undefined, { parseMode: "Markdown" })));
        for (const result of results) {
            if (result.status === "fulfilled") {
                sent += 1;
            } else {
                console.error("telegram half-shift auto checkout broadcast failed", row.occupancyId, result.reason);
            }
        }
    }

    return sent;
}

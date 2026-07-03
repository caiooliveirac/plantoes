import { and, eq, gte } from "drizzle-orm";
import { getDb } from "@/db";
import { telegramBotNotices, telegramIngestedMessages } from "@/db/schema";
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
import { sendMessage } from "@/modules/telegram/api";
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
    stage: "instruction" | "coverage_snapshot" | "coverage_checkpoint" | "payment_checkpoint" | "payment_conflict_alert" | "takeover_conflict_alert" | "regulation_confirmation" | "regulation_confirmation_private";
    text: string;
    payload: Record<string, unknown>;
}

interface ReminderPlanningParams {
    now: Date;
    board: ReminderBoardSnapshot;
}

const TEN_MINUTES = 10 * 60 * 1000;
const TWENTY_MINUTES = 20 * 60 * 1000;
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

function formatReminderDoctorName(fullName: string | null, displayName: string | null) {
    return formatDoctorSurfaceName({ fullName, displayName, fallback: "medico ainda nao identificado" });
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

function isNoonPaymentCheckpoint(plan: ReminderPlan) {
    return plan.stage === "payment_checkpoint" && plan.noticeKey.endsWith("T12:00");
}

interface PendingTakeoverConflict {
    id: string;
    createdAt: Date;
    chatId: string;
    sector: "REGULATION" | "INTERVENTION";
    targetCode: string;
    arrivingDoctorId: string;
    occupantDoctorId: string;
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
        })
        .from(telegramIngestedMessages)
        .where(and(
            eq(telegramIngestedMessages.status, "pending_takeover_confirmation"),
            gte(telegramIngestedMessages.createdAt, lowerBound),
        ));

    const conflicts: PendingTakeoverConflict[] = [];
    for (const row of rows) {
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
        });
    }

    return conflicts;
}

function buildTakeoverConflictPlan(params: {
    now: Date;
    conflict: PendingTakeoverConflict;
}): ReminderPlan {
    const bucket = floorToBucket(params.now, TEN_MINUTES);
    const elapsedMinutes = Math.max(0, Math.floor((params.now.getTime() - params.conflict.createdAt.getTime()) / 60000));
    const domainLabel = params.conflict.sector === "REGULATION" ? "Regulação" : "Intervenção";

    return {
        noticeKey: `takeover-conflict:${params.conflict.id}:${bucket.toISOString()}`,
        stage: "takeover_conflict_alert",
        payload: {
            conflictId: params.conflict.id,
            bucketAt: bucket.toISOString(),
            chatId: params.conflict.chatId,
            sector: params.conflict.sector,
            targetCode: params.conflict.targetCode,
            elapsedMinutes,
        },
        text: [
            `🚨 Conflito de chegada em ${domainLabel} ${params.conflict.targetCode} ainda pendente (${elapsedMinutes} min).`,
            "",
            "Há uma tomada de posição aguardando confirmação e o pagamento pode ficar inconsistente se ninguém resolver.",
            "",
            `Confirme no grupo com: confirmo ${params.conflict.targetCode}`,
            "ou ajuste manualmente em /admin/payment-attestation/audit.",
        ].join("\n"),
    };
}

export function resolveReminderRecipientsForPlan(params: {
    plan: ReminderPlan;
    reminderChatIds: string[];
    adminChatIds: string[];
    chiefPrivateAlertRecipients: string[];
}) {
    if (!isNoonPaymentCheckpoint(params.plan)) {
        return uniqueChatIds(params.reminderChatIds);
    }

    return uniqueChatIds([...params.reminderChatIds, ...params.adminChatIds]);
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

function buildInterventionLine(row: InterventionBoardRow, reference: Date, options: { includeArrival?: boolean; currentShiftLabel?: string } = {}) {
    const name = formatReminderDoctorName(row.doctorName, row.displayName);
    const arrival = options.includeArrival && row.startedAt ? ` | ${formatHour(row.startedAt)}` : "";

    if (row.status === "disabled") {
        const disabledAt = row.disabledAt ? ` às ${formatHour(row.disabledAt)}` : "";
        const reason = row.disabledReason?.trim() ? ` | ${row.disabledReason.trim()}` : "";
        return `⚫ ${row.baseCode} - Desativada${disabledAt}${reason}`;
    }

    if (row.status === "waiting") {
        return `🔴 ${row.baseCode} - Aguardando avançada`;
    }

    if (isInterventionAwaitingNews(row, reference)) {
        const shiftLabel = options.currentShiftLabel ?? resolveOperationalShiftWindow(reference).shiftLabel;
        return `🟡 ${row.baseCode} - ${describeInterventionAwaitingNews(row, shiftLabel)}`;
    }

    return `✅ ${row.baseCode} - ${name}${arrival}`;
}

function buildRegulationLine(row: RegulationBoardRow, includeArrival = false) {
    const name = formatReminderDoctorName(row.doctorName, row.displayName);
    const arrival = includeArrival && row.startedAt ? ` | ${formatHour(row.startedAt)}` : "";

    if (row.status === "waiting") {
        return `🔴 ${row.postCode} - Aguardando ramal`;
    }

    return `✅ ${row.postCode} - ${name}${arrival}`;
}

function buildInterventionSection(rows: InterventionBoardRow[], reference: Date, options: { includeArrival?: boolean; currentShiftLabel?: string } = {}) {
    return sortTelegramInterventionRows(rows).map((row) => buildInterventionLine(row, reference, options)).join("\n");
}

function buildRegulationSection(rows: RegulationBoardRow[], includeArrival = false) {
    return sortTelegramRegulationRows(rows).map((row) => buildRegulationLine(row, includeArrival)).join("\n");
}

function joinPendingCodes(values: string[]) {
    return values.join(", ");
}

function joinAlertCodes(values: string[]) {
    if (values.length <= 1) {
        return values.join("");
    }

    if (values.length === 2) {
        return values.join(" e ");
    }

    return `${values.slice(0, -1).join(", ")} e ${values[values.length - 1]}`;
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
            ? "🫶 Regulação: avisem ramal e turno. TARM precisa dos ramais."
            : "🫶 Quem continuou: avisem continua/P para confirmar posição.";
    }

    if (elapsedMs < 40 * 60 * 1000) {
        return params.missingRegulationCount > 0
            ? "⚠️ TARM segue sem todos os ramais. Regulação: avisem agora."
            : "⚠️ Posições sem continua/P seguem sem médico confirmado. Avisem agora.";
    }

    return params.missingRegulationCount > 0
        ? "🚨 Sem ramal informado não fecho cobertura nem folha. Regulação: avisem agora."
        : "🚨 Sem continua/P ou ajuste da chefia, posição fica sem médico na cobertura e folha.";
}

function pickInstructionExamples(nextShiftLabel: "SD" | "SN") {
    if (nextShiftLabel === "SD") {
        return {
            intervention: "Felipe Carvalho PM04 SD 07:00",
            regulation: "Luana Bordoni 2031 SD 07:00",
            continuation: "Karla Pinto BR05 continua P 07:00",
        };
    }

    return {
        intervention: "Felipe Carvalho PM04 SN 19:00",
        regulation: "Luana Bordoni 2031 SN 19:00",
        continuation: "Karla Pinto BR05 continua P 19:00",
    };
}

function buildPreShiftInstructionPlan(now: Date): ReminderPlan | null {
    const window = resolveOperationalShiftWindow(now);
    const nextBoundaryAt = window.nextBoundaryAt;
    const deltaMs = nextBoundaryAt.getTime() - now.getTime();
    if (deltaMs <= 0 || deltaMs > TEN_MINUTES) {
        return null;
    }

    const nextShiftLabel = getSaoPauloParts(nextBoundaryAt).hour === 7 ? "SD" : "SN";
    const examples = pickInstructionExamples(nextShiftLabel);

    return {
        noticeKey: `instruction:${nextBoundaryAt.toISOString()}`,
        stage: "instruction",
        payload: {
            boundaryAt: nextBoundaryAt.toISOString(),
            shiftLabel: nextShiftLabel,
        },
        text: [
            `🧭 Plantão ${nextShiftLabel} abrindo por volta de ${formatHour(nextBoundaryAt)}.`,
            "",
            "Para eu preencher certo no sistema, por favor sempre avisem nome completo, base ou ramal e SD, SN ou P.",
            "",
            "Exemplos:",
            `- Intervenção: ${examples.intervention}`,
            `- Regulação: ${examples.regulation}`,
            `- Se continuar: ${examples.continuation}`,
            "",
            "Se a pessoa segue no posto, escrevam continua. Se assumiu agora, escrevam SD, SN ou P na mesma linha.",
            "Sem aviso de continua/P ou ajuste da chefia, a posição fica como sem medico confirmado no grupo.",
        ].join("\n"),
    };
}

function buildCoverageSnapshotPlan(params: ReminderPlanningParams): ReminderPlan | null {
    const shiftWindow = resolveOperationalShiftWindow(params.now);
    const bucket = floorToBucket(params.now, TEN_MINUTES);
    if (bucket.getTime() < shiftWindow.startedAt.getTime() || bucket.getTime() >= shiftWindow.startedAt.getTime() + ONE_HOUR) {
        return null;
    }

    const coverage = summarizeCoverage(params.board, params.now);
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
        payload: {
            bucketAt: bucket.toISOString(),
            shiftLabel: shiftWindow.shiftLabel,
            confirmedInterventionCount: coverage.confirmedIntervention.length,
            confirmedRegulationCount: coverage.confirmedRegulation.length,
            unresolvedCount: coverage.unresolvedCount,
        },
        text: [
            `🧭 Quadro ${shiftWindow.shiftLabel} ${formatHour(bucket)} | Intervenção ${coverage.confirmedIntervention.length}/${interventionOperationalTotal} | Regulação ${coverage.confirmedRegulation.length}/${params.board.regulation.length}`,
            "",
            "🚑 Intervenção:",
            buildInterventionSection(params.board.intervention, params.now, { includeArrival: true, currentShiftLabel: shiftWindow.shiftLabel }),
            "",
            "☎️ Regulação:",
            regulationLines.join("\n"),
            "",
            resolveCoverageFooter({
                now: params.now,
                unresolvedCount: coverage.unresolvedCount,
                missingRegulationCount: coverage.missingRegulation.length,
            }),
            ...(hasAwaitingNews ? ["🟡 = turno anterior sem confirmar continua/P"] : []),
        ].join("\n"),
    };
}

function buildCoverageCheckpointPlan(params: ReminderPlanningParams): ReminderPlan | null {
    const parts = getSaoPauloParts(params.now);
    if (!((parts.hour === 8 || parts.hour === 20) && parts.minute < 10)) {
        return null;
    }

    const checkpointLabel = formatCheckpointLabel(parts.hour);
    const coverage = summarizeCoverage(params.board, params.now);
    const pendingLines = buildGroupedPendingLines({
        awaitingIntervention: coverage.awaitingIntervention,
        missingIntervention: coverage.missingIntervention,
        disabledIntervention: coverage.disabledIntervention,
        missingRegulation: coverage.missingRegulation,
    });

    return {
        noticeKey: `checkpoint:${parts.year}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}T${checkpointLabel}`,
        stage: "coverage_checkpoint",
        payload: {
            checkpointLabel,
            confirmedInterventionCount: coverage.confirmedIntervention.length,
            confirmedRegulationCount: coverage.confirmedRegulation.length,
            pendingCount: pendingLines.length,
        },
        text: [
            `📋 Fechamento público ${checkpointLabel}.`,
            "",
            "🚑 Intervenção confirmada:",
            renderSection(buildInterventionSection(coverage.confirmedIntervention, params.now, { includeArrival: true }), "- Nenhuma avançada confirmada neste fechamento"),
            "",
            "☎️ Regulação confirmada:",
            renderSection(buildRegulationSection(coverage.confirmedRegulation, true), "- Nenhum ramal confirmado neste fechamento"),
            ...(pendingLines.length > 0
                ? ["", "🟠 Pendências ainda abertas:", pendingLines.join("\n"), "", "⚠️ Quem não avisou base ou ramal, informe agora para fechar a cobertura."]
                : ["", "✅ Cobertura confirmada neste fechamento."]),
        ].join("\n"),
    };
}

function buildPaymentCheckpointPlan(params: ReminderPlanningParams): ReminderPlan | null {
    const parts = getSaoPauloParts(params.now);
    if (!((parts.hour === 0 || parts.hour === 12) && parts.minute < 10)) {
        return null;
    }

    const checkpointLabel = formatCheckpointLabel(parts.hour);
    const shiftLabel = resolveOperationalShiftWindow(params.now).shiftLabel;
    const coverage = summarizeCoverage(params.board, params.now);
    const confirmedIntervention = coverage.confirmedIntervention.map((row) => `- ${row.baseCode} - ${formatReminderDoctorName(row.doctorName, row.displayName)} | chegada ${formatHour(row.startedAt)} | ${row.shiftLabel ?? shiftLabel}`);
    const confirmedRegulation = coverage.confirmedRegulation.map((row) => `- ${row.postCode} - ${formatReminderDoctorName(row.doctorName, row.displayName)} | chegada ${formatHour(row.startedAt)} | ${row.shiftLabel ?? shiftLabel}`);
    const pendingLines = buildGroupedPendingLines({
        awaitingIntervention: coverage.awaitingIntervention,
        missingIntervention: coverage.missingIntervention,
        disabledIntervention: coverage.disabledIntervention,
        missingRegulation: coverage.missingRegulation,
    });

    return {
        noticeKey: `payment:${parts.year}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}T${checkpointLabel}`,
        stage: "payment_checkpoint",
        payload: {
            checkpointLabel,
            confirmedInterventionCount: confirmedIntervention.length,
            confirmedRegulationCount: confirmedRegulation.length,
            pendingCount: pendingLines.length,
        },
        text: [
            `🧾 Registro ${checkpointLabel} para pagamento e banco de horas.`,
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

function buildRegulationConfirmationPlan(params: ReminderPlanningParams): ReminderPlan | null {
    const metrics = resolveRegulationConfirmationMetrics(params);
    if (!metrics) {
        return null;
    }

    return {
        noticeKey: `reg-confirm:${metrics.dateLabel}T${metrics.slot}`,
        stage: "regulation_confirmation",
        payload: {
            checkpointLabel: metrics.slot,
            nonChiefRegulationCount: metrics.nonChiefRegulationCount,
            activeUsaCount: metrics.activeUsaCount,
            waitingUsaCount: metrics.waitingUsaCount,
        },
        text: [
            `☎️🧭 Checagem da Regulação ${metrics.slot}`,
            "",
            `👥 Reguladores logados além da chefia: ${metrics.nonChiefRegulationCount}`,
            "ℹ️ Não conta 2031, NUCLEO nem PIAM.",
            "",
            `🚑 USAs com médico: ${metrics.activeUsaCount}`,
            metrics.waitingInterventionCodes.length > 0
                ? `🚨 USAs sem informação (${metrics.waitingInterventionCodes.length}): ${joinPendingCodes(metrics.waitingInterventionCodes)}`
                : "✅ Nenhuma USA sem informação.",
            metrics.disabledInterventionCodes.length > 0
                ? `⚫ USAs desativadas (${metrics.disabledInterventionCodes.length}): ${joinPendingCodes(metrics.disabledInterventionCodes)}`
                : null,
            "",
            "👨‍✈️ Chefia, confirme se falta regulador para fechar a cobertura.",
            "🚨 Se faltou, avisem agora com nome + ramal + turno (SD/SN/P).",
        ].filter((line): line is string => Boolean(line)).join("\n"),
    };
}

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

    const lines: string[] = [];
    if (metrics.waitingInterventionCodes.length > 0) {
        lines.push(`${joinAlertCodes(metrics.waitingInterventionCodes)} ESTÃO SEM MÉDICO PARA PAGAMENTO. ATENÇÃO.`);
    }

    if (metrics.waitingRegulationCodes.length > 0) {
        lines.push(`${joinAlertCodes(metrics.waitingRegulationCodes)} ESTÃO SEM MÉDICO NA REGULAÇÃO. ATENÇÃO.`);
    }

    if (hasLowRegulationHeadcount) {
        lines.push(`SÓ TEM ${metrics.nonChiefRegulationCount} MRs LOGADOS ALÉM DA CHEFIA. É ISSO MESMO?`);
    }

    return {
        noticeKey: `reg-confirm-private:${metrics.dateLabel}T${metrics.slot}`,
        stage: "regulation_confirmation_private",
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
        buildRegulationConfirmationPlan(params),
    ].filter((plan): plan is ReminderPlan => Boolean(plan));
}

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
            const domainLabel = row.domain === "regulation" ? "Regulação" : "Intervenção";
            const doctor = row.doctorName?.trim() || "sem escolhido";
            const candidates = row.conflictCandidateLabels.length > 0 ? row.conflictCandidateLabels.join(" x ") : "nao detalhado";
            const reasons = row.issues
                .filter((issue) => issue !== "Conflito entre medicos titulares no mesmo alvo/turno")
                .slice(0, 2);
            const reasonLabel = reasons.length > 0 ? reasons.join("; ") : "entrada por cima de outro titular no mesmo turno";
            return `- ${domainLabel} ${row.targetCode} ${row.shiftLabel}: ${doctor} | candidatos ${row.candidateCount}: ${candidates} | motivo: ${reasonLabel}`;
        });

    const operationalDate = params.paymentBoard.operationalDate.slice(0, 10);
    return {
        noticeKey: `payment-conflict:${operationalDate}:${params.paymentBoard.shiftLabel}:${bucket.toISOString()}`,
        stage: "payment_conflict_alert",
        payload: {
            bucketAt: bucket.toISOString(),
            operationalDate,
            shiftLabel: params.paymentBoard.shiftLabel,
            conflictCount: conflictRows.length,
        },
        text: [
            `🚨 Conflito real de alocação para pagamento (${params.paymentBoard.shiftLabel} ${formatHour(bucket)}).`,
            "",
            "Detectei sobreposição entre titulares no mesmo alvo/turno (entrada por cima). Sombra não entra neste alerta.",
            "",
            ...lines,
            ...(conflictRows.length > lines.length ? [`- ... e mais ${conflictRows.length - lines.length} conflito(s)`] : []),
            "",
            "👨‍✈️ Chefia: revisar agora em /admin/payment-attestation/audit ou no modal do fechamento.",
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

    const plans = buildReminderPlans({
        now: referenceDate,
        board,
    });

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

        for (const chatId of recipients) {
            const inserted = await markNoticeSent(plan, chatId);
            if (!inserted) {
                continue;
            }

            try {
                await sendMessage(chatId, plan.text);
                sent += 1;
            } catch (error) {
                await rollbackNotice(chatId, plan);
                console.error(`telegram reminder failed for ${chatId} ${plan.noticeKey}`, error);
            }
        }
    }

    const chiefPrivateAlertPlan = buildChiefPrivateRegulationAlertPlan({
        now: referenceDate,
        board,
    });

    if (chiefPrivateAlertPlan) {
        evaluated += chiefPrivateAlertRecipients.length;

        for (const chatId of chiefPrivateAlertRecipients) {

    try {
        const pendingTakeovers = await loadPendingTakeoverConflicts(referenceDate);
        const takeoverRecipients = uniqueChatIds([
            ...reminderChatIds,
            ...adminChatIds,
            ...chiefPrivateAlertRecipients,
        ]);

        for (const conflict of pendingTakeovers) {
            const plan = buildTakeoverConflictPlan({ now: referenceDate, conflict });
            evaluated += takeoverRecipients.length;

            for (const chatId of takeoverRecipients) {
                const inserted = await markNoticeSent(plan, chatId);
                if (!inserted) {
                    continue;
                }

                try {
                    await sendMessage(chatId, plan.text);
                    sent += 1;
                } catch (error) {
                    await rollbackNotice(chatId, plan);
                    console.error(`telegram reminder failed for ${chatId} ${plan.noticeKey}`, error);
                }
            }
        }
    } catch (error) {
        console.error("telegram takeover conflict alerts failed", error);
    }
            const inserted = await markNoticeSent(chiefPrivateAlertPlan, chatId);
            if (!inserted) {
                continue;
            }

            try {
                await sendMessage(chatId, chiefPrivateAlertPlan.text);
                sent += 1;
            } catch (error) {
                await rollbackNotice(chatId, chiefPrivateAlertPlan);
                console.error(`telegram reminder failed for ${chatId} ${chiefPrivateAlertPlan.noticeKey}`, error);
            }
        }
    }

    try {
        const paymentBoard = await getPaymentAllocationBoard({
            reference: referenceDate,
            expireDeactivations: false,
        });
        const paymentConflictPlan = buildPaymentConflictAlertPlan({ now: referenceDate, paymentBoard });
        if (paymentConflictPlan) {
            const recipients = uniqueChatIds([...reminderChatIds, ...adminChatIds]);
            evaluated += recipients.length;

            for (const chatId of recipients) {
                const inserted = await markNoticeSent(paymentConflictPlan, chatId);
                if (!inserted) {
                    continue;
                }

                try {
                    await sendMessage(chatId, paymentConflictPlan.text);
                    sent += 1;
                } catch (error) {
                    await rollbackNotice(chatId, paymentConflictPlan);
                    console.error(`telegram reminder failed for ${chatId} ${paymentConflictPlan.noticeKey}`, error);
                }
            }
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
}) {
    const name = formatReminderDoctorName(params.doctorName, params.displayName);
    return [
        "🟠🕔 Meio plantao encerrado automaticamente.",
        `${name} foi retirado de ${params.targetCode} as 17:00.`,
        "Ja removi do quadro principal e registrei para pagamento como MEIO.",
    ].join("\n");
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
        });

        const results = await Promise.allSettled(chatIds.map((chatId) => sendMessage(chatId, text)));
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
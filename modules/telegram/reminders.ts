import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { telegramBotNotices } from "@/db/schema";
import { formatDoctorSurfaceName } from "@/modules/doctors/directory";
import {
    getSaoPauloParts,
    hasPlannedInterventionCoverageForCurrentShift,
    resolveOperationalShiftWindow,
    shouldHighlightInterventionVerification,
} from "@/modules/operational/board-rules";
import { sendMessage } from "@/modules/telegram/api";
import { getTelegramAnnouncementChatIds, getTelegramReminderChatIds } from "@/modules/telegram/config";
import {
    getOperationalBoard,
    type InterventionBoardRow,
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
    stage: "instruction" | "coverage_snapshot" | "coverage_checkpoint" | "payment_checkpoint" | "regulation_confirmation";
    text: string;
    payload: Record<string, unknown>;
}

interface ReminderPlanningParams {
    now: Date;
    board: ReminderBoardSnapshot;
}

const TEN_MINUTES = 10 * 60 * 1000;
const ONE_HOUR = 60 * 60 * 1000;

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
    const parts = getSaoPauloParts(params.now);
    const slot = resolveRegulationConfirmationSlot(parts);
    if (!slot) {
        return null;
    }

    const confirmedRegulation = sortTelegramRegulationRows(
        params.board.regulation.filter((row) => row.status === "active"),
    );
    const occupiedLines = confirmedRegulation.map((row) => `✅ ${row.postCode} - ${formatReminderDoctorName(row.doctorName, row.displayName)}`);
    const occupiedCount = confirmedRegulation.length;
    const dateLabel = `${parts.year}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;

    return {
        noticeKey: `reg-confirm:${dateLabel}T${slot}`,
        stage: "regulation_confirmation",
        payload: {
            checkpointLabel: slot,
            occupiedCount,
        },
        text: [
            `☎️🧭 Checagem da Regulação ${slot}`,
            "",
            `👥 Reguladores confirmados no turno: ${occupiedCount}`,
            "",
            "📞 Ramais ocupados agora:",
            occupiedLines.length > 0 ? occupiedLines.join("\n") : "⚠️ Sem ramal ocupado registrado no momento.",
            "",
            "🧠 Inclui NUCLEO e PIAM quando ocupados.",
            "👨‍✈️ Chefia, por favor confirme no grupo: são só esses mesmo ou faltou alguém confirmar?",
            "🚨 Se faltou, avisem agora com nome + ramal + turno (SD/SN/P).",
        ].join("\n"),
    };
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
    const chatIds = resolveReminderChatIds();
    if (chatIds.length === 0 || !process.env.TELEGRAM_BOT_TOKEN?.trim()) {
        return { sent: 0, evaluated: 0 };
    }

    const board = await getOperationalBoard();
    const plans = buildReminderPlans({
        now: referenceDate,
        board,
    });

    let sent = 0;
    let evaluated = 0;

    for (const chatId of chatIds) {
        evaluated += plans.length;

        for (const plan of plans) {
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

    return { sent, evaluated };
}
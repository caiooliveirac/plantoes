import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { telegramBotNotices } from "@/db/schema";
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

export interface ReminderBoardSnapshot {
    generatedAt: string;
    regulation: RegulationBoardRow[];
    intervention: InterventionBoardRow[];
}

export interface ReminderPlan {
    noticeKey: string;
    stage: "instruction" | "coverage_snapshot" | "coverage_checkpoint" | "payment_checkpoint";
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

function formatFullName(primary: string | null, fallback: string | null) {
    return primary?.trim() || fallback?.trim() || "medico ainda nao identificado";
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
    const hasPlannedCoverage = hasPlannedInterventionCoverageForCurrentShift({
        shiftLabel: row.shiftLabel,
        scheduledEndAt: row.scheduledEndAt,
        reference,
    });

    return row.status === "active"
        && !hasPlannedCoverage
        && shouldHighlightInterventionVerification(row.boardStartedAt ?? row.startedAt, reference, row.shiftLabel);
}

function describeInterventionAwaitingNews(row: InterventionBoardRow) {
    const name = formatFullName(row.doctorName, row.displayName);
    const lastShiftLabel = row.shiftLabel ?? "turno anterior";
    const lastStartedAt = row.startedAt ? `${lastShiftLabel} desde ${formatHour(row.startedAt)}` : lastShiftLabel;
    return `Sem medico confirmado neste turno. Ultimo aviso: ${name} | ${lastStartedAt}. So entra se avisar continua/P ou se a chefia atualizar.`;
}

function summarizeCoverage(board: ReminderBoardSnapshot, reference: Date) {
    const confirmedIntervention = board.intervention.filter((row) => row.status === "active" && !isInterventionAwaitingNews(row, reference));
    const awaitingIntervention = board.intervention.filter((row) => row.status === "active" && isInterventionAwaitingNews(row, reference));
    const missingIntervention = board.intervention.filter((row) => row.status === "waiting");
    const confirmedRegulation = board.regulation.filter((row) => row.status === "active");
    const missingRegulation = board.regulation.filter((row) => row.status === "waiting");

    return {
        confirmedIntervention,
        awaitingIntervention,
        missingIntervention,
        confirmedRegulation,
        missingRegulation,
        unresolvedCount: awaitingIntervention.length + missingIntervention.length + missingRegulation.length,
    };
}

function buildInterventionLine(row: InterventionBoardRow, reference: Date, includeArrival = false) {
    const name = formatFullName(row.doctorName, row.displayName);
    const arrival = includeArrival && row.startedAt ? ` | chegada ${formatHour(row.startedAt)}` : "";

    if (row.status === "waiting") {
        return `🔴 ${row.baseCode} - Aguardando confirmação da avançada`;
    }

    if (isInterventionAwaitingNews(row, reference)) {
        return `🔴 ${row.baseCode} - ${describeInterventionAwaitingNews(row)}`;
    }

    return `✅ ${row.baseCode} - ${name}${arrival}`;
}

function buildRegulationLine(row: RegulationBoardRow, includeArrival = false) {
    const name = formatFullName(row.doctorName, row.displayName);
    const arrival = includeArrival && row.startedAt ? ` | chegada ${formatHour(row.startedAt)}` : "";

    if (row.status === "waiting") {
        return `🔴 ${row.postCode} - Aguardando aviso de ramal`;
    }

    return `✅ ${row.postCode} - ${name}${arrival}`;
}

function buildInterventionSection(rows: InterventionBoardRow[], reference: Date, includeArrival = false) {
    return rows.map((row) => buildInterventionLine(row, reference, includeArrival)).join("\n");
}

function buildRegulationSection(rows: RegulationBoardRow[], includeArrival = false) {
    return rows.map((row) => buildRegulationLine(row, includeArrival)).join("\n");
}

function joinPendingCodes(values: string[]) {
    return values.join(", ");
}

function buildGroupedPendingLines(params: {
    awaitingIntervention: InterventionBoardRow[];
    missingIntervention: InterventionBoardRow[];
    missingRegulation: RegulationBoardRow[];
}) {
    const lines: string[] = [];

    if (params.awaitingIntervention.length > 0) {
        lines.push(
            `🔴 Intervencao sem medico confirmado neste turno (${params.awaitingIntervention.length}): ${joinPendingCodes(params.awaitingIntervention.map((row) => row.baseCode))}. So entra se avisar continua/P ou se a chefia atualizar.`,
        );
    }

    if (params.missingIntervention.length > 0) {
        lines.push(
            `🚑 Avancadas sem aviso (${params.missingIntervention.length}): ${joinPendingCodes(params.missingIntervention.map((row) => row.baseCode))}`,
        );
    }

    if (params.missingRegulation.length > 0) {
        lines.push(
            `☎️ Ramais sem aviso (${params.missingRegulation.length}): ${joinPendingCodes(params.missingRegulation.map((row) => row.postCode))}`,
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
        return "✅ Cobertura fechada até aqui. Obrigado por manterem base, ramal e turno claros para a coordenação.";
    }

    const elapsedMs = params.now.getTime() - resolveOperationalShiftWindow(params.now).startedAt.getTime();
    if (elapsedMs < 20 * 60 * 1000) {
        return params.missingRegulationCount > 0
            ? "🫶 TARM precisa dos ramais ativos. Quem estiver na regulacao, por favor avise ramal e turno no padrao."
            : "🫶 Quem continuou precisa avisar continua/P. Sem esse aviso ou ajuste da chefia, a avancada segue sem medico confirmado.";
    }

    if (elapsedMs < 40 * 60 * 1000) {
        return params.missingRegulationCount > 0
            ? "⚠️ Coordenação ainda está sem todos os ramais ativos. TARM precisa dos ramais ativos. Reguladores, por favor avisem o ramal agora para o TARM conseguir trabalhar com segurança."
            : "⚠️ Coordenação ainda está sem avancadas confirmadas. Quem continuou precisa escrever continua/P agora. Sem isso ou ajuste da chefia, a posicao fica sem medico confirmado.";
    }

    return params.missingRegulationCount > 0
        ? "🚨 Sem aviso de base e ramal eu não fecho cobertura nem folha. TARM precisa dos ramais ativos. Regulação, por favor informe agora quem está em cada ramal."
        : "🚨 Sem aviso de continua/P ou ajuste da chefia eu trato a avancada como sem medico confirmado no grupo, na cobertura e na folha. Intervencao, por favor atualize agora.";
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
            `🧭 Quadro ${formatHour(bucket)} | Intervenção ${coverage.confirmedIntervention.length}/${params.board.intervention.length} | Regulação ${coverage.confirmedRegulation.length}/${params.board.regulation.length}`,
            "",
            "Intervenção:",
            buildInterventionSection(params.board.intervention, params.now),
            "",
            "Regulação:",
            buildRegulationSection(params.board.regulation),
            "",
            resolveCoverageFooter({
                now: params.now,
                unresolvedCount: coverage.unresolvedCount,
                missingRegulationCount: coverage.missingRegulation.length,
            }),
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
            renderSection(buildInterventionSection(coverage.confirmedIntervention, params.now), "- Nenhuma avançada confirmada neste fechamento"),
            "",
            "☎️ Regulação confirmada:",
            renderSection(buildRegulationSection(coverage.confirmedRegulation), "- Nenhum ramal confirmado neste fechamento"),
            ...(pendingLines.length > 0
                ? ["", "🟠 Pendências ainda abertas:", pendingLines.join("\n"), "", "⚠️ Quem ainda não avisou base ou ramal, por favor informe agora para a coordenação fechar a cobertura."]
                : ["", "✅ Cobertura confirmada para a coordenação neste fechamento."]),
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
    const confirmedIntervention = coverage.confirmedIntervention.map((row) => `- ${row.baseCode} - ${formatFullName(row.doctorName, row.displayName)} | chegada ${formatHour(row.startedAt)} | ${row.shiftLabel ?? shiftLabel}`);
    const confirmedRegulation = coverage.confirmedRegulation.map((row) => `- ${row.postCode} - ${formatFullName(row.doctorName, row.displayName)} | chegada ${formatHour(row.startedAt)} | ${row.shiftLabel ?? shiftLabel}`);
    const pendingLines = buildGroupedPendingLines({
        awaitingIntervention: coverage.awaitingIntervention,
        missingIntervention: coverage.missingIntervention,
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
            "🚑 Intervencao confirmada:",
            confirmedIntervention.length > 0 ? confirmedIntervention.join("\n") : "- Nenhuma avancada confirmada neste recorte",
            "",
            "☎️ Regulacao confirmada:",
            confirmedRegulation.length > 0 ? confirmedRegulation.join("\n") : "- Nenhum ramal confirmado neste recorte",
            ...(pendingLines.length > 0
                ? ["", "🟠 Pendencias que ainda exigem conferencia:", pendingLines.join("\n")]
                : []),
        ].join("\n"),
    };
}

export function buildReminderPlans(params: ReminderPlanningParams) {
    return [
        buildPreShiftInstructionPlan(params.now),
        buildCoverageSnapshotPlan(params),
        buildCoverageCheckpointPlan(params),
        buildPaymentCheckpointPlan(params),
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
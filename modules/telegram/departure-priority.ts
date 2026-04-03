import { isBeforeCurrentOperationalShift, resolveOperationalShiftWindow } from "@/modules/operational/board-rules";
import { formatDoctorSurfaceName } from "@/modules/doctors/directory";
import { escapeTelegramMarkdown } from "@/modules/telegram/api";
import { isHalfShiftRoleLabel } from "@/modules/operational/half-shift";
import { isRemoteOperationalRole, normalizeOperationalRoleLabel, resolveOperationalRoleLabel } from "@/modules/operational/roles";
import { compareTelegramRegulationCodes } from "@/modules/telegram/presentation-order";
import { getCurrentOperationalMealBreakSession, type MealBreakSession } from "@/modules/telegram/meal-breaks";
import { getOperationalBoard } from "@/services/board.service";

type OperationalBoard = Awaited<ReturnType<typeof getOperationalBoard>>;

export interface TelegramDeparturePriorityCommand {
    name: "departure_priority";
    rawBody: string;
}

export interface DeparturePriorityEntry {
    rank: number;
    domain: "regulation";
    targetCode: string;
    name: string;
    roleLabel: string | null;
    startedAt: string;
    priorityStartedAt: string;
}

export interface DeparturePriorityContinuationEntry {
    targetCode: string;
    name: string;
    roleLabel: string | null;
    startedAt: string;
}

export interface DeparturePriorityView {
    generatedAt: string;
    shiftLabel: "SD" | "SN";
    entries: DeparturePriorityEntry[];
    excludedContinuations: DeparturePriorityContinuationEntry[];
    activeNightWorkSlot: "23:00" | "03:00" | null;
    /** Fechamento-alvo da janela horária ("19h" ou "07h"); null fora das janelas. */
    departureBoundary: DeparturePriorityBoundary | null;
}

/** Fechamento operacional para o qual a saída está prevista. */
type DeparturePriorityBoundary = "07h" | "19h";

interface DeparturePriorityCandidate {
    domain: "regulation";
    targetCode: string;
    name: string;
    roleLabel: string | null;
    startedAt: string;
    priorityStartedAt: string;
}

// Tempo mínimo de plantão para entrar no ranking de saída: quem chegou há
// menos de 4h ainda não é candidato a sair, então fica fora da lista.
const MINIMUM_DEPARTURE_PRIORITY_MS = 4 * 60 * 60 * 1000;

// Postos que nunca entram na lista de prioridade de saída.
const EXCLUDED_DEPARTURE_POST_CODES = new Set(["PIAM", "NUCLEO"]);

type DeparturePriorityMealBreakSession = {
    recipRamal: string | null;
    mrvRamals?: MealBreakSession["mrvRamals"];
    mode?: MealBreakSession["mode"];
    stage?: MealBreakSession["stage"];
    nightWorkAssignments?: MealBreakSession["nightWorkAssignments"];
};

function formatHour(value: string | Date) {
    return new Intl.DateTimeFormat("pt-BR", {
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
        timeZone: "America/Sao_Paulo",
    }).format(new Date(value));
}

function formatSaoPauloHourMinute(referenceAt: Date) {
    const parts = new Intl.DateTimeFormat("pt-BR", {
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
        timeZone: "America/Sao_Paulo",
    }).formatToParts(referenceAt);

    const hour = Number(parts.find((part) => part.type === "hour")?.value ?? "0");
    const minute = Number(parts.find((part) => part.type === "minute")?.value ?? "0");
    return { hour, minute };
}

// Início do turno cujo fechamento é o alvo (07h → turno SN; 19h → turno SD).
function resolveShiftStartForBoundary(referenceAt: Date, departureBoundary: DeparturePriorityBoundary) {
    const window = resolveOperationalShiftWindow(referenceAt);
    if (departureBoundary === "07h") {
        return window.shiftLabel === "SN" ? window.startedAt : window.previousBoundaryAt;
    }
    return window.shiftLabel === "SD" ? window.startedAt : window.previousBoundaryAt;
}

function resolveLateThresholdAt(referenceAt: Date, departureBoundary: DeparturePriorityBoundary | null) {
    const shiftStartedAt = departureBoundary
        ? resolveShiftStartForBoundary(referenceAt, departureBoundary)
        : resolveOperationalShiftWindow(referenceAt).startedAt;
    return shiftStartedAt.getTime() + (15 * 60 * 1000);
}

// Fechamento em que a ocupação realmente sai, derivado do horário previsto de
// saída: SD e P invertido terminam às 19h; SN e P normal terminam às 07h.
function resolveRowDepartureBoundary(row: OperationalBoard["regulation"][number]): DeparturePriorityBoundary | null {
    if (row.scheduledEndAt) {
        const { hour } = formatSaoPauloHourMinute(new Date(row.scheduledEndAt));
        return hour < 13 ? "07h" : "19h";
    }
    if (row.shiftLabel === "SD") return "19h";
    if (row.shiftLabel === "SN") return "07h";
    return null;
}

// Janela horária do /prioridadesaida:
//   16h-21h → fechamento das 19h (turno SD: SD + P invertido).
//   02h-09h → fechamento das 07h (turno SN: SN + P normal).
// Fora das janelas, mantém o comportamento legado (turno atual, sem alvo de fechamento).
function resolveDeparturePriorityMode(referenceAt: Date): {
    shiftLabel: "SD" | "SN";
    departureBoundary: DeparturePriorityBoundary | null;
} {
    const { hour } = formatSaoPauloHourMinute(referenceAt);
    if (hour >= 16 && hour < 21) {
        return { shiftLabel: "SD", departureBoundary: "19h" };
    }
    if (hour >= 2 && hour < 9) {
        return { shiftLabel: "SN", departureBoundary: "07h" };
    }
    return { shiftLabel: resolveOperationalShiftWindow(referenceAt).shiftLabel, departureBoundary: null };
}

function resolvePriorityStartedAt(startedAt: string, roleLabel: string | null, thresholdAtMs: number) {
    const startedAtMs = new Date(startedAt).getTime();
    if (!isRemoteOperationalRole(roleLabel)) {
        return startedAtMs;
    }

    return Math.max(startedAtMs, thresholdAtMs);
}

function resolveActiveNightWorkSlot(params: {
    referenceAt: Date;
    shiftLabel: "SD" | "SN";
    mealBreakSession: DeparturePriorityMealBreakSession | null;
}): "23:00" | "03:00" | null {
    if (
        params.shiftLabel !== "SN"
        || !params.mealBreakSession
        || params.mealBreakSession.mode !== "night"
        || params.mealBreakSession.stage !== "completed"
        || Object.keys(params.mealBreakSession.nightWorkAssignments ?? {}).length === 0
    ) {
        return null;
    }

    const { hour } = formatSaoPauloHourMinute(params.referenceAt);
    // "23:00" turma: from 23:00 to 02:59
    if (hour >= 23 || hour < 3) return "23:00";
    // "03:00" turma: from 03:00 onwards (until shift ends ~19:00)
    if (hour >= 3 && hour < 19) return "03:00";
    return null;
}

function compareDeparturePriorityCandidates(left: DeparturePriorityCandidate, right: DeparturePriorityCandidate) {
    const priorityStartedAtDiff = new Date(left.priorityStartedAt).getTime() - new Date(right.priorityStartedAt).getTime();
    if (priorityStartedAtDiff !== 0) {
        return priorityStartedAtDiff;
    }

    const startedAtDiff = new Date(left.startedAt).getTime() - new Date(right.startedAt).getTime();
    if (startedAtDiff !== 0) {
        return startedAtDiff;
    }

    return compareTelegramRegulationCodes(left.targetCode, right.targetCode);
}

function compareDeparturePriorityContinuations(left: DeparturePriorityContinuationEntry, right: DeparturePriorityContinuationEntry) {
    const startedAtDiff = new Date(left.startedAt).getTime() - new Date(right.startedAt).getTime();
    if (startedAtDiff !== 0) {
        return startedAtDiff;
    }

    return compareTelegramRegulationCodes(left.targetCode, right.targetCode);
}

function isExcludedDepartureRole(roleLabel: string | null) {
    const normalized = normalizeOperationalRoleLabel(roleLabel);
    return normalized === "CP"
        || normalized === "MRV"
        || normalized === "RECIP"
        || normalized === "PIAM"
        || normalized === "NUCLEO"
        || isHalfShiftRoleLabel(roleLabel);
}

function buildDeparturePriorityCandidates(params: {
    referenceAt: Date;
    shiftLabel: "SD" | "SN";
    departureBoundary: DeparturePriorityBoundary | null;
    board: OperationalBoard;
    mealBreakSession: DeparturePriorityMealBreakSession | null;
}) {
    const recipRamal = params.mealBreakSession?.recipRamal ?? null;
    const mrvRamals = new Set(params.mealBreakSession?.mrvRamals ?? []);
    const candidates: DeparturePriorityCandidate[] = [];
    const excludedContinuations: DeparturePriorityContinuationEntry[] = [];
    const thresholdAtMs = resolveLateThresholdAt(params.referenceAt, params.departureBoundary);
    const activeNightWorkSlot = resolveActiveNightWorkSlot({
        referenceAt: params.referenceAt,
        shiftLabel: params.shiftLabel,
        mealBreakSession: params.mealBreakSession,
    });

    for (const row of params.board.regulation) {
        if (row.status !== "active" || !row.doctorId || !row.startedAt) {
            continue;
        }

        const roleLabel = resolveOperationalRoleLabel({
            domain: "regulation",
            code: row.postCode,
            shiftLabel: row.shiftLabel,
            roleLabel: row.roleLabel,
            defaultRole: row.defaultRole,
        });
        const rowStartedAt = row.startedAt;
        const pushContinuation = () => excludedContinuations.push({
            targetCode: row.postCode,
            name: formatDoctorSurfaceName({
                fullName: row.doctorName,
                displayName: row.displayName,
                fallback: row.postCode,
            }),
            roleLabel,
            startedAt: rowStartedAt,
        });

        if (params.departureBoundary) {
            // Modo janela: só rankeia quem realmente sai no fechamento-alvo.
            // Quem sai no outro fechamento e está em P aparece como continuidade.
            if (resolveRowDepartureBoundary(row) !== params.departureBoundary) {
                if (row.shiftLabel === "P") {
                    pushContinuation();
                }
                continue;
            }
        } else if (row.shiftLabel === "P") {
            // P iniciado dentro do plantão atual → continua para o próximo (excluir do ranking).
            // P iniciado num plantão anterior → está terminando agora; trata como saída regular.
            const startedDuringCurrentShift = !isBeforeCurrentOperationalShift(row.startedAt, params.referenceAt);
            if (startedDuringCurrentShift) {
                pushContinuation();
                continue;
            }
        } else {
            if (params.shiftLabel === "SD" && row.shiftLabel !== "SD") {
                continue;
            }
            if (params.shiftLabel === "SN" && row.shiftLabel === "SD") {
                continue;
            }
        }

        if (
            isExcludedDepartureRole(roleLabel)
            || EXCLUDED_DEPARTURE_POST_CODES.has(row.postCode.trim().toUpperCase())
            || row.postCode === recipRamal
            || mrvRamals.has(row.postCode)
        ) {
            continue;
        }

        if (activeNightWorkSlot) {
            const assignedSlot = params.mealBreakSession?.nightWorkAssignments?.[row.postCode] ?? null;
            if (assignedSlot !== activeNightWorkSlot) {
                continue;
            }
        }

        // Chegou há pouco: sem 4h de plantão acumuladas, não entra no ranking de saída.
        const tenureMs = params.referenceAt.getTime() - new Date(row.startedAt).getTime();
        if (tenureMs < MINIMUM_DEPARTURE_PRIORITY_MS) {
            continue;
        }

        const priorityStartedAt = new Date(resolvePriorityStartedAt(row.startedAt, roleLabel, thresholdAtMs)).toISOString();

        candidates.push({
            domain: "regulation",
            targetCode: row.postCode,
            name: formatDoctorSurfaceName({
                fullName: row.doctorName,
                displayName: row.displayName,
                fallback: row.postCode,
            }),
            roleLabel,
            startedAt: row.startedAt,
            priorityStartedAt,
        });
    }

    return {
        entries: candidates.sort(compareDeparturePriorityCandidates),
        excludedContinuations: excludedContinuations.sort(compareDeparturePriorityContinuations),
        activeNightWorkSlot,
    };
}

export function isTelegramDeparturePriorityCommandText(text: string) {
    return /^\/(?:prioridadesaida|prioridadessaida)(?:@\w+)?\b/i.test(text.trim());
}

export function parseTelegramDeparturePriorityCommand(text: string): TelegramDeparturePriorityCommand | null {
    const trimmed = text.trim();
    const match = trimmed.match(/^\/(prioridadesaida|prioridadessaida)(?:@(\w+))?\s*$/i);
    if (!match) {
        return null;
    }

    return {
        name: "departure_priority",
        rawBody: trimmed.replace(/^\/(?:prioridadesaida|prioridadessaida)(?:@\w+)?/i, "").trim(),
    };
}

/**
 * Reply do /prioridadesaida (auditoria §3.3#10): ranking começa na linha 2,
 * regras colapsadas em 1 linha no rodapé, janela do jantar do SN preservada.
 * Texto pronto para envio com parseMode "Markdown" (interpolações escapadas).
 */
export function buildDeparturePriorityReply(view: DeparturePriorityView) {
    const isNight = view.shiftLabel === "SN";
    const shiftName = isNight ? "NOTURNO" : "DIURNO";
    const boundarySuffix = view.departureBoundary ? ` — sai às ${view.departureBoundary}` : "";
    const lines = [`👋 *Prioridade de saída ${shiftName}*${boundarySuffix}`];

    if (view.entries.length === 0) {
        lines.push("Sem reguladores elegíveis no quadro agora.");
    } else {
        lines.push(...view.entries.map((entry) => `${entry.rank}. ${escapeTelegramMarkdown(entry.name)} | ${escapeTelegramMarkdown(entry.targetCode)} | ${formatHour(entry.startedAt)}`));
    }

    if (view.activeNightWorkSlot) {
        lines.push(`🍽️ Janela ativa da divisão de jantar: ${view.activeNightWorkSlot}.`);
    }

    if (view.excludedContinuations.length > 0) {
        lines.push(`🔁 Em P (continuam): ${view.excludedContinuations.map((entry) => `${escapeTelegramMarkdown(entry.name)} (${escapeTelegramMarkdown(entry.targetCode)} ${formatHour(entry.startedAt)})`).join(", ")}`);
    }

    lines.push(`Regras: fora da lista CP, MRV, RECIP, PIAM, NUCLEO, MEIO, quem chegou há menos de 4h e quem está em P/continua${isNight ? "; RMT tem piso 19:15" : ""}.`);

    return lines.join("\n");
}

export async function getCurrentDeparturePriorityView(params?: {
    referenceAt?: Date;
    board?: OperationalBoard;
    mealBreakSession?: DeparturePriorityMealBreakSession | null;
}) {
    const referenceAt = params?.referenceAt ?? new Date();
    const { shiftLabel, departureBoundary } = resolveDeparturePriorityMode(referenceAt);
    const board = params?.board ?? await getOperationalBoard();
    const mealBreakSession = params?.mealBreakSession === undefined
        ? await getCurrentOperationalMealBreakSession(referenceAt)
        : params.mealBreakSession;
    const candidates = buildDeparturePriorityCandidates({
        referenceAt,
        shiftLabel,
        departureBoundary,
        board,
        mealBreakSession,
    });
    const entries = candidates.entries.map((entry, index) => ({
        ...entry,
        rank: index + 1,
    } satisfies DeparturePriorityEntry));

    return {
        generatedAt: board.generatedAt,
        shiftLabel,
        entries,
        excludedContinuations: candidates.excludedContinuations,
        activeNightWorkSlot: candidates.activeNightWorkSlot,
        departureBoundary,
    } satisfies DeparturePriorityView;
}

export async function runTelegramDeparturePriorityCommand(params?: {
    referenceAt?: Date;
    board?: OperationalBoard;
    mealBreakSession?: DeparturePriorityMealBreakSession | null;
}) {
    const view = await getCurrentDeparturePriorityView(params);
    return {
        view,
        message: buildDeparturePriorityReply(view),
        status: "reported" as const,
    };
}

export function buildDeparturePriorityCommandUsageReply() {
    return "Use /prioridadesaida para listar quem ainda está elegível no quadro para saída.";
}
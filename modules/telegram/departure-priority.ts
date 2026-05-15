import { isBeforeCurrentOperationalShift, resolveOperationalShiftWindow } from "@/modules/operational/board-rules";
import { formatDoctorSurfaceName } from "@/modules/doctors/directory";
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
}

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

function resolveLateThresholdAt(referenceAt: Date) {
    return resolveOperationalShiftWindow(referenceAt).startedAt.getTime() + (15 * 60 * 1000);
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
    board: OperationalBoard;
    mealBreakSession: DeparturePriorityMealBreakSession | null;
}) {
    const recipRamal = params.mealBreakSession?.recipRamal ?? null;
    const mrvRamals = new Set(params.mealBreakSession?.mrvRamals ?? []);
    const candidates: DeparturePriorityCandidate[] = [];
    const excludedContinuations: DeparturePriorityContinuationEntry[] = [];
    const thresholdAtMs = resolveLateThresholdAt(params.referenceAt);
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
        if (row.shiftLabel === "P") {
            // P iniciado dentro do plantão atual → continua para o próximo (excluir do ranking).
            // P iniciado num plantão anterior → está terminando agora; trata como saída regular.
            const startedDuringCurrentShift = !isBeforeCurrentOperationalShift(row.startedAt, params.referenceAt);
            if (startedDuringCurrentShift) {
                excludedContinuations.push({
                    targetCode: row.postCode,
                    name: formatDoctorSurfaceName({
                        fullName: row.doctorName,
                        displayName: row.displayName,
                        fallback: row.postCode,
                    }),
                    roleLabel,
                    startedAt: row.startedAt,
                });
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

export function buildDeparturePriorityReply(view: DeparturePriorityView) {
    const isNight = view.shiftLabel === "SN";
    const header = ["📤 PRIORIDADE DE SAIDA"];

    if (isNight) {
        header.push("Lista de reguladores no NOTURNO que realmente saem no fechamento.");
        header.push("RMT recebe piso 19:15 (perde prioridade para presencial que chegou ate +15min).");
        if (view.activeNightWorkSlot) {
            header.push(`Janela ativa da divisao de jantar: ${view.activeNightWorkSlot}.`);
        }
    } else {
        header.push("Lista de reguladores no DIURNO que realmente saem no fechamento.");
    }

    header.push("Fora da lista principal: CP, MRV, RECIP, PIAM, NUCLEO, MEIO, quem chegou ha menos de 4h e quem está em P/continua.");

    const lines: string[] = [];

    if (view.entries.length === 0) {
        lines.push("Sem reguladores elegiveis no quadro agora.");
    } else {
        lines.push(...view.entries.map((entry) => `${entry.rank}. ${entry.name} | ${entry.targetCode} | ${formatHour(entry.startedAt)}`));
    }

    lines.push("");
    lines.push("🔁 Fora por estarem em P (continua):");
    if (view.excludedContinuations.length === 0) {
        lines.push("- Nenhum no momento.");
    } else {
        lines.push(...view.excludedContinuations.map((entry) => `- ${entry.name} | ${entry.targetCode} | ${formatHour(entry.startedAt)}`));
    }

    return [...header, ...lines].join("\n");
}

export async function getCurrentDeparturePriorityView(params?: {
    referenceAt?: Date;
    board?: OperationalBoard;
    mealBreakSession?: DeparturePriorityMealBreakSession | null;
}) {
    const referenceAt = params?.referenceAt ?? new Date();
    const shiftLabel = resolveOperationalShiftWindow(referenceAt).shiftLabel;
    const board = params?.board ?? await getOperationalBoard();
    const mealBreakSession = params?.mealBreakSession === undefined
        ? await getCurrentOperationalMealBreakSession(referenceAt)
        : params.mealBreakSession;
    const candidates = buildDeparturePriorityCandidates({
        referenceAt,
        shiftLabel,
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
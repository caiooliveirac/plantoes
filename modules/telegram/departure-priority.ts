import { resolveOperationalShiftWindow } from "@/modules/operational/board-rules";
import { formatDoctorSurfaceName } from "@/modules/doctors/directory";
import { normalizeOperationalRoleLabel, resolveOperationalRoleLabel } from "@/modules/operational/roles";
import { compareTelegramInterventionCodes, compareTelegramRegulationCodes } from "@/modules/telegram/presentation-order";
import { getCurrentOperationalMealBreakSession, type MealBreakSession } from "@/modules/telegram/meal-breaks";
import { getOperationalBoard } from "@/services/board.service";

type OperationalBoard = Awaited<ReturnType<typeof getOperationalBoard>>;

export interface TelegramDeparturePriorityCommand {
    name: "departure_priority";
    rawBody: string;
}

export interface DeparturePriorityEntry {
    rank: number;
    domain: "regulation" | "intervention";
    targetCode: string;
    name: string;
    roleLabel: string | null;
    startedAt: string;
}

export interface DeparturePriorityView {
    generatedAt: string;
    shiftLabel: "SD" | "SN";
    entries: DeparturePriorityEntry[];
}

interface DeparturePriorityCandidate {
    domain: "regulation" | "intervention";
    targetCode: string;
    name: string;
    roleLabel: string | null;
    startedAt: string;
}

function formatHour(value: string | Date) {
    return new Intl.DateTimeFormat("pt-BR", {
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
        timeZone: "America/Sao_Paulo",
    }).format(new Date(value));
}

function compareDeparturePriorityCandidates(left: DeparturePriorityCandidate, right: DeparturePriorityCandidate) {
    const startedAtDiff = new Date(left.startedAt).getTime() - new Date(right.startedAt).getTime();
    if (startedAtDiff !== 0) {
        return startedAtDiff;
    }

    if (left.domain !== right.domain) {
        return left.domain === "intervention" ? -1 : 1;
    }

    return left.domain === "intervention"
        ? compareTelegramInterventionCodes(left.targetCode, right.targetCode)
        : compareTelegramRegulationCodes(left.targetCode, right.targetCode);
}

function isExcludedDepartureRole(roleLabel: string | null) {
    const normalized = normalizeOperationalRoleLabel(roleLabel);
    return normalized === "MRV" || normalized === "RECIP";
}

function buildDeparturePriorityCandidates(params: {
    board: OperationalBoard;
    mealBreakSession: Pick<MealBreakSession, "recipRamal"> | null;
}) {
    const recipRamal = params.mealBreakSession?.recipRamal ?? null;
    const candidates: DeparturePriorityCandidate[] = [];

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
        if (isExcludedDepartureRole(roleLabel) || row.postCode === recipRamal) {
            continue;
        }

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
        });
    }

    for (const row of params.board.intervention) {
        if (row.status !== "active" || !row.doctorId || !row.startedAt) {
            continue;
        }

        const roleLabel = resolveOperationalRoleLabel({
            domain: "intervention",
            code: row.baseCode,
            shiftLabel: row.shiftLabel,
            roleLabel: row.roleLabel,
            defaultRole: null,
        });
        if (isExcludedDepartureRole(roleLabel)) {
            continue;
        }

        candidates.push({
            domain: "intervention",
            targetCode: row.baseCode,
            name: formatDoctorSurfaceName({
                fullName: row.doctorName,
                displayName: row.displayName,
                fallback: row.baseCode,
            }),
            roleLabel,
            startedAt: row.startedAt,
        });
    }

    return candidates.sort(compareDeparturePriorityCandidates);
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
    const header = [
        "📤 PRIORIDADE DE SAIDA",
        `Plantão ${view.shiftLabel}. Fora da conta: saídas já declaradas, MRV e RECIP.`,
    ];

    if (view.entries.length === 0) {
        return [...header, "Sem plantonistas elegíveis no quadro agora."].join("\n");
    }

    const lines = view.entries.map((entry) => `${entry.rank}. ${entry.name} | ${entry.targetCode} | ${formatHour(entry.startedAt)}`);
    return [...header, ...lines].join("\n");
}

export async function getCurrentDeparturePriorityView(params?: {
    referenceAt?: Date;
    board?: OperationalBoard;
    mealBreakSession?: Pick<MealBreakSession, "recipRamal"> | null;
}) {
    const referenceAt = params?.referenceAt ?? new Date();
    const board = params?.board ?? await getOperationalBoard();
    const mealBreakSession = params?.mealBreakSession === undefined
        ? await getCurrentOperationalMealBreakSession(referenceAt)
        : params.mealBreakSession;
    const entries = buildDeparturePriorityCandidates({
        board,
        mealBreakSession,
    }).map((entry, index) => ({
        ...entry,
        rank: index + 1,
    } satisfies DeparturePriorityEntry));

    return {
        generatedAt: board.generatedAt,
        shiftLabel: resolveOperationalShiftWindow(referenceAt).shiftLabel,
        entries,
    } satisfies DeparturePriorityView;
}

export async function runTelegramDeparturePriorityCommand(params?: {
    referenceAt?: Date;
    board?: OperationalBoard;
    mealBreakSession?: Pick<MealBreakSession, "recipRamal"> | null;
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
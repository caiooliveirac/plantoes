"use client";

import { useDeferredValue, useEffect, useEffectEvent, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { buildOperationalRoleChoices, getOperationalRoleTone, resolveFixedOperationalRole, resolveOperationalRoleLabel } from "@/modules/operational/roles";
import type { MealBreakSession, MealBreakLunchSlot, MealBreakRestSlot } from "@/modules/telegram/meal-breaks";
import {
    getSaoPauloParts,
    hasPlannedInterventionCoverageForCurrentShift,
    requiresOvertimeJustification,
    resolveContinuationBadgeLabel,
    shouldHighlightInterventionVerification,
} from "@/modules/operational/board-rules";
import type {
    InterventionBoardRow,
    PreviousOperationalBoard,
    PreviousOperationalBucket,
    PreviousOperationalEntry,
    PreviousOperationalSection,
    RegulationBoardRow,
} from "@/services/board.service";

type UserRole = "admin" | "chief";
type ActionMode = "correct" | "end" | "start";
type PriorityLevel = "critical" | "high" | "elevated" | "steady";

const COI_CODES = new Set(["1366", "1367", "1368"]);
const MRV_DAY_CODES = new Set(["2032", "2151"]);

interface DoctorOption {
    id: string;
    fullName: string;
    displayName: string | null;
}

interface SessionSummary {
    email: string;
    roles: UserRole[];
    mustChangePassword: boolean;
    canManage: boolean;
}

interface RegulationCard extends RegulationBoardRow {
    domain: "regulation";
}

interface InterventionCard extends InterventionBoardRow {
    domain: "intervention";
}

type BoardCard = RegulationCard | InterventionCard;

interface OperationalBoardClientProps {
    generatedAt: string;
    shiftLabel: string;
    regulation: RegulationBoardRow[];
    intervention: InterventionBoardRow[];
    mealBreakSession: MealBreakSession | null;
    previousShift: PreviousOperationalBoard;
    doctors: DoctorOption[];
    session: SessionSummary | null;
}

interface FormState {
    doctorId: string;
    startedAt: string;
    endedAt: string;
    roleLabel: string;
    ramalLabel: string;
    notes: string;
}

interface AuthResponse {
    error?: string;
    session?: {
        user?: {
            mustChangePassword?: boolean;
        };
    };
}

type RobotStatusTone = "live" | "attention" | "idle";

function formatBoardDateLabel(value: string) {
    return new Date(value).toLocaleDateString("pt-BR", {
        weekday: "long",
        day: "2-digit",
        month: "long",
        timeZone: "America/Sao_Paulo",
    });
}

function formatShiftHeadline(value: string) {
    if (value === "SD") {
        return "Plantão diurno";
    }
    if (value === "SN") {
        return "Plantão noturno";
    }
    if (value === "P") {
        return "Plantão contínuo";
    }

    return `Plantão ${value}`;
}

function resolveRobotStatus(session: MealBreakSession | null) {
    if (!session) {
        return {
            tone: "idle" as RobotStatusTone,
            label: "Sem fluxo de almoço",
            copy: "Bot sem sessão aberta para almoço e descanso neste momento.",
        };
    }

    if (session.stage === "completed") {
        return {
            tone: "live" as RobotStatusTone,
            label: "Fluxo fechado",
            copy: "Almoço e descanso já distribuídos para a regulação no turno atual.",
        };
    }

    return {
        tone: "attention" as RobotStatusTone,
        label: "Fluxo em andamento",
        copy: "Bot conduzindo almoço e descanso da regulação por ordem operacional.",
    };
}

function resolveMealBreakSlot<TSlot extends MealBreakLunchSlot | MealBreakRestSlot>(
    session: MealBreakSession | null,
    ramal: string,
    assignmentType: "lunchAssignments" | "restAssignments",
) {
    if (!session) {
        return null;
    }

    return session[assignmentType][ramal] as TSlot | undefined ?? null;
}

function isRecipRamal(session: MealBreakSession | null, ramal: string) {
    return session?.recipRamal === ramal;
}

function isMrvRamal(session: MealBreakSession | null, ramal: string) {
    return Boolean(session?.mrvRamals.includes(ramal as MealBreakSession["mrvRamals"][number]));
}

function formatBoardTime(value: string | null) {
    if (!value) {
        return "--:--";
    }

    return new Date(value).toLocaleTimeString("pt-BR", {
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
        timeZone: "America/Sao_Paulo",
    });
}

function formatDateTimeDetail(value: string | null) {
    if (!value) {
        return "Nao informado";
    }

    return new Date(value).toLocaleString("pt-BR", {
        day: "2-digit",
        month: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
        timeZone: "America/Sao_Paulo",
    });
}

function formatOperationalDayLabel(value: string | null) {
    if (!value) {
        return "Nao informado";
    }

    return new Date(value).toLocaleDateString("pt-BR", {
        day: "2-digit",
        month: "2-digit",
        timeZone: "America/Sao_Paulo",
    });
}

function formatSectionTimestamp(value: string) {
    return new Date(value).toLocaleTimeString("pt-BR", {
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
        timeZone: "America/Sao_Paulo",
    });
}

function formatShiftMeta(value: string) {
    if (value === "SD") {
        return "Diurno";
    }
    if (value === "SN") {
        return "Noturno";
    }
    if (value === "P") {
        return "Plantao";
    }

    return value || "Operacao";
}

function formatPreviousBucketMeta(value: PreviousOperationalBucket) {
    if (value === "P_INVERTIDO") {
        return "P invertido";
    }

    return formatShiftMeta(value);
}

function normalizeSearchValue(value: string) {
    return value
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase()
        .trim();
}

function toLocalDateTimeValue(value?: string | null) {
    const date = value ? new Date(value) : new Date();
    const safeDate = Number.isNaN(date.getTime()) ? new Date() : date;
    const local = new Date(safeDate.getTime() - safeDate.getTimezoneOffset() * 60000);
    return local.toISOString().slice(0, 16);
}

function toIsoDateTime(value: string) {
    return new Date(value).toISOString();
}

function trimToNull(value: string) {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
}

function translateAuthError(code?: string) {
    if (code === "invalid_credentials") {
        return "Email ou senha invalidos.";
    }
    if (code === "inactive_account") {
        return "Conta inativa. Procure um admin.";
    }
    if (code === "no_roles_assigned") {
        return "Conta sem papel operacional ativo.";
    }
    if (code === "pending_chief_approval") {
        return "Cadastro pendente de aprovacao do admin.";
    }
    if (code === "rejected_chief_approval") {
        return "Cadastro rejeitado. Solicite nova validacao ao admin.";
    }
    return "Nao foi possivel autenticar agora.";
}

function summarizeRoles(roles: UserRole[]) {
    if (roles.includes("admin")) {
        return roles.includes("chief") ? "Admin e chief" : "Admin";
    }

    return "Chief";
}

function doctorOptionLabel(doctor: DoctorOption) {
    return doctor.displayName ? `${doctor.displayName} - ${doctor.fullName}` : doctor.fullName;
}

function matchesDoctorQuery(doctor: DoctorOption, query: string) {
    const normalizedQuery = query.trim().toLowerCase();
    if (!normalizedQuery) {
        return false;
    }

    const haystack = [doctor.fullName, doctor.displayName ?? ""]
        .join(" ")
        .toLowerCase();

    return normalizedQuery
        .split(/\s+/)
        .filter(Boolean)
        .every((token) => haystack.includes(token));
}

function displayDoctorName(card: BoardCard) {
    if (card.domain === "intervention" && card.status === "waiting") {
        return "Aguardando cobertura";
    }

    return card.displayName || card.doctorName || "Aguardando confirmação";
}

function canEditActiveCard(card: BoardCard) {
    return Boolean(card.occupancyId);
}

function minutesSince(referenceIso: string, value: string | null) {
    if (!value) {
        return null;
    }

    const diffMs = new Date(referenceIso).getTime() - new Date(value).getTime();
    if (Number.isNaN(diffMs)) {
        return null;
    }

    return Math.max(0, Math.floor(diffMs / 60000));
}

function formatMinutesLabel(minutes: number | null) {
    if (minutes === null) {
        return "Sem marcação";
    }

    if (minutes < 60) {
        return `${minutes} min`;
    }

    const hours = Math.floor(minutes / 60);
    const remainder = minutes % 60;
    return remainder === 0 ? `${hours} h` : `${hours} h ${remainder} min`;
}

function formatSignedMinutesLabel(minutes: number | null) {
    if (minutes === null) {
        return "Sem banco";
    }

    if (minutes === 0) {
        return "0 min";
    }

    const absolute = formatMinutesLabel(Math.abs(minutes));
    return `${minutes > 0 ? "+" : "-"}${absolute}`;
}

function formatContributionLabel(minutes: number | null) {
    if (minutes === null) {
        return "Sem fechamento";
    }

    if (minutes === 0) {
        return "0 min";
    }

    return `${minutes > 0 ? "+" : "-"}${formatMinutesLabel(Math.abs(minutes))}`;
}

function formatWindowLabel(startAt: string | null, endAt: string | null) {
    if (!startAt || !endAt) {
        return "Janela pendente";
    }

    return `${formatDateTimeDetail(startAt)} ate ${formatDateTimeDetail(endAt)}`;
}

function formatHistoryStatus(entry: PreviousOperationalEntry) {
    return entry.status === "open" ? "Responsabilidade em aberto" : "Responsabilidade encerrada";
}

function historyEntrySupportMeta(entry: PreviousOperationalEntry) {
    if (entry.domain === "regulation") {
        return resolveOperationalRoleLabel({
            domain: "regulation",
            code: entry.targetCode,
            shiftLabel: entry.shiftLabel,
            roleLabel: entry.roleLabel,
        }) ?? entry.ramalLabel ?? "Mesa operacional";
    }

    return resolveOperationalRoleLabel({
        domain: "intervention",
        code: entry.targetCode,
        shiftLabel: entry.shiftLabel,
        roleLabel: entry.roleLabel,
    }) ?? "Base operacional";
}

function historyBalanceClass(value: number | null) {
    if (value === null || value === 0) {
        return "neutral";
    }

    return value > 0 ? "positive" : "negative";
}

function historyTimingLabels(bucket: PreviousOperationalBucket) {
    if (bucket === "P") {
        return {
            arrival: "Assumiu no SD",
            departure: "Entregou no SN",
            emphasis: "Mesmo com atraso ou adiantamento, esta pessoa respondeu pelo plantao atravessando SD e SN.",
            responsibility: "Responsavel pelo P",
        };
    }

    if (bucket === "P_INVERTIDO") {
        return {
            arrival: "Assumiu no SN",
            departure: "Entregou no SD",
            emphasis: "Mesmo com atraso ou adiantamento, esta pessoa respondeu pelo plantao invertido entre SN e SD.",
            responsibility: "Responsavel pelo P invertido",
        };
    }

    return {
        arrival: bucket === "SN" ? "Assumiu o SN" : "Assumiu o SD",
        departure: bucket === "SN" ? "Entregou o SN" : "Entregou o SD",
        emphasis: bucket === "SN"
            ? "O chefe consulta aqui quem respondeu pelo SN, independentemente de entrar antes ou depois das 19h."
            : "O chefe consulta aqui quem respondeu pelo SD, independentemente de entrar antes ou depois do previsto.",
        responsibility: bucket === "SN" ? "Responsavel pelo SN" : "Responsavel pelo SD",
    };
}

function matchesPreviousShiftQuery(entry: PreviousOperationalEntry, query: string) {
    const normalizedQuery = normalizeSearchValue(query);
    if (!normalizedQuery) {
        return true;
    }

    const haystack = normalizeSearchValue([
        entry.displayName ?? entry.doctorName,
        entry.doctorName,
        entry.targetCode,
        entry.targetLabel,
        entry.domain === "regulation" ? "regulacao" : "intervencao",
        entry.ruleCode ?? "",
    ].join(" "));

    return normalizedQuery
        .split(/\s+/)
        .filter(Boolean)
        .every((token) => haystack.includes(token));
}

function compareHistoryEntriesByDoctor(left: PreviousOperationalEntry, right: PreviousOperationalEntry) {
    const leftDoctor = left.displayName ?? left.doctorName;
    const rightDoctor = right.displayName ?? right.doctorName;
    const doctorComparison = leftDoctor.localeCompare(rightDoctor, "pt-BR");
    if (doctorComparison !== 0) {
        return doctorComparison;
    }

    return left.targetCode.localeCompare(right.targetCode, "pt-BR");
}

function resolvePriority(card: BoardCard, generatedAt: string): PriorityLevel {
    if (card.status === "waiting") {
        return "critical";
    }

    const ageMinutes = minutesSince(generatedAt, card.startedAt);
    if (ageMinutes !== null && ageMinutes >= 720) {
        return "high";
    }
    if (ageMinutes !== null && ageMinutes >= 300) {
        return "elevated";
    }
    return "steady";
}

function priorityLabel(priority: PriorityLevel) {
    if (priority === "critical") {
        return "critico";
    }
    if (priority === "high") {
        return "vigiar";
    }
    if (priority === "elevated") {
        return "atencao";
    }
    return "estavel";
}

function priorityCopy(card: BoardCard, generatedAt: string) {
    const priority = resolvePriority(card, generatedAt);
    if (priority === "critical") {
        return "Sem cobertura confirmada. Chefia precisa agir agora.";
    }
    if (priority === "high") {
        return `Cobertura longa em curso: ${formatMinutesLabel(minutesSince(generatedAt, card.startedAt))}.`;
    }
    if (priority === "elevated") {
        return `Em acompanhamento ha ${formatMinutesLabel(minutesSince(generatedAt, card.startedAt))}.`;
    }
    return "Cobertura dentro do ritmo atual da operacao.";
}

function buildInitialForm(card: BoardCard) {
    return {
        doctorId: card.doctorId ?? "",
        startedAt: toLocalDateTimeValue(card.startedAt),
        endedAt: toLocalDateTimeValue(),
        roleLabel: resolveOperationalRoleLabel({
            domain: card.domain,
            code: cardCode(card),
            shiftLabel: card.shiftLabel,
            roleLabel: card.roleLabel,
            defaultRole: card.domain === "regulation" ? card.defaultRole : null,
        }) ?? "",
        ramalLabel: card.domain === "regulation" ? card.ramalLabel ?? card.postCode : "",
        notes: "",
    } satisfies FormState;
}

function resolveCardRoleLabel(card: BoardCard) {
    return resolveOperationalRoleLabel({
        domain: card.domain,
        code: cardCode(card),
        shiftLabel: card.shiftLabel,
        roleLabel: card.roleLabel,
        defaultRole: card.domain === "regulation" ? card.defaultRole : null,
    });
}

function resolveCardFixedRole(card: BoardCard) {
    return resolveFixedOperationalRole({
        domain: card.domain,
        code: cardCode(card),
        shiftLabel: card.shiftLabel,
    });
}

function renderRoleBadge(roleLabel: string | null | undefined) {
    const normalized = roleLabel?.trim();
    if (!normalized) {
        return null;
    }

    return <span className={`ops-role-badge ${getOperationalRoleTone(normalized)}`.trim()}>{normalized}</span>;
}

function cardCode(card: BoardCard) {
    return card.domain === "regulation" ? card.postCode : card.baseCode;
}

function cardLabel(card: BoardCard) {
    return card.domain === "regulation" ? card.postLabel : card.baseLabel;
}

function extractTrailingNumber(value: string) {
    const match = value.match(/(\d+)$/);
    return match ? Number(match[1]) : Number.POSITIVE_INFINITY;
}

function regulationSortRank(code: string, shiftLabel: string) {
    if (code === "2031") {
        return 0;
    }

    if (shiftLabel === "SD" && code === "2151") {
        return 1;
    }

    if (shiftLabel === "SD" && code === "2032") {
        return 2;
    }

    if (code.startsWith("1")) {
        return 4;
    }

    return 3;
}

function compareRegulationCards(left: RegulationCard, right: RegulationCard, shiftLabel: string) {
    const leftRank = regulationSortRank(left.postCode, shiftLabel);
    const rightRank = regulationSortRank(right.postCode, shiftLabel);
    if (leftRank !== rightRank) {
        return leftRank - rightRank;
    }

    return Number(left.postCode) - Number(right.postCode);
}

function isInterventionAwaitingNews(card: BoardCard, generatedAt: string) {
    const hasPlannedCoverage = card.domain === "intervention"
        && hasPlannedInterventionCoverageForCurrentShift({
            shiftLabel: card.shiftLabel,
            scheduledEndAt: card.scheduledEndAt,
            reference: generatedAt,
        });

    return card.domain === "intervention"
        && card.status === "active"
        && !hasPlannedCoverage
        && shouldHighlightInterventionVerification(card.boardStartedAt ?? card.startedAt, generatedAt, card.shiftLabel);
}

function canContinueIntervention(card: BoardCard, generatedAt: string) {
    return card.domain === "intervention"
        && card.status === "active"
        && Boolean(card.occupancyId)
        && isInterventionAwaitingNews(card, generatedAt);
}

function requiresReasonForContinuation(card: BoardCard, generatedAt: string) {
    return card.domain === "intervention" && requiresOvertimeJustification(card.startedAt, generatedAt);
}

function rowEmphasisClass(card: BoardCard, shiftLabel: string, generatedAt: string) {
    if (card.domain === "intervention" && card.status === "waiting") {
        return "emphasis-waiting";
    }

    if (isInterventionAwaitingNews(card, generatedAt)) {
        return "emphasis-verification";
    }

    if (card.domain !== "regulation") {
        return "";
    }

    if (COI_CODES.has(card.postCode)) {
        return "emphasis-coi";
    }

    if (shiftLabel === "SD" && MRV_DAY_CODES.has(card.postCode)) {
        return "emphasis-mrv-day";
    }

    return "";
}

function rowAccentLabel(card: BoardCard, shiftLabel: string, generatedAt: string) {
    if (isInterventionAwaitingNews(card, generatedAt)) {
        return "Verificar";
    }

    if (card.domain !== "regulation") {
        return null;
    }

    if (COI_CODES.has(card.postCode)) {
        return "COI";
    }

    if (shiftLabel === "SD" && MRV_DAY_CODES.has(card.postCode)) {
        return "MRV";
    }

    return null;
}

function actionTitle(mode: ActionMode, card: BoardCard) {
    if (mode === "start") {
        return `Abrir cobertura em ${cardCode(card)}`;
    }
    if (mode === "end") {
        return `Encerrar cobertura em ${cardCode(card)}`;
    }
    return `Corrigir quadro de ${cardCode(card)}`;
}

type BoardSnapshot = {
    generatedAt?: string;
};

export function OperationalBoardClient(props: OperationalBoardClientProps) {
    const { generatedAt, shiftLabel, regulation, intervention, mealBreakSession, previousShift, doctors, session } = props;
    const router = useRouter();
    const [authOpen, setAuthOpen] = useState(false);
    const [previousShiftOpen, setPreviousShiftOpen] = useState(false);
    const [authEmail, setAuthEmail] = useState("");
    const [authPassword, setAuthPassword] = useState("");
    const [previousShiftQuery, setPreviousShiftQuery] = useState("");
    const [authError, setAuthError] = useState<string | null>(null);
    const [authInfo, setAuthInfo] = useState<string | null>(null);
    const [isAuthSubmitting, setIsAuthSubmitting] = useState(false);
    const [currentPasswordInput, setCurrentPasswordInput] = useState("");
    const [nextPasswordInput, setNextPasswordInput] = useState("");
    const [confirmPasswordInput, setConfirmPasswordInput] = useState("");
    const [isPasswordChanging, setIsPasswordChanging] = useState(false);
    const [drawerOpen, setDrawerOpen] = useState(false);
    const [selectedCard, setSelectedCard] = useState<BoardCard | null>(null);
    const [actionMode, setActionMode] = useState<ActionMode | null>(null);
    const [formState, setFormState] = useState<FormState>({
        doctorId: "",
        startedAt: toLocalDateTimeValue(),
        endedAt: toLocalDateTimeValue(),
        roleLabel: "",
        ramalLabel: "",
        notes: "",
    });
    const [doctorQuery, setDoctorQuery] = useState("");
    const deferredDoctorQuery = useDeferredValue(doctorQuery);
    const deferredPreviousShiftQuery = useDeferredValue(previousShiftQuery);
    const [quickExitAt, setQuickExitAt] = useState(toLocalDateTimeValue());
    const [quickExitReason, setQuickExitReason] = useState("");
    const [errorMessage, setErrorMessage] = useState<string | null>(null);
    const [successMessage, setSuccessMessage] = useState<string | null>(null);
    const [headerMessage, setHeaderMessage] = useState<string | null>(null);
    const [isSubmitting, setIsSubmitting] = useState(false);
    const [isRefreshing, startRefresh] = useTransition();
    const latestGeneratedAtRef = useRef(generatedAt);

    useEffect(() => {
        latestGeneratedAtRef.current = generatedAt;
    }, [generatedAt]);

    useEffect(() => {
        if (session) {
            if (!session.mustChangePassword) {
                setAuthPassword("");
            }
            setAuthError(null);
            setAuthInfo(null);
        }
    }, [session]);

    useEffect(() => {
        if (!session) {
            setCurrentPasswordInput("");
            setNextPasswordInput("");
            setConfirmPasswordInput("");
            return;
        }

        if (session.mustChangePassword) {
            setAuthOpen(true);
            setAuthInfo("Senha temporaria detectada. Troque a senha antes de operar o quadro.");
        }
    }, [session]);

    const refreshIfBoardChanged = useEffectEvent(async () => {
        if (drawerOpen || isSubmitting || isRefreshing) {
            return;
        }

        try {
            const response = await fetch("/api/board", {
                cache: "no-store",
                headers: { "Accept": "application/json" },
            });

            if (!response.ok) {
                return;
            }

            const snapshot = await response.json() as BoardSnapshot;
            if (!snapshot.generatedAt || snapshot.generatedAt === latestGeneratedAtRef.current) {
                return;
            }

            startRefresh(() => {
                router.refresh();
            });
        } catch {
            return;
        }
    });

    useEffect(() => {
        let fallbackIntervalId: number | null = null;
        let reconnectTimeoutId: number | null = null;

        const startFallbackPolling = () => {
            if (fallbackIntervalId !== null) {
                return;
            }

            fallbackIntervalId = window.setInterval(() => {
                void refreshIfBoardChanged();
            }, 30000);
        };

        const stopFallbackPolling = () => {
            if (fallbackIntervalId === null) {
                return;
            }

            window.clearInterval(fallbackIntervalId);
            fallbackIntervalId = null;
        };

        let eventSource: EventSource | null = null;
        const connect = () => {
            eventSource = new EventSource("/api/board/stream");

            eventSource.addEventListener("ready", () => {
                stopFallbackPolling();
            });

            eventSource.addEventListener("board-update", () => {
                void refreshIfBoardChanged();
            });

            eventSource.onerror = () => {
                eventSource?.close();
                eventSource = null;
                startFallbackPolling();

                if (reconnectTimeoutId !== null) {
                    window.clearTimeout(reconnectTimeoutId);
                }

                reconnectTimeoutId = window.setTimeout(() => {
                    connect();
                }, 5000);
            };
        };

        connect();
        const intervalId = window.setInterval(() => {
            void refreshIfBoardChanged();
        }, 120000);

        return () => {
            eventSource?.close();
            stopFallbackPolling();
            if (reconnectTimeoutId !== null) {
                window.clearTimeout(reconnectTimeoutId);
            }
            window.clearInterval(intervalId);
        };
    }, [refreshIfBoardChanged]);

    const regulationCards: RegulationCard[] = regulation.map((row) => ({ ...row, domain: "regulation" }));
    const interventionCards: InterventionCard[] = intervention.map((row) => ({ ...row, domain: "intervention" }));
    const visibleRegulationCards = regulationCards
        .filter((card) => card.status === "active" && Boolean(card.doctorId))
        .sort((left, right) => compareRegulationCards(left, right, shiftLabel));
    const visibleInterventionCards = interventionCards
        .filter((card) => (card.status === "active" && Boolean(card.doctorId)) || card.status === "waiting")
        .sort((left, right) => extractTrailingNumber(left.baseCode) - extractTrailingNumber(right.baseCode));
    const allCards: BoardCard[] = [...visibleRegulationCards, ...visibleInterventionCards];
    const robotStatus = resolveRobotStatus(mealBreakSession);
    const regulationLunchDefinedCount = visibleRegulationCards.filter((card) => Boolean(resolveMealBreakSlot(mealBreakSession, card.postCode, "lunchAssignments"))).length;
    const regulationRestDefinedCount = visibleRegulationCards.filter((card) => Boolean(resolveMealBreakSlot(mealBreakSession, card.postCode, "restAssignments"))).length;
    const regulationLunchPendingCount = Math.max(0, visibleRegulationCards.length - regulationLunchDefinedCount);
    const regulationRestPendingCount = Math.max(0, visibleRegulationCards.length - regulationRestDefinedCount);
    const interventionWaitingCount = visibleInterventionCards.filter((card) => card.status === "waiting").length;
    const interventionActiveCount = visibleInterventionCards.length - interventionWaitingCount;
    const criticalCards = allCards.filter((card) => resolvePriority(card, generatedAt) === "critical");
    const watchCards = allCards.filter((card) => resolvePriority(card, generatedAt) === "high");
    const previousShiftSections = previousShift.sections.map((section) => ({
        ...section,
        entries: section.entries
            .filter((entry) => matchesPreviousShiftQuery(entry, deferredPreviousShiftQuery))
            .sort(compareHistoryEntriesByDoctor),
    }));
    const filteredPreviousShiftTotal = previousShiftSections.reduce((total, section) => total + section.entries.length, 0);
    const selectedDoctor = doctors.find((doctor) => doctor.id === formState.doctorId) ?? null;
    const filteredDoctors = doctors
        .filter((doctor) => matchesDoctorQuery(doctor, deferredDoctorQuery))
        .slice(0, 8);
    const doctorSelectionLocked = Boolean(selectedDoctor && doctorQuery.trim() === doctorOptionLabel(selectedDoctor));

    useEffect(() => {
        if (!headerMessage) {
            return;
        }

        const timeoutId = window.setTimeout(() => {
            setHeaderMessage(null);
        }, 3200);

        return () => window.clearTimeout(timeoutId);
    }, [headerMessage]);

    function resetDrawerFeedback() {
        setErrorMessage(null);
        setSuccessMessage(null);
    }

    function syncSelectedDoctorLabel(doctorId: string | null | undefined) {
        const doctor = doctors.find((entry) => entry.id === doctorId) ?? null;
        setDoctorQuery(doctor ? doctorOptionLabel(doctor) : "");
    }

    function openDrawer(card?: BoardCard) {
        setDrawerOpen(true);
        if (card) {
            setSelectedCard(card);
            setActionMode(card.status === "waiting" ? "start" : canEditActiveCard(card) ? "correct" : null);
            if (card.status === "waiting" || canEditActiveCard(card)) {
                setFormState(buildInitialForm(card));
                syncSelectedDoctorLabel(card.doctorId ?? null);
            }
            setQuickExitAt(toLocalDateTimeValue());
            setQuickExitReason("");
        }
        resetDrawerFeedback();
    }

    function openAction(card: BoardCard, mode: ActionMode) {
        if (mode !== "start" && !canEditActiveCard(card)) {
            setSelectedCard(card);
            setActionMode(null);
            setDrawerOpen(true);
            resetDrawerFeedback();
            return;
        }

        setSelectedCard(card);
        setActionMode(mode);
        setFormState(buildInitialForm(card));
        syncSelectedDoctorLabel(card.doctorId ?? null);
        setQuickExitAt(toLocalDateTimeValue());
        setQuickExitReason("");
        setDrawerOpen(true);
        resetDrawerFeedback();
    }

    function closeDrawer() {
        setDrawerOpen(false);
        setActionMode(null);
        setSelectedCard(null);
        setDoctorQuery("");
        setQuickExitReason("");
    }

    async function handleAuthSubmit(event: React.FormEvent<HTMLFormElement>) {
        event.preventDefault();

        try {
            setIsAuthSubmitting(true);
            setAuthError(null);
            setAuthInfo(null);

            const response = await fetch("/api/auth/login", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    email: authEmail.trim().toLowerCase(),
                    password: authPassword,
                }),
            });

            const body = await response.json().catch(() => null) as AuthResponse | null;
            if (!response.ok) {
                throw new Error(translateAuthError(body?.error));
            }

            const passwordChangeRequired = Boolean(body?.session?.user?.mustChangePassword);
            if (!passwordChangeRequired) {
                setAuthPassword("");
                setAuthOpen(false);
            }
            setAuthInfo(passwordChangeRequired
                ? "Sessao iniciada com senha temporaria. Troque a senha para liberar a operacao."
                : "Sessao iniciada. Atualizando controles operacionais.");
            startRefresh(() => {
                router.refresh();
            });
        } catch (error) {
            setAuthError(error instanceof Error ? error.message : "Nao foi possivel autenticar agora.");
        } finally {
            setIsAuthSubmitting(false);
        }
    }

    async function handleLogout() {
        try {
            setIsAuthSubmitting(true);
            setAuthError(null);
            setAuthInfo(null);

            const response = await fetch("/api/auth/logout", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
            });

            if (!response.ok) {
                throw new Error("Nao foi possivel encerrar a sessao.");
            }

            setAuthOpen(false);
            setAuthPassword("");
            setCurrentPasswordInput("");
            setNextPasswordInput("");
            setConfirmPasswordInput("");
            setAuthInfo("Sessao encerrada. O quadro voltou para modo leitura.");
            startRefresh(() => {
                router.refresh();
            });
        } catch (error) {
            setAuthError(error instanceof Error ? error.message : "Nao foi possivel encerrar a sessao.");
        } finally {
            setIsAuthSubmitting(false);
        }
    }

    async function handleChangePassword(event: React.FormEvent<HTMLFormElement>) {
        event.preventDefault();

        if (!session) {
            setAuthError("Sessao expirada. Entre novamente.");
            return;
        }

        if (nextPasswordInput !== confirmPasswordInput) {
            setAuthError("A confirmacao da nova senha nao confere.");
            return;
        }

        try {
            setIsPasswordChanging(true);
            setAuthError(null);
            setAuthInfo(null);

            const response = await fetch("/api/auth/change-password", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    currentPassword: currentPasswordInput,
                    nextPassword: nextPasswordInput,
                }),
            });

            const body = await response.json().catch(() => null) as { error?: string } | null;
            if (!response.ok) {
                throw new Error(body?.error || "Nao foi possivel trocar a senha agora.");
            }

            setAuthPassword("");
            setCurrentPasswordInput("");
            setNextPasswordInput("");
            setConfirmPasswordInput("");
            setAuthInfo("Senha atualizada. Liberando a operacao do quadro.");
            startRefresh(() => {
                router.refresh();
            });
        } catch (error) {
            setAuthError(error instanceof Error ? error.message : "Nao foi possivel trocar a senha agora.");
        } finally {
            setIsPasswordChanging(false);
        }
    }

    async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
        event.preventDefault();

        if (!selectedCard || !actionMode) {
            return;
        }
        if (!session?.canManage) {
            setErrorMessage("Entre com perfil chief ou admin para operar correções e encerramentos.");
            return;
        }

        try {
            setIsSubmitting(true);
            setErrorMessage(null);
            setSuccessMessage(null);

            let endpoint = "";
            let method = "POST";
            let payload: Record<string, unknown> = {};

            if (actionMode === "correct") {
                if (!selectedCard.occupancyId) {
                    throw new Error("Nao existe ocupacao ativa para corrigir neste card.");
                }

                const startedAtChanged = Boolean(
                    selectedCard.startedAt
                    && toIsoDateTime(formState.startedAt) !== new Date(selectedCard.startedAt).toISOString(),
                );
                if (startedAtChanged && !trimToNull(formState.notes)) {
                    throw new Error("Digite o motivo antes de corrigir horario.");
                }

                endpoint = selectedCard.domain === "regulation"
                    ? `/api/regulation/occupancies/${selectedCard.occupancyId}`
                    : `/api/intervention/occupancies/${selectedCard.occupancyId}`;
                method = "PATCH";
                payload = {
                    doctorId: formState.doctorId || undefined,
                    startedAt: toIsoDateTime(formState.startedAt),
                    boardStartedAt: toIsoDateTime(formState.startedAt),
                    roleLabel: trimToNull(formState.roleLabel),
                    notes: trimToNull(formState.notes),
                    ...(selectedCard.domain === "regulation" ? { ramalLabel: trimToNull(formState.ramalLabel) } : {}),
                };
            }

            if (actionMode === "end") {
                if (!selectedCard.occupancyId) {
                    throw new Error("Nao existe ocupacao ativa para encerrar neste card.");
                }

                endpoint = selectedCard.domain === "regulation"
                    ? `/api/regulation/occupancies/${selectedCard.occupancyId}/end`
                    : canContinueIntervention(selectedCard, generatedAt)
                        ? `/api/intervention/occupancies/${selectedCard.occupancyId}/report-departure`
                        : `/api/intervention/occupancies/${selectedCard.occupancyId}/end`;
                payload = {
                    endedAt: toIsoDateTime(formState.endedAt),
                    actualEndedAt: toIsoDateTime(formState.endedAt),
                    notes: trimToNull(formState.notes),
                };

                if (
                    selectedCard.domain === "intervention"
                    && canContinueIntervention(selectedCard, generatedAt)
                    && requiresOvertimeJustification(selectedCard.startedAt, toIsoDateTime(formState.endedAt))
                    && !trimToNull(formState.notes)
                ) {
                    throw new Error("Justificativa obrigatoria para registrar saida apos 07:15 ou 19:15.");
                }
            }

            if (actionMode === "start") {
                if (!formState.doctorId) {
                    throw new Error("Selecione um medico para abrir a cobertura.");
                }

                endpoint = selectedCard.domain === "regulation"
                    ? "/api/regulation/occupancies"
                    : "/api/intervention/occupancies";
                payload = selectedCard.domain === "regulation"
                    ? {
                        doctorId: formState.doctorId,
                        postId: selectedCard.postId,
                        startedAt: toIsoDateTime(formState.startedAt),
                        scheduledStartAt: null,
                        scheduledEndAt: null,
                        shiftLabel,
                        roleLabel: trimToNull(formState.roleLabel),
                        ramalLabel: trimToNull(formState.ramalLabel) ?? selectedCard.postCode,
                        source: "admin_correction",
                        notes: trimToNull(formState.notes),
                    }
                    : {
                        doctorId: formState.doctorId,
                        baseId: selectedCard.baseId,
                        startedAt: toIsoDateTime(formState.startedAt),
                        scheduledStartAt: null,
                        scheduledEndAt: null,
                        shiftLabel,
                        roleLabel: trimToNull(formState.roleLabel),
                        source: "admin_correction",
                        notes: trimToNull(formState.notes),
                    };
            }

            const response = await fetch(endpoint, {
                method,
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(payload),
            });

            const responseBody = await response.json().catch(() => null) as { error?: string } | null;
            if (!response.ok) {
                throw new Error(responseBody?.error || "Falha ao aplicar a acao operacional.");
            }

            setSuccessMessage(
                actionMode === "end"
                    ? (selectedCard.domain === "intervention" && canContinueIntervention(selectedCard, generatedAt)
                        ? "Saida registrada com trilha operacional especifica e quadro atualizado."
                        : "Cobertura encerrada e quadro atualizado.")
                    : "Acao aplicada. Atualizando o quadro operacional.",
            );
            setActionMode(null);
            setSelectedCard(null);
            startRefresh(() => {
                router.refresh();
            });
        } catch (error) {
            setErrorMessage(error instanceof Error ? error.message : "Falha operacional inesperada.");
        } finally {
            setIsSubmitting(false);
        }
    }

    async function handleQuickDeparture(card: BoardCard) {
        if (!session?.canManage) {
            setErrorMessage("Entre com perfil chief ou admin para registrar saida.");
            return;
        }

        if (!card.occupancyId) {
            setErrorMessage("Nao existe ocupacao ativa para registrar saida neste card.");
            return;
        }

        if (!trimToNull(quickExitReason)) {
            setErrorMessage("Digite o motivo antes de registrar a saida.");
            return;
        }

        try {
            setIsSubmitting(true);
            setErrorMessage(null);
            setSuccessMessage(null);

            const endpoint = card.domain === "regulation"
                ? `/api/regulation/occupancies/${card.occupancyId}/end`
                : canContinueIntervention(card, generatedAt)
                    ? `/api/intervention/occupancies/${card.occupancyId}/report-departure`
                    : `/api/intervention/occupancies/${card.occupancyId}/end`;

            const response = await fetch(endpoint, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    endedAt: toIsoDateTime(quickExitAt),
                    actualEndedAt: toIsoDateTime(quickExitAt),
                    notes: trimToNull(quickExitReason),
                }),
            });

            const responseBody = await response.json().catch(() => null) as { error?: string } | null;
            if (!response.ok) {
                throw new Error(responseBody?.error || "Falha ao registrar saida.");
            }

            setQuickExitReason("");
            setSuccessMessage("Saida registrada com auditoria operacional e quadro atualizado.");
            setActionMode(null);
            setSelectedCard(null);
            startRefresh(() => {
                router.refresh();
            });
        } catch (error) {
            setErrorMessage(error instanceof Error ? error.message : "Falha operacional inesperada.");
        } finally {
            setIsSubmitting(false);
        }
    }

    async function handleContinueCard(card: BoardCard) {
        if (!session?.canManage) {
            setErrorMessage("Entre com perfil chief ou admin para confirmar continuidade.");
            return;
        }

        if (card.domain !== "intervention" || !card.occupancyId) {
            setErrorMessage("A continuidade so pode ser confirmada em ocupacao ativa de intervencao.");
            return;
        }

        if (requiresReasonForContinuation(card, generatedAt) && !trimToNull(formState.notes)) {
            setErrorMessage("Justificativa obrigatoria para liberar continuidade apos 07:15 ou 19:15.");
            return;
        }

        try {
            setIsSubmitting(true);
            setErrorMessage(null);
            setSuccessMessage(null);

            const response = await fetch(`/api/intervention/occupancies/${card.occupancyId}/continue`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    notes: trimToNull(formState.notes),
                }),
            });

            const responseBody = await response.json().catch(() => null) as { error?: string } | null;
            if (!response.ok) {
                throw new Error(responseBody?.error || "Falha ao registrar continuidade do plantao.");
            }

            setSuccessMessage("Continuidade confirmada e persistida no quadro.");
            startRefresh(() => {
                router.refresh();
            });
        } catch (error) {
            setErrorMessage(error instanceof Error ? error.message : "Falha operacional inesperada.");
        } finally {
            setIsSubmitting(false);
        }
    }

    function renderScheduleChip(params: {
        slot: string | null;
        kind: "lunch" | "rest";
        pending?: boolean;
    }) {
        if (!params.slot) {
            return <span className={`ops-slot-chip pending ${params.kind}`.trim()}>{params.kind === "lunch" ? "Pendente" : "Pendente"}</span>;
        }

        return <span className={`ops-slot-chip ${params.kind}`.trim()}>{params.slot}</span>;
    }

    function renderOperationalBadges(card: RegulationCard) {
        const items: React.ReactNode[] = [];
        const roleLabel = resolveCardRoleLabel(card);

        if (isRecipRamal(mealBreakSession, card.postCode)) {
            items.push(<span key="recip" className="ops-inline-flag recip">Receptor</span>);
        }
        if (isMrvRamal(mealBreakSession, card.postCode)) {
            items.push(<span key="mrv" className="ops-inline-flag mrv">Vermelhinho</span>);
        }

        if (roleLabel) {
            items.push(<span key={`role-${card.postCode}`} className={`ops-role-badge ${getOperationalRoleTone(roleLabel)}`.trim()}>{roleLabel}</span>);
        }

        return items.length > 0 ? <div className="ops-inline-flags">{items}</div> : null;
    }

    function renderRegulationRow(card: RegulationCard) {
        const emphasisClass = rowEmphasisClass(card, shiftLabel, generatedAt);
        const lunchSlot = resolveMealBreakSlot<MealBreakLunchSlot>(mealBreakSession, card.postCode, "lunchAssignments");
        const restSlot = resolveMealBreakSlot<MealBreakRestSlot>(mealBreakSession, card.postCode, "restAssignments");
        const clickable = Boolean(session?.canManage);

        return (
            <tr
                key={`${card.domain}-${card.postCode}`}
                className={`ops-table-row ${emphasisClass} ${clickable ? "clickable" : ""}`.trim()}
                onClick={clickable ? () => openDrawer(card) : undefined}
            >
                <td className="ops-cell time compact">
                    <span className="ops-time-pill"><strong>{formatBoardTime(card.startedAt)}</strong></span>
                </td>
                <td className="ops-cell code compact">
                    <div className="ops-code-stack rail">
                        <strong>{card.postCode}</strong>
                    </div>
                </td>
                <td className="ops-cell doctor wide">
                    <div className="ops-doctor-stack compact">
                        <div className="ops-doctor-line primary">
                            <strong title={displayDoctorName(card)}>{displayDoctorName(card)}</strong>
                        </div>
                        {renderOperationalBadges(card)}
                    </div>
                </td>
                <td className="ops-cell slot">
                    {renderScheduleChip({ slot: lunchSlot, kind: "lunch", pending: !lunchSlot })}
                </td>
                <td className="ops-cell slot">
                    {renderScheduleChip({ slot: restSlot, kind: "rest", pending: !restSlot })}
                </td>
            </tr>
        );
    }

    function renderInterventionRow(card: InterventionCard) {
        const emphasisClass = rowEmphasisClass(card, shiftLabel, generatedAt);
        const isClickable = Boolean(session?.canManage);
        const isWaitingIntervention = card.status === "waiting";
        const isAwaitingNews = isInterventionAwaitingNews(card, generatedAt);
        const hasPlannedCoverage = hasPlannedInterventionCoverageForCurrentShift({
            shiftLabel: card.shiftLabel,
            scheduledEndAt: card.scheduledEndAt,
            reference: generatedAt,
        });
        const continuationLabel = resolveContinuationBadgeLabel({
            startedAt: card.boardStartedAt ?? card.startedAt,
            shiftLabel: card.shiftLabel,
            reference: generatedAt,
        });
        const isSaoPauloNightShift = getSaoPauloParts(generatedAt).hour >= 19 || getSaoPauloParts(generatedAt).hour < 7;

        return (
            <tr
                key={`${card.domain}-${card.baseCode}`}
                className={`ops-table-row ${emphasisClass} ${isClickable ? "clickable" : ""}`.trim()}
                onClick={isClickable ? () => openDrawer(card) : undefined}
            >
                <td className="ops-cell time compact">
                    <span className={`ops-time-pill ${isWaitingIntervention ? "waiting" : ""} ${isAwaitingNews ? "verification" : ""}`.trim()}>
                        <strong>{isWaitingIntervention ? "Livre" : formatBoardTime(card.startedAt)}</strong>
                    </span>
                </td>
                <td className="ops-cell code compact">
                    <div className="ops-code-stack rail">
                        <strong>{card.baseCode}</strong>
                    </div>
                </td>
                <td className="ops-cell doctor wide">
                    <div className="ops-doctor-stack compact">
                        <div className="ops-doctor-line primary">
                            <strong title={displayDoctorName(card)}>{displayDoctorName(card)}</strong>
                        </div>
                        <div className="ops-inline-flags subtle">
                            {renderRoleBadge(resolveCardRoleLabel(card))}
                            {isAwaitingNews && <span className="ops-inline-flag waiting">Verificar</span>}
                            {!hasPlannedCoverage && continuationLabel && <span className={`ops-doctor-note continuation ${isSaoPauloNightShift ? "night" : "day"}`.trim()}>{continuationLabel}</span>}
                        </div>
                    </div>
                </td>
            </tr>
        );
    }

    function renderPreviousShiftEntry(entry: PreviousOperationalEntry, bucket: PreviousOperationalBucket) {
        const effectiveEndedAt = entry.actualEndedAt ?? entry.endedAt;
        const timingLabels = historyTimingLabels(bucket);

        return (
            <article key={`${entry.domain}-${entry.occupancyId}`} className="ops-history-entry-card">
                <header className="ops-history-entry-header">
                    <div className="ops-history-entry-title">
                        <span className={`ops-history-domain ${entry.domain}`}>{entry.domain === "regulation" ? "Regulação" : "Intervenção"}</span>
                        <strong>{entry.targetCode}</strong>
                        <span>{entry.targetLabel}</span>
                    </div>
                    <span className={`ops-history-balance ${historyBalanceClass(entry.balanceMinutes)}`}>{formatSignedMinutesLabel(entry.balanceMinutes)}</span>
                </header>

                <div className="ops-history-entry-doctor">
                    <strong>{entry.displayName || entry.doctorName}</strong>
                    <span>{timingLabels.responsibility} em {entry.targetCode} • {historyEntrySupportMeta(entry)}</span>
                </div>

                <p className="ops-history-entry-copy">{timingLabels.emphasis}</p>

                <div className="ops-history-entry-grid">
                    <div>
                        <span className="ops-history-entry-label">{timingLabels.arrival}</span>
                        <strong>{formatDateTimeDetail(entry.startedAt)}</strong>
                    </div>
                    <div>
                        <span className="ops-history-entry-label">{timingLabels.departure}</span>
                        <strong>{effectiveEndedAt ? formatDateTimeDetail(effectiveEndedAt) : "Em aberto"}</strong>
                    </div>
                    <div>
                        <span className="ops-history-entry-label">Janela banco</span>
                        <strong>{formatWindowLabel(entry.scheduledStartAt, entry.scheduledEndAt)}</strong>
                    </div>
                    <div>
                        <span className="ops-history-entry-label">Status</span>
                        <strong>{formatHistoryStatus(entry)}</strong>
                    </div>
                </div>

                <div className="ops-history-entry-metrics">
                    <span>Contribuição deste plantão: {formatContributionLabel(entry.balanceMinutes)}</span>
                    <span>Atraso de entrada: {formatMinutesLabel(entry.arrivalDelayMinutes)}</span>
                    <span>Crédito por saída: {formatMinutesLabel(entry.creditedOvertimeMinutes)}</span>
                    {entry.ruleCode && <span>Regra: {entry.ruleCode}</span>}
                </div>

                <p className="ops-history-entry-copy ops-history-entry-copy-secondary">
                    {entry.bankHoursExplanation ?? "Ainda sem fechamento de banco para este registro."}
                </p>
            </article>
        );
    }

    function renderPreviousShiftSection(section: PreviousOperationalSection) {
        return (
            <section key={section.bucket} className="ops-history-section-card">
                <header className="ops-history-section-heading">
                    <div>
                        <p className="ops-section-eyebrow">Grupo operacional</p>
                        <h3>{formatPreviousBucketMeta(section.bucket)}</h3>
                    </div>
                    <span className="ops-history-section-count">{section.entries.length} registros</span>
                </header>

                <p className="ops-history-section-copy">{section.description}</p>

                {section.entries.length > 0 ? (
                    <div className="ops-history-entry-list">
                        {section.entries.map((entry) => renderPreviousShiftEntry(entry, section.bucket))}
                    </div>
                ) : (
                    <div className="ops-history-empty-state">Nenhum registro deste grupo no fechamento anterior.</div>
                )}
            </section>
        );
    }

    return (
        <>
            <div className={`ops-auth-dock ${authOpen ? "open" : ""}`.trim()}>
                {session?.roles.includes("admin") && !session.mustChangePassword && (
                    <button
                        type="button"
                        className="ops-history-trigger payment-allocation"
                        aria-label="Abrir visão de alocação de pagamento"
                        title="Alocação de pagamento"
                        onClick={() => {
                            setPreviousShiftOpen(false);
                            setAuthOpen(false);
                            router.push("/admin/payment-allocation");
                        }}
                    >
                        <span className="ops-history-trigger-icon" aria-hidden="true">
                            <svg viewBox="0 0 24 24" focusable="false">
                                <path d="M4.75 4h10.5A2.75 2.75 0 0 1 18 6.75v1.1h1.25A2.75 2.75 0 0 1 22 10.6v6.65A2.75 2.75 0 0 1 19.25 20h-10.5A2.75 2.75 0 0 1 6 17.25v-1.1H4.75A2.75 2.75 0 0 1 2 13.4V6.75A2.75 2.75 0 0 1 4.75 4Zm0 1.5A1.25 1.25 0 0 0 3.5 6.75v6.65a1.25 1.25 0 0 0 1.25 1.25H6v-4.05a2.75 2.75 0 0 1 2.75-2.75H16.5v-1.1a1.25 1.25 0 0 0-1.25-1.25H4.75Zm4 3.85A1.25 1.25 0 0 0 7.5 10.6v6.65a1.25 1.25 0 0 0 1.25 1.25h10.5a1.25 1.25 0 0 0 1.25-1.25V10.6a1.25 1.25 0 0 0-1.25-1.25H8.75Zm2.35 1.9h5.8a.75.75 0 0 1 0 1.5h-5.8a.75.75 0 0 1 0-1.5Zm0 3.5h3.2a.75.75 0 0 1 0 1.5h-3.2a.75.75 0 0 1 0-1.5Z" />
                            </svg>
                        </span>
                    </button>
                )}

                <button
                    type="button"
                    className="ops-history-trigger bank-hours"
                    aria-label="Abrir visão de banco de horas"
                    title="Banco de horas"
                    onClick={() => {
                        setPreviousShiftOpen(false);
                        setAuthOpen(false);
                        router.push("/admin/bank-hours");
                    }}
                >
                    <span className="ops-history-trigger-icon" aria-hidden="true">
                        <svg viewBox="0 0 24 24" focusable="false">
                            <path d="M12 2.75a9.25 9.25 0 1 0 9.25 9.25A9.26 9.26 0 0 0 12 2.75Zm0 1.5a7.75 7.75 0 0 1 7.74 7.5h-1.9a5.85 5.85 0 0 0-4.34-5.34V4.26c.13 0 .25-.01.38-.01ZM10.88 4.34v2.07a5.86 5.86 0 0 0-4.45 5.34H4.26a7.77 7.77 0 0 1 6.62-7.41Zm-6.62 8.91h2.17a5.86 5.86 0 0 0 4.45 5.34v2.07a7.77 7.77 0 0 1-6.62-7.41Zm8.12 7.4v-2.06a5.85 5.85 0 0 0 4.34-5.34h3.02a7.75 7.75 0 0 1-7.36 7.4Zm-3.38-8.65a3 3 0 1 1 6 0 3 3 0 0 1-6 0Zm3-1.5a1.5 1.5 0 1 0 1.5 1.5 1.5 1.5 0 0 0-1.5-1.5Z" />
                        </svg>
                    </span>
                </button>

                <button
                    type="button"
                    className="ops-history-trigger"
                    aria-label="Abrir fechamento do plantão anterior"
                    title="Plantão anterior"
                    onClick={() => {
                        setPreviousShiftOpen((current) => !current);
                        setAuthOpen(false);
                    }}
                >
                    <span className="ops-history-trigger-icon" aria-hidden="true">
                        <svg viewBox="0 0 24 24" focusable="false">
                            <path d="M12 3.25a8.75 8.75 0 1 0 8.53 10.7.75.75 0 1 0-1.46-.35A7.25 7.25 0 1 1 12 4.75c1.94 0 3.7.76 5 2l-1.87.01a.75.75 0 0 0 0 1.5h3.67a.75.75 0 0 0 .75-.75V3.84a.75.75 0 0 0-1.5 0v1.79A8.7 8.7 0 0 0 12 3.25Zm-.75 4.5a.75.75 0 0 1 1.5 0v3.89l2.37 1.58a.75.75 0 0 1-.84 1.24l-2.7-1.8a.75.75 0 0 1-.33-.62V7.75Z" />
                        </svg>
                    </span>
                </button>

                <button
                    type="button"
                    className={`ops-auth-trigger ${session ? "connected" : ""}`.trim()}
                    aria-label={session ? `Sessao ativa: ${summarizeRoles(session.roles)}. Abrir acesso operacional.` : "Abrir acesso operacional"}
                    title={session ? `${summarizeRoles(session.roles)} • ${session.email}` : "Acesso operacional"}
                    onClick={() => {
                        setAuthOpen((current) => !current);
                        setAuthError(null);
                        setAuthInfo(null);
                    }}
                >
                    <span className={`ops-auth-trigger-status ${session ? "connected" : "idle"}`.trim()} aria-hidden="true" />
                    <span className="ops-auth-trigger-icon" aria-hidden="true">
                        <svg viewBox="0 0 24 24" focusable="false">
                            <path d="M12 2.75a5 5 0 0 0-5 5v1.5H6.5A2.75 2.75 0 0 0 3.75 12v6.25A2.75 2.75 0 0 0 6.5 21h11a2.75 2.75 0 0 0 2.75-2.75V12a2.75 2.75 0 0 0-2.75-2.75H17V7.75a5 5 0 0 0-5-5Zm-3.5 6.5v-1.5a3.5 3.5 0 1 1 7 0v1.5h-7Zm3.5 3.25a1.75 1.75 0 0 1 .75 3.33V18a.75.75 0 0 1-1.5 0v-2.17a1.75 1.75 0 0 1 .75-3.33Z" />
                        </svg>
                    </span>
                    <span className="ops-auth-sr">{session ? `${summarizeRoles(session.roles)} ${session.email}` : "Abrir acesso operacional"}</span>
                </button>

                <div className={`ops-auth-popover ${authOpen ? "open" : ""}`.trim()}>
                    {session ? (
                        <div className="ops-auth-panel">
                            <div className="ops-auth-panel-header">
                                <div>
                                    <p className="ops-auth-kicker">Sessao ativa</p>
                                    <h2>{summarizeRoles(session.roles)}</h2>
                                </div>
                                <span className={`ops-auth-state ${session.mustChangePassword ? "warning" : session.canManage ? "live" : "read"}`.trim()}>
                                    {session.mustChangePassword ? "Troca obrigatoria" : session.canManage ? "Operacao habilitada" : "Leitura"}
                                </span>
                            </div>

                            <div className="ops-auth-summary">
                                <strong>{session.email}</strong>
                                <span>
                                    {session.mustChangePassword
                                        ? "Senha temporaria ativa. Troque a senha agora para liberar as rotas operacionais."
                                        : session.canManage
                                            ? "Clique no quadro para abrir correcoes, aberturas e encerramentos."
                                            : "Esta sessao nao habilita operacao."}
                                </span>
                                {session.roles.includes("admin") && !session.mustChangePassword && (
                                    <a className="ops-auth-inline-link" href="/admin/reports">
                                        Abrir auditoria mensal
                                    </a>
                                )}
                            </div>

                            {session.mustChangePassword && (
                                <form className="ops-auth-panel ops-auth-password-panel" onSubmit={handleChangePassword}>
                                    <p className="ops-auth-copy ops-auth-security-note">
                                        Esses acessos bootstrap nascem bloqueados para operacao. A liberacao acontece assim que voce troca a senha temporaria por uma senha forte e individual.
                                    </p>

                                    <label className="ops-auth-field">
                                        <span>Senha atual</span>
                                        <input
                                            type="password"
                                            className="ops-auth-input"
                                            value={currentPasswordInput}
                                            onChange={(event) => setCurrentPasswordInput(event.target.value)}
                                            autoComplete="current-password"
                                            placeholder="Informe a senha temporaria"
                                        />
                                    </label>

                                    <label className="ops-auth-field">
                                        <span>Nova senha</span>
                                        <input
                                            type="password"
                                            className="ops-auth-input"
                                            value={nextPasswordInput}
                                            onChange={(event) => setNextPasswordInput(event.target.value)}
                                            autoComplete="new-password"
                                            placeholder="Minimo de 10 caracteres com combinacao forte"
                                        />
                                    </label>

                                    <label className="ops-auth-field">
                                        <span>Confirmar nova senha</span>
                                        <input
                                            type="password"
                                            className="ops-auth-input"
                                            value={confirmPasswordInput}
                                            onChange={(event) => setConfirmPasswordInput(event.target.value)}
                                            autoComplete="new-password"
                                            placeholder="Repita a nova senha"
                                        />
                                    </label>

                                    <div className="ops-auth-actions">
                                        <button type="submit" className="ops-auth-primary" disabled={isPasswordChanging || isRefreshing || !currentPasswordInput || !nextPasswordInput || !confirmPasswordInput}>
                                            {isPasswordChanging || isRefreshing ? "Atualizando..." : "Trocar senha e liberar"}
                                        </button>
                                    </div>
                                </form>
                            )}

                            <div className="ops-auth-actions">
                                <button type="button" className="ops-auth-secondary" onClick={() => setAuthOpen(false)}>
                                    Fechar
                                </button>
                                <button type="button" className="ops-auth-primary" onClick={handleLogout} disabled={isAuthSubmitting || isPasswordChanging || isRefreshing}>
                                    {isAuthSubmitting || isRefreshing ? "Saindo..." : "Sair"}
                                </button>
                            </div>
                        </div>
                    ) : (
                        <form className="ops-auth-panel" onSubmit={handleAuthSubmit}>
                            <div className="ops-auth-panel-header">
                                <div>
                                    <p className="ops-auth-kicker">Acesso operacional</p>
                                    <h2>Chief ou admin</h2>
                                </div>
                                <span className="ops-auth-state read">Leitura publica em /</span>
                            </div>

                            <p className="ops-auth-copy">
                                O quadro continua visivel sem login. A autenticacao aqui apenas libera os controles de operacao.
                            </p>

                            <label className="ops-auth-field">
                                <span>Email</span>
                                <input
                                    type="email"
                                    className="ops-auth-input"
                                    value={authEmail}
                                    onChange={(event) => setAuthEmail(event.target.value)}
                                    autoComplete="username"
                                    placeholder="voce@dominio.com"
                                />
                            </label>

                            <label className="ops-auth-field">
                                <span>Senha</span>
                                <input
                                    type="password"
                                    className="ops-auth-input"
                                    value={authPassword}
                                    onChange={(event) => setAuthPassword(event.target.value)}
                                    autoComplete="current-password"
                                    placeholder="Sua senha operacional"
                                />
                            </label>

                            <div className="ops-auth-actions">
                                <button type="button" className="ops-auth-secondary" onClick={() => setAuthOpen(false)}>
                                    Fechar
                                </button>
                                <button type="submit" className="ops-auth-primary" disabled={isAuthSubmitting || isRefreshing || !authEmail.trim() || !authPassword}>
                                    {isAuthSubmitting || isRefreshing ? "Entrando..." : "Entrar"}
                                </button>
                            </div>
                        </form>
                    )}
                </div>
            </div>

            {(authError || authInfo) && (
                <div className={`ops-auth-toast ${authError ? "error" : "success"}`.trim()}>
                    {authError || authInfo}
                </div>
            )}

            <main className="ops-shell">
                <section className="ops-command-center">
                    <header className="ops-command-header">
                        <div className="ops-command-copy">
                            <p className="ops-kicker">Mesa operacional</p>
                            <h1>Painel de regulação e intervenção</h1>
                            <p className="ops-subtitle">
                                Leitura direta do plantão atual, com regulação em foco, intervenção compacta e almoço/descanso visíveis onde fazem diferença operacional.
                            </p>
                        </div>

                        <div className="ops-command-meta-card">
                            <div className="ops-command-meta-row">
                                <span className="ops-command-label">Turno</span>
                                <strong>{formatShiftHeadline(shiftLabel)}</strong>
                            </div>
                            <div className="ops-command-meta-row">
                                <span className="ops-command-label">Data operacional</span>
                                <strong>{formatBoardDateLabel(generatedAt)}</strong>
                            </div>
                            <div className="ops-command-meta-row">
                                <span className="ops-command-label">Robô</span>
                                <div className="ops-header-status-stack">
                                    <span className={`ops-inline-status ${robotStatus.tone === "attention" ? "warning" : robotStatus.tone === "idle" ? "neutral" : ""}`.trim()}>{robotStatus.label}</span>
                                    <small>{robotStatus.copy}</small>
                                </div>
                            </div>
                            <div className="ops-command-actions">
                                <button
                                    type="button"
                                    className="ops-header-button secondary"
                                    onClick={() => startRefresh(() => router.refresh())}
                                    disabled={isRefreshing}
                                >
                                    {isRefreshing ? "Atualizando..." : "Atualizar"}
                                </button>
                                <button
                                    type="button"
                                    className="ops-header-button primary"
                                    onClick={async () => {
                                        try {
                                            await navigator.clipboard.writeText("/almoco");
                                            setHeaderMessage("Comando /almoco copiado. Dispare no bot autorizado para abrir o fluxo.");
                                        } catch {
                                            setHeaderMessage("Use /almoco no bot autorizado para organizar almoço e descanso.");
                                        }
                                    }}
                                >
                                    Organizar almoço/descanso
                                </button>
                            </div>
                        </div>
                    </header>

                    {(headerMessage || successMessage) && (
                        <div className="ops-top-feedback">
                            <span>{headerMessage ?? successMessage}</span>
                        </div>
                    )}

                    <section className="ops-metrics-strip">
                        <article className="ops-metric-tile regulation">
                            <span className="ops-summary-label">Total em regulação</span>
                            <strong>{visibleRegulationCards.length}</strong>
                            <p>{regulationLunchPendingCount} almoço pendente • {regulationRestPendingCount} descanso pendente</p>
                        </article>
                        <article className="ops-metric-tile intervention">
                            <span className="ops-summary-label">Total em intervenção</span>
                            <strong>{interventionActiveCount}</strong>
                            <p>{interventionWaitingCount} bases aguardando confirmação</p>
                        </article>
                        <article className="ops-metric-tile lunch">
                            <span className="ops-summary-label">Almoço definido</span>
                            <strong>{regulationLunchDefinedCount}</strong>
                            <p>{robotStatus.label}</p>
                        </article>
                        <article className="ops-metric-tile rest">
                            <span className="ops-summary-label">Descanso definido</span>
                            <strong>{regulationRestDefinedCount}</strong>
                            <p>Regulação com descanso já visível no quadro</p>
                        </article>
                    </section>

                    <section className="ops-main-grid">
                        <section className="ops-operational-panel regulation">
                            <header className="ops-panel-header regulation">
                                <div>
                                    <p className="ops-section-eyebrow">Regulação</p>
                                    <h2>Ramais operacionais</h2>
                                </div>
                                <div className="ops-section-meta">
                                    <span className="ops-section-count">{visibleRegulationCards.length} em cobertura</span>
                                    <span className="ops-section-waiting danger">{regulationLunchPendingCount} almoço pendente</span>
                                    <span className="ops-section-waiting">{regulationRestPendingCount} descanso pendente</span>
                                </div>
                            </header>

                            <div className="ops-panel-table-wrap regulation">
                                <table className="ops-table ops-table-regulation">
                                    <thead>
                                        <tr>
                                            <th>Chegada</th>
                                            <th>Ramal</th>
                                            <th>Nome</th>
                                            <th>Almoço</th>
                                            <th>Descanso</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {visibleRegulationCards.length > 0 ? visibleRegulationCards.map((card) => renderRegulationRow(card)) : (
                                            <tr>
                                                <td className="ops-empty-row" colSpan={5}>Nenhum ramal ativo na regulação neste turno.</td>
                                            </tr>
                                        )}
                                    </tbody>
                                </table>
                            </div>
                        </section>

                        <section className="ops-operational-panel intervention">
                            <header className="ops-panel-header intervention">
                                <div>
                                    <p className="ops-section-eyebrow">Intervenção</p>
                                    <h2>Bases em campo</h2>
                                </div>
                                <div className="ops-section-meta">
                                    <span className="ops-section-count">{interventionActiveCount} em cobertura</span>
                                    <span className="ops-section-waiting">{interventionWaitingCount} aguardando</span>
                                </div>
                            </header>

                            <div className="ops-panel-table-wrap intervention">
                                <table className="ops-table ops-table-intervention">
                                    <thead>
                                        <tr>
                                            <th>Chegada</th>
                                            <th>Base</th>
                                            <th>Nome</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {visibleInterventionCards.length > 0 ? visibleInterventionCards.map((card) => renderInterventionRow(card)) : (
                                            <tr>
                                                <td className="ops-empty-row" colSpan={3}>Nenhuma base ativa ou aguardando neste turno.</td>
                                            </tr>
                                        )}
                                    </tbody>
                                </table>
                            </div>
                        </section>
                    </section>
                </section>
            </main>

            <div className={`ops-history-backdrop ${previousShiftOpen ? "open" : ""}`} onClick={() => setPreviousShiftOpen(false)} />
            <aside className={`ops-history-drawer ${previousShiftOpen ? "open" : ""}`} aria-hidden={!previousShiftOpen}>
                <header className="ops-history-header">
                    <div>
                        <p className="ops-column-kicker">Fechamento operacional</p>
                        <h2>Plantão anterior</h2>
                    </div>
                    <button type="button" className="chief-close-button" onClick={() => setPreviousShiftOpen(false)}>Fechar</button>
                </header>

                <div className="ops-history-summary">
                    <span className="ops-section-shift">Dia operacional {formatOperationalDayLabel(previousShift.operationalDate)}</span>
                    <span className="ops-section-count">Titulares e substituicoes classificados em P invertido, P, SD e SN</span>
                    <span className="ops-section-updated">{filteredPreviousShiftTotal} de {previousShift.totalEntries} registros visiveis</span>
                </div>

                <section className="ops-history-search-shell">
                    <div className="ops-history-search-copy">
                        <p className="ops-section-eyebrow">Consulta rapida</p>
                        <h3>Busque o medico e leia o plantao como entidade fechada</h3>
                        <p>
                            Aqui o eixo principal e responsabilidade operacional. O horario real continua importante para banco, auditoria e pagamento, mas o chefe consulta primeiro quem assumiu e quem entregou cada plantao.
                        </p>
                    </div>

                    <label className="ops-history-search-field">
                        <span className="ops-history-search-icon" aria-hidden="true">
                            <svg viewBox="0 0 24 24" focusable="false">
                                <path d="M10.5 4.75a5.75 5.75 0 1 0 0 11.5 5.75 5.75 0 0 0 0-11.5Zm-7.25 5.75a7.25 7.25 0 1 1 12.39 5.12l4 4a.75.75 0 1 1-1.06 1.06l-4-4A7.25 7.25 0 0 1 3.25 10.5Z" />
                            </svg>
                        </span>
                        <input
                            type="search"
                            value={previousShiftQuery}
                            onChange={(event) => setPreviousShiftQuery(event.target.value)}
                            placeholder="Buscar medico, base, ramal ou regra"
                            aria-label="Buscar medico no fechamento do plantao anterior"
                        />
                        {previousShiftQuery && (
                            <button type="button" className="ops-history-search-clear" onClick={() => setPreviousShiftQuery("")}>
                                Limpar
                            </button>
                        )}
                    </label>
                </section>

                <div className="ops-history-grid">
                    {previousShiftSections.map((section) => renderPreviousShiftSection(section))}
                </div>
            </aside>

            <div className={`chief-drawer-backdrop ${drawerOpen ? "open" : ""}`} onClick={closeDrawer} />
            <aside className={`chief-drawer ${drawerOpen ? "open" : ""}`} aria-hidden={!drawerOpen}>
                <header className="chief-drawer-header">
                    <div>
                        <p className="ops-column-kicker">Comando de chefia</p>
                        <h2>Fila critica e correcao rapida</h2>
                    </div>
                    <button type="button" className="chief-close-button" onClick={closeDrawer}>Fechar</button>
                </header>

                {(successMessage || errorMessage) && (
                    <div className={`chief-flash ${errorMessage ? "error" : "success"}`}>
                        {errorMessage || successMessage}
                    </div>
                )}

                {!session?.canManage && !session?.mustChangePassword && (
                    <div className="chief-auth-warning">
                        Esta mesa esta em leitura. Entre com perfil chief ou admin para habilitar abertura, correcao e encerramento.
                    </div>
                )}

                {session?.mustChangePassword && (
                    <div className="chief-auth-warning">
                        Esta sessao ainda usa senha temporaria. Troque a senha no controle de acesso para liberar qualquer operacao de chefia.
                    </div>
                )}

                <section className="chief-drawer-section">
                    <div className="chief-stat-grid">
                        <article className="chief-stat-card critical">
                            <span className="ops-summary-label">Pendencias imediatas</span>
                            <strong>{criticalCards.length}</strong>
                        </article>
                        <article className="chief-stat-card watch">
                            <span className="ops-summary-label">Coberturas sob vigia</span>
                            <strong>{watchCards.length}</strong>
                        </article>
                    </div>
                </section>

                <section className="chief-drawer-section">
                    <div className="chief-section-heading">
                        <h3>Vazios que pedem acao</h3>
                        <span>{criticalCards.length}</span>
                    </div>
                    <div className="chief-queue-list">
                        {criticalCards.length === 0 && <p className="chief-empty-copy">Nenhum vazio operacional neste instante.</p>}
                        {criticalCards.map((card) => (
                            <button key={`critical-${card.domain}-${cardCode(card)}`} type="button" className="chief-queue-item critical" onClick={() => openAction(card, "start")}>
                                <strong>{cardCode(card)}</strong>
                                <span>{cardLabel(card)}</span>
                                <small>Abrir cobertura agora</small>
                            </button>
                        ))}
                    </div>
                </section>

                <section className="chief-drawer-section">
                    <div className="chief-section-heading">
                        <h3>Tempo sob vigilância</h3>
                        <span>{watchCards.length}</span>
                    </div>
                    <div className="chief-queue-list">
                        {watchCards.length === 0 && <p className="chief-empty-copy">Nenhuma cobertura longa exigindo vigia especial.</p>}
                        {watchCards.map((card) => (
                            <button key={`watch-${card.domain}-${cardCode(card)}`} type="button" className="chief-queue-item watch" onClick={() => openAction(card, "correct")} disabled={!canEditActiveCard(card)}>
                                <strong>{cardCode(card)}</strong>
                                <span>{displayDoctorName(card)}</span>
                                <small>{canEditActiveCard(card) ? `${formatMinutesLabel(minutesSince(generatedAt, card.startedAt))} em curso` : "Leitura ao vivo sem ocupacao v2"}</small>
                            </button>
                        ))}
                    </div>
                </section>

                <section className="chief-drawer-section focus">
                    {!selectedCard || !actionMode ? (
                        <div className="chief-focus-empty">
                            <h3>Selecione um card para acao rapida</h3>
                            <p>Use os chips do quadro ou as filas deste drawer para abrir cobertura, corrigir medico ou horario e encerrar registro.</p>
                        </div>
                    ) : (
                        <div className="chief-focus-panel">
                            {canContinueIntervention(selectedCard, generatedAt) && session?.canManage && (
                                <div className="chief-verification-strip">
                                    <div>
                                        <p className="ops-column-kicker">Pendencia de virada</p>
                                        <strong>Aguardando noticia</strong>
                                        <span>
                                            Esse medico entrou antes da janela tolerada do turno atual. Confirme se vai continuar ou informe a saida com horario correto.
                                        </span>
                                    </div>
                                    <div className="chief-timing-grid">
                                        <article className="chief-timing-card">
                                            <span>Chegada registrada</span>
                                            <strong>{formatDateTimeDetail(selectedCard.startedAt)}</strong>
                                        </article>
                                        <article className="chief-timing-card">
                                            <span>Saida prevista</span>
                                            <strong>{formatDateTimeDetail(selectedCard.scheduledEndAt)}</strong>
                                        </article>
                                    </div>
                                    <p className="chief-bank-hours-copy">
                                        Banco de horas depende destes horarios. Use <strong>Continuar</strong> apenas se o medico realmente seguir no plantao. Se ele saiu, registre a saida com o horario mais fiel possivel.
                                    </p>
                                    <label className="chief-field full-width">
                                        <span>{requiresReasonForContinuation(selectedCard, generatedAt) ? "Justificativa obrigatoria" : "Justificativa operacional"}</span>
                                        <textarea
                                            className="chief-input chief-textarea compact"
                                            value={formState.notes}
                                            onChange={(event) => setFormState((current) => ({ ...current, notes: event.target.value }))}
                                            placeholder={requiresReasonForContinuation(selectedCard, generatedAt)
                                                ? "Explique por que a continuidade foi liberada apos 07:15 ou 19:15"
                                                : "Motivo operacional da continuidade, se necessario"}
                                        />
                                    </label>
                                    <div className="chief-verification-actions">
                                        <button
                                            type="button"
                                            className="chief-secondary-button"
                                            onClick={() => {
                                                setActionMode("end");
                                                setFormState((current) => ({ ...current, endedAt: toLocalDateTimeValue() }));
                                            }}
                                            disabled={isSubmitting || isRefreshing}
                                        >
                                            Informar saida
                                        </button>
                                        <button
                                            type="button"
                                            className="chief-primary-button"
                                            onClick={() => void handleContinueCard(selectedCard)}
                                            disabled={isSubmitting || isRefreshing}
                                        >
                                            {isSubmitting || isRefreshing ? "Aplicando..." : "Continuar"}
                                        </button>
                                    </div>
                                </div>
                            )}

                            <div className="chief-focus-header">
                                <div>
                                    <p className="ops-column-kicker">Ação ativa</p>
                                    <h3>{actionTitle(actionMode, selectedCard)}</h3>
                                </div>
                                <span className={`ops-priority-tag ${resolvePriority(selectedCard, generatedAt)}`}>{priorityLabel(resolvePriority(selectedCard, generatedAt))}</span>
                            </div>

                            <div className="chief-context-card">
                                <strong>{displayDoctorName(selectedCard)}</strong>
                                <div className="chief-context-badges">
                                    {renderRoleBadge(resolveCardRoleLabel(selectedCard))}
                                </div>
                                <span>{cardLabel(selectedCard)}</span>
                                <small>{selectedCard.status === "waiting" ? "Sem confirmacao ativa no quadro" : `Marcado desde ${formatBoardTime(selectedCard.startedAt)}`}</small>
                            </div>

                            {selectedCard.status === "active" && selectedCard.occupancyId && session?.canManage && (
                                <div className="chief-departure-strip">
                                    <div>
                                        <p className="ops-column-kicker">Saida rapida</p>
                                        <strong>Registrar saída</strong>
                                        <span>
                                            Use este atalho para liberar o medico agora, com horario real e motivo auditavel.
                                        </span>
                                    </div>

                                    <div className="chief-timing-grid">
                                        <label className="chief-field">
                                            <span>Horario da saida</span>
                                            <input
                                                type="datetime-local"
                                                className="chief-input"
                                                value={quickExitAt}
                                                onChange={(event) => setQuickExitAt(event.target.value)}
                                            />
                                        </label>
                                        <label className="chief-field">
                                            <span>Motivo da saida</span>
                                            <textarea
                                                className="chief-input chief-textarea compact"
                                                value={quickExitReason}
                                                onChange={(event) => setQuickExitReason(event.target.value)}
                                                placeholder="Ex.: rendido, saiu da base, ajuste de registro, troca confirmada"
                                            />
                                        </label>
                                    </div>

                                    <div className="chief-verification-actions">
                                        <button
                                            type="button"
                                            className="chief-danger-button"
                                            onClick={() => void handleQuickDeparture(selectedCard)}
                                            disabled={isSubmitting || isRefreshing || !trimToNull(quickExitReason)}
                                        >
                                            {isSubmitting || isRefreshing ? "Registrando..." : "Registrar saída"}
                                        </button>
                                    </div>
                                </div>
                            )}

                            <form className="chief-action-form" onSubmit={handleSubmit}>
                                {(actionMode === "correct" || actionMode === "start") && (
                                    <>
                                        <label className="chief-field full-width chief-doctor-picker">
                                            <span>Medico</span>
                                            <input
                                                className="chief-input"
                                                value={doctorQuery}
                                                onChange={(event) => {
                                                    const nextQuery = event.target.value;
                                                    setDoctorQuery(nextQuery);
                                                    setFormState((current) => ({ ...current, doctorId: "" }));
                                                }}
                                                placeholder="Digite parte do nome e selecione o medico completo"
                                                autoComplete="off"
                                            />

                                            {selectedDoctor && doctorSelectionLocked && (
                                                <div className="chief-doctor-selection">
                                                    <strong>{doctorOptionLabel(selectedDoctor)}</strong>
                                                    <button
                                                        type="button"
                                                        className="chief-selection-clear"
                                                        onClick={() => {
                                                            setDoctorQuery("");
                                                            setFormState((current) => ({ ...current, doctorId: "" }));
                                                        }}
                                                    >
                                                        Trocar medico
                                                    </button>
                                                </div>
                                            )}

                                            {!selectedDoctor && (
                                                <div className="chief-doctor-help">
                                                    Digite alguns caracteres. O envio so libera depois que voce escolhe um nome completo da lista.
                                                </div>
                                            )}

                                            {!selectedDoctor && filteredDoctors.length > 0 && (
                                                <div className="chief-doctor-suggestions" role="listbox" aria-label="Sugestoes de medicos">
                                                    {filteredDoctors.map((doctor) => (
                                                        <button
                                                            key={doctor.id}
                                                            type="button"
                                                            className="chief-doctor-option"
                                                            onClick={() => {
                                                                setFormState((current) => ({ ...current, doctorId: doctor.id }));
                                                                setDoctorQuery(doctorOptionLabel(doctor));
                                                            }}
                                                        >
                                                            <strong>{doctor.displayName ?? doctor.fullName}</strong>
                                                            {doctor.displayName && <span>{doctor.fullName}</span>}
                                                        </button>
                                                    ))}
                                                </div>
                                            )}
                                        </label>

                                        <label className="chief-field">
                                            <span>{actionMode === "start" ? "Horario de abertura" : "Horario corrigido"}</span>
                                            <input
                                                type="datetime-local"
                                                className="chief-input"
                                                value={formState.startedAt}
                                                onChange={(event) => setFormState((current) => ({ ...current, startedAt: event.target.value }))}
                                            />
                                        </label>

                                        <label className="chief-field">
                                            <span>Função operacional</span>
                                            <select
                                                className="chief-input chief-select"
                                                value={formState.roleLabel}
                                                onChange={(event) => setFormState((current) => ({ ...current, roleLabel: event.target.value }))}
                                                disabled={Boolean(resolveCardFixedRole(selectedCard))}
                                            >
                                                <option value="">Sem função</option>
                                                {buildOperationalRoleChoices([
                                                    resolveCardFixedRole(selectedCard),
                                                    selectedCard.roleLabel,
                                                    selectedCard.domain === "regulation" ? selectedCard.defaultRole : null,
                                                ]).map((role) => (
                                                    <option key={role} value={role}>{role}</option>
                                                ))}
                                            </select>
                                            {resolveCardFixedRole(selectedCard) && (
                                                <small className="chief-field-hint">Função travada por regra operacional deste posto neste turno.</small>
                                            )}
                                        </label>

                                        {selectedCard.domain === "regulation" && (
                                            <label className="chief-field">
                                                <span>Ramal</span>
                                                <input
                                                    className="chief-input"
                                                    value={formState.ramalLabel}
                                                    onChange={(event) => setFormState((current) => ({ ...current, ramalLabel: event.target.value }))}
                                                    placeholder="1321"
                                                />
                                            </label>
                                        )}
                                    </>
                                )}

                                {actionMode === "end" && (
                                    <label className="chief-field">
                                        <span>Horario de encerramento</span>
                                        <input
                                            type="datetime-local"
                                            className="chief-input"
                                            value={formState.endedAt}
                                            onChange={(event) => setFormState((current) => ({ ...current, endedAt: event.target.value }))}
                                        />
                                    </label>
                                )}

                                <label className="chief-field full-width">
                                    <span>{actionMode === "correct" ? "Motivo da correcao" : "Notas operacionais"}</span>
                                    <textarea
                                        className="chief-input chief-textarea"
                                        value={formState.notes}
                                        onChange={(event) => setFormState((current) => ({ ...current, notes: event.target.value }))}
                                        placeholder={actionMode === "correct"
                                            ? "Explique por que voce esta mudando o horario ou o medico deste registro"
                                            : "Contexto rapido de chefia ou observacao operacional"}
                                    />
                                </label>

                                <div className="chief-form-actions full-width">
                                    <button type="button" className="chief-secondary-button" onClick={() => setActionMode(null)}>
                                        Voltar
                                    </button>
                                    <button type="submit" className="chief-primary-button" disabled={isSubmitting || isRefreshing || !session?.canManage}>
                                        {isSubmitting || isRefreshing ? "Aplicando..." : actionMode === "start" ? "Abrir cobertura" : actionMode === "end" ? "Encerrar registro" : "Salvar correcao"}
                                    </button>
                                </div>
                            </form>
                        </div>
                    )}
                </section>
            </aside>
        </>
    );
}
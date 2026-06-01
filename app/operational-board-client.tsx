"use client";

import { useDeferredValue, useEffect, useEffectEvent, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { OperationalHistoryPanel } from "@/components/operational-history-panel";
import { InterventionLateArrivalPanel } from "@/components/intervention-late-arrival-panel";
import { buildOperationalRoleChoices, dedupeOperationalIdentityLabels, getOperationalRoleTone, isOperationalRoleRemovalSentinel, normalizeOperationalRoleLabel, resolveFixedOperationalRole, resolveOperationalRoleLabel, resolveRoleLabelForExplicitRemoval } from "@/modules/operational/roles";
import { compareRootBoardRegulationCodes, isNucleoRegulationPost, isPiamRegulationPost, resolvePendingRegulationOccupantLabel, shouldShowRegulationCardOnRootBoard } from "@/modules/operational/board-display";
import type {
    MealBreakDinnerDuration,
    MealBreakDinnerSlot,
    MealBreakLunchSlot,
    MealBreakNightWorkSlot,
    MealBreakPriorityView,
    MealBreakRestSlot,
    MealBreakSession,
} from "@/modules/telegram/meal-breaks";
import {
    getSaoPauloParts,
    requiresOvertimeJustification,
    resolveInterventionLineState,
    resolveOccupancyDirection,
} from "@/modules/operational/board-rules";
import type {
    InterventionBoardRow,
    PendingDepartureConfirmation,
    PreviousOperationalBoard,
    PreviousOperationalBucket,
    PreviousOperationalEntry,
    PreviousOperationalSection,
    RecentHandoff,
    RegulationBoardRow,
} from "@/services/board.service";
import { AuditRail } from "@/components/board/AuditRail";
import { RecentHandoffsRail } from "@/components/board/RecentHandoffsRail";
import { DepartureVerifier } from "@/components/board/DepartureVerifier";
import { CommandPalette } from "@/components/board/CommandPalette";
import { BoardHero } from "@/components/board/BoardHero";
import { BoardQuickFilters, type BoardRoleFilter, type BoardStatusFilter } from "@/components/board/BoardQuickFilters";
import { InlineTimeEditor } from "@/components/board/InlineTimeEditor";
import { RowActions } from "@/components/board/RowActions";
import { MealSlotPicker, type MealKind } from "@/components/board/MealSlotPicker";
import { AnimatePresence } from "framer-motion";
import { useQuickConfirmDeparture } from "@/lib/board/use-quick-confirm-departure";

type UserRole = "admin" | "chief";
type ActionMode = "correct" | "end" | "start";
type PriorityLevel = "critical" | "high" | "elevated" | "steady";
type OperationalDomain = "regulation" | "intervention";
type TransferConflictStrategy = "remove_destination" | "move_destination";
type ViewMode = "live" | "history";

const NIGHT_WORK_OPTIONS: MealBreakNightWorkSlot[] = ["23:00", "03:00"];
const NIGHT_DINNER_OPTIONS: MealBreakDinnerSlot[] = ["20:30", "21:00", "21:30"];
const DAY_SLOT_OPTIONS = ["11:30", "12:30", "13:30", "14:30", "15:30", "16:30", "18:00"] as const;

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
    mealBreakEligibility: { lunchExcludedRamals: string[]; restExcludedRamals: string[] };
    previousShift: PreviousOperationalBoard;
    doctors: DoctorOption[];
    session: SessionSummary | null;
    initialViewMode?: ViewMode;
    pendingDepartures?: PendingDepartureConfirmation[];
    recentHandoffs?: RecentHandoff[];
}

interface FormState {
    doctorId: string;
    startedAt: string;
    endedAt: string;
    roleLabel: string;
    shiftOverride: string;
    targetKey: string;
    notes: string;
}

interface TransferTargetOption {
    key: string;
    domain: OperationalDomain;
    targetId: number;
    code: string;
    label: string;
    status: "available" | "occupied" | "disabled";
    occupantName: string | null;
    occupancyId: string | null;
}

interface AuthResponse {
    error?: string;
    session?: {
        user?: {
            mustChangePassword?: boolean;
        };
    };
}

function resolveMealBreakSlot<TSlot extends MealBreakLunchSlot | MealBreakRestSlot | MealBreakDinnerSlot | MealBreakNightWorkSlot>(
    session: MealBreakSession | null,
    ramal: string,
    assignmentType: "lunchAssignments" | "restAssignments" | "dinnerAssignments" | "nightWorkAssignments",
) {
    if (!session) {
        return null;
    }

    return session[assignmentType][ramal] as TSlot | undefined ?? null;
}

function resolveMealBreakDisplayMode(shiftLabel: string, session: MealBreakSession | null) {
    return session?.mode ?? (shiftLabel === "SN" ? "night" : "day");
}

function resolveDinnerDuration(session: MealBreakSession | null, ramal: string): MealBreakDinnerDuration | null {
    if (!session || session.mode !== "night") {
        return null;
    }

    return session.dinnerDurationAssignments[ramal] ?? null;
}

function resolveDefaultNightDinner(duration: MealBreakDinnerDuration | null) {
    return duration === "one_hour" ? "22:00" : "22:30";
}

function isNightMealBreakEligible(session: MealBreakSession | null, ramal: string) {
    return Boolean(session?.mode === "night" && session.roster.some((doctor) => doctor.ramal === ramal));
}

function isDayMealBreakEligible(session: MealBreakSession | null, ramal: string) {
    return Boolean(session?.mode === "day" && session.roster.some((doctor) => doctor.ramal === ramal));
}

const CHIEF_RAMAL = "2031";

function shouldExcludeFromRegulationHeaderCounter(card: RegulationCard) {
    const normalizedCode = card.postCode.trim().toUpperCase();
    if (normalizedCode === CHIEF_RAMAL || isNucleoRegulationPost(normalizedCode) || isPiamRegulationPost(normalizedCode)) {
        return true;
    }

    const normalizedRoleLabel = normalizeOperationalRoleLabel(card.roleLabel);
    return normalizedRoleLabel === "CP" || normalizedRoleLabel === "PSIQ";
}

function resolveMealBreakExclusionHint(ramal: string, mode: "day" | "night") {
    if (ramal === CHIEF_RAMAL) {
        return mode === "day"
            ? "O posto 2031 (chefia) fica fora da divisao automatica de almoco e descanso."
            : "O posto 2031 (chefia) fica fora da divisao automatica de jantar e trabalho.";
    }

    if (isNucleoRegulationPost(ramal)) {
        return "O NUCLEO nao participa da divisao de almoco, descanso, jantar ou trabalho.";
    }

    if (isPiamRegulationPost(ramal)) {
        return "O PIAM nao participa da divisao de almoco, descanso, jantar ou trabalho.";
    }

    return mode === "day"
        ? `O posto ${ramal} esta fora da divisao de almoco e descanso neste turno.`
        : `O posto ${ramal} esta fora da divisao de jantar e trabalho neste turno.`;
}

function isMealBreakExcluded(session: MealBreakSession | null, ramal: string, kind: "lunch" | "rest") {
    if (!session || session.mode !== "day") {
        return false;
    }

    return kind === "lunch"
        ? session.lunchExcludedRamals.includes(ramal)
        : session.restExcludedRamals.includes(ramal);
}

function isSystemicallyExcludedFromMealBreak(ramal: string, mode: "day" | "night") {
    if (isNucleoRegulationPost(ramal)) return true;
    if (mode === "day" && isPiamRegulationPost(ramal)) return true;
    return false;
}

function resolveRemainingDayLunchSlots(session: MealBreakSession | null) {
    if (!session || session.mode !== "day") {
        return [] as Array<{ slot: MealBreakLunchSlot; remaining: number }>;
    }

    const counts = { "11:30": 0, "12:30": 0, "13:30": 0 } as Record<MealBreakLunchSlot, number>;
    for (const slot of Object.values(session.lunchAssignments)) {
        counts[slot] += 1;
    }

    return (["11:30", "12:30", "13:30"] as const)
        .map((slot) => ({ slot, remaining: Math.max(0, session.lunchCapacities[slot] - counts[slot]) }))
        .filter((entry) => entry.remaining > 0);
}

function resolveRemainingDayRestSlots(session: MealBreakSession | null) {
    if (!session || session.mode !== "day") {
        return [] as Array<{ slot: "15:30" | "16:30"; remaining: number }>;
    }

    const counts = { "15:30": 0, "16:30": 0 } as Record<"15:30" | "16:30", number>;
    for (const slot of Object.values(session.restAssignments)) {
        if (slot === "15:30" || slot === "16:30") {
            counts[slot] += 1;
        }
    }

    return (["15:30", "16:30"] as const)
        .map((slot) => ({ slot, remaining: Math.max(0, session.restChoiceCapacities[slot] - counts[slot]) }))
        .filter((entry) => entry.remaining > 0);
}

function formatMealBreakCapacity(entries: Array<{ slot: string; remaining: number }>, emptyLabel: string) {
    if (entries.length === 0) {
        return emptyLabel;
    }

    return entries.map((entry) => `${entry.slot} (${entry.remaining})`).join(" • ");
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
    if (card.domain === "regulation" && card.status === "disabled") {
        return "Ramal desativado";
    }

    if (card.domain === "intervention" && card.status === "disabled") {
        return "Base desativada";
    }

    if (card.domain === "intervention" && card.status === "waiting") {
        return "Aguardando cobertura";
    }

    if (card.domain === "regulation" && card.status === "waiting") {
        return resolvePendingRegulationOccupantLabel(card.postCode);
    }

    return card.displayName || card.doctorName || "Aguardando confirmação";
}

function canEditActiveCard(card: BoardCard) {
    return Boolean(card.occupancyId);
}

function canManageCardState(card: BoardCard) {
    return card.domain === "regulation" ? card.postId > 0 : card.baseId > 0;
}

function cardStateSubject(card: BoardCard) {
    return card.domain === "regulation" ? "ramal" : "base";
}

function cardStatePanelLabel(card: BoardCard) {
    return card.domain === "regulation" ? "Estado do ramal" : "Estado da USA";
}

function cardStateActionLabel(card: BoardCard) {
    const subject = cardStateSubject(card);
    return card.status === "disabled"
        ? `Reativar ${subject}`
        : `Desativar ${subject}`;
}

function cardStateDescription(card: BoardCard) {
    if (card.status === "disabled") {
        return card.domain === "regulation"
            ? "Use quando o ramal voltar a operar. O posto sai do estado desativado e volta para leitura normal do quadro."
            : "Use quando a USA voltar a operar. A base sai do estado desativada e volta para leitura normal do quadro.";
    }

    return card.domain === "regulation"
        ? "Use quando o ramal saiu de operação. A ação encerra coberturas abertas nesse horário para proteger banco de horas e pagamento."
        : "Use quando a USA saiu de operação. A ação encerra coberturas abertas nesse horário para proteger banco de horas e pagamento.";
}

function cardStateReasonPlaceholder(card: BoardCard) {
    if (card.status === "disabled") {
        return card.domain === "regulation"
            ? "Ex.: ramal reaberto e liberado para nova cobertura"
            : "Ex.: USA reaberta e pronta para nova cobertura";
    }

    return card.domain === "regulation"
        ? "Ex.: posto fechado, ramal indisponível, operação suspensa"
        : "Ex.: USA recolhida, indisponível, veículo fora de operação";
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

/** Operational arrival for display and priority: boardStartedAt reflects the true
 *  arrival when a doctor continues across shifts (SD→SN, P→SN). Falls back to
 *  startedAt for occupancies without a separate board anchor. */
function resolveOperationalArrival(card: BoardCard): string | null {
    return card.boardStartedAt ?? card.startedAt;
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
    if (card.status === "disabled") {
        return "steady";
    }

    if (card.status === "waiting") {
        return "critical";
    }

    const ageMinutes = minutesSince(generatedAt, resolveOperationalArrival(card));
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
        return `Cobertura longa em curso: ${formatMinutesLabel(minutesSince(generatedAt, resolveOperationalArrival(card)))}.`;
    }
    if (priority === "elevated") {
        return `Em acompanhamento ha ${formatMinutesLabel(minutesSince(generatedAt, resolveOperationalArrival(card)))}.`;
    }
    return "Cobertura dentro do ritmo atual da operacao.";
}

function buildInitialForm(card: BoardCard) {
    return {
        doctorId: card.doctorId ?? "",
        startedAt: toLocalDateTimeValue(card.startedAt),
        endedAt: toLocalDateTimeValue(),
        roleLabel: resolveCardFixedRole(card) ?? card.roleLabel ?? "",
        shiftOverride: "",
        targetKey: card.domain === "regulation"
            ? buildTransferTargetKey("regulation", card.postId)
            : buildTransferTargetKey("intervention", card.baseId),
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

function buildTransferTargetKey(domain: OperationalDomain, targetId: number) {
    return `${domain}:${targetId}`;
}

function buildCardTransferTargetKey(card: BoardCard) {
    return card.domain === "regulation"
        ? buildTransferTargetKey("regulation", card.postId)
        : buildTransferTargetKey("intervention", card.baseId);
}

function targetTypeLabel(domain: OperationalDomain) {
    return domain === "regulation" ? "Ramal" : "USA";
}

function extractTrailingNumber(value: string) {
    const match = value.match(/(\d+)$/);
    return match ? Number(match[1]) : Number.POSITIVE_INFINITY;
}

function compareRegulationCards(left: RegulationCard, right: RegulationCard, shiftLabel: string) {
    return compareRootBoardRegulationCodes(left.postCode, right.postCode, shiftLabel);
}

function isInterventionAwaitingNews(card: BoardCard, generatedAt: string) {
    return card.domain === "intervention"
        && card.status === "active"
        && resolveInterventionLineState({
            startedAt: card.startedAt,
            boardStartedAt: card.boardStartedAt,
            scheduledEndAt: card.scheduledEndAt,
            shiftLabel: card.shiftLabel,
            reference: generatedAt,
        }).kind === "saindo";
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

function resolveRegulationRoleEmphasis(card: RegulationCard, mealBreakSession: MealBreakSession | null) {
    const roleLabel = resolveCardRoleLabel(card);

    if (isRecipRamal(mealBreakSession, card.postCode) || roleLabel === "RECIP") {
        return "emphasis-recip";
    }

    if (roleLabel === "MRV" && card.shiftLabel !== "SN") {
        return "emphasis-mrv-day";
    }

    if (roleLabel === "COI") {
        return "emphasis-coi";
    }

    if (roleLabel === "PSIQ") {
        return "emphasis-psiq";
    }

    if (roleLabel === "CP") {
        return "emphasis-cp";
    }

    if (roleLabel === "RMT") {
        return "emphasis-rmt";
    }

    if (roleLabel === "IES") {
        return "emphasis-ies";
    }

    return "";
}

function rowEmphasisClass(card: BoardCard, shiftLabel: string, generatedAt: string, mealBreakSession: MealBreakSession | null) {
    if (card.status === "disabled") {
        return "emphasis-disabled";
    }

    if (card.domain === "intervention" && card.status === "waiting") {
        return "emphasis-waiting";
    }

    if (isInterventionAwaitingNews(card, generatedAt)) {
        return "emphasis-verification";
    }

    if (card.domain !== "regulation") {
        return "";
    }

    return resolveRegulationRoleEmphasis(card, mealBreakSession);
}

function rowAccentLabel(card: BoardCard, shiftLabel: string, generatedAt: string) {
    if (isInterventionAwaitingNews(card, generatedAt)) {
        return "Verificar";
    }

    if (card.domain !== "regulation") {
        return null;
    }

    const emphasisClass = resolveRegulationRoleEmphasis(card, null);

    if (emphasisClass === "emphasis-mrv-day") {
        return "MRV";
    }

    if (emphasisClass === "emphasis-coi") {
        return "COI";
    }

    if (emphasisClass === "emphasis-psiq") {
        return "PSIQ";
    }

    if (emphasisClass === "emphasis-cp") {
        return "CP";
    }

    if (emphasisClass === "emphasis-rmt") {
        return "RMT";
    }

    if (emphasisClass === "emphasis-ies") {
        return "IES";
    }

    if (emphasisClass === "emphasis-recip") {
        return "RECIP";
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
    const { generatedAt, shiftLabel, regulation, intervention, mealBreakSession, mealBreakEligibility, previousShift, doctors, session, initialViewMode = "live", pendingDepartures = [], recentHandoffs = [] } = props;
    const router = useRouter();
    const [viewMode, setViewMode] = useState<ViewMode>(initialViewMode);
    const [authOpen, setAuthOpen] = useState(false);
    const [previousShiftOpen, setPreviousShiftOpen] = useState(false);
    const [verifierTarget, setVerifierTarget] = useState<PendingDepartureConfirmation | null>(null);
    const [boardSearch, setBoardSearch] = useState("");
    const [boardRoleFilter, setBoardRoleFilter] = useState<BoardRoleFilter>("all");
    const [boardStatusFilter, setBoardStatusFilter] = useState<BoardStatusFilter>("all");
    const [expandedCardKey, setExpandedCardKey] = useState<string | null>(null);
    const quickConfirmDeparture = useQuickConfirmDeparture();
    const [priorityDrawerOpen, setPriorityDrawerOpen] = useState(false);
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
    const [professionalDrawerOpen, setProfessionalDrawerOpen] = useState(false);
    const [selectedCard, setSelectedCard] = useState<BoardCard | null>(null);
    const [actionMode, setActionMode] = useState<ActionMode | null>(null);
    const [isContinuityEntry, setIsContinuityEntry] = useState(false);
    const [formState, setFormState] = useState<FormState>({
        doctorId: "",
        startedAt: toLocalDateTimeValue(),
        endedAt: toLocalDateTimeValue(),
        roleLabel: "",
        shiftOverride: "",
        targetKey: "",
        notes: "",
    });
    const [doctorQuery, setDoctorQuery] = useState("");
    const deferredDoctorQuery = useDeferredValue(doctorQuery);
    const deferredPreviousShiftQuery = useDeferredValue(previousShiftQuery);
    const [quickExitAt, setQuickExitAt] = useState(toLocalDateTimeValue());
    const [quickExitReason, setQuickExitReason] = useState("");
    const [baseStateAt, setBaseStateAt] = useState(toLocalDateTimeValue());
    const [baseStateReason, setBaseStateReason] = useState("");
    const [errorMessage, setErrorMessage] = useState<string | null>(null);
    const [successMessage, setSuccessMessage] = useState<string | null>(null);
    const [priorityErrorMessage, setPriorityErrorMessage] = useState<string | null>(null);
    const [prioritySuccessMessage, setPrioritySuccessMessage] = useState<string | null>(null);
    const [transferConfirmOpen, setTransferConfirmOpen] = useState(false);
    const [transferConflictStrategy, setTransferConflictStrategy] = useState<TransferConflictStrategy>("remove_destination");
    const [transferRelocationKey, setTransferRelocationKey] = useState("");
    const [isSubmitting, setIsSubmitting] = useState(false);
    const [isMealBreakSaving, setIsMealBreakSaving] = useState(false);
    const [isPriorityLoading, setIsPriorityLoading] = useState(false);
    const [isPrioritySaving, setIsPrioritySaving] = useState(false);
    const [undoBanner, setUndoBanner] = useState<{ auditLogId: string; message: string; expiresAt: number } | null>(null);
    const [undoNotes, setUndoNotes] = useState("");
    const [isUndoing, setIsUndoing] = useState(false);
    const [undoNotesOpen, setUndoNotesOpen] = useState(false);
    const [priorityView, setPriorityView] = useState<MealBreakPriorityView | null>(null);
    const [priorityNotesByRamal, setPriorityNotesByRamal] = useState<Record<string, string>>({});
    const [nightWorkInput, setNightWorkInput] = useState<MealBreakNightWorkSlot | "">("");
    const [dinnerInput, setDinnerInput] = useState<MealBreakDinnerSlot | "">("");
    const [lunchSlotInput, setLunchSlotInput] = useState<string>("");
    const [restSlotInput, setRestSlotInput] = useState<string>("");
    const [isRefreshing, startRefresh] = useTransition();
    const [kickConfirmCardKey, setKickConfirmCardKey] = useState<string | null>(null);
    const latestGeneratedAtRef = useRef(generatedAt);

    useEffect(() => {
        latestGeneratedAtRef.current = generatedAt;
    }, [generatedAt]);

    useEffect(() => {
        if (!selectedCard) {
            return;
        }

        const nextSelected = selectedCard.domain === "regulation"
            ? regulationCards.find((card) => card.occupancyId && card.occupancyId === selectedCard.occupancyId)
            ?? regulationCards.find((card) => card.postCode === selectedCard.postCode)
            ?? null
            : interventionCards.find((card) => card.occupancyId && card.occupancyId === selectedCard.occupancyId)
            ?? interventionCards.find((card) => card.baseCode === selectedCard.baseCode)
            ?? null;

        if (!nextSelected) {
            setSelectedCard(null);
            setActionMode(null);
            return;
        }

        setSelectedCard(nextSelected);

        if (selectedCard.status === "disabled" && nextSelected.status === "waiting") {
            setActionMode("start");
            setFormState(buildInitialForm(nextSelected));
            syncSelectedDoctorLabel(nextSelected.doctorId ?? null);
            return;
        }

        if (nextSelected.status === "disabled") {
            setActionMode(null);
        }
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

    useEffect(() => {
        if (viewMode !== "history") {
            return;
        }

        setPreviousShiftOpen(false);
        setPriorityDrawerOpen(false);
        setDrawerOpen(false);
        setProfessionalDrawerOpen(false);
        setTransferConfirmOpen(false);
        setAuthOpen(false);
    }, [viewMode]);

    useEffect(() => {
        if (typeof window === "undefined") {
            return;
        }

        const url = new URL(window.location.href);
        if (viewMode === "history") {
            url.searchParams.set("view", "history");
        } else {
            url.searchParams.delete("view");
        }

        const nextPath = `${url.pathname}${url.search}${url.hash}`;
        const currentPath = `${window.location.pathname}${window.location.search}${window.location.hash}`;
        if (nextPath !== currentPath) {
            window.history.replaceState(null, "", nextPath);
        }
    }, [viewMode]);

    const refreshIfBoardChanged = useEffectEvent(async () => {
        if (viewMode === "history") {
            return;
        }

        if (drawerOpen || professionalDrawerOpen || priorityDrawerOpen || isSubmitting || isRefreshing) {
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

    // ─── Undo banner auto-dismiss ──────────────────────────────────
    useEffect(() => {
        if (!undoBanner) return;
        const remainingMs = undoBanner.expiresAt - Date.now();
        if (remainingMs <= 0) { setUndoBanner(null); return; }
        const timerId = window.setTimeout(() => setUndoBanner(null), remainingMs);
        return () => window.clearTimeout(timerId);
    }, [undoBanner]);

    async function fetchLatestUndoableAction() {
        try {
            const response = await fetch("/api/operational/undoable-actions");
            if (!response.ok) return;
            const body = await response.json() as { actions?: Array<{ auditLogId: string; action: string }> };
            const latest = body.actions?.[0];
            if (latest) {
                const UNDO_BANNER_MS = 60_000;
                setUndoBanner({
                    auditLogId: latest.auditLogId,
                    message: formatUndoActionLabel(latest.action),
                    expiresAt: Date.now() + UNDO_BANNER_MS,
                });
                setUndoNotes("");
                setUndoNotesOpen(false);
            }
        } catch { /* ignore */ }
    }

    function formatUndoActionLabel(action: string): string {
        if (action.includes("started")) return "Chegada registrada";
        if (action.includes("corrected")) return "Correção aplicada";
        if (action.includes("deleted")) return "Ocupação removida";
        if (action.includes("transferred")) return "Remanejamento aplicado";
        return "Ação aplicada";
    }

    async function handleUndo() {
        if (!undoBanner || !undoNotes.trim() || undoNotes.trim().length < 8) return;
        setIsUndoing(true);
        try {
            const response = await fetch("/api/operational/undo", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ auditLogId: undoBanner.auditLogId, notes: undoNotes.trim() }),
            });
            const body = await response.json() as { message?: string; error?: string };
            if (!response.ok) {
                setUndoBanner(null);
                setErrorMessage(body.error ?? "Falha ao desfazer.");
                return;
            }
            setUndoBanner(null);
            setSuccessMessage(body.message ?? "Ação desfeita com sucesso.");
            startRefresh(() => { router.refresh(); });
        } catch {
            setUndoBanner(null);
            setErrorMessage("Erro de rede ao desfazer.");
        } finally {
            setIsUndoing(false);
        }
    }

    const regulationCards: RegulationCard[] = regulation.map((row) => ({ ...row, domain: "regulation" }));
    const interventionCards: InterventionCard[] = intervention.map((row) => ({ ...row, domain: "intervention" }));
    const rootBoardRegulationCards = regulationCards.filter((card) => shouldShowRegulationCardOnRootBoard({
        postCode: card.postCode,
        status: card.status,
        doctorId: card.doctorId,
        shiftLabel,
    }));
    const regulationPostOptions = Array.from(new Map(
        [...regulationCards]
            .sort((left, right) => compareRegulationCards(left, right, shiftLabel))
            .map((card) => [card.postId, {
                postId: card.postId,
                postCode: card.postCode,
                postLabel: card.postLabel,
            }]),
    ).values());
    const interventionBaseOptions = Array.from(new Map(
        [...interventionCards]
            .sort((left, right) => extractTrailingNumber(left.baseCode) - extractTrailingNumber(right.baseCode))
            .map((card) => [card.baseId, {
                baseId: card.baseId,
                baseCode: card.baseCode,
                baseLabel: card.baseLabel,
                status: card.status,
                occupancyId: card.occupancyId,
                occupantName: card.occupancyId ? displayDoctorName(card) : null,
            }]),
    ).values());
    const visibleRegulationCards = rootBoardRegulationCards
        .sort((left, right) => compareRegulationCards(left, right, shiftLabel));
    const hasAvailableRegulationPost = rootBoardRegulationCards.some((card) => card.status === "waiting");
    const visibleInterventionCards = interventionCards
        .filter((card) => (card.status === "active" && Boolean(card.doctorId)) || card.status === "waiting" || card.status === "disabled")
        .sort((left, right) => extractTrailingNumber(left.baseCode) - extractTrailingNumber(right.baseCode));
    const allCards: BoardCard[] = [...visibleRegulationCards, ...visibleInterventionCards];
    const interventionWaitingCount = visibleInterventionCards.filter((card) => card.status === "waiting").length;
    const interventionActiveCount = visibleInterventionCards.length - interventionWaitingCount;
    const criticalCards = allCards.filter((card) => resolvePriority(card, generatedAt) === "critical");
    const watchCards = allCards.filter((card) => resolvePriority(card, generatedAt) === "high");
    const regulationCardsForHeader = visibleRegulationCards.filter((card) => !shouldExcludeFromRegulationHeaderCounter(card));
    const regulationOccupiedCount = regulationCardsForHeader.filter((card) => card.status === "active" && Boolean(card.occupancyId)).length;
    const regulationFreeCount = regulationCardsForHeader.filter((card) => card.status === "waiting").length;

    const deferredBoardSearch = useDeferredValue(boardSearch);
    const cardMatchesFilters = (card: BoardCard): boolean => {
        const needle = deferredBoardSearch.trim().toLowerCase();
        if (needle.length > 0) {
            const haystack = `${displayDoctorName(card)} ${cardCode(card)} ${cardLabel(card)} ${card.roleLabel ?? ""}`.toLowerCase();
            if (!haystack.includes(needle)) return false;
        }
        if (boardRoleFilter !== "all") {
            const role = resolveCardRoleLabel(card);
            if (role !== boardRoleFilter) return false;
        }
        if (boardStatusFilter !== "all") {
            const priority = resolvePriority(card, generatedAt);
            if (boardStatusFilter === "critical" && priority !== "critical") return false;
            if (boardStatusFilter === "watch" && priority !== "high") return false;
            if (boardStatusFilter === "waiting" && card.status !== "waiting") return false;
        }
        return true;
    };
    const filteredRegulationCards = visibleRegulationCards.filter(cardMatchesFilters);
    const filteredInterventionCards = visibleInterventionCards.filter(cardMatchesFilters);
    const filteredMatchedCount = filteredRegulationCards.length + filteredInterventionCards.length;
    const totalBoardCount = visibleRegulationCards.length + visibleInterventionCards.length;
    const previousShiftSections = previousShift.sections.map((section) => ({
        ...section,
        entries: section.entries
            .filter((entry) => matchesPreviousShiftQuery(entry, deferredPreviousShiftQuery))
            .sort(compareHistoryEntriesByDoctor),
    }));
    const filteredPreviousShiftTotal = previousShiftSections.reduce((total, section) => total + section.entries.length, 0);
    const selectedDoctor = doctors.find((doctor) => doctor.id === formState.doctorId) ?? null;
    const transferTargetOptions: TransferTargetOption[] = [
        ...regulationPostOptions.map((option) => {
            const card = regulationCards.find((entry) => entry.postId === option.postId && (entry.status === "disabled" || Boolean(entry.occupancyId)))
                ?? regulationCards.find((entry) => entry.postId === option.postId)
                ?? null;
            const occupant = card?.status === "active" && card.occupancyId ? card : null;
            return {
                key: buildTransferTargetKey("regulation", option.postId),
                domain: "regulation" as const,
                targetId: option.postId,
                code: option.postCode,
                label: option.postLabel,
                status: card?.status === "disabled" ? "disabled" : occupant ? "occupied" : "available",
                occupantName: occupant ? displayDoctorName(occupant) : null,
                occupancyId: occupant?.occupancyId ?? null,
            } satisfies TransferTargetOption;
        }),
        ...interventionBaseOptions.map((option) => ({
            key: buildTransferTargetKey("intervention", option.baseId),
            domain: "intervention" as const,
            targetId: option.baseId,
            code: option.baseCode,
            label: option.baseLabel,
            status: option.status === "disabled" ? "disabled" : option.occupancyId ? "occupied" : "available",
            occupantName: option.occupantName,
            occupancyId: option.occupancyId,
        } satisfies TransferTargetOption)),
    ];
    const selectedCardTargetKey = selectedCard ? buildCardTransferTargetKey(selectedCard) : "";
    const selectedTransferTarget = transferTargetOptions.find((option) => option.key === formState.targetKey) ?? null;
    const isTransferAction = Boolean(
        selectedCard
        && actionMode === "correct"
        && selectedTransferTarget
        && selectedTransferTarget.key !== selectedCardTargetKey,
    );
    const selectedTransferConflict = isTransferAction && selectedTransferTarget && selectedTransferTarget.occupancyId && selectedTransferTarget.occupancyId !== selectedCard?.occupancyId
        ? selectedTransferTarget
        : null;
    const relocationTargetOptions = transferTargetOptions.filter((option) => option.key !== selectedTransferTarget?.key);
    const selectedRelocationTarget = relocationTargetOptions.find((option) => option.key === transferRelocationKey) ?? null;
    const relocationTargetConflict = selectedRelocationTarget && selectedRelocationTarget.occupancyId && selectedRelocationTarget.occupancyId !== selectedCard?.occupancyId
        ? selectedRelocationTarget
        : null;
    const mealBreakDisplayMode = resolveMealBreakDisplayMode(shiftLabel, mealBreakSession);
    const selectedRegulationRamal = selectedCard?.domain === "regulation" ? selectedCard.postCode : null;
    const selectedNightWorkCurrent = selectedRegulationRamal
        ? resolveMealBreakSlot<MealBreakNightWorkSlot>(mealBreakSession, selectedRegulationRamal, "nightWorkAssignments")
        : null;
    const selectedDinnerCurrent = selectedRegulationRamal
        ? resolveMealBreakSlot<MealBreakDinnerSlot>(mealBreakSession, selectedRegulationRamal, "dinnerAssignments")
        : null;
    const selectedLunchCurrent = selectedRegulationRamal
        ? resolveMealBreakSlot<MealBreakLunchSlot>(mealBreakSession, selectedRegulationRamal, "lunchAssignments")
        : null;
    const selectedRestCurrent = selectedRegulationRamal
        ? resolveMealBreakSlot<MealBreakRestSlot>(mealBreakSession, selectedRegulationRamal, "restAssignments")
        : null;
    const selectedRoleLabel = selectedCard ? resolveCardRoleLabel(selectedCard) : null;
    const selectedIsIsolatedOrDiscretionary = mealBreakDisplayMode === "day" && (selectedRoleLabel === "PSIQ" || selectedRoleLabel === "CP");
    const selectedLunchExcluded = selectedRegulationRamal
        ? isMealBreakExcluded(mealBreakSession, selectedRegulationRamal, "lunch") || (!mealBreakSession && mealBreakEligibility.lunchExcludedRamals.includes(selectedRegulationRamal)) || selectedIsIsolatedOrDiscretionary
        : false;
    const selectedRestExcluded = selectedRegulationRamal
        ? isMealBreakExcluded(mealBreakSession, selectedRegulationRamal, "rest") || (!mealBreakSession && mealBreakEligibility.restExcludedRamals.includes(selectedRegulationRamal)) || selectedIsIsolatedOrDiscretionary
        : false;
    const selectedDinnerDuration = selectedRegulationRamal ? resolveDinnerDuration(mealBreakSession, selectedRegulationRamal) : null;
    const selectedLateDinner = resolveDefaultNightDinner(selectedDinnerDuration);
    const remainingDayLunchSlots = resolveRemainingDayLunchSlots(mealBreakSession);
    const remainingDayRestSlots = resolveRemainingDayRestSlots(mealBreakSession);
    const canEditSelectedNightMealBreak = Boolean(
        session?.canManage
        && selectedCard?.domain === "regulation"
        && selectedCard.status === "active"
        && selectedRegulationRamal
        && isNightMealBreakEligible(mealBreakSession, selectedRegulationRamal),
    );
    const canEditSelectedDayMealBreak = Boolean(
        session?.canManage
        && selectedCard?.domain === "regulation"
        && selectedCard.status === "active"
        && selectedRegulationRamal
        && (isDayMealBreakEligible(mealBreakSession, selectedRegulationRamal) || (!mealBreakSession && mealBreakDisplayMode === "day")),
    );
    const showDayMealBreakSection = Boolean(
        (mealBreakSession?.mode === "day" || (!mealBreakSession && mealBreakDisplayMode === "day"))
        && selectedCard?.domain === "regulation"
        && selectedCard.status === "active",
    );
    const showNightMealBreakSection = Boolean(
        mealBreakSession?.mode === "night"
        && selectedCard?.domain === "regulation"
        && selectedCard.status === "active",
    );
    const filteredDoctors = doctors
        .filter((doctor) => matchesDoctorQuery(doctor, deferredDoctorQuery))
        .slice(0, 8);
    const doctorSelectionLocked = Boolean(selectedDoctor && doctorQuery.trim() === doctorOptionLabel(selectedDoctor));

    useEffect(() => {
        if (!selectedTransferConflict || !selectedCardTargetKey) {
            setTransferConflictStrategy("remove_destination");
            setTransferRelocationKey("");
            return;
        }

        setTransferConflictStrategy("remove_destination");
        setTransferRelocationKey(selectedCardTargetKey);
    }, [selectedCardTargetKey, selectedTransferConflict?.key]);

    useEffect(() => {
        if (!isTransferAction) {
            setTransferConfirmOpen(false);
        }
    }, [isTransferAction]);

    useEffect(() => {
        setNightWorkInput(selectedNightWorkCurrent ?? "");
        setDinnerInput(selectedDinnerCurrent ?? "");
        setLunchSlotInput(selectedLunchCurrent ?? "");
        setRestSlotInput(selectedRestCurrent ?? "");
    }, [selectedDinnerCurrent, selectedNightWorkCurrent, selectedLunchCurrent, selectedRestCurrent]);

    useEffect(() => {
        if (!priorityView) {
            setPriorityNotesByRamal({});
            return;
        }

        setPriorityNotesByRamal(Object.fromEntries(
            priorityView.entries.map((entry) => [entry.ramal, entry.manualJustification?.notes ?? ""]),
        ));
    }, [priorityView]);

    function resetDrawerFeedback() {
        setErrorMessage(null);
        setSuccessMessage(null);
    }

    function resetTransferFlow() {
        setTransferConfirmOpen(false);
        setTransferConflictStrategy("remove_destination");
        setTransferRelocationKey("");
    }

    function syncSelectedDoctorLabel(doctorId: string | null | undefined) {
        const doctor = doctors.find((entry) => entry.id === doctorId) ?? null;
        setDoctorQuery(doctor ? doctorOptionLabel(doctor) : "");
    }

    function openDrawer(card?: BoardCard) {
        resetTransferFlow();
        setDrawerOpen(true);
        resetDrawerFeedback();
    }

    function openProfessionalDrawer(card: BoardCard) {
        resetTransferFlow();
        setDrawerOpen(false);
        setProfessionalDrawerOpen(true);
        setSelectedCard(card);
        setIsContinuityEntry(false);
        setActionMode(card.status === "waiting" ? "start" : canEditActiveCard(card) ? "correct" : null);
        if (card.status === "waiting" || canEditActiveCard(card)) {
            setFormState(buildInitialForm(card));
            syncSelectedDoctorLabel(card.doctorId ?? null);
        }
        setQuickExitAt(toLocalDateTimeValue());
        setQuickExitReason("");
        setBaseStateAt(toLocalDateTimeValue(card.disabledAt ?? null));
        setBaseStateReason("");
        resetDrawerFeedback();
    }

    function openAction(card: BoardCard, mode: ActionMode) {
        resetTransferFlow();
        setDrawerOpen(false);
        setProfessionalDrawerOpen(true);
        setIsContinuityEntry(false);
        if (mode !== "start" && !canEditActiveCard(card)) {
            setSelectedCard(card);
            setActionMode(null);
            resetDrawerFeedback();
            return;
        }

        setSelectedCard(card);
        setActionMode(mode);
        setFormState(buildInitialForm(card));
        syncSelectedDoctorLabel(card.doctorId ?? null);
        setQuickExitAt(toLocalDateTimeValue());
        setQuickExitReason("");
        setBaseStateAt(toLocalDateTimeValue(card.disabledAt ?? null));
        setBaseStateReason("");
        resetDrawerFeedback();
    }

    function openGenericStartDrawer(domain: OperationalDomain) {
        resetTransferFlow();
        setDrawerOpen(false);
        setProfessionalDrawerOpen(true);
        setIsContinuityEntry(false);
        const placeholder: BoardCard = domain === "regulation"
            ? { domain: "regulation", postId: 0, postCode: "", postLabel: "", defaultRole: null, doctorId: null, doctorName: null, displayName: null, startedAt: null, boardStartedAt: null, scheduledEndAt: null, shiftLabel: null, roleLabel: null, ramalLabel: null, occupancyId: null, status: "waiting", disabledAt: null, disabledReason: null, liveSource: "none", liveUpdatedAt: null }
            : { domain: "intervention", baseId: 0, baseCode: "", baseLabel: "", doctorId: null, doctorName: null, displayName: null, startedAt: null, scheduledStartAt: null, boardStartedAt: null, scheduledEndAt: null, shiftLabel: null, roleLabel: null, occupancyId: null, status: "waiting", liveSource: "none", liveUpdatedAt: null, disabledAt: null, disabledReason: null, lateArrivalAcknowledgedAt: null, lateArrivalAcknowledgedNote: null };
        setSelectedCard(placeholder);
        setActionMode("start");
        setFormState({
            doctorId: "",
            startedAt: toLocalDateTimeValue(),
            endedAt: toLocalDateTimeValue(),
            roleLabel: "",
            shiftOverride: "",
            targetKey: "",
            notes: "",
        });
        setDoctorQuery("");
        setQuickExitAt(toLocalDateTimeValue());
        setQuickExitReason("");
        resetDrawerFeedback();
    }

    function closeProfessionalDrawer() {
        resetTransferFlow();
        setProfessionalDrawerOpen(false);
        setActionMode(null);
        setSelectedCard(null);
        setDoctorQuery("");
        setQuickExitReason("");
        setBaseStateReason("");
        setIsContinuityEntry(false);
    }

    function closeDrawer() {
        setDrawerOpen(false);
    }

    function resetPriorityFeedback() {
        setPriorityErrorMessage(null);
        setPrioritySuccessMessage(null);
    }

    async function loadPriorityView() {
        if (!session?.canManage) {
            return;
        }

        try {
            setIsPriorityLoading(true);
            setPriorityErrorMessage(null);

            const response = await fetch("/api/board/meal-breaks/priorities", {
                cache: "no-store",
                headers: { "Accept": "application/json" },
            });
            const responseBody = await response.json().catch(() => null) as { error?: string; priorities?: MealBreakPriorityView } | null;
            if (!response.ok || !responseBody?.priorities) {
                throw new Error(responseBody?.error || "Falha ao carregar a fila de prioridades.");
            }

            setPriorityView(responseBody.priorities);
        } catch (error) {
            setPriorityErrorMessage(error instanceof Error ? error.message : "Falha operacional inesperada.");
        } finally {
            setIsPriorityLoading(false);
        }
    }

    async function openPriorityDrawer() {
        if (!session?.canManage) {
            setPriorityErrorMessage("Entre com perfil chief ou admin para revisar a fila de prioridades.");
            return;
        }

        setPriorityDrawerOpen(true);
        resetPriorityFeedback();
        await loadPriorityView();
    }

    function closePriorityDrawer() {
        setPriorityDrawerOpen(false);
        resetPriorityFeedback();
    }

    async function handlePriorityMove(ramal: string, targetIndex: number) {
        if (!session?.canManage) {
            setPriorityErrorMessage("Entre com perfil chief ou admin para alterar a fila de prioridades.");
            return;
        }

        const notes = trimToNull(priorityNotesByRamal[ramal] ?? "");
        if (!notes) {
            setPriorityErrorMessage(`Justificativa obrigatoria para alterar a prioridade do ramal ${ramal}.`);
            return;
        }

        try {
            setIsPrioritySaving(true);
            setPriorityErrorMessage(null);
            setPrioritySuccessMessage(null);

            const response = await fetch("/api/board/meal-breaks/priorities", {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    ramal,
                    targetIndex,
                    notes,
                    referenceAt: generatedAt,
                }),
            });
            const responseBody = await response.json().catch(() => null) as { error?: string; priorities?: MealBreakPriorityView } | null;
            if (!response.ok || !responseBody?.priorities) {
                throw new Error(responseBody?.error || "Falha ao atualizar a fila de prioridades.");
            }

            setPriorityView(responseBody.priorities);
            setPrioritySuccessMessage(`Prioridade de ${ramal} atualizada com justificativa auditavel.`);
        } catch (error) {
            setPriorityErrorMessage(error instanceof Error ? error.message : "Falha operacional inesperada.");
        } finally {
            setIsPrioritySaving(false);
        }
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

    async function submitOperationalAction(options?: { confirmedTransfer?: boolean }) {
        if (!selectedCard || !actionMode) {
            return;
        }
        if (!session?.canManage) {
            setErrorMessage("Entre com perfil chief ou admin para operar correções e encerramentos.");
            return;
        }

        const normalizedNotes = trimToNull(formState.notes);

        if (actionMode === "correct" && isTransferAction) {
            if (!selectedCard.occupancyId) {
                setErrorMessage("Nao existe ocupacao ativa para remanejar neste card.");
                return;
            }

            if (!selectedTransferTarget) {
                setErrorMessage("Escolha o destino operacional antes de remanejar.");
                return;
            }

            if (selectedTransferTarget.status === "disabled") {
                setErrorMessage(`A ${targetTypeLabel(selectedTransferTarget.domain)} ${selectedTransferTarget.code} esta indisponivel para remanejamento.`);
                return;
            }

            if (!normalizedNotes) {
                setErrorMessage("Explique o motivo operacional antes de remanejar o plantao.");
                return;
            }

            if (!options?.confirmedTransfer) {
                setTransferConfirmOpen(true);
                return;
            }

            if (selectedTransferConflict && transferConflictStrategy === "move_destination" && !selectedRelocationTarget) {
                setErrorMessage("Escolha o novo destino de quem esta ocupando o posto/base de chegada.");
                return;
            }

            if (selectedTransferConflict && transferConflictStrategy === "move_destination" && relocationTargetConflict) {
                setErrorMessage(`O destino alternativo ${relocationTargetConflict.code} ja esta ocupado. Escolha outro local ou retire quem esta la antes de confirmar.`);
                return;
            }
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

                if (isTransferAction && selectedTransferTarget) {
                    endpoint = "/api/operational/transfers";
                    payload = {
                        sourceDomain: selectedCard.domain,
                        sourceOccupancyId: selectedCard.occupancyId,
                        destination: {
                            domain: selectedTransferTarget.domain,
                            targetId: selectedTransferTarget.targetId,
                        },
                        roleLabel: resolveRoleLabelForExplicitRemoval(trimToNull(formState.roleLabel)),
                        notes: normalizedNotes,
                        ...(selectedTransferConflict
                            ? {
                                conflictResolution: {
                                    strategy: transferConflictStrategy,
                                    ...(transferConflictStrategy === "move_destination" && selectedRelocationTarget
                                        ? {
                                            relocationTarget: {
                                                domain: selectedRelocationTarget.domain,
                                                targetId: selectedRelocationTarget.targetId,
                                            },
                                        }
                                        : {}),
                                },
                            }
                            : {}),
                    };
                } else {
                    const nextStartedAtIso = toIsoDateTime(formState.startedAt);
                    const startedAtChanged = Boolean(
                        selectedCard.startedAt
                        && nextStartedAtIso !== new Date(selectedCard.startedAt).toISOString(),
                    );
                    if (startedAtChanged && !normalizedNotes) {
                        throw new Error("Digite o motivo antes de corrigir horario.");
                    }

                    endpoint = selectedCard.domain === "regulation"
                        ? `/api/regulation/occupancies/${selectedCard.occupancyId}`
                        : `/api/intervention/occupancies/${selectedCard.occupancyId}`;
                    method = "PATCH";
                    payload = {
                        doctorId: formState.doctorId || undefined,
                        startedAt: nextStartedAtIso,
                        boardStartedAt: startedAtChanged
                            ? nextStartedAtIso
                            : (selectedCard.boardStartedAt ? new Date(selectedCard.boardStartedAt).toISOString() : nextStartedAtIso),
                        roleLabel: resolveRoleLabelForExplicitRemoval(trimToNull(formState.roleLabel)),
                        notes: normalizedNotes,
                    };
                }
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
                    notes: normalizedNotes,
                };

                if (
                    selectedCard.domain === "intervention"
                    && canContinueIntervention(selectedCard, generatedAt)
                    && requiresOvertimeJustification(selectedCard.startedAt, toIsoDateTime(formState.endedAt))
                    && !normalizedNotes
                ) {
                    throw new Error("Justificativa obrigatoria para registrar saida apos 07:15 ou 19:15.");
                }
            }

            if (actionMode === "start") {
                if (!formState.doctorId) {
                    throw new Error("Selecione um medico para abrir a cobertura.");
                }

                const isGenericStart = (selectedCard.domain === "regulation" && selectedCard.postId === 0)
                    || (selectedCard.domain === "intervention" && selectedCard.baseId === 0);

                let resolvedPostId = selectedCard.domain === "regulation" ? selectedCard.postId : 0;
                let resolvedBaseId = selectedCard.domain === "intervention" ? selectedCard.baseId : 0;
                let resolvedPostCode = selectedCard.domain === "regulation" ? selectedCard.postCode : "";

                if (isGenericStart) {
                    if (!formState.targetKey) {
                        throw new Error("Selecione o posto onde o medico vai atuar.");
                    }
                    const target = transferTargetOptions.find((option) => option.key === formState.targetKey);
                    if (!target) {
                        throw new Error("Posto selecionado nao encontrado.");
                    }
                    if (target.domain === "regulation") {
                        resolvedPostId = target.targetId;
                        resolvedPostCode = target.code;
                    } else {
                        resolvedBaseId = target.targetId;
                    }
                }

                const effectiveShift = formState.shiftOverride === "P_INV" ? "P" : (formState.shiftOverride || shiftLabel);
                const startedAtIso = toIsoDateTime(formState.startedAt);

                // Continuity: find the doctor's current active occupancy if available (hint for service)
                // The service auto-resolves continuityGroupId and boardStartedAt from the chain
                let continuityPreviousOccupancyId: string | null = null;
                if (isContinuityEntry && formState.doctorId) {
                    const activeCard = allCards.find(
                        (card) => card.doctorId === formState.doctorId && card.status === "active" && card.occupancyId,
                    );
                    if (activeCard?.occupancyId) {
                        continuityPreviousOccupancyId = activeCard.occupancyId;
                    }
                }

                // For continuity, boardStartedAt is null — the service resolves it from the chain
                const boardStartedAtIso = isContinuityEntry
                    ? null
                    : effectiveShift === "P"
                        ? null
                        : startedAtIso;

                const startNotes = isContinuityEntry && normalizedNotes
                    ? `[Continuidade do turno anterior] ${normalizedNotes}`
                    : normalizedNotes;

                endpoint = selectedCard.domain === "regulation"
                    ? "/api/regulation/occupancies"
                    : "/api/intervention/occupancies";
                payload = selectedCard.domain === "regulation"
                    ? {
                        doctorId: formState.doctorId,
                        postId: resolvedPostId,
                        previousOccupancyId: continuityPreviousOccupancyId,
                        isContinuityEntry: isContinuityEntry || undefined,
                        startedAt: startedAtIso,
                        boardStartedAt: boardStartedAtIso,
                        scheduledStartAt: null,
                        scheduledEndAt: null,
                        shiftLabel: effectiveShift,
                        roleLabel: trimToNull(formState.roleLabel),
                        ramalLabel: resolvedPostCode,
                        source: "admin_correction",
                        notes: startNotes,
                    }
                    : {
                        doctorId: formState.doctorId,
                        baseId: resolvedBaseId,
                        previousOccupancyId: continuityPreviousOccupancyId,
                        isContinuityEntry: isContinuityEntry || undefined,
                        startedAt: startedAtIso,
                        boardStartedAt: boardStartedAtIso,
                        scheduledStartAt: null,
                        scheduledEndAt: null,
                        shiftLabel: effectiveShift,
                        roleLabel: trimToNull(formState.roleLabel),
                        source: "admin_correction",
                        notes: startNotes,
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
                    : isContinuityEntry
                        ? "Continuidade registrada. Quadro, banco de horas e prioridade de refeicao atualizados."
                        : isTransferAction
                            ? "Remanejamento aplicado. Quadro, pagamento e banco de horas foram recalculados."
                            : "Acao aplicada. Atualizando o quadro operacional.",
            );
            resetTransferFlow();
            setActionMode(null);
            setSelectedCard(null);
            setIsContinuityEntry(false);
            setProfessionalDrawerOpen(false);
            if (session?.canManage) void fetchLatestUndoableAction();
            startRefresh(() => {
                router.refresh();
            });
        } catch (error) {
            setErrorMessage(error instanceof Error ? error.message : "Falha operacional inesperada.");
        } finally {
            setIsSubmitting(false);
        }
    }

    async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
        event.preventDefault();
        await submitOperationalAction();
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
            setProfessionalDrawerOpen(false);
            if (session?.canManage) void fetchLatestUndoableAction();
            startRefresh(() => {
                router.refresh();
            });
        } catch (error) {
            setErrorMessage(error instanceof Error ? error.message : "Falha operacional inesperada.");
        } finally {
            setIsSubmitting(false);
        }
    }

    async function handleKickShiftEnd(card: BoardCard, shiftEndIso: string) {
        if (!session?.canManage || !card.occupancyId) return;
        setKickConfirmCardKey(null);
        try {
            setIsSubmitting(true);
            setErrorMessage(null);
            setSuccessMessage(null);
            const endpoint = card.domain === "regulation"
                ? `/api/regulation/occupancies/${card.occupancyId}/end`
                : `/api/intervention/occupancies/${card.occupancyId}/end`;
            const response = await fetch(endpoint, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    endedAt: shiftEndIso,
                    actualEndedAt: shiftEndIso,
                    notes: "Saída por encerramento de turno (retirada pelo chefe)",
                    chiefKick: true,
                }),
            });
            const responseBody = await response.json().catch(() => null) as { error?: string } | null;
            if (!response.ok) throw new Error(responseBody?.error || "Falha ao retirar plantonista.");
            setSuccessMessage("Plantonista retirado. Banco de horas e quadro atualizados.");
            if (session?.canManage) void fetchLatestUndoableAction();
            startRefresh(() => { router.refresh(); });
        } catch (error) {
            setErrorMessage(error instanceof Error ? error.message : "Falha operacional inesperada.");
        } finally {
            setIsSubmitting(false);
        }
    }

    async function handleCardState(card: BoardCard, action: "deactivate" | "reactivate") {
        if (!session?.canManage) {
            setErrorMessage(`Entre com perfil chief ou admin para atualizar o estado d${card.domain === "regulation" ? "o" : "a"} ${cardStateSubject(card)}.`);
            return;
        }

        try {
            setIsSubmitting(true);
            setErrorMessage(null);
            setSuccessMessage(null);

            const endpoint = card.domain === "regulation"
                ? `/api/regulation/posts/${card.postId}/state`
                : `/api/intervention/bases/${card.baseId}/state`;

            const response = await fetch(endpoint, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    action,
                    effectiveAt: toIsoDateTime(baseStateAt),
                    notes: trimToNull(baseStateReason),
                }),
            });

            const responseBody = await response.json().catch(() => null) as { error?: string; closedOccupancyIds?: string[] } | null;
            if (!response.ok) {
                throw new Error(responseBody?.error || `Falha ao atualizar o estado d${card.domain === "regulation" ? "o" : "a"} ${cardStateSubject(card)}.`);
            }

            setBaseStateReason("");
            setSuccessMessage(
                action === "deactivate"
                    ? `${card.domain === "regulation" ? "Ramal desativado" : "Base desativada"}. ${responseBody?.closedOccupancyIds?.length ? "Coberturas abertas foram encerradas com auditoria." : "Quadro atualizado."}`
                    : `${card.domain === "regulation" ? "Ramal reativado" : "Base reativada"} e ${card.domain === "regulation" ? "liberado" : "liberada"} para nova cobertura.`,
            );
            setActionMode(action === "reactivate" ? "start" : null);
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

    async function handleNightMealBreakSave() {
        if (!selectedCard || selectedCard.domain !== "regulation" || !session?.canManage) {
            return;
        }

        try {
            setIsMealBreakSaving(true);
            setErrorMessage(null);
            setSuccessMessage(null);

            const response = await fetch(`/api/board/meal-breaks/regulation/${selectedCard.postCode}`, {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    referenceAt: generatedAt,
                    nightWorkSlot: nightWorkInput || null,
                    dinnerSlot: nightWorkInput === "03:00" ? null : dinnerInput || null,
                }),
            });

            const responseBody = await response.json().catch(() => null) as { error?: string } | null;
            if (!response.ok) {
                throw new Error(responseBody?.error || "Falha ao atualizar jantar ou trabalho da noite.");
            }

            setSuccessMessage("Jantar e trabalho da noite atualizados no quadro.");
            startRefresh(() => {
                router.refresh();
            });
        } catch (error) {
            setErrorMessage(error instanceof Error ? error.message : "Falha operacional inesperada.");
        } finally {
            setIsMealBreakSaving(false);
        }
    }

    async function handleDayMealBreakSlotSave() {
        if (!selectedCard || selectedCard.domain !== "regulation" || !session?.canManage) {
            return;
        }

        try {
            setIsMealBreakSaving(true);
            setErrorMessage(null);
            setSuccessMessage(null);

            const response = await fetch(`/api/board/meal-breaks/regulation/${selectedCard.postCode}`, {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    referenceAt: generatedAt,
                    lunchSlot: lunchSlotInput || null,
                    restSlot: restSlotInput || null,
                }),
            });

            const responseBody = await response.json().catch(() => null) as { error?: string } | null;
            if (!response.ok) {
                throw new Error(responseBody?.error || "Falha ao atualizar almoco ou descanso.");
            }

            setSuccessMessage("Almoco e descanso atualizados no quadro.");
            startRefresh(() => {
                router.refresh();
            });
        } catch (error) {
            setErrorMessage(error instanceof Error ? error.message : "Falha operacional inesperada.");
        } finally {
            setIsMealBreakSaving(false);
        }
    }

    async function handleDayMealBreakToggle(kind: "lunch" | "rest", excluded: boolean) {
        if (!selectedCard || selectedCard.domain !== "regulation" || !session?.canManage) {
            return;
        }

        try {
            setIsMealBreakSaving(true);
            setErrorMessage(null);
            setSuccessMessage(null);

            const response = await fetch(`/api/board/meal-breaks/regulation/${selectedCard.postCode}`, {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    referenceAt: generatedAt,
                    ...(kind === "lunch" ? { lunchExcluded: excluded } : { restExcluded: excluded }),
                }),
            });

            const responseBody = await response.json().catch(() => null) as { error?: string } | null;
            if (!response.ok) {
                throw new Error(responseBody?.error || "Falha ao atualizar a divisao diurna.");
            }

            setSuccessMessage(
                kind === "lunch"
                    ? excluded
                        ? "Medico retirado da divisao de almoco."
                        : "Medico recolocado na divisao de almoco."
                    : excluded
                        ? "Medico retirado da divisao de descanso."
                        : "Medico recolocado na divisao de descanso.",
            );
            startRefresh(() => {
                router.refresh();
            });
        } catch (error) {
            setErrorMessage(error instanceof Error ? error.message : "Falha operacional inesperada.");
        } finally {
            setIsMealBreakSaving(false);
        }
    }

    function renderScheduleChip(params: {
        slot: string | null;
        kind: "lunch" | "rest" | "dinner" | "work";
        pending?: boolean;
        duration?: MealBreakDinnerDuration | null;
        excluded?: boolean;
    }) {
        if (params.excluded) {
            return <span className={`ops-slot-chip excluded ${params.kind}`.trim()}>Fora</span>;
        }

        if (!params.slot) {
            return <span className={`ops-slot-chip pending ${params.kind}`.trim()}>Pendente</span>;
        }

        const durationClass = params.kind === "dinner" && params.duration
            ? `duration-${params.duration === "one_hour" ? "one-hour" : "half-hour"}`
            : "";

        return <span className={`ops-slot-chip ${params.kind} ${durationClass}`.trim()}>{params.slot}</span>;
    }

    function renderCardIdentityTags(card: BoardCard) {
        if (card.domain === "regulation" && isOperationalRoleRemovalSentinel(card.roleLabel)) {
            return null;
        }

        const items: React.ReactNode[] = [];
        const roleLabel = resolveCardRoleLabel(card);
        const sessionRecip = card.domain === "regulation" && isRecipRamal(mealBreakSession, card.postCode);
        const seenLabels = new Set<string>(dedupeOperationalIdentityLabels([roleLabel]));

        if (roleLabel && !(roleLabel === "RECIP" && sessionRecip)) {
            items.push(<span key={`role-${cardCode(card)}`} className={`ops-role-badge ${getOperationalRoleTone(roleLabel)}`.trim()}>{roleLabel}</span>);
        }

        if (card.domain === "regulation") {
            if (isMrvRamal(mealBreakSession, card.postCode) && mealBreakDisplayMode !== "night" && !seenLabels.has("MRV")) {
                items.push(<span key={`mrv-${card.postCode}`} className="ops-inline-flag mrv">MRV</span>);
                seenLabels.add("MRV");
            }

            if (sessionRecip && !seenLabels.has("RECIP")) {
                items.push(<span key={`recip-${card.postCode}`} className="ops-inline-flag recip">RECIP</span>);
                seenLabels.add("RECIP");
            }
        }

        return items.length > 0 ? <span className="ops-name-tag-row">{items}</span> : null;
    }

    function handleBoardRowKeyDown(event: React.KeyboardEvent<HTMLDivElement>, card: BoardCard) {
        if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            openProfessionalDrawer(card);
        }
    }

    function renderRegulationRow(card: RegulationCard) {
        const emphasisClass = rowEmphasisClass(card, shiftLabel, generatedAt, mealBreakSession);
        const isDisabledRegulation = card.status === "disabled";
        const lunchSlot = mealBreakDisplayMode === "night"
            ? resolveMealBreakSlot<MealBreakDinnerSlot>(mealBreakSession, card.postCode, "dinnerAssignments")
            : resolveMealBreakSlot<MealBreakLunchSlot>(mealBreakSession, card.postCode, "lunchAssignments");
        const restSlot = mealBreakDisplayMode === "night"
            ? resolveMealBreakSlot<MealBreakNightWorkSlot>(mealBreakSession, card.postCode, "nightWorkAssignments")
            : resolveMealBreakSlot<MealBreakRestSlot>(mealBreakSession, card.postCode, "restAssignments");
        const rowRoleLabel = resolveCardRoleLabel(card);
        const isRowIsolatedOrDiscretionary = mealBreakDisplayMode === "day" && (rowRoleLabel === "PSIQ" || rowRoleLabel === "CP");
        const lunchExcluded = isSystemicallyExcludedFromMealBreak(card.postCode, mealBreakDisplayMode)
            || (mealBreakDisplayMode === "day" && isMealBreakExcluded(mealBreakSession, card.postCode, "lunch"))
            || isRowIsolatedOrDiscretionary
            || (!mealBreakSession && mealBreakDisplayMode === "day" && mealBreakEligibility.lunchExcludedRamals.includes(card.postCode));
        const restExcluded = isSystemicallyExcludedFromMealBreak(card.postCode, mealBreakDisplayMode)
            || (mealBreakDisplayMode === "day" && isMealBreakExcluded(mealBreakSession, card.postCode, "rest"))
            || isRowIsolatedOrDiscretionary
            || (!mealBreakSession && mealBreakDisplayMode === "day" && mealBreakEligibility.restExcludedRamals.includes(card.postCode));
        const dinnerDuration = mealBreakDisplayMode === "night" ? resolveDinnerDuration(mealBreakSession, card.postCode) : null;
        const clickable = Boolean(session?.canManage);
        const direction = resolveOccupancyDirection({
            startedAt: card.startedAt,
            scheduledEndAt: card.scheduledEndAt,
            shiftLabel: card.shiftLabel,
            reference: generatedAt,
        });
        const isLeaving = direction.status === "saindo";
        const cardKey = `${card.domain}-${card.postCode}`;
        const showKickButton = clickable && !isDisabledRegulation && card.status === "active" && card.occupancyId && isLeaving;
        const isKickConfirming = kickConfirmCardKey === cardKey;

        const cardPriority = resolvePriority(card, generatedAt);
        const isExpanded = expandedCardKey === cardKey;
        return (
            <div key={cardKey} className={`ops-grid-row-group ${isExpanded ? "is-expanded" : ""}`.trim()}>
            <div
                role="row"
                className={`ops-grid-row regulation ${emphasisClass} priority-${cardPriority} ${isLeaving ? "is-leaving" : ""} ${clickable ? "clickable" : ""} ${isExpanded ? "is-expanded" : ""}`.trim()}
                onClick={clickable ? () => { setKickConfirmCardKey(null); setExpandedCardKey((prev) => prev === cardKey ? null : cardKey); } : undefined}
                onKeyDown={clickable ? (event) => handleBoardRowKeyDown(event, card) : undefined}
                tabIndex={clickable ? 0 : undefined}
                aria-expanded={clickable ? isExpanded : undefined}
                aria-label={clickable ? `Expandir ações de ${displayDoctorName(card)} no ramal ${card.postCode}` : undefined}
            >
                <div role="cell" className="ops-grid-cell column-time">
                    {clickable && card.status === "active" && card.occupancyId ? (
                        <InlineTimeEditor
                            domain="regulation"
                            occupancyId={card.occupancyId}
                            field="arrival"
                            currentIso={resolveOperationalArrival(card)}
                            doctorName={displayDoctorName(card)}
                            targetCode={card.postCode}
                        >
                            {({ value }) => <span className="ops-time-pill"><strong>{value}</strong></span>}
                        </InlineTimeEditor>
                    ) : (
                        <span className={`ops-time-pill ${isDisabledRegulation ? "disabled" : ""}`.trim()}><strong>{isDisabledRegulation ? formatBoardTime(card.disabledAt ?? null) : formatBoardTime(resolveOperationalArrival(card))}</strong></span>
                    )}
                </div>
                <div role="cell" className="ops-grid-cell column-code">
                    <div className="ops-code-stack rail">
                        <strong>{card.postCode}</strong>
                    </div>
                </div>
                <div role="cell" className="ops-grid-cell column-name">
                    <div className="ops-doctor-stack compact">
                        <div className="ops-doctor-line primary">
                            <strong title={displayDoctorName(card)}>{displayDoctorName(card)}</strong>
                            {renderCardIdentityTags(card)}
                            {isDisabledRegulation && <span className="ops-inline-flag disabled">Desativado</span>}
                        </div>
                        {isDisabledRegulation ? (
                            <div className="ops-inline-flags subtle">
                                {card.disabledAt && <span className="ops-doctor-note continuation">Desde {formatBoardTime(card.disabledAt)}</span>}
                                {card.disabledReason && <span className="ops-doctor-note continuation">{card.disabledReason}</span>}
                            </div>
                        ) : showKickButton ? (
                            <div className="ops-inline-flags subtle">
                                {isKickConfirming ? (
                                    <button
                                        type="button"
                                        className="ops-kick-confirm-button"
                                        onClick={(e) => { e.stopPropagation(); void handleKickShiftEnd(card, direction.shiftEndAt); }}
                                        disabled={isSubmitting || isRefreshing}
                                    >
                                        Confirmar retirada
                                    </button>
                                ) : (
                                    <button
                                        type="button"
                                        className="ops-kick-button"
                                        onClick={(e) => { e.stopPropagation(); setKickConfirmCardKey(cardKey); }}
                                        disabled={isSubmitting || isRefreshing}
                                    >
                                        Retirar
                                    </button>
                                )}
                            </div>
                        ) : null}
                    </div>
                </div>
                <div role="cell" className="ops-grid-cell column-lunch">
                    {clickable && !lunchExcluded && !isDisabledRegulation ? (
                        <MealSlotPicker
                            ramal={card.postCode}
                            kind={(mealBreakDisplayMode === "night" ? "dinner" : "lunch") as MealKind}
                            currentSlot={lunchSlot ?? null}
                            doctorName={displayDoctorName(card)}
                        >
                            {renderScheduleChip({
                                slot: lunchSlot,
                                kind: mealBreakDisplayMode === "night" ? "dinner" : "lunch",
                                pending: !lunchSlot,
                                duration: dinnerDuration,
                                excluded: lunchExcluded,
                            })}
                        </MealSlotPicker>
                    ) : renderScheduleChip({
                        slot: lunchSlot,
                        kind: mealBreakDisplayMode === "night" ? "dinner" : "lunch",
                        pending: !lunchSlot,
                        duration: dinnerDuration,
                        excluded: lunchExcluded,
                    })}
                </div>
                <div role="cell" className="ops-grid-cell column-rest">
                    {clickable && !restExcluded && !isDisabledRegulation ? (
                        <MealSlotPicker
                            ramal={card.postCode}
                            kind={(mealBreakDisplayMode === "night" ? "work" : "rest") as MealKind}
                            currentSlot={restSlot ?? null}
                            doctorName={displayDoctorName(card)}
                        >
                            {renderScheduleChip({
                                slot: restSlot,
                                kind: mealBreakDisplayMode === "night" ? "work" : "rest",
                                pending: !restSlot,
                                excluded: restExcluded,
                            })}
                        </MealSlotPicker>
                    ) : renderScheduleChip({
                        slot: restSlot,
                        kind: mealBreakDisplayMode === "night" ? "work" : "rest",
                        pending: !restSlot,
                        excluded: restExcluded,
                    })}
                </div>
            </div>
            <AnimatePresence initial={false}>
                {isExpanded && clickable && (
                    <RowActions
                        domain="regulation"
                        targetId={card.postId}
                        targetCode={card.postCode}
                        targetLabel={card.postLabel}
                        occupancyId={card.occupancyId ?? null}
                        doctorName={displayDoctorName(card)}
                        currentRole={resolveCardRoleLabel(card)}
                        isDisabled={isDisabledRegulation}
                        onOpenAdvanced={() => { setExpandedCardKey(null); openProfessionalDrawer(card); }}
                    />
                )}
            </AnimatePresence>
            </div>
        );
    }

    function renderInterventionRow(card: InterventionCard) {
        const emphasisClass = rowEmphasisClass(card, shiftLabel, generatedAt, mealBreakSession);
        const isClickable = Boolean(session?.canManage);
        const isDisabledIntervention = card.status === "disabled";
        const isWaitingIntervention = card.status === "waiting";
        const lineState = resolveInterventionLineState({
            startedAt: card.startedAt,
            boardStartedAt: card.boardStartedAt,
            scheduledEndAt: card.scheduledEndAt,
            shiftLabel: card.shiftLabel,
            reference: generatedAt,
        });
        const isLeaving = lineState.kind === "saindo";
        const kickShiftEndAt = lineState.kind === "saindo" ? lineState.shiftEndAt : null;
        // "VERIFICAR" e o realce de saida andam juntos com o botao "Retirar",
        // uniforme para todo o grupo que esta saindo.
        const isAwaitingNews = isLeaving;
        // Carry-over de turno anterior: so a palavra "Continua" (sem horario).
        const continuationLabel = lineState.kind === "continua" ? "Continua" : null;
        const isSaoPauloNightShift = getSaoPauloParts(generatedAt).hour >= 19 || getSaoPauloParts(generatedAt).hour < 7;
        const showSecondaryFlags = isAwaitingNews || Boolean(continuationLabel);
        const intCardKey = `${card.domain}-${card.baseCode}`;
        const showKickButton = isClickable && !isDisabledIntervention && !isWaitingIntervention
            && card.status === "active" && card.occupancyId && isLeaving;
        const isKickConfirming = kickConfirmCardKey === intCardKey;

        const intCardPriority = resolvePriority(card, generatedAt);
        const isIntExpanded = expandedCardKey === intCardKey;
        return (
            <div key={intCardKey} className={`ops-grid-row-group ${isIntExpanded ? "is-expanded" : ""}`.trim()}>
            <div
                role="row"
                className={`ops-grid-row intervention ${emphasisClass} priority-${intCardPriority} ${isLeaving ? "is-leaving" : ""} ${isClickable ? "clickable" : ""} ${isIntExpanded ? "is-expanded" : ""}`.trim()}
                onClick={isClickable ? () => { setKickConfirmCardKey(null); setExpandedCardKey((prev) => prev === intCardKey ? null : intCardKey); } : undefined}
                onKeyDown={isClickable ? (event) => handleBoardRowKeyDown(event, card) : undefined}
                tabIndex={isClickable ? 0 : undefined}
                aria-expanded={isClickable ? isIntExpanded : undefined}
                aria-label={isClickable ? `Expandir ações de ${displayDoctorName(card)} na base ${card.baseCode}` : undefined}
            >
                <div role="cell" className="ops-grid-cell column-time">
                    {isClickable && card.status === "active" && card.occupancyId ? (
                        <InlineTimeEditor
                            domain="intervention"
                            occupancyId={card.occupancyId}
                            field="arrival"
                            currentIso={resolveOperationalArrival(card)}
                            doctorName={displayDoctorName(card)}
                            targetCode={card.baseCode}
                        >
                            {({ value }) => (
                                <span className={`ops-time-pill ${isAwaitingNews ? "verification" : ""}`.trim()}>
                                    <strong>{value}</strong>
                                </span>
                            )}
                        </InlineTimeEditor>
                    ) : (
                        <span className={`ops-time-pill ${isDisabledIntervention ? "disabled" : ""} ${isWaitingIntervention ? "waiting" : ""} ${isAwaitingNews ? "verification" : ""}`.trim()}>
                            <strong>{isDisabledIntervention ? formatBoardTime(card.disabledAt ?? null) : isWaitingIntervention ? "Livre" : formatBoardTime(resolveOperationalArrival(card))}</strong>
                        </span>
                    )}
                </div>
                <div role="cell" className="ops-grid-cell column-code">
                    <div className="ops-code-stack rail">
                        <strong>{card.baseCode}</strong>
                    </div>
                </div>
                <div role="cell" className="ops-grid-cell column-name">
                    <div className="ops-doctor-stack compact">
                        <div className="ops-doctor-line primary">
                            <strong title={displayDoctorName(card)}>{displayDoctorName(card)}</strong>
                            {renderCardIdentityTags(card)}
                            {isDisabledIntervention && <span className="ops-inline-flag disabled">Desativada</span>}
                        </div>
                        {isDisabledIntervention ? (
                            <div className="ops-inline-flags subtle">
                                {card.disabledAt && <span className="ops-doctor-note continuation">Desde {formatBoardTime(card.disabledAt)}</span>}
                                {card.disabledReason && <span className="ops-doctor-note continuation">{card.disabledReason}</span>}
                            </div>
                        ) : showKickButton ? (
                            <div className="ops-inline-flags subtle">
                                {isAwaitingNews && <span className="ops-inline-flag waiting">Verificar</span>}
                                {continuationLabel && <span className={`ops-doctor-note continuation ${isSaoPauloNightShift ? "night" : "day"}`.trim()}>{continuationLabel}</span>}
                                {isKickConfirming ? (
                                    <button
                                        type="button"
                                        className="ops-kick-confirm-button"
                                        onClick={(e) => { e.stopPropagation(); if (kickShiftEndAt) void handleKickShiftEnd(card, kickShiftEndAt); }}
                                        disabled={isSubmitting || isRefreshing}
                                    >
                                        Confirmar retirada
                                    </button>
                                ) : (
                                    <button
                                        type="button"
                                        className="ops-kick-button"
                                        onClick={(e) => { e.stopPropagation(); setKickConfirmCardKey(intCardKey); }}
                                        disabled={isSubmitting || isRefreshing}
                                    >
                                        Retirar
                                    </button>
                                )}
                            </div>
                        ) : showSecondaryFlags ? (
                            <div className="ops-inline-flags subtle">
                                {isAwaitingNews && <span className="ops-inline-flag waiting">Verificar</span>}
                                {continuationLabel && <span className={`ops-doctor-note continuation ${isSaoPauloNightShift ? "night" : "day"}`.trim()}>{continuationLabel}</span>}
                            </div>
                        ) : null}
                    </div>
                </div>
            </div>
            <AnimatePresence initial={false}>
                {isIntExpanded && isClickable && !isWaitingIntervention && (
                    <RowActions
                        domain="intervention"
                        targetId={card.baseId}
                        targetCode={card.baseCode}
                        targetLabel={card.baseLabel}
                        occupancyId={card.occupancyId ?? null}
                        doctorName={displayDoctorName(card)}
                        currentRole={resolveCardRoleLabel(card)}
                        isDisabled={isDisabledIntervention}
                        onOpenAdvanced={() => { setExpandedCardKey(null); openProfessionalDrawer(card); }}
                    />
                )}
            </AnimatePresence>
            </div>
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
            {viewMode === "live" && session?.canManage && pendingDepartures.length > 0 && (
                <AuditRail
                    pendingDepartures={pendingDepartures}
                    onOpenVerifier={setVerifierTarget}
                />
            )}

            {viewMode === "live" && session?.canManage && recentHandoffs.length > 0 && (
                <RecentHandoffsRail recentHandoffs={recentHandoffs} />
            )}

            {session?.canManage && (
                <DepartureVerifier
                    target={verifierTarget}
                    onClose={() => setVerifierTarget(null)}
                />
            )}

            {session?.canManage && (
                <CommandPalette
                    pendingDepartures={pendingDepartures}
                    onConfirm={quickConfirmDeparture}
                    onOpenVerifier={setVerifierTarget}
                />
            )}

            {viewMode === "live" && (
                <div className={`ops-auth-dock ${authOpen ? "open" : ""}`.trim()}>
                    {session?.canManage && (
                        <button
                            type="button"
                            className="ops-history-trigger historical-review"
                            aria-label="Abrir auditoria histórica da cobertura"
                            title="Modo histórico"
                            onClick={() => {
                                setPreviousShiftOpen(false);
                                setAuthOpen(false);
                                setDrawerOpen(false);
                                setProfessionalDrawerOpen(false);
                                setPriorityDrawerOpen(false);
                                setTransferConfirmOpen(false);
                                setViewMode("history");
                            }}
                        >
                            <span className="ops-history-trigger-icon" aria-hidden="true">
                                <svg viewBox="0 0 24 24" focusable="false">
                                    <path d="M12 3.25a8.75 8.75 0 1 0 8.53 10.7.75.75 0 1 0-1.46-.35A7.25 7.25 0 1 1 12 4.75c1.94 0 3.7.76 5 2l-1.87.01a.75.75 0 0 0 0 1.5h3.67a.75.75 0 0 0 .75-.75V3.84a.75.75 0 0 0-1.5 0v1.79A8.7 8.7 0 0 0 12 3.25Zm-.75 4.5a.75.75 0 0 1 1.5 0v3.89l2.37 1.58a.75.75 0 0 1-.84 1.24l-2.7-1.8a.75.75 0 0 1-.33-.62V7.75Z" />
                                </svg>
                            </span>
                            <span className="ops-history-trigger-label">Histórico operacional</span>
                        </button>
                    )}

                    {session?.canManage && (
                        <button
                            type="button"
                            className="ops-history-trigger"
                            aria-label="Abrir fechamento do plantão anterior"
                            title="Plantão anterior"
                            onClick={() => {
                                setAuthOpen(false);
                                setDrawerOpen(false);
                                setProfessionalDrawerOpen(false);
                                setPriorityDrawerOpen(false);
                                setTransferConfirmOpen(false);
                                router.push("/historico/turno-anterior");
                            }}
                        >
                            <span className="ops-history-trigger-icon" aria-hidden="true">
                                <svg viewBox="0 0 24 24" focusable="false">
                                    <path d="M12 3.25a8.75 8.75 0 1 0 8.53 10.7.75.75 0 1 0-1.46-.35A7.25 7.25 0 1 1 12 4.75c1.94 0 3.7.76 5 2l-1.87.01a.75.75 0 0 0 0 1.5h3.67a.75.75 0 0 0 .75-.75V3.84a.75.75 0 0 0-1.5 0v1.79A8.7 8.7 0 0 0 12 3.25Zm-.75 4.5a.75.75 0 0 1 1.5 0v3.89l2.37 1.58a.75.75 0 0 1-.84 1.24l-2.7-1.8a.75.75 0 0 1-.33-.62V7.75Z" />
                                </svg>
                            </span>
                            <span className="ops-history-trigger-label">Plantão anterior</span>
                        </button>
                    )}

                    {session?.canManage && (
                        <button
                            type="button"
                            className="ops-history-trigger command-drawer"
                            aria-label="Abrir fila critica e vigilancia"
                            title="Fila critica"
                            onClick={() => {
                                setPreviousShiftOpen(false);
                                setAuthOpen(false);
                                setProfessionalDrawerOpen(false);
                                setPriorityDrawerOpen(false);
                                setTransferConfirmOpen(false);
                                openDrawer();
                            }}
                        >
                            <span className="ops-history-trigger-icon" aria-hidden="true">
                                <svg viewBox="0 0 24 24" focusable="false">
                                    <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z" />
                                </svg>
                            </span>
                            <span className="ops-history-trigger-label">Fila crítica</span>
                            {criticalCards.length > 0 && (
                                <span className="ops-trigger-badge critical">{criticalCards.length}</span>
                            )}
                        </button>
                    )}

                    {session?.canManage && (
                        <button
                            type="button"
                            className="ops-history-trigger priorities"
                            aria-label="Abrir fila de prioridades do meal break"
                            title="Prioridades"
                            onClick={() => {
                                setPreviousShiftOpen(false);
                                setAuthOpen(false);
                                setDrawerOpen(false);
                                setProfessionalDrawerOpen(false);
                                setTransferConfirmOpen(false);
                                void openPriorityDrawer();
                            }}
                        >
                            <span className="ops-history-trigger-icon" aria-hidden="true">
                                <svg viewBox="0 0 24 24" focusable="false">
                                    <path d="M4.75 5.25a.75.75 0 0 1 .75-.75h3a.75.75 0 0 1 0 1.5h-3a.75.75 0 0 1-.75-.75Zm0 6a.75.75 0 0 1 .75-.75h3a.75.75 0 0 1 0 1.5h-3a.75.75 0 0 1-.75-.75Zm.75 5.25a.75.75 0 0 0 0 1.5h3a.75.75 0 0 0 0-1.5h-3Zm5.75-10.5a.75.75 0 0 1 .75-.75h6.5a.75.75 0 0 1 0 1.5H12a.75.75 0 0 1-.75-.75Zm0 6a.75.75 0 0 1 .75-.75h6.5a.75.75 0 0 1 0 1.5H12a.75.75 0 0 1-.75-.75Zm.75 4.5a.75.75 0 0 0 0 1.5h6.5a.75.75 0 0 0 0-1.5H12Z" />
                                </svg>
                            </span>
                            <span className="ops-history-trigger-label">Prioridades refeição</span>
                        </button>
                    )}

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
                            <span className="ops-history-trigger-label">Alocação pagamento</span>
                        </button>
                    )}

                    {session?.roles.includes("admin") && !session.mustChangePassword && (
                        <button
                            type="button"
                            className="ops-history-trigger payment-allocation"
                            aria-label="Abrir visão principal de pagamento"
                            title="Fechamento de pagamento"
                            onClick={() => {
                                setPreviousShiftOpen(false);
                                setAuthOpen(false);
                                router.push("/admin/payment-closing");
                            }}
                        >
                            <span className="ops-history-trigger-icon" aria-hidden="true">
                                <svg viewBox="0 0 24 24" focusable="false">
                                    <path d="M3 6.75A2.75 2.75 0 0 1 5.75 4h12.5A2.75 2.75 0 0 1 21 6.75v10.5A2.75 2.75 0 0 1 18.25 20H5.75A2.75 2.75 0 0 1 3 17.25V6.75Zm2.75-1.25A1.25 1.25 0 0 0 4.5 6.75v10.5A1.25 1.25 0 0 0 5.75 18.5h12.5a1.25 1.25 0 0 0 1.25-1.25V6.75a1.25 1.25 0 0 0-1.25-1.25H5.75Zm1.5 3a.75.75 0 0 1 .75-.75h8a.75.75 0 0 1 0 1.5h-8a.75.75 0 0 1-.75-.75Zm0 3.75a.75.75 0 0 1 .75-.75h5.5a.75.75 0 0 1 0 1.5H8a.75.75 0 0 1-.75-.75Zm0 3.75a.75.75 0 0 1 .75-.75h3.25a.75.75 0 0 1 0 1.5H8a.75.75 0 0 1-.75-.75Z" />
                                </svg>
                            </span>
                            <span className="ops-history-trigger-label">Fechamento pagamento</span>
                        </button>
                    )}

                    {session?.roles.includes("admin") && !session.mustChangePassword && (
                        <button
                            type="button"
                            className="ops-history-trigger slot-audit"
                            aria-label="Abrir auditoria historica de slots"
                            title="Auditoria de slots"
                            onClick={() => {
                                setPreviousShiftOpen(false);
                                setAuthOpen(false);
                                router.push("/admin/slot-audit");
                            }}
                        >
                            <span className="ops-history-trigger-icon" aria-hidden="true">
                                <svg viewBox="0 0 24 24" focusable="false">
                                    <path d="M6.75 3.5A2.75 2.75 0 0 0 4 6.25v11A2.75 2.75 0 0 0 6.75 20h10.5A2.75 2.75 0 0 0 20 17.25v-11A2.75 2.75 0 0 0 17.25 3.5H6.75Zm0 1.5h10.5A1.25 1.25 0 0 1 18.5 6.25v11a1.25 1.25 0 0 1-1.25 1.25H6.75A1.25 1.25 0 0 1 5.5 17.25v-11A1.25 1.25 0 0 1 6.75 5Zm1.5 2.25a.75.75 0 0 0 0 1.5h7.5a.75.75 0 0 0 0-1.5h-7.5Zm0 4a.75.75 0 0 0 0 1.5h3.75a.75.75 0 0 0 0-1.5H8.25Zm0 4a.75.75 0 0 0 0 1.5h7.5a.75.75 0 0 0 0-1.5h-7.5Z" />
                                </svg>
                            </span>
                            <span className="ops-history-trigger-label">Auditoria de slots</span>
                        </button>
                    )}

                    {session?.roles.includes("admin") && !session.mustChangePassword && (
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
                            <span className="ops-history-trigger-label">Banco de horas</span>
                        </button>
                    )}

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
                                    <>
                                        <a className="ops-auth-inline-link" href="/admin/payment-closing">
                                            Abrir fechamento de pagamento
                                        </a>
                                        <a className="ops-auth-inline-link" href="/admin/slot-audit">
                                            Auditar slots historicos
                                        </a>
                                        <a className="ops-auth-inline-link" href="/admin/chief-access">
                                            Provisionar chief
                                        </a>
                                        <a className="ops-auth-inline-link" href="/admin/reports">
                                            Abrir auditoria mensal
                                        </a>
                                    </>
                                )}

                                {session.roles.includes("chief") && !session.mustChangePassword && !session.roles.includes("admin") && (
                                    <a className="ops-auth-inline-link" href="/admin/payment-closing">
                                        Abrir fechamento de pagamento
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
            )}

            {viewMode === "live" && (authError || authInfo) && (
                <div className={`ops-auth-toast ${authError ? "error" : "success"}`.trim()}>
                    {authError || authInfo}
                </div>
            )}

            {undoBanner && (
                <div className="ops-undo-banner">
                    <div className="ops-undo-banner-content">
                        <span className="ops-undo-banner-label">{undoBanner.message}</span>
                        {undoNotesOpen ? (
                            <div className="ops-undo-form">
                                <input
                                    type="text"
                                    className="ops-undo-notes-input"
                                    placeholder="Motivo do desfazer (min. 8 caracteres)"
                                    value={undoNotes}
                                    onChange={(event) => setUndoNotes(event.target.value)}
                                    autoFocus
                                />
                                <button
                                    type="button"
                                    className="ops-undo-confirm-btn"
                                    disabled={isUndoing || undoNotes.trim().length < 8}
                                    onClick={() => void handleUndo()}
                                >
                                    {isUndoing ? "Desfazendo..." : "Confirmar"}
                                </button>
                                <button
                                    type="button"
                                    className="ops-undo-cancel-btn"
                                    onClick={() => { setUndoNotesOpen(false); setUndoNotes(""); }}
                                >
                                    Cancelar
                                </button>
                            </div>
                        ) : (
                            <button
                                type="button"
                                className="ops-undo-btn"
                                onClick={() => setUndoNotesOpen(true)}
                            >
                                Desfazer
                            </button>
                        )}
                        <button
                            type="button"
                            className="ops-undo-dismiss"
                            onClick={() => setUndoBanner(null)}
                            aria-label="Fechar"
                        >
                            ✕
                        </button>
                    </div>
                </div>
            )}

            <main className={`ops-shell ${viewMode === "history" ? "ops-shell-history" : ""}`.trim()}>
                {viewMode === "history" ? (
                    <OperationalHistoryPanel
                        session={session}
                        doctors={doctors}
                        onReturnLive={() => setViewMode("live")}
                    />
                ) : (
                    <section className="ops-command-center">
                        <BoardHero
                            shiftLabel={shiftLabel}
                            generatedAt={generatedAt}
                            regulationOccupied={regulationOccupiedCount}
                            regulationFree={regulationFreeCount}
                            interventionActive={interventionActiveCount}
                            interventionWaiting={interventionWaitingCount}
                            criticalCount={criticalCards.length}
                            pendingDeparturesCount={pendingDepartures.length}
                            canManage={Boolean(session?.canManage)}
                            onOpenCriticalQueue={session?.canManage ? () => openDrawer() : undefined}
                        />

                        {session?.canManage && (
                            <BoardQuickFilters
                                roleFilter={boardRoleFilter}
                                onRoleFilterChange={setBoardRoleFilter}
                                statusFilter={boardStatusFilter}
                                onStatusFilterChange={setBoardStatusFilter}
                                search={boardSearch}
                                onSearchChange={setBoardSearch}
                                matchedCount={filteredMatchedCount}
                                totalCount={totalBoardCount}
                            />
                        )}

                        <section className="ops-main-grid">
                            <section className="ops-operational-panel regulation">
                                <header className="ops-panel-header regulation">
                                    <div className="ops-panel-heading-stack">
                                        <h2>Regulação</h2>
                                        {mealBreakDisplayMode === "night" && (
                                            <div className="ops-panel-legend" aria-label="Legenda do jantar noturno">
                                                <span className="ops-panel-legend-label">Jantar</span>
                                                <span className="ops-slot-chip dinner duration-one-hour">1h</span>
                                                <span className="ops-slot-chip dinner duration-half-hour">30m</span>
                                            </div>
                                        )}
                                    </div>
                                </header>

                                <div className="ops-panel-table-wrap regulation">
                                    <div className="ops-grid-table regulation" role="table" aria-label="Quadro operacional da regulação">
                                        <div className="ops-grid-header" role="rowgroup">
                                            <div className="ops-grid-row ops-grid-row-header regulation" role="row">
                                                <div role="columnheader" className="ops-grid-cell column-time">Chegada</div>
                                                <div role="columnheader" className="ops-grid-cell column-code">Ramal</div>
                                                <div role="columnheader" className="ops-grid-cell column-name">Nome</div>
                                                <div role="columnheader" className="ops-grid-cell column-lunch">{mealBreakDisplayMode === "night" ? "Jantar" : "Almoço"}</div>
                                                <div role="columnheader" className="ops-grid-cell column-rest">{mealBreakDisplayMode === "night" ? "Trabalho" : "Descanso"}</div>
                                            </div>
                                        </div>

                                        <div className="ops-grid-body" role="rowgroup">
                                            {filteredRegulationCards.length > 0 ? filteredRegulationCards.map((card) => renderRegulationRow(card)) : (
                                                <div className="ops-empty-row">{visibleRegulationCards.length === 0 ? "Nenhum ramal ativo na regulação neste turno." : "Nenhum ramal corresponde aos filtros atuais."}</div>
                                            )}
                                            {session?.canManage && hasAvailableRegulationPost && (
                                                <div
                                                    role="row"
                                                    className="ops-grid-row regulation add-row clickable"
                                                    onClick={() => openGenericStartDrawer("regulation")}
                                                    onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") openGenericStartDrawer("regulation"); }}
                                                    tabIndex={0}
                                                    aria-label="Registrar nova chegada na regulação"
                                                >
                                                    <div role="cell" className="ops-grid-cell column-time">
                                                        <span className="ops-time-pill add"><strong>+</strong></span>
                                                    </div>
                                                    <div role="cell" className="ops-grid-cell column-name" style={{ gridColumn: "span 4" }}>
                                                        <span className="ops-add-row-label">Registrar chegada</span>
                                                    </div>
                                                </div>
                                            )}
                                        </div>
                                    </div>
                                </div>
                            </section>

                            <section className="ops-operational-panel intervention">
                                <header className="ops-panel-header intervention">
                                    <h2>Intervenção</h2>
                                </header>

                                <div className="ops-panel-table-wrap intervention">
                                    <div className="ops-grid-table intervention" role="table" aria-label="Quadro operacional da intervenção">
                                        <div className="ops-grid-header" role="rowgroup">
                                            <div className="ops-grid-row ops-grid-row-header intervention" role="row">
                                                <div role="columnheader" className="ops-grid-cell column-time">Chegada</div>
                                                <div role="columnheader" className="ops-grid-cell column-code">Base</div>
                                                <div role="columnheader" className="ops-grid-cell column-name">Nome</div>
                                            </div>
                                        </div>

                                        <div className="ops-grid-body" role="rowgroup">
                                            {filteredInterventionCards.length > 0 ? filteredInterventionCards.map((card) => renderInterventionRow(card)) : (
                                                <div className="ops-empty-row">{visibleInterventionCards.length === 0 ? "Nenhuma base ativa ou aguardando neste turno." : "Nenhuma base corresponde aos filtros atuais."}</div>
                                            )}
                                        </div>
                                    </div>
                                </div>
                            </section>
                        </section>
                    </section>
                )}
            </main>

            {viewMode === "live" && (
                <>
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
                </>
            )}

            {viewMode === "live" && (
                <>
                    <div className={`ops-priority-backdrop ${priorityDrawerOpen ? "open" : ""}`} onClick={closePriorityDrawer} />
                    <aside className={`ops-priority-drawer ${priorityDrawerOpen ? "open" : ""}`} aria-hidden={!priorityDrawerOpen}>
                        <header className="ops-priority-header">
                            <div>
                                <p className="ops-column-kicker">Fila auditavel</p>
                                <h2>Prioridades da escolha</h2>
                            </div>
                            <button type="button" className="chief-close-button" onClick={closePriorityDrawer}>Fechar</button>
                        </header>

                        {(prioritySuccessMessage || priorityErrorMessage) && (
                            <div className={`chief-flash ${priorityErrorMessage ? "error" : "success"}`}>
                                {priorityErrorMessage || prioritySuccessMessage}
                            </div>
                        )}

                        <section className="ops-priority-summary">
                            <span className="ops-section-shift">
                                {priorityView?.mode === "night" ? "Jantar e trabalho" : "Almoco e descanso"}
                            </span>
                            <span className="ops-section-count">
                                {priorityView ? `${priorityView.entries.length} medicos elegiveis` : "Carregando fila"}
                            </span>
                            <span className="ops-section-updated">
                                {priorityView ? `Atualizado ${formatDateTimeDetail(priorityView.updatedAt)}` : "Aguardando leitura operacional"}
                            </span>
                        </section>

                        <section className="ops-priority-copy-card">
                            <p className="ops-section-eyebrow">Leitura de chefia</p>
                            <h3>Confira a ordem antes de abrir o processo no bot</h3>
                            <p>
                                Cada linha mostra a hora que efetivamente pesa para o ranking. Quando houver continuidade entre plantões, penalidade de RMT ou ajuste manual de chefia, o motivo aparece junto na linha.
                            </p>
                        </section>

                        <section className="ops-priority-list">
                            {isPriorityLoading && <div className="ops-history-empty-state">Carregando a fila de prioridades...</div>}

                            {!isPriorityLoading && priorityView?.entries.length === 0 && (
                                <div className="ops-history-empty-state">Nenhum medico elegivel na fila atual de prioridade.</div>
                            )}

                            {!isPriorityLoading && priorityView?.entries.map((entry, index) => {
                                const notesValue = priorityNotesByRamal[entry.ramal] ?? "";
                                const canMoveUp = index > 0;
                                const canMoveDown = index < priorityView.entries.length - 1;

                                return (
                                    <article key={`priority-${entry.ramal}`} className={`ops-priority-entry ${entry.manualJustification ? "manual" : ""}`.trim()}>
                                        <div className="ops-priority-entry-header">
                                            <div className="ops-priority-rank-block">
                                                <strong>{String(entry.rank).padStart(2, "0")}</strong>
                                                <span>{entry.ramal}</span>
                                            </div>

                                            <div className="ops-priority-entry-copy">
                                                <div className="ops-priority-name-row">
                                                    <strong>{entry.name}</strong>
                                                    {entry.roleLabel && renderRoleBadge(entry.roleLabel)}
                                                    {entry.automaticRank !== entry.rank && <span className="ops-inline-flag warning">auto {entry.automaticRank}</span>}
                                                </div>
                                                <span className="ops-priority-time-row">
                                                    Prioridade {formatBoardTime(entry.priorityStartedAt)}
                                                    {entry.continuityStartedAt && entry.continuityStartedAt !== entry.actualStartedAt && ` • chegada original ${formatBoardTime(entry.actualStartedAt)}`}
                                                </span>
                                                {entry.explanation && <p className="ops-priority-explanation">{entry.explanation}</p>}
                                                {!entry.explanation && <p className="ops-priority-explanation neutral">Ordem direta pela chegada operacional.</p>}
                                            </div>
                                        </div>

                                        <div className="ops-priority-actions">
                                            <label className="chief-field full-width">
                                                <span>Justificativa do ajuste</span>
                                                <input
                                                    className="chief-input"
                                                    value={notesValue}
                                                    onChange={(event) => setPriorityNotesByRamal((current) => ({ ...current, [entry.ramal]: event.target.value }))}
                                                    placeholder="Ex.: continua desde a manhã, presencial em IES, priorizar por cobertura"
                                                    disabled={isPrioritySaving || isRefreshing}
                                                />
                                            </label>

                                            <div className="ops-priority-move-buttons">
                                                <button
                                                    type="button"
                                                    className="chief-secondary-button"
                                                    onClick={() => void handlePriorityMove(entry.ramal, 0)}
                                                    disabled={isPrioritySaving || isRefreshing || index === 0}
                                                >
                                                    Topo
                                                </button>
                                                <button
                                                    type="button"
                                                    className="chief-secondary-button"
                                                    onClick={() => void handlePriorityMove(entry.ramal, index - 1)}
                                                    disabled={isPrioritySaving || isRefreshing || !canMoveUp}
                                                >
                                                    Subir
                                                </button>
                                                <button
                                                    type="button"
                                                    className="chief-primary-button"
                                                    onClick={() => void handlePriorityMove(entry.ramal, index + 1)}
                                                    disabled={isPrioritySaving || isRefreshing || !canMoveDown}
                                                >
                                                    Descer
                                                </button>
                                            </div>
                                        </div>
                                    </article>
                                );
                            })}
                        </section>
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
                                        <small>{canEditActiveCard(card) ? `${formatMinutesLabel(minutesSince(generatedAt, resolveOperationalArrival(card)))} em curso` : "Leitura ao vivo sem ocupacao v2"}</small>
                                    </button>
                                ))}
                            </div>
                        </section>

                        <section className="chief-drawer-section focus">
                            <div className="chief-focus-empty">
                                <h3>Clique em um profissional no quadro</h3>
                                <p>Abra o card de qualquer profissional para corrigir medico, horario, funcao, lotacao, registrar continuidade, ajustar refeicao ou encerrar presenca.</p>
                            </div>
                        </section>
                    </aside>

                    <div className={`chief-drawer-backdrop ${professionalDrawerOpen ? "open" : ""}`} onClick={closeProfessionalDrawer} />
                    <aside className={`chief-drawer professional-drawer ${professionalDrawerOpen ? "open" : ""}`} aria-hidden={!professionalDrawerOpen}>
                        {selectedCard && (
                            <>
                                <header className="chief-drawer-header">
                                    <div>
                                        <p className="ops-column-kicker">
                                            {(selectedCard.domain === "regulation" && selectedCard.postId === 0) || (selectedCard.domain === "intervention" && selectedCard.baseId === 0)
                                                ? (selectedCard.domain === "regulation" ? "Regulação" : "Intervenção")
                                                : `${cardCode(selectedCard)} · ${cardLabel(selectedCard)}`}
                                        </p>
                                        <h2>
                                            {(selectedCard.domain === "regulation" && selectedCard.postId === 0) || (selectedCard.domain === "intervention" && selectedCard.baseId === 0)
                                                ? "Registrar chegada"
                                                : displayDoctorName(selectedCard)}
                                        </h2>
                                    </div>
                                    <button type="button" className="chief-close-button" onClick={closeProfessionalDrawer}>Fechar</button>
                                </header>

                                {(successMessage || errorMessage) && (
                                    <div className={`chief-flash ${errorMessage ? "error" : "success"}`}>
                                        {errorMessage || successMessage}
                                    </div>
                                )}

                                {selectedCard.domain === "intervention" && selectedCard.occupancyId && session?.canManage && (
                                    <InterventionLateArrivalPanel
                                        occupancyId={selectedCard.occupancyId}
                                        baseCode={selectedCard.baseCode}
                                        doctorLabel={displayDoctorName(selectedCard)}
                                        shiftLabel={selectedCard.shiftLabel ?? null}
                                        startedAt={selectedCard.startedAt}
                                        lateArrivalAcknowledgedAt={selectedCard.lateArrivalAcknowledgedAt ?? null}
                                        lateArrivalAcknowledgedNote={selectedCard.lateArrivalAcknowledgedNote ?? null}
                                        onSuccess={() => { startRefresh(() => { router.refresh(); }); }}
                                    />
                                )}

                                {canContinueIntervention(selectedCard, generatedAt) && session?.canManage && (
                                    <section className="chief-drawer-section">
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
                                    </section>
                                )}

                                {session?.canManage && canManageCardState(selectedCard) && (
                                    <section className="chief-drawer-section">
                                        <div className="chief-departure-strip">
                                            <div>
                                                <p className="ops-column-kicker">{cardStatePanelLabel(selectedCard)}</p>
                                                <strong>{cardStateActionLabel(selectedCard)}</strong>
                                                <span>{cardStateDescription(selectedCard)}</span>
                                            </div>

                                            <div className="chief-timing-grid">
                                                <label className="chief-field">
                                                    <span>{selectedCard.status === "disabled" ? "Horario da reativacao" : "Horario da desativacao"}</span>
                                                    <input
                                                        type="datetime-local"
                                                        className="chief-input"
                                                        value={baseStateAt}
                                                        onChange={(event) => setBaseStateAt(event.target.value)}
                                                    />
                                                </label>
                                                <label className="chief-field">
                                                    <span>Motivo operacional</span>
                                                    <textarea
                                                        className="chief-input chief-textarea compact"
                                                        value={baseStateReason}
                                                        onChange={(event) => setBaseStateReason(event.target.value)}
                                                        placeholder={cardStateReasonPlaceholder(selectedCard)}
                                                    />
                                                </label>
                                            </div>

                                            <div className="chief-verification-actions">
                                                <button
                                                    type="button"
                                                    className={selectedCard.status === "disabled" ? "chief-primary-button" : "chief-danger-button"}
                                                    onClick={() => void handleCardState(selectedCard, selectedCard.status === "disabled" ? "reactivate" : "deactivate")}
                                                    disabled={isSubmitting || isRefreshing}
                                                >
                                                    {isSubmitting || isRefreshing ? "Aplicando..." : cardStateActionLabel(selectedCard)}
                                                </button>
                                            </div>
                                        </div>
                                    </section>
                                )}

                                {actionMode && (
                                    <section className="chief-drawer-section">
                                        <div className="chief-focus-header">
                                            <div>
                                                <p className="ops-column-kicker">Correcao operacional</p>
                                                <h3>{actionTitle(actionMode, selectedCard)}</h3>
                                            </div>
                                            <span className={`ops-priority-tag ${resolvePriority(selectedCard, generatedAt)}`}>{priorityLabel(resolvePriority(selectedCard, generatedAt))}</span>
                                        </div>

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
                                                            disabled={isTransferAction}
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
                                                                    disabled={isTransferAction}
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
                                                                        disabled={isTransferAction}
                                                                    >
                                                                        <strong>{doctor.displayName ?? doctor.fullName}</strong>
                                                                        {doctor.displayName && <span>{doctor.fullName}</span>}
                                                                    </button>
                                                                ))}
                                                            </div>
                                                        )}

                                                        {isTransferAction && (
                                                            <div className="chief-inline-help chief-transfer-inline-note">
                                                                O remanejamento reaproveita o medico ja registrado neste plantao. Para trocar o nome, volte o destino para o local atual e corrija o cadastro separadamente.
                                                            </div>
                                                        )}
                                                    </label>

                                                    {actionMode === "start" && selectedCard && (
                                                        (selectedCard.domain === "regulation" && selectedCard.postId === 0) ||
                                                        (selectedCard.domain === "intervention" && selectedCard.baseId === 0)
                                                    ) && (
                                                            <label className="chief-field">
                                                                <span>{selectedCard.domain === "regulation" ? "Ramal" : "Base"}</span>
                                                                <select
                                                                    className="chief-input chief-select"
                                                                    value={formState.targetKey}
                                                                    onChange={(event) => setFormState((current) => ({ ...current, targetKey: event.target.value }))}
                                                                >
                                                                    <option value="">Selecione o posto</option>
                                                                    {transferTargetOptions
                                                                        .filter((option) => option.domain === selectedCard.domain && option.status === "available")
                                                                        .map((option) => (
                                                                            <option key={option.key} value={option.key}>
                                                                                {option.code} · {option.label}
                                                                            </option>
                                                                        ))}
                                                                </select>
                                                                <small className="chief-field-hint">Apenas postos disponíveis são exibidos.</small>
                                                            </label>
                                                        )}

                                                    {actionMode === "start" && (
                                                        <div className="chief-continuity-toggle">
                                                            <label className="chief-toggle-label">
                                                                <input
                                                                    type="checkbox"
                                                                    checked={isContinuityEntry}
                                                                    onChange={(event) => setIsContinuityEntry(event.target.checked)}
                                                                />
                                                                <span>Continua do turno anterior</span>
                                                            </label>
                                                            {isContinuityEntry && (
                                                                <div className="chief-continuity-info">
                                                                    <p>O sistema criará um novo registro neste posto vinculado ao anterior para banco de horas. O pagamento considerará cada segmento separadamente (turno/posto).</p>
                                                                </div>
                                                            )}
                                                        </div>
                                                    )}

                                                    <label className="chief-field">
                                                        <span>{isContinuityEntry ? "Horário de início neste posto" : actionMode === "start" ? "Horario de abertura" : "Horario corrigido"}</span>
                                                        <input
                                                            type="datetime-local"
                                                            className="chief-input"
                                                            value={formState.startedAt}
                                                            onChange={(event) => setFormState((current) => ({ ...current, startedAt: event.target.value }))}
                                                            disabled={isTransferAction}
                                                        />
                                                        {isContinuityEntry && (
                                                            <small className="chief-field-hint">Horário em que o médico migrou para este posto. A chegada original será preservada para banco de horas.</small>
                                                        )}
                                                        {isTransferAction && (
                                                            <small className="chief-field-hint">O novo registro nasce com o horario de chegada ja consolidado neste plantao.</small>
                                                        )}
                                                    </label>

                                                    {actionMode === "start" && (
                                                        <label className="chief-field">
                                                            <span>Turno</span>
                                                            <select
                                                                className="chief-input chief-select"
                                                                value={formState.shiftOverride}
                                                                onChange={(event) => setFormState((current) => ({ ...current, shiftOverride: event.target.value }))}
                                                            >
                                                                <option value="">Automatico ({shiftLabel})</option>
                                                                <option value="SD">SD — Serviço Diurno</option>
                                                                <option value="SN">SN — Serviço Noturno</option>
                                                                <option value="P">P — Prolongado (SD que fica até SN)</option>
                                                                <option value="P_INV">P invertido — 24h noturno (chega 19h, sai 19h)</option>
                                                            </select>
                                                            <small className="chief-field-hint">
                                                                {formState.shiftOverride === "P"
                                                                    ? "O plantonista chegou no SD e vai ficar ate o final do SN. Banco de horas e pagamento cobrem os dois turnos."
                                                                    : formState.shiftOverride === "P_INV"
                                                                        ? "O plantonista chega as 19h e sai as 19h do dia seguinte. Turno de 24h noturno. Banco e pagamento cobrem SN e o SD seguinte."
                                                                        : "Deixe em automatico para usar o turno da tela. Mude se o plantonista veio de outro turno."}
                                                            </small>
                                                        </label>
                                                    )}

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
                                                            ]).map((role) => (
                                                                <option key={role} value={role}>{role}</option>
                                                            ))}
                                                        </select>
                                                        {resolveCardFixedRole(selectedCard) ? (
                                                            <small className="chief-field-hint">Função travada por regra operacional deste posto neste turno.</small>
                                                        ) : (
                                                            <small className="chief-field-hint">Deixe em branco para remover a função sem mexer no plantão, na chegada ou no meal break. PSIQ fica fora da divisão automática do almoço.</small>
                                                        )}
                                                    </label>

                                                    {actionMode === "correct" && (
                                                        <label className="chief-field">
                                                            <span>Destino operacional</span>
                                                            <select
                                                                className="chief-input chief-select"
                                                                value={formState.targetKey}
                                                                onChange={(event) => setFormState((current) => ({ ...current, targetKey: event.target.value }))}
                                                            >
                                                                <optgroup label="Regulacao">
                                                                    {transferTargetOptions
                                                                        .filter((option) => option.domain === "regulation")
                                                                        .map((option) => (
                                                                            <option key={option.key} value={option.key}>
                                                                                {option.code} · {option.label}{option.status === "occupied" ? ` · ocupado por ${option.occupantName}` : ""}
                                                                            </option>
                                                                        ))}
                                                                </optgroup>
                                                                <optgroup label="Intervencao">
                                                                    {transferTargetOptions
                                                                        .filter((option) => option.domain === "intervention")
                                                                        .map((option) => (
                                                                            <option key={option.key} value={option.key} disabled={option.status === "disabled"}>
                                                                                {option.code} · {option.label}
                                                                                {option.status === "disabled" ? " · indisponivel" : option.status === "occupied" ? ` · ocupado por ${option.occupantName}` : ""}
                                                                            </option>
                                                                        ))}
                                                                </optgroup>
                                                            </select>
                                                            <small className="chief-field-hint">
                                                                {isTransferAction
                                                                    ? "O remanejamento apaga o vinculo atual e recria o plantao no destino, preservando chegada, nome e continuidade do pagamento."
                                                                    : "Mantenha o destino atual para corrigir so medico, horario ou funcao sem mudar a lotacao."}
                                                            </small>
                                                            {selectedTransferConflict && (
                                                                <div className="chief-inline-help chief-transfer-inline-note warning">
                                                                    {selectedTransferTarget?.code} ja esta ocupado por {selectedTransferConflict.occupantName}. Ao continuar, a chefia precisara retirar ou remanejar quem esta nesse destino.
                                                                </div>
                                                            )}
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
                                                <span>{isContinuityEntry ? "Motivo da continuidade" : actionMode === "correct" ? "Motivo da correcao" : "Notas operacionais"}</span>
                                                <textarea
                                                    className="chief-input chief-textarea"
                                                    value={formState.notes}
                                                    onChange={(event) => setFormState((current) => ({ ...current, notes: event.target.value }))}
                                                    placeholder={isContinuityEntry
                                                        ? "Ex.: Migrou do 2031 para o 1367 na virada do turno"
                                                        : actionMode === "correct"
                                                            ? isTransferAction
                                                                ? "Explique o motivo operacional do remanejamento e o que acontece com o destino atual"
                                                                : "Explique por que voce esta mudando o horario ou o medico deste registro"
                                                            : "Contexto rapido de chefia ou observacao operacional"}
                                                />
                                            </label>

                                            <div className="chief-form-actions full-width">
                                                <button type="button" className="chief-secondary-button" onClick={() => setActionMode(null)}>
                                                    Voltar
                                                </button>
                                                <button type="submit" className="chief-primary-button" disabled={isSubmitting || isRefreshing || !session?.canManage}>
                                                    {isSubmitting || isRefreshing
                                                        ? "Aplicando..."
                                                        : isContinuityEntry
                                                            ? "Registrar continuidade"
                                                            : actionMode === "start"
                                                                ? "Abrir cobertura"
                                                                : actionMode === "end"
                                                                    ? "Encerrar registro"
                                                                    : isTransferAction
                                                                        ? "Revisar remanejamento"
                                                                        : "Salvar correcao"}
                                                </button>
                                            </div>
                                        </form>
                                    </section>
                                )}

                                {!actionMode && session?.canManage && (
                                    <section className="chief-drawer-section">
                                        <div className="chief-focus-empty">
                                            <p className="ops-column-kicker">Acoes disponiveis</p>
                                            <div className="chief-action-shortcuts">
                                                {canEditActiveCard(selectedCard) && (
                                                    <button type="button" className="chief-secondary-button" onClick={() => {
                                                        setActionMode("correct");
                                                        setFormState(buildInitialForm(selectedCard));
                                                        syncSelectedDoctorLabel(selectedCard.doctorId ?? null);
                                                    }}>
                                                        Corrigir quadro
                                                    </button>
                                                )}
                                                {selectedCard.status === "waiting" && (
                                                    <button type="button" className="chief-primary-button" onClick={() => {
                                                        setActionMode("start");
                                                        setFormState(buildInitialForm(selectedCard));
                                                        syncSelectedDoctorLabel(selectedCard.doctorId ?? null);
                                                    }}>
                                                        Abrir cobertura
                                                    </button>
                                                )}
                                            </div>
                                        </div>
                                    </section>
                                )}

                                {showDayMealBreakSection && (
                                    <section className="chief-drawer-section">
                                        <div className="chief-day-meal-break-card">
                                            <div className="chief-section-heading">
                                                <div>
                                                    <p className="ops-column-kicker">Divisao diurna</p>
                                                    <h3>Almoco e descanso</h3>
                                                </div>
                                                {selectedRegulationRamal && isDayMealBreakEligible(mealBreakSession, selectedRegulationRamal) && (
                                                    <div className="chief-night-current">
                                                        {renderScheduleChip({
                                                            slot: selectedLunchCurrent,
                                                            kind: "lunch",
                                                            pending: !selectedLunchCurrent,
                                                            excluded: selectedLunchExcluded,
                                                        })}
                                                        {renderScheduleChip({
                                                            slot: selectedRestCurrent,
                                                            kind: "rest",
                                                            pending: !selectedRestCurrent,
                                                            excluded: selectedRestExcluded,
                                                        })}
                                                    </div>
                                                )}
                                            </div>

                                            {!canEditSelectedDayMealBreak ? (
                                                <p className="chief-field-hint">{resolveMealBreakExclusionHint(selectedRegulationRamal ?? "", "day")}</p>
                                            ) : (
                                                <>
                                                    {mealBreakSession && (
                                                        <div className="chief-inline-help chief-meal-break-eligibility-note">
                                                            <strong>Vagas do almoco:</strong> {formatMealBreakCapacity(remainingDayLunchSlots, "Sem vagas livres no momento.")}
                                                            <br />
                                                            <strong>Vagas do descanso:</strong> {mealBreakSession.stage === "awaiting_rest_choice" || mealBreakSession.stage === "completed"
                                                                ? formatMealBreakCapacity(remainingDayRestSlots, "Sem vagas livres no momento.")
                                                                : "Abre depois que o almoco fechar."}
                                                            <br />
                                                            <strong>Fila pendente:</strong> almoço {mealBreakSession.lunchQueue.length} • descanso {mealBreakSession.restQueue.length}
                                                        </div>
                                                    )}

                                                    {!mealBreakSession && (
                                                        <p className="chief-field-hint">
                                                            A divisao ainda nao foi aberta. Exclusoes feitas agora serao aplicadas quando /almoco iniciar.
                                                        </p>
                                                    )}

                                                    {mealBreakSession && (
                                                        <div className="chief-timing-grid chief-night-grid">
                                                            <label className="chief-field">
                                                                <span>Almoço</span>
                                                                <select
                                                                    className="chief-input chief-select"
                                                                    value={lunchSlotInput}
                                                                    onChange={(event) => setLunchSlotInput(event.target.value)}
                                                                    disabled={isMealBreakSaving || isRefreshing}
                                                                >
                                                                    <option value="">Sem definição</option>
                                                                    {DAY_SLOT_OPTIONS.map((slot) => (
                                                                        <option key={slot} value={slot}>{slot}</option>
                                                                    ))}
                                                                </select>
                                                            </label>
                                                            <label className="chief-field">
                                                                <span>Descanso</span>
                                                                <select
                                                                    className="chief-input chief-select"
                                                                    value={restSlotInput}
                                                                    onChange={(event) => setRestSlotInput(event.target.value)}
                                                                    disabled={isMealBreakSaving || isRefreshing}
                                                                >
                                                                    <option value="">Sem definição</option>
                                                                    {DAY_SLOT_OPTIONS.map((slot) => (
                                                                        <option key={slot} value={slot}>{slot}</option>
                                                                    ))}
                                                                </select>
                                                            </label>
                                                        </div>
                                                    )}

                                                    {mealBreakSession && (
                                                        <div className="chief-form-actions full-width">
                                                            <button
                                                                type="button"
                                                                className="chief-primary-button"
                                                                onClick={() => void handleDayMealBreakSlotSave()}
                                                                disabled={isMealBreakSaving || isRefreshing}
                                                            >
                                                                {isMealBreakSaving || isRefreshing ? "Aplicando..." : "Salvar almoço/descanso"}
                                                            </button>
                                                        </div>
                                                    )}

                                                    <div className="chief-day-meal-break-actions">
                                                        <button
                                                            type="button"
                                                            className={selectedLunchExcluded ? "chief-secondary-button" : "chief-danger-button"}
                                                            onClick={() => void handleDayMealBreakToggle("lunch", !selectedLunchExcluded)}
                                                            disabled={isMealBreakSaving || isRefreshing}
                                                        >
                                                            {isMealBreakSaving || isRefreshing
                                                                ? "Aplicando..."
                                                                : selectedLunchExcluded
                                                                    ? "Recolocar no almoço"
                                                                    : "Retirar do almoço"}
                                                        </button>
                                                        <button
                                                            type="button"
                                                            className={selectedRestExcluded ? "chief-secondary-button" : "chief-danger-button"}
                                                            onClick={() => void handleDayMealBreakToggle("rest", !selectedRestExcluded)}
                                                            disabled={isMealBreakSaving || isRefreshing}
                                                        >
                                                            {isMealBreakSaving || isRefreshing
                                                                ? "Aplicando..."
                                                                : selectedRestExcluded
                                                                    ? "Recolocar no descanso"
                                                                    : "Retirar do descanso"}
                                                        </button>
                                                    </div>

                                                    <p className="chief-field-hint">
                                                        Quando retirado, o bot pula este ramal na etapa correspondente e recalcula as vagas restantes da divisao.
                                                    </p>
                                                </>
                                            )}
                                        </div>
                                    </section>
                                )}

                                {showNightMealBreakSection && (
                                    <section className="chief-drawer-section">
                                        <div className="chief-night-meal-break-card">
                                            <div className="chief-section-heading">
                                                <div>
                                                    <p className="ops-column-kicker">Divisao noturna</p>
                                                    <h3>Jantar e trabalho</h3>
                                                </div>
                                                {selectedRegulationRamal && isNightMealBreakEligible(mealBreakSession, selectedRegulationRamal) && (
                                                    <div className="chief-night-current">
                                                        {renderScheduleChip({
                                                            slot: selectedDinnerCurrent,
                                                            kind: "dinner",
                                                            pending: !selectedDinnerCurrent,
                                                            duration: selectedDinnerDuration,
                                                        })}
                                                        {renderScheduleChip({
                                                            slot: selectedNightWorkCurrent,
                                                            kind: "work",
                                                            pending: !selectedNightWorkCurrent,
                                                        })}
                                                    </div>
                                                )}
                                            </div>

                                            {!canEditSelectedNightMealBreak ? (
                                                <p className="chief-field-hint">{resolveMealBreakExclusionHint(selectedRegulationRamal ?? "", "night")}</p>
                                            ) : (
                                                <>
                                                    <div className="chief-timing-grid chief-night-grid">
                                                        <label className="chief-field">
                                                            <span>Trabalho da noite</span>
                                                            <select
                                                                className="chief-input chief-select"
                                                                value={nightWorkInput}
                                                                onChange={(event) => {
                                                                    const nextValue = event.target.value as MealBreakNightWorkSlot | "";
                                                                    setNightWorkInput(nextValue);
                                                                    if (nextValue === "03:00") {
                                                                        setDinnerInput(selectedLateDinner);
                                                                    }
                                                                    if (nextValue === "23:00" && (dinnerInput === "22:00" || dinnerInput === "22:30")) {
                                                                        setDinnerInput("");
                                                                    }
                                                                    if (!nextValue) {
                                                                        setDinnerInput("");
                                                                    }
                                                                }}
                                                                disabled={isMealBreakSaving || isRefreshing}
                                                            >
                                                                <option value="">Sem definicao</option>
                                                                {NIGHT_WORK_OPTIONS.map((slot) => (
                                                                    <option key={slot} value={slot}>{slot}</option>
                                                                ))}
                                                            </select>
                                                        </label>

                                                        <label className="chief-field">
                                                            <span>Jantar</span>
                                                            <select
                                                                className="chief-input chief-select"
                                                                value={nightWorkInput === "03:00" ? selectedLateDinner : dinnerInput}
                                                                onChange={(event) => setDinnerInput(event.target.value as MealBreakDinnerSlot | "")}
                                                                disabled={isMealBreakSaving || isRefreshing || !nightWorkInput || nightWorkInput === "03:00"}
                                                            >
                                                                <option value="">Sem definicao</option>
                                                                {NIGHT_DINNER_OPTIONS.map((slot) => (
                                                                    <option key={slot} value={slot}>{slot}</option>
                                                                ))}
                                                            </select>
                                                            {nightWorkInput === "03:00" && (
                                                                <small className="chief-field-hint">03:00 fixa automaticamente o jantar final em {selectedLateDinner}.</small>
                                                            )}
                                                        </label>
                                                    </div>

                                                    <div className="chief-form-actions full-width">
                                                        <button
                                                            type="button"
                                                            className="chief-primary-button"
                                                            onClick={() => void handleNightMealBreakSave()}
                                                            disabled={isMealBreakSaving || isRefreshing}
                                                        >
                                                            {isMealBreakSaving || isRefreshing ? "Aplicando..." : "Salvar jantar/trabalho"}
                                                        </button>
                                                    </div>
                                                </>
                                            )}
                                        </div>
                                    </section>
                                )}

                                {selectedCard.status === "active" && selectedCard.occupancyId && session?.canManage && (
                                    <section className="chief-drawer-section departure-zone">
                                        <div className="chief-departure-strip">
                                            <div>
                                                <p className="ops-column-kicker">Saida do profissional</p>
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
                                    </section>
                                )}
                            </>
                        )}
                    </aside>

                    {transferConfirmOpen && selectedCard && selectedTransferTarget && (
                        <div className="chief-transfer-backdrop open" onClick={() => setTransferConfirmOpen(false)}>
                            <section className="chief-transfer-modal" aria-label="Confirmacao de remanejamento" onClick={(event) => event.stopPropagation()}>
                                <div className="chief-transfer-header">
                                    <div>
                                        <p className="ops-column-kicker">Remanejamento</p>
                                        <h3>Confirmar troca de lotacao</h3>
                                    </div>
                                    <button type="button" className="chief-drawer-close" onClick={() => setTransferConfirmOpen(false)} aria-label="Fechar confirmacao de remanejamento">
                                        <svg viewBox="0 0 24 24" aria-hidden="true">
                                            <path d="M6.4 5L12 10.6 17.6 5 19 6.4 13.4 12 19 17.6 17.6 19 12 13.4 6.4 19 5 17.6 10.6 12 5 6.4Z" />
                                        </svg>
                                    </button>
                                </div>

                                <p className="chief-transfer-copy">
                                    O registro atual em {cardCode(selectedCard)} sera removido e o sistema abrira um novo registro em {selectedTransferTarget.code}, preservando o medico e a chegada ja consolidados para quadro, pagamento e banco de horas.
                                </p>

                                <div className="chief-transfer-grid">
                                    <div className="chief-transfer-card source">
                                        <span>Origem</span>
                                        <strong>{cardCode(selectedCard)} · {cardLabel(selectedCard)}</strong>
                                        <small>{displayDoctorName(selectedCard)}</small>
                                    </div>
                                    <div className="chief-transfer-card destination">
                                        <span>Destino</span>
                                        <strong>{selectedTransferTarget.code} · {selectedTransferTarget.label}</strong>
                                        <small>{targetTypeLabel(selectedTransferTarget.domain)}</small>
                                    </div>
                                </div>

                                {selectedTransferConflict ? (
                                    <div className="chief-transfer-resolution-block">
                                        <div className="chief-transfer-warning-card">
                                            <strong>Destino ocupado</strong>
                                            <span>{selectedTransferConflict.code} esta com {selectedTransferConflict.occupantName}.</span>
                                        </div>

                                        <div className="chief-transfer-resolution-grid">
                                            <label className={`chief-transfer-choice ${transferConflictStrategy === "remove_destination" ? "active" : ""}`.trim()}>
                                                <input
                                                    type="radio"
                                                    name="transfer-conflict-strategy"
                                                    value="remove_destination"
                                                    checked={transferConflictStrategy === "remove_destination"}
                                                    onChange={() => setTransferConflictStrategy("remove_destination")}
                                                />
                                                <span>Retirar {selectedTransferConflict.occupantName} do plantao</span>
                                            </label>
                                            <label className={`chief-transfer-choice ${transferConflictStrategy === "move_destination" ? "active" : ""}`.trim()}>
                                                <input
                                                    type="radio"
                                                    name="transfer-conflict-strategy"
                                                    value="move_destination"
                                                    checked={transferConflictStrategy === "move_destination"}
                                                    onChange={() => setTransferConflictStrategy("move_destination")}
                                                />
                                                <span>Remanejar {selectedTransferConflict.occupantName} para outro posto/base</span>
                                            </label>
                                        </div>

                                        {transferConflictStrategy === "move_destination" && (
                                            <label className="chief-field full-width">
                                                <span>Novo destino de {selectedTransferConflict.occupantName}</span>
                                                <select
                                                    className="chief-input chief-select"
                                                    value={transferRelocationKey}
                                                    onChange={(event) => setTransferRelocationKey(event.target.value)}
                                                >
                                                    <option value="">Selecione o posto/base alternativo</option>
                                                    <optgroup label="Regulacao">
                                                        {relocationTargetOptions
                                                            .filter((option) => option.domain === "regulation")
                                                            .map((option) => (
                                                                <option key={option.key} value={option.key}>
                                                                    {option.code} · {option.label}
                                                                    {option.key === selectedCardTargetKey ? " · libera a origem" : option.status === "occupied" ? ` · ocupado por ${option.occupantName}` : ""}
                                                                </option>
                                                            ))}
                                                    </optgroup>
                                                    <optgroup label="Intervencao">
                                                        {relocationTargetOptions
                                                            .filter((option) => option.domain === "intervention")
                                                            .map((option) => (
                                                                <option key={option.key} value={option.key} disabled={option.status === "disabled"}>
                                                                    {option.code} · {option.label}
                                                                    {option.status === "disabled" ? " · indisponivel" : option.key === selectedCardTargetKey ? " · libera a origem" : option.status === "occupied" ? ` · ocupado por ${option.occupantName}` : ""}
                                                                </option>
                                                            ))}
                                                    </optgroup>
                                                </select>
                                                <small className="chief-field-hint">A origem atual pode ser usada para troca direta, desde que voce confirme este remanejamento.</small>
                                                {relocationTargetConflict && (
                                                    <div className="chief-inline-help chief-transfer-inline-note warning">
                                                        {selectedRelocationTarget?.code} ja esta ocupado por {relocationTargetConflict.occupantName}. Escolha outro local vazio ou retire esse profissional antes.
                                                    </div>
                                                )}
                                            </label>
                                        )}
                                    </div>
                                ) : (
                                    <div className="chief-transfer-info-card">
                                        <strong>Destino livre</strong>
                                        <span>O remanejamento vai apenas limpar a origem e recriar a lotacao em {selectedTransferTarget.code}.</span>
                                    </div>
                                )}

                                <div className="chief-form-actions full-width">
                                    <button type="button" className="chief-secondary-button" onClick={() => setTransferConfirmOpen(false)}>
                                        Revisar drawer
                                    </button>
                                    <button
                                        type="button"
                                        className="chief-primary-button"
                                        disabled={isSubmitting || isRefreshing || (transferConflictStrategy === "move_destination" && (!selectedRelocationTarget || Boolean(relocationTargetConflict)))}
                                        onClick={() => void submitOperationalAction({ confirmedTransfer: true })}
                                    >
                                        {isSubmitting || isRefreshing ? "Aplicando..." : "Confirmar remanejamento"}
                                    </button>
                                </div>
                            </section>
                        </div>
                    )}
                </>
            )}
        </>
    );
}
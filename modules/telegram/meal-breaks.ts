/**
 * Telegram Meal Break Management
 *
 * Purpose: Manages the multi-stage meal break scheduling flow for SAMU doctors.
 * Handles lunch, dinner, night-work, and rest breaks with priority ordering
 * and coverage constraints.
 *
 * Source of truth for: meal break stage transitions, eligibility rules,
 * break-slot assignment, and priority resolution.
 *
 * Key flows:
 *   1. runTelegramMealBreakCommand() — starts/advances a meal break session
 *   2. handleTelegramMealBreakReply() — processes stage-specific replies
 *   3. sendTelegramMealBreakMessages() — batch notification delivery
 *
 * Invariants:
 *   - Only one active meal break session per shift per chat
 *   - Remote-priority roles get break priority over on-site roles
 *   - Break slots respect minimum coverage constraints
 *   - Stage sequence: lunch → rest (SD) or dinner → night-work (SN)
 */
import { and, eq, gte, inArray, lte } from "drizzle-orm";
import { getDb, hasDatabaseUrl } from "@/db";
import { interventionOccupancies, regulationOccupancies, telegramBotNotices } from "@/db/schema";
import { formatDoctorSurfaceName } from "@/modules/doctors/directory";
import { isNucleoRegulationPost, isPiamRegulationPost } from "@/modules/operational/board-display";
import { isRemoteOperationalRole, isRemotePriorityRegulationCode, normalizeOperationalRoleLabel, resolveOperationalRoleLabel } from "@/modules/operational/roles";
import { getSaoPauloParts, resolveOperationalShiftWindow } from "@/modules/operational/board-rules";
import type { TelegramUpdate } from "@/modules/telegram/api";
import { buildChoiceKeyboard, REMOVE_KEYBOARD, sendMessage, type TelegramReplyMarkup } from "@/modules/telegram/api";
import { getTelegramAdminUserIds, getTelegramAnnouncementChatIds } from "@/modules/telegram/config";
import { getOperationalBoard } from "@/services/board.service";

type OperationalBoard = Awaited<ReturnType<typeof getOperationalBoard>>;

export type MealBreakMode = "day" | "night";
export type MealBreakLunchSlot = "11:30" | "12:30" | "13:30";
export type MealBreakRestSlot = "14:30" | "15:30" | "16:30" | "18:00";
export type MealBreakDinnerSlot = "20:30" | "21:00" | "21:30" | "22:00" | "22:30";
export type MealBreakNightWorkSlot = "23:00" | "03:00";
export type MealBreakDinnerDuration = "one_hour" | "half_hour";
export type MealBreakStage =
    | "awaiting_confirmation"
    | "awaiting_recip"
    | "awaiting_mrv_lunch"
    | "awaiting_lunch_choice"
    | "awaiting_rest_choice"
    | "awaiting_night_work_choice"
    | "awaiting_dinner_choice"
    | "completed";

export interface MealBreakDoctor {
    doctorId: string;
    ramal: string;
    name: string;
    domain: "regulation";
    startedAt: string;
    shiftLabel: "SD" | "SN" | "P";
    roleLabel: string | null;
}

interface MealBreakRosterDoctor extends MealBreakDoctor {
    occupancyId: string | null;
}

export interface MealBreakContinuityOccupancy {
    occupancyId: string;
    doctorId: string;
    continuityGroupId: string | null;
    startedAt: string;
    endedAt: string | null;
    actualEndedAt: string | null;
}

export interface MealBreakSessionEvent {
    type:
    | "session_started"
    | "session_restarted"
    | "confirmation_accepted"
    | "recip_selected"
    | "mrv_selected"
    | "lunch_selected"
    | "rest_auto_selected"
    | "rest_selected"
    | "night_work_selected"
    | "night_dinner_auto_selected"
    | "night_dinner_selected"
    | "night_assignment_corrected"
    | "eligibility_corrected"
    | "undo_applied"
    | "session_completed";
    ramal?: string;
    slot?: MealBreakLunchSlot | MealBreakRestSlot | MealBreakDinnerSlot | MealBreakNightWorkSlot;
    actorTelegramId: string | null;
    recordedAt: string;
}

export interface MealBreakUndoSnapshot {
    stage: MealBreakStage;
    recipRamal: string | null;
    mrvLunch1230Ramal: string | null;
    lunchAssignments: Record<string, MealBreakLunchSlot>;
    restAssignments: Record<string, MealBreakRestSlot>;
    nightWorkAssignments: Record<string, MealBreakNightWorkSlot>;
    dinnerAssignments: Record<string, MealBreakDinnerSlot>;
    label: string;
}

export interface MealBreakSession {
    kind: "telegram_meal_break_session";
    version: 1;
    mode: MealBreakMode;
    operationalDate: string;
    stage: MealBreakStage;
    trigger: "manual" | "automatic";
    roster: MealBreakDoctor[];
    chiefRamal: string | null;
    recipRamal: string | null;
    mrvRamals: string[];
    mrvLunch1230Ramal: string | null;
    lunchCapacities: Record<MealBreakLunchSlot, number>;
    lunchAssignments: Record<string, MealBreakLunchSlot>;
    lunchExcludedRamals: string[];
    restAssignments: Record<string, MealBreakRestSlot>;
    restExcludedRamals: string[];
    restChoiceCapacities: Record<"15:30" | "16:30", number>;
    lunchQueue: string[];
    restQueue: string[];
    nightWorkCapacities: Record<MealBreakNightWorkSlot, number>;
    nightWorkAssignments: Record<string, MealBreakNightWorkSlot>;
    dinnerAssignments: Record<string, MealBreakDinnerSlot>;
    dinnerDurationAssignments: Record<string, MealBreakDinnerDuration>;
    dinnerChoiceCapacities: Record<"20:30" | "21:00" | "21:30", number>;
    nightWorkQueue: string[];
    dinnerQueue: string[];
    undoSnapshots: MealBreakUndoSnapshot[];
    createdAt: string;
    updatedAt: string;
    events: MealBreakSessionEvent[];
}

export interface TelegramMealBreakCommand {
    name: "meal_break";
    mode: MealBreakMode;
    forceRestart: boolean;
    rawBody: string;
}

export interface TelegramMealBreakPriorityCommand {
    name: "meal_break_priority";
    rawBody: string;
}

export interface MealBreakPriorityJustification {
    notes: string;
    actorUserId: string | null;
    updatedAt: string;
}

interface MealBreakPriorityOverrideRecord {
    kind: "telegram_meal_break_priority_overrides";
    version: 1;
    mode: MealBreakMode;
    operationalDate: string;
    orderedRamals: string[];
    justifications: Record<string, MealBreakPriorityJustification>;
    updatedAt: string;
}

interface MealBreakEligibilityOverrideRecord {
    kind: "telegram_meal_break_eligibility_overrides";
    version: 1;
    mode: MealBreakMode;
    operationalDate: string;
    lunchExcludedRamals: string[];
    restExcludedRamals: string[];
    updatedAt: string;
}

interface MealBreakPriorityContextEntry {
    rank: number;
    automaticRank: number;
    doctor: MealBreakDoctor;
    actualStartedAt: string;
    continuityStartedAt: string | null;
    priorityStartedAt: string;
    automaticReasons: string[];
    manualJustification: MealBreakPriorityJustification | null;
}

export interface MealBreakPriorityEntry {
    rank: number;
    automaticRank: number;
    ramal: string;
    name: string;
    roleLabel: string | null;
    shiftLabel: MealBreakDoctor["shiftLabel"];
    actualStartedAt: string;
    continuityStartedAt: string | null;
    priorityStartedAt: string;
    automaticReasons: string[];
    manualJustification: MealBreakPriorityJustification | null;
    explanation: string | null;
}

export interface MealBreakPriorityView {
    mode: MealBreakMode;
    operationalDate: string;
    updatedAt: string;
    chiefRamal: string | null;
    mrvRamals: string[];
    warnings: MealBreakConsistencyIssue[];
    entries: MealBreakPriorityEntry[];
}

export interface MealBreakConsistencyIssue {
    code: "duplicate_doctor";
    message: string;
    doctorId?: string;
    doctorName?: string;
    ramals?: string[];
    ramal?: string;
}

export interface MealBreakRosterResult {
    roster: MealBreakDoctor[];
    chiefRamal: string | null;
    mrvRamals: string[];
}

export interface MealBreakActionResult {
    handled: boolean;
    session: MealBreakSession;
    messages: string[];
    status: "started" | "reported" | "updated" | "completed" | "invalid";
}

const SESSION_NOTICE_STAGE = "meal_break_flow";
const AUTO_NOTICE_STAGE = "meal_break_auto";
const PRIORITY_NOTICE_STAGE = "meal_break_priority";
const SESSION_KIND = "telegram_meal_break_session";
const PRIORITY_KIND = "telegram_meal_break_priority_overrides";
const ELIGIBILITY_KIND = "telegram_meal_break_eligibility_overrides";
const ELIGIBILITY_NOTICE_STAGE = "meal_break_eligibility";
const PRIORITY_NOTICE_CHAT_ID = "operational";
const CHIEF_RAMAL = "2031";
const LUNCH_SLOTS: MealBreakLunchSlot[] = ["11:30", "12:30", "13:30"];
const REST_SLOTS: MealBreakRestSlot[] = ["14:30", "15:30", "16:30", "18:00"];
const DINNER_SLOTS: MealBreakDinnerSlot[] = ["20:30", "21:00", "21:30", "22:00", "22:30"];
const DINNER_CHOICE_SLOTS = ["20:30", "21:00", "21:30"] as const;
const NIGHT_WORK_SLOTS: MealBreakNightWorkSlot[] = ["23:00", "03:00"];
const MEAL_BREAK_LATE_TOLERANCE_MS = 15 * 60 * 1000;
const MEAL_BREAK_CONTINUITY_GAP_MS = 30 * 60 * 1000;
const MEAL_BREAK_CONTINUITY_LOOKBACK_MS = 36 * 60 * 60 * 1000;

function resolveMealBreakModeFromReference(referenceAt: Date): MealBreakMode {
    return resolveOperationalShiftWindow(referenceAt).shiftLabel === "SN" ? "night" : "day";
}

function normalizeFreeText(value: string) {
    return value
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .trim()
        .toUpperCase();
}

function resolveRamalByName(
    session: MealBreakSession,
    text: string,
    allowedRamals?: readonly string[],
): { ramal: string; ambiguous: false } | { ramal: null; ambiguous: false } | { ramal: null; ambiguous: true; candidates: MealBreakDoctor[] } {
    const needle = normalizeFreeText(text);
    if (!needle || needle.length < 2) {
        return { ramal: null, ambiguous: false };
    }

    const allowedSet = allowedRamals ? new Set(allowedRamals.map(normalizeRamal)) : null;
    const matches = session.roster.filter((doctor) => {
        if (allowedSet && !allowedSet.has(doctor.ramal)) {
            return false;
        }
        const normalized = normalizeFreeText(doctor.name);
        const tokens = normalized.split(/\s+/);
        return normalized.includes(needle) || tokens.some((token) => token.startsWith(needle));
    });

    if (matches.length === 1) {
        return { ramal: matches[0].ramal, ambiguous: false };
    }

    if (matches.length > 1) {
        return { ramal: null, ambiguous: true, candidates: matches };
    }

    return { ramal: null, ambiguous: false };
}

function normalizeRamal(value: string) {
    return value.trim().toUpperCase().replace(/\s+/g, "");
}

function pad(value: number) {
    return String(value).padStart(2, "0");
}

function formatOperationalDate(referenceAt: Date) {
    const parts = getSaoPauloParts(resolveOperationalShiftWindow(referenceAt).startedAt);
    return `${parts.year}-${pad(parts.month)}-${pad(parts.day)}`;
}

function formatHour(value: string | Date) {
    return new Intl.DateTimeFormat("pt-BR", {
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
        timeZone: "America/Sao_Paulo",
    }).format(new Date(value));
}

function resolveSessionNoticeKey(chatId: string, mode: MealBreakMode) {
    return `${chatId}:meal_break:session:${mode}`;
}

function resolveLegacySessionNoticeKey(chatId: string) {
    return `${chatId}:meal_break:session`;
}

function resolveAutoNoticeKey(chatId: string, operationalDate: string, mode: MealBreakMode) {
    return `${chatId}:meal_break:auto:${operationalDate}:${mode === "day" ? "09:00" : "20:00"}`;
}

function resolvePriorityNoticeKey(operationalDate: string, mode: MealBreakMode) {
    return `${PRIORITY_NOTICE_CHAT_ID}:meal_break:priority:${operationalDate}:${mode}`;
}

function resolveEligibilityNoticeKey(operationalDate: string, mode: MealBreakMode) {
    return `${PRIORITY_NOTICE_CHAT_ID}:meal_break:eligibility:${operationalDate}:${mode}`;
}

function resolveDoctorName(value: { name: string }) {
    return value.name.trim() || "Medico";
}

function isMealBreakEligibilityOverrideRecord(value: unknown): value is MealBreakEligibilityOverrideRecord {
    if (!value || typeof value !== "object") {
        return false;
    }

    const candidate = value as Record<string, unknown>;
    return candidate.kind === ELIGIBILITY_KIND
        && candidate.version === 1
        && typeof candidate.operationalDate === "string"
        && typeof candidate.mode === "string"
        && typeof candidate.updatedAt === "string"
        && Array.isArray(candidate.lunchExcludedRamals)
        && Array.isArray(candidate.restExcludedRamals);
}

class MealBreakConsistencyError extends Error {
    readonly issues: MealBreakConsistencyIssue[];
    readonly mode: MealBreakMode;
    readonly operationalDate: string;

    constructor(params: {
        mode: MealBreakMode;
        operationalDate: string;
        issues: MealBreakConsistencyIssue[];
    }) {
        super("Ha inconsistência na lista de medicos ativos. Preciso da lista atualizada para continuar.");
        this.name = "MealBreakConsistencyError";
        this.issues = params.issues;
        this.mode = params.mode;
        this.operationalDate = params.operationalDate;
    }
}

function isMealBreakConsistencyError(error: unknown): error is MealBreakConsistencyError {
    return error instanceof MealBreakConsistencyError;
}

function isMealBreakPriorityOverrideRecord(value: unknown): value is MealBreakPriorityOverrideRecord {
    if (!value || typeof value !== "object") {
        return false;
    }

    const candidate = value as Record<string, unknown>;
    return candidate.kind === PRIORITY_KIND
        && candidate.version === 1
        && typeof candidate.operationalDate === "string"
        && typeof candidate.updatedAt === "string"
        && Array.isArray(candidate.orderedRamals)
        && typeof candidate.justifications === "object";
}

function resolveDoctorCompactName(value: { name: string }) {
    const tokens = resolveDoctorName(value)
        .split(/\s+/)
        .map((token) => token.trim())
        .filter(Boolean);
    if (tokens.length <= 1) {
        return resolveDoctorName(value);
    }

    const particles = new Set(["de", "da", "do", "dos", "das", "e"]);
    const suffixes = new Set(["Filho", "Neto", "Junior", "Jr", "Sobrinho"]);
    const filtered = tokens.filter((token) => !particles.has(token));
    if (filtered.length === 0) {
        return tokens[tokens.length - 1] ?? resolveDoctorName(value);
    }

    const first = tokens[0] ?? resolveDoctorName(value);
    const last = filtered[filtered.length - 1] ?? tokens[tokens.length - 1] ?? resolveDoctorName(value);
    const previous = filtered[filtered.length - 2] ?? tokens[tokens.length - 2] ?? null;
    if (suffixes.has(last) && previous) {
        return `${first} ${previous} ${last}`;
    }

    if (first === last) {
        return first;
    }

    return `${first} ${last}`;
}

function sortRoster(left: MealBreakDoctor, right: MealBreakDoctor) {
    const leftTime = new Date(left.startedAt).getTime();
    const rightTime = new Date(right.startedAt).getTime();
    if (leftTime !== rightTime) {
        return leftTime - rightTime;
    }

    return left.ramal.localeCompare(right.ramal);
}

function resolveMealBreakLateThresholdAt(referenceAt: Date) {
    return resolveOperationalShiftWindow(referenceAt).startedAt.getTime() + MEAL_BREAK_LATE_TOLERANCE_MS;
}

function resolveMealBreakLateThresholdFromSession(session: MealBreakSession) {
    const localTime = session.mode === "night" ? "19:15:00-03:00" : "07:15:00-03:00";
    return new Date(`${session.operationalDate}T${localTime}`).getTime();
}

function resolveMealBreakPriorityStartedAt(doctor: MealBreakDoctor, thresholdAtMs: number) {
    const startedAtMs = new Date(doctor.startedAt).getTime();
    if (!isRemoteOperationalRole(doctor.roleLabel)) {
        return startedAtMs;
    }

    return Math.max(startedAtMs, thresholdAtMs);
}

function compareMealBreakDoctorsByThreshold(thresholdAtMs: number, left: MealBreakDoctor, right: MealBreakDoctor) {
    const byPriorityStartedAt = resolveMealBreakPriorityStartedAt(left, thresholdAtMs) - resolveMealBreakPriorityStartedAt(right, thresholdAtMs);
    if (byPriorityStartedAt !== 0) {
        return byPriorityStartedAt;
    }

    const leftIsRemote = isRemoteOperationalRole(left.roleLabel);
    const rightIsRemote = isRemoteOperationalRole(right.roleLabel);
    if (leftIsRemote !== rightIsRemote) {
        return leftIsRemote ? 1 : -1;
    }

    return sortRoster(left, right);
}

function compareMealBreakDoctorsByReference(referenceAt: Date, left: MealBreakDoctor, right: MealBreakDoctor) {
    return compareMealBreakDoctorsByThreshold(resolveMealBreakLateThresholdAt(referenceAt), left, right);
}

function compareSessionRosterOrder(session: MealBreakSession, leftRamal: string, rightRamal: string) {
    const leftIndex = session.roster.findIndex((doctor) => doctor.ramal === leftRamal);
    const rightIndex = session.roster.findIndex((doctor) => doctor.ramal === rightRamal);
    if (leftIndex >= 0 && rightIndex >= 0 && leftIndex !== rightIndex) {
        return leftIndex - rightIndex;
    }

    const leftDoctor = findDoctor(session, leftRamal);
    const rightDoctor = findDoctor(session, rightRamal);
    if (!leftDoctor || !rightDoctor) {
        return leftRamal.localeCompare(rightRamal);
    }

    return compareMealBreakDoctorsByThreshold(resolveMealBreakLateThresholdFromSession(session), leftDoctor, rightDoctor);
}

function buildAutomaticPriorityReasons(params: {
    doctor: MealBreakDoctor;
    actualStartedAt: string;
    continuityStartedAt: string | null;
    priorityStartedAt: string;
}) {
    const reasons: string[] = [];
    const arrivalStartedAt = params.continuityStartedAt ?? params.actualStartedAt;

    if (params.continuityStartedAt && params.continuityStartedAt !== params.actualStartedAt) {
        reasons.push(`continua desde ${formatHour(params.continuityStartedAt)} em outro plantao`);
    }

    if (isRemoteOperationalRole(params.doctor.roleLabel) && params.priorityStartedAt !== arrivalStartedAt) {
        reasons.push(`RMT fixo, entra como ${formatHour(params.priorityStartedAt)}`);
    }

    if (params.doctor.roleLabel === "IES" && isRemotePriorityRegulationCode(params.doctor.ramal)) {
        reasons.push("IES declarado, tratado como presencial");
    }

    return reasons;
}

function buildPriorityEntryExplanation(entry: {
    automaticReasons: string[];
    manualJustification: MealBreakPriorityJustification | null;
}) {
    const parts = [
        entry.manualJustification ? `chefia: ${entry.manualJustification.notes}` : null,
        ...entry.automaticReasons,
    ].filter((value): value is string => Boolean(value));

    return parts.length > 0 ? parts.join("; ") : null;
}

function compareNightQueue(session: MealBreakSession, leftRamal: string, rightRamal: string) {
    return compareSessionRosterOrder(session, leftRamal, rightRamal);
}

function normalizeSessionRamals(session: MealBreakSession, ramals: string[]) {
    const rosterRamals = new Set(session.roster.map((doctor) => doctor.ramal));
    return [...new Set(ramals.map(normalizeRamal).filter((ramal) => rosterRamals.has(ramal)))]
        .sort((left, right) => compareSessionRosterOrder(session, left, right));
}

function filterAssignmentsToRoster<TSlot extends string>(
    session: MealBreakSession,
    assignments: Record<string, TSlot>,
    excludedRamals: Set<string>,
) {
    const rosterRamals = new Set(session.roster.map((doctor) => doctor.ramal));
    return Object.fromEntries(
        Object.entries(assignments).filter(([ramal]) => rosterRamals.has(ramal) && !excludedRamals.has(ramal)),
    ) as Record<string, TSlot>;
}

function isLunchExcluded(session: MealBreakSession, ramal: string) {
    return session.lunchExcludedRamals.includes(ramal);
}

function isRestExcluded(session: MealBreakSession, ramal: string) {
    return session.restExcludedRamals.includes(ramal);
}

function isMealBreakIsolatedRole(roleLabel: string | null | undefined) {
    return normalizeOperationalRoleLabel(roleLabel) === "PSIQ";
}

function isMealBreakDiscretionaryRole(roleLabel: string | null | undefined) {
    return normalizeOperationalRoleLabel(roleLabel) === "CP";
}

function isSharedPositionRole(roleLabel: string | null | undefined) {
    return normalizeOperationalRoleLabel(roleLabel) === "COI";
}

function resolveSharedPositionPeerSlots<T extends string>(session: MealBreakSession, ramal: string, assignments: Record<string, T>): Set<T> {
    const doctor = session.roster.find((d) => d.ramal === ramal);
    if (!doctor || !isSharedPositionRole(doctor.roleLabel)) {
        return new Set();
    }

    const conflicted = new Set<T>();
    for (const peer of session.roster) {
        if (peer.ramal !== ramal && isSharedPositionRole(peer.roleLabel) && assignments[peer.ramal]) {
            conflicted.add(assignments[peer.ramal]);
        }
    }
    return conflicted;
}

function separateSharedPositionConflicts<T extends string>(
    session: MealBreakSession,
    assignments: Record<string, T>,
    slotPool: readonly T[],
) {
    const coiRamals = session.roster
        .filter((d) => isSharedPositionRole(d.roleLabel) && assignments[d.ramal])
        .map((d) => d.ramal);

    if (coiRamals.length < 2) return;

    const seen = new Map<T, string>();
    for (const ramal of coiRamals) {
        const slot = assignments[ramal];
        const conflict = seen.get(slot);
        if (conflict) {
            const peerSlots = new Set(
                coiRamals.filter((r) => r !== ramal).map((r) => assignments[r]),
            );
            const alt = slotPool.find((s) => s !== slot && !peerSlots.has(s));
            if (alt) {
                assignments[ramal] = alt;
            }
        } else {
            seen.set(slot, ramal);
        }
    }
}

function wouldCoiConflictAfterChoice<T extends string>(
    session: MealBreakSession,
    choosingRamal: string,
    chosenSlot: T,
    assignments: Record<string, T>,
    queue: string[],
    slotPool: readonly T[],
    remaining: Record<string, number>,
): boolean {
    const chooser = session.roster.find((d) => d.ramal === choosingRamal);
    if (chooser && isSharedPositionRole(chooser.roleLabel)) return false;

    const simRemaining: Record<string, number> = {};
    for (const s of slotPool) {
        simRemaining[s] = remaining[s] ?? 0;
    }
    simRemaining[chosenSlot] = Math.max(0, simRemaining[chosenSlot] - 1);

    const futureQueue = queue.filter((r) => r !== choosingRamal);
    const coiPending = futureQueue.filter((r) => {
        const d = session.roster.find((doc) => doc.ramal === r);
        return d && isSharedPositionRole(d.roleLabel);
    });

    if (coiPending.length === 0) return false;

    const coiAssignedSlots = new Set<T>();
    for (const doc of session.roster) {
        if (isSharedPositionRole(doc.roleLabel) && assignments[doc.ramal] && !queue.includes(doc.ramal)) {
            coiAssignedSlots.add(assignments[doc.ramal]);
        }
    }

    if (coiPending.length >= 2 && coiAssignedSlots.size === 0) {
        const slotsWithCapacity = slotPool.filter((s) => simRemaining[s] > 0);
        return slotsWithCapacity.length < 2;
    }

    if (coiPending.length >= 1 && coiAssignedSlots.size > 0) {
        const availableForCoi = slotPool.filter((s) => !coiAssignedSlots.has(s) && simRemaining[s] > 0);
        return availableForCoi.length === 0;
    }

    return false;
}

function resolveDayMealBreakIsolatedRamals(session: MealBreakSession) {
    return normalizeSessionRamals(
        session,
        session.roster
            .filter((doctor) => isMealBreakIsolatedRole(doctor.roleLabel))
            .map((doctor) => doctor.ramal),
    );
}

function resolveDayMealBreakDiscretionaryRamals(session: MealBreakSession) {
    return normalizeSessionRamals(
        session,
        session.roster
            .filter((doctor) => isMealBreakDiscretionaryRole(doctor.roleLabel))
            .map((doctor) => doctor.ramal),
    );
}

function buildExcludedSummaryBlock(title: string, session: MealBreakSession, ramals: string[]) {
    if (ramals.length === 0) {
        return [] as string[];
    }

    return [
        "",
        title,
        ...ramals.map((ramal) => `• ${renderDoctorCompactSummary(session, ramal)}`),
    ];
}

function hasDuplicateDoctorIds(roster: MealBreakDoctor[]) {
    const seen = new Set<string>();
    for (const doctor of roster) {
        if (seen.has(doctor.doctorId)) {
            return true;
        }
        seen.add(doctor.doctorId);
    }
    return false;
}

function buildMealBreakConsistencyIssues(params: {
    regulation: MealBreakRosterDoctor[];
    mode: MealBreakMode;
}) {
    const issues: MealBreakConsistencyIssue[] = [];
    const doctorsById = new Map<string, MealBreakRosterDoctor[]>();

    for (const doctor of params.regulation) {
        const current = doctorsById.get(doctor.doctorId) ?? [];
        current.push(doctor);
        doctorsById.set(doctor.doctorId, current);
    }

    for (const [doctorId, doctors] of doctorsById.entries()) {
        if (doctors.length < 2) {
            continue;
        }

        const sortedRamals = [...new Set(doctors.map((doctor) => doctor.ramal))].sort((left, right) => left.localeCompare(right));
        const doctorName = doctors[0]?.name ?? doctorId;
        issues.push({
            code: "duplicate_doctor",
            message: `${doctorName} aparece em mais de um ramal ativo: ${sortedRamals.join(", ")}.`,
            doctorId,
            doctorName,
            ramals: sortedRamals,
        });
    }

    return issues;
}

function dedupeMealBreakRoster(params: {
    roster: MealBreakRosterDoctor[];
    issues: MealBreakConsistencyIssue[];
}) {
    const firstRamalByDoctorId = new Map<string, string>();
    const deduped: MealBreakRosterDoctor[] = [];

    for (const doctor of params.roster) {
        if (firstRamalByDoctorId.has(doctor.doctorId)) {
            continue;
        }

        firstRamalByDoctorId.set(doctor.doctorId, doctor.ramal);
        deduped.push(doctor);
    }

    const warnings = params.issues.map((issue) => {
        const chosenRamal = issue.doctorId ? firstRamalByDoctorId.get(issue.doctorId) ?? null : null;
        if (!chosenRamal) {
            return issue;
        }

        return {
            ...issue,
            ramal: chosenRamal,
            message: `${issue.message} A fila vai considerar ${chosenRamal}.`,
        } satisfies MealBreakConsistencyIssue;
    });

    return {
        roster: deduped,
        warnings,
    };
}

export function buildMealBreakConsistencyAdminReply(error: unknown) {
    if (!isMealBreakConsistencyError(error)) {
        return null;
    }

    const title = error.mode === "night"
        ? `⚠️ Inconsistência na fila do jantar ${error.operationalDate}`
        : `⚠️ Inconsistência na fila do almoço ${error.operationalDate}`;

    return [
        title,
        ...error.issues.map((issue, index) => `${index + 1}. ${issue.message}`),
        "",
        "Corrija o quadro e rode /prioridade novamente.",
    ].join("\n");
}

function resolveMealBreakDoctorShiftLabel(params: {
    startedAt: string;
    shiftLabel: MealBreakDoctor["shiftLabel"] | null;
    referenceAt: Date;
}) {
    if (params.shiftLabel) {
        return params.shiftLabel;
    }

    const currentShift = resolveOperationalShiftWindow(params.referenceAt);
    return new Date(params.startedAt).getTime() >= currentShift.startedAt.getTime()
        ? currentShift.shiftLabel
        : "P";
}

function mapRegulationDoctor(row: OperationalBoard["regulation"][number], mode: MealBreakMode, referenceAt: Date): MealBreakRosterDoctor | null {
    if (row.status !== "active" || !row.doctorId || !row.startedAt) {
        return null;
    }

    if (mode === "day" && isPiamRegulationPost(row.postCode)) {
        return null;
    }

    if (isNucleoRegulationPost(row.postCode)) {
        return null;
    }

    const effectiveShiftLabel = resolveMealBreakDoctorShiftLabel({
        startedAt: row.startedAt,
        shiftLabel: row.shiftLabel,
        referenceAt,
    });

    if (mode === "day" && effectiveShiftLabel === "SN") {
        return null;
    }

    if (mode === "night" && effectiveShiftLabel === "SD") {
        return null;
    }

    return {
        doctorId: row.doctorId,
        occupancyId: row.occupancyId,
        ramal: normalizeRamal(row.postCode),
        name: formatDoctorSurfaceName({
            fullName: row.doctorName,
            displayName: row.displayName,
            fallback: row.postCode,
        }),
        domain: "regulation",
        startedAt: row.boardStartedAt ?? row.startedAt,
        shiftLabel: effectiveShiftLabel,
        roleLabel: resolveOperationalRoleLabel({
            domain: "regulation",
            code: normalizeRamal(row.postCode),
            shiftLabel: effectiveShiftLabel,
            roleLabel: row.roleLabel,
            defaultRole: row.defaultRole,
        }),
    };
}

function isMealBreakSession(value: unknown): value is MealBreakSession {
    if (!value || typeof value !== "object") {
        return false;
    }

    const candidate = value as Record<string, unknown>;
    return candidate.kind === SESSION_KIND
        && typeof candidate.operationalDate === "string"
        && typeof candidate.stage === "string"
        && Array.isArray(candidate.roster)
        && candidate.version === 1;
}

function shouldExcludeRamalFromDayMealBreak(ramal: string) {
    return isPiamRegulationPost(ramal) || isNucleoRegulationPost(ramal);
}

function sanitizeMealBreakRosterForMode(roster: MealBreakDoctor[], mode: MealBreakMode) {
    if (mode !== "day") {
        return [...roster];
    }

    return roster.filter((doctor) => !shouldExcludeRamalFromDayMealBreak(doctor.ramal));
}

function sanitizeMealBreakSessionState(session: MealBreakSession, mode: MealBreakMode): MealBreakSession {
    const roster = sanitizeMealBreakRosterForMode(session.roster, mode);
    if (mode !== "day") {
        return {
            ...session,
            roster,
        };
    }

    const rosterRamals = new Set(roster.map((doctor) => doctor.ramal));
    const filterRamals = (ramals: string[]) => ramals
        .map(normalizeRamal)
        .filter((ramal, index, collection) => rosterRamals.has(ramal) && collection.indexOf(ramal) === index);

    return {
        ...session,
        roster,
        recipRamal: session.recipRamal && rosterRamals.has(session.recipRamal) ? session.recipRamal : null,
        mrvRamals: filterRamals(session.mrvRamals),
        mrvLunch1230Ramal: session.mrvLunch1230Ramal && rosterRamals.has(session.mrvLunch1230Ramal) ? session.mrvLunch1230Ramal : null,
        lunchExcludedRamals: filterRamals(session.lunchExcludedRamals ?? []),
        restExcludedRamals: filterRamals(session.restExcludedRamals ?? []),
        lunchQueue: filterRamals(session.lunchQueue ?? []),
        restQueue: filterRamals(session.restQueue ?? []),
    } satisfies MealBreakSession;
}

function hydrateMealBreakSession(session: MealBreakSession): MealBreakSession {
    const mode = session.mode ?? "day";
    const sanitizedSession = sanitizeMealBreakSessionState(session, mode);
    const lunchCapacities = sanitizedSession.lunchCapacities ?? (mode === "day" ? resolveThreeSlotCapacities(sanitizedSession.roster.length) : { "11:30": 0, "12:30": 0, "13:30": 0 });
    const restChoiceCapacities = sanitizedSession.restChoiceCapacities ?? { "15:30": 0, "16:30": 0 };
    const nightWorkAssignments = sanitizedSession.nightWorkAssignments ?? {};
    const dinnerAssignments = sanitizedSession.dinnerAssignments ?? {};
    const dinnerDurationAssignments = sanitizedSession.dinnerDurationAssignments ?? Object.fromEntries(
        sanitizedSession.roster.map((doctor) => [doctor.ramal, resolveNightDinnerDuration(doctor)]),
    ) as Record<string, MealBreakDinnerDuration>;

    const hydrated: MealBreakSession = {
        ...sanitizedSession,
        mode,
        lunchCapacities,
        lunchExcludedRamals: sanitizedSession.lunchExcludedRamals ?? [],
        restChoiceCapacities,
        restExcludedRamals: sanitizedSession.restExcludedRamals ?? [],
        nightWorkCapacities: sanitizedSession.nightWorkCapacities ?? (mode === "night" ? resolveNightWorkCapacities(sanitizedSession.roster.length) : { "23:00": 0, "03:00": 0 }),
        nightWorkAssignments,
        dinnerAssignments,
        dinnerDurationAssignments,
        dinnerChoiceCapacities: sanitizedSession.dinnerChoiceCapacities ?? { "20:30": 0, "21:00": 0, "21:30": 0 },
        nightWorkQueue: sanitizedSession.nightWorkQueue ?? [],
        dinnerQueue: sanitizedSession.dinnerQueue ?? [],
        lunchQueue: sanitizedSession.lunchQueue ?? [],
        restQueue: sanitizedSession.restQueue ?? [],
        undoSnapshots: sanitizedSession.undoSnapshots ?? [],
    };

    return mode === "night" ? syncNightSessionState(hydrated) : syncDaySessionState(hydrated);
}

function resolveNightDinnerDuration(doctor: MealBreakDoctor): MealBreakDinnerDuration {
    return doctor.shiftLabel === "P" ? "one_hour" : "half_hour";
}

function resolveDefaultNightDinnerSlot(duration: MealBreakDinnerDuration): MealBreakDinnerSlot {
    return duration === "one_hour" ? "22:00" : "22:30";
}

function resolveNightWorkCapacities(totalDoctors: number) {
    return {
        "23:00": Math.ceil(totalDoctors / 2),
        "03:00": Math.floor(totalDoctors / 2),
    } satisfies Record<MealBreakNightWorkSlot, number>;
}

function resolveDinnerChoiceCapacities(totalDoctors: number) {
    const base = Math.floor(totalDoctors / DINNER_CHOICE_SLOTS.length);
    const remainder = totalDoctors % DINNER_CHOICE_SLOTS.length;
    const capacities = {
        "20:30": base,
        "21:00": base,
        "21:30": base,
    } satisfies Record<(typeof DINNER_CHOICE_SLOTS)[number], number>;

    const priority = ["20:30", "21:30", "21:00"] as const;
    for (let index = 0; index < remainder; index += 1) {
        capacities[priority[index]] += 1;
    }

    return capacities;
}

function findDoctor(session: MealBreakSession, ramal: string) {
    return session.roster.find((doctor) => doctor.ramal === ramal) ?? null;
}

function renderDoctorSummary(session: MealBreakSession, ramal: string, tag?: string) {
    const doctor = findDoctor(session, ramal);
    const badges = [tag, normalizeOperationalRoleLabel(doctor?.roleLabel)]
        .filter((value): value is string => Boolean(value))
        .filter((value, index, collection) => collection.indexOf(value) === index);
    const suffix = badges.length > 0 ? ` (${badges.join(" / ")})` : "";
    if (!doctor) {
        return `${ramal}${suffix}`;
    }

    return `${ramal} - ${resolveDoctorName(doctor)}${suffix}`;
}

function renderDoctorCompactSummary(session: MealBreakSession, ramal: string, tag?: string) {
    const doctor = findDoctor(session, ramal);
    const normalizedRole = normalizeOperationalRoleLabel(doctor?.roleLabel);
    const badges = [tag, normalizedRole && normalizedRole !== "MR" ? normalizedRole : null]
        .filter((value): value is string => Boolean(value))
        .filter((value, index, collection) => collection.indexOf(value) === index);
    const suffix = badges.length > 0 ? ` (${badges.join(" / ")})` : "";
    if (!doctor) {
        return `${ramal}${suffix}`;
    }

    return `${resolveDoctorCompactName(doctor)}${suffix}`;
}

function buildSummarySlotBlock(slot: string, entries: string[]) {
    return [
        slot,
        ...(entries.length > 0 ? entries.map((entry) => `• ${entry}`) : ["• --"]),
    ].join("\n");
}

function renderSlotLine<TSlot extends MealBreakLunchSlot | MealBreakRestSlot>(params: {
    session: MealBreakSession;
    slot: TSlot;
    assignments: Record<string, TSlot>;
}) {
    const ramals = Object.entries(params.assignments)
        .filter(([, assignedSlot]) => assignedSlot === params.slot)
        .map(([ramal]) => ramal)
        .sort((left, right) => compareSessionRosterOrder(params.session, left, right));

    const entries = ramals.map((ramal) => {
        const isRecip = params.session.recipRamal === ramal;
        const isMrv = params.session.mrvRamals.includes(ramal);
        const tag = isRecip ? "RECIP" : isMrv ? "MRV" : undefined;
        return renderDoctorCompactSummary(params.session, ramal, tag);
    });

    return buildSummarySlotBlock(params.slot, entries);
}

function renderNightDinnerLine(session: MealBreakSession, slot: MealBreakDinnerSlot) {
    const ramals = Object.entries(session.dinnerAssignments)
        .filter(([, assignedSlot]) => assignedSlot === slot)
        .map(([ramal]) => ramal)
        .sort((left, right) => compareNightQueue(session, left, right));

    const entries = ramals.map((ramal) => {
        const duration = session.dinnerDurationAssignments[ramal] === "one_hour" ? "1h" : "30min";
        return `${renderDoctorCompactSummary(session, ramal)} - ${duration}`;
    });

    return buildSummarySlotBlock(slot, entries);
}

function renderNightWorkLine(session: MealBreakSession, slot: MealBreakNightWorkSlot) {
    const ramals = Object.entries(session.nightWorkAssignments)
        .filter(([, assignedSlot]) => assignedSlot === slot)
        .map(([ramal]) => ramal)
        .sort((left, right) => compareNightQueue(session, left, right));

    const entries = ramals.map((ramal) => renderDoctorCompactSummary(session, ramal));

    return buildSummarySlotBlock(slot, entries);
}

function buildSessionSummary(session: MealBreakSession) {
    if (session.mode === "night") {
        const workLines = NIGHT_WORK_SLOTS.map((slot) => renderNightWorkLine(session, slot));
        const dinnerLines = DINNER_SLOTS.map((slot) => renderNightDinnerLine(session, slot));
        const tail = session.chiefRamal
            ? ["", "👑 CHEFIA", "• A criterio"]
            : [];

        return [
            "🍽️ JANTAR",
            ...dinnerLines,
            "",
            "🌙 TRABALHO",
            ...workLines,
            ...tail,
        ].join("\n");
    }

    const lunchLines = LUNCH_SLOTS.map((slot) => renderSlotLine({
        session,
        slot,
        assignments: session.lunchAssignments,
    }));
    const restLines = REST_SLOTS.map((slot) => renderSlotLine({
        session,
        slot,
        assignments: session.restAssignments,
    }));

    const tail = session.chiefRamal
        ? ["", "👑 CHEFIA", "• Almoco a criterio", "• Descanso a criterio"]
        : [];
    const lunchExcluded = buildExcludedSummaryBlock("🚫 FORA DO ALMOCO", session, session.lunchExcludedRamals);
    const restExcluded = buildExcludedSummaryBlock("🚫 FORA DO DESCANSO", session, session.restExcludedRamals);

    return [
        "🍽️ ALMOCO",
        ...lunchLines,
        ...lunchExcluded,
        "",
        "😴 DESCANSO",
        ...restLines,
        ...restExcluded,
        ...tail,
    ].join("\n");
}

function buildAvailableLunchText(session: MealBreakSession) {
    const remaining = resolveRemainingLunchSlots(session);
    return LUNCH_SLOTS
        .filter((slot) => remaining[slot] > 0)
        .map((slot) => `${slot} (${remaining[slot]} vaga${remaining[slot] > 1 ? "s" : ""})`)
        .join(", ");
}

function buildAvailableRestText(session: MealBreakSession) {
    const remaining = resolveRemainingRestChoiceSlots(session);
    return (["15:30", "16:30"] as const)
        .filter((slot) => remaining[slot] > 0)
        .map((slot) => `${slot} (${remaining[slot]} vaga${remaining[slot] > 1 ? "s" : ""})`)
        .join(", ");
}

function resolveRemainingNightWorkSlots(session: MealBreakSession) {
    let assigned2300 = 0;
    let assigned0300 = 0;

    for (const slot of Object.values(session.nightWorkAssignments)) {
        if (slot === "23:00") {
            assigned2300 += 1;
        }
        if (slot === "03:00") {
            assigned0300 += 1;
        }
    }

    return {
        "23:00": Math.max(0, session.nightWorkCapacities["23:00"] - assigned2300),
        "03:00": Math.max(0, session.nightWorkCapacities["03:00"] - assigned0300),
    } satisfies Record<MealBreakNightWorkSlot, number>;
}

function resolveRemainingDinnerChoiceSlots(session: MealBreakSession) {
    const counts = {
        "20:30": 0,
        "21:00": 0,
        "21:30": 0,
    } satisfies Record<(typeof DINNER_CHOICE_SLOTS)[number], number>;

    for (const slot of Object.values(session.dinnerAssignments)) {
        if (slot === "20:30" || slot === "21:00" || slot === "21:30") {
            counts[slot] += 1;
        }
    }

    return {
        "20:30": Math.max(0, session.dinnerChoiceCapacities["20:30"] - counts["20:30"]),
        "21:00": Math.max(0, session.dinnerChoiceCapacities["21:00"] - counts["21:00"]),
        "21:30": Math.max(0, session.dinnerChoiceCapacities["21:30"] - counts["21:30"]),
    } satisfies Record<(typeof DINNER_CHOICE_SLOTS)[number], number>;
}

function buildAvailableNightWorkText(session: MealBreakSession) {
    const remaining = resolveRemainingNightWorkSlots(session);
    return NIGHT_WORK_SLOTS
        .filter((slot) => remaining[slot] > 0)
        .map((slot) => `${slot} (${remaining[slot]} vaga${remaining[slot] > 1 ? "s" : ""})`)
        .join(", ");
}

function buildAvailableDinnerText(session: MealBreakSession) {
    const remaining = resolveRemainingDinnerChoiceSlots(session);
    return DINNER_CHOICE_SLOTS
        .filter((slot) => remaining[slot] > 0)
        .map((slot) => `${slot} (${remaining[slot]} vaga${remaining[slot] > 1 ? "s" : ""})`)
        .join(", ");
}

export function buildMealBreakStageKeyboard(session: MealBreakSession): TelegramReplyMarkup | null {
    const undoRow = session.undoSnapshots.length > 0 ? [UNDO_TEXT] : [];

    if (session.stage === "awaiting_confirmation") {
        return buildChoiceKeyboard([[CONFIRM_TEXT]]);
    }

    if (session.stage === "awaiting_mrv_lunch") {
        if (session.mrvRamals.length === 0) {
            return undoRow.length > 0 ? buildChoiceKeyboard([undoRow]) : null;
        }
        const rows = [session.mrvRamals];
        if (undoRow.length > 0) rows.push(undoRow);
        return buildChoiceKeyboard(rows);
    }

    if (session.stage === "awaiting_lunch_choice") {
        const ramal = session.lunchQueue[0];
        if (!ramal) {
            return undoRow.length > 0 ? buildChoiceKeyboard([undoRow]) : null;
        }
        const remaining = resolveRemainingLunchSlots(session);
        const slots = LUNCH_SLOTS.filter((slot) => remaining[slot] > 0);
        if (slots.length === 0 && undoRow.length === 0) {
            return null;
        }
        const rows: string[][] = [];
        if (slots.length > 0) rows.push(slots.map((slot) => `${ramal} ${slot}`));
        if (undoRow.length > 0) rows.push(undoRow);
        return rows.length > 0 ? buildChoiceKeyboard(rows) : null;
    }

    if (session.stage === "awaiting_rest_choice") {
        const ramal = session.restQueue[0];
        if (!ramal) {
            return undoRow.length > 0 ? buildChoiceKeyboard([undoRow]) : null;
        }
        const remaining = resolveRemainingRestChoiceSlots(session);
        const slots = (["15:30", "16:30"] as const).filter((slot) => remaining[slot] > 0);
        if (slots.length === 0 && undoRow.length === 0) {
            return null;
        }
        const rows: string[][] = [];
        if (slots.length > 0) rows.push(slots.map((slot) => `${ramal} ${slot}`));
        if (undoRow.length > 0) rows.push(undoRow);
        return rows.length > 0 ? buildChoiceKeyboard(rows) : null;
    }

    if (session.stage === "awaiting_night_work_choice") {
        const ramal = session.nightWorkQueue[0];
        if (!ramal) {
            return undoRow.length > 0 ? buildChoiceKeyboard([undoRow]) : null;
        }
        const remaining = resolveRemainingNightWorkSlots(session);
        const slots = NIGHT_WORK_SLOTS.filter((slot) => remaining[slot] > 0);
        if (slots.length === 0 && undoRow.length === 0) {
            return null;
        }
        const rows: string[][] = [];
        if (slots.length > 0) rows.push(slots.map((slot) => `${ramal} ${slot}`));
        if (undoRow.length > 0) rows.push(undoRow);
        return rows.length > 0 ? buildChoiceKeyboard(rows) : null;
    }

    if (session.stage === "awaiting_dinner_choice") {
        const ramal = session.dinnerQueue[0];
        if (!ramal) {
            return undoRow.length > 0 ? buildChoiceKeyboard([undoRow]) : null;
        }
        const remaining = resolveRemainingDinnerChoiceSlots(session);
        const slots = DINNER_CHOICE_SLOTS.filter((slot) => remaining[slot] > 0);
        if (slots.length === 0 && undoRow.length === 0) {
            return null;
        }
        const rows: string[][] = [];
        if (slots.length > 0) rows.push(slots.map((slot) => `${ramal} ${slot}`));
        if (undoRow.length > 0) rows.push(undoRow);
        return rows.length > 0 ? buildChoiceKeyboard(rows) : null;
    }

    if (session.stage === "completed") {
        return REMOVE_KEYBOARD;
    }

    return undoRow.length > 0 ? buildChoiceKeyboard([undoRow]) : null;
}

function buildDayStartPrompt() {
    return "Primeiro, informem o RAMAL ou nome do medico RECIP.";
}

function buildNightWorkQueuePrompt(session: MealBreakSession) {
    const currentRamal = session.nightWorkQueue[0] ?? null;
    if (!currentRamal) {
        return "Nao ha mais escolhas de trabalho pendentes.";
    }

    const doctor = findDoctor(session, currentRamal);
    const name = resolveDoctorCompactName(doctor ?? { name: currentRamal });
    return `${currentRamal} - ${name}\n\n🔔 Sua vez`;
}

function buildNightDinnerQueuePrompt(session: MealBreakSession) {
    const currentRamal = session.dinnerQueue[0] ?? null;
    if (!currentRamal) {
        return "Nao ha mais escolhas de jantar pendentes.";
    }

    const doctor = findDoctor(session, currentRamal);
    const name = resolveDoctorCompactName(doctor ?? { name: currentRamal });
    const duration = session.dinnerDurationAssignments[currentRamal] === "one_hour" ? "1h" : "30min";
    return `${currentRamal} - ${name} (${duration})\n\n🔔 Sua vez`;
}

function buildNightStartPrompt(session: MealBreakSession) {
    return [
        `🌙 Chefia 2031 a criterio`,
        `📊 23:00 (${session.nightWorkCapacities["23:00"]}) · 03:00 (${session.nightWorkCapacities["03:00"]})`,
        "",
        buildNightWorkQueuePrompt(session),
    ].join("\n");
}

function buildStartPrompt(session: MealBreakSession) {
    return buildConfirmationPrompt(session);
}

function buildLunchQueuePrompt(session: MealBreakSession) {
    const currentRamal = session.lunchQueue[0] ?? null;
    if (!currentRamal) {
        return "Nao ha mais escolhas de almoco pendentes.";
    }

    const doctor = findDoctor(session, currentRamal);
    const name = resolveDoctorCompactName(doctor ?? { name: currentRamal });
    return `${currentRamal} - ${name}\n\n🔔 Sua vez`;
}

function buildRestQueuePrompt(session: MealBreakSession) {
    const currentRamal = session.restQueue[0] ?? null;
    if (!currentRamal) {
        return "Nao ha mais escolhas de descanso pendentes.";
    }

    const doctor = findDoctor(session, currentRamal);
    const name = resolveDoctorCompactName(doctor ?? { name: currentRamal });
    return `${currentRamal} - ${name}\n\n🔔 Sua vez`;
}

function buildExistingSessionReply(session: MealBreakSession) {
    if (session.stage === "awaiting_confirmation") {
        return buildConfirmationPrompt(session);
    }

    const intro = session.stage === "completed"
        ? "Ja existe uma divisao fechada hoje."
        : "Ja existe uma divisao em andamento hoje.";
    const nextStep = session.stage === "completed"
        ? `Se quiser reiniciar, mande /${session.mode === "night" ? "jantar" : "almoco"} reiniciar.`
        : `${buildCurrentPrompt(session)}\n\nSe quiser reiniciar, mande /${session.mode === "night" ? "jantar" : "almoco"} reiniciar.`;

    return [intro, "", buildSessionSummary(session), "", nextStep].join("\n");
}

function buildConfirmationPrompt(session: MealBreakSession) {
    const mode = session.mode;
    const label = mode === "night" ? "jantar" : "almoco";
    const priorityDoctors = mode === "day"
        ? session.roster.filter((doctor) => !isMealBreakIsolatedRole(doctor.roleLabel) && !isMealBreakDiscretionaryRole(doctor.roleLabel))
        : session.roster;
    const isolatedDoctors = mode === "day"
        ? session.roster.filter((doctor) => isMealBreakIsolatedRole(doctor.roleLabel))
        : [];
    const priority = priorityDoctors.map((doctor, index) =>
        `${index + 1}. ${resolveDoctorCompactName(doctor)} · ${doctor.ramal}`,
    );
    const isolated = isolatedDoctors.length > 0
        ? [
            "",
            "Fora da divisao:",
            ...isolatedDoctors.map((doctor) => `${resolveDoctorCompactName(doctor)} · ${doctor.ramal} · PSIQ · almoca 12:30 e descansa 18:00`),
        ]
        : [];
    const restartCmd = mode === "night" ? "/jantar reiniciar" : "/almoco reiniciar";

    return [
        mode === "night" ? "🌙 DIVISAO DO JANTAR" : "☀️ DIVISAO DO ALMOCO",
        "",
        "Ordem de prioridade:",
        ...priority,
        ...isolated,
        "",
        `Confirme para iniciar a divisao de ${label}.`,
        `Se os horarios de chegada estao errados, ajuste pelo site e mande ${restartCmd}.`,
    ].join("\n");
}

function buildCurrentPrompt(session: MealBreakSession) {
    if (session.stage === "awaiting_confirmation") {
        return buildConfirmationPrompt(session);
    }

    if (session.mode === "night") {
        if (session.stage === "awaiting_night_work_choice") {
            return buildNightWorkQueuePrompt(session);
        }
        if (session.stage === "awaiting_dinner_choice") {
            return buildNightDinnerQueuePrompt(session);
        }

        return "Divisao encerrada.";
    }

    if (session.stage === "awaiting_recip") {
        return buildDayStartPrompt();
    }
    if (session.stage === "awaiting_mrv_lunch") {
        const doctors = session.mrvRamals.map((ramal) => {
            const doc = findDoctor(session, ramal);
            return `${ramal} · ${resolveDoctorCompactName(doc ?? { name: ramal })}`;
        });
        return [
            "🍽️ Qual MRV almoca 12:30?",
            "",
            ...doctors.map((d) => `• ${d}`),
        ].join("\n");
    }
    if (session.stage === "awaiting_lunch_choice") {
        return buildLunchQueuePrompt(session);
    }
    if (session.stage === "awaiting_rest_choice") {
        return buildRestQueuePrompt(session);
    }

    return "Divisao encerrada.";
}

function compareLunchQueue(session: MealBreakSession, leftRamal: string, rightRamal: string) {
    return compareSessionRosterOrder(session, leftRamal, rightRamal);
}

function resolveThreeSlotCapacities(totalDoctors: number) {
    const slots: MealBreakLunchSlot[] = ["11:30", "12:30", "13:30"];
    const capacities = {
        "11:30": 0,
        "12:30": 0,
        "13:30": 0,
    } satisfies Record<MealBreakLunchSlot, number>;

    const base = Math.floor(totalDoctors / slots.length);
    const remainder = totalDoctors % slots.length;
    for (const slot of slots) {
        capacities[slot] = base;
    }

    const priority: MealBreakLunchSlot[] = ["11:30", "13:30", "12:30"];
    for (let index = 0; index < remainder; index += 1) {
        capacities[priority[index] as MealBreakLunchSlot] += 1;
    }

    return capacities;
}

function resolveTwoSlotCapacities(totalDoctors: number) {
    const flexibleCap = Math.ceil(totalDoctors / 2);
    return {
        "15:30": flexibleCap,
        "16:30": flexibleCap,
    } satisfies Record<"15:30" | "16:30", number>;
}

export function resolveMealBreakLunchCapacities(totalDoctors: number) {
    return resolveThreeSlotCapacities(totalDoctors);
}

export function syncDaySessionState(session: MealBreakSession) {
    const isolatedRamals = resolveDayMealBreakIsolatedRamals(session);
    const isolatedSet = new Set(isolatedRamals);
    const discretionaryRamals = resolveDayMealBreakDiscretionaryRamals(session);
    const discretionarySet = new Set(discretionaryRamals);
    const lunchExcludedRamals = normalizeSessionRamals(
        session,
        (session.lunchExcludedRamals ?? []).filter((ramal) => {
            const normalizedRamal = normalizeRamal(ramal);
            return !isolatedSet.has(normalizedRamal) && !discretionarySet.has(normalizedRamal);
        }),
    );
    const restExcludedRamals = normalizeSessionRamals(
        session,
        (session.restExcludedRamals ?? []).filter((ramal) => {
            const normalizedRamal = normalizeRamal(ramal);
            return !isolatedSet.has(normalizedRamal) && !discretionarySet.has(normalizedRamal);
        }),
    );
    const lunchExcludedSet = new Set(lunchExcludedRamals);
    const restExcludedSet = new Set(restExcludedRamals);
    const lunchIgnoredSet = new Set([...lunchExcludedRamals, ...discretionaryRamals]);
    const restIgnoredSet = new Set([...restExcludedRamals, ...discretionaryRamals]);

    const lunchAssignments = filterAssignmentsToRoster(session, session.lunchAssignments, lunchIgnoredSet);
    const restAssignments = filterAssignmentsToRoster(session, session.restAssignments, restIgnoredSet);
    const eligibleLunchCount = session.roster.filter((doctor) => !lunchIgnoredSet.has(doctor.ramal) && !isolatedSet.has(doctor.ramal)).length;

    for (const ramal of isolatedRamals) {
        lunchAssignments[ramal] = "12:30";
        restAssignments[ramal] = "18:00";
    }

    if (session.recipRamal && !lunchExcludedSet.has(session.recipRamal) && !isolatedSet.has(session.recipRamal)) {
        lunchAssignments[session.recipRamal] = "11:30";
    }
    if (session.recipRamal && !restExcludedSet.has(session.recipRamal) && !isolatedSet.has(session.recipRamal)) {
        restAssignments[session.recipRamal] = "18:00";
    }

    if (session.mrvLunch1230Ramal) {
        const otherMrv = session.mrvRamals.find((ramal) => ramal !== session.mrvLunch1230Ramal) ?? null;
        if (!lunchExcludedSet.has(session.mrvLunch1230Ramal) && !isolatedSet.has(session.mrvLunch1230Ramal)) {
            lunchAssignments[session.mrvLunch1230Ramal] = "12:30";
        }
        if (!restExcludedSet.has(session.mrvLunch1230Ramal) && !isolatedSet.has(session.mrvLunch1230Ramal)) {
            restAssignments[session.mrvLunch1230Ramal] = "18:00";
        }

        if (otherMrv && !lunchExcludedSet.has(otherMrv) && !isolatedSet.has(otherMrv)) {
            lunchAssignments[otherMrv] = "13:30";
        }
        if (otherMrv && !restExcludedSet.has(otherMrv) && !isolatedSet.has(otherMrv)) {
            restAssignments[otherMrv] = "18:00";
        }
    }

    const mrvPhaseComplete = session.mrvLunch1230Ramal || session.mrvRamals.length === 0;
    const lunchQueue = mrvPhaseComplete
        ? session.roster
            .map((doctor) => doctor.ramal)
            .filter((ramal) => !lunchIgnoredSet.has(ramal) && !isolatedSet.has(ramal))
            .filter((ramal) => ramal !== session.recipRamal && !session.mrvRamals.includes(ramal))
            .filter((ramal) => !lunchAssignments[ramal])
            .sort((left, right) => compareLunchQueue(session, left, right))
        : [];

    if (mrvPhaseComplete && lunchQueue.length === 0) {
        for (const ramal of session.roster.map((doctor) => doctor.ramal)) {
            if (
                !restIgnoredSet.has(ramal)
                && !isolatedSet.has(ramal)
                && lunchAssignments[ramal] === "13:30"
                && !session.mrvRamals.includes(ramal)
            ) {
                const peerConflicts = resolveSharedPositionPeerSlots(session, ramal, restAssignments);
                if (!peerConflicts.has("14:30")) {
                    restAssignments[ramal] = "14:30";
                }
            }
        }
    } else {
        for (const [ramal, slot] of Object.entries(restAssignments)) {
            const isFixedEighteen = slot === "18:00"
                && (ramal === session.recipRamal || session.mrvRamals.includes(ramal) || isolatedSet.has(ramal));
            if (!isFixedEighteen) {
                delete restAssignments[ramal];
            }
        }
    }

    const restQueue = mrvPhaseComplete && lunchQueue.length === 0
        ? session.roster
            .map((doctor) => doctor.ramal)
            .filter((ramal) => !restIgnoredSet.has(ramal) && !isolatedSet.has(ramal))
            .filter((ramal) => !restAssignments[ramal])
        : [];
    const flexRestAlreadyAssigned = mrvPhaseComplete && lunchQueue.length === 0
        ? Object.values(restAssignments).filter((slot) => slot === "15:30" || slot === "16:30").length
        : 0;
    const restChoiceCapacities = resolveTwoSlotCapacities(restQueue.length + flexRestAlreadyAssigned);

    separateSharedPositionConflicts(session, lunchAssignments, LUNCH_SLOTS);
    separateSharedPositionConflicts(session, restAssignments, REST_SLOTS);

    return {
        ...session,
        lunchAssignments,
        lunchExcludedRamals,
        lunchCapacities: resolveThreeSlotCapacities(eligibleLunchCount),
        restAssignments,
        restExcludedRamals,
        restChoiceCapacities,
        lunchQueue,
        restQueue,
        stage: session.stage === "awaiting_confirmation"
            ? "awaiting_confirmation"
            : !session.recipRamal
                ? "awaiting_recip"
                : !session.mrvLunch1230Ramal && session.mrvRamals.length > 0
                    ? "awaiting_mrv_lunch"
                    : lunchQueue.length > 0
                        ? "awaiting_lunch_choice"
                        : restQueue.length > 0
                            ? "awaiting_rest_choice"
                            : "completed",
    } satisfies MealBreakSession;
}

function syncNightSessionState(session: MealBreakSession) {
    const dinnerDurationAssignments = { ...session.dinnerDurationAssignments };
    for (const doctor of session.roster) {
        if (!dinnerDurationAssignments[doctor.ramal]) {
            dinnerDurationAssignments[doctor.ramal] = resolveNightDinnerDuration(doctor);
        }
    }

    const nightWorkAssignments = { ...session.nightWorkAssignments };
    separateSharedPositionConflicts(session, nightWorkAssignments, NIGHT_WORK_SLOTS);

    const dinnerAssignments = { ...session.dinnerAssignments };
    for (const [ramal, slot] of Object.entries(nightWorkAssignments)) {
        if (slot === "03:00" && !dinnerAssignments[ramal]) {
            dinnerAssignments[ramal] = resolveDefaultNightDinnerSlot(dinnerDurationAssignments[ramal] ?? "half_hour");
        }
    }

    separateSharedPositionConflicts(session, dinnerAssignments, DINNER_SLOTS);

    const nightWorkQueue = session.roster
        .map((doctor) => doctor.ramal)
        .filter((ramal) => !nightWorkAssignments[ramal])
        .sort((left, right) => compareNightQueue(session, left, right));

    const work2300 = session.roster
        .map((doctor) => doctor.ramal)
        .filter((ramal) => nightWorkAssignments[ramal] === "23:00");
    const dinnerQueue = work2300
        .filter((ramal) => !dinnerAssignments[ramal])
        .sort((left, right) => compareNightQueue(session, left, right));

    return {
        ...session,
        dinnerDurationAssignments,
        nightWorkAssignments,
        dinnerAssignments,
        nightWorkCapacities: resolveNightWorkCapacities(session.roster.length),
        dinnerChoiceCapacities: resolveDinnerChoiceCapacities(work2300.length),
        nightWorkQueue,
        dinnerQueue,
        stage: session.stage === "awaiting_confirmation"
            ? "awaiting_confirmation"
            : nightWorkQueue.length > 0 ? "awaiting_night_work_choice" : dinnerQueue.length > 0 ? "awaiting_dinner_choice" : "completed",
    } satisfies MealBreakSession;
}

function stripMealBreakRosterDoctor(doctor: MealBreakRosterDoctor): MealBreakDoctor {
    const { occupancyId: _occupancyId, ...mealBreakDoctor } = doctor;
    return mealBreakDoctor;
}

function buildMealBreakRosterEntries(
    board: OperationalBoard,
    referenceAt: Date,
    mode = resolveMealBreakModeFromReference(referenceAt),
) {
    const operationalDate = formatOperationalDate(referenceAt);
    const shiftWindow = resolveOperationalShiftWindow(referenceAt);
    if (mode === "day" && shiftWindow.shiftLabel !== "SD") {
        throw new Error("Fluxo de almoco vale apenas no plantao diurno.");
    }

    if (mode === "night" && shiftWindow.shiftLabel !== "SN") {
        throw new Error("Fluxo de jantar vale apenas no plantao noturno.");
    }

    const regulation = board.regulation
        .map((row) => mapRegulationDoctor(row, mode, referenceAt))
        .filter((doctor): doctor is MealBreakRosterDoctor => Boolean(doctor));
    const consistencyIssues = buildMealBreakConsistencyIssues({
        regulation,
        mode,
    });
    const merged = [...regulation]
        .sort((left, right) => compareMealBreakDoctorsByReference(referenceAt, left, right));
    const deduped = dedupeMealBreakRoster({
        roster: merged,
        issues: consistencyIssues,
    });

    const chiefCandidates = deduped.roster.filter((doctor) => doctor.ramal === CHIEF_RAMAL || isMealBreakDiscretionaryRole(doctor.roleLabel));
    const chief = chiefCandidates[0] ?? null;
    const chiefRamals = new Set(chiefCandidates.map((doctor) => doctor.ramal));
    const rosterEntries = deduped.roster.filter((doctor) => !chiefRamals.has(doctor.ramal));
    const mrvRamals = rosterEntries
        .filter((doctor) => doctor.roleLabel === "MRV")
        .map((doctor) => doctor.ramal);

    return {
        rosterEntries,
        chiefRamal: chief?.ramal ?? null,
        mrvRamals,
        warnings: deduped.warnings,
    };
}

export function applyMealBreakContinuityStarts(params: {
    roster: MealBreakDoctor[];
    continuityStartedAtByRamal: Record<string, string>;
    referenceAt: Date;
}) {
    return [...params.roster]
        .map((doctor) => {
            const continuityStartedAt = params.continuityStartedAtByRamal[doctor.ramal] ?? null;
            if (!continuityStartedAt) {
                return doctor;
            }

            return new Date(continuityStartedAt).getTime() < new Date(doctor.startedAt).getTime()
                ? {
                    ...doctor,
                    startedAt: continuityStartedAt,
                }
                : doctor;
        })
        .sort((left, right) => compareMealBreakDoctorsByReference(params.referenceAt, left, right));
}

function resolveMealBreakOccupancyEndedAt(occupancy: MealBreakContinuityOccupancy) {
    return occupancy.actualEndedAt ?? occupancy.endedAt;
}

function resolveMealBreakContinuityGroupStartedAt(target: MealBreakContinuityOccupancy, occupancies: MealBreakContinuityOccupancy[]) {
    if (!target.continuityGroupId) {
        return new Date(target.startedAt).getTime();
    }

    return occupancies
        .filter((occupancy) => occupancy.doctorId === target.doctorId && occupancy.continuityGroupId === target.continuityGroupId)
        .reduce((earliest, occupancy) => Math.min(earliest, new Date(occupancy.startedAt).getTime()), new Date(target.startedAt).getTime());
}

export function resolveMealBreakContinuityStartedAt(params: {
    currentOccupancyId: string;
    occupancies: MealBreakContinuityOccupancy[];
}) {
    const current = params.occupancies.find((occupancy) => occupancy.occupancyId === params.currentOccupancyId) ?? null;
    if (!current) {
        return null;
    }

    const doctorOccupancies = params.occupancies
        .filter((occupancy) => occupancy.doctorId === current.doctorId)
        .sort((left, right) => new Date(left.startedAt).getTime() - new Date(right.startedAt).getTime());

    let anchorStartedAtMs = resolveMealBreakContinuityGroupStartedAt(current, doctorOccupancies);

    while (true) {
        const previous = doctorOccupancies
            .filter((occupancy) => occupancy.occupancyId !== current.occupancyId)
            .filter((occupancy) => {
                const endedAt = resolveMealBreakOccupancyEndedAt(occupancy);
                if (!endedAt) {
                    return false;
                }

                const endedAtMs = new Date(endedAt).getTime();
                return endedAtMs <= anchorStartedAtMs && anchorStartedAtMs - endedAtMs <= MEAL_BREAK_CONTINUITY_GAP_MS;
            })
            .sort((left, right) => {
                const leftEndedAtMs = new Date(resolveMealBreakOccupancyEndedAt(left) ?? left.startedAt).getTime();
                const rightEndedAtMs = new Date(resolveMealBreakOccupancyEndedAt(right) ?? right.startedAt).getTime();
                if (rightEndedAtMs !== leftEndedAtMs) {
                    return rightEndedAtMs - leftEndedAtMs;
                }

                return new Date(right.startedAt).getTime() - new Date(left.startedAt).getTime();
            })[0] ?? null;

        if (!previous) {
            break;
        }

        const previousStartedAtMs = resolveMealBreakContinuityGroupStartedAt(previous, doctorOccupancies);
        if (previousStartedAtMs >= anchorStartedAtMs) {
            break;
        }

        anchorStartedAtMs = previousStartedAtMs;
    }

    return new Date(anchorStartedAtMs).toISOString();
}

async function resolveMealBreakContinuityStartedAtByRamal(doctors: MealBreakRosterDoctor[], referenceAt: Date) {
    const doctorIds = [...new Set(doctors.map((doctor) => doctor.doctorId).filter(Boolean))];
    const occupancyIds = new Set(doctors.map((doctor) => doctor.occupancyId).filter((value): value is string => Boolean(value)));
    if (!hasDatabaseUrl() || doctorIds.length === 0 || occupancyIds.size === 0) {
        return {} satisfies Record<string, string>;
    }

    const db = getDb();
    const lookbackStartedAt = new Date(referenceAt.getTime() - MEAL_BREAK_CONTINUITY_LOOKBACK_MS);
    const [regulation, intervention] = await Promise.all([
        db.query.regulationOccupancies.findMany({
            where: and(
                inArray(regulationOccupancies.doctorId, doctorIds),
                gte(regulationOccupancies.startedAt, lookbackStartedAt),
                lte(regulationOccupancies.startedAt, referenceAt),
            ),
            columns: {
                id: true,
                doctorId: true,
                continuityGroupId: true,
                startedAt: true,
                endedAt: true,
                actualEndedAt: true,
            },
        }),
        db.query.interventionOccupancies.findMany({
            where: and(
                inArray(interventionOccupancies.doctorId, doctorIds),
                gte(interventionOccupancies.startedAt, lookbackStartedAt),
                lte(interventionOccupancies.startedAt, referenceAt),
            ),
            columns: {
                id: true,
                doctorId: true,
                continuityGroupId: true,
                startedAt: true,
                endedAt: true,
                actualEndedAt: true,
            },
        }),
    ]);

    const occupancies = [
        ...regulation,
        ...intervention,
    ].map((occupancy) => ({
        occupancyId: occupancy.id,
        doctorId: occupancy.doctorId,
        continuityGroupId: occupancy.continuityGroupId,
        startedAt: occupancy.startedAt.toISOString(),
        endedAt: occupancy.endedAt?.toISOString() ?? null,
        actualEndedAt: occupancy.actualEndedAt?.toISOString() ?? null,
    })) satisfies MealBreakContinuityOccupancy[];

    const continuityStartedAtByRamal: Record<string, string> = {};
    for (const doctor of doctors) {
        if (!doctor.occupancyId || !occupancyIds.has(doctor.occupancyId)) {
            continue;
        }

        const continuityStartedAt = resolveMealBreakContinuityStartedAt({
            currentOccupancyId: doctor.occupancyId,
            occupancies,
        });
        if (!continuityStartedAt) {
            continue;
        }

        if (new Date(continuityStartedAt).getTime() < new Date(doctor.startedAt).getTime()) {
            continuityStartedAtByRamal[doctor.ramal] = continuityStartedAt;
        }
    }

    return continuityStartedAtByRamal;
}

export function buildMealBreakRoster(board: OperationalBoard, referenceAt: Date, mode = resolveMealBreakModeFromReference(referenceAt)): MealBreakRosterResult {
    const built = buildMealBreakRosterEntries(board, referenceAt, mode);
    return {
        roster: applyMealBreakContinuityStarts({
            roster: built.rosterEntries.map(stripMealBreakRosterDoctor),
            continuityStartedAtByRamal: {},
            referenceAt,
        }),
        chiefRamal: built.chiefRamal,
        mrvRamals: built.mrvRamals,
    };
}

export async function buildMealBreakRosterWithContinuity(board: OperationalBoard, referenceAt: Date, mode = resolveMealBreakModeFromReference(referenceAt)): Promise<MealBreakRosterResult> {
    const built = buildMealBreakRosterEntries(board, referenceAt, mode);
    const continuityStartedAtByRamal = await resolveMealBreakContinuityStartedAtByRamal(built.rosterEntries, referenceAt);

    return {
        roster: applyMealBreakContinuityStarts({
            roster: built.rosterEntries.map(stripMealBreakRosterDoctor),
            continuityStartedAtByRamal,
            referenceAt,
        }),
        chiefRamal: built.chiefRamal,
        mrvRamals: built.mrvRamals,
    };
}

async function loadMealBreakPriorityOverrides(operationalDate: string, mode: MealBreakMode) {
    if (!hasDatabaseUrl()) {
        return null;
    }

    const row = await getDb().query.telegramBotNotices.findFirst({
        where: eq(telegramBotNotices.noticeKey, resolvePriorityNoticeKey(operationalDate, mode)),
    });

    if (!row || !isMealBreakPriorityOverrideRecord(row.payload)) {
        return null;
    }

    return row.payload.operationalDate === operationalDate && row.payload.mode === mode
        ? row.payload
        : null;
}

async function loadMealBreakEligibilityOverrides(operationalDate: string, mode: MealBreakMode) {
    if (!hasDatabaseUrl()) {
        return null;
    }

    const row = await getDb().query.telegramBotNotices.findFirst({
        where: eq(telegramBotNotices.noticeKey, resolveEligibilityNoticeKey(operationalDate, mode)),
    });

    if (!row || !isMealBreakEligibilityOverrideRecord(row.payload)) {
        return null;
    }

    return row.payload.operationalDate === operationalDate && row.payload.mode === mode
        ? row.payload
        : null;
}

async function saveMealBreakPriorityOverrides(overrides: MealBreakPriorityOverrideRecord) {
    await getDb().insert(telegramBotNotices)
        .values({
            noticeKey: resolvePriorityNoticeKey(overrides.operationalDate, overrides.mode),
            chatId: PRIORITY_NOTICE_CHAT_ID,
            stage: PRIORITY_NOTICE_STAGE,
            payload: overrides,
        })
        .onConflictDoUpdate({
            target: telegramBotNotices.noticeKey,
            set: {
                stage: PRIORITY_NOTICE_STAGE,
                payload: overrides,
            },
        });
}

async function saveMealBreakEligibilityOverrides(overrides: MealBreakEligibilityOverrideRecord) {
    await getDb().insert(telegramBotNotices)
        .values({
            noticeKey: resolveEligibilityNoticeKey(overrides.operationalDate, overrides.mode),
            chatId: PRIORITY_NOTICE_CHAT_ID,
            stage: ELIGIBILITY_NOTICE_STAGE,
            payload: overrides,
        })
        .onConflictDoUpdate({
            target: telegramBotNotices.noticeKey,
            set: {
                stage: ELIGIBILITY_NOTICE_STAGE,
                payload: overrides,
            },
        });
}

function buildMealBreakPriorityEntries(params: {
    doctors: MealBreakDoctor[];
    referenceAt: Date;
}) {
    const thresholdAtMs = resolveMealBreakLateThresholdAt(params.referenceAt);
    const roster = [...params.doctors]
        .sort((left, right) => compareMealBreakDoctorsByThreshold(thresholdAtMs, left, right));

    return roster.map((doctor, index) => {
        const priorityStartedAt = new Date(resolveMealBreakPriorityStartedAt(doctor, thresholdAtMs)).toISOString();
        const automaticReasons = buildAutomaticPriorityReasons({
            doctor,
            actualStartedAt: doctor.startedAt,
            continuityStartedAt: null,
            priorityStartedAt,
        });

        return {
            rank: index + 1,
            automaticRank: index + 1,
            doctor,
            actualStartedAt: doctor.startedAt,
            continuityStartedAt: null,
            priorityStartedAt,
            automaticReasons,
            manualJustification: null,
        } satisfies MealBreakPriorityContextEntry;
    });
}

function applyMealBreakPriorityOverrides(params: {
    entries: MealBreakPriorityContextEntry[];
    overrides: MealBreakPriorityOverrideRecord | null;
}) {
    const orderIndex = new Map((params.overrides?.orderedRamals ?? []).map((ramal, index) => [ramal, index]));
    const automaticIndex = new Map(params.entries.map((entry, index) => [entry.doctor.ramal, index]));

    return [...params.entries]
        .sort((left, right) => {
            const leftOverrideIndex = orderIndex.get(left.doctor.ramal);
            const rightOverrideIndex = orderIndex.get(right.doctor.ramal);
            if (leftOverrideIndex !== undefined || rightOverrideIndex !== undefined) {
                if (leftOverrideIndex === undefined) {
                    return 1;
                }
                if (rightOverrideIndex === undefined) {
                    return -1;
                }
                if (leftOverrideIndex !== rightOverrideIndex) {
                    return leftOverrideIndex - rightOverrideIndex;
                }
            }

            return (automaticIndex.get(left.doctor.ramal) ?? 0) - (automaticIndex.get(right.doctor.ramal) ?? 0);
        })
        .map((entry, index) => ({
            ...entry,
            rank: index + 1,
            manualJustification: params.overrides?.justifications[entry.doctor.ramal] ?? null,
        } satisfies MealBreakPriorityContextEntry));
}

function serializeMealBreakPriorityView(params: {
    mode: MealBreakMode;
    operationalDate: string;
    updatedAt: string;
    chiefRamal: string | null;
    mrvRamals: string[];
    warnings: MealBreakConsistencyIssue[];
    entries: MealBreakPriorityContextEntry[];
}) {
    return {
        mode: params.mode,
        operationalDate: params.operationalDate,
        updatedAt: params.updatedAt,
        chiefRamal: params.chiefRamal,
        mrvRamals: params.mrvRamals,
        warnings: params.warnings,
        entries: params.entries.map((entry) => ({
            rank: entry.rank,
            automaticRank: entry.automaticRank,
            ramal: entry.doctor.ramal,
            name: entry.doctor.name,
            roleLabel: entry.doctor.roleLabel,
            shiftLabel: entry.doctor.shiftLabel,
            actualStartedAt: entry.actualStartedAt,
            continuityStartedAt: entry.continuityStartedAt,
            priorityStartedAt: entry.priorityStartedAt,
            automaticReasons: entry.automaticReasons,
            manualJustification: entry.manualJustification,
            explanation: buildPriorityEntryExplanation(entry),
        } satisfies MealBreakPriorityEntry)),
    } satisfies MealBreakPriorityView;
}

async function buildMealBreakPriorityContext(params: {
    referenceAt: Date;
    mode?: MealBreakMode;
    board?: OperationalBoard;
}) {
    const mode = params.mode ?? resolveMealBreakModeFromReference(params.referenceAt);
    const operationalDate = formatOperationalDate(params.referenceAt);
    const board = params.board ?? await getOperationalBoard();
    const built = buildMealBreakRosterEntries(board, params.referenceAt, mode);
    const overrides = await loadMealBreakPriorityOverrides(operationalDate, mode);
    const eligibilityOverrides = await loadMealBreakEligibilityOverrides(operationalDate, mode);
    const lunchExcluded = new Set(eligibilityOverrides?.lunchExcludedRamals ?? []);
    const restExcluded = new Set(eligibilityOverrides?.restExcludedRamals ?? []);
    const automaticEntries = buildMealBreakPriorityEntries({
        doctors: built.rosterEntries
            .map(stripMealBreakRosterDoctor)
            .filter((doctor) => !(mode === "day" && isMealBreakIsolatedRole(doctor.roleLabel)))
            .filter((doctor) => mode !== "day" || !lunchExcluded.has(doctor.ramal) || !restExcluded.has(doctor.ramal)),
        referenceAt: params.referenceAt,
    });
    const entries = applyMealBreakPriorityOverrides({
        entries: automaticEntries,
        overrides,
    });

    return {
        mode,
        operationalDate,
        chiefRamal: built.chiefRamal,
        mrvRamals: built.mrvRamals,
        warnings: built.warnings,
        updatedAt: overrides?.updatedAt ?? params.referenceAt.toISOString(),
        entries,
    };
}

export async function getCurrentMealBreakPriorityView(params?: {
    referenceAt?: Date;
    mode?: MealBreakMode;
    board?: OperationalBoard;
}) {
    const referenceAt = params?.referenceAt ?? new Date();
    const context = await buildMealBreakPriorityContext({
        referenceAt,
        mode: params?.mode,
        board: params?.board,
    });

    return serializeMealBreakPriorityView(context);
}

export async function updateMealBreakPriorityOrder(params: {
    ramal: string;
    targetIndex: number;
    notes: string;
    referenceAt: Date;
    actorUserId: string | null;
    mode?: MealBreakMode;
    board?: OperationalBoard;
}) {
    const notes = params.notes.trim();
    if (!notes) {
        throw new Error("A justificativa do ajuste de prioridade e obrigatoria.");
    }

    const context = await buildMealBreakPriorityContext({
        referenceAt: params.referenceAt,
        mode: params.mode,
        board: params.board,
    });
    const currentIndex = context.entries.findIndex((entry) => entry.doctor.ramal === normalizeRamal(params.ramal));
    if (currentIndex < 0) {
        throw new Error("Nao encontrei esse ramal na fila atual de prioridade.");
    }

    if (!Number.isInteger(params.targetIndex) || params.targetIndex < 0 || params.targetIndex >= context.entries.length) {
        throw new Error("Posicao de prioridade invalida para a fila atual.");
    }

    const orderedRamals = context.entries.map((entry) => entry.doctor.ramal);
    const [moved] = orderedRamals.splice(currentIndex, 1);
    orderedRamals.splice(params.targetIndex, 0, moved ?? normalizeRamal(params.ramal));

    const referenceIso = params.referenceAt.toISOString();
    const previous = await loadMealBreakPriorityOverrides(context.operationalDate, context.mode);
    const overrides: MealBreakPriorityOverrideRecord = {
        kind: PRIORITY_KIND,
        version: 1,
        mode: context.mode,
        operationalDate: context.operationalDate,
        orderedRamals,
        justifications: {
            ...(previous?.justifications ?? {}),
            [normalizeRamal(params.ramal)]: {
                notes,
                actorUserId: params.actorUserId,
                updatedAt: referenceIso,
            },
        },
        updatedAt: referenceIso,
    };

    await saveMealBreakPriorityOverrides(overrides);

    return serializeMealBreakPriorityView({
        ...context,
        updatedAt: referenceIso,
        entries: applyMealBreakPriorityOverrides({
            entries: context.entries.map((entry) => ({
                ...entry,
                manualJustification: overrides.justifications[entry.doctor.ramal] ?? null,
            })),
            overrides,
        }),
    });
}

export function createMealBreakSession(params: {
    roster: MealBreakDoctor[];
    chiefRamal: string | null;
    mrvRamals: string[];
    referenceAt: Date;
    mode?: MealBreakMode;
    trigger: "manual" | "automatic";
    restarted: boolean;
    actorTelegramId: string | null;
    lunchExcludedRamals?: string[];
    restExcludedRamals?: string[];
}) {
    const recordedAt = params.referenceAt.toISOString();
    const mode = params.mode ?? resolveMealBreakModeFromReference(params.referenceAt);
    const sortedRoster = sanitizeMealBreakRosterForMode(params.roster, mode);
    const rosterRamals = new Set(sortedRoster.map((doctor) => doctor.ramal));
    const dinnerDurationAssignments = Object.fromEntries(
        sortedRoster.map((doctor) => [doctor.ramal, resolveNightDinnerDuration(doctor)]),
    ) as Record<string, MealBreakDinnerDuration>;

    const normalizedMrvRamals = params.mrvRamals.map(normalizeRamal).filter((ramal) => rosterRamals.has(ramal));
    const lunchExcludedRamals = params.lunchExcludedRamals ?? [];
    const restExcludedRamals = params.restExcludedRamals ?? [];

    const presetRecipRamal = mode === "day"
        ? (sortedRoster.find((doctor) =>
            doctor.roleLabel === "RECIP"
            && doctor.ramal !== params.chiefRamal
            && !normalizedMrvRamals.includes(doctor.ramal),
        )?.ramal ?? null)
        : null;

    const lunchAssignments: Record<string, MealBreakLunchSlot> = {};
    const restAssignments: Record<string, MealBreakRestSlot> = {};
    if (presetRecipRamal) {
        if (!lunchExcludedRamals.includes(presetRecipRamal)) {
            lunchAssignments[presetRecipRamal] = "11:30";
        }
        if (!restExcludedRamals.includes(presetRecipRamal)) {
            restAssignments[presetRecipRamal] = "18:00";
        }
    }

    const session = {
        kind: SESSION_KIND,
        version: 1,
        mode,
        operationalDate: formatOperationalDate(params.referenceAt),
        stage: "awaiting_confirmation",
        trigger: params.trigger,
        roster: sortedRoster,
        chiefRamal: params.chiefRamal,
        recipRamal: presetRecipRamal,
        mrvRamals: normalizedMrvRamals,
        mrvLunch1230Ramal: null,
        lunchCapacities: mode === "day" ? resolveThreeSlotCapacities(sortedRoster.length) : { "11:30": 0, "12:30": 0, "13:30": 0 },
        lunchAssignments,
        lunchExcludedRamals,
        restAssignments,
        restExcludedRamals,
        restChoiceCapacities: mode === "day" ? { "15:30": 0, "16:30": 0 } : { "15:30": 0, "16:30": 0 },
        lunchQueue: [],
        restQueue: [],
        nightWorkCapacities: mode === "night" ? resolveNightWorkCapacities(sortedRoster.length) : { "23:00": 0, "03:00": 0 },
        nightWorkAssignments: {},
        dinnerAssignments: {},
        dinnerDurationAssignments,
        dinnerChoiceCapacities: { "20:30": 0, "21:00": 0, "21:30": 0 },
        nightWorkQueue: mode === "night" ? sortedRoster.map((doctor) => doctor.ramal) : [],
        dinnerQueue: [],
        undoSnapshots: [],
        createdAt: recordedAt,
        updatedAt: recordedAt,
        events: [
            {
                type: params.restarted ? "session_restarted" : "session_started",
                actorTelegramId: params.actorTelegramId,
                recordedAt,
            },
            ...(presetRecipRamal ? [{
                type: "recip_selected" as const,
                actorTelegramId: null as string | null,
                ramal: presetRecipRamal,
                slot: "11:30" as MealBreakLunchSlot,
                recordedAt,
            }] : []),
        ],
    } satisfies MealBreakSession;

    return mode === "night" ? syncNightSessionState(session) : syncDaySessionState(session);
}

function withEvent(session: MealBreakSession, event: Omit<MealBreakSessionEvent, "recordedAt">, referenceAt: Date) {
    return {
        ...session,
        updatedAt: referenceAt.toISOString(),
        events: [...session.events, {
            ...event,
            recordedAt: referenceAt.toISOString(),
        }],
    } satisfies MealBreakSession;
}

function captureUndoSnapshot(session: MealBreakSession, label: string): MealBreakUndoSnapshot {
    return {
        stage: session.stage,
        recipRamal: session.recipRamal,
        mrvLunch1230Ramal: session.mrvLunch1230Ramal,
        lunchAssignments: { ...session.lunchAssignments },
        restAssignments: { ...session.restAssignments },
        nightWorkAssignments: { ...session.nightWorkAssignments },
        dinnerAssignments: { ...session.dinnerAssignments },
        label,
    };
}

function withUndoSnapshot(session: MealBreakSession, label: string): MealBreakSession {
    return {
        ...session,
        undoSnapshots: [...session.undoSnapshots, captureUndoSnapshot(session, label)],
    };
}

function applyUndoSnapshot(session: MealBreakSession, snapshot: MealBreakUndoSnapshot, referenceAt: Date, actorTelegramId: string | null): MealBreakSession {
    const restored: MealBreakSession = {
        ...session,
        recipRamal: snapshot.recipRamal,
        mrvLunch1230Ramal: snapshot.mrvLunch1230Ramal,
        lunchAssignments: { ...snapshot.lunchAssignments },
        restAssignments: { ...snapshot.restAssignments },
        nightWorkAssignments: { ...snapshot.nightWorkAssignments },
        dinnerAssignments: { ...snapshot.dinnerAssignments },
        undoSnapshots: session.undoSnapshots.slice(0, -1),
        updatedAt: referenceAt.toISOString(),
    };

    const synced = session.mode === "night"
        ? syncNightSessionState(restored)
        : syncDaySessionState(restored);

    return withEvent(synced, {
        type: "undo_applied",
        actorTelegramId,
    }, referenceAt);
}

function resolveRemainingLunchSlots(session: MealBreakSession) {
    const ignoredRamals = new Set([
        ...resolveDayMealBreakIsolatedRamals(session),
        ...resolveDayMealBreakDiscretionaryRamals(session),
        ...session.lunchExcludedRamals,
    ]);
    const counts = {
        "11:30": 0,
        "12:30": 0,
        "13:30": 0,
    } satisfies Record<MealBreakLunchSlot, number>;

    for (const [ramal, slot] of Object.entries(session.lunchAssignments)) {
        if (ignoredRamals.has(ramal)) {
            continue;
        }
        counts[slot] += 1;
    }

    return {
        "11:30": Math.max(0, session.lunchCapacities["11:30"] - counts["11:30"]),
        "12:30": Math.max(0, session.lunchCapacities["12:30"] - counts["12:30"]),
        "13:30": Math.max(0, session.lunchCapacities["13:30"] - counts["13:30"]),
    } satisfies Record<MealBreakLunchSlot, number>;
}

function resolveRemainingRestChoiceSlots(session: MealBreakSession) {
    let assigned1530 = 0;
    let assigned1630 = 0;

    for (const slot of Object.values(session.restAssignments)) {
        if (slot === "15:30") {
            assigned1530 += 1;
        }
        if (slot === "16:30") {
            assigned1630 += 1;
        }
    }

    return {
        "15:30": Math.max(0, session.restChoiceCapacities["15:30"] - assigned1530),
        "16:30": Math.max(0, session.restChoiceCapacities["16:30"] - assigned1630),
    } satisfies Record<"15:30" | "16:30", number>;
}

const UNDO_TEXT = "↩️ Desfazer";
const CONFIRM_TEXT = "✅ Confirmar";

function isRecognizedReplyCandidate(session: MealBreakSession, text: string) {
    return shouldPreferMealBreakReplyForSession(session, text);
}

function extractTargetCode(text: string) {
    const match = text.toUpperCase().match(/\b(?:\d{4}|[A-Z]{2,3}\d{2})\b/);
    return match ? normalizeRamal(match[0]) : null;
}

function extractSlotStart(text: string): string | null {
    const normalized = text.trim().replace(/H/gi, ":");
    const match = normalized.match(/\b((?:1[1-8]|20|21|22):(?:00|30)|23:00|03:00)\b/);
    if (!match) {
        return null;
    }

    return match[1] ?? null;
}

function parseSingleRamalReply(text: string) {
    const trimmed = text.trim();
    const tokens = trimmed.split(/\s+/).filter(Boolean);
    const ramal = extractTargetCode(trimmed);
    return {
        ramal,
        valid: Boolean(ramal) && tokens.length === 1,
    };
}

function resolveSingleChoiceRamal(
    session: MealBreakSession,
    text: string,
    allowedRamals?: readonly string[],
): { ramal: string; ambiguous: false } | { ramal: null; ambiguous: false } | { ramal: null; ambiguous: true; candidates: MealBreakDoctor[] } {
    const parsed = parseSingleRamalReply(text);
    const allowedSet = allowedRamals ? new Set(allowedRamals.map(normalizeRamal)) : null;
    if (parsed.ramal && parsed.valid) {
        if (!allowedSet || allowedSet.has(parsed.ramal)) {
            return { ramal: parsed.ramal, ambiguous: false };
        }

        return { ramal: null, ambiguous: false };
    }

    if (extractTargetCode(text) || extractSlotStart(text)) {
        return { ramal: null, ambiguous: false };
    }

    return resolveRamalByName(session, text.trim(), allowedRamals);
}

function parseChoiceReply(text: string) {
    return {
        ramal: extractTargetCode(text),
        slot: extractSlotStart(text),
    };
}

function parseStrictChoiceReply(text: string) {
    const tokens = text.trim().split(/\s+/).filter(Boolean);
    if (tokens.length !== 2) {
        return {
            ramal: null,
            slot: null,
            valid: false,
        };
    }

    const ramal = extractTargetCode(tokens[0] ?? "");
    const slot = extractSlotStart(tokens[1] ?? "");
    return {
        ramal,
        slot,
        valid: Boolean(ramal && slot),
    };
}

function isSessionQueueChoice(params: {
    session: MealBreakSession;
    ramal: string;
    slot: string;
}) {
    const { session, ramal, slot } = params;

    if (!findDoctor(session, ramal)) {
        return false;
    }

    if (session.stage === "awaiting_lunch_choice") {
        const currentRamal = session.lunchQueue[0] ?? null;
        return currentRamal === ramal && LUNCH_SLOTS.includes(slot as MealBreakLunchSlot);
    }

    if (session.stage === "awaiting_rest_choice") {
        const currentRamal = session.restQueue[0] ?? null;
        return currentRamal === ramal && (slot === "15:30" || slot === "16:30");
    }

    if (session.stage === "awaiting_night_work_choice") {
        const currentRamal = session.nightWorkQueue[0] ?? null;
        return currentRamal === ramal && NIGHT_WORK_SLOTS.includes(slot as MealBreakNightWorkSlot);
    }

    if (session.stage === "awaiting_dinner_choice") {
        const currentRamal = session.dinnerQueue[0] ?? null;
        return currentRamal === ramal && DINNER_CHOICE_SLOTS.includes(slot as (typeof DINNER_CHOICE_SLOTS)[number]);
    }

    return false;
}

const MEAL_BREAK_AMBIGUOUS_ARRIVAL_CUES = /\b(?:CHEGUEI|CHEGANDO|CHEGADA|PRESENTE|ASSUMI|ASSUMINDO|SD|SN|\bP\b)\b/i;
const MEAL_BREAK_AMBIGUOUS_DEPARTURE_CUES = /\b(?:SAIDA|SAÍDA|SAINDO|SAIU|ENCERREI|FINALIZEI|LIBERADO|LIBERADA)\b/i;

function resolveArrivalLunchAmbiguity(params: {
    session: MealBreakSession;
    text: string;
    ramal: string;
    slot: string;
}) {
    const { session, text, ramal, slot } = params;

    // Safety rule: only treat as meal-break when it matches the active queue item.
    // This preserves normal arrival behavior for any other target.
    if (!isSessionQueueChoice({ session, ramal, slot })) {
        return false;
    }

    // Conservative bias: explicit operational cues win over meal-break ambiguity.
    // If the message contains clear arrival/departure intent, do NOT hijack it.
    if (MEAL_BREAK_AMBIGUOUS_ARRIVAL_CUES.test(text) || MEAL_BREAK_AMBIGUOUS_DEPARTURE_CUES.test(text)) {
        return false;
    }

    return true;
}

export function shouldPreferMealBreakReplyForSession(session: MealBreakSession, text: string) {
    if (text.trim().startsWith("/")) {
        return false;
    }

    const normalized = normalizeFreeText(text);
    if (normalized === normalizeFreeText(UNDO_TEXT)) {
        return session.undoSnapshots.length > 0;
    }

    if (session.stage === "awaiting_confirmation") {
        return normalized === normalizeFreeText(CONFIRM_TEXT);
    }

    if (session.stage === "awaiting_recip") {
        const candidate = resolveSingleChoiceRamal(session, text);
        if (candidate.ambiguous || Boolean(candidate.ramal)) {
            return true;
        }
        // Fallback: if the text looks like a name attempt (no ramal code, no time slot,
        // no operational cues), intercept it so the stage handler can show
        // "Nao reconheci" instead of falling through to arrival parsing.
        const trimmed = text.trim();
        return (
            trimmed.length >= 3 &&
            !extractTargetCode(trimmed) &&
            !extractSlotStart(trimmed) &&
            !MEAL_BREAK_AMBIGUOUS_ARRIVAL_CUES.test(trimmed) &&
            !MEAL_BREAK_AMBIGUOUS_DEPARTURE_CUES.test(trimmed)
        );
    }

    if (session.stage === "awaiting_mrv_lunch") {
        const candidate = resolveSingleChoiceRamal(session, text, session.mrvRamals);
        if (candidate.ambiguous || Boolean(candidate.ramal)) {
            return true;
        }
        // Same fallback as awaiting_recip — name not matched but looks like a name attempt.
        const trimmed = text.trim();
        return (
            trimmed.length >= 3 &&
            !extractTargetCode(trimmed) &&
            !extractSlotStart(trimmed) &&
            !MEAL_BREAK_AMBIGUOUS_ARRIVAL_CUES.test(trimmed) &&
            !MEAL_BREAK_AMBIGUOUS_DEPARTURE_CUES.test(trimmed)
        );
    }

    const strictChoice = parseStrictChoiceReply(text);
    if (strictChoice.valid && strictChoice.ramal && strictChoice.slot) {
        return resolveArrivalLunchAmbiguity({
            session,
            text,
            ramal: strictChoice.ramal,
            slot: strictChoice.slot,
        });
    }

    // During an active meal-break queue, messages often come as
    // "RAMAL Nome Sobrenome HH:MM". If ramal+slot match the CURRENT queue item,
    // prefer meal-break flow to avoid overriding an already valid arrival record.
    const looseChoice = parseChoiceReply(text);
    if (looseChoice.ramal && looseChoice.slot) {
        return resolveArrivalLunchAmbiguity({
            session,
            text,
            ramal: looseChoice.ramal,
            slot: looseChoice.slot,
        });
    }

    return false;
}

function finalizeLunchSetup(session: MealBreakSession, referenceAt: Date, actorTelegramId: string | null) {
    const isolatedSet = new Set(resolveDayMealBreakIsolatedRamals(session));
    const discretionarySet = new Set(resolveDayMealBreakDiscretionaryRamals(session));
    const remainingDoctors = session.roster
        .map((doctor) => doctor.ramal)
        .filter((ramal) => !isLunchExcluded(session, ramal) && !isolatedSet.has(ramal) && !discretionarySet.has(ramal))
        .filter((ramal) => ramal !== session.recipRamal && !session.mrvRamals.includes(ramal))
        .sort((left, right) => compareLunchQueue(session, left, right));

    const nextSession: MealBreakSession = {
        ...session,
        stage: remainingDoctors.length > 0 ? "awaiting_lunch_choice" : "awaiting_rest_choice",
        lunchQueue: remainingDoctors,
        updatedAt: referenceAt.toISOString(),
    };

    return withEvent(nextSession, {
        type: "mrv_selected",
        actorTelegramId,
        ramal: nextSession.mrvLunch1230Ramal ?? undefined,
    }, referenceAt);
}

function autoAssignRemainingLunchIfSingleOption(session: MealBreakSession, referenceAt: Date, actorTelegramId: string | null) {
    if (session.stage !== "awaiting_lunch_choice") {
        return session;
    }

    const remaining = resolveRemainingLunchSlots(session);
    const availableSlots = LUNCH_SLOTS.filter((slot) => remaining[slot] > 0);
    if (availableSlots.length !== 1) {
        return session;
    }

    const forcedSlot = availableSlots[0];
    const lunchAssignments = { ...session.lunchAssignments };
    let nextSession = session;

    for (const ramal of session.lunchQueue) {
        const peerConflicts = resolveSharedPositionPeerSlots(nextSession, ramal, lunchAssignments);
        let effectiveSlot = forcedSlot;
        if (peerConflicts.has(forcedSlot)) {
            const alt = LUNCH_SLOTS.find((s) => s !== forcedSlot && !peerConflicts.has(s));
            if (alt) {
                effectiveSlot = alt;
            }
        }
        lunchAssignments[ramal] = effectiveSlot;
        nextSession = withEvent({ ...nextSession }, {
            type: "lunch_selected",
            actorTelegramId,
            ramal,
            slot: effectiveSlot,
        }, referenceAt);
    }

    return {
        ...nextSession,
        lunchAssignments,
        lunchQueue: [],
        updatedAt: referenceAt.toISOString(),
    };
}

function buildRestPhase(session: MealBreakSession, referenceAt: Date, actorTelegramId: string | null) {
    const isolatedSet = new Set(resolveDayMealBreakIsolatedRamals(session));
    const discretionarySet = new Set(resolveDayMealBreakDiscretionaryRamals(session));
    const updatedAssignments = { ...session.restAssignments };
    const autoAssigned14 = session.roster
        .map((doctor) => doctor.ramal)
        .filter((ramal) => !isRestExcluded(session, ramal) && !isolatedSet.has(ramal) && !discretionarySet.has(ramal))
        .filter((ramal) => session.lunchAssignments[ramal] === "13:30" && !session.mrvRamals.includes(ramal));

    const deferredFromAutoAssign14: string[] = [];
    for (const ramal of autoAssigned14) {
        const peerConflicts = resolveSharedPositionPeerSlots(session, ramal, updatedAssignments);
        if (peerConflicts.has("14:30")) {
            deferredFromAutoAssign14.push(ramal);
        } else {
            updatedAssignments[ramal] = "14:30";
        }
    }

    const pendingRest = session.roster
        .map((doctor) => doctor.ramal)
        .filter((ramal) => !isRestExcluded(session, ramal) && !isolatedSet.has(ramal) && !discretionarySet.has(ramal))
        .filter((ramal) => !updatedAssignments[ramal]);
    const restChoiceCapacities = resolveTwoSlotCapacities(pendingRest.length);

    let nextSession: MealBreakSession = {
        ...session,
        stage: pendingRest.length > 0 ? "awaiting_rest_choice" : "completed",
        restAssignments: updatedAssignments,
        restChoiceCapacities,
        restQueue: pendingRest,
        updatedAt: referenceAt.toISOString(),
    };

    nextSession = withEvent(nextSession, {
        type: "rest_auto_selected",
        actorTelegramId,
    }, referenceAt);

    return autoAssignRemainingRestIfSingleOption(nextSession, referenceAt, actorTelegramId);
}

function autoAssignRemainingRestIfSingleOption(session: MealBreakSession, referenceAt: Date, actorTelegramId: string | null) {
    if (session.stage !== "awaiting_rest_choice") {
        return session;
    }

    const remaining = resolveRemainingRestChoiceSlots(session);
    const availableSlots = (["15:30", "16:30"] as const).filter((slot) => remaining[slot] > 0);
    if (availableSlots.length !== 1) {
        return session;
    }

    const forcedSlot = availableSlots[0];
    const otherSlot = forcedSlot === "15:30" ? "16:30" as const : "15:30" as const;
    const assignments = { ...session.restAssignments };
    for (const ramal of session.restQueue) {
        const peerConflicts = resolveSharedPositionPeerSlots(session, ramal, assignments);
        assignments[ramal] = peerConflicts.has(forcedSlot) ? otherSlot : forcedSlot;
    }

    return withEvent({
        ...session,
        stage: "completed",
        restAssignments: assignments,
        restQueue: [],
        updatedAt: referenceAt.toISOString(),
    }, {
        type: "session_completed",
        actorTelegramId,
        slot: forcedSlot,
    }, referenceAt);
}

function autoAssignRemainingNightWorkIfSingleOption(session: MealBreakSession, referenceAt: Date, actorTelegramId: string | null) {
    if (session.stage !== "awaiting_night_work_choice") {
        return session;
    }

    const remaining = resolveRemainingNightWorkSlots(session);
    const availableSlots = NIGHT_WORK_SLOTS.filter((slot) => remaining[slot] > 0);
    if (availableSlots.length !== 1) {
        return session;
    }

    const forcedSlot = availableSlots[0];
    const otherSlot = forcedSlot === "23:00" ? "03:00" as const : "23:00" as const;
    const nightWorkAssignments = { ...session.nightWorkAssignments };
    for (const ramal of session.nightWorkQueue) {
        const peerConflicts = resolveSharedPositionPeerSlots(session, ramal, nightWorkAssignments);
        nightWorkAssignments[ramal] = peerConflicts.has(forcedSlot) ? otherSlot : forcedSlot;
    }

    let nextSession: MealBreakSession = {
        ...session,
        nightWorkAssignments,
        nightWorkQueue: [],
        updatedAt: referenceAt.toISOString(),
    };

    for (const ramal of session.nightWorkQueue) {
        nextSession = withEvent(nextSession, {
            type: "night_work_selected",
            actorTelegramId,
            ramal,
            slot: nightWorkAssignments[ramal],
        }, referenceAt);
    }

    return syncNightSessionState(nextSession);
}

function autoAssignRemainingDinnerIfSingleOption(session: MealBreakSession, referenceAt: Date, actorTelegramId: string | null) {
    if (session.stage !== "awaiting_dinner_choice") {
        return session;
    }

    const remaining = resolveRemainingDinnerChoiceSlots(session);
    const availableSlots = DINNER_CHOICE_SLOTS.filter((slot) => remaining[slot] > 0);
    if (availableSlots.length !== 1) {
        return session;
    }

    const forcedSlot = availableSlots[0];
    const assignments = { ...session.dinnerAssignments };
    for (const ramal of session.dinnerQueue) {
        const peerConflicts = resolveSharedPositionPeerSlots(session, ramal, assignments);
        if (peerConflicts.has(forcedSlot)) {
            const alt = DINNER_CHOICE_SLOTS.find((s) => s !== forcedSlot && !peerConflicts.has(s));
            if (alt) {
                assignments[ramal] = alt;
                continue;
            }
        }
        assignments[ramal] = forcedSlot;
    }

    return withEvent(syncNightSessionState({
        ...session,
        dinnerAssignments: assignments,
        updatedAt: referenceAt.toISOString(),
    }), {
        type: "session_completed",
        actorTelegramId,
        slot: forcedSlot,
    }, referenceAt);
}

function buildLunchClosedMessages(session: MealBreakSession) {
    return [
        "Almoco fechado.",
        buildSessionSummary(session),
    ].join("\n\n");
}

function buildNightWorkClosedMessages(session: MealBreakSession) {
    return [
        "Trabalho da noite fechado.",
        buildSessionSummary(session),
    ].join("\n\n");
}

function buildRestIntro(session: MealBreakSession) {
    const automatic1430 = Object.entries(session.restAssignments)
        .filter(([, slot]) => slot === "14:30")
        .map(([ramal]) => renderDoctorCompactSummary(session, ramal))
        .join(", ");
    const fixed1800 = Object.entries(session.restAssignments)
        .filter(([, slot]) => slot === "18:00")
        .map(([ramal]) => renderDoctorCompactSummary(
            session,
            ramal,
            session.recipRamal === ramal ? "RECIP" : session.mrvRamals.includes(ramal) ? "MRV" : undefined,
        ))
        .join(", ");

    const blocks = ["😴 Descanso:"];
    if (automatic1430) {
        blocks.push(`14:30 auto: ${automatic1430}`);
    }
    if (fixed1800) {
        blocks.push(`18:00 fixo: ${fixed1800}`);
    }

    return blocks.join("\n");
}

function buildNightDinnerIntro(session: MealBreakSession) {
    const autoLateDinner = Object.entries(session.nightWorkAssignments)
        .filter(([, slot]) => slot === "03:00")
        .map(([ramal]) => {
            const dinnerSlot = session.dinnerAssignments[ramal] ?? resolveDefaultNightDinnerSlot(session.dinnerDurationAssignments[ramal] ?? "half_hour");
            const duration = session.dinnerDurationAssignments[ramal] === "one_hour" ? "1h" : "30min";
            return `${renderDoctorCompactSummary(session, ramal)} ${dinnerSlot} (${duration})`;
        })
        .join(", ");

    const blocks = ["🍽️ Jantar:"];
    if (autoLateDinner) {
        blocks.push(`03:00 janta por ultimo: ${autoLateDinner}`);
    }
    blocks.push(`Vagas: ${buildAvailableDinnerText(session)}`);

    return blocks.join("\n");
}

function completeSession(session: MealBreakSession, referenceAt: Date, actorTelegramId: string | null) {
    if (session.stage === "completed") {
        return session;
    }

    return withEvent({
        ...session,
        stage: "completed",
        updatedAt: referenceAt.toISOString(),
    }, {
        type: "session_completed",
        actorTelegramId,
    }, referenceAt);
}

export function applyMealBreakReply(params: {
    session: MealBreakSession;
    text: string;
    senderTelegramId: string | null;
    referenceAt: Date;
}): MealBreakActionResult | null {
    const { session, text, senderTelegramId, referenceAt } = params;

    if (!isRecognizedReplyCandidate(session, text)) {
        return null;
    }

    // Handle undo across all stages
    if (normalizeFreeText(text) === normalizeFreeText(UNDO_TEXT) && session.undoSnapshots.length > 0) {
        const snapshot = session.undoSnapshots[session.undoSnapshots.length - 1];
        const restored = applyUndoSnapshot(session, snapshot, referenceAt, senderTelegramId);
        return {
            handled: true,
            session: restored,
            messages: [`↩️ Desfeito: ${snapshot.label}\n\n${buildCurrentPrompt(restored)}`],
            status: "updated",
        };
    }

    // Handle confirmation stage
    if (session.stage === "awaiting_confirmation") {
        if (normalizeFreeText(text) !== normalizeFreeText(CONFIRM_TEXT)) {
            return null;
        }

        const restartCmd = session.mode === "night" ? "/jantar reiniciar" : "/almoco reiniciar";
        const nextStage: MealBreakStage = session.mode === "night" ? "awaiting_night_work_choice" : "awaiting_recip";
        let confirmed = withEvent({
            ...session,
            stage: nextStage,
            updatedAt: referenceAt.toISOString(),
        }, {
            type: "confirmation_accepted",
            actorTelegramId: senderTelegramId,
        }, referenceAt);

        confirmed = session.mode === "night"
            ? syncNightSessionState(confirmed)
            : syncDaySessionState(confirmed);

        const startMsg = session.mode === "night"
            ? [
                `✅ Confirmado!`,
                `Reiniciar: ${restartCmd}`,
                "",
                buildNightStartPrompt(confirmed),
            ].join("\n")
            : [
                `✅ Confirmado!`,
                `Reiniciar: ${restartCmd}`,
                "",
                buildDayStartPrompt(),
            ].join("\n");

        return {
            handled: true,
            session: confirmed,
            messages: [startMsg],
            status: "updated",
        };
    }

    if (session.mode === "night") {
        const activeSession = syncNightSessionState(session);

        if (activeSession.stage === "awaiting_night_work_choice") {
            const parsed = parseChoiceReply(text);
            const currentRamal = activeSession.nightWorkQueue[0] ?? null;
            if (!parsed.ramal || !parsed.slot) {
                return {
                    handled: true,
                    session: activeSession,
                    messages: ["Formato invalido. Responda: RAMAL HORARIO."],
                    status: "invalid",
                };
            }

            if (!currentRamal || parsed.ramal !== currentRamal) {
                return {
                    handled: true,
                    session: activeSession,
                    messages: [`O chamado atual e para o ramal ${currentRamal ?? "-"}. Aguarde sua vez.`],
                    status: "invalid",
                };
            }

            if (!NIGHT_WORK_SLOTS.includes(parsed.slot as MealBreakNightWorkSlot)) {
                return {
                    handled: true,
                    session: activeSession,
                    messages: [`Horario invalido. Disponiveis agora: ${buildAvailableNightWorkText(activeSession)}.`],
                    status: "invalid",
                };
            }

            const chosenSlot = parsed.slot as MealBreakNightWorkSlot;
            const remaining = resolveRemainingNightWorkSlots(activeSession);

            const nightWorkPeerConflicts = resolveSharedPositionPeerSlots(activeSession, parsed.ramal, activeSession.nightWorkAssignments);
            if (nightWorkPeerConflicts.size > 0 && nightWorkPeerConflicts.has(chosenSlot)) {
                const otherSlot = chosenSlot === "23:00" ? "03:00" as const : "23:00" as const;
                if (remaining[otherSlot] > 0) {
                    return {
                        handled: true,
                        session: activeSession,
                        messages: [`Outro COI ja esta em ${chosenSlot}. Use ${otherSlot}.`],
                        status: "invalid",
                    };
                }
                const dinnerDuration = activeSession.dinnerDurationAssignments[parsed.ramal] ?? "half_hour";
                const sessionWithUndo = withUndoSnapshot(activeSession, `${renderDoctorCompactSummary(activeSession, parsed.ramal)} → trabalho ${otherSlot} (COI separado)`);
                let forcedSession: MealBreakSession = syncNightSessionState(withEvent({
                    ...sessionWithUndo,
                    nightWorkAssignments: { ...activeSession.nightWorkAssignments, [parsed.ramal]: otherSlot },
                    updatedAt: referenceAt.toISOString(),
                }, { type: "night_work_selected", actorTelegramId: senderTelegramId, ramal: parsed.ramal, slot: otherSlot }, referenceAt));
                forcedSession = autoAssignRemainingNightWorkIfSingleOption(forcedSession, referenceAt, senderTelegramId);
                return {
                    handled: true,
                    session: forcedSession,
                    messages: [`⚠️ COI nao pode coincidir. ${renderDoctorCompactSummary(activeSession, parsed.ramal)} foi alocado em ${otherSlot} automaticamente.`],
                    status: "updated",
                };
            }

            if (wouldCoiConflictAfterChoice(activeSession, parsed.ramal!, chosenSlot, activeSession.nightWorkAssignments, activeSession.nightWorkQueue, NIGHT_WORK_SLOTS, remaining)) {
                const otherSlot = chosenSlot === "23:00" ? "03:00" as const : "23:00" as const;
                const sessionWithUndo = withUndoSnapshot(activeSession, `${renderDoctorCompactSummary(activeSession, parsed.ramal)} → trabalho ${otherSlot} (COI reservado)`);
                let forcedSession: MealBreakSession = syncNightSessionState(withEvent({
                    ...sessionWithUndo,
                    nightWorkAssignments: { ...activeSession.nightWorkAssignments, [parsed.ramal]: otherSlot },
                    updatedAt: referenceAt.toISOString(),
                }, { type: "night_work_selected", actorTelegramId: senderTelegramId, ramal: parsed.ramal, slot: otherSlot }, referenceAt));
                forcedSession = autoAssignRemainingNightWorkIfSingleOption(forcedSession, referenceAt, senderTelegramId);
                return {
                    handled: true,
                    session: forcedSession,
                    messages: [`⚠️ Trabalho alocado em ${otherSlot} para garantir separacao dos COIs.`],
                    status: "updated",
                };
            }

            if (remaining[chosenSlot] <= 0) {
                return {
                    handled: true,
                    session: activeSession,
                    messages: [`Esse horario ja completou as vagas. Disponiveis agora: ${buildAvailableNightWorkText(activeSession)}.`],
                    status: "invalid",
                };
            }

            const dinnerDuration = activeSession.dinnerDurationAssignments[parsed.ramal] ?? "half_hour";
            const sessionWithUndo = withUndoSnapshot(activeSession, `${renderDoctorCompactSummary(activeSession, parsed.ramal)} → trabalho`);
            let nextSession: MealBreakSession = syncNightSessionState(withEvent({
                ...sessionWithUndo,
                nightWorkAssignments: {
                    ...activeSession.nightWorkAssignments,
                    [parsed.ramal]: chosenSlot,
                },
                updatedAt: referenceAt.toISOString(),
            }, {
                type: "night_work_selected",
                actorTelegramId: senderTelegramId,
                ramal: parsed.ramal,
                slot: chosenSlot,
            }, referenceAt));
            nextSession = autoAssignRemainingNightWorkIfSingleOption(nextSession, referenceAt, senderTelegramId);

            const compactName = renderDoctorCompactSummary(nextSession, parsed.ramal);
            const workMessage = chosenSlot === "03:00"
                ? `✅ ${compactName} → ${chosenSlot} (jantar ${nextSession.dinnerAssignments[parsed.ramal] ?? resolveDefaultNightDinnerSlot(dinnerDuration)})`
                : `✅ ${compactName} → ${chosenSlot}`;

            if (nextSession.stage === "awaiting_night_work_choice") {
                return {
                    handled: true,
                    session: nextSession,
                    messages: [[workMessage, buildCurrentPrompt(nextSession)].join("\n")],
                    status: "updated",
                };
            }

            const dinnerPhase = autoAssignRemainingDinnerIfSingleOption(nextSession, referenceAt, senderTelegramId);
            if (dinnerPhase.stage === "completed") {
                return {
                    handled: true,
                    session: dinnerPhase,
                    messages: [buildNightWorkClosedMessages(nextSession), buildSessionSummary(dinnerPhase)],
                    status: "completed",
                };
            }

            return {
                handled: true,
                session: dinnerPhase,
                messages: [buildNightWorkClosedMessages(nextSession), buildNightDinnerIntro(dinnerPhase), buildCurrentPrompt(dinnerPhase)],
                status: "updated",
            };
        }

        if (activeSession.stage === "awaiting_dinner_choice") {
            const parsed = parseChoiceReply(text);
            const currentRamal = activeSession.dinnerQueue[0] ?? null;
            if (!parsed.ramal || !parsed.slot) {
                return {
                    handled: true,
                    session: activeSession,
                    messages: ["Formato invalido. Responda: RAMAL HORARIO."],
                    status: "invalid",
                };
            }

            if (!currentRamal || parsed.ramal !== currentRamal) {
                return {
                    handled: true,
                    session: activeSession,
                    messages: [`O chamado atual e para o ramal ${currentRamal ?? "-"}. Aguarde sua vez.`],
                    status: "invalid",
                };
            }

            if (!DINNER_CHOICE_SLOTS.includes(parsed.slot as (typeof DINNER_CHOICE_SLOTS)[number])) {
                return {
                    handled: true,
                    session: activeSession,
                    messages: [`Horario invalido. Disponiveis agora: ${buildAvailableDinnerText(activeSession)}.`],
                    status: "invalid",
                };
            }

            const chosenSlot = parsed.slot as (typeof DINNER_CHOICE_SLOTS)[number];
            const remaining = resolveRemainingDinnerChoiceSlots(activeSession);

            const dinnerPeerConflicts = resolveSharedPositionPeerSlots(activeSession, parsed.ramal, activeSession.dinnerAssignments);
            if (dinnerPeerConflicts.size > 0 && dinnerPeerConflicts.has(chosenSlot)) {
                const available = DINNER_CHOICE_SLOTS.filter((s) => remaining[s] > 0 && !dinnerPeerConflicts.has(s));
                if (available.length === 0) {
                    const forcedAlt = DINNER_CHOICE_SLOTS.find((s) => !dinnerPeerConflicts.has(s));
                    if (forcedAlt) {
                        let forcedSession: MealBreakSession = syncNightSessionState(withEvent({
                            ...withUndoSnapshot(activeSession, `${renderDoctorCompactSummary(activeSession, parsed.ramal)} → jantar ${forcedAlt} (COI separado)`),
                            dinnerAssignments: { ...activeSession.dinnerAssignments, [parsed.ramal]: forcedAlt },
                            updatedAt: referenceAt.toISOString(),
                        }, { type: "night_dinner_selected", actorTelegramId: senderTelegramId, ramal: parsed.ramal, slot: forcedAlt }, referenceAt));
                        forcedSession = autoAssignRemainingDinnerIfSingleOption(forcedSession, referenceAt, senderTelegramId);
                        return {
                            handled: true,
                            session: forcedSession,
                            messages: [`⚠️ COI nao pode coincidir. ${renderDoctorCompactSummary(activeSession, parsed.ramal)} foi alocado em ${forcedAlt} automaticamente.`],
                            status: forcedSession.stage === "completed" ? "completed" : "updated",
                        };
                    }
                }
                return {
                    handled: true,
                    session: activeSession,
                    messages: [`Outro COI ja esta em ${chosenSlot}. Escolha outro: ${available.join(" ou ")}.`],
                    status: "invalid",
                };
            }

            if (wouldCoiConflictAfterChoice(activeSession, parsed.ramal!, chosenSlot, activeSession.dinnerAssignments, activeSession.dinnerQueue, DINNER_CHOICE_SLOTS, remaining)) {
                const safeSlots = DINNER_CHOICE_SLOTS.filter((s) => remaining[s] > 0 && !wouldCoiConflictAfterChoice(activeSession, parsed.ramal!, s, activeSession.dinnerAssignments, activeSession.dinnerQueue, DINNER_CHOICE_SLOTS, remaining));
                const forcedSlot = safeSlots[0] ?? DINNER_CHOICE_SLOTS.find((s) => s !== chosenSlot && remaining[s] > 0);
                if (forcedSlot) {
                    let forcedSession: MealBreakSession = syncNightSessionState(withEvent({
                        ...withUndoSnapshot(activeSession, `${renderDoctorCompactSummary(activeSession, parsed.ramal)} → jantar ${forcedSlot} (COI reservado)`),
                        dinnerAssignments: { ...activeSession.dinnerAssignments, [parsed.ramal]: forcedSlot },
                        updatedAt: referenceAt.toISOString(),
                    }, { type: "night_dinner_selected", actorTelegramId: senderTelegramId, ramal: parsed.ramal, slot: forcedSlot }, referenceAt));
                    forcedSession = autoAssignRemainingDinnerIfSingleOption(forcedSession, referenceAt, senderTelegramId);
                    return {
                        handled: true,
                        session: forcedSession,
                        messages: [`⚠️ Jantar alocado em ${forcedSlot} para garantir separacao dos COIs.`],
                        status: forcedSession.stage === "completed" ? "completed" : "updated",
                    };
                }
            }

            if (remaining[chosenSlot] <= 0) {
                return {
                    handled: true,
                    session: activeSession,
                    messages: [`Esse horario ja completou as vagas. Disponiveis agora: ${buildAvailableDinnerText(activeSession)}.`],
                    status: "invalid",
                };
            }

            let updatedSession: MealBreakSession = syncNightSessionState(withEvent({
                ...withUndoSnapshot(activeSession, `${renderDoctorCompactSummary(activeSession, parsed.ramal)} → jantar`),
                dinnerAssignments: {
                    ...activeSession.dinnerAssignments,
                    [parsed.ramal]: chosenSlot,
                },
                updatedAt: referenceAt.toISOString(),
            }, {
                type: "night_dinner_selected",
                actorTelegramId: senderTelegramId,
                ramal: parsed.ramal,
                slot: chosenSlot,
            }, referenceAt));

            updatedSession = autoAssignRemainingDinnerIfSingleOption(updatedSession, referenceAt, senderTelegramId);
            const duration = updatedSession.dinnerDurationAssignments[parsed.ramal] === "one_hour" ? "1h" : "30min";
            const compactDinnerName = renderDoctorCompactSummary(updatedSession, parsed.ramal);

            if (updatedSession.stage === "completed") {
                return {
                    handled: true,
                    session: updatedSession,
                    messages: [
                        `✅ ${compactDinnerName} → ${chosenSlot} (${duration})`,
                        buildSessionSummary(updatedSession),
                    ],
                    status: "completed",
                };
            }

            return {
                handled: true,
                session: updatedSession,
                messages: [[
                    `✅ ${compactDinnerName} → ${chosenSlot} (${duration})`,
                    buildCurrentPrompt(updatedSession),
                ].join("\n")],
                status: "updated",
            };
        }

        return null;
    }

    if (session.stage === "awaiting_recip") {
        const choiceResult = resolveSingleChoiceRamal(session, text);
        if (choiceResult.ambiguous) {
            const candidates = choiceResult.candidates.map((doctor) => `• ${doctor.ramal} · ${resolveDoctorCompactName(doctor)}`).join("\n");
            return {
                handled: true,
                session,
                messages: [`Encontrei mais de um medico:\n${candidates}\n\nDigite o RAMAL para confirmar.`],
                status: "invalid",
            };
        }

        const resolvedRamal = choiceResult.ramal;

        if (!resolvedRamal) {
            return {
                handled: true,
                session,
                messages: ["Nao reconheci. Envie o RAMAL ou nome do medico RECIP."],
                status: "invalid",
            };
        }

        if (resolvedRamal === CHIEF_RAMAL || session.mrvRamals.includes(resolvedRamal)) {
            return {
                handled: true,
                session,
                messages: ["RECIP nao pode ser chefia nem um dos MRV. Informe outro."],
                status: "invalid",
            };
        }

        const doctor = findDoctor(session, resolvedRamal);
        if (!doctor) {
            return {
                handled: true,
                session,
                messages: ["Nao reconheci esse ramal na lista ativa. Envie RAMAL ou nome."],
                status: "invalid",
            };
        }

        const sessionWithUndo = withUndoSnapshot(session, `RECIP ${resolveDoctorCompactName(doctor)}`);
        const nextSession = withEvent({
            ...sessionWithUndo,
            recipRamal: resolvedRamal,
            stage: "awaiting_mrv_lunch",
            lunchAssignments: {
                ...session.lunchAssignments,
                ...(!isLunchExcluded(session, resolvedRamal) ? { [resolvedRamal]: "11:30" } : {}),
            },
            restAssignments: {
                ...session.restAssignments,
                ...(!isRestExcluded(session, resolvedRamal) ? { [resolvedRamal]: "18:00" } : {}),
            },
            updatedAt: referenceAt.toISOString(),
        }, {
            type: "recip_selected",
            actorTelegramId: senderTelegramId,
            ramal: resolvedRamal,
            slot: "11:30",
        }, referenceAt);

        return {
            handled: true,
            session: nextSession,
            messages: [
                [
                    `✅ RECIP: ${resolveDoctorCompactName(doctor)} · ${resolvedRamal}`,
                    "Almoco 11:30 · Descanso 18:00",
                    "",
                    buildCurrentPrompt(nextSession),
                ].join("\n"),
            ],
            status: "updated",
        };
    }

    if (session.stage === "awaiting_mrv_lunch") {
        const choiceResult = resolveSingleChoiceRamal(session, text, session.mrvRamals);
        if (choiceResult.ambiguous) {
            const candidates = choiceResult.candidates.map((doctor) => `• ${doctor.ramal} · ${resolveDoctorCompactName(doctor)}`).join("\n");
            return {
                handled: true,
                session,
                messages: [`Encontrei mais de um MRV:\n${candidates}\n\nDigite o RAMAL para confirmar.`],
                status: "invalid",
            };
        }

        if (!choiceResult.ramal) {
            return {
                handled: true,
                session,
                messages: ["Clique ou envie o RAMAL ou nome do MRV que ficara com 12:30."],
                status: "invalid",
            };
        }

        if (!session.mrvRamals.includes(choiceResult.ramal)) {
            const mrvList = session.mrvRamals.join(" ou ");
            return {
                handled: true,
                session,
                messages: [`Esse ramal nao e um dos MRV. Responda apenas com ${mrvList}.`],
                status: "invalid",
            };
        }

        const selectedRamal = choiceResult.ramal;
        const otherMrv = session.mrvRamals.find((ramal) => ramal !== selectedRamal) ?? null;
        const sessionWithUndo = withUndoSnapshot(session, `MRV 12:30 → ${renderDoctorCompactSummary(session, selectedRamal)}`);
        const preparedSession = finalizeLunchSetup({
            ...sessionWithUndo,
            mrvLunch1230Ramal: selectedRamal,
            lunchAssignments: {
                ...session.lunchAssignments,
                ...(!isLunchExcluded(session, selectedRamal) ? { [selectedRamal]: "12:30" } : {}),
                ...(otherMrv && !isLunchExcluded(session, otherMrv) ? { [otherMrv]: "13:30" } : {}),
            },
            restAssignments: {
                ...session.restAssignments,
                ...(!isRestExcluded(session, selectedRamal) ? { [selectedRamal]: "18:00" } : {}),
                ...(otherMrv && !isRestExcluded(session, otherMrv) ? { [otherMrv]: "18:00" } : {}),
            },
            updatedAt: referenceAt.toISOString(),
        }, referenceAt, senderTelegramId);
        const autoPreparedSession = autoAssignRemainingLunchIfSingleOption(preparedSession, referenceAt, senderTelegramId);

        const mrvMsg = otherMrv
            ? `✅ MRV 12:30: ${renderDoctorCompactSummary(autoPreparedSession, selectedRamal)} · MRV 13:30: ${renderDoctorCompactSummary(autoPreparedSession, otherMrv)}`
            : `✅ MRV 12:30: ${renderDoctorCompactSummary(autoPreparedSession, selectedRamal)}`;
        const messages = [[
            mrvMsg,
            `Vagas: 11:30 (${autoPreparedSession.lunchCapacities["11:30"]}), 12:30 (${autoPreparedSession.lunchCapacities["12:30"]}), 13:30 (${autoPreparedSession.lunchCapacities["13:30"]})`,
            "",
            buildCurrentPrompt(autoPreparedSession),
        ].join("\n")];

        if (autoPreparedSession.lunchQueue.length === 0) {
            const restPhase = buildRestPhase(autoPreparedSession, referenceAt, senderTelegramId);
            if (restPhase.stage === "completed") {
                const completed = completeSession(restPhase, referenceAt, senderTelegramId);
                return {
                    handled: true,
                    session: completed,
                    messages: [buildLunchClosedMessages(autoPreparedSession), buildSessionSummary(completed)],
                    status: "completed",
                };
            }

            return {
                handled: true,
                session: restPhase,
                messages: [buildLunchClosedMessages(autoPreparedSession), buildRestIntro(restPhase), buildCurrentPrompt(restPhase)],
                status: "updated",
            };
        }

        return {
            handled: true,
            session: autoPreparedSession,
            messages,
            status: "updated",
        };
    }

    if (session.stage === "awaiting_lunch_choice") {
        const parsed = parseChoiceReply(text);
        const currentRamal = session.lunchQueue[0] ?? null;
        if (!parsed.ramal || !parsed.slot) {
            return {
                handled: true,
                session,
                messages: ["Formato invalido. Responda: RAMAL HORARIO."],
                status: "invalid",
            };
        }

        if (!currentRamal || parsed.ramal !== currentRamal) {
            return {
                handled: true,
                session,
                messages: [`O chamado atual e para o ramal ${currentRamal ?? "-"}. Aguarde sua vez.`],
                status: "invalid",
            };
        }

        if (!LUNCH_SLOTS.includes(parsed.slot as MealBreakLunchSlot)) {
            return {
                handled: true,
                session,
                messages: [`Horario invalido. Disponiveis agora: ${buildAvailableLunchText(session)}.`],
                status: "invalid",
            };
        }

        const remaining = resolveRemainingLunchSlots(session);
        const chosenSlot = parsed.slot as MealBreakLunchSlot;

        const lunchPeerConflicts = resolveSharedPositionPeerSlots(session, parsed.ramal, session.lunchAssignments);
        if (lunchPeerConflicts.size > 0 && lunchPeerConflicts.has(chosenSlot)) {
            const available = LUNCH_SLOTS.filter((s) => remaining[s] > 0 && !lunchPeerConflicts.has(s));
            if (available.length === 0) {
                const forcedAlt = LUNCH_SLOTS.find((s) => !lunchPeerConflicts.has(s));
                if (forcedAlt) {
                    const nextQueue = session.lunchQueue.slice(1);
                    let updatedSession = withEvent({
                        ...withUndoSnapshot(session, `${renderDoctorCompactSummary(session, parsed.ramal)} → almoco ${forcedAlt} (COI separado)`),
                        lunchAssignments: { ...session.lunchAssignments, [parsed.ramal]: forcedAlt },
                        lunchQueue: nextQueue,
                        updatedAt: referenceAt.toISOString(),
                    }, { type: "lunch_selected", actorTelegramId: senderTelegramId, ramal: parsed.ramal, slot: forcedAlt }, referenceAt);
                    updatedSession = autoAssignRemainingLunchIfSingleOption(updatedSession, referenceAt, senderTelegramId);
                    return {
                        handled: true,
                        session: updatedSession,
                        messages: [`⚠️ COI nao pode coincidir. ${renderDoctorCompactSummary(session, parsed.ramal)} foi alocado em ${forcedAlt} automaticamente.`],
                        status: "updated",
                    };
                }
            }
            return {
                handled: true,
                session,
                messages: [`Outro COI ja esta em ${chosenSlot}. Escolha outro: ${available.join(" ou ")}.`],
                status: "invalid",
            };
        }

        if (wouldCoiConflictAfterChoice(session, parsed.ramal!, chosenSlot, session.lunchAssignments, session.lunchQueue, LUNCH_SLOTS, remaining)) {
            const safeSlots = LUNCH_SLOTS.filter((s) => remaining[s] > 0 && !wouldCoiConflictAfterChoice(session, parsed.ramal!, s, session.lunchAssignments, session.lunchQueue, LUNCH_SLOTS, remaining));
            const forcedSlot = safeSlots[0] ?? LUNCH_SLOTS.find((s) => s !== chosenSlot && remaining[s] > 0);
            if (forcedSlot) {
                const nextQueue = session.lunchQueue.slice(1);
                let updatedSession = withEvent({
                    ...withUndoSnapshot(session, `${renderDoctorCompactSummary(session, parsed.ramal)} → almoco ${forcedSlot} (COI reservado)`),
                    lunchAssignments: { ...session.lunchAssignments, [parsed.ramal]: forcedSlot },
                    lunchQueue: nextQueue,
                    updatedAt: referenceAt.toISOString(),
                }, { type: "lunch_selected", actorTelegramId: senderTelegramId, ramal: parsed.ramal, slot: forcedSlot }, referenceAt);
                updatedSession = autoAssignRemainingLunchIfSingleOption(updatedSession, referenceAt, senderTelegramId);
                return {
                    handled: true,
                    session: updatedSession,
                    messages: [`⚠️ Almoco alocado em ${forcedSlot} para garantir separacao dos COIs.`],
                    status: "updated",
                };
            }
        }

        if (remaining[chosenSlot] <= 0) {
            return {
                handled: true,
                session,
                messages: [`Esse horario ja completou as vagas. Disponiveis agora: ${buildAvailableLunchText(session)}.`],
                status: "invalid",
            };
        }

        const nextQueue = session.lunchQueue.slice(1);
        let updatedSession = withEvent({
            ...withUndoSnapshot(session, `${renderDoctorCompactSummary(session, parsed.ramal)} → almoco ${chosenSlot}`),
            lunchAssignments: {
                ...session.lunchAssignments,
                [parsed.ramal]: chosenSlot,
            },
            lunchQueue: nextQueue,
            updatedAt: referenceAt.toISOString(),
        }, {
            type: "lunch_selected",
            actorTelegramId: senderTelegramId,
            ramal: parsed.ramal,
            slot: chosenSlot,
        }, referenceAt);
        updatedSession = autoAssignRemainingLunchIfSingleOption(updatedSession, referenceAt, senderTelegramId);

        const compactLunchName = renderDoctorCompactSummary(updatedSession, parsed.ramal);
        if (updatedSession.lunchQueue.length > 0) {
            return {
                handled: true,
                session: updatedSession,
                messages: [[
                    `✅ ${compactLunchName} → ${chosenSlot}`,
                    buildCurrentPrompt(updatedSession),
                ].join("\n")],
                status: "updated",
            };
        }

        const restPhase = buildRestPhase(updatedSession, referenceAt, senderTelegramId);
        if (restPhase.stage === "completed") {
            const completed = completeSession(restPhase, referenceAt, senderTelegramId);
            return {
                handled: true,
                session: completed,
                messages: [buildLunchClosedMessages(updatedSession), buildSessionSummary(completed)],
                status: "completed",
            };
        }

        return {
            handled: true,
            session: restPhase,
            messages: [buildLunchClosedMessages(updatedSession), buildRestIntro(restPhase), buildCurrentPrompt(restPhase)],
            status: "updated",
        };
    }

    if (session.stage === "awaiting_rest_choice") {
        const parsed = parseChoiceReply(text);
        const currentRamal = session.restQueue[0] ?? null;
        if (!parsed.ramal || !parsed.slot) {
            return {
                handled: true,
                session,
                messages: ["Formato invalido. Responda: RAMAL HORARIO."],
                status: "invalid",
            };
        }

        if (!currentRamal || parsed.ramal !== currentRamal) {
            return {
                handled: true,
                session,
                messages: [`O chamado atual e para o ramal ${currentRamal ?? "-"}. Aguarde sua vez.`],
                status: "invalid",
            };
        }

        if (parsed.slot !== "15:30" && parsed.slot !== "16:30") {
            return {
                handled: true,
                session,
                messages: [`Nesse momento so posso usar 15:30 ou 16:30. Disponiveis agora: ${buildAvailableRestText(session)}.`],
                status: "invalid",
            };
        }

        const remaining = resolveRemainingRestChoiceSlots(session);
        const chosenSlot = parsed.slot as "15:30" | "16:30";

        const restPeerConflicts = resolveSharedPositionPeerSlots(session, parsed.ramal, session.restAssignments);
        if (restPeerConflicts.size > 0) {
            const otherSlot = chosenSlot === "15:30" ? "16:30" : "15:30";
            if (restPeerConflicts.has(chosenSlot)) {
                if (remaining[otherSlot] > 0) {
                    return {
                        handled: true,
                        session,
                        messages: [`Outro COI ja esta em ${chosenSlot}. Use ${otherSlot}.`],
                        status: "invalid",
                    };
                }
                const nextQueue = session.restQueue.slice(1);
                let updatedSession = withEvent({
                    ...withUndoSnapshot(session, `${renderDoctorCompactSummary(session, parsed.ramal)} → descanso ${otherSlot} (COI separado)`),
                    restAssignments: { ...session.restAssignments, [parsed.ramal]: otherSlot },
                    restQueue: nextQueue,
                    updatedAt: referenceAt.toISOString(),
                }, { type: "rest_selected", actorTelegramId: senderTelegramId, ramal: parsed.ramal, slot: otherSlot }, referenceAt);
                updatedSession = autoAssignRemainingRestIfSingleOption(updatedSession, referenceAt, senderTelegramId);
                const completedMsg = updatedSession.stage === "completed"
                    ? buildSessionSummary(completeSession(updatedSession, referenceAt, senderTelegramId))
                    : buildCurrentPrompt(updatedSession);
                return {
                    handled: true,
                    session: updatedSession.stage === "completed" ? completeSession(updatedSession, referenceAt, senderTelegramId) : updatedSession,
                    messages: [`⚠️ COI nao pode coincidir. ${renderDoctorCompactSummary(session, parsed.ramal)} foi alocado em ${otherSlot} automaticamente.`, completedMsg],
                    status: updatedSession.stage === "completed" ? "completed" : "updated",
                };
            }
        }

        if (wouldCoiConflictAfterChoice(session, parsed.ramal!, chosenSlot, session.restAssignments, session.restQueue, ["15:30", "16:30"] as const, remaining)) {
            const otherSlot = chosenSlot === "15:30" ? "16:30" as const : "15:30" as const;
            const nextQueue = session.restQueue.slice(1);
            let updatedSession = withEvent({
                ...withUndoSnapshot(session, `${renderDoctorCompactSummary(session, parsed.ramal)} → descanso ${otherSlot} (COI reservado)`),
                restAssignments: { ...session.restAssignments, [parsed.ramal]: otherSlot },
                restQueue: nextQueue,
                updatedAt: referenceAt.toISOString(),
            }, { type: "rest_selected", actorTelegramId: senderTelegramId, ramal: parsed.ramal, slot: otherSlot }, referenceAt);
            updatedSession = autoAssignRemainingRestIfSingleOption(updatedSession, referenceAt, senderTelegramId);
            const completedMsg = updatedSession.stage === "completed"
                ? buildSessionSummary(completeSession(updatedSession, referenceAt, senderTelegramId))
                : buildCurrentPrompt(updatedSession);
            return {
                handled: true,
                session: updatedSession.stage === "completed" ? completeSession(updatedSession, referenceAt, senderTelegramId) : updatedSession,
                messages: [`⚠️ Descanso alocado em ${otherSlot} para garantir separacao dos COIs.`, completedMsg],
                status: updatedSession.stage === "completed" ? "completed" : "updated",
            };
        }

        if (remaining[chosenSlot] <= 0) {
            return {
                handled: true,
                session,
                messages: [`Esse horario ja completou as vagas. Disponiveis agora: ${buildAvailableRestText(session)}.`],
                status: "invalid",
            };
        }

        const nextQueue = session.restQueue.slice(1);
        let updatedSession = withEvent({
            ...withUndoSnapshot(session, `${renderDoctorCompactSummary(session, parsed.ramal)} → descanso ${chosenSlot}`),
            restAssignments: {
                ...session.restAssignments,
                [parsed.ramal]: chosenSlot,
            },
            restQueue: nextQueue,
            updatedAt: referenceAt.toISOString(),
        }, {
            type: "rest_selected",
            actorTelegramId: senderTelegramId,
            ramal: parsed.ramal,
            slot: chosenSlot,
        }, referenceAt);

        updatedSession = autoAssignRemainingRestIfSingleOption(updatedSession, referenceAt, senderTelegramId);
        const compactRestName = renderDoctorCompactSummary(updatedSession, parsed.ramal);
        if (updatedSession.stage === "completed") {
            const completed = completeSession(updatedSession, referenceAt, senderTelegramId);
            return {
                handled: true,
                session: completed,
                messages: [
                    `✅ ${compactRestName} → ${chosenSlot}`,
                    buildSessionSummary(completed),
                ],
                status: "completed",
            };
        }

        return {
            handled: true,
            session: updatedSession,
            messages: [[
                `✅ ${compactRestName} → ${chosenSlot}`,
                buildCurrentPrompt(updatedSession),
            ].join("\n")],
            status: "updated",
        };
    }

    return null;
}

async function loadMealBreakSession(chatId: string, operationalDate: string, mode: MealBreakMode) {
    const db = getDb();
    const noticeKeys = mode === "day"
        ? [resolveSessionNoticeKey(chatId, mode), resolveLegacySessionNoticeKey(chatId)]
        : [resolveSessionNoticeKey(chatId, mode)];
    const rows = await db.query.telegramBotNotices.findMany({
        where: inArray(telegramBotNotices.noticeKey, noticeKeys),
        limit: noticeKeys.length,
    });

    const row = noticeKeys
        .map((noticeKey) => rows.find((candidate) => candidate.noticeKey === noticeKey) ?? null)
        .find((candidate) => Boolean(candidate)) ?? null;

    if (!row || !isMealBreakSession(row.payload)) {
        return null;
    }

    const session = hydrateMealBreakSession(row.payload);
    return session.operationalDate === operationalDate && session.mode === mode ? session : null;
}

function getMealBreakVisibleChatIds() {
    return [...new Set([...getTelegramAdminUserIds(), ...getTelegramAnnouncementChatIds()])];
}

async function resolveCurrentOperationalMealBreakState(referenceAt: Date, mode: MealBreakMode) {
    const operationalDate = formatOperationalDate(referenceAt);
    const chatIds = getMealBreakVisibleChatIds();
    if (chatIds.length === 0) {
        return null;
    }

    const sessions = await Promise.all(chatIds.map(async (chatId) => {
        const session = await loadMealBreakSession(chatId, operationalDate, mode);
        return session ? { chatId, session } : null;
    }));

    const available = sessions.filter((entry): entry is { chatId: string; session: MealBreakSession } => Boolean(entry));
    if (available.length === 0) {
        return null;
    }

    available.sort((left, right) => new Date(right.session.updatedAt).getTime() - new Date(left.session.updatedAt).getTime());
    return available[0] ?? null;
}

async function saveMealBreakSession(chatId: string, session: MealBreakSession) {
    const db = getDb();
    await db.insert(telegramBotNotices)
        .values({
            noticeKey: resolveSessionNoticeKey(chatId, session.mode),
            chatId,
            stage: SESSION_NOTICE_STAGE,
            payload: session,
        })
        .onConflictDoUpdate({
            target: telegramBotNotices.noticeKey,
            set: {
                stage: SESSION_NOTICE_STAGE,
                payload: session,
            },
        });
}

async function reserveMealBreakAutoNotice(chatId: string, operationalDate: string, mode: MealBreakMode) {
    const db = getDb();
    const [inserted] = await db.insert(telegramBotNotices)
        .values({
            noticeKey: resolveAutoNoticeKey(chatId, operationalDate, mode),
            chatId,
            stage: AUTO_NOTICE_STAGE,
            payload: { operationalDate, mode },
        })
        .onConflictDoNothing()
        .returning();

    return Boolean(inserted);
}

async function rollbackMealBreakAutoNotice(chatId: string, operationalDate: string, mode: MealBreakMode) {
    const db = getDb();
    await db.delete(telegramBotNotices)
        .where(eq(telegramBotNotices.noticeKey, resolveAutoNoticeKey(chatId, operationalDate, mode)));
}

export function isTelegramMealBreakCommandText(text: string) {
    const normalized = text.trim().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
    return /^\/(?:almoco|jantar)(?:@\w+)?\b/i.test(normalized);
}

export function isTelegramMealBreakPriorityCommandText(text: string) {
    return /^\/(?:prioridades|prioridade)(?:@\w+)?\b/i.test(text.trim());
}

export function parseTelegramMealBreakCommand(text: string): TelegramMealBreakCommand | null {
    const trimmed = text.trim();
    const normalized = trimmed.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
    const match = normalized.match(/^\/(almoco|jantar)(?:@(\w+))?(?:\s+(reiniciar))?\s*$/i);
    if (!match) {
        return null;
    }

    return {
        name: "meal_break",
        mode: match[1]?.toLowerCase() === "jantar" ? "night" : "day",
        forceRestart: Boolean(match[3]),
        rawBody: normalized.replace(/^\/(?:almoco|jantar)(?:@\w+)?/i, "").trim(),
    };
}

export function parseTelegramMealBreakPriorityCommand(text: string): TelegramMealBreakPriorityCommand | null {
    const trimmed = text.trim();
    const match = trimmed.match(/^\/(prioridades|prioridade)(?:@(\w+))?\s*$/i);
    if (!match) {
        return null;
    }

    return {
        name: "meal_break_priority",
        rawBody: trimmed.replace(/^\/(?:prioridades|prioridade)(?:@\w+)?/i, "").trim(),
    };
}

export interface TelegramMealBreakExcludeCommand {
    name: "meal_break_exclude";
    ramal: string;
}

export function isTelegramMealBreakExcludeCommandText(text: string) {
    return /^\/(?:excluir|incluir)(?:@\w+)?\b/i.test(text.trim());
}

export function parseTelegramMealBreakExcludeCommand(text: string): TelegramMealBreakExcludeCommand | null {
    const trimmed = text.trim();
    const match = trimmed.match(/^\/(excluir|incluir)(?:@\w+)?\s+(\d{4})\s*$/i);
    if (!match) {
        return null;
    }

    return {
        name: "meal_break_exclude",
        ramal: normalizeRamal(match[2]),
    };
}

export function buildMealBreakExcludeCommandUsageReply() {
    return "Use /excluir <ramal> para retirar um medico da divisao de almoco e descanso, ou /incluir <ramal> para recolocar. Exemplo: /excluir 2041";
}

export async function runTelegramMealBreakExcludeCommand(params: {
    ramal: string;
    exclude: boolean;
    referenceAt: Date;
    actorTelegramId: string | null;
}) {
    const mode = resolveMealBreakModeFromReference(params.referenceAt);
    if (mode !== "day") {
        return {
            messages: [":/ Exclusao da divisao so funciona no plantao diurno. No noturno, use o quadro para ajustar jantar e trabalho."],
            status: "rejected" as const,
        };
    }

    const result = await updateDayMealBreakEligibility({
        ramal: params.ramal,
        referenceAt: params.referenceAt,
        actorTelegramId: params.actorTelegramId,
        lunchExcluded: params.exclude,
        restExcluded: params.exclude,
    });

    const normalizedRamal = normalizeRamal(params.ramal);
    const doctor = result.session
        ? findDoctor(result.session, normalizedRamal)
        : null;
    const doctorLabel = doctor ? resolveDoctorCompactName(doctor) : `ramal ${normalizedRamal}`;

    if (params.exclude) {
        return {
            messages: [`🚫 ${doctorLabel} foi retirado da divisao de almoco e descanso de hoje. Para recolocar, use /incluir ${normalizedRamal}`],
            status: "excluded" as const,
        };
    }

    return {
        messages: [`✅ ${doctorLabel} foi recolocado na divisao de almoco e descanso de hoje.`],
        status: "included" as const,
    };
}

export function buildMealBreakPriorityReply(view: MealBreakPriorityView) {
    if (view.entries.length === 0) {
        return view.mode === "night"
            ? "🌙 PRIORIDADES DO JANTAR\nSem medicos elegiveis na fila atual."
            : "☀️ PRIORIDADES DO ALMOCO\nSem medicos elegiveis na fila atual.";
    }

    const title = view.mode === "night" ? "🌙 PRIORIDADES DO JANTAR" : "☀️ PRIORIDADES DO ALMOCO";
    const warnings = view.warnings.map((warning) => `⚠️ ${warning.message}`);
    const lines = view.entries.map((entry) => {
        const base = `${entry.rank}. ${resolveDoctorCompactName({ name: entry.name })} | ${entry.ramal} | ${formatHour(entry.priorityStartedAt)}`;
        return entry.explanation ? `${base} | ${entry.explanation}` : base;
    });

    return [title, ...warnings, ...lines].join("\n");
}

export function buildMealBreakPriorityReplyMessages(view: MealBreakPriorityView, maxLength = 3500) {
    const singleReply = buildMealBreakPriorityReply(view);
    if (singleReply.length <= maxLength) {
        return [singleReply];
    }

    const title = view.mode === "night" ? "🌙 PRIORIDADES DO JANTAR" : "☀️ PRIORIDADES DO ALMOCO";
    const lines = view.entries.map((entry) => {
        const base = `${entry.rank}. ${resolveDoctorCompactName({ name: entry.name })} | ${entry.ramal} | ${formatHour(entry.priorityStartedAt)}`;
        return entry.explanation ? `${base} | ${entry.explanation}` : base;
    });
    const messages: string[] = [];
    let current = title;

    for (const line of lines) {
        const next = `${current}\n${line}`;
        if (next.length > maxLength && current !== title) {
            messages.push(current);
            current = `${title}\n${line}`;
            continue;
        }

        if (next.length > maxLength) {
            messages.push(title);
            current = line;
            continue;
        }

        current = next;
    }

    messages.push(current);
    return messages;
}

export function buildMealBreakCommandUsageReply() {
    return "Use /almoco para a divisao diurna ou /jantar para a divisao noturna. Acrescente reiniciar para recomecar o fluxo atual.";
}

export function buildMealBreakPriorityCommandUsageReply() {
    return "Use /prioridade ou /prioridades para consultar a fila atual antes de abrir a divisao.";
}

export async function runTelegramMealBreakPriorityCommand(params: {
    referenceAt: Date;
    mode?: MealBreakMode;
    board?: OperationalBoard;
}) {
    const view = await getCurrentMealBreakPriorityView(params);
    return {
        view,
        messages: buildMealBreakPriorityReplyMessages(view),
        status: "reported" as const,
    };
}

export async function runTelegramMealBreakCommand(params: {
    chatId: string;
    referenceAt: Date;
    trigger: "manual" | "automatic";
    mode?: MealBreakMode;
    forceRestart: boolean;
    actorTelegramId: string | null;
    board?: OperationalBoard;
}) {
    const mode = params.mode ?? resolveMealBreakModeFromReference(params.referenceAt);
    const operationalDate = formatOperationalDate(params.referenceAt);
    const existing = await loadMealBreakSession(params.chatId, operationalDate, mode);

    if (existing && !params.forceRestart) {
        return {
            session: existing,
            messages: [buildExistingSessionReply(existing)],
            status: "reported" as const,
        };
    }

    const board = params.board ?? await getOperationalBoard();
    const priorityContext = await buildMealBreakPriorityContext({
        referenceAt: params.referenceAt,
        mode,
        board,
    });
    const eligibilityOverrides = await loadMealBreakEligibilityOverrides(operationalDate, mode);
    const session = createMealBreakSession({
        roster: priorityContext.entries.map((entry) => entry.doctor),
        chiefRamal: priorityContext.chiefRamal,
        mrvRamals: priorityContext.mrvRamals,
        referenceAt: params.referenceAt,
        mode,
        trigger: params.trigger,
        restarted: Boolean(existing && params.forceRestart),
        actorTelegramId: params.actorTelegramId,
        lunchExcludedRamals: eligibilityOverrides?.lunchExcludedRamals,
        restExcludedRamals: eligibilityOverrides?.restExcludedRamals,
    });

    await saveMealBreakSession(params.chatId, session);

    const intro = existing && params.forceRestart
        ? "Divisao anterior descartada. Vamos reiniciar."
        : null;

    return {
        session,
        messages: [intro, buildStartPrompt(session)].filter((value): value is string => Boolean(value)),
        status: "started" as const,
    };
}

export async function handleTelegramMealBreakReply(params: {
    chatId: string;
    text: string;
    senderTelegramId: string | null;
    referenceAt: Date;
}) {
    const operationalDate = formatOperationalDate(params.referenceAt);
    const session = await loadMealBreakSession(params.chatId, operationalDate, resolveMealBreakModeFromReference(params.referenceAt));
    if (!session || session.stage === "completed") {
        return null;
    }

    const result = applyMealBreakReply({
        session,
        text: params.text,
        senderTelegramId: params.senderTelegramId,
        referenceAt: params.referenceAt,
    });

    if (!result) {
        return null;
    }

    await saveMealBreakSession(params.chatId, result.session);
    return result;
}

export async function shouldPrioritizeTelegramMealBreakReply(params: {
    chatId: string;
    text: string;
    referenceAt: Date;
}) {
    const operationalDate = formatOperationalDate(params.referenceAt);
    const session = await loadMealBreakSession(
        params.chatId,
        operationalDate,
        resolveMealBreakModeFromReference(params.referenceAt),
    );
    if (!session || session.stage === "completed") {
        return false;
    }

    return shouldPreferMealBreakReplyForSession(session, params.text);
}

export async function getCurrentOperationalMealBreakSession(referenceAt = new Date()) {
    const state = await resolveCurrentOperationalMealBreakState(referenceAt, resolveMealBreakModeFromReference(referenceAt));
    return state?.session ?? null;
}

export async function getCurrentMealBreakEligibilityOverrides(referenceAt = new Date()) {
    const mode = resolveMealBreakModeFromReference(referenceAt);
    const operationalDate = formatOperationalDate(referenceAt);
    const overrides = await loadMealBreakEligibilityOverrides(operationalDate, mode);
    return overrides
        ? { lunchExcludedRamals: overrides.lunchExcludedRamals, restExcludedRamals: overrides.restExcludedRamals }
        : { lunchExcludedRamals: [] as string[], restExcludedRamals: [] as string[] };
}

export async function updateNightMealBreakAssignment(params: {
    chatId?: string;
    ramal: string;
    referenceAt: Date;
    actorTelegramId: string | null;
    nightWorkSlot?: MealBreakNightWorkSlot | null;
    dinnerSlot?: MealBreakDinnerSlot | null;
}) {
    const operationalDate = formatOperationalDate(params.referenceAt);
    const resolvedState = params.chatId
        ? {
            chatId: params.chatId,
            session: await loadMealBreakSession(params.chatId, operationalDate, "night"),
        }
        : await resolveCurrentOperationalMealBreakState(params.referenceAt, "night");
    const chatId = resolvedState?.chatId ?? null;
    const session = resolvedState?.session ?? null;
    if (!session) {
        throw new Error("Nao existe sessao noturna ativa para este plantao.");
    }
    if (!chatId) {
        throw new Error("Nao consegui identificar o chat ativo da divisao noturna.");
    }

    const ramal = normalizeRamal(params.ramal);
    if (!findDoctor(session, ramal)) {
        throw new Error(`O posto ${ramal} nao participa da divisao atual.`);
    }

    const hasNightWorkPatch = Object.prototype.hasOwnProperty.call(params, "nightWorkSlot");
    const hasDinnerPatch = Object.prototype.hasOwnProperty.call(params, "dinnerSlot");
    const nightWorkAssignments = { ...session.nightWorkAssignments };
    const dinnerAssignments = { ...session.dinnerAssignments };
    const dinnerDuration = session.dinnerDurationAssignments[ramal] ?? "half_hour";
    const defaultLateDinner = resolveDefaultNightDinnerSlot(dinnerDuration);
    const previousWorkSlot = nightWorkAssignments[ramal] ?? null;

    if (hasNightWorkPatch) {
        const nextNightWorkSlot = params.nightWorkSlot ?? null;

        if (nextNightWorkSlot === null) {
            delete nightWorkAssignments[ramal];
            delete dinnerAssignments[ramal];
        } else {
            nightWorkAssignments[ramal] = nextNightWorkSlot;
            if (nextNightWorkSlot === "03:00") {
                dinnerAssignments[ramal] = defaultLateDinner;
            } else if (previousWorkSlot === "03:00") {
                delete dinnerAssignments[ramal];
            }
        }
    }

    const effectiveNightWorkSlot = nightWorkAssignments[ramal] ?? null;
    if (hasDinnerPatch) {
        if (!effectiveNightWorkSlot) {
            throw new Error("Defina primeiro o trabalho da noite antes do jantar.");
        }

        if (effectiveNightWorkSlot === "03:00") {
            if (params.dinnerSlot && params.dinnerSlot !== defaultLateDinner) {
                throw new Error("Quem trabalha as 03:00 deve jantar no ultimo horario permitido.");
            }

            dinnerAssignments[ramal] = defaultLateDinner;
        } else {
            const nextDinnerSlot = params.dinnerSlot ?? null;

            if (nextDinnerSlot === null) {
                delete dinnerAssignments[ramal];
            } else {
                if (!DINNER_CHOICE_SLOTS.includes(nextDinnerSlot as (typeof DINNER_CHOICE_SLOTS)[number])) {
                    throw new Error("Quem trabalha as 23:00 so pode jantar entre 20:30 e 21:30.");
                }

                dinnerAssignments[ramal] = nextDinnerSlot;
            }
        }
    }

    const nextSession = syncNightSessionState(withEvent({
        ...session,
        nightWorkAssignments,
        dinnerAssignments,
        updatedAt: params.referenceAt.toISOString(),
    }, {
        type: "night_assignment_corrected",
        actorTelegramId: params.actorTelegramId,
        ramal,
        slot: effectiveNightWorkSlot ?? dinnerAssignments[ramal] ?? undefined,
    }, params.referenceAt));

    await saveMealBreakSession(chatId, nextSession);
    return nextSession;
}

export async function updateDayMealBreakEligibility(params: {
    chatId?: string;
    ramal: string;
    referenceAt: Date;
    actorTelegramId: string | null;
    lunchExcluded?: boolean;
    restExcluded?: boolean;
}) {
    if (
        !Object.prototype.hasOwnProperty.call(params, "lunchExcluded")
        && !Object.prototype.hasOwnProperty.call(params, "restExcluded")
    ) {
        throw new Error("Nenhuma mudança de almoço ou descanso foi informada.");
    }

    const operationalDate = formatOperationalDate(params.referenceAt);
    const normalizedRamal = normalizeRamal(params.ramal);
    const previous = await loadMealBreakEligibilityOverrides(operationalDate, "day");
    const lunchExcluded = new Set(previous?.lunchExcludedRamals ?? []);
    const restExcluded = new Set(previous?.restExcludedRamals ?? []);

    if (Object.prototype.hasOwnProperty.call(params, "lunchExcluded")) {
        if (params.lunchExcluded) {
            lunchExcluded.add(normalizedRamal);
        } else {
            lunchExcluded.delete(normalizedRamal);
        }
    }

    if (Object.prototype.hasOwnProperty.call(params, "restExcluded")) {
        if (params.restExcluded) {
            restExcluded.add(normalizedRamal);
        } else {
            restExcluded.delete(normalizedRamal);
        }
    }

    const overrides: MealBreakEligibilityOverrideRecord = {
        kind: ELIGIBILITY_KIND,
        version: 1,
        mode: "day",
        operationalDate,
        lunchExcludedRamals: [...lunchExcluded],
        restExcludedRamals: [...restExcluded],
        updatedAt: params.referenceAt.toISOString(),
    };

    await saveMealBreakEligibilityOverrides(overrides);

    const resolvedState = params.chatId
        ? {
            chatId: params.chatId,
            session: await loadMealBreakSession(params.chatId, operationalDate, "day"),
        }
        : await resolveCurrentOperationalMealBreakState(params.referenceAt, "day");
    const chatId = resolvedState?.chatId ?? null;
    const session = resolvedState?.session ?? null;

    if (!session || !chatId) {
        return { session: null, overrides };
    }

    if (!findDoctor(session, normalizedRamal)) {
        throw new Error(`O posto ${normalizedRamal} nao participa da divisao atual.`);
    }

    const nextSession = syncDaySessionState(withEvent({
        ...session,
        lunchExcludedRamals: overrides.lunchExcludedRamals,
        restExcludedRamals: overrides.restExcludedRamals,
        updatedAt: params.referenceAt.toISOString(),
    }, {
        type: "eligibility_corrected",
        actorTelegramId: params.actorTelegramId,
        ramal: normalizedRamal,
    }, params.referenceAt));

    await saveMealBreakSession(chatId, nextSession);
    return { session: nextSession, overrides };
}

export async function updateDayMealBreakAssignment(params: {
    chatId?: string;
    ramal: string;
    referenceAt: Date;
    actorTelegramId: string | null;
    lunchSlot?: MealBreakLunchSlot | MealBreakRestSlot | null;
    restSlot?: MealBreakRestSlot | MealBreakLunchSlot | null;
}) {
    const hasLunchPatch = Object.prototype.hasOwnProperty.call(params, "lunchSlot");
    const hasRestPatch = Object.prototype.hasOwnProperty.call(params, "restSlot");
    if (!hasLunchPatch && !hasRestPatch) {
        throw new Error("Nenhuma mudanca de almoco ou descanso foi informada.");
    }

    const operationalDate = formatOperationalDate(params.referenceAt);
    const resolvedState = params.chatId
        ? { chatId: params.chatId, session: await loadMealBreakSession(params.chatId, operationalDate, "day") }
        : await resolveCurrentOperationalMealBreakState(params.referenceAt, "day");
    const chatId = resolvedState?.chatId ?? null;
    const session = resolvedState?.session ?? null;
    if (!session) {
        throw new Error("Nao existe sessao diurna ativa para este plantao.");
    }
    if (!chatId) {
        throw new Error("Nao consegui identificar o chat ativo da divisao diurna.");
    }

    const ramal = normalizeRamal(params.ramal);
    if (!findDoctor(session, ramal)) {
        throw new Error(`O posto ${ramal} nao participa da divisao atual.`);
    }

    const lunchAssignments = { ...session.lunchAssignments };
    const restAssignments = { ...session.restAssignments };

    if (hasLunchPatch) {
        if (params.lunchSlot === null) {
            delete lunchAssignments[ramal];
        } else if (params.lunchSlot) {
            lunchAssignments[ramal] = params.lunchSlot as MealBreakLunchSlot;
        }
    }

    if (hasRestPatch) {
        if (params.restSlot === null) {
            delete restAssignments[ramal];
        } else if (params.restSlot) {
            restAssignments[ramal] = params.restSlot as MealBreakRestSlot;
        }
    }

    const nextSession = syncDaySessionState(withEvent({
        ...session,
        lunchAssignments,
        restAssignments,
        updatedAt: params.referenceAt.toISOString(),
    }, {
        type: "eligibility_corrected",
        actorTelegramId: params.actorTelegramId,
        ramal,
    }, params.referenceAt));

    await saveMealBreakSession(chatId, nextSession);
    return nextSession;
}

export async function sendTelegramMealBreakCycle(referenceDate = new Date()) {
    // Meal-break sessions must be started manually via /almoco or /jantar.
    // Automatic start was disabled to avoid interrupting the operational flow.
    return { sent: 0, evaluated: 0 };

    /* eslint-disable no-unreachable -- preserved for future reference */
    if (!process.env.TELEGRAM_BOT_TOKEN?.trim()) {
        return { sent: 0, evaluated: 0 };
    }

    const parts = getSaoPauloParts(referenceDate);
    const mode = resolveMealBreakModeFromReference(referenceDate);
    const operationalDate = formatOperationalDate(referenceDate);
    const isAutomaticWindow = mode === "day"
        ? parts.hour === 9 && parts.minute < 10
        : parts.hour === 20 && parts.minute < 10;
    if (!isAutomaticWindow) {
        return { sent: 0, evaluated: 0 };
    }

    const chatIds = getTelegramAnnouncementChatIds();
    if (chatIds.length === 0) {
        return { sent: 0, evaluated: 0 };
    }

    const board = await getOperationalBoard();
    let sent = 0;
    let evaluated = 0;

    for (const chatId of chatIds) {
        evaluated += 1;

        const reserved = await reserveMealBreakAutoNotice(chatId, operationalDate, mode);
        if (!reserved) {
            continue;
        }

        try {
            const result = await runTelegramMealBreakCommand({
                chatId,
                referenceAt: referenceDate,
                trigger: "automatic",
                mode,
                forceRestart: false,
                actorTelegramId: null,
                board,
            });
            for (const [index, text] of result.messages.entries()) {
                await sendMessage(chatId, text, index === 0 ? undefined : undefined);
            }
            sent += result.messages.length;
        } catch (error) {
            await rollbackMealBreakAutoNotice(chatId, operationalDate, mode);
            console.error(`telegram meal break failed for ${chatId} ${operationalDate}`, error);
        }
    }

    return { sent, evaluated };
    /* eslint-enable no-unreachable */
}

export async function sendTelegramMealBreakMessages(params: {
    chatId: string | number;
    messages: string[];
    replyToMessageId?: number;
    replyMarkup?: TelegramReplyMarkup;
}) {
    const lastIndex = params.messages.length - 1;
    for (const [index, text] of params.messages.entries()) {
        const isLast = index === lastIndex;
        await sendMessage(
            params.chatId,
            text,
            index === 0 ? params.replyToMessageId : undefined,
            isLast ? params.replyMarkup : undefined,
        );
    }
}

export function buildMealBreakErrorReply(error: unknown) {
    const message = error instanceof Error ? error.message : "Falha inesperada.";
    if (message.includes("inconsistência")) {
        return "Ha inconsistência na lista de medicos ativos. Preciso da lista atualizada para continuar.";
    }
    if (message.includes("diurno")) {
        return "Esse fluxo vale so para o plantao diurno.";
    }
    if (message.includes("noturno")) {
        return "Esse fluxo vale so para o plantao noturno.";
    }
    return `Nao consegui organizar a divisao agora. ${message}`;
}

export function resolveMealBreakLogDetails(session: MealBreakSession | null) {
    if (!session) {
        return {};
    }

    return {
        mealBreakMode: session.mode,
        mealBreakStage: session.stage,
        mealBreakOperationalDate: session.operationalDate,
        mealBreakAssignedLunchCount: Object.keys(session.lunchAssignments).length,
        mealBreakAssignedRestCount: Object.keys(session.restAssignments).length,
        mealBreakAssignedNightWorkCount: Object.keys(session.nightWorkAssignments).length,
        mealBreakAssignedDinnerCount: Object.keys(session.dinnerAssignments).length,
    };
}

export function resolveTelegramMealBreakSenderId(update: TelegramUpdate) {
    return update.message?.from?.id ? String(update.message.from.id) : null;
}
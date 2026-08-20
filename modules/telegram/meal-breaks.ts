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
import { and, desc, eq, gte, inArray, isNotNull, like, lt, lte, notInArray } from "drizzle-orm";
import { getDb, hasDatabaseUrl } from "@/db";
import { interventionOccupancies, regulationOccupancies, telegramBotNotices, telegramIngestedMessages } from "@/db/schema";
import { formatDoctorSurfaceName } from "@/modules/doctors/directory";
import { isNucleoRegulationPost, isPiamRegulationPost } from "@/modules/operational/board-display";
import { isHalfShiftRoleLabel } from "@/modules/operational/half-shift";
import { isRemoteOperationalRole, isRemotePriorityRegulationCode, normalizeOperationalRoleLabel, resolveOperationalRoleLabel } from "@/modules/operational/roles";
import { getSaoPauloParts, resolveArrivalShiftLabel, resolveOperationalShiftWindow } from "@/modules/operational/board-rules";
import type { TelegramFormatOptions, TelegramUpdate } from "@/modules/telegram/api";
import { buildChoiceKeyboard, escapeTelegramMarkdown, getChatMember, REMOVE_KEYBOARD, sendMessage, type TelegramReplyMarkup } from "@/modules/telegram/api";
import { publishBoardUpdate } from "@/lib/board-live";
import { getTelegramAdminUserIds, getTelegramAnnouncementChatIds, getTelegramChiefUserIds } from "@/modules/telegram/config";
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
    arrivalStartedAt?: string;
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
    | "mrv_declared"
    | "mrv_selected"
    | "lunch_selected"
    | "rest_auto_selected"
    | "rest_selected"
    | "night_work_selected"
    | "night_dinner_auto_selected"
    | "night_dinner_selected"
    | "night_assignment_corrected"
    | "eligibility_corrected"
    | "latecomer_joined"
    | "latecomer_rewind"
    | "session_restored"
    | "chief_pin_applied"
    | "chief_pin_rewind"
    | "board_reconciled"
    | "board_rewind"
    | "undo_applied"
    | "session_completed";
    ramal?: string;
    slot?: MealBreakLunchSlot | MealBreakRestSlot | MealBreakDinnerSlot | MealBreakNightWorkSlot;
    actorTelegramId: string | null;
    recordedAt: string;
}

/**
 * Horários FIXADOS pela chefia no painel logado. Autoridade absoluta: são
 * reaplicados no fim de todo sync, passando por cima das regras que, de outra
 * forma, desfariam a mudança no mesmo instante — apagamento de descanso
 * enquanto a fase de almoço não fecha, 14:30 automático de quem almoçou 13:30,
 * separação de par COI, capacidade do horário e exclusões de elegibilidade.
 *
 * Existe porque o clique do chefe gravava e o sync desfazia logo depois: a API
 * respondia 200 e o horário sumia da tela, o que parecia bug (relato de
 * 04/08/2026 — "clico e não funciona diversas vezes").
 *
 * Fixar `null` desfixa (volta a valer a regra automática).
 */
export interface MealBreakChiefPins {
    lunch: Record<string, MealBreakLunchSlot>;
    rest: Record<string, MealBreakRestSlot>;
    nightWork: Record<string, MealBreakNightWorkSlot>;
    dinner: Record<string, MealBreakDinnerSlot>;
}

export function emptyMealBreakChiefPins(): MealBreakChiefPins {
    return { lunch: {}, rest: {}, nightWork: {}, dinner: {} };
}

export interface MealBreakUndoSnapshot {
    stage: MealBreakStage;
    recipRamal: string | null;
    mrvRamals: string[];
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
    /** Fixações da chefia (painel). Ausente em sessões antigas — ver hydrate. */
    chiefPins?: MealBreakChiefPins;
    createdAt: string;
    updatedAt: string;
    events: MealBreakSessionEvent[];
}

export interface TelegramMealBreakCommand {
    name: "meal_break";
    mode: MealBreakMode;
    forceRestart: boolean;
    /** `restore_list` = mostrar os pontos de restauração; `restore_apply` = voltar
     *  para o ponto `restorePosition` (1 = o mais recente). */
    action: "start" | "restore_list" | "restore_apply";
    restorePosition: number | null;
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

export interface MealBreakPriorityOverrideRecord {
    kind: "telegram_meal_break_priority_overrides";
    // v2: prioridade e justificativas indexadas por doctorId (segue o medico em
    // remanejamentos). v1 (legado): indexadas por ramal — ainda lidas e traduzidas
    // ramal->doctorId pelo roster vivo, nunca mais gravadas.
    version: 1 | 2;
    mode: MealBreakMode;
    operationalDate: string;
    orderedDoctorIds?: string[];
    orderedRamals?: string[];
    justifications: Record<string, MealBreakPriorityJustification>;
    updatedAt: string;
}

interface MealBreakEligibilityOverrideRecord {
    kind: "telegram_meal_break_eligibility_overrides";
    // v2: exclusoes de almoco/descanso indexadas por doctorId (seguem o medico no
    // remanejamento). v1 (legado): indexadas por ramal — ainda lidas como estao. Mesma
    // motivacao da prioridade v2 (resolvePriorityOverridesByDoctorId).
    version: 1 | 2;
    mode: MealBreakMode;
    operationalDate: string;
    // v2 — fonte de verdade.
    lunchExcludedDoctorIds?: string[];
    restExcludedDoctorIds?: string[];
    // Snapshot dos ramais no momento da escrita: compat com v1 e observabilidade. Nunca
    // lido quando o registro e v2 (a verdade vem dos doctorIds, resolvidos pelo board vivo).
    lunchExcludedRamals: string[];
    restExcludedRamals: string[];
    updatedAt: string;
}

export interface MealBreakPriorityContextEntry {
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
    /**
     * Quando true, o remetente NÃO deve reanexar o reply keyboard da vez a esta
     * resposta (ex.: "fora da vez" e dedupe — o teclado pertence a outra pessoa).
     */
    suppressKeyboard?: boolean;
}

/**
 * Opções de formatação dos balões de refeição: todos os textos deste módulo já
 * escapam interpolações (nomes) via escapeTelegramMarkdown, então o callsite de
 * envio pode ligar Markdown com segurança. Exportado para o service usar no
 * dispatcher sem precisar conhecer o detalhe.
 */
export const MEAL_BREAK_FORMAT_OPTIONS: TelegramFormatOptions = { parseMode: "Markdown" };

/**
 * Erro de negócio "user-facing" do fluxo de refeição: a mensagem é curada em
 * pt-BR e pode ir direto ao grupo. Qualquer outro Error é tratado como falha
 * técnica (mensagem genérica no grupo; detalhe só para o admin/log).
 */
export class MealBreakUserError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "MealBreakUserError";
    }
}

export function isMealBreakUserFacingError(error: unknown): boolean {
    return error instanceof MealBreakUserError || isMealBreakConsistencyError(error);
}

/**
 * Detalhe técnico de um erro NÃO user-facing, para alerta privado ao admin.
 * Devolve null para erros de negócio (que já foram respondidos no grupo).
 */
export function resolveMealBreakTechnicalErrorDetail(error: unknown): string | null {
    if (isMealBreakUserFacingError(error)) {
        return null;
    }
    if (error instanceof Error) {
        return `${error.name}: ${error.message}`;
    }
    return String(error);
}

const SESSION_NOTICE_STAGE = "meal_break_flow";
const AUTO_NOTICE_STAGE = "meal_break_auto";
const PRIORITY_NOTICE_STAGE = "meal_break_priority";
const SESSION_KIND = "telegram_meal_break_session";
const PRIORITY_KIND = "telegram_meal_break_priority_overrides";
const ELIGIBILITY_KIND = "telegram_meal_break_eligibility_overrides";
const ELIGIBILITY_NOTICE_STAGE = "meal_break_eligibility";
const TURN_NUDGE_NOTICE_STAGE = "meal_break_turn_nudge";
const PRIORITY_NOTICE_CHAT_ID = "operational";
// Intervalo entre as cobranças da vez: o bot escala o chamado a cada 90 segundos
// até a pessoa responder.
const MEAL_BREAK_TURN_NUDGE_INTERVAL_MS = 90 * 1000;
const MEAL_BREAK_CHIEF_USERNAME = "@chefe2031";
const MEAL_BREAK_RECENT_REGULATOR_LIMIT = 6;
const MEAL_BREAK_NUDGEABLE_STAGES: ReadonlySet<MealBreakStage> = new Set<MealBreakStage>([
    "awaiting_lunch_choice",
    "awaiting_rest_choice",
    "awaiting_night_work_choice",
    "awaiting_dinner_choice",
]);
const CHIEF_RAMAL = "2031";
const LUNCH_SLOTS: MealBreakLunchSlot[] = ["11:30", "12:30", "13:30"];
const REST_SLOTS: MealBreakRestSlot[] = ["14:30", "15:30", "16:30", "18:00"];
const DINNER_SLOTS: MealBreakDinnerSlot[] = ["20:30", "21:00", "21:30", "22:00", "22:30"];
const DINNER_CHOICE_SLOTS = ["20:30", "21:00", "21:30"] as const;
const NIGHT_WORK_SLOTS: MealBreakNightWorkSlot[] = ["23:00", "03:00"];

// All canonical slot strings produced by buildMealBreakStageKeyboard buttons.
// Used to recognise a literal button payload "NNNN HH:MM" even when the chat's
// session is already completed — protects against the button reply leaking
// into the operational parser as a false arrival.
const ALL_MEAL_BREAK_SLOTS: ReadonlySet<string> = new Set<string>([
    ...LUNCH_SLOTS,
    ...REST_SLOTS,
    ...DINNER_SLOTS,
    ...NIGHT_WORK_SLOTS,
]);

const MEAL_BREAK_BUTTON_PATTERN = /^\s*(\d{4})\s+(\d{1,2}:\d{2})\s*$/;

export function looksLikeMealBreakButtonReply(text: string): boolean {
    const match = MEAL_BREAK_BUTTON_PATTERN.exec(text);
    if (!match) {
        return false;
    }
    return ALL_MEAL_BREAK_SLOTS.has(match[2]);
}
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

// Converte a data operacional "YYYY-MM-DD" para o formato DD/MM usado nas copies.
function formatOperationalDateLabel(operationalDate: string) {
    const [, month, day] = operationalDate.split("-");
    return day && month ? `${day}/${month}` : operationalDate;
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

function resolveTurnNudgeNoticeKey(chatId: string, operationalDate: string, mode: MealBreakMode) {
    return `${chatId}:meal_break:turn_nudge:${operationalDate}:${mode}`;
}

function resolvePriorityNoticeKey(operationalDate: string, mode: MealBreakMode) {
    return `${PRIORITY_NOTICE_CHAT_ID}:meal_break:priority:${operationalDate}:${mode}`;
}

function resolveEligibilityNoticeKey(operationalDate: string, mode: MealBreakMode) {
    return `${PRIORITY_NOTICE_CHAT_ID}:meal_break:eligibility:${operationalDate}:${mode}`;
}

// Nome pronto para interpolação nos balões: os envios deste módulo usam
// parse_mode Markdown (MEAL_BREAK_FORMAT_OPTIONS), então TODO nome interpolado
// passa por escapeTelegramMarkdown aqui, no choke point de renderização.
// O roster/sessão continua guardando o nome cru.
function resolveDoctorName(value: { name: string }) {
    return escapeTelegramMarkdown(value.name.trim() || "Médico");
}

// Referência ao painel operacional nos balões: com AUTH_URL definido vira
// "painel (https://...)" — o cliente do Telegram auto-linka a URL; sem env,
// fica só "painel" (texto sem link).
export function resolveMealBreakPanelLabel() {
    const raw = process.env.AUTH_URL?.trim();
    if (!raw) {
        return "painel";
    }
    return `painel (${escapeTelegramMarkdown(raw.replace(/\/+$/, ""))})`;
}

// Glosas de jargão (1ª ocorrência por balão): o repo não define as expansões
// das siglas, então traduzimos pelo EFEITO operacional, que é verificável no
// código deste módulo (RECIP almoça 11:30/descansa 18:00; MRVs almoçam
// 12:30/13:30; COI é a dupla 1367/1368 que não pode parar junta).
const RECIP_GLOSS = "RECIP (função fixa: almoço 11:30 e descanso 18:00)";
const MRV_GLOSS = "MRV (função fixa de almoço 12:30/13:30)";
const COI_GLOSS = "COI (dupla 1367/1368)";

function isMealBreakEligibilityOverrideRecord(value: unknown): value is MealBreakEligibilityOverrideRecord {
    if (!value || typeof value !== "object") {
        return false;
    }

    const candidate = value as Record<string, unknown>;
    return candidate.kind === ELIGIBILITY_KIND
        && (candidate.version === 1 || candidate.version === 2)
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
        super("Há inconsistência na lista de médicos ativos. Preciso da lista atualizada para continuar.");
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
    const isV2 = candidate.version === 2 && Array.isArray(candidate.orderedDoctorIds);
    const isV1 = candidate.version === 1 && Array.isArray(candidate.orderedRamals);
    return candidate.kind === PRIORITY_KIND
        && (isV2 || isV1)
        && typeof candidate.operationalDate === "string"
        && typeof candidate.updatedAt === "string"
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
        reasons.push(`continua desde ${formatHour(params.continuityStartedAt)} em outro plantão`);
    }

    if (isRemoteOperationalRole(params.doctor.roleLabel) && params.priorityStartedAt !== arrivalStartedAt) {
        // Jargão traduzido na fonte (camada de refeição): RMT = cobre remoto.
        reasons.push(`função remota (RMT): entra na fila como ${formatHour(params.priorityStartedAt)}`);
    }

    if (params.doctor.roleLabel === "IES" && isRemotePriorityRegulationCode(params.doctor.ramal)) {
        reasons.push("IES declarado: conta como presencial na fila");
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

// "MR" (médico regulador) é o papel genérico padrão: no roster do almoço não é
// função especial, então o tratamos como null (sem rótulo). O contrato global de
// resolveOperationalRoleLabel continua devolvendo "MR" — esta normalização é só
// para a fila de almoço, coerente com o badges code que já ignora "MR".
function nullifyGenericRegulatorRole(roleLabel: string | null) {
    return normalizeOperationalRoleLabel(roleLabel) === "MR" ? null : roleLabel;
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

// Presencial = papel que precisa de presença física no SAMU à noite (cobre as bases).
// Por convenção operacional: COI e RMT trabalham remoto; IES não atua à noite.
// Tudo o mais (CP, MRV, RECIP, sem função declarada, etc.) é considerado presencial.
function isPresentialRole(roleLabel: string | null | undefined) {
    const normalized = normalizeOperationalRoleLabel(roleLabel);
    return normalized !== "COI" && normalized !== "RMT" && normalized !== "IES";
}

function countPresenciaisInRoster(roster: MealBreakDoctor[]): number {
    return roster.filter((doctor) => isPresentialRole(doctor.roleLabel)).length;
}

// Determina se uma escolha de slot pelo presencial deixaria o outro slot
// completamente sem cobertura presencial. Retorna o slot descoberto (a sugestão
// de redirecionamento) ou null se não há violação. Quando há só 1 presencial no
// roster total, é impossível cobrir os 2 slots → retorna null (escolha livre).
function presentialCoverageWouldBreak<T extends string>(
    session: MealBreakSession,
    choosingRamal: string,
    chosenSlot: T,
    assignments: Record<string, T>,
    queue: string[],
    slotPool: readonly T[],
): T | null {
    const chooser = session.roster.find((d) => d.ramal === choosingRamal);
    if (!chooser || !isPresentialRole(chooser.roleLabel)) return null;

    if (countPresenciaisInRoster(session.roster) < 2) return null;

    const otherSlot = slotPool.find((s) => s !== chosenSlot);
    if (!otherSlot) return null;

    const otherSlotHasPresential = session.roster.some((d) =>
        isPresentialRole(d.roleLabel)
        && d.ramal !== choosingRamal
        && assignments[d.ramal] === otherSlot,
    );
    if (otherSlotHasPresential) return null;

    const futureQueue = queue.filter((r) => r !== choosingRamal);
    const pendingPresential = futureQueue.some((r) => {
        const d = session.roster.find((doc) => doc.ramal === r);
        return Boolean(d && isPresentialRole(d.roleLabel));
    });
    if (pendingPresential) return null;

    const chosenSlotHasPresential = session.roster.some((d) =>
        isPresentialRole(d.roleLabel)
        && d.ramal !== choosingRamal
        && assignments[d.ramal] === chosenSlot,
    );
    if (!chosenSlotHasPresential) return null;

    return otherSlot;
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
        ? `⚠️ Inconsistência na fila do jantar ${formatOperationalDateLabel(error.operationalDate)}`
        : `⚠️ Inconsistência na fila do almoço ${formatOperationalDateLabel(error.operationalDate)}`;

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
    const inferredArrivalShift = resolveArrivalShiftLabel(params.startedAt);
    return inferredArrivalShift === currentShift.shiftLabel
        ? currentShift.shiftLabel
        : "P";
}

/** Por que um ramal ativo do quadro fica fora da divisão. `fixed_post` (PIAM/
 *  NUCLEO) e `half_shift` (MEIO plantão) são regra fixa: nem participam nem
 *  interferem no cálculo das vagas. */
export type MealBreakOutOfDivisionReason = "inactive" | "fixed_post" | "other_shift" | "half_shift";

type MealBreakBoardEntry =
    | { kind: "doctor"; doctor: MealBreakRosterDoctor }
    | { kind: "excluded"; reason: MealBreakOutOfDivisionReason; ramal: string; name: string };

function mapRegulationBoardEntry(row: OperationalBoard["regulation"][number], mode: MealBreakMode, referenceAt: Date): MealBreakBoardEntry {
    const ramal = normalizeRamal(row.postCode);
    const name = formatDoctorSurfaceName({
        fullName: row.doctorName,
        displayName: row.displayName,
        fallback: row.postCode,
    });

    if (row.status !== "active" || !row.doctorId || !row.startedAt) {
        return { kind: "excluded", reason: "inactive", ramal, name };
    }

    // PIAM e NUCLEO nunca participam de divisao (almoco/jantar/descanso/trabalho noturno),
    // em qualquer modo. Sao postos fora do esquema de prioridade ordenada.
    if (isPiamRegulationPost(row.postCode) || isNucleoRegulationPost(row.postCode)) {
        return { kind: "excluded", reason: "fixed_post", ramal, name };
    }

    const effectiveShiftLabel = resolveMealBreakDoctorShiftLabel({
        startedAt: row.startedAt,
        shiftLabel: row.shiftLabel,
        referenceAt,
    });

    if (mode === "day" && effectiveShiftLabel === "SN") {
        return { kind: "excluded", reason: "other_shift", ramal, name };
    }

    if (mode === "night" && effectiveShiftLabel === "SD") {
        return { kind: "excluded", reason: "other_shift", ramal, name };
    }

    const roleLabel = nullifyGenericRegulatorRole(resolveOperationalRoleLabel({
        domain: "regulation",
        code: ramal,
        shiftLabel: effectiveShiftLabel,
        roleLabel: row.roleLabel,
        defaultRole: row.defaultRole,
    }));

    // MEIO plantão (janela 11:30–17:00) segue a mesma regra fixa de PIAM/NUCLEO:
    // não participa nem interfere na divisão — não entra na fila, não consome
    // vaga e não muda a capacidade dos horários de ninguém (decisão do usuário,
    // 04/08/2026). Sai como "excluído", e não como linha inexistente, para o bot
    // conseguir avisar QUEM ficou de fora e POR QUE: se a função estiver errada,
    // a chefia troca no painel e reinicia a divisão.
    if (isHalfShiftRoleLabel(roleLabel)) {
        return { kind: "excluded", reason: "half_shift", ramal, name };
    }

    return {
        kind: "doctor",
        doctor: {
            doctorId: row.doctorId,
            occupancyId: row.occupancyId,
            ramal,
            name,
            domain: "regulation",
            arrivalStartedAt: row.startedAt,
            startedAt: row.boardStartedAt ?? row.startedAt,
            shiftLabel: effectiveShiftLabel,
            roleLabel,
        },
    };
}

function mapRegulationDoctor(row: OperationalBoard["regulation"][number], mode: MealBreakMode, referenceAt: Date): MealBreakRosterDoctor | null {
    const entry = mapRegulationBoardEntry(row, mode, referenceAt);
    return entry.kind === "doctor" ? entry.doctor : null;
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

function shouldExcludeRamalFromMealBreak(ramal: string) {
    return isPiamRegulationPost(ramal) || isNucleoRegulationPost(ramal);
}

function sanitizeMealBreakRosterForMode(roster: MealBreakDoctor[], _mode: MealBreakMode) {
    return roster.filter((doctor) => !shouldExcludeRamalFromMealBreak(doctor.ramal));
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
        chiefPins: {
            ...emptyMealBreakChiefPins(),
            ...(sanitizedSession.chiefPins ?? {}),
        },
    };

    return mode === "night" ? syncNightSessionState(hydrated) : syncDaySessionState(hydrated);
}

function resolveNightDinnerDuration(doctor: MealBreakDoctor): MealBreakDinnerDuration {
    // Quem dobra desde a manhã janta 1h — decidido pela ÂNCORA da cadeia
    // (arrivalStartedAt/startedAt do roster já apontam a chegada original),
    // não pelo rótulo: a continuação explícita cria bloco "SN" com âncora de
    // manhã, e o rótulo "P" acidental que dava 1h por engano deixou de existir
    // (reforço repetido não rebatiza mais o bloco).
    const arrivalStartedAt = doctor.arrivalStartedAt ?? doctor.startedAt;
    return resolveArrivalShiftLabel(arrivalStartedAt) === "SD"
        ? "one_hour"
        : "half_hour";
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

function resolveSPMinutesOfDay(isoString: string): number {
    const parts = new Intl.DateTimeFormat("pt-BR", {
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
        timeZone: "America/Sao_Paulo",
    }).formatToParts(new Date(isoString));
    const hour = parseInt(parts.find((p) => p.type === "hour")?.value ?? "0", 10);
    const minute = parseInt(parts.find((p) => p.type === "minute")?.value ?? "0", 10);
    return hour * 60 + minute;
}

function resolveUnavailableDinnerChoiceSlots(createdAt: string): Set<(typeof DINNER_CHOICE_SLOTS)[number]> {
    const minutesOfDay = resolveSPMinutesOfDay(createdAt);
    const unavailable = new Set<(typeof DINNER_CHOICE_SLOTS)[number]>();
    if (minutesOfDay >= 20 * 60 + 15) {
        unavailable.add("20:30");
    }
    if (minutesOfDay >= 20 * 60 + 45) {
        unavailable.add("21:00");
    }
    return unavailable;
}


function resolveDinnerChoiceCapacities(totalDoctors: number, unavailableSlots: Set<(typeof DINNER_CHOICE_SLOTS)[number]> = new Set()) {
    const availableSlots = DINNER_CHOICE_SLOTS.filter((s) => !unavailableSlots.has(s));
    const capacities = {
        "20:30": 0,
        "21:00": 0,
        "21:30": 0,
    } satisfies Record<(typeof DINNER_CHOICE_SLOTS)[number], number>;

    if (availableSlots.length === 0) {
        return capacities;
    }

    const base = Math.floor(totalDoctors / availableSlots.length);
    const remainder = totalDoctors % availableSlots.length;
    for (const slot of availableSlots) {
        capacities[slot] = base;
    }

    const priority = (["20:30", "21:30", "21:00"] as const).filter((s) => !unavailableSlots.has(s));
    for (let index = 0; index < remainder; index += 1) {
        const slot = priority[index];
        if (slot) {
            capacities[slot] += 1;
        }
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
            ? ["", "👑 CHEFIA", "• A critério"]
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
        ? ["", "👑 CHEFIA", "• Almoço a critério", "• Descanso a critério"]
        : [];
    const lunchExcluded = buildExcludedSummaryBlock("🚫 FORA DO ALMOÇO", session, session.lunchExcludedRamals);
    const restExcluded = buildExcludedSummaryBlock("🚫 FORA DO DESCANSO", session, session.restExcludedRamals);

    return [
        "🍽️ ALMOÇO",
        ...lunchLines,
        ...lunchExcluded,
        "",
        "😴 DESCANSO",
        ...restLines,
        ...restExcluded,
        ...tail,
    ].join("\n");
}

function formatAvailableSlotEntry(slot: string, remaining: number) {
    return `*${slot}* (${remaining} vaga${remaining > 1 ? "s" : ""})`;
}

function buildAvailableLunchText(session: MealBreakSession) {
    const remaining = resolveRemainingLunchSlots(session);
    return LUNCH_SLOTS
        .filter((slot) => remaining[slot] > 0)
        .map((slot) => formatAvailableSlotEntry(slot, remaining[slot]))
        .join(" · ");
}

function buildAvailableRestText(session: MealBreakSession) {
    const remaining = resolveRemainingRestChoiceSlots(session);
    return (["15:30", "16:30"] as const)
        .filter((slot) => remaining[slot] > 0)
        .map((slot) => formatAvailableSlotEntry(slot, remaining[slot]))
        .join(" · ");
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
        .map((slot) => formatAvailableSlotEntry(slot, remaining[slot]))
        .join(" · ");
}

function buildAvailableDinnerText(session: MealBreakSession) {
    const remaining = resolveRemainingDinnerChoiceSlots(session);
    return DINNER_CHOICE_SLOTS
        .filter((slot) => remaining[slot] > 0)
        .map((slot) => formatAvailableSlotEntry(slot, remaining[slot]))
        .join(" · ");
}

export function buildMealBreakStageKeyboard(session: MealBreakSession): TelegramReplyMarkup | null {
    const undoRow = session.undoSnapshots.length > 0 ? [UNDO_TEXT] : [];

    if (session.stage === "awaiting_confirmation") {
        return buildChoiceKeyboard([[CONFIRM_TEXT]]);
    }

    if (session.stage === "awaiting_mrv_lunch") {
        if (session.mrvRamals.length < 2) {
            const candidateRows = chunkChoices(resolveManualMrvCandidateRamals(session), 4);
            const rows = [...candidateRows];
            if (undoRow.length > 0) rows.push(undoRow);
            return rows.length > 0 ? buildChoiceKeyboard(rows) : null;
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
    return `Primeiro, informem o RAMAL ou nome do médico ${RECIP_GLOSS}.`;
}

// Escalada de cobrança quando a pessoa da vez não respondeu. Cada mensagem tem
// uma única linha, nome em negrito e linguagem visual diferente da anterior.
// A partir da terceira, convoca reguladores recentes para telefonar ao colega.
export function buildMealBreakTurnNudgeMessage(
    session: MealBreakSession,
    count: number,
    recentRegulatorMentions: Array<string | MealBreakTelegramMention> = [],
    targetMention: string | MealBreakTelegramMention | null = null,
) {
    const currentRamal = resolveStageChoiceQueue(session)[0];
    if (!currentRamal) {
        return buildCurrentPrompt(session);
    }
    const name = escapeTelegramMarkdown(resolveDoctorCompactName(findDoctor(session, currentRamal) ?? { name: currentRamal }));
    const boldName = `*${name}*`;
    const safeTargetMention = formatMealBreakTelegramMention(targetMention);
    const targetLabel = safeTargetMention ? `${safeTargetMention} (${boldName})` : boldName;

    if (count <= 1) {
        return safeTargetMention
            ? `⏳ ${safeTargetMention} — ${boldName}, sua vez chegou; escolha um horário nos botões para a fila andar.`
            : `⏳ ${boldName}, sua vez chegou — escolha um horário nos botões para a fila andar.`;
    }

    if (count === 2) {
        return `📞 ${MEAL_BREAK_CHIEF_USERNAME}, consegue ligar para ${targetLabel}? A divisão está parada esperando a resposta.`;
    }

    const safeMentions = recentRegulatorMentions
        .map(formatMealBreakTelegramMention)
        .filter((mention): mention is string => Boolean(mention))
        .filter((mention) => !mention.toLowerCase().includes("@chefe2031"))
        .slice(0, MEAL_BREAK_RECENT_REGULATOR_LIMIT);
    const audience = safeMentions.length > 0 ? safeMentions.join(" ") : "Pessoal da regulação";
    const collectiveTemplates = [
        `🚨 ${audience}: missão relâmpago #${count} — alguém liga para ${targetLabel} e pede a resposta no bot?`,
        `🩺 Busca ativa #${count}: ${audience}, quem localizar ${targetLabel} primeiro liga e destrava a fila.`,
        `☎️ Corrente do ramal #${count} — ${audience}, passem o chamado até ${targetLabel} escolher o horário.`,
        `🛰️ Sinal procurando ${targetLabel} na rodada #${count}: ${audience}, deem um toque por telefone.`,
        `🎯 Desafio #${count} para ${audience}: encontrar ${targetLabel}, ligar e trazer a resposta para o bot.`,
        `📣 Central da regulação, chamada #${count}: ${audience}, precisamos de contato telefônico com ${targetLabel}.`,
    ];
    return collectiveTemplates[(count - 3) % collectiveTemplates.length]!;
}

/**
 * Slot de exemplo da convocação/recusa: varia de forma DETERMINÍSTICA pela
 * posição da fila (seed % vagas) para não induzir aglomeração no primeiro
 * horário — sem aleatoriedade, então os testes não ficam flaky.
 */
export function pickMealBreakExampleSlot<TSlot extends string>(availableSlots: readonly TSlot[], seed: number): TSlot | null {
    if (availableSlots.length === 0) {
        return null;
    }
    const size = availableSlots.length;
    const index = ((seed % size) + size) % size;
    return availableSlots[index] ?? null;
}

// Anúncio "é a vez de FULANO": nome na 1ª linha (a dor nº1 do fluxo era o nome
// da vez enterrado), horários livres preservados (o teclado atual depende do
// payload "RAMAL HH:MM" — os botões NÃO mudam) e prévia de quem vem depois.
function buildTurnAnnouncement(params: {
    ramal: string;
    name: string;
    mealLabel: string;
    emoji: string;
    available: string;
    exampleSlot: string | null;
    nextName: string | null;
    remainingInQueue: number;
}) {
    const { ramal, name, mealLabel, emoji, available, exampleSlot, nextName, remainingInQueue } = params;
    const lines = [
        `${emoji} *É a vez de ${name}* — ramal *${ramal}*`,
        exampleSlot
            ? `Escolha o ${mealLabel} nos botões, ou responda: \`${ramal} ${exampleSlot}\``
            : `Escolha o ${mealLabel} nos botões.`,
    ];
    if (available) {
        lines.push(`Livres: ${available}`);
    }
    lines.push(
        remainingInQueue > 1 && nextName
            ? `⏭️ Depois: ${nextName} · faltam ${remainingInQueue - 1}`
            : "⏭️ Falta só você na fila.",
    );
    return lines.join("\n");
}

/**
 * Posição (1-based) de um ramal na fila do estágio atual da sessão, calculada
 * pelo RAMAL digitado (não há vínculo telegram↔médico). Null quando o ramal
 * não está na fila desta etapa.
 */
export function resolveMealBreakQueuePosition(session: MealBreakSession, ramal: string): number | null {
    const queue = resolveStageChoiceQueue(session);
    const index = queue.indexOf(normalizeRamal(ramal));
    return index >= 0 ? index + 1 : null;
}

// Resposta para escolha fora da vez: diz quem é a vez AGORA e a posição de quem
// digitou (pelo ramal informado), com fallback claro quando o ramal não está na
// fila. Enviada SEM teclado (suppressKeyboard) — o teclado pertence à vez atual.
function buildWaitYourTurnMessage(session: MealBreakSession, currentRamal: string | null, attemptedRamal?: string | null) {
    if (!currentRamal) {
        return "Calma! A divisão está sendo finalizada, já te aviso.";
    }
    const name = resolveDoctorCompactName(findDoctor(session, currentRamal) ?? { name: currentRamal });
    const lead = `⛔ Ainda não é sua vez — agora é *${name}* (${currentRamal}).`;
    const position = attemptedRamal ? resolveMealBreakQueuePosition(session, attemptedRamal) : null;
    if (position && position > 1) {
        return `${lead} Você é o *${position}º* da fila; eu te chamo.`;
    }
    if (attemptedRamal) {
        return `${lead} O ramal ${normalizeRamal(attemptedRamal)} não está na fila desta etapa — confira o número ou fale com a chefia.`;
    }
    return `${lead} Eu te chamo quando chegar a sua vez.`;
}

/**
 * Escolha idêntica já registrada (mesmo ramal → mesmo horário) em qualquer fase
 * do modo atual. Base do ack de dedupe: repetição não pode virar silêncio nem
 * vazar para o parser de chegada.
 */
export function findMealBreakDuplicateChoice(
    session: MealBreakSession,
    ramal: string,
    slot: string,
): { kind: "lunch" | "rest" | "night_work" | "dinner" } | null {
    const normalizedRamal = normalizeRamal(ramal);
    if (session.mode === "day") {
        if (session.lunchAssignments[normalizedRamal] === slot) {
            return { kind: "lunch" };
        }
        if (session.restAssignments[normalizedRamal] === slot) {
            return { kind: "rest" };
        }
        return null;
    }
    if (session.nightWorkAssignments[normalizedRamal] === slot) {
        return { kind: "night_work" };
    }
    if (session.dinnerAssignments[normalizedRamal] === slot) {
        return { kind: "dinner" };
    }
    return null;
}

function buildMealBreakDuplicateChoiceReply(ramal: string, slot: string) {
    return `✅ Já anotei *${normalizeRamal(ramal)} → ${slot}*. Não precisa reenviar.`;
}

/**
 * Recusas de escolha em 2 moldes fixos, sempre com o ramal REAL da vez e um
 * horário livre copiável. Distingue formato inválido, horário que não existe
 * nesta fase e horário lotado.
 */
export function buildMealBreakChoiceRejection(params: {
    kind: "format" | "slot_not_in_phase" | "slot_full";
    slot?: string | null;
    queueHead: string | null;
    queueLength: number;
    availableText: string;
    availableSlots: readonly string[];
}): string {
    const example = pickMealBreakExampleSlot(params.availableSlots, params.queueLength);
    const replyHint = params.queueHead && example ? `Responda: \`${params.queueHead} ${example}\`` : null;
    if (params.kind === "format") {
        return ["⛔ Não entendi.", replyHint].filter(Boolean).join(" ");
    }
    const slotLabel = params.slot ? `*${params.slot}*` : "Esse horário";
    const freeSuffix = params.availableText ? ` Livres: ${params.availableText}.` : "";
    const lead = params.kind === "slot_full"
        ? `⛔ ${slotLabel} lotou.${freeSuffix}`
        : `⛔ ${slotLabel} não vale nesta fase.${freeSuffix}`;
    return [lead, replyHint].filter(Boolean).join(" ");
}

function resolveQueueNextName(session: MealBreakSession, queue: string[]) {
    const nextRamal = queue[1] ?? null;
    if (!nextRamal) {
        return null;
    }
    return resolveDoctorCompactName(findDoctor(session, nextRamal) ?? { name: nextRamal });
}

function buildNightWorkQueuePrompt(session: MealBreakSession) {
    const currentRamal = session.nightWorkQueue[0] ?? null;
    if (!currentRamal) {
        return "Não há mais escolhas de trabalho pendentes.";
    }

    const doctor = findDoctor(session, currentRamal);
    const name = resolveDoctorCompactName(doctor ?? { name: currentRamal });
    const remaining = resolveRemainingNightWorkSlots(session);
    const availableSlots = NIGHT_WORK_SLOTS.filter((slot) => remaining[slot] > 0);
    return buildTurnAnnouncement({
        ramal: currentRamal,
        name,
        mealLabel: "trabalho noturno",
        emoji: "🌙",
        available: buildAvailableNightWorkText(session),
        exampleSlot: pickMealBreakExampleSlot(availableSlots, session.nightWorkQueue.length),
        nextName: resolveQueueNextName(session, session.nightWorkQueue),
        remainingInQueue: session.nightWorkQueue.length,
    });
}

function buildNightDinnerQueuePrompt(session: MealBreakSession) {
    const currentRamal = session.dinnerQueue[0] ?? null;
    if (!currentRamal) {
        return "Não há mais escolhas de jantar pendentes.";
    }

    const doctor = findDoctor(session, currentRamal);
    const name = resolveDoctorCompactName(doctor ?? { name: currentRamal });
    const duration = session.dinnerDurationAssignments[currentRamal] === "one_hour" ? "1h" : "30min";
    const remaining = resolveRemainingDinnerChoiceSlots(session);
    const availableSlots = DINNER_CHOICE_SLOTS.filter((slot) => remaining[slot] > 0);
    return buildTurnAnnouncement({
        ramal: currentRamal,
        name,
        mealLabel: `jantar (${duration})`,
        emoji: "🍽️",
        available: buildAvailableDinnerText(session),
        exampleSlot: pickMealBreakExampleSlot(availableSlots, session.dinnerQueue.length),
        nextName: resolveQueueNextName(session, session.dinnerQueue),
        remainingInQueue: session.dinnerQueue.length,
    });
}

function buildNightStartPrompt(session: MealBreakSession) {
    return [
        `🌙 Chefia 2031 a critério`,
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
        return "Não há mais escolhas de almoço pendentes.";
    }

    const doctor = findDoctor(session, currentRamal);
    const name = resolveDoctorCompactName(doctor ?? { name: currentRamal });
    const remaining = resolveRemainingLunchSlots(session);
    const availableSlots = LUNCH_SLOTS.filter((slot) => remaining[slot] > 0);
    return buildTurnAnnouncement({
        ramal: currentRamal,
        name,
        mealLabel: "almoço",
        emoji: "🍽️",
        available: buildAvailableLunchText(session),
        exampleSlot: pickMealBreakExampleSlot(availableSlots, session.lunchQueue.length),
        nextName: resolveQueueNextName(session, session.lunchQueue),
        remainingInQueue: session.lunchQueue.length,
    });
}

function buildRestQueuePrompt(session: MealBreakSession) {
    const currentRamal = session.restQueue[0] ?? null;
    if (!currentRamal) {
        return "Não há mais escolhas de descanso pendentes.";
    }

    const doctor = findDoctor(session, currentRamal);
    const name = resolveDoctorCompactName(doctor ?? { name: currentRamal });
    const remaining = resolveRemainingRestChoiceSlots(session);
    const availableSlots = (["15:30", "16:30"] as const).filter((slot) => remaining[slot] > 0);
    return buildTurnAnnouncement({
        ramal: currentRamal,
        name,
        mealLabel: "descanso",
        emoji: "😴",
        available: buildAvailableRestText(session),
        exampleSlot: pickMealBreakExampleSlot(availableSlots, session.restQueue.length),
        nextName: resolveQueueNextName(session, session.restQueue),
        remainingInQueue: session.restQueue.length,
    });
}

function buildExistingSessionReply(session: MealBreakSession) {
    if (session.stage === "awaiting_confirmation") {
        return buildConfirmationPrompt(session);
    }

    const intro = session.stage === "completed"
        ? "Já existe uma divisão fechada hoje."
        : "Já existe uma divisão em andamento hoje.";
    const nextStep = session.stage === "completed"
        ? `Se quiser reiniciar, mande /${session.mode === "night" ? "jantar" : "almoco"} reiniciar.`
        : `${buildCurrentPrompt(session)}\n\nSe quiser reiniciar, mande /${session.mode === "night" ? "jantar" : "almoco"} reiniciar.`;

    return [intro, "", buildSessionSummary(session), "", nextStep].join("\n");
}

function buildConfirmationPrompt(session: MealBreakSession) {
    const mode = session.mode;
    const label = mode === "night" ? "jantar" : "almoço";
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
            "Fora da divisão:",
            ...isolatedDoctors.map((doctor) => `${resolveDoctorCompactName(doctor)} · ${doctor.ramal} · PSIQ · almoça 12:30 e descansa 18:00`),
        ]
        : [];
    const restartCmd = mode === "night" ? "/jantar reiniciar" : "/almoco reiniciar";

    const presentialNotice: string[] = [];
    if (mode === "night") {
        const presenciais = session.roster.filter((d) => isPresentialRole(d.roleLabel));
        if (presenciais.length < 5) {
            const presList = presenciais.length > 0
                ? presenciais.map((d) => `• ${resolveDoctorCompactName(d)} · ${d.ramal}`).join("\n")
                : "(nenhum identificado)";
            presentialNotice.push(
                "",
                `🛡️ Cobertura presencial — ${presenciais.length} ${presenciais.length === 1 ? "presencial" : "presenciais"} (não COI, não RMT, não IES):`,
                presList,
                "Garanto 1 presencial em cada horário (23:00 e 03:00) — se uma escolha quebrar isso, eu remanejo.",
            );
        }
    }

    return [
        mode === "night" ? "🌙 DIVISÃO DO JANTAR" : "☀️ DIVISÃO DO ALMOÇO",
        "",
        "Ordem de prioridade:",
        ...priority,
        ...isolated,
        ...presentialNotice,
        "",
        `Confirme para iniciar a divisão de ${label}.`,
        `Se os horários de chegada estão errados, ajuste pelo ${resolveMealBreakPanelLabel()} e mande ${restartCmd}.`,
    ].join("\n");
}

/**
 * Aviso de quem ficou fora da divisão por estar como MEIO plantão. É a única
 * exclusão fixa que nasce de um dado editável (a função no quadro), então o
 * balão sempre diz o caminho da correção: trocar a função no painel logado e
 * reiniciar a divisão. PIAM/NUCLEO não entram aqui — lá o posto é a regra.
 */
function buildHalfShiftOutOfDivisionNotice(params: {
    excluded: Array<{ ramal: string; name: string }>;
    mode: MealBreakMode;
}) {
    if (params.excluded.length === 0) {
        return null;
    }

    const mealLabel = params.mode === "night" ? "jantar" : "almoço";
    const restartCmd = params.mode === "night" ? "/jantar reiniciar" : "/almoco reiniciar";
    return [
        `ℹ️ Fora da divisão do ${mealLabel} por estar como *MEIO plantão*:`,
        ...params.excluded.map((doctor) => `• ${resolveDoctorCompactName(doctor)} · ${doctor.ramal}`),
        `Meio plantão não participa nem muda as vagas dos horários (mesma regra fixa de PIAM e NÚCLEO). Se a função estiver errada, corrija no ${resolveMealBreakPanelLabel()} e mande ${restartCmd}.`,
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

        return "Divisão encerrada.";
    }

    if (session.stage === "awaiting_recip") {
        return buildDayStartPrompt();
    }
    if (session.stage === "awaiting_mrv_lunch") {
        if (session.mrvRamals.length < 2) {
            const missingCount = 2 - session.mrvRamals.length;
            const knownMrvs = session.mrvRamals.length > 0
                ? [
                    "MRVs já identificados:",
                    ...session.mrvRamals.map((ramal) => `• ${renderDoctorCompactSummary(session, ramal)}`),
                    "",
                ]
                : [];
            return [
                `⚠️ Não identifiquei os 2 ${MRV_GLOSS} ativos. Falta${missingCount > 1 ? "m" : ""} ${missingCount}.`,
                `Adicione no ${resolveMealBreakPanelLabel()} e mande /almoco reiniciar, ou responda com o RAMAL do MRV faltante.`,
                "",
                ...knownMrvs,
                "Responda com um RAMAL ativo para registrar como MRV.",
            ].join("\n");
        }
        const doctors = session.mrvRamals.map((ramal) => {
            const doc = findDoctor(session, ramal);
            return `${ramal} · ${resolveDoctorCompactName(doc ?? { name: ramal })}`;
        });
        return [
            `🍽️ Qual ${MRV_GLOSS} almoça *12:30*?`,
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

    return "Divisão encerrada.";
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

export /**
 * Reaplica as fixações da chefia DEPOIS de toda a lógica automática e recalcula
 * as filas em cima do resultado. É o último passo do sync de propósito: as
 * regras anteriores podem ter apagado ou remanejado o horário fixado, e a
 * fixação tem que sobreviver a todas elas (autoridade absoluta do painel).
 */
function applyMealBreakChiefPins(session: MealBreakSession): MealBreakSession {
    const pins = session.chiefPins;
    if (!pins) {
        return session;
    }

    const rosterRamals = new Set(session.roster.map((doctor) => doctor.ramal));
    const pinnedIn = <TSlot extends string>(source: Record<string, TSlot>) =>
        Object.entries(source).filter(([ramal]) => rosterRamals.has(ramal));

    const lunchPins = pinnedIn(pins.lunch ?? {});
    const restPins = pinnedIn(pins.rest ?? {});
    const nightWorkPins = pinnedIn(pins.nightWork ?? {});
    const dinnerPins = pinnedIn(pins.dinner ?? {});
    if (lunchPins.length + restPins.length + nightWorkPins.length + dinnerPins.length === 0) {
        return session;
    }

    const lunchAssignments = { ...session.lunchAssignments, ...Object.fromEntries(lunchPins) };
    const restAssignments = { ...session.restAssignments, ...Object.fromEntries(restPins) };
    const nightWorkAssignments = { ...session.nightWorkAssignments, ...Object.fromEntries(nightWorkPins) };
    const dinnerAssignments = { ...session.dinnerAssignments, ...Object.fromEntries(dinnerPins) };

    // Quem foi fixado sai das filas de pendência — já tem horário por decisão da
    // chefia, não pode continuar sendo cobrado a escolher.
    const lunchQueue = session.lunchQueue.filter((ramal) => !lunchAssignments[ramal]);
    const restQueue = session.restQueue.filter((ramal) => !restAssignments[ramal]);
    const nightWorkQueue = session.nightWorkQueue.filter((ramal) => !nightWorkAssignments[ramal]);
    const dinnerQueue = session.dinnerQueue.filter((ramal) => !dinnerAssignments[ramal]);

    const stage = session.stage === "awaiting_confirmation"
        ? "awaiting_confirmation"
        : session.mode === "night"
            ? (nightWorkQueue.length > 0
                ? "awaiting_night_work_choice"
                : dinnerQueue.length > 0 ? "awaiting_dinner_choice" : "completed")
            : (!session.recipRamal
                ? "awaiting_recip"
                : !session.mrvLunch1230Ramal
                    ? "awaiting_mrv_lunch"
                    : lunchQueue.length > 0
                        ? "awaiting_lunch_choice"
                        : restQueue.length > 0
                            ? "awaiting_rest_choice"
                            : "completed");

    return {
        ...session,
        lunchAssignments,
        restAssignments,
        nightWorkAssignments,
        dinnerAssignments,
        lunchQueue,
        restQueue,
        nightWorkQueue,
        dinnerQueue,
        stage,
    } satisfies MealBreakSession;
}

// As fixações da chefia entram DEPOIS de todo o resto — ver
// applyMealBreakChiefPins. Qualquer caminho que sincronize a sessão passa por
// aqui, então não existe rota que desfaça o clique do painel.
export function syncDaySessionState(session: MealBreakSession) {
    return applyMealBreakChiefPins(syncDaySessionStateCore(session));
}

export function syncNightSessionState(session: MealBreakSession) {
    return applyMealBreakChiefPins(syncNightSessionStateCore(session));
}

function syncDaySessionStateCore(session: MealBreakSession) {
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

    const mrvPhaseComplete = Boolean(session.mrvLunch1230Ramal);
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
                : !mrvPhaseComplete
                    ? "awaiting_mrv_lunch"
                    : lunchQueue.length > 0
                        ? "awaiting_lunch_choice"
                        : restQueue.length > 0
                            ? "awaiting_rest_choice"
                            : "completed",
    } satisfies MealBreakSession;
}

function syncNightSessionStateCore(session: MealBreakSession) {
    const dinnerDurationAssignments = Object.fromEntries(
        session.roster.map((doctor) => [doctor.ramal, resolveNightDinnerDuration(doctor)]),
    ) as Record<string, MealBreakDinnerDuration>;

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

    // Quando só 21:30 está disponível (sessão iniciada >= 20:45), auto-atribui 21:30 para
    // todos os trabalhadores das 23:00 sem jantar atribuído.
    const unavailableSlots = resolveUnavailableDinnerChoiceSlots(session.createdAt);
    if (unavailableSlots.has("20:30") && unavailableSlots.has("21:00")) {
        for (const ramal of work2300) {
            if (!dinnerAssignments[ramal]) {
                dinnerAssignments[ramal] = "21:30";
            }
        }
    }

    const dinnerQueue = work2300
        .filter((ramal) => !dinnerAssignments[ramal])
        .sort((left, right) => compareNightQueue(session, left, right));

    return {
        ...session,
        dinnerDurationAssignments,
        nightWorkAssignments,
        dinnerAssignments,
        nightWorkCapacities: resolveNightWorkCapacities(session.roster.length),
        dinnerChoiceCapacities: resolveDinnerChoiceCapacities(work2300.length, unavailableSlots),
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

// Mapeia o board vivo nos dois sentidos doctorId<->ramal (apenas regulacao ativa). E a
// base para tudo que precisa "seguir o medico": reconciliacao de ramais da sessao e
// traducao das exclusoes de elegibilidade v2 (doctorId) para o ramal atual.
function buildBoardRamalMaps(board: OperationalBoard) {
    const ramalByDoctorId = new Map<string, string>();
    const doctorIdByRamal = new Map<string, string>();
    for (const row of board.regulation) {
        if (row.status !== "active" || !row.doctorId) {
            continue;
        }
        const ramal = normalizeRamal(row.postCode);
        ramalByDoctorId.set(row.doctorId, ramal);
        doctorIdByRamal.set(ramal, row.doctorId);
    }
    return { ramalByDoctorId, doctorIdByRamal };
}

// Exclusoes de almoco/descanso pertencem ao MEDICO (doctorId, v2): traduzidas para o ramal
// ATUAL pelo board vivo, entao seguem o remanejamento. Registros v1 (legado) devolvem os
// ramais gravados como estao (melhor esforco). Pura e testavel — trava o comportamento no CI.
export function resolveMealBreakEligibilityExclusions(
    overrides: MealBreakEligibilityOverrideRecord | null,
    ramalByDoctorId: Map<string, string>,
): { lunchExcludedRamals: string[]; restExcludedRamals: string[] } {
    if (!overrides) {
        return { lunchExcludedRamals: [], restExcludedRamals: [] };
    }

    const isV2 = overrides.version === 2
        || Array.isArray(overrides.lunchExcludedDoctorIds)
        || Array.isArray(overrides.restExcludedDoctorIds);
    if (!isV2) {
        return {
            lunchExcludedRamals: overrides.lunchExcludedRamals ?? [],
            restExcludedRamals: overrides.restExcludedRamals ?? [],
        };
    }

    const toRamals = (doctorIds: string[] | undefined) => [
        ...new Set(
            (doctorIds ?? [])
                .map((doctorId) => ramalByDoctorId.get(doctorId))
                .filter((ramal): ramal is string => Boolean(ramal)),
        ),
    ];
    return {
        lunchExcludedRamals: toRamals(overrides.lunchExcludedDoctorIds),
        restExcludedRamals: toRamals(overrides.restExcludedDoctorIds),
    };
}

// doctorIds atualmente excluidos: direto se v2; traduzidos ramal->doctorId pelo board atual
// se v1 (legado, melhor esforco). Usado na escrita para acumular sobre o registro anterior.
function resolveExcludedDoctorIdSet(
    overrides: MealBreakEligibilityOverrideRecord | null,
    kind: "lunch" | "rest",
    doctorIdByRamal: Map<string, string>,
): Set<string> {
    if (!overrides) {
        return new Set();
    }

    const doctorIds = kind === "lunch" ? overrides.lunchExcludedDoctorIds : overrides.restExcludedDoctorIds;
    if (Array.isArray(doctorIds)) {
        return new Set(doctorIds);
    }

    const ramals = kind === "lunch" ? overrides.lunchExcludedRamals : overrides.restExcludedRamals;
    return new Set(
        (ramals ?? [])
            .map((ramal) => doctorIdByRamal.get(normalizeRamal(ramal)))
            .filter((doctorId): doctorId is string => Boolean(doctorId)),
    );
}

// Remanejamento ou troca voluntaria de ramal: as atribuicoes de almoco/descanso/jantar/
// trabalho noturno pertencem ao MEDICO (doctorId), nao a posicao. Aqui detectamos, pelo
// doctorId, quando o ramal vivo no board difere do ramal gravado na sessao e re-mapeamos
// TODAS as estruturas indexadas por ramal, para que o horario siga o medico mesmo quando
// ele muda de ramal. Mesma motivacao da prioridade v2 (resolvePriorityOverridesByDoctorId).
export function reconcileMealBreakSessionRamalsWithBoard(params: {
    session: MealBreakSession;
    board: OperationalBoard;
}): MealBreakSession {
    const { ramalByDoctorId: liveRamalByDoctorId } = buildBoardRamalMaps(params.board);

    const oldToNew = new Map<string, string>();
    for (const doctor of params.session.roster) {
        const liveRamal = liveRamalByDoctorId.get(doctor.doctorId);
        if (liveRamal && liveRamal !== doctor.ramal) {
            oldToNew.set(doctor.ramal, liveRamal);
        }
    }

    if (oldToNew.size === 0) {
        return params.session;
    }

    const remapRamal = (ramal: string) => oldToNew.get(ramal) ?? ramal;
    const remapNullableRamal = (ramal: string | null) => (ramal ? remapRamal(ramal) : ramal);
    const remapList = (ramals: string[]) => ramals.map(remapRamal);
    const remapRecord = <T,>(record: Record<string, T>) => {
        const next: Record<string, T> = {};
        for (const [ramal, value] of Object.entries(record)) {
            next[remapRamal(ramal)] = value;
        }
        return next;
    };
    const remapSnapshot = (snapshot: MealBreakUndoSnapshot): MealBreakUndoSnapshot => ({
        ...snapshot,
        recipRamal: remapNullableRamal(snapshot.recipRamal),
        mrvRamals: remapList(snapshot.mrvRamals),
        mrvLunch1230Ramal: remapNullableRamal(snapshot.mrvLunch1230Ramal),
        lunchAssignments: remapRecord(snapshot.lunchAssignments),
        restAssignments: remapRecord(snapshot.restAssignments),
        nightWorkAssignments: remapRecord(snapshot.nightWorkAssignments),
        dinnerAssignments: remapRecord(snapshot.dinnerAssignments),
    });

    const remapped: MealBreakSession = {
        ...params.session,
        roster: params.session.roster.map((doctor) => {
            const nextRamal = remapRamal(doctor.ramal);
            return nextRamal === doctor.ramal ? doctor : { ...doctor, ramal: nextRamal };
        }),
        chiefRamal: remapNullableRamal(params.session.chiefRamal),
        recipRamal: remapNullableRamal(params.session.recipRamal),
        mrvRamals: remapList(params.session.mrvRamals),
        mrvLunch1230Ramal: remapNullableRamal(params.session.mrvLunch1230Ramal),
        lunchAssignments: remapRecord(params.session.lunchAssignments),
        lunchExcludedRamals: remapList(params.session.lunchExcludedRamals),
        restAssignments: remapRecord(params.session.restAssignments),
        restExcludedRamals: remapList(params.session.restExcludedRamals),
        nightWorkAssignments: remapRecord(params.session.nightWorkAssignments),
        dinnerAssignments: remapRecord(params.session.dinnerAssignments),
        dinnerDurationAssignments: remapRecord(params.session.dinnerDurationAssignments),
        lunchQueue: remapList(params.session.lunchQueue),
        restQueue: remapList(params.session.restQueue),
        nightWorkQueue: remapList(params.session.nightWorkQueue),
        dinnerQueue: remapList(params.session.dinnerQueue),
        undoSnapshots: params.session.undoSnapshots.map(remapSnapshot),
    };

    return remapped.mode === "night" ? syncNightSessionState(remapped) : syncDaySessionState(remapped);
}

export function reconcileNightMealBreakSessionWithBoard(params: {
    session: MealBreakSession;
    board: OperationalBoard;
}) {
    if (params.session.mode !== "night") {
        return params.session;
    }

    const boardArrivalByRamal = new Map(
        params.board.regulation
            .filter((row) => row.status === "active" && Boolean(row.startedAt))
            .map((row) => [normalizeRamal(row.postCode), row.startedAt as string]),
    );

    let changed = false;
    const roster = params.session.roster.map((doctor) => {
        const liveArrivalStartedAt = boardArrivalByRamal.get(doctor.ramal) ?? null;
        if (!liveArrivalStartedAt || doctor.arrivalStartedAt === liveArrivalStartedAt) {
            return doctor;
        }

        changed = true;
        return {
            ...doctor,
            arrivalStartedAt: liveArrivalStartedAt,
        };
    });

    if (!changed) {
        return params.session;
    }

    return syncNightSessionState({
        ...params.session,
        roster,
    });
}

function buildMealBreakRosterEntries(
    board: OperationalBoard,
    referenceAt: Date,
    mode = resolveMealBreakModeFromReference(referenceAt),
) {
    const operationalDate = formatOperationalDate(referenceAt);
    const shiftWindow = resolveOperationalShiftWindow(referenceAt);
    if (mode === "day" && shiftWindow.shiftLabel !== "SD") {
        throw new MealBreakUserError("Fluxo de almoço vale apenas no plantão diurno.");
    }

    if (mode === "night" && shiftWindow.shiftLabel !== "SN") {
        throw new MealBreakUserError("Fluxo de jantar vale apenas no plantão noturno.");
    }

    const boardEntries = board.regulation.map((row) => mapRegulationBoardEntry(row, mode, referenceAt));
    const regulation = boardEntries
        .map((entry) => (entry.kind === "doctor" ? entry.doctor : null))
        .filter((doctor): doctor is MealBreakRosterDoctor => Boolean(doctor));
    // Quem está de MEIO plantão fica fora por regra, mas o grupo precisa saber —
    // é a única exclusão fixa que vem de um dado editável (a função no painel).
    const halfShiftExcluded = boardEntries.flatMap((entry) =>
        entry.kind === "excluded" && entry.reason === "half_shift"
            ? [{ ramal: entry.ramal, name: entry.name }]
            : [],
    );
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
        halfShiftExcluded,
    };
}

/**
 * Tira do roster JÁ PERSISTIDO quem está como meio plantão. A regra fixa
 * (04/08/2026) vale na montagem, mas o roster é gravado no payload da sessão e
 * não é recalculado a cada leitura — uma sessão montada antes da regra, ou um
 * médico cuja função virou MEIO no painel durante o turno, continuavam dentro
 * da divisão. Consequência real: ele nunca escolhe, a fase de almoço não fecha
 * e o sync apaga os descansos de todo mundo (incidente de 04/08/2026, ramal
 * 1361).
 *
 * O papel vivo do quadro tem precedência sobre o do roster: é ele que a chefia
 * edita no painel.
 */
export function dropHalfShiftFromMealBreakSession(params: {
    session: MealBreakSession;
    board: OperationalBoard;
}) {
    const liveRoleByRamal = new Map(
        params.board.regulation
            .filter((row) => row.status === "active")
            .map((row) => [normalizeRamal(row.postCode), row.roleLabel] as const),
    );

    // Fixação da chefia vence a regra automática: se ela deu horário a alguém de
    // meio plantão pelo painel, ele fica (autoridade absoluta do botão).
    const pins = params.session.chiefPins;
    const pinnedRamals = new Set([
        ...Object.keys(pins?.lunch ?? {}),
        ...Object.keys(pins?.rest ?? {}),
        ...Object.keys(pins?.nightWork ?? {}),
        ...Object.keys(pins?.dinner ?? {}),
    ]);

    const halfShiftRamals = params.session.roster
        .filter((doctor) => {
            if (pinnedRamals.has(doctor.ramal)) {
                return false;
            }
            const liveRole = liveRoleByRamal.get(doctor.ramal);
            return isHalfShiftRoleLabel(liveRole ?? doctor.roleLabel);
        })
        .map((doctor) => doctor.ramal);

    if (halfShiftRamals.length === 0) {
        return params.session;
    }

    const without = <TSlot extends string>(assignments: Record<string, TSlot>) =>
        Object.fromEntries(
            Object.entries(assignments).filter(([ramal]) => !halfShiftRamals.includes(ramal)),
        ) as Record<string, TSlot>;

    const next: MealBreakSession = {
        ...params.session,
        roster: params.session.roster.filter((doctor) => !halfShiftRamals.includes(doctor.ramal)),
        mrvRamals: params.session.mrvRamals.filter((ramal) => !halfShiftRamals.includes(ramal)),
        recipRamal: params.session.recipRamal && halfShiftRamals.includes(params.session.recipRamal)
            ? null
            : params.session.recipRamal,
        lunchAssignments: without(params.session.lunchAssignments),
        restAssignments: without(params.session.restAssignments),
        nightWorkAssignments: without(params.session.nightWorkAssignments),
        dinnerAssignments: without(params.session.dinnerAssignments),
    };

    return params.session.mode === "night" ? syncNightSessionState(next) : syncDaySessionState(next);
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

    publishBoardUpdate(`meal-break:priority:${overrides.mode}`);
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

    publishBoardUpdate(`meal-break:eligibility:${overrides.mode}`);
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

// A prioridade manual e armazenada por doctorId (v2). Registros legados (v1) sao
// traduzidos ramal->doctorId usando o roster vivo, para que a posicao siga o medico
// mesmo quando ele troca de ramal (remanejamento).
export function resolvePriorityOverridesByDoctorId(
    overrides: MealBreakPriorityOverrideRecord | null,
    entries: MealBreakPriorityContextEntry[],
): { orderedDoctorIds: string[]; justifications: Record<string, MealBreakPriorityJustification> } {
    if (!overrides) {
        return { orderedDoctorIds: [], justifications: {} };
    }

    if (overrides.version === 2 || Array.isArray(overrides.orderedDoctorIds)) {
        return {
            orderedDoctorIds: overrides.orderedDoctorIds ?? [],
            justifications: overrides.justifications ?? {},
        };
    }

    const doctorIdByRamal = new Map(entries.map((entry) => [entry.doctor.ramal, entry.doctor.doctorId]));
    const orderedDoctorIds = (overrides.orderedRamals ?? [])
        .map((ramal) => doctorIdByRamal.get(ramal))
        .filter((doctorId): doctorId is string => Boolean(doctorId));
    const justifications: Record<string, MealBreakPriorityJustification> = {};
    for (const [ramal, justification] of Object.entries(overrides.justifications ?? {})) {
        const doctorId = doctorIdByRamal.get(ramal);
        if (doctorId) {
            justifications[doctorId] = justification;
        }
    }
    return { orderedDoctorIds, justifications };
}

export function applyMealBreakPriorityOverrides(params: {
    entries: MealBreakPriorityContextEntry[];
    overrides: MealBreakPriorityOverrideRecord | null;
}) {
    const { orderedDoctorIds, justifications } = resolvePriorityOverridesByDoctorId(params.overrides, params.entries);
    const orderIndex = new Map(orderedDoctorIds.map((doctorId, index) => [doctorId, index]));
    const automaticIndex = new Map(params.entries.map((entry, index) => [entry.doctor.doctorId, index]));

    return [...params.entries]
        .sort((left, right) => {
            const leftOverrideIndex = orderIndex.get(left.doctor.doctorId);
            const rightOverrideIndex = orderIndex.get(right.doctor.doctorId);
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

            return (automaticIndex.get(left.doctor.doctorId) ?? 0) - (automaticIndex.get(right.doctor.doctorId) ?? 0);
        })
        .map((entry, index) => ({
            ...entry,
            rank: index + 1,
            manualJustification: justifications[entry.doctor.doctorId] ?? null,
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
    const eligibilityExclusions = resolveMealBreakEligibilityExclusions(
        eligibilityOverrides,
        buildBoardRamalMaps(board).ramalByDoctorId,
    );
    const lunchExcluded = new Set(eligibilityExclusions.lunchExcludedRamals);
    const restExcluded = new Set(eligibilityExclusions.restExcludedRamals);
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
        halfShiftExcluded: built.halfShiftExcluded,
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
        throw new MealBreakUserError("A justificativa do ajuste de prioridade é obrigatória.");
    }

    const context = await buildMealBreakPriorityContext({
        referenceAt: params.referenceAt,
        mode: params.mode,
        board: params.board,
    });
    const currentIndex = context.entries.findIndex((entry) => entry.doctor.ramal === normalizeRamal(params.ramal));
    if (currentIndex < 0) {
        throw new MealBreakUserError("Não encontrei esse ramal na fila atual de prioridade.");
    }

    if (!Number.isInteger(params.targetIndex) || params.targetIndex < 0 || params.targetIndex >= context.entries.length) {
        throw new MealBreakUserError("Posição de prioridade inválida para a fila atual.");
    }

    const movingDoctorId = context.entries[currentIndex].doctor.doctorId;
    const orderedDoctorIds = context.entries.map((entry) => entry.doctor.doctorId);
    const [moved] = orderedDoctorIds.splice(currentIndex, 1);
    orderedDoctorIds.splice(params.targetIndex, 0, moved ?? movingDoctorId);

    const referenceIso = params.referenceAt.toISOString();
    const previous = await loadMealBreakPriorityOverrides(context.operationalDate, context.mode);
    const previousByDoctorId = resolvePriorityOverridesByDoctorId(previous, context.entries);
    const overrides: MealBreakPriorityOverrideRecord = {
        kind: PRIORITY_KIND,
        version: 2,
        mode: context.mode,
        operationalDate: context.operationalDate,
        orderedDoctorIds,
        justifications: {
            ...previousByDoctorId.justifications,
            [movingDoctorId]: {
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
            entries: context.entries,
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
        mrvRamals: [...session.mrvRamals],
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
        mrvRamals: [...(snapshot.mrvRamals ?? session.mrvRamals)],
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

// Exportados para o service.ts interceptar toques nesses botões fora de sessão
// ativa (senão viram no_operational_match). NÃO alterar os textos: são payload
// literal do reply keyboard.
export const UNDO_TEXT = "↩️ Desfazer";
export const CONFIRM_TEXT = "✅ Confirmar";

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

function chunkChoices(values: string[], size: number) {
    const rows: string[][] = [];
    for (let index = 0; index < values.length; index += size) {
        rows.push(values.slice(index, index + size));
    }
    return rows;
}

function resolveManualMrvCandidateRamals(session: MealBreakSession) {
    return session.roster
        .filter((doctor) => doctor.ramal !== session.chiefRamal)
        .filter((doctor) => doctor.ramal !== session.recipRamal)
        .filter((doctor) => !session.mrvRamals.includes(doctor.ramal))
        .filter((doctor) => !isMealBreakIsolatedRole(doctor.roleLabel))
        .filter((doctor) => !isMealBreakDiscretionaryRole(doctor.roleLabel))
        .map((doctor) => doctor.ramal);
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

// Fila pendente do estagio atual (qualquer posicao, nao so a vez). Usada para
// reconhecer escolhas fora da vez e responder "aguarde sua vez" em vez de
// deixar a mensagem vazar para o parser de chegada.
function resolveStageChoiceQueue(session: MealBreakSession): string[] {
    if (session.stage === "awaiting_lunch_choice") {
        return session.lunchQueue;
    }
    if (session.stage === "awaiting_rest_choice") {
        return session.restQueue;
    }
    if (session.stage === "awaiting_night_work_choice") {
        return session.nightWorkQueue;
    }
    if (session.stage === "awaiting_dinner_choice") {
        return session.dinnerQueue;
    }
    return [];
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
        const candidate = resolveSingleChoiceRamal(session, text, session.mrvRamals.length >= 2 ? session.mrvRamals : undefined);
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
        if (resolveArrivalLunchAmbiguity({
            session,
            text,
            ramal: strictChoice.ramal,
            slot: strictChoice.slot,
        })) {
            return true;
        }
        // "RAMAL HH:MM" puro (sem nome, sem turno) e claramente uma tentativa de
        // escolha da divisao. Se o ramal esta na fila ativa mas ainda nao e a vez
        // dele, interceptamos mesmo assim para o handler responder "aguarde sua
        // vez" — em vez de deixar vazar para o parser de chegada e o robo
        // responder outra coisa no meio do almoco/jantar. O mesmo vale para a
        // escolha IDENTICA ja registrada (dedupe): a repeticao ganha um ack em
        // vez de virar tentativa de chegada silenciosa.
        if (
            !MEAL_BREAK_AMBIGUOUS_ARRIVAL_CUES.test(text)
            && !MEAL_BREAK_AMBIGUOUS_DEPARTURE_CUES.test(text)
            && (
                resolveStageChoiceQueue(session).includes(strictChoice.ramal)
                || findMealBreakDuplicateChoice(session, strictChoice.ramal, strictChoice.slot) !== null
            )
        ) {
            return true;
        }
        return false;
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

// Transição de fase em 1 balão: status curto + convocação seguinte na sequência.
// O detalhamento (quem caiu no 14:30 automático, 18:00 fixo etc.) sai apenas no
// resumo final, que mantém a lista nominal em cada bloco de horário.
function buildPhaseTransitionMessage(closedLabel: string, prompt: string) {
    return [`✅ *${closedLabel}* — resumo completo no fim.`, "", prompt].join("\n");
}

// Resumo final da divisão: lista nominal por horário (buildSessionSummary),
// legenda das regras fixas e — só aqui, no fim — a dica de reinício (antes ela
// aparecia 1 segundo depois da confirmação).
function buildCompletedSummary(session: MealBreakSession) {
    const restartCmd = session.mode === "night" ? "/jantar reiniciar" : "/almoco reiniciar";
    const legend = session.mode === "day"
        ? "ℹ️ 14:30: descanso automático de quem almoçou 13:30 · 18:00: fixo de RECIP, MRV e PSIQ."
        : "ℹ️ Quem trabalha às 03:00 janta no último horário: 22:00 (1h) ou 22:30 (30min).";
    return [
        "✅ *Divisão fechada!*",
        buildSessionSummary(session),
        legend,
        `Se precisar refazer: ${restartCmd}`,
    ].join("\n\n");
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

        // A dica de reinício NÃO aparece aqui (acabou de confirmar) — ela vive
        // no fim do resumo final (buildCompletedSummary).
        const startMsg = session.mode === "night"
            ? [
                `✅ Confirmado!`,
                "",
                buildNightStartPrompt(confirmed),
            ].join("\n")
            // Quando o RECIP ja vem definido no quadro (roleLabel "RECIP"), a
            // sessao pula direto para a etapa do MRV. Usamos buildCurrentPrompt
            // para anunciar a etapa real em vez de pedir o RECIP de novo.
            : [
                `✅ Confirmado!`,
                "",
                buildCurrentPrompt(confirmed),
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
            const availableNightWork = resolveRemainingNightWorkSlots(activeSession);
            const availableNightWorkSlots = NIGHT_WORK_SLOTS.filter((slot) => availableNightWork[slot] > 0);
            if (!parsed.ramal || !parsed.slot) {
                return {
                    handled: true,
                    session: activeSession,
                    messages: [buildMealBreakChoiceRejection({
                        kind: "format",
                        queueHead: currentRamal,
                        queueLength: activeSession.nightWorkQueue.length,
                        availableText: buildAvailableNightWorkText(activeSession),
                        availableSlots: availableNightWorkSlots,
                    })],
                    status: "invalid",
                };
            }

            if (!currentRamal || parsed.ramal !== currentRamal) {
                const duplicate = findMealBreakDuplicateChoice(activeSession, parsed.ramal, parsed.slot);
                if (duplicate) {
                    return {
                        handled: true,
                        session: activeSession,
                        messages: [buildMealBreakDuplicateChoiceReply(parsed.ramal, parsed.slot)],
                        status: "reported",
                        suppressKeyboard: true,
                    };
                }
                return {
                    handled: true,
                    session: activeSession,
                    messages: [buildWaitYourTurnMessage(activeSession, currentRamal, parsed.ramal)],
                    status: "invalid",
                    suppressKeyboard: true,
                };
            }

            if (!NIGHT_WORK_SLOTS.includes(parsed.slot as MealBreakNightWorkSlot)) {
                return {
                    handled: true,
                    session: activeSession,
                    messages: [buildMealBreakChoiceRejection({
                        kind: "slot_not_in_phase",
                        slot: parsed.slot,
                        queueHead: currentRamal,
                        queueLength: activeSession.nightWorkQueue.length,
                        availableText: buildAvailableNightWorkText(activeSession),
                        availableSlots: availableNightWorkSlots,
                    })],
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
                        messages: [`⛔ O outro ${COI_GLOSS} já está em *${chosenSlot}*. Use *${otherSlot}*.`],
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
                    messages: [`⚠️ ${COI_GLOSS} não pode coincidir. Aloquei ${renderDoctorCompactSummary(activeSession, parsed.ramal)} em *${otherSlot}* automaticamente.`],
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
                    messages: [`⚠️ Trabalho alocado em *${otherSlot}* para garantir a separação dos COIs (dupla 1367/1368).`],
                    status: "updated",
                };
            }

            const presentialUncovered = presentialCoverageWouldBreak(
                activeSession,
                parsed.ramal!,
                chosenSlot,
                activeSession.nightWorkAssignments,
                activeSession.nightWorkQueue,
                NIGHT_WORK_SLOTS,
            );
            if (presentialUncovered && remaining[presentialUncovered] > 0) {
                const sessionWithUndo = withUndoSnapshot(activeSession, `${renderDoctorCompactSummary(activeSession, parsed.ramal)} → trabalho ${presentialUncovered} (presencial reservado)`);
                let forcedSession: MealBreakSession = syncNightSessionState(withEvent({
                    ...sessionWithUndo,
                    nightWorkAssignments: { ...activeSession.nightWorkAssignments, [parsed.ramal]: presentialUncovered },
                    updatedAt: referenceAt.toISOString(),
                }, { type: "night_work_selected", actorTelegramId: senderTelegramId, ramal: parsed.ramal, slot: presentialUncovered }, referenceAt));
                forcedSession = autoAssignRemainingNightWorkIfSingleOption(forcedSession, referenceAt, senderTelegramId);
                return {
                    handled: true,
                    session: forcedSession,
                    messages: [`⚠️ Trabalho alocado em *${presentialUncovered}* para garantir pelo menos 1 presencial em cada horário noturno.`],
                    status: "updated",
                };
            }

            if (remaining[chosenSlot] <= 0) {
                return {
                    handled: true,
                    session: activeSession,
                    messages: [buildMealBreakChoiceRejection({
                        kind: "slot_full",
                        slot: chosenSlot,
                        queueHead: currentRamal,
                        queueLength: activeSession.nightWorkQueue.length,
                        availableText: buildAvailableNightWorkText(activeSession),
                        availableSlots: NIGHT_WORK_SLOTS.filter((slot) => remaining[slot] > 0),
                    })],
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
            // Ack SEPARADO da convocação seguinte: o balão do ✅ é só de quem
            // escolheu; a convocação do próximo sai em outro balão (o dispatcher
            // anexa o teclado apenas à última mensagem).
            const workMessage = chosenSlot === "03:00"
                ? `✅ *${compactName}* → trabalho *${chosenSlot}* (jantar *${nextSession.dinnerAssignments[parsed.ramal] ?? resolveDefaultNightDinnerSlot(dinnerDuration)}*)`
                : `✅ *${compactName}* → trabalho *${chosenSlot}*`;

            if (nextSession.stage === "awaiting_night_work_choice") {
                return {
                    handled: true,
                    session: nextSession,
                    messages: [workMessage, buildCurrentPrompt(nextSession)],
                    status: "updated",
                };
            }

            const dinnerPhase = autoAssignRemainingDinnerIfSingleOption(nextSession, referenceAt, senderTelegramId);
            if (dinnerPhase.stage === "completed") {
                return {
                    handled: true,
                    session: dinnerPhase,
                    messages: [workMessage, buildCompletedSummary(dinnerPhase)],
                    status: "completed",
                };
            }

            return {
                handled: true,
                session: dinnerPhase,
                messages: [workMessage, buildPhaseTransitionMessage("Trabalho da noite fechado", buildCurrentPrompt(dinnerPhase))],
                status: "updated",
            };
        }

        if (activeSession.stage === "awaiting_dinner_choice") {
            const parsed = parseChoiceReply(text);
            const currentRamal = activeSession.dinnerQueue[0] ?? null;
            const availableDinner = resolveRemainingDinnerChoiceSlots(activeSession);
            const availableDinnerSlots = DINNER_CHOICE_SLOTS.filter((slot) => availableDinner[slot] > 0);
            if (!parsed.ramal || !parsed.slot) {
                return {
                    handled: true,
                    session: activeSession,
                    messages: [buildMealBreakChoiceRejection({
                        kind: "format",
                        queueHead: currentRamal,
                        queueLength: activeSession.dinnerQueue.length,
                        availableText: buildAvailableDinnerText(activeSession),
                        availableSlots: availableDinnerSlots,
                    })],
                    status: "invalid",
                };
            }

            if (!currentRamal || parsed.ramal !== currentRamal) {
                const duplicate = findMealBreakDuplicateChoice(activeSession, parsed.ramal, parsed.slot);
                if (duplicate) {
                    return {
                        handled: true,
                        session: activeSession,
                        messages: [buildMealBreakDuplicateChoiceReply(parsed.ramal, parsed.slot)],
                        status: "reported",
                        suppressKeyboard: true,
                    };
                }
                return {
                    handled: true,
                    session: activeSession,
                    messages: [buildWaitYourTurnMessage(activeSession, currentRamal, parsed.ramal)],
                    status: "invalid",
                    suppressKeyboard: true,
                };
            }

            if (!DINNER_CHOICE_SLOTS.includes(parsed.slot as (typeof DINNER_CHOICE_SLOTS)[number])) {
                return {
                    handled: true,
                    session: activeSession,
                    messages: [buildMealBreakChoiceRejection({
                        kind: "slot_not_in_phase",
                        slot: parsed.slot,
                        queueHead: currentRamal,
                        queueLength: activeSession.dinnerQueue.length,
                        availableText: buildAvailableDinnerText(activeSession),
                        availableSlots: availableDinnerSlots,
                    })],
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
                            messages: [`⚠️ ${COI_GLOSS} não pode coincidir. Aloquei ${renderDoctorCompactSummary(activeSession, parsed.ramal)} em *${forcedAlt}* automaticamente.`],
                            status: forcedSession.stage === "completed" ? "completed" : "updated",
                        };
                    }
                }
                return {
                    handled: true,
                    session: activeSession,
                    messages: [`⛔ O outro ${COI_GLOSS} já está em *${chosenSlot}*. Escolha outro: ${available.map((s) => `*${s}*`).join(" ou ")}.`],
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
                        messages: [`⚠️ Jantar alocado em *${forcedSlot}* para garantir a separação dos COIs (dupla 1367/1368).`],
                        status: forcedSession.stage === "completed" ? "completed" : "updated",
                    };
                }
            }

            if (remaining[chosenSlot] <= 0) {
                return {
                    handled: true,
                    session: activeSession,
                    messages: [buildMealBreakChoiceRejection({
                        kind: "slot_full",
                        slot: chosenSlot,
                        queueHead: currentRamal,
                        queueLength: activeSession.dinnerQueue.length,
                        availableText: buildAvailableDinnerText(activeSession),
                        availableSlots: DINNER_CHOICE_SLOTS.filter((slot) => remaining[slot] > 0),
                    })],
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
                        `✅ *${compactDinnerName}* → jantar *${chosenSlot}* (${duration})`,
                        buildCompletedSummary(updatedSession),
                    ],
                    status: "completed",
                };
            }

            // Ack separado da convocação seguinte (2 balões).
            return {
                handled: true,
                session: updatedSession,
                messages: [
                    `✅ *${compactDinnerName}* → jantar *${chosenSlot}* (${duration})`,
                    buildCurrentPrompt(updatedSession),
                ],
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
                messages: [`Encontrei mais de um médico:\n${candidates}\n\nDigite o RAMAL para confirmar.`],
                status: "invalid",
            };
        }

        const resolvedRamal = choiceResult.ramal;

        if (!resolvedRamal) {
            return {
                handled: true,
                session,
                messages: ["⛔ Não reconheci. Envie o RAMAL ou nome do médico RECIP."],
                status: "invalid",
            };
        }

        if (resolvedRamal === CHIEF_RAMAL || session.mrvRamals.includes(resolvedRamal)) {
            return {
                handled: true,
                session,
                messages: ["⛔ RECIP não pode ser chefia nem um dos MRV. Informe outro."],
                status: "invalid",
            };
        }

        const doctor = findDoctor(session, resolvedRamal);
        if (!doctor) {
            return {
                handled: true,
                session,
                messages: ["⛔ Não reconheci esse ramal na lista ativa. Envie RAMAL ou nome."],
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
                `✅ RECIP: *${resolveDoctorCompactName(doctor)}* · *${resolvedRamal}*\nAlmoço *11:30* · Descanso *18:00*`,
                buildCurrentPrompt(nextSession),
            ],
            status: "updated",
        };
    }

    if (session.stage === "awaiting_mrv_lunch") {
        const choiceResult = resolveSingleChoiceRamal(session, text, session.mrvRamals.length >= 2 ? session.mrvRamals : undefined);
        if (choiceResult.ambiguous) {
            const candidates = choiceResult.candidates.map((doctor) => `• ${doctor.ramal} · ${resolveDoctorCompactName(doctor)}`).join("\n");
            return {
                handled: true,
                session,
                messages: [`Encontrei mais de uma opção:\n${candidates}\n\nDigite o RAMAL para confirmar.`],
                status: "invalid",
            };
        }

        if (!choiceResult.ramal) {
            return {
                handled: true,
                session,
                messages: [session.mrvRamals.length < 2
                    ? `⛔ Não reconheci o MRV faltante. Atualize no ${resolveMealBreakPanelLabel()} e mande /almoco reiniciar, ou envie o RAMAL de um médico ativo.`
                    : "⛔ Não reconheci. Clique ou envie o RAMAL ou nome do MRV que ficará com *12:30*."],
                status: "invalid",
            };
        }

        if (session.mrvRamals.length < 2) {
            if (choiceResult.ramal === session.chiefRamal || choiceResult.ramal === session.recipRamal) {
                return {
                    handled: true,
                    session,
                    messages: ["⛔ MRV não pode ser chefia nem RECIP. Informe outro ramal."],
                    status: "invalid",
                };
            }

            if (session.mrvRamals.includes(choiceResult.ramal)) {
                return {
                    handled: true,
                    session,
                    messages: ["⛔ Esse MRV já está registrado. Informe o outro ramal MRV faltante."],
                    status: "invalid",
                };
            }

            const doctor = findDoctor(session, choiceResult.ramal);
            if (!doctor) {
                return {
                    handled: true,
                    session,
                    messages: [`⛔ Não reconheci esse ramal na lista ativa. Atualize no ${resolveMealBreakPanelLabel()} e mande /almoco reiniciar, ou informe outro ramal.`],
                    status: "invalid",
                };
            }

            if (isMealBreakIsolatedRole(doctor.roleLabel) || isMealBreakDiscretionaryRole(doctor.roleLabel)) {
                return {
                    handled: true,
                    session,
                    messages: ["⛔ Esse ramal não pode ser registrado como MRV nesta divisão. Informe outro."],
                    status: "invalid",
                };
            }

            const nextMrvSet = new Set([...session.mrvRamals, choiceResult.ramal]);
            const sessionWithUndo = withUndoSnapshot(session, `MRV ${resolveDoctorCompactName(doctor)}`);
            const syncedSession = syncDaySessionState(withEvent({
                ...sessionWithUndo,
                mrvRamals: session.roster
                    .map((entry) => entry.ramal)
                    .filter((ramal) => nextMrvSet.has(ramal)),
                updatedAt: referenceAt.toISOString(),
            }, {
                type: "mrv_declared",
                actorTelegramId: senderTelegramId,
                ramal: choiceResult.ramal,
            }, referenceAt));

            return {
                handled: true,
                session: syncedSession,
                messages: [
                    `✅ MRV registrado: *${resolveDoctorCompactName(doctor)}* · *${choiceResult.ramal}*`,
                    buildCurrentPrompt(syncedSession),
                ],
                status: "updated",
            };
        }

        if (!session.mrvRamals.includes(choiceResult.ramal)) {
            const mrvList = session.mrvRamals.join(" ou ");
            return {
                handled: true,
                session,
                messages: [`⛔ Esse ramal não é um dos MRV. Responda apenas com ${mrvList}.`],
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

        // Ack do MRV separado da convocação seguinte: o balão que abre com
        // "✅ MRV ..." não carrega mais o chamado do próximo médico.
        const mrvMsg = [
            otherMrv
                ? `✅ MRV 12:30: *${renderDoctorCompactSummary(autoPreparedSession, selectedRamal)}* · MRV 13:30: *${renderDoctorCompactSummary(autoPreparedSession, otherMrv)}*`
                : `✅ MRV 12:30: *${renderDoctorCompactSummary(autoPreparedSession, selectedRamal)}*`,
            `Vagas: 11:30 (${autoPreparedSession.lunchCapacities["11:30"]}) · 12:30 (${autoPreparedSession.lunchCapacities["12:30"]}) · 13:30 (${autoPreparedSession.lunchCapacities["13:30"]})`,
        ].join("\n");

        if (autoPreparedSession.lunchQueue.length === 0) {
            const restPhase = buildRestPhase(autoPreparedSession, referenceAt, senderTelegramId);
            if (restPhase.stage === "completed") {
                const completed = completeSession(restPhase, referenceAt, senderTelegramId);
                return {
                    handled: true,
                    session: completed,
                    messages: [mrvMsg, buildCompletedSummary(completed)],
                    status: "completed",
                };
            }

            return {
                handled: true,
                session: restPhase,
                messages: [mrvMsg, buildPhaseTransitionMessage("Almoço fechado", buildCurrentPrompt(restPhase))],
                status: "updated",
            };
        }

        return {
            handled: true,
            session: autoPreparedSession,
            messages: [mrvMsg, buildCurrentPrompt(autoPreparedSession)],
            status: "updated",
        };
    }

    if (session.stage === "awaiting_lunch_choice") {
        const parsed = parseChoiceReply(text);
        const currentRamal = session.lunchQueue[0] ?? null;
        const availableLunch = resolveRemainingLunchSlots(session);
        const availableLunchSlots = LUNCH_SLOTS.filter((slot) => availableLunch[slot] > 0);
        if (!parsed.ramal || !parsed.slot) {
            return {
                handled: true,
                session,
                messages: [buildMealBreakChoiceRejection({
                    kind: "format",
                    queueHead: currentRamal,
                    queueLength: session.lunchQueue.length,
                    availableText: buildAvailableLunchText(session),
                    availableSlots: availableLunchSlots,
                })],
                status: "invalid",
            };
        }

        if (!currentRamal || parsed.ramal !== currentRamal) {
            const duplicate = findMealBreakDuplicateChoice(session, parsed.ramal, parsed.slot);
            if (duplicate) {
                return {
                    handled: true,
                    session,
                    messages: [buildMealBreakDuplicateChoiceReply(parsed.ramal, parsed.slot)],
                    status: "reported",
                    suppressKeyboard: true,
                };
            }
            return {
                handled: true,
                session,
                messages: [buildWaitYourTurnMessage(session, currentRamal, parsed.ramal)],
                status: "invalid",
                suppressKeyboard: true,
            };
        }

        if (!LUNCH_SLOTS.includes(parsed.slot as MealBreakLunchSlot)) {
            return {
                handled: true,
                session,
                messages: [buildMealBreakChoiceRejection({
                    kind: "slot_not_in_phase",
                    slot: parsed.slot,
                    queueHead: currentRamal,
                    queueLength: session.lunchQueue.length,
                    availableText: buildAvailableLunchText(session),
                    availableSlots: availableLunchSlots,
                })],
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
                        ...withUndoSnapshot(session, `${renderDoctorCompactSummary(session, parsed.ramal)} → almoço ${forcedAlt} (COI separado)`),
                        lunchAssignments: { ...session.lunchAssignments, [parsed.ramal]: forcedAlt },
                        lunchQueue: nextQueue,
                        updatedAt: referenceAt.toISOString(),
                    }, { type: "lunch_selected", actorTelegramId: senderTelegramId, ramal: parsed.ramal, slot: forcedAlt }, referenceAt);
                    updatedSession = autoAssignRemainingLunchIfSingleOption(updatedSession, referenceAt, senderTelegramId);
                    return {
                        handled: true,
                        session: updatedSession,
                        messages: [`⚠️ ${COI_GLOSS} não pode coincidir. Aloquei ${renderDoctorCompactSummary(session, parsed.ramal)} em *${forcedAlt}* automaticamente.`],
                        status: "updated",
                    };
                }
            }
            return {
                handled: true,
                session,
                messages: [`⛔ O outro ${COI_GLOSS} já está em *${chosenSlot}*. Escolha outro: ${available.map((s) => `*${s}*`).join(" ou ")}.`],
                status: "invalid",
            };
        }

        if (wouldCoiConflictAfterChoice(session, parsed.ramal!, chosenSlot, session.lunchAssignments, session.lunchQueue, LUNCH_SLOTS, remaining)) {
            const safeSlots = LUNCH_SLOTS.filter((s) => remaining[s] > 0 && !wouldCoiConflictAfterChoice(session, parsed.ramal!, s, session.lunchAssignments, session.lunchQueue, LUNCH_SLOTS, remaining));
            const forcedSlot = safeSlots[0] ?? LUNCH_SLOTS.find((s) => s !== chosenSlot && remaining[s] > 0);
            if (forcedSlot) {
                const nextQueue = session.lunchQueue.slice(1);
                let updatedSession = withEvent({
                    ...withUndoSnapshot(session, `${renderDoctorCompactSummary(session, parsed.ramal)} → almoço ${forcedSlot} (COI reservado)`),
                    lunchAssignments: { ...session.lunchAssignments, [parsed.ramal]: forcedSlot },
                    lunchQueue: nextQueue,
                    updatedAt: referenceAt.toISOString(),
                }, { type: "lunch_selected", actorTelegramId: senderTelegramId, ramal: parsed.ramal, slot: forcedSlot }, referenceAt);
                updatedSession = autoAssignRemainingLunchIfSingleOption(updatedSession, referenceAt, senderTelegramId);
                return {
                    handled: true,
                    session: updatedSession,
                    messages: [`⚠️ Almoço alocado em *${forcedSlot}* para garantir a separação dos COIs (dupla 1367/1368).`],
                    status: "updated",
                };
            }
        }

        if (remaining[chosenSlot] <= 0) {
            return {
                handled: true,
                session,
                messages: [buildMealBreakChoiceRejection({
                    kind: "slot_full",
                    slot: chosenSlot,
                    queueHead: currentRamal,
                    queueLength: session.lunchQueue.length,
                    availableText: buildAvailableLunchText(session),
                    availableSlots: LUNCH_SLOTS.filter((slot) => remaining[slot] > 0),
                })],
                status: "invalid",
            };
        }

        const nextQueue = session.lunchQueue.slice(1);
        let updatedSession = withEvent({
            ...withUndoSnapshot(session, `${renderDoctorCompactSummary(session, parsed.ramal)} → almoço ${chosenSlot}`),
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

        // Ack SEPARADO da convocação: balão 1 é só o ✅ de quem escolheu; a
        // convocação do próximo (ou a transição de fase) sai no balão seguinte.
        const lunchAck = `✅ *${renderDoctorCompactSummary(updatedSession, parsed.ramal)}* → almoço *${chosenSlot}*`;
        if (updatedSession.lunchQueue.length > 0) {
            return {
                handled: true,
                session: updatedSession,
                messages: [lunchAck, buildCurrentPrompt(updatedSession)],
                status: "updated",
            };
        }

        const restPhase = buildRestPhase(updatedSession, referenceAt, senderTelegramId);
        if (restPhase.stage === "completed") {
            const completed = completeSession(restPhase, referenceAt, senderTelegramId);
            return {
                handled: true,
                session: completed,
                messages: [lunchAck, buildCompletedSummary(completed)],
                status: "completed",
            };
        }

        return {
            handled: true,
            session: restPhase,
            messages: [lunchAck, buildPhaseTransitionMessage("Almoço fechado", buildCurrentPrompt(restPhase))],
            status: "updated",
        };
    }

    if (session.stage === "awaiting_rest_choice") {
        const parsed = parseChoiceReply(text);
        const currentRamal = session.restQueue[0] ?? null;
        const availableRest = resolveRemainingRestChoiceSlots(session);
        const availableRestSlots = (["15:30", "16:30"] as const).filter((slot) => availableRest[slot] > 0);
        if (!parsed.ramal || !parsed.slot) {
            return {
                handled: true,
                session,
                messages: [buildMealBreakChoiceRejection({
                    kind: "format",
                    queueHead: currentRamal,
                    queueLength: session.restQueue.length,
                    availableText: buildAvailableRestText(session),
                    availableSlots: availableRestSlots,
                })],
                status: "invalid",
            };
        }

        if (!currentRamal || parsed.ramal !== currentRamal) {
            const duplicate = findMealBreakDuplicateChoice(session, parsed.ramal, parsed.slot);
            if (duplicate) {
                return {
                    handled: true,
                    session,
                    messages: [buildMealBreakDuplicateChoiceReply(parsed.ramal, parsed.slot)],
                    status: "reported",
                    suppressKeyboard: true,
                };
            }
            return {
                handled: true,
                session,
                messages: [buildWaitYourTurnMessage(session, currentRamal, parsed.ramal)],
                status: "invalid",
                suppressKeyboard: true,
            };
        }

        if (parsed.slot !== "15:30" && parsed.slot !== "16:30") {
            return {
                handled: true,
                session,
                messages: [buildMealBreakChoiceRejection({
                    kind: "slot_not_in_phase",
                    slot: parsed.slot,
                    queueHead: currentRamal,
                    queueLength: session.restQueue.length,
                    availableText: buildAvailableRestText(session),
                    availableSlots: availableRestSlots,
                })],
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
                        messages: [`⛔ O outro ${COI_GLOSS} já está em *${chosenSlot}*. Use *${otherSlot}*.`],
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
                    ? buildCompletedSummary(completeSession(updatedSession, referenceAt, senderTelegramId))
                    : buildCurrentPrompt(updatedSession);
                return {
                    handled: true,
                    session: updatedSession.stage === "completed" ? completeSession(updatedSession, referenceAt, senderTelegramId) : updatedSession,
                    messages: [`⚠️ ${COI_GLOSS} não pode coincidir. Aloquei ${renderDoctorCompactSummary(session, parsed.ramal)} em *${otherSlot}* automaticamente.`, completedMsg],
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
                ? buildCompletedSummary(completeSession(updatedSession, referenceAt, senderTelegramId))
                : buildCurrentPrompt(updatedSession);
            return {
                handled: true,
                session: updatedSession.stage === "completed" ? completeSession(updatedSession, referenceAt, senderTelegramId) : updatedSession,
                messages: [`⚠️ Descanso alocado em *${otherSlot}* para garantir a separação dos COIs (dupla 1367/1368).`, completedMsg],
                status: updatedSession.stage === "completed" ? "completed" : "updated",
            };
        }

        if (remaining[chosenSlot] <= 0) {
            return {
                handled: true,
                session,
                messages: [buildMealBreakChoiceRejection({
                    kind: "slot_full",
                    slot: chosenSlot,
                    queueHead: currentRamal,
                    queueLength: session.restQueue.length,
                    availableText: buildAvailableRestText(session),
                    availableSlots: (["15:30", "16:30"] as const).filter((slot) => remaining[slot] > 0),
                })],
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
        const restAck = `✅ *${renderDoctorCompactSummary(updatedSession, parsed.ramal)}* → descanso *${chosenSlot}*`;
        if (updatedSession.stage === "completed") {
            const completed = completeSession(updatedSession, referenceAt, senderTelegramId);
            return {
                handled: true,
                session: completed,
                messages: [
                    restAck,
                    buildCompletedSummary(completed),
                ],
                status: "completed",
            };
        }

        // Ack separado da convocação seguinte (2 balões).
        return {
            handled: true,
            session: updatedSession,
            messages: [restAck, buildCurrentPrompt(updatedSession)],
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

    let session = hydrateMealBreakSession(row.payload);
    if (session.operationalDate !== operationalDate || session.mode !== mode) {
        return null;
    }

    const board = await getOperationalBoard();
    session = reconcileMealBreakSessionRamalsWithBoard({ session, board });
    if (mode === "night") {
        session = reconcileNightMealBreakSessionWithBoard({
            session,
            board,
        });
    }
    // Meio plantão não participa da divisão nem quando a sessão foi montada
    // antes dessa regra: sem isto ele trava a fila e o sync apaga os descansos.
    session = dropHalfShiftFromMealBreakSession({ session, board });

    return session;
}

function getMealBreakVisibleChatIds() {
    return [...new Set([...getTelegramAdminUserIds(), ...getTelegramAnnouncementChatIds()])];
}

/**
 * Chats candidatos a ter sessão de refeição, a partir das sessões PERSISTIDAS no
 * banco (uma linha por chat+modo, upsert). Complementa a lista do env: com
 * TELEGRAM_ALLOWED_CHAT_IDS vazio (caso magalu pós-migração, jul/2026) o bot
 * funciona no grupo mas painel e lembretes ficavam cegos — a sessão existia no
 * banco e ninguém a descobria. loadMealBreakSession valida operationalDate/modo,
 * então chats com sessão antiga são filtrados naturalmente.
 */
export function filterMealBreakSessionNoticeChatIds(
    rows: Array<{ noticeKey: string; chatId: string | null }>,
    mode: MealBreakMode,
) {
    const suffixes = mode === "day"
        ? [":meal_break:session:day", ":meal_break:session"]
        : [":meal_break:session:night"];
    return [...new Set(rows
        .filter((row) => suffixes.some((suffix) => row.noticeKey.endsWith(suffix)))
        .map((row) => row.chatId)
        .filter((chatId): chatId is string => Boolean(chatId)))];
}

async function resolveMealBreakDiscoveryChatIds(mode: MealBreakMode) {
    const envChatIds = getMealBreakVisibleChatIds();
    const rows = await getDb().query.telegramBotNotices.findMany({
        where: eq(telegramBotNotices.stage, SESSION_NOTICE_STAGE),
        columns: { noticeKey: true, chatId: true },
    });
    return [...new Set([...envChatIds, ...filterMealBreakSessionNoticeChatIds(rows, mode)])];
}

async function resolveCurrentOperationalMealBreakState(referenceAt: Date, mode: MealBreakMode) {
    const operationalDate = formatOperationalDate(referenceAt);
    const chatIds = await resolveMealBreakDiscoveryChatIds(mode);
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

/**
 * Ponto de restauração: TODA gravação da sessão deixa uma cópia completa do
 * estado, com o motivo da gravação. A linha viva é um upsert (uma por chat+modo)
 * — sem isto, qualquer bug que mexa nas escolhas apaga o que havia antes e a
 * divisão do dia se perde de vez, que foi o incidente de 04/08/2026.
 *
 * Guardado no mesmo `telegram_bot_notices` (payload jsonb) para não depender de
 * migration: a chave carrega chat+modo+dia+instante, então revisões nunca se
 * sobrescrevem e a poda é um `like` no prefixo.
 */
const REVISION_NOTICE_STAGE = "meal_break_revision";
/** Revisões mantidas por chat+modo+dia. ~20KB cada no pior caso: 40 ≈ 800KB/dia. */
const MEAL_BREAK_REVISION_LIMIT = 40;
/** Dias de retenção das revisões de dias anteriores (a poda roda a cada gravação). */
const MEAL_BREAK_REVISION_RETENTION_DAYS = 7;

export type MealBreakSaveReason =
    | "session_started"
    | "session_restarted"
    | "choice"
    | "chief_correction"
    | "latecomer_joined"
    | "latecomer_rewind"
    | "board_reconcile"
    | "board_rewind"
    | "undo"
    | "restored";

const MEAL_BREAK_SAVE_REASON_LABELS: Record<MealBreakSaveReason, string> = {
    session_started: "divisão iniciada",
    session_restarted: "divisão reiniciada",
    choice: "escolha registrada",
    chief_correction: "correção da chefia",
    latecomer_joined: "retardatário entrou",
    latecomer_rewind: "rebobina do retardatário",
    board_reconcile: "quadro vivo sincronizado",
    board_rewind: "rebobina por mudança no quadro",
    undo: "desfazer",
    restored: "restauração de ponto",
};

export function resolveMealBreakSaveReasonLabel(reason: string | null | undefined) {
    return MEAL_BREAK_SAVE_REASON_LABELS[reason as MealBreakSaveReason] ?? "gravação";
}

interface MealBreakRevisionPayload {
    kind: "telegram_meal_break_revision";
    reason: MealBreakSaveReason;
    savedAt: string;
    session: MealBreakSession;
}

function resolveRevisionNoticeKeyPrefix(chatId: string, mode: MealBreakMode, operationalDate: string) {
    return `${chatId}:meal_break:revision:${mode}:${operationalDate}:`;
}

function resolveRevisionNoticeKeyChatPrefix(chatId: string, mode: MealBreakMode) {
    return `${chatId}:meal_break:revision:${mode}:`;
}

function isMealBreakRevisionPayload(value: unknown): value is MealBreakRevisionPayload {
    if (!value || typeof value !== "object") {
        return false;
    }
    const candidate = value as Partial<MealBreakRevisionPayload>;
    return candidate.kind === "telegram_meal_break_revision"
        && typeof candidate.savedAt === "string"
        && isMealBreakSession(candidate.session);
}

// Best-effort: a revisão é rede de segurança, nunca pode derrubar a gravação da
// sessão em si (o médico perder a escolha por causa do backup seria o oposto do
// objetivo). Falha aqui vira log e segue.
async function appendMealBreakSessionRevision(chatId: string, session: MealBreakSession, reason: MealBreakSaveReason) {
    const db = getDb();
    const savedAt = new Date().toISOString();
    const prefix = resolveRevisionNoticeKeyPrefix(chatId, session.mode, session.operationalDate);

    await db.insert(telegramBotNotices)
        .values({
            noticeKey: `${prefix}${savedAt}`,
            chatId,
            stage: REVISION_NOTICE_STAGE,
            payload: {
                kind: "telegram_meal_break_revision",
                reason,
                savedAt,
                session,
            } satisfies MealBreakRevisionPayload,
        })
        .onConflictDoNothing();

    // Poda 1: dias antigos deste chat+modo saem inteiros.
    await db.delete(telegramBotNotices)
        .where(and(
            eq(telegramBotNotices.stage, REVISION_NOTICE_STAGE),
            like(telegramBotNotices.noticeKey, `${resolveRevisionNoticeKeyChatPrefix(chatId, session.mode)}%`),
            lt(telegramBotNotices.createdAt, new Date(Date.now() - (MEAL_BREAK_REVISION_RETENTION_DAYS * 24 * 60 * 60 * 1000))),
        ));

    // Poda 2: dentro do dia, mantém só as MEAL_BREAK_REVISION_LIMIT mais novas.
    const surviving = await db.query.telegramBotNotices.findMany({
        where: and(
            eq(telegramBotNotices.stage, REVISION_NOTICE_STAGE),
            like(telegramBotNotices.noticeKey, `${prefix}%`),
        ),
        columns: { noticeKey: true },
        orderBy: [desc(telegramBotNotices.createdAt)],
        limit: MEAL_BREAK_REVISION_LIMIT,
    });
    if (surviving.length >= MEAL_BREAK_REVISION_LIMIT) {
        await db.delete(telegramBotNotices)
            .where(and(
                eq(telegramBotNotices.stage, REVISION_NOTICE_STAGE),
                like(telegramBotNotices.noticeKey, `${prefix}%`),
                notInArray(telegramBotNotices.noticeKey, surviving.map((row) => row.noticeKey)),
            ));
    }
}

async function saveMealBreakSession(chatId: string, session: MealBreakSession, reason: MealBreakSaveReason = "choice") {
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

    try {
        await appendMealBreakSessionRevision(chatId, session, reason);
    } catch (error) {
        console.error("[meal-breaks] falha ao gravar ponto de restauração", error);
    }

    // O painel assina /api/board/stream e faz router.refresh() a cada evento —
    // sem publicar aqui, o almoço/descanso registrado no bot só aparecia no
    // próximo refresh casual do quadro, nunca "em tempo real".
    publishBoardUpdate(`meal-break:session:${session.mode}`);
}

export interface MealBreakRevisionSummary {
    /** 1 = mais recente. É o número que a chefia digita no /almoco restaurar. */
    position: number;
    savedAt: string;
    reason: MealBreakSaveReason;
    reasonLabel: string;
    stage: MealBreakStage;
    /** Quantos já tinham horário definido naquele ponto (almoço+descanso ou noturno+jantar). */
    assignedCount: number;
    rosterCount: number;
    session: MealBreakSession;
}

function countMealBreakAssignments(session: MealBreakSession) {
    return session.mode === "night"
        ? Object.keys(session.nightWorkAssignments).length + Object.keys(session.dinnerAssignments).length
        : Object.keys(session.lunchAssignments).length + Object.keys(session.restAssignments).length;
}

export function summarizeMealBreakRevisions(
    revisions: Array<{ reason: MealBreakSaveReason; savedAt: string; session: MealBreakSession }>,
): MealBreakRevisionSummary[] {
    return [...revisions]
        .sort((left, right) => right.savedAt.localeCompare(left.savedAt))
        .map((revision, index) => ({
            position: index + 1,
            savedAt: revision.savedAt,
            reason: revision.reason,
            reasonLabel: resolveMealBreakSaveReasonLabel(revision.reason),
            stage: revision.session.stage,
            assignedCount: countMealBreakAssignments(revision.session),
            rosterCount: revision.session.roster.length,
            session: revision.session,
        }));
}

async function loadMealBreakSessionRevisions(chatId: string, mode: MealBreakMode, operationalDate: string) {
    const db = getDb();
    const rows = await db.query.telegramBotNotices.findMany({
        where: and(
            eq(telegramBotNotices.stage, REVISION_NOTICE_STAGE),
            like(telegramBotNotices.noticeKey, `${resolveRevisionNoticeKeyPrefix(chatId, mode, operationalDate)}%`),
        ),
        orderBy: [desc(telegramBotNotices.createdAt)],
        limit: MEAL_BREAK_REVISION_LIMIT,
    });

    return summarizeMealBreakRevisions(
        rows
            .map((row) => row.payload)
            .filter(isMealBreakRevisionPayload)
            .map((payload) => ({
                reason: payload.reason,
                savedAt: payload.savedAt,
                session: hydrateMealBreakSession(payload.session),
            })),
    );
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
    // "restaurar" (opcionalmente com o número do ponto) e "voltar" como sinônimo:
    // na hora do aperto ninguém lembra qual das duas palavras é a certa.
    const match = normalized.match(/^\/(almoco|jantar)(?:@(\w+))?(?:\s+(reiniciar|restaurar|voltar)(?:\s+(\d{1,2}))?)?\s*$/i);
    if (!match) {
        return null;
    }

    const verb = match[3]?.toLowerCase() ?? null;
    const isRestore = verb === "restaurar" || verb === "voltar";
    const restorePosition = isRestore && match[4] ? Number(match[4]) : null;

    return {
        name: "meal_break",
        mode: match[1]?.toLowerCase() === "jantar" ? "night" : "day",
        forceRestart: verb === "reiniciar",
        action: isRestore
            ? (restorePosition ? "restore_apply" : "restore_list")
            : "start",
        restorePosition,
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
    return "Use /excluir <ramal> para retirar um médico da divisão de almoço e descanso, ou /incluir <ramal> para recolocar. Exemplo: /excluir 2041";
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
            messages: ["⛔ Exclusão da divisão só funciona no plantão diurno. No noturno, use o quadro para ajustar jantar e trabalho."],
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
            messages: [`🚫 ${doctorLabel} está fora da divisão de almoço e descanso de hoje. Para recolocar, use /incluir ${normalizedRamal}`],
            status: "excluded" as const,
        };
    }

    return {
        messages: [`✅ ${doctorLabel} está de volta na divisão de almoço e descanso de hoje.`],
        status: "included" as const,
    };
}

// Cabeçalho neutro: a ordem NÃO é só de chegada (continuidade, RMT e ajuste
// manual da chefia também pesam), então "ordem de prioridade" em vez de fila.
function buildMealBreakPriorityTitle(view: MealBreakPriorityView) {
    return view.mode === "night" ? "📋 Ordem de prioridade — jantar" : "📋 Ordem de prioridade — almoço";
}

// 1 entrada por linha, sem tabela de pipes (ilegível no mobile): posição em
// negrito, ramal entre parênteses e a hora REAL de chegada; ajustes (RMT,
// continuidade, chefia) aparecem como explicação traduzida na mesma linha.
function buildMealBreakPriorityLine(entry: MealBreakPriorityEntry) {
    const base = `${entry.rank}º *${resolveDoctorCompactName({ name: entry.name })}* (${entry.ramal}) — chegou ${formatHour(entry.actualStartedAt)}`;
    return entry.explanation ? `${base} · ${escapeTelegramMarkdown(entry.explanation)}` : base;
}

export function buildMealBreakPriorityReply(view: MealBreakPriorityView) {
    const title = buildMealBreakPriorityTitle(view);
    if (view.entries.length === 0) {
        return `${title}\nSem médicos elegíveis na fila atual.`;
    }

    const warnings = view.warnings.map((warning) => `⚠️ ${escapeTelegramMarkdown(warning.message)}`);
    const lines = view.entries.map((entry) => buildMealBreakPriorityLine(entry));

    return [title, ...warnings, ...lines].join("\n");
}

export function buildMealBreakPriorityReplyMessages(view: MealBreakPriorityView, maxLength = 3500) {
    const singleReply = buildMealBreakPriorityReply(view);
    if (singleReply.length <= maxLength) {
        return [singleReply];
    }

    const title = buildMealBreakPriorityTitle(view);
    const lines = view.entries.map((entry) => buildMealBreakPriorityLine(entry));
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
    return "Use /almoco para a divisão diurna ou /jantar para a divisão noturna. Acrescente reiniciar para recomeçar o fluxo atual, ou restaurar para ver os pontos de restauração (e restaurar <número> para voltar a divisão para um deles).";
}

export function buildMealBreakPriorityCommandUsageReply() {
    return "Use /prioridade ou /prioridades para consultar a fila atual antes de abrir a divisão.";
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

function formatRevisionClock(savedAt: string) {
    const parts = getSaoPauloParts(new Date(savedAt));
    return `${String(parts.hour).padStart(2, "0")}:${String(parts.minute).padStart(2, "0")}`;
}

export function buildMealBreakRestoreListMessage(params: {
    mode: MealBreakMode;
    revisions: MealBreakRevisionSummary[];
}) {
    const mealLabel = params.mode === "night" ? "jantar" : "almoço";
    const restoreCmd = params.mode === "night" ? "/jantar restaurar" : "/almoco restaurar";
    if (params.revisions.length === 0) {
        return `Não há ponto de restauração guardado para a divisão do ${mealLabel} de hoje.`;
    }

    // O ponto 1 é o estado atual (última gravação): quem quer VOLTAR precisa
    // escolher do 2 em diante, e o texto diz isso para não parecer no-op.
    const lines = params.revisions.map((revision) => {
        const marker = revision.position === 1 ? " ← estado atual" : "";
        return `${revision.position}) ${formatRevisionClock(revision.savedAt)} · ${revision.reasonLabel} · ${revision.assignedCount} horário(s) definido(s)${marker}`;
    });

    return [
        `🗂️ Pontos de restauração da divisão do ${mealLabel} (mais recente primeiro):`,
        ...lines,
        "",
        `Para voltar, mande \`${restoreCmd} <número>\` — ex.: \`${restoreCmd} 2\`. A restauração também vira ponto, então dá para voltar atrás dela.`,
    ].join("\n");
}

/**
 * Volta a divisão para um ponto de restauração. Existe porque a linha viva da
 * sessão é um upsert: qualquer bug que mexa nas escolhas apagava o que havia
 * antes e a divisão do dia se perdia. Restaurar é uma gravação como outra
 * qualquer — vira ponto também, então uma restauração errada se desfaz.
 */
async function runMealBreakRestore(params: {
    chatId: string;
    mode: MealBreakMode;
    operationalDate: string;
    referenceAt: Date;
    actorTelegramId: string | null;
    position: number | null;
    current: MealBreakSession | null;
}) {
    const revisions = await loadMealBreakSessionRevisions(params.chatId, params.mode, params.operationalDate);
    const mealLabel = params.mode === "night" ? "jantar" : "almoço";

    if (params.position === null) {
        return {
            session: params.current,
            messages: [buildMealBreakRestoreListMessage({ mode: params.mode, revisions })],
            status: "restore_listed" as const,
        };
    }

    const target = revisions.find((revision) => revision.position === params.position) ?? null;
    if (!target) {
        return {
            session: params.current,
            messages: [
                revisions.length === 0
                    ? `Não há ponto de restauração guardado para a divisão do ${mealLabel} de hoje.`
                    : `Não achei o ponto ${params.position}. Os pontos disponíveis vão de 1 a ${revisions.length}.`,
                buildMealBreakRestoreListMessage({ mode: params.mode, revisions }),
            ],
            status: "restore_failed" as const,
        };
    }

    const sync = params.mode === "night" ? syncNightSessionState : syncDaySessionState;
    const restored = sync(withEvent({
        ...target.session,
        updatedAt: params.referenceAt.toISOString(),
    }, {
        type: "session_restored",
        actorTelegramId: params.actorTelegramId,
    }, params.referenceAt));

    await saveMealBreakSession(params.chatId, restored, "restored");

    const messages = [
        `↩️ Divisão do ${mealLabel} restaurada para o ponto ${target.position} (${formatRevisionClock(target.savedAt)} · ${target.reasonLabel}): ${countMealBreakAssignments(restored)} horário(s) definido(s).`,
        buildSessionSummary(restored),
    ];
    if (restored.stage !== "completed") {
        messages.push(buildCurrentPrompt(restored));
    }

    return {
        session: restored,
        messages,
        status: "restored" as const,
    };
}

// ───────────────────────────────────────────────────────────────────────────
// Restauração a partir do RESUMO publicado no grupo
//
// Ponte para o que é anterior aos pontos de restauração (ou para sessão cuja
// linha já foi sobrescrita): o balão "✅ Divisão fechada!" que o bot publicou
// no grupo é uma serialização completa da divisão — buildSessionSummary —, e
// dá para lê-lo de volta. Só diurno: foi o modo do incidente, e o noturno tem
// semântica própria (trabalho noturno + janta).
// ───────────────────────────────────────────────────────────────────────────

export interface MealBreakSummaryEntry {
    name: string;
    /** Etiquetas entre parênteses no resumo: RECIP, MRV, COI, RMT, IES... */
    tags: string[];
}

export interface MealBreakDaySummaryParse {
    lunch: Array<MealBreakSummaryEntry & { slot: MealBreakLunchSlot }>;
    rest: Array<MealBreakSummaryEntry & { slot: MealBreakRestSlot }>;
    /** Blocos "🚫 FORA DO ..." encontrados: esta ponte NÃO restaura exclusões. */
    excludedBlocks: string[];
}

function parseSummaryEntryLine(line: string): MealBreakSummaryEntry | null {
    const match = line.trim().match(/^[•*-]\s*(.+)$/);
    if (!match) {
        return null;
    }

    const body = match[1]?.trim() ?? "";
    if (!body || body === "--") {
        return null;
    }

    const tagMatch = body.match(/^(.*?)\s*\(([^)]*)\)\s*$/);
    if (!tagMatch) {
        return { name: body, tags: [] };
    }

    return {
        name: (tagMatch[1] ?? "").trim(),
        tags: (tagMatch[2] ?? "")
            .split("/")
            .map((tag) => normalizeFreeText(tag))
            .filter(Boolean),
    };
}

/**
 * Lê de volta o resumo diurno publicado no grupo. Tolerante ao que o Telegram
 * faz com o texto colado (linhas em branco, espaço extra), mas estrito no que
 * importa: horário desconhecido ou seção fora de ordem devolve null em vez de
 * restaurar uma divisão pela metade.
 */
export function parseMealBreakDaySummary(text: string): MealBreakDaySummaryParse | null {
    const lines = text.split(/\r?\n/).map((line) => line.trim());
    let section: "lunch" | "rest" | null = null;
    let slot: string | null = null;
    const parsed: MealBreakDaySummaryParse = { lunch: [], rest: [], excludedBlocks: [] };

    for (const line of lines) {
        if (!line) {
            continue;
        }

        const normalized = normalizeFreeText(line);

        // Rodapé ANTES dos cabeçalhos de seção: a legenda fala "descanso
        // automático de quem almoçou 13:30" e cairia na checagem de seção,
        // reabrindo o descanso no fim do balão.
        if (normalized.includes("CHEFIA") || line.startsWith("ℹ️") || normalized.startsWith("SE PRECISAR")) {
            section = null;
            slot = null;
            continue;
        }
        if (normalized.includes("FORA DO")) {
            parsed.excludedBlocks.push(line);
            section = null;
            slot = null;
            continue;
        }
        // "• Almoço a critério" (chefia) não é cabeçalho: por isso o guard do "•".
        if (normalized.includes("ALMOCO") && !normalized.startsWith("•")) {
            section = "lunch";
            slot = null;
            continue;
        }
        if (normalized.includes("DESCANSO") && !normalized.startsWith("•")) {
            section = "rest";
            slot = null;
            continue;
        }

        const slotMatch = line.match(/^(\d{1,2}:\d{2})$/);
        if (slotMatch) {
            slot = slotMatch[1] ?? null;
            continue;
        }

        if (!section || !slot) {
            continue;
        }

        const entry = parseSummaryEntryLine(line);
        if (!entry) {
            continue;
        }

        if (section === "lunch") {
            if (!LUNCH_SLOTS.includes(slot as MealBreakLunchSlot)) {
                return null;
            }
            parsed.lunch.push({ ...entry, slot: slot as MealBreakLunchSlot });
        } else {
            if (!REST_SLOTS.includes(slot as MealBreakRestSlot)) {
                return null;
            }
            parsed.rest.push({ ...entry, slot: slot as MealBreakRestSlot });
        }
    }

    return parsed.lunch.length > 0 || parsed.rest.length > 0 ? parsed : null;
}

/** O resumo imprime o nome compacto (primeiro + último). Casamos primeiro por
 *  igualdade exata desse nome — o texto saiu do mesmo renderizador — e só então
 *  por "todos os tokens presentes", para aguentar edição manual do balão. */
function matchRosterRamalByCompactName(session: MealBreakSession, name: string) {
    const needle = normalizeFreeText(name);
    if (!needle) {
        return { ramal: null, candidates: [] as MealBreakDoctor[] };
    }

    const exact = session.roster.filter((doctor) => normalizeFreeText(resolveDoctorCompactName(doctor)) === needle);
    if (exact.length === 1) {
        return { ramal: exact[0]!.ramal, candidates: exact };
    }

    const needleTokens = needle.split(/\s+/).filter(Boolean);
    const loose = session.roster.filter((doctor) => {
        const tokens = new Set(normalizeFreeText(doctor.name).split(/\s+/).filter(Boolean));
        return needleTokens.every((token) => tokens.has(token));
    });

    return { ramal: loose.length === 1 ? loose[0]!.ramal : null, candidates: loose.length > 0 ? loose : exact };
}

export interface MealBreakSummaryRestoreReport {
    matched: Array<{ name: string; ramal: string; lunchSlot: MealBreakLunchSlot | null; restSlot: MealBreakRestSlot | null }>;
    unmatchedNames: string[];
    /** Ramais de MEIO plantão retirados do roster persistido (regra fixa). */
    halfShiftRemoved: string[];
    excludedBlocks: string[];
    recipRamal: string | null;
    mrvRamals: string[];
    applied: boolean;
    session: MealBreakSession | null;
}

/**
 * Reaplica no estado vivo a divisão diurna lida de um resumo do grupo. Nunca
 * grava parcial: um nome que não casa com o roster aborta tudo e volta no
 * relatório, porque restaurar metade da divisão é pior que não restaurar.
 * `apply: false` (padrão) só simula e devolve o mapeamento para conferência.
 */
export async function restoreDayMealBreakFromSummary(params: {
    chatId?: string;
    referenceAt: Date;
    summaryText: string;
    actorTelegramId?: string | null;
    apply?: boolean;
}): Promise<MealBreakSummaryRestoreReport> {
    const parsed = parseMealBreakDaySummary(params.summaryText);
    if (!parsed) {
        throw new MealBreakUserError("Não reconheci uma divisão de almoço nesse texto — cole o balão inteiro que o bot publicou no grupo.");
    }

    const operationalDate = formatOperationalDate(params.referenceAt);
    const resolvedState = params.chatId
        ? { chatId: params.chatId, session: await loadMealBreakSession(params.chatId, operationalDate, "day") }
        : await resolveCurrentOperationalMealBreakState(params.referenceAt, "day");
    const chatId = resolvedState?.chatId ?? null;
    const loadedSession = resolvedState?.session ?? null;
    if (!loadedSession || !chatId) {
        throw new MealBreakUserError("Não existe sessão diurna deste dia operacional para receber a restauração.");
    }

    // O roster é PERSISTIDO, não recalculado a cada leitura: uma sessão montada
    // antes da regra que tira o meio plantão da divisão (04/08/2026) ainda o
    // carrega. Restaurar sem removê-lo não funciona — ele nunca escolhe, a fase
    // de almoço não fecha, e o syncDaySessionState apaga os descansos que
    // acabaram de ser restaurados (foi o que aconteceu na restauração de
    // 04/08/2026: os 9 almoços voltaram e os 14:30/15:30/16:30 sumiram).
    const halfShiftRamals = loadedSession.roster
        .filter((doctor) => isHalfShiftRoleLabel(doctor.roleLabel))
        .map((doctor) => doctor.ramal);
    const baseSession: MealBreakSession = halfShiftRamals.length === 0
        ? loadedSession
        : {
            ...loadedSession,
            roster: loadedSession.roster.filter((doctor) => !halfShiftRamals.includes(doctor.ramal)),
            lunchAssignments: Object.fromEntries(
                Object.entries(loadedSession.lunchAssignments).filter(([ramal]) => !halfShiftRamals.includes(ramal)),
            ) as Record<string, MealBreakLunchSlot>,
            restAssignments: Object.fromEntries(
                Object.entries(loadedSession.restAssignments).filter(([ramal]) => !halfShiftRamals.includes(ramal)),
            ) as Record<string, MealBreakRestSlot>,
        };

    const lunchAssignments: Record<string, MealBreakLunchSlot> = {};
    const restAssignments: Record<string, MealBreakRestSlot> = {};
    const byRamal = new Map<string, { name: string; ramal: string; lunchSlot: MealBreakLunchSlot | null; restSlot: MealBreakRestSlot | null }>();
    const unmatchedNames: string[] = [];
    const recipRamals = new Set<string>();
    const mrvRamals = new Set<string>();

    const register = (entry: MealBreakSummaryEntry, slot: MealBreakLunchSlot | MealBreakRestSlot, kind: "lunch" | "rest") => {
        const { ramal } = matchRosterRamalByCompactName(baseSession, entry.name);
        if (!ramal) {
            unmatchedNames.push(entry.name);
            return;
        }

        const current = byRamal.get(ramal) ?? { name: entry.name, ramal, lunchSlot: null, restSlot: null };
        if (kind === "lunch") {
            lunchAssignments[ramal] = slot as MealBreakLunchSlot;
            current.lunchSlot = slot as MealBreakLunchSlot;
        } else {
            restAssignments[ramal] = slot as MealBreakRestSlot;
            current.restSlot = slot as MealBreakRestSlot;
        }
        byRamal.set(ramal, current);

        if (entry.tags.includes("RECIP")) {
            recipRamals.add(ramal);
        }
        if (entry.tags.includes("MRV")) {
            mrvRamals.add(ramal);
        }
    };

    for (const entry of parsed.lunch) {
        register(entry, entry.slot, "lunch");
    }
    for (const entry of parsed.rest) {
        register(entry, entry.slot, "rest");
    }

    const report: MealBreakSummaryRestoreReport = {
        matched: [...byRamal.values()],
        unmatchedNames: [...new Set(unmatchedNames)],
        halfShiftRemoved: halfShiftRamals,
        excludedBlocks: parsed.excludedBlocks,
        recipRamal: [...recipRamals][0] ?? baseSession.recipRamal,
        mrvRamals: mrvRamals.size > 0 ? [...mrvRamals] : baseSession.mrvRamals,
        applied: false,
        session: null,
    };

    if (report.unmatchedNames.length > 0) {
        return report;
    }

    // mrvLunch1230Ramal é o que destrava a fase de MRV no sync: sem ele o
    // syncDaySessionState apaga os descansos que acabamos de restaurar.
    const mrvLunch1230Ramal = report.mrvRamals.find((ramal) => lunchAssignments[ramal] === "12:30")
        ?? baseSession.mrvLunch1230Ramal
        ?? report.mrvRamals[0]
        ?? null;

    const restored = syncDaySessionState(withEvent({
        ...baseSession,
        recipRamal: report.recipRamal,
        mrvRamals: report.mrvRamals,
        mrvLunch1230Ramal,
        lunchAssignments,
        restAssignments,
        updatedAt: params.referenceAt.toISOString(),
    }, {
        type: "session_restored",
        actorTelegramId: params.actorTelegramId ?? null,
    }, params.referenceAt));

    report.session = restored;
    if (!params.apply) {
        return report;
    }

    await saveMealBreakSession(chatId, restored, "restored");
    report.applied = true;
    return report;
}

export async function runTelegramMealBreakCommand(params: {
    chatId: string;
    referenceAt: Date;
    trigger: "manual" | "automatic";
    mode?: MealBreakMode;
    forceRestart: boolean;
    action?: TelegramMealBreakCommand["action"];
    restorePosition?: number | null;
    actorTelegramId: string | null;
    board?: OperationalBoard;
}) {
    const mode = params.mode ?? resolveMealBreakModeFromReference(params.referenceAt);
    const operationalDate = formatOperationalDate(params.referenceAt);
    const existing = await loadMealBreakSession(params.chatId, operationalDate, mode);

    if (params.action === "restore_list" || params.action === "restore_apply") {
        return runMealBreakRestore({
            chatId: params.chatId,
            mode,
            operationalDate,
            referenceAt: params.referenceAt,
            actorTelegramId: params.actorTelegramId,
            position: params.action === "restore_apply" ? params.restorePosition ?? null : null,
            current: existing,
        });
    }

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
    const eligibilityExclusions = resolveMealBreakEligibilityExclusions(
        eligibilityOverrides,
        buildBoardRamalMaps(board).ramalByDoctorId,
    );
    const session = createMealBreakSession({
        roster: priorityContext.entries.map((entry) => entry.doctor),
        chiefRamal: priorityContext.chiefRamal,
        mrvRamals: priorityContext.mrvRamals,
        referenceAt: params.referenceAt,
        mode,
        trigger: params.trigger,
        restarted: Boolean(existing && params.forceRestart),
        actorTelegramId: params.actorTelegramId,
        lunchExcludedRamals: eligibilityExclusions.lunchExcludedRamals,
        restExcludedRamals: eligibilityExclusions.restExcludedRamals,
    });

    await saveMealBreakSession(
        params.chatId,
        session,
        existing && params.forceRestart ? "session_restarted" : "session_started",
    );

    const intro = existing && params.forceRestart
        ? "Divisão anterior descartada. Vamos reiniciar."
        : null;
    const halfShiftNotice = buildHalfShiftOutOfDivisionNotice({
        excluded: priorityContext.halfShiftExcluded,
        mode,
    });

    return {
        session,
        messages: [intro, buildStartPrompt(session), halfShiftNotice].filter((value): value is string => Boolean(value)),
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

    // O "↩️ Desfazer" também passa por aqui: rotula como undo para o ponto de
    // restauração ficar legível na lista.
    await saveMealBreakSession(
        params.chatId,
        result.session,
        normalizeFreeText(params.text) === normalizeFreeText(UNDO_TEXT) ? "undo" : "choice",
    );
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

type MealBreakRewindStageKey = "lunch" | "rest_choice" | "night_work" | "dinner_choice";

export interface MealBreakLatecomerRewind {
    stage: MealBreakRewindStageKey;
    pivotRamal: string;
    /** Horários lotados/bloqueados no momento em que o pivô escolheu. */
    blockedSlots: string[];
    /** Pivô + todos que escolheram depois dele na mesma etapa, na ordem original. */
    clearedRamals: string[];
}

interface MealBreakRewindStageSpec {
    key: MealBreakRewindStageKey;
    pool: readonly string[];
    oldCapacities: Record<string, number>;
    newCapacities: Record<string, number>;
    eventType: MealBreakSessionEvent["type"];
}

// Última escolha manual por ramal (re-escolhas e undo substituem), na ordem cronológica.
function listMealBreakStageSelectionEvents(session: MealBreakSession, spec: MealBreakRewindStageSpec) {
    const byRamal = new Map<string, MealBreakSessionEvent>();
    for (const event of session.events) {
        if (event.type !== spec.eventType || !event.ramal || !event.slot) {
            continue;
        }
        if (!spec.pool.includes(event.slot)) {
            continue;
        }
        byRamal.set(event.ramal, event);
    }
    return [...byRamal.values()].sort((left, right) => left.recordedAt.localeCompare(right.recordedAt));
}

/**
 * Ponto de rebobina quando um retardatário entra na sessão: repete as escolhas
 * na ordem em que aconteceram, contra as capacidades ANTIGAS, e para na
 * primeira escolha que NÃO foi livre — horário já lotado, ou COI bloqueado do
 * horário do par mesmo havendo vaga. Desse ponto em diante todo mundo escolhe
 * de novo, agora com as vagas recalculadas; quem escolheu com todas as opções
 * abertas escolheu por vontade própria e é mantido (decisão do usuário,
 * 04/08/2026: não dá para saber se quem escolheu sob restrição teria escolhido
 * o mesmo — então volta até onde a escolha era entre tudo).
 *
 * Só rebobina etapas cuja capacidade de fato mudou com o novo total.
 * ponytail: a reserva preventiva de COI (wouldCoiConflictAfterChoice) e o caso
 * do jantar cuja capacidade só muda depois de o novato escolher 23:00 não são
 * detectados — cobrir se aparecer na prática.
 */
export function resolveMealBreakLatecomerRewind(params: {
    before: MealBreakSession;
    after: MealBreakSession;
}): MealBreakLatecomerRewind | null {
    const { before, after } = params;
    const specs: MealBreakRewindStageSpec[] = before.mode === "night"
        ? [
            { key: "night_work", pool: NIGHT_WORK_SLOTS, oldCapacities: before.nightWorkCapacities, newCapacities: after.nightWorkCapacities, eventType: "night_work_selected" },
            { key: "dinner_choice", pool: DINNER_CHOICE_SLOTS, oldCapacities: before.dinnerChoiceCapacities, newCapacities: after.dinnerChoiceCapacities, eventType: "night_dinner_selected" },
        ]
        : [
            { key: "lunch", pool: LUNCH_SLOTS, oldCapacities: before.lunchCapacities, newCapacities: after.lunchCapacities, eventType: "lunch_selected" },
            { key: "rest_choice", pool: ["15:30", "16:30"], oldCapacities: before.restChoiceCapacities, newCapacities: after.restChoiceCapacities, eventType: "rest_selected" },
        ];

    const roleByRamal = new Map(before.roster.map((doctor) => [doctor.ramal, doctor.roleLabel]));

    for (const spec of specs) {
        const capacitiesChanged = spec.pool.some(
            (slot) => (spec.oldCapacities[slot] ?? 0) !== (spec.newCapacities[slot] ?? 0),
        );
        if (!capacitiesChanged) {
            continue;
        }

        const events = listMealBreakStageSelectionEvents(before, spec);
        const remaining: Record<string, number> = { ...spec.oldCapacities };
        const coiSlots = new Set<string>();

        for (const [index, event] of events.entries()) {
            const baseline = spec.pool.filter((slot) => (spec.oldCapacities[slot] ?? 0) > 0);
            const fullSlots = baseline.filter((slot) => (remaining[slot] ?? 0) <= 0);
            const isCoi = isSharedPositionRole(roleByRamal.get(event.ramal as string));
            const coiBlockedSlots = isCoi
                ? baseline.filter((slot) => coiSlots.has(slot) && (remaining[slot] ?? 0) > 0)
                : [];
            const blockedSlots = [...new Set([...fullSlots, ...coiBlockedSlots])];

            if (blockedSlots.length > 0) {
                return {
                    stage: spec.key,
                    pivotRamal: event.ramal as string,
                    blockedSlots,
                    clearedRamals: events.slice(index).map((entry) => entry.ramal as string),
                };
            }

            remaining[event.slot as string] = (remaining[event.slot as string] ?? 0) - 1;
            if (isCoi) {
                coiSlots.add(event.slot as string);
            }
        }
    }

    return null;
}

// Limpa as escolhas do pivô em diante; a etapa dependente (descanso/janta dos
// afetados) é refeita pelo sync. Escolhas anteriores ao pivô ficam intactas.
export function applyMealBreakLatecomerRewind(session: MealBreakSession, rewind: MealBreakLatecomerRewind): MealBreakSession {
    const next = {
        ...session,
        lunchAssignments: { ...session.lunchAssignments },
        restAssignments: { ...session.restAssignments },
        nightWorkAssignments: { ...session.nightWorkAssignments },
        dinnerAssignments: { ...session.dinnerAssignments },
    };
    for (const ramal of rewind.clearedRamals) {
        if (rewind.stage === "lunch") {
            delete next.lunchAssignments[ramal];
        } else if (rewind.stage === "rest_choice") {
            delete next.restAssignments[ramal];
        } else if (rewind.stage === "night_work") {
            delete next.nightWorkAssignments[ramal];
            delete next.dinnerAssignments[ramal];
        } else {
            delete next.dinnerAssignments[ramal];
        }
    }
    return next;
}

function stageIgnoredRamals(session: MealBreakSession, stage: MealBreakRewindStageKey): Set<string> {
    if (stage === "lunch") {
        return new Set([
            ...(session.lunchExcludedRamals ?? []),
            ...session.roster.filter((doctor) => isMealBreakDiscretionaryRole(doctor.roleLabel)).map((doctor) => doctor.ramal),
        ]);
    }
    if (stage === "rest_choice") {
        return new Set([
            ...(session.restExcludedRamals ?? []),
            ...session.roster.filter((doctor) => isMealBreakDiscretionaryRole(doctor.roleLabel)).map((doctor) => doctor.ramal),
        ]);
    }
    return new Set();
}

function assignmentsForImpactStage(session: MealBreakSession, stage: MealBreakRewindStageKey): Record<string, string> {
    if (stage === "lunch") return session.lunchAssignments;
    if (stage === "rest_choice") return session.restAssignments;
    if (stage === "night_work") return session.nightWorkAssignments;
    return session.dinnerAssignments;
}

/**
 * Régua da mudança no quadro (Fora, encerrar, função, remanejar): só rebobina
 * se a escolha de alguém ficou ilegal depois, ou se essa pessoa teria tido
 * opção a mais no mundo novo. Capacidade que muda sem liberar escolha de
 * ninguém não reinicia nada. Diferente da rebobina do retardatário, que é
 * mais agressiva (qualquer restrição + qualquer mudança de vaga).
 */
export function resolveMealBreakChoiceImpact(params: {
    before: MealBreakSession;
    after: MealBreakSession;
}): MealBreakLatecomerRewind | null {
    const { before, after } = params;
    const specs: MealBreakRewindStageSpec[] = before.mode === "night"
        ? [
            { key: "night_work", pool: NIGHT_WORK_SLOTS, oldCapacities: before.nightWorkCapacities, newCapacities: after.nightWorkCapacities, eventType: "night_work_selected" },
            { key: "dinner_choice", pool: DINNER_CHOICE_SLOTS, oldCapacities: before.dinnerChoiceCapacities, newCapacities: after.dinnerChoiceCapacities, eventType: "night_dinner_selected" },
        ]
        : [
            { key: "lunch", pool: LUNCH_SLOTS, oldCapacities: before.lunchCapacities, newCapacities: after.lunchCapacities, eventType: "lunch_selected" },
            { key: "rest_choice", pool: ["15:30", "16:30"], oldCapacities: before.restChoiceCapacities, newCapacities: after.restChoiceCapacities, eventType: "rest_selected" },
        ];

    const roleBefore = new Map(before.roster.map((doctor) => [doctor.ramal, doctor.roleLabel]));
    const roleAfter = new Map(after.roster.map((doctor) => [doctor.ramal, doctor.roleLabel]));
    const afterRoster = new Set(after.roster.map((doctor) => doctor.ramal));

    for (const spec of specs) {
        const ignoredAfter = stageIgnoredRamals(after, spec.key);
        const events = listMealBreakStageSelectionEvents(before, spec);
        const remainingOld: Record<string, number> = { ...spec.oldCapacities };
        const remainingNew: Record<string, number> = { ...spec.newCapacities };
        const eventRamals = new Set(events.map((event) => event.ramal as string));

        for (const [ramal, slot] of Object.entries(assignmentsForImpactStage(before, spec.key))) {
            if (eventRamals.has(ramal) || !spec.pool.includes(slot)) {
                continue;
            }
            remainingOld[slot] = (remainingOld[slot] ?? 0) - 1;
        }
        for (const [ramal, slot] of Object.entries(assignmentsForImpactStage(after, spec.key))) {
            if (eventRamals.has(ramal) || !spec.pool.includes(slot) || ignoredAfter.has(ramal)) {
                continue;
            }
            remainingNew[slot] = (remainingNew[slot] ?? 0) - 1;
        }

        const coiOld = new Set<string>();
        const coiNew = new Set<string>();

        const blockedIn = (
            remaining: Record<string, number>,
            capacities: Record<string, number>,
            coiSlots: Set<string>,
            roleLabel: string | null | undefined,
        ) => {
            const baseline = spec.pool.filter((slot) => (capacities[slot] ?? 0) > 0);
            const fullSlots = baseline.filter((slot) => (remaining[slot] ?? 0) <= 0);
            const coiBlocked = isSharedPositionRole(roleLabel)
                ? baseline.filter((slot) => coiSlots.has(slot) && (remaining[slot] ?? 0) > 0)
                : [];
            return [...new Set([...fullSlots, ...coiBlocked])];
        };

        for (const [index, event] of events.entries()) {
            const ramal = event.ramal as string;
            const chosen = event.slot as string;
            const stillHere = afterRoster.has(ramal) && !ignoredAfter.has(ramal);

            if (!stillHere) {
                remainingOld[chosen] = (remainingOld[chosen] ?? 0) - 1;
                if (isSharedPositionRole(roleBefore.get(ramal))) {
                    coiOld.add(chosen);
                }
                continue;
            }

            const blockedOld = blockedIn(remainingOld, spec.oldCapacities, coiOld, roleBefore.get(ramal));
            const blockedNew = blockedIn(remainingNew, spec.newCapacities, coiNew, roleAfter.get(ramal));
            const freeOld = new Set(spec.pool.filter((slot) => !blockedOld.includes(slot) && (remainingOld[slot] ?? 0) > 0));
            const freeNew = new Set(spec.pool.filter((slot) => !blockedNew.includes(slot) && (remainingNew[slot] ?? 0) > 0));
            const extraOptions = [...freeNew].filter((slot) => !freeOld.has(slot));
            const choiceIllegalAfter = (remainingNew[chosen] ?? 0) <= 0 || blockedNew.includes(chosen);

            if (choiceIllegalAfter || extraOptions.length > 0) {
                const clearedRamals = events.slice(index)
                    .map((entry) => entry.ramal as string)
                    .filter((cleared) => afterRoster.has(cleared) && !ignoredAfter.has(cleared));
                return {
                    stage: spec.key,
                    pivotRamal: ramal,
                    blockedSlots: choiceIllegalAfter ? [chosen] : extraOptions,
                    clearedRamals,
                };
            }

            remainingOld[chosen] = (remainingOld[chosen] ?? 0) - 1;
            remainingNew[chosen] = (remainingNew[chosen] ?? 0) - 1;
            if (isSharedPositionRole(roleBefore.get(ramal))) {
                coiOld.add(chosen);
            }
            if (isSharedPositionRole(roleAfter.get(ramal))) {
                coiNew.add(chosen);
            }
        }
    }

    return null;
}

export type MealBreakBoardChangeKind = "none" | "sync" | "rewind" | "structural" | "stale";

export interface MealBreakBoardEvaluation {
    kind: MealBreakBoardChangeKind;
    rewind: MealBreakLatecomerRewind | null;
    structuralReasons: Array<"recip" | "mrv">;
    rosterAdded: string[];
    rosterRemoved: string[];
    staleHint: string | null;
    mealLabel: "almoço" | "jantar";
}

function liveEligibleMealBreakDoctors(
    board: OperationalBoard,
    mode: MealBreakMode,
    referenceAt: Date,
): MealBreakRosterDoctor[] {
    return board.regulation
        .map((row) => mapRegulationDoctor(row, mode, referenceAt))
        .filter((doctor): doctor is MealBreakRosterDoctor => Boolean(doctor))
        .filter((doctor) => doctor.ramal !== CHIEF_RAMAL && !isMealBreakDiscretionaryRole(doctor.roleLabel));
}

export function projectMealBreakSessionOntoBoard(params: {
    session: MealBreakSession;
    board: OperationalBoard;
    lunchExcludedRamals?: string[];
    restExcludedRamals?: string[];
    referenceAt: Date;
}): MealBreakSession {
    const remapped = reconcileMealBreakSessionRamalsWithBoard({
        session: params.session,
        board: params.board,
    });
    const liveDoctors = liveEligibleMealBreakDoctors(params.board, remapped.mode, params.referenceAt);
    const liveByDoctorId = new Map(liveDoctors.map((doctor) => [doctor.doctorId, doctor]));
    const liveByRamal = new Map(liveDoctors.map((doctor) => [doctor.ramal, doctor]));

    const kept = remapped.roster
        .filter((doctor) => liveByDoctorId.has(doctor.doctorId) || liveByRamal.has(doctor.ramal))
        .map((doctor) => {
            const live = liveByDoctorId.get(doctor.doctorId) ?? liveByRamal.get(doctor.ramal);
            if (!live) {
                return doctor;
            }
            return {
                ...doctor,
                ramal: live.ramal,
                name: live.name,
                roleLabel: live.roleLabel,
                startedAt: live.startedAt,
                arrivalStartedAt: live.arrivalStartedAt ?? doctor.arrivalStartedAt,
                shiftLabel: live.shiftLabel,
            };
        });

    const keptIds = new Set(kept.map((doctor) => doctor.doctorId));
    const keptRamals = new Set(kept.map((doctor) => doctor.ramal));
    const added = liveDoctors
        .filter((doctor) => !keptIds.has(doctor.doctorId) && !keptRamals.has(doctor.ramal))
        .map((doctor) => stripMealBreakRosterDoctor(doctor));

    const roster = [...kept, ...added];
    const rosterRamals = new Set(roster.map((doctor) => doctor.ramal));
    const mrvRamals = roster
        .filter((doctor) => doctor.roleLabel === "MRV")
        .map((doctor) => doctor.ramal);
    const recipRamal = remapped.recipRamal && rosterRamals.has(remapped.recipRamal)
        ? remapped.recipRamal
        : null;
    const mrvLunch1230Ramal = remapped.mrvLunch1230Ramal && mrvRamals.includes(remapped.mrvLunch1230Ramal)
        ? remapped.mrvLunch1230Ramal
        : null;

    const lunchExcludedRamals = (params.lunchExcludedRamals ?? remapped.lunchExcludedRamals)
        .map(normalizeRamal)
        .filter((ramal) => rosterRamals.has(ramal));
    const restExcludedRamals = (params.restExcludedRamals ?? remapped.restExcludedRamals)
        .map(normalizeRamal)
        .filter((ramal) => rosterRamals.has(ramal));

    const next: MealBreakSession = {
        ...remapped,
        roster,
        recipRamal,
        mrvRamals,
        mrvLunch1230Ramal,
        lunchExcludedRamals,
        restExcludedRamals,
    };

    return remapped.mode === "night" ? syncNightSessionState(next) : syncDaySessionState(next);
}

export function evaluateMealBreakSessionAgainstBoard(params: {
    session: MealBreakSession;
    board: OperationalBoard;
    lunchExcludedRamals?: string[];
    restExcludedRamals?: string[];
    referenceAt?: Date;
}): { evaluation: MealBreakBoardEvaluation; projected: MealBreakSession } {
    const referenceAt = params.referenceAt ?? new Date();
    const projected = projectMealBreakSessionOntoBoard({
        session: params.session,
        board: params.board,
        lunchExcludedRamals: params.lunchExcludedRamals,
        restExcludedRamals: params.restExcludedRamals,
        referenceAt,
    });
    const mealLabel: MealBreakBoardEvaluation["mealLabel"] = params.session.mode === "night" ? "jantar" : "almoço";
    const beforeIds = new Set(params.session.roster.map((doctor) => doctor.doctorId));
    const afterIds = new Set(projected.roster.map((doctor) => doctor.doctorId));
    const rosterAdded = projected.roster
        .filter((doctor) => !beforeIds.has(doctor.doctorId))
        .map((doctor) => doctor.ramal);
    const rosterRemoved = params.session.roster
        .filter((doctor) => !afterIds.has(doctor.doctorId))
        .map((doctor) => doctor.ramal);

    const structuralReasons: Array<"recip" | "mrv"> = [];
    if (params.session.mode === "day" && params.session.recipRamal && params.session.recipRamal !== projected.recipRamal) {
        structuralReasons.push("recip");
    }
    if (params.session.mode === "day" && params.session.mrvLunch1230Ramal && params.session.mrvLunch1230Ramal !== projected.mrvLunch1230Ramal) {
        structuralReasons.push("mrv");
    }

    const rewind = resolveMealBreakChoiceImpact({ before: params.session, after: projected });
    const rolesChanged = params.session.roster.some((doctor) => {
        const next = projected.roster.find((candidate) => candidate.doctorId === doctor.doctorId);
        return Boolean(next && next.roleLabel !== doctor.roleLabel);
    });
    const ramalsChanged = params.session.roster.some((doctor) => {
        const next = projected.roster.find((candidate) => candidate.doctorId === doctor.doctorId);
        return Boolean(next && next.ramal !== doctor.ramal);
    });
    const exclusionsChanged = params.session.mode === "day" && (
        params.session.lunchExcludedRamals.join() !== projected.lunchExcludedRamals.join()
        || params.session.restExcludedRamals.join() !== projected.restExcludedRamals.join()
    );

    const drifted = rosterAdded.length > 0
        || rosterRemoved.length > 0
        || structuralReasons.length > 0
        || Boolean(rewind)
        || rolesChanged
        || ramalsChanged
        || exclusionsChanged;

    const base = {
        rewind,
        structuralReasons,
        rosterAdded,
        rosterRemoved,
        mealLabel,
        staleHint: null as string | null,
    };

    if (!drifted) {
        return { evaluation: { ...base, kind: "none" }, projected };
    }

    if (params.session.stage === "completed" && (rewind || structuralReasons.length > 0 || rosterAdded.length > 0 || rosterRemoved.length > 0 || exclusionsChanged)) {
        const hint = rewind
            ? `A divisão do ${mealLabel} já fechou, mas o quadro mudou as vagas. Quem escolheu sem ter as opções de agora precisaria escolher de novo — isso só acontece se a chefia reiniciar.`
            : rosterRemoved.length > 0
                ? `A divisão do ${mealLabel} já fechou e tem gente que saiu do quadro. Reiniciar refaz as vagas; manter deixa os horários combinados.`
                : `A divisão do ${mealLabel} já fechou. Essa mudança no quadro não entra sozinha. Reiniciar descarta os horários combinados.`
        return {
            evaluation: { ...base, kind: "stale", staleHint: hint },
            projected,
        };
    }

    if (structuralReasons.length > 0) {
        return { evaluation: { ...base, kind: "structural" }, projected };
    }
    if (rewind) {
        return { evaluation: { ...base, kind: "rewind" }, projected };
    }
    return { evaluation: { ...base, kind: "sync" }, projected };
}

function buildBoardReconcileMessages(params: {
    evaluation: MealBreakBoardEvaluation;
    before: MealBreakSession;
    after: MealBreakSession;
}): string[] {
    const { evaluation, after } = params;
    if (evaluation.kind === "none" || evaluation.kind === "stale") {
        return [];
    }

    const mealLabel = evaluation.mealLabel;
    const nameOf = (ramal: string) => renderDoctorCompactSummary(after, ramal) || ramal;
    const messages: string[] = [];

    if (evaluation.rosterRemoved.length > 0) {
        messages.push(`🍽️ Saíram da divisão do ${mealLabel}: ${evaluation.rosterRemoved.map(nameOf).join(", ")}.`);
    }
    if (evaluation.rosterAdded.length > 0) {
        messages.push(`🍽️ Entraram na divisão do ${mealLabel}: ${evaluation.rosterAdded.map(nameOf).join(", ")} — agora ${after.roster.length} plantonistas.`);
    }
    if (evaluation.structuralReasons.includes("recip")) {
        messages.push("⏪ O RECIP não está mais no quadro. Voltei a essa etapa.");
    }
    if (evaluation.structuralReasons.includes("mrv")) {
        messages.push("⏪ O MRV da divisão não está mais no quadro. Voltei a escolher o almoço dos MRV.");
    }
    if (evaluation.rewind) {
        const clearedList = evaluation.rewind.clearedRamals.map((ramal) => nameOf(ramal)).join(", ");
        messages.push(
            `⏪ Recalculei as vagas do ${mealLabel}. Voltei até ${nameOf(evaluation.rewind.pivotRamal)}: ${evaluation.rewind.blockedSlots.join("/")} passou a ser opção (ou a escolha ficou sem vaga). Refazem: ${clearedList}. Quem escolheu com tudo livre foi mantido.`,
        );
    } else if (evaluation.kind === "sync" && evaluation.rosterAdded.length === 0 && evaluation.rosterRemoved.length === 0) {
        return [];
    }

    if (after.stage !== "completed" && (evaluation.kind === "rewind" || evaluation.kind === "structural" || evaluation.rosterAdded.length > 0 || evaluation.rosterRemoved.length > 0)) {
        messages.push(buildCurrentPrompt(after));
    }

    return messages;
}

export async function maybeReconcileLiveMealBreakSession(params: {
    trigger: "board_change" | "eligibility" | "manual";
    actorTelegramId?: string | null;
    referenceAt?: Date;
    chatId?: string;
}): Promise<{ evaluation: MealBreakBoardEvaluation | null; session: MealBreakSession | null }> {
    const referenceAt = params.referenceAt ?? new Date();
    const mode = resolveMealBreakModeFromReference(referenceAt);
    const resolved = params.chatId
        ? {
            chatId: params.chatId,
            session: await loadMealBreakSession(params.chatId, formatOperationalDate(referenceAt), mode),
        }
        : await resolveCurrentOperationalMealBreakState(referenceAt, mode);
    if (!resolved?.session || !resolved.chatId) {
        return { evaluation: null, session: null };
    }

    const board = await getOperationalBoard();
    const eligibility = resolved.session.mode === "day"
        ? await loadMealBreakEligibilityOverrides(resolved.session.operationalDate, "day")
            .then((overrides) => resolveMealBreakEligibilityExclusions(overrides, buildBoardRamalMaps(board).ramalByDoctorId))
        : { lunchExcludedRamals: [] as string[], restExcludedRamals: [] as string[] };

    const { evaluation, projected } = evaluateMealBreakSessionAgainstBoard({
        session: resolved.session,
        board,
        lunchExcludedRamals: eligibility.lunchExcludedRamals,
        restExcludedRamals: eligibility.restExcludedRamals,
        referenceAt,
    });

    if (evaluation.kind === "none" || evaluation.kind === "stale") {
        return { evaluation, session: resolved.session };
    }

    const withEventSession = withEvent(projected, {
        type: evaluation.rewind ? "board_rewind" : "board_reconciled",
        actorTelegramId: params.actorTelegramId ?? null,
        ramal: evaluation.rewind?.pivotRamal,
    }, referenceAt);
    const sync = resolved.session.mode === "night" ? syncNightSessionState : syncDaySessionState;
    const rewound = evaluation.rewind
        ? sync(applyMealBreakLatecomerRewind(withEventSession, evaluation.rewind))
        : sync(withEventSession);

    await saveMealBreakSession(
        resolved.chatId,
        rewound,
        evaluation.rewind ? "board_rewind" : "board_reconcile",
    );

    const messages = buildBoardReconcileMessages({
        evaluation: { ...evaluation, rewind: evaluation.rewind },
        before: resolved.session,
        after: rewound,
    });
    if (messages.length > 0) {
        await sendTelegramMealBreakMessages({
            chatId: resolved.chatId,
            messages,
            replyMarkup: buildMealBreakStageKeyboard(rewound) ?? undefined,
            options: MEAL_BREAK_FORMAT_OPTIONS,
        });
    }

    return { evaluation, session: rewound };
}

export async function restartCurrentMealBreakSession(params: {
    actorUserId?: string | null;
    referenceAt?: Date;
}) {
    const referenceAt = params.referenceAt ?? new Date();
    const mode = resolveMealBreakModeFromReference(referenceAt);
    const resolved = await resolveCurrentOperationalMealBreakState(referenceAt, mode);
    if (!resolved?.chatId) {
        throw new MealBreakUserError(
            mode === "night"
                ? "Não existe divisão de jantar em curso para reiniciar."
                : "Não existe divisão de almoço em curso para reiniciar.",
        );
    }

    const result = await runTelegramMealBreakCommand({
        chatId: resolved.chatId,
        referenceAt,
        trigger: "manual",
        mode,
        forceRestart: true,
        actorTelegramId: params.actorUserId ?? null,
    });
    const restarted = result.session;
    if (!restarted) {
        throw new MealBreakUserError("Não consegui reiniciar a divisão agora.");
    }

    await sendTelegramMealBreakMessages({
        chatId: resolved.chatId,
        messages: result.messages,
        replyMarkup: buildMealBreakStageKeyboard(restarted) ?? undefined,
        options: MEAL_BREAK_FORMAT_OPTIONS,
    });

    return { ...result, session: restarted };
}

export type MealBreakLatecomerSkipReason = "division_completed" | "half_shift";

/**
 * Chegadas tardias que NÃO entram na divisão já montada — a inclusão automática
 * é para quem chega com o fluxo ainda rolando, não para desmanchar o que já
 * está combinado (decisão do usuário, 04/08/2026, depois de a rebobina melar
 * quadro pronto):
 *
 * - `division_completed`: todos já escolheram e a divisão fechou. Incluir mais
 *   um reabre a etapa, recalcula as vagas e (no diurno) apaga os descansos já
 *   combinados — gente que já saiu para comer perderia o horário. Quem chega
 *   depois de fechada fica de fora; a chefia decide caso a caso (reiniciar a
 *   divisão ou ajustar pelo painel).
 * - `half_shift`: meio plantão não participa da divisão em circunstância
 *   nenhuma — a exclusão principal é no mapRegulationBoardEntry (ele nem chega
 *   ao roster). Este guard é a rede: sessão montada antes de a chefia trocar a
 *   função para MEIO no painel guarda o rótulo antigo no roster.
 *
 * Vale para os dois modos: a divisão do jantar tem a mesma regra.
 */
export function resolveMealBreakLatecomerSkip(params: {
    session: MealBreakSession;
    roleLabel: string | null | undefined;
}): MealBreakLatecomerSkipReason | null {
    if (params.session.stage === "completed") {
        return "division_completed";
    }

    if (isHalfShiftRoleLabel(params.roleLabel)) {
        return "half_shift";
    }

    return null;
}

/**
 * Chegada/continuação declarada DEPOIS de a sessão de refeições já estar
 * montada: inclui o médico no roster automaticamente (mesmo mecanismo da
 * soberania do chefe), anuncia no grupo o novo total, e rebobina a divisão até
 * a última escolha 100% livre (ver resolveMealBreakLatecomerRewind) — quem
 * escolheu sob lotação/bloqueio ganha a escolha de novo com as vagas novas.
 * Exceções em resolveMealBreakLatecomerSkip (divisão já fechada, meio plantão):
 * nesses casos nada é salvo, só um aviso no grupo.
 * Best-effort: retorna false quando não há sessão, o ramal já está no roster ou
 * o médico não é elegível (PIAM/NUCLEO/outro turno) — nunca lança para o caller.
 */
export async function ensureArrivalInCurrentMealBreakSession(params: {
    ramal: string;
    referenceAt?: Date;
}): Promise<boolean> {
    const referenceAt = params.referenceAt ?? new Date();
    const mode = resolveMealBreakModeFromReference(referenceAt);
    const state = await resolveCurrentOperationalMealBreakState(referenceAt, mode);
    if (!state?.session || !state.chatId) {
        return false;
    }

    const ramal = normalizeRamal(params.ramal);
    if (findDoctor(state.session, ramal)) {
        return false;
    }

    const mealLabel = mode === "night" ? "jantar" : "almoço";
    const restartCmd = mode === "night" ? "/jantar reiniciar" : "/almoco reiniciar";
    const ensured = await ensureMealBreakDoctorInSession({
        session: state.session,
        ramal,
        mode,
        referenceAt,
    });

    // Chegou de MEIO plantão: fica fora por regra (nem participa, nem muda as
    // vagas de ninguém), mas o grupo é avisado de quem ficou de fora e de que a
    // função é editável no painel. PIAM/NUCLEO e outro turno saem em silêncio —
    // ali não há nada a corrigir.
    if (ensured.status !== "ready") {
        if (ensured.reason === "half_shift") {
            const notice = buildHalfShiftOutOfDivisionNotice({
                excluded: [{ ramal, name: ensured.name }],
                mode,
            });
            if (notice) {
                await sendTelegramMealBreakMessages({
                    chatId: state.chatId,
                    messages: [notice],
                    options: MEAL_BREAK_FORMAT_OPTIONS,
                });
            }
        }
        return false;
    }

    if (ensured.session === state.session) {
        return false;
    }

    const joining = findDoctor(ensured.session, ramal);
    const joiningName = joining ? resolveDoctorCompactName(joining) : escapeTelegramMarkdown(ramal);

    // Divisão fechada: não mexe em nada — nem roster, nem vagas, nem rebobina
    // (ver resolveMealBreakLatecomerSkip). Só avisa o grupo, e a sessão salva
    // continua exatamente a mesma.
    const skipReason = resolveMealBreakLatecomerSkip({
        session: state.session,
        roleLabel: joining?.roleLabel ?? null,
    });
    if (skipReason) {
        await sendTelegramMealBreakMessages({
            chatId: state.chatId,
            messages: [
                skipReason === "half_shift"
                    ? `🍽️ *${joiningName}* (${ramal}) está como meio plantão — a divisão do ${mealLabel} segue como está, sem refazer as escolhas.`
                    : `🍽️ *${joiningName}* (${ramal}) chegou com a divisão do ${mealLabel} já fechada — mantive os horários de todo mundo. Para incluir na divisão, chefia: ${restartCmd}.`,
            ],
            options: MEAL_BREAK_FORMAT_OPTIONS,
        });
        return false;
    }

    const withJoinEvent = withEvent(ensured.session, {
        type: "latecomer_joined",
        actorTelegramId: null,
        ramal,
    }, referenceAt);
    const sync = mode === "night" ? syncNightSessionState : syncDaySessionState;
    const syncedNext = sync(withJoinEvent);

    const rewind = resolveMealBreakLatecomerRewind({ before: state.session, after: syncedNext });
    const final = rewind
        ? sync(withEvent(applyMealBreakLatecomerRewind(withJoinEvent, rewind), {
            type: "latecomer_rewind",
            actorTelegramId: null,
            ramal: rewind.pivotRamal,
        }, referenceAt))
        : syncedNext;

    await saveMealBreakSession(state.chatId, final, rewind ? "latecomer_rewind" : "latecomer_joined");

    const messages: string[] = [
        `🍽️ *${joiningName}* (${ramal}) entrou na divisão do ${mealLabel} — agora ${final.roster.length} plantonistas; as vagas por horário foram recalculadas.`,
    ];
    if (rewind) {
        const clearedList = rewind.clearedRamals.map((cleared) => renderDoctorCompactSummary(final, cleared)).join(", ");
        messages.push(
            `⏪ Com mais um para dividir, voltei a divisão até ${renderDoctorCompactSummary(final, rewind.pivotRamal)}: quando escolheu, *${rewind.blockedSlots.join("/")}* já não tinha vaga livre. Refazem a escolha (agora com todas as opções): ${clearedList}. Quem escolheu com tudo livre foi mantido.`,
        );
    }
    if (final.stage !== "completed") {
        messages.push(buildCurrentPrompt(final));
    }
    await sendTelegramMealBreakMessages({
        chatId: state.chatId,
        messages,
        replyMarkup: buildMealBreakStageKeyboard(final) ?? undefined,
        options: MEAL_BREAK_FORMAT_OPTIONS,
    });
    return true;
}

export async function getCurrentMealBreakEligibilityOverrides(referenceAt = new Date()) {
    const mode = resolveMealBreakModeFromReference(referenceAt);
    const operationalDate = formatOperationalDate(referenceAt);
    const overrides = await loadMealBreakEligibilityOverrides(operationalDate, mode);
    if (!overrides) {
        return { lunchExcludedRamals: [] as string[], restExcludedRamals: [] as string[] };
    }

    // Resolve doctorId->ramal-atual contra o board vivo: as exclusoes seguem o remanejamento
    // mesmo antes de existir uma sessao (este endpoint alimenta o board cinza no front).
    const board = await getOperationalBoard();
    return resolveMealBreakEligibilityExclusions(overrides, buildBoardRamalMaps(board).ramalByDoctorId);
}

// Soberania do chefe: quando ele configura almoco/descanso/jantar de um plantonista que
// (ainda) nao esta no roster da sessao — tipicamente chegada tardia ou remanejamento para um
// ramal novo — nos o incluimos a partir do board ao vivo em vez de recusar com erro. PIAM/
// NUCLEO e medicos de outro turno seguem fora por regra (mapRegulationDoctor devolve null).
type EnsureMealBreakDoctorResult =
    | { status: "ready"; session: MealBreakSession }
    | { status: "out_of_division"; reason: MealBreakOutOfDivisionReason; name: string };

async function ensureMealBreakDoctorInSession(params: {
    session: MealBreakSession;
    ramal: string;
    mode: MealBreakMode;
    referenceAt: Date;
    board?: OperationalBoard;
}): Promise<EnsureMealBreakDoctorResult> {
    if (findDoctor(params.session, params.ramal)) {
        return { status: "ready", session: params.session };
    }

    const board = params.board ?? await getOperationalBoard();
    const row = board.regulation.find(
        (candidate) => candidate.status === "active" && normalizeRamal(candidate.postCode) === params.ramal,
    );
    if (!row) {
        return { status: "out_of_division", reason: "inactive", name: params.ramal };
    }

    const entry = mapRegulationBoardEntry(row, params.mode, params.referenceAt);
    if (entry.kind !== "doctor") {
        return { status: "out_of_division", reason: entry.reason, name: entry.name };
    }

    return {
        status: "ready",
        session: {
            ...params.session,
            roster: [...params.session.roster, stripMealBreakRosterDoctor(entry.doctor)],
        },
    };
}

/**
 * Inclui no roster um ramal que a inclusão automática recusaria (PIAM/NUCLEO,
 * meio plantão, outro turno), porque a chefia mandou explicitamente pelo painel.
 * Só recusa o que é impossível: ramal sem ninguém ativo no quadro — aí não há
 * médico a quem atribuir horário.
 */
async function forceMealBreakDoctorIntoSession(params: {
    session: MealBreakSession;
    ramal: string;
    mode: MealBreakMode;
    referenceAt: Date;
    reason: MealBreakOutOfDivisionReason;
}): Promise<MealBreakSession> {
    if (params.reason === "inactive") {
        throw new MealBreakUserError(resolveMealBreakOutOfDivisionMessage(params.ramal, "inactive"));
    }

    const board = await getOperationalBoard();
    const row = board.regulation.find(
        (candidate) => candidate.status === "active" && normalizeRamal(candidate.postCode) === params.ramal,
    );
    if (!row || !row.doctorId || !row.startedAt) {
        throw new MealBreakUserError(resolveMealBreakOutOfDivisionMessage(params.ramal, "inactive"));
    }

    return {
        ...params.session,
        roster: [
            ...params.session.roster,
            {
                doctorId: row.doctorId,
                ramal: params.ramal,
                name: formatDoctorSurfaceName({
                    fullName: row.doctorName,
                    displayName: row.displayName,
                    fallback: row.postCode,
                }),
                domain: "regulation",
                arrivalStartedAt: row.startedAt,
                startedAt: row.boardStartedAt ?? row.startedAt,
                shiftLabel: params.mode === "night" ? "SN" : "SD",
                roleLabel: nullifyGenericRegulatorRole(resolveOperationalRoleLabel({
                    domain: "regulation",
                    code: params.ramal,
                    shiftLabel: params.mode === "night" ? "SN" : "SD",
                    roleLabel: row.roleLabel,
                    defaultRole: row.defaultRole,
                })),
            },
        ],
    };
}

/**
 * Rebobina provocada por uma fixação da chefia no meio da divisão. Mesma régua
 * do retardatário: quem escolheu quando o horário fixado JÁ estava lotado (ou
 * ficou lotado agora por causa da fixação) não escolheu entre todas as opções,
 * e reescolhe. Quem escolheu com tudo livre é mantido.
 *
 * O pivô nunca é o próprio fixado, e escolhas anteriores à fixação que não
 * tocam o horário afetado ficam intactas — é o "voltar ao ponto onde a troca
 * não interfere em nada".
 */
export function resolveMealBreakChiefRewind(params: {
    before: MealBreakSession;
    after: MealBreakSession;
    pinnedRamal: string;
}): MealBreakLatecomerRewind | null {
    const { before, after, pinnedRamal } = params;
    const specs: MealBreakRewindStageSpec[] = before.mode === "night"
        ? [
            { key: "night_work", pool: NIGHT_WORK_SLOTS, oldCapacities: before.nightWorkCapacities, newCapacities: after.nightWorkCapacities, eventType: "night_work_selected" },
            { key: "dinner_choice", pool: DINNER_CHOICE_SLOTS, oldCapacities: before.dinnerChoiceCapacities, newCapacities: after.dinnerChoiceCapacities, eventType: "night_dinner_selected" },
        ]
        : [
            { key: "lunch", pool: LUNCH_SLOTS, oldCapacities: before.lunchCapacities, newCapacities: after.lunchCapacities, eventType: "lunch_selected" },
            { key: "rest_choice", pool: ["15:30", "16:30"], oldCapacities: before.restChoiceCapacities, newCapacities: after.restChoiceCapacities, eventType: "rest_selected" },
        ];

    for (const spec of specs) {
        const assignmentsAfter = spec.key === "lunch"
            ? after.lunchAssignments
            : spec.key === "rest_choice"
                ? after.restAssignments
                : spec.key === "night_work"
                    ? after.nightWorkAssignments
                    : after.dinnerAssignments;

        const pinnedSlot = assignmentsAfter[pinnedRamal] as string | undefined;
        if (!pinnedSlot || !spec.pool.includes(pinnedSlot)) {
            continue;
        }

        // Ocupação da etapa DEPOIS da fixação, contando só quem já tem horário.
        const remaining: Record<string, number> = { ...spec.newCapacities };
        remaining[pinnedSlot] = (remaining[pinnedSlot] ?? 0) - 1;

        const events = listMealBreakStageSelectionEvents(before, spec)
            .filter((event) => event.ramal !== pinnedRamal);

        for (const [index, event] of events.entries()) {
            const baseline = spec.pool.filter((slot) => (spec.newCapacities[slot] ?? 0) > 0);
            const fullSlots = baseline.filter((slot) => (remaining[slot] ?? 0) <= 0);

            // Só rebobina se a lotação que ele enfrenta agora envolve o horário
            // fixado: é a interferência que a troca criou.
            if (fullSlots.includes(pinnedSlot) && event.slot !== pinnedSlot) {
                return {
                    stage: spec.key,
                    pivotRamal: event.ramal as string,
                    blockedSlots: fullSlots,
                    clearedRamals: events.slice(index).map((entry) => entry.ramal as string),
                };
            }

            remaining[event.slot as string] = (remaining[event.slot as string] ?? 0) - 1;
        }
    }

    return null;
}

// Mensagem clara para os casos em que o medico legitimamente nao entra na divisao, no lugar
// do generico "nao participa da divisao atual" que confundia o chefe. O meio plantao ganha
// o caminho da correcao: a funcao e editavel no painel, o posto PIAM/NUCLEO nao.
function resolveMealBreakOutOfDivisionMessage(ramal: string, reason: MealBreakOutOfDivisionReason = "inactive") {
    if (reason === "half_shift") {
        return `O ramal ${ramal} está como MEIO plantão e por isso não entra na divisão de almoço/jantar (regra fixa, igual a PIAM/NÚCLEO): não participa nem muda as vagas dos horários. Se a função estiver errada, corrija no ${resolveMealBreakPanelLabel()} e reinicie a divisão.`;
    }
    if (reason === "fixed_post" || isPiamRegulationPost(ramal) || isNucleoRegulationPost(ramal)) {
        return `O posto ${ramal} (PIAM/NUCLEO) não entra na divisão de almoço/jantar por regra fixa.`;
    }
    if (reason === "other_shift") {
        return `O ramal ${ramal} está no outro turno, então não entra nesta divisão.`;
    }
    return `O posto ${ramal} não está ativo na regulação agora, então não dá para incluir na divisão.`;
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
    const baseSession = resolvedState?.session ?? null;
    if (!baseSession) {
        throw new MealBreakUserError("Não existe sessão noturna ativa para este plantão.");
    }
    if (!chatId) {
        throw new MealBreakUserError("Não consegui identificar o chat ativo da divisão noturna.");
    }

    const ramal = normalizeRamal(params.ramal);
    const ensured = await ensureMealBreakDoctorInSession({
        session: baseSession,
        ramal,
        mode: "night",
        referenceAt: params.referenceAt,
    });
    // Soberania do painel: ver updateDayMealBreakAssignment.
    const session = ensured.status === "ready"
        ? ensured.session
        : await forceMealBreakDoctorIntoSession({
            session: baseSession,
            ramal,
            mode: "night",
            referenceAt: params.referenceAt,
            reason: ensured.reason,
        });

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
            throw new MealBreakUserError("Defina primeiro o trabalho da noite antes do jantar.");
        }

        if (effectiveNightWorkSlot === "03:00") {
            if (params.dinnerSlot && params.dinnerSlot !== defaultLateDinner) {
                throw new MealBreakUserError("Quem trabalha às 03:00 deve jantar no último horário permitido.");
            }

            dinnerAssignments[ramal] = defaultLateDinner;
        } else {
            const nextDinnerSlot = params.dinnerSlot ?? null;

            if (nextDinnerSlot === null) {
                delete dinnerAssignments[ramal];
            } else {
                if (!DINNER_CHOICE_SLOTS.includes(nextDinnerSlot as (typeof DINNER_CHOICE_SLOTS)[number])) {
                    throw new MealBreakUserError("Quem trabalha às 23:00 só pode jantar entre 20:30 e 21:30.");
                }

                dinnerAssignments[ramal] = nextDinnerSlot;
            }
        }
    }

    const pins = { ...emptyMealBreakChiefPins(), ...(session.chiefPins ?? {}) };
    const nightWorkPins = { ...pins.nightWork };
    const dinnerPins = { ...pins.dinner };
    if (hasNightWorkPatch) {
        if (nightWorkAssignments[ramal]) {
            nightWorkPins[ramal] = nightWorkAssignments[ramal];
        } else {
            delete nightWorkPins[ramal];
        }
    }
    if (hasDinnerPatch || hasNightWorkPatch) {
        if (dinnerAssignments[ramal]) {
            dinnerPins[ramal] = dinnerAssignments[ramal];
        } else {
            delete dinnerPins[ramal];
        }
    }

    const pinned = syncNightSessionState(withEvent({
        ...session,
        nightWorkAssignments,
        dinnerAssignments,
        chiefPins: { ...pins, nightWork: nightWorkPins, dinner: dinnerPins },
        updatedAt: params.referenceAt.toISOString(),
    }, {
        type: "chief_pin_applied",
        actorTelegramId: params.actorTelegramId,
        ramal,
        slot: effectiveNightWorkSlot ?? dinnerAssignments[ramal] ?? undefined,
    }, params.referenceAt));

    const rewind = pinned.stage === "completed"
        ? null
        : resolveMealBreakChiefRewind({ before: session, after: pinned, pinnedRamal: ramal });
    const nextSession = rewind
        ? syncNightSessionState(withEvent(applyMealBreakLatecomerRewind(pinned, rewind), {
            type: "chief_pin_rewind",
            actorTelegramId: params.actorTelegramId,
            ramal: rewind.pivotRamal,
        }, params.referenceAt))
        : pinned;

    await saveMealBreakSession(chatId, nextSession, "chief_correction");
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
        throw new MealBreakUserError("Nenhuma mudança de almoço ou descanso foi informada.");
    }

    const operationalDate = formatOperationalDate(params.referenceAt);
    const normalizedRamal = normalizeRamal(params.ramal);
    const board = await getOperationalBoard();
    const { ramalByDoctorId, doctorIdByRamal } = buildBoardRamalMaps(board);

    // Exclusao segue o MEDICO: resolvemos o ramal clicado para o doctorId ativo no board.
    // Sem isso (posto vazio/inativo) nao da para gravar uma exclusao que acompanhe alguem.
    const targetDoctorId = doctorIdByRamal.get(normalizedRamal) ?? null;
    if (!targetDoctorId) {
        throw new MealBreakUserError(resolveMealBreakOutOfDivisionMessage(normalizedRamal));
    }

    const previous = await loadMealBreakEligibilityOverrides(operationalDate, "day");
    const lunchExcludedDoctorIds = resolveExcludedDoctorIdSet(previous, "lunch", doctorIdByRamal);
    const restExcludedDoctorIds = resolveExcludedDoctorIdSet(previous, "rest", doctorIdByRamal);

    if (Object.prototype.hasOwnProperty.call(params, "lunchExcluded")) {
        if (params.lunchExcluded) {
            lunchExcludedDoctorIds.add(targetDoctorId);
        } else {
            lunchExcludedDoctorIds.delete(targetDoctorId);
        }
    }

    if (Object.prototype.hasOwnProperty.call(params, "restExcluded")) {
        if (params.restExcluded) {
            restExcludedDoctorIds.add(targetDoctorId);
        } else {
            restExcludedDoctorIds.delete(targetDoctorId);
        }
    }

    const doctorIdsToRamals = (doctorIds: Set<string>) => [
        ...new Set(
            [...doctorIds]
                .map((doctorId) => ramalByDoctorId.get(doctorId))
                .filter((ramal): ramal is string => Boolean(ramal)),
        ),
    ];

    const overrides: MealBreakEligibilityOverrideRecord = {
        kind: ELIGIBILITY_KIND,
        version: 2,
        mode: "day",
        operationalDate,
        lunchExcludedDoctorIds: [...lunchExcludedDoctorIds],
        restExcludedDoctorIds: [...restExcludedDoctorIds],
        // Snapshot dos ramais atuais (compat/observabilidade) — a verdade sao os doctorIds.
        lunchExcludedRamals: doctorIdsToRamals(lunchExcludedDoctorIds),
        restExcludedRamals: doctorIdsToRamals(restExcludedDoctorIds),
        updatedAt: params.referenceAt.toISOString(),
    };

    await saveMealBreakEligibilityOverrides(overrides);

    const reconciled = await maybeReconcileLiveMealBreakSession({
        trigger: "eligibility",
        actorTelegramId: params.actorTelegramId,
        referenceAt: params.referenceAt,
        chatId: params.chatId,
    });

    return { session: reconciled.session, overrides, evaluation: reconciled.evaluation };
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
        throw new MealBreakUserError("Nenhuma mudança de almoço ou descanso foi informada.");
    }

    const operationalDate = formatOperationalDate(params.referenceAt);
    const resolvedState = params.chatId
        ? { chatId: params.chatId, session: await loadMealBreakSession(params.chatId, operationalDate, "day") }
        : await resolveCurrentOperationalMealBreakState(params.referenceAt, "day");
    const chatId = resolvedState?.chatId ?? null;
    const baseSession = resolvedState?.session ?? null;
    if (!baseSession) {
        throw new MealBreakUserError("Não existe sessão diurna ativa para este plantão.");
    }
    if (!chatId) {
        throw new MealBreakUserError("Não consegui identificar o chat ativo da divisão diurna.");
    }

    const ramal = normalizeRamal(params.ramal);
    const ensured = await ensureMealBreakDoctorInSession({
        session: baseSession,
        ramal,
        mode: "day",
        referenceAt: params.referenceAt,
    });
    // Soberania do painel: nem "fora da divisão" barra o clique do chefe. Se o
    // ramal está ativo no quadro, ele entra no roster para receber o horário —
    // PIAM/NUCLEO/MEIO só ficam de fora da inclusão AUTOMÁTICA, não de uma
    // decisão explícita da chefia.
    const session = ensured.status === "ready"
        ? ensured.session
        : await forceMealBreakDoctorIntoSession({
            session: baseSession,
            ramal,
            mode: "day",
            referenceAt: params.referenceAt,
            reason: ensured.reason,
        });

    const pins = { ...emptyMealBreakChiefPins(), ...(session.chiefPins ?? {}) };
    const lunchPins = { ...pins.lunch };
    const restPins = { ...pins.rest };
    const lunchAssignments = { ...session.lunchAssignments };
    const restAssignments = { ...session.restAssignments };

    if (hasLunchPatch) {
        if (params.lunchSlot === null) {
            delete lunchAssignments[ramal];
            delete lunchPins[ramal];
        } else if (params.lunchSlot) {
            lunchAssignments[ramal] = params.lunchSlot as MealBreakLunchSlot;
            lunchPins[ramal] = params.lunchSlot as MealBreakLunchSlot;
        }
    }

    if (hasRestPatch) {
        if (params.restSlot === null) {
            delete restAssignments[ramal];
            delete restPins[ramal];
        } else if (params.restSlot) {
            restAssignments[ramal] = params.restSlot as MealBreakRestSlot;
            restPins[ramal] = params.restSlot as MealBreakRestSlot;
        }
    }

    const pinned = syncDaySessionState(withEvent({
        ...session,
        lunchAssignments,
        restAssignments,
        chiefPins: { ...pins, lunch: lunchPins, rest: restPins },
        updatedAt: params.referenceAt.toISOString(),
    }, {
        type: "chief_pin_applied",
        actorTelegramId: params.actorTelegramId,
        ramal,
        slot: (params.lunchSlot ?? params.restSlot ?? undefined) as MealBreakSessionEvent["slot"],
    }, params.referenceAt));

    // Divisão ainda em andamento: a mudança da chefia mexe nas vagas de quem
    // ainda vai escolher, então rebobina até o ponto em que ela não interfere —
    // mesma régua do retardatário (decisão do usuário, 04/08/2026).
    const rewind = pinned.stage === "completed"
        ? null
        : resolveMealBreakChiefRewind({ before: session, after: pinned, pinnedRamal: ramal });
    const nextSession = rewind
        ? syncDaySessionState(withEvent(applyMealBreakLatecomerRewind(pinned, rewind), {
            type: "chief_pin_rewind",
            actorTelegramId: params.actorTelegramId,
            ramal: rewind.pivotRamal,
        }, params.referenceAt))
        : pinned;

    await saveMealBreakSession(chatId, nextSession, "chief_correction");
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

export interface MealBreakTurnNudgeRecord {
    ramal: string;
    at: string;
    count: number;
    targetMention?: string | MealBreakTelegramMention | null;
    recentRegulatorMentions?: Array<string | MealBreakTelegramMention>;
}

export interface MealBreakTelegramMention {
    telegramId: string;
    username: string;
}

export interface MealBreakRegulatorDeclaration {
    senderTelegramId: string | null;
    doctorId: string;
    createdAt?: Date;
}

export interface MealBreakTelegramInteraction {
    senderTelegramId: string | null;
    createdAt: Date;
}

/**
 * Entre quem declarou presença em REGULATION no turno, escolhe os usuários que
 * interagiram mais recentemente no mesmo chat. As consultas que alimentam este
 * helper já excluem chegadas de intervenção por domínio + join de ocupação.
 */
export function selectRecentMealBreakRegulatorTelegramIds(params: {
    declarations: MealBreakRegulatorDeclaration[];
    interactions: MealBreakTelegramInteraction[];
    excludedTelegramIds: ReadonlySet<string>;
    targetDoctorId: string | null;
    limit?: number;
}) {
    const idsForTargetDoctor = new Set(
        params.declarations
            .filter((row) => params.targetDoctorId && row.doctorId === params.targetDoctorId)
            .map((row) => row.senderTelegramId)
            .filter((id): id is string => Boolean(id)),
    );
    const eligibleIds = new Set(
        params.declarations
            .map((row) => row.senderTelegramId)
            .filter((id): id is string => Boolean(id))
            .filter((id) => !params.excludedTelegramIds.has(id))
            .filter((id) => !idsForTargetDoctor.has(id)),
    );
    const sortedInteractions = [...params.interactions]
        .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime());
    const selected: string[] = [];
    const seen = new Set<string>();
    const limit = params.limit ?? MEAL_BREAK_RECENT_REGULATOR_LIMIT;

    for (const row of sortedInteractions) {
        const id = row.senderTelegramId;
        if (!id || seen.has(id) || !eligibleIds.has(id)) {
            continue;
        }
        seen.add(id);
        selected.push(id);
        if (selected.length >= limit) {
            break;
        }
    }

    return selected;
}

/**
 * Candidatos de Telegram vinculados ao próprio médico aguardado, mais recente
 * primeiro. O vínculo é operacional (mensagem aceita → ocupação → doctorId);
 * nunca é inferido por semelhança de nome.
 */
export function selectMealBreakTargetTelegramIds(params: {
    declarations: MealBreakRegulatorDeclaration[];
    targetDoctorId: string;
    excludedTelegramIds: ReadonlySet<string>;
    limit?: number;
}) {
    const selected: string[] = [];
    const seen = new Set<string>();
    const sorted = [...params.declarations]
        .filter((row) => row.doctorId === params.targetDoctorId)
        .sort((left, right) => (right.createdAt?.getTime() ?? 0) - (left.createdAt?.getTime() ?? 0));

    for (const row of sorted) {
        const id = row.senderTelegramId;
        if (!id || seen.has(id) || params.excludedTelegramIds.has(id)) {
            continue;
        }
        seen.add(id);
        selected.push(id);
        if (selected.length >= (params.limit ?? 6)) {
            break;
        }
    }

    return selected;
}

function formatMealBreakTelegramMention(
    mention: string | MealBreakTelegramMention | null | undefined,
) {
    if (!mention) {
        return null;
    }
    if (typeof mention === "string") {
        const username = mention.trim().replace(/^@/, "");
        return /^[A-Za-z0-9_]{5,32}$/.test(username)
            ? `@${escapeTelegramMarkdown(username)}`
            : null;
    }
    const telegramId = mention.telegramId.trim();
    const username = mention.username.trim().replace(/^@/, "");
    if (!/^\d+$/.test(telegramId) || !/^[A-Za-z0-9_]{5,32}$/.test(username)) {
        return null;
    }
    return `[@${escapeTelegramMarkdown(username)}](tg://user?id=${telegramId})`;
}

function resolveMealBreakTelegramMention(
    member: Awaited<ReturnType<typeof getChatMember>> | null,
    telegramId: string,
) {
    if (!member || member.status === "left" || member.status === "kicked" || member.user.is_bot) {
        return null;
    }
    const username = member.user.username?.trim() ?? "";
    return /^[A-Za-z0-9_]{5,32}$/.test(username)
        ? { telegramId, username } satisfies MealBreakTelegramMention
        : null;
}

async function resolveMealBreakTargetMention(params: {
    chatId: string;
    referenceAt: Date;
    targetDoctorId: string;
}) {
    const db = getDb();
    const shift = resolveOperationalShiftWindow(params.referenceAt);
    const declarations = await db.select({
        senderTelegramId: telegramIngestedMessages.senderTelegramId,
        doctorId: regulationOccupancies.doctorId,
        createdAt: telegramIngestedMessages.createdAt,
    })
        .from(telegramIngestedMessages)
        .innerJoin(
            regulationOccupancies,
            eq(telegramIngestedMessages.relatedOccupancyId, regulationOccupancies.id),
        )
        .where(and(
            eq(telegramIngestedMessages.chatId, params.chatId),
            eq(telegramIngestedMessages.status, "accepted"),
            eq(telegramIngestedMessages.parsedDomain, "REGULATION"),
            inArray(telegramIngestedMessages.parsedAction, ["arrival", "continuation"]),
            eq(regulationOccupancies.doctorId, params.targetDoctorId),
            isNotNull(telegramIngestedMessages.senderTelegramId),
            gte(telegramIngestedMessages.createdAt, shift.startedAt),
            lte(telegramIngestedMessages.createdAt, params.referenceAt),
        ))
        .orderBy(desc(telegramIngestedMessages.createdAt));
    const excludedTelegramIds = new Set([
        ...getTelegramAdminUserIds(),
        ...getTelegramChiefUserIds(),
    ]);
    const candidateIds = selectMealBreakTargetTelegramIds({
        declarations,
        targetDoctorId: params.targetDoctorId,
        excludedTelegramIds,
    });
    const members = await Promise.all(candidateIds.map(async (telegramId) => {
        try {
            return await getChatMember(params.chatId, telegramId);
        } catch (error) {
            console.warn(`telegram meal break could not resolve target @username for ${telegramId}`, error);
            return null;
        }
    }));

    for (const [index, member] of members.entries()) {
        const mention = resolveMealBreakTelegramMention(member, candidateIds[index]!);
        if (mention && `@${mention.username}`.toLowerCase() !== MEAL_BREAK_CHIEF_USERNAME.toLowerCase()) {
            return mention;
        }
    }
    return null;
}

async function resolveRecentMealBreakRegulatorMentions(params: {
    chatId: string;
    referenceAt: Date;
    targetDoctorId: string | null;
}) {
    const db = getDb();
    const shift = resolveOperationalShiftWindow(params.referenceAt);
    const declarations = await db.select({
        senderTelegramId: telegramIngestedMessages.senderTelegramId,
        doctorId: regulationOccupancies.doctorId,
    })
        .from(telegramIngestedMessages)
        .innerJoin(
            regulationOccupancies,
            eq(telegramIngestedMessages.relatedOccupancyId, regulationOccupancies.id),
        )
        .where(and(
            eq(telegramIngestedMessages.chatId, params.chatId),
            eq(telegramIngestedMessages.status, "accepted"),
            eq(telegramIngestedMessages.parsedDomain, "REGULATION"),
            inArray(telegramIngestedMessages.parsedAction, ["arrival", "continuation"]),
            isNotNull(telegramIngestedMessages.senderTelegramId),
            gte(telegramIngestedMessages.createdAt, shift.startedAt),
            lte(telegramIngestedMessages.createdAt, params.referenceAt),
        ));

    if (declarations.length === 0) {
        return [] as string[];
    }

    const eligibleIds = [...new Set(
        declarations
            .map((row) => row.senderTelegramId)
            .filter((id): id is string => Boolean(id)),
    )];
    const interactions = await db.select({
        senderTelegramId: telegramIngestedMessages.senderTelegramId,
        createdAt: telegramIngestedMessages.createdAt,
    })
        .from(telegramIngestedMessages)
        .where(and(
            eq(telegramIngestedMessages.chatId, params.chatId),
            inArray(telegramIngestedMessages.senderTelegramId, eligibleIds),
            gte(telegramIngestedMessages.createdAt, shift.startedAt),
            lte(telegramIngestedMessages.createdAt, params.referenceAt),
        ))
        .orderBy(desc(telegramIngestedMessages.createdAt));

    const excludedTelegramIds = new Set([
        ...getTelegramAdminUserIds(),
        ...getTelegramChiefUserIds(),
    ]);
    const selectedIds = selectRecentMealBreakRegulatorTelegramIds({
        declarations,
        interactions,
        excludedTelegramIds,
        targetDoctorId: params.targetDoctorId,
        limit: MEAL_BREAK_RECENT_REGULATOR_LIMIT,
    });
    const members = await Promise.all(selectedIds.map(async (telegramId) => {
        try {
            return await getChatMember(params.chatId, telegramId);
        } catch (error) {
            console.warn(`telegram meal break could not resolve @username for ${telegramId}`, error);
            return null;
        }
    }));

    return members
        .map((member, index) => resolveMealBreakTelegramMention(member, selectedIds[index]!))
        .filter((mention): mention is MealBreakTelegramMention => Boolean(mention))
        .filter((mention) => `@${mention.username}`.toLowerCase() !== MEAL_BREAK_CHIEF_USERNAME.toLowerCase())
        .slice(0, MEAL_BREAK_RECENT_REGULATOR_LIMIT);
}

// Decisao pura: dado o estagio, quem esta na vez, quando ele virou a vez e o
// ultimo cutucao registrado, diz se e hora de cutucar de novo e qual a contagem.
// Extraida para ser testavel sem banco/rede.
export function resolveMealBreakTurnNudgeAction(params: {
    stage: MealBreakStage;
    queueHead: string | null;
    sessionUpdatedAt: string;
    previous: MealBreakTurnNudgeRecord | null;
    nowMs: number;
    intervalMs?: number;
}): { send: false } | { send: true; count: number } {
    const interval = params.intervalMs ?? MEAL_BREAK_TURN_NUDGE_INTERVAL_MS;
    if (!MEAL_BREAK_NUDGEABLE_STAGES.has(params.stage) || !params.queueHead) {
        return { send: false };
    }
    const sameHead = params.previous?.ramal === params.queueHead;
    const baseMs = new Date(sameHead && params.previous ? params.previous.at : params.sessionUpdatedAt).getTime();
    if (params.nowMs - baseMs < interval) {
        return { send: false };
    }
    return { send: true, count: sameHead && params.previous ? params.previous.count + 1 : 1 };
}

function isMealBreakTurnNudgeRecord(value: unknown): value is MealBreakTurnNudgeRecord {
    if (!value || typeof value !== "object") {
        return false;
    }
    const candidate = value as Record<string, unknown>;
    const isMention = (mention: unknown) => typeof mention === "string"
        || (Boolean(mention)
            && typeof mention === "object"
            && typeof (mention as Record<string, unknown>).telegramId === "string"
            && typeof (mention as Record<string, unknown>).username === "string");
    return typeof candidate.ramal === "string"
        && typeof candidate.at === "string"
        && typeof candidate.count === "number"
        && (candidate.targetMention === undefined
            || candidate.targetMention === null
            || isMention(candidate.targetMention))
        && (candidate.recentRegulatorMentions === undefined
            || (Array.isArray(candidate.recentRegulatorMentions)
                && candidate.recentRegulatorMentions.every(isMention)));
}

async function loadMealBreakTurnNudgeRecord(chatId: string, operationalDate: string, mode: MealBreakMode) {
    const db = getDb();
    const row = await db.query.telegramBotNotices.findFirst({
        where: eq(telegramBotNotices.noticeKey, resolveTurnNudgeNoticeKey(chatId, operationalDate, mode)),
    });
    return row && isMealBreakTurnNudgeRecord(row.payload) ? row.payload : null;
}

async function saveMealBreakTurnNudgeRecord(chatId: string, operationalDate: string, mode: MealBreakMode, record: MealBreakTurnNudgeRecord) {
    const db = getDb();
    await db.insert(telegramBotNotices)
        .values({
            noticeKey: resolveTurnNudgeNoticeKey(chatId, operationalDate, mode),
            chatId,
            stage: TURN_NUDGE_NOTICE_STAGE,
            payload: record,
        })
        .onConflictDoUpdate({
            target: telegramBotNotices.noticeKey,
            set: { stage: TURN_NUDGE_NOTICE_STAGE, payload: record },
        });
}

// Escala a cobrança a cada MEAL_BREAK_TURN_NUDGE_INTERVAL_MS enquanto a fila
// estiver parada. Na terceira, resolve e guarda até 6 @usernames de reguladores
// recentes; as cobranças seguintes reutilizam o snapshot para não consultar a
// API do Telegram a cada poll.
export async function sendTelegramMealBreakTurnNudges(referenceDate = new Date()) {
    if (!process.env.TELEGRAM_BOT_TOKEN?.trim()) {
        return { sent: 0, evaluated: 0 };
    }

    const mode = resolveMealBreakModeFromReference(referenceDate);
    const operationalDate = formatOperationalDate(referenceDate);
    const chatIds = await resolveMealBreakDiscoveryChatIds(mode);
    let sent = 0;
    let evaluated = 0;

    for (const chatId of chatIds) {
        const session = await loadMealBreakSession(chatId, operationalDate, mode);
        if (!session || !MEAL_BREAK_NUDGEABLE_STAGES.has(session.stage)) {
            continue;
        }

        const head = resolveStageChoiceQueue(session)[0] ?? null;
        if (!head) {
            continue;
        }

        evaluated += 1;

        const previous = await loadMealBreakTurnNudgeRecord(chatId, operationalDate, mode);
        const action = resolveMealBreakTurnNudgeAction({
            stage: session.stage,
            queueHead: head,
            sessionUpdatedAt: session.updatedAt,
            previous,
            nowMs: referenceDate.getTime(),
        });
        if (!action.send) {
            continue;
        }

        try {
            const sameHead = previous?.ramal === head;
            const targetDoctorId = findDoctor(session, head)?.doctorId ?? null;
            let targetMention = sameHead && previous && "targetMention" in previous
                ? previous.targetMention
                : undefined;
            if (targetMention === undefined && targetDoctorId) {
                targetMention = await resolveMealBreakTargetMention({
                    chatId,
                    referenceAt: referenceDate,
                    targetDoctorId,
                });
            }
            let recentRegulatorMentions = sameHead
                ? previous?.recentRegulatorMentions
                : undefined;
            const hasLegacyTextMentions = recentRegulatorMentions?.some((mention) => typeof mention === "string") ?? false;
            if (action.count >= 3 && (recentRegulatorMentions === undefined || hasLegacyTextMentions)) {
                recentRegulatorMentions = await resolveRecentMealBreakRegulatorMentions({
                    chatId,
                    referenceAt: referenceDate,
                    targetDoctorId,
                });
            }

            await sendMessage(
                chatId,
                buildMealBreakTurnNudgeMessage(
                    session,
                    action.count,
                    recentRegulatorMentions ?? [],
                    targetMention ?? null,
                ),
                undefined,
                buildMealBreakStageKeyboard(session) ?? undefined,
                MEAL_BREAK_FORMAT_OPTIONS,
            );
            await saveMealBreakTurnNudgeRecord(chatId, operationalDate, mode, {
                ramal: head,
                at: referenceDate.toISOString(),
                count: action.count,
                targetMention: targetMention ?? null,
                ...(recentRegulatorMentions !== undefined ? { recentRegulatorMentions } : {}),
            });
            sent += 1;
        } catch (error) {
            console.error(`telegram meal break turn nudge failed for ${chatId} ${operationalDate}`, error);
        }
    }

    return { sent, evaluated };
}

export async function sendTelegramMealBreakMessages(params: {
    chatId: string | number;
    messages: string[];
    replyToMessageId?: number;
    replyMarkup?: TelegramReplyMarkup;
    /** Formatação por callsite (ex.: MEAL_BREAK_FORMAT_OPTIONS para os balões deste módulo). */
    options?: TelegramFormatOptions;
}) {
    const lastIndex = params.messages.length - 1;
    for (const [index, text] of params.messages.entries()) {
        const isLast = index === lastIndex;
        await sendMessage(
            params.chatId,
            text,
            index === 0 ? params.replyToMessageId : undefined,
            isLast ? params.replyMarkup : undefined,
            params.options,
        );
    }
}

// Erros por CLASSE, não por substring: MealBreakUserError (e o erro de
// consistência) carregam copies curadas que podem ir ao grupo; qualquer outro
// Error vira mensagem genérica curta — o detalhe técnico fica no log e no
// alerta privado do admin (resolveMealBreakTechnicalErrorDetail).
export function buildMealBreakErrorReply(error: unknown) {
    if (isMealBreakConsistencyError(error)) {
        return "Há inconsistência na lista de médicos ativos. Preciso da lista atualizada para continuar.";
    }
    if (error instanceof MealBreakUserError) {
        return error.message;
    }
    return "⛔ Não consegui organizar a divisão agora. Tente de novo em instantes — o detalhe técnico já foi registrado.";
}

export function resolveMealBreakLogDetails(session: MealBreakSession | null) {
    if (!session) {
        return {};
    }

    const dinnerDurations = Object.values(session.dinnerDurationAssignments ?? {});
    const oneHourDinnerCount = dinnerDurations.filter((value) => value === "one_hour").length;
    const halfHourDinnerCount = dinnerDurations.filter((value) => value === "half_hour").length;

    return {
        mealBreakMode: session.mode,
        mealBreakStage: session.stage,
        mealBreakOperationalDate: session.operationalDate,
        mealBreakAssignedLunchCount: Object.keys(session.lunchAssignments).length,
        mealBreakAssignedRestCount: Object.keys(session.restAssignments).length,
        mealBreakAssignedNightWorkCount: Object.keys(session.nightWorkAssignments).length,
        mealBreakAssignedDinnerCount: Object.keys(session.dinnerAssignments).length,
        mealBreakOneHourDinnerCount: oneHourDinnerCount,
        mealBreakHalfHourDinnerCount: halfHourDinnerCount,
    };
}

export function resolveTelegramMealBreakSenderId(update: TelegramUpdate) {
    return update.message?.from?.id ? String(update.message.from.id) : null;
}

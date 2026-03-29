import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { telegramBotNotices } from "@/db/schema";
import { isRemoteOperationalRole, normalizeOperationalRoleLabel, resolveOperationalRoleLabel } from "@/modules/operational/roles";
import { getSaoPauloParts, resolveOperationalShiftWindow } from "@/modules/operational/board-rules";
import type { TelegramUpdate } from "@/modules/telegram/api";
import { sendMessage } from "@/modules/telegram/api";
import { getTelegramAnnouncementChatIds } from "@/modules/telegram/config";
import { getOperationalBoard } from "@/services/board.service";

type OperationalBoard = Awaited<ReturnType<typeof getOperationalBoard>>;

export type MealBreakLunchSlot = "11:30" | "12:30" | "13:30";
export type MealBreakRestSlot = "14:30" | "15:30" | "16:30" | "18:00";
export type MealBreakStage = "awaiting_recip" | "awaiting_mrv_lunch" | "awaiting_lunch_choice" | "awaiting_rest_choice" | "completed";

export interface MealBreakDoctor {
    doctorId: string;
    ramal: string;
    name: string;
    domain: "regulation";
    startedAt: string;
    shiftLabel: "SD" | "P";
    roleLabel: string | null;
}

export interface MealBreakSessionEvent {
    type:
    | "session_started"
    | "session_restarted"
    | "recip_selected"
    | "mrv_selected"
    | "lunch_selected"
    | "rest_auto_selected"
    | "rest_selected"
    | "session_completed";
    ramal?: string;
    slot?: MealBreakLunchSlot | MealBreakRestSlot;
    actorTelegramId: string | null;
    recordedAt: string;
}

export interface MealBreakSession {
    kind: "telegram_meal_break_session";
    version: 1;
    operationalDate: string;
    stage: MealBreakStage;
    trigger: "manual" | "automatic";
    roster: MealBreakDoctor[];
    chiefRamal: string | null;
    recipRamal: string | null;
    mrvRamals: [string, string];
    mrvLunch1230Ramal: string | null;
    lunchCapacities: Record<MealBreakLunchSlot, number>;
    lunchAssignments: Record<string, MealBreakLunchSlot>;
    restAssignments: Record<string, MealBreakRestSlot>;
    restChoiceCapacities: Record<"15:30" | "16:30", number>;
    lunchQueue: string[];
    restQueue: string[];
    createdAt: string;
    updatedAt: string;
    events: MealBreakSessionEvent[];
}

export interface TelegramMealBreakCommand {
    name: "meal_break";
    forceRestart: boolean;
    rawBody: string;
}

export interface MealBreakRosterResult {
    roster: MealBreakDoctor[];
    chiefRamal: string | null;
    mrvRamals: [string, string];
}

export interface MealBreakActionResult {
    handled: boolean;
    session: MealBreakSession;
    messages: string[];
    status: "started" | "reported" | "updated" | "completed" | "invalid";
}

const SESSION_NOTICE_STAGE = "meal_break_flow";
const AUTO_NOTICE_STAGE = "meal_break_auto";
const SESSION_KIND = "telegram_meal_break_session";
const CHIEF_RAMAL = "2031";
const MRV_RAMALS = ["2032", "2151"] as const;
const LUNCH_SLOTS: MealBreakLunchSlot[] = ["11:30", "12:30", "13:30"];
const REST_SLOTS: MealBreakRestSlot[] = ["14:30", "15:30", "16:30", "18:00"];

function normalizeFreeText(value: string) {
    return value
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .trim()
        .toUpperCase();
}

function normalizeRamal(value: string) {
    return value.trim().toUpperCase().replace(/\s+/g, "");
}

function pad(value: number) {
    return String(value).padStart(2, "0");
}

function formatOperationalDate(referenceAt: Date) {
    const parts = getSaoPauloParts(referenceAt);
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

function resolveSessionNoticeKey(chatId: string) {
    return `${chatId}:meal_break:session`;
}

function resolveAutoNoticeKey(chatId: string, operationalDate: string) {
    return `${chatId}:meal_break:auto:${operationalDate}:09:00`;
}

function resolveDoctorName(value: { name: string }) {
    return value.name.trim() || "Medico";
}

function sortRoster(left: MealBreakDoctor, right: MealBreakDoctor) {
    const leftTime = new Date(left.startedAt).getTime();
    const rightTime = new Date(right.startedAt).getTime();
    if (leftTime !== rightTime) {
        return leftTime - rightTime;
    }

    return left.ramal.localeCompare(right.ramal);
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

function mapRegulationDoctor(row: OperationalBoard["regulation"][number]): MealBreakDoctor | null {
    if (row.status !== "active" || !row.doctorId || !row.startedAt || !row.shiftLabel || row.shiftLabel === "SN") {
        return null;
    }

    return {
        doctorId: row.doctorId,
        ramal: normalizeRamal(row.postCode),
        name: row.doctorName?.trim() || row.displayName?.trim() || row.postCode,
        domain: "regulation",
        startedAt: row.startedAt,
        shiftLabel: row.shiftLabel === "P" ? "P" : "SD",
        roleLabel: resolveOperationalRoleLabel({
            domain: "regulation",
            code: normalizeRamal(row.postCode),
            shiftLabel: row.shiftLabel,
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

function renderSlotLine<TSlot extends MealBreakLunchSlot | MealBreakRestSlot>(params: {
    session: MealBreakSession;
    slot: TSlot;
    assignments: Record<string, TSlot>;
}) {
    const ramals = Object.entries(params.assignments)
        .filter(([, assignedSlot]) => assignedSlot === params.slot)
        .map(([ramal]) => ramal)
        .sort((left, right) => {
            const leftDoctor = findDoctor(params.session, left);
            const rightDoctor = findDoctor(params.session, right);
            if (!leftDoctor || !rightDoctor) {
                return left.localeCompare(right);
            }
            return sortRoster(leftDoctor, rightDoctor);
        });

    const entries = ramals.length > 0
        ? ramals.map((ramal) => {
            const isRecip = params.session.recipRamal === ramal;
            const isMrv = params.session.mrvRamals.includes(ramal as (typeof MRV_RAMALS)[number]);
            const tag = isRecip ? "RECIP" : isMrv ? "MRV" : undefined;
            return renderDoctorSummary(params.session, ramal, tag);
        }).join(", ")
        : "-";

    return `${params.slot} - ${entries}`;
}

function buildSessionSummary(session: MealBreakSession) {
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
        ? [``, `CHEFIA ${session.chiefRamal} - a criterio`]
        : [];

    return [
        "ALMOCO",
        ...lunchLines,
        "",
        "DESCANSO",
        ...restLines,
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

function buildStartPrompt() {
    return "Vamos organizar almoco e descanso do plantao. Primeiro, informem o RAMAL do medico RECIP.";
}

function buildLunchQueuePrompt(session: MealBreakSession) {
    const currentRamal = session.lunchQueue[0] ?? null;
    if (!currentRamal) {
        return "Nao ha mais escolhas de almoco pendentes.";
    }

    const doctor = findDoctor(session, currentRamal);
    return [
        `Proximo da fila: ${resolveDoctorName(doctor ?? { name: currentRamal })}, ramal ${currentRamal}.`,
        `Horarios disponiveis: ${buildAvailableLunchText(session)}.`,
        "Responda: RAMAL HORARIO.",
    ].join("\n");
}

function buildRestQueuePrompt(session: MealBreakSession) {
    const currentRamal = session.restQueue[0] ?? null;
    if (!currentRamal) {
        return "Nao ha mais escolhas de descanso pendentes.";
    }

    const doctor = findDoctor(session, currentRamal);
    return [
        `Proximo da fila: ${resolveDoctorName(doctor ?? { name: currentRamal })}, ramal ${currentRamal}.`,
        `Horarios disponiveis: ${buildAvailableRestText(session)}.`,
        "Responda: RAMAL HORARIO.",
    ].join("\n");
}

function buildExistingSessionReply(session: MealBreakSession) {
    const intro = session.stage === "completed"
        ? "Ja existe uma divisao fechada hoje."
        : "Ja existe uma divisao em andamento hoje.";
    const nextStep = session.stage === "completed"
        ? "Se quiser reiniciar, mande /almoco reiniciar."
        : `${buildCurrentPrompt(session)}\n\nSe quiser reiniciar, mande /almoco reiniciar.`;

    return [intro, "", buildSessionSummary(session), "", nextStep].join("\n");
}

function buildCurrentPrompt(session: MealBreakSession) {
    if (session.stage === "awaiting_recip") {
        return buildStartPrompt();
    }
    if (session.stage === "awaiting_mrv_lunch") {
        const doctors = session.mrvRamals.map((ramal) => renderDoctorSummary(session, ramal)).join(" | ");
        return `Agora informem qual dos MRV ficara com almoco 12:30. Responder apenas com o RAMAL.\n${doctors}`;
    }
    if (session.stage === "awaiting_lunch_choice") {
        return buildLunchQueuePrompt(session);
    }
    if (session.stage === "awaiting_rest_choice") {
        return buildRestQueuePrompt(session);
    }

    return "Divisao encerrada.";
}

function resolveLunchQueueEffectiveStartedAt(session: MealBreakSession, doctor: MealBreakDoctor) {
    const startedAtMs = new Date(doctor.startedAt).getTime();
    if (!isRemoteOperationalRole(doctor.roleLabel)) {
        return startedAtMs;
    }

    const thresholdAtMs = new Date(`${session.operationalDate}T07:15:00-03:00`).getTime();
    return Math.max(startedAtMs, thresholdAtMs);
}

function compareLunchQueue(session: MealBreakSession, leftRamal: string, rightRamal: string) {
    const leftDoctor = findDoctor(session, leftRamal);
    const rightDoctor = findDoctor(session, rightRamal);
    if (!leftDoctor || !rightDoctor) {
        return leftRamal.localeCompare(rightRamal);
    }

    const byEffectiveStart = resolveLunchQueueEffectiveStartedAt(session, leftDoctor) - resolveLunchQueueEffectiveStartedAt(session, rightDoctor);
    if (byEffectiveStart !== 0) {
        return byEffectiveStart;
    }

    const byActualStart = new Date(leftDoctor.startedAt).getTime() - new Date(rightDoctor.startedAt).getTime();
    if (byActualStart !== 0) {
        return byActualStart;
    }

    return leftDoctor.ramal.localeCompare(rightDoctor.ramal);
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
    return {
        "15:30": Math.ceil(totalDoctors / 2),
        "16:30": Math.floor(totalDoctors / 2),
    } satisfies Record<"15:30" | "16:30", number>;
}

export function resolveMealBreakLunchCapacities(totalDoctors: number) {
    return resolveThreeSlotCapacities(totalDoctors);
}

export function buildMealBreakRoster(board: OperationalBoard, referenceAt: Date): MealBreakRosterResult {
    const shiftWindow = resolveOperationalShiftWindow(referenceAt);
    if (shiftWindow.shiftLabel !== "SD") {
        throw new Error("Fluxo de almoco vale apenas no plantao diurno.");
    }

    const regulation = board.regulation
        .map(mapRegulationDoctor)
        .filter((doctor): doctor is MealBreakDoctor => Boolean(doctor));
    const merged = [...regulation]
        .sort(sortRoster);

    if (hasDuplicateDoctorIds(merged)) {
        throw new Error("Ha inconsistência na lista de medicos ativos. Preciso da lista atualizada para continuar.");
    }

    const chief = merged.find((doctor) => doctor.ramal === CHIEF_RAMAL) ?? null;
    const roster = merged.filter((doctor) => doctor.ramal !== CHIEF_RAMAL);
    const activeRamals = new Set(roster.map((doctor) => doctor.ramal));
    for (const mrvRamal of MRV_RAMALS) {
        if (!activeRamals.has(mrvRamal)) {
            throw new Error("Ha inconsistência na lista de medicos ativos. Preciso da lista atualizada para continuar.");
        }
    }

    return {
        roster,
        chiefRamal: chief?.ramal ?? null,
        mrvRamals: [MRV_RAMALS[0], MRV_RAMALS[1]],
    };
}

export function createMealBreakSession(params: {
    roster: MealBreakDoctor[];
    chiefRamal: string | null;
    mrvRamals: [string, string];
    referenceAt: Date;
    trigger: "manual" | "automatic";
    restarted: boolean;
    actorTelegramId: string | null;
}) {
    const recordedAt = params.referenceAt.toISOString();

    return {
        kind: SESSION_KIND,
        version: 1,
        operationalDate: formatOperationalDate(params.referenceAt),
        stage: "awaiting_recip",
        trigger: params.trigger,
        roster: [...params.roster].sort(sortRoster),
        chiefRamal: params.chiefRamal,
        recipRamal: null,
        mrvRamals: params.mrvRamals,
        mrvLunch1230Ramal: null,
        lunchCapacities: resolveThreeSlotCapacities(params.roster.length),
        lunchAssignments: {},
        restAssignments: {},
        restChoiceCapacities: { "15:30": 0, "16:30": 0 },
        lunchQueue: [],
        restQueue: [],
        createdAt: recordedAt,
        updatedAt: recordedAt,
        events: [{
            type: params.restarted ? "session_restarted" : "session_started",
            actorTelegramId: params.actorTelegramId,
            recordedAt,
        }],
    } satisfies MealBreakSession;
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

function resolveRemainingLunchSlots(session: MealBreakSession) {
    const counts = {
        "11:30": 0,
        "12:30": 0,
        "13:30": 0,
    } satisfies Record<MealBreakLunchSlot, number>;

    for (const slot of Object.values(session.lunchAssignments)) {
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

function isRecognizedReplyCandidate(session: MealBreakSession, text: string) {
    if (text.trim().startsWith("/")) {
        return false;
    }

    const ramal = extractTargetCode(text);
    const slot = extractSlotStart(text);
    if (session.stage === "awaiting_recip" || session.stage === "awaiting_mrv_lunch") {
        return Boolean(ramal);
    }

    return Boolean(ramal || slot);
}

function extractTargetCode(text: string) {
    const match = text.toUpperCase().match(/\b(?:\d{4}|[A-Z]{2,3}\d{2})\b/);
    return match ? normalizeRamal(match[0]) : null;
}

function extractSlotStart(text: string): string | null {
    const normalized = text.trim().replace(/H/gi, ":");
    const match = normalized.match(/\b(1[1-8]):([03]0)\b/);
    if (!match) {
        return null;
    }

    return `${match[1]}:${match[2]}`;
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

function parseChoiceReply(text: string) {
    return {
        ramal: extractTargetCode(text),
        slot: extractSlotStart(text),
    };
}

function finalizeLunchSetup(session: MealBreakSession, referenceAt: Date, actorTelegramId: string | null) {
    const remainingDoctors = session.roster
        .map((doctor) => doctor.ramal)
        .filter((ramal) => ramal !== session.recipRamal && !session.mrvRamals.includes(ramal as (typeof MRV_RAMALS)[number]))
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

function buildRestPhase(session: MealBreakSession, referenceAt: Date, actorTelegramId: string | null) {
    const updatedAssignments = { ...session.restAssignments };
    const autoAssigned14 = session.roster
        .map((doctor) => doctor.ramal)
        .filter((ramal) => session.lunchAssignments[ramal] === "13:30" && !session.mrvRamals.includes(ramal as (typeof MRV_RAMALS)[number]));

    for (const ramal of autoAssigned14) {
        updatedAssignments[ramal] = "14:30";
    }

    const pendingRest = session.roster
        .map((doctor) => doctor.ramal)
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
    const assignments = { ...session.restAssignments };
    for (const ramal of session.restQueue) {
        assignments[ramal] = forcedSlot;
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

function buildLunchClosedMessages(session: MealBreakSession) {
    return [
        "Almoco fechado.",
        buildSessionSummary(session),
    ].join("\n\n");
}

function buildRestIntro(session: MealBreakSession) {
    const automatic1430 = Object.entries(session.restAssignments)
        .filter(([, slot]) => slot === "14:30")
        .map(([ramal]) => renderDoctorSummary(session, ramal))
        .join(", ");
    const fixed1800 = Object.entries(session.restAssignments)
        .filter(([, slot]) => slot === "18:00")
        .map(([ramal]) => renderDoctorSummary(session, ramal, session.recipRamal === ramal ? "RECIP" : "MRV"))
        .join(", ");

    const blocks = ["Descanso:"];
    if (automatic1430) {
        blocks.push(`14:30 fixado automaticamente: ${automatic1430}.`);
    }
    if (fixed1800) {
        blocks.push(`18:00 fixo: ${fixed1800}.`);
    }

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

    if (session.stage === "awaiting_recip") {
        const parsed = parseSingleRamalReply(text);
        if (!parsed.ramal || !parsed.valid) {
            return {
                handled: true,
                session,
                messages: ["Envie apenas o RAMAL do medico RECIP."],
                status: "invalid",
            };
        }

        if (parsed.ramal === CHIEF_RAMAL || session.mrvRamals.includes(parsed.ramal as (typeof MRV_RAMALS)[number])) {
            return {
                handled: true,
                session,
                messages: ["RECIP nao pode ser chefia nem um dos MRV. Informe outro RAMAL."],
                status: "invalid",
            };
        }

        const doctor = findDoctor(session, parsed.ramal);
        if (!doctor) {
            return {
                handled: true,
                session,
                messages: ["Nao reconheci esse ramal na lista ativa. Envie apenas o RAMAL."],
                status: "invalid",
            };
        }

        const nextSession = withEvent({
            ...session,
            recipRamal: parsed.ramal,
            stage: "awaiting_mrv_lunch",
            lunchAssignments: {
                ...session.lunchAssignments,
                [parsed.ramal]: "11:30",
            },
            restAssignments: {
                ...session.restAssignments,
                [parsed.ramal]: "18:00",
            },
            updatedAt: referenceAt.toISOString(),
        }, {
            type: "recip_selected",
            actorTelegramId: senderTelegramId,
            ramal: parsed.ramal,
            slot: "11:30",
        }, referenceAt);

        return {
            handled: true,
            session: nextSession,
            messages: [
                [
                    `RECIP confirmado: ${renderDoctorSummary(nextSession, parsed.ramal, "RECIP")}.`,
                    "Almoco 11:30 e descanso 18:00-19:00 fixados.",
                    "",
                    buildCurrentPrompt(nextSession),
                ].join("\n"),
            ],
            status: "updated",
        };
    }

    if (session.stage === "awaiting_mrv_lunch") {
        const parsed = parseSingleRamalReply(text);
        if (!parsed.ramal || !parsed.valid) {
            return {
                handled: true,
                session,
                messages: ["Envie apenas o RAMAL do MRV que ficara com 12:30."],
                status: "invalid",
            };
        }

        if (!session.mrvRamals.includes(parsed.ramal as (typeof MRV_RAMALS)[number])) {
            return {
                handled: true,
                session,
                messages: ["Esse ramal nao e um dos MRV fixos. Responda apenas com 2032 ou 2151."],
                status: "invalid",
            };
        }

        const otherMrv = session.mrvRamals.find((ramal) => ramal !== parsed.ramal) as string;
        const preparedSession = finalizeLunchSetup({
            ...session,
            mrvLunch1230Ramal: parsed.ramal,
            lunchAssignments: {
                ...session.lunchAssignments,
                [parsed.ramal]: "12:30",
                [otherMrv]: "13:30",
            },
            restAssignments: {
                ...session.restAssignments,
                [parsed.ramal]: "18:00",
                [otherMrv]: "18:00",
            },
            updatedAt: referenceAt.toISOString(),
        }, referenceAt, senderTelegramId);

        const messages = [[
            `MRV confirmados: ${renderDoctorSummary(preparedSession, parsed.ramal, "MRV 12:30")} | ${renderDoctorSummary(preparedSession, otherMrv, "MRV 13:30")}.`,
            `Capacidade do almoco hoje: 11:30 (${preparedSession.lunchCapacities["11:30"]}), 12:30 (${preparedSession.lunchCapacities["12:30"]}), 13:30 (${preparedSession.lunchCapacities["13:30"]}).`,
            "",
            buildCurrentPrompt(preparedSession),
        ].join("\n")];

        if (preparedSession.stage !== "awaiting_lunch_choice") {
            const restPhase = buildRestPhase(preparedSession, referenceAt, senderTelegramId);
            if (restPhase.stage === "completed") {
                const completed = completeSession(restPhase, referenceAt, senderTelegramId);
                return {
                    handled: true,
                    session: completed,
                    messages: [buildLunchClosedMessages(preparedSession), buildSessionSummary(completed)],
                    status: "completed",
                };
            }

            return {
                handled: true,
                session: restPhase,
                messages: [buildLunchClosedMessages(preparedSession), buildRestIntro(restPhase), buildCurrentPrompt(restPhase)],
                status: "updated",
            };
        }

        return {
            handled: true,
            session: preparedSession,
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
        if (remaining[chosenSlot] <= 0) {
            return {
                handled: true,
                session,
                messages: [`Esse horario ja completou as vagas. Disponiveis agora: ${buildAvailableLunchText(session)}.`],
                status: "invalid",
            };
        }

        const nextQueue = session.lunchQueue.slice(1);
        const updatedSession = withEvent({
            ...session,
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

        if (nextQueue.length > 0) {
            return {
                handled: true,
                session: updatedSession,
                messages: [[
                    `Almoco registrado: ${renderDoctorSummary(updatedSession, parsed.ramal)} em ${chosenSlot}.`,
                    "",
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
            ...session,
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
        if (updatedSession.stage === "completed") {
            const completed = completeSession(updatedSession, referenceAt, senderTelegramId);
            return {
                handled: true,
                session: completed,
                messages: [
                    `Descanso registrado: ${renderDoctorSummary(completed, parsed.ramal)} em ${chosenSlot}.`,
                    buildSessionSummary(completed),
                ],
                status: "completed",
            };
        }

        return {
            handled: true,
            session: updatedSession,
            messages: [[
                `Descanso registrado: ${renderDoctorSummary(updatedSession, parsed.ramal)} em ${chosenSlot}.`,
                "",
                buildCurrentPrompt(updatedSession),
            ].join("\n")],
            status: "updated",
        };
    }

    return null;
}

async function loadMealBreakSession(chatId: string, operationalDate: string) {
    const db = getDb();
    const row = await db.query.telegramBotNotices.findFirst({
        where: eq(telegramBotNotices.noticeKey, resolveSessionNoticeKey(chatId)),
    });

    if (!row || !isMealBreakSession(row.payload)) {
        return null;
    }

    return row.payload.operationalDate === operationalDate ? row.payload : null;
}

async function saveMealBreakSession(chatId: string, session: MealBreakSession) {
    const db = getDb();
    await db.insert(telegramBotNotices)
        .values({
            noticeKey: resolveSessionNoticeKey(chatId),
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

async function reserveMealBreakAutoNotice(chatId: string, operationalDate: string) {
    const db = getDb();
    const [inserted] = await db.insert(telegramBotNotices)
        .values({
            noticeKey: resolveAutoNoticeKey(chatId, operationalDate),
            chatId,
            stage: AUTO_NOTICE_STAGE,
            payload: { operationalDate },
        })
        .onConflictDoNothing()
        .returning();

    return Boolean(inserted);
}

async function rollbackMealBreakAutoNotice(chatId: string, operationalDate: string) {
    const db = getDb();
    await db.delete(telegramBotNotices)
        .where(eq(telegramBotNotices.noticeKey, resolveAutoNoticeKey(chatId, operationalDate)));
}

export function isTelegramMealBreakCommandText(text: string) {
    return /^\/almoco(?:@\w+)?\b/i.test(text.trim());
}

export function parseTelegramMealBreakCommand(text: string): TelegramMealBreakCommand | null {
    const trimmed = text.trim();
    const match = trimmed.match(/^\/almoco(?:@(\w+))?(?:\s+(reiniciar))?\s*$/i);
    if (!match) {
        return null;
    }

    return {
        name: "meal_break",
        forceRestart: Boolean(match[2]),
        rawBody: trimmed.replace(/^\/almoco(?:@\w+)?/i, "").trim(),
    };
}

export function buildMealBreakCommandUsageReply() {
    return "Use /almoco para abrir o fluxo ou /almoco reiniciar para recomecar a divisao do dia.";
}

export async function runTelegramMealBreakCommand(params: {
    chatId: string;
    referenceAt: Date;
    trigger: "manual" | "automatic";
    forceRestart: boolean;
    actorTelegramId: string | null;
    board?: OperationalBoard;
}) {
    const operationalDate = formatOperationalDate(params.referenceAt);
    const existing = await loadMealBreakSession(params.chatId, operationalDate);

    if (existing && !params.forceRestart) {
        return {
            session: existing,
            messages: [buildExistingSessionReply(existing)],
            status: "reported" as const,
        };
    }

    const board = params.board ?? await getOperationalBoard();
    const roster = buildMealBreakRoster(board, params.referenceAt);
    const session = createMealBreakSession({
        roster: roster.roster,
        chiefRamal: roster.chiefRamal,
        mrvRamals: roster.mrvRamals,
        referenceAt: params.referenceAt,
        trigger: params.trigger,
        restarted: Boolean(existing && params.forceRestart),
        actorTelegramId: params.actorTelegramId,
    });

    await saveMealBreakSession(params.chatId, session);

    const intro = existing && params.forceRestart
        ? "Divisao anterior descartada. Vamos reiniciar."
        : null;

    return {
        session,
        messages: [intro, buildStartPrompt()].filter((value): value is string => Boolean(value)),
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
    const session = await loadMealBreakSession(params.chatId, operationalDate);
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

export async function getCurrentOperationalMealBreakSession(referenceAt = new Date()) {
    const chatId = getTelegramAnnouncementChatIds()[0] ?? null;
    if (!chatId) {
        return null;
    }

    return loadMealBreakSession(chatId, formatOperationalDate(referenceAt));
}

export async function sendTelegramMealBreakCycle(referenceDate = new Date()) {
    if (!process.env.TELEGRAM_BOT_TOKEN?.trim()) {
        return { sent: 0, evaluated: 0 };
    }

    const parts = getSaoPauloParts(referenceDate);
    const operationalDate = formatOperationalDate(referenceDate);
    if (resolveOperationalShiftWindow(referenceDate).shiftLabel !== "SD" || parts.hour !== 9 || parts.minute >= 10) {
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

        const reserved = await reserveMealBreakAutoNotice(chatId, operationalDate);
        if (!reserved) {
            continue;
        }

        try {
            const result = await runTelegramMealBreakCommand({
                chatId,
                referenceAt: referenceDate,
                trigger: "automatic",
                forceRestart: false,
                actorTelegramId: null,
                board,
            });
            for (const [index, text] of result.messages.entries()) {
                await sendMessage(chatId, text, index === 0 ? undefined : undefined);
            }
            sent += result.messages.length;
        } catch (error) {
            await rollbackMealBreakAutoNotice(chatId, operationalDate);
            console.error(`telegram meal break failed for ${chatId} ${operationalDate}`, error);
        }
    }

    return { sent, evaluated };
}

export async function sendTelegramMealBreakMessages(params: {
    chatId: string | number;
    messages: string[];
    replyToMessageId?: number;
}) {
    for (const [index, text] of params.messages.entries()) {
        await sendMessage(params.chatId, text, index === 0 ? params.replyToMessageId : undefined);
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
    return `Nao consegui organizar a divisao agora. ${message}`;
}

export function resolveMealBreakLogDetails(session: MealBreakSession | null) {
    if (!session) {
        return {};
    }

    return {
        mealBreakStage: session.stage,
        mealBreakOperationalDate: session.operationalDate,
        mealBreakAssignedLunchCount: Object.keys(session.lunchAssignments).length,
        mealBreakAssignedRestCount: Object.keys(session.restAssignments).length,
    };
}

export function resolveTelegramMealBreakSenderId(update: TelegramUpdate) {
    return update.message?.from?.id ? String(update.message.from.id) : null;
}
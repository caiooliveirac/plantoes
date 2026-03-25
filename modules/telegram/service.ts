import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { getDb } from "@/db";
import {
    doctors,
    interventionBases,
    interventionOccupancies,
    regulationOccupancies,
    regulationPosts,
    telegramIngestedMessages,
    userRoles,
    users,
} from "@/db/schema";
import { normalizeDoctorName } from "@/modules/doctors/importer";
import { endInterventionOccupancy, startInterventionOccupancy } from "@/modules/intervention/service";
import { correctInterventionOccupancy, correctRegulationOccupancy, removeInterventionOccupancyRecord, removeRegulationOccupancyRecord } from "@/modules/operational/corrections";
import { resolveTelegramEventTime } from "@/modules/operational/rules";
import { endRegulationOccupancy, startRegulationOccupancy } from "@/modules/regulation/service";
import { getTelegramAdminUserIds, getTelegramAnnouncementChatIds, getTelegramChiefUserIds, isTelegramChatAllowed, isTelegramPrivateControlUserId } from "@/modules/telegram/config";
import { parseTelegramCommand } from "@/modules/telegram/commands";
import { isCasualTelegramMessage, parseMessageMulti, type ParsedMessage } from "@/modules/telegram/parser";
import type { TelegramUpdate } from "@/modules/telegram/api";
import { sendMessage } from "@/modules/telegram/api";
import { pickCandidateFromReply, pickConfidentDoctorCandidate, resolveDoctorCandidates, type TelegramDoctorCandidate, type TelegramDoctorDirectoryEntry } from "@/modules/telegram/name-resolution";
import { buildCandidatePromptReply, buildGroupCorrectionAnnouncement, buildNameUnresolvedReply, pickTelegramReply } from "@/modules/telegram/replies";

interface PendingNameResolutionData {
    parsed: {
        sector: "REGULATION" | "INTERVENTION";
        baseCode: string;
        arrivalTime: string | null;
        shiftType: "SD" | "SN" | "P" | null;
        roleFunction: string | null;
        isDeparture: boolean;
    };
    candidates: Array<{ id: string; fullName: string; displayName: string | null; normalizedName: string }>;
    originalText: string;
    originalEventAt: string;
}

type OperationalParsedEntry = PendingNameResolutionData["parsed"];

function isOperationalParsedEntry(entry: ParsedMessage): entry is ParsedMessage & OperationalParsedEntry {
    return Boolean(entry.baseCode && entry.sector);
}

async function resolveDoctorId(rawName: string) {
    const db = getDb();
    const normalizedName = normalizeDoctorName(rawName);
    if (!normalizedName) {
        return null;
    }

    const doctor = await db.query.doctors.findFirst({
        where: eq(doctors.normalizedName, normalizedName),
    });

    return doctor ?? null;
}

async function listDirectoryEntries() {
    const db = getDb();
    return db.select({
        id: doctors.id,
        fullName: doctors.fullName,
        displayName: doctors.displayName,
        normalizedName: doctors.normalizedName,
    }).from(doctors).where(eq(doctors.isActive, true));
}

async function resolveDoctorWithFallback(rawName: string) {
    const exact = await resolveDoctorId(rawName);
    if (exact) {
        return { doctor: exact, candidates: [] as TelegramDoctorCandidate[] };
    }

    const directory = await listDirectoryEntries();
    const candidates = resolveDoctorCandidates(rawName, directory as TelegramDoctorDirectoryEntry[]);
    const confidentCandidate = pickConfidentDoctorCandidate(rawName, candidates);
    if (confidentCandidate) {
        return {
            doctor: directory.find((entry) => entry.id === confidentCandidate.id) ?? null,
            candidates,
        };
    }

    return {
        doctor: null,
        candidates,
    };
}

async function logTelegramMessage(update: TelegramUpdate) {
    const message = update.message;
    if (!message?.text) {
        return null;
    }

    const db = getDb();
    const [row] = await db.insert(telegramIngestedMessages)
        .values({
            telegramUpdateId: update.update_id,
            telegramMessageId: message.message_id,
            chatId: String(message.chat.id),
            senderTelegramId: message.from?.id ? String(message.from.id) : null,
            senderName: [message.from?.first_name, message.from?.last_name].filter(Boolean).join(" ") || null,
            rawText: message.text,
            status: "pending",
        })
        .onConflictDoNothing()
        .returning();

    return row ?? db.query.telegramIngestedMessages.findFirst({
        where: and(
            eq(telegramIngestedMessages.chatId, String(message.chat.id)),
            eq(telegramIngestedMessages.telegramMessageId, message.message_id),
        ),
    });
}

async function markTelegramProcessed(id: string, patch: Partial<typeof telegramIngestedMessages.$inferInsert>) {
    const db = getDb();
    await db.update(telegramIngestedMessages)
        .set({
            ...patch,
            processedAt: new Date(),
        })
        .where(eq(telegramIngestedMessages.id, id));
}

function buildResolutionData(current: unknown, patch: Record<string, unknown>) {
    const base = current && typeof current === "object" ? current as Record<string, unknown> : {};
    return {
        ...base,
        ...patch,
    };
}

async function markTelegramTrainingCandidate(
    id: string,
    current: unknown,
    reason: string,
    details: Record<string, unknown> = {},
) {
    await markTelegramProcessed(id, {
        resolutionData: buildResolutionData(current, {
            trainingCandidate: true,
            trainingReason: reason,
            ...details,
        }),
    });
}

async function resolveTelegramCommandActor(message: TelegramUpdate["message"]) {
    const senderTelegramId = message?.from?.id ? String(message.from.id) : null;
    const senderName = [message?.from?.first_name, message?.from?.last_name].filter(Boolean).join(" ").trim();

    if (senderTelegramId && getTelegramAdminUserIds().includes(senderTelegramId)) {
        return { userId: null, roles: ["admin"] as const, senderName };
    }
    if (senderTelegramId && getTelegramChiefUserIds().includes(senderTelegramId)) {
        return { userId: null, roles: ["chief"] as const, senderName };
    }

    if (!senderName) {
        return null;
    }

    const doctor = await resolveDoctorId(senderName);
    if (!doctor) {
        return null;
    }

    const db = getDb();
    const rows = await db
        .select({ userId: users.id, role: userRoles.role })
        .from(users)
        .innerJoin(userRoles, eq(userRoles.userId, users.id))
        .where(and(eq(users.doctorId, doctor.id), eq(users.isActive, true), inArray(userRoles.role, ["admin", "chief"])));

    if (rows.length === 0) {
        return null;
    }

    return {
        userId: rows[0].userId,
        roles: [...new Set(rows.map((row) => row.role))] as Array<"admin" | "chief">,
        senderName: doctor.fullName,
    };
}

async function isTelegramMessageAllowed(message: TelegramUpdate["message"]) {
    if (!message) {
        return false;
    }

    if (isTelegramChatAllowed(message.chat.id)) {
        return true;
    }

    if (message.chat.type !== "private") {
        return false;
    }

    if (isTelegramPrivateControlUserId(message.from?.id)) {
        return true;
    }

    const actor = await resolveTelegramCommandActor(message);
    return Boolean(actor && actor.roles.some((role) => role === "admin" || role === "chief"));
}

async function announcePrivateCorrectionToGroups(seed: number, params: { name: string; target: string; time: string }) {
    const groupChatIds = getTelegramAnnouncementChatIds();
    if (groupChatIds.length === 0) {
        return;
    }

    const text = buildGroupCorrectionAnnouncement(seed, params);
    const results = await Promise.allSettled(groupChatIds.map((chatId) => sendMessage(chatId, text)));
    for (const result of results) {
        if (result.status === "rejected") {
            console.error("telegram group correction announcement failed", result.reason);
        }
    }
}

async function findActiveOccupancyByTarget(parsed: OperationalParsedEntry) {
    const db = getDb();
    if (parsed.sector === "REGULATION") {
        const post = await db.query.regulationPosts.findFirst({ where: eq(regulationPosts.code, parsed.baseCode) });
        if (!post) {
            throw new Error("Regulation post not found.");
        }

        const occupancy = await db.query.regulationOccupancies.findFirst({
            where: and(
                eq(regulationOccupancies.postId, post.id),
                isNull(regulationOccupancies.endedAt),
            ),
        });
        return { post, occupancy, base: null };
    }

    const base = await db.query.interventionBases.findFirst({ where: eq(interventionBases.code, parsed.baseCode) });
    if (!base) {
        throw new Error("Intervention base not found.");
    }

    const occupancy = await db.query.interventionOccupancies.findFirst({
        where: and(
            eq(interventionOccupancies.baseId, base.id),
            isNull(interventionOccupancies.endedAt),
        ),
        orderBy: [desc(interventionOccupancies.boardStartedAt), desc(interventionOccupancies.startedAt)],
    });
    return { base, occupancy, post: null };
}

async function loadDoctorFullName(doctorId: string) {
    const db = getDb();
    const doctor = await db.query.doctors.findFirst({ where: eq(doctors.id, doctorId) });
    return doctor?.fullName ?? "Medico nao identificado";
}

async function loadDoctorById(doctorId: string | null | undefined) {
    if (!doctorId) {
        return null;
    }

    const db = getDb();
    return db.query.doctors.findFirst({ where: eq(doctors.id, doctorId) });
}

function resolveCommandAuditUserId(actorUserId: string | null | undefined) {
    return actorUserId ?? null;
}

function doctorMatchesCommandQuery(query: string, doctor: { fullName: string; displayName: string | null }) {
    const normalizedQuery = normalizeDoctorName(query);
    if (!normalizedQuery) {
        return false;
    }

    const queryTokens = normalizedQuery.split(/\s+/).filter(Boolean);
    if (queryTokens.length === 0) {
        return false;
    }

    const doctorTokens = new Set(normalizeDoctorName(doctor.fullName).split(/\s+/).filter(Boolean));
    const displayTokens = new Set(normalizeDoctorName(doctor.displayName ?? "").split(/\s+/).filter(Boolean));

    return queryTokens.every((token) => doctorTokens.has(token) || displayTokens.has(token));
}

async function resolveCommandDoctor(params: {
    doctorQuery: string | null;
    activeDoctorId: string | null | undefined;
}) {
    const activeDoctor = await loadDoctorById(params.activeDoctorId);

    if (!params.doctorQuery) {
        return {
            doctor: activeDoctor,
            candidates: [] as TelegramDoctorCandidate[],
            usedActiveDoctorFallback: Boolean(activeDoctor),
        };
    }

    const exact = await resolveDoctorId(params.doctorQuery);
    if (exact) {
        return {
            doctor: exact,
            candidates: [] as TelegramDoctorCandidate[],
            usedActiveDoctorFallback: false,
        };
    }

    if (activeDoctor && doctorMatchesCommandQuery(params.doctorQuery, activeDoctor)) {
        return {
            doctor: activeDoctor,
            candidates: [] as TelegramDoctorCandidate[],
            usedActiveDoctorFallback: true,
        };
    }

    const { doctor, candidates } = await resolveDoctorWithFallback(params.doctorQuery);
    if (doctor) {
        return {
            doctor,
            candidates,
            usedActiveDoctorFallback: false,
        };
    }

    const confidentCandidate = pickConfidentDoctorCandidate(params.doctorQuery, candidates);
    if (confidentCandidate) {
        const inferredDoctor = await loadDoctorById(confidentCandidate.id);
        if (inferredDoctor) {
            return {
                doctor: inferredDoctor,
                candidates,
                usedActiveDoctorFallback: false,
            };
        }
    }

    if (candidates.length === 1 && candidates[0].score >= 180) {
        const singleCandidate = await loadDoctorById(candidates[0].id);
        if (singleCandidate) {
            return {
                doctor: singleCandidate,
                candidates,
                usedActiveDoctorFallback: false,
            };
        }
    }

    if (activeDoctor) {
        const activeCandidate = candidates.find((candidate) => candidate.id === activeDoctor.id);
        if (activeCandidate && activeCandidate.score >= 140) {
            return {
                doctor: activeDoctor,
                candidates,
                usedActiveDoctorFallback: true,
            };
        }
    }

    return {
        doctor: null,
        candidates,
        usedActiveDoctorFallback: false,
    };
}

async function resolveOperationalDoctor(params: {
    parsed: OperationalParsedEntry;
    doctorQuery: string | null;
    senderName: string | null;
}) {
    const active = params.parsed.baseCode ? await findActiveOccupancyByTarget(params.parsed) : null;
    const activeDoctorId = active?.occupancy?.doctorId;

    if (params.parsed.isDeparture) {
        return {
            ...(await resolveCommandDoctor({
                doctorQuery: params.doctorQuery,
                activeDoctorId,
            })),
            active,
        };
    }

    const lookupQuery = params.doctorQuery || params.senderName;
    const resolved = lookupQuery ? await resolveDoctorWithFallback(lookupQuery) : { doctor: null, candidates: [] as TelegramDoctorCandidate[] };
    return {
        doctor: resolved.doctor,
        candidates: resolved.candidates,
        usedActiveDoctorFallback: false,
        active,
    };
}

async function handleTelegramCommand(update: TelegramUpdate, logId: string) {
    const message = update.message;
    if (!message?.text) {
        return null;
    }

    const command = parseTelegramCommand(message.text);
    if (!command) {
        if (message.text.trim().startsWith("/")) {
            await markTelegramProcessed(logId, {
                status: "ignored",
                errorMessage: "command_parse_failed",
                resolutionData: { trainingCandidate: true, trainingReason: "command_parse_failed", rawCommand: message.text },
            });
            await sendMessage(message.chat.id, pickTelegramReply("command_usage", message.message_id, {
                usage: "/corrigir PM04 20:00 | /corrigir PM04 Nome Completo 20:00 | /retirar PM04 19:00 | /remover PM04",
            }), message.message_id);
            return { ok: true, ignored: true };
        }
        return null;
    }

    const actor = await resolveTelegramCommandActor(message);
    if (!actor || !actor.roles.some((role) => role === "admin" || role === "chief")) {
        await markTelegramProcessed(logId, {
            status: "ignored",
            errorMessage: "command_forbidden",
            parsedDomain: command.sector,
            parsedTargetCode: command.targetCode,
            parsedAction: command.name,
            resolutionData: { commandName: command.name, commandBody: command.rawBody },
        });
        await sendMessage(message.chat.id, pickTelegramReply("command_forbidden", message.message_id, {}), message.message_id);
        return { ok: true, ignored: true };
    }

    const parsedEntry: OperationalParsedEntry = {
        sector: command.sector,
        baseCode: command.targetCode,
        arrivalTime: command.time,
        shiftType: null,
        roleFunction: null,
        isDeparture: command.isDeparture,
    };

    const active = await findActiveOccupancyByTarget(parsedEntry);
    if (!active.occupancy) {
        await markTelegramProcessed(logId, {
            status: "error",
            errorMessage: "command_target_not_found",
            parsedDomain: command.sector,
            parsedTargetCode: command.targetCode,
            parsedAction: command.name,
        });
        await sendMessage(message.chat.id, `:/ Nao encontrei ocupacao ativa em ${command.targetCode} para aplicar ${command.name}.`, message.message_id);
        return { ok: true, ignored: true };
    }

    if (command.name === "corrigir" && !command.isDeparture) {
        if (!command.time) {
            await markTelegramProcessed(logId, {
                status: "ignored",
                errorMessage: "command_usage_invalid",
                parsedDomain: command.sector,
                parsedTargetCode: command.targetCode,
                parsedAction: command.name,
            });
            await sendMessage(message.chat.id, pickTelegramReply("command_usage", message.message_id, {
                usage: "/corrigir PM04 20:00 | /corrigir PM04 Nome Completo 20:00",
            }), message.message_id);
            return { ok: true, ignored: true };
        }

        const { doctor, candidates, usedActiveDoctorFallback } = await resolveCommandDoctor({
            doctorQuery: command.doctorName,
            activeDoctorId: active.occupancy.doctorId,
        });
        if (!doctor) {
            await markTelegramProcessed(logId, {
                status: "ignored",
                errorMessage: "command_doctor_not_resolved",
                parsedDomain: command.sector,
                parsedTargetCode: command.targetCode,
                parsedAction: command.name,
                resolutionData: {
                    doctorQuery: command.doctorName,
                    activeDoctorId: active.occupancy.doctorId,
                    candidates: candidates.slice(0, 3),
                },
            });
            await sendMessage(message.chat.id, buildNameUnresolvedReply(message.message_id, candidates), message.message_id);
            return { ok: true, ignored: true };
        }

        try {
            const eventAt = resolveTelegramEventTime(new Date(message.date * 1000), command.time);
            const updated = command.sector === "REGULATION"
                ? await correctRegulationOccupancy(active.occupancy.id, {
                    doctorId: doctor.id,
                    startedAt: eventAt,
                    boardStartedAt: eventAt,
                    notes: `${active.occupancy.notes ?? ""}\n[telegram /corrigir] ${message.text}`.trim(),
                }, resolveCommandAuditUserId(null))
                : await correctInterventionOccupancy(active.occupancy.id, {
                    doctorId: doctor.id,
                    startedAt: eventAt,
                    boardStartedAt: eventAt,
                    notes: `${active.occupancy.notes ?? ""}\n[telegram /corrigir] ${message.text}`.trim(),
                }, resolveCommandAuditUserId(null));

            await markTelegramProcessed(logId, {
                status: "accepted",
                parsedDomain: command.sector,
                parsedTargetCode: command.targetCode,
                parsedAction: command.name,
                parsedDoctorName: doctor.fullName,
                relatedOccupancyId: updated.id,
                resolutionData: {
                    actorRoles: actor.roles,
                    commandName: command.name,
                    usedActiveDoctorFallback,
                },
            });
            await sendMessage(message.chat.id, pickTelegramReply("command_corrected", message.message_id, {
                target: command.targetCode,
                name: doctor.fullName,
                time: formatTelegramReplyTime(eventAt),
            }), message.message_id);

            if (message.chat.type === "private") {
                await announcePrivateCorrectionToGroups(message.message_id, {
                    target: command.targetCode,
                    name: doctor.fullName,
                    time: formatTelegramReplyTime(eventAt),
                });
            }

            return { ok: true, occupancyId: updated.id };
        } catch (error) {
            await markTelegramProcessed(logId, {
                status: "error",
                parsedDomain: command.sector,
                parsedTargetCode: command.targetCode,
                parsedAction: command.name,
                parsedDoctorName: doctor.fullName,
                errorMessage: error instanceof Error ? error.message : "command_correction_failed",
                resolutionData: {
                    actorRoles: actor.roles,
                    commandName: command.name,
                    usedActiveDoctorFallback,
                },
            });
            await sendMessage(message.chat.id, `:/ Nao consegui corrigir ${command.targetCode}. ${error instanceof Error ? error.message : "Falha inesperada."}`, message.message_id);
            return { ok: true, ignored: true };
        }
    }

    if (command.name === "retirar" || command.isDeparture) {
        const eventAt = resolveTelegramEventTime(new Date(message.date * 1000), command.time);
        const { doctor, candidates, usedActiveDoctorFallback } = await resolveCommandDoctor({
            doctorQuery: command.doctorName,
            activeDoctorId: active.occupancy.doctorId,
        });
        if (!doctor) {
            await markTelegramProcessed(logId, {
                status: "ignored",
                errorMessage: "command_doctor_not_resolved",
                parsedDomain: command.sector,
                parsedTargetCode: command.targetCode,
                parsedAction: "departure",
                resolutionData: {
                    doctorQuery: command.doctorName,
                    activeDoctorId: active.occupancy.doctorId,
                    candidates: candidates.slice(0, 3),
                },
            });
            await sendMessage(message.chat.id, buildNameUnresolvedReply(message.message_id, candidates), message.message_id);
            return { ok: true, ignored: true };
        }

        const updated = command.sector === "REGULATION"
            ? await endRegulationOccupancy(active.occupancy.id, { endedAt: eventAt, actualEndedAt: eventAt }, resolveCommandAuditUserId(null))
            : await endInterventionOccupancy(active.occupancy.id, { endedAt: eventAt, actualEndedAt: eventAt }, resolveCommandAuditUserId(null));
        const doctorName = doctor.fullName;

        await markTelegramProcessed(logId, {
            status: "accepted",
            parsedDomain: command.sector,
            parsedTargetCode: command.targetCode,
            parsedAction: "departure",
            parsedDoctorName: doctorName,
            relatedOccupancyId: updated.id,
            resolutionData: { actorRoles: actor.roles, commandName: command.name, usedActiveDoctorFallback },
        });
        await sendMessage(message.chat.id, pickTelegramReply("command_removed", message.message_id, {
            target: command.targetCode,
            name: doctorName,
            time: formatTelegramReplyTime(eventAt),
        }), message.message_id);
        return { ok: true, occupancyId: updated.id };
    }

    const deleted = command.sector === "REGULATION"
        ? await removeRegulationOccupancyRecord(active.occupancy.id, resolveCommandAuditUserId(null))
        : await removeInterventionOccupancyRecord(active.occupancy.id, resolveCommandAuditUserId(null));
    const doctorName = await loadDoctorFullName(deleted.doctorId);

    await markTelegramProcessed(logId, {
        status: "accepted",
        parsedDomain: command.sector,
        parsedTargetCode: command.targetCode,
        parsedAction: command.name,
        parsedDoctorName: doctorName,
        relatedOccupancyId: null,
        resolutionData: { actorRoles: actor.roles, commandName: command.name },
    });
    await sendMessage(message.chat.id, pickTelegramReply("command_deleted", message.message_id, {
        target: command.targetCode,
        name: doctorName,
        time: "",
    }), message.message_id);
    return { ok: true, removed: true };
}

async function findPendingNameSelection(chatId: string, senderTelegramId: string) {
    const db = getDb();
    return db.query.telegramIngestedMessages.findFirst({
        where: and(
            eq(telegramIngestedMessages.chatId, chatId),
            eq(telegramIngestedMessages.senderTelegramId, senderTelegramId),
            eq(telegramIngestedMessages.status, "pending_name_selection"),
        ),
        orderBy: [desc(telegramIngestedMessages.createdAt)],
    });
}

function isPendingResolutionData(value: unknown): value is PendingNameResolutionData {
    if (!value || typeof value !== "object") {
        return false;
    }

    const candidate = value as Record<string, unknown>;
    return Boolean(
        candidate.parsed
        && candidate.candidates
        && candidate.originalEventAt,
    );
}

async function queuePendingNameSelection(
    logId: string,
    message: TelegramUpdate["message"],
    parsed: OperationalParsedEntry,
    eventAt: Date,
    candidates: TelegramDoctorCandidate[],
) {
    await markTelegramProcessed(logId, {
        status: "pending_name_selection",
        parsedDomain: parsed.sector,
        parsedTargetCode: parsed.baseCode,
        parsedAction: parsed.isDeparture ? "departure" : "arrival",
        resolutionData: {
            parsed: {
                sector: parsed.sector,
                baseCode: parsed.baseCode,
                arrivalTime: parsed.arrivalTime,
                shiftType: parsed.shiftType,
                roleFunction: parsed.roleFunction,
                isDeparture: parsed.isDeparture,
            },
            candidates: candidates.slice(0, 3).map((candidate) => ({
                id: candidate.id,
                fullName: candidate.fullName,
                displayName: candidate.displayName,
                normalizedName: candidate.normalizedName,
            })),
            originalText: message?.text ?? "",
            originalEventAt: eventAt.toISOString(),
        },
    });

    await sendMessage(
        message!.chat.id,
        `${buildCandidatePromptReply(message!.message_id, candidates)}\n\nVou manter o horario da primeira mensagem.`,
        message!.message_id,
    );
}

async function applyParsedEntry(params: {
    parsed: OperationalParsedEntry;
    resolvedDoctor: { id: string; fullName: string };
    eventAt: Date;
    messageText: string;
}) {
    const db = getDb();
    const { parsed, resolvedDoctor, eventAt, messageText } = params;
    let occupancyId: string | null = null;

    if (parsed.sector === "REGULATION") {
        const post = await db.query.regulationPosts.findFirst({
            where: eq(regulationPosts.code, parsed.baseCode as string),
        });
        if (!post) {
            throw new Error("Regulation post not found.");
        }

        if (parsed.isDeparture) {
            const occupancy = await db.query.regulationOccupancies.findFirst({
                where: and(
                    eq(regulationOccupancies.postId, post.id),
                    eq(regulationOccupancies.doctorId, resolvedDoctor.id),
                    isNull(regulationOccupancies.endedAt),
                ),
            });
            if (!occupancy) {
                throw new Error("No active regulation occupancy found for this doctor/post.");
            }

            occupancyId = (await endRegulationOccupancy(occupancy.id, {
                endedAt: eventAt,
                actualEndedAt: eventAt,
            })).id;
        } else {
            occupancyId = (await startRegulationOccupancy({
                doctorId: resolvedDoctor.id,
                postId: post.id,
                startedAt: eventAt,
                shiftLabel: parsed.shiftType,
                roleLabel: parsed.roleFunction,
                ramalLabel: parsed.baseCode,
                source: "telegram",
                notes: messageText,
                createdByUserId: null,
            })).id;
        }
    } else {
        const base = await db.query.interventionBases.findFirst({
            where: eq(interventionBases.code, parsed.baseCode as string),
        });
        if (!base) {
            throw new Error("Intervention base not found.");
        }

        if (parsed.isDeparture) {
            const occupancy = await db.query.interventionOccupancies.findFirst({
                where: and(
                    eq(interventionOccupancies.baseId, base.id),
                    eq(interventionOccupancies.doctorId, resolvedDoctor.id),
                    isNull(interventionOccupancies.endedAt),
                ),
            });
            if (!occupancy) {
                throw new Error("No active intervention occupancy found for this doctor/base.");
            }

            occupancyId = (await endInterventionOccupancy(occupancy.id, {
                endedAt: eventAt,
                actualEndedAt: eventAt,
            })).id;
        } else {
            occupancyId = (await startInterventionOccupancy({
                doctorId: resolvedDoctor.id,
                baseId: base.id,
                startedAt: eventAt,
                shiftLabel: parsed.shiftType,
                roleLabel: parsed.roleFunction,
                source: "telegram",
                notes: messageText,
                createdByUserId: null,
            })).id;
        }
    }

    return { occupancyId };
}

async function sendSuccessReply(
    chatId: number,
    replyToMessageId: number,
    seed: number,
    parsed: OperationalParsedEntry,
    doctorName: string,
    eventAt: Date,
) {
    const time = eventAt.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "America/Sao_Paulo" });
    const text = pickTelegramReply(
        parsed.isDeparture ? "departure_recorded" : "arrival_recorded",
        seed,
        {
            name: doctorName,
            target: parsed.baseCode ?? "plantao",
            time,
        },
    );
    await sendMessage(chatId, text, replyToMessageId);
}

function formatTelegramReplyTime(value: Date) {
    return value.toLocaleTimeString("pt-BR", {
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
        timeZone: "America/Sao_Paulo",
    });
}

async function tryHandlePendingNameSelection(update: TelegramUpdate, logId: string) {
    const message = update.message;
    if (!message?.text || !message.from?.id) {
        return null;
    }

    const pending = await findPendingNameSelection(String(message.chat.id), String(message.from.id));
    if (!pending || !isPendingResolutionData(pending.resolutionData)) {
        return null;
    }

    const replyCandidates = pending.resolutionData.candidates.map((candidate) => ({
        ...candidate,
        score: 0,
    }));
    let selected = pickCandidateFromReply(message.text, replyCandidates);

    if (!selected) {
        const directory = await listDirectoryEntries();
        const refreshedCandidates = resolveDoctorCandidates(message.text, directory as TelegramDoctorDirectoryEntry[]);
        if (refreshedCandidates.length > 0) {
            if (refreshedCandidates.length === 1 || (refreshedCandidates[0].score >= (refreshedCandidates[1]?.score ?? 0) + 40)) {
                selected = refreshedCandidates[0];
            } else {
                await markTelegramProcessed(pending.id, {
                    status: "superseded",
                    errorMessage: "pending_name_selection_replaced",
                });
                await queuePendingNameSelection(logId, message, pending.resolutionData.parsed, new Date(pending.resolutionData.originalEventAt), refreshedCandidates);
                return { ok: true, ignored: true, pending: true };
            }
        }
    }

    if (!selected) {
        const directory = await listDirectoryEntries();
        const nearbyCandidates = resolveDoctorCandidates(message.text, directory as TelegramDoctorDirectoryEntry[], 3);

        if (isCasualTelegramMessage(message.text)) {
            await markTelegramProcessed(logId, {
                status: "ignored",
                errorMessage: "casual_smalltalk_pending",
                resolutionData: { casual: true, pendingSelectionKept: true },
            });
            await sendMessage(
                message.chat.id,
                pickTelegramReply("casual_smalltalk", message.message_id, {}),
                message.message_id,
            );
            return { ok: true, ignored: true, pending: true };
        }

        await sendMessage(
            message.chat.id,
            buildNameUnresolvedReply(message.message_id, nearbyCandidates),
            message.message_id,
        );
        await markTelegramProcessed(logId, {
            status: "ignored",
            errorMessage: "pending_name_selection_unresolved",
        });
        return { ok: true, ignored: true };
    }

    const result = await applyParsedEntry({
        parsed: pending.resolutionData.parsed,
        resolvedDoctor: { id: selected.id, fullName: selected.fullName },
        eventAt: new Date(pending.resolutionData.originalEventAt),
        messageText: pending.resolutionData.originalText,
    });

    await markTelegramProcessed(pending.id, {
        status: "accepted",
        parsedDoctorName: selected.fullName,
        relatedOccupancyId: result.occupancyId,
        errorMessage: null,
    });
    await markTelegramProcessed(logId, {
        status: "accepted",
        parsedDomain: pending.resolutionData.parsed.sector,
        parsedTargetCode: pending.resolutionData.parsed.baseCode,
        parsedAction: pending.resolutionData.parsed.isDeparture ? "departure" : "arrival",
        parsedDoctorName: selected.fullName,
        relatedOccupancyId: result.occupancyId,
    });
    await sendSuccessReply(
        message.chat.id,
        message.message_id,
        message.message_id,
        pending.resolutionData.parsed,
        selected.fullName,
        new Date(pending.resolutionData.originalEventAt),
    );
    return { ok: true, occupancyId: result.occupancyId };
}

export async function processTelegramUpdate(update: TelegramUpdate) {
    const message = update.message;
    if (!message?.text) {
        return { ok: true, ignored: true };
    }

    const log = await logTelegramMessage(update);
    if (!(await isTelegramMessageAllowed(message))) {
        if (log) {
            await markTelegramProcessed(log.id, { status: "ignored", errorMessage: "chat_not_allowed" });
        }
        return { ok: true, ignored: true };
    }
    if (log) {
        try {
            const commandResult = await handleTelegramCommand(update, log.id);
            if (commandResult) {
                return commandResult;
            }

            if (message.from?.id) {
                const pendingResult = await tryHandlePendingNameSelection(update, log.id);
                if (pendingResult) {
                    return pendingResult;
                }
            }

            const parsedEntries = parseMessageMulti(message.text).filter(isOperationalParsedEntry);
            if (parsedEntries.length === 0) {
                if (isCasualTelegramMessage(message.text)) {
                    await markTelegramProcessed(log.id, {
                        status: "ignored",
                        errorMessage: "casual_smalltalk",
                        resolutionData: { casual: true },
                    });
                    await sendMessage(
                        message.chat.id,
                        pickTelegramReply("casual_smalltalk", message.message_id, {}),
                        message.message_id,
                    );
                    return { ok: true, ignored: true };
                }

                await markTelegramProcessed(log.id, {
                    status: "ignored",
                    errorMessage: "no_operational_match",
                    resolutionData: { trainingCandidate: true, trainingReason: "no_operational_match" },
                });
                return { ok: true, ignored: true };
            }

            const firstParsed = parsedEntries[0];
            const senderName = [message.from?.first_name, message.from?.last_name].filter(Boolean).join(" ");
            const doctorQuery = firstParsed.extractedNames[0] ?? null;
            const { doctor: resolvedDoctor, candidates } = await resolveOperationalDoctor({
                parsed: firstParsed,
                doctorQuery,
                senderName,
            });
            if (!resolvedDoctor) {
                const eventAt = resolveTelegramEventTime(new Date(message.date * 1000), firstParsed.arrivalTime);
                if (candidates.length > 0) {
                    await queuePendingNameSelection(log.id, message, firstParsed, eventAt, candidates);
                    return { ok: true, ignored: true, pending: true };
                }

                await markTelegramProcessed(log.id, {
                    status: "ignored",
                    parsedDomain: firstParsed.sector,
                    parsedTargetCode: firstParsed.baseCode,
                    parsedAction: firstParsed.isDeparture ? "departure" : "arrival",
                    errorMessage: "doctor_not_resolved",
                    resolutionData: { trainingCandidate: true, trainingReason: "doctor_not_resolved", doctorQuery: doctorQuery || senderName },
                });
                await sendMessage(message.chat.id, buildNameUnresolvedReply(message.message_id, candidates), message.message_id);
                return { ok: true, ignored: true };
            }

            const eventAt = resolveTelegramEventTime(new Date(message.date * 1000), firstParsed.arrivalTime);

            try {
                const { occupancyId } = await applyParsedEntry({
                    parsed: firstParsed,
                    resolvedDoctor: { id: resolvedDoctor.id, fullName: resolvedDoctor.fullName },
                    eventAt,
                    messageText: message.text,
                });

                await markTelegramProcessed(log.id, {
                    status: "accepted",
                    parsedDomain: firstParsed.sector,
                    parsedTargetCode: firstParsed.baseCode,
                    parsedAction: firstParsed.isDeparture ? "departure" : "arrival",
                    parsedDoctorName: resolvedDoctor.fullName,
                    relatedOccupancyId: occupancyId,
                });

                await sendSuccessReply(
                    message.chat.id,
                    message.message_id,
                    update.update_id,
                    firstParsed,
                    resolvedDoctor.fullName,
                    eventAt,
                );

                return { ok: true, occupancyId };
            } catch (error) {
                await markTelegramProcessed(log.id, {
                    status: "error",
                    parsedDomain: firstParsed.sector,
                    parsedTargetCode: firstParsed.baseCode,
                    parsedAction: firstParsed.isDeparture ? "departure" : "arrival",
                    parsedDoctorName: resolvedDoctor.fullName,
                    errorMessage: error instanceof Error ? error.message : "telegram_processing_failed",
                });
                throw error;
            }
        } catch (error) {
            await markTelegramProcessed(log.id, {
                status: "error",
                errorMessage: error instanceof Error ? error.message : "telegram_processing_failed",
            });
            return { ok: true, ignored: true, processingError: true };
        }
    }

    return { ok: true, ignored: true };
}
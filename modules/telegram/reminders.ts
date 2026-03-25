import { desc, eq, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { telegramBotNotices, telegramIngestedMessages } from "@/db/schema";
import { sendMessage } from "@/modules/telegram/api";
import { getTelegramReminderChatIds } from "@/modules/telegram/config";

export interface ReminderShiftSnapshot {
    shiftInstanceId: string;
    targetCode: string;
    targetLabel: string;
    sector: "REGULATION" | "INTERVENTION";
    scheduledStartAt: Date | null;
    scheduledEndAt: Date | null;
    arrivalTime: Date | null;
    departureTime: Date | null;
}

export interface ReminderPlan {
    noticeKey: string;
    stage: "greeting" | "nudge" | "escalation";
    text: string;
    payload: Record<string, unknown>;
}

interface ReminderPlanningParams {
    now: Date;
    lastActivityAt: Date | null;
    shifts: ReminderShiftSnapshot[];
}

const FIVE_MINUTES = 5 * 60 * 1000;
const TEN_MINUTES = 10 * 60 * 1000;
const TWO_HOURS = 2 * 60 * 60 * 1000;

function uniqueTargets(shifts: ReminderShiftSnapshot[]) {
    const map = new Map<string, ReminderShiftSnapshot>();
    for (const shift of shifts) {
        map.set(`${shift.sector}:${shift.targetCode}`, shift);
    }

    return [...map.values()].sort((left, right) => left.targetCode.localeCompare(right.targetCode, "pt-BR"));
}

function formatTarget(shift: ReminderShiftSnapshot) {
    return shift.targetLabel && shift.targetLabel !== shift.targetCode
        ? `${shift.targetCode} - ${shift.targetLabel}`
        : shift.targetCode;
}

function formatTargetList(shifts: ReminderShiftSnapshot[]) {
    return uniqueTargets(shifts)
        .map((shift) => `- ${formatTarget(shift)}`)
        .join("\n");
}

function floorToBucket(date: Date, bucketMs: number) {
    return new Date(Math.floor(date.getTime() / bucketMs) * bucketMs);
}

function formatHour(date: Date) {
    return date.toLocaleTimeString("pt-BR", {
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
        timeZone: "America/Sao_Paulo",
    });
}

export function buildReminderPlans(params: ReminderPlanningParams) {
    const { now, lastActivityAt, shifts } = params;
    const plans: ReminderPlan[] = [];
    const inactiveMs = lastActivityAt ? now.getTime() - lastActivityAt.getTime() : Number.POSITIVE_INFINITY;
    const isInactive = inactiveMs >= FIVE_MINUTES;

    const greetingGroups = new Map<string, ReminderShiftSnapshot[]>();
    for (const shift of shifts) {
        if (!shift.scheduledStartAt || shift.arrivalTime) {
            continue;
        }

        const delta = shift.scheduledStartAt.getTime() - now.getTime();
        if (delta < 0 || delta > TEN_MINUTES) {
            continue;
        }

        const slotKey = shift.scheduledStartAt.toISOString();
        const current = greetingGroups.get(slotKey) ?? [];
        current.push(shift);
        greetingGroups.set(slotKey, current);
    }

    for (const [slotKey, group] of greetingGroups) {
        const slotAt = new Date(slotKey);
        plans.push({
            noticeKey: `greeting:${slotAt.toISOString()}`,
            stage: "greeting",
            payload: {
                slotAt: slotAt.toISOString(),
                targets: uniqueTargets(group).map((shift) => shift.targetCode),
            },
            text: [
                ':)',
                `Plantao chegando por volta de ${formatHour(slotAt)}.`,
                "",
                "Entradas esperadas nesse horario:",
                formatTargetList(group),
                "",
                "Quando forem confirmando chegadas e saidas, podem avisar por aqui.",
            ].join("\n"),
        });
    }

    const recentArrivalPending = shifts.filter((shift) => {
        if (!shift.scheduledStartAt || shift.arrivalTime) {
            return false;
        }

        const delta = shift.scheduledStartAt.getTime() - now.getTime();
        return delta <= FIVE_MINUTES && delta >= -TEN_MINUTES;
    });
    const recentDeparturePending = shifts.filter((shift) => {
        if (!shift.scheduledEndAt || shift.departureTime) {
            return false;
        }

        const delta = shift.scheduledEndAt.getTime() - now.getTime();
        return delta <= FIVE_MINUTES && delta >= -TEN_MINUTES;
    });

    const overdueArrivalPending = shifts.filter((shift) => {
        if (!shift.scheduledStartAt || shift.arrivalTime) {
            return false;
        }

        const overdueMs = now.getTime() - shift.scheduledStartAt.getTime();
        return overdueMs >= TEN_MINUTES && overdueMs <= TWO_HOURS;
    });
    const overdueDeparturePending = shifts.filter((shift) => {
        if (!shift.scheduledEndAt || shift.departureTime) {
            return false;
        }

        const overdueMs = now.getTime() - shift.scheduledEndAt.getTime();
        return overdueMs >= TEN_MINUTES && overdueMs <= TWO_HOURS;
    });

    if (isInactive && (recentArrivalPending.length > 0 || recentDeparturePending.length > 0)) {
        const bucket = floorToBucket(now, FIVE_MINUTES);
        const sections = [
            ':|',
            "Estou acompanhando a troca de plantao por aqui.",
            "",
        ];

        if (recentArrivalPending.length > 0) {
            sections.push("Avisem as chegadas, por favor:");
            sections.push(formatTargetList(recentArrivalPending));
            sections.push("");
        }

        if (recentDeparturePending.length > 0) {
            sections.push("Avisem as saidas, por favor:");
            sections.push(formatTargetList(recentDeparturePending));
            sections.push("");
        }

        sections.push("Pode mandar uma linha por vez. Eu registro daqui.");

        plans.push({
            noticeKey: `nudge:${bucket.toISOString()}`,
            stage: "nudge",
            payload: {
                bucketAt: bucket.toISOString(),
                arrivalTargets: uniqueTargets(recentArrivalPending).map((shift) => shift.targetCode),
                departureTargets: uniqueTargets(recentDeparturePending).map((shift) => shift.targetCode),
            },
            text: sections.join("\n"),
        });
    }

    if (isInactive && (overdueArrivalPending.length > 0 || overdueDeparturePending.length > 0)) {
        const bucket = floorToBucket(now, FIVE_MINUTES);
        const sections = [
            ':(',
            "Ainda faltam confirmacoes no plantao.",
            "",
        ];

        if (overdueArrivalPending.length > 0) {
            sections.push("Chegadas ainda sem confirmacao:");
            sections.push(formatTargetList(overdueArrivalPending));
            sections.push("");
        }

        if (overdueDeparturePending.length > 0) {
            sections.push("Saidas ainda sem confirmacao:");
            sections.push(formatTargetList(overdueDeparturePending));
            sections.push("");
        }

        sections.push("Quando puderem, mandem as atualizacoes por aqui para eu fechar o quadro.");

        plans.push({
            noticeKey: `escalation:${bucket.toISOString()}`,
            stage: "escalation",
            payload: {
                bucketAt: bucket.toISOString(),
                arrivalTargets: uniqueTargets(overdueArrivalPending).map((shift) => shift.targetCode),
                departureTargets: uniqueTargets(overdueDeparturePending).map((shift) => shift.targetCode),
            },
            text: sections.join("\n"),
        });
    }

    return plans;
}

async function loadReminderShifts(now: Date) {
    const db = getDb();
    const lowerBound = new Date(now.getTime() - TWO_HOURS).toISOString();
    const upperBound = new Date(now.getTime() + TEN_MINUTES).toISOString();
    const result = await db.execute(sql`
        select
            s.id as shift_instance_id,
            coalesce(cs.ramal, b.code, 'sem-codigo') as target_code,
            coalesce(b.name, cs.ramal, s.role_function, 'posto') as target_label,
            case
                when cs.ramal is not null then 'REGULATION'
                when upper(coalesce(b.sector::text, '')) = 'REGULATION' then 'REGULATION'
                else 'INTERVENTION'
            end as sector,
            s.scheduled_start_at,
            s.scheduled_end_at,
            cs.arrival_time,
            cs.departure_time
        from public.shift_instances s
        left join public.shift_current_state cs on cs.shift_instance_id = s.id
        left join public.bases b on b.id = s.base_id
        where (
            s.scheduled_start_at between ${lowerBound}::timestamptz and ${upperBound}::timestamptz
            or s.scheduled_end_at between ${lowerBound}::timestamptz and ${upperBound}::timestamptz
        )
        and (b.is_active is null or b.is_active = true)
        order by s.scheduled_start_at asc nulls last, s.scheduled_end_at asc nulls last
    `);

    return result as unknown as ReminderShiftSnapshot[];
}

async function loadLastActivityAt(chatId: string) {
    const db = getDb();
    const row = await db.query.telegramIngestedMessages.findFirst({
        where: eq(telegramIngestedMessages.chatId, chatId),
        orderBy: [desc(telegramIngestedMessages.createdAt)],
    });

    return row?.createdAt ?? null;
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
    const chatIds = getTelegramReminderChatIds();
    if (chatIds.length === 0 || !process.env.TELEGRAM_BOT_TOKEN?.trim()) {
        return { sent: 0, evaluated: 0 };
    }

    const shifts = await loadReminderShifts(referenceDate);
    let sent = 0;
    let evaluated = 0;

    for (const chatId of chatIds) {
        const lastActivityAt = await loadLastActivityAt(chatId);
        const plans = buildReminderPlans({
            now: referenceDate,
            lastActivityAt,
            shifts,
        });
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
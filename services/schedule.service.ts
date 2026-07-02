import { and, asc, eq, inArray } from "drizzle-orm";
import { getDb } from "@/db";
import {
    doctorBasePreferences,
    doctorWeekdayPreferences,
    doctors,
    interventionBases,
    regulationPosts,
    scheduledShifts,
} from "@/db/schema";

export type ScheduleShiftLabel = "SD" | "SN";
export type ScheduleDomain = "regulation" | "intervention";

const SAO_PAULO_OFFSET_HOURS = 3;

function parseOperationalDate(value: string) {
    const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!match) {
        throw new Error(`Data operacional inválida: ${value}`);
    }
    return { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
}

function fromSaoPauloClock(year: number, month: number, day: number, hour: number) {
    return new Date(Date.UTC(year, month - 1, day, hour + SAO_PAULO_OFFSET_HOURS, 0, 0, 0));
}

/** Janela UTC do turno previsto (SD 07–19, SN 19–07+1, horário de São Paulo). */
export function resolveScheduledWindow(operationalDate: string, shiftLabel: ScheduleShiftLabel) {
    const { year, month, day } = parseOperationalDate(operationalDate);
    if (shiftLabel === "SD") {
        return {
            scheduledStartAt: fromSaoPauloClock(year, month, day, 7),
            scheduledEndAt: fromSaoPauloClock(year, month, day, 19),
        };
    }
    return {
        scheduledStartAt: fromSaoPauloClock(year, month, day, 19),
        scheduledEndAt: new Date(fromSaoPauloClock(year, month, day, 7).getTime() + 86400000),
    };
}

export function resolveWeekday(operationalDate: string) {
    const { year, month, day } = parseOperationalDate(operationalDate);
    return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

export interface ScheduleDoctorEntry {
    id: string;
    fullName: string;
    displayName: string | null;
    admittedAt: string | null;
    eligibleRegulation: boolean;
    eligibleIntervention: boolean;
    /** true = médico fixo do dia da semana da data consultada. */
    fixedForWeekday: boolean;
    /** baseIds em ordem de preferência (vazio = sem preferência). */
    basePreferences: number[];
}

export interface ScheduleTargetEntry {
    domain: ScheduleDomain;
    targetId: number;
    code: string;
    label: string;
    scheduled: {
        [label in ScheduleShiftLabel]?: {
            shiftId: string;
            doctorId: string;
            doctorName: string;
            roleLabel: string | null;
        };
    };
}

export interface ScheduleBoard {
    operationalDate: string;
    weekday: number;
    targets: ScheduleTargetEntry[];
    doctors: ScheduleDoctorEntry[];
}

export async function getScheduleBoard(operationalDate: string): Promise<ScheduleBoard> {
    const db = getDb();
    const weekday = resolveWeekday(operationalDate);

    const [posts, bases, planned, activeDoctors, weekdayPrefs, basePrefs] = await Promise.all([
        db.select().from(regulationPosts).where(eq(regulationPosts.isActive, true)).orderBy(asc(regulationPosts.sortOrder)),
        db.select().from(interventionBases).where(eq(interventionBases.isActive, true)).orderBy(asc(interventionBases.sortOrder)),
        db.select().from(scheduledShifts).where(and(
            eq(scheduledShifts.operationalDate, operationalDate),
            eq(scheduledShifts.status, "planned"),
        )),
        db.select().from(doctors).where(eq(doctors.isActive, true)).orderBy(asc(doctors.fullName)),
        db.select().from(doctorWeekdayPreferences).where(eq(doctorWeekdayPreferences.weekday, weekday)),
        db.select().from(doctorBasePreferences).orderBy(asc(doctorBasePreferences.preferenceOrder)),
    ]);

    const doctorNames = new Map(activeDoctors.map((doctor) => [doctor.id, doctor.displayName ?? doctor.fullName]));
    const fixedDoctorIds = new Set(weekdayPrefs.map((pref) => pref.doctorId));
    const basePrefsByDoctor = new Map<string, number[]>();
    for (const pref of basePrefs) {
        const list = basePrefsByDoctor.get(pref.doctorId) ?? [];
        list.push(pref.baseId);
        basePrefsByDoctor.set(pref.doctorId, list);
    }

    const targets: ScheduleTargetEntry[] = [
        ...posts.map((post) => ({
            domain: "regulation" as const,
            targetId: post.id,
            code: post.code,
            label: post.label,
            scheduled: {},
        })),
        ...bases.map((base) => ({
            domain: "intervention" as const,
            targetId: base.id,
            code: base.code,
            label: base.label,
            scheduled: {},
        })),
    ];

    const targetIndex = new Map(targets.map((target) => [`${target.domain}:${target.targetId}`, target]));
    for (const shift of planned) {
        const key = shift.postId != null ? `regulation:${shift.postId}` : `intervention:${shift.baseId}`;
        const target = targetIndex.get(key);
        const label = shift.shiftLabel as ScheduleShiftLabel;
        if (!target || (label !== "SD" && label !== "SN")) {
            continue;
        }
        target.scheduled[label] = {
            shiftId: shift.id,
            doctorId: shift.doctorId,
            doctorName: doctorNames.get(shift.doctorId) ?? "?",
            roleLabel: shift.roleLabel,
        };
    }

    const doctorEntries: ScheduleDoctorEntry[] = activeDoctors
        .map((doctor) => ({
            id: doctor.id,
            fullName: doctor.fullName,
            displayName: doctor.displayName,
            admittedAt: doctor.admittedAt,
            eligibleRegulation: doctor.eligibleRegulation,
            eligibleIntervention: doctor.eligibleIntervention,
            fixedForWeekday: fixedDoctorIds.has(doctor.id),
            basePreferences: basePrefsByDoctor.get(doctor.id) ?? [],
        }))
        .sort((left, right) => {
            if (left.fixedForWeekday !== right.fixedForWeekday) {
                return left.fixedForWeekday ? -1 : 1;
            }
            // Antiguidade: admitido há mais tempo primeiro; sem data vai pro fim do bloco.
            if (left.admittedAt !== right.admittedAt) {
                if (!left.admittedAt) return 1;
                if (!right.admittedAt) return -1;
                return left.admittedAt.localeCompare(right.admittedAt);
            }
            return left.fullName.localeCompare(right.fullName, "pt-BR");
        });

    return { operationalDate, weekday, targets, doctors: doctorEntries };
}

export async function createScheduledShift(params: {
    domain: ScheduleDomain;
    targetId: number;
    doctorId: string;
    operationalDate: string;
    shiftLabel: ScheduleShiftLabel;
    roleLabel?: string | null;
    createdByUserId: string;
}) {
    const db = getDb();

    const doctor = await db.query.doctors.findFirst({ where: eq(doctors.id, params.doctorId) });
    if (!doctor || !doctor.isActive) {
        throw new Error("Médico inexistente ou inativo.");
    }
    if (params.domain === "regulation" && !doctor.eligibleRegulation) {
        throw new Error(`${doctor.fullName} não está apto(a) a REGULAÇÃO.`);
    }
    if (params.domain === "intervention" && !doctor.eligibleIntervention) {
        throw new Error(`${doctor.fullName} não está apto(a) a INTERVENÇÃO.`);
    }

    const window = resolveScheduledWindow(params.operationalDate, params.shiftLabel);
    const [created] = await db.insert(scheduledShifts).values({
        domain: params.domain,
        postId: params.domain === "regulation" ? params.targetId : null,
        baseId: params.domain === "intervention" ? params.targetId : null,
        doctorId: params.doctorId,
        operationalDate: params.operationalDate,
        shiftLabel: params.shiftLabel,
        scheduledStartAt: window.scheduledStartAt,
        scheduledEndAt: window.scheduledEndAt,
        roleLabel: params.roleLabel ?? null,
        createdByUserId: params.createdByUserId,
    }).returning();

    return created;
}

export async function cancelScheduledShift(shiftId: string, updatedByUserId: string) {
    const db = getDb();
    const [updated] = await db.update(scheduledShifts)
        .set({ status: "cancelled", updatedByUserId, updatedAt: new Date() })
        .where(and(eq(scheduledShifts.id, shiftId), eq(scheduledShifts.status, "planned")))
        .returning();

    if (!updated) {
        throw new Error("Plantão previsto não encontrado ou já cancelado.");
    }
    return updated;
}

export async function listScheduledShiftsForDoctor(doctorId: string, fromDate: string) {
    const db = getDb();
    const rows = await db.select().from(scheduledShifts).where(and(
        eq(scheduledShifts.doctorId, doctorId),
        eq(scheduledShifts.status, "planned"),
    )).orderBy(asc(scheduledShifts.operationalDate));

    return rows.filter((row) => row.operationalDate >= fromDate);
}

export async function loadScheduledShiftsById(shiftIds: string[]) {
    if (shiftIds.length === 0) {
        return [];
    }
    const db = getDb();
    return db.select().from(scheduledShifts).where(inArray(scheduledShifts.id, shiftIds));
}

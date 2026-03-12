import { and, asc, eq, inArray } from "drizzle-orm";
import { getDb } from "@/db";
import {
    doctorBasePreferences,
    doctorFixedShifts,
    doctorWeekdayPreferences,
    doctors,
    userRoles,
    users,
} from "@/db/schema";
import { normalizeDoctorName } from "@/modules/doctors/importer";

export interface DoctorAdminEntry {
    id: string;
    fullName: string;
    displayName: string | null;
    isActive: boolean;
    eligibleRegulation: boolean;
    eligibleIntervention: boolean;
    admittedAt: string | null;
    /** weekdays ranqueados, mais preferido primeiro. */
    preferredWeekdays: number[];
    /** baseIds em ordem de preferência. */
    basePreferences: number[];
    /** turnos fixos (weekday + SD/SN); pode ter vários. */
    fixedShifts: { weekday: number; shiftLabel: string }[];
    account: { userId: string; email: string; isActive: boolean } | null;
}

export async function listDoctorsForAdmin(): Promise<DoctorAdminEntry[]> {
    const db = getDb();
    const [doctorRows, weekdayRows, baseRows, fixedRows, accountRows] = await Promise.all([
        db.select().from(doctors).orderBy(asc(doctors.fullName)),
        db.select().from(doctorWeekdayPreferences).orderBy(asc(doctorWeekdayPreferences.preferenceOrder)),
        db.select().from(doctorBasePreferences).orderBy(asc(doctorBasePreferences.preferenceOrder)),
        db.select().from(doctorFixedShifts).orderBy(asc(doctorFixedShifts.weekday), asc(doctorFixedShifts.shiftLabel)),
        db.select({
            userId: users.id,
            doctorId: users.doctorId,
            email: users.email,
            isActive: users.isActive,
            role: userRoles.role,
        }).from(users).innerJoin(userRoles, eq(userRoles.userId, users.id)).where(eq(userRoles.role, "doctor")),
    ]);

    const weekdaysByDoctor = new Map<string, number[]>();
    for (const row of weekdayRows) {
        const list = weekdaysByDoctor.get(row.doctorId) ?? [];
        list.push(row.weekday);
        weekdaysByDoctor.set(row.doctorId, list);
    }

    const basesByDoctor = new Map<string, number[]>();
    for (const row of baseRows) {
        const list = basesByDoctor.get(row.doctorId) ?? [];
        list.push(row.baseId);
        basesByDoctor.set(row.doctorId, list);
    }

    const fixedByDoctor = new Map<string, { weekday: number; shiftLabel: string }[]>();
    for (const row of fixedRows) {
        const list = fixedByDoctor.get(row.doctorId) ?? [];
        list.push({ weekday: row.weekday, shiftLabel: row.shiftLabel });
        fixedByDoctor.set(row.doctorId, list);
    }

    const accountsByDoctor = new Map(accountRows
        .filter((row) => row.doctorId)
        .map((row) => [row.doctorId as string, { userId: row.userId, email: row.email, isActive: row.isActive }]));

    return doctorRows.map((doctor) => ({
        id: doctor.id,
        fullName: doctor.fullName,
        displayName: doctor.displayName,
        isActive: doctor.isActive,
        eligibleRegulation: doctor.eligibleRegulation,
        eligibleIntervention: doctor.eligibleIntervention,
        admittedAt: doctor.admittedAt,
        preferredWeekdays: weekdaysByDoctor.get(doctor.id) ?? [],
        basePreferences: basesByDoctor.get(doctor.id) ?? [],
        fixedShifts: fixedByDoctor.get(doctor.id) ?? [],
        account: accountsByDoctor.get(doctor.id) ?? null,
    }));
}

export async function createDoctor(params: {
    fullName: string;
    displayName?: string | null;
    admittedAt?: string | null;
    eligibleRegulation: boolean;
    eligibleIntervention: boolean;
}) {
    const db = getDb();
    const normalizedName = normalizeDoctorName(params.fullName);
    if (!normalizedName) {
        throw new Error("Nome inválido.");
    }

    const existing = await db.query.doctors.findFirst({ where: eq(doctors.normalizedName, normalizedName) });
    if (existing) {
        throw new Error(`Já existe médico com este nome: ${existing.fullName}.`);
    }

    const [created] = await db.insert(doctors).values({
        fullName: params.fullName.trim(),
        displayName: params.displayName?.trim() || null,
        normalizedName,
        admittedAt: params.admittedAt ?? null,
        eligibleRegulation: params.eligibleRegulation,
        eligibleIntervention: params.eligibleIntervention,
    }).returning();

    return created;
}

export async function updateDoctorProfile(doctorId: string, params: {
    displayName?: string | null;
    admittedAt?: string | null;
    eligibleRegulation?: boolean;
    eligibleIntervention?: boolean;
    isActive?: boolean;
}) {
    const db = getDb();
    const [updated] = await db.update(doctors)
        .set({
            ...(params.displayName !== undefined ? { displayName: params.displayName?.trim() || null } : {}),
            ...(params.admittedAt !== undefined ? { admittedAt: params.admittedAt } : {}),
            ...(params.eligibleRegulation !== undefined ? { eligibleRegulation: params.eligibleRegulation } : {}),
            ...(params.eligibleIntervention !== undefined ? { eligibleIntervention: params.eligibleIntervention } : {}),
            ...(params.isActive !== undefined ? { isActive: params.isActive } : {}),
            updatedAt: new Date(),
        })
        .where(eq(doctors.id, doctorId))
        .returning();

    if (!updated) {
        throw new Error("Médico não encontrado.");
    }
    return updated;
}

/**
 * Substitui de uma vez as três listas de preferências do médico. São tabelas
 * de preferência (não append-only): delete + insert transacional é o padrão.
 */
export async function replaceDoctorPreferences(doctorId: string, params: {
    preferredWeekdays: number[];
    basePreferences: number[];
    fixedShifts: { weekday: number; shiftLabel: "SD" | "SN" }[];
}) {
    const db = getDb();
    const doctor = await db.query.doctors.findFirst({ where: eq(doctors.id, doctorId) });
    if (!doctor) {
        throw new Error("Médico não encontrado.");
    }

    const uniqueWeekdays = [...new Set(params.preferredWeekdays)];
    const uniqueBases = [...new Set(params.basePreferences)];
    const uniqueFixed = [...new Map(params.fixedShifts.map((entry) => [`${entry.weekday}:${entry.shiftLabel}`, entry])).values()];

    await db.transaction(async (tx) => {
        await tx.delete(doctorWeekdayPreferences).where(eq(doctorWeekdayPreferences.doctorId, doctorId));
        if (uniqueWeekdays.length > 0) {
            await tx.insert(doctorWeekdayPreferences).values(uniqueWeekdays.map((weekday, order) => ({
                doctorId,
                weekday,
                preferenceOrder: order,
            })));
        }

        await tx.delete(doctorBasePreferences).where(eq(doctorBasePreferences.doctorId, doctorId));
        if (uniqueBases.length > 0) {
            await tx.insert(doctorBasePreferences).values(uniqueBases.map((baseId, order) => ({
                doctorId,
                baseId,
                preferenceOrder: order,
            })));
        }

        await tx.delete(doctorFixedShifts).where(eq(doctorFixedShifts.doctorId, doctorId));
        if (uniqueFixed.length > 0) {
            await tx.insert(doctorFixedShifts).values(uniqueFixed.map((entry) => ({
                doctorId,
                weekday: entry.weekday,
                shiftLabel: entry.shiftLabel,
            })));
        }
    });
}

export async function activateDoctorAccount(userId: string) {
    const db = getDb();
    const roleRows = await db.select().from(userRoles).where(and(
        eq(userRoles.userId, userId),
        inArray(userRoles.role, ["doctor"]),
    ));
    if (roleRows.length === 0) {
        throw new Error("Conta não é de médico.");
    }

    const [updated] = await db.update(users)
        .set({ isActive: true, updatedAt: new Date() })
        .where(eq(users.id, userId))
        .returning();

    if (!updated) {
        throw new Error("Conta não encontrada.");
    }
    return updated;
}

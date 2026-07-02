import { and, asc, eq, inArray } from "drizzle-orm";
import { getDb } from "@/db";
import {
    doctorBasePreferences,
    doctorFixedShifts,
    doctorWeekdayPreferences,
    doctors,
    interventionBases,
    scheduledShifts,
} from "@/db/schema";

export type ScheduleShiftLabel = "SD" | "SN";
export type ScheduleDomain = "regulation" | "intervention";

const SAO_PAULO_OFFSET_HOURS = 3;

/** Limites de comando por turno na regulação: 1 CP e 2 COI, sempre. */
export const COMMAND_LIMITS: Record<string, number> = { CP: 1, COI: 2 };

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
    /** true = médico tem turno fixo no dia da semana da data consultada. */
    fixedForWeekday: boolean;
    /** turnos fixos do médico nesse dia da semana (ex.: ["SD"], ["SD","SN"]). */
    fixedShiftLabels: string[];
    /** posição do dia no ranking de dias preferidos (0 = mais preferido; null = sem preferência). */
    weekdayPreferenceRank: number | null;
    /** baseIds em ordem de preferência (vazio = sem preferência). */
    basePreferences: number[];
}

export interface RegulationAssignment {
    shiftId: string;
    doctorId: string;
    doctorName: string;
    roleLabel: string | null;
}

export interface ScheduleTargetEntry {
    domain: "intervention";
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
    /** Regulação por turno, SEM ramal: CP/COI/demais por função. */
    regulation: { [label in ScheduleShiftLabel]: RegulationAssignment[] };
    /** Intervenção mantém a base (ambulância) exata. */
    targets: ScheduleTargetEntry[];
    doctors: ScheduleDoctorEntry[];
}

/**
 * Ordenação do painel de médicos na escala do dia:
 * 1. turno fixo no dia > dia preferido (melhor rank primeiro) > demais;
 * 2. dentro do bloco, antiguidade (admitido há mais tempo primeiro; sem data
 *    vai pro fim); 3. nome.
 */
export function compareScheduleDoctors(left: ScheduleDoctorEntry, right: ScheduleDoctorEntry) {
    if (left.fixedForWeekday !== right.fixedForWeekday) {
        return left.fixedForWeekday ? -1 : 1;
    }

    const leftRank = left.weekdayPreferenceRank ?? Number.POSITIVE_INFINITY;
    const rightRank = right.weekdayPreferenceRank ?? Number.POSITIVE_INFINITY;
    if (leftRank !== rightRank) {
        return leftRank - rightRank;
    }

    if (left.admittedAt !== right.admittedAt) {
        if (!left.admittedAt) return 1;
        if (!right.admittedAt) return -1;
        return left.admittedAt.localeCompare(right.admittedAt);
    }

    return left.fullName.localeCompare(right.fullName, "pt-BR");
}

export async function getScheduleBoard(operationalDate: string): Promise<ScheduleBoard> {
    const db = getDb();
    const weekday = resolveWeekday(operationalDate);

    const [bases, planned, activeDoctors, weekdayPrefs, basePrefs, fixedShifts] = await Promise.all([
        db.select().from(interventionBases).where(eq(interventionBases.isActive, true)).orderBy(asc(interventionBases.sortOrder)),
        db.select().from(scheduledShifts).where(and(
            eq(scheduledShifts.operationalDate, operationalDate),
            eq(scheduledShifts.status, "planned"),
        )),
        db.select().from(doctors).where(eq(doctors.isActive, true)).orderBy(asc(doctors.fullName)),
        db.select().from(doctorWeekdayPreferences).where(eq(doctorWeekdayPreferences.weekday, weekday)),
        db.select().from(doctorBasePreferences).orderBy(asc(doctorBasePreferences.preferenceOrder)),
        db.select().from(doctorFixedShifts).where(eq(doctorFixedShifts.weekday, weekday)).orderBy(asc(doctorFixedShifts.shiftLabel)),
    ]);

    const doctorNames = new Map(activeDoctors.map((doctor) => [doctor.id, doctor.displayName ?? doctor.fullName]));
    const weekdayRankByDoctor = new Map(weekdayPrefs.map((pref) => [pref.doctorId, pref.preferenceOrder]));
    const fixedLabelsByDoctor = new Map<string, string[]>();
    for (const fixed of fixedShifts) {
        const list = fixedLabelsByDoctor.get(fixed.doctorId) ?? [];
        list.push(fixed.shiftLabel);
        fixedLabelsByDoctor.set(fixed.doctorId, list);
    }
    const basePrefsByDoctor = new Map<string, number[]>();
    for (const pref of basePrefs) {
        const list = basePrefsByDoctor.get(pref.doctorId) ?? [];
        list.push(pref.baseId);
        basePrefsByDoctor.set(pref.doctorId, list);
    }

    const targets: ScheduleTargetEntry[] = bases.map((base) => ({
        domain: "intervention" as const,
        targetId: base.id,
        code: base.code,
        label: base.label,
        scheduled: {},
    }));
    const targetIndex = new Map(targets.map((target) => [target.targetId, target]));

    const regulation: ScheduleBoard["regulation"] = { SD: [], SN: [] };
    const commandOrder = (role: string | null) => role === "CP" ? 0 : role === "COI" ? 1 : 2;

    for (const shift of planned) {
        const label = shift.shiftLabel as ScheduleShiftLabel;
        if (label !== "SD" && label !== "SN") {
            continue;
        }

        if (shift.domain === "regulation") {
            regulation[label].push({
                shiftId: shift.id,
                doctorId: shift.doctorId,
                doctorName: doctorNames.get(shift.doctorId) ?? "?",
                roleLabel: shift.roleLabel,
            });
            continue;
        }

        const target = shift.baseId != null ? targetIndex.get(shift.baseId) : undefined;
        if (target) {
            target.scheduled[label] = {
                shiftId: shift.id,
                doctorId: shift.doctorId,
                doctorName: doctorNames.get(shift.doctorId) ?? "?",
                roleLabel: shift.roleLabel,
            };
        }
    }

    for (const label of ["SD", "SN"] as const) {
        regulation[label].sort((left, right) => {
            const orderDiff = commandOrder(left.roleLabel) - commandOrder(right.roleLabel);
            if (orderDiff !== 0) return orderDiff;
            return left.doctorName.localeCompare(right.doctorName, "pt-BR");
        });
    }

    const doctorEntries: ScheduleDoctorEntry[] = activeDoctors
        .map((doctor) => ({
            id: doctor.id,
            fullName: doctor.fullName,
            displayName: doctor.displayName,
            admittedAt: doctor.admittedAt,
            eligibleRegulation: doctor.eligibleRegulation,
            eligibleIntervention: doctor.eligibleIntervention,
            fixedForWeekday: fixedLabelsByDoctor.has(doctor.id),
            fixedShiftLabels: fixedLabelsByDoctor.get(doctor.id) ?? [],
            weekdayPreferenceRank: weekdayRankByDoctor.get(doctor.id) ?? null,
            basePreferences: basePrefsByDoctor.get(doctor.id) ?? [],
        }))
        .sort(compareScheduleDoctors);

    return { operationalDate, weekday, regulation, targets, doctors: doctorEntries };
}

export async function createScheduledShift(params: {
    domain: ScheduleDomain;
    /** Obrigatório na intervenção (base exata); regulação não tem alvo. */
    targetId?: number | null;
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
    if (params.domain === "intervention" && params.targetId == null) {
        throw new Error("Intervenção exige a base (ambulância).");
    }

    const dayShifts = await db.select().from(scheduledShifts).where(and(
        eq(scheduledShifts.operationalDate, params.operationalDate),
        eq(scheduledShifts.shiftLabel, params.shiftLabel),
        eq(scheduledShifts.status, "planned"),
    ));

    if (dayShifts.some((shift) => shift.doctorId === params.doctorId)) {
        throw new Error(`${doctor.fullName} já está escalado(a) neste dia/turno.`);
    }

    const role = params.domain === "regulation" ? (params.roleLabel ?? "RMT").toUpperCase() : null;
    if (role && COMMAND_LIMITS[role] != null) {
        const current = dayShifts.filter((shift) =>
            shift.domain === "regulation" && (shift.roleLabel ?? "").toUpperCase() === role).length;
        if (current >= COMMAND_LIMITS[role]) {
            throw new Error(`Turno já tem ${COMMAND_LIMITS[role]} ${role} — o limite do serviço.`);
        }
    }

    const window = resolveScheduledWindow(params.operationalDate, params.shiftLabel);
    const [created] = await db.insert(scheduledShifts).values({
        domain: params.domain,
        postId: null,
        baseId: params.domain === "intervention" ? params.targetId : null,
        doctorId: params.doctorId,
        operationalDate: params.operationalDate,
        shiftLabel: params.shiftLabel,
        scheduledStartAt: window.scheduledStartAt,
        scheduledEndAt: window.scheduledEndAt,
        roleLabel: role,
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

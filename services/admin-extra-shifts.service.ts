import { and, asc, between, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { adminExtraShifts, doctors } from "@/db/schema";

export interface AdminExtraShiftRow {
    id: string;
    doctorId: string;
    doctorName: string;
    displayName: string | null;
    operationalDate: string;
    shiftLabel: "SD" | "SN";
    label: string | null;
    /** 'extra' (verde manual) | 'bonus' (verde do banco) | 'penalty' (vermelho). */
    kind: string;
    /** +1 para verdes, -1 para o vermelho (punição do banco de horas). */
    unit: number;
    createdAt: string;
}

function normalizeShiftLabel(value: string): "SD" | "SN" {
    const normalized = value.trim().toUpperCase();
    if (normalized !== "SD" && normalized !== "SN") {
        throw new Error("Turno invalido para plantao extra (use SD ou SN).");
    }
    return normalized;
}

function normalizeOperationalDate(value: string): string {
    const date = value.trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        throw new Error("Data invalida para plantao extra.");
    }
    return date;
}

/**
 * Cria um plantão extra arbitrário para um médico — sem amarrar a ramal/base.
 * Aparece em verde no board do payment-closing e conta para o valor a pagar.
 */
export async function createAdminExtraShift(params: {
    doctorId: string;
    operationalDate: string;
    shiftLabel: string;
    label: string | null;
    actorUserId: string;
}): Promise<AdminExtraShiftRow> {
    const operationalDate = normalizeOperationalDate(params.operationalDate);
    const shiftLabel = normalizeShiftLabel(params.shiftLabel);
    const label = params.label?.trim() ?? "";
    if (label.length < 2) {
        throw new Error("Descreva o plantão extra com pelo menos 2 caracteres.");
    }
    const normalizedLabel = label.slice(0, 40);

    const db = getDb();
    const doctor = await db
        .select({ id: doctors.id, fullName: doctors.fullName, displayName: doctors.displayName })
        .from(doctors)
        .where(eq(doctors.id, params.doctorId))
        .limit(1);

    if (doctor.length === 0) {
        throw new Error("Medico nao encontrado para o plantao extra.");
    }

    const inserted = await db
        .insert(adminExtraShifts)
        .values({
            doctorId: params.doctorId,
            operationalDate,
            shiftLabel,
            label: normalizedLabel,
            createdByUserId: params.actorUserId,
        })
        .returning({
            id: adminExtraShifts.id,
            createdAt: adminExtraShifts.createdAt,
        });

    const row = inserted[0];
    return {
        id: row.id,
        doctorId: params.doctorId,
        doctorName: doctor[0].fullName,
        displayName: doctor[0].displayName,
        operationalDate,
        shiftLabel,
        label: normalizedLabel,
        kind: "extra",
        unit: 1,
        createdAt: row.createdAt.toISOString(),
    };
}

/** Remove um plantão extra criado pelo admin. */
export async function removeAdminExtraShift(params: { id: string }): Promise<{ removed: boolean }> {
    const db = getDb();
    const deleted = await db
        .delete(adminExtraShifts)
        .where(eq(adminExtraShifts.id, params.id))
        .returning({ id: adminExtraShifts.id });

    return { removed: deleted.length > 0 };
}

/**
 * Carrega os plantões extra cujo dia operacional cai no intervalo [startDate, endDate]
 * (datas YYYY-MM-DD inclusivas). Usado pelo board do payment-closing para mesclar os
 * extras como PayableShift verdes.
 */
export async function loadAdminExtraShiftsForRange(
    startDate: string,
    endDate: string,
): Promise<AdminExtraShiftRow[]> {
    const db = getDb();
    const rows = await db
        .select({
            id: adminExtraShifts.id,
            doctorId: adminExtraShifts.doctorId,
            doctorName: doctors.fullName,
            displayName: doctors.displayName,
            operationalDate: adminExtraShifts.operationalDate,
            shiftLabel: adminExtraShifts.shiftLabel,
            label: adminExtraShifts.label,
            kind: adminExtraShifts.kind,
            unit: adminExtraShifts.unit,
            createdAt: adminExtraShifts.createdAt,
        })
        .from(adminExtraShifts)
        .innerJoin(doctors, eq(doctors.id, adminExtraShifts.doctorId))
        .where(and(between(adminExtraShifts.operationalDate, startDate, endDate)))
        .orderBy(asc(adminExtraShifts.operationalDate));

    return rows.map((row) => ({
        id: row.id,
        doctorId: row.doctorId,
        doctorName: row.doctorName,
        displayName: row.displayName,
        operationalDate: row.operationalDate,
        shiftLabel: row.shiftLabel === "SN" ? "SN" : "SD",
        label: row.label,
        kind: row.kind,
        unit: row.unit,
        createdAt: row.createdAt.toISOString(),
    }));
}

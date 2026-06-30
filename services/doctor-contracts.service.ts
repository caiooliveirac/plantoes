import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { doctorContracts } from "@/db/schema";

export interface DoctorContractRow {
    doctorId: string;
    /** Teto do contrato em reais. */
    ceilingBrl: number;
    /** Mês (YYYY-MM) a partir do qual os pagamentos passam a consumir o teto. */
    seedMonth: string;
}

/** Mês válido no formato YYYY-MM. */
function normalizeMonthKey(value: string): string {
    const trimmed = value.trim();
    if (!/^\d{4}-\d{2}$/.test(trimmed)) {
        throw new Error("Mês inválido para o contrato (use AAAA-MM).");
    }
    return trimmed;
}

/** Sementes de contrato de todos os médicos que já têm teto cadastrado. */
export async function loadDoctorContracts(): Promise<Map<string, DoctorContractRow>> {
    const db = getDb();
    const rows = await db
        .select({
            doctorId: doctorContracts.doctorId,
            ceilingBrl: doctorContracts.ceilingBrl,
            seedMonth: doctorContracts.seedMonth,
        })
        .from(doctorContracts);

    return new Map(rows.map((row) => [
        row.doctorId,
        {
            doctorId: row.doctorId,
            ceilingBrl: Number(row.ceilingBrl),
            seedMonth: row.seedMonth,
        },
    ]));
}

/**
 * Grava (ou corrige) a semente do contrato de um médico: teto em R$ e mês inicial.
 * A UI só oferece o campo editável quando ainda não há semente — depois disso o
 * saldo contratual é apenas cálculo.
 */
export async function setDoctorContract(params: {
    doctorId: string;
    ceilingBrl: number;
    seedMonth: string;
    actorUserId: string;
}): Promise<DoctorContractRow> {
    if (!Number.isFinite(params.ceilingBrl) || params.ceilingBrl <= 0) {
        throw new Error("Informe um teto de contrato em reais maior que zero.");
    }
    const seedMonth = normalizeMonthKey(params.seedMonth);
    const ceiling = Number(params.ceilingBrl.toFixed(2));

    const db = getDb();
    const [saved] = await db
        .insert(doctorContracts)
        .values({
            doctorId: params.doctorId,
            ceilingBrl: ceiling.toFixed(2),
            seedMonth,
            createdByUserId: params.actorUserId,
            updatedAt: new Date(),
        })
        .onConflictDoUpdate({
            target: doctorContracts.doctorId,
            set: {
                ceilingBrl: ceiling.toFixed(2),
                seedMonth,
                updatedAt: new Date(),
            },
        })
        .returning({
            doctorId: doctorContracts.doctorId,
            ceilingBrl: doctorContracts.ceilingBrl,
            seedMonth: doctorContracts.seedMonth,
        });

    return {
        doctorId: saved.doctorId,
        ceilingBrl: Number(saved.ceilingBrl),
        seedMonth: saved.seedMonth,
    };
}

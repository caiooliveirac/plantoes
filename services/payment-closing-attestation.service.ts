import { and, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { paymentClosingAttestations } from "@/db/schema";

const MONTH_KEY_PATTERN = /^\d{4}-\d{2}$/;

function normalizeMonthKey(value: string): string {
    const monthKey = value.trim();
    if (!MONTH_KEY_PATTERN.test(monthKey)) {
        throw new Error("Mês inválido para atestação (use AAAA-MM).");
    }
    return monthKey;
}

/** Marca que o admin conferiu/assinou a produtividade do médico naquele mês. */
export async function setDoctorMonthAttestation(params: {
    doctorId: string;
    monthKey: string;
    attested: boolean;
    actorUserId: string;
}): Promise<{ attestedAt: string | null }> {
    const monthKey = normalizeMonthKey(params.monthKey);
    const db = getDb();

    if (!params.attested) {
        await db
            .delete(paymentClosingAttestations)
            .where(and(
                eq(paymentClosingAttestations.doctorId, params.doctorId),
                eq(paymentClosingAttestations.monthKey, monthKey),
            ));
        return { attestedAt: null };
    }

    const inserted = await db
        .insert(paymentClosingAttestations)
        .values({
            doctorId: params.doctorId,
            monthKey,
            attestedByUserId: params.actorUserId,
        })
        .onConflictDoUpdate({
            target: [paymentClosingAttestations.doctorId, paymentClosingAttestations.monthKey],
            set: {
                attestedByUserId: params.actorUserId,
                attestedAt: new Date(),
            },
        })
        .returning({ attestedAt: paymentClosingAttestations.attestedAt });

    return { attestedAt: inserted[0]?.attestedAt.toISOString() ?? null };
}

/** doctorId -> attestedAt ISO, para todas as atestações de um mês. */
export async function loadDoctorAttestationsForMonth(monthKey: string): Promise<Record<string, string>> {
    const normalized = normalizeMonthKey(monthKey);
    const db = getDb();
    const rows = await db
        .select({
            doctorId: paymentClosingAttestations.doctorId,
            attestedAt: paymentClosingAttestations.attestedAt,
        })
        .from(paymentClosingAttestations)
        .where(eq(paymentClosingAttestations.monthKey, normalized));

    const map: Record<string, string> = {};
    for (const row of rows) {
        map[row.doctorId] = row.attestedAt.toISOString();
    }
    return map;
}

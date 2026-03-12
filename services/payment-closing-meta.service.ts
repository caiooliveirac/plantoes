import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { paymentClosingMeta } from "@/db/schema";

export interface PaymentClosingMetaRow {
    doctorId: string;
    invoiceNumber: string | null;
    paymentProcessNumber: string | null;
    updatedAt: string | null;
}

function normalizeField(value: string | null | undefined): string | null {
    const trimmed = value?.trim() ?? "";
    if (trimmed.length === 0) {
        return null;
    }
    return trimmed.slice(0, 60);
}

/** Nota fiscal + nº do processo de pagamento de cada médico no mês. */
export async function loadPaymentClosingMetaForMonth(
    monthKey: string,
): Promise<Map<string, PaymentClosingMetaRow>> {
    const db = getDb();
    const rows = await db
        .select({
            doctorId: paymentClosingMeta.doctorId,
            invoiceNumber: paymentClosingMeta.invoiceNumber,
            paymentProcessNumber: paymentClosingMeta.paymentProcessNumber,
            updatedAt: paymentClosingMeta.updatedAt,
        })
        .from(paymentClosingMeta)
        .where(eq(paymentClosingMeta.monthKey, monthKey));

    return new Map(rows.map((row) => [
        row.doctorId,
        {
            doctorId: row.doctorId,
            invoiceNumber: row.invoiceNumber,
            paymentProcessNumber: row.paymentProcessNumber,
            updatedAt: row.updatedAt ? row.updatedAt.toISOString() : null,
        },
    ]));
}

/** Upsert da nota fiscal / processo de pagamento (uma linha por médico+mês). */
export async function setPaymentClosingMeta(params: {
    doctorId: string;
    monthKey: string;
    invoiceNumber: string | null;
    paymentProcessNumber: string | null;
    actorUserId: string;
}): Promise<PaymentClosingMetaRow> {
    const invoiceNumber = normalizeField(params.invoiceNumber);
    const paymentProcessNumber = normalizeField(params.paymentProcessNumber);

    const db = getDb();
    const [saved] = await db
        .insert(paymentClosingMeta)
        .values({
            doctorId: params.doctorId,
            monthKey: params.monthKey,
            invoiceNumber,
            paymentProcessNumber,
            updatedByUserId: params.actorUserId,
            updatedAt: new Date(),
        })
        .onConflictDoUpdate({
            target: [paymentClosingMeta.doctorId, paymentClosingMeta.monthKey],
            set: {
                invoiceNumber,
                paymentProcessNumber,
                updatedByUserId: params.actorUserId,
                updatedAt: new Date(),
            },
        })
        .returning({
            doctorId: paymentClosingMeta.doctorId,
            invoiceNumber: paymentClosingMeta.invoiceNumber,
            paymentProcessNumber: paymentClosingMeta.paymentProcessNumber,
            updatedAt: paymentClosingMeta.updatedAt,
        });

    return {
        doctorId: saved.doctorId,
        invoiceNumber: saved.invoiceNumber,
        paymentProcessNumber: saved.paymentProcessNumber,
        updatedAt: saved.updatedAt ? saved.updatedAt.toISOString() : null,
    };
}

/**
 * O campo em branco da tela: o coordenador informa o saldo de abertura.
 *
 * Existe porque o backfill de maio deixou 15 contratos sem número confiável
 * (renovação que a planilha não aplicou, teto nunca carregado, célula ilegível)
 * e 65 médicos ativos sem contrato nenhum. Chutar um valor ali seria pior que
 * deixar vazio — ver docs/saldo-contrato/backfill-report.md.
 */
import { NextRequest, NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getDb, hasDatabaseUrl } from "@/db";
import { auditLogs } from "@/db/schema";
import { AuthError, requireAuthenticatedSession } from "@/lib/auth/server";
import { recordOpeningBalance } from "@/services/contract-ledger.service";

const payloadSchema = z.object({
    /** Pode ser negativo: há contrato que entra no sistema já estourado. */
    balanceBrl: z.number().finite(),
    /** Competência do saldo informado. Default: hoje. */
    entryDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
    if (!hasDatabaseUrl()) {
        return NextResponse.json({ error: "DATABASE_URL is not configured for operations-v2." }, { status: 503 });
    }

    let session;
    try {
        session = await requireAuthenticatedSession(["admin"]);
    } catch (error) {
        const status = error instanceof AuthError ? error.status : 500;
        return NextResponse.json({ error: error instanceof Error ? error.message : "Unauthorized." }, { status });
    }

    const { id } = await context.params;
    const parsed = payloadSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
        return NextResponse.json({ error: "Informe o saldo de abertura em reais." }, { status: 400 });
    }

    const entryDate = parsed.data.entryDate ?? new Date().toISOString().slice(0, 10);
    try {
        await recordOpeningBalance({
            contractId: id,
            balanceCents: Math.round(parsed.data.balanceBrl * 100),
            entryDate,
            actorUserId: session.user.id,
        });

        await getDb().insert(auditLogs).values({
            actorUserId: session.user.id,
            action: "contract.opening_balance",
            entityType: "contract",
            entityId: id,
            details: { balanceBrl: parsed.data.balanceBrl, entryDate },
        });

        revalidatePath("/admin/payment-closing");
        return NextResponse.json({ contractId: id, entryDate });
    } catch (error) {
        return NextResponse.json(
            { error: error instanceof Error ? error.message : "Não foi possível gravar o saldo de abertura." },
            { status: 400 },
        );
    }
}

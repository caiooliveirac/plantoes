/**
 * Antes/depois de um fechamento que ainda não foi confirmado. NÃO PERSISTE NADA.
 *
 * A UI do fechamento prefere chamar o módulo puro no cliente (recálculo a cada
 * plantão marcado, sem round-trip). Esta rota existe para quem não pode fazer
 * isso — conferência do servidor, teste de integração, chamada de fora da tela.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { hasDatabaseUrl } from "@/db";
import { AuthError, requireAuthenticatedSession } from "@/lib/auth/server";
import { simulateClosing } from "@/lib/contracts/balance-metrics";
import { loadContractBalances } from "@/services/contract-balance.service";

const payloadSchema = z.object({
    amountBrl: z.number().finite().nonnegative(),
    weekdayShifts: z.number().finite().min(0).default(0),
    weekendShifts: z.number().finite().min(0).default(0),
    asOf: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
    if (!hasDatabaseUrl()) {
        return NextResponse.json({ error: "DATABASE_URL is not configured for operations-v2." }, { status: 503 });
    }

    try {
        await requireAuthenticatedSession(["admin", "payment_closing_limited"]);
    } catch (error) {
        const status = error instanceof AuthError ? error.status : 500;
        return NextResponse.json({ error: error instanceof Error ? error.message : "Unauthorized." }, { status });
    }

    const { id } = await context.params;
    const parsed = payloadSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
        return NextResponse.json({ error: "Payload inválido para simulação." }, { status: 400 });
    }

    const asOf = parsed.data.asOf ? new Date(`${parsed.data.asOf}T12:00:00Z`) : new Date();
    const { rows, computedAt } = await loadContractBalances({ asOf });
    const contract = rows.find((row) => row.contractId === id);
    if (!contract) {
        return NextResponse.json({ error: "Contrato não encontrado ou inativo." }, { status: 404 });
    }

    const { before, after } = simulateClosing(
        contract.metricsInput,
        {
            amountCents: Math.round(parsed.data.amountBrl * 100),
            weekdayShifts: parsed.data.weekdayShifts,
            weekendShifts: parsed.data.weekendShifts,
        },
    );

    return NextResponse.json({
        contractId: id,
        before,
        after,
        asOf: asOf.toISOString(),
        computedAt: computedAt.toISOString(),
    });
}

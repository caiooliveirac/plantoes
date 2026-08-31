/**
 * Ajuste manual no razão: glosa, acerto, dobra de plantão, correção que não vem
 * de um fechamento. Justificativa é obrigatória — sem ela o histórico do
 * contrato vira uma lista de números sem dono.
 */
import { NextRequest, NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getDb, hasDatabaseUrl } from "@/db";
import { auditLogs } from "@/db/schema";
import { AuthError, requireAuthenticatedSession } from "@/lib/auth/server";
import { recordBalanceAnchor, recordManualAdjustment } from "@/services/contract-ledger.service";

// Dois modos. Delta: o admin sabe o valor do ajuste (glosa, dobra). Âncora: o
// admin sabe o SALDO que valia no início de uma data ("em 01/05 era R$ X") e o
// servidor calcula o delta contra o razão — nunca confiar num delta vindo do
// cliente para este caso, o razão pode ter mudado entre a leitura e o clique.
const payloadSchema = z.union([
    z.object({
        mode: z.literal("anchor"),
        targetBalanceBrl: z.number().finite(),
        /**
         * Só dia 1º: o saldo do contrato é conferido por mês (planilha, extrato,
         * fechamento) e âncora no meio do mês pegava um mês partido pela metade —
         * o consumo do mês inteiro está lançado no último dia.
         */
        anchorDate: z.string().regex(/^\d{4}-\d{2}-01$/, "A correção de saldo só vale para o dia 1º de um mês."),
        description: z.string().trim().min(5, "Descreva o motivo da correção."),
    }),
    z.object({
        mode: z.literal("delta").optional(),
        /** Positivo credita saldo, negativo consome. Zero é recusado. */
        amountBrl: z.number().finite().refine((value) => value !== 0, "O ajuste não pode ser zero."),
        description: z.string().trim().min(5, "Descreva o motivo do ajuste."),
        entryDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    }),
]);

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
        return NextResponse.json(
            { error: parsed.error.issues[0]?.message ?? "Ajuste inválido." },
            { status: 400 },
        );
    }

    try {
        if (parsed.data.mode === "anchor") {
            const { targetBalanceBrl, anchorDate, description } = parsed.data;
            const result = await recordBalanceAnchor({
                contractId: id,
                targetBalanceCents: Math.round(targetBalanceBrl * 100),
                anchorDate,
                description,
                actorUserId: session.user.id,
            });

            await getDb().insert(auditLogs).values({
                actorUserId: session.user.id,
                action: "contract.balance_anchor",
                entityType: "contract",
                entityId: id,
                details: {
                    targetBalanceBrl,
                    anchorDate,
                    description,
                    deltaBrl: result.deltaCents / 100,
                    balanceBeforeBrl: result.balanceBeforeCents / 100,
                },
            });

            revalidatePath("/admin/payment-closing");
            return NextResponse.json({ contractId: id, anchorDate, deltaBrl: result.deltaCents / 100 });
        }

        const entryDate = parsed.data.entryDate ?? new Date().toISOString().slice(0, 10);
        await recordManualAdjustment({
            contractId: id,
            amountCents: Math.round(parsed.data.amountBrl * 100),
            entryDate,
            description: parsed.data.description,
            actorUserId: session.user.id,
        });

        await getDb().insert(auditLogs).values({
            actorUserId: session.user.id,
            action: "contract.manual_adjustment",
            entityType: "contract",
            entityId: id,
            details: { amountBrl: parsed.data.amountBrl, entryDate, description: parsed.data.description },
        });

        revalidatePath("/admin/payment-closing");
        return NextResponse.json({ contractId: id, entryDate });
    } catch (error) {
        return NextResponse.json(
            { error: error instanceof Error ? error.message : "Não foi possível lançar o ajuste." },
            { status: 400 },
        );
    }
}

/**
 * Renovação de contrato confirmada pelo admin.
 *
 * O modelo do schema (migration 0038): renovar = criar OUTRO registro de
 * contrato, com o antigo terminado e apontando superseded_by para o novo, e um
 * 'opening' com o saldo que a coordenação definiu. Esta rota é o botão que faz
 * as três coisas numa transação — antes dela a renovação só existia como
 * procedimento manual no banco, e contratos com ciclo vencido continuavam
 * "ativos" recebendo a cara do mês novo na tela.
 *
 * O saldo de abertura vem do corpo: a tela sugere o teto do ciclo anterior
 * (única coisa que o passado permite inferir) e o admin confirma ou corrige.
 */
import { NextRequest, NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { getDb, hasDatabaseUrl } from "@/db";
import { auditLogs, contracts } from "@/db/schema";
import { AuthError, requireAuthenticatedSession } from "@/lib/auth/server";
import { recordOpeningBalance } from "@/services/contract-ledger.service";

const payloadSchema = z.object({
    /** Saldo do novo ciclo em reais. Pode ser negativo (estouro herdado). */
    openingBalanceBrl: z.number().finite(),
    /** Fim do novo ciclo (exclusivo). Default: início + 1 ano. */
    cycleEnd: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    /** Teto do novo ciclo. Default: o teto do ciclo anterior. */
    ceilingBrl: z.number().positive().nullable().optional(),
});

/** Soma um ano a uma data AAAA-MM-DD, sem passar por fuso. */
function plusOneYear(dateIso: string): string {
    const [year, rest] = [dateIso.slice(0, 4), dateIso.slice(4)];
    return `${Number(year) + 1}${rest}`;
}

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
        return NextResponse.json({ error: "Informe o saldo do novo ciclo em reais." }, { status: 400 });
    }
    const data = parsed.data;

    try {
        const db = getDb();
        const [old] = await db.select().from(contracts).where(eq(contracts.id, id)).limit(1);
        if (!old) {
            return NextResponse.json({ error: "Contrato não encontrado." }, { status: 404 });
        }
        if (old.status !== "active") {
            return NextResponse.json({ error: "Só contrato ativo pode ser renovado." }, { status: 400 });
        }
        if (old.supersededByContractId) {
            return NextResponse.json({ error: "Este contrato já foi renovado." }, { status: 400 });
        }

        const newCycleStart = old.cycleEnd;
        const newCycleEnd = data.cycleEnd ?? plusOneYear(newCycleStart);
        if (newCycleEnd <= newCycleStart) {
            return NextResponse.json({ error: "O fim do novo ciclo tem que ser depois do início." }, { status: 400 });
        }

        const newContractId = await db.transaction(async (tx) => {
            // O antigo sai de cena PRIMEIRO: o índice único (médico, nº) só vale
            // para status 'active', e o novo nasce com o mesmo número.
            await tx.update(contracts)
                .set({ status: "terminated", endedAt: old.cycleEnd, updatedAt: new Date() })
                .where(eq(contracts.id, old.id));

            const [created] = await tx.insert(contracts).values({
                doctorId: old.doctorId,
                contractNumber: old.contractNumber,
                companyName: old.companyName,
                companyTaxId: old.companyTaxId,
                category: old.category,
                weeklyHours: old.weeklyHours,
                ceilingAmount: data.ceilingBrl !== undefined
                    ? (data.ceilingBrl === null ? null : data.ceilingBrl.toFixed(2))
                    : old.ceilingAmount,
                cycleStart: newCycleStart,
                cycleEnd: newCycleEnd,
                startedAt: newCycleStart,
                notes: old.notes,
                createdByUserId: session.user.id,
            }).returning({ id: contracts.id });

            await tx.update(contracts)
                .set({ supersededByContractId: created.id, updatedAt: new Date() })
                .where(eq(contracts.id, old.id));

            await recordOpeningBalance({
                contractId: created.id,
                balanceCents: Math.round(data.openingBalanceBrl * 100),
                entryDate: newCycleStart,
                actorUserId: session.user.id,
                tx,
            });
            return created.id;
        });

        await getDb().insert(auditLogs).values({
            actorUserId: session.user.id,
            action: "contract.renew",
            entityType: "contract",
            entityId: newContractId,
            details: {
                previousContractId: old.id,
                cycleStart: newCycleStart,
                cycleEnd: newCycleEnd,
                openingBalanceBrl: data.openingBalanceBrl,
            },
        });

        revalidatePath("/admin/payment-closing");
        return NextResponse.json({ contractId: newContractId, cycleStart: newCycleStart, cycleEnd: newCycleEnd }, { status: 201 });
    } catch (error) {
        return NextResponse.json(
            { error: error instanceof Error ? error.message : "Não foi possível renovar o contrato." },
            { status: 400 },
        );
    }
}

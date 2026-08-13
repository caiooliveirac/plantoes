/**
 * Redefinição do contrato: o admin informa o teto (R$) e o mês em que ele
 * passou a valer, e o sistema reconstrói o acompanhamento a partir daí.
 *
 * Existe porque a carga da planilha errou para alguns médicos (teto trocado,
 * ciclo errado, abertura torta) e o alerta de fim de contrato dispara em cima
 * de dado ruim. Também cobre troca de contrato / renovação antecipada: o mês
 * informado vira o início do ciclo novo.
 *
 * O modelo é o mesmo da renovação (renew/route.ts): o contrato antigo é
 * terminado e um novo nasce com ciclo [mês, mês+1 ano) e abertura igual ao
 * teto. A diferença: consumo já lançado no razão para meses >= mês informado é
 * TRANSFERIDO para o contrato novo (estorno no antigo + relançamento no novo,
 * append-only), senão esses meses ficariam marcados como "settled" num contrato
 * terminado e nunca descontariam do saldo novo. Meses ainda não lançados são
 * apurados ao vivo pelo read model, como sempre.
 */
import { NextRequest, NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { eq, and, like } from "drizzle-orm";
import { z } from "zod";
import { getDb, hasDatabaseUrl } from "@/db";
import { auditLogs, contractLedger, contracts } from "@/db/schema";
import { AuthError, requireAuthenticatedSession } from "@/lib/auth/server";
import { planClosingTransfers } from "@/lib/contracts/redefinition";
import { CLOSING_SOURCE_TYPE, recordOpeningBalance } from "@/services/contract-ledger.service";

const payloadSchema = z.object({
    /** Teto do contrato em reais. */
    ceilingBrl: z.number().finite().positive(),
    /** Mês (AAAA-MM) a partir do qual o teto vale — vira o início do ciclo. */
    startMonth: z.string().regex(/^\d{4}-\d{2}$/),
});

/** Soma um ano a uma data AAAA-MM-DD, sem passar por fuso. */
function plusOneYear(dateIso: string): string {
    return `${Number(dateIso.slice(0, 4)) + 1}${dateIso.slice(4)}`;
}

/** Último dia do mês AAAA-MM, para a competência do lançamento. */
function monthLastDay(monthKey: string): string {
    const [year, month] = monthKey.split("-").map(Number);
    return new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
}

function centsToNumeric(cents: number): string {
    return (cents / 100).toFixed(2);
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
        return NextResponse.json({ error: "Informe o teto (R$) e o mês inicial (AAAA-MM)." }, { status: 400 });
    }
    const { ceilingBrl, startMonth } = parsed.data;
    const ceilingCents = Math.round(ceilingBrl * 100);
    const newCycleStart = `${startMonth}-01`;
    const newCycleEnd = plusOneYear(newCycleStart);

    try {
        const db = getDb();
        const [old] = await db.select().from(contracts).where(eq(contracts.id, id)).limit(1);
        if (!old) {
            return NextResponse.json({ error: "Contrato não encontrado." }, { status: 404 });
        }
        if (old.status !== "active") {
            return NextResponse.json({ error: "Só contrato ativo pode ser redefinido." }, { status: 400 });
        }
        if (old.supersededByContractId) {
            return NextResponse.json({ error: "Este contrato já foi substituído." }, { status: 400 });
        }

        // Mês informado é o mesmo em que o contrato atual já começou: não é uma
        // redefinição de ciclo, é só o teto que veio errado (ex.: preset trocado
        // no cadastro). Terminar+criar bateria em contracts_window_ordered
        // (ended_at > started_at é estrito) porque ended_at cairia igual a
        // started_at. Corrige o teto no lugar, sem mexer no razão.
        if (newCycleStart === old.startedAt) {
            await db.update(contracts)
                .set({ ceilingAmount: ceilingBrl.toFixed(2), updatedAt: new Date() })
                .where(eq(contracts.id, old.id));
            await db.insert(auditLogs).values({
                actorUserId: session.user.id,
                action: "contract.ceiling_correction",
                entityType: "contract",
                entityId: old.id,
                details: { previousCeilingAmount: old.ceilingAmount, ceilingBrl, startMonth },
            });
            revalidatePath("/admin/payment-closing");
            return NextResponse.json(
                { contractId: old.id, cycleStart: old.cycleStart, cycleEnd: old.cycleEnd },
                { status: 200 },
            );
        }
        if (newCycleStart < old.startedAt) {
            return NextResponse.json(
                { error: "O mês informado é anterior ao início do contrato atual." },
                { status: 400 },
            );
        }

        const newContractId = await db.transaction(async (tx) => {
            // O antigo sai de cena PRIMEIRO: o índice único (médico, nº) só vale
            // para status 'active', e o novo nasce com o mesmo número.
            await tx.update(contracts)
                .set({ status: "terminated", endedAt: newCycleStart, updatedAt: new Date() })
                .where(eq(contracts.id, old.id));

            const [created] = await tx.insert(contracts).values({
                doctorId: old.doctorId,
                contractNumber: old.contractNumber,
                companyName: old.companyName,
                companyTaxId: old.companyTaxId,
                category: old.category,
                weeklyHours: old.weeklyHours,
                ceilingAmount: ceilingBrl.toFixed(2),
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
                balanceCents: ceilingCents,
                entryDate: newCycleStart,
                actorUserId: session.user.id,
                tx,
            });

            // Transferência do consumo já lançado: os fechamentos vivos de meses
            // do ciclo novo saem do razão do contrato antigo (estorno) e entram
            // no novo (relançamento). A revisão continua da MAIOR já usada pela
            // origem em qualquer contrato — o índice único é global.
            const rows = await tx
                .select({
                    contractId: contractLedger.contractId,
                    sourceKey: contractLedger.sourceKey,
                    amount: contractLedger.amount,
                    weekdayShifts: contractLedger.weekdayShifts,
                    weekendShifts: contractLedger.weekendShifts,
                    revision: contractLedger.sourceRevision,
                })
                .from(contractLedger)
                .where(and(
                    eq(contractLedger.sourceType, CLOSING_SOURCE_TYPE),
                    like(contractLedger.sourceKey, `${old.doctorId}|%`),
                ));

            const transfers = planClosingTransfers({
                rows: rows.map((row) => ({
                    contractId: row.contractId,
                    sourceKey: row.sourceKey,
                    amountCents: Math.round(Number(row.amount) * 100),
                    weekdayShifts: Number(row.weekdayShifts),
                    weekendShifts: Number(row.weekendShifts),
                    sourceRevision: row.revision,
                })),
                oldContractId: old.id,
                newCycleStart,
                newCycleEnd,
            });

            for (const transfer of transfers) {
                const entryDate = monthLastDay(transfer.monthKey);
                await tx.insert(contractLedger).values({
                    contractId: old.id,
                    entryDate,
                    type: "invoice_reversal",
                    amount: centsToNumeric(-transfer.netCents),
                    weekdayShifts: (-transfer.weekdayShifts).toFixed(1),
                    weekendShifts: (-transfer.weekendShifts).toFixed(1),
                    sourceType: CLOSING_SOURCE_TYPE,
                    sourceKey: transfer.sourceKey,
                    sourceRevision: transfer.reversalRevision,
                    description: `Contrato redefinido — consumo de ${transfer.monthKey} transferido para o contrato novo`,
                    createdByUserId: session.user.id,
                });
                await tx.insert(contractLedger).values({
                    contractId: created.id,
                    entryDate,
                    type: "invoice",
                    amount: centsToNumeric(transfer.netCents),
                    weekdayShifts: transfer.weekdayShifts.toFixed(1),
                    weekendShifts: transfer.weekendShifts.toFixed(1),
                    sourceType: CLOSING_SOURCE_TYPE,
                    sourceKey: transfer.sourceKey,
                    sourceRevision: transfer.invoiceRevision,
                    description: `Fechamento de ${transfer.monthKey} — transferido na redefinição do contrato`,
                    createdByUserId: session.user.id,
                });
            }

            return created.id;
        });

        await getDb().insert(auditLogs).values({
            actorUserId: session.user.id,
            action: "contract.redefine",
            entityType: "contract",
            entityId: newContractId,
            details: {
                previousContractId: old.id,
                ceilingBrl,
                startMonth,
                cycleStart: newCycleStart,
                cycleEnd: newCycleEnd,
            },
        });

        revalidatePath("/admin/payment-closing");
        return NextResponse.json(
            { contractId: newContractId, cycleStart: newCycleStart, cycleEnd: newCycleEnd },
            { status: 201 },
        );
    } catch (error) {
        return NextResponse.json(
            { error: error instanceof Error ? error.message : "Não foi possível redefinir o contrato." },
            { status: 400 },
        );
    }
}

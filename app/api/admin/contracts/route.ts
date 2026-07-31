import { NextRequest, NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getDb, hasDatabaseUrl } from "@/db";
import { auditLogs, contracts } from "@/db/schema";
import { AuthError, requireAuthenticatedSession } from "@/lib/auth/server";
import { loadContractBalances, loadDoctorsWithoutContract } from "@/services/contract-balance.service";
import { recordOpeningBalance } from "@/services/contract-ledger.service";

const createSchema = z.object({
    doctorId: z.string().uuid(),
    contractNumber: z.string().trim().min(1).max(40),
    companyName: z.string().trim().max(255).optional(),
    companyTaxId: z.string().trim().max(20).optional(),
    category: z.enum(["generalista", "especialista", "psiquiatria"]),
    weeklyHours: z.number().positive().max(168).optional(),
    ceilingBrl: z.number().positive().optional(),
    cycleStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    cycleEnd: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    /** Saldo de abertura. Opcional: o contrato pode nascer esperando o número. */
    openingBalanceBrl: z.number().optional(),
    notes: z.string().trim().max(2000).optional(),
});

export async function GET(request: NextRequest) {
    if (!hasDatabaseUrl()) {
        return NextResponse.json({ error: "DATABASE_URL is not configured for operations-v2." }, { status: 503 });
    }

    try {
        // Leitura é liberada para quem já vê o fechamento; escrita, só admin.
        await requireAuthenticatedSession(["admin", "payment_closing_limited"]);
    } catch (error) {
        const status = error instanceof AuthError ? error.status : 500;
        return NextResponse.json({ error: error instanceof Error ? error.message : "Unauthorized." }, { status });
    }

    const asOfParam = request.nextUrl.searchParams.get("asOf");
    const asOf = asOfParam ? new Date(`${asOfParam}T12:00:00Z`) : new Date();
    if (Number.isNaN(asOf.getTime())) {
        return NextResponse.json({ error: "asOf inválido (use AAAA-MM-DD)." }, { status: 400 });
    }

    const doctorId = request.nextUrl.searchParams.get("doctorId") ?? undefined;
    const [balances, withoutContract] = await Promise.all([
        loadContractBalances({ asOf, doctorId }),
        doctorId ? Promise.resolve([]) : loadDoctorsWithoutContract(),
    ]);

    return NextResponse.json({
        contracts: balances.rows,
        doctorsWithoutContract: withoutContract,
        // Sem asOf/computedAt, comparar print com planilha vira discussão.
        asOf: balances.asOf.toISOString(),
        computedAt: balances.computedAt.toISOString(),
    });
}

export async function POST(request: NextRequest) {
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

    const parsed = createSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
        return NextResponse.json({ error: "Dados do contrato inválidos." }, { status: 400 });
    }
    const data = parsed.data;
    if (data.cycleEnd <= data.cycleStart) {
        return NextResponse.json({ error: "O fim do ciclo tem que ser depois do início." }, { status: 400 });
    }

    try {
        const db = getDb();
        const contractId = await db.transaction(async (tx) => {
            const [created] = await tx.insert(contracts).values({
                doctorId: data.doctorId,
                contractNumber: data.contractNumber,
                companyName: data.companyName ?? null,
                companyTaxId: data.companyTaxId ?? null,
                category: data.category,
                weeklyHours: data.weeklyHours === undefined ? null : String(data.weeklyHours),
                ceilingAmount: data.ceilingBrl === undefined ? null : data.ceilingBrl.toFixed(2),
                cycleStart: data.cycleStart,
                cycleEnd: data.cycleEnd,
                startedAt: data.cycleStart,
                notes: data.notes ?? null,
                createdByUserId: session.user.id,
            }).returning({ id: contracts.id });

            if (data.openingBalanceBrl !== undefined) {
                await recordOpeningBalance({
                    contractId: created.id,
                    balanceCents: Math.round(data.openingBalanceBrl * 100),
                    entryDate: data.cycleStart,
                    actorUserId: session.user.id,
                    tx,
                });
            }
            return created.id;
        });

        await getDb().insert(auditLogs).values({
            actorUserId: session.user.id,
            action: "contract.create",
            entityType: "contract",
            entityId: contractId,
            details: { ...data },
        });

        revalidatePath("/admin/payment-closing");
        return NextResponse.json({ contractId }, { status: 201 });
    } catch (error) {
        return NextResponse.json(
            { error: error instanceof Error ? error.message : "Não foi possível criar o contrato." },
            { status: 400 },
        );
    }
}

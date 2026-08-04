import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { getDb, hasDatabaseUrl } from "@/db";
import { auditLogs, interventionOccupancies } from "@/db/schema";
import { AuthError, requireAuthenticatedSession } from "@/lib/auth/server";
import { correctInterventionOccupancy } from "@/modules/operational/corrections";
import { classifyEarlyDeparture, isEarlyDepartureEligible } from "@/modules/operational/early-departure";

const schema = z.object({
    actualEndedAt: z.string().datetime().optional(),
    note: z.union([z.string().trim().max(2000), z.null()]).optional(),
    // Opção do chefe na confirmação: saída na faixa 6h–10h de janela pode ser
    // fechada como MEIO plantão, com o excedente de 6h indo para o banco.
    creditHalfShift: z.boolean().optional(),
});

export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
    if (!hasDatabaseUrl()) {
        return NextResponse.json({ error: "DATABASE_URL is not configured for operations-v2." }, { status: 503 });
    }

    let session;
    try {
        session = await requireAuthenticatedSession(["admin", "chief"]);
    } catch (error) {
        const status = error instanceof AuthError ? error.status : 500;
        return NextResponse.json({ error: error instanceof Error ? error.message : "Unauthorized." }, { status });
    }

    const parsed = schema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
        return NextResponse.json({ error: "Payload de confirmacao invalido." }, { status: 400 });
    }

    const { id } = await context.params;
    const db = getDb();
    const existing = await db.query.interventionOccupancies.findFirst({
        where: eq(interventionOccupancies.id, id),
    });
    if (!existing) {
        return NextResponse.json({ error: "Intervention occupancy not found." }, { status: 404 });
    }
    if (!existing.actualEndedAt) {
        return NextResponse.json({ error: "Esta ocupacao ainda nao tem saida registrada para confirmar." }, { status: 400 });
    }

    const nextActualEndedAt = parsed.data.actualEndedAt ? new Date(parsed.data.actualEndedAt) : existing.actualEndedAt;
    if (nextActualEndedAt.getTime() < existing.startedAt.getTime()) {
        return NextResponse.json({ error: "Horario de saida nao pode ser anterior a chegada." }, { status: 400 });
    }

    // Creditar meio plantão só vale quando a saída confirmada cai de fato na
    // faixa 6h–10h da janela do turno (modules/operational/early-departure.ts).
    if (parsed.data.creditHalfShift) {
        if (!isEarlyDepartureEligible({ roleLabel: existing.roleLabel })) {
            return NextResponse.json({ error: "Ocupacao de meio plantao declarado nao entra na regua de saida antecipada." }, { status: 400 });
        }
        const classification = classifyEarlyDeparture({
            departureAt: nextActualEndedAt,
            scheduledStartAt: existing.scheduledStartAt,
            scheduledEndAt: existing.scheduledEndAt,
            startedAt: existing.startedAt,
        });
        if (classification.outcome !== "half_shift") {
            return NextResponse.json({ error: "Essa saida nao cai na faixa de meio plantao (entre 6h e 10h de janela)." }, { status: 400 });
        }
    }

    try {
        if (parsed.data.creditHalfShift) {
            // Antes da correção: o recálculo do banco dentro de correctInterventionOccupancy
            // já precisa ler o desfecho gravado.
            await db.update(interventionOccupancies)
                .set({ earlyDepartureOutcome: "half_shift" })
                .where(eq(interventionOccupancies.id, id));
        }

        const updated = await correctInterventionOccupancy(id, {
            actualEndedAt: nextActualEndedAt,
            chiefConfirmed: true,
        }, session.user.id);

        if (parsed.data.note) {
            await db.update(interventionOccupancies)
                .set({ departureConfirmedNote: parsed.data.note })
                .where(eq(interventionOccupancies.id, id));
        }

        await db.insert(auditLogs).values({
            actorUserId: session.user.id,
            action: "intervention_occupancy.departure_confirmed",
            entityType: "intervention_occupancy",
            entityId: updated.id,
            details: {
                previousActualEndedAt: existing.actualEndedAt.toISOString(),
                confirmedActualEndedAt: nextActualEndedAt.toISOString(),
                edited: nextActualEndedAt.getTime() !== existing.actualEndedAt.getTime(),
                note: parsed.data.note ?? null,
                creditHalfShift: parsed.data.creditHalfShift === true,
            },
        });

        return NextResponse.json({ occupancy: updated });
    } catch (error) {
        return NextResponse.json(
            { error: error instanceof Error ? error.message : "Unable to confirm intervention departure." },
            { status: 400 },
        );
    }
}

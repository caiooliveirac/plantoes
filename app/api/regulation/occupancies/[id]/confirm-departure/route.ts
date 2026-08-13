import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { getDb, hasDatabaseUrl } from "@/db";
import { auditLogs, regulationOccupancies } from "@/db/schema";
import { AuthError, requireAuthenticatedSession } from "@/lib/auth/server";
import { correctRegulationOccupancy } from "@/modules/operational/corrections";
import { classifyEarlyDeparture, isEarlyDepartureEligible } from "@/modules/operational/early-departure";
import { isValidOverrideNote, OVERRIDE_NOTE_MIN_LENGTH } from "@/modules/operational/departure-triage";

const schema = z.object({
    actualEndedAt: z.string().datetime().optional(),
    // Ajuste da chegada (modal "Ajustar o crédito no banco de horas"). A correção
    // recalcula janela agendada e banco de horas.
    startedAt: z.string().datetime().optional(),
    note: z.union([z.string().trim().max(2000), z.null()]).optional(),
    // Legado: equivale a outcome "half_shift".
    creditHalfShift: z.boolean().optional(),
    // Decisão explícita do chefe sobre uma saída antecipada:
    //   bank_only  → não assina; horas viram banco (só na faixa <6h)
    //   half_shift → assina MEIO (faixa 6h–10h, ou <6h com justificativa)
    //   full_shift → assina inteiro apesar da saída antecipada (<6h ou 6h–10h;
    //                exige justificativa quando a régua diria bank_only)
    outcome: z.enum(["bank_only", "half_shift", "full_shift"]).optional(),
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
    const existing = await db.query.regulationOccupancies.findFirst({
        where: eq(regulationOccupancies.id, id),
    });
    if (!existing) {
        return NextResponse.json({ error: "Regulation occupancy not found." }, { status: 404 });
    }
    // Sem saída registrada, só dá para confirmar se o chamador INFORMAR a saída
    // (fluxo do payment-closing sobre ocupação fechada por handoff/boundary).
    if (!existing.actualEndedAt && !parsed.data.actualEndedAt) {
        return NextResponse.json({ error: "Esta ocupacao ainda nao tem saida registrada para confirmar." }, { status: 400 });
    }

    const nextActualEndedAt = parsed.data.actualEndedAt ? new Date(parsed.data.actualEndedAt) : existing.actualEndedAt!;
    const nextStartedAt = parsed.data.startedAt ? new Date(parsed.data.startedAt) : existing.startedAt;
    if (nextActualEndedAt.getTime() < nextStartedAt.getTime()) {
        return NextResponse.json({ error: "Horario de saida nao pode ser anterior a chegada." }, { status: 400 });
    }

    // Decisão explícita de saída antecipada (outcome) — creditHalfShift é o legado.
    const requestedOutcome = parsed.data.outcome ?? (parsed.data.creditHalfShift ? "half_shift" : null);
    if (requestedOutcome) {
        if (!isEarlyDepartureEligible({ roleLabel: existing.roleLabel })) {
            return NextResponse.json({ error: "Ocupacao de meio plantao declarado nao entra na regua de saida antecipada." }, { status: 400 });
        }
        const classification = classifyEarlyDeparture({
            departureAt: nextActualEndedAt,
            scheduledStartAt: existing.scheduledStartAt,
            scheduledEndAt: existing.scheduledEndAt,
            startedAt: nextStartedAt,
        });
        // Desfecho só existe para saída ANTES do fim da janela — saída no fim ou
        // depois dele é encerramento normal, sem régua.
        if (classification.outcome === "full_shift" && classification.remainingMinutes === 0) {
            return NextResponse.json({ error: "Essa saida nao e antecipada — nao ha desfecho de pagamento a decidir." }, { status: 400 });
        }
        // Desviar da régua (para mais OU para menos) exige justificativa escrita.
        // Única exceção: pagar inteiro na faixa de MEIO, decisão corriqueira do chefe.
        const noteRequired = requestedOutcome !== classification.outcome
            && !(classification.outcome === "half_shift" && requestedOutcome === "full_shift");
        if (noteRequired && !isValidOverrideNote(parsed.data.note)) {
            return NextResponse.json({ error: `Desviar da regua de pagamento exige justificativa com pelo menos ${OVERRIDE_NOTE_MIN_LENGTH} caracteres.` }, { status: 400 });
        }
    }

    try {
        if (requestedOutcome) {
            // Antes da correção: o recálculo do banco dentro de correctRegulationOccupancy
            // já precisa ler o desfecho gravado.
            await db.update(regulationOccupancies)
                .set({ earlyDepartureOutcome: requestedOutcome })
                .where(eq(regulationOccupancies.id, id));
        }

        const updated = await correctRegulationOccupancy(id, {
            actualEndedAt: nextActualEndedAt,
            ...(parsed.data.startedAt ? { startedAt: nextStartedAt } : {}),
            chiefConfirmed: true,
        }, session.user.id);

        if (parsed.data.note) {
            await db.update(regulationOccupancies)
                .set({ departureConfirmedNote: parsed.data.note })
                .where(eq(regulationOccupancies.id, id));
        }

        await db.insert(auditLogs).values({
            actorUserId: session.user.id,
            action: "regulation_occupancy.departure_confirmed",
            entityType: "regulation_occupancy",
            entityId: updated.id,
            details: {
                previousActualEndedAt: existing.actualEndedAt?.toISOString() ?? null,
                confirmedActualEndedAt: nextActualEndedAt.toISOString(),
                previousStartedAt: existing.startedAt.toISOString(),
                confirmedStartedAt: nextStartedAt.toISOString(),
                edited: nextActualEndedAt.getTime() !== (existing.actualEndedAt?.getTime() ?? null)
                    || nextStartedAt.getTime() !== existing.startedAt.getTime(),
                note: parsed.data.note ?? null,
                earlyDepartureOutcome: requestedOutcome,
            },
        });

        return NextResponse.json({ occupancy: updated });
    } catch (error) {
        return NextResponse.json(
            { error: error instanceof Error ? error.message : "Unable to confirm regulation departure." },
            { status: 400 },
        );
    }
}

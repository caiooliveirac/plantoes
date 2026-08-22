import { eq } from "drizzle-orm";

import { closeDb, getDb } from "@/db";
import { interventionOccupancies } from "@/db/schema";
import { correctInterventionOccupancy } from "@/modules/operational/corrections";

/**
 * Bruna Micheli, PP20, 19/08/2026.
 *
 * Ela avisou "Bruna 24 h pp20" (P) às 06:59, mas às 19:13 a chefia remanejou:
 * "ROBSON CONTINUA PP20" fechou a PP20 dela e "BRUNA CONTINUA 2031" abriu as
 * outras 12h no ramal 2031 da regulação (essa ocupação está fechada e correta).
 *
 * Depois alguém clicou "NÃO SAIU" na PP20 — mas ela SAIU: só mudou de posição.
 * A contestação reabriu o registro (ended_at/actual_ended_at nulos), que ficou
 * aberto por 3 dias e só parou de ocupar a base quando o Robson a deslocou.
 *
 * Correção: PP20 vira SD, encerrada às 19:13 (a hora do remanejamento). O
 * pagamento passa a enxergar 12h de SD na PP20 + 12h de SN na 2031.
 */

const OCCUPANCY_ID = "06c867b8-118f-42b9-a850-50280b7de4a0";
// 19/08/2026 19:13:58 em São Paulo (UTC-3).
const DEPARTURE_AT = new Date("2026-08-19T22:13:58.000Z");

async function main() {
    const db = getDb();
    const existing = await db.query.interventionOccupancies.findFirst({
        where: (t, { eq }) => eq(t.id, OCCUPANCY_ID),
    });
    if (!existing) {
        throw new Error("Ocupação da Bruna na PP20 não encontrada.");
    }
    if (existing.endedAt) {
        console.log("Já está encerrada — nada a fazer.");
        await closeDb();
        return;
    }

    const updated = await correctInterventionOccupancy(OCCUPANCY_ID, {
        shiftLabel: "SD",
        endedAt: DEPARTURE_AT,
        actualEndedAt: DEPARTURE_AT,
        chiefConfirmed: true,
    }, null);

    await db.update(interventionOccupancies)
        .set({
            notes: [
                existing.notes,
                "[CORREÇÃO 22/08/2026] Encerrada como SD às 19:13 de 19/08: ela saiu da PP20 no remanejamento"
                + " (\"ROBSON CONTINUA PP20\") e cumpriu as outras 12h no ramal 2031. O \"NÃO SAIU\" anterior"
                + " havia reaberto o registro por engano.",
            ].filter(Boolean).join("\n").trim(),
        })
        .where(eq(interventionOccupancies.id, OCCUPANCY_ID));

    console.log("PP20 corrigida:", {
        shiftLabel: updated.shiftLabel,
        scheduledEndAt: updated.scheduledEndAt,
        endedAt: updated.endedAt,
        actualEndedAt: updated.actualEndedAt,
    });
    await closeDb();
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});

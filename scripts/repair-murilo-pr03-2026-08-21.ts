import { eq } from "drizzle-orm";

import { closeDb, getDb } from "@/db";
import { interventionOccupancies } from "@/db/schema";
import { correctInterventionOccupancy } from "@/modules/operational/corrections";

/**
 * Murilo Damasceno, PR03, 21/08/2026.
 *
 * Ele avisou "Murilo Damasceno na PR03 p" às 06:59 — plantão de 24h. O bot
 * ofereceu o botão "Foi só este dia (SD)", ele tocou por engano, e o plantão
 * virou SD 07:00–19:00. Ficou na base a noite inteira mesmo assim, e avisou a
 * saída só às 08:27 de 22/08 ("saindo da PR03, motivo: ocorrência 0126").
 *
 * Correção (decisão do coordenador em 22/08): volta a ser P, janela 21/08 07:00
 * → 22/08 07:00, encerrado na saída declarada de 08:27 — a permanência além das
 * 07:00 foi ocorrência, então gera crédito de banco de horas. A titularidade no
 * quadro (board_started_at), zerada pelo "NÃO SAIU", volta para a chegada: sem
 * ela o plantão não entra na folha.
 */

const OCCUPANCY_ID = "2ae3efd9-cdc4-42aa-b4a5-1e7a7dece95d";
// 22/08/2026 08:27:24 em São Paulo (UTC-3) — o horário que o bot registrou.
const DEPARTURE_AT = new Date("2026-08-22T11:27:24.000Z");

async function main() {
    const db = getDb();
    const existing = await db.query.interventionOccupancies.findFirst({
        where: (t, { eq: equals }) => equals(t.id, OCCUPANCY_ID),
    });
    if (!existing) {
        throw new Error("Ocupação do Murilo na PR03 não encontrada.");
    }

    const updated = await correctInterventionOccupancy(OCCUPANCY_ID, {
        shiftLabel: "P",
        endedAt: DEPARTURE_AT,
        actualEndedAt: DEPARTURE_AT,
        // Sem a validação da chefia a saída física não vira crédito
        // (isDepartureClosureAuthoritative) — a decisão de creditar a ocorrência
        // 0126 é do coordenador, tomada em 22/08.
        chiefConfirmed: true,
    }, null);

    await db.update(interventionOccupancies)
        .set({
            notes: [
                existing.notes,
                "[CORREÇÃO 22/08/2026] Restaurado como P (21/08 07:00 → 22/08 07:00): o botão"
                + " \"Foi só este dia (SD)\" foi tocado por engano na chegada. Saída declarada às 08:27"
                + " de 22/08 por ocorrência 0126, com crédito de banco de horas. Titularidade no quadro"
                + " devolvida — o \"NÃO SAIU\" a havia zerado e o plantão tinha sumido da folha.",
            ].filter(Boolean).join("\n").trim(),
        })
        .where(eq(interventionOccupancies.id, OCCUPANCY_ID));

    console.log("PR03 corrigida:", {
        shiftLabel: updated.shiftLabel,
        scheduledStartAt: updated.scheduledStartAt,
        scheduledEndAt: updated.scheduledEndAt,
        boardStartedAt: updated.boardStartedAt,
        endedAt: updated.endedAt,
        actualEndedAt: updated.actualEndedAt,
    });
    await closeDb();
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});

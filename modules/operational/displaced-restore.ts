import { and, asc, eq, gt, isNotNull, isNull, like, or } from "drizzle-orm";

import { interventionOccupancies, regulationOccupancies } from "@/db/schema";
import { operationalNotesIndicateShadow } from "@/modules/operational/shadow";

// Mesmo texto de REGULATION_/INTERVENTION_DISPLACED_NOTE_MARKER (este módulo não importa
// os domínios para não criar ciclo com eles).
const DISPLACED_NOTE_MARKER = "[DESLOCADO]";

type Executor = any;

export function stripDisplacedMarkerLines(notes: string | null | undefined): string | null {
    const kept = (notes ?? "")
        .split("\n")
        .filter((line) => !line.includes(DISPLACED_NOTE_MARKER))
        .join("\n")
        .trim();
    return kept.length > 0 ? kept : null;
}

/**
 * Quem tomou o posto saiu dele (saída, retirada, remanejo): o deslocado que segue no
 * plantão naquele mesmo ramal/base REASSUME o quadro sozinho, com a chegada original.
 * Sem isto o posto ficava vazio no quadro e o deslocado invisível até reenviar a
 * chegada (caso José Roberto, 2153, 23/09/2026 — defeito D10 de docs/chegada.md).
 *
 * Só age quando o alvo ficou SEM titular e há deslocado com cobertura vigente; o mais
 * antigo reassume. Não roda em rendição (handoff): aí quem chega assume o quadro.
 */
export async function restoreDisplacedOnVacatedTargetTx(tx: Executor, params: {
    domain: "regulation" | "intervention";
    targetId: number;
    at: Date;
}): Promise<string | null> {
    const table = params.domain === "regulation" ? regulationOccupancies : interventionOccupancies;
    const targetColumn = params.domain === "regulation" ? regulationOccupancies.postId : interventionOccupancies.baseId;

    const [carrier] = await tx.select({ id: table.id }).from(table).where(and(
        eq(targetColumn, params.targetId),
        isNull(table.endedAt),
        isNotNull(table.boardStartedAt),
    )).limit(1);
    if (carrier) {
        return null;
    }

    const candidates: Array<{ id: string; startedAt: Date; notes: string | null }> = await tx.select({ id: table.id, startedAt: table.startedAt, notes: table.notes }).from(table).where(and(
        eq(targetColumn, params.targetId),
        isNull(table.endedAt),
        isNull(table.boardStartedAt),
        like(table.notes, `%${DISPLACED_NOTE_MARKER}%`),
        or(isNull(table.scheduledEndAt), gt(table.scheduledEndAt, params.at)),
    )).orderBy(asc(table.startedAt));
    // Sombra deslocada segue sombra: nunca assume o quadro.
    const displaced = candidates.find((row) => !operationalNotesIndicateShadow(row.notes));
    if (!displaced) {
        return null;
    }

    await tx.update(table)
        .set({
            boardStartedAt: displaced.startedAt,
            notes: stripDisplacedMarkerLines(displaced.notes),
            updatedAt: new Date(),
        })
        .where(eq(table.id, displaced.id));
    return displaced.id;
}

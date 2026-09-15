import { and, asc, eq, gt, isNull, ne, or } from "drizzle-orm";
import { interventionBases, interventionOccupancies, regulationOccupancies, regulationPosts } from "@/db/schema";
import type { LaterArrival } from "@/modules/operational/contested-departure";

// ponytail: Executor = any, como nos services; drizzle não exporta um tipo
// prático de "db ou tx".
type Executor = any;

/**
 * Chegada do médico em QUALQUER ramal/base depois da ocupação dada, ainda aberta
 * ou encerrada depois da saída contestada. Existir uma dessas prova que a saída
 * contestada aconteceu.
 */
export async function findLaterArrivalForDoctor(tx: Executor, params: {
    doctorId: string;
    excludeOccupancyId: string;
    afterStartedAt: Date;
    contestedDepartureAt: Date;
}): Promise<LaterArrival | null> {
    const [intervention, regulation] = await Promise.all([
        tx.select({ code: interventionBases.code, startedAt: interventionOccupancies.startedAt })
            .from(interventionOccupancies)
            .innerJoin(interventionBases, eq(interventionBases.id, interventionOccupancies.baseId))
            .where(and(
                eq(interventionOccupancies.doctorId, params.doctorId),
                ne(interventionOccupancies.id, params.excludeOccupancyId),
                gt(interventionOccupancies.startedAt, params.afterStartedAt),
                or(isNull(interventionOccupancies.endedAt), gt(interventionOccupancies.endedAt, params.contestedDepartureAt)),
            ))
            .orderBy(asc(interventionOccupancies.startedAt))
            .limit(1),
        tx.select({ code: regulationPosts.code, startedAt: regulationOccupancies.startedAt })
            .from(regulationOccupancies)
            .innerJoin(regulationPosts, eq(regulationPosts.id, regulationOccupancies.postId))
            .where(and(
                eq(regulationOccupancies.doctorId, params.doctorId),
                ne(regulationOccupancies.id, params.excludeOccupancyId),
                gt(regulationOccupancies.startedAt, params.afterStartedAt),
                or(isNull(regulationOccupancies.endedAt), gt(regulationOccupancies.endedAt, params.contestedDepartureAt)),
            ))
            .orderBy(asc(regulationOccupancies.startedAt))
            .limit(1),
    ]) as [Array<{ code: string; startedAt: Date }>, Array<{ code: string; startedAt: Date }>];

    const candidates = [...intervention, ...regulation]
        .sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime());
    const first = candidates[0];
    return first ? { targetCode: first.code, startedAt: first.startedAt } : null;
}

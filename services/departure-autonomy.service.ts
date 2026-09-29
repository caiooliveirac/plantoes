import { and, desc, eq, gte, inArray, isNull, like } from "drizzle-orm";

import { getDb } from "@/db";
import { auditLogs, doctors, interventionBases, interventionOccupancies, regulationOccupancies, regulationPosts } from "@/db/schema";
import { syncInterventionBankHours, syncRegulationBankHours } from "@/modules/bank-hours/service";
import {
    SYSTEM_DEPARTURE_CONFIRM_NOTE_PREFIX,
    isSystemDepartureConfirmNote,
    type DepartureAutonomyResult,
} from "@/modules/operational/departure-autonomy";
import type { PendingDepartureConfirmation } from "@/services/board.service";

/**
 * O que o sistema faz sozinho na fila "Saídas a confirmar"
 * (modules/operational/departure-autonomy.ts, docs/saidas-a-confirmar.md):
 * confirmar a rotina, aplicar a sugestão vencida — e o Desfazer da chefia.
 *
 * Confirmar pelo sistema grava o mesmo estado da confirmação da chefia sem
 * mudar hora nenhuma (confirmação + desfecho da sugestão) e recalcula o banco
 * pelo mesmo sync — só sem usuário.
 */

type Domain = "regulation" | "intervention";

const AUTO_CONFIRMED = "departure_auto_confirmed";
const AUTO_CONFIRM_UNDONE = "departure_auto_confirm_undone";

function auditAction(domain: Domain, suffix: string) {
    return `${domain}_occupancy.${suffix}`;
}

async function loadOccupancy(domain: Domain, occupancyId: string) {
    const db = getDb();
    return domain === "regulation"
        ? db.query.regulationOccupancies.findFirst({ where: eq(regulationOccupancies.id, occupancyId) })
        : db.query.interventionOccupancies.findFirst({ where: eq(interventionOccupancies.id, occupancyId) });
}

/** Tira a confirmação só se ela ainda for do sistema (a marca na nota). */
async function clearSystemConfirmation(domain: Domain, occupancyId: string, fields: {
    departureConfirmedNote: null;
    departureConfirmedAt: null;
    departureConfirmedByUserId: null;
    earlyDepartureOutcome?: null;
}) {
    const db = getDb();
    const systemNote = `${SYSTEM_DEPARTURE_CONFIRM_NOTE_PREFIX}%`;
    const rows = domain === "regulation"
        ? await db.update(regulationOccupancies).set(fields).where(and(
            eq(regulationOccupancies.id, occupancyId),
            like(regulationOccupancies.departureConfirmedNote, systemNote),
        )).returning({ id: regulationOccupancies.id })
        : await db.update(interventionOccupancies).set(fields).where(and(
            eq(interventionOccupancies.id, occupancyId),
            like(interventionOccupancies.departureConfirmedNote, systemNote),
        )).returning({ id: interventionOccupancies.id });
    return rows.length > 0;
}

/**
 * Confirma como sistema. A confirmação é REIVINDICADA num UPDATE condicional
 * (ainda não confirmada, mesma hora de saída da fila): se a chefia confirmou,
 * corrigiu a hora ou contestou no meio tempo, nada é gravado (false) — nunca
 * sobrescreve a confirmação de alguém. Nota, desfecho e confirmação saem
 * juntos; depois o banco de horas é recalculado como na confirmação da chefia.
 */
export async function confirmDepartureBySystem(params: {
    pending: PendingDepartureConfirmation;
    assessment: DepartureAutonomyResult;
    /** "virada" (rotina) ou "prazo" (sugestão vencida em 24h). */
    reason: "virada" | "prazo";
}): Promise<boolean> {
    const { pending, assessment, reason } = params;
    const suggestion = assessment.suggestion;
    if (!suggestion) return false;

    const db = getDb();
    const actualEndedAt = new Date(pending.actualEndedAt);
    const fields = {
        departureConfirmedAt: new Date(),
        departureConfirmedByUserId: null,
        departureConfirmedNote: `${SYSTEM_DEPARTURE_CONFIRM_NOTE_PREFIX} (${reason === "virada" ? "rotina, na virada" : "sugestão, após 24h"}): ${suggestion.label}.`,
        ...(suggestion.outcome ? { earlyDepartureOutcome: suggestion.outcome } : {}),
    };
    const claimed = pending.domain === "regulation"
        ? await db.update(regulationOccupancies).set(fields).where(and(
            eq(regulationOccupancies.id, pending.occupancyId),
            isNull(regulationOccupancies.departureConfirmedAt),
            eq(regulationOccupancies.actualEndedAt, actualEndedAt),
        )).returning({ id: regulationOccupancies.id })
        : await db.update(interventionOccupancies).set(fields).where(and(
            eq(interventionOccupancies.id, pending.occupancyId),
            isNull(interventionOccupancies.departureConfirmedAt),
            eq(interventionOccupancies.actualEndedAt, actualEndedAt),
        )).returning({ id: interventionOccupancies.id });
    if (claimed.length === 0) return false;

    // Saída confirmada libera o banco do grupo de continuidade.
    if (pending.domain === "regulation") {
        await syncRegulationBankHours(db, pending.occupancyId);
    } else {
        await syncInterventionBankHours(db, pending.occupancyId);
    }

    await db.insert(auditLogs).values({
        actorUserId: null,
        action: auditAction(pending.domain, AUTO_CONFIRMED),
        entityType: `${pending.domain}_occupancy`,
        entityId: pending.occupancyId,
        details: {
            reason,
            autonomy: assessment.autonomy,
            kind: assessment.triage.kind,
            origin: pending.origin,
            suggestion: suggestion.label,
            effect: suggestion.effect,
            earlyDepartureOutcome: suggestion.outcome,
            actualEndedAt: actualEndedAt.toISOString(),
        },
    });
    return true;
}

/**
 * Desfazer da chefia: a saída volta para a fila e passa a ser dela — o sistema
 * não confirma de novo (listDepartureIdsUndoneByChief).
 */
export async function undoSystemDepartureConfirmation(params: {
    domain: Domain;
    occupancyId: string;
    userId: string;
}) {
    const existing = await loadOccupancy(params.domain, params.occupancyId);
    if (!existing) {
        throw new Error("Ocupação não encontrada.");
    }
    if (!existing.departureConfirmedAt || !isSystemDepartureConfirmNote(existing.departureConfirmedNote)) {
        throw new Error("Esta saída já não está confirmada pelo sistema.");
    }

    const [lastAuto] = await getDb()
        .select({ details: auditLogs.details })
        .from(auditLogs)
        .where(and(
            eq(auditLogs.action, auditAction(params.domain, AUTO_CONFIRMED)),
            eq(auditLogs.entityId, params.occupancyId),
        ))
        .orderBy(desc(auditLogs.createdAt))
        .limit(1);
    const appliedOutcome = (lastAuto?.details as { earlyDepartureOutcome?: string | null } | undefined)?.earlyDepartureOutcome ?? null;

    const cleared = await clearSystemConfirmation(params.domain, params.occupancyId, {
        departureConfirmedAt: null,
        departureConfirmedByUserId: null,
        departureConfirmedNote: null,
        // Só limpa o desfecho que o próprio sistema gravou.
        ...(appliedOutcome && existing.earlyDepartureOutcome === appliedOutcome ? { earlyDepartureOutcome: null } : {}),
    });
    if (!cleared) {
        // A chefia confirmou por cima entre a leitura e aqui: a dela vale.
        throw new Error("Esta saída já não está confirmada pelo sistema.");
    }
    // Saída não confirmada volta a reter o banco do grupo.
    if (params.domain === "regulation") {
        await syncRegulationBankHours(getDb(), params.occupancyId);
    } else {
        await syncInterventionBankHours(getDb(), params.occupancyId);
    }

    await getDb().insert(auditLogs).values({
        actorUserId: params.userId,
        action: auditAction(params.domain, AUTO_CONFIRM_UNDONE),
        entityType: `${params.domain}_occupancy`,
        entityId: params.occupancyId,
        details: { clearedOutcome: appliedOutcome },
    });
}

/** Ocupações que a chefia tirou do automático (Desfazer). */
export async function listDepartureIdsUndoneByChief(occupancyIds: string[]): Promise<Set<string>> {
    if (occupancyIds.length === 0) return new Set();
    const rows = await getDb()
        .select({ entityId: auditLogs.entityId })
        .from(auditLogs)
        .where(and(
            inArray(auditLogs.action, [auditAction("regulation", AUTO_CONFIRM_UNDONE), auditAction("intervention", AUTO_CONFIRM_UNDONE)]),
            inArray(auditLogs.entityId, occupancyIds),
        ));
    return new Set(rows.map((row) => row.entityId));
}

export interface SystemConfirmedDeparture {
    domain: Domain;
    occupancyId: string;
    doctorName: string;
    targetCode: string;
    actualEndedAt: string;
    confirmedAt: string;
    note: string;
}

/** Confirmadas pelo sistema nas últimas horas e ainda não desfeitas — a lista do Desfazer. */
export async function listSystemConfirmedDepartures(sinceHours = 24): Promise<SystemConfirmedDeparture[]> {
    const db = getDb();
    const since = new Date(Date.now() - sinceHours * 3_600_000);
    const notePattern = `${SYSTEM_DEPARTURE_CONFIRM_NOTE_PREFIX}%`;

    const [regulation, intervention] = await Promise.all([
        db.select({
            occupancyId: regulationOccupancies.id,
            doctorName: doctors.fullName,
            displayName: doctors.displayName,
            targetCode: regulationPosts.code,
            actualEndedAt: regulationOccupancies.actualEndedAt,
            confirmedAt: regulationOccupancies.departureConfirmedAt,
            note: regulationOccupancies.departureConfirmedNote,
        })
            .from(regulationOccupancies)
            .innerJoin(doctors, eq(doctors.id, regulationOccupancies.doctorId))
            .innerJoin(regulationPosts, eq(regulationPosts.id, regulationOccupancies.postId))
            .where(and(
                gte(regulationOccupancies.departureConfirmedAt, since),
                like(regulationOccupancies.departureConfirmedNote, notePattern),
            )),
        db.select({
            occupancyId: interventionOccupancies.id,
            doctorName: doctors.fullName,
            displayName: doctors.displayName,
            targetCode: interventionBases.code,
            actualEndedAt: interventionOccupancies.actualEndedAt,
            confirmedAt: interventionOccupancies.departureConfirmedAt,
            note: interventionOccupancies.departureConfirmedNote,
        })
            .from(interventionOccupancies)
            .innerJoin(doctors, eq(doctors.id, interventionOccupancies.doctorId))
            .innerJoin(interventionBases, eq(interventionBases.id, interventionOccupancies.baseId))
            .where(and(
                gte(interventionOccupancies.departureConfirmedAt, since),
                like(interventionOccupancies.departureConfirmedNote, notePattern),
            )),
    ]);

    return [
        ...regulation.map((row) => ({ ...row, domain: "regulation" as const })),
        ...intervention.map((row) => ({ ...row, domain: "intervention" as const })),
    ]
        .filter((row) => row.actualEndedAt && row.confirmedAt && row.note)
        .map((row) => ({
            domain: row.domain,
            occupancyId: row.occupancyId,
            doctorName: row.displayName?.trim() || row.doctorName,
            targetCode: row.targetCode,
            actualEndedAt: row.actualEndedAt!.toISOString(),
            confirmedAt: row.confirmedAt!.toISOString(),
            note: row.note!,
        }))
        .sort((left, right) => right.confirmedAt.localeCompare(left.confirmedAt));
}

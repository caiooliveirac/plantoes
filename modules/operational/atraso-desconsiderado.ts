/**
 * Atraso desconsiderado pela chefia.
 *
 * A chefia marca que o atraso de chegada de uma ocupação não conta: o banco de
 * horas (e, por ele, o pagamento) passa a tratar o médico como pontual —
 * atraso 0, excedente em dobro. `startedAt`/`boardStartedAt` NÃO mudam, então
 * prioridade de refeição e de saída seguem pela hora real de chegada.
 *
 * Toda marcação (e remoção) fica em `audit_logs` — com o estado anterior, para
 * o undo operacional (modules/operational/undo.ts) restaurar — e em
 * `shift_events`. Migration 0052.
 */
import { eq } from "drizzle-orm";
import { auditLogs, interventionOccupancies, regulationOccupancies, shiftEvents } from "@/db/schema";
import { syncInterventionBankHours, syncRegulationBankHours } from "@/modules/bank-hours/service";

type Executor = any;

export type ArrivalDelayWaiverDomain = "regulation" | "intervention";

export interface ArrivalDelayWaiverSnapshot {
    waivedAt: string | null;
    byUserId: string | null;
    note: string | null;
}

export const ARRIVAL_DELAY_WAIVER_SET_ACTION = "arrival_delay_waiver.set";
export const ARRIVAL_DELAY_WAIVER_REMOVED_ACTION = "arrival_delay_waiver.removed";

function occupancyTable(domain: ArrivalDelayWaiverDomain) {
    return domain === "regulation" ? regulationOccupancies : interventionOccupancies;
}

export function toArrivalDelayWaiverSnapshot(row: {
    arrivalDelayWaivedAt: Date | null;
    arrivalDelayWaivedByUserId: string | null;
    arrivalDelayWaiverNote: string | null;
}): ArrivalDelayWaiverSnapshot {
    return {
        waivedAt: row.arrivalDelayWaivedAt?.toISOString() ?? null,
        byUserId: row.arrivalDelayWaivedByUserId,
        note: row.arrivalDelayWaiverNote,
    };
}

/**
 * Grava as três colunas (ou as limpa), ressincroniza o banco de horas do grupo
 * de continuidade e deixa o rastro de auditoria. Transação própria.
 */
export async function setArrivalDelayWaiver(db: Executor, params: {
    domain: ArrivalDelayWaiverDomain;
    occupancyId: string;
    waived: boolean;
    note: string | null;
    actorUserId: string;
}) {
    const table = occupancyTable(params.domain);
    const trimmedNote = params.note?.trim() || null;

    return db.transaction(async (tx: Executor) => {
        const existing = params.domain === "regulation"
            ? await tx.query.regulationOccupancies.findFirst({ where: eq(regulationOccupancies.id, params.occupancyId) })
            : await tx.query.interventionOccupancies.findFirst({ where: eq(interventionOccupancies.id, params.occupancyId) });
        if (!existing) {
            throw new Error("Ocupação não encontrada.");
        }

        const previous = toArrivalDelayWaiverSnapshot(existing);
        const now = new Date();
        const [occupancy] = await tx.update(table)
            .set({
                arrivalDelayWaivedAt: params.waived ? now : null,
                arrivalDelayWaivedByUserId: params.waived ? params.actorUserId : null,
                arrivalDelayWaiverNote: params.waived ? trimmedNote : null,
                updatedByUserId: params.actorUserId,
                updatedAt: now,
            })
            .where(eq(table.id, params.occupancyId))
            .returning();

        if (params.domain === "regulation") {
            await syncRegulationBankHours(tx, params.occupancyId);
        } else {
            await syncInterventionBankHours(tx, params.occupancyId);
        }

        await tx.insert(shiftEvents).values({
            domain: params.domain,
            entityId: params.occupancyId,
            entityType: `${params.domain}_occupancy`,
            eventType: `${params.domain}_occupancy.${params.waived ? "arrival_delay_waived" : "arrival_delay_waiver_removed"}`,
            actorUserId: params.actorUserId,
            payload: {
                occupancyId: params.occupancyId,
                doctorId: existing.doctorId,
                waived: params.waived,
                note: params.waived ? trimmedNote : null,
                previous,
            },
        });

        await tx.insert(auditLogs).values({
            actorUserId: params.actorUserId,
            action: params.waived ? ARRIVAL_DELAY_WAIVER_SET_ACTION : ARRIVAL_DELAY_WAIVER_REMOVED_ACTION,
            entityType: `${params.domain}_occupancy`,
            entityId: params.occupancyId,
            details: {
                domain: params.domain,
                doctorId: existing.doctorId,
                waived: params.waived,
                note: params.waived ? trimmedNote : null,
                // O undo restaura exatamente isto.
                previous,
            },
        });

        return { occupancy, previous };
    });
}

/** Restaura as três colunas a partir do snapshot gravado na auditoria e ressincroniza o banco. */
export async function restoreArrivalDelayWaiver(db: Executor, params: {
    domain: ArrivalDelayWaiverDomain;
    occupancyId: string;
    previous: ArrivalDelayWaiverSnapshot;
    actorUserId: string;
}) {
    const table = occupancyTable(params.domain);
    await db.update(table)
        .set({
            arrivalDelayWaivedAt: params.previous.waivedAt ? new Date(params.previous.waivedAt) : null,
            arrivalDelayWaivedByUserId: params.previous.byUserId ?? null,
            arrivalDelayWaiverNote: params.previous.note ?? null,
            updatedByUserId: params.actorUserId,
            updatedAt: new Date(),
        })
        .where(eq(table.id, params.occupancyId));

    if (params.domain === "regulation") {
        await syncRegulationBankHours(db, params.occupancyId);
    } else {
        await syncInterventionBankHours(db, params.occupancyId);
    }
}

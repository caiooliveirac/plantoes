// Saneamento de segunda ordem: o auto-close em
// modules/regulation/service.ts (linha ~478) e a logica equivalente em
// intervention/service.ts fechavam o ocupante anterior do mesmo target
// usando o started_at do ghost (que era retroativo). Resultado: o
// colega aparecia com actual_ended_at = anchor antigo, encurtando seu
// plantao para 10-30 minutos.
//
// Sinal de vitima:
//   1. Existe um shift_event continuation_startedat_repaired no DB.
//   2. Existe um ocupante do mesmo target com actual_ended_at =
//      ghost.previousStartedAt (saneamento ja conhece esse valor).
//   3. O updated_at do ocupante bate com o created_at do ghost
//      (mesma transacao do INSERT bug-induced).
//
// Acao: reabrir o ocupante setando ended_at e actual_ended_at = NULL,
// gravar shift_event de auditoria e re-sincronizar banco de horas.
// A chefia decide depois o fechamento real.
//
// Uso:
//   tsx scripts/repair-continuation-collateral.ts            # preview
//   tsx scripts/repair-continuation-collateral.ts --apply    # executa

import { eq } from "drizzle-orm";
import { closeDb, getDb } from "@/db";
import { sql } from "drizzle-orm";
import { interventionOccupancies, regulationOccupancies, shiftEvents } from "@/db/schema";
import { syncBankHoursByContinuityGroup } from "@/modules/bank-hours/service";

const UPDATED_AT_DELTA_TOLERANCE_MS = 5_000;

function hasFlag(flag: string) {
    return process.argv.includes(flag);
}

type Victim = {
    ghostOccupancyId: string;
    ghostCreatedAt: Date;
    ghostPreviousStartedAt: Date;
    victimOccupancyId: string;
    victimDomain: "regulation" | "intervention";
    victimDoctor: string;
    victimTarget: string;
    victimStartedAt: Date;
    victimEndedAt: Date | null;
    victimActualEndedAt: Date | null;
    victimContinuityGroupId: string | null;
    victimDurationMinutes: number;
};

async function loadVictims(): Promise<Victim[]> {
    const db = getDb();
    const events = await db.execute(sql`
        select se.entity_id, se.entity_type, se.payload
        from operations_v2.shift_events se
        where se.event_type = 'continuation_startedat_repaired'
        order by se.occurred_at
    `);

    const victims: Victim[] = [];
    for (const e of events as any) {
        const p = e.payload;
        const targetCode = p.targetCode;
        const previousStartedAt = new Date(p.previousStartedAt);
        const ghostCreatedAt = new Date(p.newStartedAt);
        const doctorId = p.doctorId;

        const matches = await db.execute(sql`
            select * from (
                select 'regulation' as domain, ro.id, d.full_name,
                       rp.code as target, ro.started_at, ro.ended_at,
                       ro.actual_ended_at, ro.continuity_group_id, ro.updated_at
                from operations_v2.regulation_occupancies ro
                inner join operations_v2.doctors d on d.id = ro.doctor_id
                inner join operations_v2.regulation_posts rp on rp.id = ro.post_id
                where rp.code = ${targetCode}
                  and ro.doctor_id <> ${doctorId}::uuid
                  and ro.actual_ended_at is not null
                  and abs(extract(epoch from (ro.actual_ended_at - ${previousStartedAt.toISOString()}::timestamptz))) < 60
                union all
                select 'intervention' as domain, io.id, d.full_name,
                       ib.code as target, io.started_at, io.ended_at,
                       io.actual_ended_at, io.continuity_group_id, io.updated_at
                from operations_v2.intervention_occupancies io
                inner join operations_v2.doctors d on d.id = io.doctor_id
                inner join operations_v2.intervention_bases ib on ib.id = io.base_id
                where ib.code = ${targetCode}
                  and io.doctor_id <> ${doctorId}::uuid
                  and io.actual_ended_at is not null
                  and abs(extract(epoch from (io.actual_ended_at - ${previousStartedAt.toISOString()}::timestamptz))) < 60
            ) m
        `);

        for (const m of matches as any) {
            const updatedAtMs = new Date(m.updated_at).getTime();
            if (Math.abs(updatedAtMs - ghostCreatedAt.getTime()) > UPDATED_AT_DELTA_TOLERANCE_MS) continue;

            const durationMs = new Date(m.actual_ended_at).getTime() - new Date(m.started_at).getTime();
            victims.push({
                ghostOccupancyId: e.entity_id,
                ghostCreatedAt,
                ghostPreviousStartedAt: previousStartedAt,
                victimOccupancyId: m.id,
                victimDomain: m.domain,
                victimDoctor: m.full_name,
                victimTarget: m.target,
                victimStartedAt: new Date(m.started_at),
                victimEndedAt: m.ended_at ? new Date(m.ended_at) : null,
                victimActualEndedAt: m.actual_ended_at ? new Date(m.actual_ended_at) : null,
                victimContinuityGroupId: m.continuity_group_id,
                victimDurationMinutes: Number((durationMs / 60000).toFixed(1)),
            });
        }
    }
    return victims;
}

async function resolveNextHandoffAt(victim: Victim): Promise<Date | null> {
    const db = getDb();
    // Procura o proximo registro do mesmo target apos o started_at do bug
    // (ghost.previousStartedAt) que serve como handoff legitimo.
    const result = await db.execute(sql`
        select min(started_at) as next_start from (
            select ro.started_at from operations_v2.regulation_occupancies ro
            inner join operations_v2.regulation_posts rp on rp.id = ro.post_id
            where rp.code = ${victim.victimTarget}
              and ro.id <> ${victim.victimOccupancyId}::uuid
              and ro.started_at > ${victim.ghostPreviousStartedAt.toISOString()}::timestamptz
            union all
            select io.started_at from operations_v2.intervention_occupancies io
            inner join operations_v2.intervention_bases ib on ib.id = io.base_id
            where ib.code = ${victim.victimTarget}
              and io.id <> ${victim.victimOccupancyId}::uuid
              and io.started_at > ${victim.ghostPreviousStartedAt.toISOString()}::timestamptz
        ) t
    `);
    const next = (result as any)[0]?.next_start;
    return next ? new Date(next) : null;
}

async function reopenVictim(v: Victim) {
    const db = getDb();
    // Setar ended_at = NULL viola a constraint one_active_board_per_target.
    // Em vez disso, estendemos a vitima ate o proximo handoff legitimo do
    // target (o registro seguinte no mesmo target/base). Se nao houver
    // proximo, aplicamos +1h como fallback conservador para devolver
    // pelo menos uma duracao plausivel a ser revisada manualmente.
    const nextHandoff = await resolveNextHandoffAt(v);
    const fallbackEnd = new Date(v.victimStartedAt.getTime() + 60 * 60 * 1000);
    const newEndedAt = nextHandoff ?? fallbackEnd;

    if (v.victimDomain === "regulation") {
        await db.update(regulationOccupancies)
            .set({ endedAt: newEndedAt, actualEndedAt: null, updatedAt: new Date() })
            .where(eq(regulationOccupancies.id, v.victimOccupancyId));
    } else {
        await db.update(interventionOccupancies)
            .set({ endedAt: newEndedAt, actualEndedAt: null, updatedAt: new Date() })
            .where(eq(interventionOccupancies.id, v.victimOccupancyId));
    }

    await db.insert(shiftEvents).values({
        domain: v.victimDomain,
        entityId: v.victimOccupancyId,
        entityType: v.victimDomain === "regulation" ? "regulation_occupancy" : "intervention_occupancy",
        eventType: "continuation_collateral_repaired",
        actorLabel: "scripts/repair-continuation-collateral",
        occurredAt: new Date(),
        payload: {
            previousEndedAt: v.victimEndedAt?.toISOString() ?? null,
            previousActualEndedAt: v.victimActualEndedAt?.toISOString() ?? null,
            newEndedAt: newEndedAt.toISOString(),
            newActualEndedAt: null,
            nextHandoffFound: nextHandoff !== null,
            ghostOccupancyId: v.ghostOccupancyId,
            ghostPreviousStartedAt: v.ghostPreviousStartedAt.toISOString(),
            ghostCreatedAt: v.ghostCreatedAt.toISOString(),
            victimTarget: v.victimTarget,
            victimDurationMinutesBefore: v.victimDurationMinutes,
            note: "Saneamento de auto-close colateral do continuation bug — ended_at extendido ate o proximo handoff legitimo; actual_ended_at limpo para a chefia revisar a saida real.",
        },
    });

    if (v.victimContinuityGroupId) {
        await syncBankHoursByContinuityGroup(db, v.victimContinuityGroupId);
    }
}

async function main() {
    const apply = hasFlag("--apply");
    const victims = await loadVictims();
    console.log(JSON.stringify({
        mode: apply ? "apply" : "preview",
        victimCount: victims.length,
        victims: victims.map((v) => ({
            target: v.victimTarget,
            doctor: v.victimDoctor,
            domain: v.victimDomain,
            durationBeforeMin: v.victimDurationMinutes,
            startedAt: v.victimStartedAt.toISOString(),
            actualEndedAt: v.victimActualEndedAt?.toISOString() ?? null,
            ghostPreviousStartedAt: v.ghostPreviousStartedAt.toISOString(),
        })),
    }, null, 2));

    if (!apply || victims.length === 0) {
        await closeDb();
        return;
    }

    let count = 0;
    for (const v of victims) { await reopenVictim(v); count += 1; }
    console.log(JSON.stringify({ reopened: count }, null, 2));
    await closeDb();
}

main().catch(async (err) => { console.error(err); await closeDb().catch(() => undefined); process.exitCode = 1; });

/**
 * Recalcula o banco de horas dos grupos de continuidade cuja janela prevista foi
 * esticada pelo "P" além da saída efetiva (a extensão que engolia a hora extra).
 *
 * Só recalcula o que MUDA de janela; o recálculo passa por
 * syncBankHoursByContinuityGroup, então override manual de saldo continua valendo.
 *
 * Uso:
 *   tsx scripts/repair-p-shift-continuity-clamp.ts            # dry-run (padrão)
 *   tsx scripts/repair-p-shift-continuity-clamp.ts --apply    # grava
 */
import { sql } from "drizzle-orm";
import { closeDb, getDb } from "@/db";
import { applyAnomalyGuard, calculateBankHours } from "@/modules/bank-hours/calculator";
import {
    buildContinuityBankHoursSpan,
    buildContinuityGroups,
    type ContinuityOccupancy,
} from "@/modules/bank-hours/continuity";
import { syncBankHoursByContinuityGroup } from "@/modules/bank-hours/service";
import { resolveBankHoursScheduledWindow } from "@/modules/bank-hours/window";

const apply = process.argv.includes("--apply");

// Janela como era antes do recorte: sem informar a saída efetiva.
function scheduledEndBeforeClamp(members: ContinuityOccupancy[]) {
    const group = buildContinuityGroups(members)[0]!;
    return resolveBankHoursScheduledWindow({
        domain: group.tail.domain,
        startedAt: group.tail.startedAt,
        shiftLabel: group.tail.shiftLabel,
        scheduledStartAt: group.tail.scheduledStartAt,
        scheduledEndAt: group.tail.scheduledEndAt,
    }).scheduledEndAt;
}

async function main() {
    const db = getDb();

    const occupancies = await db.execute(sql`
        select id as "occupancyId", 'regulation' as domain, doctor_id as "doctorId",
               continuity_group_id as "continuityGroupId", started_at as "startedAt",
               ended_at as "endedAt", actual_ended_at as "actualEndedAt",
               departure_confirmed_at as "departureConfirmedAt",
               scheduled_start_at as "scheduledStartAt", scheduled_end_at as "scheduledEndAt",
               shift_label as "shiftLabel"
        from operations_v2.regulation_occupancies
        union all
        select id, 'intervention', doctor_id, continuity_group_id, started_at, ended_at,
               actual_ended_at, departure_confirmed_at, scheduled_start_at, scheduled_end_at, shift_label
        from operations_v2.intervention_occupancies
    `) as unknown as ContinuityOccupancy[];

    const byGroup = new Map<string, ContinuityOccupancy[]>();
    for (const row of occupancies) {
        const list = byGroup.get(row.continuityGroupId) ?? [];
        list.push(row);
        byGroup.set(row.continuityGroupId, list);
    }

    const affected: Array<{ groupId: string; doctorId: string; before: string; after: string; balance: number }> = [];

    for (const [groupId, members] of byGroup) {
        const span = buildContinuityBankHoursSpan(members);
        if (!span.isClosed || !span.scheduledStartAt || !span.scheduledEndAt || !span.actualEndAt) {
            continue;
        }
        const before = scheduledEndBeforeClamp(members);
        if (!before || before.getTime() === span.scheduledEndAt.getTime()) {
            continue;
        }

        const calculation = applyAnomalyGuard(calculateBankHours({
            scheduledStartAt: span.scheduledStartAt,
            scheduledEndAt: span.scheduledEndAt,
            actualStartAt: span.actualStartAt,
            actualEndAt: span.actualEndAt,
        }));

        affected.push({
            groupId,
            doctorId: span.doctorId,
            before: before.toISOString(),
            after: span.scheduledEndAt.toISOString(),
            balance: calculation.balanceMinutes,
        });
    }

    console.log(`grupos com janela recortada: ${affected.length}`);
    console.log(`saldo total após recálculo nesses grupos: ${affected.reduce((sum, row) => sum + row.balance, 0)} min`);

    if (!apply) {
        console.log("dry-run — nada gravado. Rode com --apply para persistir.");
        return;
    }

    let done = 0;
    for (const row of affected) {
        await syncBankHoursByContinuityGroup(db, row.groupId);
        done++;
        if (done % 25 === 0) {
            console.log(`  ${done}/${affected.length}`);
        }
    }
    console.log(`recalculados ${done} grupos.`);
}

main()
    .catch((error) => {
        console.error(error);
        process.exitCode = 1;
    })
    .finally(() => closeDb());

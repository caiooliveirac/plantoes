/**
 * Levanta as permanências de 6h ou mais além do previsto que nunca viraram
 * plantão na folha — o passivo que a régua nova (classifyExtendedStay) passa a
 * resolver na origem, mas que já aconteceu.
 *
 * Enquanto o excedente longo era tratado como anomalia, esses plantões eram
 * zerados em silêncio: o médico ficou o turno seguinte inteiro na posição, a
 * folha pagou um plantão só e o banco creditou nada. Este script não grava
 * nada — imprime a lista para a chefia lançar em /admin/payment-closing.
 *
 * Uso:
 *   tsx scripts/audit-extended-stay-shifts.ts
 *   tsx scripts/audit-extended-stay-shifts.ts --csv
 */
import { sql } from "drizzle-orm";
import { closeDb, getDb } from "@/db";
import { applyAnomalyGuard, calculateBankHours } from "@/modules/bank-hours/calculator";
import {
    buildContinuityBankHoursSpan,
    type ContinuityOccupancy,
} from "@/modules/bank-hours/continuity";
import { describeExtendedStay } from "@/modules/operational/extended-stay";

const asCsv = process.argv.includes("--csv");

const SAO_PAULO_DAY = new Intl.DateTimeFormat("pt-BR", {
    timeZone: "America/Sao_Paulo",
    dateStyle: "short",
});

interface OccupancyRow extends ContinuityOccupancy {
    doctorName: string;
    targetCode: string;
}

async function main() {
    const db = getDb();

    const occupancies = await db.execute(sql`
        select o.id as "occupancyId", 'regulation' as domain, o.doctor_id as "doctorId",
               o.continuity_group_id as "continuityGroupId", o.started_at as "startedAt",
               o.ended_at as "endedAt", o.actual_ended_at as "actualEndedAt",
               o.departure_confirmed_at as "departureConfirmedAt",
               o.scheduled_start_at as "scheduledStartAt", o.scheduled_end_at as "scheduledEndAt",
               o.shift_label as "shiftLabel", d.full_name as "doctorName", p.code as "targetCode"
        from operations_v2.regulation_occupancies o
        join operations_v2.doctors d on d.id = o.doctor_id
        join operations_v2.regulation_posts p on p.id = o.post_id
        union all
        select o.id, 'intervention', o.doctor_id, o.continuity_group_id, o.started_at,
               o.ended_at, o.actual_ended_at, o.departure_confirmed_at,
               o.scheduled_start_at, o.scheduled_end_at, o.shift_label, d.full_name, b.code
        from operations_v2.intervention_occupancies o
        join operations_v2.doctors d on d.id = o.doctor_id
        join operations_v2.intervention_bases b on b.id = o.base_id
    `) as unknown as OccupancyRow[];

    // Cruzamento obrigatório: a chefia já lançou 163 extras à mão desde abril, e
    // propor de novo o mesmo dia é pagar duas vezes. Chave por médico+dia.
    const lancados = new Set(
        ((await db.execute(sql`
            select doctor_id as "doctorId", operational_date::text as "operationalDate"
            from operations_v2.admin_extra_shifts
        `)) as unknown as Array<{ doctorId: string; operationalDate: string }>)
            .map((row) => `${row.doctorId}:${row.operationalDate}`),
    );

    const byGroup = new Map<string, OccupancyRow[]>();
    for (const row of occupancies) {
        byGroup.set(row.continuityGroupId, [...(byGroup.get(row.continuityGroupId) ?? []), row]);
    }

    const pendencies: Array<{
        doctorName: string;
        day: string;
        target: string;
        overtimeMinutes: number;
        fullShifts: number;
        halfShifts: number;
        groupId: string;
        alreadyFiled: boolean;
    }> = [];

    for (const [groupId, members] of byGroup) {
        const span = buildContinuityBankHoursSpan(members);
        if (!span.isClosed || !span.scheduledStartAt || !span.scheduledEndAt || !span.actualEndAt) {
            continue;
        }

        const calculation = applyAnomalyGuard(calculateBankHours({
            scheduledStartAt: span.scheduledStartAt,
            scheduledEndAt: span.scheduledEndAt,
            actualStartAt: span.actualStartAt,
            actualEndAt: span.actualEndAt,
        }));
        if (!calculation.extendedStay) {
            continue;
        }

        const tail = members[members.length - 1]!;
        const operationalDate = span.scheduledEndAt.toISOString().slice(0, 10);
        pendencies.push({
            alreadyFiled: lancados.has(`${span.doctorId}:${operationalDate}`),
            doctorName: tail.doctorName,
            // O plantão a assinar é o do turno em que a permanência aconteceu:
            // conta a partir do fim previsto, não da chegada.
            day: SAO_PAULO_DAY.format(span.scheduledEndAt),
            target: members.map((member) => member.targetCode).join(" -> "),
            overtimeMinutes: calculation.extendedStay.overtimeMinutes,
            fullShifts: calculation.extendedStay.fullShifts,
            halfShifts: calculation.extendedStay.halfShifts,
            groupId,
        });
    }

    pendencies.sort((left, right) => left.day.localeCompare(right.day));

    if (asCsv) {
        console.log("medico;dia;posicao;permanencia_min;inteiros;meios;ja_lancado;grupo");
        for (const row of pendencies) {
            console.log([row.doctorName, row.day, row.target, row.overtimeMinutes, row.fullShifts, row.halfShifts, row.alreadyFiled ? "ja_lancado" : "", row.groupId].join(";"));
        }
    } else {
        for (const row of pendencies) {
            const proposta = describeExtendedStay({
                overtimeMinutes: row.overtimeMinutes,
                fullShifts: row.fullShifts,
                halfShifts: row.halfShifts,
                bankMinutes: 0,
            });
            const marca = row.alreadyFiled ? "  [JÁ TEM EXTRA LANÇADO NESSE DIA — conferir antes]" : "";
            console.log(`${row.day}  ${row.doctorName} (${row.target}): ficou ${(row.overtimeMinutes / 60).toFixed(1)}h além do previsto — ${proposta}${marca}`);
        }
    }

    const inteiros = pendencies.reduce((sum, row) => sum + row.fullShifts, 0);
    const meios = pendencies.reduce((sum, row) => sum + row.halfShifts, 0);
    const conferir = pendencies.filter((row) => row.alreadyFiled).length;
    console.log(`\n${pendencies.length} permanências a assinar: ${inteiros} plantões inteiros + ${meios} meios.`);
    if (conferir > 0) {
        console.log(`${conferir} já têm plantão extra lançado no mesmo dia — conferir uma a uma antes de lançar.`);
    }
    console.log("Nada gravado por este script.");
}

main()
    .catch((error) => {
        console.error(error);
        process.exitCode = 1;
    })
    .finally(() => closeDb());

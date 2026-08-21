/**
 * Reparo das entradas de banco de horas cuja janela ficou gravada na fronteira
 * de rendição (07:15 / 19:15) em vez de 07:00 / 19:00.
 *
 * A normalização existia só para a regulação; na intervenção as ocupações
 * gravadas em :15 tiveram o excedente medido do lugar errado e o médico perdeu
 * 15 min de crédito (dobrados quando chegou no horário). O `rebuild-bank-hours`
 * não pega esses casos porque compara a entrada com ela mesma — recalcula com a
 * janela ARMAZENADA, que é justamente a errada. Aqui a seleção é pela fronteira
 * e o recálculo passa pelo caminho normal (`sync*BankHours`), que resolve a
 * janela de novo.
 *
 * Uso (sempre a partir do servidor, com o .env.production carregado):
 *   npx tsx scripts/repair-quarter-boundary-bank-hours.ts           # dry-run
 *   npx tsx scripts/repair-quarter-boundary-bank-hours.ts --apply   # aplica
 */

import { closeDb, getDb } from "@/db";
import { bankHoursEntries } from "@/db/schema";
import { calculateBankHours } from "@/modules/bank-hours/calculator";
import { syncInterventionBankHours, syncRegulationBankHours } from "@/modules/bank-hours/service";
import { resolveBankHoursScheduledWindow } from "@/modules/bank-hours/window";

const SAO_PAULO_HOUR_MINUTE = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Sao_Paulo",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
});

function isQuarterBoundary(date: Date) {
    const parts = SAO_PAULO_HOUR_MINUTE.formatToParts(date);
    const hour = Number(parts.find((part) => part.type === "hour")?.value ?? "0");
    const minute = Number(parts.find((part) => part.type === "minute")?.value ?? "0");
    return minute === 15 && (hour === 7 || hour === 19);
}

function formatSaoPaulo(date: Date) {
    return date.toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" });
}

async function main() {
    const apply = process.argv.includes("--apply");
    const db = getDb();

    const entries = await db.query.bankHoursEntries.findMany({
        orderBy: (table, { asc }) => [asc(table.scheduledStartAt)],
    });
    const targets = entries.filter((entry) => isQuarterBoundary(entry.scheduledEndAt));

    const preview = targets.map((entry) => {
        const domain = entry.sourceType === "regulation" ? "regulation" as const : "intervention" as const;
        const occupancyId = domain === "regulation"
            ? entry.regulationOccupancyId
            : entry.interventionOccupancyId;

        const window = resolveBankHoursScheduledWindow({
            domain,
            startedAt: entry.actualStartAt,
            shiftLabel: null,
            scheduledStartAt: entry.scheduledStartAt,
            scheduledEndAt: entry.scheduledEndAt,
            actualEndAt: entry.actualEndAt,
        });
        const desired = calculateBankHours({
            scheduledStartAt: window.scheduledStartAt ?? entry.scheduledStartAt,
            scheduledEndAt: window.scheduledEndAt ?? entry.scheduledEndAt,
            actualStartAt: entry.actualStartAt,
            actualEndAt: entry.actualEndAt,
        });

        return {
            entryId: entry.id,
            domain,
            occupancyId,
            doctorId: entry.doctorId,
            scheduledEndAt: formatSaoPaulo(entry.scheduledEndAt),
            actualEndAt: formatSaoPaulo(entry.actualEndAt),
            stored: { overtime: entry.overtimeMinutes, balance: entry.balanceMinutes, rule: entry.ruleCode },
            desired: { overtime: desired.overtimeMinutes, balance: desired.balanceMinutes, rule: desired.ruleCode },
            changes: desired.balanceMinutes !== entry.balanceMinutes,
        };
    });

    console.log(JSON.stringify({
        mode: apply ? "apply" : "dry-run",
        totalEntries: entries.length,
        quarterBoundaryEntries: targets.length,
        wouldChange: preview.filter((item) => item.changes).length,
        preview,
    }, null, 2));

    if (!apply) {
        await closeDb();
        return;
    }

    const failures: Array<{ entryId: string; message: string }> = [];
    let applied = 0;
    for (const item of preview) {
        if (!item.occupancyId) {
            failures.push({ entryId: item.entryId, message: "entrada sem occupancyId" });
            continue;
        }
        try {
            if (item.domain === "regulation") {
                await syncRegulationBankHours(db, item.occupancyId);
            } else {
                await syncInterventionBankHours(db, item.occupancyId);
            }
            applied += 1;
        } catch (error) {
            failures.push({
                entryId: item.entryId,
                message: error instanceof Error ? error.message : "erro desconhecido",
            });
        }
    }

    console.log(JSON.stringify({ applied, failed: failures.length, failures }, null, 2));
    await closeDb();
}

main().catch(async (error) => {
    console.error(error);
    await closeDb().catch(() => undefined);
    process.exitCode = 1;
});

import { closeDb, getDb } from "@/db";
import { bankHoursEntries } from "@/db/schema";
import {
    BANK_HOURS_RULE_VERSION,
    calculateBankHours,
} from "@/modules/bank-hours/calculator";
import {
    syncInterventionBankHours,
    syncRegulationBankHours,
} from "@/modules/bank-hours/service";

type BankHoursEntry = typeof bankHoursEntries.$inferSelect;
type ComparedEntry = {
    entry: BankHoursEntry;
    desired: ReturnType<typeof calculateBankHours>;
    mismatchReasons: string[];
};

function hasFlag(flag: string) {
    return process.argv.includes(flag);
}

function compareStoredCalculation(entry: BankHoursEntry) {
    const desired = calculateBankHours({
        scheduledStartAt: entry.scheduledStartAt,
        scheduledEndAt: entry.scheduledEndAt,
        actualStartAt: entry.actualStartAt,
        actualEndAt: entry.actualEndAt,
    });
    const mismatchReasons: string[] = [];

    if (entry.arrivalDelayMinutes !== desired.arrivalDelayMinutes) {
        mismatchReasons.push("arrival-delay");
    }

    if (entry.overtimeMinutes !== desired.overtimeMinutes) {
        mismatchReasons.push("overtime");
    }

    if (entry.overtimeMultiplier !== desired.overtimeMultiplier) {
        mismatchReasons.push("overtime-multiplier");
    }

    if (entry.creditedOvertimeMinutes !== desired.creditedOvertimeMinutes) {
        mismatchReasons.push("credited-overtime");
    }

    if (entry.balanceMinutes !== desired.balanceMinutes) {
        mismatchReasons.push("balance");
    }

    if (entry.ruleCode !== desired.ruleCode) {
        mismatchReasons.push("rule-code");
    }

    return {
        entry,
        desired,
        mismatchReasons,
    } satisfies ComparedEntry;
}

function selectOccupancy(entry: BankHoursEntry) {
    if (entry.sourceType === "regulation") {
        return {
            domain: "regulation" as const,
            occupancyId: entry.regulationOccupancyId,
        };
    }

    return {
        domain: "intervention" as const,
        occupancyId: entry.interventionOccupancyId,
    };
}

function serializeEntry(compared: ComparedEntry) {
    const { domain, occupancyId } = selectOccupancy(compared.entry);
    return {
        entryId: compared.entry.id,
        domain,
        occupancyId,
        calculationVersion: compared.entry.calculationVersion,
        scheduledStartAt: compared.entry.scheduledStartAt.toISOString(),
        scheduledEndAt: compared.entry.scheduledEndAt.toISOString(),
        actualStartAt: compared.entry.actualStartAt.toISOString(),
        actualEndAt: compared.entry.actualEndAt.toISOString(),
        stored: {
            arrivalDelayMinutes: compared.entry.arrivalDelayMinutes,
            overtimeMinutes: compared.entry.overtimeMinutes,
            overtimeMultiplier: compared.entry.overtimeMultiplier,
            creditedOvertimeMinutes: compared.entry.creditedOvertimeMinutes,
            balanceMinutes: compared.entry.balanceMinutes,
            ruleCode: compared.entry.ruleCode,
        },
        desired: {
            arrivalDelayMinutes: compared.desired.arrivalDelayMinutes,
            overtimeMinutes: compared.desired.overtimeMinutes,
            overtimeMultiplier: compared.desired.overtimeMultiplier,
            creditedOvertimeMinutes: compared.desired.creditedOvertimeMinutes,
            balanceMinutes: compared.desired.balanceMinutes,
            ruleCode: compared.desired.ruleCode,
        },
        mismatchReasons: compared.mismatchReasons,
    };
}

async function main() {
    const db = getDb();
    const apply = hasFlag("--apply");
    const includeAllStale = hasFlag("--all-stale");

    const entries = await db.query.bankHoursEntries.findMany({
        orderBy: (table, { asc }) => [asc(table.scheduledStartAt), asc(table.createdAt)],
    });

    const comparedEntries = entries.map(compareStoredCalculation);
    const staleEntries = comparedEntries.filter(({ entry }) => entry.calculationVersion < BANK_HOURS_RULE_VERSION);
    const mismatchEntries = comparedEntries.filter((entry) => entry.mismatchReasons.length > 0);
    const targetEntries = includeAllStale
        ? staleEntries
        : mismatchEntries;

    console.log(JSON.stringify({
        ruleVersion: BANK_HOURS_RULE_VERSION,
        mode: includeAllStale ? "all-stale" : "mismatch-only",
        staleCount: staleEntries.length,
        mismatchCount: mismatchEntries.length,
        targetCount: targetEntries.length,
        preview: targetEntries.slice(0, 50).map(serializeEntry),
    }, null, 2));

    if (!apply || targetEntries.length === 0) {
        await closeDb();
        return;
    }

    const failures: Array<{ entryId: string; message: string }> = [];
    let applied = 0;

    for (const compared of targetEntries) {
        const { entry } = compared;
        const { domain, occupancyId } = selectOccupancy(entry);
        if (!occupancyId) {
            failures.push({
                entryId: entry.id,
                message: "Linha sem occupancyId correspondente para recálculo.",
            });
            continue;
        }

        try {
            if (domain === "regulation") {
                await syncRegulationBankHours(db, occupancyId);
            } else {
                await syncInterventionBankHours(db, occupancyId);
            }
            applied += 1;
        } catch (error) {
            failures.push({
                entryId: entry.id,
                message: error instanceof Error ? error.message : "Erro desconhecido no recálculo.",
            });
        }
    }

    console.log(JSON.stringify({
        applied,
        failed: failures.length,
        failures,
    }, null, 2));

    await closeDb();
}

main().catch(async (error) => {
    console.error(error);
    await closeDb().catch(() => undefined);
    process.exitCode = 1;
});
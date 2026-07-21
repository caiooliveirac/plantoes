/**
 * Captura snapshots de equivalência do payment-closing para validar refactors
 * de performance sem mudança de comportamento.
 *
 * Uso: DATABASE_URL=... npx tsx scripts/perf-baseline-payment-closing.ts <outDir> [meses...]
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getChiefPayableShiftsBoard } from "@/services/payable-shifts.service";
import { getDoctorBankHoursEffectiveBalances } from "@/services/bank-hours-history.service";

async function main() {
    const outDir = process.argv[2];
    if (!outDir) {
        throw new Error("uso: perf-baseline-payment-closing.ts <outDir> [meses...]");
    }
    const months = process.argv.slice(3);
    if (months.length === 0) {
        months.push("2026-04", "2026-05", "2026-06", "2026-07");
    }
    mkdirSync(outDir, { recursive: true });

    for (const month of months) {
        const board = await getChiefPayableShiftsBoard(month);
        writeFileSync(join(outDir, `board-${month}.json`), JSON.stringify(board, null, 1));
        console.log(`board-${month}.json ok (${board.doctors.length} médicos, ${board.payableShifts.length} shifts)`);
    }

    const balances = await getDoctorBankHoursEffectiveBalances();
    const sorted = Object.fromEntries([...balances.entries()].sort((a, b) => a[0].localeCompare(b[0])));
    writeFileSync(join(outDir, "bank-balances.json"), JSON.stringify(sorted, null, 1));
    console.log(`bank-balances.json ok (${balances.size} médicos)`);
    process.exit(0);
}

void main();

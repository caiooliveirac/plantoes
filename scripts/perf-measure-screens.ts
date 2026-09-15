/**
 * Medição das duas telas lentas (banco de horas e payment-closing) contra um
 * dump de produção restaurado localmente.
 *
 * Uso: DATABASE_URL=... npx tsx scripts/perf-measure-screens.ts [outDir] [mês]
 *
 * Mede tempo por fase, nº de queries e linhas lidas (pg_stat_database) e o
 * tamanho do JSON (proxy do payload RSC). Com outDir, grava snapshots para
 * comparar byte a byte antes/depois de refactors.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { getDb } from "@/db";
import { getChiefPayableShiftsBoard, perfEvents } from "@/services/payable-shifts.service";
import { getBankHoursHistory, getBankHoursHistorySummary, getDoctorBankHoursEffectiveBalances } from "@/services/bank-hours-history.service";

async function dbStats() {
    const rows = await getDb().execute(sql`
        select tup_returned::bigint as returned, tup_fetched::bigint as fetched,
               xact_commit::bigint + xact_rollback::bigint as xacts
        from pg_stat_database where datname = current_database()
    `) as unknown as { returned: string; fetched: string; xacts: string }[];
    return { returned: Number(rows[0].returned), fetched: Number(rows[0].fetched), xacts: Number(rows[0].xacts) };
}

async function measure<T>(label: string, fn: () => Promise<T>): Promise<T> {
    perfEvents.length = 0;
    const before = await dbStats();
    const t0 = performance.now();
    const value = await fn();
    const ms = performance.now() - t0;
    const after = await dbStats();
    const json = JSON.stringify(value);
    console.log(`\n=== ${label} ===`);
    for (const e of perfEvents) {
        console.log(`  ${e.label.padEnd(44)} ${e.ms.toFixed(1).padStart(8)} ms  ${e.extra ?? ""}`);
    }
    console.log(`  ${"TOTAL".padEnd(44)} ${ms.toFixed(1).padStart(8)} ms`);
    console.log(`  tup_returned: ${(after.returned - before.returned).toLocaleString()}  tup_fetched: ${(after.fetched - before.fetched).toLocaleString()}  xacts: ${after.xacts - before.xacts}`);
    console.log(`  JSON: ${(json.length / 1024).toFixed(0)} KiB`);
    return value;
}

// Campos que dependem do relógio (não do dado) saem do snapshot; o
// projectedDepletionDate herda a hora do asOf, então fica só a data.
function stable(value: unknown) {
    return JSON.stringify(value, (key, v) => {
        if (key === "generatedAt" || key === "computedAt" || key === "asOf") return "<ts>";
        if (key === "projectedDepletionDate" && typeof v === "string") return v.slice(0, 10);
        return v;
    }, 1);
}

async function main() {
    const outDir = process.argv[2] ?? null;
    const month = process.argv[3] ?? "2026-09";

    await measure("warmup: payment-closing " + month, () => getChiefPayableShiftsBoard(month));
    const board = await measure("payment-closing " + month, () => getChiefPayableShiftsBoard(month));
    const balances = await measure("bank balances (balancesOnly)", () => getDoctorBankHoursEffectiveBalances());
    const history = await measure("bank-hours history (full)", () => getBankHoursHistory());
    const history2 = await measure("bank-hours history (full, 2ª)", () => getBankHoursHistory());
    const summary = await measure("bank-hours summary (lista da tela)", () => getBankHoursHistorySummary());
    const firstDoctorId = summary.doctors.find((doctor) => doctor.months.length > 0)?.doctorId ?? null;
    if (firstDoctorId) {
        await measure(`bank-hours detail (1 médico ${firstDoctorId.slice(0, 8)})`, () => getBankHoursHistory({ doctorId: firstDoctorId }));
    }

    console.log("\n=== estrutura ===");
    console.log("board.doctors:", board.doctors.length, "days:", board.days.length, "payableShifts:", board.payableShifts.length);
    console.log("history.doctors:", history.doctors.length, "shifts:", history.doctors.reduce((s, d) => s + d.shifts.length, 0), "settlements:", history.doctors.reduce((s, d) => s + d.settlements.length, 0));
    const sizes = Object.entries(history.doctors[0] ?? {}).map(([k, v]) => [k, JSON.stringify(v).length] as const);
    console.log("bytes por chave (1º médico):", sizes.filter(([, n]) => n > 200).map(([k, n]) => `${k}=${(n / 1024).toFixed(1)}KiB`).join(" "));

    if (outDir) {
        mkdirSync(outDir, { recursive: true });
        writeFileSync(join(outDir, `board-${month}.json`), stable(board));
        writeFileSync(join(outDir, "bank-balances.json"), stable(Object.fromEntries([...balances.entries()].sort((a, b) => a[0].localeCompare(b[0])))));
        writeFileSync(join(outDir, "bank-history.json"), stable(history));
        writeFileSync(join(outDir, "bank-history-2.json"), stable(history2));
        console.log("snapshots em", outDir);
    }
    process.exit(0);
}

void main();

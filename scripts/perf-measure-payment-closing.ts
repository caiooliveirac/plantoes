/**
 * Medição do getChiefPayableShiftsBoard contra o dump de produção restaurado
 * em plantoes_perf_test. Roda 3x (1 fria + 2 quentes) e mede também o tamanho
 * do JSON serializado (proxy do payload RSC).
 */
import { getChiefPayableShiftsBoard, perfEvents } from "@/services/payable-shifts.service";


const month = process.argv[2] ?? "2026-06";

async function run(label: string) {
    perfEvents.length = 0;
    const t0 = performance.now();
    const board = await getChiefPayableShiftsBoard(month);
    const total = performance.now() - t0;
    const tSer = performance.now();
    const json = JSON.stringify(board);
    const serMs = performance.now() - tSer;
    console.log(`\n=== ${label} — mês ${month} ===`);
    for (const e of perfEvents) {
        console.log(`  ${e.label.padEnd(42)} ${e.ms.toFixed(1).padStart(8)} ms  ${e.extra ?? ""}`);
    }
    console.log(`  ${"TOTAL getChiefPayableShiftsBoard".padEnd(42)} ${total.toFixed(1).padStart(8)} ms`);
    console.log(`  ${"JSON.stringify(board)".padEnd(42)} ${serMs.toFixed(1).padStart(8)} ms  ${(json.length / 1024).toFixed(0)} KiB`);
    return { board, json };
}

async function main() {
const r1 = await run("run 1 (fria)");
await run("run 2 (quente)");
await run("run 3 (quente)");

// Estatísticas do payload
const b = r1.board;
const cellShiftCount = b.doctors.reduce((s: number, d: { cells: { shifts: unknown[] }[] }) => s + d.cells.reduce((cs: number, c) => cs + c.shifts.length, 0), 0);
console.log("\n=== Estrutura do payload ===");
console.log("doctors:", b.doctors.length);
console.log("days:", b.days.length);
console.log("células (doctors × days):", b.doctors.length * b.days.length);
console.log("shifts dentro de cells:", cellShiftCount);
console.log("payableShifts (lista plana duplicada):", b.payableShifts.length);
console.log("attestationSegments:", b.attestationSegments.length);
console.log("targetOptions:", b.targetOptions.length);
console.log("disabledTargets:", b.disabledTargets.length);
console.log("uncoveredTargets:", b.uncoveredTargets.length);
console.log("allDoctorNames:", b.allDoctorNames.length);
const sizes: Record<string, number> = {};
for (const key of Object.keys(b) as Array<keyof typeof b>) {
    sizes[String(key)] = JSON.stringify(b[key]).length;
}
console.log("\nBytes por chave do board:");
for (const [k, v] of Object.entries(sizes).sort((a, b2) => b2[1] - a[1])) {
    console.log(`  ${k.padEnd(24)} ${(v / 1024).toFixed(1).padStart(8)} KiB`);
}

process.exit(0);
}
void main();

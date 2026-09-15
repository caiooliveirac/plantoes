/**
 * Equivalência do detalhe por médico (getBankHoursHistory({ doctorId })) com a
 * fatia dele no histórico completo — é o que a tela gerencial passa a usar ao
 * abrir um médico. Compara byte a byte, médico por médico.
 *
 * Uso: DATABASE_URL=... npx tsx scripts/perf-verify-bank-hours-detail.ts
 */
import { getBankHoursHistory } from "@/services/bank-hours-history.service";

function stable(value: unknown) {
    return JSON.stringify(value, (key, v) => (key === "generatedAt" ? "<ts>" : v));
}

async function main() {
    const full = await getBankHoursHistory();
    let checked = 0;
    let different = 0;
    for (const doctor of full.doctors) {
        const detail = await getBankHoursHistory({ doctorId: doctor.doctorId });
        const mine = detail.doctors.find((row) => row.doctorId === doctor.doctorId) ?? null;
        checked += 1;
        if (stable(mine) !== stable(doctor)) {
            different += 1;
            const before = stable(doctor);
            const after = stable(mine);
            let at = 0;
            while (at < before.length && before[at] === after[at]) at += 1;
            console.log(`DIFERE ${doctor.doctorName} (${doctor.doctorId}) @${at}: …${before.slice(Math.max(0, at - 80), at + 120)}… vs …${after.slice(Math.max(0, at - 80), at + 120)}…`);
        }
    }
    console.log(`${checked} médicos comparados, ${different} diferentes`);
    process.exit(different === 0 ? 0 : 1);
}

void main();

/**
 * Leitura (read-only) da sessão de refeições vigente: roster, atribuições,
 * estágio e filas pendentes. Não grava nada.
 *
 *   npx tsx scripts/inspect-meal-break-session.ts [--date YYYY-MM-DD] [--night]
 */
import { closeDb } from "@/db";
import { getCurrentOperationalMealBreakSession } from "@/modules/telegram/meal-breaks";

function readArg(flag: string) {
    const index = process.argv.indexOf(flag);
    return index >= 0 ? process.argv[index + 1] ?? null : null;
}

async function main() {
    const dateArg = readArg("--date");
    const referenceAt = dateArg ? new Date(`${dateArg}T15:00:00.000Z`) : new Date();
    const session = await getCurrentOperationalMealBreakSession(referenceAt);

    if (!session) {
        console.log("Nenhuma sessão de refeições vigente para este dia/modo.");
        return;
    }

    console.log(`modo=${session.mode} dia=${session.operationalDate} estágio=${session.stage}`);
    console.log(`recip=${session.recipRamal ?? "-"} mrv=[${session.mrvRamals.join(", ")}] mrvLunch12:30=${session.mrvLunch1230Ramal ?? "-"} chefia=${session.chiefRamal ?? "-"}`);
    console.log(`\nRoster (${session.roster.length}):`);
    for (const doctor of session.roster) {
        const lunch = session.lunchAssignments[doctor.ramal] ?? "--";
        const rest = session.restAssignments[doctor.ramal] ?? "--";
        console.log(`  ${doctor.ramal.padEnd(6)} ${doctor.name.slice(0, 28).padEnd(30)} papel=${(doctor.roleLabel ?? "-").padEnd(6)} almoço=${lunch.padEnd(6)} descanso=${rest}`);
    }
    console.log(`\nfila de almoço pendente: [${session.lunchQueue.join(", ")}]`);
    console.log(`fila de descanso pendente: [${session.restQueue.join(", ")}]`);
    console.log(`capacidades almoço: ${JSON.stringify(session.lunchCapacities)}`);
    console.log(`capacidades descanso: ${JSON.stringify(session.restChoiceCapacities)}`);
    console.log(`\núltimos eventos:`);
    for (const event of session.events.slice(-12)) {
        console.log(`  ${event.recordedAt}  ${event.type.padEnd(26)} ${event.ramal ?? ""} ${event.slot ?? ""}`);
    }
}

main()
    .catch((error) => {
        console.error(error instanceof Error ? error.message : error);
        process.exitCode = 1;
    })
    .finally(async () => {
        await closeDb();
    });

/**
 * Restaura a divisão DIURNA a partir do resumo que o bot publicou no grupo.
 *
 * Para quê: os pontos de restauração automáticos (/almoco restaurar) só valem
 * do deploy em diante. Para uma divisão anterior a isso — ou cuja linha viva já
 * foi sobrescrita — o balão "✅ Divisão fechada!" do grupo é a única cópia
 * completa que sobrou, e ele é uma serialização do próprio estado.
 *
 * Uso (no Mac, com .env.production apontando para o banco de produção):
 *
 *   # 1) Simula e mostra o mapeamento nome -> ramal (NÃO grava):
 *   pbpaste | npx tsx scripts/restore-meal-break-session.ts
 *
 *   # 2) Confere o mapeamento e grava:
 *   pbpaste | npx tsx scripts/restore-meal-break-session.ts --apply
 *
 * Opções: --chat <id> (fixa o chat, em vez de descobrir a sessão do dia),
 *         --date <YYYY-MM-DD> (dia operacional; padrão é hoje).
 */
import { closeDb } from "@/db";
import { restoreDayMealBreakFromSummary } from "@/modules/telegram/meal-breaks";

function readArg(flag: string) {
    const index = process.argv.indexOf(flag);
    return index >= 0 ? process.argv[index + 1] ?? null : null;
}

async function readStdin() {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) {
        chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks).toString("utf8");
}

async function main() {
    const apply = process.argv.includes("--apply");
    const chatId = readArg("--chat") ?? undefined;
    const dateArg = readArg("--date");
    // Meio-dia local evita que o dia operacional escorregue na virada de turno.
    const referenceAt = dateArg ? new Date(`${dateArg}T15:00:00.000Z`) : new Date();

    const summaryText = await readStdin();
    if (!summaryText.trim()) {
        console.error("Nada no stdin. Cole o balão do grupo, ex.: pbpaste | npx tsx scripts/restore-meal-break-session.ts");
        process.exitCode = 1;
        return;
    }

    const report = await restoreDayMealBreakFromSummary({
        chatId,
        referenceAt,
        summaryText,
        apply,
    });

    console.log(`\nMapeamento (${report.matched.length} médicos):`);
    for (const entry of [...report.matched].sort((left, right) => left.ramal.localeCompare(right.ramal))) {
        console.log(`  ${entry.ramal.padEnd(6)} ${entry.name.padEnd(26)} almoço=${entry.lunchSlot ?? "--"}  descanso=${entry.restSlot ?? "--"}`);
    }
    console.log(`\nRECIP: ${report.recipRamal ?? "(nenhum)"} · MRV: ${report.mrvRamals.join(", ") || "(nenhum)"}`);

    if (report.excludedBlocks.length > 0) {
        console.log("\nAtenção — blocos de exclusão NÃO são restaurados por este script:");
        for (const block of report.excludedBlocks) {
            console.log(`  ${block}`);
        }
    }

    if (report.unmatchedNames.length > 0) {
        console.error(`\nNada foi gravado: não achei no roster da sessão ${report.unmatchedNames.length} nome(s):`);
        for (const name of report.unmatchedNames) {
            console.error(`  - ${name}`);
        }
        console.error("Confira se a sessão do dia é a mesma do balão (o roster precisa conter essas pessoas).");
        process.exitCode = 1;
        return;
    }

    if (report.applied) {
        console.log(`\n✅ Divisão restaurada e gravada (estágio: ${report.session?.stage}). Um ponto de restauração foi criado antes de tudo.`);
    } else {
        console.log("\n(simulação — nada gravado). Rode de novo com --apply para gravar.");
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

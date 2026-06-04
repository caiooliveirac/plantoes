import { and, desc, eq, gte, ilike, lt, or } from "drizzle-orm";
import { closeDb, getDb } from "@/db";
import { doctors, regulationOccupancies, regulationPosts } from "@/db/schema";
import { isRegulationShadowOccupancyNotes } from "@/modules/regulation/service";
import { syncRegulationBankHours } from "@/modules/bank-hours/service";

/**
 * Backfill: corrige o incidente da sombra que expulsou a titular no ramal 2152.
 *
 * Bug (corrigido no código a partir desta branch): uma chegada de "sombra" na
 * REGULAÇÃO descartava o flag de sombra e fechava o ocupante ativo
 * incondicionalmente. Yngra entrou de sombra na 2152 e o login dela fechou a
 * ocupação ativa da Indira (endedAt/actualEndedAt setados) — Indira "sumiu".
 *
 * Este script, de forma IDEMPOTENTE e em DRY-RUN por padrão:
 *   1. Marca a ocupação da Yngra como sombra (prefixo "[telegram sombra]" nas
 *      notas), para o painel/pagamento/banco a tratarem como sombra coexistente.
 *   2. Reabre a ocupação da Indira que foi fechada pela chegada da Yngra
 *      (endedAt/actualEndedAt -> null), deixando-a ativa de novo.
 *   3. Recalcula banco de horas das duas ocupações.
 *
 * Uso (rodar LOCAL apontando DATABASE_URL para o banco alvo):
 *   tsx scripts/recover-yngra-shadow-2152.ts                 # dry-run, só mostra o plano
 *   tsx scripts/recover-yngra-shadow-2152.ts --apply         # aplica
 *   flags opcionais: --post=2152 --shadow=Yngra --active=Indira --date=2026-06-04
 *
 * Aborta com segurança se algo estiver ambíguo (médica não única, mais de uma
 * ocupação candidata, nada para fazer).
 */

function flag(name: string, fallback: string | null = null) {
    const prefix = `--${name}=`;
    return process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length) ?? fallback;
}

const APPLY = process.argv.includes("--apply");
const POST_CODE = flag("post", "2152") as string;
const SHADOW_NAME = flag("shadow", "Yngra") as string;
const ACTIVE_NAME = flag("active", "Indira") as string;
// Operational date the incident happened on (local). Defaults to today.
const DATE = flag("date", new Date().toISOString().slice(0, 10)) as string;

// Window of started_at to search for the incident's occupancies: from the
// operational date 00:00 local (~03:00Z) to +36h, covering an SD→SN span.
const windowStart = new Date(`${DATE}T00:00:00.000-03:00`);
const windowEnd = new Date(windowStart.getTime() + 36 * 60 * 60 * 1000);

function fmt(value: Date | null | undefined) {
    return value ? value.toISOString() : "null";
}

async function resolveUniqueDoctor(db: ReturnType<typeof getDb>, name: string) {
    const matches = await db.query.doctors.findMany({
        where: or(
            ilike(doctors.fullName, `%${name}%`),
            ilike(doctors.displayName, `%${name}%`),
            ilike(doctors.normalizedName, `%${name}%`),
        ),
        columns: { id: true, fullName: true, displayName: true },
    });
    if (matches.length === 0) {
        throw new Error(`Nenhuma médica encontrada para "${name}".`);
    }
    if (matches.length > 1) {
        const list = matches.map((m) => `  - ${m.fullName} (${m.id})`).join("\n");
        throw new Error(`"${name}" é ambíguo (${matches.length}):\n${list}\nRefine com o nome completo.`);
    }
    return matches[0];
}

async function main() {
    const db = getDb();

    console.log(`== Backfill sombra 2152 ==`);
    console.log(`modo: ${APPLY ? "APPLY (escreve)" : "DRY-RUN (não escreve)"}`);
    console.log(`post=${POST_CODE} shadow=${SHADOW_NAME} active=${ACTIVE_NAME} date=${DATE}`);
    console.log(`janela started_at: ${windowStart.toISOString()} .. ${windowEnd.toISOString()}\n`);

    const post = await db.query.regulationPosts.findFirst({
        where: eq(regulationPosts.code, POST_CODE),
        columns: { id: true, code: true },
    });
    if (!post) {
        throw new Error(`Posto de regulação com code=${POST_CODE} não encontrado.`);
    }

    const shadowDoctor = await resolveUniqueDoctor(db, SHADOW_NAME);
    const activeDoctor = await resolveUniqueDoctor(db, ACTIVE_NAME);
    console.log(`sombra:  ${shadowDoctor.fullName} (${shadowDoctor.id})`);
    console.log(`ativa:   ${activeDoctor.fullName} (${activeDoctor.id})\n`);

    // --- Ocupação da sombra (Yngra) na 2152 dentro da janela ---
    const shadowOccupancies = await db.query.regulationOccupancies.findMany({
        where: and(
            eq(regulationOccupancies.postId, post.id),
            eq(regulationOccupancies.doctorId, shadowDoctor.id),
            gte(regulationOccupancies.startedAt, windowStart),
            lt(regulationOccupancies.startedAt, windowEnd),
        ),
        orderBy: [desc(regulationOccupancies.startedAt)],
    });
    if (shadowOccupancies.length !== 1) {
        throw new Error(`Esperava exatamente 1 ocupação da sombra na 2152 na janela, achei ${shadowOccupancies.length}. Abortando.`);
    }
    const shadowOcc = shadowOccupancies[0];
    console.log(`sombra ocupação ${shadowOcc.id} started=${fmt(shadowOcc.startedAt)} ended=${fmt(shadowOcc.endedAt)} notes=${JSON.stringify(shadowOcc.notes)}`);

    // --- Ocupação da titular (Indira) fechada pela chegada da sombra ---
    // A vítima é a ocupação da titular cujo ended_at ≈ started_at da sombra.
    const activeOccupancies = await db.query.regulationOccupancies.findMany({
        where: and(
            eq(regulationOccupancies.postId, post.id),
            eq(regulationOccupancies.doctorId, activeDoctor.id),
            gte(regulationOccupancies.startedAt, windowStart),
            lt(regulationOccupancies.startedAt, windowEnd),
        ),
        orderBy: [desc(regulationOccupancies.startedAt)],
    });
    console.log(`titular: ${activeOccupancies.length} ocupação(ões) na janela.`);
    for (const occ of activeOccupancies) {
        console.log(`  - ${occ.id} started=${fmt(occ.startedAt)} ended=${fmt(occ.endedAt)} actualEnded=${fmt(occ.actualEndedAt)}`);
    }

    // A vítima: titular fechada em torno do horário de chegada da sombra (±10min).
    const shadowStartMs = shadowOcc.startedAt.getTime();
    const victim = activeOccupancies.find((occ) => (
        occ.endedAt !== null
        && Math.abs(occ.endedAt.getTime() - shadowStartMs) <= 10 * 60 * 1000
    )) ?? activeOccupancies.find((occ) => occ.endedAt !== null) ?? null;

    // --- Plano ---
    // Passos rodam dentro de UMA transação (tudo ou nada). Ordem importa: a sombra
    // precisa virar coexistente (board NULL + marcador) ANTES de reabrir a titular,
    // senão duas ocupações ativas COM board no mesmo posto violam o índice único
    // regulation_occupancies_one_active_board_per_post_idx.
    // tx is the drizzle transaction executor; typed loosely like the app's own
    // services (type Executor = any) to avoid PgTransaction/PgDatabase mismatch.
    const steps: Array<(tx: any) => Promise<void>> = [];

    const shadowAlreadyMarked = isRegulationShadowOccupancyNotes(shadowOcc.notes);
    const shadowBoardSet = shadowOcc.boardStartedAt !== null;
    if (shadowAlreadyMarked && !shadowBoardSet) {
        console.log(`\n[sombra] já é sombra coexistente (marcada + board nulo) — nada a fazer.`);
    } else {
        const newNotes = shadowAlreadyMarked
            ? (shadowOcc.notes ?? "")
            : `[telegram sombra] ${shadowOcc.notes ?? ""}`.trim();
        console.log(`\n[sombra] vou normalizar como sombra coexistente:`);
        if (!shadowAlreadyMarked) {
            console.log(`   notes: ${JSON.stringify(shadowOcc.notes)} -> ${JSON.stringify(newNotes)}`);
        }
        if (shadowBoardSet) {
            console.log(`   boardStartedAt: ${fmt(shadowOcc.boardStartedAt)} -> null (sai do índice de 1-ativo-com-board)`);
        }
        steps.push(async (tx) => {
            await tx.update(regulationOccupancies)
                .set({ notes: newNotes, boardStartedAt: null, updatedAt: new Date() })
                .where(eq(regulationOccupancies.id, shadowOcc.id));
            await syncRegulationBankHours(tx, shadowOcc.id);
        });
    }

    if (!victim) {
        console.log(`\n[titular] nenhuma ocupação fechada encontrada — talvez já reativada. Nada a fazer.`);
    } else if (victim.endedAt === null) {
        console.log(`\n[titular] ocupação ${victim.id} já está aberta — nada a fazer.`);
    } else {
        console.log(`\n[titular] vou reabrir ${victim.id} (fechada em ${fmt(victim.endedAt)}):`);
        console.log(`   endedAt: ${fmt(victim.endedAt)} -> null`);
        console.log(`   actualEndedAt: ${fmt(victim.actualEndedAt)} -> null`);
        steps.push(async (tx) => {
            await tx.update(regulationOccupancies)
                .set({ endedAt: null, actualEndedAt: null, updatedAt: new Date() })
                .where(eq(regulationOccupancies.id, victim.id));
            await syncRegulationBankHours(tx, victim.id);
        });
    }

    if (steps.length === 0) {
        console.log(`\nNada a aplicar. Estado já consistente.`);
        await closeDb();
        return;
    }

    if (!APPLY) {
        console.log(`\nDRY-RUN: ${steps.length} alteração(ões) planejada(s). Rode com --apply para escrever.`);
        await closeDb();
        return;
    }

    await db.transaction(async (tx) => {
        for (const step of steps) {
            await step(tx);
        }
    });
    console.log(`\nAplicado (transação): ${steps.length} alteração(ões). Banco de horas recalculado.`);
    await closeDb();
}

main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
});

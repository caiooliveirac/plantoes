import { and, isNull, sql } from "drizzle-orm";
import { closeDb, getDb } from "@/db";
import { interventionOccupancies, regulationOccupancies } from "@/db/schema";

/**
 * Saneamento: "[DESLOCADO]" gravado em cima de uma ocupação SOMBRA.
 *
 * Estado impossível. Sombra nunca teve o quadro — não há o que deslocar. Ele
 * nascia da regra antiga "sombra sozinha assume o quadro" (corrigida em #224):
 * a sombra registrada num posto vazio virava titular de fato, e a chegada do
 * titular real caía no portão de tomada, marcando a sombra como deslocada e
 * disparando o aviso de deslocamento no grupo e na coordenação.
 *
 * Caso de origem: Vaner Paulo na 2031, 23/08/2026, ocupação
 * ea3fd78d-5b97-4c77-a0bc-9257b6219a67. Em 90 dias havia 2 registros assim.
 *
 * O que o script faz, de forma IDEMPOTENTE: remove APENAS as linhas de marcador
 * "[DESLOCADO] ..." das notas, nas ocupações ABERTAS que também têm marcador de
 * sombra. Não toca em board_started_at (já é nulo, e é assim que tem de ficar),
 * não toca em started_at, não fecha nem reabre nada, não recalcula banco de horas
 * (a linha de nota não entra em nenhum cálculo).
 *
 * Uso (rodar LOCAL apontando DATABASE_URL para o banco alvo):
 *   tsx scripts/repair-shadow-marked-displaced.ts            # dry-run, só mostra o plano
 *   tsx scripts/repair-shadow-marked-displaced.ts --apply    # aplica
 */

const APPLY = process.argv.includes("--apply");

const SHADOW_PATTERN = /\[telegram sombra\]|\[sombra\]|\bsombras?\b|\bshadow\b/i;
const DISPLACED_MARKER = "[DESLOCADO]";

export function stripDisplacedMarkerLines(notes: string | null | undefined): string | null {
    const kept = (notes ?? "")
        .split("\n")
        .filter((line) => !line.includes(DISPLACED_MARKER));
    const cleaned = kept.join("\n").trim();
    return cleaned.length > 0 ? cleaned : null;
}

function isShadowNotes(notes: string | null | undefined) {
    return SHADOW_PATTERN.test(notes ?? "");
}

async function main() {
    const db = getDb();
    let planned = 0;

    for (const domain of ["regulation", "intervention"] as const) {
        const table = domain === "regulation" ? regulationOccupancies : interventionOccupancies;
        const rows = await db
            .select({ id: table.id, notes: table.notes, boardStartedAt: table.boardStartedAt })
            .from(table)
            .where(and(
                isNull(table.endedAt),
                sql`coalesce(${table.notes}, '') like ${"%" + DISPLACED_MARKER + "%"}`,
            ));

        for (const row of rows) {
            if (!isShadowNotes(row.notes)) {
                continue;
            }
            planned++;
            const nextNotes = stripDisplacedMarkerLines(row.notes);
            console.log(`\n[${domain}] ${row.id}`);
            console.log(`  antes : ${JSON.stringify(row.notes)}`);
            console.log(`  depois: ${JSON.stringify(nextNotes)}`);
            if (row.boardStartedAt !== null) {
                console.log("  ⚠️  board_started_at NÃO é nulo — pulando, revise à mão.");
                planned--;
                continue;
            }
            if (APPLY) {
                await db.update(table)
                    .set({ notes: nextNotes, updatedAt: new Date() })
                    .where(sql`${table.id} = ${row.id}`);
                console.log("  ✅ aplicado");
            }
        }
    }

    console.log(`\n${planned} ocupação(ões) sombra com marcador [DESLOCADO].`);
    console.log(APPLY ? "Aplicado." : "Dry-run — rode com --apply para gravar.");
}

// Só roda quando chamado direto — o helper puro acima é importado pelo teste.
if (require.main === module) {
    main()
        .catch((error) => {
            console.error(error);
            process.exitCode = 1;
        })
        .finally(() => closeDb());
}

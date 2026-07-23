import { and, asc, eq, isNull, lte } from "drizzle-orm";
import { closeDb, getDb } from "@/db";
import {
    interventionBaseDeactivations,
    interventionBases,
    regulationPostDeactivations,
    regulationPosts,
} from "@/db/schema";

/**
 * Repair script: neutraliza janelas de desativação órfãs.
 *
 * Uma janela órfã é uma linha em *_deactivations com reactivated_at NULL e
 * deactivated_at já no passado, num posto/base que está ATIVO (is_active = true).
 * Isso é uma contradição: o registro diz "desativado desde X, ainda desativado",
 * mas o posto/base está operacional (e normalmente com médico em plantão).
 *
 * Como surgia: a reativação-na-chegada fechava só a janela de desativação mais
 * recente. Com janelas sobrepostas, as antigas ficavam abertas para sempre. A
 * janela órfã fazia `is*DeactivationActive` retornar true e o remanejamento
 * tratar o posto/base como desativado — bloqueando inclusive a SAÍDA de quem
 * estava lá (incidente Camila Coutinho BR05 → CN10, 2026-07-23). O bug de
 * acúmulo foi corrigido em modules/{intervention,regulation}/service.ts; este
 * script sana o dado histórico já gravado.
 *
 * Neutralização: fecha a janela com reactivated_at = deactivated_at (duração
 * zero). Preserva a linha para auditoria, mas deixa claro que não teve efeito
 * operacional. NÃO toca janelas de postos/bases que estão realmente inativos
 * (is_active = false) — nesses a janela aberta é legítima.
 *
 * Uso:
 *   npx tsx scripts/repair-orphan-deactivation-windows.ts          # dry-run (preview)
 *   npx tsx scripts/repair-orphan-deactivation-windows.ts --apply  # aplica
 */

function hasFlag(flag: string) {
    return process.argv.includes(flag);
}

async function main() {
    const db = getDb();
    const applyMode = hasFlag("--apply");
    const now = new Date();
    let fixedCount = 0;

    // ── Intervenção ──────────────────────────────────────────────────
    const activeBases = await db.query.interventionBases.findMany({
        where: eq(interventionBases.isActive, true),
    });
    for (const base of activeBases) {
        const orphans = await db.query.interventionBaseDeactivations.findMany({
            where: and(
                eq(interventionBaseDeactivations.baseId, base.id),
                isNull(interventionBaseDeactivations.reactivatedAt),
                lte(interventionBaseDeactivations.deactivatedAt, now),
            ),
            orderBy: [asc(interventionBaseDeactivations.deactivatedAt)],
        });
        for (const orphan of orphans) {
            console.log(`[${applyMode ? "FIX" : "PREVIEW"}] base ${base.code} (ativa) — janela órfã ${orphan.id}`);
            console.log(`  deactivated_at: ${orphan.deactivatedAt.toISOString()} → reactivated_at anulado (= deactivated_at)`);
            if (applyMode) {
                await db.update(interventionBaseDeactivations)
                    .set({ reactivatedAt: orphan.deactivatedAt, updatedAt: now })
                    .where(eq(interventionBaseDeactivations.id, orphan.id));
            }
            fixedCount++;
        }
    }

    // ── Regulação ────────────────────────────────────────────────────
    const activePosts = await db.query.regulationPosts.findMany({
        where: eq(regulationPosts.isActive, true),
    });
    for (const post of activePosts) {
        const orphans = await db.query.regulationPostDeactivations.findMany({
            where: and(
                eq(regulationPostDeactivations.postId, post.id),
                isNull(regulationPostDeactivations.reactivatedAt),
                lte(regulationPostDeactivations.deactivatedAt, now),
            ),
            orderBy: [asc(regulationPostDeactivations.deactivatedAt)],
        });
        for (const orphan of orphans) {
            console.log(`[${applyMode ? "FIX" : "PREVIEW"}] posto ${post.code} (ativo) — janela órfã ${orphan.id}`);
            console.log(`  deactivated_at: ${orphan.deactivatedAt.toISOString()} → reactivated_at anulado (= deactivated_at)`);
            if (applyMode) {
                await db.update(regulationPostDeactivations)
                    .set({ reactivatedAt: orphan.deactivatedAt, updatedAt: now })
                    .where(eq(regulationPostDeactivations.id, orphan.id));
            }
            fixedCount++;
        }
    }

    console.log(`\nResumo: ${fixedCount} janela(s) órfã(s) ${applyMode ? "saneada(s)" : "a sanear"}.`);
    if (!applyMode && fixedCount > 0) {
        console.log("Rode com --apply para aplicar.");
    }

    await closeDb();
}

main().catch((error) => {
    console.error("Repair script failed:", error);
    process.exit(1);
});

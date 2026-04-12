import { and, eq, isNotNull, sql } from "drizzle-orm";
import { closeDb, getDb } from "@/db";
import { regulationOccupancies, regulationPosts } from "@/db/schema";
import { inferRegulationCoverageWindow } from "@/modules/operational/rules";
import { syncBankHoursByContinuityGroup } from "@/modules/bank-hours/service";

/**
 * Repair script: Fixes scheduled windows for NUCLEO regulation occupancies.
 *
 * NUCLEO is a regulation position whose SD arrival is at 08:00, not 07:00.
 * Before this fix, the system treated NUCLEO like any other regulation post,
 * assigning scheduledStartAt = 07:00 for SD. This caused false arrival delays
 * and incorrect bank-hours calculations (punishing doctors or stripping the
 * doubled late-departure bonus).
 *
 * This script:
 * 1. Finds all NUCLEO regulation occupancies with SD shift
 * 2. Recalculates scheduledStartAt using the corrected 08:00 rule
 * 3. Updates the occupancy record
 * 4. Recalculates bank hours for the affected continuity group
 *
 * Usage:
 *   npx tsx scripts/repair-nucleo-scheduled-windows.ts          # dry-run (preview)
 *   npx tsx scripts/repair-nucleo-scheduled-windows.ts --apply  # apply changes
 */

function hasFlag(flag: string) {
    return process.argv.includes(flag);
}

async function main() {
    const db = getDb();
    const applyMode = hasFlag("--apply");

    // Find the NUCLEO post
    const nucleoPost = await db.query.regulationPosts.findFirst({
        where: eq(regulationPosts.code, "NUCLEO"),
    });

    if (!nucleoPost) {
        console.log("NUCLEO post not found in regulation_posts table.");
        await closeDb();
        return;
    }

    console.log(`NUCLEO post id: ${nucleoPost.id}`);

    // Find all NUCLEO occupancies where shift is SD (or P derived from SD)
    // and scheduledStartAt was set to 07:00 instead of 08:00
    const occupancies = await db.query.regulationOccupancies.findMany({
        where: and(
            eq(regulationOccupancies.postId, nucleoPost.id),
            isNotNull(regulationOccupancies.scheduledStartAt),
        ),
    });

    const touchedContinuityGroups = new Set<string>();
    let fixedCount = 0;
    let skippedCount = 0;

    for (const occupancy of occupancies) {
        const baseShiftLabel = occupancy.shiftLabel === "P" || occupancy.shiftLabel === "SD"
            ? "SD"
            : occupancy.shiftLabel;

        // Only fix SD-based occupancies (NUCLEO only operates during SD)
        if (baseShiftLabel !== "SD") {
            skippedCount++;
            continue;
        }

        const { scheduledStartAt: correctScheduledStartAt, scheduledEndAt: correctScheduledEndAt } = inferRegulationCoverageWindow({
            startedAt: occupancy.startedAt,
            shiftLabel: occupancy.shiftLabel,
            postCode: "NUCLEO",
            explicitScheduledStartAt: null,
            explicitScheduledEndAt: null,
        });

        const storedStart = occupancy.scheduledStartAt?.toISOString() ?? null;
        const desiredStart = correctScheduledStartAt?.toISOString() ?? null;
        const storedEnd = occupancy.scheduledEndAt?.toISOString() ?? null;
        const desiredEnd = correctScheduledEndAt?.toISOString() ?? null;

        if (storedStart === desiredStart && storedEnd === desiredEnd) {
            skippedCount++;
            continue;
        }

        console.log(`[${applyMode ? "FIX" : "PREVIEW"}] occupancy ${occupancy.id} (shift=${occupancy.shiftLabel})`);
        console.log(`  scheduledStartAt: ${storedStart} → ${desiredStart}`);
        console.log(`  scheduledEndAt:   ${storedEnd} → ${desiredEnd}`);

        if (applyMode) {
            await db.update(regulationOccupancies)
                .set({
                    scheduledStartAt: correctScheduledStartAt,
                    scheduledEndAt: correctScheduledEndAt,
                    updatedAt: new Date(),
                })
                .where(eq(regulationOccupancies.id, occupancy.id));

            touchedContinuityGroups.add(occupancy.continuityGroupId);
        }

        fixedCount++;
    }

    // Recalculate bank hours for all affected continuity groups
    if (applyMode && touchedContinuityGroups.size > 0) {
        console.log(`\nRecalculating bank hours for ${touchedContinuityGroups.size} continuity groups...`);
        for (const continuityGroupId of touchedContinuityGroups) {
            try {
                await syncBankHoursByContinuityGroup(db, continuityGroupId);
                console.log(`  ✓ ${continuityGroupId}`);
            } catch (error) {
                console.error(`  ✗ ${continuityGroupId}: ${(error as Error).message}`);
            }
        }
    }

    console.log(`\nSummary: ${fixedCount} occupancies ${applyMode ? "fixed" : "to fix"}, ${skippedCount} skipped.`);

    if (!applyMode && fixedCount > 0) {
        console.log("Run with --apply to apply the changes.");
    }

    await closeDb();
}

main().catch((error) => {
    console.error("Repair script failed:", error);
    process.exit(1);
});

import { closeDb, getDb } from "@/db";
import { interventionOccupancies } from "@/db/schema";
import { eq } from "drizzle-orm";
import { inferInterventionCoverageWindow } from "@/modules/operational/rules";
import { syncBankHoursByContinuityGroup } from "@/modules/bank-hours/service";

/**
 * Repair script: Fixes scheduled windows for P-shift intervention occupancies
 * where the scheduled_end_at was under-extended due to boundary classification bug.
 *
 * The bug caused doctors arriving within 15 minutes before a shift boundary
 * (e.g., 06:52 local arriving for SD) to be classified as the previous shift (SN),
 * resulting in their P coverage missing the next shift in payment allocation.
 */

const AFFECTED_IDS = [
    "4a1caac9-c36c-4f95-98aa-bde76d6523a3", // Andre Paschoal Viana PM40
    "6d5fed16-214e-402f-91e4-86ca0fd32ff3", // André Victor Cardoso Codeceira PP20
    "504fb9f7-31fe-4f1e-b71d-0398d3788207", // Maurício Santos Bomfim CZ50
    "612a6a8d-d72a-4718-b47d-154f2665ae2d", // Tiago Cervino Raton Peixoto PR03
    "ffe3359b-9095-43d3-882e-4acf172aaed9", // Bruno Santana Alencar PM04
    "01559e14-d588-4b7c-b0da-617a52012b18", // Vinicius Raimundo Santos da Silva IT30
];

async function main() {
    const db = getDb();
    const touchedContinuityGroups = new Set<string>();

    for (const id of AFFECTED_IDS) {
        const occupancy = await db.query.interventionOccupancies.findFirst({
            where: eq(interventionOccupancies.id, id),
        });
        if (!occupancy) {
            console.warn(`Occupancy ${id} not found, skipping.`);
            continue;
        }

        // Use the boardStartedAt (physical arrival) as reference for correct scheduling.
        // This gets the right shift classification for doctors arriving near the boundary.
        const referenceAt = occupancy.boardStartedAt ?? occupancy.startedAt;
        const { scheduledStartAt, scheduledEndAt } = inferInterventionCoverageWindow({
            startedAt: referenceAt,
            shiftLabel: occupancy.shiftLabel,
            explicitScheduledStartAt: null,
            explicitScheduledEndAt: null,
        });

        const oldStart = occupancy.scheduledStartAt?.toISOString();
        const oldEnd = occupancy.scheduledEndAt?.toISOString();
        const newStart = scheduledStartAt?.toISOString();
        const newEnd = scheduledEndAt?.toISOString();

        if (oldStart === newStart && oldEnd === newEnd) {
            console.log(`${id}: already correct (${newStart} → ${newEnd}), skipping.`);
            continue;
        }

        // Also fix startedAt if it was snapped to wrong shift start
        const newStartedAt = scheduledStartAt ?? occupancy.startedAt;

        await db.update(interventionOccupancies)
            .set({
                startedAt: newStartedAt,
                scheduledStartAt,
                scheduledEndAt,
                updatedAt: new Date(),
            })
            .where(eq(interventionOccupancies.id, id));

        touchedContinuityGroups.add(occupancy.continuityGroupId);

        console.log(`${id}: FIXED`);
        console.log(`  scheduledStart: ${oldStart} → ${newStart}`);
        console.log(`  scheduledEnd:   ${oldEnd} → ${newEnd}`);
        if (newStartedAt.toISOString() !== occupancy.startedAt.toISOString()) {
            console.log(`  startedAt:      ${occupancy.startedAt.toISOString()} → ${newStartedAt.toISOString()}`);
        }
    }

    // Rebuild bank hours for all affected continuity groups
    console.log(`\nRebuilding bank hours for ${touchedContinuityGroups.size} continuity groups...`);
    for (const groupId of touchedContinuityGroups) {
        const result = await syncBankHoursByContinuityGroup(db, groupId);
        if (result) {
            console.log(`  ${groupId}: balance=${result.balanceMinutes}min, rule=${result.ruleCode}`);
        } else {
            console.log(`  ${groupId}: null (open or missing scheduled fields)`);
        }
    }

    await closeDb();
    console.log("\nDone.");
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});

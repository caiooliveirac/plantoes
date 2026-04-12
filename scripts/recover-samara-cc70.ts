import { closeDb, getDb } from "@/db";
import { interventionOccupancies } from "@/db/schema";
import { syncBankHoursByContinuityGroup } from "@/modules/bank-hours/service";

/**
 * Recovery script: restores Samara's CC70 P occupancy that was deleted by
 * a transfer with remove_destination strategy on 2026-04-05T11:36:45Z.
 *
 * Timeline:
 *   - Syone CC70 P: ended_at 2026-04-04 10:00 UTC (07:00 local)
 *   - Samara CC70 P: started 10:00 UTC → left at 08:50 local (11:50 UTC Apr 5)
 *   - João Pedro transferred to CC70: started_at 09:54:35 UTC Apr 5
 *
 * Samara stayed 1h50min past scheduled end (07:00 local Apr 5) due to
 * ocorrência 0174, generating bank hours credit.
 */

async function main() {
    const db = getDb();

    const ORIGINAL_OCCUPANCY_ID = "5ca51b35-45f4-4dda-841a-0a0f242de385";
    const DOCTOR_ID = "700104db-6988-4f48-a1c4-6c7b20e883b3"; // Samara Alves Messias Viana
    const BASE_ID = 12; // CC70
    const CONTINUITY_GROUP_ID = "5816603d-d266-4ea5-9490-e557e0dbc57d";

    // Check it doesn't already exist
    const existing = await db.query.interventionOccupancies.findFirst({
        where: (t, { eq }) => eq(t.id, ORIGINAL_OCCUPANCY_ID),
    });

    if (existing) {
        console.log("Occupancy already exists, skipping INSERT.");
        await closeDb();
        return;
    }

    // Times (all UTC):
    // started_at: when Syone ended (handoff)
    // ended_at: when João Pedro took over CC70 via transfer
    // actual_ended_at: 08:50 São Paulo = 11:50 UTC (she was on ocorrência 0174)
    // scheduled: P shift from SD start (07:00 local = 10:00 UTC) to next morning (07:00 local = 10:00 UTC)
    const startedAt = new Date("2026-04-04T10:00:00.000Z");
    const endedAt = new Date("2026-04-05T09:54:35.000Z");
    const actualEndedAt = new Date("2026-04-05T11:50:00.000Z");
    const scheduledStartAt = new Date("2026-04-04T10:00:00.000Z");
    const scheduledEndAt = new Date("2026-04-05T10:00:00.000Z");
    const boardStartedAt = new Date("2026-04-04T10:05:11.000Z");

    const [inserted] = await db.insert(interventionOccupancies).values({
        id: ORIGINAL_OCCUPANCY_ID,
        doctorId: DOCTOR_ID,
        baseId: BASE_ID,
        shiftLabel: "P",
        source: "telegram",
        startedAt,
        endedAt,
        actualEndedAt,
        scheduledStartAt,
        scheduledEndAt,
        boardStartedAt,
        continuityGroupId: CONTINUITY_GROUP_ID,
        notes: "Recuperado após deleção acidental por transferência remove_destination em 2026-04-05T11:36:45Z. Saída às 08:50 local por ocorrência 0174.",
    }).returning();

    console.log("Inserted occupancy:", inserted.id);

    // Rebuild bank hours for the continuity group
    const bankHoursResult = await syncBankHoursByContinuityGroup(db, CONTINUITY_GROUP_ID);
    if (bankHoursResult) {
        console.log("Bank hours recalculated:");
        console.log("  scheduledStart:", bankHoursResult.scheduledStartAt);
        console.log("  scheduledEnd:", bankHoursResult.scheduledEndAt);
        console.log("  actualStart:", bankHoursResult.actualStartAt);
        console.log("  actualEnd:", bankHoursResult.actualEndAt);
        console.log("  arrivalDelay:", bankHoursResult.arrivalDelayMinutes, "min");
        console.log("  overtime:", bankHoursResult.overtimeMinutes, "min");
        console.log("  multiplier:", bankHoursResult.overtimeMultiplier);
        console.log("  creditedOvertime:", bankHoursResult.creditedOvertimeMinutes, "min");
        console.log("  balance:", bankHoursResult.balanceMinutes, "min");
        console.log("  rule:", bankHoursResult.ruleCode);
        console.log("  explanation:", bankHoursResult.explanation);
    } else {
        console.warn("Bank hours sync returned null — span may not be closed or missing scheduled fields.");
    }

    await closeDb();
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});

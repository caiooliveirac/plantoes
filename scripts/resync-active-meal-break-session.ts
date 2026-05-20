/**
 * Emergency resync: reloads the active day meal-break session,
 * runs syncDaySessionState (with the capacity fix), and saves it back.
 * This allows the current doctor in the queue to proceed without restarting.
 *
 * Usage:
 *   source .env.production && npx tsx scripts/resync-active-meal-break-session.ts
 */

import { eq, like } from "drizzle-orm";
import { getDb } from "@/db/index";
import { telegramBotNotices } from "@/db/schema";
import { syncDaySessionState } from "@/modules/telegram/meal-breaks";
import type { MealBreakSession } from "@/modules/telegram/meal-breaks";
import { getSaoPauloParts, resolveOperationalShiftWindow } from "@/modules/operational/board-rules";

const SESSION_KIND = "meal_break_session";

function formatOperationalDate(referenceAt: Date) {
    const parts = getSaoPauloParts(resolveOperationalShiftWindow(referenceAt).startedAt);
    return `${parts.year}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
}

const MEAL_BREAK_SESSION_KIND = "telegram_meal_break_session";

function isMealBreakSession(value: unknown): value is MealBreakSession {
    if (!value || typeof value !== "object") return false;
    const candidate = value as Record<string, unknown>;
    return candidate.kind === MEAL_BREAK_SESSION_KIND
        && typeof candidate.operationalDate === "string"
        && typeof candidate.stage === "string"
        && Array.isArray(candidate.roster)
        && candidate.version === 1;
}

async function main() {
    const now = new Date();
    const operationalDate = formatOperationalDate(now);
    console.log(`Operational date: ${operationalDate}`);

    const db = getDb();
    const rows = await db.select().from(telegramBotNotices).where(
        like(telegramBotNotices.noticeKey, "%:meal_break:session:day"),
    );

    console.log(`Found ${rows.length} day session row(s)`);
    for (const row of rows) {
        const payload = row.payload as Record<string, unknown> | null;
        console.log(`  Key: ${row.noticeKey}, operationalDate: ${payload?.operationalDate ?? "N/A"}, stage: ${payload?.stage ?? "N/A"}`);
    }

    // Accept any active session (not just today's) — the user wants to fix whatever is live
    const candidates = rows.filter((row) => {
        const payload = row.payload as Record<string, unknown> | null;
        if (!payload) return false;
        const valid = isMealBreakSession(payload);
        if (!valid) {
            console.log(`  Skipped (not valid session): kind=${payload.kind}, version=${payload.version}, roster=${Array.isArray(payload.roster)}`);
        }
        return valid && payload.mode === "day";
    });

    if (candidates.length === 0) {
        console.log("No active day meal-break session found for today.");
        return;
    }

    for (const row of candidates) {
        const session = row.payload as unknown as MealBreakSession;
        console.log(`\nFound session: chatId key=${row.noticeKey}`);
        console.log(`  Stage: ${session.stage}`);
        console.log(`  Rest queue: [${session.restQueue.join(", ")}]`);
        console.log(`  Rest capacities: ${JSON.stringify(session.restChoiceCapacities)}`);

        const assigned1530 = Object.values(session.restAssignments).filter((s) => s === "15:30").length;
        const assigned1630 = Object.values(session.restAssignments).filter((s) => s === "16:30").length;
        console.log(`  Assigned 15:30: ${assigned1530}, 16:30: ${assigned1630}`);
        console.log(`  Remaining 15:30: ${session.restChoiceCapacities["15:30"] - assigned1530}`);
        console.log(`  Remaining 16:30: ${session.restChoiceCapacities["16:30"] - assigned1630}`);

        // Resync
        const resynced = syncDaySessionState(session);

        const newAssigned1530 = Object.values(resynced.restAssignments).filter((s) => s === "15:30").length;
        const newAssigned1630 = Object.values(resynced.restAssignments).filter((s) => s === "16:30").length;
        console.log(`\n  After resync:`);
        console.log(`  Stage: ${resynced.stage}`);
        console.log(`  Rest queue: [${resynced.restQueue.join(", ")}]`);
        console.log(`  Rest capacities: ${JSON.stringify(resynced.restChoiceCapacities)}`);
        console.log(`  Remaining 15:30: ${resynced.restChoiceCapacities["15:30"] - newAssigned1530}`);
        console.log(`  Remaining 16:30: ${resynced.restChoiceCapacities["16:30"] - newAssigned1630}`);

        // Save
        await db.update(telegramBotNotices)
            .set({ payload: resynced as unknown as Record<string, unknown> })
            .where(eq(telegramBotNotices.id, row.id));

        console.log(`  ✅ Session saved. Zolaina pode responder agora.`);
    }

    process.exit(0);
}

main().catch((error) => {
    console.error("Resync failed:", error);
    process.exit(1);
});

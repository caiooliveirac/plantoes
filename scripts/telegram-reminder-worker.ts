import { getTelegramReminderPollMs } from "@/modules/telegram/config";
import { assertSingleRuntimeConfig, logRuntimeIdentity } from "@/lib/runtime-identity";
import { sendTelegramMealBreakCycle, sendTelegramMealBreakTurnNudges } from "@/modules/telegram/meal-breaks";
import { sendTelegramReminderCycle } from "@/modules/telegram/reminders";

let running = false;

async function runCycle() {
    if (running) {
        return;
    }

    running = true;
    try {
        const referenceDate = new Date();
        const [reminders, mealBreak, mealBreakNudges] = await Promise.all([
            sendTelegramReminderCycle(referenceDate),
            sendTelegramMealBreakCycle(referenceDate),
            sendTelegramMealBreakTurnNudges(referenceDate),
        ]);
        const evaluated = reminders.evaluated + mealBreak.evaluated + mealBreakNudges.evaluated;
        const sent = reminders.sent + mealBreak.sent + mealBreakNudges.sent;
        if (evaluated > 0 || sent > 0) {
            console.log(`[telegram-reminder-worker] evaluated=${evaluated} sent=${sent}`);
        }
    } catch (error) {
        console.error("[telegram-reminder-worker] cycle failed", error);
    } finally {
        running = false;
    }
}

async function main() {
    logRuntimeIdentity("telegram.reminder.worker");
    assertSingleRuntimeConfig("telegram.reminder.worker");

    await runCycle();
    const intervalMs = getTelegramReminderPollMs();
    setInterval(() => {
        void runCycle();
    }, intervalMs);
}

main().catch((error) => {
    console.error("[telegram-reminder-worker] fatal", error);
    process.exit(1);
});
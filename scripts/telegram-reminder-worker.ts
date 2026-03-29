import { getTelegramReminderPollMs } from "@/modules/telegram/config";
import { sendTelegramMealBreakCycle } from "@/modules/telegram/meal-breaks";
import { sendTelegramReminderCycle } from "@/modules/telegram/reminders";

let running = false;

async function runCycle() {
    if (running) {
        return;
    }

    running = true;
    try {
        const referenceDate = new Date();
        const [reminders, mealBreak] = await Promise.all([
            sendTelegramReminderCycle(referenceDate),
            sendTelegramMealBreakCycle(referenceDate),
        ]);
        const evaluated = reminders.evaluated + mealBreak.evaluated;
        const sent = reminders.sent + mealBreak.sent;
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
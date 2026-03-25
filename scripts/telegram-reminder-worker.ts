import { getTelegramReminderPollMs } from "@/modules/telegram/config";
import { sendTelegramReminderCycle } from "@/modules/telegram/reminders";

let running = false;

async function runCycle() {
    if (running) {
        return;
    }

    running = true;
    try {
        const result = await sendTelegramReminderCycle(new Date());
        if (result.evaluated > 0 || result.sent > 0) {
            console.log(`[telegram-reminder-worker] evaluated=${result.evaluated} sent=${result.sent}`);
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
import "./worker-env";
import { getTelegramReminderPollMs } from "@/modules/telegram/config";
import { assertSingleRuntimeConfig, logRuntimeIdentity } from "@/lib/runtime-identity";
import { sendTelegramMealBreakCycle, sendTelegramMealBreakTurnNudges } from "@/modules/telegram/meal-breaks";
import { sendContractBalanceCycle } from "@/modules/telegram/contract-balance-alerts";
import { sendTelegramPaymentDigestCycle } from "@/modules/telegram/payment-digest";
import { sendTelegramReminderCycle } from "@/modules/telegram/reminders";
import { expireResidenteOccupancies } from "@/modules/operational/residente-auto-close";

let running = false;

async function runCycle() {
    if (running) {
        return;
    }

    running = true;
    try {
        const referenceDate = new Date();
        const [reminders, mealBreak, mealBreakNudges, paymentDigest, residenteAutoClose, contractBalance] = await Promise.all([
            sendTelegramReminderCycle(referenceDate),
            sendTelegramMealBreakCycle(referenceDate),
            sendTelegramMealBreakTurnNudges(referenceDate),
            sendTelegramPaymentDigestCycle(referenceDate),
            expireResidenteOccupancies(referenceDate),
            // Varredura do razão do saldo contratual + alertas (SPEC §8).
            sendContractBalanceCycle(referenceDate),
        ]);
        const evaluated = reminders.evaluated + mealBreak.evaluated + mealBreakNudges.evaluated
            + paymentDigest.evaluated + contractBalance.evaluated;
        const sent = reminders.sent + mealBreak.sent + mealBreakNudges.sent
            + paymentDigest.sent + contractBalance.sent;
        if (evaluated > 0 || sent > 0) {
            console.log(`[telegram-reminder-worker] evaluated=${evaluated} sent=${sent}`);
        }
        if (residenteAutoClose.closed > 0) {
            console.log(`[telegram-reminder-worker] residente auto-close: evaluated=${residenteAutoClose.evaluated} closed=${residenteAutoClose.closed}`);
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
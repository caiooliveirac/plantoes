import "./worker-env";
import { getTelegramReminderPollMs } from "@/modules/telegram/config";
import { assertSingleRuntimeConfig, logRuntimeIdentity } from "@/lib/runtime-identity";
import { sendTelegramMealBreakCycle, sendTelegramMealBreakTurnNudges } from "@/modules/telegram/meal-breaks";
import { sendBankHoursPendingCycle } from "@/modules/telegram/bank-hours-pending-alerts";
import { sendChecklistDigestCycle } from "@/modules/telegram/checklist-digest";
import { sendContractBalanceCycle } from "@/modules/telegram/contract-balance-alerts";
import { sendTelegramPaymentDigestCycle } from "@/modules/telegram/payment-digest";
import { sendTelegramReminderCycle } from "@/modules/telegram/reminders";
import { sendSelfDeclaredExtraCycle } from "@/modules/telegram/self-declared-extra-alerts";
import { syncTelegramAdminCommandMenus } from "@/modules/telegram/admin-menu";
import { expireResidenteOccupancies } from "@/modules/operational/residente-auto-close";

let running = false;

async function runCycle() {
    if (running) {
        return;
    }

    running = true;
    try {
        const referenceDate = new Date();
        const [
            reminders,
            mealBreak,
            mealBreakNudges,
            paymentDigest,
            residenteAutoClose,
            contractBalance,
            bankHoursPending,
            selfDeclaredExtra,
            checklistDigest,
        ] = await Promise.all([
            sendTelegramReminderCycle(referenceDate),
            sendTelegramMealBreakCycle(referenceDate),
            sendTelegramMealBreakTurnNudges(referenceDate),
            sendTelegramPaymentDigestCycle(referenceDate),
            expireResidenteOccupancies(referenceDate),
            // Varredura do razão do saldo contratual + alertas (SPEC §8).
            sendContractBalanceCycle(referenceDate),
            // Resumo diário das pendências de ±12h do banco de horas.
            sendBankHoursPendingCycle(referenceDate),
            // Extra declarado que caiu em turno depois trabalhado: remarca e avisa.
            sendSelfDeclaredExtraCycle(referenceDate),
            // Digest 11h/13h do checklist das USAs (flag CHECKLIST_DIGEST_ENABLED).
            sendChecklistDigestCycle(referenceDate),
        ]);
        const evaluated = reminders.evaluated + mealBreak.evaluated + mealBreakNudges.evaluated
            + paymentDigest.evaluated + contractBalance.evaluated + bankHoursPending.evaluated
            + selfDeclaredExtra.evaluated + checklistDigest.evaluated;
        const sent = reminders.sent + mealBreak.sent + mealBreakNudges.sent
            + paymentDigest.sent + contractBalance.sent + bankHoursPending.sent
            + selfDeclaredExtra.sent + checklistDigest.sent;
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

    // Menu "/" no privado dos admins — idempotente, refeito a cada boot.
    try {
        const menu = await syncTelegramAdminCommandMenus();
        console.log(`[telegram-reminder-worker] admin menus: synced=${menu.synced} failed=${menu.failed}`);
    } catch (error) {
        console.error("[telegram-reminder-worker] admin menu sync failed", error);
    }

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
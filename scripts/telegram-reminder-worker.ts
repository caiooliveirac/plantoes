import "./worker-env";
import { getTelegramReminderPollMs } from "@/modules/telegram/config";
import { assertSingleRuntimeConfig, logRuntimeIdentity } from "@/lib/runtime-identity";
import { sendTelegramMealBreakCycle, sendTelegramMealBreakTurnNudges } from "@/modules/telegram/meal-breaks";
import { sendBankHoursPendingCycle } from "@/modules/telegram/bank-hours-pending-alerts";
import { sendAcessosCycle } from "@/modules/telegram/acessos-alerts";
import { sendAvisoFimTurnoCycle } from "@/modules/telegram/aviso-fim-turno";
import { sendChecklistDigestCycle } from "@/modules/telegram/checklist-digest";
import { sendOccurrenceHandoffCycle } from "@/modules/telegram/occurrence-handoff-cycle";
import { sendContractBalanceCycle } from "@/modules/telegram/contract-balance-alerts";
import { sendTelegramPaymentDigestCycle } from "@/modules/telegram/payment-digest";
import { sendTelegramReminderCycle } from "@/modules/telegram/reminders";
import { sendSelfDeclaredExtraCycle } from "@/modules/telegram/self-declared-extra-alerts";
import { sendVerificacaoPosViradaCycle } from "@/modules/telegram/verificacao-pos-virada-cycle";
import { syncTelegramAdminCommandMenus } from "@/modules/telegram/admin-menu";
import { expireResidenteOccupancies } from "@/modules/operational/residente-auto-close";
import { expireInterventionBaseDeactivations } from "@/modules/intervention/service";
import { expireRegulationPostDeactivations } from "@/modules/regulation/service";

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
            occurrenceHandoff,
            verificacaoPosVirada,
            acessos,
            avisoFimTurno,
            expiredBaseDeactivations,
            expiredPostDeactivations,
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
            // Passagem de ocorrências no almoço/descanso: aviso, cobrança com @, divisão.
            sendOccurrenceHandoffCycle(referenceDate),
            // Roteiro de docs/verificacao-saidas-continuidade.md após cada virada (flag VERIFICACAO_POS_VIRADA).
            sendVerificacaoPosViradaCycle(referenceDate),
            // Monitor de acessos: alerta forte na hora + resumo 8h (flag ACESSOS_ALERTAS_ENABLED) e poda de 180 dias.
            sendAcessosCycle(referenceDate),
            // Aviso no privado do regulador às 07:00/19:00: turno acabou, avise a saída (flag TELEGRAM_AVISO_FIM_TURNO).
            sendAvisoFimTurnoCycle(referenceDate),
            // Desativação de base/posto vence na virada do turno: grava reactivated_at =
            // virada. O quadro já esconde a vencida na leitura; aqui só o registro
            // (antes era feito dentro de getOperationalBoard — leitura que gravava).
            expireInterventionBaseDeactivations(referenceDate),
            expireRegulationPostDeactivations(referenceDate),
        ]);
        const evaluated = reminders.evaluated + mealBreak.evaluated + mealBreakNudges.evaluated
            + paymentDigest.evaluated + contractBalance.evaluated + bankHoursPending.evaluated
            + selfDeclaredExtra.evaluated + checklistDigest.evaluated + occurrenceHandoff.evaluated
            + verificacaoPosVirada.evaluated + acessos.evaluated + avisoFimTurno.evaluated;
        const sent = reminders.sent + mealBreak.sent + mealBreakNudges.sent
            + paymentDigest.sent + contractBalance.sent + bankHoursPending.sent
            + selfDeclaredExtra.sent + checklistDigest.sent + occurrenceHandoff.sent
            + verificacaoPosVirada.sent + acessos.sent + avisoFimTurno.sent;
        if (evaluated > 0 || sent > 0) {
            console.log(`[telegram-reminder-worker] evaluated=${evaluated} sent=${sent}`);
        }
        if (expiredBaseDeactivations > 0 || expiredPostDeactivations > 0) {
            console.log(`[telegram-reminder-worker] desativações vencidas: bases=${expiredBaseDeactivations} postos=${expiredPostDeactivations}`);
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
/**
 * Resumo diário das pendências do banco de horas (múltiplos de ±12h) para o
 * privado dos admins.
 *
 * Mesmo padrão do contract-balance-alerts: roda no ciclo do worker, só age na
 * janela das 8h (America/Sao_Paulo), deduplica por dia via telegram_bot_notices
 * (reserva idempotente → dois workers não mandam o mesmo resumo) e continua
 * lembrando todo dia enquanto houver ação pendente.
 *
 * Feature flag: BANK_HOURS_PENDING_ALERTS_ENABLED=1 liga o envio. Desligada,
 * nada sai — os dados e o fluxo de acerto continuam intactos.
 */
import { eq, inArray } from "drizzle-orm";

import { getDb } from "@/db";
import { doctors, telegramBotNotices } from "@/db/schema";
import {
    buildBankHoursPendingSummaryMessage,
    resolveBankHoursPendingAction,
    type BankHoursPendingRow,
} from "@/modules/bank-hours/pending-actions";
import { getSaoPauloParts } from "@/modules/operational/board-rules";
import { sendMessage } from "@/modules/telegram/api";
import { getTelegramAdminUserIds } from "@/modules/telegram/config";
import { getDoctorBankHoursEffectiveBalances } from "@/services/bank-hours-history.service";
import { loadDoctorBankHoursStoryLines } from "@/services/bank-hours-story.service";
import { loadBankHoursSettlementDeltaByDoctor } from "@/services/bank-hours-settlements.service";

const STAGE = "bank-hours";

export function isBankHoursPendingAlertsEnabled() {
    const value = process.env.BANK_HOURS_PENDING_ALERTS_ENABLED?.trim().toLowerCase();
    return value === "1" || value === "true";
}

/** Mesma janela das 8h dos outros avisos administrativos. */
export function shouldRunBankHoursPendingCycle(referenceDate: Date) {
    const parts = getSaoPauloParts(referenceDate);
    return parts.hour === 8 && parts.minute < 10;
}

/** Monta as linhas do resumo a partir do saldo efetivo + acertos já lançados. */
export async function loadBankHoursPendingRows(): Promise<BankHoursPendingRow[]> {
    const [balances, settlementDeltaByDoctor] = await Promise.all([
        getDoctorBankHoursEffectiveBalances(),
        loadBankHoursSettlementDeltaByDoctor(),
    ]);

    const pending: Array<Omit<BankHoursPendingRow, "doctorName"> & { doctorId: string }> = [];
    for (const [doctorId, balance] of balances) {
        const action = resolveBankHoursPendingAction({
            bonusEligibleMinutes: balance.bonusEligibleMinutes,
            penaltyEligibleMinutes: balance.penaltyEligibleMinutes,
            settlementDeltaMinutes: settlementDeltaByDoctor.get(doctorId) ?? 0,
        });
        if (!action.direction) continue;
        pending.push({
            doctorId,
            direction: action.direction,
            eligibleMinutes: action.direction === "bonus" ? balance.bonusEligibleMinutes : balance.penaltyEligibleMinutes,
            pendingUnits: action.pendingUnits,
            residualMinutes: action.residualMinutes,
            inconsistency: action.inconsistency,
        });
    }
    if (pending.length === 0) return [];

    const nameRows = await getDb()
        .select({ id: doctors.id, fullName: doctors.fullName, displayName: doctors.displayName })
        .from(doctors)
        .where(inArray(doctors.id, pending.map((row) => row.doctorId)));
    const nameById = new Map(nameRows.map((row) => [row.id, row.displayName?.trim() || row.fullName]));

    const ordered = pending.sort((left, right) => Math.abs(right.eligibleMinutes) - Math.abs(left.eligibleMinutes));

    // Os plantões que sustentam cada pendência, contados em português. Sem eles o
    // aviso trazia só o total, e não dava para farejar um bônus nascido de
    // registro errado (caso Murilo Damasceno, PR03, 21/08/2026).
    const storiesByDoctor = new Map<string, string[]>();
    for (const row of ordered) {
        try {
            storiesByDoctor.set(row.doctorId, await loadDoctorBankHoursStoryLines(row.doctorId, row.direction));
        } catch (error) {
            console.error(`[bank-hours] não consegui contar os plantões de ${row.doctorId}`, error);
        }
    }

    return ordered
        .map(({ doctorId, ...row }) => ({
            ...row,
            doctorName: nameById.get(doctorId) ?? doctorId,
            storyLines: storiesByDoctor.get(doctorId) ?? [],
        }));
}

function pad2(value: number) {
    return String(value).padStart(2, "0");
}

export async function sendBankHoursPendingCycle(referenceDate = new Date()) {
    if (!isBankHoursPendingAlertsEnabled() || !shouldRunBankHoursPendingCycle(referenceDate)) {
        return { sent: 0, evaluated: 0 };
    }
    if (!process.env.TELEGRAM_BOT_TOKEN?.trim()) {
        return { sent: 0, evaluated: 0 };
    }
    const admins = [...new Set(getTelegramAdminUserIds().filter(Boolean))];
    if (admins.length === 0) {
        return { sent: 0, evaluated: 0 };
    }

    const rows = await loadBankHoursPendingRows();
    const appUrl = (process.env.AUTH_URL?.trim() || "https://plantoes.mnrs.com.br").replace(/\/$/, "");
    const message = buildBankHoursPendingSummaryMessage(rows, { adminUrl: `${appUrl}/admin/bank-hours` });
    if (!message) {
        return { sent: 0, evaluated: rows.length };
    }

    const parts = getSaoPauloParts(referenceDate);
    const day = `${parts.year}-${pad2(parts.month)}-${pad2(parts.day)}`;

    let sent = 0;
    for (const chatId of admins) {
        const noticeKey = `${chatId}:bank-hours-pending:${day}`;
        const [reserved] = await getDb()
            .insert(telegramBotNotices)
            .values({ noticeKey, chatId, stage: STAGE, payload: { doctors: rows.length } })
            .onConflictDoNothing()
            .returning();
        if (!reserved) continue;

        try {
            await sendMessage(chatId, message);
            sent += 1;
        } catch (error) {
            // Falhou o envio: solta a reserva para o próximo ciclo tentar de novo.
            await getDb().delete(telegramBotNotices).where(eq(telegramBotNotices.noticeKey, noticeKey));
            console.error(`[bank-hours] resumo pendências falhou ${chatId}`, error);
        }
    }

    return { sent, evaluated: rows.length * admins.length };
}

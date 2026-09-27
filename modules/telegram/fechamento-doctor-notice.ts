/**
 * Aviso privado ao médico quando o admin atesta (assina) o mês dele no
 * fechamento: "N plantões, R$ X, folha pronta" + link assinado da folha de ponto.
 * Antes o médico só sabia pedindo /pagamento ou /banco.
 *
 * Números: os mesmos do /pagamento (getChiefPayableShiftsBoard +
 * summarizeDoctorPayroll) — nunca recalculados aqui.
 *
 * Canal: o mesmo do aviso de acerto de banco de horas (findDoctorTelegramChatId,
 * último chat privado do autoatendimento). Sem chat conhecido, não envia.
 *
 * Flag TELEGRAM_DM_FECHAMENTO:
 *  - off (padrão, ou qualquer valor desconhecido): não envia nada;
 *  - admins: ensaio — a mesma mensagem vai para os TELEGRAM_ADMIN_IDS, com um
 *    cabeçalho dizendo para quem iria. O médico não recebe;
 *  - on: envia ao médico.
 *
 * Idempotência: noticeKey por médico/mês/contagem/total (telegram_bot_notices).
 * Desassinar e reassinar sem mudança nos números não reenvia; se os números
 * mudaram, o médico recebe a versão nova. Falha no envio libera a reserva.
 *
 * Nunca lança: a atestação já foi commitada e não pode depender do Telegram.
 */
import { eq } from "drizzle-orm";

import { getDb } from "@/db";
import { telegramBotNotices } from "@/db/schema";
import { createFolhaToken } from "@/lib/folha-ponto/token";
import { formatDoctorBackofficeName } from "@/modules/doctors/directory";
import type { ChiefPayableBoardModel } from "@/modules/reporting/payable-shifts";
import { sendMessage } from "@/modules/telegram/api";
import { findDoctorTelegramChatId } from "@/modules/telegram/bank-hours-doctor-notice";
import { getTelegramAdminUserIds } from "@/modules/telegram/config";
import { formatBRL, summarizeDoctorPayroll } from "@/modules/telegram/payment-digest";
import { getBankHoursHistory } from "@/services/bank-hours-history.service";
import { getChiefPayableShiftsBoard } from "@/services/payable-shifts.service";

const STAGE = "fechamento-medico";

export type FechamentoDmMode = "off" | "admins" | "on";

export function resolveFechamentoDmMode(value = process.env.TELEGRAM_DM_FECHAMENTO): FechamentoDmMode {
    const normalized = value?.trim().toLowerCase();
    return normalized === "on" || normalized === "admins" ? normalized : "off";
}

export function buildFolhaPontoUrl(doctorId: string, monthKey: string, now = Date.now()) {
    const [year, month] = monthKey.split("-").map(Number);
    const appUrl = (process.env.AUTH_URL?.trim() || "https://plantoes.mnrs.com.br").replace(/\/$/, "");
    const token = createFolhaToken({ medicoId: doctorId, ano: year, mes: month }, undefined, now);
    return `${appUrl}/folha-ponto/${doctorId}/${year}/${String(month).padStart(2, "0")}?t=${token}`;
}

export function buildFechamentoDoctorMessage(params: {
    monthLabel: string;
    shiftCount: number;
    /** null = estatutário (pago fora deste sistema): não mostra R$. */
    total: number | null;
    folhaUrl: string;
    pendingLateDepartures: number;
}) {
    const plantoes = `${params.shiftCount} ${params.shiftCount === 1 ? "plantão" : "plantões"}`;
    const valor = params.total === null ? "" : `, ${formatBRL(params.total)}`;
    const pendentes = params.pendingLateDepartures > 0
        ? [`⚠️ ${params.pendingLateDepartures} ${params.pendingLateDepartures === 1 ? "saída tardia ainda aguarda" : "saídas tardias ainda aguardam"} validação da chefia.`]
        : [];
    return [
        `📄 Fechamento de ${params.monthLabel}: ${plantoes}${valor}, folha pronta.`,
        ...pendentes,
        `Folha de ponto: ${params.folhaUrl}`,
    ].join("\n");
}

async function countPendingLateDepartures(doctorId: string, monthKey: string) {
    const history = await getBankHoursHistory({ doctorId });
    const doctor = history.doctors.find((row) => row.doctorId === doctorId);
    return (doctor?.shifts ?? [])
        .filter((shift) => shift.monthKey === monthKey && shift.approval.state === "aguardando_chefia")
        .length;
}

export interface FechamentoDoctorNoticeDeps {
    loadBoard: (monthKey: string) => Promise<ChiefPayableBoardModel>;
    countPendingLateDepartures: (doctorId: string, monthKey: string) => Promise<number>;
}

const defaultDeps: FechamentoDoctorNoticeDeps = {
    loadBoard: getChiefPayableShiftsBoard,
    countPendingLateDepartures,
};

async function reserve(noticeKey: string, chatId: string, payload: Record<string, unknown>) {
    const [inserted] = await getDb()
        .insert(telegramBotNotices)
        .values({ noticeKey, chatId, stage: STAGE, payload })
        .onConflictDoNothing()
        .returning({ id: telegramBotNotices.id });
    return Boolean(inserted);
}

async function release(noticeKey: string) {
    await getDb().delete(telegramBotNotices).where(eq(telegramBotNotices.noticeKey, noticeKey));
}

export type FechamentoDoctorNoticeResult =
    | { status: "disabled" | "no_shifts" | "no_known_chat" | "already_sent" | "failed" }
    | { status: "sent"; chatIds: string[] };

export async function notifyDoctorMonthClosed(
    params: { doctorId: string; monthKey: string },
    deps: FechamentoDoctorNoticeDeps = defaultDeps,
): Promise<FechamentoDoctorNoticeResult> {
    const mode = resolveFechamentoDmMode();
    if (mode === "off" || !process.env.TELEGRAM_BOT_TOKEN?.trim()) {
        return { status: "disabled" };
    }

    try {
        const board = await deps.loadBoard(params.monthKey);
        const row = board.doctors.find((doctor) => doctor.doctorId === params.doctorId);
        const summary = row ? summarizeDoctorPayroll(row) : null;
        if (!row || !summary || summary.shifts.length === 0) {
            return { status: "no_shifts" };
        }

        const targets = mode === "admins"
            ? [...new Set(getTelegramAdminUserIds().filter(Boolean))]
            : [await findDoctorTelegramChatId(params.doctorId)].filter((id): id is string => Boolean(id));
        if (targets.length === 0) {
            return { status: "no_known_chat" };
        }

        // Pendência de saída tardia é complemento: se falhar, o aviso sai sem ela.
        const pendingLateDepartures = await deps.countPendingLateDepartures(params.doctorId, params.monthKey)
            .catch((error) => {
                console.error(`[fechamento] pendências de saída tardia indisponíveis ${params.doctorId}`, error);
                return 0;
            });

        const total = row.employmentType === "estatutario" ? null : summary.total;
        const text = buildFechamentoDoctorMessage({
            monthLabel: board.monthLabel,
            shiftCount: summary.shifts.length,
            total,
            folhaUrl: buildFolhaPontoUrl(params.doctorId, board.monthKey),
            pendingLateDepartures,
        });
        const baseKey = `fechamento-medico:${params.doctorId}:${board.monthKey}:${summary.shifts.length}:${Math.round(summary.total * 100)}`;
        const doctorName = formatDoctorBackofficeName({ fullName: row.doctorName, displayName: row.displayName });

        const sentTo: string[] = [];
        let failed = false;
        for (const chatId of targets) {
            const noticeKey = mode === "admins" ? `${baseKey}:ensaio:${chatId}` : baseKey;
            const reserved = await reserve(noticeKey, chatId, {
                doctorId: params.doctorId,
                monthKey: board.monthKey,
                mode,
            });
            if (!reserved) {
                continue;
            }
            try {
                await sendMessage(chatId, mode === "admins" ? `🧪 Ensaio — iria para ${doctorName}:\n\n${text}` : text);
                sentTo.push(chatId);
            } catch (error) {
                failed = true;
                await release(noticeKey).catch(() => undefined);
                console.error(`[fechamento] aviso ao médico falhou ${params.doctorId} ${board.monthKey}`, error);
            }
        }

        if (sentTo.length > 0) {
            return { status: "sent", chatIds: sentTo };
        }
        return { status: failed ? "failed" : "already_sent" };
    } catch (error) {
        console.error(`[fechamento] aviso ao médico falhou ${params.doctorId} ${params.monthKey}`, error);
        return { status: "failed" };
    }
}

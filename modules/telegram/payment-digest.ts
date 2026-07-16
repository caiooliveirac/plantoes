import { eq } from "drizzle-orm";

import { getDb } from "@/db";
import { telegramBotNotices } from "@/db/schema";
import { formatDoctorBackofficeName } from "@/modules/doctors/directory";
import { getSaoPauloParts } from "@/modules/operational/board-rules";
import { isSamuHolidayDate, isWeekendDate } from "@/modules/operational/holidays";
import { sendDocument } from "@/modules/telegram/api";
import { getTelegramAdminUserIds } from "@/modules/telegram/config";
import type {
    ChiefPayableBoardModel,
    ChiefPayableDoctorRow,
    PayableShift,
} from "@/modules/reporting/payable-shifts";
import { resolveShiftDueAmount } from "@/modules/reporting/payable-shifts";
import { getChiefPayableShiftsBoard } from "@/services/payable-shifts.service";

const WEEKDAY_LABELS_PT = ["Dom", "Seg", "Ter", "Qua", "Qui", "Sex", "Sáb"] as const;

// Margem de segurança abaixo do limite de 4096 chars por mensagem do Telegram.
const MAX_MESSAGE_CHARS = 3500;

const STAGE = "payment_digest";

function pad2(value: number) {
    return String(value).padStart(2, "0");
}

function dayKindLabel(operationalDate: string) {
    if (isSamuHolidayDate(operationalDate)) {
        return "Feriado";
    }
    if (isWeekendDate(operationalDate)) {
        return "Fim de semana";
    }
    return "Dia útil";
}

// Linha compacta: "01/06 Seg SD PR03 (Dia útil)" (+ tag MEIO quando meio-plantão).
export function formatShiftLine(shift: PayableShift) {
    const [, month, day] = shift.operationalDate.split("-");
    const weekday = WEEKDAY_LABELS_PT[new Date(`${shift.operationalDate}T12:00:00-03:00`).getUTCDay()];
    const tag = shift.paymentTag ? ` ${shift.paymentTag}` : "";
    return `${day}/${month} ${weekday} ${shift.shiftLabel} ${shift.targetCode} (${dayKindLabel(shift.operationalDate)})${tag}`;
}

function collectDoctorShifts(row: ChiefPayableDoctorRow) {
    return row.cells.flatMap((cell) => cell.shifts);
}

function doctorDisplayName(row: ChiefPayableDoctorRow) {
    return formatDoctorBackofficeName({ fullName: row.doctorName, displayName: row.displayName });
}

// Bloco markdown de um médico: heading com nome + contagem, uma linha de lista por
// plantão. Retorna null quando o médico não tem nenhum plantão no período.
export function formatDoctorBlock(row: ChiefPayableDoctorRow) {
    const shifts = collectDoctorShifts(row);
    if (shifts.length === 0) {
        return null;
    }
    const count = shifts.length;
    const header = `## 👤 ${doctorDisplayName(row)} — ${count} ${count === 1 ? "plantão" : "plantões"}`;
    return [header, "", ...shifts.map((shift) => `- ${formatShiftLine(shift)}`)].join("\n");
}

export interface PaymentDigestDocument {
    filename: string;
    content: string;
    caption: string;
}

// Monta o digest do mês como UM arquivo markdown (o volume de um mês inteiro não
// cabe em mensagens de 4096 chars — antes eram ~15 mensagens numeradas no privado).
// Retorna null quando não há nenhum plantão (evita mandar arquivo vazio).
export function buildPaymentDigestDocument(
    board: ChiefPayableBoardModel,
    referenceDate: Date,
): PaymentDigestDocument | null {
    const rows = [...board.doctors]
        .sort((a, b) => doctorDisplayName(a).localeCompare(doctorDisplayName(b), "pt-BR"));
    const blocks = rows
        .map(formatDoctorBlock)
        .filter((block): block is string => Boolean(block));

    if (blocks.length === 0) {
        return null;
    }

    const shifts = rows.flatMap(collectDoctorShifts);
    const meioCount = shifts.filter((shift) => shift.paymentTag).length;
    const parts = getSaoPauloParts(referenceDate);
    const stamp = `${pad2(parts.day)}/${pad2(parts.month)} ${pad2(parts.hour)}:${pad2(parts.minute)}`;
    const summary = `${blocks.length} médicos · ${shifts.length} plantões`
        + (meioCount > 0 ? ` (${meioCount} MEIO)` : "");

    const content = [
        `# 💰 Fechamento provisório — ${board.monthLabel}`,
        "",
        `Gerado ${stamp} · confira com cada plantonista antes de subir p/ pagamento.`,
        "",
        summary,
        "",
        blocks.join("\n\n"),
        "",
    ].join("\n");

    return {
        filename: `fechamento-provisorio-${board.monthKey}.md`,
        content,
        caption: `💰 Fechamento provisório — ${board.monthLabel}\n`
            + `Gerado ${stamp} · ${summary}\n`
            + "Confira com cada plantonista antes de subir p/ pagamento.",
    };
}

const BRL = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });

function formatBRL(value: number | null | undefined) {
    return BRL.format(Number.isFinite(value) ? Number(value) : 0);
}

function doctorShiftDue(row: ChiefPayableDoctorRow, shift: PayableShift) {
    return resolveShiftDueAmount({
        profile: row.paymentProfile ?? "generalist",
        operationalDate: shift.operationalDate,
        paymentUnit: shift.paymentUnit,
    });
}

// Variante vazia única (auditoria §3.4#7): sem link — folha vazia não ajuda ninguém.
export function buildDoctorPayrollEmptyMessage(monthLabel: string) {
    return `💰 Pagamento — ${monthLabel}: nenhum plantão registrado neste mês ainda.`;
}

// Mensagem de autoatendimento do médico: TOTAL no cabeçalho (auditoria §3.4#7 — antes
// ficava no fim, espremido acima de uma URL de ~150 chars), linhas com R$, legenda de
// MEIO quando aparece, e link assinado da folha no rodapé. Quebra por linhas se passar
// do limite, mantendo o rodapé (link) na última mensagem.
export function buildDoctorPayrollMessages(row: ChiefPayableDoctorRow, board: ChiefPayableBoardModel, folhaUrl: string): string[] {
    const shifts = row.cells.flatMap((cell) => cell.shifts);

    if (shifts.length === 0) {
        return [buildDoctorPayrollEmptyMessage(board.monthLabel)];
    }

    const total = row.totalDue ?? shifts.reduce((sum, shift) => sum + doctorShiftDue(row, shift), 0);
    const hasMeio = shifts.some((shift) => shift.paymentTag);
    const header = `💰 Seu pagamento — ${board.monthLabel} (prévia, sujeita a conferência)`
        + `\nTotal do mês: ${formatBRL(total)}`
        + (hasMeio ? "\nMEIO = meio plantão" : "");

    const lines = shifts.map((shift) => `${formatShiftLine(shift)} · ${formatBRL(doctorShiftDue(row, shift))}`);
    const footer = `📄 Folha de ponto: ${folhaUrl}`;

    // Caminho comum: cabe tudo numa mensagem.
    const full = [header, "", ...lines, "", footer].join("\n");
    if (full.length <= MAX_MESSAGE_CHARS) {
        return [full];
    }

    // Volume alto: empacota as linhas em várias mensagens; rodapé entra na última.
    const chunks: string[] = [];
    let current = header;
    for (const line of lines) {
        const candidate = `${current}\n${line}`;
        if (candidate.length <= MAX_MESSAGE_CHARS) {
            current = candidate;
            continue;
        }
        chunks.push(current);
        current = line;
    }
    const footerBlock = `\n\n${footer}`;
    if (current.length + footerBlock.length <= MAX_MESSAGE_CHARS) {
        current += footerBlock;
        chunks.push(current);
    } else {
        chunks.push(current, footer);
    }
    const total2 = chunks.length;
    return chunks.map((chunk, index) => `(${index + 1}/${total2})\n${chunk}`);
}

export function shouldSendPaymentDigest(referenceDate: Date) {
    const parts = getSaoPauloParts(referenceDate);
    return parts.hour === 12 && parts.minute < 10;
}

function uniqueChatIds(values: string[]) {
    return [...new Set(values.filter(Boolean))];
}

function digestNoticeKey(referenceDate: Date) {
    const parts = getSaoPauloParts(referenceDate);
    return `payment-digest:${parts.year}-${pad2(parts.month)}-${pad2(parts.day)}`;
}

// Reserva idempotente por (admin, dia): primeira inserção vence, repetições no mesmo
// dia caem no onConflictDoNothing e retornam null — mesmo padrão de markNoticeSent.
async function reserveDigestNotice(noticeKey: string, chatId: string) {
    const db = getDb();
    const [inserted] = await db.insert(telegramBotNotices)
        .values({
            noticeKey: `${chatId}:${noticeKey}`,
            chatId,
            stage: STAGE,
            payload: {},
        })
        .onConflictDoNothing()
        .returning();
    return inserted ?? null;
}

async function rollbackDigestNotice(noticeKey: string, chatId: string) {
    const db = getDb();
    await db.delete(telegramBotNotices).where(eq(telegramBotNotices.noticeKey, `${chatId}:${noticeKey}`));
}

// Disparado a cada ciclo do worker; só age na janela das 12:00 (America/Sao_Paulo)
// e envia, uma vez por dia, o digest de fechamento para cada admin pessoal.
export async function sendTelegramPaymentDigestCycle(referenceDate = new Date()) {
    if (!process.env.TELEGRAM_BOT_TOKEN?.trim() || !shouldSendPaymentDigest(referenceDate)) {
        return { sent: 0, evaluated: 0 };
    }

    const admins = uniqueChatIds(getTelegramAdminUserIds());
    if (admins.length === 0) {
        return { sent: 0, evaluated: 0 };
    }

    const board = await getChiefPayableShiftsBoard();
    const document = buildPaymentDigestDocument(board, referenceDate);
    if (!document) {
        return { sent: 0, evaluated: 0 };
    }

    const noticeKey = digestNoticeKey(referenceDate);
    let sent = 0;
    let evaluated = 0;

    for (const chatId of admins) {
        evaluated += 1;
        const reserved = await reserveDigestNotice(noticeKey, chatId);
        if (!reserved) {
            continue;
        }

        try {
            await sendDocument(chatId, document);
            sent += 1;
        } catch (error) {
            await rollbackDigestNotice(noticeKey, chatId);
            console.error(`telegram payment digest failed for ${chatId} ${noticeKey}`, error);
        }
    }

    return { sent, evaluated };
}

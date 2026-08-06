import { NextRequest, NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { getDb, hasDatabaseUrl } from "@/db";
import { auditLogs, doctors } from "@/db/schema";
import { readAuthenticatedSession } from "@/lib/auth/server";
import { isValidFolhaToken } from "@/lib/folha-ponto/token";
import { getSaoPauloParts } from "@/modules/operational/board-rules";
import { sendMessage } from "@/modules/telegram/api";
import { getTelegramAdminUserIds } from "@/modules/telegram/config";
import { getDoctorBankHoursEffectiveBalances } from "@/services/bank-hours-history.service";
import {
    BANK_HOURS_FOLHA_RETIRADA_MARKER,
    BANK_HOURS_SETTLEMENT_THRESHOLD_MINUTES,
    isChiefByPost2031,
    loadBankHoursSettlementsForMonth,
    settleBankHours,
} from "@/services/bank-hours-settlements.service";
import { syncContractLedgerForMonth } from "@/services/contract-ledger.service";
import { getChiefPayableShiftsBoard } from "@/services/payable-shifts.service";

const payloadSchema = z.object({
    medicoId: z.string().uuid(),
    monthKey: z.string().regex(/^\d{4}-\d{2}$/),
    action: z.enum(["bonus", "penalty"]),
    operationalDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    shiftLabel: z.enum(["SD", "SN"]).optional(),
    /** Token assinado da folha (acesso pelo link do bot, sem login). */
    t: z.string().optional(),
});

/**
 * Autoatendimento do banco de horas na área do médico:
 *  - bonus: registra um plantão extra de 12h numa data escolhida (abate +12h);
 *  - penalty: retira um plantão real escolhido da folha (compensa -12h).
 *
 * Quem já deu plantão na 2031 (chefia) registra o extra sem o gate de +12h —
 * o saldo desconta do mesmo jeito e a revisão fica com o coordenador, que vê o
 * lançamento (e pode estorná-lo) nas telas de admin.
 */
export async function POST(request: NextRequest) {
    if (!hasDatabaseUrl()) {
        return NextResponse.json({ error: "DATABASE_URL is not configured." }, { status: 503 });
    }

    const parsed = payloadSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
        return NextResponse.json({ error: "Dados inválidos." }, { status: 400 });
    }
    const { medicoId, monthKey, action, operationalDate } = parsed.data;
    const [ano, mes] = monthKey.split("-").map(Number);

    // Identidade: sessão do PRÓPRIO médico ou token assinado deste médico/mês.
    const session = await readAuthenticatedSession();
    const isOwnSession = Boolean(session?.user.doctorId && session.user.doctorId === medicoId);
    const tokenValido = isValidFolhaToken(parsed.data.t, { medicoId, ano, mes });
    if (!isOwnSession && !tokenValido) {
        return NextResponse.json({ error: "Acesso negado." }, { status: 403 });
    }

    // Competência: só o mês corrente (SP) aceita autoatendimento.
    const nowParts = getSaoPauloParts(new Date());
    const currentMonthKey = `${nowParts.year}-${String(nowParts.month).padStart(2, "0")}`;
    if (monthKey !== currentMonthKey) {
        return NextResponse.json({ error: "Só o mês corrente aceita este registro." }, { status: 409 });
    }
    if (!operationalDate.startsWith(monthKey)) {
        return NextResponse.json({ error: "A data precisa estar dentro do mês corrente." }, { status: 400 });
    }

    try {
        const balances = await getDoctorBankHoursEffectiveBalances();
        const balance = balances.get(medicoId)
            ?? { totalMinutes: 0, oldMinutes: 0, recentMinutes: 0, bonusEligibleMinutes: 0, penaltyEligibleMinutes: 0 };

        // Anti-duplo-clique/abas: um lançamento de autoatendimento por dia+direção.
        const monthSettlements = (await loadBankHoursSettlementsForMonth(monthKey)).get(medicoId) ?? [];
        const duplicate = monthSettlements.some((settlement) =>
            settlement.kind === action
            && settlement.operationalDate === operationalDate
            && settlement.notes.includes("autoatendimento"));
        if (duplicate) {
            return NextResponse.json({ error: "Este dia já tem um registro igual." }, { status: 409 });
        }

        let shiftLabel: "SD" | "SN" = parsed.data.shiftLabel ?? "SD";
        let isChief = false;

        if (action === "bonus") {
            if (balance.bonusEligibleMinutes < BANK_HOURS_SETTLEMENT_THRESHOLD_MINUTES) {
                isChief = await isChiefByPost2031(medicoId);
                if (!isChief) {
                    return NextResponse.json({ error: "Sem saldo disponível." }, { status: 409 });
                }
            }
        } else {
            if (balance.penaltyEligibleMinutes > -BANK_HOURS_SETTLEMENT_THRESHOLD_MINUTES) {
                return NextResponse.json({ error: "Sem saldo negativo a compensar." }, { status: 409 });
            }
            // A retirada precisa apontar um plantão REAL dele no dia/turno escolhidos.
            const board = await getChiefPayableShiftsBoard(monthKey);
            const target = board.payableShifts.find((shift) =>
                shift.doctorId === medicoId
                && shift.operationalDate === operationalDate
                && shift.paymentUnit > 0
                && shift.source !== "admin_extra"
                && (parsed.data.shiftLabel ? shift.shiftLabel === parsed.data.shiftLabel : true));
            if (!target) {
                return NextResponse.json({ error: "Nenhum plantão seu nesse dia." }, { status: 409 });
            }
            shiftLabel = (target.shiftLabel === "SN" ? "SN" : "SD");
        }

        const note = action === "penalty"
            ? `${BANK_HOURS_FOLHA_RETIRADA_MARKER} (autoatendimento, ${operationalDate} ${shiftLabel})`
            : `plantão extra declarado (autoatendimento${isChief ? ", chefia 2031" : ""}, ${operationalDate} ${shiftLabel})`;

        const result = await settleBankHours({
            doctorId: medicoId,
            monthKey,
            kind: action,
            actorUserId: session?.user.id ?? null,
            note,
            operationalDate,
            shiftLabel,
        });

        await getDb().insert(auditLogs).values({
            actorUserId: session?.user.id ?? null,
            action: "medico.bank_hours_settlement.self_apply",
            entityType: "bank_hours_settlement",
            entityId: result.settlementId,
            details: {
                doctorId: medicoId,
                monthKey,
                kind: action,
                operationalDate,
                shiftLabel,
                viaToken: !isOwnSession,
                chiefBypass: isChief,
                balanceBeforeMinutes: balance.totalMinutes,
                bonusEligibleBefore: balance.bonusEligibleMinutes,
                penaltyEligibleBefore: balance.penaltyEligibleMinutes,
            },
        });

        revalidatePath("/admin/payment-closing");
        revalidatePath("/admin/bank-hours");
        await syncContractLedgerForMonth({ doctorId: medicoId, monthKey, actorUserId: session?.user.id ?? null });

        // Aviso imediato aos admins (best-effort): o coordenador carimba depois.
        try {
            if (process.env.TELEGRAM_BOT_TOKEN?.trim()) {
                const [doctorRow] = await getDb()
                    .select({ fullName: doctors.fullName })
                    .from(doctors)
                    .where(eq(doctors.id, medicoId))
                    .limit(1);
                const nome = doctorRow?.fullName ?? medicoId;
                const texto = action === "bonus"
                    ? `🟢 *${nome}* registrou um plantão extra de 12h em ${operationalDate} (${shiftLabel}) pelo banco de horas${isChief ? " — chefia 2031, sem gate de saldo" : ""}. Revisar em /admin/bank-hours.`
                    : `🔴 *${nome}* retirou o plantão de ${operationalDate} (${shiftLabel}) da própria folha para compensar saldo negativo. Revisar em /admin/bank-hours.`;
                for (const chatId of new Set(getTelegramAdminUserIds().filter(Boolean))) {
                    await sendMessage(chatId, texto).catch(() => undefined);
                }
            }
        } catch {
            // Telegram indisponível nunca desfaz o lançamento.
        }

        return NextResponse.json({ settlement: result });
    } catch (error) {
        return NextResponse.json(
            { error: error instanceof Error ? error.message : "Não foi possível registrar." },
            { status: 400 },
        );
    }
}

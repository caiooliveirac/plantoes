import { NextRequest, NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { getDb, hasDatabaseUrl } from "@/db";
import { auditLogs, doctors } from "@/db/schema";
import { avisarSecretario } from "@/lib/avisos/secretario";
import { formatSignedHours } from "@/modules/bank-hours/pending-actions";
import { loadDoctorBankHoursStoryLines } from "@/services/bank-hours-story.service";
import { readAuthenticatedSession } from "@/lib/auth/server";
import { isValidFolhaToken } from "@/lib/folha-ponto/token";
import { getSaoPauloParts } from "@/modules/operational/board-rules";
import { sendMessage } from "@/modules/telegram/api";
import { getTelegramAdminUserIds } from "@/modules/telegram/config";
import { getDoctorBankHoursEffectiveBalances } from "@/services/bank-hours-history.service";
import {
    BANK_HOURS_FOLHA_RETIRADA_MARKER,
    BANK_HOURS_SETTLEMENT_THRESHOLD_MINUTES,
    deleteSelfDeclaredExtra,
    isSelfServiceSettlementNote,
    loadBankHoursSettlementsForMonth,
    SELF_DECLARED_EXTRA_LABEL,
    settleBankHours,
    updateSelfDeclaredExtra,
} from "@/services/bank-hours-settlements.service";
import { syncContractLedgerForMonth } from "@/services/contract-ledger.service";
import { hasWorkedSlot } from "@/services/self-declared-extra-slots.service";
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
 * Os dois exigem saldo elegível de ±12h. Turno de CHEFIA não passa por aqui:
 * ele é pago como plantão extra sem tocar no banco de horas, e tem rota própria
 * (/api/medico/plantao-chefia).
 *
 * PATCH e DELETE (abaixo) só alcançam o extra que o PRÓPRIO médico declarou no
 * mês corrente: trocar dia/turno ou desistir dele.
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

    // Identidade: sessão do PRÓPRIO médico, token assinado deste médico/mês, ou
    // sessão ADMIN (coordenador registrando em nome do médico, direto da tela dele).
    const session = await readAuthenticatedSession();
    const isOwnSession = Boolean(session?.user.doctorId && session.user.doctorId === medicoId);
    const isAdmin = Boolean(session?.user.roles.includes("admin"));
    const tokenValido = isValidFolhaToken(parsed.data.t, { medicoId, ano, mes });
    if (!isOwnSession && !tokenValido && !isAdmin) {
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

        // Anti-duplo-clique/abas: um lançamento de autoatendimento por dia+turno+direção.
        const monthSettlements = (await loadBankHoursSettlementsForMonth(monthKey)).get(medicoId) ?? [];
        const duplicate = monthSettlements.some((settlement) =>
            settlement.kind === action
            && settlement.operationalDate === operationalDate
            && (!parsed.data.shiftLabel || settlement.shiftLabel === parsed.data.shiftLabel)
            && isSelfServiceSettlementNote(settlement.notes));
        if (duplicate) {
            return NextResponse.json({ error: "Este dia já tem um registro igual." }, { status: 409 });
        }

        let shiftLabel: "SD" | "SN" = parsed.data.shiftLabel ?? "SD";

        if (action === "bonus") {
            // Extra em cima de turno já trabalhado pagaria o mesmo slot duas vezes.
            const jaTrabalhou = await hasWorkedSlot({ monthKey, doctorId: medicoId, operationalDate, shiftLabel });
            if (jaTrabalhou) {
                return NextResponse.json(
                    { error: "Você já tem plantão nesse dia e turno. Escolha outro dia ou turno." },
                    { status: 409 },
                );
            }
            // Sem saldo, sem lançamento — nem para a chefia. Turno de chefia tem
            // porta própria (/api/medico/plantao-chefia), que não toca no saldo.
            if (balance.bonusEligibleMinutes < BANK_HOURS_SETTLEMENT_THRESHOLD_MINUTES) {
                return NextResponse.json({ error: "Sem saldo disponível." }, { status: 409 });
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
            : `plantão extra declarado (autoatendimento, ${operationalDate} ${shiftLabel})`;

        const result = await settleBankHours({
            doctorId: medicoId,
            monthKey,
            kind: action,
            actorUserId: session?.user.id ?? null,
            note,
            operationalDate,
            shiftLabel,
            // Tag do chip verde no board do coordenador: ele precisa distinguir
            // o extra que o médico declarou sozinho do que a coordenação lançou.
            label: action === "bonus" ? SELF_DECLARED_EXTRA_LABEL : undefined,
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
                viaToken: !isOwnSession && !isAdmin,
                actedByAdmin: isAdmin && !isOwnSession,
                balanceBeforeMinutes: balance.totalMinutes,
                bonusEligibleBefore: balance.bonusEligibleMinutes,
                penaltyEligibleBefore: balance.penaltyEligibleMinutes,
            },
        });

        revalidatePath("/admin/payment-closing");
        revalidatePath("/admin/bank-hours");
        await syncContractLedgerForMonth({ doctorId: medicoId, monthKey, actorUserId: session?.user.id ?? null });

        // Aviso imediato à coordenação (best-effort): o coordenador carimba depois.
        // Vai junto a HISTÓRIA dos plantões que formaram o saldo — só o total não
        // deixa ninguém desconfiar de um crédito nascido de registro errado.
        const historia = await loadDoctorBankHoursStoryLines(medicoId, action).catch(() => [] as string[]);
        const origem = historia.length > 0
            ? `\n\nDe onde veio o saldo:\n${historia.map((linha) => `• ${linha}`).join("\n")}`
            : "";

        await notifyAdmins(medicoId, (nome) => (action === "bonus"
            ? `🟢 *${nome}* registrou um plantão extra de 12h em ${operationalDate} (${shiftLabel}) pelo banco de horas.`
                + ` Saldo antes: ${formatSignedHours(balance.totalMinutes)}.${origem}\n\nRevisar em /admin/bank-hours.`
            : `🔴 *${nome}* retirou o plantão de ${operationalDate} (${shiftLabel}) da própria folha para compensar saldo negativo.`
                + ` Saldo antes: ${formatSignedHours(balance.totalMinutes)}.${origem}\n\nRevisar em /admin/bank-hours.`));

        return NextResponse.json({ settlement: result });
    } catch (error) {
        return NextResponse.json(
            { error: error instanceof Error ? error.message : "Não foi possível registrar." },
            { status: 400 },
        );
    }
}

const managePayloadSchema = z.object({
    medicoId: z.string().uuid(),
    settlementId: z.string().uuid(),
    /** Só no PATCH: o novo dia/turno do extra. */
    operationalDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    shiftLabel: z.enum(["SD", "SN"]).optional(),
    t: z.string().optional(),
});

/** Mesma porta de identidade do POST, mais a competência (só o mês corrente). */
async function authorizeManage(request: NextRequest) {
    const parsed = managePayloadSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
        return { error: NextResponse.json({ error: "Dados inválidos." }, { status: 400 }) } as const;
    }
    const { medicoId } = parsed.data;
    const nowParts = getSaoPauloParts(new Date());
    const currentMonthKey = `${nowParts.year}-${String(nowParts.month).padStart(2, "0")}`;
    const [ano, mes] = currentMonthKey.split("-").map(Number);

    const session = await readAuthenticatedSession();
    const isOwnSession = Boolean(session?.user.doctorId && session.user.doctorId === medicoId);
    const isAdmin = Boolean(session?.user.roles.includes("admin"));
    const tokenValido = isValidFolhaToken(parsed.data.t, { medicoId, ano, mes });
    if (!isOwnSession && !tokenValido && !isAdmin) {
        return { error: NextResponse.json({ error: "Acesso negado." }, { status: 403 }) } as const;
    }
    return { data: parsed.data, session, currentMonthKey, isOwnSession, isAdmin } as const;
}

/**
 * Avisa quem responde pela escala: Telegram do admin (como sempre) e WhatsApp
 * da coordenação, pelo secretário.
 *
 * Os dois canais são independentes de propósito. Antes, a mensagem inteira
 * ficava atrás do `TELEGRAM_BOT_TOKEN`: sem token, ninguém era avisado. Quem
 * mexe na folha de alguém não pode depender do canal que por acaso está
 * configurado.
 */
async function notifyAdmins(medicoId: string, texto: (nome: string) => string) {
    let mensagem: string;
    try {
        const [doctorRow] = await getDb()
            .select({ fullName: doctors.fullName })
            .from(doctors)
            .where(eq(doctors.id, medicoId))
            .limit(1);
        mensagem = texto(doctorRow?.fullName ?? medicoId);
    } catch {
        // Sem o nome não dá para escrever o aviso — e o lançamento já aconteceu.
        return;
    }

    try {
        if (process.env.TELEGRAM_BOT_TOKEN?.trim()) {
            for (const chatId of new Set(getTelegramAdminUserIds().filter(Boolean))) {
                await sendMessage(chatId, mensagem).catch(() => undefined);
            }
        }
    } catch {
        // Telegram indisponível nunca desfaz a alteração.
    }

    await avisarSecretario(mensagem);
}

async function afterManage(medicoId: string, monthKey: string, actorUserId: string | null) {
    revalidatePath("/admin/payment-closing");
    revalidatePath("/admin/bank-hours");
    await syncContractLedgerForMonth({ doctorId: medicoId, monthKey, actorUserId });
}

/** Troca o dia/turno de um extra que o próprio médico declarou no mês corrente. */
export async function PATCH(request: NextRequest) {
    if (!hasDatabaseUrl()) {
        return NextResponse.json({ error: "DATABASE_URL is not configured." }, { status: 503 });
    }
    const auth = await authorizeManage(request);
    if ("error" in auth) return auth.error;
    const { data, session, currentMonthKey } = auth;

    const operationalDate = data.operationalDate;
    const shiftLabel = data.shiftLabel ?? "SD";
    if (!operationalDate) {
        return NextResponse.json({ error: "Informe a nova data." }, { status: 400 });
    }
    if (!operationalDate.startsWith(currentMonthKey)) {
        return NextResponse.json({ error: "A data precisa estar dentro do mês corrente." }, { status: 400 });
    }

    try {
        const jaTrabalhou = await hasWorkedSlot({
            monthKey: currentMonthKey,
            doctorId: data.medicoId,
            operationalDate,
            shiftLabel,
        });
        if (jaTrabalhou) {
            return NextResponse.json(
                { error: "Você já tem plantão nesse dia e turno. Escolha outro dia ou turno." },
                { status: 409 },
            );
        }

        await updateSelfDeclaredExtra({
            settlementId: data.settlementId,
            doctorId: data.medicoId,
            currentMonthKey,
            operationalDate,
            shiftLabel,
        });

        await getDb().insert(auditLogs).values({
            actorUserId: session?.user.id ?? null,
            action: "medico.bank_hours_settlement.self_update",
            entityType: "bank_hours_settlement",
            entityId: data.settlementId,
            details: { doctorId: data.medicoId, monthKey: currentMonthKey, operationalDate, shiftLabel },
        });

        await afterManage(data.medicoId, currentMonthKey, session?.user.id ?? null);
        await notifyAdmins(data.medicoId, (nome) =>
            `✏️ *${nome}* mudou o plantão extra declarado para ${operationalDate} (${shiftLabel}). Revisar em /admin/bank-hours.`);

        return NextResponse.json({ ok: true });
    } catch (error) {
        return NextResponse.json(
            { error: error instanceof Error ? error.message : "Não foi possível alterar." },
            { status: 409 },
        );
    }
}

/** Desiste de um extra que o próprio médico declarou no mês corrente. */
export async function DELETE(request: NextRequest) {
    if (!hasDatabaseUrl()) {
        return NextResponse.json({ error: "DATABASE_URL is not configured." }, { status: 503 });
    }
    const auth = await authorizeManage(request);
    if ("error" in auth) return auth.error;
    const { data, session, currentMonthKey } = auth;

    try {
        const removed = await deleteSelfDeclaredExtra({
            settlementId: data.settlementId,
            doctorId: data.medicoId,
            currentMonthKey,
        });

        await getDb().insert(auditLogs).values({
            actorUserId: session?.user.id ?? null,
            action: "medico.bank_hours_settlement.self_delete",
            entityType: "bank_hours_settlement",
            entityId: data.settlementId,
            details: { doctorId: data.medicoId, monthKey: currentMonthKey, ...removed },
        });

        await afterManage(data.medicoId, currentMonthKey, session?.user.id ?? null);
        await notifyAdmins(data.medicoId, (nome) =>
            `🗑️ *${nome}* retirou o plantão extra declarado de ${removed.operationalDate} (${removed.shiftLabel}). Revisar em /admin/bank-hours.`);

        return NextResponse.json({ ok: true });
    } catch (error) {
        return NextResponse.json(
            { error: error instanceof Error ? error.message : "Não foi possível remover." },
            { status: 409 },
        );
    }
}

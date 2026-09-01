/**
 * Plantão extra de CHEFIA — rota própria, sem nenhuma linha de banco de horas.
 *
 * É de propósito que isto não vive em /api/medico/bank-hours-self-service: lá
 * todo lançamento nasce de um acerto de ±12h e mexe no saldo. Aqui não há
 * settlement, não há gate de saldo e não há débito — o turno de chefia é pago
 * como plantão extra e ponto.
 *
 * Quem pode: quem já deu plantão na 2031 ou está na allowlist nominal.
 * Competência: mês corrente ou mês anterior ainda não atestado, igual ao resto
 * do autoatendimento (ver lib/medico/competencia.ts).
 */
import { NextRequest, NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getDb, hasDatabaseUrl } from "@/db";
import { auditLogs, doctors } from "@/db/schema";
import { eq } from "drizzle-orm";
import { avisarSecretario } from "@/lib/avisos/secretario";
import { autorizarPainelDoMedico } from "@/lib/medico/painel-acesso";
import { competenciaDoAutoatendimento, mesCorrenteSP } from "@/lib/medico/competencia";
import { sendMessage } from "@/modules/telegram/api";
import { getTelegramAdminUserIds } from "@/modules/telegram/config";
import {
    canDeclareChiefExtraShift,
    createChiefExtraShift,
    deleteChiefExtraShift,
    updateChiefExtraShift,
} from "@/services/chief-extra-shifts.service";
import { syncContractLedgerForMonth } from "@/services/contract-ledger.service";
import { hasWorkedSlot } from "@/services/self-declared-extra-slots.service";

const createSchema = z.object({
    medicoId: z.string().uuid(),
    operationalDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    shiftLabel: z.enum(["SD", "SN"]),
    // Plantão inteiro (1 unidade) ou meio plantão (0,5 — metade do valor).
    coverage: z.enum(["full", "half"]).optional(),
    t: z.string().optional(),
});

const manageSchema = z.object({
    medicoId: z.string().uuid(),
    extraShiftId: z.string().uuid(),
    /** Competência do lançamento. Ausente (cliente antigo) = mês corrente. */
    monthKey: z.string().regex(/^\d{4}-\d{2}$/).optional(),
    operationalDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    shiftLabel: z.enum(["SD", "SN"]).optional(),
    coverage: z.enum(["full", "half"]).optional(),
    t: z.string().optional(),
});

/** Sufixo das mensagens/avisos: só o meio plantão precisa de destaque. */
function coverageSuffix(coverage: "full" | "half"): string {
    return coverage === "half" ? ", MEIO plantão — vale metade" : "";
}

/**
 * Identidade + competência numa chamada só. `monthKey` é o mês do lançamento —
 * o token da folha vale para UM médico/mês, então ele é validado contra esse
 * mês, não contra o mês de hoje.
 */
async function autorizar(medicoId: string, token: string | undefined, monthKey: string) {
    const [ano, mes] = monthKey.split("-").map(Number);
    const acesso = await autorizarPainelDoMedico({ medicoId, ano, mes, token });
    const competencia = acesso.autorizado
        ? await competenciaDoAutoatendimento({ doctorId: medicoId, monthKey, isAdmin: acesso.isAdmin })
        : { aberta: false, erro: null };
    return { acesso, competencia, monthKey };
}

/** Aviso best-effort à coordenação — Telegram do admin + WhatsApp do secretário. */
async function avisarCoordenacao(medicoId: string, texto: (nome: string) => string) {
    let mensagem: string;
    try {
        const [doctor] = await getDb()
            .select({ fullName: doctors.fullName })
            .from(doctors)
            .where(eq(doctors.id, medicoId))
            .limit(1);
        mensagem = texto(doctor?.fullName ?? medicoId);
    } catch {
        return;
    }
    try {
        if (process.env.TELEGRAM_BOT_TOKEN?.trim()) {
            for (const chatId of new Set(getTelegramAdminUserIds().filter(Boolean))) {
                await sendMessage(chatId, mensagem).catch(() => undefined);
            }
        }
    } catch {
        // Canal indisponível nunca desfaz o lançamento.
    }
    await avisarSecretario(mensagem);
}

async function depois(medicoId: string, monthKey: string, actorUserId: string | null) {
    revalidatePath("/admin/payment-closing");
    await syncContractLedgerForMonth({ doctorId: medicoId, monthKey, actorUserId });
}

export async function POST(request: NextRequest) {
    if (!hasDatabaseUrl()) {
        return NextResponse.json({ error: "DATABASE_URL is not configured." }, { status: 503 });
    }
    const parsed = createSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
        return NextResponse.json({ error: "Dados inválidos." }, { status: 400 });
    }
    const { medicoId, operationalDate, shiftLabel } = parsed.data;
    const coverage = parsed.data.coverage ?? "full";
    const { acesso, competencia, monthKey } = await autorizar(medicoId, parsed.data.t, operationalDate.slice(0, 7));
    if (!acesso.autorizado) {
        return NextResponse.json({ error: "Acesso negado." }, { status: 403 });
    }
    if (!competencia.aberta) {
        return NextResponse.json({ error: competencia.erro }, { status: 409 });
    }
    if (!(await canDeclareChiefExtraShift(medicoId))) {
        return NextResponse.json({ error: "Você não está liberado a declarar plantão de chefia." }, { status: 403 });
    }

    try {
        // Extra em cima de turno já trabalhado pagaria o mesmo slot duas vezes.
        if (await hasWorkedSlot({ monthKey, doctorId: medicoId, operationalDate, shiftLabel })) {
            return NextResponse.json(
                { error: "Você já tem plantão nesse dia e turno. Escolha outro dia ou turno." },
                { status: 409 },
            );
        }

        const created = await createChiefExtraShift({
            doctorId: medicoId,
            operationalDate,
            shiftLabel,
            coverage,
            actorUserId: acesso.session?.user.id ?? null,
        });

        await getDb().insert(auditLogs).values({
            actorUserId: acesso.session?.user.id ?? null,
            action: "medico.chief_extra_shift.create",
            entityType: "admin_extra_shift",
            entityId: created.id,
            details: {
                doctorId: medicoId,
                monthKey,
                operationalDate,
                shiftLabel,
                coverage,
                viaToken: !acesso.isOwnSession && !acesso.isAdmin,
                actedByAdmin: acesso.isAdmin && !acesso.isOwnSession,
            },
        });

        await depois(medicoId, monthKey, acesso.session?.user.id ?? null);
        await avisarCoordenacao(medicoId, (nome) =>
            `🟣 *${nome}* registrou um PLANTÃO DE CHEFIA em ${operationalDate} (${shiftLabel}${coverageSuffix(coverage)}).`
            + ` Não é banco de horas: nenhum saldo foi movido. Revisar em /admin/payment-closing.`);

        return NextResponse.json({ chiefExtraShift: created });
    } catch (error) {
        return NextResponse.json(
            { error: error instanceof Error ? error.message : "Não foi possível registrar." },
            { status: 409 },
        );
    }
}

export async function PATCH(request: NextRequest) {
    if (!hasDatabaseUrl()) {
        return NextResponse.json({ error: "DATABASE_URL is not configured." }, { status: 503 });
    }
    const parsed = manageSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
        return NextResponse.json({ error: "Dados inválidos." }, { status: 400 });
    }
    const { medicoId, extraShiftId, operationalDate } = parsed.data;
    const shiftLabel = parsed.data.shiftLabel ?? "SD";
    if (!operationalDate) {
        return NextResponse.json({ error: "Informe a nova data." }, { status: 400 });
    }
    // O plantão só se move dentro do próprio mês: o guard de `updateChiefExtraShift`
    // procura a linha na janela deste monthKey, então mudar de mês não acha nada.
    const { acesso, competencia, monthKey } = await autorizar(medicoId, parsed.data.t, operationalDate.slice(0, 7));
    if (!acesso.autorizado) {
        return NextResponse.json({ error: "Acesso negado." }, { status: 403 });
    }
    if (!competencia.aberta) {
        return NextResponse.json({ error: competencia.erro }, { status: 409 });
    }

    try {
        if (await hasWorkedSlot({ monthKey, doctorId: medicoId, operationalDate, shiftLabel })) {
            return NextResponse.json(
                { error: "Você já tem plantão nesse dia e turno. Escolha outro dia ou turno." },
                { status: 409 },
            );
        }

        const updated = await updateChiefExtraShift({
            id: extraShiftId,
            doctorId: medicoId,
            monthKey,
            operationalDate,
            shiftLabel,
            coverage: parsed.data.coverage,
        });

        await getDb().insert(auditLogs).values({
            actorUserId: acesso.session?.user.id ?? null,
            action: "medico.chief_extra_shift.update",
            entityType: "admin_extra_shift",
            entityId: extraShiftId,
            details: { doctorId: medicoId, monthKey, operationalDate, shiftLabel, coverage: updated.coverage },
        });

        await depois(medicoId, monthKey, acesso.session?.user.id ?? null);
        await avisarCoordenacao(medicoId, (nome) =>
            `✏️ *${nome}* mudou o plantão de chefia para ${operationalDate} (${shiftLabel}${coverageSuffix(updated.coverage)}).`);

        return NextResponse.json({ ok: true });
    } catch (error) {
        return NextResponse.json(
            { error: error instanceof Error ? error.message : "Não foi possível alterar." },
            { status: 409 },
        );
    }
}

export async function DELETE(request: NextRequest) {
    if (!hasDatabaseUrl()) {
        return NextResponse.json({ error: "DATABASE_URL is not configured." }, { status: 503 });
    }
    const parsed = manageSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
        return NextResponse.json({ error: "Dados inválidos." }, { status: 400 });
    }
    const { medicoId, extraShiftId } = parsed.data;
    const { acesso, competencia, monthKey } = await autorizar(
        medicoId,
        parsed.data.t,
        parsed.data.monthKey ?? mesCorrenteSP(),
    );
    if (!acesso.autorizado) {
        return NextResponse.json({ error: "Acesso negado." }, { status: 403 });
    }
    if (!competencia.aberta) {
        return NextResponse.json({ error: competencia.erro }, { status: 409 });
    }

    try {
        const removed = await deleteChiefExtraShift({ id: extraShiftId, doctorId: medicoId, monthKey });

        await getDb().insert(auditLogs).values({
            actorUserId: acesso.session?.user.id ?? null,
            action: "medico.chief_extra_shift.delete",
            entityType: "admin_extra_shift",
            entityId: extraShiftId,
            details: { doctorId: medicoId, monthKey, ...removed },
        });

        await depois(medicoId, monthKey, acesso.session?.user.id ?? null);
        await avisarCoordenacao(medicoId, (nome) =>
            `🗑️ *${nome}* tirou o plantão de chefia de ${removed.operationalDate} (${removed.shiftLabel}${coverageSuffix(removed.coverage)}).`);

        return NextResponse.json({ ok: true });
    } catch (error) {
        return NextResponse.json(
            { error: error instanceof Error ? error.message : "Não foi possível remover." },
            { status: 409 },
        );
    }
}

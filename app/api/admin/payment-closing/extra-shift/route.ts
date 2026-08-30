import { NextRequest, NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getDb, hasDatabaseUrl } from "@/db";
import { auditLogs } from "@/db/schema";
import { AuthError, requireAuthenticatedSession } from "@/lib/auth/server";
import { createAdminExtraShift, removeAdminExtraShift } from "@/services/admin-extra-shifts.service";
import { createChiefExtraShift } from "@/services/chief-extra-shifts.service";
import { CHIEF_EXTRA_SHIFT_LABEL } from "@/modules/reporting/payable-shifts";
import { syncContractLedgerForMonth } from "@/services/contract-ledger.service";

const payloadSchema = z.discriminatedUnion("action", [
    z.object({
        action: z.literal("add"),
        doctorId: z.string().uuid(),
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        shift: z.enum(["SD", "SN"]),
        coverage: z.enum(["full", "half"]).optional(),
        // 'extra' (verde, motivo obrigatório) ou 'chief' (roxo, label fixo).
        type: z.enum(["extra", "chief"]).optional(),
        label: z.string().trim().max(40).optional(),
    }),
    z.object({
        action: z.literal("remove"),
        id: z.string().uuid(),
    }),
]);

export async function POST(request: NextRequest) {
    if (!hasDatabaseUrl()) {
        return NextResponse.json({ error: "DATABASE_URL is not configured for operations-v2." }, { status: 503 });
    }

    let session;
    try {
        session = await requireAuthenticatedSession(["admin"]);
    } catch (error) {
        const status = error instanceof AuthError ? error.status : 500;
        return NextResponse.json({ error: error instanceof Error ? error.message : "Unauthorized." }, { status });
    }

    const parsed = payloadSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
        return NextResponse.json({ error: "Payload invalido para plantao extra." }, { status: 400 });
    }

    try {
        if (parsed.data.action === "add") {
            const isChief = parsed.data.type === "chief";
            let extraId: string;

            if (isChief) {
                // Chefia lançada pela coordenação: mesmo registro (kind chief/
                // chief_half) que o autoatendimento do médico cria — roxo no
                // quadro, fora do banco de horas, label fixo.
                const chief = await createChiefExtraShift({
                    doctorId: parsed.data.doctorId,
                    operationalDate: parsed.data.date,
                    shiftLabel: parsed.data.shift,
                    coverage: parsed.data.coverage ?? "full",
                    actorUserId: session.user.id,
                });
                extraId = chief.id;
            } else {
                const label = parsed.data.label?.trim() ?? "";
                if (label.length < 2) {
                    return NextResponse.json(
                        { error: "Descreva o plantão extra com pelo menos 2 caracteres." },
                        { status: 400 },
                    );
                }
                const extra = await createAdminExtraShift({
                    doctorId: parsed.data.doctorId,
                    operationalDate: parsed.data.date,
                    shiftLabel: parsed.data.shift,
                    coverage: parsed.data.coverage ?? "full",
                    label,
                    actorUserId: session.user.id,
                });
                extraId = extra.id;
            }

            await getDb().insert(auditLogs).values({
                actorUserId: session.user.id,
                action: isChief ? "payment_closing.chief_extra_shift.add" : "payment_closing.extra_shift.add",
                entityType: "admin_extra_shift",
                entityId: extraId,
                details: {
                    doctorId: parsed.data.doctorId,
                    operationalDate: parsed.data.date,
                    shiftLabel: parsed.data.shift,
                    coverage: parsed.data.coverage ?? "full",
                    label: isChief ? CHIEF_EXTRA_SHIFT_LABEL : parsed.data.label?.trim(),
                    type: parsed.data.type ?? "extra",
                },
            });

            // O extra muda o total do mês DEPOIS da atestação: o razão precisa
            // acompanhar, senão o saldo desencontra do fechamento.
            await syncContractLedgerForMonth({
                doctorId: parsed.data.doctorId,
                monthKey: parsed.data.date.slice(0, 7),
                actorUserId: session.user.id,
            });

            revalidatePath("/admin/payment-closing");
            return NextResponse.json({ extraId });
        }

        const result = await removeAdminExtraShift({ id: parsed.data.id });
        if (!result.removed) {
            return NextResponse.json({ error: "Plantao extra nao encontrado." }, { status: 404 });
        }

        if (result.doctorId && result.operationalDate) {
            await syncContractLedgerForMonth({
                doctorId: result.doctorId,
                monthKey: result.operationalDate.slice(0, 7),
                actorUserId: session.user.id,
            });
        }

        await getDb().insert(auditLogs).values({
            actorUserId: session.user.id,
            action: "payment_closing.extra_shift.remove",
            entityType: "admin_extra_shift",
            entityId: parsed.data.id,
            details: { id: parsed.data.id },
        });

        revalidatePath("/admin/payment-closing");
        return NextResponse.json({ removed: true });
    } catch (error) {
        return NextResponse.json(
            { error: error instanceof Error ? error.message : "Nao foi possivel salvar o plantao extra." },
            { status: 400 },
        );
    }
}

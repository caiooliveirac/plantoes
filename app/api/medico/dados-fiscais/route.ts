import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getDb, hasDatabaseUrl } from "@/db";
import { auditLogs } from "@/db/schema";
import { readAuthenticatedSession } from "@/lib/auth/server";
import { isValidFolhaToken } from "@/lib/folha-ponto/token";
import {
    isLikelyValidCnpj,
    normalizeCnpj,
    normalizeCompanyName,
    upsertDoctorFiscalProfile,
} from "@/modules/telegram/payment-access";

const payloadSchema = z.object({
    medicoId: z.string().uuid(),
    monthKey: z.string().regex(/^\d{4}-\d{2}$/),
    razaoSocial: z.string().max(200),
    cnpj: z.string().max(40),
    /** Token assinado da folha (acesso pelo link do bot, sem login). */
    t: z.string().optional(),
});

/**
 * Razão social + CNPJ que saem na folha de ponto, editados pelo próprio médico
 * no painel. Mesma gravação e mesma validação do /pagamento cadastro do bot
 * (upsertDoctorFiscalProfile): quem troca de empresa não depende mais do bot.
 */
export async function POST(request: NextRequest) {
    if (!hasDatabaseUrl()) {
        return NextResponse.json({ error: "DATABASE_URL is not configured." }, { status: 503 });
    }

    const parsed = payloadSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
        return NextResponse.json({ error: "Dados inválidos." }, { status: 400 });
    }
    const { medicoId, monthKey } = parsed.data;
    const [ano, mes] = monthKey.split("-").map(Number);

    // Identidade: sessão do PRÓPRIO médico, token assinado deste médico/mês, ou admin.
    const session = await readAuthenticatedSession();
    const isOwnSession = Boolean(session?.user.doctorId && session.user.doctorId === medicoId);
    const isAdmin = Boolean(session?.user.roles.includes("admin"));
    const tokenValido = isValidFolhaToken(parsed.data.t, { medicoId, ano, mes });
    if (!isOwnSession && !tokenValido && !isAdmin) {
        return NextResponse.json({ error: "Acesso negado." }, { status: 403 });
    }

    const razaoSocial = normalizeCompanyName(parsed.data.razaoSocial);
    if (razaoSocial.length < 3) {
        return NextResponse.json({ error: "Razão social muito curta. Informe o nome completo da empresa." }, { status: 400 });
    }
    const cnpj = isLikelyValidCnpj(parsed.data.cnpj) ? normalizeCnpj(parsed.data.cnpj) : null;
    if (!cnpj) {
        return NextResponse.json({ error: "CNPJ inválido. Informe os 14 dígitos." }, { status: 400 });
    }

    try {
        const saved = await upsertDoctorFiscalProfile({ doctorId: medicoId, razaoSocial, cnpj });
        await getDb().insert(auditLogs).values({
            actorUserId: session?.user.id ?? null,
            action: "medico.fiscal_profile.self_update",
            entityType: "doctor",
            entityId: medicoId,
            details: {
                razaoSocial,
                cnpj,
                viaToken: !isOwnSession && !isAdmin,
                actedByAdmin: isAdmin && !isOwnSession,
            },
        });
        return NextResponse.json({ razaoSocial: saved.razaoSocial, cnpj: saved.cnpj });
    } catch (error) {
        if (error instanceof Error && error.message === "doctor_not_found") {
            return NextResponse.json({ error: "Médico não encontrado." }, { status: 404 });
        }
        throw error;
    }
}

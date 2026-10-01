/**
 * O próprio médico se move de posto pela web (transferOperationalOccupancy,
 * mesmo caminho da chefia e do bot). Hora = agora, no servidor.
 *
 * POST { domain: "regulation"|"intervention", targetId, cienteOcupado?, assumirPosto? }
 *  200 { ok: true, ocupacao: { domain, occupancyId, targetId, code, startedAt } }
 *  409 fora_de_turno | mesmo_posto | posto_ocupado (ocupante, efeito, precisaConfirmar) | posto_indisponivel
 *  403 sem_medico_vinculado | sem_papel_medico
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { hasDatabaseUrl } from "@/db";
import { AuthError, requireAuthenticatedSession } from "@/lib/auth/server";
import { PresencaRecusada, declararRemanejo, medicoDaSessao } from "@/services/medico-presenca.service";

const schema = z.object({
    domain: z.enum(["regulation", "intervention"]),
    targetId: z.coerce.number().int().positive(),
    cienteOcupado: z.boolean().optional(),
    assumirPosto: z.boolean().optional(),
});

export async function POST(request: NextRequest) {
    if (!hasDatabaseUrl()) {
        return NextResponse.json({ error: "DATABASE_URL is not configured for operations-v2." }, { status: 503 });
    }

    let session;
    try {
        session = await requireAuthenticatedSession();
    } catch (error) {
        const status = error instanceof AuthError ? error.status : 500;
        return NextResponse.json({ error: error instanceof Error ? error.message : "Unauthorized." }, { status });
    }

    const parsed = schema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
        return NextResponse.json({ error: "payload_invalido" }, { status: 400 });
    }

    try {
        const medico = medicoDaSessao(session);
        const ocupacao = await declararRemanejo({
            medico,
            domain: parsed.data.domain,
            targetId: parsed.data.targetId,
            cienteOcupado: parsed.data.cienteOcupado === true,
            assumirPosto: parsed.data.assumirPosto === true,
        });
        return NextResponse.json({ ok: true, ocupacao });
    } catch (error) {
        if (error instanceof PresencaRecusada) {
            return NextResponse.json(error.body, { status: error.status });
        }
        return NextResponse.json({ error: error instanceof Error ? error.message : "remanejo_falhou" }, { status: 400 });
    }
}

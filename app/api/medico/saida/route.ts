/**
 * Saída declarada pelo próprio médico na web — o mesmo fechamento do "saí" do
 * bot: fica a confirmar pela chefia (docs/saidas-a-confirmar.md).
 *
 * POST {}
 *  200 { ok: true, saida: { at, aConfirmar }, previa }
 *  409 fora_de_turno · 403 sem_medico_vinculado | sem_papel_medico
 */
import { NextResponse } from "next/server";
import { hasDatabaseUrl } from "@/db";
import { AuthError, requireAuthenticatedSession } from "@/lib/auth/server";
import { PresencaRecusada, declararSaida, medicoDaSessao } from "@/services/medico-presenca.service";

export async function POST() {
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

    try {
        const medico = medicoDaSessao(session);
        const { previa, ...saida } = await declararSaida({ medico });
        return NextResponse.json({ ok: true, saida, previa });
    } catch (error) {
        if (error instanceof PresencaRecusada) {
            return NextResponse.json(error.body, { status: error.status });
        }
        return NextResponse.json({ error: error instanceof Error ? error.message : "saida_falhou" }, { status: 400 });
    }
}

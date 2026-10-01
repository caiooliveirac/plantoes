/**
 * Estado do próprio médico para a área do médico na web.
 *
 * GET → 200 { medico: { id, nome }, emTurno: null | { domain, occupancyId, targetId,
 *            code, startedAt, saidaDeclaradaAt }, previa: null | {...banco de horas até agora} }
 *  403 sem_medico_vinculado | sem_papel_medico
 */
import { NextResponse } from "next/server";
import { hasDatabaseUrl } from "@/db";
import { AuthError, requireAuthenticatedSession } from "@/lib/auth/server";
import { PresencaRecusada, estadoDoMedico, medicoDaSessao } from "@/services/medico-presenca.service";

export async function GET() {
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
        return NextResponse.json(await estadoDoMedico(medico.doctorId));
    } catch (error) {
        if (error instanceof PresencaRecusada) {
            return NextResponse.json(error.body, { status: error.status });
        }
        return NextResponse.json({ error: error instanceof Error ? error.message : "estado_falhou" }, { status: 400 });
    }
}

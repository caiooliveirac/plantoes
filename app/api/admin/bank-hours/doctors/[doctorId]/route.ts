import { NextRequest, NextResponse } from "next/server";
import { hasDatabaseUrl } from "@/db";
import { AuthError, requireAuthenticatedSession } from "@/lib/auth/server";
import { getBankHoursHistory } from "@/services/bank-hours-history.service";

/**
 * Detalhe de UM médico para a tela gerencial do banco de horas: a lista chega
 * enxuta no primeiro render e o histórico completo (prova, auditoria,
 * correções) só é carregado quando o admin abre o médico.
 */
export async function GET(_request: NextRequest, context: { params: Promise<{ doctorId: string }> }) {
    if (!hasDatabaseUrl()) {
        return NextResponse.json({ error: "DATABASE_URL is not configured for operations-v2." }, { status: 503 });
    }

    try {
        await requireAuthenticatedSession(["admin"]);
    } catch (error) {
        const status = error instanceof AuthError ? error.status : 500;
        return NextResponse.json({ error: error instanceof Error ? error.message : "Unauthorized." }, { status });
    }

    const { doctorId } = await context.params;
    if (!/^[0-9a-f-]{36}$/i.test(doctorId)) {
        return NextResponse.json({ error: "Médico inválido." }, { status: 400 });
    }

    const history = await getBankHoursHistory({ doctorId });
    const doctor = history.doctors.find((row) => row.doctorId === doctorId) ?? null;
    return NextResponse.json({ doctor }, { headers: { "Cache-Control": "no-store" } });
}

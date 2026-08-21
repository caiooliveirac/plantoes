import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { getDb, hasDatabaseUrl } from "@/db";
import { auditLogs, doctors, regulationOccupancies, regulationPosts } from "@/db/schema";
import { AuthError, requireAuthenticatedSession } from "@/lib/auth/server";
import { avisarSecretario } from "@/lib/avisos/secretario";
import { buildChiefExitUnknownNotice } from "@/modules/operational/chief-arrival-guard";

/**
 * "Não sei dizer a que horas o chefe saiu."
 *
 * Não fecha nada e não credita nada: registra quem não soube, avisa a
 * coordenação no WhatsApp e devolve o caso para a pergunta obrigatória do
 * quadro, que volta a aparecer. O banco de horas do chefe fica travado até
 * alguém informar o horário — que é exatamente o efeito desejado.
 */
export async function POST(_request: Request, context: { params: Promise<{ id: string }> }) {
    if (!hasDatabaseUrl()) {
        return NextResponse.json({ error: "DATABASE_URL is not configured for operations-v2." }, { status: 503 });
    }

    let session;
    try {
        session = await requireAuthenticatedSession(["admin", "chief"]);
    } catch (error) {
        const status = error instanceof AuthError ? error.status : 500;
        return NextResponse.json({ error: error instanceof Error ? error.message : "Unauthorized." }, { status });
    }

    const { id } = await context.params;
    const db = getDb();
    const existing = await db.query.regulationOccupancies.findFirst({
        where: eq(regulationOccupancies.id, id),
    });
    if (!existing) {
        return NextResponse.json({ error: "Regulation occupancy not found." }, { status: 404 });
    }

    const [post, doctor] = await Promise.all([
        db.query.regulationPosts.findFirst({
            where: eq(regulationPosts.id, existing.postId),
            columns: { code: true },
        }),
        db.query.doctors.findFirst({
            where: eq(doctors.id, existing.doctorId),
            columns: { fullName: true, displayName: true },
        }),
    ]);

    const handoffAt = existing.endedAt ?? existing.scheduledEndAt ?? existing.startedAt;

    await db.insert(auditLogs).values({
        actorUserId: session.user.id,
        action: "chief_exit.unknown_reported",
        entityType: "regulation_occupancy",
        entityId: id,
        details: {
            postCode: post?.code ?? null,
            doctorId: existing.doctorId,
            doctorName: doctor?.displayName ?? doctor?.fullName ?? null,
            handoffAt: handoffAt.toISOString(),
            actorEmail: session.user.email,
        },
    });

    await avisarSecretario(buildChiefExitUnknownNotice({
        doctorName: doctor?.displayName ?? doctor?.fullName ?? null,
        postCode: post?.code ?? "2031",
        handoffAt,
        actorLabel: session.user.email,
    }));

    return NextResponse.json({ ok: true });
}

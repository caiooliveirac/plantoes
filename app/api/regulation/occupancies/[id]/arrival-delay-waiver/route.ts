import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { getDb, hasDatabaseUrl } from "@/db";
import { auditLogs, doctors, regulationOccupancies, regulationPosts } from "@/db/schema";
import { AuthError, requireMesaEscrita } from "@/lib/auth/server";
import { avisarSecretario } from "@/lib/avisos/secretario";
import { publishBoardUpdate } from "@/lib/board-live";
import { setArrivalDelayWaiver } from "@/modules/operational/atraso-desconsiderado";
import {
    buildChiefArrivalBlockNotice,
    CHIEF_ARRIVAL_ADMIN_ONLY_CODE,
    CHIEF_ARRIVAL_ADMIN_ONLY_MESSAGE,
    shouldBlockChiefArrivalEdit,
} from "@/modules/operational/chief-arrival-guard";

// Atraso desconsiderado pela chefia: marcar exige motivo (os chips da Mesa,
// como "Avisou antes da chegada", já cumprem o mínimo); desmarcar não.
const schema = z.object({
    waived: z.boolean(),
    note: z.string().trim().optional(),
}).refine((value) => !value.waived || (value.note?.length ?? 0) >= 8, {
    message: "Motivo obrigatório (mínimo 8 caracteres) para desconsiderar o atraso.",
    path: ["note"],
});

export async function POST(request: NextRequest, context: RouteContext<"/api/regulation/occupancies/[id]/arrival-delay-waiver">) {
    if (!hasDatabaseUrl()) {
        return NextResponse.json({ error: "DATABASE_URL is not configured for operations-v2." }, { status: 503 });
    }

    let session;
    try {
        session = await requireMesaEscrita(["admin", "chief"]);
    } catch (error) {
        const status = error instanceof AuthError ? error.status : 500;
        return NextResponse.json({ error: error instanceof Error ? error.message : "Unauthorized." }, { status });
    }

    const parsed = schema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
        return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid arrival delay waiver payload." }, { status: 400 });
    }

    const { id } = await context.params;
    try {
        const db = getDb();
        const existing = await db.query.regulationOccupancies.findFirst({
            where: eq(regulationOccupancies.id, id),
        });
        if (!existing) {
            return NextResponse.json({ error: "Regulation occupancy not found." }, { status: 404 });
        }
        const currentPost = await db.query.regulationPosts.findFirst({
            where: eq(regulationPosts.id, existing.postId),
            columns: { code: true },
        });

        // Mesma trava da edição de chegada: na 2031 (chefia de plantão) o atraso
        // mexe no banco de quem ficou — só admin decide; chefe deixa o pedido.
        if (shouldBlockChiefArrivalEdit({
            postCode: currentPost?.code,
            isAdmin: session.user.roles.includes("admin"),
            arrivalChanged: true,
        })) {
            const doctor = await db.query.doctors.findFirst({
                where: eq(doctors.id, existing.doctorId),
                columns: { fullName: true, displayName: true },
            });
            await db.insert(auditLogs).values({
                actorUserId: session.user.id,
                action: "chief_arrival_change.requested",
                entityType: "regulation_occupancy",
                entityId: id,
                details: {
                    postCode: currentPost?.code ?? null,
                    doctorId: existing.doctorId,
                    doctorName: doctor?.displayName ?? doctor?.fullName ?? null,
                    currentStartedAt: existing.startedAt.toISOString(),
                    requestedStartedAt: null,
                    requestedArrivalDelayWaiver: parsed.data.waived,
                    note: parsed.data.note ?? null,
                    channel: "quadro",
                    actorEmail: session.user.email,
                },
            });
            await avisarSecretario(buildChiefArrivalBlockNotice({
                doctorName: doctor?.displayName ?? doctor?.fullName ?? null,
                actorLabel: session.user.email,
                postCode: currentPost?.code ?? String(existing.postId),
                currentArrivalAt: existing.startedAt,
                requestedArrivalAt: null,
                note: parsed.data.waived
                    ? `desconsiderar o atraso — ${parsed.data.note ?? ""}`.trim()
                    : "voltar a contar o atraso",
                channel: "quadro",
            }));
            return NextResponse.json(
                { error: CHIEF_ARRIVAL_ADMIN_ONLY_MESSAGE, code: CHIEF_ARRIVAL_ADMIN_ONLY_CODE },
                { status: 403 },
            );
        }

        const { occupancy } = await setArrivalDelayWaiver(db, {
            domain: "regulation",
            occupancyId: id,
            waived: parsed.data.waived,
            note: parsed.data.note ?? null,
            actorUserId: session.user.id,
        });
        publishBoardUpdate("arrival-delay-waiver");
        return NextResponse.json({
            ok: true,
            occupancy: {
                id: occupancy.id,
                arrivalDelayWaivedAt: occupancy.arrivalDelayWaivedAt,
                arrivalDelayWaiverNote: occupancy.arrivalDelayWaiverNote,
            },
        });
    } catch (error) {
        return NextResponse.json(
            { error: error instanceof Error ? error.message : "Unable to update arrival delay waiver." },
            { status: 400 },
        );
    }
}

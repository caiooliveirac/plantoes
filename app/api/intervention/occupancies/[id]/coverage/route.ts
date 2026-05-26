import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { hasDatabaseUrl, getDb } from "@/db";
import { auditLogs, doctors, interventionBases, interventionOccupancies } from "@/db/schema";
import { eq } from "drizzle-orm";
import { AuthError, requireAuthenticatedSession } from "@/lib/auth/server";
import {
    markInterventionAsCoverage,
    unmarkInterventionAsCoverage,
} from "@/modules/bank-hours/coverage";
import { buildCoverageAnnouncement } from "@/modules/telegram/coverage-prompt";
import { sendMessage } from "@/modules/telegram/api";
import { getTelegramAllowedChatIds } from "@/modules/telegram/config";

const patchSchema = z.object({
    coverageKind: z.literal("COBERTURA").nullable(),
    note: z.string().trim().min(0).max(500).optional().nullable(),
    announceChatIds: z.array(z.string().min(1)).optional(),
});

export async function PATCH(request: NextRequest, context: { params: Promise<{ id: string }> }) {
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

    const parsed = patchSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
        return NextResponse.json({ error: "Invalid coverage payload.", details: parsed.error.format() }, { status: 400 });
    }

    const { id } = await context.params;

    try {
        if (parsed.data.coverageKind === null) {
            const result = await unmarkInterventionAsCoverage({
                occupancyId: id,
                actor: { userId: session.user.id },
            });
            await getDb().insert(auditLogs).values({
                actorUserId: session.user.id,
                action: "intervention_occupancy.coverage.unmarked",
                entityType: "intervention_occupancy",
                entityId: id,
                details: { wasCoverage: result.wasCoverage },
            });
            return NextResponse.json({ ok: true, coverageKind: null, wasCoverage: result.wasCoverage });
        }

        const result = await markInterventionAsCoverage({
            occupancyId: id,
            note: parsed.data.note ?? null,
            actor: { userId: session.user.id },
        });

        await getDb().insert(auditLogs).values({
            actorUserId: session.user.id,
            action: "intervention_occupancy.coverage.marked",
            entityType: "intervention_occupancy",
            entityId: id,
            details: {
                coverageKind: result.coverageKind,
                arrivalDelayMinutes: result.arrivalDelayMinutes,
                note: result.coverageNote,
            },
        });

        // Public announcement when requested. The drawer client can pass the
        // chatIds it wants the bot to publish to (typically the operational
        // groups). If none provided, default to all allowed chats.
        const chatIds = parsed.data.announceChatIds && parsed.data.announceChatIds.length > 0
            ? parsed.data.announceChatIds
            : getTelegramAllowedChatIds().filter((chatId) => chatId.startsWith("-"));

        if (chatIds.length > 0) {
            const [doctorRow, baseRow] = await Promise.all([
                getDb().query.doctors.findFirst({ where: eq(doctors.id, result.doctorId) }),
                getDb().query.interventionBases.findFirst({ where: eq(interventionBases.id, result.baseId) }),
            ]);
            const doctorName = doctorRow?.displayName ?? doctorRow?.fullName ?? "medico desconhecido";
            const baseCode = baseRow?.code ?? "base desconhecida";
            const announcement = buildCoverageAnnouncement({
                doctorName,
                baseCode,
                delayMinutes: result.arrivalDelayMinutes,
                markedByLabel: session.user.email ?? session.user.id,
                markedByChefe: true,
                source: "drawer",
            });
            await Promise.allSettled(chatIds.map((chatId) => sendMessage(chatId, announcement).catch(() => null)));
        }

        return NextResponse.json({
            ok: true,
            coverageKind: result.coverageKind,
            arrivalDelayMinutes: result.arrivalDelayMinutes,
            coverageMarkedAt: result.coverageMarkedAt,
        });
    } catch (error) {
        return NextResponse.json(
            { error: error instanceof Error ? error.message : "Unable to update coverage." },
            { status: 400 },
        );
    }
}

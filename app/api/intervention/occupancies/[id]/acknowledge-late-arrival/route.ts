import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { hasDatabaseUrl, getDb } from "@/db";
import { auditLogs, doctors, interventionBases } from "@/db/schema";
import { AuthError, requireAuthenticatedSession } from "@/lib/auth/server";
import {
    acknowledgeInterventionLateArrival,
    revertInterventionLateArrival,
} from "@/modules/bank-hours/late-arrival";
import { buildLateArrivalAcknowledgementAnnouncement } from "@/modules/telegram/late-arrival-prompt";
import { sendMessage } from "@/modules/telegram/api";
import { getTelegramAllowedChatIds } from "@/modules/telegram/config";

const patchSchema = z.object({
    acknowledged: z.boolean(),
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
        return NextResponse.json({ error: "Invalid payload.", details: parsed.error.format() }, { status: 400 });
    }

    const { id } = await context.params;

    try {
        if (!parsed.data.acknowledged) {
            const result = await revertInterventionLateArrival({
                occupancyId: id,
                actor: { userId: session.user.id },
            });
            await getDb().insert(auditLogs).values({
                actorUserId: session.user.id,
                action: "intervention_occupancy.late_arrival.reverted",
                entityType: "intervention_occupancy",
                entityId: id,
                details: { wasAcknowledged: result.wasAcknowledged },
            });
            return NextResponse.json({ ok: true, acknowledged: false, wasAcknowledged: result.wasAcknowledged });
        }

        const result = await acknowledgeInterventionLateArrival({
            occupancyId: id,
            note: parsed.data.note ?? null,
            actor: { userId: session.user.id },
        });

        await getDb().insert(auditLogs).values({
            actorUserId: session.user.id,
            action: "intervention_occupancy.late_arrival.acknowledged",
            entityType: "intervention_occupancy",
            entityId: id,
            details: {
                actualStartAt: result.actualStartAt,
                newScheduledStartAt: result.newScheduledStartAt,
                newScheduledEndAt: result.newScheduledEndAt,
                carryoverMinutes: result.carryoverMinutes,
            },
        });

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
            const actualStartLabel = new Date(result.actualStartAt).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit", timeZone: "America/Bahia" });
            const announcement = buildLateArrivalAcknowledgementAnnouncement({
                doctorName,
                baseCode,
                actualStartLabel,
                carryoverMinutes: result.carryoverMinutes,
                markedByLabel: session.user.email ?? session.user.id,
                markedByChefe: true,
                source: "drawer",
            });
            await Promise.allSettled(chatIds.map((chatId) => sendMessage(chatId, announcement).catch(() => null)));
        }

        return NextResponse.json({
            ok: true,
            acknowledged: true,
            carryoverMinutes: result.carryoverMinutes,
            newScheduledStartAt: result.newScheduledStartAt,
            newScheduledEndAt: result.newScheduledEndAt,
        });
    } catch (error) {
        return NextResponse.json(
            { error: error instanceof Error ? error.message : "Unable to update late-arrival acknowledgement." },
            { status: 400 },
        );
    }
}

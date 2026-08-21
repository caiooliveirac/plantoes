import { NextResponse } from "next/server";
import { and, desc, eq, gte, inArray } from "drizzle-orm";
import { z } from "zod";
import { getDb, hasDatabaseUrl } from "@/db";
import { auditLogs } from "@/db/schema";
import { AuthError, requireAuthenticatedSession } from "@/lib/auth/server";
import { correctRegulationOccupancy } from "@/modules/operational/corrections";

/**
 * Pedidos de correção da chegada da chefia (2031).
 *
 * Chefe barrado no quadro deixa aqui o horário que ele diz ser o certo, com o
 * motivo. Nenhuma tabela nova: o pedido é a linha de `audit_logs`
 * `chief_arrival_change.requested`, e a resolução é outra linha (`applied` /
 * `dismissed`) apontando para ela. Aberto = pedido sem resolução.
 */

const REQUEST_ACTION = "chief_arrival_change.requested";
const RESOLVED_ACTIONS = ["chief_arrival_change.applied", "chief_arrival_change.dismissed"];
const WINDOW_HOURS = 72;

const decisionSchema = z.object({
    requestId: z.string().uuid(),
    decision: z.enum(["apply", "dismiss"]),
});

async function listOpenRequests() {
    const db = getDb();
    const since = new Date(Date.now() - WINDOW_HOURS * 60 * 60 * 1000);

    const requests = await db.query.auditLogs.findMany({
        where: and(eq(auditLogs.action, REQUEST_ACTION), gte(auditLogs.createdAt, since)),
        orderBy: [desc(auditLogs.createdAt)],
        limit: 50,
    });
    if (requests.length === 0) {
        return [];
    }

    const resolutions = await db.query.auditLogs.findMany({
        where: and(inArray(auditLogs.action, RESOLVED_ACTIONS), gte(auditLogs.createdAt, since)),
        limit: 200,
    });
    const resolved = new Set(
        resolutions
            .map((row) => (row.details as { requestId?: string } | null)?.requestId)
            .filter((value): value is string => Boolean(value)),
    );

    return requests
        .filter((row) => !resolved.has(row.id))
        .map((row) => {
            const details = (row.details ?? {}) as Record<string, unknown>;
            return {
                requestId: row.id,
                occupancyId: row.entityId,
                requestedAt: row.createdAt.toISOString(),
                postCode: (details.postCode as string | null) ?? null,
                doctorName: (details.doctorName as string | null) ?? null,
                currentStartedAt: (details.currentStartedAt as string | null) ?? null,
                requestedStartedAt: (details.requestedStartedAt as string | null) ?? null,
                note: (details.note as string | null) ?? null,
                channel: (details.channel as string | null) ?? null,
                actorEmail: (details.actorEmail as string | null) ?? null,
            };
        });
}

export async function GET() {
    if (!hasDatabaseUrl()) {
        return NextResponse.json({ error: "DATABASE_URL is not configured for operations-v2." }, { status: 503 });
    }
    try {
        await requireAuthenticatedSession(["admin"]);
    } catch (error) {
        const status = error instanceof AuthError ? error.status : 500;
        return NextResponse.json({ error: error instanceof Error ? error.message : "Unauthorized." }, { status });
    }

    return NextResponse.json({ requests: await listOpenRequests() });
}

export async function POST(request: Request) {
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

    const parsed = decisionSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
        return NextResponse.json({ error: "Payload de decisao invalido." }, { status: 400 });
    }

    const db = getDb();
    const pending = await db.query.auditLogs.findFirst({
        where: and(eq(auditLogs.id, parsed.data.requestId), eq(auditLogs.action, REQUEST_ACTION)),
    });
    if (!pending) {
        return NextResponse.json({ error: "Pedido nao encontrado." }, { status: 404 });
    }

    const details = (pending.details ?? {}) as Record<string, unknown>;
    const requestedStartedAt = details.requestedStartedAt as string | null | undefined;

    if (parsed.data.decision === "apply") {
        if (!requestedStartedAt || !pending.entityId) {
            return NextResponse.json({ error: "Pedido sem horario para aplicar." }, { status: 400 });
        }
        const startedAt = new Date(requestedStartedAt);
        try {
            await correctRegulationOccupancy(pending.entityId, {
                startedAt,
                boardStartedAt: startedAt,
                notes: `[pedido da chefia aplicado pelo admin] ${(details.note as string | null) ?? ""}`.trim(),
            }, session.user.id);
        } catch (error) {
            return NextResponse.json(
                { error: error instanceof Error ? error.message : "Falha ao aplicar o pedido." },
                { status: 400 },
            );
        }
    }

    await db.insert(auditLogs).values({
        actorUserId: session.user.id,
        action: parsed.data.decision === "apply"
            ? "chief_arrival_change.applied"
            : "chief_arrival_change.dismissed",
        entityType: "regulation_occupancy",
        entityId: pending.entityId,
        details: {
            requestId: pending.id,
            requestedStartedAt: requestedStartedAt ?? null,
            postCode: (details.postCode as string | null) ?? null,
        },
    });

    return NextResponse.json({ ok: true, requests: await listOpenRequests() });
}

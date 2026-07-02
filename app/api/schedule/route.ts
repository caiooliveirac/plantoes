import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { hasDatabaseUrl } from "@/db";
import { AuthError, requireAuthenticatedSession } from "@/lib/auth/server";
import { createScheduledShift, getScheduleBoard } from "@/services/schedule.service";

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

// Regulação não tem ramal/alvo (escala por função); intervenção exige a base.
const createSchema = z.object({
    domain: z.enum(["regulation", "intervention"]),
    targetId: z.number().int().positive().nullable().optional(),
    doctorId: z.string().uuid(),
    operationalDate: z.string().regex(DATE_PATTERN),
    shiftLabel: z.enum(["SD", "SN"]),
    roleLabel: z.string().trim().max(100).nullable().optional(),
}).refine((value) => value.domain === "regulation" || value.targetId != null, {
    message: "Intervenção exige a base (ambulância).",
});

export async function GET(request: NextRequest) {
    if (!hasDatabaseUrl()) {
        return NextResponse.json({ error: "database_unavailable" }, { status: 503 });
    }

    try {
        // Médico logado também lê a escala (a edição continua só em POST).
        await requireAuthenticatedSession(["admin", "chief", "doctor"]);
        const date = request.nextUrl.searchParams.get("date");
        if (!date || !DATE_PATTERN.test(date)) {
            return NextResponse.json({ error: "invalid_date" }, { status: 400 });
        }

        const board = await getScheduleBoard(date);
        return NextResponse.json(board);
    } catch (error) {
        if (error instanceof AuthError) {
            return NextResponse.json({ error: error.message }, { status: error.status });
        }
        throw error;
    }
}

export async function POST(request: NextRequest) {
    if (!hasDatabaseUrl()) {
        return NextResponse.json({ error: "database_unavailable" }, { status: 503 });
    }

    try {
        const session = await requireAuthenticatedSession(["admin", "chief"]);
        const parsed = createSchema.safeParse(await request.json());
        if (!parsed.success) {
            return NextResponse.json({ error: "invalid_payload", issues: parsed.error.issues }, { status: 400 });
        }

        const created = await createScheduledShift({
            ...parsed.data,
            targetId: parsed.data.targetId ?? null,
            roleLabel: parsed.data.roleLabel ?? null,
            createdByUserId: session.user.id,
        });
        return NextResponse.json({ shift: created }, { status: 201 });
    } catch (error) {
        if (error instanceof AuthError) {
            return NextResponse.json({ error: error.message }, { status: error.status });
        }
        if (error instanceof Error) {
            return NextResponse.json({ error: error.message }, { status: 409 });
        }
        throw error;
    }
}

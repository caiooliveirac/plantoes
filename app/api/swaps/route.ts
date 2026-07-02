import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { hasDatabaseUrl } from "@/db";
import { AuthError, requireAuthenticatedSession } from "@/lib/auth/server";
import { createSwap, listSwapsForActor } from "@/services/shift-swaps.service";

const createSchema = z.object({
    shiftId: z.string().uuid(),
    swapType: z.enum(["transfer", "mutual", "function_change", "base_change"]),
    toDoctorId: z.string().uuid(),
    counterpartShiftId: z.string().uuid().nullable().optional(),
    toPostId: z.number().int().positive().nullable().optional(),
    toBaseId: z.number().int().positive().nullable().optional(),
    toRoleLabel: z.string().trim().max(100).nullable().optional(),
    notes: z.string().trim().max(2000).nullable().optional(),
});

function isChief(roles: string[]) {
    return roles.includes("admin") || roles.includes("chief");
}

export async function GET() {
    if (!hasDatabaseUrl()) {
        return NextResponse.json({ error: "database_unavailable" }, { status: 503 });
    }

    try {
        const session = await requireAuthenticatedSession(["admin", "chief", "doctor"]);
        const swaps = await listSwapsForActor({
            doctorId: session.user.doctorId,
            isChief: isChief(session.user.roles),
        });
        return NextResponse.json({ swaps });
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
        const session = await requireAuthenticatedSession(["admin", "chief", "doctor"]);
        if (!session.user.doctorId) {
            return NextResponse.json({ error: "Conta sem médico vinculado não pode propor trocas." }, { status: 403 });
        }

        const parsed = createSchema.safeParse(await request.json());
        if (!parsed.success) {
            return NextResponse.json({ error: "invalid_payload", issues: parsed.error.issues }, { status: 400 });
        }

        const created = await createSwap({
            ...parsed.data,
            counterpartShiftId: parsed.data.counterpartShiftId ?? null,
            toPostId: parsed.data.toPostId ?? null,
            toBaseId: parsed.data.toBaseId ?? null,
            toRoleLabel: parsed.data.toRoleLabel ?? null,
            notes: parsed.data.notes ?? null,
            actorDoctorId: session.user.doctorId,
            actorUserId: session.user.id,
        });
        return NextResponse.json({ swap: created }, { status: 201 });
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

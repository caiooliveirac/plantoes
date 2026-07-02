import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { hasDatabaseUrl } from "@/db";
import { AuthError, requireAuthenticatedSession } from "@/lib/auth/server";
import { replaceDoctorPreferences, updateDoctorProfile } from "@/services/doctor-admin.service";

const patchSchema = z.object({
    displayName: z.string().trim().max(255).nullable().optional(),
    admittedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
    eligibleRegulation: z.boolean().optional(),
    eligibleIntervention: z.boolean().optional(),
    isActive: z.boolean().optional(),
});

const preferencesSchema = z.object({
    preferredWeekdays: z.array(z.number().int().min(0).max(6)).max(7),
    basePreferences: z.array(z.number().int().positive()).max(50),
    fixedShifts: z.array(z.object({
        weekday: z.number().int().min(0).max(6),
        shiftLabel: z.enum(["SD", "SN"]),
    })).max(14),
});

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    if (!hasDatabaseUrl()) {
        return NextResponse.json({ error: "database_unavailable" }, { status: 503 });
    }

    try {
        await requireAuthenticatedSession(["admin", "chief"]);
        const { id } = await params;
        const parsed = patchSchema.safeParse(await request.json());
        if (!parsed.success) {
            return NextResponse.json({ error: "invalid_payload", issues: parsed.error.issues }, { status: 400 });
        }

        const updated = await updateDoctorProfile(id, parsed.data);
        return NextResponse.json({ doctor: updated });
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

export async function PUT(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    if (!hasDatabaseUrl()) {
        return NextResponse.json({ error: "database_unavailable" }, { status: 503 });
    }

    try {
        await requireAuthenticatedSession(["admin", "chief"]);
        const { id } = await params;
        const parsed = preferencesSchema.safeParse(await request.json());
        if (!parsed.success) {
            return NextResponse.json({ error: "invalid_payload", issues: parsed.error.issues }, { status: 400 });
        }

        await replaceDoctorPreferences(id, parsed.data);
        return NextResponse.json({ ok: true });
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

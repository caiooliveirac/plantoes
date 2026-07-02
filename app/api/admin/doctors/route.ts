import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { hasDatabaseUrl } from "@/db";
import { AuthError, requireAuthenticatedSession } from "@/lib/auth/server";
import { createDoctor, listDoctorsForAdmin } from "@/services/doctor-admin.service";

const createSchema = z.object({
    fullName: z.string().trim().min(5).max(255),
    displayName: z.string().trim().max(255).nullable().optional(),
    admittedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
    eligibleRegulation: z.boolean(),
    eligibleIntervention: z.boolean(),
});

export async function GET() {
    if (!hasDatabaseUrl()) {
        return NextResponse.json({ error: "database_unavailable" }, { status: 503 });
    }

    try {
        await requireAuthenticatedSession(["admin", "chief"]);
        const doctors = await listDoctorsForAdmin();
        return NextResponse.json({ doctors });
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
        await requireAuthenticatedSession(["admin", "chief"]);
        const parsed = createSchema.safeParse(await request.json());
        if (!parsed.success) {
            return NextResponse.json({ error: "invalid_payload", issues: parsed.error.issues }, { status: 400 });
        }

        const created = await createDoctor({
            ...parsed.data,
            displayName: parsed.data.displayName ?? null,
            admittedAt: parsed.data.admittedAt ?? null,
        });
        return NextResponse.json({ doctor: created }, { status: 201 });
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

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { hasDatabaseUrl } from "@/db";
import { AuthError, requireAuthenticatedSession } from "@/lib/auth/server";
import { undoAction } from "@/modules/operational/undo";

const schema = z.object({
    auditLogId: z.string().uuid(),
    notes: z.string().trim().min(8).max(2000),
});

export async function POST(request: NextRequest) {
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

    const parsed = schema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
        return NextResponse.json({ error: "Motivo obrigatório para desfazer (mínimo 8 caracteres)." }, { status: 400 });
    }

    try {
        const result = await undoAction(
            parsed.data.auditLogId,
            session.user.id,
            parsed.data.notes,
        );

        if (!result.success) {
            return NextResponse.json({ error: result.message }, { status: 409 });
        }

        return NextResponse.json({
            message: result.message,
            undoneAuditLogId: result.undoneAuditLogId,
        });
    } catch (error) {
        return NextResponse.json(
            { error: error instanceof Error ? error.message : "Não foi possível desfazer a ação." },
            { status: 400 },
        );
    }
}

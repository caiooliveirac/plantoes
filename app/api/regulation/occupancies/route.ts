import { NextRequest, NextResponse } from "next/server";
import { and, desc, eq, isNull, ne } from "drizzle-orm";
import { z } from "zod";
import { hasDatabaseUrl, getDb } from "@/db";
import { auditLogs, doctors, regulationOccupancies, regulationPosts } from "@/db/schema";
import { conferirChegada } from "@/modules/operational/arrival-check";
import { AuthError, requireAuthenticatedSession } from "@/lib/auth/server";
import {
    describeConflicts,
    describeMergeable,
    findMergeableOccupancy,
    findSameDayOccupancies,
} from "@/services/duplicate-occupancy-guard";
import { startRegulationOccupancy } from "@/modules/regulation/service";

const schema = z.object({
    doctorId: z.string().uuid(),
    postId: z.number().int().positive(),
    continuityGroupId: z.string().uuid().optional().nullable(),
    previousOccupancyId: z.string().uuid().optional().nullable(),
    isContinuityEntry: z.boolean().optional(),
    startedAt: z.string().datetime(),
    boardStartedAt: z.string().datetime().optional().nullable(),
    scheduledStartAt: z.string().datetime().optional().nullable(),
    scheduledEndAt: z.string().datetime().optional().nullable(),
    shiftLabel: z.string().trim().max(100).optional().nullable(),
    roleLabel: z.string().trim().max(100).optional().nullable(),
    ramalLabel: z.string().trim().max(50).optional().nullable(),
    source: z.enum(["manual", "telegram", "import", "admin_correction"]),
    notes: z.string().trim().max(2000).optional().nullable(),
    /** Marcado pelo admin depois de ver o aviso de plantão duplicado. */
    confirmDuplicate: z.boolean().optional(),
    /**
     * Marcado depois de ver o plantão que já existe nesta janela e informar o
     * horário verdadeiro de chegada: a chegada JUNTA com ele em vez de criar
     * uma segunda linha.
     */
    confirmMerge: z.boolean().optional(),
});

export async function GET() {
    if (!hasDatabaseUrl()) {
        return NextResponse.json({ error: "DATABASE_URL is not configured for operations-v2." }, { status: 503 });
    }

    try {
        await requireAuthenticatedSession(["admin", "chief"]);
    } catch (error) {
        const status = error instanceof AuthError ? error.status : 500;
        return NextResponse.json({ error: error instanceof Error ? error.message : "Unauthorized." }, { status });
    }

    const db = getDb();
    const rows = await db
        .select({
            id: regulationOccupancies.id,
            doctorId: regulationOccupancies.doctorId,
            doctorName: doctors.fullName,
            postId: regulationOccupancies.postId,
            postCode: regulationPosts.code,
            postLabel: regulationPosts.label,
            startedAt: regulationOccupancies.startedAt,
            boardStartedAt: regulationOccupancies.boardStartedAt,
            endedAt: regulationOccupancies.endedAt,
            actualEndedAt: regulationOccupancies.actualEndedAt,
            shiftLabel: regulationOccupancies.shiftLabel,
            roleLabel: regulationOccupancies.roleLabel,
            ramalLabel: regulationOccupancies.ramalLabel,
            source: regulationOccupancies.source,
        })
        .from(regulationOccupancies)
        .innerJoin(doctors, eq(doctors.id, regulationOccupancies.doctorId))
        .innerJoin(regulationPosts, eq(regulationPosts.id, regulationOccupancies.postId))
        .orderBy(desc(regulationOccupancies.startedAt));

    return NextResponse.json({ occupancies: rows });
}

async function nomeDoMedicoReg(doctorId: string): Promise<string> {
    const [linha] = await getDb().select({ nome: doctors.fullName }).from(doctors).where(eq(doctors.id, doctorId)).limit(1);
    return linha?.nome ?? "";
}

/** O ramal (CRU-3, COI-1…) vira a família que a escala conhece: CRU, COI ou CH. */
async function familiaDoPosto(postId: number): Promise<string> {
    const [linha] = await getDb()
        .select({ cod: regulationPosts.code })
        .from(regulationPosts)
        .where(eq(regulationPosts.id, postId))
        .limit(1);
    const cod = (linha?.cod ?? "").toUpperCase();
    if (cod.startsWith("COI")) return "COI";
    if (cod.startsWith("CH") || cod.startsWith("CP")) return "CH";
    return "CRU";
}

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
        return NextResponse.json({ error: "Invalid regulation occupancy payload." }, { status: 400 });
    }

    // Plantão duplicado no mesmo dia e turno infla o valor da nota e costuma
    // passar despercebido até o fechamento. Avisa e exige confirmação.
    if (!parsed.data.confirmDuplicate) {
        const conflitos = await findSameDayOccupancies({
            doctorId: parsed.data.doctorId,
            startedAt: new Date(parsed.data.startedAt),
            shiftLabel: parsed.data.shiftLabel ?? null,
            continuityGroupId: parsed.data.continuityGroupId ?? null,
        });
        if (conflitos.length > 0) {
            return NextResponse.json({
                error: describeConflicts(conflitos),
                needsDuplicateConfirmation: true,
                conflicts: conflitos,
            }, { status: 409 });
        }
    }

    // Mesmo médico, mesmo ramal, janela ainda aberta para esta chegada: não é
    // plantão novo. Mostra o que existe e pede o horário verdadeiro antes de juntar.
    if (!parsed.data.confirmMerge) {
        const mergeable = await findMergeableOccupancy({
            domain: "regulation",
            targetId: parsed.data.postId,
            doctorId: parsed.data.doctorId,
            startedAt: new Date(parsed.data.startedAt),
        });
        if (mergeable) {
            return NextResponse.json({
                error: describeMergeable(mergeable),
                needsMergeConfirmation: true,
                mergeable,
            }, { status: 409 });
        }
    }

    try {
        const created = await startRegulationOccupancy({
            doctorId: parsed.data.doctorId,
            postId: parsed.data.postId,
            continuityGroupId: parsed.data.continuityGroupId ?? null,
            previousOccupancyId: parsed.data.previousOccupancyId ?? null,
            isContinuityEntry: parsed.data.isContinuityEntry ?? false,
            startedAt: new Date(parsed.data.startedAt),
            boardStartedAt: parsed.data.boardStartedAt ? new Date(parsed.data.boardStartedAt) : null,
            scheduledStartAt: parsed.data.scheduledStartAt ? new Date(parsed.data.scheduledStartAt) : null,
            scheduledEndAt: parsed.data.scheduledEndAt ? new Date(parsed.data.scheduledEndAt) : null,
            shiftLabel: parsed.data.shiftLabel ?? null,
            roleLabel: parsed.data.roleLabel ?? null,
            ramalLabel: parsed.data.ramalLabel ?? null,
            source: parsed.data.source,
            notes: parsed.data.notes ?? null,
            createdByUserId: session.user.id,
        });

        // Detect if the start displaced someone (for undo support)
        const displacedOccupancy = await getDb().query.regulationOccupancies.findFirst({
            where: and(
                eq(regulationOccupancies.postId, created.postId),
                eq(regulationOccupancies.endedAt, created.startedAt),
                ne(regulationOccupancies.id, created.id),
            ),
            orderBy: [desc(regulationOccupancies.startedAt)],
        });

        await getDb().insert(auditLogs).values({
            actorUserId: session.user.id,
            action: "regulation_occupancy.started",
            entityType: "regulation_occupancy",
            entityId: created.id,
            details: {
                doctorId: created.doctorId,
                postId: created.postId,
                startedAt: created.startedAt,
                shiftLabel: created.shiftLabel,
                displacedOccupancyId: displacedOccupancy?.id ?? null,
                displacedDoctorId: displacedOccupancy?.doctorId ?? null,
            },
        });

        /* Chegada × escala (nível A) — ver o gêmeo em intervention/occupancies.
           Na regulação o "posto" da escala é o conjunto (CRU), o COI e a chefia:
           o código do ramal vira essa família em nomesEsperados(). */
        void conferirChegada({
            ocupacaoId: created.id,
            doctorId: created.doctorId,
            doctorName: await nomeDoMedicoReg(created.doctorId),
            posto: await familiaDoPosto(created.postId),
            turno: created.shiftLabel ?? "—",
            quando: created.startedAt,
            actorUserId: session.user.id,
        }).catch((erro) => console.error("[chegada] conferência escapou", erro));

        return NextResponse.json({ occupancy: created });
    } catch (error) {
        return NextResponse.json(
            { error: error instanceof Error ? error.message : "Unable to start regulation occupancy." },
            { status: 400 },
        );
    }
}
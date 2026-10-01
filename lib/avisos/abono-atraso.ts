/**
 * Aviso ao secretário (app `tom` → WhatsApp da coordenação) quando a chefia
 * desconsidera o atraso de alguém — ou volta a contar. Pedido do Caio em
 * 01/10/2026: o abono mexe no banco e no pagamento sem passar pelo admin, e a
 * coordenação precisa saber no minuto (mesma razão de lib/avisos/secretario.ts).
 * Texto puro em `buildArrivalDelayWaiverNotice`; a parte com banco busca nome
 * e posto. Nunca levanta: o audit_logs é a verdade, isto é cortesia.
 */
import { eq } from "drizzle-orm";
import { doctors, interventionBases, interventionOccupancies, regulationOccupancies, regulationPosts } from "@/db/schema";
import { getDb } from "@/db";
import { avisarSecretario } from "@/lib/avisos/secretario";
import { ARRIVAL_GRACE_MINUTES } from "@/modules/operational/early-departure";

function hora(value: Date | null | undefined) {
    if (!value) return "--:--";
    return new Intl.DateTimeFormat("pt-BR", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "America/Sao_Paulo" }).format(value);
}

export function buildArrivalDelayWaiverNotice(params: {
    waived: boolean;
    doctorName: string | null;
    targetCode: string;
    actorLabel: string | null;
    startedAt: Date;
    scheduledStartAt: Date | null;
    note: string | null;
}) {
    const medico = params.doctorName?.trim() || "ocupante";
    const quem = params.actorLabel?.trim() || "chefia de plantão";
    const atrasoMin = params.scheduledStartAt
        ? Math.max(0, Math.trunc((params.startedAt.getTime() - params.scheduledStartAt.getTime()) / 60000))
        : null;
    const atraso = atrasoMin === null
        ? `chegada ${hora(params.startedAt)}`
        : atrasoMin <= ARRIVAL_GRACE_MINUTES
            ? `chegada ${hora(params.startedAt)}, dentro da tolerância`
            : `atraso de ${atrasoMin} min (previsto ${hora(params.scheduledStartAt)}, chegou ${hora(params.startedAt)})`;
    if (!params.waived) {
        return `⏱️ ${quem} voltou a contar o atraso de ${medico} (${params.targetCode}): ${atraso}. Banco e pagamento voltam ao cálculo normal.`;
    }
    const motivo = params.note?.trim() ? ` Motivo: ${params.note.trim()}.` : "";
    return `⏱️ ${quem} desconsiderou o atraso de ${medico} (${params.targetCode}): ${atraso}.${motivo} Banco e pagamento passam a tratar como pontual; a hora de chegada não mudou.`;
}

export async function avisarAbonoDeAtraso(params: {
    domain: "regulation" | "intervention";
    occupancyId: string;
    waived: boolean;
    note: string | null;
    actorLabel: string | null;
}) {
    try {
        const db = getDb();
        const linha = params.domain === "regulation"
            ? await db
                .select({ doctorName: doctors.displayName, fullName: doctors.fullName, code: regulationPosts.code, startedAt: regulationOccupancies.startedAt, scheduledStartAt: regulationOccupancies.scheduledStartAt })
                .from(regulationOccupancies)
                .innerJoin(regulationPosts, eq(regulationPosts.id, regulationOccupancies.postId))
                .innerJoin(doctors, eq(doctors.id, regulationOccupancies.doctorId))
                .where(eq(regulationOccupancies.id, params.occupancyId))
                .limit(1)
            : await db
                .select({ doctorName: doctors.displayName, fullName: doctors.fullName, code: interventionBases.code, startedAt: interventionOccupancies.startedAt, scheduledStartAt: interventionOccupancies.scheduledStartAt })
                .from(interventionOccupancies)
                .innerJoin(interventionBases, eq(interventionBases.id, interventionOccupancies.baseId))
                .innerJoin(doctors, eq(doctors.id, interventionOccupancies.doctorId))
                .where(eq(interventionOccupancies.id, params.occupancyId))
                .limit(1);
        const r = linha[0];
        if (!r) return;
        await avisarSecretario(buildArrivalDelayWaiverNotice({
            waived: params.waived,
            doctorName: r.doctorName?.trim() || r.fullName,
            targetCode: r.code,
            actorLabel: params.actorLabel,
            startedAt: r.startedAt,
            scheduledStartAt: r.scheduledStartAt ?? null,
            note: params.note,
        }));
    } catch {
        // cortesia: nunca derruba o abono já gravado
    }
}

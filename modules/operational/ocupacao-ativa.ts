/**
 * Ocupação ATIVA de um médico (regulação ou intervenção), do ponto de vista de
 * quem declara chegada/saída agora — bot do Telegram e área do médico na web.
 *
 * Extraído de modules/telegram/service.ts (01/10/2026) sem mudar a semântica,
 * para a chegada/saída pela web usar exatamente a mesma leitura do bot.
 */
import { and, desc, eq, gte, isNull } from "drizzle-orm";
import { getDb } from "@/db";
import { interventionBases, interventionOccupancies, regulationOccupancies, regulationPosts } from "@/db/schema";

// Até onde a mensagem de HOJE pode enxergar um plantão aberto do médico. Uma
// ocupação aberta antiga NÃO é "o plantão atual dele": é lixo que escapou do
// reaper (P sem saída, janela não expirada ainda). Sem esta trava, uma chegada
// digitada dias depois virava remanejamento retroativo — movia a ocupação
// ANTIGA para o ramal novo, preservando o started_at original e reescrevendo o
// passado (incidente 08/07/2026: "CAROLINA TANAJURA 2031 P" levou o plantão
// dela de 01/07 do 1366 para o 2031 e derrubou a Bruna do SD da chefia).
// O critério é a JANELA da ocupação, não a idade dela: vale enquanto o plantão
// ainda cobre o agora (com 3h de folga para a mensagem que chega atrasada).
// Continuidade declarada estende o scheduledEndAt e por isso continua alcançável
// mesmo com started_at de dois dias atrás; plantão que passou da janela e ficou
// aberto por silêncio, não.
const ACTIVE_OCCUPANCY_GRACE_MS = 3 * 60 * 60 * 1000;

export function resolveActiveOccupancyCoverageFloor(referenceAt: Date): Date {
    return new Date(referenceAt.getTime() - ACTIVE_OCCUPANCY_GRACE_MS);
}

export interface OcupacaoAtivaDoMedico {
    sector: "REGULATION" | "INTERVENTION";
    /** Código do ramal/base (nome histórico: o bot chama tudo de baseCode). */
    baseCode: string;
    /** id do ramal (regulation_posts) ou da base (intervention_bases). */
    targetId: number;
    occupancyId: string;
    startedAt: Date;
    shiftLabel: string | null;
    continuityGroupId: string | null;
    boardStartedAt: Date | null;
    scheduledEndAt: Date | null;
}

export async function findActiveOccupancyByDoctorId(doctorId: string, referenceAt = new Date(), options: {
    /** Chegada: cobertura de madrugada não é plantão de origem (docs/madrugada.md). */
    ignoreMadrugada?: boolean;
} = {}): Promise<OcupacaoAtivaDoMedico | null> {
    const db = getDb();
    const coverageFloor = resolveActiveOccupancyCoverageFloor(referenceAt);

    const regOcc = await db
        .select({
            id: regulationOccupancies.id,
            postId: regulationOccupancies.postId,
            startedAt: regulationOccupancies.startedAt,
            shiftLabel: regulationOccupancies.shiftLabel,
            continuityGroupId: regulationOccupancies.continuityGroupId,
            boardStartedAt: regulationOccupancies.boardStartedAt,
            scheduledEndAt: regulationOccupancies.scheduledEndAt,
        })
        .from(regulationOccupancies)
        .where(and(
            eq(regulationOccupancies.doctorId, doctorId),
            isNull(regulationOccupancies.endedAt),
            gte(regulationOccupancies.scheduledEndAt, coverageFloor),
            options.ignoreMadrugada ? eq(regulationOccupancies.madrugadaCobertura, false) : undefined,
        ))
        .orderBy(desc(regulationOccupancies.startedAt))
        .limit(1);

    if (regOcc.length > 0) {
        const post = await db.query.regulationPosts.findFirst({ where: eq(regulationPosts.id, regOcc[0].postId) });
        if (post) {
            return {
                sector: "REGULATION",
                baseCode: post.code,
                targetId: post.id,
                occupancyId: regOcc[0].id,
                startedAt: regOcc[0].startedAt,
                shiftLabel: regOcc[0].shiftLabel,
                continuityGroupId: regOcc[0].continuityGroupId,
                boardStartedAt: regOcc[0].boardStartedAt,
                scheduledEndAt: regOcc[0].scheduledEndAt,
            };
        }
    }

    const intOcc = await db
        .select({
            id: interventionOccupancies.id,
            baseId: interventionOccupancies.baseId,
            startedAt: interventionOccupancies.startedAt,
            shiftLabel: interventionOccupancies.shiftLabel,
            continuityGroupId: interventionOccupancies.continuityGroupId,
            boardStartedAt: interventionOccupancies.boardStartedAt,
            scheduledEndAt: interventionOccupancies.scheduledEndAt,
        })
        .from(interventionOccupancies)
        .where(and(
            eq(interventionOccupancies.doctorId, doctorId),
            isNull(interventionOccupancies.endedAt),
            gte(interventionOccupancies.scheduledEndAt, coverageFloor),
        ))
        .orderBy(desc(interventionOccupancies.startedAt))
        .limit(1);

    if (intOcc.length > 0) {
        const base = await db.query.interventionBases.findFirst({ where: eq(interventionBases.id, intOcc[0].baseId) });
        if (base) {
            return {
                sector: "INTERVENTION",
                baseCode: base.code,
                targetId: base.id,
                occupancyId: intOcc[0].id,
                startedAt: intOcc[0].startedAt,
                shiftLabel: intOcc[0].shiftLabel,
                continuityGroupId: intOcc[0].continuityGroupId,
                boardStartedAt: intOcc[0].boardStartedAt,
                scheduledEndAt: intOcc[0].scheduledEndAt,
            };
        }
    }

    return null;
}

export interface UltimoPlantaoDoMedico {
    targetCode: string;
    shiftLabel: string | null;
    startedAt: Date;
    /** Saída real quando houve; senão o fim de quadro (rendição). Nulo = aberto. */
    endedAt: Date | null;
}

/**
 * Último plantão registrado do médico, aberto ou fechado, em qualquer setor.
 * Serve para o bot DIZER o que tem no registro quando uma saída não acha o que
 * fechar ("pode ser esse que você acha que precisa avisar, e já está fechado").
 */
export async function findLastOccupancyByDoctorId(doctorId: string): Promise<UltimoPlantaoDoMedico | null> {
    const db = getDb();
    const [reg, int] = await Promise.all([
        db.select({
            targetCode: regulationPosts.code,
            shiftLabel: regulationOccupancies.shiftLabel,
            startedAt: regulationOccupancies.startedAt,
            endedAt: regulationOccupancies.endedAt,
            actualEndedAt: regulationOccupancies.actualEndedAt,
        })
            .from(regulationOccupancies)
            .innerJoin(regulationPosts, eq(regulationPosts.id, regulationOccupancies.postId))
            .where(eq(regulationOccupancies.doctorId, doctorId))
            .orderBy(desc(regulationOccupancies.startedAt))
            .limit(1),
        db.select({
            targetCode: interventionBases.code,
            shiftLabel: interventionOccupancies.shiftLabel,
            startedAt: interventionOccupancies.startedAt,
            endedAt: interventionOccupancies.endedAt,
            actualEndedAt: interventionOccupancies.actualEndedAt,
        })
            .from(interventionOccupancies)
            .innerJoin(interventionBases, eq(interventionBases.id, interventionOccupancies.baseId))
            .where(eq(interventionOccupancies.doctorId, doctorId))
            .orderBy(desc(interventionOccupancies.startedAt))
            .limit(1),
    ]);
    const last = [...reg, ...int].sort((left, right) => right.startedAt.getTime() - left.startedAt.getTime())[0];
    if (!last) {
        return null;
    }
    return {
        targetCode: last.targetCode,
        shiftLabel: last.shiftLabel,
        startedAt: last.startedAt,
        endedAt: last.actualEndedAt ?? last.endedAt,
    };
}

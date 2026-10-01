import { and, eq, gte, lt } from "drizzle-orm";
import { getDb } from "@/db";
import {
    bankHoursEntries,
    doctors,
    interventionBases,
    interventionOccupancies,
    regulationOccupancies,
    regulationPosts,
} from "@/db/schema";
import { startInterventionOccupancy } from "@/modules/intervention/service";
import {
    correctOccupancyShiftAndDeparture,
    removeInterventionOccupancyRecord,
    removeRegulationOccupancyRecord,
} from "@/modules/operational/corrections";
import {
    previewManualShiftBankHours,
    resolveManualShiftInstants,
    type ManualShiftLabel,
} from "@/modules/operational/manual-shift";
import { applyShadowMarkerToOccupancyNotes } from "@/modules/operational/shadow";
import { startRegulationOccupancy } from "@/modules/regulation/service";
import { getDoctorBankHoursEffectiveBalances } from "@/services/bank-hours-history.service";

export interface ManualShiftInput {
    doctorId: string;
    domain: "regulation" | "intervention";
    targetId: number;
    operationalDate: string;
    shiftLabel: ManualShiftLabel;
    arrivalTime: string;
    departureTime: string;
    isShadow: boolean;
    reason: string;
}

export async function listManualShiftTargets() {
    const db = getDb();
    const [posts, bases] = await Promise.all([
        db.select({ id: regulationPosts.id, code: regulationPosts.code, label: regulationPosts.label })
            .from(regulationPosts).where(eq(regulationPosts.isActive, true)).orderBy(regulationPosts.sortOrder),
        db.select({ id: interventionBases.id, code: interventionBases.code, label: interventionBases.label })
            .from(interventionBases).where(eq(interventionBases.isActive, true)).orderBy(interventionBases.sortOrder),
    ]);
    return [
        ...posts.map((post) => ({ domain: "regulation" as const, ...post })),
        ...bases.map((base) => ({ domain: "intervention" as const, ...base })),
    ];
}

async function resolveTarget(input: ManualShiftInput) {
    const db = getDb();
    if (input.domain === "regulation") {
        const post = await db.query.regulationPosts.findFirst({ where: eq(regulationPosts.id, input.targetId) });
        if (!post || !post.isActive) throw new Error("Ramal nao encontrado ou inativo.");
        return { code: post.code, label: post.label };
    }
    const base = await db.query.interventionBases.findFirst({ where: eq(interventionBases.id, input.targetId) });
    if (!base || !base.isActive) throw new Error("Base nao encontrada ou inativa.");
    return { code: base.code, label: base.label };
}

/** Plantões do médico que encostam na janela informada (aviso, não bloqueio). */
async function findOverlaps(params: { doctorId: string; startedAt: Date; departureAt: Date }) {
    const db = getDb();
    const since = new Date(params.startedAt.getTime() - 36 * 60 * 60 * 1000);
    const [reg, intv] = await Promise.all([
        db.select({
            id: regulationOccupancies.id, code: regulationPosts.code, startedAt: regulationOccupancies.startedAt,
            end: regulationOccupancies.actualEndedAt, ended: regulationOccupancies.endedAt, scheduledEnd: regulationOccupancies.scheduledEndAt,
        }).from(regulationOccupancies)
            .innerJoin(regulationPosts, eq(regulationPosts.id, regulationOccupancies.postId))
            .where(and(eq(regulationOccupancies.doctorId, params.doctorId), gte(regulationOccupancies.startedAt, since), lt(regulationOccupancies.startedAt, params.departureAt))),
        db.select({
            id: interventionOccupancies.id, code: interventionBases.code, startedAt: interventionOccupancies.startedAt,
            end: interventionOccupancies.actualEndedAt, ended: interventionOccupancies.endedAt, scheduledEnd: interventionOccupancies.scheduledEndAt,
        }).from(interventionOccupancies)
            .innerJoin(interventionBases, eq(interventionBases.id, interventionOccupancies.baseId))
            .where(and(eq(interventionOccupancies.doctorId, params.doctorId), gte(interventionOccupancies.startedAt, since), lt(interventionOccupancies.startedAt, params.departureAt))),
    ]);
    return [...reg, ...intv]
        .map((row) => ({ ...row, endsAt: row.end ?? row.ended ?? row.scheduledEnd }))
        .filter((row) => !row.endsAt || row.endsAt.getTime() > params.startedAt.getTime())
        .map((row) => ({ id: row.id, code: row.code, startedAt: row.startedAt.toISOString(), endsAt: row.endsAt?.toISOString() ?? null }));
}

export async function previewManualShift(input: ManualShiftInput) {
    const target = await resolveTarget(input);
    const { startedAt, departureAt } = resolveManualShiftInstants({
        date: input.operationalDate, arrivalTime: input.arrivalTime, departureTime: input.departureTime,
    });
    if (departureAt.getTime() > Date.now()) {
        throw new Error("A saida nao pode ficar no futuro: esta tela lanca plantao ja cumprido.");
    }
    const { scheduledStartAt, scheduledEndAt, calculation } = previewManualShiftBankHours({
        domain: input.domain, targetCode: target.code, shiftLabel: input.shiftLabel, startedAt, departureAt,
    });
    const [balances, overlaps] = await Promise.all([
        getDoctorBankHoursEffectiveBalances(),
        findOverlaps({ doctorId: input.doctorId, startedAt, departureAt }),
    ]);
    const balanceBefore = balances.get(input.doctorId)?.totalMinutes ?? 0;
    return {
        target,
        scheduledStartAt: scheduledStartAt.toISOString(),
        scheduledEndAt: scheduledEndAt.toISOString(),
        startedAt: startedAt.toISOString(),
        departureAt: departureAt.toISOString(),
        calculation: {
            arrivalDelayMinutes: calculation.arrivalDelayMinutes,
            overtimeMinutes: calculation.overtimeMinutes,
            overtimeMultiplier: calculation.overtimeMultiplier,
            balanceMinutes: calculation.balanceMinutes,
            ruleCode: calculation.ruleCode,
            explanation: calculation.explanation,
        },
        balanceBeforeMinutes: balanceBefore,
        balanceAfterMinutes: balanceBefore + calculation.balanceMinutes,
        overlaps,
    };
}

/**
 * Cria o plantão pelos mesmos serviços do painel (start + correção de saída com
 * confirmação da chefia), então banco de horas, continuidade e auditoria seguem
 * as regras de sempre. Se a saída falhar, o plantão recém-criado é removido —
 * nunca fica ocupação aberta de um lançamento que deu errado.
 */
export async function createManualShift(input: ManualShiftInput, actorUserId: string) {
    const reason = input.reason.trim();
    if (reason.length < 8) throw new Error("Motivo obrigatorio (minimo 8 caracteres).");

    const preview = await previewManualShift(input);
    const startedAt = new Date(preview.startedAt);
    const departureAt = new Date(preview.departureAt);

    const db = getDb();
    const duplicate = input.domain === "regulation"
        ? await db.query.regulationOccupancies.findFirst({
            where: and(eq(regulationOccupancies.doctorId, input.doctorId), eq(regulationOccupancies.postId, input.targetId), eq(regulationOccupancies.startedAt, startedAt)),
        })
        : await db.query.interventionOccupancies.findFirst({
            where: and(eq(interventionOccupancies.doctorId, input.doctorId), eq(interventionOccupancies.baseId, input.targetId), eq(interventionOccupancies.startedAt, startedAt)),
        });
    if (duplicate) throw new Error("Este plantao ja esta registrado (mesmo medico, local e chegada).");

    const notes = applyShadowMarkerToOccupancyNotes(`lancamento administrativo — ${reason}`, input.isShadow);
    const base = {
        doctorId: input.doctorId,
        startedAt,
        shiftLabel: input.shiftLabel,
        source: "admin_correction" as const,
        notes,
        isShadow: input.isShadow,
        createdByUserId: actorUserId,
    };
    const created = input.domain === "regulation"
        ? await startRegulationOccupancy({ ...base, postId: input.targetId })
        : await startInterventionOccupancy({ ...base, baseId: input.targetId });

    try {
        await correctOccupancyShiftAndDeparture({
            domain: input.domain,
            occupancyId: created.id,
            shiftLabel: input.shiftLabel,
            departureAt,
            reason,
            actorUserId,
        });
    } catch (error) {
        if (input.domain === "regulation") await removeRegulationOccupancyRecord(created.id, actorUserId);
        else await removeInterventionOccupancyRecord(created.id, actorUserId);
        throw error;
    }

    // Resultado REAL gravado (a continuidade pode somar com plantão vizinho).
    const [entry] = await db.select({
        balanceMinutes: bankHoursEntries.balanceMinutes,
        ruleCode: bankHoursEntries.ruleCode,
        explanation: bankHoursEntries.explanation,
    }).from(bankHoursEntries).where(
        input.domain === "regulation"
            ? eq(bankHoursEntries.regulationOccupancyId, created.id)
            : eq(bankHoursEntries.interventionOccupancyId, created.id),
    ).limit(1);

    const [doctor] = await db.select({ fullName: doctors.fullName }).from(doctors).where(eq(doctors.id, input.doctorId)).limit(1);
    return { occupancyId: created.id, doctorName: doctor?.fullName ?? null, preview, bankEntry: entry ?? null };
}

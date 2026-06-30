import { and, desc, eq, inArray, or, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { auditLogs, bankHoursBalanceOverrides, users } from "@/db/schema";
import {
    buildBankHoursHistoryModel,
    type BankHoursHistoryModel,
    type RawBankHoursHistoryShift,
} from "@/modules/reporting/bank-hours-history";
import type { MonthlyReportAuditEntry, MonthlyReportSource } from "@/modules/reporting/monthly-report";
import {
    loadAllBankHoursSettlements,
    loadBankHoursSettlementDeltaByDoctor,
} from "@/services/bank-hours-settlements.service";

function mapRow(row: Record<string, unknown>): RawBankHoursHistoryShift {
    return {
        occupancyId: String(row.occupancyId),
        domain: String(row.domain) === "regulation" ? "regulation" : "intervention",
        doctorId: String(row.doctorId),
        doctorName: String(row.doctorName),
        displayName: (row.displayName ?? null) as string | null,
        targetCode: String(row.targetCode),
        targetLabel: String(row.targetLabel),
        continuityGroupId: String(row.continuityGroupId),
        startedAt: String(row.startedAt),
        boardStartedAt: (row.boardStartedAt ?? null) as string | null,
        handoffEndedAt: (row.handoffEndedAt ?? null) as string | null,
        actualEndedAt: (row.actualEndedAt ?? null) as string | null,
        effectiveEndedAt: (row.effectiveEndedAt ?? null) as string | null,
        shiftLabel: (row.shiftLabel ?? null) as string | null,
        source: String(row.source) as MonthlyReportSource,
        notes: (row.notes ?? null) as string | null,
        createdAt: String(row.createdAt),
        updatedAt: String(row.updatedAt),
        createdByEmail: (row.createdByEmail ?? null) as string | null,
        updatedByEmail: (row.updatedByEmail ?? null) as string | null,
        hasPersistedBankEntry: Boolean(row.hasPersistedBankEntry),
        occupancyScheduledStartAt: (row.occupancyScheduledStartAt ?? null) as string | null,
        occupancyScheduledEndAt: (row.occupancyScheduledEndAt ?? null) as string | null,
        bankScheduledStartAt: (row.bankScheduledStartAt ?? null) as string | null,
        bankScheduledEndAt: (row.bankScheduledEndAt ?? null) as string | null,
        bankActualStartAt: (row.bankActualStartAt ?? null) as string | null,
        bankActualEndAt: (row.bankActualEndAt ?? null) as string | null,
        arrivalDelayMinutes: row.arrivalDelayMinutes === null ? null : Number(row.arrivalDelayMinutes),
        overtimeMinutes: row.overtimeMinutes === null ? null : Number(row.overtimeMinutes),
        creditedOvertimeMinutes: row.creditedOvertimeMinutes === null ? null : Number(row.creditedOvertimeMinutes),
        balanceMinutes: row.balanceMinutes === null ? null : Number(row.balanceMinutes),
        ruleCode: (row.ruleCode ?? null) as string | null,
        bankHoursExplanation: (row.bankHoursExplanation ?? null) as string | null,
        manualBalanceMinutes: null,
        manualBalanceNotes: null,
        manualBalanceUpdatedAt: null,
        manualBalanceActorEmail: null,
        auditTrail: [],
    };
}

async function loadManualBalanceOverrides(continuityGroupIds: string[]) {
    const normalizedIds = [...new Set(continuityGroupIds.filter(Boolean))];
    if (normalizedIds.length === 0) {
        return new Map<string, {
            balanceMinutes: number;
            notes: string;
            updatedAt: string;
            actorEmail: string | null;
        }>();
    }

    const db = getDb();
    const rows = await db
        .select({
            continuityGroupId: bankHoursBalanceOverrides.continuityGroupId,
            balanceMinutes: bankHoursBalanceOverrides.balanceMinutes,
            notes: bankHoursBalanceOverrides.notes,
            updatedAt: bankHoursBalanceOverrides.updatedAt,
            actorEmail: users.email,
        })
        .from(bankHoursBalanceOverrides)
        .leftJoin(users, eq(users.id, bankHoursBalanceOverrides.updatedByUserId))
        .where(inArray(bankHoursBalanceOverrides.continuityGroupId, normalizedIds));

    return new Map(rows.map((row) => [
        row.continuityGroupId,
        {
            balanceMinutes: row.balanceMinutes,
            notes: row.notes,
            updatedAt: row.updatedAt.toISOString(),
            actorEmail: row.actorEmail,
        },
    ]));
}

async function loadAuditTrailByOccupancy(shifts: RawBankHoursHistoryShift[]) {
    const regulationIds = shifts.filter((shift) => shift.domain === "regulation").map((shift) => shift.occupancyId);
    const interventionIds = shifts.filter((shift) => shift.domain === "intervention").map((shift) => shift.occupancyId);
    const filters = [];

    if (regulationIds.length > 0) {
        filters.push(and(
            eq(auditLogs.entityType, "regulation_occupancy"),
            inArray(auditLogs.entityId, regulationIds),
        ));
    }

    if (interventionIds.length > 0) {
        filters.push(and(
            eq(auditLogs.entityType, "intervention_occupancy"),
            inArray(auditLogs.entityId, interventionIds),
        ));
    }

    if (filters.length === 0) {
        return new Map<string, MonthlyReportAuditEntry[]>();
    }

    const db = getDb();
    const whereClause = filters.length === 1 ? filters[0] : or(...filters);
    const rows = await db
        .select({
            id: auditLogs.id,
            action: auditLogs.action,
            entityType: auditLogs.entityType,
            entityId: auditLogs.entityId,
            createdAt: auditLogs.createdAt,
            details: auditLogs.details,
            actorEmail: users.email,
        })
        .from(auditLogs)
        .leftJoin(users, eq(users.id, auditLogs.actorUserId))
        .where(whereClause)
        .orderBy(desc(auditLogs.createdAt));

    const grouped = new Map<string, MonthlyReportAuditEntry[]>();
    for (const row of rows) {
        const key = `${row.entityType}:${row.entityId}`;
        const current = grouped.get(key) ?? [];
        current.push({
            id: row.id,
            action: row.action,
            actorEmail: row.actorEmail,
            createdAt: row.createdAt.toISOString(),
            details: typeof row.details === "object" && row.details !== null ? row.details as Record<string, unknown> : {},
        });
        grouped.set(key, current);
    }

    return grouped;
}

export async function getBankHoursHistory(): Promise<BankHoursHistoryModel> {
    const db = getDb();
    const result = await db.execute(sql`
        with regulation_history as (
            select
                ro.id as "occupancyId",
                'regulation' as domain,
                d.id as "doctorId",
                d.full_name as "doctorName",
                d.display_name as "displayName",
                rp.code as "targetCode",
                rp.label as "targetLabel",
                ro.continuity_group_id as "continuityGroupId",
                ro.started_at as "startedAt",
                ro.board_started_at as "boardStartedAt",
                ro.ended_at as "handoffEndedAt",
                ro.actual_ended_at as "actualEndedAt",
                coalesce(ro.actual_ended_at, ro.ended_at) as "effectiveEndedAt",
                ro.shift_label as "shiftLabel",
                ro.source as source,
                ro.notes as notes,
                ro.created_at as "createdAt",
                ro.updated_at as "updatedAt",
                creator.email as "createdByEmail",
                updater.email as "updatedByEmail",
                (bhe.id is not null) as "hasPersistedBankEntry",
                ro.scheduled_start_at as "occupancyScheduledStartAt",
                ro.scheduled_end_at as "occupancyScheduledEndAt",
                bhe.scheduled_start_at as "bankScheduledStartAt",
                bhe.scheduled_end_at as "bankScheduledEndAt",
                bhe.actual_start_at as "bankActualStartAt",
                bhe.actual_end_at as "bankActualEndAt",
                bhe.arrival_delay_minutes as "arrivalDelayMinutes",
                bhe.overtime_minutes as "overtimeMinutes",
                bhe.credited_overtime_minutes as "creditedOvertimeMinutes",
                bhe.balance_minutes as "balanceMinutes",
                bhe.rule_code as "ruleCode",
                bhe.explanation as "bankHoursExplanation"
            from operations_v2.regulation_occupancies ro
            inner join operations_v2.doctors d on d.id = ro.doctor_id
            inner join operations_v2.regulation_posts rp on rp.id = ro.post_id
            left join operations_v2.users creator on creator.id = ro.created_by_user_id
            left join operations_v2.users updater on updater.id = ro.updated_by_user_id
            left join operations_v2.bank_hours_entries bhe on bhe.regulation_occupancy_id = ro.id
        ),
        intervention_history as (
            select
                io.id as "occupancyId",
                'intervention' as domain,
                d.id as "doctorId",
                d.full_name as "doctorName",
                d.display_name as "displayName",
                ib.code as "targetCode",
                ib.label as "targetLabel",
                io.continuity_group_id as "continuityGroupId",
                io.started_at as "startedAt",
                io.board_started_at as "boardStartedAt",
                io.ended_at as "handoffEndedAt",
                io.actual_ended_at as "actualEndedAt",
                coalesce(io.actual_ended_at, io.ended_at) as "effectiveEndedAt",
                io.shift_label as "shiftLabel",
                io.source as source,
                io.notes as notes,
                io.created_at as "createdAt",
                io.updated_at as "updatedAt",
                creator.email as "createdByEmail",
                updater.email as "updatedByEmail",
                (bhe.id is not null) as "hasPersistedBankEntry",
                io.scheduled_start_at as "occupancyScheduledStartAt",
                io.scheduled_end_at as "occupancyScheduledEndAt",
                bhe.scheduled_start_at as "bankScheduledStartAt",
                bhe.scheduled_end_at as "bankScheduledEndAt",
                bhe.actual_start_at as "bankActualStartAt",
                bhe.actual_end_at as "bankActualEndAt",
                bhe.arrival_delay_minutes as "arrivalDelayMinutes",
                bhe.overtime_minutes as "overtimeMinutes",
                bhe.credited_overtime_minutes as "creditedOvertimeMinutes",
                bhe.balance_minutes as "balanceMinutes",
                bhe.rule_code as "ruleCode",
                bhe.explanation as "bankHoursExplanation"
            from operations_v2.intervention_occupancies io
            inner join operations_v2.doctors d on d.id = io.doctor_id
            inner join operations_v2.intervention_bases ib on ib.id = io.base_id
            left join operations_v2.users creator on creator.id = io.created_by_user_id
            left join operations_v2.users updater on updater.id = io.updated_by_user_id
            left join operations_v2.bank_hours_entries bhe on bhe.intervention_occupancy_id = io.id
        )
        select * from regulation_history
        union all
        select * from intervention_history
    `);

    const rows = (result as unknown as Record<string, unknown>[]).map(mapRow);
    const [auditTrailByOccupancy, settlementsByDoctor] = await Promise.all([
        loadAuditTrailByOccupancy(rows),
        loadAllBankHoursSettlements(),
    ]);
    const manualOverridesByGroup = await loadManualBalanceOverrides(rows.map((row) => row.continuityGroupId));
    const enrichedRows = rows.map((row) => ({
        ...row,
        manualBalanceMinutes: manualOverridesByGroup.get(row.continuityGroupId)?.balanceMinutes ?? null,
        manualBalanceNotes: manualOverridesByGroup.get(row.continuityGroupId)?.notes ?? null,
        manualBalanceUpdatedAt: manualOverridesByGroup.get(row.continuityGroupId)?.updatedAt ?? null,
        manualBalanceActorEmail: manualOverridesByGroup.get(row.continuityGroupId)?.actorEmail ?? null,
        auditTrail: auditTrailByOccupancy.get(`${row.domain === "regulation" ? "regulation_occupancy" : "intervention_occupancy"}:${row.occupancyId}`) ?? [],
    }));

    return buildBankHoursHistoryModel(enrichedRows, settlementsByDoctor);
}

/**
 * Saldo EFETIVO do banco de horas por médico, em minutos. É a fonte única usada
 * pelo modal do payment-closing para decidir o gatilho de ±12h. O saldo do
 * histórico JÁ inclui os acertos (buildBankHoursHistoryModel os soma), então aqui
 * apenas reusamos esse número — sem dobrar a contagem.
 */
export async function getDoctorBankHoursEffectiveBalances(): Promise<Map<string, number>> {
    const [history, settlementDelta] = await Promise.all([
        getBankHoursHistory(),
        loadBankHoursSettlementDeltaByDoctor(),
    ]);

    const balances = new Map<string, number>();
    for (const doctor of history.doctors) {
        balances.set(doctor.doctorId, doctor.balanceMinutes);
    }
    // Médicos que só têm acerto (sem histórico de plantão) ainda precisam aparecer.
    for (const [doctorId, delta] of settlementDelta) {
        if (!balances.has(doctorId)) {
            balances.set(doctorId, delta);
        }
    }
    return balances;
}
import { and, desc, eq, inArray, or, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { auditLogs, bankHoursBalanceOverrides, bankHoursLegacyBalances, doctors, users } from "@/db/schema";
import {
    buildBankHoursHistoryModel,
    resolveBankHoursSettlementBalance,
    type BankHoursHistoryModel,
    type BankHoursLateDeparture,
    type BankHoursLegacyDoctorRecord,
    type BankHoursSettlementBalance,
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

// Saldos legados da planilha da coordenação: só linhas matched entram na
// composição — unmatched nunca aparece para nenhum médico.
async function loadLegacyBalancesByDoctor(): Promise<Map<string, BankHoursLegacyDoctorRecord>> {
    const db = getDb();
    const rows = await db
        .select({
            doctorId: bankHoursLegacyBalances.doctorId,
            doctorName: doctors.fullName,
            displayName: doctors.displayName,
            spreadsheetName: bankHoursLegacyBalances.spreadsheetName,
            preMay2025Minutes: bankHoursLegacyBalances.preMay2025Minutes,
            spreadsheetPeriodMinutes: bankHoursLegacyBalances.spreadsheetPeriodMinutes,
            totalMinutes: bankHoursLegacyBalances.totalMinutes,
            source: bankHoursLegacyBalances.source,
            notes: bankHoursLegacyBalances.notes,
        })
        .from(bankHoursLegacyBalances)
        .innerJoin(doctors, eq(doctors.id, bankHoursLegacyBalances.doctorId))
        .where(eq(bankHoursLegacyBalances.status, "matched"));

    return new Map(rows
        .filter((row): row is typeof row & { doctorId: string } => Boolean(row.doctorId))
        .map((row) => [row.doctorId, row]));
}

// Justificativas de saída tardia registradas no bot (ocorrência com número,
// higienização, liberação da chefia, rendição). Vivem no resolution_data das
// mensagens ingeridas; são poucas linhas no total, então carregamos todas.
async function loadLateDeparturesByOccupancy(): Promise<Map<string, BankHoursLateDeparture>> {
    const db = getDb();
    const result = await db.execute(sql`
        select
            related_occupancy_id as "occupancyId",
            resolution_data->>'matchedReasonCode' as "reasonCode",
            resolution_data->>'occurrenceNumber' as "occurrenceNumber"
        from operations_v2.telegram_ingested_messages
        where related_occupancy_id is not null
          and resolution_data ? 'matchedReasonCode'
        order by created_at asc
    `);

    const map = new Map<string, BankHoursLateDeparture>();
    for (const row of result as unknown as Record<string, unknown>[]) {
        const occupancyId = row.occupancyId ? String(row.occupancyId) : null;
        const reasonCode = row.reasonCode ? String(row.reasonCode) : null;
        if (!occupancyId || !reasonCode) {
            continue;
        }

        // Ordenado por received_at asc: a última justificativa aceita prevalece.
        map.set(occupancyId, {
            reasonCode,
            occurrenceNumber: row.occurrenceNumber ? String(row.occurrenceNumber) : null,
        });
    }

    return map;
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

/**
 * balancesOnly: pula o audit trail, as justificativas de saída do bot e as
 * provas textuais por plantão — tudo exclusivamente de exibição, sem efeito no
 * cálculo de balanceMinutes. É o modo usado pelo payment-closing, que só
 * precisa do saldo efetivo por médico.
 */
export async function getBankHoursHistory(options?: { balancesOnly?: boolean }): Promise<BankHoursHistoryModel> {
    const balancesOnly = options?.balancesOnly === true;
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
    const [auditTrailByOccupancy, settlementsByDoctor, legacyByDoctor, lateDeparturesByOccupancy] = await Promise.all([
        balancesOnly ? new Map<string, MonthlyReportAuditEntry[]>() : loadAuditTrailByOccupancy(rows),
        loadAllBankHoursSettlements(),
        loadLegacyBalancesByDoctor(),
        balancesOnly ? new Map<string, BankHoursLateDeparture>() : loadLateDeparturesByOccupancy(),
    ]);
    const manualOverridesByGroup = await loadManualBalanceOverrides(rows.map((row) => row.continuityGroupId));
    const enrichedRows = rows.map((row) => ({
        ...row,
        manualBalanceMinutes: manualOverridesByGroup.get(row.continuityGroupId)?.balanceMinutes ?? null,
        manualBalanceNotes: manualOverridesByGroup.get(row.continuityGroupId)?.notes ?? null,
        manualBalanceUpdatedAt: manualOverridesByGroup.get(row.continuityGroupId)?.updatedAt ?? null,
        manualBalanceActorEmail: manualOverridesByGroup.get(row.continuityGroupId)?.actorEmail ?? null,
        auditTrail: auditTrailByOccupancy.get(`${row.domain === "regulation" ? "regulation_occupancy" : "intervention_occupancy"}:${row.occupancyId}`) ?? [],
        lateDeparture: lateDeparturesByOccupancy.get(row.occupancyId) ?? null,
    }));

    return buildBankHoursHistoryModel(enrichedRows, settlementsByDoctor, legacyByDoctor, {
        includeProofs: !balancesOnly,
    });
}

/**
 * Saldo EFETIVO do banco de horas por médico, decomposto para a régua do acerto
 * de ±12h do fechamento. É a fonte única usada pelo payment-closing. O saldo do
 * histórico JÁ inclui os acertos (buildBankHoursHistoryModel os soma), então aqui
 * apenas reusamos esses números — sem dobrar a contagem.
 *
 * Decomposição: `oldMinutes` = planilha até abr/2025 (fora da régua);
 * `recentMinutes` = planilha mai/2025→mai/2026 + apurado pela aplicação
 * (com acertos). Só o recente pode virar bônus/punição — ver
 * resolveBankHoursSettlementBalance.
 */
export async function getDoctorBankHoursEffectiveBalances(): Promise<Map<string, BankHoursSettlementBalance>> {
    const [history, settlementDelta] = await Promise.all([
        getBankHoursHistory({ balancesOnly: true }),
        loadBankHoursSettlementDeltaByDoctor(),
    ]);

    const balances = new Map<string, BankHoursSettlementBalance>();
    for (const doctor of history.doctors) {
        const oldMinutes = doctor.legacy?.preMay2025Minutes ?? 0;
        balances.set(doctor.doctorId, resolveBankHoursSettlementBalance({
            oldMinutes,
            recentMinutes: (doctor.legacy?.spreadsheetPeriodMinutes ?? 0) + doctor.applicationBalanceMinutes,
        }));
    }
    // Médicos que só têm acerto (sem histórico de plantão) ainda precisam aparecer.
    for (const [doctorId, delta] of settlementDelta) {
        if (!balances.has(doctorId)) {
            balances.set(doctorId, resolveBankHoursSettlementBalance({ oldMinutes: 0, recentMinutes: delta }));
        }
    }
    return balances;
}
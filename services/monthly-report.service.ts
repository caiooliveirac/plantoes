import { and, desc, eq, inArray, or, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { auditLogs, users } from "@/db/schema";
import { buildContinuityCarrierLookup } from "@/modules/bank-hours/continuity";
import {
    buildMonthlyReportCsv,
    buildMonthlyReportModel,
    type MonthlyReportAuditEntry,
    type MonthlyReportModel,
    resolveMonthlyReportRange,
    type RawMonthlyReportShift,
} from "@/modules/reporting/monthly-report";
import { buildMonthlyReportWorkbook } from "@/modules/reporting/monthly-report-xlsx";
import {
    buildPaymentAllocationBoardModel,
    type PaymentAllocationRawRow,
    type PaymentAllocationTargetDefinition,
} from "@/services/board.service";

function normalizePaymentShiftLabel(value: unknown): PaymentAllocationRawRow["shiftLabel"] {
    const normalized = String(value ?? "").trim().toUpperCase();
    if (normalized === "SD" || normalized === "SN" || normalized === "P") {
        return normalized;
    }

    return null;
}

function mapPaymentAllocationTarget(row: Record<string, unknown>): PaymentAllocationTargetDefinition {
    return {
        domain: String(row.domain) === "regulation" ? "regulation" : "intervention",
        targetCode: String(row.targetCode),
        targetLabel: String(row.targetLabel),
        sortOrder: Number(row.sortOrder ?? 0),
        defaultRole: (row.defaultRole ?? null) as string | null,
    };
}

function mapPaymentAllocationAuditRow(row: Record<string, unknown>): PaymentAllocationRawRow {
    return {
        occupancyId: String(row.occupancyId),
        domain: String(row.domain) === "regulation" ? "regulation" : "intervention",
        targetCode: String(row.targetCode),
        targetLabel: String(row.targetLabel),
        doctorId: String(row.doctorId),
        doctorName: String(row.doctorName),
        displayName: (row.displayName ?? null) as string | null,
        startedAt: String(row.startedAt),
        boardStartedAt: (row.boardStartedAt ?? null) as string | null,
        endedAt: (row.endedAt ?? null) as string | null,
        actualEndedAt: (row.actualEndedAt ?? null) as string | null,
        scheduledStartAt: (row.scheduledStartAt ?? null) as string | null,
        scheduledEndAt: (row.scheduledEndAt ?? null) as string | null,
        continuityGroupId: (row.continuityGroupId ?? null) as string | null,
        shiftLabel: normalizePaymentShiftLabel(row.shiftLabel),
        roleLabel: (row.roleLabel ?? null) as string | null,
        ramalLabel: (row.ramalLabel ?? null) as string | null,
        earlyDepartureOutcome: (row.earlyDepartureOutcome ?? null) as string | null,
        arrivalDelayMinutes: row.arrivalDelayMinutes === null ? null : Number(row.arrivalDelayMinutes),
        overtimeMinutes: row.overtimeMinutes === null ? null : Number(row.overtimeMinutes),
        creditedOvertimeMinutes: row.creditedOvertimeMinutes === null ? null : Number(row.creditedOvertimeMinutes),
        balanceMinutes: row.balanceMinutes === null ? null : Number(row.balanceMinutes),
        ruleCode: (row.ruleCode ?? null) as string | null,
        bankHoursExplanation: (row.bankHoursExplanation ?? null) as string | null,
        source: (row.source ?? null) as string | null,
        notes: (row.notes ?? null) as string | null,
        createdAt: (row.createdAt ?? null) as string | null,
    };
}

function buildPaymentAuditSlotKey(slotStart: Date, shiftLabel: "SD" | "SN") {
    return `${slotStart.toISOString().slice(0, 10)}|${shiftLabel}`;
}

function buildOperationalDateIso(slotStart: Date) {
    return `${slotStart.toISOString().slice(0, 10)}T12:00:00.000Z`;
}

function buildMonthlyPaymentAllocationUsage(params: {
    range: {
        start: Date;
        end: Date;
    };
    targets: PaymentAllocationTargetDefinition[];
    rawRows: PaymentAllocationRawRow[];
}) {
    const usageByOccupancyId = new Map<string, string[]>();
    const slotDurationMs = 12 * 60 * 60 * 1000;

    for (let cursor = params.range.start.getTime(), index = 0; cursor < params.range.end.getTime(); cursor += slotDurationMs, index += 1) {
        const slotStart = new Date(cursor);
        const shiftLabel = index % 2 === 0 ? "SD" : "SN";
        const slotKey = buildPaymentAuditSlotKey(slotStart, shiftLabel);
        const board = buildPaymentAllocationBoardModel({
            targets: params.targets,
            rawRows: params.rawRows,
            operationalDate: buildOperationalDateIso(slotStart),
            shiftLabel,
            startedAt: slotStart.toISOString(),
            endedAt: new Date(cursor + slotDurationMs).toISOString(),
            generatedAt: params.range.end.toISOString(),
        });

        for (const row of [...board.regulation, ...board.intervention]) {
            if (!row.occupancyId) {
                continue;
            }

            const current = usageByOccupancyId.get(row.occupancyId) ?? [];
            current.push(slotKey);
            usageByOccupancyId.set(row.occupancyId, current);
        }
    }

    return usageByOccupancyId;
}

function mapRow(row: Record<string, unknown>): RawMonthlyReportShift {
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
        endedAt: (row.endedAt ?? null) as string | null,
        actualEndedAt: (row.actualEndedAt ?? null) as string | null,
        scheduledStartAt: (row.scheduledStartAt ?? null) as string | null,
        scheduledEndAt: (row.scheduledEndAt ?? null) as string | null,
        shiftLabel: (row.shiftLabel ?? null) as string | null,
        roleLabel: (row.roleLabel ?? null) as string | null,
        source: String(row.source) as RawMonthlyReportShift["source"],
        notes: (row.notes ?? null) as string | null,
        createdAt: String(row.createdAt),
        updatedAt: String(row.updatedAt),
        createdByEmail: (row.createdByEmail ?? null) as string | null,
        updatedByEmail: (row.updatedByEmail ?? null) as string | null,
        arrivalDelayMinutes: row.arrivalDelayMinutes === null ? null : Number(row.arrivalDelayMinutes),
        overtimeMinutes: row.overtimeMinutes === null ? null : Number(row.overtimeMinutes),
        creditedOvertimeMinutes: row.creditedOvertimeMinutes === null ? null : Number(row.creditedOvertimeMinutes),
        balanceMinutes: row.balanceMinutes === null ? null : Number(row.balanceMinutes),
        ruleCode: (row.ruleCode ?? null) as string | null,
        bankHoursExplanation: (row.bankHoursExplanation ?? null) as string | null,
        auditTrail: [],
        continuityCarrierOccupancyId: null,
        continuityGroupSize: 1,
    };
}

async function loadAuditTrailByOccupancy(shifts: RawMonthlyReportShift[]) {
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

export async function getMonthlyAdminReport(monthKey?: string | null): Promise<MonthlyReportModel> {
    const range = resolveMonthlyReportRange(monthKey);
    const startIso = range.start.toISOString();
    const endIso = range.end.toISOString();
    const auditStartIso = new Date(range.start.getTime() - 86400000).toISOString();
    const auditEndIso = new Date(range.end.getTime() + 86400000).toISOString();
    const db = getDb();
    const targetResult = await db.execute(sql`
        select
            'regulation' as domain,
            rp.code as "targetCode",
            rp.label as "targetLabel",
            rp.sort_order as "sortOrder",
            rp.default_role as "defaultRole"
        from operations_v2.regulation_posts rp
        where rp.is_active = true
        union all
        select
            'intervention' as domain,
            ib.code as "targetCode",
            ib.label as "targetLabel",
            ib.sort_order as "sortOrder",
            null::text as "defaultRole"
        from operations_v2.intervention_bases ib
        where ib.is_active = true
    `);
    const result = await db.execute(sql`
        with monthly_regulation as (
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
                coalesce(ro.actual_ended_at, ro.ended_at) as "endedAt",
                ro.actual_ended_at as "actualEndedAt",
                ro.scheduled_start_at as "scheduledStartAt",
                ro.scheduled_end_at as "scheduledEndAt",
                ro.shift_label as "shiftLabel",
                ro.role_label as "roleLabel",
        ro.early_departure_outcome as "earlyDepartureOutcome",
                coalesce(ro.ramal_label, rp.code) as "ramalLabel",
                ro.source as source,
                ro.notes as notes,
                ro.created_at as "createdAt",
                ro.updated_at as "updatedAt",
                creator.email as "createdByEmail",
                updater.email as "updatedByEmail",
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
            where ro.started_at >= ${auditStartIso}::timestamptz
                and ro.started_at < ${auditEndIso}::timestamptz
        ),
        monthly_intervention as (
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
                coalesce(io.actual_ended_at, io.ended_at) as "endedAt",
                io.actual_ended_at as "actualEndedAt",
                io.scheduled_start_at as "scheduledStartAt",
                io.scheduled_end_at as "scheduledEndAt",
                io.shift_label as "shiftLabel",
                io.role_label as "roleLabel",
        io.early_departure_outcome as "earlyDepartureOutcome",
                null::text as "ramalLabel",
                io.source as source,
                io.notes as notes,
                io.created_at as "createdAt",
                io.updated_at as "updatedAt",
                creator.email as "createdByEmail",
                updater.email as "updatedByEmail",
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
            where io.started_at >= ${auditStartIso}::timestamptz
                and io.started_at < ${auditEndIso}::timestamptz
        )
        select * from monthly_regulation
        union all
        select * from monthly_intervention
    `);

    const rawRecords = result as unknown as Record<string, unknown>[];
    const continuityByOccupancyId = buildContinuityCarrierLookup(rawRecords.map((row) => ({
        occupancyId: String(row.occupancyId),
        doctorId: String(row.doctorId),
        continuityGroupId: String(row.continuityGroupId),
        startedAt: String(row.startedAt),
        endedAt: (row.endedAt ?? null) as string | null,
        actualEndedAt: (row.actualEndedAt ?? null) as string | null,
    })));
    const paymentUsageByOccupancyId = buildMonthlyPaymentAllocationUsage({
        range: {
            start: range.start,
            end: range.end,
        },
        targets: (targetResult as unknown as Record<string, unknown>[]).map(mapPaymentAllocationTarget),
        rawRows: rawRecords.map(mapPaymentAllocationAuditRow),
    });
    const rows = rawRecords
        .filter((row) => {
            const startedAt = new Date(String(row.startedAt)).getTime();
            return startedAt >= range.start.getTime() && startedAt < range.end.getTime();
        })
        .map((row) => {
            const mappedRow = mapRow(row);
            const continuity = continuityByOccupancyId.get(mappedRow.occupancyId);
            return {
                ...mappedRow,
                continuityCarrierOccupancyId: continuity?.carrierOccupancyId ?? mappedRow.occupancyId,
                continuityGroupSize: continuity?.memberCount ?? 1,
                continuityGroupId: continuity?.continuityGroupId ?? mappedRow.continuityGroupId,
                paymentAuditPerformed: true,
                paymentAllocationSlotKeys: paymentUsageByOccupancyId.get(String(row.occupancyId)) ?? [],
            } satisfies RawMonthlyReportShift;
        });
    const auditTrailByOccupancy = await loadAuditTrailByOccupancy(rows);
    const enrichedRows = rows.map((row) => ({
        ...row,
        auditTrail: auditTrailByOccupancy.get(`${row.domain === "regulation" ? "regulation_occupancy" : "intervention_occupancy"}:${row.occupancyId}`) ?? [],
    }));

    return buildMonthlyReportModel(enrichedRows, range.monthKey);
}

export async function exportMonthlyAdminReportCsv(monthKey?: string | null) {
    const model = await getMonthlyAdminReport(monthKey);
    return buildMonthlyReportCsv(model);
}

export async function exportMonthlyAdminReportXlsx(monthKey?: string | null) {
    const model = await getMonthlyAdminReport(monthKey);
    return buildMonthlyReportWorkbook(model);
}
import { asc, eq, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { doctors } from "@/db/schema";
import { resolveMonthlyReportRange } from "@/modules/reporting/monthly-report";
import {
    buildAdminExtraPayableShift,
    buildAttestationSegments,
    buildChiefPayableBoard,
    buildDisabledTargetsFromBoards,
    buildUncoveredTargetsFromBoards,
    buildPayableShiftsFromBoards,
    buildPayableTargetOptions,
    type ChiefPayableBoardModel,
    resolveDoctorPaymentProfile,
    type RawPresenceEvent,
} from "@/modules/reporting/payable-shifts";
import { loadAdminExtraShiftsForRange } from "@/services/admin-extra-shifts.service";
import { loadDoctorAttestationsForMonth } from "@/services/payment-closing-attestation.service";
import {
    buildPaymentAllocationBoardModel,
    type PaymentAllocationBoard,
    type PaymentAllocationRawRow,
    type PaymentAllocationTargetDefinition,
} from "@/services/board.service";
import { buildChiefMonthlyPayableWorkbook } from "@/modules/reporting/payable-shifts-xlsx";

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
        targetId: row.targetId === null || row.targetId === undefined ? null : Number(row.targetId),
        targetCode: String(row.targetCode),
        targetLabel: String(row.targetLabel),
        sortOrder: Number(row.sortOrder ?? 0),
        defaultRole: (row.defaultRole ?? null) as string | null,
        disabledAt: null,
        reactivatedAt: null,
        disabledReason: null,
        disabledDuringShift: false,
        disabledEntireShift: false,
    };
}

interface TargetDeactivationInterval {
    domain: "regulation" | "intervention";
    targetId: number;
    deactivatedAt: string;
    reactivatedAt: string | null;
    notes: string | null;
}

function mapTargetDeactivationInterval(row: Record<string, unknown>): TargetDeactivationInterval {
    return {
        domain: String(row.domain) === "regulation" ? "regulation" : "intervention",
        targetId: Number(row.targetId),
        deactivatedAt: String(row.deactivatedAt),
        reactivatedAt: (row.reactivatedAt ?? null) as string | null,
        notes: (row.notes ?? null) as string | null,
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

function mapRawPresenceEvent(row: Record<string, unknown>): RawPresenceEvent {
    return {
        occupancyId: String(row.occupancyId),
        domain: String(row.domain) === "regulation" ? "regulation" : "intervention",
        doctorId: String(row.doctorId),
        doctorName: String(row.doctorName),
        displayName: (row.displayName ?? null) as string | null,
        targetCode: String(row.targetCode),
        targetLabel: String(row.targetLabel),
        startedAt: String(row.startedAt),
        endedAt: (row.endedAt ?? null) as string | null,
        actualEndedAt: (row.actualEndedAt ?? null) as string | null,
        scheduledStartAt: (row.scheduledStartAt ?? null) as string | null,
        scheduledEndAt: (row.scheduledEndAt ?? null) as string | null,
        shiftLabel: normalizePaymentShiftLabel(row.shiftLabel),
        source: ((row.source ?? "telegram") as RawPresenceEvent["source"]),
        continuityGroupId: (row.continuityGroupId ?? null) as string | null,
        notes: (row.notes ?? null) as string | null,
    };
}

async function loadTargets(startIso: string, endIso: string) {
    const db = getDb();
    const result = await db.execute(sql`
        select
            'regulation' as domain,
            rp.id as "targetId",
            rp.code as "targetCode",
            rp.label as "targetLabel",
            rp.sort_order as "sortOrder",
            rp.default_role as "defaultRole"
        from operations_v2.regulation_posts rp
                where rp.is_active = true
                     or exists (
                                select 1
                                from operations_v2.regulation_occupancies ro
                                where ro.post_id = rp.id
                                    and ro.started_at >= ${startIso}::timestamptz
                                    and ro.started_at < ${endIso}::timestamptz
                     )
                     or exists (
                                select 1
                                from operations_v2.regulation_post_deactivations rpd
                                where rpd.post_id = rp.id
                                    and rpd.deactivated_at < ${endIso}::timestamptz
                                    and coalesce(rpd.reactivated_at, 'infinity'::timestamptz) > ${startIso}::timestamptz
                     )
        union all
        select
            'intervention' as domain,
            ib.id as "targetId",
            ib.code as "targetCode",
            ib.label as "targetLabel",
            ib.sort_order as "sortOrder",
            null::text as "defaultRole"
        from operations_v2.intervention_bases ib
                where ib.is_active = true
                     or exists (
                                select 1
                                from operations_v2.intervention_occupancies io
                                where io.base_id = ib.id
                                    and io.started_at >= ${startIso}::timestamptz
                                    and io.started_at < ${endIso}::timestamptz
                     )
                     or exists (
                                select 1
                                from operations_v2.intervention_base_deactivations ibd
                                where ibd.base_id = ib.id
                                    and ibd.deactivated_at < ${endIso}::timestamptz
                                    and coalesce(ibd.reactivated_at, 'infinity'::timestamptz) > ${startIso}::timestamptz
                     )
    `);

    return (result as unknown as Record<string, unknown>[]).map(mapPaymentAllocationTarget);
}

async function loadTargetDeactivationIntervals(startIso: string, endIso: string) {
    const db = getDb();
    const result = await db.execute(sql`
        select
            'regulation' as domain,
            rpd.post_id as "targetId",
            rpd.deactivated_at as "deactivatedAt",
            rpd.reactivated_at as "reactivatedAt",
            rpd.notes as notes
        from operations_v2.regulation_post_deactivations rpd
        where rpd.deactivated_at < ${endIso}::timestamptz
          and coalesce(rpd.reactivated_at, 'infinity'::timestamptz) > ${startIso}::timestamptz

        union all

        select
            'intervention' as domain,
            ibd.base_id as "targetId",
            ibd.deactivated_at as "deactivatedAt",
            ibd.reactivated_at as "reactivatedAt",
            ibd.notes as notes
        from operations_v2.intervention_base_deactivations ibd
        where ibd.deactivated_at < ${endIso}::timestamptz
          and coalesce(ibd.reactivated_at, 'infinity'::timestamptz) > ${startIso}::timestamptz
    `);

    return (result as unknown as Record<string, unknown>[]).map(mapTargetDeactivationInterval);
}

function applyTargetDeactivationState(params: {
    targets: PaymentAllocationTargetDefinition[];
    intervals: TargetDeactivationInterval[];
    slotStartIso: string;
    slotEndIso: string;
}) {
    const slotStartMs = new Date(params.slotStartIso).getTime();
    const slotEndMs = new Date(params.slotEndIso).getTime();

    return params.targets.map((target) => {
        const targetId = target.targetId;
        if (!targetId) {
            return {
                ...target,
                disabledAt: null,
                reactivatedAt: null,
                disabledReason: null,
                disabledDuringShift: false,
                disabledEntireShift: false,
            } satisfies PaymentAllocationTargetDefinition;
        }

        const overlaps = params.intervals
            .filter((interval) => interval.domain === target.domain && interval.targetId === targetId)
            .filter((interval) => {
                const startMs = new Date(interval.deactivatedAt).getTime();
                const endMs = interval.reactivatedAt ? new Date(interval.reactivatedAt).getTime() : Number.POSITIVE_INFINITY;
                return startMs < slotEndMs && endMs > slotStartMs;
            })
            .sort((left, right) => new Date(right.deactivatedAt).getTime() - new Date(left.deactivatedAt).getTime());

        if (overlaps.length === 0) {
            return {
                ...target,
                disabledAt: null,
                reactivatedAt: null,
                disabledReason: null,
                disabledDuringShift: false,
                disabledEntireShift: false,
            } satisfies PaymentAllocationTargetDefinition;
        }

        const latest = overlaps[0] as TargetDeactivationInterval;
        const disabledEntireShift = overlaps.some((interval) => {
            const startMs = new Date(interval.deactivatedAt).getTime();
            const endMs = interval.reactivatedAt ? new Date(interval.reactivatedAt).getTime() : Number.POSITIVE_INFINITY;
            return startMs <= slotStartMs && endMs >= slotEndMs;
        });

        return {
            ...target,
            disabledAt: latest.deactivatedAt,
            reactivatedAt: latest.reactivatedAt,
            disabledReason: latest.notes,
            disabledDuringShift: true,
            disabledEntireShift,
        } satisfies PaymentAllocationTargetDefinition;
    });
}

async function loadRawRows(startIso: string, endIso: string) {
    const db = getDb();
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
                coalesce(ro.ramal_label, rp.code) as "ramalLabel",
                ro.source as source,
                ro.notes as notes,
                ro.created_at as "createdAt",
                bhe.arrival_delay_minutes as "arrivalDelayMinutes",
                bhe.overtime_minutes as "overtimeMinutes",
                bhe.credited_overtime_minutes as "creditedOvertimeMinutes",
                bhe.balance_minutes as "balanceMinutes",
                bhe.rule_code as "ruleCode",
                bhe.explanation as "bankHoursExplanation"
            from operations_v2.regulation_occupancies ro
            inner join operations_v2.doctors d on d.id = ro.doctor_id
            inner join operations_v2.regulation_posts rp on rp.id = ro.post_id
            left join operations_v2.bank_hours_entries bhe on bhe.regulation_occupancy_id = ro.id
            where ro.started_at >= ${startIso}::timestamptz
                and ro.started_at < ${endIso}::timestamptz
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
                null::text as "ramalLabel",
                io.source as source,
                io.notes as notes,
                io.created_at as "createdAt",
                bhe.arrival_delay_minutes as "arrivalDelayMinutes",
                bhe.overtime_minutes as "overtimeMinutes",
                bhe.credited_overtime_minutes as "creditedOvertimeMinutes",
                bhe.balance_minutes as "balanceMinutes",
                bhe.rule_code as "ruleCode",
                bhe.explanation as "bankHoursExplanation"
            from operations_v2.intervention_occupancies io
            inner join operations_v2.doctors d on d.id = io.doctor_id
            inner join operations_v2.intervention_bases ib on ib.id = io.base_id
            left join operations_v2.bank_hours_entries bhe on bhe.intervention_occupancy_id = io.id
            where io.started_at >= ${startIso}::timestamptz
                and io.started_at < ${endIso}::timestamptz
        )
        select * from monthly_regulation
        union all
        select * from monthly_intervention
    `);

    return result as unknown as Record<string, unknown>[];
}

function buildBoardsForRange(params: {
    rangeStart: Date;
    rangeEnd: Date;
    targets: PaymentAllocationTargetDefinition[];
    targetDeactivationIntervals: TargetDeactivationInterval[];
    rawRows: PaymentAllocationRawRow[];
}) {
    const boards: PaymentAllocationBoard[] = [];
    const slotDurationMs = 12 * 60 * 60 * 1000;

    for (let cursor = params.rangeStart.getTime(), index = 0; cursor < params.rangeEnd.getTime(); cursor += slotDurationMs, index += 1) {
        const slotStart = new Date(cursor);
        const slotEnd = new Date(cursor + slotDurationMs);
        const shiftLabel = index % 2 === 0 ? "SD" : "SN";
        const targetsForSlot = applyTargetDeactivationState({
            targets: params.targets,
            intervals: params.targetDeactivationIntervals,
            slotStartIso: slotStart.toISOString(),
            slotEndIso: slotEnd.toISOString(),
        });

        boards.push(buildPaymentAllocationBoardModel({
            targets: targetsForSlot,
            rawRows: params.rawRows,
            operationalDate: `${slotStart.toISOString().slice(0, 10)}T12:00:00.000Z`,
            shiftLabel,
            startedAt: slotStart.toISOString(),
            endedAt: slotEnd.toISOString(),
            generatedAt: params.rangeEnd.toISOString(),
        }));
    }

    return boards;
}

export interface PayableAllocationRangeResult {
    /** Os mesmos PaymentAllocationBoard que alimentam o fechamento mensal (um por slot de 12h). */
    boards: PaymentAllocationBoard[];
    /** occupancyId -> continuityGroupId, para casar a posição paga com o saldo de banco de horas. */
    continuityGroupByOccupancyId: Map<string, string>;
}

/**
 * Monta os PaymentAllocationBoard para um intervalo arbitrário usando exatamente
 * os mesmos loaders e o mesmo núcleo (buildBoardsForRange -> buildPaymentAllocationBoardModel)
 * que o fechamento mensal. É o ponto de reúso para auditorias por posição (slot-audit):
 * garante que "quem vai receber" cada posição seja idêntico ao payment-closing.
 *
 * NÃO altera o caminho do getChiefPayableShiftsBoard — apenas reaproveita as mesmas peças.
 */
export async function getPayableAllocationBoardsForRange(
    rangeStart: Date,
    rangeEnd: Date,
): Promise<PayableAllocationRangeResult> {
    const rawStartIso = new Date(rangeStart.getTime() - 86400000).toISOString();
    const rawEndIso = new Date(rangeEnd.getTime() + 86400000).toISOString();
    const [targets, targetDeactivationIntervals, rawResultRows] = await Promise.all([
        loadTargets(rawStartIso, rawEndIso),
        loadTargetDeactivationIntervals(rawStartIso, rawEndIso),
        loadRawRows(rawStartIso, rawEndIso),
    ]);

    const rawRows = rawResultRows.map(mapPaymentAllocationAuditRow);
    const boards = buildBoardsForRange({
        rangeStart,
        rangeEnd,
        targets,
        targetDeactivationIntervals,
        rawRows,
    });

    const continuityGroupByOccupancyId = new Map<string, string>();
    for (const row of rawRows) {
        if (row.continuityGroupId) {
            continuityGroupByOccupancyId.set(row.occupancyId, row.continuityGroupId);
        }
    }

    return { boards, continuityGroupByOccupancyId };
}

export async function getChiefPayableShiftsBoard(monthKey?: string | null): Promise<ChiefPayableBoardModel> {
    const range = resolveMonthlyReportRange(monthKey);
    const rawStartIso = new Date(range.start.getTime() - 86400000).toISOString();
    const rawEndIso = new Date(range.end.getTime() + 86400000).toISOString();
    // Datas operacionais (São Paulo, -180min) que delimitam o mês visível — usadas
    // para buscar os plantões extra do admin, cuja coluna operational_date é um date.
    const extraStartDate = new Date(range.start.getTime() - (180 * 60000)).toISOString().slice(0, 10);
    const extraEndDate = new Date(range.end.getTime() - (180 * 60000) - 1).toISOString().slice(0, 10);
    const [targets, targetDeactivationIntervals, rawResultRows, adminExtraRows, doctorAttestations, allDoctorRows] = await Promise.all([
        loadTargets(rawStartIso, rawEndIso),
        loadTargetDeactivationIntervals(rawStartIso, rawEndIso),
        loadRawRows(rawStartIso, rawEndIso),
        loadAdminExtraShiftsForRange(extraStartDate, extraEndDate),
        loadDoctorAttestationsForMonth(range.monthKey),
        getDb()
            .select({
                id: doctors.id,
                fullName: doctors.fullName,
                metadata: doctors.metadata,
            })
            .from(doctors)
            .where(eq(doctors.isActive, true))
            .orderBy(asc(doctors.fullName)),
    ]);

    const rawRows = rawResultRows.map(mapPaymentAllocationAuditRow);
    const boards = buildBoardsForRange({
        rangeStart: range.start,
        rangeEnd: range.end,
        targets,
        targetDeactivationIntervals,
        rawRows,
    });
    const payableShifts = buildPayableShiftsFromBoards(boards);
    // Plantões extra do admin entram como PayableShift verdes — contam no total a
    // pagar, mas não viram opção de ramal/base nem segmento de presença.
    const adminExtraShifts = adminExtraRows.map(buildAdminExtraPayableShift);
    const payableShiftsWithExtras = adminExtraShifts.length > 0
        ? [...payableShifts, ...adminExtraShifts]
        : payableShifts;
    const disabledTargets = buildDisabledTargetsFromBoards({
        boards,
        maxSlotStartedAtIso: new Date().toISOString(),
    });
    const uncoveredTargets = buildUncoveredTargetsFromBoards({
        boards,
        maxSlotStartedAtIso: new Date().toISOString(),
    });
    const targetOptions = buildPayableTargetOptions({ payableShifts, disabledTargets, uncoveredTargets });
    const selectedOccupancyIds = new Set(payableShifts.map((shift) => shift.occupancyId));
    const attestationSegments = buildAttestationSegments({
        rawEvents: rawResultRows
            .filter((row) => {
                const startedAt = new Date(String(row.startedAt)).getTime();
                return startedAt >= range.start.getTime() && startedAt < range.end.getTime();
            })
            .map(mapRawPresenceEvent),
        selectedOccupancyIds,
    });

    const doctorPaymentProfiles = Object.fromEntries(
        allDoctorRows.map((row) => [row.id, resolveDoctorPaymentProfile(row.metadata)])
    );

    return buildChiefPayableBoard({
        monthKey: range.monthKey,
        monthLabel: range.monthLabel,
        presetMonths: range.presetMonths,
        rangeStartIso: range.start.toISOString(),
        rangeEndIso: range.end.toISOString(),
        payableShifts: payableShiftsWithExtras,
        disabledTargets,
        uncoveredTargets,
        targetOptions,
        attestationSegments,
        allDoctorNames: allDoctorRows.map((row) => row.fullName),
        doctorPaymentProfiles,
        doctorAttestations,
    });
}

export async function exportChiefPayableShiftsXlsx(monthKey?: string | null) {
    const board = await getChiefPayableShiftsBoard(monthKey);
    return buildChiefMonthlyPayableWorkbook(board);
}

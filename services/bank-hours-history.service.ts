import { eq, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { bankHoursBalanceOverrides, bankHoursLegacyBalances, doctors, users } from "@/db/schema";
import { resolveDoctorEmploymentType } from "@/modules/reporting/payable-shifts";
import {
    buildBankHoursHistoryModel,
    resolveBankHoursSettlementBalance,
    type BankHoursEmploymentType,
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
        departureConfirmedAt: (row.departureConfirmedAt ?? null) as string | null,
        departureConfirmedByName: (row.departureConfirmedByName ?? null) as string | null,
        departureConfirmedNote: (row.departureConfirmedNote ?? null) as string | null,
        lateArrivalAcknowledgedAt: (row.lateArrivalAcknowledgedAt ?? null) as string | null,
        lateArrivalAcknowledgedByName: (row.lateArrivalAcknowledgedByName ?? null) as string | null,
        lateArrivalAcknowledgedNote: (row.lateArrivalAcknowledgedNote ?? null) as string | null,
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

// Carrega TODOS os overrides (tabela pequena, 1 linha por correção manual):
// mandar milhares de continuity_group_ids num IN custava mais em parse/bind do
// que trazer a tabela inteira e resolver o vínculo no map por grupo.
async function loadManualBalanceOverrides() {
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
        .leftJoin(users, eq(users.id, bankHoursBalanceOverrides.updatedByUserId));

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

// Vínculo (PJ × estatutário) por médico: mora em doctors.metadata.employmentType,
// a mesma leitura do fechamento (resolveDoctorEmploymentType). A tabela é
// pequena; carregar inteira custa menos que filtrar pelos ids do histórico.
async function loadEmploymentTypesByDoctor(): Promise<Map<string, BankHoursEmploymentType>> {
    const db = getDb();
    const rows = await db
        .select({ id: doctors.id, metadata: doctors.metadata })
        .from(doctors);
    return new Map(rows.map((row) => [row.id, resolveDoctorEmploymentType(row.metadata)]));
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

// O histórico cobre TODAS as ocupações, então o vínculo com a auditoria é
// resolvido no banco via EXISTS (índice audit_logs_entity_idx, migration 0036)
// em vez de mandar milhares de ids num IN — que custava parse/bind por request.
async function loadAuditTrailByOccupancy(doctorId?: string) {
    const db = getDb();
    // Filtrando por médico, o EXISTS ainda casa pelo mesmo índice
    // (audit_logs_entity_idx) mas descarta no banco as correções de todo mundo:
    // é o que permite a página do médico listar o histórico inteiro dele.
    const regulationOwner = doctorId ? sql`and ro.doctor_id = ${doctorId}` : sql``;
    const interventionOwner = doctorId ? sql`and io.doctor_id = ${doctorId}` : sql``;
    const result = await db.execute(sql`
        select
            al.id,
            al.action,
            al.entity_type as "entityType",
            al.entity_id as "entityId",
            al.created_at as "createdAt",
            al.details,
            u.email as "actorEmail"
        from operations_v2.audit_logs al
        left join operations_v2.users u on u.id = al.actor_user_id
        where (al.entity_type = 'regulation_occupancy' and exists (
                select 1 from operations_v2.regulation_occupancies ro where ro.id::text = al.entity_id ${regulationOwner}
            ))
           or (al.entity_type = 'intervention_occupancy' and exists (
                select 1 from operations_v2.intervention_occupancies io where io.id::text = al.entity_id ${interventionOwner}
            ))
        order by al.created_at desc
    `);

    const grouped = new Map<string, MonthlyReportAuditEntry[]>();
    for (const row of result as unknown as Record<string, unknown>[]) {
        const key = `${String(row.entityType)}:${String(row.entityId)}`;
        const current = grouped.get(key) ?? [];
        current.push({
            id: String(row.id),
            action: String(row.action),
            actorEmail: (row.actorEmail ?? null) as string | null,
            createdAt: new Date(String(row.createdAt)).toISOString(),
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
 *
 * doctorId: restringe a UM médico — a visão do próprio médico (link do bot) não
 * precisa varrer o histórico de todo mundo.
 */
export async function getBankHoursHistory(options?: { balancesOnly?: boolean; doctorId?: string }): Promise<BankHoursHistoryModel> {
    const balancesOnly = options?.balancesOnly === true;
    const db = getDb();
    // Forma canônica em operations_v2.bank_hours_history_shifts (migration 0036):
    // a mesma consulta fica disponível para EXPLAIN/auditoria direto no psql.
    // Filtrando por médico, os plantões do ramal 2031 de OUTROS médicos precisam
    // vir junto: é deles que sai a identificação de quem estava na chefia em cada
    // momento. Sem isso o lookup nasce vazio e nenhuma validação tem dono — que é
    // exatamente o que acontecia na página do médico.
    const result = await db.execute(sql`
        select * from operations_v2.bank_hours_history_shifts
        ${options?.doctorId
            ? sql`where "doctorId" = ${options.doctorId} or ("domain" = 'regulation' and "targetCode" = '2031')`
            : sql``}
    `);

    const rows = (result as unknown as Record<string, unknown>[]).map(mapRow);
    const [auditTrailByOccupancy, settlementsByDoctor, legacyByDoctor, lateDeparturesByOccupancy, manualOverridesByGroup, employmentTypeByDoctor] = await Promise.all([
        balancesOnly ? new Map<string, MonthlyReportAuditEntry[]>() : loadAuditTrailByOccupancy(options?.doctorId),
        loadAllBankHoursSettlements(),
        loadLegacyBalancesByDoctor(),
        balancesOnly ? new Map<string, BankHoursLateDeparture>() : loadLateDeparturesByOccupancy(),
        loadManualBalanceOverrides(),
        loadEmploymentTypesByDoctor(),
    ]);
    const enrichedRows = rows.map((row) => ({
        ...row,
        manualBalanceMinutes: manualOverridesByGroup.get(row.continuityGroupId)?.balanceMinutes ?? null,
        manualBalanceNotes: manualOverridesByGroup.get(row.continuityGroupId)?.notes ?? null,
        manualBalanceUpdatedAt: manualOverridesByGroup.get(row.continuityGroupId)?.updatedAt ?? null,
        manualBalanceActorEmail: manualOverridesByGroup.get(row.continuityGroupId)?.actorEmail ?? null,
        auditTrail: auditTrailByOccupancy.get(`${row.domain === "regulation" ? "regulation_occupancy" : "intervention_occupancy"}:${row.occupancyId}`) ?? [],
        lateDeparture: lateDeparturesByOccupancy.get(row.occupancyId) ?? null,
    }));

    const model = buildBankHoursHistoryModel(enrichedRows, settlementsByDoctor, legacyByDoctor, {
        includeProofs: !balancesOnly,
        employmentTypeByDoctor,
    });
    if (!options?.doctorId) return model;
    // Os plantões da chefia entraram só para alimentar o lookup: não são deste médico.
    return { ...model, doctors: model.doctors.filter((row) => row.doctorId === options.doctorId) };
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
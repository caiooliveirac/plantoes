/**
 * Database Schema (operations_v2)
 *
 * 18 tables organized by domain:
 *   - Core operational: regulationPosts, regulationOccupancies, interventionBases,
 *     interventionOccupancies, regulationPostDeactivations, interventionBaseDeactivations
 *   - Bank hours: bankHoursEntries, bankHoursBalanceOverrides, continuityGroups
 *   - Telegram: telegramIngestedMessages, telegramBotNotices
 *   - Doctors: doctors
 *   - Auth: users, userRoles, loginAttempts
 *   - Admin: paymentAttestations
 *   - Reminders: telegramReminders
 *
 * Key relationships:
 *   - Occupancies → Posts/Bases (many-to-one via postId/baseId)
 *   - Occupancies → Doctors (many-to-one via doctorId)
 *   - BankHoursEntries → Occupancies (via occupancyId + domain)
 *   - ContinuityGroups link consecutive occupancies by same doctor
 *
 * Invariants:
 *   - All timestamps are UTC (application handles São Paulo timezone conversion)
 *   - isActive on doctors/posts/bases is a domain state, not a soft delete
 *   - Occupancy.endedAt = scheduled handoff; actualEndedAt = real departure
 */
import { sql } from "drizzle-orm";
import {
    bigint,
    boolean,
    date,
    index,
    integer,
    jsonb,
    numeric,
    pgSchema,
    primaryKey,
    serial,
    smallint,
    text,
    timestamp,
    uniqueIndex,
    uuid,
    varchar,
} from "drizzle-orm/pg-core";

const operationsV2 = pgSchema("operations_v2");

export const userRoleEnum = operationsV2.enum("user_role", ["admin", "chief", "doctor", "payment_closing_limited"]);
export const inviteModeEnum = operationsV2.enum("invite_mode", ["email", "bearer"]);
export const chiefRequestStatusEnum = operationsV2.enum("chief_request_status", ["pending", "approved", "rejected"]);
export const occupancySourceEnum = operationsV2.enum("occupancy_source", ["manual", "telegram", "import", "admin_correction"]);
export const shiftEventDomainEnum = operationsV2.enum("shift_event_domain", ["regulation", "intervention", "chief", "doctors", "bank_hours", "auth"]);
export const bankHoursSourceEnum = operationsV2.enum("bank_hours_source", ["regulation", "intervention", "manual_adjustment"]);
export const paymentAttestationSlotStatusEnum = operationsV2.enum("payment_attestation_slot_status", ["draft", "approved"]);
export const scheduledShiftStatusEnum = operationsV2.enum("scheduled_shift_status", ["planned", "cancelled"]);
export const shiftSwapTypeEnum = operationsV2.enum("shift_swap_type", ["transfer", "mutual", "function_change", "base_change"]);
export const shiftSwapStatusEnum = operationsV2.enum("shift_swap_status", ["offered", "accepted", "approved", "rejected", "cancelled"]);

export const doctors = operationsV2.table(
    "doctors",
    {
        id: uuid("id").primaryKey().defaultRandom(),
        externalCode: varchar("external_code", { length: 64 }),
        fullName: varchar("full_name", { length: 255 }).notNull(),
        displayName: varchar("display_name", { length: 255 }),
        normalizedName: varchar("normalized_name", { length: 255 }).notNull(),
        isActive: boolean("is_active").notNull().default(true),
        // Elegibilidade por domínio para a escala web; default true = todo
        // médico existente nasce apto aos dois domínios.
        eligibleRegulation: boolean("eligible_regulation").notNull().default(true),
        eligibleIntervention: boolean("eligible_intervention").notNull().default(true),
        // Antiguidade (data de admissão); nullable, preenchida pelo admin.
        admittedAt: date("admitted_at"),
        metadata: jsonb("metadata").notNull().default({}),
        createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
        updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    },
    (table) => [
        uniqueIndex("doctors_normalized_name_idx").on(table.normalizedName),
        index("doctors_active_idx").on(table.isActive),
    ],
);

export const users = operationsV2.table(
    "users",
    {
        id: uuid("id").primaryKey().defaultRandom(),
        doctorId: uuid("doctor_id").references(() => doctors.id),
        email: varchar("email", { length: 255 }).notNull(),
        passwordHash: text("password_hash").notNull(),
        mustChangePassword: boolean("must_change_password").notNull().default(false),
        isActive: boolean("is_active").notNull().default(true),
        createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
        updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    },
    (table) => [
        uniqueIndex("users_email_idx").on(table.email),
        index("users_doctor_idx").on(table.doctorId),
    ],
);

export const userRoles = operationsV2.table(
    "user_roles",
    {
        userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
        role: userRoleEnum("role").notNull(),
        createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    },
    (table) => [primaryKey({ columns: [table.userId, table.role] })],
);

export const passwordResetTokens = operationsV2.table(
    "password_reset_tokens",
    {
        id: uuid("id").primaryKey().defaultRandom(),
        userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
        token: varchar("token", { length: 128 }).notNull(),
        expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
        usedAt: timestamp("used_at", { withTimezone: true }),
        createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    },
    (table) => [
        uniqueIndex("password_reset_tokens_token_idx").on(table.token),
        index("password_reset_tokens_user_idx").on(table.userId),
    ],
);

export const chiefInvites = operationsV2.table(
    "chief_invites",
    {
        id: uuid("id").primaryKey().defaultRandom(),
        token: varchar("token", { length: 128 }).notNull(),
        email: varchar("email", { length: 255 }),
        inviteMode: inviteModeEnum("invite_mode").notNull(),
        invitedByUserId: uuid("invited_by_user_id").references(() => users.id),
        expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
        usedAt: timestamp("used_at", { withTimezone: true }),
        createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    },
    (table) => [uniqueIndex("chief_invites_token_idx").on(table.token)],
);

export const chiefAccessRequests = operationsV2.table(
    "chief_access_requests",
    {
        id: uuid("id").primaryKey().defaultRandom(),
        inviteId: uuid("invite_id").notNull().references(() => chiefInvites.id, { onDelete: "cascade" }),
        doctorId: uuid("doctor_id").notNull().references(() => doctors.id),
        requestedEmail: varchar("requested_email", { length: 255 }).notNull(),
        phone: varchar("phone", { length: 30 }),
        registrationNumber: varchar("registration_number", { length: 100 }),
        selfieUrl: text("selfie_url").notNull(),
        passwordHash: text("password_hash").notNull(),
        status: chiefRequestStatusEnum("status").notNull().default("pending"),
        reviewedByUserId: uuid("reviewed_by_user_id").references(() => users.id),
        reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
        reviewNotes: text("review_notes"),
        approvedUserId: uuid("approved_user_id").references(() => users.id),
        createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
        updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    },
    (table) => [
        index("chief_access_requests_status_idx").on(table.status),
        index("chief_access_requests_doctor_idx").on(table.doctorId),
    ],
);

export const regulationPosts = operationsV2.table(
    "regulation_posts",
    {
        id: serial("id").primaryKey(),
        code: varchar("code", { length: 32 }).notNull(),
        label: varchar("label", { length: 255 }).notNull(),
        defaultRole: varchar("default_role", { length: 100 }),
        sortOrder: integer("sort_order").notNull().default(0),
        isActive: boolean("is_active").notNull().default(true),
    },
    (table) => [uniqueIndex("regulation_posts_code_idx").on(table.code)],
);

export const interventionBases = operationsV2.table(
    "intervention_bases",
    {
        id: serial("id").primaryKey(),
        code: varchar("code", { length: 32 }).notNull(),
        label: varchar("label", { length: 255 }).notNull(),
        sortOrder: integer("sort_order").notNull().default(0),
        isActive: boolean("is_active").notNull().default(true),
    },
    (table) => [uniqueIndex("intervention_bases_code_idx").on(table.code)],
);

export const interventionBaseDeactivations = operationsV2.table(
    "intervention_base_deactivations",
    {
        id: uuid("id").primaryKey().defaultRandom(),
        baseId: integer("base_id").notNull().references(() => interventionBases.id, { onDelete: "cascade" }),
        deactivatedAt: timestamp("deactivated_at", { withTimezone: true }).notNull(),
        reactivatedAt: timestamp("reactivated_at", { withTimezone: true }),
        notes: text("notes"),
        createdByUserId: uuid("created_by_user_id").references(() => users.id),
        updatedByUserId: uuid("updated_by_user_id").references(() => users.id),
        createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
        updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    },
    (table) => [
        index("intervention_base_deactivations_base_idx").on(table.baseId, table.deactivatedAt),
        index("intervention_base_deactivations_active_idx").on(table.baseId, table.reactivatedAt),
    ],
);

export const regulationPostDeactivations = operationsV2.table(
    "regulation_post_deactivations",
    {
        id: uuid("id").primaryKey().defaultRandom(),
        postId: integer("post_id").notNull().references(() => regulationPosts.id, { onDelete: "cascade" }),
        deactivatedAt: timestamp("deactivated_at", { withTimezone: true }).notNull(),
        reactivatedAt: timestamp("reactivated_at", { withTimezone: true }),
        notes: text("notes"),
        createdByUserId: uuid("created_by_user_id").references(() => users.id),
        updatedByUserId: uuid("updated_by_user_id").references(() => users.id),
        createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
        updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    },
    (table) => [
        index("regulation_post_deactivations_post_idx").on(table.postId, table.deactivatedAt),
        index("regulation_post_deactivations_active_idx").on(table.postId, table.reactivatedAt),
    ],
);

export const regulationOccupancies = operationsV2.table(
    "regulation_occupancies",
    {
        id: uuid("id").primaryKey().defaultRandom(),
        doctorId: uuid("doctor_id").notNull().references(() => doctors.id),
        continuityGroupId: uuid("continuity_group_id").notNull(),
        postId: integer("post_id").notNull().references(() => regulationPosts.id),
        scheduledStartAt: timestamp("scheduled_start_at", { withTimezone: true }),
        scheduledEndAt: timestamp("scheduled_end_at", { withTimezone: true }),
        startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
        // Nullable so a coexisting "sombra" can be stored without a board anchor
        // (mirrors intervention) and stays outside the one-active-board-per-post
        // unique index. A titular / lone arrival always carries a board_started_at.
        boardStartedAt: timestamp("board_started_at", { withTimezone: true }),
        endedAt: timestamp("ended_at", { withTimezone: true }),
        actualEndedAt: timestamp("actual_ended_at", { withTimezone: true }),
        shiftLabel: varchar("shift_label", { length: 100 }),
        roleLabel: varchar("role_label", { length: 100 }),
        ramalLabel: varchar("ramal_label", { length: 50 }),
        source: occupancySourceEnum("source").notNull(),
        notes: text("notes"),
        createdByUserId: uuid("created_by_user_id").references(() => users.id),
        updatedByUserId: uuid("updated_by_user_id").references(() => users.id),
        createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
        updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
        departureConfirmedAt: timestamp("departure_confirmed_at", { withTimezone: true }),
        departureConfirmedByUserId: uuid("departure_confirmed_by_user_id").references(() => users.id),
        departureConfirmedNote: text("departure_confirmed_note"),
    },
    (table) => [
        index("regulation_occupancies_doctor_idx").on(table.doctorId),
        index("regulation_occupancies_continuity_idx").on(table.doctorId, table.continuityGroupId, table.startedAt),
        index("regulation_occupancies_post_idx").on(table.postId),
        index("regulation_occupancies_board_idx").on(table.postId, table.boardStartedAt),
        index("regulation_occupancies_active_idx").on(table.endedAt),
    ],
);

export const interventionOccupancies = operationsV2.table(
    "intervention_occupancies",
    {
        id: uuid("id").primaryKey().defaultRandom(),
        doctorId: uuid("doctor_id").notNull().references(() => doctors.id),
        continuityGroupId: uuid("continuity_group_id").notNull(),
        baseId: integer("base_id").notNull().references(() => interventionBases.id),
        scheduledStartAt: timestamp("scheduled_start_at", { withTimezone: true }),
        scheduledEndAt: timestamp("scheduled_end_at", { withTimezone: true }),
        startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
        boardStartedAt: timestamp("board_started_at", { withTimezone: true }),
        endedAt: timestamp("ended_at", { withTimezone: true }),
        actualEndedAt: timestamp("actual_ended_at", { withTimezone: true }),
        shiftLabel: varchar("shift_label", { length: 100 }),
        roleLabel: varchar("role_label", { length: 100 }),
        source: occupancySourceEnum("source").notNull(),
        notes: text("notes"),
        createdByUserId: uuid("created_by_user_id").references(() => users.id),
        updatedByUserId: uuid("updated_by_user_id").references(() => users.id),
        createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
        updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
        lateArrivalAcknowledgedAt: timestamp("late_arrival_acknowledged_at", { withTimezone: true }),
        lateArrivalAcknowledgedByUserId: uuid("late_arrival_acknowledged_by_user_id").references(() => users.id),
        lateArrivalAcknowledgedNote: text("late_arrival_acknowledged_note"),
        departureConfirmedAt: timestamp("departure_confirmed_at", { withTimezone: true }),
        departureConfirmedByUserId: uuid("departure_confirmed_by_user_id").references(() => users.id),
        departureConfirmedNote: text("departure_confirmed_note"),
    },
    (table) => [
        index("intervention_occupancies_doctor_idx").on(table.doctorId),
        index("intervention_occupancies_continuity_idx").on(table.doctorId, table.continuityGroupId, table.startedAt),
        index("intervention_occupancies_base_idx").on(table.baseId),
        index("intervention_occupancies_board_idx").on(table.baseId, table.boardStartedAt),
        index("intervention_occupancies_active_idx").on(table.endedAt),
    ],
);

// Plantões extra adicionados manualmente pelo admin na tela de fechamento de
// pagamento. Não são ocupações reais do quadro operacional — entram só no board
// do payment-closing (em verde) e contam para o valor a pagar do médico.
export const adminExtraShifts = operationsV2.table(
    "admin_extra_shifts",
    {
        id: uuid("id").primaryKey().defaultRandom(),
        doctorId: uuid("doctor_id").notNull().references(() => doctors.id),
        operationalDate: date("operational_date").notNull(),
        shiftLabel: varchar("shift_label", { length: 2 }).notNull(),
        label: varchar("label", { length: 40 }),
        // 'extra' = verde manual; 'bonus' = verde gerado pelo acerto do banco de
        // horas; 'penalty' = vermelho (unit -1, desconta um plantão do total).
        kind: varchar("kind", { length: 10 }).notNull().default("extra"),
        unit: integer("unit").notNull().default(1),
        createdByUserId: uuid("created_by_user_id").references(() => users.id),
        createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    },
    (table) => [
        index("admin_extra_shifts_doctor_idx").on(table.doctorId),
        index("admin_extra_shifts_date_idx").on(table.operationalDate),
    ],
);

// Nota fiscal e nº do processo de pagamento por médico/mês — preenchidos à mão
// pelo admin no modal do fechamento. Uma linha por (médico, mês); upsert.
export const paymentClosingMeta = operationsV2.table(
    "payment_closing_meta",
    {
        id: uuid("id").primaryKey().defaultRandom(),
        doctorId: uuid("doctor_id").notNull().references(() => doctors.id),
        monthKey: varchar("month_key", { length: 7 }).notNull(),
        invoiceNumber: varchar("invoice_number", { length: 60 }),
        paymentProcessNumber: varchar("payment_process_number", { length: 60 }),
        updatedByUserId: uuid("updated_by_user_id").references(() => users.id),
        updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    },
    (table) => [
        uniqueIndex("payment_closing_meta_doctor_month_idx").on(table.doctorId, table.monthKey),
    ],
);

// Semente do contrato do médico: teto em R$ informado uma vez. A partir daí o
// saldo contratual é cálculo (teto - pagamentos acumulados desde seed_month).
export const doctorContracts = operationsV2.table(
    "doctor_contracts",
    {
        id: uuid("id").primaryKey().defaultRandom(),
        doctorId: uuid("doctor_id").notNull().references(() => doctors.id),
        ceilingBrl: numeric("ceiling_brl", { precision: 12, scale: 2 }).notNull(),
        seedMonth: varchar("seed_month", { length: 7 }).notNull(),
        createdByUserId: uuid("created_by_user_id").references(() => users.id),
        createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
        updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    },
    (table) => [
        uniqueIndex("doctor_contracts_doctor_idx").on(table.doctorId),
    ],
);

// Acerto do banco de horas (débito/bônus de 12h) lançado no fechamento. Move o
// saldo do médico em direção a zero (delta negativo = bônus pago; positivo =
// punição cobrada) e fica casado ao plantão verde/vermelho gerado.
export const bankHoursSettlements = operationsV2.table(
    "bank_hours_settlements",
    {
        id: uuid("id").primaryKey().defaultRandom(),
        doctorId: uuid("doctor_id").notNull().references(() => doctors.id),
        monthKey: varchar("month_key", { length: 7 }).notNull(),
        deltaMinutes: integer("delta_minutes").notNull(),
        kind: varchar("kind", { length: 10 }).notNull(),
        adminExtraShiftId: uuid("admin_extra_shift_id").references(() => adminExtraShifts.id, { onDelete: "set null" }),
        notes: text("notes").notNull(),
        createdByUserId: uuid("created_by_user_id").references(() => users.id),
        createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    },
    (table) => [
        index("bank_hours_settlements_doctor_idx").on(table.doctorId, table.monthKey),
    ],
);

// Atestação por médico/mês: o admin marca que já conferiu e assinou a
// produtividade do plantonista naquele mês. Uma linha por (médico, mês); toggle.
export const paymentClosingAttestations = operationsV2.table(
    "payment_closing_attestations",
    {
        id: uuid("id").primaryKey().defaultRandom(),
        doctorId: uuid("doctor_id").notNull().references(() => doctors.id),
        monthKey: varchar("month_key", { length: 7 }).notNull(),
        attestedByUserId: uuid("attested_by_user_id").references(() => users.id),
        attestedAt: timestamp("attested_at", { withTimezone: true }).notNull().defaultNow(),
    },
    (table) => [
        uniqueIndex("payment_closing_attestations_doctor_month_idx").on(table.doctorId, table.monthKey),
    ],
);

export const shiftEvents = operationsV2.table(
    "shift_events",
    {
        id: uuid("id").primaryKey().defaultRandom(),
        domain: shiftEventDomainEnum("domain").notNull(),
        entityId: uuid("entity_id"),
        entityType: varchar("entity_type", { length: 100 }).notNull(),
        eventType: varchar("event_type", { length: 100 }).notNull(),
        actorUserId: uuid("actor_user_id").references(() => users.id),
        actorLabel: varchar("actor_label", { length: 255 }),
        payload: jsonb("payload").notNull().default({}),
        occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
    },
    (table) => [index("shift_events_domain_idx").on(table.domain, table.occurredAt)],
);

export const bankHoursEntries = operationsV2.table(
    "bank_hours_entries",
    {
        id: uuid("id").primaryKey().defaultRandom(),
        doctorId: uuid("doctor_id").notNull().references(() => doctors.id),
        sourceType: bankHoursSourceEnum("source_type").notNull(),
        regulationOccupancyId: uuid("regulation_occupancy_id").references(() => regulationOccupancies.id),
        interventionOccupancyId: uuid("intervention_occupancy_id").references(() => interventionOccupancies.id),
        scheduledStartAt: timestamp("scheduled_start_at", { withTimezone: true }).notNull(),
        scheduledEndAt: timestamp("scheduled_end_at", { withTimezone: true }).notNull(),
        actualStartAt: timestamp("actual_start_at", { withTimezone: true }).notNull(),
        actualEndAt: timestamp("actual_end_at", { withTimezone: true }).notNull(),
        arrivalDelayMinutes: integer("arrival_delay_minutes").notNull(),
        overtimeMinutes: integer("overtime_minutes").notNull(),
        overtimeMultiplier: integer("overtime_multiplier").notNull(),
        creditedOvertimeMinutes: integer("credited_overtime_minutes").notNull(),
        balanceMinutes: integer("balance_minutes").notNull(),
        ruleCode: varchar("rule_code", { length: 100 }).notNull(),
        calculationVersion: integer("calculation_version").notNull().default(1),
        explanation: text("explanation").notNull(),
        createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
        updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    },
    (table) => [
        index("bank_hours_entries_doctor_idx").on(table.doctorId, table.scheduledStartAt),
        uniqueIndex("bank_hours_entries_regulation_idx").on(table.regulationOccupancyId),
        uniqueIndex("bank_hours_entries_intervention_idx").on(table.interventionOccupancyId),
    ],
);

export const bankHoursBalanceOverrides = operationsV2.table(
    "bank_hours_balance_overrides",
    {
        id: uuid("id").primaryKey().defaultRandom(),
        continuityGroupId: uuid("continuity_group_id").notNull(),
        doctorId: uuid("doctor_id").notNull().references(() => doctors.id),
        balanceMinutes: integer("balance_minutes").notNull(),
        notes: text("notes").notNull(),
        createdByUserId: uuid("created_by_user_id").references(() => users.id),
        updatedByUserId: uuid("updated_by_user_id").references(() => users.id),
        createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
        updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    },
    (table) => [
        uniqueIndex("bank_hours_balance_overrides_group_idx").on(table.continuityGroupId),
        index("bank_hours_balance_overrides_doctor_idx").on(table.doctorId, table.updatedAt),
    ],
);

// Saldo legado do banco de horas vindo da planilha da coordenação (pré-corte).
// Duas parcelas separadas em minutos assinados: até 30/abr/2025 e o período
// mai/2025 -> mai/2026 apurado pela planilha. Registros são imutáveis após a
// importação (sem updated_at; correção = nova migração). doctor_id nasce nulo
// e só é gravado com matching de nome aprovado manualmente (status matched).
// Índice único parcial em doctor_id (where not null) vive só na migration 0033.
export const bankHoursLegacyBalances = operationsV2.table(
    "bank_hours_legacy_balances",
    {
        id: uuid("id").primaryKey().defaultRandom(),
        doctorId: uuid("doctor_id").references(() => doctors.id),
        spreadsheetName: varchar("spreadsheet_name", { length: 255 }).notNull(),
        preMay2025Minutes: integer("pre_may_2025_minutes").notNull(),
        spreadsheetPeriodMinutes: integer("spreadsheet_period_minutes").notNull(),
        totalMinutes: integer("total_minutes").notNull(),
        source: text("source").notNull(),
        notes: text("notes"),
        status: varchar("status", { length: 10 }).notNull(),
        createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    },
    (table) => [
        uniqueIndex("bank_hours_legacy_balances_name_idx").on(table.spreadsheetName),
    ],
);

export const paymentAttestationSlots = operationsV2.table(
    "payment_attestation_slots",
    {
        id: uuid("id").primaryKey().defaultRandom(),
        operationalDate: timestamp("operational_date", { withTimezone: true }).notNull(),
        shiftLabel: varchar("shift_label", { length: 8 }).notNull(),
        startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
        endedAt: timestamp("ended_at", { withTimezone: true }).notNull(),
        snapshotGeneratedAt: timestamp("snapshot_generated_at", { withTimezone: true }).notNull(),
        status: paymentAttestationSlotStatusEnum("status").notNull().default("draft"),
        totalTargets: integer("total_targets").notNull().default(0),
        readyCount: integer("ready_count").notNull().default(0),
        needsReviewCount: integer("needs_review_count").notNull().default(0),
        unassignedCount: integer("unassigned_count").notNull().default(0),
        disabledCount: integer("disabled_count").notNull().default(0),
        lastRefreshedByUserId: uuid("last_refreshed_by_user_id").references(() => users.id),
        approvedByUserId: uuid("approved_by_user_id").references(() => users.id),
        approvedAt: timestamp("approved_at", { withTimezone: true }),
        createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
        updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    },
    (table) => [
        uniqueIndex("payment_attestation_slots_operational_shift_idx").on(table.operationalDate, table.shiftLabel),
        index("payment_attestation_slots_status_idx").on(table.status, table.operationalDate, table.startedAt),
    ],
);

export const paymentAttestationSlotEntries = operationsV2.table(
    "payment_attestation_slot_entries",
    {
        id: uuid("id").primaryKey().defaultRandom(),
        slotId: uuid("slot_id").notNull().references(() => paymentAttestationSlots.id, { onDelete: "cascade" }),
        domain: varchar("domain", { length: 32 }).notNull(),
        targetCode: varchar("target_code", { length: 32 }).notNull(),
        targetLabel: varchar("target_label", { length: 255 }).notNull(),
        sortOrder: integer("sort_order").notNull().default(0),
        defaultRole: varchar("default_role", { length: 100 }),
        disabledAt: timestamp("disabled_at", { withTimezone: true }),
        disabledReason: text("disabled_reason"),
        disabledDuringShift: boolean("disabled_during_shift").notNull().default(false),
        disabledEntireShift: boolean("disabled_entire_shift").notNull().default(false),
        occupancyId: uuid("occupancy_id"),
        doctorId: uuid("doctor_id").references(() => doctors.id),
        doctorName: varchar("doctor_name", { length: 255 }),
        displayName: varchar("display_name", { length: 255 }),
        startedAt: timestamp("started_at", { withTimezone: true }),
        endedAt: timestamp("ended_at", { withTimezone: true }),
        actualEndedAt: timestamp("actual_ended_at", { withTimezone: true }),
        scheduledStartAt: timestamp("scheduled_start_at", { withTimezone: true }),
        scheduledEndAt: timestamp("scheduled_end_at", { withTimezone: true }),
        shiftLabel: varchar("shift_label", { length: 100 }),
        roleLabel: varchar("role_label", { length: 100 }),
        ramalLabel: varchar("ramal_label", { length: 50 }),
        source: occupancySourceEnum("source"),
        candidateCount: integer("candidate_count").notNull().default(0),
        paymentStatus: varchar("payment_status", { length: 32 }).notNull(),
        issues: jsonb("issues").notNull().default([]),
        arrivalDelayMinutes: integer("arrival_delay_minutes"),
        overtimeMinutes: integer("overtime_minutes"),
        creditedOvertimeMinutes: integer("credited_overtime_minutes"),
        balanceMinutes: integer("balance_minutes"),
        ruleCode: varchar("rule_code", { length: 100 }),
        bankHoursExplanation: text("bank_hours_explanation"),
        createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    },
    (table) => [
        uniqueIndex("payment_attestation_slot_entries_target_idx").on(table.slotId, table.domain, table.targetCode, table.occupancyId),
        index("payment_attestation_slot_entries_slot_idx").on(table.slotId, table.sortOrder),
        index("payment_attestation_slot_entries_doctor_idx").on(table.doctorId, table.createdAt),
    ],
);

export const telegramIngestedMessages = operationsV2.table(
    "telegram_ingested_messages",
    {
        id: uuid("id").primaryKey().defaultRandom(),
        telegramUpdateId: bigint("telegram_update_id", { mode: "number" }),
        telegramMessageId: bigint("telegram_message_id", { mode: "number" }).notNull(),
        chatId: varchar("chat_id", { length: 32 }).notNull(),
        senderTelegramId: varchar("sender_telegram_id", { length: 32 }),
        senderName: varchar("sender_name", { length: 255 }),
        rawText: text("raw_text").notNull(),
        parsedDomain: varchar("parsed_domain", { length: 32 }),
        parsedTargetCode: varchar("parsed_target_code", { length: 64 }),
        parsedAction: varchar("parsed_action", { length: 32 }),
        parsedDoctorName: varchar("parsed_doctor_name", { length: 255 }),
        relatedOccupancyId: uuid("related_occupancy_id"),
        status: varchar("status", { length: 32 }).notNull().default("pending"),
        resolutionData: jsonb("resolution_data").notNull().default({}),
        errorMessage: text("error_message"),
        processedAt: timestamp("processed_at", { withTimezone: true }),
        createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    },
    (table) => [
        uniqueIndex("telegram_ingested_messages_msg_idx").on(table.chatId, table.telegramMessageId),
        index("telegram_ingested_messages_status_idx").on(table.status, table.createdAt),
    ],
);

export const telegramBotNotices = operationsV2.table(
    "telegram_bot_notices",
    {
        id: uuid("id").primaryKey().defaultRandom(),
        noticeKey: varchar("notice_key", { length: 255 }).notNull(),
        chatId: varchar("chat_id", { length: 32 }).notNull(),
        stage: varchar("stage", { length: 32 }).notNull(),
        payload: jsonb("payload").notNull().default({}),
        createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    },
    (table) => [
        uniqueIndex("telegram_bot_notices_key_idx").on(table.noticeKey),
        index("telegram_bot_notices_chat_stage_idx").on(table.chatId, table.stage, table.createdAt),
    ],
);

// Codinome de autoatendimento: o médico consulta o próprio pagamento no privado do
// bot enviando /pagamento <codinome>. Guardamos só o HMAC do codinome (nunca em claro).
// 1 codinome ativo por médico; regenerar (reset) sobrescreve o hash anterior.
export const doctorPaymentAccess = operationsV2.table(
    "doctor_payment_access",
    {
        id: uuid("id").primaryKey().defaultRandom(),
        doctorId: uuid("doctor_id").notNull().references(() => doctors.id, { onDelete: "cascade" }),
        codenameHmac: text("codename_hmac").notNull(),
        // Codinome em claro, para o coordenador consultar/exportar depois. Preenchido
        // nas gerações novas; antigas (só-hash) ficam null até regerar.
        codename: text("codename"),
        createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
        updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    },
    (table) => [
        uniqueIndex("doctor_payment_access_doctor_idx").on(table.doctorId),
        uniqueIndex("doctor_payment_access_codename_idx").on(table.codenameHmac),
    ],
);

// Anti-força-bruta por conta de Telegram: conta tentativas de codinome erradas numa
// janela e trava temporariamente após o limite.
export const telegramPaymentAccessAttempts = operationsV2.table(
    "telegram_payment_access_attempts",
    {
        telegramUserId: varchar("telegram_user_id", { length: 32 }).primaryKey(),
        failedCount: integer("failed_count").notNull().default(0),
        windowStartedAt: timestamp("window_started_at", { withTimezone: true }),
        lockedUntil: timestamp("locked_until", { withTimezone: true }),
        updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    },
);

export const auditLogs = operationsV2.table(
    "audit_logs",
    {
        id: uuid("id").primaryKey().defaultRandom(),
        actorUserId: uuid("actor_user_id").references(() => users.id),
        action: varchar("action", { length: 100 }).notNull(),
        entityType: varchar("entity_type", { length: 100 }).notNull(),
        entityId: varchar("entity_id", { length: 255 }).notNull(),
        details: jsonb("details").notNull().default({}),
        createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    },
    (table) => [index("audit_logs_action_idx").on(table.action, table.createdAt)],
);

// Preferências de base ordenadas do médico (só intervenção tem bases).
export const doctorBasePreferences = operationsV2.table(
    "doctor_base_preferences",
    {
        id: uuid("id").primaryKey().defaultRandom(),
        doctorId: uuid("doctor_id").notNull().references(() => doctors.id, { onDelete: "cascade" }),
        baseId: integer("base_id").notNull().references(() => interventionBases.id),
        preferenceOrder: integer("preference_order").notNull(),
        createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
        updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    },
    (table) => [
        uniqueIndex("doctor_base_preferences_doctor_base_idx").on(table.doctorId, table.baseId),
        uniqueIndex("doctor_base_preferences_doctor_order_idx").on(table.doctorId, table.preferenceOrder),
    ],
);

// Dias preferidos do médico, RANQUEADOS (preference_order menor = mais
// preferido). weekday: 0 = domingo ... 6 = sábado.
export const doctorWeekdayPreferences = operationsV2.table(
    "doctor_weekday_preferences",
    {
        id: uuid("id").primaryKey().defaultRandom(),
        doctorId: uuid("doctor_id").notNull().references(() => doctors.id, { onDelete: "cascade" }),
        weekday: smallint("weekday").notNull(),
        preferenceOrder: integer("preference_order").notNull().default(0),
        createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    },
    (table) => [
        uniqueIndex("doctor_weekday_preferences_doctor_weekday_idx").on(table.doctorId, table.weekday),
    ],
);

// Turnos fixos do médico (dia da semana + SD/SN); pode ter vários. É o que
// faz o médico aparecer primeiro na montagem da escala daquele dia.
export const doctorFixedShifts = operationsV2.table(
    "doctor_fixed_shifts",
    {
        id: uuid("id").primaryKey().defaultRandom(),
        doctorId: uuid("doctor_id").notNull().references(() => doctors.id, { onDelete: "cascade" }),
        weekday: smallint("weekday").notNull(),
        shiftLabel: varchar("shift_label", { length: 8 }).notNull(),
        createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    },
    (table) => [
        uniqueIndex("doctor_fixed_shifts_doctor_slot_idx").on(table.doctorId, table.weekday, table.shiftLabel),
        index("doctor_fixed_shifts_weekday_idx").on(table.weekday, table.shiftLabel),
    ],
);

// Escala prevista: quem o chefe planejou para cada alvo/data/turno. Camada
// paralela às occupancies (que continuam sendo o realizado + pagamento).
export const scheduledShifts = operationsV2.table(
    "scheduled_shifts",
    {
        id: uuid("id").primaryKey().defaultRandom(),
        domain: varchar("domain", { length: 32 }).notNull(),
        postId: integer("post_id").references(() => regulationPosts.id),
        baseId: integer("base_id").references(() => interventionBases.id),
        doctorId: uuid("doctor_id").notNull().references(() => doctors.id),
        operationalDate: date("operational_date").notNull(),
        shiftLabel: varchar("shift_label", { length: 8 }).notNull(),
        scheduledStartAt: timestamp("scheduled_start_at", { withTimezone: true }).notNull(),
        scheduledEndAt: timestamp("scheduled_end_at", { withTimezone: true }).notNull(),
        roleLabel: varchar("role_label", { length: 100 }),
        status: scheduledShiftStatusEnum("status").notNull().default("planned"),
        createdByUserId: uuid("created_by_user_id").references(() => users.id),
        updatedByUserId: uuid("updated_by_user_id").references(() => users.id),
        createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
        updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    },
    (table) => [
        uniqueIndex("scheduled_shifts_intervention_slot_idx")
            .on(table.baseId, table.operationalDate, table.shiftLabel)
            .where(sql`${table.status} = 'planned' and ${table.baseId} is not null`),
        uniqueIndex("scheduled_shifts_doctor_slot_idx")
            .on(table.doctorId, table.operationalDate, table.shiftLabel)
            .where(sql`${table.status} = 'planned'`),
        index("scheduled_shifts_doctor_idx").on(table.doctorId, table.operationalDate),
        index("scheduled_shifts_date_idx").on(table.operationalDate, table.shiftLabel),
    ],
);

// Trocas de plantão, append-only (triggers no banco proíbem DELETE e UPDATE
// fora da transição de status). Atribuição "fulano está POR sicrano" segue a
// cadeia de transfer/mutual; function_change/base_change movem só o local/
// função efetivos da linhagem, nunca a atribuição.
export const shiftSwaps = operationsV2.table(
    "shift_swaps",
    {
        id: uuid("id").primaryKey().defaultRandom(),
        shiftId: uuid("shift_id").notNull().references(() => scheduledShifts.id),
        swapType: shiftSwapTypeEnum("swap_type").notNull(),
        fromDoctorId: uuid("from_doctor_id").notNull().references(() => doctors.id),
        toDoctorId: uuid("to_doctor_id").notNull().references(() => doctors.id),
        counterpartShiftId: uuid("counterpart_shift_id").references(() => scheduledShifts.id),
        toPostId: integer("to_post_id").references(() => regulationPosts.id),
        toBaseId: integer("to_base_id").references(() => interventionBases.id),
        toRoleLabel: varchar("to_role_label", { length: 100 }),
        status: shiftSwapStatusEnum("status").notNull().default("offered"),
        offeredAt: timestamp("offered_at", { withTimezone: true }).notNull().defaultNow(),
        acceptedAt: timestamp("accepted_at", { withTimezone: true }),
        approvedAt: timestamp("approved_at", { withTimezone: true }),
        rejectedAt: timestamp("rejected_at", { withTimezone: true }),
        cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
        approvedByUserId: uuid("approved_by_user_id").references(() => users.id),
        createdByUserId: uuid("created_by_user_id").references(() => users.id),
        notes: text("notes"),
        createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
        updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    },
    (table) => [
        index("shift_swaps_shift_idx").on(table.shiftId, table.status),
        index("shift_swaps_from_doctor_idx").on(table.fromDoctorId, table.status),
        index("shift_swaps_to_doctor_idx").on(table.toDoctorId, table.status),
    ],
);

// Mural de trocas: oferta pública de um plantão, com bônus em R$ (um $ a cada
// R$100 na UI). Negociação — o acordo vira uma linha em shiftSwaps.
export const shiftOffers = operationsV2.table(
    "shift_offers",
    {
        id: uuid("id").primaryKey().defaultRandom(),
        shiftId: uuid("shift_id").notNull().references(() => scheduledShifts.id),
        offeredByDoctorId: uuid("offered_by_doctor_id").notNull().references(() => doctors.id),
        bonusBrl: integer("bonus_brl").notNull().default(0),
        note: text("note"),
        status: varchar("status", { length: 16 }).notNull().default("open"),
        settledSwapId: uuid("settled_swap_id").references(() => shiftSwaps.id),
        createdByUserId: uuid("created_by_user_id").references(() => users.id),
        createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
        updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    },
    (table) => [
        uniqueIndex("shift_offers_open_shift_idx").on(table.shiftId).where(sql`${table.status} = 'open'`),
        index("shift_offers_status_idx").on(table.status, table.createdAt),
    ],
);

// Lances numa oferta: "pegar" ou contra-oferta com outro plantão. Vários
// médicos podem ter lance pendente na mesma oferta simultaneamente.
export const shiftOfferBids = operationsV2.table(
    "shift_offer_bids",
    {
        id: uuid("id").primaryKey().defaultRandom(),
        offerId: uuid("offer_id").notNull().references(() => shiftOffers.id, { onDelete: "cascade" }),
        doctorId: uuid("doctor_id").notNull().references(() => doctors.id),
        kind: varchar("kind", { length: 16 }).notNull().default("take"),
        counterShiftId: uuid("counter_shift_id").references(() => scheduledShifts.id),
        note: text("note"),
        status: varchar("status", { length: 16 }).notNull().default("pending"),
        createdByUserId: uuid("created_by_user_id").references(() => users.id),
        createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
        updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    },
    (table) => [
        uniqueIndex("shift_offer_bids_offer_doctor_idx").on(table.offerId, table.doctorId).where(sql`${table.status} = 'pending'`),
        index("shift_offer_bids_offer_idx").on(table.offerId, table.status),
    ],
);

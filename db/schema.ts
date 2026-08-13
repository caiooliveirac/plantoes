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
        // Base que só opera 07:00-19:00: nunca gera SN nem plantão continuo (P) — ver
        // resolveDayOnlyBaseAutoCloseEndedAt em modules/intervention/service.ts.
        dayOnly: boolean("day_only").notNull().default(false),
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
        // Desfecho de retirada/saída antecipada decidida pela chefia, medido a
        // partir da JANELA do turno: 'bank_only' (não assina, horas viram banco),
        // 'half_shift' (assina meio, excedente de 6h vira banco), 'full_shift'
        // (assina inteiro — só auditoria). NULL = sem decisão. Independente do
        // role_label MEIO_PLANTAO. Régua: modules/operational/early-departure.ts.
        earlyDepartureOutcome: varchar("early_departure_outcome", { length: 10 }),
    },
    (table) => [
        index("regulation_occupancies_doctor_idx").on(table.doctorId),
        index("regulation_occupancies_continuity_idx").on(table.doctorId, table.continuityGroupId, table.startedAt),
        index("regulation_occupancies_post_idx").on(table.postId),
        index("regulation_occupancies_board_idx").on(table.postId, table.boardStartedAt),
        index("regulation_occupancies_active_idx").on(table.endedAt),
        index("regulation_occupancies_started_idx").on(table.startedAt),
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
        // APOSENTADAS (jul/2026). Marcavam a regra "chegou depois das 9h em
        // intervenção SD -> vira meio plantão 13-19, o antes vira crédito no
        // banco". A regra saiu: atraso em plantão inteiro é atraso e debita
        // sobre a janela do turno. Colunas mantidas só como histórico das
        // ocupações já marcadas — nada lê mais para cálculo. Não usar em código novo.
        lateArrivalAcknowledgedAt: timestamp("late_arrival_acknowledged_at", { withTimezone: true }),
        lateArrivalAcknowledgedByUserId: uuid("late_arrival_acknowledged_by_user_id").references(() => users.id),
        lateArrivalAcknowledgedNote: text("late_arrival_acknowledged_note"),
        departureConfirmedAt: timestamp("departure_confirmed_at", { withTimezone: true }),
        departureConfirmedByUserId: uuid("departure_confirmed_by_user_id").references(() => users.id),
        departureConfirmedNote: text("departure_confirmed_note"),
        // Mesmo contrato da coluna homônima em regulation_occupancies — ver lá.
        earlyDepartureOutcome: varchar("early_departure_outcome", { length: 10 }),
    },
    (table) => [
        index("intervention_occupancies_doctor_idx").on(table.doctorId),
        index("intervention_occupancies_continuity_idx").on(table.doctorId, table.continuityGroupId, table.startedAt),
        index("intervention_occupancies_base_idx").on(table.baseId),
        index("intervention_occupancies_board_idx").on(table.baseId, table.boardStartedAt),
        index("intervention_occupancies_active_idx").on(table.endedAt),
        index("intervention_occupancies_started_idx").on(table.startedAt),
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
        // Saldo que valia no início do seed_month. Nulo = parte do teto (médico
        // que começou o ciclo sem consumo anterior).
        openingBalanceBrl: numeric("opening_balance_brl", { precision: 12, scale: 2 }),
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
// Índice único parcial em doctor_id (where not null) vive só na migration 0034.
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

// Autocadastro do médico por codinome: código de 6 dígitos enviado por email para
// provar a posse do endereço ANTES de criar a conta (evita email digitado errado,
// que inviabilizaria a recuperação de senha). Só o HMAC do código é guardado.
export const doctorSignupEmailVerifications = operationsV2.table(
    "doctor_signup_email_verifications",
    {
        id: uuid("id").primaryKey().defaultRandom(),
        doctorId: uuid("doctor_id").notNull().references(() => doctors.id, { onDelete: "cascade" }),
        email: text("email").notNull(),
        codeHmac: text("code_hmac").notNull(),
        expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
        attemptCount: integer("attempt_count").notNull().default(0),
        consumedAt: timestamp("consumed_at", { withTimezone: true }),
        createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    },
    (table) => [
        index("doctor_signup_email_verif_doctor_idx").on(table.doctorId, table.createdAt),
        index("doctor_signup_email_verif_email_idx").on(table.email, table.createdAt),
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
    (table) => [
        index("audit_logs_action_idx").on(table.action, table.createdAt),
        index("audit_logs_entity_idx").on(table.entityType, table.entityId),
    ],
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

// ---------------------------------------------------------------------------
// Saldo contratual (docs/saldo-contrato/SPEC.md §4, migration 0038)
//
// Duas tabelas. A renovação do contrato é ato MANUAL do chefe: ele cria o
// contrato novo já com o saldo de abertura que decidiu. Não há rollover
// automático, ciclo não é entidade própria, e o estouro do contrato anterior
// não vira registro — na renovação o chefe já resolve ao digitar o saldo.
//
// O saldo nunca é campo mutável: é a soma do razão append-only contractLedger.
// Leitura pela view contract_balance. Convive com doctorContracts (semente da
// 0026) até esta feature virar a chave.
// ---------------------------------------------------------------------------

export const contractCategoryEnum = operationsV2.enum("contract_category", ["generalista", "especialista", "psiquiatria"]);
export const contractStatusEnum = operationsV2.enum("contract_status", ["active", "suspended", "terminated"]);
export const contractLedgerEntryTypeEnum = operationsV2.enum("contract_ledger_entry_type", [
    "opening",
    "invoice",
    "invoice_reversal",
    "manual_adjustment",
]);

// Um médico pode ter mais de um contrato ativo: a atribuição fechamento ->
// contrato é por data, pela janela [startedAt, endedAt). Renovar = criar outro
// registro, apontando supersededByContractId do antigo para o novo.
//
// O saldo NÃO mora aqui: é a soma do razão (contractLedger), pela view
// operations_v2.contract_balance. `ceilingAmount` é nullable de propósito — nem
// todo contrato tem teto conhecido, e chutar um é pior que deixar vazio.
// Antes de mexer em contrato/razão/saldo, leia docs/saldo-contrato/README.md:
// os dados de origem vieram de planilha e têm armadilhas documentadas.
export const contracts = operationsV2.table(
    "contracts",
    {
        id: uuid("id").primaryKey().defaultRandom(),
        doctorId: uuid("doctor_id").notNull().references(() => doctors.id),
        contractNumber: varchar("contract_number", { length: 40 }).notNull(),
        companyName: varchar("company_name", { length: 255 }),
        companyTaxId: varchar("company_tax_id", { length: 20 }),
        category: contractCategoryEnum("category").notNull(),
        // Dado cadastral: nenhum cálculo do saldo depende da CH (SPEC §3.3).
        weeklyHours: numeric("weekly_hours", { precision: 5, scale: 1 }),
        // Nullable: no backfill de maio nem todo médico tem teto conhecido, e o
        // coordenador preenche depois. Sem teto o saldo funciona; o que não dá
        // para calcular é o percentual consumido.
        ceilingAmount: numeric("ceiling_amount", { precision: 14, scale: 2 }),
        // Janela do ciclo vigente, definida pelo chefe — é o que permite projetar
        // "acaba em dd/mm e o ciclo só termina em dd/mm".
        cycleStart: date("cycle_start").notNull(),
        cycleEnd: date("cycle_end").notNull(),
        startedAt: date("started_at").notNull(),
        endedAt: date("ended_at"),
        status: contractStatusEnum("status").notNull().default("active"),
        supersededByContractId: uuid("superseded_by_contract_id"),
        notes: text("notes"),
        createdByUserId: uuid("created_by_user_id").references(() => users.id),
        createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
        updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    },
    (table) => [
        index("contracts_doctor_idx").on(table.doctorId),
        index("contracts_status_doctor_idx").on(table.status, table.doctorId),
        index("contracts_doctor_window_idx").on(table.doctorId, table.startedAt, table.endedAt),
        uniqueIndex("contracts_doctor_number_active_idx")
            .on(table.doctorId, table.contractNumber)
            .where(sql`status = 'active'`),
    ],
);

// Append-only: nada aqui é UPDATE nem DELETE. Errou, lança o estorno.
// Sinal do amount: positivo credita saldo, negativo consome.
export const contractLedger = operationsV2.table(
    "contract_ledger",
    {
        id: uuid("id").primaryKey().defaultRandom(),
        contractId: uuid("contract_id").notNull().references(() => contracts.id),
        entryDate: date("entry_date").notNull(),
        type: contractLedgerEntryTypeEnum("type").notNull(),
        amount: numeric("amount", { precision: 14, scale: 2 }).notNull(),
        // Um invoice_reversal precisa trazer estes valores NEGATIVOS: a view soma
        // as colunas cruas, e estorno sem isso conta os plantões duas vezes.
        weekdayShifts: numeric("weekday_shifts", { precision: 6, scale: 1 }).notNull().default("0"),
        weekendShifts: numeric("weekend_shifts", { precision: 6, scale: 1 }).notNull().default("0"),
        // Não existe tabela payment_closings: o fechamento é (médico, mês) em
        // paymentClosingAttestations, cuja linha é DELETADA ao desassinar. Por
        // isso a origem é chave lógica estável, não FK.
        sourceType: varchar("source_type", { length: 40 }),
        sourceKey: varchar("source_key", { length: 80 }),
        // atestar=0, desatestar=1, reatestar=2... o unique impede dois 'invoice'
        // vivos para o mesmo fechamento sem quebrar o append-only.
        sourceRevision: integer("source_revision").notNull().default(0),
        invoiceNumber: varchar("invoice_number", { length: 60 }),
        processNumber: varchar("process_number", { length: 60 }),
        description: text("description"),
        createdByUserId: uuid("created_by_user_id").references(() => users.id),
        createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    },
    (table) => [
        index("contract_ledger_contract_idx").on(table.contractId, table.entryDate),
        uniqueIndex("contract_ledger_source_revision_idx")
            .on(table.sourceType, table.sourceKey, table.sourceRevision)
            .where(sql`source_key is not null`),
    ],
);

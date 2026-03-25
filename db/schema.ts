import {
    bigint,
    boolean,
    index,
    integer,
    jsonb,
    pgSchema,
    primaryKey,
    serial,
    text,
    timestamp,
    uniqueIndex,
    uuid,
    varchar,
} from "drizzle-orm/pg-core";

const operationsV2 = pgSchema("operations_v2");

export const userRoleEnum = operationsV2.enum("user_role", ["admin", "chief"]);
export const inviteModeEnum = operationsV2.enum("invite_mode", ["email", "bearer"]);
export const chiefRequestStatusEnum = operationsV2.enum("chief_request_status", ["pending", "approved", "rejected"]);
export const occupancySourceEnum = operationsV2.enum("occupancy_source", ["manual", "telegram", "import", "admin_correction"]);
export const shiftEventDomainEnum = operationsV2.enum("shift_event_domain", ["regulation", "intervention", "chief", "doctors", "bank_hours", "auth"]);
export const bankHoursSourceEnum = operationsV2.enum("bank_hours_source", ["regulation", "intervention", "manual_adjustment"]);

export const doctors = operationsV2.table(
    "doctors",
    {
        id: uuid("id").primaryKey().defaultRandom(),
        externalCode: varchar("external_code", { length: 64 }),
        fullName: varchar("full_name", { length: 255 }).notNull(),
        displayName: varchar("display_name", { length: 255 }),
        normalizedName: varchar("normalized_name", { length: 255 }).notNull(),
        isActive: boolean("is_active").notNull().default(true),
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

export const regulationOccupancies = operationsV2.table(
    "regulation_occupancies",
    {
        id: uuid("id").primaryKey().defaultRandom(),
        doctorId: uuid("doctor_id").notNull().references(() => doctors.id),
        postId: integer("post_id").notNull().references(() => regulationPosts.id),
        scheduledStartAt: timestamp("scheduled_start_at", { withTimezone: true }),
        scheduledEndAt: timestamp("scheduled_end_at", { withTimezone: true }),
        startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
        boardStartedAt: timestamp("board_started_at", { withTimezone: true }).notNull(),
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
    },
    (table) => [
        index("regulation_occupancies_doctor_idx").on(table.doctorId),
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
    },
    (table) => [
        index("intervention_occupancies_doctor_idx").on(table.doctorId),
        index("intervention_occupancies_base_idx").on(table.baseId),
        index("intervention_occupancies_board_idx").on(table.baseId, table.boardStartedAt),
        index("intervention_occupancies_active_idx").on(table.endedAt),
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

create extension if not exists pgcrypto;

create type user_role as enum ('admin', 'chief');
create type invite_mode as enum ('email', 'bearer');
create type chief_request_status as enum ('pending', 'approved', 'rejected');
create type occupancy_source as enum ('manual', 'telegram', 'import', 'admin_correction');
create type shift_event_domain as enum ('regulation', 'intervention', 'chief', 'doctors', 'bank_hours', 'auth');
create type bank_hours_source as enum ('regulation', 'intervention', 'manual_adjustment');

create table doctors (
  id uuid primary key default gen_random_uuid(),
  external_code varchar(64),
  full_name varchar(255) not null,
  display_name varchar(255),
  normalized_name varchar(255) not null,
  is_active boolean not null default true,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index doctors_normalized_name_idx on doctors(normalized_name);
create index doctors_active_idx on doctors(is_active);

create table users (
  id uuid primary key default gen_random_uuid(),
  doctor_id uuid references doctors(id),
  email varchar(255) not null,
  password_hash text not null,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index users_email_idx on users(email);
create index users_doctor_idx on users(doctor_id);

create table user_roles (
  user_id uuid not null references users(id) on delete cascade,
  role user_role not null,
  created_at timestamptz not null default now(),
  primary key (user_id, role)
);

create table password_reset_tokens (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  token varchar(128) not null,
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);
create unique index password_reset_tokens_token_idx on password_reset_tokens(token);
create index password_reset_tokens_user_idx on password_reset_tokens(user_id);

create table chief_invites (
  id uuid primary key default gen_random_uuid(),
  token varchar(128) not null,
  email varchar(255),
  invite_mode invite_mode not null,
  invited_by_user_id uuid references users(id),
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);
create unique index chief_invites_token_idx on chief_invites(token);

create table chief_access_requests (
  id uuid primary key default gen_random_uuid(),
  invite_id uuid not null references chief_invites(id) on delete cascade,
  doctor_id uuid not null references doctors(id),
  requested_email varchar(255) not null,
  phone varchar(30),
  registration_number varchar(100),
  selfie_url text not null,
  password_hash text not null,
  status chief_request_status not null default 'pending',
  reviewed_by_user_id uuid references users(id),
  reviewed_at timestamptz,
  review_notes text,
  approved_user_id uuid references users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index chief_access_requests_status_idx on chief_access_requests(status);
create index chief_access_requests_doctor_idx on chief_access_requests(doctor_id);

create table regulation_posts (
  id serial primary key,
  code varchar(32) not null,
  label varchar(255) not null,
  default_role varchar(100),
  sort_order integer not null default 0,
  is_active boolean not null default true
);
create unique index regulation_posts_code_idx on regulation_posts(code);

create table intervention_bases (
  id serial primary key,
  code varchar(32) not null,
  label varchar(255) not null,
  sort_order integer not null default 0,
  is_active boolean not null default true
);
create unique index intervention_bases_code_idx on intervention_bases(code);

create table regulation_occupancies (
  id uuid primary key default gen_random_uuid(),
  doctor_id uuid not null references doctors(id),
  post_id integer not null references regulation_posts(id),
  scheduled_start_at timestamptz,
  scheduled_end_at timestamptz,
  started_at timestamptz not null,
  ended_at timestamptz,
  shift_label varchar(100),
  role_label varchar(100),
  ramal_label varchar(50),
  source occupancy_source not null,
  notes text,
  created_by_user_id uuid references users(id),
  updated_by_user_id uuid references users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index regulation_occupancies_doctor_idx on regulation_occupancies(doctor_id);
create index regulation_occupancies_post_idx on regulation_occupancies(post_id);
create index regulation_occupancies_active_idx on regulation_occupancies(ended_at);
create unique index regulation_occupancies_one_active_per_post_idx on regulation_occupancies(post_id) where ended_at is null;

create table intervention_occupancies (
  id uuid primary key default gen_random_uuid(),
  doctor_id uuid not null references doctors(id),
  base_id integer not null references intervention_bases(id),
  scheduled_start_at timestamptz,
  scheduled_end_at timestamptz,
  started_at timestamptz not null,
  ended_at timestamptz,
  shift_label varchar(100),
  role_label varchar(100),
  source occupancy_source not null,
  notes text,
  created_by_user_id uuid references users(id),
  updated_by_user_id uuid references users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index intervention_occupancies_doctor_idx on intervention_occupancies(doctor_id);
create index intervention_occupancies_base_idx on intervention_occupancies(base_id);
create index intervention_occupancies_active_idx on intervention_occupancies(ended_at);
create unique index intervention_occupancies_one_active_per_base_idx on intervention_occupancies(base_id) where ended_at is null;

create table shift_events (
  id uuid primary key default gen_random_uuid(),
  domain shift_event_domain not null,
  entity_id uuid,
  entity_type varchar(100) not null,
  event_type varchar(100) not null,
  actor_user_id uuid references users(id),
  actor_label varchar(255),
  payload jsonb not null default '{}'::jsonb,
  occurred_at timestamptz not null default now()
);
create index shift_events_domain_idx on shift_events(domain, occurred_at);

create table bank_hours_entries (
  id uuid primary key default gen_random_uuid(),
  doctor_id uuid not null references doctors(id),
  source_type bank_hours_source not null,
  regulation_occupancy_id uuid references regulation_occupancies(id),
  intervention_occupancy_id uuid references intervention_occupancies(id),
  scheduled_start_at timestamptz not null,
  scheduled_end_at timestamptz not null,
  actual_start_at timestamptz not null,
  actual_end_at timestamptz not null,
  arrival_delay_minutes integer not null,
  overtime_minutes integer not null,
  overtime_multiplier integer not null,
  credited_overtime_minutes integer not null,
  balance_minutes integer not null,
  rule_code varchar(100) not null,
  calculation_version integer not null default 1,
  explanation text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index bank_hours_entries_doctor_idx on bank_hours_entries(doctor_id, scheduled_start_at);
create index bank_hours_entries_regulation_idx on bank_hours_entries(regulation_occupancy_id);
create index bank_hours_entries_intervention_idx on bank_hours_entries(intervention_occupancy_id);

create table audit_logs (
  id uuid primary key default gen_random_uuid(),
  actor_user_id uuid references users(id),
  action varchar(100) not null,
  entity_type varchar(100) not null,
  entity_id varchar(255) not null,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index audit_logs_action_idx on audit_logs(action, created_at);

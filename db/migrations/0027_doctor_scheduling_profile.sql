-- Perfil de escala do médico: role de login 'doctor', elegibilidade por
-- domínio, antiguidade e preferências (base + dia fixo da semana).
-- Aditiva: só ADD COLUMN com default e tabelas novas. Nenhuma CTE existente
-- em services/ referencia essas colunas/tabelas; o pagamento continua
-- alimentado por occupancies (check-ins do robô) + admin_extra_shifts.
--
-- ROLLBACK:
--   drop table if exists operations_v2.doctor_weekday_preferences;
--   drop table if exists operations_v2.doctor_base_preferences;
--   alter table operations_v2.doctors drop column if exists admitted_at;
--   alter table operations_v2.doctors drop column if exists eligible_intervention;
--   alter table operations_v2.doctors drop column if exists eligible_regulation;
--   -- O valor 'doctor' no enum user_role NÃO é removível sem recriar o tipo;
--   -- é inofensivo permanecer (basta não atribuir o role a ninguém).

-- Role de login para o médico operar a interface web de trocas/escala.
alter type operations_v2.user_role add value if not exists 'doctor';

-- Elegibilidade por domínio. Default true => todo médico existente nasce
-- apto aos dois domínios (retrocompatibilidade da série).
alter table operations_v2.doctors
    add column if not exists eligible_regulation boolean not null default true;

alter table operations_v2.doctors
    add column if not exists eligible_intervention boolean not null default true;

-- Antiguidade (data de admissão). Nullable: preenchida aos poucos pelo admin.
alter table operations_v2.doctors
    add column if not exists admitted_at date;

-- Preferências de base ordenadas (só intervenção tem bases; preferência de
-- ramal de regulação, se um dia existir, será outra tabela).
create table if not exists operations_v2.doctor_base_preferences (
    id uuid primary key default gen_random_uuid(),
    doctor_id uuid not null references operations_v2.doctors (id) on delete cascade,
    base_id integer not null references operations_v2.intervention_bases (id),
    preference_order integer not null,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create unique index if not exists doctor_base_preferences_doctor_base_idx
    on operations_v2.doctor_base_preferences (doctor_id, base_id);

create unique index if not exists doctor_base_preferences_doctor_order_idx
    on operations_v2.doctor_base_preferences (doctor_id, preference_order);

-- Dia fixo da semana: alimenta a view de escala (médicos "do dia" aparecem
-- primeiro; os demais só ao expandir). weekday: 0 = domingo ... 6 = sábado.
create table if not exists operations_v2.doctor_weekday_preferences (
    id uuid primary key default gen_random_uuid(),
    doctor_id uuid not null references operations_v2.doctors (id) on delete cascade,
    weekday smallint not null check (weekday between 0 and 6),
    created_at timestamptz not null default now()
);

create unique index if not exists doctor_weekday_preferences_doctor_weekday_idx
    on operations_v2.doctor_weekday_preferences (doctor_id, weekday);

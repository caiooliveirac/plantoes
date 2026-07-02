-- Escala prevista (plantões planejados pelo chefe na interface web).
-- Camada NOVA, paralela às occupancies: as occupancies continuam sendo a
-- fonte de verdade do que ACONTECEU (check-in real via bot) e do pagamento;
-- scheduled_shifts é o que está PLANEJADO e norteia quem eram os donos
-- originais de cada plantão. Nenhum código existente lê esta tabela.
--
-- ROLLBACK:
--   drop table if exists operations_v2.scheduled_shifts;
--   drop type if exists operations_v2.scheduled_shift_status;

create type operations_v2.scheduled_shift_status as enum ('planned', 'cancelled');

create table if not exists operations_v2.scheduled_shifts (
    id uuid primary key default gen_random_uuid(),
    domain varchar(32) not null,
    post_id integer references operations_v2.regulation_posts (id),
    base_id integer references operations_v2.intervention_bases (id),
    doctor_id uuid not null references operations_v2.doctors (id),
    operational_date date not null,
    shift_label varchar(8) not null,
    scheduled_start_at timestamptz not null,
    scheduled_end_at timestamptz not null,
    role_label varchar(100),
    status operations_v2.scheduled_shift_status not null default 'planned',
    created_by_user_id uuid references operations_v2.users (id),
    updated_by_user_id uuid references operations_v2.users (id),
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    -- Exatamente um alvo, coerente com o domínio (espelha a separação
    -- regulation/intervention das occupancies).
    constraint scheduled_shifts_domain_target_check check (
        (domain = 'regulation' and post_id is not null and base_id is null)
        or (domain = 'intervention' and base_id is not null and post_id is null)
    )
);

-- Um planejamento ativo por alvo/data/turno (cancelados ficam fora).
create unique index if not exists scheduled_shifts_regulation_slot_idx
    on operations_v2.scheduled_shifts (post_id, operational_date, shift_label)
    where status = 'planned' and post_id is not null;

create unique index if not exists scheduled_shifts_intervention_slot_idx
    on operations_v2.scheduled_shifts (base_id, operational_date, shift_label)
    where status = 'planned' and base_id is not null;

create index if not exists scheduled_shifts_doctor_idx
    on operations_v2.scheduled_shifts (doctor_id, operational_date);

create index if not exists scheduled_shifts_date_idx
    on operations_v2.scheduled_shifts (operational_date, shift_label);

-- Trocas de plantão, append-only. Nunca DELETE; UPDATE só para transição de
-- status (+ timestamps da transição, approved_by e updated_at). Garantido por
-- triggers — primeira vez que o projeto usa trigger, justificada pelo
-- requisito de imutabilidade no nível do banco.
--
-- Semântica de atribuição ("fulano está POR sicrano"), por linhagem de
-- scheduled_shift:
--   transfer        -> move o médico efetivo da linhagem (Victor por Ana)
--   mutual          -> transfer nos dois sentidos entre duas linhagens
--                      (counterpart_shift_id obrigatório)
--   function_change -> muda role_label efetivo, NÃO muda a atribuição
--   base_change     -> muda base/posto efetivo, NÃO muda a atribuição
--                      (Victor continua por Ana, mesmo assumindo na 2034)
-- to_base_id/to_post_id/to_role_label registram o destino de function/base
-- change; quando a mudança é uma troca a dois, counterpart_shift_id liga as
-- duas linhagens e o resolvedor troca os locais entre elas.
--
-- ROLLBACK:
--   drop trigger if exists shift_swaps_no_delete on operations_v2.shift_swaps;
--   drop trigger if exists shift_swaps_status_only on operations_v2.shift_swaps;
--   drop function if exists operations_v2.shift_swaps_forbid_delete();
--   drop function if exists operations_v2.shift_swaps_guard_update();
--   drop table if exists operations_v2.shift_swaps;
--   drop type if exists operations_v2.shift_swap_status;
--   drop type if exists operations_v2.shift_swap_type;

create type operations_v2.shift_swap_type as enum
    ('transfer', 'mutual', 'function_change', 'base_change');

create type operations_v2.shift_swap_status as enum
    ('offered', 'accepted', 'approved', 'rejected', 'cancelled');

create table if not exists operations_v2.shift_swaps (
    id uuid primary key default gen_random_uuid(),
    shift_id uuid not null references operations_v2.scheduled_shifts (id),
    swap_type operations_v2.shift_swap_type not null,
    from_doctor_id uuid not null references operations_v2.doctors (id),
    to_doctor_id uuid not null references operations_v2.doctors (id),
    counterpart_shift_id uuid references operations_v2.scheduled_shifts (id),
    to_post_id integer references operations_v2.regulation_posts (id),
    to_base_id integer references operations_v2.intervention_bases (id),
    to_role_label varchar(100),
    status operations_v2.shift_swap_status not null default 'offered',
    offered_at timestamptz not null default now(),
    accepted_at timestamptz,
    approved_at timestamptz,
    rejected_at timestamptz,
    cancelled_at timestamptz,
    approved_by_user_id uuid references operations_v2.users (id),
    created_by_user_id uuid references operations_v2.users (id),
    notes text,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    constraint shift_swaps_mutual_counterpart_check check (
        swap_type <> 'mutual' or counterpart_shift_id is not null
    )
);

create index if not exists shift_swaps_shift_idx
    on operations_v2.shift_swaps (shift_id, status);

create index if not exists shift_swaps_from_doctor_idx
    on operations_v2.shift_swaps (from_doctor_id, status);

create index if not exists shift_swaps_to_doctor_idx
    on operations_v2.shift_swaps (to_doctor_id, status);

-- Append-only: DELETE proibido incondicionalmente.
create or replace function operations_v2.shift_swaps_forbid_delete()
returns trigger language plpgsql as $$
begin
    raise exception 'shift_swaps é append-only: DELETE proibido (id %)', old.id;
end $$;

create trigger shift_swaps_no_delete
    before delete on operations_v2.shift_swaps
    for each row execute function operations_v2.shift_swaps_forbid_delete();

-- UPDATE permitido só para transição de status: colunas de identidade da
-- troca são imutáveis.
create or replace function operations_v2.shift_swaps_guard_update()
returns trigger language plpgsql as $$
begin
    if new.id is distinct from old.id
        or new.shift_id is distinct from old.shift_id
        or new.swap_type is distinct from old.swap_type
        or new.from_doctor_id is distinct from old.from_doctor_id
        or new.to_doctor_id is distinct from old.to_doctor_id
        or new.counterpart_shift_id is distinct from old.counterpart_shift_id
        or new.to_post_id is distinct from old.to_post_id
        or new.to_base_id is distinct from old.to_base_id
        or new.to_role_label is distinct from old.to_role_label
        or new.offered_at is distinct from old.offered_at
        or new.created_by_user_id is distinct from old.created_by_user_id
        or new.created_at is distinct from old.created_at
    then
        raise exception 'shift_swaps é append-only: só transição de status é permitida (id %)', old.id;
    end if;

    return new;
end $$;

create trigger shift_swaps_status_only
    before update on operations_v2.shift_swaps
    for each row execute function operations_v2.shift_swaps_guard_update();

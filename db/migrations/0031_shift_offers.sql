-- Mural de trocas: camada de NEGOCIAÇÃO separada do livro-razão shift_swaps.
--   shift_offers      -> oferta pública de um plantão no mural (com bônus em
--                        R$, sinalizado na UI como um $ a cada R$100)
--   shift_offer_bids  -> interesses/lances: "pegar" ou contra-oferta com outro
--                        plantão. Vários médicos podem dar lance na MESMA
--                        oferta ao mesmo tempo — nada bloqueia até o ofertante
--                        escolher um lance (aí nasce o shift_swap acordado,
--                        que segue para aprovação da chefia como sempre).
--
-- ROLLBACK:
--   drop table if exists operations_v2.shift_offer_bids;
--   drop table if exists operations_v2.shift_offers;

create table if not exists operations_v2.shift_offers (
    id uuid primary key default gen_random_uuid(),
    shift_id uuid not null references operations_v2.scheduled_shifts (id),
    offered_by_doctor_id uuid not null references operations_v2.doctors (id),
    bonus_brl integer not null default 0 check (bonus_brl >= 0),
    note text,
    status varchar(16) not null default 'open',   -- open | committed | withdrawn
    settled_swap_id uuid references operations_v2.shift_swaps (id),
    created_by_user_id uuid references operations_v2.users (id),
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

-- Uma oferta ABERTA por plantão (lances múltiplos ficam nos bids; ofertar o
-- mesmo plantão duas vezes em paralelo é que não faz sentido).
create unique index if not exists shift_offers_open_shift_idx
    on operations_v2.shift_offers (shift_id)
    where status = 'open';

create index if not exists shift_offers_status_idx
    on operations_v2.shift_offers (status, created_at);

create table if not exists operations_v2.shift_offer_bids (
    id uuid primary key default gen_random_uuid(),
    offer_id uuid not null references operations_v2.shift_offers (id) on delete cascade,
    doctor_id uuid not null references operations_v2.doctors (id),
    kind varchar(16) not null default 'take',     -- take | counter
    counter_shift_id uuid references operations_v2.scheduled_shifts (id),
    note text,
    status varchar(16) not null default 'pending', -- pending | chosen | declined | withdrawn
    created_by_user_id uuid references operations_v2.users (id),
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    constraint shift_offer_bids_counter_check check (
        kind <> 'counter' or counter_shift_id is not null
    )
);

-- Um lance vivo por médico por oferta (pode retirar e refazer).
create unique index if not exists shift_offer_bids_offer_doctor_idx
    on operations_v2.shift_offer_bids (offer_id, doctor_id)
    where status = 'pending';

create index if not exists shift_offer_bids_offer_idx
    on operations_v2.shift_offer_bids (offer_id, status);

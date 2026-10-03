-- Vínculo conta daqui ↔ usuário de outro sistema (docs/internos-goa.md).
-- Hoje só provedor 'goa' (SkyRescue): sujeito = users.id de lá. Tabela nova,
-- nada lê antes do deploy: aplicar ANTES do merge.
create table if not exists operations_v2.identidades_federadas (
    id uuid primary key default gen_random_uuid(),
    provedor varchar(32) not null,
    sujeito varchar(128) not null,
    user_id uuid not null references operations_v2.users(id) on delete cascade,
    login varchar(64),
    nome varchar(160),
    created_at timestamptz not null default now(),
    ultimo_uso_em timestamptz
);
create unique index if not exists identidades_federadas_provedor_sujeito_idx
    on operations_v2.identidades_federadas (provedor, sujeito);
create index if not exists identidades_federadas_user_idx
    on operations_v2.identidades_federadas (user_id);

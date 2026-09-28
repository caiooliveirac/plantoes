-- Rótulos de rede do monitor de acessos (docs/monitor-acessos.md, "Redes").
-- Uma linha por faixa (/24 IPv4, /64 IPv6), escrita pelo admin em
-- /admin/acessos/redes. `central` entra na rede do plantão do portão de turno
-- (garante que os PCs da Central abram Mesa e Tabela mesmo sem 3 plantonistas
-- medidos); `suspeita` e `conhecida` só nomeiam a rede no painel e nos avisos.
-- Só tabela nova: o código antigo não a lê; aplicar ANTES do deploy.
create table if not exists operations_v2.auth_network_labels (
    faixa text primary key,
    kind text not null check (kind in ('central', 'suspeita', 'conhecida')),
    label text not null,
    note text,
    updated_by uuid references operations_v2.users(id) on delete set null,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

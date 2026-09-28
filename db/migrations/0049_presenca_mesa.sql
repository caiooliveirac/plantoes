-- Presença na Mesa (docs/presenca-mesa.md): uma tela da Mesa por conta e
-- bloqueio por ociosidade. Só tabelas novas: o código antigo não as lê;
-- aplicar ANTES do deploy. Sem elas o app segue igual (a presença falha
-- aberta e registra `[presenca]` no log).

-- Quem está com a Mesa à vista agora: uma linha por conta × recurso. O
-- aparelho (cookie plantoes_aparelho) só perde a vez quando para de renovar e
-- `expires_at` passa. `epoch` sobe a cada troca de aparelho.
create table if not exists operations_v2.view_leases (
    user_id uuid not null references operations_v2.users(id) on delete cascade,
    resource varchar(24) not null,
    device_id uuid not null,
    session_id uuid,
    epoch bigint not null default 1,
    acquired_at timestamptz not null default now(),
    heartbeat_at timestamptz not null default now(),
    expires_at timestamptz not null,
    primary key (user_id, resource)
);

-- Presença por conta × aparelho: último sinal, última interação humana
-- (mexer, rolar, tocar, teclar) e o bloqueio por ociosidade. O bloqueio é do
-- aparelho, não da sessão: entrar de novo pelo portal não o desfaz — só a
-- senha digitada na tela de bloqueio (`unlocked_at`).
create table if not exists operations_v2.view_presence (
    user_id uuid not null references operations_v2.users(id) on delete cascade,
    device_id uuid not null,
    last_heartbeat_at timestamptz,
    last_human_at timestamptz,
    locked_at timestamptz,
    lock_reason varchar(24),
    unlocked_at timestamptz,
    updated_at timestamptz not null default now(),
    primary key (user_id, device_id)
);

-- O monitor passa a saber qual aparelho usou cada sessão e fez cada evento.
alter table operations_v2.auth_sessions add column if not exists device_id uuid;
alter table operations_v2.auth_session_events add column if not exists device_id uuid;

-- Monitor de acessos (docs/monitor-acessos.md). Cada login ganha uma sessão com
-- id próprio (`sid` no cookie) e o que ela faz fica registrado com IP, aparelho
-- e localização aproximada, para provar quando a mesma conta está aberta em
-- lugares diferentes ao mesmo tempo. Só tabelas novas: o código antigo não as
-- lê, então aplicar antes do deploy é inócuo. Retenção de 180 dias, apagada
-- pelo plantoes-telegram-worker (modules/telegram/acessos-alerts.ts).

-- Uma linha por sessão de login (um navegador/aparelho). `session_version` é o
-- `sv` gravado no cookie dela: quando users.session_version sobe (troca de
-- senha, "encerrar sessões"), a sessão morre mesmo sem revoked_at.
create table if not exists operations_v2.auth_sessions (
    id uuid primary key,
    user_id uuid not null references operations_v2.users(id) on delete cascade,
    origin varchar(24) not null,
    session_version integer not null default 0,
    created_at timestamptz not null default now(),
    created_ip text,
    created_user_agent text,
    created_geo jsonb not null default '{}'::jsonb,
    last_seen_at timestamptz,
    last_ip text,
    revoked_at timestamptz,
    revoked_by uuid references operations_v2.users(id) on delete set null,
    revoked_reason text
);
create index if not exists auth_sessions_user_seen_idx
    on operations_v2.auth_sessions (user_id, last_seen_at desc);

-- Linha do tempo das interações: entrada, página aberta, ação (POST/PATCH…),
-- quadro ao vivo, rede nova no meio da sessão, senha digitada no portal, saída
-- e ações do admin. A consulta periódica do quadro NÃO entra aqui (é volume) —
-- vai agregada em auth_session_activity.
create table if not exists operations_v2.auth_session_events (
    id bigint generated always as identity primary key,
    occurred_at timestamptz not null default now(),
    session_id uuid references operations_v2.auth_sessions(id) on delete cascade,
    user_id uuid references operations_v2.users(id) on delete cascade,
    kind varchar(40) not null,
    method varchar(8),
    path text,
    ip text,
    user_agent text,
    geo jsonb not null default '{}'::jsonb,
    details jsonb not null default '{}'::jsonb
);
create index if not exists auth_session_events_user_idx
    on operations_v2.auth_session_events (user_id, occurred_at desc);
create index if not exists auth_session_events_session_idx
    on operations_v2.auth_session_events (session_id, occurred_at);
create index if not exists auth_session_events_occurred_idx
    on operations_v2.auth_session_events (occurred_at);

-- Presença: uma linha por sessão × IP × janela de 5 minutos. É o que prova que
-- dois aparelhos estavam abertos ao mesmo tempo. visible_requests = pedidos com
-- a aba da Mesa visível; active_requests = visível e com toque/mouse/teclado
-- nos 2 minutos anteriores (cabeçalho x-mesa-uso do quadro).
create table if not exists operations_v2.auth_session_activity (
    session_id uuid not null references operations_v2.auth_sessions(id) on delete cascade,
    user_id uuid not null references operations_v2.users(id) on delete cascade,
    ip text not null,
    window_start timestamptz not null,
    first_at timestamptz not null,
    last_at timestamptz not null,
    requests integer not null default 0,
    visible_requests integer not null default 0,
    active_requests integer not null default 0,
    primary key (session_id, ip, window_start)
);
create index if not exists auth_session_activity_user_idx
    on operations_v2.auth_session_activity (user_id, window_start);
create index if not exists auth_session_activity_ip_idx
    on operations_v2.auth_session_activity (ip, window_start);

-- O que se sabe de cada IP: localização (cabeçalhos do Cloudflare, a última
-- vista) e provedor (DNS reverso). Cache: o DNS reverso é refeito após 7 dias.
create table if not exists operations_v2.auth_network_info (
    ip text primary key,
    reverse_dns text,
    provider text,
    geo jsonb not null default '{}'::jsonb,
    geo_seen_at timestamptz,
    reverse_looked_up_at timestamptz
);

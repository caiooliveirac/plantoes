-- Enfermeiro(a) do plantão: quem a chefia registra na Mesa para o turno.
--
-- Uma linha ativa (substituido_em null) por turno (turno_data + SD/SN; o SN
-- depois da meia-noite pertence à data anterior). Registrar outro marca o
-- anterior como substituído — o histórico fica (auditoria). Limpar também só
-- marca substituido_em. O porteiro do quadro.mnrs.com.br libera o e-mail que
-- estiver em `emails` da linha ativa (services/acessos-portao.service.ts).
-- Só cria tabela: aplicar ANTES do deploy (o código novo lê e escreve aqui).

create table if not exists operations_v2.enfermeiros_plantao (
    id uuid primary key default gen_random_uuid(),
    turno_data date not null,
    turno varchar(2) not null,
    profissional_id text null,
    nome text not null,
    emails text[] not null default '{}'::text[],
    telefone text null,
    registrado_por uuid null references operations_v2.users (id),
    registrado_em timestamptz not null default now(),
    substituido_em timestamptz null,
    constraint enfermeiros_plantao_turno_check check (turno in ('SD', 'SN'))
);

create unique index if not exists enfermeiros_plantao_ativo_idx
    on operations_v2.enfermeiros_plantao (turno_data, turno)
    where substituido_em is null;

create index if not exists enfermeiros_plantao_turno_idx
    on operations_v2.enfermeiros_plantao (turno_data, turno, registrado_em);

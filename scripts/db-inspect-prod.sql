-- Inspeção READ-ONLY do Postgres de produção do plantoes.
--
-- Uso (do Mac, pelo túnel — docs/agent-operations.md §3):
--   psql "$PLANTOES_RO_URL" -f scripts/db-inspect-prod.sql > /tmp/db-inspect-$(date +%F).txt
--
-- Só SELECT em catálogos e views de estatística. Não cria, não altera, não
-- apaga, não roda EXPLAIN ANALYZE em nada que escreva. Os dois EXPLAIN (ANALYZE,
-- BUFFERS) de leitura ficam COMENTADOS no fim: você decide quando executar.
--
-- Algumas colunas (query text em pg_stat_activity / pg_stat_statements de
-- outros roles) só aparecem para membros de pg_read_all_stats; sem isso vêm
-- como <insufficient privilege>. É esperado, não é erro.
--
-- Contexto e leitura dos resultados: docs/db/auditoria-performance-2026-09.md

\set ON_ERROR_STOP off
\pset pager off
\timing off

\echo
\echo '=== 1. Versão, role e limites ==='
select version();
select current_user, session_user, current_database(), inet_server_port() as port, now() as at;
select rolname, rolsuper, rolbypassrls, rolcreaterole, rolreplication, rolconnlimit
from pg_roles
where rolname in (current_user, 'plantoes', 'plantoes_ro', 'postgres')
order by rolname;

\echo
\echo '--- 1b. Configuração relevante ---'
select name, setting, unit, source
from pg_settings
where name in (
    'server_version', 'max_connections', 'shared_buffers', 'work_mem', 'maintenance_work_mem',
    'effective_cache_size', 'random_page_cost', 'statement_timeout', 'lock_timeout',
    'idle_in_transaction_session_timeout', 'log_min_duration_statement',
    'autovacuum', 'autovacuum_vacuum_scale_factor', 'autovacuum_analyze_scale_factor',
    'autovacuum_naptime', 'track_activity_query_size', 'shared_preload_libraries',
    'max_parallel_workers_per_gather', 'jit'
)
order by name;

\echo
\echo '--- 1c. Timeouts por role/banco (pg_db_role_setting) ---'
select coalesce(r.rolname, '<todos>') as role, coalesce(d.datname, '<todos>') as db, s.setconfig
from pg_db_role_setting s
left join pg_roles r on r.oid = s.setrole
left join pg_database d on d.oid = s.setdatabase;

\echo
\echo '--- 1d. Owner das tabelas do app (o app conecta como owner? é superuser?) ---'
select tableowner, count(*) as tabelas
from pg_tables
where schemaname = 'operations_v2'
group by tableowner;

\echo
\echo '=== 2. Volume por tabela (operations_v2) ==='
select
    c.relname as tabela,
    s.n_live_tup as linhas_est,
    s.n_dead_tup as dead_tuples,
    round(100.0 * s.n_dead_tup / greatest(s.n_live_tup + s.n_dead_tup, 1), 1) as pct_dead,
    pg_size_pretty(pg_table_size(c.oid)) as tabela_bytes,
    pg_size_pretty(pg_indexes_size(c.oid)) as indices_bytes,
    pg_size_pretty(pg_total_relation_size(c.oid)) as total,
    s.seq_scan, s.idx_scan,
    s.n_tup_ins, s.n_tup_upd, s.n_tup_del, s.n_tup_hot_upd,
    s.last_autovacuum, s.last_autoanalyze, s.last_analyze
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
left join pg_stat_user_tables s on s.relid = c.oid
where n.nspname = 'operations_v2' and c.relkind in ('r', 'p')
order by pg_total_relation_size(c.oid) desc;

\echo
\echo '--- 2b. Estatísticas resetadas quando? (idx_scan/seq_scan contam desde aqui) ---'
select stats_reset from pg_stat_database where datname = current_database();

\echo
\echo '=== 3. Índices: definição, tamanho e uso ==='
select
    i.relname as indice,
    t.relname as tabela,
    pg_size_pretty(pg_relation_size(i.oid)) as tamanho,
    s.idx_scan, s.idx_tup_read, s.idx_tup_fetch,
    ix.indisunique as unico, ix.indisvalid as valido,
    pg_get_indexdef(i.oid) as definicao
from pg_index ix
join pg_class i on i.oid = ix.indexrelid
join pg_class t on t.oid = ix.indrelid
join pg_namespace n on n.oid = t.relnamespace
left join pg_stat_user_indexes s on s.indexrelid = i.oid
where n.nspname = 'operations_v2'
order by t.relname, s.idx_scan nulls first, i.relname;

\echo
\echo '--- 3b. Índices NUNCA usados desde o reset (candidatos a revisão; não remover sem entender) ---'
select t.relname as tabela, i.relname as indice, pg_size_pretty(pg_relation_size(i.oid)) as tamanho, pg_get_indexdef(i.oid) as definicao
from pg_index ix
join pg_class i on i.oid = ix.indexrelid
join pg_class t on t.oid = ix.indrelid
join pg_namespace n on n.oid = t.relnamespace
join pg_stat_user_indexes s on s.indexrelid = i.oid
where n.nspname = 'operations_v2' and s.idx_scan = 0 and not ix.indisunique and not ix.indisprimary
order by pg_relation_size(i.oid) desc;

\echo
\echo '--- 3c. Índices inválidos (CREATE INDEX CONCURRENTLY que falhou) ---'
select n.nspname, i.relname as indice, t.relname as tabela
from pg_index ix
join pg_class i on i.oid = ix.indexrelid
join pg_class t on t.oid = ix.indrelid
join pg_namespace n on n.oid = t.relnamespace
where not ix.indisvalid;

\echo
\echo '--- 3d. FKs sem índice cobrindo as colunas referenciadoras ---'
with fk as (
    select c.conrelid, c.conname, c.conkey, t.relname as tabela
    from pg_constraint c
    join pg_class t on t.oid = c.conrelid
    join pg_namespace n on n.oid = t.relnamespace
    where c.contype = 'f' and n.nspname = 'operations_v2'
)
select fk.tabela, fk.conname,
       (select string_agg(a.attname, ', ' order by a.attnum) from pg_attribute a where a.attrelid = fk.conrelid and a.attnum = any(fk.conkey)) as colunas
from fk
where not exists (
    select 1 from pg_index ix
    where ix.indrelid = fk.conrelid
      and (ix.indkey::int2[])[0:array_length(fk.conkey,1)-1] = fk.conkey
)
order by fk.tabela;

\echo
\echo '=== 4. Constraints e views ==='
select conrelid::regclass as tabela, conname, contype, pg_get_constraintdef(oid) as definicao
from pg_constraint
where connamespace = 'operations_v2'::regnamespace and contype in ('c', 'u', 'x')
order by 1, 2;

select schemaname, viewname, viewowner from pg_views where schemaname = 'operations_v2';
select schemaname, matviewname, ispopulated from pg_matviews where schemaname = 'operations_v2';

\echo
\echo '--- 4b. Grants na schema operations_v2 por grantee (RLS não se aplica: sistema single-tenant) ---'
select grantee, privilege_type, count(*) as objetos
from information_schema.role_table_grants
where table_schema = 'operations_v2'
group by grantee, privilege_type
order by grantee, privilege_type;

select relname, relrowsecurity, relforcerowsecurity
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'operations_v2' and c.relkind = 'r' and (relrowsecurity or relforcerowsecurity);

\echo
\echo '=== 5. Contagens de negócio que decidem propostas do relatório (sem dados pessoais) ==='
\echo '--- 5a. Ocupações por mês (tamanho da janela mensal do fechamento) ---'
select to_char(date_trunc('month', started_at at time zone 'America/Sao_Paulo'), 'YYYY-MM') as mes,
       count(*) filter (where dom = 'reg') as regulacao,
       count(*) filter (where dom = 'int') as intervencao
from (
    select started_at, 'reg' as dom from operations_v2.regulation_occupancies
    union all
    select started_at, 'int' from operations_v2.intervention_occupancies
) o
group by 1 order by 1;

\echo '--- 5b. Quantos meses o saldo contratual reapura hoje (abertura mais antiga / cycle_start mais antigo) ---'
select
    (select min(l.entry_date) from operations_v2.contract_ledger l where l.type = 'opening') as abertura_mais_antiga,
    (select min(c.cycle_start) from operations_v2.contracts c where c.status = 'active'
        and not exists (select 1 from operations_v2.contract_ledger l where l.contract_id = c.id and l.type = 'opening')) as cycle_start_sem_abertura,
    (select count(*) from operations_v2.contracts where status = 'active') as contratos_ativos,
    (select count(*) from operations_v2.contract_ledger) as lancamentos_razao;

\echo '--- 5c. Semente antiga (doctor_contracts) ainda em uso? (dispara a 2a passada da apuração) ---'
select count(*) as linhas, min(seed_month) as seed_mais_antigo from operations_v2.doctor_contracts;

\echo '--- 5d. Acertos de banco de horas: existe mais de um por (médico, mês, tipo)? decide a §6.3 ---'
select count(*) as pares_com_duplicidade
from (
    select doctor_id, month_key, kind
    from operations_v2.bank_hours_settlements
    where notes not like 'reversal:%'
    group by 1, 2, 3
    having count(*) > 1
) d;

\echo '--- 5e. Tamanho da trilha de auditoria que o banco de horas carrega inteira ---'
select entity_type, count(*) from operations_v2.audit_logs group by 1 order by 2 desc;

\echo '--- 5f. Mensagens do bot: total e com justificativa de saída (parcial index) ---'
select count(*) as total,
       count(*) filter (where related_occupancy_id is not null and resolution_data ? 'matchedReasonCode') as com_justificativa,
       min(created_at) as desde
from operations_v2.telegram_ingested_messages;

\echo
\echo '=== 6. Atividade agora: conexões, transações longas, waits ==='
select coalesce(usename, '<bg>') as usuario, coalesce(application_name, '') as app, state, count(*)
from pg_stat_activity
where datname = current_database()
group by 1, 2, 3
order by 4 desc;

\echo '--- 6b. Transações abertas há mais de 30 s / idle in transaction ---'
select pid, usename, application_name, state, wait_event_type, wait_event,
       now() - xact_start as xact_age, now() - state_change as state_age,
       left(query, 200) as query
from pg_stat_activity
where datname = current_database()
  and (state like 'idle in transaction%' or (xact_start is not null and now() - xact_start > interval '30 seconds'))
order by xact_start;

\echo '--- 6c. Bloqueios: quem trava quem ---'
select blocked.pid as blocked_pid, blocked.usename as blocked_user, left(blocked.query, 120) as blocked_query,
       blocking.pid as blocking_pid, blocking.usename as blocking_user, blocking.state as blocking_state,
       left(blocking.query, 120) as blocking_query, now() - blocking.xact_start as blocking_xact_age
from pg_stat_activity blocked
join lateral unnest(pg_blocking_pids(blocked.pid)) as b(pid) on true
join pg_stat_activity blocking on blocking.pid = b.pid
where blocked.datname = current_database();

\echo
\echo '=== 7. pg_stat_statements (se instalado) ==='
select extname, extversion from pg_extension where extname in ('pg_stat_statements', 'pg_trgm', 'pgcrypto', 'uuid-ossp');

select exists (select 1 from pg_extension where extname = 'pg_stat_statements') as has_pss \gset
\if :has_pss
\echo '--- 7a. Top 20 por tempo total ---'
select round(total_exec_time::numeric / 1000, 1) as total_s, calls,
       round(mean_exec_time::numeric, 1) as mean_ms, round(max_exec_time::numeric, 1) as max_ms,
       rows, shared_blks_hit, shared_blks_read, temp_blks_written,
       left(regexp_replace(query, '\s+', ' ', 'g'), 220) as query
from pg_stat_statements
where dbid = (select oid from pg_database where datname = current_database())
order by total_exec_time desc
limit 20;

\echo '--- 7b. Top 20 por tempo médio (calls >= 5) ---'
select round(mean_exec_time::numeric, 1) as mean_ms, calls, round(total_exec_time::numeric / 1000, 1) as total_s,
       rows, shared_blks_read, temp_blks_written,
       left(regexp_replace(query, '\s+', ' ', 'g'), 220) as query
from pg_stat_statements
where dbid = (select oid from pg_database where datname = current_database()) and calls >= 5
order by mean_exec_time desc
limit 20;
\else
\echo 'pg_stat_statements NÃO está instalado — sem ele a análise de lentidão é por dedução (relatório §7).'
\endif

\echo
\echo '=== 8. Backups visíveis pelo banco (o resto é no host: ls /home/ubuntu/backups/plantoes-predeploy) ==='
select name, setting from pg_settings where name in ('archive_mode', 'archive_command', 'wal_level', 'data_directory');

\echo
\echo '=== 9. Planos das leituras críticas — COMENTADOS. Descomente para rodar (são SELECTs; a view sem WHERE lê tudo). ==='
-- \echo '--- 9a. Fechamento: UNION ALL mensal (ajuste as datas para o mês em análise) ---'
-- explain (analyze, buffers, format text)
-- select ro.id, d.full_name, rp.code, ro.started_at, bhe.balance_minutes
-- from operations_v2.regulation_occupancies ro
-- join operations_v2.doctors d on d.id = ro.doctor_id
-- join operations_v2.regulation_posts rp on rp.id = ro.post_id
-- left join operations_v2.bank_hours_entries bhe on bhe.regulation_occupancy_id = ro.id
-- where ro.started_at >= '2026-07-31T03:00:00Z'::timestamptz and ro.started_at < '2026-09-02T03:00:00Z'::timestamptz
-- union all
-- select io.id, d.full_name, ib.code, io.started_at, bhe.balance_minutes
-- from operations_v2.intervention_occupancies io
-- join operations_v2.doctors d on d.id = io.doctor_id
-- join operations_v2.intervention_bases ib on ib.id = io.base_id
-- left join operations_v2.bank_hours_entries bhe on bhe.intervention_occupancy_id = io.id
-- where io.started_at >= '2026-07-31T03:00:00Z'::timestamptz and io.started_at < '2026-09-02T03:00:00Z'::timestamptz;

-- \echo '--- 9b. Banco de horas: a view inteira, como a tela lê hoje ---'
-- explain (analyze, buffers, format text)
-- select * from operations_v2.bank_hours_history_shifts;

-- \echo '--- 9c. Banco de horas: trilha de auditoria via EXISTS com cast ---'
-- explain (analyze, buffers, format text)
-- select al.id
-- from operations_v2.audit_logs al
-- where (al.entity_type = 'regulation_occupancy' and exists (select 1 from operations_v2.regulation_occupancies ro where ro.id::text = al.entity_id))
--    or (al.entity_type = 'intervention_occupancy' and exists (select 1 from operations_v2.intervention_occupancies io where io.id::text = al.entity_id))
-- order by al.created_at desc;

-- \echo '--- 9d. Bot: últimas mensagens de um chat (candidato ao índice §6.1; troque o chat_id) ---'
-- explain (analyze, buffers, format text)
-- select id, created_at from operations_v2.telegram_ingested_messages
-- where chat_id = '<TELEGRAM_GROUP_CHAT_ID>' order by created_at desc limit 50;

\echo
\echo 'fim.'

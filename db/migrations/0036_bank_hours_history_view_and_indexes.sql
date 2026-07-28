-- Preparação de banco para as leituras do banco de horas e do fechamento.
--
-- 1) View bank_hours_history_shifts: a forma canônica "ocupação + médico +
--    posto/base + linha do banco de horas" usada pelo histórico do banco de
--    horas (e disponível para consultas ad-hoc via psql). Antes o UNION vivia
--    duplicado em SQL inline no service; a view centraliza e permite EXPLAIN
--    e auditoria direto no banco.
-- 2) Índices para os joins/lookups que hoje caem em seq scan e crescem com o
--    uso: audit_logs por entidade, telegram_ingested_messages por ocupação
--    relacionada (só as linhas com justificativa de saída), e started_at das
--    ocupações (janelas mensais do fechamento/relatórios).
--
-- ATENÇÃO deploy: rodar `npm run db:migrate` em produção ANTES do merge — o
-- service do banco de horas passa a consultar a view.

create or replace view operations_v2.bank_hours_history_shifts as
select
    ro.id as "occupancyId",
    'regulation' as domain,
    d.id as "doctorId",
    d.full_name as "doctorName",
    d.display_name as "displayName",
    rp.code as "targetCode",
    rp.label as "targetLabel",
    ro.continuity_group_id as "continuityGroupId",
    ro.started_at as "startedAt",
    ro.board_started_at as "boardStartedAt",
    ro.ended_at as "handoffEndedAt",
    ro.actual_ended_at as "actualEndedAt",
    coalesce(ro.actual_ended_at, ro.ended_at) as "effectiveEndedAt",
    ro.shift_label as "shiftLabel",
    ro.source as source,
    ro.notes as notes,
    ro.created_at as "createdAt",
    ro.updated_at as "updatedAt",
    creator.email as "createdByEmail",
    updater.email as "updatedByEmail",
    (bhe.id is not null) as "hasPersistedBankEntry",
    ro.scheduled_start_at as "occupancyScheduledStartAt",
    ro.scheduled_end_at as "occupancyScheduledEndAt",
    bhe.scheduled_start_at as "bankScheduledStartAt",
    bhe.scheduled_end_at as "bankScheduledEndAt",
    bhe.actual_start_at as "bankActualStartAt",
    bhe.actual_end_at as "bankActualEndAt",
    bhe.arrival_delay_minutes as "arrivalDelayMinutes",
    bhe.overtime_minutes as "overtimeMinutes",
    bhe.credited_overtime_minutes as "creditedOvertimeMinutes",
    bhe.balance_minutes as "balanceMinutes",
    bhe.rule_code as "ruleCode",
    bhe.explanation as "bankHoursExplanation"
from operations_v2.regulation_occupancies ro
inner join operations_v2.doctors d on d.id = ro.doctor_id
inner join operations_v2.regulation_posts rp on rp.id = ro.post_id
left join operations_v2.users creator on creator.id = ro.created_by_user_id
left join operations_v2.users updater on updater.id = ro.updated_by_user_id
left join operations_v2.bank_hours_entries bhe on bhe.regulation_occupancy_id = ro.id
union all
select
    io.id as "occupancyId",
    'intervention' as domain,
    d.id as "doctorId",
    d.full_name as "doctorName",
    d.display_name as "displayName",
    ib.code as "targetCode",
    ib.label as "targetLabel",
    io.continuity_group_id as "continuityGroupId",
    io.started_at as "startedAt",
    io.board_started_at as "boardStartedAt",
    io.ended_at as "handoffEndedAt",
    io.actual_ended_at as "actualEndedAt",
    coalesce(io.actual_ended_at, io.ended_at) as "effectiveEndedAt",
    io.shift_label as "shiftLabel",
    io.source as source,
    io.notes as notes,
    io.created_at as "createdAt",
    io.updated_at as "updatedAt",
    creator.email as "createdByEmail",
    updater.email as "updatedByEmail",
    (bhe.id is not null) as "hasPersistedBankEntry",
    io.scheduled_start_at as "occupancyScheduledStartAt",
    io.scheduled_end_at as "occupancyScheduledEndAt",
    bhe.scheduled_start_at as "bankScheduledStartAt",
    bhe.scheduled_end_at as "bankScheduledEndAt",
    bhe.actual_start_at as "bankActualStartAt",
    bhe.actual_end_at as "bankActualEndAt",
    bhe.arrival_delay_minutes as "arrivalDelayMinutes",
    bhe.overtime_minutes as "overtimeMinutes",
    bhe.credited_overtime_minutes as "creditedOvertimeMinutes",
    bhe.balance_minutes as "balanceMinutes",
    bhe.rule_code as "ruleCode",
    bhe.explanation as "bankHoursExplanation"
from operations_v2.intervention_occupancies io
inner join operations_v2.doctors d on d.id = io.doctor_id
inner join operations_v2.intervention_bases ib on ib.id = io.base_id
left join operations_v2.users creator on creator.id = io.created_by_user_id
left join operations_v2.users updater on updater.id = io.updated_by_user_id
left join operations_v2.bank_hours_entries bhe on bhe.intervention_occupancy_id = io.id;

-- Permissões da view: uma view NÃO herda os grants das tabelas base — o
-- Postgres checa SELECT na própria view. Se esta migration for aplicada por um
-- superusuário/DBA (e não pelo role do app), a view nasceria dele e o app
-- levaria 42501. Então: (a) alinha o owner da view com o dono das tabelas;
-- (b) replica para a view todo grantee com SELECT na tabela base (cobre roles
-- read-only como plantoes_ro). Ambos idempotentes e tolerantes a privilégio
-- insuficiente (quando o app aplica a própria migration, já é o owner).
do $$
declare
    base_owner text;
    reader record;
begin
    select tableowner into base_owner
    from pg_tables
    where schemaname = 'operations_v2' and tablename = 'regulation_occupancies';

    if base_owner is not null then
        begin
            execute format('alter view operations_v2.bank_hours_history_shifts owner to %I', base_owner);
        exception when insufficient_privilege then
            null;
        end;
    end if;

    for reader in
        select distinct grantee
        from information_schema.role_table_grants
        where table_schema = 'operations_v2'
          and table_name = 'regulation_occupancies'
          and privilege_type = 'SELECT'
          and grantee <> 'PUBLIC'
    loop
        begin
            execute format('grant select on operations_v2.bank_hours_history_shifts to %I', reader.grantee);
        exception when insufficient_privilege or undefined_object then
            null;
        end;
    end loop;
end $$;

-- Lookup da trilha de auditoria por entidade (antes: seq scan com IN gigante).
create index if not exists audit_logs_entity_idx
    on operations_v2.audit_logs (entity_type, entity_id);

-- Justificativas de saída tardia do bot: parcial, só as linhas que interessam.
create index if not exists telegram_ingested_messages_related_occupancy_idx
    on operations_v2.telegram_ingested_messages (related_occupancy_id)
    where related_occupancy_id is not null and resolution_data ? 'matchedReasonCode';

-- Janelas mensais (fechamento, relatórios, slot-audit) filtram por started_at.
create index if not exists regulation_occupancies_started_idx
    on operations_v2.regulation_occupancies (started_at);

create index if not exists intervention_occupancies_started_idx
    on operations_v2.intervention_occupancies (started_at);

-- Expõe na view bank_hours_history_shifts o estado de aprovação da chefia.
--
-- Os dados sempre existiram nas duas tabelas de ocupação, mas nunca chegaram ao
-- modelo de leitura — então NENHUMA tela mostrava se o chefe validou a saída
-- tardia do médico. É a origem dos questionamentos: o médico avisa no bot que
-- saiu depois por causa de uma ocorrência, isso abre um modal para o chefe
-- logado validar, e o médico nunca fica sabendo se alguém validou.
--
-- Com estas colunas dá para distinguir os três estados que importam:
--   saída registrada + confirmação nula        -> pendente (ninguém opinou)
--   saída registrada + confirmação preenchida  -> validada, com quem e quando
--   saída corrigida para menos                 -> recusa na prática (já vinha
--                                                 pelo audit trail das correções)
--
-- Só regulação tem confirmação de saída; intervenção tem saída E reconhecimento
-- de atraso. Do lado da regulação as colunas de atraso vêm nulas, de propósito.
--
-- CREATE OR REPLACE VIEW só aceita acrescentar colunas no fim, mantendo as
-- existentes na mesma ordem e tipo — é o que esta migration faz.

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
    bhe.explanation as "bankHoursExplanation",
    -- Colunas novas (0039)
    ro.departure_confirmed_at as "departureConfirmedAt",
    coalesce(confirmer_doctor.display_name, confirmer_doctor.full_name, confirmer.email) as "departureConfirmedByName",
    ro.departure_confirmed_note as "departureConfirmedNote",
    null::timestamptz as "lateArrivalAcknowledgedAt",
    null::varchar as "lateArrivalAcknowledgedByName",
    null::text as "lateArrivalAcknowledgedNote"
from operations_v2.regulation_occupancies ro
inner join operations_v2.doctors d on d.id = ro.doctor_id
inner join operations_v2.regulation_posts rp on rp.id = ro.post_id
left join operations_v2.users creator on creator.id = ro.created_by_user_id
left join operations_v2.users updater on updater.id = ro.updated_by_user_id
left join operations_v2.users confirmer on confirmer.id = ro.departure_confirmed_by_user_id
-- O médico quer o NOME de quem validou, não um e-mail de sistema.
left join operations_v2.doctors confirmer_doctor on confirmer_doctor.id = confirmer.doctor_id
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
    bhe.explanation as "bankHoursExplanation",
    -- Colunas novas (0039)
    io.departure_confirmed_at as "departureConfirmedAt",
    coalesce(confirmer_doctor.display_name, confirmer_doctor.full_name, confirmer.email) as "departureConfirmedByName",
    io.departure_confirmed_note as "departureConfirmedNote",
    io.late_arrival_acknowledged_at as "lateArrivalAcknowledgedAt",
    coalesce(acknowledger_doctor.display_name, acknowledger_doctor.full_name, acknowledger.email) as "lateArrivalAcknowledgedByName",
    io.late_arrival_acknowledged_note as "lateArrivalAcknowledgedNote"
from operations_v2.intervention_occupancies io
inner join operations_v2.doctors d on d.id = io.doctor_id
inner join operations_v2.intervention_bases ib on ib.id = io.base_id
left join operations_v2.users creator on creator.id = io.created_by_user_id
left join operations_v2.users updater on updater.id = io.updated_by_user_id
left join operations_v2.users confirmer on confirmer.id = io.departure_confirmed_by_user_id
left join operations_v2.doctors confirmer_doctor on confirmer_doctor.id = confirmer.doctor_id
left join operations_v2.users acknowledger on acknowledger.id = io.late_arrival_acknowledged_by_user_id
left join operations_v2.doctors acknowledger_doctor on acknowledger_doctor.id = acknowledger.doctor_id
left join operations_v2.bank_hours_entries bhe on bhe.intervention_occupancy_id = io.id;

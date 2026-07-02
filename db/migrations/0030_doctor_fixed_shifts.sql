-- Gestão de médicos pela chefia (/admin/medicos):
--   1. doctor_weekday_preferences ganha ranking (preference_order): os "dias
--      preferidos" do médico são uma lista ordenada, não um conjunto.
--   2. doctor_fixed_shifts: turnos fixos do médico (dia da semana + SD/SN).
--      Cada médico pode ter vários (ex.: fixo de terça SD e sexta SN). É o
--      que faz o médico aparecer primeiro na montagem da escala daquele dia.
-- Aditiva como as demais da série.
--
-- ROLLBACK:
--   drop table if exists operations_v2.doctor_fixed_shifts;
--   alter table operations_v2.doctor_weekday_preferences
--       drop column if exists preference_order;

alter table operations_v2.doctor_weekday_preferences
    add column if not exists preference_order integer not null default 0;

create table if not exists operations_v2.doctor_fixed_shifts (
    id uuid primary key default gen_random_uuid(),
    doctor_id uuid not null references operations_v2.doctors (id) on delete cascade,
    weekday smallint not null check (weekday between 0 and 6),
    shift_label varchar(8) not null,
    created_at timestamptz not null default now()
);

create unique index if not exists doctor_fixed_shifts_doctor_slot_idx
    on operations_v2.doctor_fixed_shifts (doctor_id, weekday, shift_label);

create index if not exists doctor_fixed_shifts_weekday_idx
    on operations_v2.doctor_fixed_shifts (weekday, shift_label);

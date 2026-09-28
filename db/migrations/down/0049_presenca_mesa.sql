alter table operations_v2.auth_session_events drop column if exists device_id;
alter table operations_v2.auth_sessions drop column if exists device_id;
drop table if exists operations_v2.view_presence;
drop table if exists operations_v2.view_leases;

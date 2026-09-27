-- Reversão de 0046_monitor_acessos.sql.
--
-- Apaga o registro de sessões e interações (a prova do monitor de acessos) —
-- exportar antes o relatório de quem estiver sob apuração. O cookie de sessão
-- continua valendo: `sid` é opcional na leitura (lib/auth/token.ts).
drop table if exists operations_v2.auth_network_info;
drop table if exists operations_v2.auth_session_activity;
drop table if exists operations_v2.auth_session_events;
drop table if exists operations_v2.auth_sessions;

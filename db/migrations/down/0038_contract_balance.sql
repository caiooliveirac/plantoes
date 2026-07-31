-- Reversão da 0038. NÃO é aplicada por `npm run db:migrate`: o runner só varre
-- db/migrations/*.sql e ignora subdiretórios. Rodar à mão, em base LOCAL:
--
--   psql "$DATABASE_URL" -f db/migrations/down/0038_contract_balance.sql
--   psql "$DATABASE_URL" -c \
--     "delete from operations_v2.schema_migrations where filename = '0038_contract_balance.sql'"
--
-- Destrutivo: apaga contratos e razão. Nunca em produção.

drop view if exists operations_v2.contract_balance;

drop table if exists operations_v2.contract_ledger;
drop table if exists operations_v2.contracts;

drop type if exists operations_v2.contract_ledger_entry_type;
drop type if exists operations_v2.contract_status;
drop type if exists operations_v2.contract_category;

-- Postgres não remove valor de enum. Reverter = tirar os papéis das contas;
-- os valores ficam no tipo, sem uso.
delete from operations_v2.user_roles where role in ('radio_operador', 'tarm');

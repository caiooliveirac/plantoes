-- Postgres não remove valor de enum. Reverter = tirar o papel das contas;
-- o valor fica no tipo, sem uso.
delete from operations_v2.user_roles where role = 'radio_operador';

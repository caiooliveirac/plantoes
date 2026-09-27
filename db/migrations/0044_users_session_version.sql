-- Sessão revogável: o cookie de sessão leva `sv` e só vale enquanto for igual a
-- users.session_version. Troca e redefinição de senha (própria, reset por e-mail,
-- senha provisória da chefia, re-cadastro do médico) incrementam a coluna e
-- derrubam os cookies emitidos antes. Default 0 = o que vale para o cookie
-- antigo sem `sv`, então o deploy não desloga ninguém.
alter table operations_v2.users
    add column if not exists session_version integer not null default 0;

-- Papel `portal`: a conta entra no portal mnrs.com.br (o porteiro autentica via
-- POST /api/auth/verificar-escala) mas NÃO tem acesso ao app Plantões. Nasce
-- pelo POST /api/servicos/contas-portal (equipe cadastrada no Huddle, que não é
-- médica e não passa pelo cadastro por codinome).
--
-- Transação: scripts/apply-migrations.ts roda cada arquivo dentro de BEGIN/COMMIT.
-- Desde o PG 12, ALTER TYPE ... ADD VALUE pode rodar em bloco de transação; o
-- que não pode é USAR o valor novo na mesma transação — por isso este arquivo só
-- acrescenta o valor e nada mais. Mesmo padrão de 0027 ('doctor') e 0032
-- ('payment_closing_limited'). Produção e CI rodam PG 16.
alter type operations_v2.user_role
    add value if not exists 'portal';

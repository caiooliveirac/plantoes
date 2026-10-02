-- Papel `observador` (modules/auth/contracts.ts, OBSERVADOR_ROLE): vê tudo o
-- que o admin vê, fora do plantão e de qualquer lugar, sem escrever. Só
-- acrescenta valor ao enum: aplicar ANTES do deploy.
alter type operations_v2.user_role add value if not exists 'observador';

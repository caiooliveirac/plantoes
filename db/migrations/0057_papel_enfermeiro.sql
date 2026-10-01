-- Papel `enfermeiro` (modules/auth/contracts.ts, ENFERMEIRO_ROLE): conta de
-- enfermeiro(a) aprovada no Escalas (POST /api/servicos/contas-escala). Edita
-- o Quadro Informativo e lê a Mesa (toda escrita da Mesa exige admin/chief),
-- de qualquer lugar. Só acrescenta valor ao enum: aplicar ANTES do deploy.
alter type operations_v2.user_role add value if not exists 'enfermeiro';

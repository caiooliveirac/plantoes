-- Papel `interno` (modules/auth/contracts.ts, INTERNO_ROLE): interno(a) de
-- medicina do GOA, conta nominal que só entra pelo SkyRescue (docs/internos-goa.md).
-- Lê a Mesa de qualquer lugar, sem escrever. Só acrescenta valor ao enum:
-- aplicar ANTES do deploy.
alter type operations_v2.user_role add value if not exists 'interno';

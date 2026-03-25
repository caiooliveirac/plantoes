# Contributing

## Objetivo

Este repositório concentra a evolução da operação de plantão SAMU com foco em previsibilidade, rastreabilidade e segurança operacional.

## Regras de contribuição

1. Toda mudança deve preservar a leitura operacional do quadro.
2. Mudanças em auth, banco de horas e correções operacionais exigem testes ou justificativa explícita.
3. Nunca versionar segredos, tokens ou dumps locais.
4. Evitar refactors amplos junto com correções críticas de operação.
5. Preferir mudanças pequenas, auditáveis e publicáveis.
6. Mudou regra de turno, tolerancia, continuidade ou lembrete? Atualizar `OPERATIONAL_RULES.md` na mesma entrega.
7. Se a entrega exigir restart ou publicação, seguir `DEPLOY.md` e usar reload com `.env.production` + `pm2 restart ... --update-env`.

## Fluxo recomendado

1. Abrir issue descrevendo problema, risco operacional e comportamento esperado.
2. Criar branch curta a partir de `main`.
3. Implementar a mudança com cobertura de teste quando a regra for crítica.
4. Abrir PR com impacto operacional, risco, rollback e validação.
5. Fazer merge apenas depois de confirmar comportamento em ambiente publicado.

## Convenções de branch

- `feat/...` para funcionalidades
- `fix/...` para correções
- `chore/...` para manutenção
- `docs/...` para documentação

## Checklist mínimo

- build local sem erro
- testes relevantes executados
- README atualizado se houve mudança estrutural
- impacto de auth/permissão documentado quando aplicável

## Áreas sensíveis

- `modules/operational/*`
- `modules/regulation/*`
- `modules/intervention/*`
- `modules/bank-hours/*`
- `lib/auth/*`
- `app/api/*`
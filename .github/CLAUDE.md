# .github/ — CI e deploy

> Carregado sob demanda: só entra no contexto quando um arquivo desta pasta é lido. Índice na raiz: [CLAUDE.md](../CLAUDE.md)


- **Dev local**: `npm run dev`. `.env.local` para apontar num Postgres local (schema
  `operations_v2`, ver connection string de exemplo em `.env.example`).
- **CI de PR** ([.github/workflows/ci-pr.yml](workflows/ci-pr.yml)), runner
  `ubuntu-latest` do GitHub com Postgres 16 de serviço: `npm ci` → `db:migrate`
  (valida que as migrations aplicam limpas; os testes não tocam o banco) →
  `npm run typecheck` → `npm run test:deploy` → meal-breaks isolado (bloqueante,
  `--experimental-test-isolation=none` no Node 22) → `npm run build`. Todos os
  passos são bloqueantes; ~2min no total.
- **Deploy** ([.github/workflows/release-deploy.yml](workflows/release-deploy.yml)),
  em push a `main`: job `validate` (mesma bateria do CI de PR, sem meal-breaks e sem
  build) e depois job `deploy`, que executa
  [scripts/deploy-magalu.sh](../scripts/deploy-magalu.sh) **no servidor via SSH** — o
  `next build` de produção acontece lá (build atômico com `.next.prev` para
  rollback, guard de memória), com restart dos dois processos PM2 (`plantoes`,
  `plantoes-telegram-worker`) e healthcheck de `/api/health` + `/api/board`.
  Não há mais self-hosted runner nem os jobs antigos `test_smoke`/`test_regression`.
- **Migrations em produção são manuais**: aplicar `db/migrations/NNNN_*.sql` no
  servidor **antes** do merge (via `npm run db:migrate` com `.env.production`), não
  fazem parte do pipeline de deploy automático.


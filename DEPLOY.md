# Deploy de produção (magalu · PM2)

> Modelo antigo (EC2 + container por digest) foi aposentado na migração de
> julho/2026 — histórico em `docs/deploy-audit-ec2-before-after.md`.

## Visão geral

Produção roda no servidor **magalu** (x86_64, 15GB RAM) como checkout git de
`main` em `/home/ubuntu/plantoes`, com **PM2** (processos `plantoes` web na
porta 3004 e `plantoes-telegram-worker`). O nginx do host roteia
`plantoes.mnrs.com.br → 127.0.0.1:3004`.

## Pipeline

1. **Pull Request** — `.github/workflows/ci-pr.yml`: typecheck (next typegen +
   tsc), testes com Postgres de serviço e build. Não toca no servidor.
2. **Merge em `main`** — `.github/workflows/release-deploy.yml`:
   - `validate`: typecheck + `test:deploy` (com migrações num Postgres de CI);
   - `deploy`: envia `scripts/deploy-magalu.sh` por scp e executa via SSH.
3. **No servidor** (`scripts/deploy-magalu.sh`):
   - `git fetch && git reset --hard <sha>` (working tree de produção fica limpo);
   - `npm ci` **somente se o package-lock mudou**;
   - migrações **apenas** com `--run-migrations` (workflow_dispatch), com
     `pg_dump` de backup antes;
   - `next build` com `nice` — roda **antes** do restart: se falhar, o `.next`
     antigo continua servindo e nada é reiniciado;
   - `pm2 startOrRestart ecosystem.config.cjs --update-env` + `pm2 save`;
   - healthcheck local (30s) e, de volta no runner, healthcheck público.

## Rollback

```bash
ssh magalu
bash /home/ubuntu/plantoes/scripts/deploy-magalu.sh <sha-anterior>
```

(ou re-rode o workflow num commit anterior via workflow_dispatch)

## Migrações

Deploy normal **não** roda migrações. Quando precisar:
GitHub → Actions → Release and Deploy → Run workflow → `run_migrations: true`.
O script faz `pg_dump` para `/home/ubuntu/backups/plantoes-predeploy/`
(mantém os 5 mais recentes) antes de aplicar.

## Segredos e ambiente

- Nada de segredo no Git nem no runner além da chave SSH de deploy.
- Ambiente do app: `/home/ubuntu/plantoes/.env.production` (o Next carrega
  nativamente com `NODE_ENV=production`).
- Secrets do repositório: `PROD_SSH_HOST`, `PROD_SSH_USER`, `PROD_SSH_KEY`
  (chave ed25519 dedicada de CI, sem sudo).

## Regras que continuam valendo

- Não desenvolver dentro do servidor: o working tree de produção deve ficar
  sempre limpo (o deploy usa `git reset --hard`).
- Testes e experimentos: sempre no macOS local / CI.

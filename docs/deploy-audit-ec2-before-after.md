# Auditoria objetiva — comandos que chegavam na EC2

## Antes (modelo legado)

Origem principal:

- `.github/workflows/deploy.yml`
- `scripts/deploy-production.sh`
- `ecosystem.config.cjs`

Comandos que chegavam na EC2 de produção:

- `runs-on: self-hosted`
- `npm ci --prefer-offline`
- `npm run test:deploy`
- `npm run test:full` (PR, não bloqueante)
- `npx tsc --noEmit -p tsconfig.deploy.json`
- `npx next typegen`
- `npm run build` (`next build`)
- `git fetch` + `git checkout <sha>` (dentro de `scripts/deploy-production.sh`)
- restart PM2 (`pm2 delete`, `pm2 start`, `pm2 save`)

Resumo: validação, instalação e build ocorriam no mesmo host da produção.

## Depois (modelo novo)

Origem principal:

- `.github/workflows/ci-pr.yml`
- `.github/workflows/release-deploy.yml`
- `scripts/deploy-plantoes-container.sh` (instalado como `/usr/local/sbin/deploy-plantoes`)

Comandos que chegam na EC2:

- `docker pull <image@sha256:...>`
- `docker run` (candidato + ativo)
- `curl` de health local
- rollback por `docker rm/run` da imagem anterior
- limpeza de imagens antigas (preservando atual/anterior)
- opcional e explícito: `docker run ... npm run db:migrate`

Comandos que **não** chegam mais na EC2:

- `npm ci`, `npm install`, `pnpm install`, `yarn install`
- `next build`, `vite build`
- testes
- `tsc`
- `git pull`, `git checkout`
- `docker build`

## Evidência de desenho

- PR: somente `ubuntu-latest`, sem SSH/prod.
- Merge em `main`: valida em hosted runner, buildx `linux/arm64`, push GHCR por SHA, deploy por digest.
- Deploy serializado por `concurrency`.
- Script fixo no host valida digest e arquitetura antes da troca.

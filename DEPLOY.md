# Deploy de produção (modelo container por digest)

## Regra principal

A EC2 de produção **não executa**:

- `npm ci`, `npm install`, `pnpm install`, `yarn install`
- `next build`, `vite build`, `tsc`
- testes (`npm test`, `node --test`)
- `git pull`, `git checkout`
- `docker build`

A EC2 apenas:

- recebe `image@sha256:...`
- faz `docker pull`
- valida arquitetura `arm64`
- sobe candidato
- checa health
- promove ou faz rollback

## Pipeline

1. Pull Request
- Runner: `ubuntu-latest` (GitHub-hosted)
- Executa: lint, typecheck, testes, build
- Não publica imagem
- Não acessa EC2

2. Merge em `main`
- Runner: `ubuntu-latest` (GitHub-hosted)
- Executa validações novamente
- Buildx `linux/arm64`
- Push para GHCR com tag imutável `sha-<commit>`
- Resolve digest e faz deploy remoto por digest

3. Host EC2
- Script fixo: `/usr/local/sbin/deploy-plantoes`
- Entrada: `ghcr.io/...@sha256:...`
- Rollback automático em falha de health

## Script remoto oficial

Arquivo versionado no repositório:

- `scripts/deploy-plantoes-container.sh`

Ele é instalado pelo workflow em:

- `/usr/local/sbin/deploy-plantoes`

Uso no host (manual, emergência):

```bash
sudo /usr/local/sbin/deploy-plantoes ghcr.io/<org>/<repo>/plantoes@sha256:<digest>
```

Migração explícita (opcional):

```bash
sudo /usr/local/sbin/deploy-plantoes ghcr.io/<org>/<repo>/plantoes@sha256:<digest> --run-migrations
```

## Segredos e ambiente

- Segredos continuam fora da imagem e fora do Git.
- Arquivo de ambiente no host: `/home/ubuntu/plantoes/.env.production`.
- Credencial GHCR do host deve ser **read-only** (`packages:read`) via:
  - `GHCR_USERNAME`
  - `GHCR_READ_TOKEN`
  - ou login Docker pré-configurado no host.

## Health check

- Candidato: `http://127.0.0.1:3904/api/health`
- Ativo: `http://127.0.0.1:3004/api/health`
- Público: `https://plantoes.mnrs.com.br/api/health`

Endpoint adicional estável para orquestração:

- `GET /healthz`

## Rollback

- O script salva digest atual e anterior em `/var/lib/plantoes-deploy/`.
- Se falhar health após promoção, ele reinicia a versão anterior e retorna código não-zero.
- Logs de deploy ficam no stdout/stderr do comando remoto e no resumo do GitHub Actions.

## Workflows

- PR CI: `.github/workflows/ci-pr.yml`
- Release/Deploy: `.github/workflows/release-deploy.yml`

## Observação

`npm run deploy:production` foi mantido apenas como bloqueio explícito para impedir uso do fluxo legado de build no host.

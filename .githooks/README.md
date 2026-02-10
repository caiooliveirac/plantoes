# Git hooks deste repo

Repo privado em conta free do GitHub nao permite branch protection nem rulesets,
entao protegemos `main` em camadas:

1. **Client-side (este diretorio)**: `pre-push` bloqueia push direto e force-push em `main`.
2. **Server-side (CI)**: job `deploy` em `.github/workflows/deploy.yml` recusa commits que nao venham de PR mergeado.
3. **Deploy script**: `scripts/deploy-production.sh` exige working tree limpo e reconcilia para o commit do CI.

## Ativar nos clones

Git nao roda hooks de subdiretorios versionados por padrao. Cada clone precisa:

```bash
git config core.hooksPath .githooks
```

Isso fica no `.git/config` local (nao versionado).

## Overrides de emergencia

- `PRE_PUSH_ALLOW_DIRECT_MAIN=1 git push origin main` — pula bloqueio de push direto.
- No CI, `workflow_dispatch` pula o guard de PR (acao manual, audit log).

Use overrides so quando o humano decidir conscientemente. Agentes IA NAO devem usar.

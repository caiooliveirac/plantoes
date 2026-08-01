#!/usr/bin/env bash
# Deploy do plantoes no servidor magalu (runtime PM2, sem containers).
#
# Fluxo: git reset ao SHA validado → npm ci (só se o lockfile mudou) →
# migrações (apenas com --run-migrations, com backup antes) → next build →
# pm2 startOrRestart → healthcheck local.
#
# Segurança do fluxo: o build acontece ANTES do restart — se falhar, o
# processo antigo continua no ar com o .next anterior. Rollback manual:
#   bash scripts/deploy-magalu.sh <sha-anterior>
#
# Uso: bash deploy-magalu.sh <sha> [--run-migrations]
set -euo pipefail

SHA="${1:?uso: deploy-magalu.sh <sha> [--run-migrations]}"
RUN_MIGRATIONS="${2:-}"
APP_DIR=/home/ubuntu/plantoes
ENV_FILE="$APP_DIR/.env.production"
BACKUP_DIR=/home/ubuntu/backups/plantoes-predeploy

cd "$APP_DIR"
if [ ! -f "$ENV_FILE" ]; then
  echo "ERRO: $ENV_FILE ausente." >&2
  exit 1
fi

PREV=$(git rev-parse HEAD)
echo "=== git: ${PREV:0:7} -> ${SHA:0:7} ==="
git fetch origin
git reset --hard "$SHA"

if git diff --quiet "$PREV" "$SHA" -- package-lock.json 2>/dev/null; then
  echo "=== deps: lockfile inalterado, npm ci pulado ==="
else
  echo "=== deps: npm ci (lockfile mudou) ==="
  npm ci
fi

# Env de produção para migrações e build (o Next também lê .env.production sozinho).
set -a
# shellcheck disable=SC1090
. "$ENV_FILE"
set +a

# Guarda de desvio: migration no repo que ainda não foi aplicada em produção
# derruba o deploy ANTES do build. É o erro que já aconteceu duas vezes aqui —
# a 0037 foi aplicada à mão e o código ficou para trás; a 0038 e a 0039 exigiram
# aplicação manual antes do merge. Sem esta checagem o deploy sobe código que
# consulta coluna ou tabela que não existe, e a falha só aparece para o usuário.
if [ "$RUN_MIGRATIONS" != "--run-migrations" ]; then
  echo "=== conferindo migrações pendentes em produção ==="
  aplicadas=$(psql "$DATABASE_URL" -qtA -c \
    "select filename from operations_v2.schema_migrations" 2>/dev/null | sort || echo "")
  if [ -z "$aplicadas" ]; then
    echo "AVISO: não consegui ler schema_migrations — seguindo sem a checagem."
  else
    noRepo=$(ls db/migrations/*.sql 2>/dev/null | xargs -r -n1 basename | sort)
    pendentes=$(comm -23 <(echo "$noRepo") <(echo "$aplicadas"))
    if [ -n "$pendentes" ]; then
      echo "ERRO: existem migrações no repo que não foram aplicadas neste banco:"
      echo "$pendentes" | sed "s/^/  - /"
      echo ""
      echo "Aplique antes de seguir (o padrão do repo é manual):"
      echo "  cd $APP_DIR && set -a && . .env.production && set +a && npm run db:migrate"
      echo "Ou refaça o deploy com --run-migrations (faz backup antes)."
      exit 1
    fi
    echo "nenhuma migração pendente."
  fi
fi

if [ "$RUN_MIGRATIONS" = "--run-migrations" ]; then
  echo "=== backup do banco antes das migrações ==="
  mkdir -p "$BACKUP_DIR"
  ts=$(date +%Y%m%dT%H%M%S)
  pg_dump "$DATABASE_URL" | gzip > "$BACKUP_DIR/db-$ts.sql.gz"
  ls -t "$BACKUP_DIR"/db-*.sql.gz | tail -n +6 | xargs -r rm
  echo "backup: db-$ts.sql.gz"
  echo "=== npm run db:migrate ==="
  npm run db:migrate
fi

# Build LIMPO. O incremental por cima do .next antigo deixa manifesto órfão
# quando o deploy REMOVE rotas ou componentes de cliente: aconteceu no deploy do
# PR #128, que apagou /escala e /trocas — o Next passou a responder
# "client reference manifest for route /admin/payment-closing does not exist" e a
# tela do fechamento caiu com 500, enquanto as rotas removidas seguiam
# respondendo 200 a partir de chunks velhos.
#
# O .next anterior vira .next.prev ANTES do build, então a garantia de rollback
# continua de pé: se o build falhar, o processo antigo segue no ar e o
# .next.prev tem o build que estava funcionando.
echo "=== preservando build anterior em .next.prev ==="
rm -rf .next.prev
[ -d .next ] && mv .next .next.prev

echo "=== next build limpo (nice, antes do restart — falha não derruba produção) ==="
if ! nice -n 10 npm run build; then
  echo "ERRO: build falhou. Restaurando o .next anterior para o processo atual."
  rm -rf .next
  [ -d .next.prev ] && cp -r .next.prev .next
  exit 1
fi

echo "=== pm2 restart ==="
export GIT_COMMIT_SHA="${SHA:0:7}"
export GIT_COMMIT_SHA_LONG="$SHA"
export GIT_WORKING_TREE_CLEAN="true"
pm2 startOrRestart ecosystem.config.cjs --update-env
pm2 save

echo "=== healthcheck local (127.0.0.1:3004) ==="
ok=0
for i in $(seq 1 30); do
  if curl -fsS http://127.0.0.1:3004/api/health >/dev/null 2>&1; then
    ok=1
    echo "producao OK em ${i}s"
    break
  fi
  sleep 1
done
if [ "$ok" -eq 0 ]; then
  echo "ERRO: produção não saudável após restart" >&2
  pm2 logs plantoes --lines 40 --nostream || true
  echo "Rollback manual: bash scripts/deploy-magalu.sh $PREV" >&2
  exit 1
fi

echo "=== OK: plantoes ${SHA:0:7} no ar ==="

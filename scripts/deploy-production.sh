#!/usr/bin/env bash
set -euo pipefail

cd /home/ubuntu/plantoes

set -a
source .env.production
set +a

npm test
npm run build

pm2 restart plantoes --update-env
pm2 restart plantoes-telegram-worker --update-env

sleep 4

web_pid="$(pm2 pid plantoes)"
worker_pid="$(pm2 pid plantoes-telegram-worker)"
port="$(tr '\0' '\n' < "/proc/${web_pid}/environ" | sed -n 's/^PORT=//p' | head -n 1)"

if [[ -z "${port}" ]]; then
    port="3004"
fi

tr '\0' '\n' < "/proc/${web_pid}/environ" | grep -q '^DATABASE_URL='
tr '\0' '\n' < "/proc/${worker_pid}/environ" | grep -q '^DATABASE_URL='

curl -fsS "http://127.0.0.1:${port}/api/health" >/dev/null
curl -fsS "http://127.0.0.1:${port}/api/board" >/dev/null

pm2 save >/dev/null

echo "deploy_ok port=${port} web_pid=${web_pid} worker_pid=${worker_pid}"
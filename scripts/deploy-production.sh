#!/usr/bin/env bash
set -euo pipefail

cd /home/ubuntu/plantoes

set -a
source .env.production
set +a

npm run build

pm2 delete plantoes >/dev/null 2>&1 || true
pm2 delete plantoes-telegram-worker >/dev/null 2>&1 || true
pm2 start ecosystem.config.cjs --update-env

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

if [[ -n "${TELEGRAM_BOT_TOKEN:-}" ]]; then
    auth_url="${AUTH_URL:-}"
    if [[ -z "${auth_url}" ]]; then
        echo "AUTH_URL is required to configure the Telegram webhook." >&2
        exit 1
    fi

    webhook_url="${auth_url%/}/api/telegram/webhook"
    webhook_payload=$(printf '{"url":"%s","secret_token":"%s","allowed_updates":["message"]}' "${webhook_url}" "${TELEGRAM_WEBHOOK_SECRET:-}")

    curl -fsS -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setWebhook" \
        -H 'Content-Type: application/json' \
        -d "${webhook_payload}" \
        | grep -q '"ok":true'

    curl -fsS "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getWebhookInfo" \
        | grep -Fq "\"url\":\"${webhook_url}\""
fi

pm2 save >/dev/null

echo "deploy_ok port=${port} web_pid=${web_pid} worker_pid=${worker_pid}"
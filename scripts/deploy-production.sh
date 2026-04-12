#!/usr/bin/env bash
set -euo pipefail

OFFICIAL_RUNTIME_SOURCE="pm2"
OFFICIAL_APP_NAME="plantoes"
OFFICIAL_WORKER_NAME="plantoes-telegram-worker"
OFFICIAL_PORT="3004"
LEGACY_CONTAINER_NAME="plantoes-app"

fail() {
    echo "[deploy][ERROR] $*" >&2
    exit 1
}

warn() {
    echo "[deploy][WARN] $*" >&2
}

info() {
    echo "[deploy][INFO] $*"
}

resolve_leaf_child_pid() {
    local pid="$1"
    local child_pid=""

    while child_pid="$(ps -o pid= --ppid "$pid" | awk 'NR==1 { gsub(/^[[:space:]]+|[[:space:]]+$/, ""); print }')" \
        && [[ -n "${child_pid}" ]]; do
        pid="$child_pid"
    done

    printf '%s\n' "$pid"
}

collect_descendants() {
    local root_pid="$1"
    local queue="${root_pid}"
    local visited=""

    while [[ -n "${queue}" ]]; do
        local current
        current="${queue%% *}"
        queue="${queue#* }"
        [[ "${current}" == "${queue}" ]] && queue=""

        if [[ " ${visited} " == *" ${current} "* ]]; then
            continue
        fi
        visited="${visited} ${current}"

        local children
        children="$(pgrep -P "${current}" || true)"
        if [[ -n "${children}" ]]; then
            while IFS= read -r child; do
                [[ -z "${child}" ]] && continue
                queue="${queue} ${child}"
            done <<< "${children}"
        fi
    done

    printf '%s\n' ${visited}
}

is_container_running() {
    local name="$1"
    local count
    count="$(docker ps --filter "name=^/${name}$" --filter status=running --format '{{.Names}}' | wc -l | tr -d ' ')"
    [[ "${count}" != "0" ]]
}

ensure_no_legacy_runtime() {
    if is_container_running "${LEGACY_CONTAINER_NAME}"; then
        fail "Container legado '${LEGACY_CONTAINER_NAME}' está ativo. Isso cria runtime concorrente com PM2. Pare/remova o container antes do deploy."
    fi
}

ensure_pm2_singletons() {
    local counts
    counts="$(pm2 jlist | node -e '
const fs = require("fs");
const rows = JSON.parse(fs.readFileSync(0, "utf8"));
const online = rows.filter((row) => row?.pm2_env?.status === "online");
const app = online.filter((row) => row?.name === "plantoes").length;
const worker = online.filter((row) => row?.name === "plantoes-telegram-worker").length;
process.stdout.write(`${app}:${worker}`);
')"

    local app_count="${counts%%:*}"
    local worker_count="${counts##*:}"

    if [[ "${app_count}" -gt 1 || "${worker_count}" -gt 1 ]]; then
        fail "Processos PM2 duplicados detectados (plantoes=${app_count}, worker=${worker_count}). Resolva antes do deploy."
    fi
}

ensure_delivery_mode_consistent() {
    local delivery_mode="${TELEGRAM_DELIVERY_MODE:-webhook}"
    delivery_mode="$(printf '%s' "${delivery_mode}" | tr '[:upper:]' '[:lower:]')"

    if [[ "${OFFICIAL_RUNTIME_SOURCE}" == "pm2" && "${delivery_mode}" == "polling" ]]; then
        fail "TELEGRAM_DELIVERY_MODE=polling conflita com runtime oficial PM2/webhook."
    fi

    if [[ "${delivery_mode}" == "polling" && -n "${TELEGRAM_WEBHOOK_URL:-}" ]]; then
        fail "Configuração ambígua: polling ativo com TELEGRAM_WEBHOOK_URL definido."
    fi
}

ensure_port_not_ambiguous() {
    local app_pid
    app_pid="$(pm2 pid ${OFFICIAL_APP_NAME} 2>/dev/null || true)"

    local listeners
    listeners="$(ss -ltnp | grep ":${OFFICIAL_PORT} " || true)"
    if [[ -z "${listeners}" ]]; then
        return
    fi

    if [[ -n "${app_pid}" && "${app_pid}" != "0" ]]; then
        local app_tree
        app_tree="$(collect_descendants "${app_pid}" | tr '\n' ' ' || true)"
        if [[ "${listeners}" == *"pid=${app_pid},"* ]]; then
            return
        fi
        if [[ -n "${app_tree}" ]]; then
            local child
            for child in ${app_tree}; do
                if [[ "${listeners}" == *"pid=${child},"* ]]; then
                    return
                fi
            done
        fi
    fi

    fail "Porta ${OFFICIAL_PORT} já ocupada por processo fora do runtime oficial PM2."
}

predeploy_checks() {
    info "Executando pre-checks de runtime único"
    command -v pm2 >/dev/null 2>&1 || fail "pm2 não encontrado no PATH."
    command -v docker >/dev/null 2>&1 || fail "docker não encontrado no PATH."

    ensure_no_legacy_runtime
    ensure_pm2_singletons
    ensure_delivery_mode_consistent
    ensure_port_not_ambiguous
}

postdeploy_checks() {
    local expected_webhook_url="$1"

    ensure_no_legacy_runtime
    ensure_pm2_singletons

    local web_pid worker_pid
    web_pid="$(pm2 pid ${OFFICIAL_APP_NAME})"
    worker_pid="$(pm2 pid ${OFFICIAL_WORKER_NAME})"
    [[ -n "${web_pid}" && "${web_pid}" != "0" ]] || fail "Processo PM2 '${OFFICIAL_APP_NAME}' não está ativo."
    [[ -n "${worker_pid}" && "${worker_pid}" != "0" ]] || fail "Processo PM2 '${OFFICIAL_WORKER_NAME}' não está ativo."

    local port
    port="$(tr '\0' '\n' < "/proc/${web_pid}/environ" | sed -n 's/^PORT=//p' | head -n 1)"
    [[ -n "${port}" ]] || port="${OFFICIAL_PORT}"

    curl -fsS "http://127.0.0.1:${port}/api/health" >/dev/null
    curl -fsS "http://127.0.0.1:${port}/api/board" >/dev/null

    if [[ -n "${TELEGRAM_BOT_TOKEN:-}" ]]; then
        local webhook_info webhook_url
        webhook_info="$(curl -fsS "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getWebhookInfo")"
        webhook_url="$(printf '%s' "${webhook_info}" | node -e 'const fs=require("fs");const data=JSON.parse(fs.readFileSync(0,"utf8"));process.stdout.write(data?.result?.url ?? "");')"
        [[ "${webhook_url}" == "${expected_webhook_url}" ]] || fail "Webhook divergente após deploy. Esperado '${expected_webhook_url}', atual '${webhook_url}'."
    fi

    local commit_sha
    commit_sha="${GIT_COMMIT_SHA:-unknown}"
    info "deploy_summary runtime=${OFFICIAL_RUNTIME_SOURCE} commit=${commit_sha} port=${port} app_pid=${web_pid} worker_pid=${worker_pid} webhook=${expected_webhook_url}"
}

cd /home/ubuntu/plantoes

set -a
source .env.production
set +a

GIT_COMMIT_SHA="$(git rev-parse --short HEAD 2>/dev/null || printf 'unknown')"
export GIT_COMMIT_SHA
export RUNTIME_SOURCE_OF_TRUTH="${OFFICIAL_RUNTIME_SOURCE}"
export TELEGRAM_DELIVERY_MODE="webhook"

predeploy_checks

if [[ -z "${DATABASE_URL:-}" ]]; then
    echo "DATABASE_URL is required in .env.production." >&2
    exit 1
fi

npm run build

pm2 delete plantoes >/dev/null 2>&1 || true
pm2 delete plantoes-telegram-worker >/dev/null 2>&1 || true
pm2 start ecosystem.config.cjs --update-env

sleep 4

web_pid="$(pm2 pid plantoes)"
worker_pid="$(pm2 pid plantoes-telegram-worker)"
port="$(tr '\0' '\n' < "/proc/${web_pid}/environ" | sed -n 's/^PORT=//p' | head -n 1)"
worker_leaf_pid="$(resolve_leaf_child_pid "$worker_pid")"

if [[ -z "${port}" ]]; then
    port="3004"
fi

tr '\0' '\n' < "/proc/${worker_leaf_pid}/environ" | grep -q '^DATABASE_URL='

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

postdeploy_checks "${webhook_url:-}"

pm2 save >/dev/null

echo "deploy_ok port=${port} web_pid=${web_pid} worker_pid=${worker_pid}"
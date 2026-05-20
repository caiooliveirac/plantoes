#!/usr/bin/env bash
set -euo pipefail

scenario="${1:-all}"

detect_conflicts() {
    local runtime_source="$1"
    local delivery_mode="$2"
    local legacy_container_running="$3"
    local duplicate_pm2="$4"
    local port_ambiguous="$5"
    local webhook_url="$6"

    local conflicts=()

    if [[ "${runtime_source}" == "pm2" && "${delivery_mode}" == "polling" ]]; then
        conflicts+=("delivery_mode_polling_conflicts_with_pm2")
    fi

    if [[ "${delivery_mode}" == "polling" && -n "${webhook_url}" ]]; then
        conflicts+=("polling_and_webhook_configured")
    fi

    if [[ "${legacy_container_running}" == "1" ]]; then
        conflicts+=("legacy_container_running")
    fi

    if [[ "${duplicate_pm2}" == "1" ]]; then
        conflicts+=("duplicate_pm2_processes")
    fi

    if [[ "${port_ambiguous}" == "1" ]]; then
        conflicts+=("port_occupied_by_non_official_runtime")
    fi

    printf '%s\n' "${conflicts[@]}"
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

run_case() {
    local name="$1"
    local runtime_source="$2"
    local delivery_mode="$3"
    local legacy_container_running="$4"
    local duplicate_pm2="$5"
    local port_ambiguous="$6"
    local webhook_url="$7"
    local expect_conflict="$8"

    echo "[runtime-guard-check] scenario=${name}"
    local out
    out="$(detect_conflicts "${runtime_source}" "${delivery_mode}" "${legacy_container_running}" "${duplicate_pm2}" "${port_ambiguous}" "${webhook_url}" | sed '/^$/d' || true)"

    if [[ -n "${out}" ]]; then
        echo "  conflicts:"
        while IFS= read -r line; do
            [[ -n "${line}" ]] && echo "    - ${line}"
        done <<< "${out}"
    else
        echo "  conflicts: none"
    fi

    if [[ "${expect_conflict}" == "1" && -z "${out}" ]]; then
        echo "  result: FAIL (expected conflict, got none)"
        exit 1
    fi

    if [[ "${expect_conflict}" == "0" && -n "${out}" ]]; then
        echo "  result: FAIL (expected clean state, got conflicts)"
        exit 1
    fi

    echo "  result: OK"
}

run_live_checks() {
    echo "[runtime-guard-check] live-check"

    local legacy_container_running=0
    if command -v docker >/dev/null 2>&1; then
        if docker ps --filter 'name=^/plantoes-app$' --filter status=running --format '{{.Names}}' | grep -q '^plantoes-app$'; then
            legacy_container_running=1
        fi
    fi

    local duplicate_pm2=0
    if command -v pm2 >/dev/null 2>&1; then
        counts="$(pm2 jlist | node -e '
const fs = require("fs");
const rows = JSON.parse(fs.readFileSync(0, "utf8"));
const online = rows.filter((row) => row?.pm2_env?.status === "online");
const app = online.filter((row) => row?.name === "plantoes").length;
const worker = online.filter((row) => row?.name === "plantoes-telegram-worker").length;
process.stdout.write(`${app}:${worker}`);
')"
        app_count="${counts%%:*}"
        worker_count="${counts##*:}"
        if [[ "${app_count}" -gt 1 || "${worker_count}" -gt 1 ]]; then
            duplicate_pm2=1
        fi
    fi

    local port_ambiguous=0
    if ss -ltnp | grep -q ':3004 '; then
        if command -v pm2 >/dev/null 2>&1; then
            app_pid="$(pm2 pid plantoes 2>/dev/null || true)"
            listeners="$(ss -ltnp | grep ':3004 ' || true)"
            if [[ -n "${app_pid}" && "${app_pid}" != "0" ]]; then
                local owns_port=0
                if [[ "${listeners}" == *"pid=${app_pid},"* ]]; then
                    owns_port=1
                else
                    descendants="$(collect_descendants "${app_pid}" || true)"
                    if [[ -n "${descendants}" ]]; then
                        while IFS= read -r child; do
                            [[ -z "${child}" ]] && continue
                            if [[ "${listeners}" == *"pid=${child},"* ]]; then
                                owns_port=1
                                break
                            fi
                        done <<< "${descendants}"
                    fi
                fi

                if [[ "${owns_port}" == "0" ]]; then
                    port_ambiguous=1
                fi
            fi
        fi
    fi

    local delivery_mode="${TELEGRAM_DELIVERY_MODE:-webhook}"
    local webhook_url="${TELEGRAM_WEBHOOK_URL:-}"

    run_case "live-check" "pm2" "${delivery_mode}" "${legacy_container_running}" "${duplicate_pm2}" "${port_ambiguous}" "${webhook_url}" 0
}

if [[ "${scenario}" == "legacy-container" || "${scenario}" == "all" ]]; then
    run_case "legacy-container" "pm2" "webhook" 1 0 0 "https://plantoes.mnrs.com.br/api/telegram/webhook" 1
fi

if [[ "${scenario}" == "duplicate-pm2" || "${scenario}" == "all" ]]; then
    run_case "duplicate-pm2" "pm2" "webhook" 0 1 0 "https://plantoes.mnrs.com.br/api/telegram/webhook" 1
fi

if [[ "${scenario}" == "polling-webhook-conflict" || "${scenario}" == "all" ]]; then
    run_case "polling-webhook-conflict" "pm2" "polling" 0 0 0 "https://plantoes.mnrs.com.br/api/telegram/webhook" 1
fi

if [[ "${scenario}" == "clean" || "${scenario}" == "all" ]]; then
    run_case "clean" "pm2" "webhook" 0 0 0 "https://plantoes.mnrs.com.br/api/telegram/webhook" 0
fi

if [[ "${scenario}" == "live" || "${scenario}" == "all" ]]; then
    run_live_checks
fi

echo "[runtime-guard-check] done"

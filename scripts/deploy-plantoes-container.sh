#!/usr/bin/env bash
set -euo pipefail

APP_NAME="plantoes"
WEB_CONTAINER="plantoes-web"
WORKER_CONTAINER="plantoes-worker"
CANDIDATE_CONTAINER="plantoes-web-candidate"
ENV_FILE="/home/ubuntu/plantoes/.env.production"
STATE_DIR="/var/lib/plantoes-deploy"
CURRENT_DIGEST_FILE="${STATE_DIR}/current_digest"
PREVIOUS_DIGEST_FILE="${STATE_DIR}/previous_digest"
ACTIVE_PORT="3004"
CANDIDATE_PORT="3904"
HEALTH_PATH="/api/health"
HEALTH_TIMEOUT_SECONDS="120"

log() {
  echo "[deploy-container] $*"
}

fail() {
  echo "[deploy-container][ERROR] $*" >&2
  exit 1
}

usage() {
  cat <<EOF
Usage:
  deploy-plantoes-container <image@sha256:digest> [--run-migrations]

Example:
  deploy-plantoes-container ghcr.io/acme/plantoes:sha-abc123@sha256:deadbeef...
EOF
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || fail "Command not found: $1"
}

validate_image_ref() {
  local ref="$1"
  if [[ ! "$ref" =~ ^[a-z0-9./:_-]+@sha256:[a-f0-9]{64}$ ]]; then
    fail "Invalid image reference: '$ref'. Expected image@sha256:<64 hex>."
  fi
}

docker_login_ghcr_if_configured() {
  if [[ -n "${GHCR_USERNAME:-}" && -n "${GHCR_READ_TOKEN:-}" ]]; then
    log "Logging in to GHCR with read-only credentials from host env"
    echo "${GHCR_READ_TOKEN}" | docker login ghcr.io -u "${GHCR_USERNAME}" --password-stdin >/dev/null
  else
    log "GHCR credentials not set in env; using existing Docker auth on host"
  fi
}

inspect_architecture() {
  local ref="$1"
  local arch
  arch="$(docker image inspect "$ref" --format '{{.Architecture}}' 2>/dev/null || true)"
  [[ -n "$arch" ]] || fail "Unable to inspect architecture for $ref"
  [[ "$arch" == "arm64" ]] || fail "Image architecture must be arm64, got '$arch'"
}

wait_for_health() {
  local url="$1"
  local timeout_seconds="$2"
  local started_at now
  started_at="$(date +%s)"

  while true; do
    if curl -fsS "$url" >/dev/null 2>&1; then
      return 0
    fi

    now="$(date +%s)"
    if (( now - started_at >= timeout_seconds )); then
      return 1
    fi
    sleep 2
  done
}

container_image_or_empty() {
  local container="$1"
  docker inspect --format '{{.Config.Image}}' "$container" 2>/dev/null || true
}

stop_and_remove_if_exists() {
  local container="$1"
  if docker ps -a --format '{{.Names}}' | grep -Fxq "$container"; then
    docker rm -f "$container" >/dev/null
  fi
}

run_web_candidate() {
  local image_ref="$1"
  stop_and_remove_if_exists "$CANDIDATE_CONTAINER"

  docker run -d \
    --name "$CANDIDATE_CONTAINER" \
    --env-file "$ENV_FILE" \
    -e NODE_ENV=production \
    -e PORT=3004 \
    -p "127.0.0.1:${CANDIDATE_PORT}:3004" \
    "$image_ref" \
    npm start >/dev/null
}

promote_new_release() {
  local image_ref="$1"

  stop_and_remove_if_exists "$WEB_CONTAINER"
  stop_and_remove_if_exists "$WORKER_CONTAINER"

  docker run -d \
    --name "$WEB_CONTAINER" \
    --restart unless-stopped \
    --env-file "$ENV_FILE" \
    -e NODE_ENV=production \
    -e PORT=3004 \
    -p "127.0.0.1:${ACTIVE_PORT}:3004" \
    "$image_ref" \
    npm start >/dev/null

  docker run -d \
    --name "$WORKER_CONTAINER" \
    --restart unless-stopped \
    --env-file "$ENV_FILE" \
    -e NODE_ENV=production \
    "$image_ref" \
    npm run telegram:worker >/dev/null
}

rollback_previous_release() {
  local previous_web_image="$1"
  local previous_worker_image="$2"

  [[ -n "$previous_web_image" && -n "$previous_worker_image" ]] || fail "Rollback not possible: previous image references are empty"

  log "Rolling back to previous images"
  stop_and_remove_if_exists "$WEB_CONTAINER"
  stop_and_remove_if_exists "$WORKER_CONTAINER"

  docker run -d \
    --name "$WEB_CONTAINER" \
    --restart unless-stopped \
    --env-file "$ENV_FILE" \
    -e NODE_ENV=production \
    -e PORT=3004 \
    -p "127.0.0.1:${ACTIVE_PORT}:3004" \
    "$previous_web_image" \
    npm start >/dev/null

  docker run -d \
    --name "$WORKER_CONTAINER" \
    --restart unless-stopped \
    --env-file "$ENV_FILE" \
    -e NODE_ENV=production \
    "$previous_worker_image" \
    npm run telegram:worker >/dev/null

  wait_for_health "http://127.0.0.1:${ACTIVE_PORT}${HEALTH_PATH}" "$HEALTH_TIMEOUT_SECONDS" \
    || fail "Rollback failed: previous release did not become healthy"
}

cleanup_old_images() {
  local current_ref="$1"
  local previous_ref="$2"

  docker image prune -f --filter dangling=true >/dev/null || true

  local refs
  refs="$(docker images --digests --format '{{.Repository}}@{{.Digest}}' | grep '^ghcr.io/.\+@sha256:' | sort -u || true)"

  while IFS= read -r ref; do
    [[ -z "$ref" ]] && continue
    [[ "$ref" == "$current_ref" ]] && continue
    [[ -n "$previous_ref" && "$ref" == "$previous_ref" ]] && continue
    docker rmi "$ref" >/dev/null 2>&1 || true
  done <<< "$refs"
}

run_migrations_if_requested() {
  local image_ref="$1"
  local run_migrations="$2"

  if [[ "$run_migrations" != "1" ]]; then
    return 0
  fi

  log "Running explicit migration step using pulled image"
  docker run --rm \
    --env-file "$ENV_FILE" \
    -e NODE_ENV=production \
    "$image_ref" \
    npm run db:migrate
}

main() {
  [[ $# -ge 1 ]] || { usage; exit 1; }

  local image_ref="$1"
  shift || true

  local run_migrations=0
  if [[ "${1:-}" == "--run-migrations" ]]; then
    run_migrations=1
  fi

  require_cmd docker
  require_cmd curl
  require_cmd date

  [[ -f "$ENV_FILE" ]] || fail "Missing env file: $ENV_FILE"

  validate_image_ref "$image_ref"

  mkdir -p "$STATE_DIR"

  local previous_web_image previous_worker_image previous_ref
  previous_web_image="$(container_image_or_empty "$WEB_CONTAINER")"
  previous_worker_image="$(container_image_or_empty "$WORKER_CONTAINER")"
  previous_ref="$(cat "$CURRENT_DIGEST_FILE" 2>/dev/null || true)"

  docker_login_ghcr_if_configured

  log "Pulling image $image_ref"
  docker pull "$image_ref" >/dev/null

  inspect_architecture "$image_ref"

  run_migrations_if_requested "$image_ref" "$run_migrations"

  log "Starting candidate container on 127.0.0.1:${CANDIDATE_PORT}"
  run_web_candidate "$image_ref"

  if ! wait_for_health "http://127.0.0.1:${CANDIDATE_PORT}${HEALTH_PATH}" "$HEALTH_TIMEOUT_SECONDS"; then
    docker logs --tail 200 "$CANDIDATE_CONTAINER" || true
    stop_and_remove_if_exists "$CANDIDATE_CONTAINER"
    fail "Candidate health check failed"
  fi

  log "Promoting candidate image"
  stop_and_remove_if_exists "$CANDIDATE_CONTAINER"
  promote_new_release "$image_ref"

  if ! wait_for_health "http://127.0.0.1:${ACTIVE_PORT}${HEALTH_PATH}" "$HEALTH_TIMEOUT_SECONDS"; then
    docker logs --tail 200 "$WEB_CONTAINER" || true
    docker logs --tail 200 "$WORKER_CONTAINER" || true

    if [[ -n "$previous_web_image" && -n "$previous_worker_image" ]]; then
      rollback_previous_release "$previous_web_image" "$previous_worker_image"
    fi

    fail "New release failed health check after promotion"
  fi

  if [[ -n "$previous_ref" ]]; then
    echo "$previous_ref" > "$PREVIOUS_DIGEST_FILE"
  fi
  echo "$image_ref" > "$CURRENT_DIGEST_FILE"

  cleanup_old_images "$image_ref" "$previous_ref"

  log "Deploy completed successfully"
  log "active_image=$image_ref"
  log "previous_image=${previous_ref:-none}"
}

main "$@"

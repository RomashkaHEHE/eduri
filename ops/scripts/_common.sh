#!/usr/bin/env bash

set -Eeuo pipefail
umask 077

readonly EDURI_APP_ROOT="/home/user1/eduri"
readonly EDURI_DATA_DIR="$EDURI_APP_ROOT/data"
readonly EDURI_BACKUP_DIR="$EDURI_APP_ROOT/backups"
readonly EDURI_COMPOSE_FILE="$EDURI_APP_ROOT/docker-compose.yml"
readonly EDURI_LOCK_FILE="$EDURI_APP_ROOT/.maintenance.lock"
readonly EDURI_HEALTH_URL="http://127.0.0.1:3020/api/health"
readonly EDURI_LIVEKIT_HEALTH_URL="http://127.0.0.1:7880/"
readonly EDURI_SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"

die() {
    printf 'ERROR: %s\n' "$*" >&2
    exit 1
}

require_command() {
    command -v "$1" >/dev/null 2>&1 || die "required command is missing: $1"
}

assert_production_layout() {
    require_command realpath
    [[ -d "$EDURI_APP_ROOT" ]] || die "application directory does not exist: $EDURI_APP_ROOT"
    [[ "$(realpath -e -- "$EDURI_APP_ROOT")" == "$EDURI_APP_ROOT" ]] \
        || die "application directory must be the real path $EDURI_APP_ROOT"
    [[ -f "$EDURI_COMPOSE_FILE" ]] || die "missing $EDURI_COMPOSE_FILE"
    [[ ! -L "$EDURI_DATA_DIR" ]] || die "data directory must not be a symlink"
    [[ ! -L "$EDURI_BACKUP_DIR" ]] || die "backup directory must not be a symlink"

    mkdir -p -- "$EDURI_DATA_DIR" "$EDURI_BACKUP_DIR"
    [[ "$(realpath -e -- "$EDURI_DATA_DIR")" == "$EDURI_DATA_DIR" ]] \
        || die "unexpected data directory target"
    [[ "$(realpath -e -- "$EDURI_BACKUP_DIR")" == "$EDURI_BACKUP_DIR" ]] \
        || die "unexpected backup directory target"
}

acquire_maintenance_lock() {
    require_command flock
    require_command readlink

    if [[ "${EDURI_MAINTENANCE_LOCK_HELD:-0}" == "1" && -e "/proc/$$/fd/9" ]]; then
        local inherited_target
        inherited_target="$(readlink -f -- "/proc/$$/fd/9")"
        [[ "$inherited_target" == "$EDURI_LOCK_FILE" ]] \
            || die "inherited maintenance lock points to an unexpected file"
        return
    fi

    exec 9>"$EDURI_LOCK_FILE"
    flock -w 120 9 || die "another Eduri maintenance operation is running"
    export EDURI_MAINTENANCE_LOCK_HELD=1
}

compose() {
    docker compose --project-directory "$EDURI_APP_ROOT" \
        --file "$EDURI_COMPOSE_FILE" "$@"
}

app_is_running() {
    compose ps --status running --services 2>/dev/null | grep -Fxq app
}

wait_for_app_health() {
    local attempts="${1:-30}"
    local delay_seconds="${2:-2}"
    local attempt

    require_command curl
    for ((attempt = 1; attempt <= attempts; attempt++)); do
        if curl --fail --silent --show-error --max-time 3 \
            "$EDURI_HEALTH_URL" >/dev/null 2>&1; then
            return 0
        fi
        sleep "$delay_seconds"
    done
    return 1
}

wait_for_livekit_health() {
    local attempts="${1:-30}"
    local delay_seconds="${2:-2}"
    local attempt

    require_command curl
    for ((attempt = 1; attempt <= attempts; attempt++)); do
        if curl --fail --silent --show-error --max-time 3 \
            "$EDURI_LIVEKIT_HEALTH_URL" >/dev/null 2>&1; then
            return 0
        fi
        sleep "$delay_seconds"
    done
    return 1
}

wait_for_compose_service_health() {
    local service_name="$1"
    local attempts="${2:-30}"
    local delay_seconds="${3:-2}"
    local attempt container_id health_status

    for ((attempt = 1; attempt <= attempts; attempt++)); do
        container_id="$(compose ps --quiet "$service_name" 2>/dev/null || true)"
        if [[ -n "$container_id" ]]; then
            health_status="$(docker inspect --format \
                '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' \
                "$container_id" 2>/dev/null || true)"
            [[ "$health_status" == "healthy" ]] && return 0
            [[ "$health_status" == "exited" || "$health_status" == "dead" ]] && return 1
        fi
        sleep "$delay_seconds"
    done
    return 1
}

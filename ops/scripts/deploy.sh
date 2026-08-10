#!/usr/bin/env bash
set -Eeuo pipefail

readonly SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=_common.sh
source "$SCRIPT_DIR/_common.sh"

for command_name in cmp curl docker find grep id; do
    require_command "$command_name"
done

readonly EDGE_CONFIG_INSTALLER="$SCRIPT_DIR/install-edge-config.sh"
readonly NGINX_SOURCE="$EDURI_APP_ROOT/ops/nginx/eduri.ru.conf"
readonly HOOK_SOURCE="$EDURI_APP_ROOT/ops/certbot/reload-nginx.sh"
readonly NGINX_TARGET="/etc/nginx/sites-available/eduri.ru"
readonly HOOK_TARGET="/etc/letsencrypt/renewal-hooks/deploy/reload-nginx"
[[ -f "$EDGE_CONFIG_INSTALLER" && ! -L "$EDGE_CONFIG_INSTALLER" ]] \
    || die "missing edge configuration installer: $EDGE_CONFIG_INSTALLER"

edge_config_is_current() {
    [[ -f "$NGINX_SOURCE" && ! -L "$NGINX_SOURCE" \
        && -f "$HOOK_SOURCE" && ! -L "$HOOK_SOURCE" \
        && -f "$NGINX_TARGET" && ! -L "$NGINX_TARGET" \
        && -f "$HOOK_TARGET" && ! -L "$HOOK_TARGET" ]] \
        && cmp --silent -- "$NGINX_SOURCE" "$NGINX_TARGET" \
        && cmp --silent -- "$HOOK_SOURCE" "$HOOK_TARGET"
}

if ((EUID == 0)); then
    if ! edge_config_is_current; then
        bash "$EDGE_CONFIG_INSTALLER"
    fi
    die "edge configuration is current; rerun deploy.sh as user1 to preserve data ownership"
fi
[[ "$(id -un)" == "user1" ]] || die "run deploy.sh as user1"
edge_config_is_current \
    || die "edge configuration is stale; as root run: bash $EDGE_CONFIG_INSTALLER"

assert_production_layout
acquire_maintenance_lock

env_file="$EDURI_APP_ROOT/.env"
[[ -f "$env_file" ]] || die "missing production environment file: $env_file"
[[ -z "$(find "$env_file" -maxdepth 0 -perm /077 -print -quit)" ]] \
    || die "$env_file must not be readable or writable by group/others (use chmod 600)"
grep -Eq '^NODE_ENV=production[[:space:]]*$' "$env_file" \
    || die "NODE_ENV=production is required in .env"
grep -Eq '^APP_ORIGIN=https://eduri\.ru/?[[:space:]]*$' "$env_file" \
    || die "APP_ORIGIN=https://eduri.ru is required in .env"
grep -Eq '^TRUST_PROXY=10\.253\.0\.1[[:space:]]*$' "$env_file" \
    || die "TRUST_PROXY must name the exact Compose nginx gateway 10.253.0.1"
grep -Eq '^LIVEKIT_URL=wss://eduri\.ru/livekit/?[[:space:]]*$' "$env_file" \
    || die "LIVEKIT_URL=wss://eduri.ru/livekit is required in .env"
for variable_name in LIVEKIT_API_KEY LIVEKIT_API_SECRET; do
    grep -Eq "^${variable_name}=.+$" "$env_file" \
        || die "$variable_name must be configured in .env"
done
if grep -Eq 'replace-with|change-me' "$env_file"; then
    die ".env still contains a placeholder credential"
fi

compose config --quiet
compose build --pull app
compose pull livekit clamav
compose up --detach --remove-orphans clamav livekit

if ! wait_for_compose_service_health clamav 180 2; then
    compose ps clamav >&2 || true
    compose logs --tail 100 clamav >&2 || true
    die "deployment failed its malware scanner health check; Code blobs remain fail-closed"
fi

if ! wait_for_livekit_health 45 2; then
    compose ps livekit >&2 || true
    compose logs --tail 100 livekit >&2 || true
    die "deployment failed the LiveKit health check before cutover"
fi

if [[ -f "$EDURI_DATA_DIR/eduri.sqlite" ]]; then
    bash "$SCRIPT_DIR/backup.sh" --leave-stopped
else
    printf 'No production database exists yet; creating an explicit bootstrap backup.\n'
    bash "$SCRIPT_DIR/backup.sh" --allow-empty --leave-stopped
fi

compose up --detach --remove-orphans app

if ! wait_for_app_health 45 2; then
    compose ps app >&2 || true
    compose logs --tail 100 app >&2 || true
    die "deployment failed its health check; the pre-deploy backup is retained"
fi

if ! wait_for_livekit_health 45 2; then
    compose ps livekit >&2 || true
    compose logs --tail 100 livekit >&2 || true
    die "deployment failed the LiveKit health check; the application remains available"
fi

printf 'Deployment healthy: https://eduri.ru (app + ClamAV + LiveKit)\n'

#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

readonly APP_ROOT="/home/user1/eduri"
readonly SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
readonly OPS_DIR="$(cd -- "$SCRIPT_DIR/.." && pwd -P)"
readonly NGINX_SOURCE="$OPS_DIR/nginx/eduri.ru.conf"
readonly HOOK_SOURCE="$OPS_DIR/certbot/reload-nginx.sh"
readonly SITE_AVAILABLE="/etc/nginx/sites-available/eduri.ru"
readonly SITE_ENABLED="/etc/nginx/sites-enabled/eduri.ru"
readonly HOOK_TARGET="/etc/letsencrypt/renewal-hooks/deploy/reload-nginx"

die() {
    printf 'ERROR: %s\n' "$*" >&2
    exit 1
}

[[ $EUID -eq 0 ]] || die "run this installer as root"
for command_name in cmp install mktemp mv nginx readlink realpath rm systemctl; do
    command -v "$command_name" >/dev/null 2>&1 \
        || die "required command is missing: $command_name"
done

[[ "$(realpath -e -- "$OPS_DIR")" == "$APP_ROOT/ops" ]] \
    || die "operations directory must be $APP_ROOT/ops"
for source_file in "$NGINX_SOURCE" "$HOOK_SOURCE"; do
    [[ -f "$source_file" && ! -L "$source_file" ]] \
        || die "source must be a regular non-symlink file: $source_file"
done
/bin/sh -n "$HOOK_SOURCE" || die "Certbot deploy hook has invalid shell syntax"

[[ -f "$SITE_AVAILABLE" && ! -L "$SITE_AVAILABLE" ]] \
    || die "$SITE_AVAILABLE must already be a regular non-symlink file"
[[ -L "$SITE_ENABLED" ]] \
    || die "$SITE_ENABLED must already be the enabled-site symlink"
[[ "$(readlink -f -- "$SITE_ENABLED")" == "$SITE_AVAILABLE" ]] \
    || die "$SITE_ENABLED points somewhere unexpected"
[[ -d "$(dirname -- "$HOOK_TARGET")" ]] \
    || die "Certbot deploy-hook directory is missing; run install-tls.sh first"
if [[ -e "$HOOK_TARGET" || -L "$HOOK_TARGET" ]]; then
    [[ -f "$HOOK_TARGET" && ! -L "$HOOK_TARGET" ]] \
        || die "$HOOK_TARGET must be a regular non-symlink file"
fi

nginx_changed=0
nginx_backup=""
nginx_candidate=""
hook_candidate=""

restore_nginx_config() {
    local restore_candidate

    [[ $nginx_changed -eq 1 && -n "$nginx_backup" ]] || return 0
    restore_candidate="$(mktemp "$(dirname -- "$SITE_AVAILABLE")/.eduri.ru.restore.XXXXXX")" \
        || return 1
    if ! install -m 0644 "$nginx_backup" "$restore_candidate" \
        || ! mv -fT -- "$restore_candidate" "$SITE_AVAILABLE"; then
        rm -f -- "$restore_candidate"
        return 1
    fi
    nginx_changed=0
}

cleanup() {
    local status=$?

    trap - EXIT
    if [[ $status -ne 0 && $nginx_changed -eq 1 ]]; then
        printf 'Restoring the previous nginx configuration.\n' >&2
        if restore_nginx_config && nginx -t && systemctl reload nginx; then
            printf 'Previous nginx configuration restored.\n' >&2
        else
            printf 'ERROR: automatic nginx rollback failed; inspect nginx immediately.\n' >&2
            status=1
        fi
    fi
    [[ -z "$nginx_candidate" ]] || rm -f -- "$nginx_candidate"
    [[ -z "$hook_candidate" ]] || rm -f -- "$hook_candidate"
    [[ -z "$nginx_backup" ]] || rm -f -- "$nginx_backup"
    exit "$status"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

if ! cmp --silent -- "$NGINX_SOURCE" "$SITE_AVAILABLE"; then
    nginx_backup="$(mktemp /run/eduri-nginx-backup.XXXXXX)"
    install -m 0644 "$SITE_AVAILABLE" "$nginx_backup"
    nginx_candidate="$(mktemp "$(dirname -- "$SITE_AVAILABLE")/.eduri.ru.candidate.XXXXXX")"
    install -m 0644 "$NGINX_SOURCE" "$nginx_candidate"
    nginx_changed=1
    mv -fT -- "$nginx_candidate" "$SITE_AVAILABLE"
    nginx_candidate=""
fi

nginx -t
systemctl reload nginx

if [[ ! -e "$HOOK_TARGET" ]] || ! cmp --silent -- "$HOOK_SOURCE" "$HOOK_TARGET"; then
    hook_candidate="$(mktemp "$(dirname -- "$(dirname -- "$HOOK_TARGET")")/.reload-nginx.candidate.XXXXXX")"
    install -m 0755 "$HOOK_SOURCE" "$hook_candidate"
    mv -fT -- "$hook_candidate" "$HOOK_TARGET"
    hook_candidate=""
fi
nginx_changed=0

printf 'nginx configuration and Certbot deploy hook are synchronized.\n'

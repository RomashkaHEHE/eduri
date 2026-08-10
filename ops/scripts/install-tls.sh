#!/usr/bin/env bash
set -Eeuo pipefail

readonly DOMAIN="eduri.ru"
readonly WEBROOT="/var/www/certbot"
readonly SITE_AVAILABLE="/etc/nginx/sites-available/eduri.ru"
readonly SITE_ENABLED="/etc/nginx/sites-enabled/eduri.ru"
readonly SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
readonly OPS_DIR="$(cd -- "$SCRIPT_DIR/.." && pwd -P)"

usage() {
    printf 'Usage: sudo %s (--email admin@example.com | --no-email)\n' "$0" >&2
}

die() {
    printf 'ERROR: %s\n' "$*" >&2
    exit 1
}

email=""
no_email=0
while (($# > 0)); do
    case "$1" in
        --email)
            (($# >= 2)) || die "--email requires a value"
            email="$2"
            shift 2
            ;;
        --no-email)
            no_email=1
            shift
            ;;
        -h|--help)
            usage
            exit 0
            ;;
        *)
            usage
            die "unknown argument: $1"
            ;;
    esac
done

[[ $EUID -eq 0 ]] || die "run this script as root"
if [[ -n "$email" && $no_email -eq 1 ]]; then
    die "use either --email or --no-email, not both"
fi
if [[ -n "$email" ]]; then
    [[ "$email" == *@*.* ]] || die "provide a valid operational email"
elif [[ $no_email -ne 1 ]]; then
    die "provide --email (preferred) or explicitly choose --no-email"
fi
[[ -f "$OPS_DIR/nginx/eduri.ru.bootstrap.conf" ]] || die "bootstrap nginx config is missing"
[[ -f "$OPS_DIR/nginx/eduri.ru.conf" ]] || die "TLS nginx config is missing"
[[ -f "$OPS_DIR/certbot/reload-nginx.sh" ]] || die "Certbot deploy hook is missing"
[[ -f "$SCRIPT_DIR/install-edge-config.sh" ]] || die "edge configuration installer is missing"

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y --no-install-recommends nginx certbot ca-certificates

install -d -m 0755 "$WEBROOT/.well-known/acme-challenge"
install -m 0644 "$OPS_DIR/nginx/eduri.ru.bootstrap.conf" "$SITE_AVAILABLE"

if [[ -e "$SITE_ENABLED" || -L "$SITE_ENABLED" ]]; then
    [[ "$(readlink -f -- "$SITE_ENABLED")" == "$SITE_AVAILABLE" ]] \
        || die "$SITE_ENABLED exists and points elsewhere; inspect it manually"
else
    ln -s "$SITE_AVAILABLE" "$SITE_ENABLED"
fi

nginx -t
systemctl enable --now nginx
systemctl reload nginx

certbot_args=(
    certonly
    --webroot
    --webroot-path "$WEBROOT"
    --cert-name "$DOMAIN"
    --domain "$DOMAIN"
    --agree-tos
    --keep-until-expiring
    --non-interactive
)
if [[ -n "$email" ]]; then
    certbot_args+=(--email "$email" --no-eff-email)
else
    certbot_args+=(--register-unsafely-without-email)
fi
certbot "${certbot_args[@]}"

bash "$SCRIPT_DIR/install-edge-config.sh"
systemctl enable --now certbot.timer

printf 'TLS is configured for https://%s\n' "$DOMAIN"
printf 'Run "certbot renew --dry-run --run-deploy-hooks" after DNS and firewall checks.\n'

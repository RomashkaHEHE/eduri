#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

readonly APP_ROOT=/home/user1/eduri
readonly SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
readonly INSTALL_ROOT=/usr/local/libexec/eduri
readonly GENERATIONS_ROOT="$INSTALL_ROOT/generations"
readonly CURRENT_LINK="$INSTALL_ROOT/current"
readonly RECEIVER_TARGET="$CURRENT_LINK/cd-receive.sh"
readonly STATE_ROOT=/var/lib/eduri-cd
readonly MARKER_LINK="$STATE_ROOT/deployed-sha"
readonly QUEUE_LOCK="$STATE_ROOT/queue.lock"
readonly AUTHORIZED_KEYS=/root/.ssh/authorized_keys
readonly KEY_MARKER=eduri-production-cd
readonly RECONCILE_SOURCE="$APP_ROOT/ops/systemd/eduri-cd-reconcile.service"
readonly RECONCILE_TARGET=/etc/systemd/system/eduri-cd-reconcile.service
readonly NGINX_DEPENDENCY_SOURCE="$APP_ROOT/ops/systemd/nginx.service.d/eduri-cd-reconcile.conf"
readonly NGINX_DEPENDENCY_ROOT=/etc/systemd/system/nginx.service.d
readonly NGINX_DEPENDENCY_TARGET="$NGINX_DEPENDENCY_ROOT/eduri-cd-reconcile.conf"
readonly -a HELPER_NAMES=(
    cd-receive.sh
    cd-worker.sh
    cd-validate-helpers.sh
    install-edge-config.sh
    validate_cd_release.py
)

generation_path=""
current_candidate=""
marker_candidate=""
authorized_candidate=""
reconcile_candidate=""
nginx_dependency_candidate=""
marker_needs_install=0
nginx_dependency_content=""

die() {
    printf 'ERROR: %s\n' "$*" >&2
    exit 1
}

cleanup() {
    local status=$?
    trap - EXIT
    set +e
    [[ -z "$current_candidate" ]] || rm -f -- "$current_candidate"
    [[ -z "$marker_candidate" ]] || rm -f -- "$marker_candidate"
    [[ -z "$authorized_candidate" ]] || rm -f -- "$authorized_candidate"
    [[ -z "$reconcile_candidate" ]] || rm -f -- "$reconcile_candidate"
    [[ -z "$nginx_dependency_candidate" ]] \
        || rm -f -- "$nginx_dependency_candidate"
    if [[ -n "$generation_path" ]]; then
        case "$generation_path" in
            "$GENERATIONS_ROOT"/.bootstrap.*) rm -rf -- "$generation_path" ;;
        esac
    fi
    exit "$status"
}
trap cleanup EXIT

[[ $EUID -eq 0 ]] || die "run this installer as root"
[[ $# -eq 2 ]] || die "usage: $0 PUBLIC_KEY_FILE DEPLOYED_SHA"
readonly bootstrap_sha="$2"
[[ "$bootstrap_sha" =~ ^[0-9a-f]{40}$ ]] \
    || die "DEPLOYED_SHA must be the exact 40-character production revision"
for command_name in \
    awk basename bash cat chmod chown flock head install ln mktemp mv python3 realpath \
    readlink rm ssh-keygen stat sync systemctl systemd-analyze; do
    command -v "$command_name" >/dev/null 2>&1 \
        || die "required command is missing: $command_name"
done
[[ -x /bin/bash ]] || die "required command is missing: /bin/bash"
[[ "$(realpath -e -- "$SCRIPT_DIR")" == "$APP_ROOT/ops/scripts" ]] \
    || die "installer must run from $APP_ROOT"
for helper_name in "${HELPER_NAMES[@]}"; do
    source_file="$SCRIPT_DIR/$helper_name"
    [[ -f "$source_file" && ! -L "$source_file" ]] \
        || die "missing regular source file: $source_file"
done
[[ -f "$RECONCILE_SOURCE" && ! -L "$RECONCILE_SOURCE" ]] \
    || die "missing regular systemd unit: $RECONCILE_SOURCE"
[[ -f "$NGINX_DEPENDENCY_SOURCE" && ! -L "$NGINX_DEPENDENCY_SOURCE" ]] \
    || die "missing regular nginx dependency drop-in: $NGINX_DEPENDENCY_SOURCE"
nginx_dependency_content="$(cat -- "$NGINX_DEPENDENCY_SOURCE")"
[[ "$nginx_dependency_content" \
    == $'[Unit]\nRequires=eduri-cd-reconcile.service\nAfter=eduri-cd-reconcile.service' ]] \
    || die "nginx dependency drop-in has an unexpected contract"

public_key_file="$(realpath -e -- "$1")"
[[ -f "$public_key_file" && ! -L "$public_key_file" ]] \
    || die "public key must be a regular non-symlink file"
read -r key_type key_body key_comment extra <"$public_key_file" \
    || die "cannot read public key"
key_comment="${key_comment%$'\r'}"
[[ "$key_type" == "ssh-ed25519" && -n "$key_body" \
    && "$key_comment" == "$KEY_MARKER" && -z "${extra:-}" ]] \
    || die "only the dedicated commented Ed25519 public key is accepted"
printf '%s %s\n' "$key_type" "$key_body" | ssh-keygen -l -f - >/dev/null \
    || die "invalid Ed25519 public key"
if [[ -e "$MARKER_LINK" || -L "$MARKER_LINK" ]]; then
    if [[ -L "$MARKER_LINK" ]]; then
        [[ "$(readlink -- "$MARKER_LINK")" == "$CURRENT_LINK/deployed-sha" ]] \
            || die "$MARKER_LINK must be the managed deployment marker symlink"
        [[ -f "$MARKER_LINK" \
            && "$(stat -Lc '%U:%G:%a:%s' "$MARKER_LINK")" \
                == "root:root:644:41" ]] \
            || die "$MARKER_LINK managed marker target is unsafe"
        marker_value="$(head -n 2 -- "$MARKER_LINK")"
        [[ "$marker_value" == "$bootstrap_sha" ]] \
            || die "$MARKER_LINK managed marker does not match DEPLOYED_SHA"
    else
        [[ -f "$MARKER_LINK" \
            && "$(stat -c '%U:%G:%a:%s' "$MARKER_LINK")" \
                == "root:root:644:41" ]] \
            || die "$MARKER_LINK legacy marker is unsafe"
        marker_value="$(head -n 2 -- "$MARKER_LINK")"
        [[ "$marker_value" == "$bootstrap_sha" ]] \
            || die "$MARKER_LINK legacy marker does not match DEPLOYED_SHA"
        marker_needs_install=1
    fi
else
    marker_needs_install=1
fi

install -d -o root -g root -m 0755 \
    /usr/local/libexec "$INSTALL_ROOT" "$GENERATIONS_ROOT" /etc/eduri
install -d -o root -g root -m 0700 "$STATE_ROOT" "$STATE_ROOT/jobs" \
    "$STATE_ROOT/recovery" /root/.ssh
exec 8>"$QUEUE_LOCK"
flock -w 120 8 || die "another deployment operation is active"
generation_path="$(mktemp -d "$GENERATIONS_ROOT/.bootstrap.XXXXXXXX")"
for helper_name in "${HELPER_NAMES[@]}"; do
    install -o root -g root -m 0755 "$SCRIPT_DIR/$helper_name" \
        "$generation_path/$helper_name"
    sync -f "$generation_path/$helper_name"
done
/bin/bash "$SCRIPT_DIR/cd-validate-helpers.sh" "$generation_path"
/bin/bash "$SCRIPT_DIR/install-edge-config.sh"

printf '%s\n' "$bootstrap_sha" >"$generation_path/deployed-sha"
chmod 0644 "$generation_path/deployed-sha"
sync -f "$generation_path/deployed-sha"
sync -f "$generation_path"
sync -f "$GENERATIONS_ROOT"

current_candidate="$INSTALL_ROOT/.current.$$"
ln -s -- "generations/$(basename -- "$generation_path")" "$current_candidate"
mv -fT -- "$current_candidate" "$CURRENT_LINK"
current_candidate=""
sync -f "$INSTALL_ROOT"
generation_path=""

if [[ $marker_needs_install -eq 1 ]]; then
    marker_candidate="$STATE_ROOT/.deployed-sha.$$"
    ln -s -- "$CURRENT_LINK/deployed-sha" "$marker_candidate"
    mv -fT -- "$marker_candidate" "$MARKER_LINK"
    marker_candidate=""
    sync -f "$STATE_ROOT"
fi

install -d -o root -g root -m 0755 "$NGINX_DEPENDENCY_ROOT"
nginx_dependency_candidate="$(mktemp "$NGINX_DEPENDENCY_ROOT/.eduri-cd-reconcile.XXXXXXXX")"
install -o root -g root -m 0644 \
    "$NGINX_DEPENDENCY_SOURCE" "$nginx_dependency_candidate"
sync -f "$nginx_dependency_candidate"
mv -fT -- "$nginx_dependency_candidate" "$NGINX_DEPENDENCY_TARGET"
nginx_dependency_candidate=""
sync -f "$NGINX_DEPENDENCY_ROOT"

reconcile_candidate="$(mktemp /etc/systemd/system/.eduri-cd-reconcile.XXXXXXXX)"
install -o root -g root -m 0644 "$RECONCILE_SOURCE" "$reconcile_candidate"
sync -f "$reconcile_candidate"
mv -fT -- "$reconcile_candidate" "$RECONCILE_TARGET"
reconcile_candidate=""
sync -f /etc/systemd/system
systemctl daemon-reload
systemd-analyze verify eduri-cd-reconcile.service nginx.service >/dev/null \
    || die "invalid CD reconciliation systemd dependency"
systemctl enable eduri-cd-reconcile.service >/dev/null
sync -f /etc/systemd/system/multi-user.target.wants
sync -f /etc/systemd/system

if [[ -e "$AUTHORIZED_KEYS" || -L "$AUTHORIZED_KEYS" ]]; then
    [[ -f "$AUTHORIZED_KEYS" && ! -L "$AUTHORIZED_KEYS" ]] \
        || die "$AUTHORIZED_KEYS must be a regular non-symlink file"
fi
authorized_candidate="$(mktemp /root/.ssh/.authorized_keys.XXXXXXXX)"
if [[ -f "$AUTHORIZED_KEYS" ]]; then
    awk -v marker="$KEY_MARKER" '$NF != marker' "$AUTHORIZED_KEYS" \
        >"$authorized_candidate"
fi
printf 'restrict,command="%s" %s %s %s\n' \
    "$RECEIVER_TARGET" "$key_type" "$key_body" "$KEY_MARKER" \
    >>"$authorized_candidate"
chmod 0600 "$authorized_candidate"
chown root:root "$authorized_candidate"
sync -f "$authorized_candidate"
mv -fT -- "$authorized_candidate" "$AUTHORIZED_KEYS"
authorized_candidate=""
sync -f /root/.ssh

printf 'Installed restricted Eduri production CD key.\n'

#!/usr/bin/env bash
set -Eeuo pipefail

readonly APP_ROOT="/home/user1/eduri"
readonly SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
readonly OPS_DIR="$(cd -- "$SCRIPT_DIR/.." && pwd -P)"

die() {
    printf 'ERROR: %s\n' "$*" >&2
    exit 1
}

run_now=0
while (($# > 0)); do
    case "$1" in
        --run-now)
            run_now=1
            shift
            ;;
        -h|--help)
            printf 'Usage: sudo %s [--run-now]\n' "$0"
            exit 0
            ;;
        *)
            die "unknown argument: $1"
            ;;
    esac
done

[[ $EUID -eq 0 ]] || die "run this script as root"
id user1 >/dev/null 2>&1 || die "system user user1 does not exist"
[[ "$(realpath -e -- "$APP_ROOT")" == "$APP_ROOT" ]] \
    || die "$APP_ROOT must exist and must not be a symlink"
[[ -f "$OPS_DIR/systemd/eduri-backup.service" ]] || die "backup service file is missing"
[[ -f "$OPS_DIR/systemd/eduri-backup.timer" ]] || die "backup timer file is missing"
[[ -f "$OPS_DIR/systemd/eduri-storage.service" ]] || die "storage service file is missing"
[[ -f "$OPS_DIR/systemd/eduri-storage.timer" ]] || die "storage timer file is missing"
[[ -f "$SCRIPT_DIR/storage-maintenance.py" ]] || die "storage maintenance script is missing"
command -v python3 >/dev/null || die "python3 is required"
docker buildx prune --help | grep -q -- '--max-used-space' \
    || die "Docker Buildx with bounded cache pruning is required"
python3 -m py_compile "$SCRIPT_DIR/storage-maintenance.py"

install -d -o user1 -g user1 -m 0700 "$APP_ROOT/backups"
touch -- "$APP_ROOT/.maintenance.lock"
chown user1:user1 "$APP_ROOT/.maintenance.lock"
chmod 0600 "$APP_ROOT/.maintenance.lock"
install -m 0644 "$OPS_DIR/systemd/eduri-backup.service" \
    /etc/systemd/system/eduri-backup.service
install -m 0644 "$OPS_DIR/systemd/eduri-backup.timer" \
    /etc/systemd/system/eduri-backup.timer
install -d -o root -g root -m 0755 /usr/local/libexec/eduri
install -d -o root -g root -m 0700 /var/lib/eduri-cd
install -o root -g root -m 0644 "$SCRIPT_DIR/storage-maintenance.py" \
    /usr/local/libexec/eduri/storage-maintenance.py
install -m 0644 "$OPS_DIR/systemd/eduri-storage.service" \
    /etc/systemd/system/eduri-storage.service
install -m 0644 "$OPS_DIR/systemd/eduri-storage.timer" \
    /etc/systemd/system/eduri-storage.timer

systemctl daemon-reload
systemctl enable --now eduri-backup.timer
systemctl enable --now eduri-storage.timer

if [[ $run_now -eq 1 ]]; then
    systemctl start eduri-backup.service
    systemctl start eduri-storage.service
fi

systemctl --no-pager list-timers eduri-backup.timer eduri-storage.timer

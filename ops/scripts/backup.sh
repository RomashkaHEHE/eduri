#!/usr/bin/env bash
set -Eeuo pipefail

readonly SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=_common.sh
source "$SCRIPT_DIR/_common.sh"

allow_empty=0
leave_stopped=0
while (($# > 0)); do
    case "$1" in
        --allow-empty)
            allow_empty=1
            ;;
        --leave-stopped)
            leave_stopped=1
            ;;
        *)
            printf 'Usage: %s [--allow-empty] [--leave-stopped]\n' "$0" >&2
            exit 2
            ;;
    esac
    shift
done

for command_name in docker tar sha256sum find grep rm; do
    require_command "$command_name"
done
assert_production_layout
acquire_maintenance_lock
compose config --quiet

if [[ ! -f "$EDURI_DATA_DIR/eduri.sqlite" && $allow_empty -ne 1 ]]; then
    die "production database is missing: $EDURI_DATA_DIR/eduri.sqlite"
fi

symlink_path="$(find "$EDURI_DATA_DIR" -type l -print -quit)"
[[ -z "$symlink_path" ]] || die "refusing to archive symlink in data directory: $symlink_path"

timestamp="$(date -u +'%Y%m%dT%H%M%S%NZ')"
archive_name="eduri-data-${timestamp}-$$.tar.gz"
archive_path="$EDURI_BACKUP_DIR/$archive_name"
partial_path="$archive_path.partial"
checksum_path="$archive_path.sha256"
metadata_path="$archive_path.meta"
was_running=0
app_stopped=0

if app_is_running; then
    was_running=1
fi

cleanup() {
    local status=$?
    trap - EXIT INT TERM
    if [[ $app_stopped -eq 1 && $was_running -eq 1 ]]; then
        compose start app >/dev/null || true
    fi
    [[ ! -e "$partial_path" ]] || rm -f -- "$partial_path"
    exit "$status"
}
trap cleanup EXIT INT TERM

if [[ $was_running -eq 1 ]]; then
    compose stop --timeout 30 app
    app_stopped=1
fi

: >"$partial_path"
chmod 0600 "$partial_path"
tar --create --gzip --file "$partial_path" \
    --directory "$EDURI_APP_ROOT" data
mv -- "$partial_path" "$archive_path"
chmod 0600 "$archive_path"

(
    cd -- "$EDURI_BACKUP_DIR"
    sha256sum "$archive_name" >"$archive_name.sha256"
)
chmod 0600 "$checksum_path"

compose_digest="$(sha256sum "$EDURI_COMPOSE_FILE" | awk '{print $1}')"
{
    printf 'created_utc=%s\n' "$timestamp"
    printf 'source=%s\n' "$EDURI_DATA_DIR"
    printf 'compose_sha256=%s\n' "$compose_digest"
    printf 'consistency=application-stopped\n'
} >"$metadata_path"
chmod 0600 "$metadata_path"

if [[ $was_running -eq 1 && $leave_stopped -eq 0 ]]; then
    compose start app >/dev/null
    app_stopped=0
    wait_for_app_health 30 2 || die "backup completed, but the application did not become healthy"
fi

if [[ $allow_empty -eq 1 ]]; then
    validation_args=(--allow-empty "$archive_path")
else
    validation_args=("$archive_path")
fi
if ! bash "$SCRIPT_DIR/check-backup.sh" "${validation_args[@]}"; then
    rm -f -- "$checksum_path" "$metadata_path" "$archive_path"
    die "backup validation failed; the unverified archive and sidecars were removed"
fi
trap - EXIT INT TERM
printf 'Backup ready: %s\n' "$archive_path"

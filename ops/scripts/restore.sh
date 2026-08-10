#!/usr/bin/env bash
set -Eeuo pipefail

readonly SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=_common.sh
source "$SCRIPT_DIR/_common.sh"

usage() {
    printf 'Usage: %s --archive /absolute/path/backup.tar.gz --confirm RESTORE-EDURI-DATA\n' "$0" >&2
}

archive_argument=""
confirmation=""
while (($# > 0)); do
    case "$1" in
        --archive)
            (($# >= 2)) || die "--archive requires a value"
            archive_argument="$2"
            shift 2
            ;;
        --confirm)
            (($# >= 2)) || die "--confirm requires a value"
            confirmation="$2"
            shift 2
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

[[ -n "$archive_argument" ]] || die "--archive is required"
[[ "$confirmation" == "RESTORE-EDURI-DATA" ]] \
    || die "restore requires --confirm RESTORE-EDURI-DATA"

for command_name in docker tar mv realpath mktemp sqlite3 timeout; do
    require_command "$command_name"
done
assert_production_layout
archive_path="$(realpath -e -- "$archive_argument")"
acquire_maintenance_lock
bash "$SCRIPT_DIR/check-backup.sh" "$archive_path"

if [[ -f "$EDURI_DATA_DIR/eduri.sqlite" ]]; then
    current_quick_check="$(
        timeout 60 sqlite3 -readonly "$EDURI_DATA_DIR/eduri.sqlite" \
            'PRAGMA quick_check;' 2>/dev/null || true
    )"
    if [[ "$current_quick_check" == "ok" ]]; then
        printf 'Creating a pre-restore backup...\n'
        bash "$SCRIPT_DIR/backup.sh"
    else
        printf 'WARNING: current SQLite data failed its integrity check; skipping the archival pre-restore backup.\n' >&2
        printf 'The original data directory will still be retained for manual recovery.\n' >&2
    fi
else
    printf 'WARNING: current SQLite database is missing; skipping the archival pre-restore backup.\n' >&2
    printf 'The original data directory will still be retained for manual recovery.\n' >&2
fi

timestamp="$(date -u +'%Y%m%dT%H%M%S%NZ')-$$"
restore_dir="$(mktemp -d --tmpdir="$EDURI_APP_ROOT" ".restore.${timestamp}.XXXXXXXX")"
rollback_dir="$EDURI_APP_ROOT/data.pre-restore-$timestamp"
failed_dir="$EDURI_APP_ROOT/data.failed-restore-$timestamp"
[[ ! -e "$rollback_dir" && ! -e "$failed_dir" ]] || die "restore safety path already exists"
case "$restore_dir" in
    "$EDURI_APP_ROOT"/.restore.*) ;;
    *) die "mktemp returned an unsafe restore path" ;;
esac

was_running=0
app_stopped=0
swap_started=0
if app_is_running; then
    was_running=1
fi

cleanup() {
    local status=$?
    trap - EXIT INT TERM
    if [[ $swap_started -eq 1 && -d "$rollback_dir" ]]; then
        compose stop --timeout 30 app >/dev/null 2>&1 || true
        if [[ -d "$EDURI_DATA_DIR" && ! -e "$failed_dir" ]]; then
            mv -- "$EDURI_DATA_DIR" "$failed_dir" || true
        fi
        if [[ ! -e "$EDURI_DATA_DIR" ]]; then
            mv -- "$rollback_dir" "$EDURI_DATA_DIR" || true
        fi
    fi
    if [[ $app_stopped -eq 1 && $was_running -eq 1 ]]; then
        compose start app >/dev/null || true
    fi
    if [[ -d "$restore_dir" ]]; then
        case "$restore_dir" in
            "$EDURI_APP_ROOT"/.restore.*) rm -rf -- "$restore_dir" ;;
        esac
    fi
    exit "$status"
}
trap cleanup EXIT INT TERM

tar --extract --gzip --file "$archive_path" \
    --directory "$restore_dir" --no-same-owner --no-same-permissions
[[ -d "$restore_dir/data" ]] || die "verified archive is missing data/ after extraction"
[[ -z "$(find "$restore_dir/data" -type l -print -quit)" ]] \
    || die "refusing to restore symlinks"

if [[ $was_running -eq 1 ]]; then
    compose stop --timeout 30 app
    app_stopped=1
fi

mv -- "$EDURI_DATA_DIR" "$rollback_dir"
swap_started=1
mv -- "$restore_dir/data" "$EDURI_DATA_DIR"
rmdir -- "$restore_dir"

compose up --detach app
app_stopped=0
if ! wait_for_app_health 45 2; then
    printf 'Restored data failed health checks; rolling back the directory swap.\n' >&2
    compose stop --timeout 30 app || true
    app_stopped=1
    mv -- "$EDURI_DATA_DIR" "$failed_dir"
    mv -- "$rollback_dir" "$EDURI_DATA_DIR"
    compose up --detach app
    app_stopped=0
    wait_for_app_health 45 2 \
        || die "restore and automatic rollback both failed; inspect Docker logs immediately"
    swap_started=0
    die "restore failed; original data was recovered and failed data is at $failed_dir"
fi

swap_started=0
trap - EXIT INT TERM
printf 'Restore healthy. Previous data retained at: %s\n' "$rollback_dir"
printf 'Do not delete it until login, lesson, upload, and audit smoke tests pass.\n'

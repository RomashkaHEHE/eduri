#!/usr/bin/env bash
set -Eeuo pipefail

readonly SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=_common.sh
source "$SCRIPT_DIR/_common.sh"

usage() {
    printf 'Usage: %s [--allow-empty] /absolute/path/to/eduri-data-*.tar.gz\n' "$0" >&2
}

allow_empty=0
if [[ ${1:-} == "--allow-empty" ]]; then
    allow_empty=1
    shift
fi

[[ $# -eq 1 ]] || {
    usage
    exit 2
}

for command_name in tar sha256sum sqlite3 timeout find realpath awk; do
    require_command "$command_name"
done
assert_production_layout
acquire_maintenance_lock

archive_path="$(realpath -e -- "$1")"
[[ -f "$archive_path" ]] || die "backup archive is not a regular file"
[[ "$archive_path" == *.tar.gz ]] || die "expected a .tar.gz backup archive"
checksum_path="$archive_path.sha256"
[[ -f "$checksum_path" ]] || die "missing checksum sidecar: $checksum_path"

read -r expected_checksum _ <"$checksum_path"
[[ "$expected_checksum" =~ ^[0-9a-fA-F]{64}$ ]] || die "checksum sidecar is malformed"
actual_checksum="$(sha256sum "$archive_path" | awk '{print $1}')"
[[ "$actual_checksum" == "$expected_checksum" ]] || die "backup checksum mismatch"

verify_dir="$(mktemp -d --tmpdir="$EDURI_BACKUP_DIR" '.verify.XXXXXXXX')"
case "$verify_dir" in
    "$EDURI_BACKUP_DIR"/.verify.*) ;;
    *) die "mktemp returned an unsafe verification path" ;;
esac

cleanup() {
    local status=$?
    trap - EXIT INT TERM
    case "$verify_dir" in
        "$EDURI_BACKUP_DIR"/.verify.*) rm -rf -- "$verify_dir" ;;
        *) printf 'Refusing to remove unexpected path: %s\n' "$verify_dir" >&2 ;;
    esac
    exit "$status"
}
trap cleanup EXIT INT TERM

entry_count=0
while IFS= read -r archive_entry; do
    ((entry_count += 1))
    [[ "$archive_entry" != /* ]] || die "archive contains an absolute path"
    case "$archive_entry" in
        data|data/|data/*) ;;
        *) die "archive entry is outside data/: $archive_entry" ;;
    esac
    case "/$archive_entry/" in
        */../*) die "archive contains parent path traversal" ;;
    esac
done < <(tar -tzf "$archive_path")
[[ $entry_count -gt 0 ]] || die "backup archive is empty"

if ! tar -tvzf "$archive_path" | awk '
    {
        type = substr($1, 1, 1)
        if (type != "-" && type != "d") exit 1
    }
'; then
    die "archive contains a link or special filesystem entry"
fi

tar --extract --gzip --file "$archive_path" \
    --directory "$verify_dir" --no-same-owner --no-same-permissions
[[ -d "$verify_dir/data" ]] || die "archive does not contain data/"
[[ -z "$(find "$verify_dir/data" -type l -print -quit)" ]] \
    || die "extracted backup contains a symlink"

database_count=0
while IFS= read -r -d '' database_path; do
    ((database_count += 1))
    quick_check="$(timeout 60 sqlite3 -readonly "$database_path" 'PRAGMA quick_check;')"
    [[ "$quick_check" == "ok" ]] || die "SQLite integrity check failed: $database_path"
done < <(
    find "$verify_dir/data" -type f \
        \( -name '*.db' -o -name '*.sqlite' -o -name '*.sqlite3' \) -print0
)

if [[ $allow_empty -ne 1 ]]; then
    [[ -f "$verify_dir/data/eduri.sqlite" ]] \
        || die "backup does not contain data/eduri.sqlite"
    [[ $database_count -eq 1 ]] \
        || die "backup must contain exactly one SQLite database (found $database_count)"
fi

trap - EXIT INT TERM
rm -rf -- "$verify_dir"
printf 'Backup verified: %s (%d SQLite database(s))\n' \
    "$archive_path" "$database_count"

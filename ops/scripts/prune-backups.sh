#!/usr/bin/env bash
set -Eeuo pipefail

readonly SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=_common.sh
source "$SCRIPT_DIR/_common.sh"

usage() {
    printf 'Usage: %s [--keep 14]\n' "$0" >&2
}

keep=14
while (($# > 0)); do
    case "$1" in
        --keep)
            (($# >= 2)) || die "--keep requires a value"
            keep="$2"
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

[[ "$keep" =~ ^[0-9]+$ && $keep -ge 1 && $keep -le 365 ]] \
    || die "--keep must be between 1 and 365"
for command_name in find sort realpath rm; do
    require_command "$command_name"
done
assert_production_layout
acquire_maintenance_lock

mapfile -t archives < <(
    find "$EDURI_BACKUP_DIR" -maxdepth 1 -type f \
        -name 'eduri-data-*.tar.gz' -printf '%f\n' | sort
)

remove_count=$((${#archives[@]} - keep))
if ((remove_count <= 0)); then
    printf 'No backup pruning required (%d retained).\n' "${#archives[@]}"
    exit 0
fi

for ((index = 0; index < remove_count; index++)); do
    archive_name="${archives[$index]}"
    [[ "$archive_name" =~ ^eduri-data-[0-9]{8}T[0-9]{15}Z-[0-9]+\.tar\.gz$ ]] \
        || die "refusing to prune unexpected filename: $archive_name"

    archive_path="$EDURI_BACKUP_DIR/$archive_name"
    [[ ! -L "$archive_path" && -f "$archive_path" ]] \
        || die "refusing to prune a link or non-file: $archive_path"
    [[ "$(dirname -- "$(realpath -e -- "$archive_path")")" == "$EDURI_BACKUP_DIR" ]] \
        || die "backup resolved outside the backup directory"

    for candidate in \
        "$archive_path" \
        "$archive_path.sha256" \
        "$archive_path.meta"; do
        if [[ -e "$candidate" || -L "$candidate" ]]; then
            [[ ! -L "$candidate" && -f "$candidate" ]] \
                || die "refusing to remove a sidecar link or non-file: $candidate"
            [[ "$(dirname -- "$(realpath -e -- "$candidate")")" == "$EDURI_BACKUP_DIR" ]] \
                || die "sidecar resolved outside the backup directory"
        fi
    done

    rm -f -- "$archive_path.sha256" "$archive_path.meta" "$archive_path"
    printf 'Pruned validated backup: %s\n' "$archive_path"
done

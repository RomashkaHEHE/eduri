#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

readonly PATH=/usr/sbin:/usr/bin:/sbin:/bin
readonly STATE_ROOT=/var/lib/eduri-cd
readonly JOBS_ROOT="$STATE_ROOT/jobs"
readonly QUEUE_LOCK="$STATE_ROOT/queue.lock"
readonly HELPER_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
readonly VALIDATOR="$HELPER_DIR/validate_cd_release.py"
readonly WORKER="$HELPER_DIR/cd-worker.sh"
readonly MARKER_FILE="$STATE_ROOT/deployed-sha"
readonly MAX_ARCHIVE_BYTES=33554432

receive_path=""
job_staging=""
job_path=""
handed_off=0
last_phase=""

die() {
    printf 'ERROR: %s\n' "$*" >&2
    exit 1
}

cleanup() {
    local status=$?
    trap - EXIT HUP INT TERM
    set +e

    if [[ -n "$receive_path" ]]; then
        case "$receive_path" in
            "$STATE_ROOT"/receive.*) rm -rf -- "$receive_path" ;;
            *) printf 'ERROR: refusing to clean unexpected receive path: %s\n' \
                "$receive_path" >&2 ;;
        esac
    fi
    if [[ $handed_off -eq 0 && -n "$job_staging" ]]; then
        case "$job_staging" in
            "$JOBS_ROOT"/.job.*) rm -rf -- "$job_staging" ;;
            *) printf 'ERROR: refusing to clean unexpected job path: %s\n' \
                "$job_staging" >&2 ;;
        esac
    fi
    if [[ $handed_off -eq 0 && -n "$job_path" ]]; then
        case "$job_path" in
            "$JOBS_ROOT"/job.*.ready) rm -rf -- "$job_path" ;;
            *) printf 'ERROR: refusing to clean unexpected job path: %s\n' \
                "$job_path" >&2 ;;
        esac
    fi
    exit "$status"
}

trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

[[ $EUID -eq 0 ]] || die "deployment receiver must run as root"
[[ -z "${SSH_ORIGINAL_COMMAND:-}" ]] \
    || die "the deployment key does not accept remote commands"
for command_name in \
    bash chmod cut find flock head install journalctl mktemp mv python3 realpath \
    rm rmdir sha256sum sleep stat sync systemctl systemd-run; do
    command -v "$command_name" >/dev/null 2>&1 \
        || die "required command is missing: $command_name"
done
for trusted_helper in "$VALIDATOR" "$WORKER"; do
    [[ -f "$trusted_helper" && ! -L "$trusted_helper" ]] \
        || die "trusted deployment helper is missing or unsafe: $trusted_helper"
    [[ "$(stat -c '%U:%G:%a' "$trusted_helper")" == "root:root:755" ]] \
        || die "trusted deployment helper ownership or mode is unsafe: $trusted_helper"
done

IFS= read -r -n 257 -d $'\n' header || {
    [[ -n "$header" ]] || die "missing deployment header"
}
[[ ${#header} -le 256 ]] || die "deployment header is too long"
if [[ ! "$header" =~ ^EDURI_CD_V1[[:space:]]([0-9a-f]{40})[[:space:]]([0-9a-f]{64})[[:space:]]([1-9][0-9]{0,8})$ ]]; then
    die "invalid deployment header"
fi
readonly release_sha="${BASH_REMATCH[1]}"
readonly expected_archive_sha="${BASH_REMATCH[2]}"
readonly expected_archive_bytes="${BASH_REMATCH[3]}"
((expected_archive_bytes <= MAX_ARCHIVE_BYTES)) || die "release archive is too large"

if [[ -e "$STATE_ROOT" || -L "$STATE_ROOT" ]]; then
    [[ -d "$STATE_ROOT" && ! -L "$STATE_ROOT" ]] \
        || die "deployment state root is unsafe"
fi
install -d -o root -g root -m 0700 "$STATE_ROOT" "$JOBS_ROOT"
[[ "$(stat -c '%U:%G:%a' "$STATE_ROOT")" == "root:root:700" ]] \
    || die "deployment state root ownership or mode is unsafe"
[[ "$(stat -c '%U:%G:%a' "$JOBS_ROOT")" == "root:root:700" ]] \
    || die "deployment jobs root ownership or mode is unsafe"
exec 8>"$QUEUE_LOCK"
flock -w 120 8 || die "another deployment submission is in progress"
while IFS= read -r existing_job; do
    [[ -f "$existing_job/succeeded" || -f "$existing_job/failed" ]] \
        || die "an unfinished deployment job already exists"
done < <(find "$JOBS_ROOT" -mindepth 1 -maxdepth 1 -type d \
    -name 'job.*.ready' -print)

receive_path="$(mktemp -d "$STATE_ROOT/receive.XXXXXXXX")"
readonly archive_path="$receive_path/release.tar.gz"
readonly release_path="$receive_path/release"
head -c "$expected_archive_bytes" >"$archive_path"
[[ "$(stat -c '%s' "$archive_path")" == "$expected_archive_bytes" ]] \
    || die "truncated release archive"
readonly trailing_path="$receive_path/trailing"
head -c 1 >"$trailing_path"
[[ ! -s "$trailing_path" ]] || die "unexpected bytes after release archive"
readonly actual_archive_sha="$(sha256sum "$archive_path" | cut -d ' ' -f 1)"
[[ "$actual_archive_sha" == "$expected_archive_sha" ]] \
    || die "release archive checksum mismatch"
python3 "$VALIDATOR" "$archive_path" "$release_path"

job_staging="$(mktemp -d "$JOBS_ROOT/.job.$release_sha.XXXXXXXX")"
mv -- "$archive_path" "$job_staging/release.tar.gz"
mv -- "$release_path" "$job_staging/release"
printf '%s\n' "$release_sha" >"$job_staging/release-sha"
printf '%s\n' "$actual_archive_sha" >"$job_staging/archive-sha256"
printf '%s\n' "$expected_archive_bytes" >"$job_staging/archive-bytes"
printf '%s\n' ready >"$job_staging/phase"
find "$job_staging" -maxdepth 1 -type f -exec chmod 0600 {} +
chmod 0700 "$job_staging/release"
sync -f "$job_staging/release-sha"
sync -f "$job_staging"

readonly job_token="${job_staging##*.}"
job_path="$JOBS_ROOT/job.$release_sha.$job_token.ready"
[[ ! -e "$job_path" && ! -L "$job_path" ]] || die "deployment job already exists"
mv -- "$job_staging" "$job_path"
job_staging=""
sync -f "$JOBS_ROOT"

readonly unit_name="eduri-cd-${release_sha:0:12}-$job_token"
printf 'Validated release %s; production job %s started.\n' \
    "$release_sha" "$unit_name"
if ! systemd-run \
    --quiet \
    --collect \
    --unit "$unit_name" \
    --property Type=exec \
    --property RuntimeMaxSec=40min \
    --property TimeoutStopSec=10min \
    --property KillMode=control-group \
    --property Restart=on-failure \
    --property RestartSec=5s \
    "$WORKER" "$job_path"; then
    if systemctl is-active --quiet "$unit_name.service"; then
        handed_off=1
    fi
    journalctl --unit "$unit_name.service" --no-pager --output=cat -n 200 >&2 \
        || true
    [[ $handed_off -eq 1 ]] \
        || die "production deployment worker could not be started"
fi
handed_off=1
flock -u 8

for ((attempt = 1; attempt <= 330; attempt++)); do
    if [[ -f "$job_path/succeeded" \
        && "$(head -n 1 -- "$MARKER_FILE" 2>/dev/null)" == "$release_sha" ]]; then
        break
    fi
    if [[ -f "$job_path/failed" ]]; then
        journalctl --unit "$unit_name.service" --no-pager --output=cat -n 200 >&2 \
            || true
        die "production deployment worker failed"
    fi
    current_phase="$(head -n 1 -- "$job_path/phase" 2>/dev/null || true)"
    if [[ -n "$current_phase" && "$current_phase" != "$last_phase" ]]; then
        printf 'Deployment phase: %s\n' "$current_phase"
        last_phase="$current_phase"
    fi
    sleep 10
done
[[ -f "$job_path/succeeded" \
    && "$(head -n 1 -- "$MARKER_FILE" 2>/dev/null)" == "$release_sha" ]] \
    || die "production deployment worker timed out"
printf 'EDURI_DEPLOYED_SHA=%s\n' "$release_sha"
case "$job_path" in
    "$JOBS_ROOT"/job.*.ready) rm -rf -- "$job_path" ;;
    *) die "refusing to clean unexpected completed job path" ;;
esac

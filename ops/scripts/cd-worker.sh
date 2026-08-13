#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

readonly PATH=/usr/sbin:/usr/bin:/sbin:/bin
readonly APP_ROOT=/home/user1/eduri
readonly BACKUP_ROOT="$APP_ROOT/backups"
readonly DATA_ROOT="$APP_ROOT/data"
readonly LOCK_FILE="$APP_ROOT/.maintenance.lock"
readonly STATE_ROOT=/var/lib/eduri-cd
readonly JOBS_ROOT="$STATE_ROOT/jobs"
readonly RECOVERY_ROOT="$STATE_ROOT/recovery"
readonly QUEUE_LOCK="$STATE_ROOT/queue.lock"
readonly LIBEXEC_ROOT=/usr/local/libexec/eduri
readonly GENERATIONS_ROOT="$LIBEXEC_ROOT/generations"
readonly CURRENT_LINK="$LIBEXEC_ROOT/current"
readonly MARKER_FILE="$STATE_ROOT/deployed-sha"
readonly MAINTENANCE_ROOT=/etc/eduri
readonly MAINTENANCE_FILE="$MAINTENANCE_ROOT/maintenance"
readonly EDGE_SITE=/etc/nginx/sites-available/eduri.ru
readonly EDGE_HOOK=/etc/letsencrypt/renewal-hooks/deploy/reload-nginx
readonly RECONCILE_UNIT=/etc/systemd/system/eduri-cd-reconcile.service
readonly NGINX_DEPENDENCY_ROOT=/etc/systemd/system/nginx.service.d
readonly NGINX_DEPENDENCY_UNIT="$NGINX_DEPENDENCY_ROOT/eduri-cd-reconcile.conf"
readonly HELPER_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
readonly EDGE_INSTALLER="$HELPER_DIR/install-edge-config.sh"
readonly BUNDLE_VALIDATOR="$HELPER_DIR/cd-validate-helpers.sh"
readonly APP_IMAGE=eduri-app:production
readonly APP_BOOTSTRAP_IMAGE=eduri-app:latest
readonly -a HELPER_NAMES=(
    cd-receive.sh
    cd-worker.sh
    cd-validate-helpers.sh
    install-edge-config.sh
    validate_cd_release.py
)
readonly -a RSYNC_EXCLUDES=(
    --exclude=/.env
    --exclude=/.env.*
    --exclude=/.maintenance.lock
    --exclude=/.qa-board-v2/
    --exclude=/backups/
    --exclude=/data/
    --exclude=/data-dev/
    --exclude=/data.failed-restore-*/
    --exclude=/data.pre-restore-*/
    --exclude=/.restore.*/
    --exclude=/qa-data-*/
)

job_path=""
release_path=""
release_sha=""
recovery_path=""
recovery_staging=""
restore_staging=""
generation_path=""
generation_staging=""
current_candidate=""
maintenance_candidate=""
build_context=""
old_generation_target=""
old_app_image_id=""
old_database_existed=0
job_validated=0
terminal_written=0

die() {
    printf 'ERROR: %s\n' "$*" >&2
    exit 1
}

run_as_user1() {
    setpriv --reuid=user1 --regid=user1 --init-groups --reset-env -- \
        env EDURI_MAINTENANCE_LOCK_HELD=1 "$@"
}

compose_user() {
    run_as_user1 /usr/bin/docker compose \
        --project-directory "$APP_ROOT" \
        --file "$APP_ROOT/docker-compose.yml" "$@"
}

app_is_running() {
    compose_user ps --status running --services 2>/dev/null | grep -Fxq app
}

wait_for_app_health() {
    local attempt

    for ((attempt = 1; attempt <= 45; attempt++)); do
        if curl --fail --silent --show-error --max-time 3 \
            http://127.0.0.1:3020/api/health >/dev/null 2>&1; then
            return 0
        fi
        sleep 2
    done
    return 1
}

wait_for_livekit_health() {
    local attempt

    for ((attempt = 1; attempt <= 45; attempt++)); do
        if curl --fail --silent --show-error --max-time 3 \
            http://127.0.0.1:7880/ >/dev/null 2>&1; then
            return 0
        fi
        sleep 2
    done
    return 1
}

durable_write() {
    local target="$1"
    local value="$2"
    local parent candidate

    parent="$(dirname -- "$target")" || return 1
    candidate="$(mktemp "$parent/.cd-state.XXXXXXXX")" || return 1
    printf '%s\n' "$value" >"$candidate" || return 1
    chmod 0600 "$candidate" || return 1
    sync -f "$candidate" || return 1
    mv -fT -- "$candidate" "$target" || return 1
    sync -f "$parent" || return 1
}

read_single_line() {
    local file="$1"
    local value

    [[ -f "$file" && ! -L "$file" ]] || return 1
    value="$(head -n 2 -- "$file")" || return 1
    [[ -n "$value" && "$value" != *$'\n'* ]] || return 1
    printf '%s' "$value"
}

read_phase() {
    local phase

    phase="$(read_single_line "$job_path/phase")" || return 1
    case "$phase" in
        ready|rollback-required|commit-intent|committed|rolled-back)
            printf '%s' "$phase"
            ;;
        *)
            return 1
            ;;
    esac
}

write_phase() {
    durable_write "$job_path/phase" "$1"
}

activate_gate() {
    if [[ -e "$MAINTENANCE_FILE" || -L "$MAINTENANCE_FILE" ]]; then
        [[ -f "$MAINTENANCE_FILE" && ! -L "$MAINTENANCE_FILE" ]] \
            || return 1
        return 0
    fi
    install -d -o root -g root -m 0755 "$MAINTENANCE_ROOT" || return 1
    maintenance_candidate="$(mktemp "$MAINTENANCE_ROOT/.maintenance.XXXXXXXX")" \
        || return 1
    printf 'Deployment in progress. Please retry shortly.\n' \
        >"$maintenance_candidate" || return 1
    chmod 0644 "$maintenance_candidate" || return 1
    sync -f "$maintenance_candidate" || return 1
    mv -fT -- "$maintenance_candidate" "$MAINTENANCE_FILE" || return 1
    maintenance_candidate=""
    sync -f "$MAINTENANCE_ROOT" || return 1
}

remove_gate() {
    if [[ -e "$MAINTENANCE_FILE" || -L "$MAINTENANCE_FILE" ]]; then
        [[ -f "$MAINTENANCE_FILE" && ! -L "$MAINTENANCE_FILE" ]] \
            || return 1
        rm -f -- "$MAINTENANCE_FILE" || return 1
        sync -f "$MAINTENANCE_ROOT" || return 1
    fi
}

validate_generation() {
    local generation_dir="$1"
    local expected_sha="${2:-}"
    local helper_name marker_value

    [[ -d "$generation_dir" && ! -L "$generation_dir" \
        && "$(stat -c '%U:%G:%a' "$generation_dir")" == "root:root:700" ]] \
        || return 1
    for helper_name in "${HELPER_NAMES[@]}"; do
        [[ -f "$generation_dir/$helper_name" \
            && ! -L "$generation_dir/$helper_name" \
            && "$(stat -c '%U:%G:%a' "$generation_dir/$helper_name")" \
                == "root:root:755" ]] || return 1
    done
    [[ -f "$generation_dir/deployed-sha" \
        && ! -L "$generation_dir/deployed-sha" \
        && "$(stat -c '%U:%G:%a' "$generation_dir/deployed-sha")" \
            == "root:root:644" ]] || return 1
    marker_value="$(head -n 2 -- "$generation_dir/deployed-sha")" || return 1
    [[ "$marker_value" =~ ^[0-9a-f]{40}$ ]] || return 1
    [[ -z "$expected_sha" || "$marker_value" == "$expected_sha" ]] || return 1
    /bin/bash "$BUNDLE_VALIDATOR" "$generation_dir"
}

validate_current_generation() {
    local target generation_sha="${1:-}"

    [[ -L "$CURRENT_LINK" ]] || return 1
    target="$(readlink -- "$CURRENT_LINK")" || return 1
    [[ "$target" =~ ^generations/(release-[0-9a-f]{40}|[.]bootstrap[.][A-Za-z0-9]{8})$ ]] \
        || return 1
    [[ -d "$LIBEXEC_ROOT/$target" \
        && "$(realpath -e -- "$LIBEXEC_ROOT/$target")" \
            == "$GENERATIONS_ROOT/${target#generations/}" ]] || return 1
    validate_generation "$LIBEXEC_ROOT/$target" "$generation_sha" || return 1
    [[ -L "$MARKER_FILE" \
        && "$(readlink -- "$MARKER_FILE")" == "$CURRENT_LINK/deployed-sha" ]] \
        || return 1
    printf '%s' "$target"
}

prepare_generation() {
    local helper_name

    generation_path="$GENERATIONS_ROOT/release-$release_sha"
    install -d -o root -g root -m 0755 \
        "$LIBEXEC_ROOT" "$GENERATIONS_ROOT" || return 1
    if [[ -e "$generation_path" || -L "$generation_path" ]]; then
        validate_generation "$generation_path" "$release_sha" || return 1
        for helper_name in "${HELPER_NAMES[@]}"; do
            cmp --silent -- "$release_path/ops/scripts/$helper_name" \
                "$generation_path/$helper_name" || return 1
        done
        return 0
    fi

    generation_staging="$(mktemp -d "$GENERATIONS_ROOT/.release.XXXXXXXX")" \
        || return 1
    for helper_name in "${HELPER_NAMES[@]}"; do
        install -o root -g root -m 0755 \
            "$release_path/ops/scripts/$helper_name" \
            "$generation_staging/$helper_name" || return 1
    done
    /bin/bash "$BUNDLE_VALIDATOR" "$generation_staging" || return 1
    printf '%s\n' "$release_sha" >"$generation_staging/deployed-sha" \
        || return 1
    chmod 0644 "$generation_staging/deployed-sha" || return 1
    sync -f "$generation_staging/deployed-sha" || return 1
    sync -f "$generation_staging" || return 1
}

finalize_generation() {
    if [[ -n "$generation_staging" ]]; then
        mv -- "$generation_staging" "$generation_path" || return 1
        generation_staging=""
        sync -f "$GENERATIONS_ROOT" || return 1
    fi
    validate_generation "$generation_path" "$release_sha"
}

switch_current_to() {
    local target="$1"

    if [[ -L "$CURRENT_LINK" \
        && "$(readlink -- "$CURRENT_LINK")" == "$target" ]]; then
        return 0
    fi
    current_candidate="$LIBEXEC_ROOT/.current.$release_sha.$$"
    [[ ! -e "$current_candidate" && ! -L "$current_candidate" ]] \
        || return 1
    ln -s -- "$target" "$current_candidate" || return 1
    mv -fT -- "$current_candidate" "$CURRENT_LINK" || return 1
    current_candidate=""
    sync -f "$LIBEXEC_ROOT" || return 1
}

install_reconcile_unit() {
    local source="$APP_ROOT/ops/systemd/eduri-cd-reconcile.service"
    local nginx_source="$APP_ROOT/ops/systemd/nginx.service.d/eduri-cd-reconcile.conf"
    local candidate changed=0 nginx_candidate

    [[ -f "$source" && ! -L "$source" \
        && -f "$nginx_source" && ! -L "$nginx_source" ]] || return 1
    systemd-analyze verify "$source" >/dev/null || return 1
    install -d -o root -g root -m 0755 "$NGINX_DEPENDENCY_ROOT" || return 1
    if [[ ! -f "$NGINX_DEPENDENCY_UNIT" ]] \
        || ! cmp --silent -- "$nginx_source" "$NGINX_DEPENDENCY_UNIT"; then
        nginx_candidate="$(mktemp \
            "$NGINX_DEPENDENCY_ROOT/.eduri-cd-reconcile.XXXXXXXX")" \
            || return 1
        install -o root -g root -m 0644 \
            "$nginx_source" "$nginx_candidate" || return 1
        sync -f "$nginx_candidate" || return 1
        mv -fT -- "$nginx_candidate" "$NGINX_DEPENDENCY_UNIT" || return 1
        sync -f "$NGINX_DEPENDENCY_ROOT" || return 1
        changed=1
    fi
    if [[ ! -f "$RECONCILE_UNIT" ]] \
        || ! cmp --silent -- "$source" "$RECONCILE_UNIT"; then
        candidate="$(mktemp /etc/systemd/system/.eduri-cd-reconcile.XXXXXXXX)" \
            || return 1
        install -o root -g root -m 0644 "$source" "$candidate" || return 1
        sync -f "$candidate" || return 1
        mv -fT -- "$candidate" "$RECONCILE_UNIT" || return 1
        sync -f /etc/systemd/system || return 1
        changed=1
    fi
    if [[ $changed -eq 1 ]]; then
        systemctl daemon-reload || return 1
    fi
    systemd-analyze verify eduri-cd-reconcile.service nginx.service \
        >/dev/null || return 1
    systemctl enable eduri-cd-reconcile.service >/dev/null || return 1
}

install_tree() {
    local source_root="$1"

    rsync --archive --delete-delay --chown=user1:user1 \
        "${RSYNC_EXCLUDES[@]}" "$source_root/" "$APP_ROOT/" || return 1
    /bin/bash "$EDGE_INSTALLER" || return 1
}

record_predeploy_backup() {
    local archive_name candidate="" candidate_count=0

    while IFS= read -r archive_name; do
        [[ -n "$archive_name" ]] || continue
        grep -Fxq -- "$archive_name" "$recovery_path/backups.before" \
            && continue
        [[ "$archive_name" =~ ^eduri-data-[0-9]{8}T[0-9]{15}Z-[0-9]+[.]tar[.]gz$ ]] \
            || continue
        [[ -f "$BACKUP_ROOT/$archive_name" \
            && -f "$BACKUP_ROOT/$archive_name.sha256" \
            && -f "$BACKUP_ROOT/$archive_name.meta" ]] || continue
        candidate="$archive_name"
        ((candidate_count += 1))
    done < <(
        find "$BACKUP_ROOT" -maxdepth 1 -type f \
            -name 'eduri-data-*.tar.gz' -printf '%f\n' | sort
    )
    [[ $candidate_count -eq 1 ]] || return 1
    durable_write "$recovery_path/predeploy-backup" "$candidate" || return 1
    durable_write "$recovery_path/database-existed" "$old_database_existed"
}

restore_edge_snapshot() {
    local candidate

    grep -Fqx '    if (-f /etc/eduri/maintenance) {' \
        "$recovery_path/edge/eduri.ru.conf" || return 1
    candidate="$(mktemp "$(dirname -- "$EDGE_SITE")/.eduri.ru.cd-restore.XXXXXXXX")" \
        || return 1
    install -o root -g root -m 0644 \
        "$recovery_path/edge/eduri.ru.conf" "$candidate" || return 1
    mv -fT -- "$candidate" "$EDGE_SITE" || return 1
    candidate="$(mktemp "$(dirname -- "$EDGE_HOOK")/.reload-nginx.cd-restore.XXXXXXXX")" \
        || return 1
    install -o root -g root -m 0755 \
        "$recovery_path/edge/reload-nginx.sh" "$candidate" || return 1
    mv -fT -- "$candidate" "$EDGE_HOOK" || return 1
    nginx -t || return 1
    if systemctl is-active --quiet nginx; then
        systemctl reload nginx || return 1
    fi
}

restore_predeploy_data() {
    local backup_name predeploy_backup failed_path restore_id
    local current_restore_id=""
    local failed_restore_id=""
    local -a check_args=()

    [[ ! -f "$recovery_path/data-restored" ]] || return 0
    backup_name="$(read_single_line "$recovery_path/predeploy-backup")" \
        || return 1
    [[ "$backup_name" =~ ^eduri-data-[0-9]{8}T[0-9]{15}Z-[0-9]+[.]tar[.]gz$ ]] \
        || return 1
    predeploy_backup="$BACKUP_ROOT/$backup_name"
    if [[ "$(read_single_line "$recovery_path/database-existed")" == "0" ]]; then
        check_args+=(--allow-empty)
    fi
    run_as_user1 /bin/bash "$APP_ROOT/ops/scripts/check-backup.sh" \
        "${check_args[@]}" "$predeploy_backup" || return 1
    compose_user stop --timeout 30 app || return 1
    ! app_is_running || return 1

    restore_id="${recovery_path##*/}"
    failed_path="$APP_ROOT/data.failed-restore-cd-$release_sha-${restore_id##*.}"
    if [[ -e "$DATA_ROOT" || -L "$DATA_ROOT" ]]; then
        [[ -d "$DATA_ROOT" && ! -L "$DATA_ROOT" ]] || return 1
        if [[ -e "$DATA_ROOT/.eduri-cd-restore-id" \
            || -L "$DATA_ROOT/.eduri-cd-restore-id" ]]; then
            [[ -f "$DATA_ROOT/.eduri-cd-restore-id" \
                && ! -L "$DATA_ROOT/.eduri-cd-restore-id" ]] || return 1
            current_restore_id="$(read_single_line \
                "$DATA_ROOT/.eduri-cd-restore-id")" || return 1
        fi
    fi
    if [[ -e "$failed_path" || -L "$failed_path" ]]; then
        [[ -d "$failed_path" && ! -L "$failed_path" ]] || return 1
        if [[ -e "$failed_path/.eduri-cd-restore-id" \
            || -L "$failed_path/.eduri-cd-restore-id" ]]; then
            [[ -f "$failed_path/.eduri-cd-restore-id" \
                && ! -L "$failed_path/.eduri-cd-restore-id" ]] || return 1
            failed_restore_id="$(read_single_line \
                "$failed_path/.eduri-cd-restore-id")" || return 1
        fi
    fi
    if [[ "$current_restore_id" == "$restore_id" ]]; then
        chown -R user1:user1 "$DATA_ROOT" || return 1
        sync || return 1
        durable_write "$recovery_path/data-restored" "$restore_id"
        return
    fi
    if [[ -e "$failed_path" && -e "$DATA_ROOT" ]]; then
        [[ "$current_restore_id" == "$restore_id" ]] || return 1
    fi
    [[ -z "$failed_restore_id" ]] || return 1

    restore_staging="$APP_ROOT/.restore.cd-$release_sha-${restore_id##*.}"
    case "$restore_staging" in
        "$APP_ROOT"/.restore.cd-[0-9a-f]*-[A-Za-z0-9]*) ;;
        *) return 1 ;;
    esac
    rm -rf -- "$restore_staging" || return 1
    install -d -o root -g root -m 0700 "$restore_staging" || return 1
    tar --extract --gzip --file "$predeploy_backup" \
        --directory "$restore_staging" --no-same-owner --no-same-permissions \
        || return 1
    [[ -d "$restore_staging/data" \
        && -z "$(find "$restore_staging/data" -type l -print -quit)" ]] \
        || return 1
    printf '%s\n' "$restore_id" \
        >"$restore_staging/data/.eduri-cd-restore-id" \
        || return 1
    chmod 0600 "$restore_staging/data/.eduri-cd-restore-id" || return 1
    chown -R user1:user1 "$restore_staging/data" || return 1
    sync || return 1
    if [[ ! -e "$failed_path" && ! -L "$failed_path" \
        && ( -e "$DATA_ROOT" || -L "$DATA_ROOT" ) ]]; then
        [[ -d "$DATA_ROOT" && ! -L "$DATA_ROOT" \
            && ! -e "$failed_path" ]] || return 1
        mv -- "$DATA_ROOT" "$failed_path" || return 1
        sync -f "$APP_ROOT" || return 1
    fi
    mv -- "$restore_staging/data" "$DATA_ROOT" || return 1
    sync -f "$APP_ROOT" || return 1
    rmdir -- "$restore_staging" || return 1
    restore_staging=""
    sync -f "$APP_ROOT" || return 1
    durable_write "$recovery_path/data-restored" "$restore_id"
}

load_recovery() {
    local recovery_name database_value

    recovery_name="$(read_single_line "$job_path/recovery-name")" || return 1
    [[ "$recovery_name" =~ ^recovery[.]$release_sha[.][A-Za-z0-9]{8}$ ]] \
        || return 1
    recovery_path="$RECOVERY_ROOT/$recovery_name"
    [[ -d "$recovery_path" && ! -L "$recovery_path" \
        && "$(realpath -e -- "$recovery_path")" == "$recovery_path" ]] \
        || return 1
    old_app_image_id="$(read_single_line "$recovery_path/old-app-image-id")" \
        || return 1
    [[ "$old_app_image_id" =~ ^sha256:[0-9a-f]{64}$ ]] || return 1
    old_generation_target="$(read_single_line \
        "$recovery_path/old-generation-target")" || return 1
    [[ "$old_generation_target" \
        =~ ^generations/(release-[0-9a-f]{40}|[.]bootstrap[.][A-Za-z0-9]{8})$ ]] \
        || return 1
    database_value="$(read_single_line "$recovery_path/database-existed")" \
        || return 1
    [[ "$database_value" == "0" || "$database_value" == "1" ]] || return 1
    old_database_existed="$database_value"
    [[ -d "$recovery_path/source" && ! -L "$recovery_path/source" \
        && -f "$recovery_path/edge/eduri.ru.conf" \
        && ! -L "$recovery_path/edge/eduri.ru.conf" \
        && -f "$recovery_path/edge/reload-nginx.sh" \
        && ! -L "$recovery_path/edge/reload-nginx.sh" ]] || return 1
}

rollback_release() {
    printf 'Deployment failed; restoring the previous release.\n' >&2
    activate_gate || return 1
    compose_user stop --timeout 30 app >/dev/null 2>&1 || true
    ! app_is_running || return 1
    rsync --archive --delete-delay --chown=user1:user1 \
        "${RSYNC_EXCLUDES[@]}" "$recovery_path/source/" "$APP_ROOT/" \
        || return 1
    if [[ -f "$recovery_path/predeploy-backup" ]]; then
        restore_predeploy_data || return 1
    fi
    /usr/bin/docker image inspect "$old_app_image_id" >/dev/null || return 1
    /usr/bin/docker tag "$old_app_image_id" "$APP_IMAGE" || return 1
    /usr/bin/docker tag "$old_app_image_id" "$APP_BOOTSTRAP_IMAGE" || return 1
    compose_user up --detach --no-build --pull never clamav livekit || return 1
    wait_for_livekit_health || return 1
    compose_user up --detach --no-deps --no-build --pull never app || return 1
    wait_for_app_health || return 1
    wait_for_livekit_health || return 1
    switch_current_to "$old_generation_target" || return 1
    validate_current_generation >/dev/null || return 1
    restore_edge_snapshot || return 1
    wait_for_app_health || return 1
    sync || return 1
    write_phase rolled-back || return 1
    remove_gate || return 1
    printf 'Previous production release restored and healthy.\n' >&2
}

commit_forward() {
    local candidate_image="eduri-app:cd-$release_sha"

    printf 'Completing production cutover for %s.\n' "$release_sha"
    activate_gate || return 1
    [[ -d "$release_path" && ! -L "$release_path" ]] || return 1
    install_tree "$release_path" || return 1
    /usr/bin/docker image inspect "$candidate_image" >/dev/null || return 1
    /usr/bin/docker tag "$candidate_image" "$APP_IMAGE" || return 1
    compose_user up --detach --remove-orphans clamav livekit || return 1
    wait_for_livekit_health || return 1
    compose_user up --detach --no-deps --no-build app || return 1
    wait_for_app_health || return 1
    wait_for_livekit_health || return 1
    generation_path="$GENERATIONS_ROOT/release-$release_sha"
    validate_generation "$generation_path" "$release_sha" || return 1
    switch_current_to "generations/release-$release_sha" || return 1
    validate_current_generation "$release_sha" >/dev/null || return 1
    install_reconcile_unit || return 1
    sync || return 1
    write_phase committed || return 1
    remove_gate || return 1
}

compact_job() {
    case "$job_path" in
        "$JOBS_ROOT"/job.*.ready) ;;
        *) return 1 ;;
    esac
    rm -rf -- "$job_path/release" || return 1
    rm -f -- \
        "$job_path/release.tar.gz" \
        "$job_path/archive-sha256" \
        "$job_path/archive-bytes" || return 1
    sync -f "$job_path" || return 1
}

remove_recovery() {
    [[ -n "$recovery_path" ]] || return 0
    case "$recovery_path" in
        "$RECOVERY_ROOT"/recovery.*) rm -rf -- "$recovery_path" || return 1 ;;
        *) return 1 ;;
    esac
    sync -f "$RECOVERY_ROOT" || return 1
    recovery_path=""
}

find_existing_recovery() {
    local recovery_name candidate

    [[ -z "$recovery_path" && -f "$job_path/recovery-name" ]] || return 0
    recovery_name="$(read_single_line "$job_path/recovery-name")" || return 1
    [[ "$recovery_name" =~ ^recovery[.]$release_sha[.][A-Za-z0-9]{8}$ ]] \
        || return 1
    candidate="$RECOVERY_ROOT/$recovery_name"
    [[ ! -e "$candidate" || -d "$candidate" ]] || return 1
    [[ ! -d "$candidate" ]] || recovery_path="$candidate"
}

finish_success() {
    validate_current_generation "$release_sha" >/dev/null || return 1
    wait_for_app_health || return 1
    wait_for_livekit_health || return 1
    remove_gate || return 1
    find_existing_recovery || return 1
    remove_recovery || return 1
    compact_job || return 1
    durable_write "$job_path/succeeded" "$release_sha" || return 1
    terminal_written=1
    printf 'Deployment healthy: https://eduri.ru (app + ClamAV + LiveKit)\n'
}

finish_failure() {
    wait_for_app_health || return 1
    wait_for_livekit_health || return 1
    remove_gate || return 1
    if [[ -f "$DATA_ROOT/.eduri-cd-restore-id" \
        && ! -L "$DATA_ROOT/.eduri-cd-restore-id" ]]; then
        rm -f -- "$DATA_ROOT/.eduri-cd-restore-id" || return 1
        sync -f "$DATA_ROOT" || return 1
    fi
    find_existing_recovery || return 1
    remove_recovery || return 1
    compact_job || return 1
    durable_write "$job_path/failed" "$release_sha" || return 1
    terminal_written=1
}

cleanup() {
    local status=$?
    local phase=""
    trap - EXIT HUP INT TERM
    set +e

    if [[ -n "$build_context" ]]; then
        case "$build_context" in
            /tmp/eduri-cd-build.*) rm -rf -- "$build_context" ;;
        esac
    fi
    [[ -z "$maintenance_candidate" ]] || rm -f -- "$maintenance_candidate"
    [[ -z "$current_candidate" ]] || rm -f -- "$current_candidate"
    if [[ -n "$generation_staging" ]]; then
        case "$generation_staging" in
            "$GENERATIONS_ROOT"/.release.*) rm -rf -- "$generation_staging" ;;
        esac
    fi
    if [[ -n "$recovery_staging" ]]; then
        case "$recovery_staging" in
            "$RECOVERY_ROOT"/.recovery.*) rm -rf -- "$recovery_staging" ;;
        esac
    fi
    if [[ -n "$restore_staging" ]]; then
        case "$restore_staging" in
            "$APP_ROOT"/.restore.cd-*) rm -rf -- "$restore_staging" ;;
        esac
    fi
    if [[ $status -ne 0 && $job_validated -eq 1 && $terminal_written -eq 0 ]]; then
        phase="$(read_phase 2>/dev/null)"
        case "$phase" in
            ready)
                if compact_job && durable_write "$job_path/failed" "$release_sha"; then
                    terminal_written=1
                fi
                ;;
            rollback-required)
                if load_recovery && rollback_release && finish_failure; then
                    printf 'Automatic rollback completed.\n' >&2
                else
                    activate_gate >/dev/null 2>&1 || true
                    printf 'ERROR: rollback is incomplete; maintenance gate and recovery are retained.\n' >&2
                fi
                ;;
            commit-intent)
                if load_recovery && commit_forward && finish_success; then
                    status=0
                else
                    activate_gate >/dev/null 2>&1 || true
                    printf 'ERROR: forward recovery is incomplete; maintenance gate is retained.\n' >&2
                fi
                ;;
            committed)
                if finish_success; then
                    status=0
                else
                    activate_gate >/dev/null 2>&1 || true
                fi
                ;;
            rolled-back)
                if finish_failure; then
                    :
                else
                    activate_gate >/dev/null 2>&1 || true
                fi
                ;;
        esac
    fi
    exit "$status"
}

trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

validate_job_path() {
    local candidate="$1"

    job_path="$(realpath -e -- "$candidate")" || return 1
    case "$job_path" in
        "$JOBS_ROOT"/job.*.ready) ;;
        *) return 1 ;;
    esac
    [[ -d "$job_path" && ! -L "$job_path" \
        && "$(stat -c '%U:%G:%a' "$job_path")" == "root:root:700" ]] \
        || return 1
    release_sha="$(read_single_line "$job_path/release-sha")" || return 1
    [[ "$release_sha" =~ ^[0-9a-f]{40}$ ]] || return 1
    [[ "${job_path##*/}" =~ ^job[.]$release_sha[.][A-Za-z0-9]{8}[.]ready$ ]] \
        || return 1
    job_validated=1
}

reconcile_jobs() {
    local -a pending_jobs=()
    local candidate candidate_sha phase terminal_count terminal_value
    local gate_preexisting=0 terminal_name unit_name token

    install -d -o root -g root -m 0700 "$STATE_ROOT" "$JOBS_ROOT" || return 1
    exec 8>"$QUEUE_LOCK"
    flock -w 30 8 || return 1
    shopt -s nullglob
    for candidate in "$JOBS_ROOT"/job.*.ready; do
        [[ -d "$candidate" && ! -L "$candidate" ]] || {
            activate_gate || true
            return 1
        }
        if [[ ! "${candidate##*/}" \
            =~ ^job[.]([0-9a-f]{40})[.][A-Za-z0-9]{8}[.]ready$ ]]; then
            activate_gate || true
            return 1
        fi
        candidate_sha="${BASH_REMATCH[1]}"
        terminal_count=0
        for terminal_name in succeeded failed; do
            if [[ -e "$candidate/$terminal_name" \
                || -L "$candidate/$terminal_name" ]]; then
                ((terminal_count += 1))
                [[ -f "$candidate/$terminal_name" \
                    && ! -L "$candidate/$terminal_name" ]] || {
                    activate_gate || true
                    return 1
                }
                terminal_value="$(read_single_line \
                    "$candidate/$terminal_name")" || {
                    activate_gate || true
                    return 1
                }
                [[ "$terminal_value" == "$candidate_sha" ]] || {
                    activate_gate || true
                    return 1
                }
            fi
        done
        ((terminal_count <= 1)) || {
            activate_gate || true
            return 1
        }
        ((terminal_count == 1)) && continue
        if [[ -e "$MAINTENANCE_FILE" || -L "$MAINTENANCE_FILE" ]]; then
            [[ -f "$MAINTENANCE_FILE" && ! -L "$MAINTENANCE_FILE" ]] || return 1
            gate_preexisting=1
        fi
        activate_gate || return 1
        pending_jobs+=("$candidate")
    done
    ((${#pending_jobs[@]} <= 1)) || {
        activate_gate || true
        die "multiple unfinished deployment jobs require manual inspection"
    }
    ((${#pending_jobs[@]} == 1)) || return 0
    candidate="${pending_jobs[0]}"
    validate_job_path "$candidate" || return 1
    phase="$(read_phase)" || return 1
    if [[ "$phase" == "ready" ]]; then
        [[ $gate_preexisting -eq 0 ]] || return 1
        wait_for_app_health || return 1
        wait_for_livekit_health || return 1
        remove_gate || return 1
        token="${candidate%.ready}"
        token="${token##*.}"
        unit_name="eduri-cd-${release_sha:0:12}-$token"
        systemd-run --quiet --collect --unit "$unit_name" \
            --property Type=exec \
            --property RuntimeMaxSec=40min \
            --property TimeoutStopSec=10min \
            --property KillMode=control-group \
            --property Restart=on-failure \
            --property RestartSec=5s \
            "$HELPER_DIR/cd-worker.sh" "$candidate"
        return
    fi
    flock -u 8
    if "$HELPER_DIR/cd-worker.sh" "$candidate"; then
        return 0
    fi
    [[ -f "$candidate/failed" && ! -L "$candidate/failed" \
        && "$(read_single_line "$candidate/failed")" == "$release_sha" ]]
}

[[ $EUID -eq 0 ]] || die "deployment worker must run as root"
for command_name in \
    bash chmod chown cmp curl date dirname docker env find flock grep head \
    install ln mktemp mv nginx python3 readlink realpath rm rmdir rsync \
    setpriv sort stat sync systemctl systemd-analyze systemd-run tar; do
    command -v "$command_name" >/dev/null 2>&1 \
        || die "required command is missing: $command_name"
done
[[ -x /usr/bin/docker ]] || die "required command is missing: /usr/bin/docker"

if [[ $# -eq 1 && "$1" == "--reconcile" ]]; then
    reconcile_jobs
    exit
fi
[[ $# -eq 1 ]] || die "usage: $0 JOB_PATH | --reconcile"
validate_job_path "$1" || die "invalid deployment job"
exec 8>"$QUEUE_LOCK"
flock -w 120 8 || die "another deployment worker is active"

phase="$(read_phase)" || die "invalid deployment phase"
if [[ -f "$job_path/succeeded" || -f "$job_path/failed" ]]; then
    terminal_written=1
    exit 0
fi

[[ -d "$APP_ROOT" && "$(realpath -e -- "$APP_ROOT")" == "$APP_ROOT" ]] \
    || die "unexpected application root"
[[ -f "$LOCK_FILE" && ! -L "$LOCK_FILE" ]] \
    || die "maintenance lock is missing or unsafe"
install -d -o root -g root -m 0700 "$RECOVERY_ROOT"
exec 9>"$LOCK_FILE"
flock -w 120 9 || die "another Eduri maintenance operation is running"
export EDURI_MAINTENANCE_LOCK_HELD=1

case "$phase" in
    rollback-required)
        load_recovery || die "cannot load rollback recovery state"
        rollback_release || die "automatic rollback failed"
        finish_failure || die "cannot finalize the rolled-back deployment"
        exit 1
        ;;
    commit-intent)
        release_path="$job_path/release"
        load_recovery || die "cannot load forward recovery state"
        commit_forward || die "cannot complete forward recovery"
        finish_success
        exit
        ;;
    committed)
        finish_success
        exit
        ;;
    rolled-back)
        finish_failure
        exit 1
        ;;
    ready)
        ;;
esac

[[ ! -e "$MAINTENANCE_FILE" && ! -L "$MAINTENANCE_FILE" ]] \
    || die "production maintenance gate is already active; inspect recovery state"
release_path="$job_path/release"
[[ -d "$release_path" && ! -L "$release_path" \
    && "$(realpath -e -- "$release_path")" == "$release_path" ]] \
    || die "job release tree is missing or unsafe"

prepare_generation || die "cannot prepare the deployment helper generation"
old_generation_target="$(validate_current_generation)" \
    || die "current deployment generation is unsafe"
if app_is_running; then
    old_container_id="$(compose_user ps --quiet app)"
    [[ -n "$old_container_id" ]] || die "cannot identify the running app container"
    old_app_image_id="$(/usr/bin/docker inspect --format '{{.Image}}' "$old_container_id")"
    [[ "$old_app_image_id" =~ ^sha256:[0-9a-f]{64}$ ]] \
        || die "cannot identify the running app image"
    /usr/bin/docker image inspect "$old_app_image_id" >/dev/null
else
    die "a healthy running production app is required before automatic CD"
fi
[[ -f "$DATA_ROOT/eduri.sqlite" ]] && old_database_existed=1

readonly candidate_image="eduri-app:cd-$release_sha"
printf 'Building release %s while production remains available.\n' "$release_sha"
build_context="$(mktemp -d /tmp/eduri-cd-build.XXXXXXXX)"
chown user1:user1 "$build_context"
rsync --archive --delete-delay --chown=user1:user1 \
    "$release_path/" "$build_context/"
run_as_user1 env EDURI_APP_IMAGE="$candidate_image" /usr/bin/docker compose \
    --project-directory "$build_context" \
    --file "$build_context/docker-compose.yml" \
    --env-file "$APP_ROOT/.env" build --pull app
run_as_user1 env EDURI_APP_IMAGE="$candidate_image" /usr/bin/docker compose \
    --project-directory "$build_context" \
    --file "$build_context/docker-compose.yml" \
    --env-file "$APP_ROOT/.env" pull livekit clamav
rm -rf -- "$build_context"
build_context=""

recovery_staging="$(mktemp -d "$RECOVERY_ROOT/.recovery.$release_sha.XXXXXXXX")"
install -d -o root -g root -m 0700 \
    "$recovery_staging/source" "$recovery_staging/edge"
rsync --archive "${RSYNC_EXCLUDES[@]}" \
    "$APP_ROOT/" "$recovery_staging/source/"
install -o root -g root -m 0644 "$EDGE_SITE" \
    "$recovery_staging/edge/eduri.ru.conf"
install -o root -g root -m 0755 "$EDGE_HOOK" \
    "$recovery_staging/edge/reload-nginx.sh"
grep -Fqx '    if (-f /etc/eduri/maintenance) {' \
    "$recovery_staging/edge/eduri.ru.conf" \
    || die "active nginx configuration lacks the maintenance gate"
find "$BACKUP_ROOT" -maxdepth 1 -type f \
    -name 'eduri-data-*.tar.gz' -printf '%f\n' \
    | sort >"$recovery_staging/backups.before"
printf '%s\n' "$old_app_image_id" >"$recovery_staging/old-app-image-id"
printf '%s\n' "$old_generation_target" >"$recovery_staging/old-generation-target"
printf '%s\n' "$old_database_existed" >"$recovery_staging/database-existed"
sync
recovery_path="$RECOVERY_ROOT/recovery.$release_sha.${recovery_staging##*.}"
mv -- "$recovery_staging" "$recovery_path"
recovery_staging=""
sync -f "$RECOVERY_ROOT"
durable_write "$job_path/recovery-name" "${recovery_path##*/}"
write_phase rollback-required

printf 'Release built; entering the short production cutover.\n'
activate_gate
compose_user stop --timeout 30 app
! app_is_running || die "old app is still running after the stop barrier"
if [[ $old_database_existed -eq 1 ]]; then
    run_as_user1 /bin/bash "$APP_ROOT/ops/scripts/backup.sh" --leave-stopped
else
    run_as_user1 /bin/bash "$APP_ROOT/ops/scripts/backup.sh" \
        --allow-empty --leave-stopped
fi
record_predeploy_backup || die "cannot identify the pre-deploy backup"
install_tree "$release_path"

compose_user up --detach --remove-orphans clamav livekit
wait_for_livekit_health || die "LiveKit did not become healthy before cutover"
/usr/bin/docker tag "$candidate_image" "$APP_IMAGE"
compose_user up --detach --no-deps --no-build app
wait_for_app_health || die "new app did not become healthy before cutover"
wait_for_livekit_health || die "LiveKit failed its final health check"
finalize_generation || die "cannot finalize the deployment helper generation"
write_phase commit-intent
commit_forward || die "cannot commit the new production release"
finish_success

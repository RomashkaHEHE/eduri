#!/usr/bin/env bash
set -Eeuo pipefail

[[ $# -eq 1 ]] || {
    printf 'Usage: %s HELPER_DIRECTORY\n' "$0" >&2
    exit 2
}

readonly helper_dir="$(realpath -e -- "$1")"
[[ -d "$helper_dir" && ! -L "$helper_dir" ]] || {
    printf 'ERROR: helper directory is missing or unsafe\n' >&2
    exit 1
}

for helper_name in \
    cd-receive.sh cd-worker.sh cd-validate-helpers.sh install-edge-config.sh; do
    [[ -f "$helper_dir/$helper_name" && ! -L "$helper_dir/$helper_name" ]] || {
        printf 'ERROR: missing helper: %s\n' "$helper_name" >&2
        exit 1
    }
    /bin/bash -n "$helper_dir/$helper_name"
done

[[ -f "$helper_dir/validate_cd_release.py" \
    && ! -L "$helper_dir/validate_cd_release.py" ]] || {
    printf 'ERROR: missing helper: validate_cd_release.py\n' >&2
    exit 1
}
python3 -c 'compile(open(__import__("sys").argv[1], encoding="utf-8").read(), __import__("sys").argv[1], "exec")' \
    "$helper_dir/validate_cd_release.py"

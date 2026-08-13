import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const workflow = readRepositoryFile(".github/workflows/deploy.yml");
const ciWorkflow = readRepositoryFile(".github/workflows/ci.yml");
const receiver = readRepositoryFile("ops/scripts/cd-receive.sh");
const worker = readRepositoryFile("ops/scripts/cd-worker.sh");
const backup = readRepositoryFile("ops/scripts/backup.sh");
const helperValidatorPath = new URL(
  "../../ops/scripts/cd-validate-helpers.sh",
  import.meta.url,
);
const helperValidator = readRepositoryFile("ops/scripts/cd-validate-helpers.sh");
const installer = readRepositoryFile("ops/scripts/install-cd-receiver.sh");
const common = readRepositoryFile("ops/scripts/_common.sh");
const edgeInstaller = readRepositoryFile("ops/scripts/install-edge-config.sh");
const reconcileUnit = readRepositoryFile(
  "ops/systemd/eduri-cd-reconcile.service",
);
const nginxReconcileDependency = readRepositoryFile(
  "ops/systemd/nginx.service.d/eduri-cd-reconcile.conf",
);

const temporaryDirectories: string[] = [];

function readRepositoryFile(relativePath: string): string {
  return readFileSync(new URL(`../../${relativePath}`, import.meta.url), "utf8");
}

function expectOrdered(source: string, snippets: string[]): void {
  let searchFrom = 0;
  for (const snippet of snippets) {
    const index = source.indexOf(snippet, searchFrom);
    expect(index, `Missing deployment step: ${snippet}`).toBeGreaterThanOrEqual(
      searchFrom,
    );
    searchFrom = index + snippet.length;
  }
}

function expectOrderedAfter(source: string, anchor: string, snippets: string[]): void {
  const anchorIndex = source.indexOf(anchor);
  expect(
    anchorIndex,
    `Missing deployment phase anchor: ${anchor}`,
  ).toBeGreaterThanOrEqual(0);
  expectOrdered(source.slice(anchorIndex + anchor.length), snippets);
}

function availableBash(): string | null {
  const candidates = process.platform === "win32"
    ? [
        "C:\\Program Files\\Git\\bin\\bash.exe",
        "C:\\Program Files (x86)\\Git\\bin\\bash.exe",
      ]
    : ["/bin/bash", "/usr/bin/bash"];
  return candidates.find(existsSync) ?? null;
}

function bashPath(value: string | URL): string {
  const filePath = value instanceof URL ? fileURLToPath(value) : value;
  if (process.platform !== "win32") return filePath;
  return filePath.replace(/^([A-Za-z]):[\\/]/u, (_, drive: string) => (
    `/${drive.toLowerCase()}/`
  )).replaceAll("\\", "/");
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("production continuous deployment contract", () => {
  it("syntax-checks every deployment shell helper separately in CI", () => {
    expect(ciWorkflow).toContain("while IFS= read -r -d '' script; do");
    expect(ciWorkflow).toContain('bash -n "$script"');
    expect(ciWorkflow).toContain("-name '*.sh' -print0");
    expect(ciWorkflow).toContain('test "$checked" -gt 0');
  });

  it("deploys only a successful same-repository push to main", () => {
    expect(workflow).toContain("github.event.workflow_run.conclusion == 'success'");
    expect(workflow).toContain("github.event.workflow_run.event == 'push'");
    expect(workflow).toContain("github.event.workflow_run.head_branch == 'main'");
    expect(workflow).toContain(
      "github.event.workflow_run.head_repository.full_name == github.repository",
    );
    expect(workflow).toContain("ref: ${{ env.DEPLOY_SHA }}");
    expect(workflow).toContain('test "$(git rev-parse HEAD)" = "$DEPLOY_SHA"');
    expectOrderedAfter(workflow, "- name: Deploy the verified revision", [
      "git ls-remote --exit-code origin refs/heads/main",
      'test "$current_main" = "$DEPLOY_SHA"',
      "root@eduri.ru",
    ]);
    expect(workflow).toContain("cancel-in-progress: false");
    expect(workflow).toContain(
      'grep -Fxq "EDURI_DEPLOYED_SHA=$DEPLOY_SHA" "$deploy_log"',
    );
    expect(workflow).toContain("https://eduri.ru/api/health");
  });

  it("pins host identity and sends a bounded checksummed archive", () => {
    expect(workflow).toContain("EDURI_CD_SSH_PRIVATE_KEY");
    expect(workflow).toContain("EDURI_CD_KNOWN_HOSTS");
    expect(workflow).toContain("StrictHostKeyChecking=yes");
    expect(workflow).toContain("IdentitiesOnly=yes");
    expect(workflow).toContain('test "$archive_bytes" -le 33554432');
    expect(workflow).toContain("EDURI_CD_V1 %s %s %s");
  });

  it("gives the deploy key only a forced generation-based receiver command", () => {
    expect(installer).toContain('restrict,command="%s"');
    expect(installer).toContain("ssh-ed25519");
    expect(installer).toContain('RECEIVER_TARGET="$CURRENT_LINK/cd-receive.sh"');
    expect(installer).toContain('mv -fT -- "$current_candidate" "$CURRENT_LINK"');
    expect(installer).toContain('"$CURRENT_LINK/deployed-sha"');
    expect(receiver).toContain('[[ -z "${SSH_ORIGINAL_COMMAND:-}" ]]');
    expect(receiver).toContain("MAX_ARCHIVE_BYTES=33554432");
    expect(receiver).toContain('WORKER="$HELPER_DIR/cd-worker.sh"');
    expect(receiver).not.toContain("APP_ROOT=");
    expect(receiver).not.toContain("rollback_release");
    expect(receiver).not.toContain("docker compose");
    expect(edgeInstaller).toContain("/usr/local/libexec/eduri/generations/*)");
  });

  it("durably bootstraps the generation, marker, boot dependency, and deploy key", () => {
    expectOrdered(installer, [
      'readonly bootstrap_sha="$2"',
      '[[ "$bootstrap_sha" =~ ^[0-9a-f]{40}$ ]]',
      '[[ -e "$MARKER_LINK" || -L "$MARKER_LINK" ]]',
      'install -d -o root -g root -m 0755',
      'flock -w 120 8',
    ]);
    expect(installer).toContain('sync -f "$generation_path/$helper_name"');
    expectOrdered(installer, [
      'sync -f "$generation_path/deployed-sha"',
      'sync -f "$generation_path"',
      'sync -f "$GENERATIONS_ROOT"',
      'mv -fT -- "$current_candidate" "$CURRENT_LINK"',
      'sync -f "$INSTALL_ROOT"',
      'mv -fT -- "$marker_candidate" "$MARKER_LINK"',
      'sync -f "$STATE_ROOT"',
      "systemd-analyze verify eduri-cd-reconcile.service nginx.service",
    ]);
    expect(installer).toContain('[[ "$marker_value" == "$bootstrap_sha" ]]');
    expect(installer).toContain('== "root:root:644:41"');
    expect(installer).toContain('stat -Lc \'%U:%G:%a:%s\' "$MARKER_LINK"');
    expect(installer).toContain(
      "nginx dependency drop-in has an unexpected contract",
    );
    expect(installer).toContain('sync -f "$nginx_dependency_candidate"');
    expect(installer).toContain('sync -f "$reconcile_candidate"');
    expect(installer).toContain(
      "systemd-analyze verify eduri-cd-reconcile.service nginx.service",
    );
    expectOrdered(installer, [
      'sync -f "$authorized_candidate"',
      'mv -fT -- "$authorized_candidate" "$AUTHORIZED_KEYS"',
      "sync -f /root/.ssh",
    ]);
    expect(nginxReconcileDependency).toContain(
      "Requires=eduri-cd-reconcile.service",
    );
    expect(nginxReconcileDependency).toContain(
      "After=eduri-cd-reconcile.service",
    );
    expect(reconcileUnit).toContain("Before=nginx.service");
    expect(reconcileUnit).toContain("Requires=docker.service");
    expect(reconcileUnit).not.toContain("After=nginx.service");
  });

  it("durably hands a validated release to an independent systemd worker", () => {
    expectOrderedAfter(
      receiver,
      'python3 "$VALIDATOR" "$archive_path" "$release_path"',
      [
        'job_staging="$(mktemp -d "$JOBS_ROOT/.job.$release_sha.XXXXXXXX")"',
        'mv -- "$job_staging" "$job_path"',
        'sync -f "$JOBS_ROOT"',
        "systemd-run \\",
        "handed_off=1",
      ],
    );
    expect(receiver).toContain("--property RuntimeMaxSec=40min");
    expect(receiver).toContain("--property KillMode=control-group");
    expect(receiver).toContain("--property Restart=on-failure");
    expect(receiver).toContain('"$WORKER" "$job_path"');
    expect(receiver).toContain('[[ -f "$job_path/succeeded"');
    expect(receiver).toContain('head -n 1 -- "$MARKER_FILE"');
    expect(receiver).toContain('[[ -f "$job_path/failed" ]]');
    expect(receiver).toContain("EDURI_DEPLOYED_SHA=%s");
  });

  it("prebuilds before mutation and keeps rollback independent of build or pull", () => {
    for (const protectedPath of [
      "/.env",
      "/.env.*",
      "/.maintenance.lock",
      "/.qa-board-v2/",
      "/backups/",
      "/data/",
      "/data-dev/",
      "/qa-data-*/",
    ]) {
      expect(worker).toContain(`--exclude=${protectedPath}`);
    }
    expectOrderedAfter(worker, 'readonly candidate_image="eduri-app:cd-$release_sha"', [
      'build --pull app',
      'recovery_staging="$(mktemp -d "$RECOVERY_ROOT/.recovery.$release_sha.XXXXXXXX")"',
      'mv -- "$recovery_staging" "$recovery_path"',
      "write_phase rollback-required",
      "activate_gate",
      "compose_user stop --timeout 30 app",
      '! app_is_running || die "old app is still running after the stop barrier"',
      "record_predeploy_backup",
      'install_tree "$release_path"',
    ]);
    expect(worker).toContain('/usr/bin/docker tag "$old_app_image_id" "$APP_IMAGE"');
    expect(worker).toContain("compose_user up --detach --no-build --pull never clamav livekit");
    expect(worker).toContain("compose_user up --detach --no-deps --no-build --pull never app");
    expect(worker).toContain('check_args+=(--allow-empty)');
    expect(worker).toContain('restore_predeploy_data');
    const restoreData = worker.slice(
      worker.indexOf("restore_predeploy_data()"),
      worker.indexOf("load_recovery()"),
    );
    expect(restoreData).toContain("compose_user stop --timeout 30 app");
    expect(restoreData).toContain("! app_is_running || return 1");
    expect(restoreData).toContain(
      'restore_staging="$APP_ROOT/.restore.cd-$release_sha-${restore_id##*.}"',
    );
    expectOrderedAfter(restoreData, 'chown -R user1:user1 "$restore_staging/data"', [
      "sync || return 1",
      'mv -- "$DATA_ROOT" "$failed_path"',
      'sync -f "$APP_ROOT"',
      'mv -- "$restore_staging/data" "$DATA_ROOT"',
      'sync -f "$APP_ROOT"',
      'durable_write "$recovery_path/data-restored" "$restore_id"',
    ]);
    expect(restoreData).toContain('failed_restore_id="$(read_single_line');
    expect(restoreData).not.toContain("stop --timeout 30 app >/dev/null 2>&1 || true");
    expectOrderedAfter(backup, 'chmod 0600 "$metadata_path"', [
      'sync -f "$archive_path"',
      'sync -f "$checksum_path"',
      'sync -f "$metadata_path"',
      'sync -f "$EDURI_BACKUP_DIR"',
    ]);
  });

  it("serializes mutations and commits a durable forward-only intent", () => {
    expect(worker).toContain('flock -w 120 9');
    expect(worker).toContain("EDURI_MAINTENANCE_LOCK_HELD=1");
    expect(worker).toContain(
      "setpriv --reuid=user1 --regid=user1 --init-groups --reset-env",
    );
    expect(common).toContain('readlink -f -- "/proc/$$/fd/9"');
    expectOrderedAfter(worker, "finalize_generation || die", [
      "write_phase commit-intent",
      "commit_forward",
      "finish_success",
    ]);
    expectOrderedAfter(worker, "commit_forward()", [
      "activate_gate",
      'switch_current_to "generations/release-$release_sha"',
      "install_reconcile_unit",
      "sync || return 1",
      "write_phase committed",
      "remove_gate",
    ]);
    const installTree = worker.slice(
      worker.indexOf("install_tree()"),
      worker.indexOf("record_predeploy_backup()"),
    );
    expect(installTree).not.toContain("install_reconcile_unit");
    expect(worker).toContain('sync -f "$nginx_candidate"');
    expect(worker).toContain(
      "systemd-analyze verify eduri-cd-reconcile.service nginx.service",
    );
    expect(worker).toContain("write_phase rolled-back");
    expect(reconcileUnit).toContain(
      "ExecStart=/usr/local/libexec/eduri/current/cd-worker.sh --reconcile",
    );
    expect(worker).toContain("trap 'exit 143' TERM");
    expect(worker).toContain("rollback_release");
    expect(worker).toContain(
      "maintenance gate and recovery are retained",
    );
    expect(worker).toContain('durable_write "$job_path/succeeded" "$release_sha"');
    const reconcile = worker.slice(worker.indexOf("reconcile_jobs()"));
    expectOrderedAfter(reconcile, 'for candidate in "$JOBS_ROOT"/job.*.ready', [
      "gate_preexisting=1",
      "activate_gate || return 1",
      'phase="$(read_phase)"',
      'if [[ "$phase" == "ready" ]]',
      '[[ $gate_preexisting -eq 0 ]]',
      "wait_for_app_health || return 1",
      "wait_for_livekit_health || return 1",
      "remove_gate || return 1",
    ]);
    expect(reconcile).toContain(
      '[[ -f "$candidate/failed" && ! -L "$candidate/failed"',
    );
  });

  it.skipIf(availableBash() === null)(
    "checks every shell helper rather than treating later paths as bash arguments",
    () => {
      const bash = availableBash();
      if (!bash) throw new Error("Bash disappeared during the test");

      const helperDirectory = mkdtempSync(path.join(os.tmpdir(), "eduri-cd-helpers-"));
      temporaryDirectories.push(helperDirectory);
      const validShell = "#!/usr/bin/env bash\n:\n";
      writeFileSync(path.join(helperDirectory, "cd-receive.sh"), validShell);
      writeFileSync(
        path.join(helperDirectory, "cd-worker.sh"),
        "#!/usr/bin/env bash\nif then\n",
      );
      writeFileSync(path.join(helperDirectory, "cd-validate-helpers.sh"), validShell);
      writeFileSync(path.join(helperDirectory, "install-edge-config.sh"), validShell);
      writeFileSync(path.join(helperDirectory, "validate_cd_release.py"), "pass\n");

      const result = spawnSync(
        bash,
        [bashPath(helperValidatorPath), bashPath(helperDirectory)],
        {
          encoding: "utf8",
        },
      );
      expect(result.status).not.toBe(0);
      expect(`${result.stdout}\n${result.stderr}`).toMatch(/syntax error/u);
      expect(helperValidator).toContain('/bin/bash -n "$helper_dir/$helper_name"');
    },
  );
});

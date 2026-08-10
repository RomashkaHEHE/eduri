import * as Y from "yjs";
import {
  CODE_WORKSPACE_MAIN_ENTRY_ID,
  applyCodeWorkspaceStableFileCommands,
  listCodeWorkspaceEntries,
  workspaceFilePaths,
  type CodeWorkspaceBlobIdentity,
  type CodeWorkspaceEntrySnapshot,
  type CodeWorkspaceStableFileCommand,
  type CodeWorkspaceStableFileContent,
} from "../../code/core/index.js";
import {
  PYTHON_RUNNER_WORKSPACE_LIMITS,
  PYTHON_WORKSPACE_DELTA_VERSION,
  type PythonRunnerDirectory,
  type PythonRunnerFile,
  type PythonRunnerFileBaseIdentity,
  type PythonWorkspaceDelta,
  type PythonWorkspaceDeltaChange,
} from "../pythonRunner.js";

export interface PythonWorkspaceBlobStore {
  put(blob: Blob): Promise<CodeWorkspaceBlobIdentity>;
  get(identity: CodeWorkspaceBlobIdentity): Promise<Blob | null>;
}

interface PythonWorkspaceBaselineFile {
  readonly entry: CodeWorkspaceEntrySnapshot;
  readonly path: string;
  readonly base: PythonRunnerFileBaseIdentity;
}

interface PythonWorkspaceBaselineDirectory {
  readonly entryId: string;
  readonly path: string;
}

export interface PythonWorkspaceRunBaseline {
  readonly runnerFiles: readonly PythonRunnerFile[];
  readonly runnerDirectories: readonly PythonRunnerDirectory[];
  readonly files: readonly PythonWorkspaceBaselineFile[];
  readonly directories: readonly PythonWorkspaceBaselineDirectory[];
}

export interface PythonWorkspaceDeltaConflict {
  readonly path: string;
  readonly reason:
    | "changed-since-run"
    | "main-file-required"
    | "path-conflict"
    | "parent-conflict";
}

export interface PythonWorkspaceDeltaApplyResult {
  readonly appliedPaths: readonly string[];
  readonly conflicts: readonly PythonWorkspaceDeltaConflict[];
  readonly aborted: boolean;
}

interface PreparedWrite {
  readonly change: Extract<PythonWorkspaceDeltaChange, { readonly kind: "write" }>;
  readonly text: string | null;
}

type PlannedFileCommand =
  | {
      readonly kind: "replace-file";
      readonly entryId: string;
      readonly path: string;
      readonly write: PreparedWrite;
    }
  | {
      readonly kind: "remove-file";
      readonly entryId: string;
      readonly path: string;
    }
  | {
      readonly kind: "create-folder";
      readonly entryId: string;
      readonly parentId: string | null;
      readonly name: string;
    }
  | {
      readonly kind: "create-file";
      readonly entryId: string;
      readonly parentId: string | null;
      readonly name: string;
      readonly path: string;
      readonly write: PreparedWrite;
    };

interface DeltaPlan {
  readonly commands: readonly PlannedFileCommand[];
  readonly acceptedPaths: ReadonlySet<string>;
  readonly conflicts: readonly PythonWorkspaceDeltaConflict[];
}

function comparablePath(path: string): string {
  return path.toLocaleLowerCase("en-US");
}

function comparePaths(left: string, right: string): number {
  return comparablePath(left).localeCompare(comparablePath(right))
    || left.localeCompare(right);
}

function sameBlobIdentity(
  left: CodeWorkspaceBlobIdentity | null,
  right: CodeWorkspaceBlobIdentity | null,
): boolean {
  return left === null
    ? right === null
    : right !== null
      && left.sha256 === right.sha256
      && left.byteSize === right.byteSize
      && left.mimeType === right.mimeType;
}

function exactBaselineFile(
  current: CodeWorkspaceEntrySnapshot | undefined,
  currentPath: string | undefined,
  baseline: PythonWorkspaceBaselineFile,
): boolean {
  if (
    !current
    || current.kind !== "file"
    || currentPath !== baseline.path
    || current.contentKind !== baseline.entry.contentKind
  ) return false;
  return current.contentKind === "text"
    ? current.text === baseline.entry.text
    : sameBlobIdentity(current.blob, baseline.entry.blob);
}

function utf8Text(bytes: Uint8Array): string | null {
  if (bytes.includes(0)) return null;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

function hex(bytes: Uint8Array): string {
  return [...bytes].map((value) => value.toString(16).padStart(2, "0")).join("");
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const copy = bytes.slice();
  return hex(new Uint8Array(await crypto.subtle.digest("SHA-256", copy.buffer)));
}

export async function capturePythonWorkspaceRunBaseline(
  document: Y.Doc,
  blobStore: PythonWorkspaceBlobStore,
): Promise<PythonWorkspaceRunBaseline> {
  const entries = listCodeWorkspaceEntries(document);
  const paths = workspaceFilePaths(document);
  if (entries.length > PYTHON_RUNNER_WORKSPACE_LIMITS.maxEntries) {
    throw new Error("Workspace exceeds the Python execution entry limit");
  }
  const directoryEntries = entries
    .filter((entry) => entry.kind === "folder")
    .map((entry) => ({ entry, path: paths.get(entry.id)! }))
    .sort((left, right) => comparePaths(left.path, right.path));
  const fileEntries = entries
    .filter((entry) => entry.kind === "file")
    .map((entry) => ({ entry, path: paths.get(entry.id)! }))
    .sort((left, right) => comparePaths(left.path, right.path));
  let totalBytes = 0;
  const captured: Array<{
    entry: CodeWorkspaceEntrySnapshot;
    path: string;
    base: PythonRunnerFileBaseIdentity;
    runnerFile: PythonRunnerFile;
  }> = [];
  for (const { entry, path } of fileEntries) {
    let bytes: Uint8Array;
    if (entry.contentKind === "blob") {
      if (!entry.blob) throw new Error(`File ${path} has no blob identity`);
      const blob = await blobStore.get(entry.blob);
      if (!blob) throw new Error(`File ${path} is unavailable on this device`);
      bytes = new Uint8Array(await blob.arrayBuffer());
    } else {
      bytes = new TextEncoder().encode(entry.text ?? "");
    }
    if (bytes.byteLength > PYTHON_RUNNER_WORKSPACE_LIMITS.maxFileBytes) {
      throw new Error(`File ${path} exceeds the Python execution size limit`);
    }
    totalBytes += bytes.byteLength;
    if (totalBytes > PYTHON_RUNNER_WORKSPACE_LIMITS.maxTotalBytes) {
      throw new Error("Workspace exceeds the Python execution aggregate limit");
    }
    const contentSha256 = await sha256(bytes);
    if (
      entry.contentKind === "blob"
      && entry.blob
      && (
        bytes.byteLength !== entry.blob.byteSize
        || contentSha256 !== entry.blob.sha256
      )
    ) {
      throw new Error(`File ${path} failed its content identity check`);
    }
    const base: PythonRunnerFileBaseIdentity = {
      entryId: entry.id,
      contentKind: entry.contentKind === "blob" ? "blob" : "text",
      sha256: contentSha256,
      byteSize: bytes.byteLength,
    };
    captured.push({
      entry: {
        ...entry,
        blob: entry.blob ? { ...entry.blob } : null,
      },
      path,
      base,
      runnerFile: entry.contentKind === "blob"
        ? { path, base, bytes } as const
        : { path, base, content: entry.text ?? "" } as const,
    });
  }
  return {
    runnerFiles: captured.map((file) => file.runnerFile),
    runnerDirectories: directoryEntries.map(({ entry, path }) => ({
      entryId: entry.id,
      path,
    })),
    files: captured.map(({ entry, path, base }) => ({ entry, path, base })),
    directories: directoryEntries.map(({ entry, path }) => ({
      entryId: entry.id,
      path,
    })),
  };
}

function sameRunnerBase(
  left: PythonRunnerFileBaseIdentity,
  right: PythonRunnerFileBaseIdentity,
): boolean {
  return left.entryId === right.entryId
    && left.contentKind === right.contentKind
    && left.sha256 === right.sha256
    && left.byteSize === right.byteSize;
}

function planDelta(
  document: Y.Doc,
  baseline: PythonWorkspaceRunBaseline,
  delta: PythonWorkspaceDelta,
  preparedByPath: ReadonlyMap<string, PreparedWrite>,
  newEntryIds: Map<string, string>,
  createEntryId: () => string,
  allowedPaths?: ReadonlySet<string>,
): DeltaPlan {
  const current = listCodeWorkspaceEntries(document);
  const paths = workspaceFilePaths(document);
  const currentById = new Map(current.map((entry) => [entry.id, entry]));
  const currentByPath = new Map(current.map((entry) => (
    [comparablePath(paths.get(entry.id)!), entry] as const
  )));
  const baselineFilesById = new Map(baseline.files.map((file) => (
    [file.entry.id, file] as const
  )));
  const baselineDirectoriesByPath = new Map(baseline.directories.map((directory) => (
    [comparablePath(directory.path), directory] as const
  )));
  const commands: PlannedFileCommand[] = [];
  const conflicts: PythonWorkspaceDeltaConflict[] = [];
  const acceptedPaths = new Set<string>();
  const plannedFolders = new Map<string, string>();
  const blockedDirectoryReplacements = new Set(delta.changes.flatMap((change) => {
    if (change.kind !== "write" || change.base !== null) return [];
    const pathKey = comparablePath(change.path);
    return currentByPath.get(pathKey)?.kind === "folder" ? [pathKey] : [];
  }));
  const nextId = (key: string): string => {
    const existing = newEntryIds.get(key);
    if (existing) return existing;
    const created = createEntryId();
    newEntryIds.set(key, created);
    return created;
  };

  for (const change of delta.changes) {
    const pathKey = comparablePath(change.path);
    if (allowedPaths && !allowedPaths.has(pathKey)) {
      continue;
    }
    const blockedDirectory = [...blockedDirectoryReplacements].find((directory) => (
      pathKey === directory || pathKey.startsWith(`${directory}/`)
    ));
    if (blockedDirectory) {
      conflicts.push({
        path: change.path,
        reason: pathKey === blockedDirectory ? "path-conflict" : "parent-conflict",
      });
      continue;
    }
    if (change.base !== null) {
      const baselineFile = baselineFilesById.get(change.base.entryId);
      if (
        !baselineFile
        || baselineFile.path !== change.path
        || !sameRunnerBase(baselineFile.base, change.base)
        || !exactBaselineFile(
          currentById.get(change.base.entryId),
          paths.get(change.base.entryId),
          baselineFile,
        )
      ) {
        conflicts.push({ path: change.path, reason: "changed-since-run" });
        continue;
      }
      if (change.kind === "delete") {
        if (change.base.entryId === CODE_WORKSPACE_MAIN_ENTRY_ID) {
          conflicts.push({ path: change.path, reason: "main-file-required" });
          continue;
        }
        commands.push({
          kind: "remove-file",
          entryId: change.base.entryId,
          path: change.path,
        });
        currentByPath.delete(pathKey);
      } else {
        commands.push({
          kind: "replace-file",
          entryId: change.base.entryId,
          path: change.path,
          write: preparedByPath.get(pathKey)!,
        });
      }
      acceptedPaths.add(pathKey);
      continue;
    }

    if (change.kind !== "write" || currentByPath.has(pathKey)) {
      conflicts.push({ path: change.path, reason: "path-conflict" });
      continue;
    }
    const segments = change.path.split("/");
    let parentId: string | null = null;
    let parentPath = "";
    let parentConflict = false;
    const pendingFolders: Array<Extract<
      PlannedFileCommand,
      { readonly kind: "create-folder" }
    >> = [];
    const pendingFolderIds = new Map<string, string>();
    for (const segment of segments.slice(0, -1)) {
      parentPath = parentPath ? `${parentPath}/${segment}` : segment;
      const parentKey = comparablePath(parentPath);
      const plannedParent = plannedFolders.get(parentKey);
      if (plannedParent) {
        parentId = plannedParent;
        continue;
      }
      const pendingParent = pendingFolderIds.get(parentKey);
      if (pendingParent) {
        parentId = pendingParent;
        continue;
      }
      const baselineDirectory = baselineDirectoriesByPath.get(parentKey);
      if (baselineDirectory) {
        const currentParent = currentById.get(baselineDirectory.entryId);
        if (
          !currentParent
          || currentParent.kind !== "folder"
          || paths.get(currentParent.id) !== baselineDirectory.path
        ) {
          parentConflict = true;
          break;
        }
        parentId = currentParent.id;
        plannedFolders.set(parentKey, parentId);
        continue;
      }
      if (currentByPath.has(parentKey)) {
        parentConflict = true;
        break;
      }
      const folderId = nextId(`folder:${parentKey}`);
      pendingFolders.push({
        kind: "create-folder",
        entryId: folderId,
        parentId,
        name: segment,
      });
      pendingFolderIds.set(parentKey, folderId);
      parentId = folderId;
    }
    if (parentConflict) {
      conflicts.push({ path: change.path, reason: "parent-conflict" });
      continue;
    }
    commands.push(...pendingFolders);
    for (const [folderPath, folderId] of pendingFolderIds) {
      plannedFolders.set(folderPath, folderId);
    }
    commands.push({
      kind: "create-file",
      entryId: nextId(`file:${pathKey}`),
      parentId,
      name: segments.at(-1)!,
      path: change.path,
      write: preparedByPath.get(pathKey)!,
    });
    acceptedPaths.add(pathKey);
  }
  return { commands, acceptedPaths, conflicts };
}

function coreContent(
  write: PreparedWrite,
  published: ReadonlyMap<string, CodeWorkspaceBlobIdentity>,
): CodeWorkspaceStableFileContent {
  if (write.text !== null) return { kind: "text", text: write.text };
  const blob = published.get(comparablePath(write.change.path));
  if (!blob) throw new Error(`Binary result ${write.change.path} was not published`);
  return { kind: "blob", blob };
}

export async function applyPythonWorkspaceDelta(options: {
  readonly document: Y.Doc;
  readonly origin?: unknown;
  readonly blobStore: PythonWorkspaceBlobStore;
  readonly baseline: PythonWorkspaceRunBaseline;
  readonly delta: PythonWorkspaceDelta;
  readonly canApply?: () => boolean;
  readonly createEntryId?: () => string;
}): Promise<PythonWorkspaceDeltaApplyResult> {
  if (options.delta.version !== PYTHON_WORKSPACE_DELTA_VERSION) {
    throw new Error("Python workspace delta version is unsupported");
  }
  if (options.canApply && !options.canApply()) {
    return { appliedPaths: [], conflicts: [], aborted: true };
  }
  const preparedByPath = new Map<string, PreparedWrite>();
  for (const change of options.delta.changes) {
    if (change.kind !== "write") continue;
    preparedByPath.set(comparablePath(change.path), {
      change,
      text: utf8Text(change.bytes),
    });
  }
  const newEntryIds = new Map<string, string>();
  const createEntryId = options.createEntryId ?? (() => crypto.randomUUID());
  const preliminary = planDelta(
    options.document,
    options.baseline,
    options.delta,
    preparedByPath,
    newEntryIds,
    createEntryId,
  );
  const published = new Map<string, CodeWorkspaceBlobIdentity>();
  await Promise.all(preliminary.commands.map(async (command) => {
    if (
      command.kind !== "replace-file"
      && command.kind !== "create-file"
    ) return;
    if (command.write.text !== null) return;
    const pathKey = comparablePath(command.path);
    if (published.has(pathKey)) return;
    const baselineFile = command.write.change.base
      ? options.baseline.files.find((file) => (
        file.entry.id === command.write.change.base?.entryId
      ))
      : undefined;
    const mimeType = baselineFile?.entry.blob?.mimeType
      ?? "application/octet-stream";
    const bytes = command.write.change.bytes.slice();
    const identity = await options.blobStore.put(new Blob(
      [bytes.buffer],
      { type: mimeType },
    ));
    published.set(pathKey, identity);
  }));
  if (options.canApply && !options.canApply()) {
    return { appliedPaths: [], conflicts: [], aborted: true };
  }
  const finalPlan = planDelta(
    options.document,
    options.baseline,
    options.delta,
    preparedByPath,
    newEntryIds,
    createEntryId,
    preliminary.acceptedPaths,
  );
  const commands: CodeWorkspaceStableFileCommand[] = finalPlan.commands.map((command) => {
    if (command.kind === "remove-file" || command.kind === "create-folder") {
      return command;
    }
    if (command.kind === "replace-file") {
      return {
        kind: "replace-file",
        entryId: command.entryId,
        content: coreContent(command.write, published),
      };
    }
    return {
      kind: "create-file",
      entryId: command.entryId,
      parentId: command.parentId,
      name: command.name,
      content: coreContent(command.write, published),
    };
  });
  if (options.canApply && !options.canApply()) {
    return { appliedPaths: [], conflicts: [], aborted: true };
  }
  applyCodeWorkspaceStableFileCommands(
    options.document,
    commands,
    options.origin,
  );
  const appliedPaths = finalPlan.commands
    .filter((command) => command.kind !== "create-folder")
    .map((command) => command.path)
    .sort(comparePaths);
  return {
    appliedPaths,
    conflicts: [...preliminary.conflicts, ...finalPlan.conflicts],
    aborted: false,
  };
}

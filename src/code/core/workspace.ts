import * as Y from "yjs";

export const CODE_WORKSPACE_SCHEMA_VERSION = 1;
export const CODE_WORKSPACE_MAIN_ENTRY_ID = "main-py";
export const CODE_WORKSPACE_MAX_ENTRIES = 512;
export const CODE_WORKSPACE_MAX_NAME_CODE_UNITS = 128;
export const CODE_WORKSPACE_MAX_TEXT_CODE_UNITS = 2 * 1024 * 1024;
export const CODE_WORKSPACE_MAX_TOTAL_TEXT_CODE_UNITS = 32 * 1024 * 1024;
export const CODE_WORKSPACE_MAX_DEPTH = 32;
export const CODE_WORKSPACE_MAX_PATH_CODE_UNITS = 1024;
export const CODE_WORKSPACE_MAX_TEST_CASES = 100;
export const CODE_WORKSPACE_MAX_TEST_TEXT_CODE_UNITS = 1024 * 1024;
export const CODE_TEST_TIMEOUT_DEFAULT_MS = 5_000;
export const CODE_TEST_TIMEOUT_MIN_MS = 250;
export const CODE_TEST_TIMEOUT_MAX_MS = 45_000;
export const CODE_WORKSPACE_ENTRIES_KEY = "entries";
export const CODE_WORKSPACE_META_KEY = "meta";
export const CODE_WORKSPACE_TEST_CASES_KEY = "testCases";

export type CodeWorkspaceEntryKind = "file" | "folder";
export type CodeWorkspaceFileContentKind = "text" | "blob";

export interface CodeWorkspaceBlobIdentity {
  sha256: string;
  byteSize: number;
  mimeType: string;
}

export interface CodeWorkspaceEntrySnapshot {
  id: string;
  kind: CodeWorkspaceEntryKind;
  parentId: string | null;
  name: string;
  rank: string;
  text: string | null;
  contentKind: CodeWorkspaceFileContentKind | null;
  blob: CodeWorkspaceBlobIdentity | null;
}

export interface CodeWorkspaceDraft {
  id?: string;
  kind: CodeWorkspaceEntryKind;
  parentId?: string | null;
  name: string;
  rank?: string;
  text?: string;
  blob?: CodeWorkspaceBlobIdentity;
}

export type CodeWorkspaceStableFileContent =
  | {
      readonly kind: "text";
      readonly text: string;
    }
  | {
      readonly kind: "blob";
      readonly blob: CodeWorkspaceBlobIdentity;
    };

export type CodeWorkspaceStableFileCommand =
  | {
      readonly kind: "replace-file";
      readonly entryId: string;
      readonly content: CodeWorkspaceStableFileContent;
    }
  | {
      readonly kind: "remove-file";
      readonly entryId: string;
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
      readonly content: CodeWorkspaceStableFileContent;
    };

export function compareCodeTestOutput(
  actual: string,
  expected: string,
): boolean {
  const normalize = (value: string) => value
    .replace(/\r\n?/gu, "\n")
    .replace(/\n$/u, "");
  return normalize(actual) === normalize(expected);
}

export interface CodeTestCaseSnapshot {
  id: string;
  entryId: string;
  name: string;
  rank: string;
  timeoutMs: number;
  stdin: string;
  expectedOutput: string;
}

export interface CodeTestCaseDraft {
  id?: string;
  entryId?: string;
  name: string;
  rank?: string;
  timeoutMs?: number;
  stdin?: string;
  expectedOutput?: string;
}

const ENTRY_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/u;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const MIME_PATTERN = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/u;
const FORBIDDEN_NAME_PATTERN = /[\u0000-\u001f/\\]/u;

export class CodeWorkspaceError extends Error {
  constructor(
    public readonly code:
      | "INVALID_ENTRY"
      | "DUPLICATE_NAME"
      | "MISSING_PARENT"
      | "ENTRY_LIMIT"
      | "TEXT_LIMIT"
      | "TEST_LIMIT"
      | "INVALID_DOCUMENT",
    message: string,
  ) {
    super(message);
    this.name = "CodeWorkspaceError";
  }
}

export function codeWorkspaceEntries(
  document: Y.Doc,
): Y.Map<Y.Map<unknown>> {
  return document.getMap<Y.Map<unknown>>(CODE_WORKSPACE_ENTRIES_KEY);
}

export function codeWorkspaceMeta(document: Y.Doc): Y.Map<unknown> {
  return document.getMap(CODE_WORKSPACE_META_KEY);
}

export function codeWorkspaceTestCases(
  document: Y.Doc,
): Y.Map<Y.Map<unknown>> {
  return document.getMap<Y.Map<unknown>>(CODE_WORKSPACE_TEST_CASES_KEY);
}

export function normalizeCodeWorkspaceName(value: string): string {
  const normalized = value.normalize("NFKC").trim();
  if (
    normalized.length < 1
    || normalized.length > CODE_WORKSPACE_MAX_NAME_CODE_UNITS
    || normalized === "."
    || normalized === ".."
    || FORBIDDEN_NAME_PATTERN.test(normalized)
  ) {
    throw new CodeWorkspaceError("INVALID_ENTRY", "Invalid workspace entry name");
  }
  return normalized;
}

function comparableName(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("en-US");
}

function totalWorkspaceText(
  entries: Y.Map<Y.Map<unknown>>,
  exceptId?: string,
): number {
  let total = 0;
  for (const [id, entry] of entries) {
    if (id === exceptId) continue;
    const text = entry.get("text");
    if (text instanceof Y.Text) total += text.length;
  }
  return total;
}

function assertWorkspaceTextLimit(
  entries: Y.Map<Y.Map<unknown>>,
  valueLength: number,
  exceptId?: string,
): void {
  if (
    valueLength > CODE_WORKSPACE_MAX_TEXT_CODE_UNITS
    || totalWorkspaceText(entries, exceptId) + valueLength
      > CODE_WORKSPACE_MAX_TOTAL_TEXT_CODE_UNITS
  ) {
    throw new CodeWorkspaceError("TEXT_LIMIT", "Workspace text limit reached");
  }
}

function entryKind(value: unknown): CodeWorkspaceEntryKind | null {
  return value === "file" || value === "folder" ? value : null;
}

function readEntry(
  id: string,
  value: Y.Map<unknown>,
): CodeWorkspaceEntrySnapshot | null {
  const kind = entryKind(value.get("kind"));
  const name = value.get("name");
  const parentId = value.get("parentId");
  const rank = value.get("rank");
  const text = value.get("text");
  const contentKind = value.get("contentKind") ?? "text";
  const blobSha256 = value.get("blobSha256");
  const blobByteSize = value.get("blobByteSize");
  const blobMimeType = value.get("blobMimeType");
  if (
    !ENTRY_ID_PATTERN.test(id)
    || !kind
    || typeof name !== "string"
    || (
      parentId !== null
      && (typeof parentId !== "string" || !ENTRY_ID_PATTERN.test(parentId))
    )
    || typeof rank !== "string"
    || (
      kind === "file"
      && contentKind !== "text"
      && contentKind !== "blob"
    )
    || (
      kind === "file"
      && contentKind === "text"
      && !(text instanceof Y.Text)
    )
    || (
      kind === "file"
      && contentKind === "blob"
      && (
        text !== undefined
        || typeof blobSha256 !== "string"
        || !SHA256_PATTERN.test(blobSha256)
        || typeof blobByteSize !== "number"
        || !Number.isSafeInteger(blobByteSize)
        || blobByteSize < 1
        || typeof blobMimeType !== "string"
        || !MIME_PATTERN.test(blobMimeType)
      )
    )
    || (
      kind === "folder"
      && (
        text !== undefined
        || value.get("contentKind") !== undefined
        || blobSha256 !== undefined
        || blobByteSize !== undefined
        || blobMimeType !== undefined
      )
    )
  ) return null;
  return {
    id,
    kind,
    parentId,
    name,
    rank,
    text: text instanceof Y.Text ? text.toString() : null,
    contentKind: kind === "file"
      ? contentKind as CodeWorkspaceFileContentKind
      : null,
    blob: kind === "file" && contentKind === "blob"
      ? {
          sha256: blobSha256 as string,
          byteSize: blobByteSize as number,
          mimeType: blobMimeType as string,
        }
      : null,
  };
}

function rawCodeWorkspaceEntries(
  document: Y.Doc,
): CodeWorkspaceEntrySnapshot[] {
  return [...codeWorkspaceEntries(document).entries()]
    .map(([id, value]) => readEntry(id, value))
    .filter((entry): entry is CodeWorkspaceEntrySnapshot => entry !== null);
}

export function listCodeWorkspaceEntries(
  document: Y.Doc,
): readonly CodeWorkspaceEntrySnapshot[] {
  return normalizeCodeWorkspaceEntries(
    rawCodeWorkspaceEntries(document),
  )
    .sort((left, right) => (
      (left.parentId ?? "").localeCompare(right.parentId ?? "")
      || left.rank.localeCompare(right.rank)
      || left.id.localeCompare(right.id)
    ));
}

function compareStableIds(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function resolvedSiblingNames(
  entries: readonly CodeWorkspaceEntrySnapshot[],
): ReadonlyMap<string, string> {
  const resolvedNames = new Map<string, string>();
  const byParent = new Map<string, CodeWorkspaceEntrySnapshot[]>();
  for (const entry of entries) {
    const key = entry.parentId ?? "";
    const siblings = byParent.get(key) ?? [];
    siblings.push(entry);
    byParent.set(key, siblings);
  }
  for (const siblings of byParent.values()) {
    const used = new Set<string>();
    for (const entry of [...siblings].sort((left, right) => (
      compareStableIds(left.id, right.id)
    ))) {
      let resolved = entry.name;
      if (used.has(comparableName(resolved))) {
        const dot = entry.name.lastIndexOf(".");
        const stem = dot > 0 ? entry.name.slice(0, dot) : entry.name;
        const extension = dot > 0 ? entry.name.slice(dot) : "";
        resolved = `${stem}~${entry.id}${extension}`;
        let collision = 2;
        while (used.has(comparableName(resolved))) {
          resolved = `${stem}~${entry.id}-${collision}${extension}`;
          collision += 1;
        }
      }
      used.add(comparableName(resolved));
      resolvedNames.set(entry.id, resolved);
    }
  }
  return resolvedNames;
}

function normalizeCodeWorkspaceEntries(
  entries: readonly CodeWorkspaceEntrySnapshot[],
): CodeWorkspaceEntrySnapshot[] {
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const parentById = new Map<string, string | null>();
  for (const entry of entries) {
    const parent = entry.parentId === null ? null : byId.get(entry.parentId);
    parentById.set(
      entry.id,
      parent && parent.kind === "folder" && parent.id !== entry.id
        ? parent.id
        : null,
    );
  }

  // Concurrent assignments can form a cycle even though every local move was
  // valid. Break exactly one edge per cycle by stable entry ID so every
  // implementation derives the same forest without emitting repair updates.
  const resolved = new Set<string>();
  for (const startId of [...byId.keys()].sort(compareStableIds)) {
    if (resolved.has(startId)) continue;
    const path: string[] = [];
    const indexById = new Map<string, number>();
    let cursor: string | null = startId;
    while (
      cursor !== null
      && !resolved.has(cursor)
      && !indexById.has(cursor)
    ) {
      indexById.set(cursor, path.length);
      path.push(cursor);
      cursor = parentById.get(cursor) ?? null;
    }
    if (cursor !== null) {
      const cycleStart = indexById.get(cursor);
      if (cycleStart !== undefined) {
        const detached = path
          .slice(cycleStart)
          .sort(compareStableIds)[0];
        if (detached !== undefined) parentById.set(detached, null);
      }
    }
    for (const id of path) resolved.add(id);
  }

  // Detach only the first edge that crosses the depth limit. Descendants stay
  // attached to that newly rooted subtree instead of being discarded.
  const depthById = new Map<string, number>();
  const depthFor = (id: string): number => {
    const cached = depthById.get(id);
    if (cached !== undefined) return cached;
    const parentId = parentById.get(id) ?? null;
    if (parentId === null) {
      depthById.set(id, 0);
      return 0;
    }
    const depth = depthFor(parentId) + 1;
    if (depth > CODE_WORKSPACE_MAX_DEPTH) {
      parentById.set(id, null);
      depthById.set(id, 0);
      return 0;
    }
    depthById.set(id, depth);
    return depth;
  };
  for (const id of [...byId.keys()].sort(compareStableIds)) depthFor(id);

  // Moving two valid subtrees together can also exceed the path bound. Edges
  // are only detached, never reattached, so this reaches a stable fixed point.
  for (let pass = 0; pass <= entries.length; pass += 1) {
    const effective = entries.map((entry) => ({
      ...entry,
      parentId: parentById.get(entry.id) ?? null,
    }));
    const effectiveById = new Map(effective.map((entry) => [entry.id, entry]));
    const names = resolvedSiblingNames(effective);
    const paths = new Map<string, string>();
    const firstOverflow = new Set<string>();
    const pathFor = (id: string): string => {
      const cached = paths.get(id);
      if (cached !== undefined) return cached;
      const entry = effectiveById.get(id)!;
      const parentId = entry.parentId;
      const segment = names.get(id) ?? entry.name;
      if (parentId === null) {
        paths.set(id, segment);
        return segment;
      }
      const parentPath = pathFor(parentId);
      const path = `${parentPath}/${segment}`;
      if (
        parentPath.length <= CODE_WORKSPACE_MAX_PATH_CODE_UNITS
        && path.length > CODE_WORKSPACE_MAX_PATH_CODE_UNITS
      ) {
        firstOverflow.add(id);
      }
      paths.set(id, path);
      return path;
    };
    for (const id of [...byId.keys()].sort(compareStableIds)) pathFor(id);
    if (firstOverflow.size === 0) break;
    for (const id of firstOverflow) parentById.set(id, null);
  }

  return entries.map((entry) => ({
    ...entry,
    parentId: parentById.get(entry.id) ?? null,
  }));
}

function assertProspectiveTree(
  before: readonly CodeWorkspaceEntrySnapshot[],
  after: readonly CodeWorkspaceEntrySnapshot[],
  expectedParentChanges: ReadonlyMap<string, string | null>,
): void {
  const beforeParents = new Map(normalizeCodeWorkspaceEntries(before)
    .map((entry) => [entry.id, entry.parentId]));
  const afterParents = new Map(normalizeCodeWorkspaceEntries(after)
    .map((entry) => [entry.id, entry.parentId]));
  for (const id of expectedParentChanges.keys()) {
    if (!afterParents.has(id)) {
      throw new CodeWorkspaceError(
        "INVALID_DOCUMENT",
        "Workspace entries are invalid",
      );
    }
  }
  for (const [id, parentId] of afterParents) {
    const expected = expectedParentChanges.has(id)
      ? expectedParentChanges.get(id)
      : beforeParents.get(id);
    if (parentId !== expected) {
      throw new CodeWorkspaceError(
        "INVALID_ENTRY",
        "Workspace change would create an invalid tree",
      );
    }
  }
}

function assertParent(
  entries: Y.Map<Y.Map<unknown>>,
  parentId: string | null,
): void {
  if (parentId === null) return;
  const parent = entries.get(parentId);
  if (!parent || parent.get("kind") !== "folder") {
    throw new CodeWorkspaceError("MISSING_PARENT", "Workspace folder does not exist");
  }
}

function assertUniqueName(
  document: Y.Doc,
  parentId: string | null,
  name: string,
  exceptId?: string,
): void {
  const comparable = comparableName(name);
  for (const entry of listCodeWorkspaceEntries(document)) {
    if (entry.id === exceptId || entry.parentId !== parentId) continue;
    if (comparableName(entry.name) === comparable) {
      throw new CodeWorkspaceError(
        "DUPLICATE_NAME",
        "A sibling entry already uses this name",
      );
    }
  }
}

export function addCodeWorkspaceEntry(
  document: Y.Doc,
  draft: CodeWorkspaceDraft,
  origin?: unknown,
): string {
  const entries = codeWorkspaceEntries(document);
  if (entries.size >= CODE_WORKSPACE_MAX_ENTRIES) {
    throw new CodeWorkspaceError("ENTRY_LIMIT", "Workspace entry limit reached");
  }
  const id = draft.id ?? crypto.randomUUID();
  if (!ENTRY_ID_PATTERN.test(id) || entries.has(id)) {
    throw new CodeWorkspaceError("INVALID_ENTRY", "Workspace entry ID is invalid");
  }
  const parentId = draft.parentId ?? null;
  const name = normalizeCodeWorkspaceName(draft.name);
  assertParent(entries, parentId);
  assertUniqueName(document, parentId, name);
  const textValue = draft.text ?? "";
  if (draft.kind === "folder" && draft.blob) {
    throw new CodeWorkspaceError("INVALID_ENTRY", "A folder cannot contain a blob");
  }
  if (draft.blob && draft.text !== undefined) {
    throw new CodeWorkspaceError("INVALID_ENTRY", "A file cannot be text and a blob");
  }
  if (
    draft.blob
    && (
      !SHA256_PATTERN.test(draft.blob.sha256)
      || !Number.isSafeInteger(draft.blob.byteSize)
      || draft.blob.byteSize < 1
      || !MIME_PATTERN.test(draft.blob.mimeType)
    )
  ) {
    throw new CodeWorkspaceError("INVALID_ENTRY", "Invalid blob identity");
  }
  if (!draft.blob) assertWorkspaceTextLimit(entries, textValue.length);
  const rawEntries = rawCodeWorkspaceEntries(document);
  if (rawEntries.length !== entries.size) {
    throw new CodeWorkspaceError("INVALID_DOCUMENT", "Workspace entries are invalid");
  }
  assertProspectiveTree(
    rawEntries,
    [...rawEntries, {
      id,
      kind: draft.kind,
      parentId,
      name,
      rank: draft.rank ?? `z:${id}`,
      text: draft.kind === "file" && !draft.blob ? textValue : null,
      contentKind: draft.kind === "file"
        ? draft.blob ? "blob" : "text"
        : null,
      blob: draft.blob ?? null,
    }],
    new Map([[id, parentId]]),
  );
  Y.transact(document, () => {
    const entry = new Y.Map<unknown>();
    entry.set("kind", draft.kind);
    entry.set("parentId", parentId);
    entry.set("name", name);
    entry.set("rank", draft.rank ?? `z:${id}`);
    if (draft.kind === "file") {
      if (draft.blob) {
        entry.set("contentKind", "blob");
        entry.set("blobSha256", draft.blob.sha256);
        entry.set("blobByteSize", draft.blob.byteSize);
        entry.set("blobMimeType", draft.blob.mimeType);
      } else {
        const text = new Y.Text();
        if (textValue) text.insert(0, textValue);
        entry.set("contentKind", "text");
        entry.set("text", text);
      }
    }
    entries.set(id, entry);
  }, origin);
  return id;
}

export function initializeCodeWorkspace(
  document: Y.Doc,
  origin?: unknown,
): string {
  const meta = codeWorkspaceMeta(document);
  if (meta.get("schemaVersion") === undefined) {
    Y.transact(document, () => {
      meta.set("documentKind", "code-workspace");
      meta.set("schemaVersion", CODE_WORKSPACE_SCHEMA_VERSION);
    }, origin);
  }
  codeWorkspaceTestCases(document);
  const entries = codeWorkspaceEntries(document);
  const existing = listCodeWorkspaceEntries(document)
    .find((entry) => entry.kind === "file");
  if (existing) return existing.id;
  return addCodeWorkspaceEntry(document, {
    id: CODE_WORKSPACE_MAIN_ENTRY_ID,
    kind: "file",
    name: "main.py",
    text: "print(\"Hello, Eduri!\")\n",
    rank: "a0",
  }, origin);
}

export function codeWorkspaceText(
  document: Y.Doc,
  entryId: string,
): Y.Text | null {
  const entry = codeWorkspaceEntries(document).get(entryId);
  if (
    !entry
    || entry.get("kind") !== "file"
    || (entry.get("contentKind") ?? "text") !== "text"
  ) return null;
  const text = entry.get("text");
  return text instanceof Y.Text ? text : null;
}

function replaceCollaborativeText(text: Y.Text, value: string): void {
  const current = text.toString();
  let prefix = 0;
  while (
    prefix < current.length
    && prefix < value.length
    && current.charCodeAt(prefix) === value.charCodeAt(prefix)
  ) {
    prefix += 1;
  }
  let suffix = 0;
  while (
    suffix < current.length - prefix
    && suffix < value.length - prefix
    && current.charCodeAt(current.length - suffix - 1)
      === value.charCodeAt(value.length - suffix - 1)
  ) {
    suffix += 1;
  }
  const deleteLength = current.length - prefix - suffix;
  if (deleteLength > 0) text.delete(prefix, deleteLength);
  const insertion = value.slice(prefix, value.length - suffix);
  if (insertion) text.insert(prefix, insertion);
}

export function replaceCodeWorkspaceText(
  document: Y.Doc,
  entryId: string,
  value: string,
  origin?: unknown,
): void {
  const entries = codeWorkspaceEntries(document);
  assertWorkspaceTextLimit(entries, value.length, entryId);
  const text = codeWorkspaceText(document, entryId);
  if (!text) throw new CodeWorkspaceError("INVALID_ENTRY", "Workspace file does not exist");
  Y.transact(document, () => {
    replaceCollaborativeText(text, value);
  }, origin);
}

function assertCodeWorkspaceBlobIdentity(
  blob: CodeWorkspaceBlobIdentity,
): void {
  if (
    !SHA256_PATTERN.test(blob.sha256)
    || !Number.isSafeInteger(blob.byteSize)
    || blob.byteSize < 1
    || !MIME_PATTERN.test(blob.mimeType)
  ) {
    throw new CodeWorkspaceError("INVALID_ENTRY", "Invalid blob identity");
  }
}

function stableFileContentTextLength(
  content: CodeWorkspaceStableFileContent,
): number {
  if (content.kind === "blob") {
    assertCodeWorkspaceBlobIdentity(content.blob);
    return 0;
  }
  if (content.text.length > CODE_WORKSPACE_MAX_TEXT_CODE_UNITS) {
    throw new CodeWorkspaceError("TEXT_LIMIT", "Workspace text limit reached");
  }
  return content.text.length;
}

function setStableFileContent(
  entry: Y.Map<unknown>,
  content: CodeWorkspaceStableFileContent,
): void {
  if (content.kind === "text") {
    const existing = entry.get("text");
    if (entry.get("contentKind") === "text" && existing instanceof Y.Text) {
      replaceCollaborativeText(existing, content.text);
    } else {
      const text = new Y.Text();
      if (content.text) text.insert(0, content.text);
      entry.set("text", text);
    }
    entry.set("contentKind", "text");
    entry.delete("blobSha256");
    entry.delete("blobByteSize");
    entry.delete("blobMimeType");
    return;
  }
  entry.set("contentKind", "blob");
  entry.delete("text");
  entry.set("blobSha256", content.blob.sha256);
  entry.set("blobByteSize", content.blob.byteSize);
  entry.set("blobMimeType", content.blob.mimeType);
}

/**
 * Applies already conflict-checked runner changes by stable entry ID. Every
 * command is validated before the one Yjs transaction is opened.
 */
export function applyCodeWorkspaceStableFileCommands(
  document: Y.Doc,
  commands: readonly CodeWorkspaceStableFileCommand[],
  origin?: unknown,
): void {
  if (commands.length > CODE_WORKSPACE_MAX_ENTRIES * 2) {
    throw new CodeWorkspaceError("ENTRY_LIMIT", "Workspace command limit reached");
  }
  if (commands.length === 0) return;
  const entries = codeWorkspaceEntries(document);
  const current = listCodeWorkspaceEntries(document);
  if (entries.size !== current.length) {
    throw new CodeWorkspaceError("INVALID_DOCUMENT", "Workspace entries are invalid");
  }
  const candidateById = new Map(current.map((entry) => [entry.id, entry]));
  const commandIds = new Set<string>();
  const createdIds = new Set<string>();
  const normalizedCommands: CodeWorkspaceStableFileCommand[] = [];

  for (const command of commands) {
    if (!ENTRY_ID_PATTERN.test(command.entryId) || commandIds.has(command.entryId)) {
      throw new CodeWorkspaceError("INVALID_ENTRY", "Workspace command ID is invalid");
    }
    commandIds.add(command.entryId);
    if (command.kind === "replace-file") {
      const entry = candidateById.get(command.entryId);
      if (!entry || entry.kind !== "file") {
        throw new CodeWorkspaceError("INVALID_ENTRY", "Workspace file does not exist");
      }
      stableFileContentTextLength(command.content);
      candidateById.set(command.entryId, {
        ...entry,
        text: command.content.kind === "text" ? command.content.text : null,
        contentKind: command.content.kind,
        blob: command.content.kind === "blob" ? command.content.blob : null,
      });
      normalizedCommands.push(command);
      continue;
    }
    if (command.kind === "remove-file") {
      const entry = candidateById.get(command.entryId);
      if (!entry || entry.kind !== "file") {
        throw new CodeWorkspaceError("INVALID_ENTRY", "Workspace file does not exist");
      }
      if (command.entryId === CODE_WORKSPACE_MAIN_ENTRY_ID) {
        throw new CodeWorkspaceError("INVALID_ENTRY", "main.py cannot be removed");
      }
      candidateById.delete(command.entryId);
      normalizedCommands.push(command);
      continue;
    }
    if (candidateById.has(command.entryId)) {
      throw new CodeWorkspaceError("INVALID_ENTRY", "Workspace entry ID already exists");
    }
    const name = normalizeCodeWorkspaceName(command.name);
    if (command.kind === "create-folder") {
      candidateById.set(command.entryId, {
        id: command.entryId,
        kind: "folder",
        parentId: command.parentId,
        name,
        rank: `z:runner:${command.entryId}`,
        text: null,
        contentKind: null,
        blob: null,
      });
      normalizedCommands.push({ ...command, name });
    } else {
      stableFileContentTextLength(command.content);
      candidateById.set(command.entryId, {
        id: command.entryId,
        kind: "file",
        parentId: command.parentId,
        name,
        rank: `z:runner:${command.entryId}`,
        text: command.content.kind === "text" ? command.content.text : null,
        contentKind: command.content.kind,
        blob: command.content.kind === "blob" ? command.content.blob : null,
      });
      normalizedCommands.push({ ...command, name });
    }
    createdIds.add(command.entryId);
  }

  if (candidateById.size > CODE_WORKSPACE_MAX_ENTRIES) {
    throw new CodeWorkspaceError("ENTRY_LIMIT", "Workspace entry limit reached");
  }
  const main = candidateById.get(CODE_WORKSPACE_MAIN_ENTRY_ID);
  if (!main || main.kind !== "file") {
    throw new CodeWorkspaceError("INVALID_ENTRY", "main.py is required");
  }
  let totalText = 0;
  for (const entry of candidateById.values()) {
    if (entry.kind === "file" && entry.contentKind === "text") {
      totalText += entry.text?.length ?? 0;
    }
  }
  if (totalText > CODE_WORKSPACE_MAX_TOTAL_TEXT_CODE_UNITS) {
    throw new CodeWorkspaceError("TEXT_LIMIT", "Workspace text limit reached");
  }

  for (const entryId of createdIds) {
    const entry = candidateById.get(entryId)!;
    if (entry.parentId !== null) {
      const parent = candidateById.get(entry.parentId);
      if (!parent || parent.kind !== "folder") {
        throw new CodeWorkspaceError("MISSING_PARENT", "Workspace folder does not exist");
      }
    }
    for (const sibling of candidateById.values()) {
      if (
        sibling.id !== entry.id
        && sibling.parentId === entry.parentId
        && comparableName(sibling.name) === comparableName(entry.name)
      ) {
        throw new CodeWorkspaceError(
          "DUPLICATE_NAME",
          "A sibling entry already uses this name",
        );
      }
    }
    let cursor: CodeWorkspaceEntrySnapshot | undefined = entry;
    let depth = 0;
    let path = entry.name;
    const seen = new Set<string>();
    while (cursor.parentId !== null) {
      if (seen.has(cursor.id)) {
        throw new CodeWorkspaceError("INVALID_ENTRY", "Workspace tree contains a cycle");
      }
      seen.add(cursor.id);
      const parent = candidateById.get(cursor.parentId);
      if (!parent || parent.kind !== "folder") {
        throw new CodeWorkspaceError("MISSING_PARENT", "Workspace folder does not exist");
      }
      depth += 1;
      path = `${parent.name}/${path}`;
      cursor = parent;
    }
    if (
      depth > CODE_WORKSPACE_MAX_DEPTH
      || path.length > CODE_WORKSPACE_MAX_PATH_CODE_UNITS
    ) {
      throw new CodeWorkspaceError("INVALID_ENTRY", "Workspace path is invalid");
    }
  }

  Y.transact(document, () => {
    const tests = codeWorkspaceTestCases(document);
    for (const command of normalizedCommands) {
      if (command.kind !== "remove-file") continue;
      entries.delete(command.entryId);
      for (const [testId, test] of tests) {
        const targetEntryId = test.get("entryId") ?? CODE_WORKSPACE_MAIN_ENTRY_ID;
        if (targetEntryId === command.entryId) tests.delete(testId);
      }
    }
    for (const command of normalizedCommands) {
      if (command.kind === "replace-file") {
        setStableFileContent(entries.get(command.entryId)!, command.content);
        continue;
      }
      if (command.kind !== "create-folder" && command.kind !== "create-file") {
        continue;
      }
      const entry = new Y.Map<unknown>();
      entry.set("kind", command.kind === "create-folder" ? "folder" : "file");
      entry.set("parentId", command.parentId);
      entry.set("name", command.name);
      entry.set("rank", `z:runner:${command.entryId}`);
      entries.set(command.entryId, entry);
      if (command.kind === "create-file") {
        setStableFileContent(entry, command.content);
      }
    }
  }, origin);
}

export function removeCodeWorkspaceEntries(
  document: Y.Doc,
  entryIds: readonly string[],
  origin?: unknown,
): readonly string[] {
  if (entryIds.length > CODE_WORKSPACE_MAX_ENTRIES) {
    throw new CodeWorkspaceError("ENTRY_LIMIT", "Workspace command limit reached");
  }
  if (entryIds.length === 0) return [];

  const requestedIds = new Set<string>();
  for (const entryId of entryIds) {
    if (!ENTRY_ID_PATTERN.test(entryId)) {
      throw new CodeWorkspaceError("INVALID_ENTRY", "Workspace entry ID is invalid");
    }
    requestedIds.add(entryId);
  }

  const entries = codeWorkspaceEntries(document);
  const rawEntries = rawCodeWorkspaceEntries(document);
  if (entries.size !== rawEntries.length) {
    throw new CodeWorkspaceError("INVALID_DOCUMENT", "Workspace entries are invalid");
  }
  const effectiveEntries = normalizeCodeWorkspaceEntries(rawEntries);
  const effectiveById = new Map(effectiveEntries.map((entry) => [entry.id, entry]));
  const childrenByParent = new Map<string, string[]>();
  for (const entry of effectiveEntries) {
    if (entry.parentId === null) continue;
    const children = childrenByParent.get(entry.parentId) ?? [];
    children.push(entry.id);
    childrenByParent.set(entry.parentId, children);
  }

  const removed = new Set<string>();
  const pending = [...requestedIds]
    .filter((entryId) => effectiveById.has(entryId));
  while (pending.length > 0) {
    const entryId = pending.pop()!;
    if (removed.has(entryId)) continue;
    removed.add(entryId);
    for (const childId of childrenByParent.get(entryId) ?? []) {
      pending.push(childId);
    }
  }
  if (removed.has(CODE_WORKSPACE_MAIN_ENTRY_ID)) {
    throw new CodeWorkspaceError("INVALID_ENTRY", "main.py cannot be removed");
  }
  const removedIds = [...removed].sort(compareStableIds);
  if (removedIds.length === 0) return [];
  Y.transact(document, () => {
    for (const id of removedIds) entries.delete(id);
    const tests = codeWorkspaceTestCases(document);
    for (const [testId, test] of tests) {
      const targetEntryId = test.get("entryId") ?? CODE_WORKSPACE_MAIN_ENTRY_ID;
      if (removed.has(String(targetEntryId))) tests.delete(testId);
    }
  }, origin);
  return removedIds;
}

export function removeCodeWorkspaceEntry(
  document: Y.Doc,
  entryId: string,
  origin?: unknown,
): readonly string[] {
  return removeCodeWorkspaceEntries(document, [entryId], origin);
}

export function renameCodeWorkspaceEntry(
  document: Y.Doc,
  entryId: string,
  nextName: string,
  origin?: unknown,
): void {
  const entries = codeWorkspaceEntries(document);
  const entry = entries.get(entryId);
  if (!entry) throw new CodeWorkspaceError("INVALID_ENTRY", "Workspace entry does not exist");
  const name = normalizeCodeWorkspaceName(nextName);
  const parentId = listCodeWorkspaceEntries(document)
    .find((candidate) => candidate.id === entryId)?.parentId;
  if (parentId === undefined) {
    throw new CodeWorkspaceError("INVALID_ENTRY", "Workspace entry is invalid");
  }
  assertUniqueName(document, parentId, name, entryId);
  const rawEntries = rawCodeWorkspaceEntries(document);
  assertProspectiveTree(
    rawEntries,
    rawEntries.map((candidate) => candidate.id === entryId
      ? { ...candidate, name }
      : candidate),
    new Map(),
  );
  Y.transact(document, () => entry.set("name", name), origin);
}

export function moveCodeWorkspaceEntries(
  document: Y.Doc,
  entryIds: readonly string[],
  nextParentId: string | null,
  origin?: unknown,
): readonly string[] {
  if (entryIds.length > CODE_WORKSPACE_MAX_ENTRIES) {
    throw new CodeWorkspaceError("ENTRY_LIMIT", "Workspace command limit reached");
  }
  if (entryIds.length === 0) return [];

  const requestedIds = new Set<string>();
  for (const entryId of entryIds) {
    if (!ENTRY_ID_PATTERN.test(entryId)) {
      throw new CodeWorkspaceError("INVALID_ENTRY", "Workspace entry ID is invalid");
    }
    requestedIds.add(entryId);
  }

  const entries = codeWorkspaceEntries(document);
  const rawEntries = rawCodeWorkspaceEntries(document);
  if (entries.size !== rawEntries.length) {
    throw new CodeWorkspaceError("INVALID_DOCUMENT", "Workspace entries are invalid");
  }
  const effectiveEntries = normalizeCodeWorkspaceEntries(rawEntries);
  const effectiveById = new Map(effectiveEntries.map((entry) => [entry.id, entry]));
  for (const entryId of requestedIds) {
    if (!effectiveById.has(entryId)) {
      throw new CodeWorkspaceError("INVALID_ENTRY", "Workspace entry does not exist");
    }
  }
  if (nextParentId !== null) {
    const parent = effectiveById.get(nextParentId);
    if (!parent || parent.kind !== "folder") {
      throw new CodeWorkspaceError("MISSING_PARENT", "Workspace folder does not exist");
    }
  }

  const movedRoots = [...requestedIds].filter((entryId) => {
    let parentId = effectiveById.get(entryId)!.parentId;
    while (parentId !== null) {
      if (requestedIds.has(parentId)) return false;
      parentId = effectiveById.get(parentId)?.parentId ?? null;
    }
    return true;
  }).sort(compareStableIds);
  const movedRootIds = new Set(movedRoots);
  let cursor = nextParentId;
  while (cursor !== null) {
    if (movedRootIds.has(cursor)) {
      throw new CodeWorkspaceError("INVALID_ENTRY", "Workspace move would create a cycle");
    }
    cursor = effectiveById.get(cursor)?.parentId ?? null;
  }

  const changedRoots = movedRoots.filter((entryId) => (
    effectiveById.get(entryId)!.parentId !== nextParentId
  ));
  if (changedRoots.length === 0) return [];
  const changedRootIds = new Set(changedRoots);
  const occupiedNames = new Map<string, string>();
  for (const entry of effectiveEntries) {
    if (entry.parentId !== nextParentId || changedRootIds.has(entry.id)) continue;
    occupiedNames.set(comparableName(entry.name), entry.id);
  }
  for (const entryId of changedRoots) {
    const entry = effectiveById.get(entryId)!;
    const comparable = comparableName(entry.name);
    if (occupiedNames.has(comparable)) {
      throw new CodeWorkspaceError(
        "DUPLICATE_NAME",
        "A sibling entry already uses this name",
      );
    }
    occupiedNames.set(comparable, entryId);
  }

  const expectedParentChanges = new Map(changedRoots.map((entryId) => (
    [entryId, nextParentId] as const
  )));
  assertProspectiveTree(
    rawEntries,
    rawEntries.map((entry) => expectedParentChanges.has(entry.id)
      ? { ...entry, parentId: nextParentId }
      : entry),
    expectedParentChanges,
  );
  Y.transact(document, () => {
    for (const entryId of changedRoots) {
      entries.get(entryId)!.set("parentId", nextParentId);
    }
  }, origin);
  return changedRoots;
}

export function moveCodeWorkspaceEntry(
  document: Y.Doc,
  entryId: string,
  nextParentId: string | null,
  origin?: unknown,
): void {
  moveCodeWorkspaceEntries(document, [entryId], nextParentId, origin);
}

export function workspaceFilePaths(
  document: Y.Doc,
): ReadonlyMap<string, string> {
  const snapshots = listCodeWorkspaceEntries(document);
  const byId = new Map(snapshots.map((entry) => [entry.id, entry]));
  const resolvedNames = resolvedSiblingNames(snapshots);
  const paths = new Map<string, string>();
  const pathFor = (entry: CodeWorkspaceEntrySnapshot, seen: Set<string>): string => {
    const cached = paths.get(entry.id);
    if (cached) return cached;
    if (seen.has(entry.id)) {
      throw new CodeWorkspaceError("INVALID_ENTRY", "Workspace tree contains a cycle");
    }
    seen.add(entry.id);
    const parent = entry.parentId ? byId.get(entry.parentId) : null;
    if (entry.parentId && (!parent || parent.kind !== "folder")) {
      throw new CodeWorkspaceError("MISSING_PARENT", "Workspace tree has a missing folder");
    }
    const segment = resolvedNames.get(entry.id) ?? entry.name;
    const value = parent
      ? `${pathFor(parent, seen)}/${segment}`
      : segment;
    if (value.length > CODE_WORKSPACE_MAX_PATH_CODE_UNITS) {
      throw new CodeWorkspaceError("INVALID_ENTRY", "Workspace path is too long");
    }
    paths.set(entry.id, value);
    seen.delete(entry.id);
    return value;
  };
  for (const entry of snapshots) pathFor(entry, new Set());
  return paths;
}

function readTestCase(
  id: string,
  value: Y.Map<unknown>,
): CodeTestCaseSnapshot | null {
  const name = value.get("name");
  const storedEntryId = value.get("entryId");
  // Test cases created before per-file binding belonged to main.py.
  const entryId = storedEntryId === undefined
    ? CODE_WORKSPACE_MAIN_ENTRY_ID
    : storedEntryId;
  const rank = value.get("rank");
  const storedTimeoutMs = value.get("timeoutMs");
  const timeoutMs = storedTimeoutMs === undefined
    ? CODE_TEST_TIMEOUT_DEFAULT_MS
    : storedTimeoutMs;
  const stdin = value.get("stdin");
  const expectedOutput = value.get("expectedOutput");
  if (
    !ENTRY_ID_PATTERN.test(id)
    || typeof entryId !== "string"
    || !ENTRY_ID_PATTERN.test(entryId)
    || typeof name !== "string"
    || !name.trim()
    || name.length > CODE_WORKSPACE_MAX_NAME_CODE_UNITS
    || typeof rank !== "string"
    || !rank
    || typeof timeoutMs !== "number"
    || !Number.isSafeInteger(timeoutMs)
    || timeoutMs < CODE_TEST_TIMEOUT_MIN_MS
    || timeoutMs > CODE_TEST_TIMEOUT_MAX_MS
    || !(stdin instanceof Y.Text)
    || !(expectedOutput instanceof Y.Text)
    || stdin.length > CODE_WORKSPACE_MAX_TEST_TEXT_CODE_UNITS
    || expectedOutput.length > CODE_WORKSPACE_MAX_TEST_TEXT_CODE_UNITS
  ) {
    return null;
  }
  return {
    id,
    entryId,
    name,
    rank,
    timeoutMs,
    stdin: stdin.toString(),
    expectedOutput: expectedOutput.toString(),
  };
}

function assertPlainCollaborativeText(
  value: Y.Text,
  label: string,
): void {
  for (const operation of value.toDelta()) {
    if (
      typeof operation.insert !== "string"
      || operation.attributes !== undefined
    ) {
      throw new CodeWorkspaceError(
        "INVALID_DOCUMENT",
        `${label} must contain plain text only`,
      );
    }
  }
}

export function listCodeTestCases(
  document: Y.Doc,
  entryId?: string,
): readonly CodeTestCaseSnapshot[] {
  return [...codeWorkspaceTestCases(document).entries()]
    .map(([id, value]) => readTestCase(id, value))
    .filter((value): value is CodeTestCaseSnapshot => value !== null)
    .filter((value) => entryId === undefined || value.entryId === entryId)
    .sort((left, right) => (
      left.rank.localeCompare(right.rank) || left.id.localeCompare(right.id)
    ));
}

export function addCodeTestCase(
  document: Y.Doc,
  draft: CodeTestCaseDraft,
  origin?: unknown,
): string {
  const tests = codeWorkspaceTestCases(document);
  if (tests.size >= CODE_WORKSPACE_MAX_TEST_CASES) {
    throw new CodeWorkspaceError("TEST_LIMIT", "Test case limit reached");
  }
  const id = draft.id ?? crypto.randomUUID();
  const entryId = draft.entryId ?? CODE_WORKSPACE_MAIN_ENTRY_ID;
  const name = draft.name.normalize("NFKC").trim();
  const stdinValue = draft.stdin ?? "";
  const expectedValue = draft.expectedOutput ?? "";
  const timeoutMs = draft.timeoutMs ?? CODE_TEST_TIMEOUT_DEFAULT_MS;
  if (
    !ENTRY_ID_PATTERN.test(id)
    || !ENTRY_ID_PATTERN.test(entryId)
    || tests.has(id)
    || !name
    || name.length > CODE_WORKSPACE_MAX_NAME_CODE_UNITS
  ) {
    throw new CodeWorkspaceError("INVALID_ENTRY", "Invalid test case");
  }
  const target = listCodeWorkspaceEntries(document)
    .find((entry) => entry.id === entryId);
  if (!target || target.kind !== "file" || target.contentKind !== "text") {
    throw new CodeWorkspaceError("INVALID_ENTRY", "Test target file does not exist");
  }
  if (
    stdinValue.length > CODE_WORKSPACE_MAX_TEST_TEXT_CODE_UNITS
    || expectedValue.length > CODE_WORKSPACE_MAX_TEST_TEXT_CODE_UNITS
  ) {
    throw new CodeWorkspaceError("TEXT_LIMIT", "Test case text is too large");
  }
  if (
    !Number.isSafeInteger(timeoutMs)
    || timeoutMs < CODE_TEST_TIMEOUT_MIN_MS
    || timeoutMs > CODE_TEST_TIMEOUT_MAX_MS
  ) {
    throw new CodeWorkspaceError("INVALID_ENTRY", "Invalid test timeout");
  }
  Y.transact(document, () => {
    const test = new Y.Map<unknown>();
    const stdin = new Y.Text();
    const expectedOutput = new Y.Text();
    if (stdinValue) stdin.insert(0, stdinValue);
    if (expectedValue) expectedOutput.insert(0, expectedValue);
    test.set("name", name);
    test.set("entryId", entryId);
    test.set("rank", draft.rank ?? `z:${id}`);
    // Retain the field for Yjs schema compatibility, but all tests use the
    // single normalized line-comparison rule.
    test.set("comparisonMode", "normalized");
    test.set("timeoutMs", timeoutMs);
    test.set("stdin", stdin);
    test.set("expectedOutput", expectedOutput);
    tests.set(id, test);
  }, origin);
  return id;
}

export function updateCodeTestCase(
  document: Y.Doc,
  testId: string,
  patch: Partial<Omit<CodeTestCaseDraft, "id" | "entryId">>,
  origin?: unknown,
): void {
  const test = codeWorkspaceTestCases(document).get(testId);
  if (!test) throw new CodeWorkspaceError("INVALID_ENTRY", "Test case does not exist");
  if (
    patch.timeoutMs !== undefined
    && (
      !Number.isSafeInteger(patch.timeoutMs)
      || patch.timeoutMs < CODE_TEST_TIMEOUT_MIN_MS
      || patch.timeoutMs > CODE_TEST_TIMEOUT_MAX_MS
    )
  ) {
    throw new CodeWorkspaceError("INVALID_ENTRY", "Invalid test timeout");
  }
  Y.transact(document, () => {
    if (patch.name !== undefined) {
      const name = patch.name.normalize("NFKC").trim();
      if (!name || name.length > CODE_WORKSPACE_MAX_NAME_CODE_UNITS) {
        throw new CodeWorkspaceError("INVALID_ENTRY", "Invalid test case name");
      }
      test.set("name", name);
    }
    if (patch.rank !== undefined) {
      if (!patch.rank) throw new CodeWorkspaceError("INVALID_ENTRY", "Invalid test rank");
      test.set("rank", patch.rank);
    }
    if (patch.timeoutMs !== undefined) {
      test.set("timeoutMs", patch.timeoutMs);
    }
    for (const [key, value] of [
      ["stdin", patch.stdin],
      ["expectedOutput", patch.expectedOutput],
    ] as const) {
      if (value === undefined) continue;
      if (value.length > CODE_WORKSPACE_MAX_TEST_TEXT_CODE_UNITS) {
        throw new CodeWorkspaceError("TEXT_LIMIT", "Test case text is too large");
      }
      const text = test.get(key);
      if (!(text instanceof Y.Text)) {
        throw new CodeWorkspaceError("INVALID_DOCUMENT", "Test case text is invalid");
      }
      replaceCollaborativeText(text, value);
    }
  }, origin);
}

export function removeCodeTestCase(
  document: Y.Doc,
  testId: string,
  origin?: unknown,
): void {
  Y.transact(document, () => {
    codeWorkspaceTestCases(document).delete(testId);
  }, origin);
}

export function validateCodeWorkspaceDocument(document: Y.Doc): void {
  const meta = codeWorkspaceMeta(document);
  if (
    meta.get("documentKind") !== "code-workspace"
    || meta.get("schemaVersion") !== CODE_WORKSPACE_SCHEMA_VERSION
  ) {
    throw new CodeWorkspaceError("INVALID_DOCUMENT", "Invalid workspace metadata");
  }
  const entries = codeWorkspaceEntries(document);
  const rawSnapshots = rawCodeWorkspaceEntries(document);
  if (
    entries.size !== rawSnapshots.length
    || entries.size > CODE_WORKSPACE_MAX_ENTRIES
  ) {
    throw new CodeWorkspaceError("INVALID_DOCUMENT", "Workspace entries are invalid");
  }
  const snapshots = normalizeCodeWorkspaceEntries(rawSnapshots);
  const byId = new Map(snapshots.map((entry) => [entry.id, entry]));
  const main = byId.get(CODE_WORKSPACE_MAIN_ENTRY_ID);
  if (!main || main.kind !== "file") {
    throw new CodeWorkspaceError("INVALID_DOCUMENT", "main.py is required");
  }
  let totalText = 0;
  for (const entry of snapshots) {
    if (normalizeCodeWorkspaceName(entry.name) !== entry.name) {
      throw new CodeWorkspaceError("INVALID_DOCUMENT", "Workspace name is not canonical");
    }
    if (entry.kind === "file") {
      totalText += entry.text?.length ?? 0;
      if (entry.contentKind === "text") {
        const text = codeWorkspaceText(document, entry.id);
        if (!text) {
          throw new CodeWorkspaceError(
            "INVALID_DOCUMENT",
            "Workspace text file is invalid",
          );
        }
        assertPlainCollaborativeText(text, "Workspace text file");
      }
    }
    let parentId = entry.parentId;
    const seen = new Set<string>([entry.id]);
    let depth = 0;
    while (parentId !== null) {
      const parent = byId.get(parentId);
      if (!parent || parent.kind !== "folder" || seen.has(parentId)) {
        throw new CodeWorkspaceError("INVALID_DOCUMENT", "Workspace tree is invalid");
      }
      seen.add(parentId);
      depth += 1;
      if (depth > CODE_WORKSPACE_MAX_DEPTH) {
        throw new CodeWorkspaceError("INVALID_DOCUMENT", "Workspace tree is too deep");
      }
      parentId = parent.parentId;
    }
  }
  if (totalText > CODE_WORKSPACE_MAX_TOTAL_TEXT_CODE_UNITS) {
    throw new CodeWorkspaceError("TEXT_LIMIT", "Workspace text limit reached");
  }
  workspaceFilePaths(document);

  const tests = codeWorkspaceTestCases(document);
  const testSnapshots = listCodeTestCases(document);
  if (tests.size !== testSnapshots.length || tests.size > CODE_WORKSPACE_MAX_TEST_CASES) {
    throw new CodeWorkspaceError("INVALID_DOCUMENT", "Workspace test cases are invalid");
  }
  for (const [testId, test] of tests) {
    for (const field of ["stdin", "expectedOutput"] as const) {
      const text = test.get(field);
      if (!(text instanceof Y.Text)) {
        throw new CodeWorkspaceError(
          "INVALID_DOCUMENT",
          `Workspace test ${testId} ${field} is invalid`,
        );
      }
      assertPlainCollaborativeText(text, `Workspace test ${field}`);
    }
  }
}

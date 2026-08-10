import { describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import {
  addCodeWorkspaceEntry,
  codeWorkspaceEntries,
  codeWorkspaceText,
  initializeCodeWorkspace,
  listCodeWorkspaceEntries,
  removeCodeWorkspaceEntry,
  renameCodeWorkspaceEntry,
  replaceCodeWorkspaceText,
  workspaceFilePaths,
} from "../../code/core/index.js";
import {
  applyPythonWorkspaceDelta,
  capturePythonWorkspaceRunBaseline,
  type PythonWorkspaceBlobStore,
} from "./pythonWorkspaceDelta.js";

function textBytes(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function emptyBlobStore(): PythonWorkspaceBlobStore {
  return {
    get: vi.fn(async () => null),
    put: vi.fn(async (blob: Blob) => ({
      sha256: "d".repeat(64),
      byteSize: blob.size,
      mimeType: blob.type || "application/octet-stream",
    })),
  };
}

describe("Python workspace delta application", () => {
  it("prepublishes binary data then atomically creates, modifies, and deletes files", async () => {
    const document = new Y.Doc();
    initializeCodeWorkspace(document, "seed");
    addCodeWorkspaceEntry(document, {
      id: "old-file",
      kind: "file",
      name: "old.txt",
      text: "old\n",
    }, "seed");
    const blobStore = emptyBlobStore();
    const baseline = await capturePythonWorkspaceRunBaseline(document, blobStore);
    const mainBase = baseline.files.find((file) => file.entry.id === "main-py")!.base;
    const oldBase = baseline.files.find((file) => file.entry.id === "old-file")!.base;
    const origin = Object.freeze({ type: "runner" });
    let transactions = 0;
    document.on("afterTransaction", (transaction) => {
      if (transaction.origin === origin) transactions += 1;
    });
    vi.mocked(blobStore.put).mockImplementation(async (blob) => {
      expect(codeWorkspaceText(document, "main-py")?.toString())
        .toBe("print(\"Hello, Eduri!\")\n");
      expect([...workspaceFilePaths(document).values()]).not.toContain("data.bin");
      return {
        sha256: "e".repeat(64),
        byteSize: blob.size,
        mimeType: blob.type,
      };
    });
    const ids = ["generated-binary", "generated-folder", "generated-text"];

    const result = await applyPythonWorkspaceDelta({
      document,
      origin,
      blobStore,
      baseline,
      delta: {
        version: 1,
        changes: [
          { kind: "write", path: "data.bin", base: null, bytes: new Uint8Array([0, 7]) },
          {
            kind: "write",
            path: "main.py",
            base: mainBase,
            bytes: textBytes("print(42)\n"),
          },
          {
            kind: "write",
            path: "new/answer.txt",
            base: null,
            bytes: textBytes("42\n"),
          },
          { kind: "delete", path: "old.txt", base: oldBase },
        ],
      },
      createEntryId: () => ids.shift()!,
    });

    expect(result).toEqual({
      appliedPaths: ["data.bin", "main.py", "new/answer.txt", "old.txt"],
      conflicts: [],
      aborted: false,
    });
    expect(blobStore.put).toHaveBeenCalledOnce();
    expect(transactions).toBe(1);
    expect(codeWorkspaceText(document, "main-py")?.toString()).toBe("print(42)\n");
    expect(codeWorkspaceEntries(document).has("old-file")).toBe(false);
    expect(new Set(workspaceFilePaths(document).values())).toEqual(new Set([
      "main.py",
      "data.bin",
      "new",
      "new/answer.txt",
    ]));
    expect(listCodeWorkspaceEntries(document)).toContainEqual(
      expect.objectContaining({
        id: "generated-binary",
        contentKind: "blob",
        blob: expect.objectContaining({ sha256: "e".repeat(64) }),
      }),
    );
  });

  it("atomically replaces a deleted file with a generated directory", async () => {
    const document = new Y.Doc();
    initializeCodeWorkspace(document, "seed");
    addCodeWorkspaceEntry(document, {
      id: "old-node",
      kind: "file",
      name: "node",
      text: "old\n",
    }, "seed");
    const blobStore = emptyBlobStore();
    const baseline = await capturePythonWorkspaceRunBaseline(document, blobStore);
    const oldBase = baseline.files.find((file) => file.entry.id === "old-node")!.base;
    const ids = ["generated-node-folder", "generated-child"];

    const result = await applyPythonWorkspaceDelta({
      document,
      blobStore,
      baseline,
      delta: {
        version: 1,
        changes: [
          { kind: "delete", path: "node", base: oldBase },
          {
            kind: "write",
            path: "node/child.txt",
            base: null,
            bytes: textBytes("child\n"),
          },
        ],
      },
      createEntryId: () => ids.shift()!,
    });

    expect(result).toEqual({
      appliedPaths: ["node", "node/child.txt"],
      conflicts: [],
      aborted: false,
    });
    expect(codeWorkspaceEntries(document).has("old-node")).toBe(false);
    expect(new Set(workspaceFilePaths(document).values())).toEqual(new Set([
      "main.py",
      "node",
      "node/child.txt",
    ]));
    expect(codeWorkspaceText(document, "generated-child")?.toString()).toBe("child\n");
  });

  it("keeps a directory subtree when replacing it with a file is not representable", async () => {
    const document = new Y.Doc();
    initializeCodeWorkspace(document, "seed");
    addCodeWorkspaceEntry(document, {
      id: "old-node-folder",
      kind: "folder",
      name: "node",
    }, "seed");
    addCodeWorkspaceEntry(document, {
      id: "old-child",
      kind: "file",
      parentId: "old-node-folder",
      name: "child.txt",
      text: "old child\n",
    }, "seed");
    const blobStore = emptyBlobStore();
    const baseline = await capturePythonWorkspaceRunBaseline(document, blobStore);
    const childBase = baseline.files.find((file) => file.entry.id === "old-child")!.base;

    const result = await applyPythonWorkspaceDelta({
      document,
      blobStore,
      baseline,
      delta: {
        version: 1,
        changes: [
          {
            kind: "write",
            path: "node",
            base: null,
            bytes: textBytes("replacement\n"),
          },
          { kind: "delete", path: "node/child.txt", base: childBase },
        ],
      },
    });

    expect(result).toEqual({
      appliedPaths: [],
      conflicts: [
        { path: "node", reason: "path-conflict" },
        { path: "node/child.txt", reason: "parent-conflict" },
      ],
      aborted: false,
    });
    expect(workspaceFilePaths(document).get("old-node-folder")).toBe("node");
    expect(workspaceFilePaths(document).get("old-child")).toBe("node/child.txt");
    expect(codeWorkspaceText(document, "old-child")?.toString()).toBe("old child\n");
  });

  it("never overwrites a file edited after the exact Run baseline", async () => {
    const document = new Y.Doc();
    initializeCodeWorkspace(document, "seed");
    const blobStore = emptyBlobStore();
    const baseline = await capturePythonWorkspaceRunBaseline(document, blobStore);
    const mainBase = baseline.files[0]!.base;
    replaceCodeWorkspaceText(document, "main-py", "# concurrent\n", "peer");

    const result = await applyPythonWorkspaceDelta({
      document,
      blobStore,
      baseline,
      delta: {
        version: 1,
        changes: [{
          kind: "write",
          path: "main.py",
          base: mainBase,
          bytes: textBytes("# runner\n"),
        }],
      },
    });

    expect(result.conflicts).toEqual([{
      path: "main.py",
      reason: "changed-since-run",
    }]);
    expect(result.appliedPaths).toEqual([]);
    expect(codeWorkspaceText(document, "main-py")?.toString())
      .toBe("# concurrent\n");
  });

  it("treats stable-ID replacement and path changes as baseline conflicts", async () => {
    for (const mutation of ["path", "stable-id"] as const) {
      const document = new Y.Doc();
      initializeCodeWorkspace(document, "seed");
      addCodeWorkspaceEntry(document, {
        id: "target-file",
        kind: "file",
        name: "target.txt",
        text: "baseline\n",
      }, "seed");
      const blobStore = emptyBlobStore();
      const baseline = await capturePythonWorkspaceRunBaseline(document, blobStore);
      const targetBase = baseline.files.find((file) => (
        file.entry.id === "target-file"
      ))!.base;
      if (mutation === "path") {
        renameCodeWorkspaceEntry(document, "target-file", "renamed.txt", "peer");
      } else {
        removeCodeWorkspaceEntry(document, "target-file", "peer");
        addCodeWorkspaceEntry(document, {
          id: "replacement-file",
          kind: "file",
          name: "target.txt",
          text: "baseline\n",
        }, "peer");
      }

      const result = await applyPythonWorkspaceDelta({
        document,
        blobStore,
        baseline,
        delta: {
          version: 1,
          changes: [{
            kind: "write",
            path: "target.txt",
            base: targetBase,
            bytes: textBytes("runner\n"),
          }],
        },
      });
      expect(result.conflicts).toEqual([{
        path: "target.txt",
        reason: "changed-since-run",
      }]);
      expect(codeWorkspaceText(document, "target-file")?.toString())
        .not.toBe("runner\n");
      expect(codeWorkspaceText(document, "replacement-file")?.toString())
        .not.toBe("runner\n");
    }
  });

  it("keeps main.py when Python deletes it", async () => {
    const document = new Y.Doc();
    initializeCodeWorkspace(document, "seed");
    const blobStore = emptyBlobStore();
    const baseline = await capturePythonWorkspaceRunBaseline(document, blobStore);
    const result = await applyPythonWorkspaceDelta({
      document,
      blobStore,
      baseline,
      delta: {
        version: 1,
        changes: [{
          kind: "delete",
          path: "main.py",
          base: baseline.files[0]!.base,
        }],
      },
    });
    expect(result.conflicts).toEqual([{
      path: "main.py",
      reason: "main-file-required",
    }]);
    expect(workspaceFilePaths(document).get("main-py")).toBe("main.py");
  });

  it("does not publish a late transaction after becoming read-only", async () => {
    const document = new Y.Doc();
    initializeCodeWorkspace(document, "seed");
    const blobStore = emptyBlobStore();
    const baseline = await capturePythonWorkspaceRunBaseline(document, blobStore);
    const origin = Object.freeze({ type: "runner" });
    let runnerTransactions = 0;
    document.on("afterTransaction", (transaction) => {
      if (transaction.origin === origin) runnerTransactions += 1;
    });
    let writable = true;
    vi.mocked(blobStore.put).mockImplementation(async (blob) => {
      writable = false;
      return {
        sha256: "f".repeat(64),
        byteSize: blob.size,
        mimeType: blob.type,
      };
    });

    const result = await applyPythonWorkspaceDelta({
      document,
      origin,
      blobStore,
      baseline,
      delta: {
        version: 1,
        changes: [{
          kind: "write",
          path: "late.bin",
          base: null,
          bytes: new Uint8Array([0, 1]),
        }],
      },
      canApply: () => writable,
    });

    expect(result.aborted).toBe(true);
    expect(runnerTransactions).toBe(0);
    expect([...workspaceFilePaths(document).values()]).not.toContain("late.bin");
  });

  it("rechecks after binary publication and skips a newly conflicting path", async () => {
    const document = new Y.Doc();
    initializeCodeWorkspace(document, "seed");
    const blobStore = emptyBlobStore();
    const baseline = await capturePythonWorkspaceRunBaseline(document, blobStore);
    const origin = Object.freeze({ type: "runner" });
    let runnerTransactions = 0;
    document.on("afterTransaction", (transaction) => {
      if (transaction.origin === origin) runnerTransactions += 1;
    });
    vi.mocked(blobStore.put).mockImplementation(async (blob) => {
      addCodeWorkspaceEntry(document, {
        id: "peer-file",
        kind: "file",
        name: "published.bin",
        text: "peer\n",
      }, "peer");
      return {
        sha256: "1".repeat(64),
        byteSize: blob.size,
        mimeType: blob.type,
      };
    });
    const result = await applyPythonWorkspaceDelta({
      document,
      origin,
      blobStore,
      baseline,
      delta: {
        version: 1,
        changes: [{
          kind: "write",
          path: "published.bin",
          base: null,
          bytes: new Uint8Array([0, 9]),
        }],
      },
    });

    expect(blobStore.put).toHaveBeenCalledOnce();
    expect(result.appliedPaths).toEqual([]);
    expect(runnerTransactions).toBe(0);
    expect(result.conflicts).toEqual([{
      path: "published.bin",
      reason: "path-conflict",
    }]);
    expect(codeWorkspaceText(document, "peer-file")?.toString()).toBe("peer\n");
  });
});

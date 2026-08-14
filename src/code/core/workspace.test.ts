import * as Y from "yjs";
import { describe, expect, it } from "vitest";
import {
  CODE_TEST_TIMEOUT_DEFAULT_MS,
  CODE_TEST_TIMEOUT_MAX_MS,
  CODE_TEST_TIMEOUT_MIN_MS,
  CODE_WORKSPACE_MAIN_ENTRY_ID,
  CODE_WORKSPACE_MAX_DEPTH,
  CODE_WORKSPACE_MAX_PATH_CODE_UNITS,
  CodeWorkspaceError,
  addCodeTestCase,
  addCodeWorkspaceEntry,
  applyCodeWorkspaceStableFileCommands,
  codeWorkspaceEntries,
  codeWorkspaceTestCases,
  codeWorkspaceText,
  compareCodeTestOutput,
  initializeCodeWorkspace,
  listCodeWorkspaceEntries,
  listCodeTestCases,
  moveCodeWorkspaceEntries,
  moveCodeWorkspaceEntry,
  removeCodeWorkspaceEntries,
  removeCodeWorkspaceEntry,
  renameCodeWorkspaceEntry,
  replaceCodeWorkspaceText,
  updateCodeTestCase,
  validateCodeWorkspaceDocument,
  workspaceFilePaths,
} from "./workspace.js";

describe("code workspace core", () => {
  it("initializes one collaborative main.py and updates its Y.Text", () => {
    const document = new Y.Doc();
    const id = initializeCodeWorkspace(document, "local");
    expect(id).toBe("main-py");
    expect(codeWorkspaceText(document, id)).toBeInstanceOf(Y.Text);
    replaceCodeWorkspaceText(document, id, "print(42)\n", "local");
    expect(listCodeWorkspaceEntries(document)).toEqual([
      expect.objectContaining({
        id,
        kind: "file",
        name: "main.py",
        text: "print(42)\n",
      }),
    ]);
  });

  it("builds folders by stable IDs and removes descendants atomically", () => {
    const document = new Y.Doc();
    const folder = addCodeWorkspaceEntry(document, {
      id: "src",
      kind: "folder",
      name: "src",
    });
    const file = addCodeWorkspaceEntry(document, {
      id: "solver",
      kind: "file",
      parentId: folder,
      name: "solver.py",
      text: "def solve(): pass\n",
    });
    expect(workspaceFilePaths(document).get(file)).toBe("src/solver.py");
    expect([...removeCodeWorkspaceEntry(document, folder, "local")].sort())
      .toEqual(["solver", "src"]);
    expect(listCodeWorkspaceEntries(document)).toEqual([]);
  });

  it("does not remove a folder containing the required main.py", () => {
    const document = new Y.Doc();
    initializeCodeWorkspace(document, "seed");
    const folder = addCodeWorkspaceEntry(document, {
      id: "source",
      kind: "folder",
      name: "source",
    }, "seed");
    moveCodeWorkspaceEntry(document, "main-py", folder, "seed");

    expect(() => removeCodeWorkspaceEntry(document, folder, "local"))
      .toThrowError("main.py cannot be removed");
    expect(workspaceFilePaths(document).get("main-py")).toBe("source/main.py");
    expect(codeWorkspaceEntries(document).has(folder)).toBe(true);
  });

  it("removes overlapping and independent selections in one transaction", () => {
    const document = new Y.Doc();
    initializeCodeWorkspace(document, "seed");
    addCodeWorkspaceEntry(document, {
      id: "source",
      kind: "folder",
      name: "source",
    }, "seed");
    addCodeWorkspaceEntry(document, {
      id: "nested",
      kind: "folder",
      parentId: "source",
      name: "nested",
    }, "seed");
    addCodeWorkspaceEntry(document, {
      id: "source-file",
      kind: "file",
      parentId: "nested",
      name: "source.py",
    }, "seed");
    addCodeWorkspaceEntry(document, {
      id: "other",
      kind: "folder",
      name: "other",
    }, "seed");
    addCodeWorkspaceEntry(document, {
      id: "other-file",
      kind: "file",
      parentId: "other",
      name: "other.py",
    }, "seed");
    const origin = Object.freeze({ type: "batch-delete" });
    let transactions = 0;
    document.on("afterTransaction", (transaction) => {
      if (transaction.origin === origin) transactions += 1;
    });

    expect(removeCodeWorkspaceEntries(
      document,
      ["nested", "source", "other", "nested", "already-missing"],
      origin,
    )).toEqual(["nested", "other", "other-file", "source", "source-file"]);
    expect(transactions).toBe(1);
    expect(listCodeWorkspaceEntries(document).map((entry) => entry.id))
      .toEqual(["main-py"]);
  });

  it("rejects a batch containing main.py without emitting a partial update", () => {
    const document = new Y.Doc();
    initializeCodeWorkspace(document, "seed");
    addCodeWorkspaceEntry(document, {
      id: "source",
      kind: "folder",
      name: "source",
    }, "seed");
    moveCodeWorkspaceEntry(document, "main-py", "source", "seed");
    addCodeWorkspaceEntry(document, {
      id: "disposable",
      kind: "file",
      name: "disposable.py",
    }, "seed");
    const before = Y.encodeStateVector(document);
    let updates = 0;
    document.on("update", () => {
      updates += 1;
    });

    expect(() => removeCodeWorkspaceEntries(
      document,
      ["disposable", "source"],
      "local",
    )).toThrowError("main.py cannot be removed");
    expect(Y.encodeStateVector(document)).toEqual(before);
    expect(updates).toBe(0);
    expect(codeWorkspaceEntries(document).has("disposable")).toBe(true);
    expect(codeWorkspaceEntries(document).has("source")).toBe(true);
  });

  it("undoes and redoes an entire batch deletion as one history item", () => {
    const document = new Y.Doc();
    initializeCodeWorkspace(document, "seed");
    for (const id of ["first", "second"]) {
      addCodeWorkspaceEntry(document, {
        id,
        kind: "file",
        name: `${id}.py`,
      }, "seed");
    }
    const origin = Object.freeze({ type: "batch-history" });
    const undoManager = new Y.UndoManager(codeWorkspaceEntries(document), {
      trackedOrigins: new Set([origin]),
    });

    undoManager.stopCapturing();
    removeCodeWorkspaceEntries(document, ["first", "second"], origin);
    undoManager.stopCapturing();
    expect(codeWorkspaceEntries(document).has("first")).toBe(false);
    expect(codeWorkspaceEntries(document).has("second")).toBe(false);

    undoManager.undo();
    expect(codeWorkspaceEntries(document).has("first")).toBe(true);
    expect(codeWorkspaceEntries(document).has("second")).toBe(true);
    undoManager.redo();
    expect(codeWorkspaceEntries(document).has("first")).toBe(false);
    expect(codeWorkspaceEntries(document).has("second")).toBe(false);
    undoManager.destroy();
  });

  it("moves entries by stable parent ID and prevents cycles", () => {
    const document = new Y.Doc();
    const source = addCodeWorkspaceEntry(document, {
      id: "source",
      kind: "folder",
      name: "source",
    });
    const target = addCodeWorkspaceEntry(document, {
      id: "target",
      kind: "folder",
      name: "target",
    });
    const file = addCodeWorkspaceEntry(document, {
      id: "file",
      kind: "file",
      parentId: source,
      name: "main.py",
    });
    moveCodeWorkspaceEntry(document, file, target, "local");
    expect(workspaceFilePaths(document).get(file)).toBe("target/main.py");
    expect(() => moveCodeWorkspaceEntry(document, target, file))
      .toThrowError(CodeWorkspaceError);
  });

  it("moves only the highest selected roots and preserves their subtrees", () => {
    const document = new Y.Doc();
    initializeCodeWorkspace(document, "seed");
    for (const [id, name] of [
      ["source", "source"],
      ["target", "target"],
    ] as const) {
      addCodeWorkspaceEntry(document, {
        id,
        kind: "folder",
        name,
      }, "seed");
    }
    addCodeWorkspaceEntry(document, {
      id: "nested",
      kind: "folder",
      parentId: "source",
      name: "nested",
    }, "seed");
    addCodeWorkspaceEntry(document, {
      id: "child",
      kind: "file",
      parentId: "nested",
      name: "child.py",
    }, "seed");
    addCodeWorkspaceEntry(document, {
      id: "loose",
      kind: "file",
      name: "loose.py",
    }, "seed");
    const origin = Object.freeze({ type: "batch-move" });
    let transactions = 0;
    document.on("afterTransaction", (transaction) => {
      if (transaction.origin === origin) transactions += 1;
    });

    expect(moveCodeWorkspaceEntries(
      document,
      ["child", "source", "nested", "loose", "source"],
      "target",
      origin,
    )).toEqual(["loose", "source"]);
    expect(transactions).toBe(1);
    expect(new Map(listCodeWorkspaceEntries(document).map((entry) => (
      [entry.id, entry.parentId]
    )))).toEqual(new Map([
      ["child", "nested"],
      ["loose", "target"],
      ["main-py", null],
      ["nested", "source"],
      ["source", "target"],
      ["target", null],
    ]));
  });

  it("undoes and redoes an entire batch move as one history item", () => {
    const document = new Y.Doc();
    initializeCodeWorkspace(document, "seed");
    addCodeWorkspaceEntry(document, {
      id: "target",
      kind: "folder",
      name: "target",
    }, "seed");
    for (const id of ["first", "second"]) {
      addCodeWorkspaceEntry(document, {
        id,
        kind: "file",
        name: `${id}.py`,
      }, "seed");
    }
    const origin = Object.freeze({ type: "batch-history" });
    const undoManager = new Y.UndoManager(codeWorkspaceEntries(document), {
      trackedOrigins: new Set([origin]),
    });

    undoManager.stopCapturing();
    moveCodeWorkspaceEntries(document, ["first", "second"], "target", origin);
    undoManager.stopCapturing();
    expect(listCodeWorkspaceEntries(document)
      .filter((entry) => entry.id === "first" || entry.id === "second")
      .map((entry) => entry.parentId)).toEqual(["target", "target"]);

    undoManager.undo();
    expect(listCodeWorkspaceEntries(document)
      .filter((entry) => entry.id === "first" || entry.id === "second")
      .map((entry) => entry.parentId)).toEqual([null, null]);
    undoManager.redo();
    expect(listCodeWorkspaceEntries(document)
      .filter((entry) => entry.id === "first" || entry.id === "second")
      .map((entry) => entry.parentId)).toEqual(["target", "target"]);
    undoManager.destroy();
  });

  it("rejects an invalid batch move atomically", () => {
    const document = new Y.Doc();
    initializeCodeWorkspace(document, "seed");
    for (const [id, name] of [
      ["left", "left"],
      ["right", "right"],
      ["target", "target"],
    ] as const) {
      addCodeWorkspaceEntry(document, {
        id,
        kind: "folder",
        name,
      }, "seed");
    }
    addCodeWorkspaceEntry(document, {
      id: "left-file",
      kind: "file",
      parentId: "left",
      name: "answer.py",
    }, "seed");
    addCodeWorkspaceEntry(document, {
      id: "right-file",
      kind: "file",
      parentId: "right",
      name: "ANSWER.py",
    }, "seed");
    addCodeWorkspaceEntry(document, {
      id: "occupied",
      kind: "file",
      parentId: "target",
      name: "occupied.py",
    }, "seed");
    addCodeWorkspaceEntry(document, {
      id: "incoming-occupied",
      kind: "file",
      parentId: "left",
      name: "OCCUPIED.py",
    }, "seed");
    const before = Y.encodeStateVector(document);
    let updates = 0;
    document.on("update", () => {
      updates += 1;
    });

    expect(() => moveCodeWorkspaceEntries(
      document,
      ["left-file", "right-file"],
      "target",
      "local",
    )).toThrowError(CodeWorkspaceError);
    expect(Y.encodeStateVector(document)).toEqual(before);
    expect(updates).toBe(0);
    expect(workspaceFilePaths(document).get("left-file")).toBe("left/answer.py");
    expect(workspaceFilePaths(document).get("right-file")).toBe("right/ANSWER.py");

    expect(() => moveCodeWorkspaceEntries(
      document,
      ["left", "missing-entry"],
      "target",
      "local",
    )).toThrowError(CodeWorkspaceError);
    expect(Y.encodeStateVector(document)).toEqual(before);
    expect(updates).toBe(0);

    expect(() => moveCodeWorkspaceEntries(
      document,
      ["incoming-occupied", "right-file"],
      "target",
      "local",
    )).toThrowError(CodeWorkspaceError);
    expect(workspaceFilePaths(document).get("right-file")).toBe("right/ANSWER.py");
    expect(Y.encodeStateVector(document)).toEqual(before);
    expect(updates).toBe(0);
  });

  it("rejects a batch when one moved subtree would exceed the path bound", () => {
    const document = new Y.Doc();
    initializeCodeWorkspace(document, "seed");
    let targetId: string | null = null;
    for (let index = 0; index < 8; index += 1) {
      const id = `target-${index}`;
      addCodeWorkspaceEntry(document, {
        id,
        kind: "folder",
        parentId: targetId,
        name: `${id}-${"x".repeat(110)}`,
      }, "seed");
      targetId = id;
    }
    addCodeWorkspaceEntry(document, {
      id: "deep-source",
      kind: "folder",
      name: "source",
    }, "seed");
    addCodeWorkspaceEntry(document, {
      id: "deep-child",
      kind: "file",
      parentId: "deep-source",
      name: `${"y".repeat(100)}.py`,
    }, "seed");
    addCodeWorkspaceEntry(document, {
      id: "valid-file",
      kind: "file",
      name: "valid.py",
    }, "seed");
    const before = Y.encodeStateVector(document);
    let updates = 0;
    document.on("update", () => {
      updates += 1;
    });

    expect(() => moveCodeWorkspaceEntries(
      document,
      ["valid-file", "deep-source"],
      targetId,
      "local",
    )).toThrowError(CodeWorkspaceError);
    expect(Y.encodeStateVector(document)).toEqual(before);
    expect(updates).toBe(0);
    expect(listCodeWorkspaceEntries(document)
      .find((entry) => entry.id === "valid-file")?.parentId).toBeNull();
    expect(listCodeWorkspaceEntries(document)
      .find((entry) => entry.id === "deep-source")?.parentId).toBeNull();
  });

  it("rejects moving a selected subtree into itself and skips complete no-ops", () => {
    const document = new Y.Doc();
    initializeCodeWorkspace(document, "seed");
    addCodeWorkspaceEntry(document, {
      id: "source",
      kind: "folder",
      name: "source",
    }, "seed");
    addCodeWorkspaceEntry(document, {
      id: "nested",
      kind: "folder",
      parentId: "source",
      name: "nested",
    }, "seed");
    const before = Y.encodeStateVector(document);
    let updates = 0;
    document.on("update", () => {
      updates += 1;
    });

    expect(() => moveCodeWorkspaceEntries(
      document,
      ["source", "nested"],
      "nested",
      "local",
    )).toThrowError(CodeWorkspaceError);
    expect(moveCodeWorkspaceEntries(
      document,
      ["source", "nested", "source"],
      null,
      "local",
    )).toEqual([]);
    expect(removeCodeWorkspaceEntries(
      document,
      ["missing-entry", "missing-entry"],
      "local",
    )).toEqual([]);
    expect(Y.encodeStateVector(document)).toEqual(before);
    expect(updates).toBe(0);
  });

  it("rejects traversal, separators, and case-folded sibling collisions", () => {
    const document = new Y.Doc();
    addCodeWorkspaceEntry(document, {
      id: "main",
      kind: "file",
      name: "Main.py",
    });
    expect(() => addCodeWorkspaceEntry(document, {
      kind: "file",
      name: "main.PY",
    })).toThrowError(CodeWorkspaceError);
    expect(() => addCodeWorkspaceEntry(document, {
      kind: "file",
      name: "../secret",
    })).toThrowError(CodeWorkspaceError);
    expect(() => renameCodeWorkspaceEntry(document, "main", ".."))
      .toThrowError(CodeWorkspaceError);
  });

  it("converges independent text edits through standard Yjs updates", () => {
    const seed = new Y.Doc();
    const id = initializeCodeWorkspace(seed, "seed");
    const left = new Y.Doc();
    const right = new Y.Doc();
    const initial = Y.encodeStateAsUpdate(seed);
    Y.applyUpdate(left, initial);
    Y.applyUpdate(right, initial);
    codeWorkspaceText(left, id)?.insert(0, "# left\n");
    codeWorkspaceText(right, id)?.insert(0, "# right\n");
    const leftUpdate = Y.encodeStateAsUpdate(left, Y.encodeStateVector(seed));
    const rightUpdate = Y.encodeStateAsUpdate(right, Y.encodeStateVector(seed));
    Y.applyUpdate(left, rightUpdate);
    Y.applyUpdate(right, leftUpdate);
    expect(Y.encodeStateVector(left)).toEqual(Y.encodeStateVector(right));
    expect(codeWorkspaceText(left, id)?.toString())
      .toBe(codeWorkspaceText(right, id)?.toString());
  });

  it("emits incremental text edits that preserve concurrent insertions", () => {
    const seed = new Y.Doc();
    const id = initializeCodeWorkspace(seed, "seed");
    replaceCodeWorkspaceText(seed, id, "abcdef", "seed");
    const left = new Y.Doc();
    const right = new Y.Doc();
    const initial = Y.encodeStateAsUpdate(seed);
    Y.applyUpdate(left, initial);
    Y.applyUpdate(right, initial);
    replaceCodeWorkspaceText(left, id, "Xabcdef", "left");
    replaceCodeWorkspaceText(right, id, "abcdefY", "right");
    const baseline = Y.encodeStateVector(seed);
    const leftUpdate = Y.encodeStateAsUpdate(left, baseline);
    const rightUpdate = Y.encodeStateAsUpdate(right, baseline);
    Y.applyUpdate(left, rightUpdate);
    Y.applyUpdate(right, leftUpdate);
    expect(codeWorkspaceText(left, id)?.toString()).toBe("XabcdefY");
    expect(codeWorkspaceText(right, id)?.toString()).toBe("XabcdefY");
  });

  it("stores named collaborative test cases in the canonical document", () => {
    const document = new Y.Doc();
    initializeCodeWorkspace(document, "seed");
    const id = addCodeTestCase(document, {
      id: "sample-1",
      name: "Пример 1",
      stdin: "2 3\n",
      expectedOutput: "5\n",
    }, "local");
    updateCodeTestCase(document, id, { expectedOutput: "5" }, "local");
    const storedTest = codeWorkspaceTestCases(document).get(id)!;
    expect(storedTest.get("comparisonMode")).toBe("normalized");
    // Older documents may carry an explicit mode; it no longer affects the
    // public snapshot or test execution.
    storedTest.set("comparisonMode", "tokens");
    expect(listCodeTestCases(document)).toEqual([{
      id,
      entryId: CODE_WORKSPACE_MAIN_ENTRY_ID,
      name: "Пример 1",
      rank: "z:sample-1",
      timeoutMs: CODE_TEST_TIMEOUT_DEFAULT_MS,
      stdin: "2 3\n",
      expectedOutput: "5",
    }]);
    expect(() => validateCodeWorkspaceDocument(document)).not.toThrow();
  });

  it("binds each test to a stable file ID and defaults legacy tests to main.py", () => {
    const document = new Y.Doc();
    initializeCodeWorkspace(document, "seed");
    const secondaryId = addCodeWorkspaceEntry(document, {
      id: "solution-py",
      kind: "file",
      name: "solution.py",
      text: "print(2)\n",
    }, "seed");
    const mainTestId = addCodeTestCase(document, {
      id: "main-test",
      name: "Main",
    }, "seed");
    const secondaryTestId = addCodeTestCase(document, {
      id: "solution-test",
      entryId: secondaryId,
      name: "Solution",
    }, "seed");

    codeWorkspaceTestCases(document).get(mainTestId)?.delete("entryId");
    expect(listCodeTestCases(document, CODE_WORKSPACE_MAIN_ENTRY_ID)
      .map((test) => test.id)).toEqual([mainTestId]);
    expect(listCodeTestCases(document, secondaryId)).toEqual([
      expect.objectContaining({ id: secondaryTestId, entryId: secondaryId }),
    ]);

    renameCodeWorkspaceEntry(document, secondaryId, "renamed.py", "local");
    expect(listCodeTestCases(document, secondaryId)[0]?.id).toBe(secondaryTestId);
    expect(removeCodeWorkspaceEntry(document, secondaryId, "local"))
      .toEqual([secondaryId]);
    expect(listCodeTestCases(document).map((test) => test.id))
      .toEqual([mainTestId]);
  });

  it("preserves valid orphan test bindings from concurrent merges", () => {
    const document = new Y.Doc();
    initializeCodeWorkspace(document, "seed");
    const secondaryId = addCodeWorkspaceEntry(document, {
      id: "concurrent-py",
      kind: "file",
      name: "concurrent.py",
    }, "seed");
    const testId = addCodeTestCase(document, {
      id: "concurrent-test",
      entryId: secondaryId,
      name: "Concurrent",
    }, "seed");

    codeWorkspaceEntries(document).delete(secondaryId);
    expect(listCodeTestCases(document)).toContainEqual(
      expect.objectContaining({ id: testId, entryId: secondaryId }),
    );
    expect(() => validateCodeWorkspaceDocument(document)).not.toThrow();

    codeWorkspaceTestCases(document).get(testId)?.set("entryId", "../unsafe");
    expect(() => validateCodeWorkspaceDocument(document))
      .toThrowError(CodeWorkspaceError);
  });

  it("rejects embedded or formatted content in collaborative code and test text", () => {
    const codeDocument = new Y.Doc();
    initializeCodeWorkspace(codeDocument, "seed");
    const code = codeWorkspaceText(codeDocument, "main-py")!;
    code.insertEmbed(0, { unsafe: true });
    expect(() => validateCodeWorkspaceDocument(codeDocument))
      .toThrowError(CodeWorkspaceError);

    const testDocument = new Y.Doc();
    initializeCodeWorkspace(testDocument, "seed");
    const testId = addCodeTestCase(testDocument, {
      id: "plain-text-test",
      name: "Plain",
    });
    const test = codeWorkspaceTestCases(testDocument).get(testId)!;
    const stdin = test.get("stdin") as Y.Text;
    stdin.insert(0, "formatted", { bold: true });
    expect(() => validateCodeWorkspaceDocument(testDocument))
      .toThrowError(CodeWorkspaceError);
  });

  it("stores bounded test timeouts and defaults legacy cases", () => {
    const document = new Y.Doc();
    initializeCodeWorkspace(document, "seed");
    const testId = addCodeTestCase(document, {
      id: "timed-test",
      name: "Timed",
      timeoutMs: 1_250,
    }, "local");
    expect(listCodeTestCases(document)[0]?.timeoutMs).toBe(1_250);
    updateCodeTestCase(document, testId, {
      timeoutMs: CODE_TEST_TIMEOUT_MAX_MS,
    }, "local");
    expect(listCodeTestCases(document)[0]?.timeoutMs)
      .toBe(CODE_TEST_TIMEOUT_MAX_MS);
    codeWorkspaceTestCases(document).get(testId)?.delete("timeoutMs");
    expect(listCodeTestCases(document)[0]?.timeoutMs)
      .toBe(CODE_TEST_TIMEOUT_DEFAULT_MS);
    expect(() => updateCodeTestCase(document, testId, {
      timeoutMs: CODE_TEST_TIMEOUT_MIN_MS - 1,
    })).toThrowError(CodeWorkspaceError);
    expect(() => addCodeTestCase(document, {
      name: "Too slow",
      timeoutMs: CODE_TEST_TIMEOUT_MAX_MS + 1,
    })).toThrowError(CodeWorkspaceError);
  });

  it("applies stable-ID runner file commands in one transaction", () => {
    const document = new Y.Doc();
    initializeCodeWorkspace(document, "seed");
    const originalMainText = codeWorkspaceText(document, "main-py");
    addCodeWorkspaceEntry(document, {
      id: "old-file",
      kind: "file",
      name: "old.txt",
      text: "old",
    }, "seed");
    const localOrigin = Object.freeze({ type: "runner-delta" });
    let transactions = 0;
    document.on("afterTransaction", (transaction) => {
      if (transaction.origin === localOrigin) transactions += 1;
    });

    applyCodeWorkspaceStableFileCommands(document, [
      {
        kind: "replace-file",
        entryId: "main-py",
        content: { kind: "text", text: "print(42)\n" },
      },
      { kind: "remove-file", entryId: "old-file" },
      {
        kind: "create-folder",
        entryId: "generated-folder",
        parentId: null,
        name: "generated",
      },
      {
        kind: "create-file",
        entryId: "generated-text",
        parentId: "generated-folder",
        name: "answer.txt",
        content: { kind: "text", text: "42\n" },
      },
      {
        kind: "create-file",
        entryId: "generated-binary",
        parentId: null,
        name: "data.bin",
        content: {
          kind: "blob",
          blob: {
            sha256: "c".repeat(64),
            byteSize: 3,
            mimeType: "application/octet-stream",
          },
        },
      },
    ], localOrigin);

    expect(transactions).toBe(1);
    expect(codeWorkspaceText(document, "main-py")).toBe(originalMainText);
    expect(codeWorkspaceText(document, "main-py")?.toString()).toBe("print(42)\n");
    expect(codeWorkspaceEntries(document).has("old-file")).toBe(false);
    expect(workspaceFilePaths(document).get("generated-text"))
      .toBe("generated/answer.txt");
    expect(listCodeWorkspaceEntries(document)).toContainEqual(
      expect.objectContaining({
        id: "generated-binary",
        contentKind: "blob",
        blob: expect.objectContaining({ sha256: "c".repeat(64) }),
      }),
    );
    expect(() => applyCodeWorkspaceStableFileCommands(document, [{
      kind: "remove-file",
      entryId: "main-py",
    }])).toThrowError(CodeWorkspaceError);
  });

  it("compares test output by normalized lines", () => {
    expect(compareCodeTestOutput("42\r\n", "42")).toBe(true);
    expect(compareCodeTestOutput("1  2\n3", "1\n2 3")).toBe(false);
  });

  it("rejects malformed remote tree state during structural validation", () => {
    const document = new Y.Doc();
    initializeCodeWorkspace(document, "seed");
    const entry = codeWorkspaceEntries(document).get("main-py")!;
    entry.set("name", "../main.py");
    expect(() => validateCodeWorkspaceDocument(document))
      .toThrowError(CodeWorkspaceError);
  });

  it("requires main-py to remain a file during structural validation", () => {
    const missingMain = new Y.Doc();
    initializeCodeWorkspace(missingMain, "seed");
    codeWorkspaceEntries(missingMain).delete("main-py");
    expect(() => validateCodeWorkspaceDocument(missingMain))
      .toThrowError("main.py is required");

    const folderMain = new Y.Doc();
    initializeCodeWorkspace(folderMain, "seed");
    const entries = codeWorkspaceEntries(folderMain);
    entries.delete("main-py");
    const folder = new Y.Map<unknown>();
    folder.set("kind", "folder");
    folder.set("parentId", null);
    folder.set("name", "main.py");
    folder.set("rank", "a0");
    entries.set("main-py", folder);
    expect(() => validateCodeWorkspaceDocument(folderMain))
      .toThrowError("main.py is required");
  });

  it("keeps binary file bytes outside the CRDT behind a content identity", () => {
    const document = new Y.Doc();
    initializeCodeWorkspace(document, "seed");
    const id = addCodeWorkspaceEntry(document, {
      id: "dataset",
      kind: "file",
      name: "данные.bin",
      blob: {
        sha256: "a".repeat(64),
        byteSize: 4,
        mimeType: "application/octet-stream",
      },
    }, "local");
    expect(codeWorkspaceText(document, id)).toBeNull();
    expect(listCodeWorkspaceEntries(document)).toContainEqual(
      expect.objectContaining({
        id,
        contentKind: "blob",
        text: null,
        blob: expect.objectContaining({
          sha256: "a".repeat(64),
          byteSize: 4,
        }),
      }),
    );
    expect(() => validateCodeWorkspaceDocument(document)).not.toThrow();
  });

  it("derives deterministic unique paths for concurrent sibling collisions", () => {
    const seed = new Y.Doc();
    initializeCodeWorkspace(seed, "seed");
    const initial = Y.encodeStateAsUpdate(seed);
    const left = new Y.Doc();
    const right = new Y.Doc();
    Y.applyUpdate(left, initial);
    Y.applyUpdate(right, initial);
    addCodeWorkspaceEntry(left, {
      id: "left-file",
      kind: "file",
      name: "solver.py",
    }, "left");
    addCodeWorkspaceEntry(right, {
      id: "right-file",
      kind: "file",
      name: "SOLVER.py",
    }, "right");
    Y.applyUpdate(left, Y.encodeStateAsUpdate(right, Y.encodeStateVector(seed)));
    Y.applyUpdate(right, Y.encodeStateAsUpdate(left));

    const leftPaths = workspaceFilePaths(left);
    const rightPaths = workspaceFilePaths(right);
    expect(leftPaths).toEqual(rightPaths);
    expect(new Set([
      leftPaths.get("left-file")?.toLocaleLowerCase("en-US"),
      leftPaths.get("right-file")?.toLocaleLowerCase("en-US"),
    ]).size).toBe(2);
    expect(() => validateCodeWorkspaceDocument(left)).not.toThrow();
    expect(() => validateCodeWorkspaceDocument(right)).not.toThrow();
  });

  it("derives the same valid tree from concurrent cross-moves", () => {
    const seed = new Y.Doc();
    initializeCodeWorkspace(seed, "seed");
    addCodeWorkspaceEntry(seed, {
      id: "a-folder",
      kind: "folder",
      name: "a",
    }, "seed");
    addCodeWorkspaceEntry(seed, {
      id: "b-folder",
      kind: "folder",
      name: "b",
    }, "seed");
    const initial = Y.encodeStateAsUpdate(seed);
    const baseline = Y.encodeStateVector(seed);
    const left = new Y.Doc();
    const right = new Y.Doc();
    Y.applyUpdate(left, initial);
    Y.applyUpdate(right, initial);

    moveCodeWorkspaceEntry(left, "a-folder", "b-folder", "left");
    moveCodeWorkspaceEntry(right, "b-folder", "a-folder", "right");
    const leftUpdate = Y.encodeStateAsUpdate(left, baseline);
    const rightUpdate = Y.encodeStateAsUpdate(right, baseline);
    const leftFirst = new Y.Doc();
    const rightFirst = new Y.Doc();
    Y.applyUpdate(leftFirst, initial);
    Y.applyUpdate(rightFirst, initial);
    Y.applyUpdate(leftFirst, leftUpdate);
    Y.applyUpdate(leftFirst, rightUpdate);
    Y.applyUpdate(leftFirst, rightUpdate);
    Y.applyUpdate(rightFirst, rightUpdate);
    Y.applyUpdate(rightFirst, leftUpdate);

    expect(codeWorkspaceEntries(leftFirst).get("a-folder")?.get("parentId"))
      .toBe("b-folder");
    expect(codeWorkspaceEntries(leftFirst).get("b-folder")?.get("parentId"))
      .toBe("a-folder");
    const expectedParents = new Map([
      ["a-folder", null],
      ["b-folder", "a-folder"],
      ["main-py", null],
    ]);
    expect(new Map(listCodeWorkspaceEntries(leftFirst)
      .map((entry) => [entry.id, entry.parentId])))
      .toEqual(expectedParents);
    expect(new Map(listCodeWorkspaceEntries(rightFirst)
      .map((entry) => [entry.id, entry.parentId])))
      .toEqual(expectedParents);
    expect(workspaceFilePaths(leftFirst)).toEqual(workspaceFilePaths(rightFirst));
    expect(Y.encodeStateVector(leftFirst)).toEqual(Y.encodeStateVector(rightFirst));
    expect(() => validateCodeWorkspaceDocument(leftFirst)).not.toThrow();
    expect(() => validateCodeWorkspaceDocument(rightFirst)).not.toThrow();

    expect(() => moveCodeWorkspaceEntry(leftFirst, "a-folder", "b-folder"))
      .toThrowError(CodeWorkspaceError);
    expect(removeCodeWorkspaceEntry(leftFirst, "b-folder", "left"))
      .toEqual(["b-folder"]);
    expect(codeWorkspaceEntries(leftFirst).has("a-folder")).toBe(true);
    expect(() => validateCodeWorkspaceDocument(leftFirst)).not.toThrow();
  });

  it("detaches an entry whose concurrently assigned parent was deleted", () => {
    const seed = new Y.Doc();
    initializeCodeWorkspace(seed, "seed");
    addCodeWorkspaceEntry(seed, {
      id: "doomed-folder",
      kind: "folder",
      name: "doomed",
    }, "seed");
    addCodeWorkspaceEntry(seed, {
      id: "survivor",
      kind: "file",
      name: "survivor.py",
    }, "seed");
    const initial = Y.encodeStateAsUpdate(seed);
    const baseline = Y.encodeStateVector(seed);
    const movingPeer = new Y.Doc();
    const deletingPeer = new Y.Doc();
    Y.applyUpdate(movingPeer, initial);
    Y.applyUpdate(deletingPeer, initial);
    moveCodeWorkspaceEntry(movingPeer, "survivor", "doomed-folder", "move");
    removeCodeWorkspaceEntry(deletingPeer, "doomed-folder", "delete");
    const moveUpdate = Y.encodeStateAsUpdate(movingPeer, baseline);
    const deleteUpdate = Y.encodeStateAsUpdate(deletingPeer, baseline);

    const moveFirst = new Y.Doc();
    const deleteFirst = new Y.Doc();
    Y.applyUpdate(moveFirst, initial);
    Y.applyUpdate(deleteFirst, initial);
    Y.applyUpdate(moveFirst, moveUpdate);
    Y.applyUpdate(moveFirst, deleteUpdate);
    Y.applyUpdate(deleteFirst, deleteUpdate);
    Y.applyUpdate(deleteFirst, moveUpdate);

    expect(codeWorkspaceEntries(moveFirst).get("survivor")?.get("parentId"))
      .toBe("doomed-folder");
    expect(listCodeWorkspaceEntries(moveFirst)
      .find((entry) => entry.id === "survivor")?.parentId)
      .toBeNull();
    expect(workspaceFilePaths(moveFirst).get("survivor")).toBe("survivor.py");
    expect(workspaceFilePaths(moveFirst)).toEqual(workspaceFilePaths(deleteFirst));
    expect(() => validateCodeWorkspaceDocument(moveFirst)).not.toThrow();
    expect(() => validateCodeWorkspaceDocument(deleteFirst)).not.toThrow();
  });

  it("normalizes a concurrent depth overflow while rejecting it locally", () => {
    const seed = new Y.Doc();
    initializeCodeWorkspace(seed, "seed");
    const addChain = (prefix: string): { root: string; leaf: string } => {
      let parentId: string | null = null;
      let root = "";
      for (let index = 0; index < 12; index += 1) {
        const id = `${prefix}-${index}`;
        addCodeWorkspaceEntry(seed, {
          id,
          kind: "folder",
          parentId,
          name: id,
        }, "seed");
        if (index === 0) root = id;
        parentId = id;
      }
      return { root, leaf: parentId! };
    };
    const a = addChain("a");
    const b = addChain("b");
    const c = addChain("c");
    const initial = Y.encodeStateAsUpdate(seed);
    const baseline = Y.encodeStateVector(seed);
    const left = new Y.Doc();
    const right = new Y.Doc();
    Y.applyUpdate(left, initial);
    Y.applyUpdate(right, initial);
    moveCodeWorkspaceEntry(left, a.root, b.leaf, "left");
    moveCodeWorkspaceEntry(right, b.root, c.leaf, "right");
    const leftUpdate = Y.encodeStateAsUpdate(left, baseline);
    const rightUpdate = Y.encodeStateAsUpdate(right, baseline);
    Y.applyUpdate(left, rightUpdate);
    Y.applyUpdate(right, leftUpdate);

    const depths = (document: Y.Doc) => {
      const entries = listCodeWorkspaceEntries(document);
      const byId = new Map(entries.map((entry) => [entry.id, entry]));
      return entries.map((entry) => {
        let depth = 0;
        let parentId = entry.parentId;
        while (parentId !== null) {
          depth += 1;
          parentId = byId.get(parentId)?.parentId ?? null;
        }
        return depth;
      });
    };
    expect(Math.max(...depths(left))).toBeLessThanOrEqual(CODE_WORKSPACE_MAX_DEPTH);
    expect(listCodeWorkspaceEntries(left)).toEqual(listCodeWorkspaceEntries(right));
    expect(() => validateCodeWorkspaceDocument(left)).not.toThrow();
    expect(() => validateCodeWorkspaceDocument(right)).not.toThrow();

    const local = new Y.Doc();
    Y.applyUpdate(local, initial);
    moveCodeWorkspaceEntry(local, a.root, b.leaf, "local");
    expect(() => moveCodeWorkspaceEntry(local, b.root, c.leaf, "local"))
      .toThrowError(CodeWorkspaceError);
  });

  it("normalizes a concurrent path overflow while rejecting it locally", () => {
    const seed = new Y.Doc();
    initializeCodeWorkspace(seed, "seed");
    const addChain = (prefix: string): { root: string; leaf: string } => {
      let parentId: string | null = null;
      let root = "";
      for (let index = 0; index < 7; index += 1) {
        const id = `${prefix}-${index}`;
        addCodeWorkspaceEntry(seed, {
          id,
          kind: "folder",
          parentId,
          name: `${id}-${"x".repeat(45)}`,
        }, "seed");
        if (index === 0) root = id;
        parentId = id;
      }
      return { root, leaf: parentId! };
    };
    const a = addChain("a");
    const b = addChain("b");
    const c = addChain("c");
    const initial = Y.encodeStateAsUpdate(seed);
    const baseline = Y.encodeStateVector(seed);
    const left = new Y.Doc();
    const right = new Y.Doc();
    Y.applyUpdate(left, initial);
    Y.applyUpdate(right, initial);
    moveCodeWorkspaceEntry(left, a.root, b.leaf, "left");
    moveCodeWorkspaceEntry(right, b.root, c.leaf, "right");
    const leftUpdate = Y.encodeStateAsUpdate(left, baseline);
    const rightUpdate = Y.encodeStateAsUpdate(right, baseline);
    Y.applyUpdate(left, rightUpdate);
    Y.applyUpdate(right, leftUpdate);

    expect(Math.max(...[...workspaceFilePaths(left).values()]
      .map((path) => path.length)))
      .toBeLessThanOrEqual(CODE_WORKSPACE_MAX_PATH_CODE_UNITS);
    expect(listCodeWorkspaceEntries(left)).toEqual(listCodeWorkspaceEntries(right));
    expect(workspaceFilePaths(left)).toEqual(workspaceFilePaths(right));
    expect(() => validateCodeWorkspaceDocument(left)).not.toThrow();
    expect(() => validateCodeWorkspaceDocument(right)).not.toThrow();

    const local = new Y.Doc();
    Y.applyUpdate(local, initial);
    moveCodeWorkspaceEntry(local, a.root, b.leaf, "local");
    expect(() => moveCodeWorkspaceEntry(local, b.root, c.leaf, "local"))
      .toThrowError(CodeWorkspaceError);
  });
});

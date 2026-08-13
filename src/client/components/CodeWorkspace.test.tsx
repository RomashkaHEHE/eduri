// @vitest-environment jsdom

import { webcrypto } from "node:crypto";
import { act, createElement, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import {
  addCodeTestCase,
  addCodeWorkspaceEntry,
  codeWorkspaceText,
  codeWorkspaceTestCases,
  initializeCodeWorkspace,
  listCodeWorkspaceEntries,
  removeCodeWorkspaceEntry,
  replaceCodeWorkspaceText,
} from "../../code/core/index.js";
import type { CodeWorkspaceSessionHandle } from "./CodeWorkspace.js";
import {
  SHARED_TERMINAL_LIMITS,
  SharedTerminalStateMachine,
  toSharedTerminalClientEffect,
  type SharedTerminalAction,
  type SharedTerminalActor,
  type SharedTerminalClientEffect,
  type SharedTerminalState,
} from "../../code/terminal/index.js";

if (!globalThis.crypto.subtle) {
  Object.defineProperty(globalThis.crypto, "subtle", {
    configurable: true,
    value: webcrypto.subtle,
  });
}

const runnerMocks = vi.hoisted(() => ({
  startPythonRun: vi.fn(),
}));
const terminalRunnerMocks = vi.hoisted(() => ({
  startPythonTerminal: vi.fn(),
}));
const editorMocks = vi.hoisted(() => ({
  props: vi.fn(),
  setTheme: vi.fn(),
  instances: [] as Array<{ model: Record<string, any>; editor: Record<string, any> }>,
}));
const xtermMocks = vi.hoisted(() => ({
  instances: [] as Array<{
    emitData(data: string): void;
    output: string;
    options: Record<string, unknown>;
  }>,
}));

vi.mock("@monaco-editor/react", () => ({
  default: (props: {
    value?: string;
    defaultValue?: string;
    path?: string;
    theme?: string;
    onMount?: (editor: unknown, monaco: unknown) => void;
  }) => {
    editorMocks.props(props);
    useEffect(() => {
      let value = props.defaultValue ?? props.value ?? "";
      let selection = {
        selectionStartLineNumber: 1,
        selectionStartColumn: 1,
        positionLineNumber: 1,
        positionColumn: 1,
      };
      const contentListeners = new Set<(event: { changes: unknown[] }) => void>();
      const disposeListeners = new Set<() => void>();
      const cursorListeners = new Set<() => void>();
      const focusListeners = new Set<() => void>();
      const blurListeners = new Set<() => void>();
      let focused = false;
      const offsetAt = (position: { lineNumber: number; column: number }) => {
        const lines = value.split("\n");
        let offset = 0;
        for (let line = 1; line < position.lineNumber; line += 1) {
          offset += (lines[line - 1]?.length ?? 0) + 1;
        }
        return Math.min(value.length, offset + Math.max(0, position.column - 1));
      };
      const positionAt = (input: number) => {
        const offset = Math.max(0, Math.min(value.length, input));
        const prefix = value.slice(0, offset);
        const lines = prefix.split("\n");
        return {
          lineNumber: lines.length,
          column: (lines.at(-1)?.length ?? 0) + 1,
        };
      };
      const model = {
        getValue: () => value,
        setValue: (next: string) => {
          const previousLength = value.length;
          value = next;
          for (const listener of contentListeners) listener({
            changes: [{ rangeOffset: 0, rangeLength: previousLength, text: next }],
          });
        },
        getOffsetAt: offsetAt,
        getPositionAt: positionAt,
        applyEdits: (edits: Array<{ range: {
          startLineNumber: number;
          startColumn: number;
          endLineNumber: number;
          endColumn: number;
        }; text: string }>) => {
          const changes = edits.map((edit) => {
            const start = offsetAt({
              lineNumber: edit.range.startLineNumber,
              column: edit.range.startColumn,
            });
            const end = offsetAt({
              lineNumber: edit.range.endLineNumber,
              column: edit.range.endColumn,
            });
            return {
              rangeOffset: start,
              rangeLength: end - start,
              text: edit.text,
            };
          }).sort((left, right) => right.rangeOffset - left.rangeOffset);
          for (const change of changes) {
            value = value.slice(0, change.rangeOffset)
              + change.text
              + value.slice(change.rangeOffset + change.rangeLength);
          }
          for (const listener of contentListeners) listener({ changes });
          return [];
        },
        onDidChangeContent: (listener: (event: { changes: unknown[] }) => void) => {
          contentListeners.add(listener);
          return { dispose: () => contentListeners.delete(listener) };
        },
        onWillDispose: (listener: () => void) => {
          disposeListeners.add(listener);
          return { dispose: () => disposeListeners.delete(listener) };
        },
      };
      const disposable = () => ({ dispose: vi.fn() });
      const editor = {
        addCommand: vi.fn(),
        addContentWidget: vi.fn(),
        createDecorationsCollection: () => ({ clear: vi.fn(), set: vi.fn() }),
        getDomNode: () => globalThis.document.body,
        getModel: () => model,
        getPosition: () => ({
          lineNumber: selection.positionLineNumber,
          column: selection.positionColumn,
        }),
        getSelection: () => selection,
        getSelections: () => [selection],
        hasTextFocus: () => focused,
        layoutContentWidget: vi.fn(),
        onDidBlurEditorText: (listener: () => void) => {
          blurListeners.add(listener);
          return { dispose: () => blurListeners.delete(listener) };
        },
        onDidChangeCursorSelection: (listener: () => void) => {
          cursorListeners.add(listener);
          return { dispose: () => cursorListeners.delete(listener) };
        },
        onDidChangeModel: disposable,
        onDidDispose: disposable,
        onDidFocusEditorText: (listener: () => void) => {
          focusListeners.add(listener);
          return { dispose: () => focusListeners.delete(listener) };
        },
        removeContentWidget: vi.fn(),
        setSelections: (next: typeof selection[]) => {
          selection = next[0] ?? selection;
        },
        emitCursorSelection: () => {
          for (const listener of cursorListeners) listener();
        },
        setTextFocus: (next: boolean) => {
          focused = next;
          for (const listener of next ? focusListeners : blurListeners) listener();
        },
      };
      editorMocks.instances.push({ model, editor });
      props.onMount?.(editor, {
        editor: { setTheme: editorMocks.setTheme },
        KeyCode: { KeyY: 2, KeyZ: 1 },
        KeyMod: { CtrlCmd: 1, Shift: 2 },
      });
      return () => {
        for (const listener of disposeListeners) listener();
      };
    }, [props.path]);
    return createElement("div", {
      "data-testid": "monaco",
      "data-default-value": props.defaultValue,
      "data-controlled-value": props.value,
    });
  },
}));

vi.mock("@xterm/xterm", () => ({
  Terminal: class MockTerminal {
    output = "";
    options: Record<string, unknown>;
    private dataListener: ((data: string) => void) | null = null;

    constructor(options: Record<string, unknown>) {
      this.options = { ...options };
      xtermMocks.instances.push(this);
    }

    loadAddon() {}
    open() {}
    reset() { this.output = ""; }
    write(value: string) { this.output += value; }
    dispose() {}
    onData(listener: (data: string) => void) {
      this.dataListener = listener;
      return { dispose: () => { this.dataListener = null; } };
    }
    emitData(data: string) { this.dataListener?.(data); }
  },
}));

vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class MockFitAddon {
    fit() {}
  },
}));

vi.mock("../pythonRunner", async (importOriginal) => ({
  ...await importOriginal<typeof import("../pythonRunner")>(),
  startPythonRun: runnerMocks.startPythonRun,
}));

vi.mock("../pythonTerminal", async (importOriginal) => ({
  ...await importOriginal<typeof import("../pythonTerminal")>(),
  startPythonTerminal: terminalRunnerMocks.startPythonTerminal,
}));

import { CodeWorkspace } from "./CodeWorkspace.js";
import { PYTHON_TERMINAL_OUTPUT_TRUNCATION_MARKER } from "../pythonTerminal.js";
import { THEME_STORAGE_KEY, ThemeProvider } from "../theme.js";

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
    .IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  runnerMocks.startPythonRun.mockReset();
  terminalRunnerMocks.startPythonTerminal.mockReset();
  editorMocks.props.mockReset();
  editorMocks.setTheme.mockReset();
  editorMocks.instances.length = 0;
  xtermMocks.instances.length = 0;
  window.localStorage.clear();
  vi.useRealTimers();
});

function createTestTerminalBridge() {
  const machine = new SharedTerminalStateMachine();
  const actor: SharedTerminalActor = {
    socketId: "test-socket",
    participantId: "test-participant",
    displayName: "Test user",
    color: "#336699",
  };
  const stateListeners = new Set<(state: SharedTerminalState) => void>();
  const effectListeners = new Set<
    (effect: SharedTerminalClientEffect) => void
  >();
  const dispatch = vi.fn((action: SharedTerminalAction) => {
    const result = machine.dispatch(actor, action);
    if (result.changed || action.type === "sync") {
      for (const listener of stateListeners) listener(result.state);
    }
    if (result.effect) {
      const effect = toSharedTerminalClientEffect(result.effect);
      for (const listener of effectListeners) listener(effect);
    }
  });
  return {
    bridge: {
      participantId: actor.participantId,
      dispatch,
      subscribeState(listener: (state: SharedTerminalState) => void) {
        stateListeners.add(listener);
        listener(machine.snapshot());
        return () => stateListeners.delete(listener);
      },
      subscribeEffects(listener: (effect: SharedTerminalClientEffect) => void) {
        effectListeners.add(listener);
        return () => effectListeners.delete(listener);
      },
    },
    dispatch,
    snapshot: () => machine.snapshot(),
  };
}

function createPythonTerminalMock(overrides: Record<string, unknown> = {}) {
  return {
    sessionId: "python-terminal-test",
    ready: Promise.resolve({ status: "ready" as const }),
    mode: vi.fn(() => "shell" as const),
    executeEntrypoint: vi.fn(async () => ({
      commandId: "command-1",
      status: "ok" as const,
      output: "",
      truncated: false,
      mode: "shell" as const,
      prompt: null,
    })),
    startRepl: vi.fn(),
    submitReplLine: vi.fn(),
    interruptRepl: vi.fn(),
    exitRepl: vi.fn(),
    submitInput: vi.fn(() => true),
    sendEof: vi.fn(() => true),
    interrupt: vi.fn(() => true),
    close: vi.fn(),
    ...overrides,
  };
}

function commandResult() {
  return {
    commandId: "command-1",
    status: "ok" as const,
    output: "",
    truncated: false,
    mode: "shell" as const,
    prompt: null,
  };
}

describe("CodeWorkspace collaborative session", () => {
  it("uses the global dark theme for Monaco without changing the workspace", async () => {
    const document = new Y.Doc();
    initializeCodeWorkspace(document, "theme-test");
    const session: CodeWorkspaceSessionHandle = {
      document,
      origin: Object.freeze({ type: "local" }),
      blobStore: {
        put: vi.fn(async () => {
          throw new Error("not used");
        }),
        get: vi.fn(async () => null),
      },
      flush: vi.fn(async () => undefined),
    };
    const beforeEntries = listCodeWorkspaceEntries(document);
    window.localStorage.setItem(THEME_STORAGE_KEY, "dark");
    container = documentOwner().createElement("div");
    documentOwner().body.append(container);
    root = createRoot(container);

    await act(async () => {
      root?.render(createElement(
        ThemeProvider,
        null,
        createElement(CodeWorkspace, { session }),
      ));
      await Promise.resolve();
    });

    expect(editorMocks.props).toHaveBeenLastCalledWith(expect.objectContaining({
      theme: "vs-dark",
    }));
    expect(editorMocks.setTheme).toHaveBeenLastCalledWith("vs-dark");
    const workspace = container.querySelector(".full-code-workspace");
    const explorer = container.querySelector(".code-explorer");
    const terminal = container.querySelector(".code-console");
    expect(workspace?.getAttribute("data-code-theme")).toBe("dark");
    expect(explorer).not.toBeNull();
    expect(terminal).not.toBeNull();

    window.localStorage.setItem(THEME_STORAGE_KEY, "light");
    await act(async () => {
      window.dispatchEvent(new StorageEvent("storage", {
        key: THEME_STORAGE_KEY,
        newValue: "light",
      }));
    });

    expect(editorMocks.props).toHaveBeenLastCalledWith(expect.objectContaining({
      theme: "vs",
    }));
    expect(editorMocks.setTheme).toHaveBeenLastCalledWith("vs");
    expect(workspace?.getAttribute("data-code-theme")).toBe("light");
    expect(container.querySelector(".code-explorer")).toBe(explorer);
    expect(container.querySelector(".code-console")).toBe(terminal);
    expect(listCodeWorkspaceEntries(document)).toEqual(beforeEntries);
    await act(async () => root?.unmount());
    root = null;
    document.destroy();
  });

  it("does not mutate a guest document merely by mounting and enforces read-only controls", async () => {
    const document = new Y.Doc();
    initializeCodeWorkspace(document, "server-bootstrap");
    const updates: Uint8Array[] = [];
    document.on("update", (update) => updates.push(update.slice()));
    const session: CodeWorkspaceSessionHandle = {
      document,
      origin: Object.freeze({ type: "local" }),
      blobStore: {
        put: vi.fn(async () => {
          throw new Error("not used");
        }),
        get: vi.fn(async () => null),
      },
      flush: vi.fn(async () => undefined),
    };
    const onSessionReady = vi.fn();
    container = documentOwner().createElement("div");
    documentOwner().body.append(container);
    root = createRoot(container);

    await act(async () => {
      root?.render(createElement(CodeWorkspace, {
        session,
        readOnly: true,
        onSessionReady,
      }));
      await Promise.resolve();
    });

    expect(codeWorkspaceTestCases(document).size).toBe(0);
    expect(updates).toEqual([]);
    expect(onSessionReady).toHaveBeenCalledWith(session);
    const explorerMenu = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Меню проводника"]',
    );
    await act(async () => {
      explorerMenu?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });
    const mutationActions = [
      ...container.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'),
    ];
    expect(mutationActions).toHaveLength(3);
    expect(mutationActions.every((button) => button.disabled)).toBe(true);
    await act(async () => root?.unmount());
    root = null;
    document.destroy();
  });

  it("duplicates files and keeps Explorer undo history only for the mounted session", async () => {
    const document = new Y.Doc();
    initializeCodeWorkspace(document, "server-bootstrap");
    addCodeWorkspaceEntry(document, {
      id: "helper-py",
      kind: "file",
      name: "helper.py",
      text: "def helper():\n    return 42\n",
    }, "server-bootstrap");
    addCodeWorkspaceEntry(document, {
      id: "data-bin",
      kind: "file",
      name: "data.bin",
      blob: {
        sha256: "a".repeat(64),
        byteSize: 4,
        mimeType: "application/octet-stream",
      },
    }, "server-bootstrap");
    const session: CodeWorkspaceSessionHandle = {
      document,
      origin: Object.freeze({ type: "local" }),
      blobStore: {
        put: vi.fn(async () => {
          throw new Error("not used");
        }),
        get: vi.fn(async () => null),
      },
      flush: vi.fn(async () => undefined),
    };
    container = documentOwner().createElement("div");
    documentOwner().body.append(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(createElement(CodeWorkspace, { session }));
      await Promise.resolve();
    });

    const treeButton = (name: string) => [
      ...container!.querySelectorAll<HTMLButtonElement>("button"),
    ].find((button) => button.textContent?.trim() === name);
    const openEntryMenu = async (name: string) => {
      await act(async () => {
        treeButton(name)?.closest('[role="treeitem"]')?.dispatchEvent(
          new MouseEvent("contextmenu", {
            bubbles: true,
            cancelable: true,
            clientX: 40,
            clientY: 50,
          }),
        );
        await Promise.resolve();
      });
    };
    const clickMenuAction = async (name: string) => {
      const action = [
        ...container!.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'),
      ].find((button) => button.textContent?.trim() === name);
      await act(async () => {
        action?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await Promise.resolve();
      });
    };

    await openEntryMenu("helper.py");
    await clickMenuAction("Дублировать");
    await vi.waitFor(() => expect(listCodeWorkspaceEntries(document))
      .toContainEqual(expect.objectContaining({
        name: "helper-2.py",
        text: "def helper():\n    return 42\n",
        contentKind: "text",
      })));

    await openEntryMenu("data.bin");
    await clickMenuAction("Дублировать");
    expect(listCodeWorkspaceEntries(document)).toContainEqual(
      expect.objectContaining({
        name: "data-2.bin",
        contentKind: "blob",
        blob: expect.objectContaining({ sha256: "a".repeat(64) }),
      }),
    );

    await openEntryMenu("helper.py");
    await clickMenuAction("Удалить");
    await vi.waitFor(() => expect(listCodeWorkspaceEntries(document)
      .some((entry) => entry.id === "helper-py")).toBe(false));

    const historyKey = async (key: "z" | "y") => {
      await act(async () => {
        treeButton("main.py")?.dispatchEvent(new KeyboardEvent("keydown", {
          key,
          ctrlKey: true,
          bubbles: true,
          cancelable: true,
        }));
        await Promise.resolve();
      });
    };
    await historyKey("z");
    expect(listCodeWorkspaceEntries(document)
      .some((entry) => entry.id === "helper-py")).toBe(true);
    await historyKey("y");
    expect(listCodeWorkspaceEntries(document)
      .some((entry) => entry.id === "helper-py")).toBe(false);

    await act(async () => root?.unmount());
    root = createRoot(container);
    await act(async () => {
      root?.render(createElement(CodeWorkspace, { session }));
      await Promise.resolve();
    });
    await historyKey("z");
    expect(listCodeWorkspaceEntries(document)
      .some((entry) => entry.id === "helper-py")).toBe(false);

    await act(async () => root?.unmount());
    root = null;
    document.destroy();
  });

  it("shows folder actions in the editor area and targets the selected folder", async () => {
    const document = new Y.Doc();
    initializeCodeWorkspace(document, "server-bootstrap");
    addCodeWorkspaceEntry(document, {
      id: "empty-folder",
      kind: "folder",
      name: "empty",
    }, "server-bootstrap");
    const session: CodeWorkspaceSessionHandle = {
      document,
      origin: Object.freeze({ type: "local" }),
      blobStore: {
        put: vi.fn(async () => {
          throw new Error("not used");
        }),
        get: vi.fn(async () => null),
      },
      flush: vi.fn(async () => undefined),
    };
    container = documentOwner().createElement("div");
    documentOwner().body.append(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(createElement(CodeWorkspace, { session }));
      await Promise.resolve();
    });

    const buttonNamed = (name: string) => [
      ...container!.querySelectorAll<HTMLButtonElement>("button"),
    ].find((button) => button.textContent?.trim() === name);
    await act(async () => {
      buttonNamed("empty")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });

    const folderActions = container.querySelector('[role="group"][aria-label="Действия папки empty"]');
    expect(folderActions).not.toBeNull();
    expect([
      ...folderActions!.querySelectorAll<HTMLButtonElement>("button"),
    ].map((button) => button.textContent?.trim())).toEqual([
      "Прикрепить файл",
      "Создать файл",
      "Создать папку",
    ]);

    await act(async () => {
      buttonNamed("Создать папку")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });
    expect(listCodeWorkspaceEntries(document)).toContainEqual(
      expect.objectContaining({
        kind: "folder",
        parentId: "empty-folder",
        name: "folder",
      }),
    );

    const uploadInput = container.querySelector<HTMLInputElement>(
      'input[aria-label="Файлы для папки empty"]',
    )!;
    const inputClick = vi.spyOn(uploadInput, "click");
    await act(async () => {
      buttonNamed("Прикрепить файл")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(inputClick).toHaveBeenCalledTimes(1);
    const attached = new File(["print(1)\n"], "attached.py", {
      type: "text/x-python",
    });
    Object.defineProperty(attached, "arrayBuffer", {
      configurable: true,
      value: async () => new TextEncoder().encode("print(1)\n").buffer,
    });
    Object.defineProperty(uploadInput, "files", {
      configurable: true,
      value: [attached],
    });
    await act(async () => {
      uploadInput.dispatchEvent(new Event("change", { bubbles: true }));
      await vi.waitFor(() => expect(listCodeWorkspaceEntries(document))
        .toContainEqual(expect.objectContaining({
          kind: "file",
          parentId: "empty-folder",
          name: "attached.py",
          text: "print(1)\n",
        })));
    });

    await act(async () => {
      buttonNamed("empty")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });
    await act(async () => {
      buttonNamed("Создать файл")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });
    expect(listCodeWorkspaceEntries(document)).toContainEqual(
      expect.objectContaining({
        kind: "file",
        parentId: "empty-folder",
        name: "untitled.py",
      }),
    );

    document.destroy();
  });

  it("keeps command editing inside xterm and routes it through shared state", async () => {
    const document = new Y.Doc();
    initializeCodeWorkspace(document, "solo-bootstrap");
    const terminal = createTestTerminalBridge();
    let resolveSynchronization!: () => void;
    const synchronization = new Promise<void>((resolve) => {
      resolveSynchronization = resolve;
    });
    const waitUntilSynchronized = vi.fn(() => synchronization);
    const session: CodeWorkspaceSessionHandle = {
      document,
      origin: Object.freeze({ type: "local" }),
      blobStore: {
        put: vi.fn(async () => {
          throw new Error("not used");
        }),
        get: vi.fn(async () => null),
      },
      flush: vi.fn(async () => undefined),
      terminal: terminal.bridge,
      waitUntilSynchronized,
    };
    terminalRunnerMocks.startPythonTerminal.mockReturnValue(
      createPythonTerminalMock(),
    );
    container = documentOwner().createElement("div");
    documentOwner().body.append(container);
    root = createRoot(container);

    await act(async () => {
      root?.render(createElement(CodeWorkspace, { session }));
      await Promise.resolve();
    });
    expect(container.querySelector(".code-console__output input")).toBeNull();
    expect(container.querySelector(".code-console__output form")).toBeNull();
    expect(container.querySelector('[role="textbox"]')).not.toBeNull();
    const xterm = xtermMocks.instances.at(-1);
    expect(xterm).toBeDefined();
    await act(async () => {
      container?.querySelector('[role="textbox"]')?.dispatchEvent(
        new FocusEvent("focusin", { bubbles: true }),
      );
      await Promise.resolve();
    });

    await act(async () => {
      container?.querySelector<HTMLElement>('[role="textbox"]')?.dispatchEvent(
        new FocusEvent("focusin", { bubbles: true }),
      );
      await Promise.resolve();
    });
    await act(async () => {
      xterm?.emitData("pwd");
      await Promise.resolve();
    });
    expect(terminal.dispatch).toHaveBeenCalledWith(expect.objectContaining({
      type: "edit-input",
      value: "pwd",
      cursor: 3,
    }));
    expect(terminal.snapshot().input.value).toBe("pwd");

    await act(async () => {
      xterm?.emitData("\r");
      await Promise.resolve();
    });
    expect(waitUntilSynchronized).toHaveBeenCalledOnce();
    expect(terminal.dispatch).not.toHaveBeenCalledWith(expect.objectContaining({
      type: "submit-line",
    }));

    // Input is frozen as soon as Enter is pressed. A key typed while the code
    // outbox is still synchronizing cannot overtake the delayed submit.
    await act(async () => {
      xterm?.emitData("x");
      await Promise.resolve();
    });
    expect(terminal.dispatch).not.toHaveBeenCalledWith(expect.objectContaining({
      type: "edit-input",
      value: "pwdx",
    }));

    await act(async () => {
      resolveSynchronization();
      await vi.waitFor(() => expect(terminal.dispatch).toHaveBeenCalledWith(
        expect.objectContaining({ type: "submit-line", value: "pwd" }),
      ));
    });
    await vi.waitFor(() => expect(terminal.snapshot().transcript)
      .toContain("/workspace\n"));
    document.destroy();
  });

  it("keeps the editor writable but disables terminal input and Run offline", async () => {
    const document = new Y.Doc();
    initializeCodeWorkspace(document, "offline-terminal-bootstrap");
    const terminal = createTestTerminalBridge();
    const session: CodeWorkspaceSessionHandle = {
      document,
      origin: Object.freeze({ type: "local" }),
      blobStore: {
        put: vi.fn(async () => {
          throw new Error("not used");
        }),
        get: vi.fn(async () => null),
      },
      flush: vi.fn(async () => undefined),
      terminal: terminal.bridge,
    };
    container = documentOwner().createElement("div");
    documentOwner().body.append(container);
    root = createRoot(container);

    await act(async () => {
      root?.render(createElement(CodeWorkspace, {
        session,
        participantId: "test-participant",
        readOnly: false,
        terminalReadOnly: true,
      }));
      await Promise.resolve();
    });

    const runButton = container.querySelector<HTMLButtonElement>(
      ".code-run-command",
    );
    const terminalHost = container.querySelector<HTMLElement>('[role="textbox"]');
    const xterm = xtermMocks.instances.at(-1);
    expect(runButton?.disabled).toBe(true);
    expect(terminalHost?.getAttribute("aria-readonly")).toBe("true");
    expect((editorMocks.props.mock.lastCall?.[0] as {
      options?: { readOnly?: boolean };
    }).options?.readOnly).toBe(false);

    await act(async () => {
      terminalHost?.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
      xterm?.emitData("x");
      runButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });
    const dispatchedTypes = terminal.dispatch.mock.calls.map(
      ([action]) => action.type,
    );
    expect(dispatchedTypes).not.toContain("claim");
    expect(dispatchedTypes).not.toContain("edit-input");
    expect(dispatchedTypes).not.toContain("start-run");

    document.destroy();
  });

  it("uses the same shared xterm row for Python input requests", async () => {
    const document = new Y.Doc();
    initializeCodeWorkspace(document, "shared-bootstrap");
    const terminal = createTestTerminalBridge();
    const session: CodeWorkspaceSessionHandle = {
      document,
      origin: Object.freeze({ type: "local" }),
      blobStore: {
        put: vi.fn(async () => {
          throw new Error("not used");
        }),
        get: vi.fn(async () => null),
      },
      flush: vi.fn(async () => undefined),
      terminal: terminal.bridge,
    };
    let resolveCommand!: (value: ReturnType<typeof commandResult>) => void;
    const command = new Promise<ReturnType<typeof commandResult>>((resolve) => {
      resolveCommand = resolve;
    });
    const runtime = createPythonTerminalMock({
      executeEntrypoint: vi.fn(() => command),
    });
    terminalRunnerMocks.startPythonTerminal.mockReturnValue(runtime);
    container = documentOwner().createElement("div");
    documentOwner().body.append(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(createElement(CodeWorkspace, { session }));
      await Promise.resolve();
    });

    const runButton = [...container.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.classList.contains("code-run-command"));
    await act(async () => {
      runButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await vi.waitFor(() => expect(runtime.executeEntrypoint)
        .toHaveBeenCalledWith("main.py"));
    });
    const terminalOptions = terminalRunnerMocks.startPythonTerminal.mock.calls[0][1];
    await act(async () => {
      terminalOptions.onOutput({
        sessionId: "python-terminal-test",
        commandId: "command-1",
        chunk: "Name: ",
      });
      terminalOptions.onInputRequest({
        sessionId: "python-terminal-test",
        commandId: "command-1",
        requestId: "request-1",
      });
      await Promise.resolve();
    });
    const inputOrdering = terminal.dispatch.mock.calls
      .map(([action]) => action)
      .filter((action) => action.type === "host-output"
        || action.type === "host-input-request");
    expect(inputOrdering).toEqual([
      expect.objectContaining({ type: "host-output", chunk: "Name: " }),
      expect.objectContaining({ type: "host-input-request", requestId: "request-1" }),
    ]);
    expect(terminal.snapshot().mode).toBe("program-input");
    expect(container.querySelector(".code-console__output input")).toBeNull();

    const xterm = xtermMocks.instances.at(-1);
    await act(async () => {
      container?.querySelector('[role="textbox"]')?.dispatchEvent(
        new FocusEvent("focusin", { bubbles: true }),
      );
      await Promise.resolve();
    });
    await act(async () => {
      container?.querySelector<HTMLElement>('[role="textbox"]')?.dispatchEvent(
        new FocusEvent("focusin", { bubbles: true }),
      );
      await Promise.resolve();
    });
    await act(async () => {
      xterm?.emitData("Ada");
      xterm?.emitData("\r");
      await Promise.resolve();
    });
    expect(runtime.submitInput).toHaveBeenCalledWith("Ada");
    expect(terminal.snapshot().transcript).toContain("Name: Ada\n");
    await act(async () => {
      resolveCommand(commandResult());
      await command;
      await Promise.resolve();
    });
    document.destroy();
  });

  it("batches tiny Python output callbacks and flushes them before host-ready", async () => {
    const document = new Y.Doc();
    initializeCodeWorkspace(document, "output-batching");
    const terminal = createTestTerminalBridge();
    const flush = vi.fn(async () => undefined);
    const waitUntilSynchronized = vi.fn(async () => undefined);
    const session: CodeWorkspaceSessionHandle = {
      document,
      origin: Object.freeze({ type: "local" }),
      blobStore: {
        put: vi.fn(async () => {
          throw new Error("not used");
        }),
        get: vi.fn(async () => null),
      },
      flush,
      waitUntilSynchronized,
      terminal: terminal.bridge,
    };
    let resolveCommand!: (value: ReturnType<typeof commandResult> & {
      workspaceDelta: { version: 1; changes: readonly unknown[] };
    }) => void;
    const command = new Promise<Parameters<typeof resolveCommand>[0]>((resolve) => {
      resolveCommand = resolve;
    });
    const runtime = createPythonTerminalMock({
      executeEntrypoint: vi.fn(() => command),
    });
    terminalRunnerMocks.startPythonTerminal.mockReturnValue(runtime);
    container = documentOwner().createElement("div");
    documentOwner().body.append(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(createElement(CodeWorkspace, { session }));
      await Promise.resolve();
    });
    const runButton = [...container.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.classList.contains("code-run-command"));
    await act(async () => {
      runButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await vi.waitFor(() => expect(runtime.executeEntrypoint).toHaveBeenCalled());
    });

    const chunks = Array.from({ length: 2_000 }, (_, index) => (
      `${String(index).padStart(4, "0")}|${"x".repeat(35)}`
    ));
    const expectedOutput = chunks.join("");
    const terminalOptions = terminalRunnerMocks.startPythonTerminal.mock.calls[0][1];
    await act(async () => {
      for (const chunk of chunks.slice(0, 1_000)) {
        terminalOptions.onOutput({
          sessionId: "python-terminal-test",
          commandId: "command-1",
          chunk,
        });
      }
      await vi.waitFor(() => expect(terminal.dispatch.mock.calls
        .filter(([action]) => action.type === "host-output")).toHaveLength(1));
    });

    flush.mockClear();
    waitUntilSynchronized.mockClear();
    await act(async () => {
      for (const chunk of chunks.slice(1_000)) {
        terminalOptions.onOutput({
          sessionId: "python-terminal-test",
          commandId: "command-1",
          chunk,
        });
      }
      resolveCommand({
        ...commandResult(),
        output: expectedOutput,
        workspaceDelta: { version: 1, changes: [] },
      });
      await command;
      await Promise.resolve();
    });
    await vi.waitFor(() => expect(terminal.dispatch.mock.calls
      .some(([action]) => action.type === "host-ready")).toBe(true));

    const hostActions = terminal.dispatch.mock.calls
      .map(([action]) => action)
      .filter((action) => action.type === "host-output" || action.type === "host-ready");
    const outputActions = hostActions.filter((action) => action.type === "host-output");
    expect(outputActions).toHaveLength(2);
    expect(outputActions.every((action) => (
      action.type === "host-output"
      && action.chunk.length <= SHARED_TERMINAL_LIMITS.maxOutputChunkCodeUnits
    ))).toBe(true);
    expect(outputActions.map((action) => (
      action.type === "host-output" ? action.chunk : ""
    )).join("")).toBe(expectedOutput);
    expect(hostActions.at(-1)?.type).toBe("host-ready");
    expect(flush).toHaveBeenCalledOnce();
    expect(waitUntilSynchronized).toHaveBeenCalledOnce();
    const readyIndex = terminal.dispatch.mock.calls
      .map(([action]) => action.type)
      .lastIndexOf("host-ready");
    const readyCallOrder = terminal.dispatch.mock.invocationCallOrder[readyIndex]!;
    expect(flush.mock.invocationCallOrder.at(-1)).toBeLessThan(readyCallOrder);
    expect(waitUntilSynchronized.mock.invocationCallOrder.at(-1)).toBeLessThan(
      readyCallOrder,
    );
    document.destroy();
  });

  it("keeps sustained tiny output below the shared action rate limit", async () => {
    const document = new Y.Doc();
    initializeCodeWorkspace(document, "output-rate-limit");
    const terminal = createTestTerminalBridge();
    const session: CodeWorkspaceSessionHandle = {
      document,
      origin: Object.freeze({ type: "local" }),
      blobStore: {
        put: vi.fn(async () => {
          throw new Error("not used");
        }),
        get: vi.fn(async () => null),
      },
      flush: vi.fn(async () => undefined),
      terminal: terminal.bridge,
    };
    let resolveCommand!: (value: ReturnType<typeof commandResult> & {
      workspaceDelta: { version: 1; changes: readonly unknown[] };
    }) => void;
    const command = new Promise<Parameters<typeof resolveCommand>[0]>((resolve) => {
      resolveCommand = resolve;
    });
    const runtime = createPythonTerminalMock({
      executeEntrypoint: vi.fn(() => command),
    });
    terminalRunnerMocks.startPythonTerminal.mockReturnValue(runtime);
    container = documentOwner().createElement("div");
    documentOwner().body.append(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(createElement(CodeWorkspace, { session }));
      await Promise.resolve();
    });
    const runButton = [...container.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.classList.contains("code-run-command"));
    await act(async () => {
      runButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await vi.waitFor(() => expect(runtime.executeEntrypoint).toHaveBeenCalled());
    });

    vi.useFakeTimers();
    const terminalOptions = terminalRunnerMocks.startPythonTerminal.mock.calls[0][1];
    await act(async () => {
      for (let index = 0; index < 120; index += 1) {
        terminalOptions.onOutput({
          sessionId: "python-terminal-test",
          commandId: "command-1",
          chunk: "x",
        });
        await vi.advanceTimersByTimeAsync(10);
      }
    });
    const timedOutputActions = terminal.dispatch.mock.calls
      .map(([action]) => action)
      .filter((action) => action.type === "host-output");
    expect(timedOutputActions.map((action) => (
      action.type === "host-output" ? action.chunk : ""
    )).join("")).toBe("x".repeat(120));
    expect((timedOutputActions.length * 60_000) / 1_200).toBeLessThan(3_000);

    await act(async () => {
      resolveCommand({
        ...commandResult(),
        output: "x".repeat(120),
        workspaceDelta: { version: 1, changes: [] },
      });
      await command;
      await Promise.resolve();
    });
    vi.useRealTimers();
    document.destroy();
  });

  it("flushes pending output before host-failed and makes truncation explicit", async () => {
    const document = new Y.Doc();
    initializeCodeWorkspace(document, "failed-output-order");
    const terminal = createTestTerminalBridge();
    const session: CodeWorkspaceSessionHandle = {
      document,
      origin: Object.freeze({ type: "local" }),
      blobStore: {
        put: vi.fn(async () => {
          throw new Error("not used");
        }),
        get: vi.fn(async () => null),
      },
      flush: vi.fn(async () => undefined),
      terminal: terminal.bridge,
    };
    let resolveCommand!: (value: {
      commandId: string;
      status: "worker-error";
      output: string;
      truncated: true;
      mode: "closed";
      prompt: null;
    }) => void;
    const command = new Promise<Parameters<typeof resolveCommand>[0]>((resolve) => {
      resolveCommand = resolve;
    });
    const runtime = createPythonTerminalMock({
      executeEntrypoint: vi.fn(() => command),
    });
    terminalRunnerMocks.startPythonTerminal.mockReturnValue(runtime);
    container = documentOwner().createElement("div");
    documentOwner().body.append(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(createElement(CodeWorkspace, { session }));
      await Promise.resolve();
    });
    const runButton = [...container.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.classList.contains("code-run-command"));
    await act(async () => {
      runButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await vi.waitFor(() => expect(runtime.executeEntrypoint).toHaveBeenCalled());
    });
    const terminalOptions = terminalRunnerMocks.startPythonTerminal.mock.calls[0][1];
    await act(async () => {
      terminalOptions.onOutput({
        sessionId: "python-terminal-test",
        commandId: "command-1",
        chunk: "partial",
      });
      resolveCommand({
        commandId: "command-1",
        status: "worker-error",
        output: "partial",
        truncated: true,
        mode: "closed",
        prompt: null,
      });
      await command;
      await Promise.resolve();
    });
    await vi.waitFor(() => expect(terminal.dispatch.mock.calls
      .some(([action]) => action.type === "host-failed")).toBe(true));
    const ordered = terminal.dispatch.mock.calls
      .map(([action]) => action)
      .filter((action) => action.type === "host-output" || action.type === "host-failed");
    expect(ordered.map((action) => action.type)).toEqual([
      "host-output",
      "host-failed",
    ]);
    expect(ordered[0]).toMatchObject({
      type: "host-output",
      chunk: `partial${PYTHON_TERMINAL_OUTPUT_TRUNCATION_MARKER}`,
    });
    document.destroy();
  });

  it("cancels a run while the Python terminal is still starting", async () => {
    const document = new Y.Doc();
    initializeCodeWorkspace(document, "cancel-starting-runtime");
    const terminal = createTestTerminalBridge();
    const session: CodeWorkspaceSessionHandle = {
      document,
      origin: Object.freeze({ type: "local" }),
      blobStore: {
        put: vi.fn(async () => {
          throw new Error("not used");
        }),
        get: vi.fn(async () => null),
      },
      flush: vi.fn(async () => undefined),
      terminal: terminal.bridge,
    };
    let settleReady!: (value: {
      status: "cancelled";
      message: string;
    }) => void;
    const ready = new Promise<Parameters<typeof settleReady>[0]>((resolve) => {
      settleReady = resolve;
    });
    const executeEntrypoint = vi.fn();
    const close = vi.fn(() => settleReady({
      status: "cancelled",
      message: "Python terminal closed",
    }));
    const runtime = createPythonTerminalMock({
      ready,
      mode: vi.fn(() => "starting" as const),
      executeEntrypoint,
      close,
    });
    terminalRunnerMocks.startPythonTerminal.mockReturnValue(runtime);
    container = documentOwner().createElement("div");
    documentOwner().body.append(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(createElement(CodeWorkspace, { session }));
      await Promise.resolve();
    });
    const runButton = [...container.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.classList.contains("code-run-command"));
    await act(async () => {
      runButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await vi.waitFor(() => expect(terminalRunnerMocks.startPythonTerminal)
        .toHaveBeenCalledOnce());
    });
    expect(terminal.snapshot().mode).toBe("busy");

    await act(async () => {
      terminal.bridge.dispatch({ type: "interrupt", actionId: crypto.randomUUID() });
      await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
    });
    await vi.waitFor(() => expect(terminal.snapshot().mode).toBe("shell"));
    expect(executeEntrypoint).not.toHaveBeenCalled();
    expect(terminal.dispatch.mock.calls
      .some(([action]) => action.type === "host-failed")).toBe(true);
    document.destroy();
  });

  it("resets Ctrl-C in the shared Python REPL without closing the interpreter", async () => {
    const document = new Y.Doc();
    initializeCodeWorkspace(document, "python-repl-interrupt");
    const terminal = createTestTerminalBridge();
    const session: CodeWorkspaceSessionHandle = {
      document,
      origin: Object.freeze({ type: "local" }),
      blobStore: {
        put: vi.fn(async () => {
          throw new Error("not used");
        }),
        get: vi.fn(async () => null),
      },
      flush: vi.fn(async () => undefined),
      terminal: terminal.bridge,
    };
    let runtimeMode: "shell" | "repl" = "shell";
    let resolveLine!: (value: {
      commandId: string;
      status: "interrupted";
      output: string;
      truncated: false;
      mode: "repl";
      prompt: ">>> ";
    }) => void;
    const line = new Promise<Parameters<typeof resolveLine>[0]>((resolve) => {
      resolveLine = resolve;
    });
    const runtime = createPythonTerminalMock({
      mode: vi.fn(() => runtimeMode),
      startRepl: vi.fn(async () => {
        runtimeMode = "repl";
        return { ...commandResult(), mode: "repl" as const, prompt: ">>> " as const };
      }),
      submitReplLine: vi.fn(() => line),
      interruptRepl: vi.fn(async () => ({
        ...commandResult(),
        mode: "repl" as const,
        prompt: ">>> " as const,
      })),
    });
    terminalRunnerMocks.startPythonTerminal.mockReturnValue(runtime);
    container = documentOwner().createElement("div");
    documentOwner().body.append(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(createElement(CodeWorkspace, { session }));
      await Promise.resolve();
    });
    await act(async () => {
      terminal.bridge.dispatch({
        type: "submit-line",
        actionId: crypto.randomUUID(),
        value: "py",
      });
      await vi.waitFor(() => expect(runtime.startRepl).toHaveBeenCalledOnce());
    });
    await vi.waitFor(() => expect(terminal.snapshot().mode).toBe("python"));

    await act(async () => {
      terminal.bridge.dispatch({ type: "interrupt", actionId: crypto.randomUUID() });
      await vi.waitFor(() => expect(runtime.interruptRepl).toHaveBeenCalledOnce());
    });
    await vi.waitFor(() => expect(terminal.snapshot().mode).toBe("python"));
    expect(runtime.close).not.toHaveBeenCalled();

    await act(async () => {
      terminal.bridge.dispatch({
        type: "submit-line",
        actionId: crypto.randomUUID(),
        value: "while True:",
      });
      await vi.waitFor(() => expect(runtime.submitReplLine).toHaveBeenCalledOnce());
      terminal.bridge.dispatch({ type: "interrupt", actionId: crypto.randomUUID() });
      await vi.waitFor(() => expect(runtime.interrupt).toHaveBeenCalledOnce());
      resolveLine({
        commandId: "interrupted-repl-line",
        status: "interrupted",
        output: "",
        truncated: false,
        mode: "repl",
        prompt: ">>> ",
      });
      await line;
      await Promise.resolve();
    });
    await vi.waitFor(() => expect(runtime.interruptRepl).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(terminal.snapshot().mode).toBe("python"));
    expect(runtime.close).not.toHaveBeenCalled();
    expect(terminal.snapshot().transcript).toContain("KeyboardInterrupt");
    document.destroy();
  });

  it("applies and synchronizes the cumulative REPL delta before EOF becomes ready", async () => {
    const document = new Y.Doc();
    initializeCodeWorkspace(document, "repl-eof-delta");
    const terminal = createTestTerminalBridge();
    const flush = vi.fn(async () => undefined);
    const waitUntilSynchronized = vi.fn(async () => undefined);
    const session: CodeWorkspaceSessionHandle = {
      document,
      origin: Object.freeze({ type: "local" }),
      blobStore: {
        put: vi.fn(async () => {
          throw new Error("not used");
        }),
        get: vi.fn(async () => null),
      },
      flush,
      waitUntilSynchronized,
      terminal: terminal.bridge,
    };
    let runtimeMode: "shell" | "repl" = "shell";
    const runtime = createPythonTerminalMock({
      mode: vi.fn(() => runtimeMode),
      startRepl: vi.fn(async () => {
        runtimeMode = "repl";
        return {
          ...commandResult(),
          mode: "repl" as const,
          prompt: ">>> " as const,
          workspaceDelta: { version: 1, changes: [] },
        };
      }),
      exitRepl: vi.fn(async () => {
        runtimeMode = "shell";
        const workspace = terminalRunnerMocks.startPythonTerminal.mock.calls[0][0];
        return {
          ...commandResult(),
          workspaceDelta: {
            version: 1,
            changes: [{
              kind: "write" as const,
              path: "main.py",
              base: workspace.files[0].base,
              bytes: new TextEncoder().encode("print('from repl')\n"),
            }],
          },
        };
      }),
    });
    terminalRunnerMocks.startPythonTerminal.mockReturnValue(runtime);
    container = documentOwner().createElement("div");
    documentOwner().body.append(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(createElement(CodeWorkspace, { session }));
      await Promise.resolve();
    });

    await act(async () => {
      terminal.bridge.dispatch({ type: "claim", actionId: crypto.randomUUID() });
      terminal.bridge.dispatch({
        type: "submit-line",
        actionId: crypto.randomUUID(),
        value: "py",
      });
      await vi.waitFor(() => expect(runtime.startRepl).toHaveBeenCalledOnce());
    });
    await vi.waitFor(() => expect(terminal.snapshot().mode).toBe("python"));
    flush.mockClear();
    waitUntilSynchronized.mockClear();

    await act(async () => {
      terminal.bridge.dispatch({ type: "eof", actionId: crypto.randomUUID() });
      await vi.waitFor(() => expect(runtime.exitRepl).toHaveBeenCalledOnce());
    });
    await vi.waitFor(() => expect(terminal.snapshot().mode).toBe("shell"));
    expect(codeWorkspaceText(document, "main-py")?.toString())
      .toBe("print('from repl')\n");
    expect(flush).toHaveBeenCalledOnce();
    expect(waitUntilSynchronized).toHaveBeenCalledOnce();
    expect(runtime.close).toHaveBeenCalledOnce();
    const readyIndex = terminal.dispatch.mock.calls
      .map(([action]) => action.type)
      .lastIndexOf("host-ready");
    const readyCallOrder = terminal.dispatch.mock.invocationCallOrder[readyIndex]!;
    expect(flush.mock.invocationCallOrder[0]).toBeLessThan(readyCallOrder);
    expect(waitUntilSynchronized.mock.invocationCallOrder[0]).toBeLessThan(
      readyCallOrder,
    );
    expect(runtime.close.mock.invocationCallOrder[0]).toBeLessThan(readyCallOrder);
    document.destroy();
  });

  it("does not overwrite a concurrent edit and surfaces the file conflict", async () => {
    const document = new Y.Doc();
    initializeCodeWorkspace(document, "solo-bootstrap");
    const terminal = createTestTerminalBridge();
    const session: CodeWorkspaceSessionHandle = {
      document,
      origin: Object.freeze({ type: "local" }),
      blobStore: {
        put: vi.fn(async () => {
          throw new Error("not used");
        }),
        get: vi.fn(async () => null),
      },
      flush: vi.fn(async () => undefined),
      terminal: terminal.bridge,
    };
    let resolveRun!: (value: {
      commandId: string;
      status: "ok";
      output: string;
      truncated: false;
      mode: "shell";
      prompt: null;
      workspaceDelta: {
        version: 1;
        changes: readonly unknown[];
      };
    }) => void;
    const result = new Promise<Parameters<typeof resolveRun>[0]>((resolve) => {
      resolveRun = resolve;
    });
    const runtime = createPythonTerminalMock({
      executeEntrypoint: vi.fn(() => result),
    });
    terminalRunnerMocks.startPythonTerminal.mockReturnValue(runtime);
    container = documentOwner().createElement("div");
    documentOwner().body.append(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(createElement(CodeWorkspace, { session }));
      await Promise.resolve();
    });
    const runButton = [...container.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.classList.contains("code-run-command"));
    await act(async () => {
      runButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await vi.waitFor(() => expect(runtime.executeEntrypoint).toHaveBeenCalled());
    });
    const workspace = terminalRunnerMocks.startPythonTerminal.mock.calls[0][0];
    await act(async () => {
      replaceCodeWorkspaceText(
        document,
        "main-py",
        "# concurrent\n",
        "peer",
      );
      resolveRun({
        commandId: "conflict-run",
        status: "ok",
        output: "",
        truncated: false,
        mode: "shell",
        prompt: null,
        workspaceDelta: {
          version: 1,
          changes: [{
            kind: "write",
            path: "main.py",
            base: workspace.files[0].base,
            bytes: new TextEncoder().encode("# runner\n"),
          }],
        },
      });
      await result;
      await Promise.resolve();
    });

    expect(codeWorkspaceText(document, "main-py")?.toString())
      .toBe("# concurrent\n");
    expect(container.querySelector('[role="alert"]')?.textContent)
      .toContain("не применены");
    document.destroy();
  });

  it("does not apply terminal filesystem writes after becoming read-only", async () => {
    const document = new Y.Doc();
    initializeCodeWorkspace(document, "solo-bootstrap");
    const original = codeWorkspaceText(document, "main-py")?.toString();
    const terminal = createTestTerminalBridge();
    const session: CodeWorkspaceSessionHandle = {
      document,
      origin: Object.freeze({ type: "local" }),
      blobStore: {
        put: vi.fn(async () => {
          throw new Error("not used");
        }),
        get: vi.fn(async () => null),
      },
      flush: vi.fn(async () => undefined),
      terminal: terminal.bridge,
    };
    let resolveRun!: (value: ReturnType<typeof commandResult> & {
      workspaceDelta: {
        version: 1;
        changes: readonly unknown[];
      };
    }) => void;
    const result = new Promise<Parameters<typeof resolveRun>[0]>((resolve) => {
      resolveRun = resolve;
    });
    const runtime = createPythonTerminalMock({
      executeEntrypoint: vi.fn(() => result),
    });
    terminalRunnerMocks.startPythonTerminal.mockReturnValue(runtime);
    container = documentOwner().createElement("div");
    documentOwner().body.append(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(createElement(CodeWorkspace, { session }));
      await Promise.resolve();
    });
    const runButton = [...container.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.classList.contains("code-run-command"));
    await act(async () => {
      runButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await vi.waitFor(() => expect(runtime.executeEntrypoint).toHaveBeenCalled());
    });
    const workspace = terminalRunnerMocks.startPythonTerminal.mock.calls[0][0];

    await act(async () => {
      root?.render(createElement(CodeWorkspace, { session, readOnly: true }));
      await Promise.resolve();
    });
    expect(runtime.close).toHaveBeenCalled();

    await act(async () => {
      resolveRun({
        ...commandResult(),
        workspaceDelta: {
          version: 1,
          changes: [{
            kind: "write",
            path: "main.py",
            base: workspace.files[0].base,
            bytes: new TextEncoder().encode("print('must not apply')\n"),
          }],
        },
      });
      await result;
      await Promise.resolve();
    });

    expect(codeWorkspaceText(document, "main-py")?.toString()).toBe(original);
    document.destroy();
  });

  it("drops terminal filesystem writes from an execution predating reconnect", async () => {
    const document = new Y.Doc();
    initializeCodeWorkspace(document, "terminal-reconnect-epoch");
    const original = codeWorkspaceText(document, "main-py")?.toString();
    const terminal = createTestTerminalBridge();
    const session: CodeWorkspaceSessionHandle = {
      document,
      origin: Object.freeze({ type: "local" }),
      blobStore: {
        put: vi.fn(async () => {
          throw new Error("not used");
        }),
        get: vi.fn(async () => null),
      },
      flush: vi.fn(async () => undefined),
      terminal: terminal.bridge,
    };
    let resolveRun!: (value: ReturnType<typeof commandResult> & {
      workspaceDelta: {
        version: 1;
        changes: readonly unknown[];
      };
    }) => void;
    const result = new Promise<Parameters<typeof resolveRun>[0]>((resolve) => {
      resolveRun = resolve;
    });
    const runtime = createPythonTerminalMock({
      executeEntrypoint: vi.fn(() => result),
    });
    terminalRunnerMocks.startPythonTerminal.mockReturnValue(runtime);
    container = documentOwner().createElement("div");
    documentOwner().body.append(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(createElement(CodeWorkspace, {
        session,
        participantId: "test-participant",
        terminalReadOnly: false,
        terminalConnectionEpoch: 0,
      }));
      await Promise.resolve();
    });
    const runButton = container.querySelector<HTMLButtonElement>(
      ".code-run-command",
    );
    await act(async () => {
      runButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await vi.waitFor(() => expect(runtime.executeEntrypoint).toHaveBeenCalled());
    });
    const workspace = terminalRunnerMocks.startPythonTerminal.mock.calls[0][0];

    await act(async () => {
      root?.render(createElement(CodeWorkspace, {
        session,
        participantId: "test-participant",
        terminalReadOnly: true,
        terminalConnectionEpoch: 1,
      }));
      await Promise.resolve();
      root?.render(createElement(CodeWorkspace, {
        session,
        participantId: "test-participant",
        terminalReadOnly: false,
        terminalConnectionEpoch: 2,
      }));
      await Promise.resolve();
    });
    expect(runtime.close).toHaveBeenCalled();

    await act(async () => {
      resolveRun({
        ...commandResult(),
        workspaceDelta: {
          version: 1,
          changes: [{
            kind: "write",
            path: "main.py",
            base: workspace.files[0].base,
            bytes: new TextEncoder().encode("print('stale run')\n"),
          }],
        },
      });
      await result;
      await Promise.resolve();
    });

    expect(codeWorkspaceText(document, "main-py")?.toString()).toBe(original);
    document.destroy();
  });

  it("rejects binary terminal writes when the lesson has no durable blob channel", async () => {
    const document = new Y.Doc();
    initializeCodeWorkspace(document, "lesson-text-only-terminal");
    const terminal = createTestTerminalBridge();
    const put = vi.fn(async () => ({
      sha256: "0".repeat(64),
      byteSize: 3,
      mimeType: "application/octet-stream",
    }));
    const session: CodeWorkspaceSessionHandle = {
      document,
      origin: Object.freeze({ type: "local" }),
      blobStore: { put, get: vi.fn(async () => null) },
      flush: vi.fn(async () => undefined),
      terminal: terminal.bridge,
      allowBinaryUploads: false,
    };
    const runtime = createPythonTerminalMock({
      executeEntrypoint: vi.fn(async () => ({
        ...commandResult(),
        workspaceDelta: {
          version: 1 as const,
          changes: [{
            kind: "write" as const,
            path: "artifact.bin",
            base: null,
            bytes: Uint8Array.of(0xff, 0x00, 0xfe),
          }],
        },
      })),
    });
    terminalRunnerMocks.startPythonTerminal.mockReturnValue(runtime);
    container = documentOwner().createElement("div");
    documentOwner().body.append(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(createElement(CodeWorkspace, { session }));
      await Promise.resolve();
    });
    const runButton = container.querySelector<HTMLButtonElement>(
      ".code-run-command",
    );
    await act(async () => {
      runButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await vi.waitFor(() => expect(runtime.executeEntrypoint).toHaveBeenCalled());
    });
    await vi.waitFor(() => expect(terminal.snapshot().mode).toBe("shell"));

    expect(put).not.toHaveBeenCalled();
    expect(listCodeWorkspaceEntries(document)
      .some((entry) => entry.name === "artifact.bin")).toBe(false);
    expect(terminal.snapshot().transcript).toContain("Бинарные изменения");
    document.destroy();
  });

  it("executes a run only through the host effect assigned by shared terminal state", async () => {
    const document = new Y.Doc();
    initializeCodeWorkspace(document, "solo-bootstrap");
    const terminal = createTestTerminalBridge();
    const session: CodeWorkspaceSessionHandle = {
      document,
      origin: Object.freeze({ type: "local" }),
      blobStore: {
        put: vi.fn(async () => {
          throw new Error("not used");
        }),
        get: vi.fn(async () => null),
      },
      flush: vi.fn(async () => undefined),
      terminal: terminal.bridge,
    };
    const runtime = createPythonTerminalMock();
    terminalRunnerMocks.startPythonTerminal.mockReturnValue(runtime);
    container = documentOwner().createElement("div");
    documentOwner().body.append(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(createElement(CodeWorkspace, { session }));
      await Promise.resolve();
    });

    expect(terminalRunnerMocks.startPythonTerminal).not.toHaveBeenCalled();
    const runButton = [...container.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.classList.contains("code-run-command"));
    await act(async () => {
      runButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await vi.waitFor(() => expect(runtime.executeEntrypoint)
        .toHaveBeenCalledWith("main.py"));
    });

    expect(terminal.dispatch).toHaveBeenCalledWith(expect.objectContaining({
      type: "start-run",
      entryId: "main-py",
      entrypoint: "main.py",
    }));
    await vi.waitFor(() => expect(terminal.snapshot().mode).toBe("shell"));
    document.destroy();
  });

  it("coalesces Run and Test clicks while document synchronization is pending", async () => {
    const document = new Y.Doc();
    initializeCodeWorkspace(document, "run-request-lock");
    addCodeTestCase(document, {
      id: "pending-test",
      name: "Pending",
    }, "run-request-lock");
    const terminal = createTestTerminalBridge();
    let resolveSynchronization!: () => void;
    const synchronization = new Promise<void>((resolve) => {
      resolveSynchronization = resolve;
    });
    const waitUntilSynchronized = vi.fn(() => synchronization);
    const session: CodeWorkspaceSessionHandle = {
      document,
      origin: Object.freeze({ type: "local" }),
      blobStore: {
        put: vi.fn(async () => {
          throw new Error("not used");
        }),
        get: vi.fn(async () => null),
      },
      flush: vi.fn(async () => undefined),
      terminal: terminal.bridge,
      waitUntilSynchronized,
    };
    terminalRunnerMocks.startPythonTerminal.mockReturnValue(
      createPythonTerminalMock(),
    );
    container = documentOwner().createElement("div");
    documentOwner().body.append(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(createElement(CodeWorkspace, { session }));
      await Promise.resolve();
    });

    const runButton = container.querySelector<HTMLButtonElement>(
      ".code-run-command",
    );
    const testsToggle = [...container.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent?.includes("Тесты"));
    await act(async () => {
      testsToggle?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    const testButton = [...container.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent?.includes("Проверить"));

    await act(async () => {
      runButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      runButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      testButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });
    expect(waitUntilSynchronized).toHaveBeenCalledOnce();
    expect(runButton?.disabled).toBe(true);
    expect(testButton?.disabled).toBe(true);
    expect(terminal.dispatch).not.toHaveBeenCalledWith(expect.objectContaining({
      type: "start-run",
    }));

    await act(async () => {
      resolveSynchronization();
      await synchronization;
      await Promise.resolve();
    });
    expect(terminal.dispatch.mock.calls
      .filter(([action]) => action.type === "start-run")).toHaveLength(1);
    expect(terminal.dispatch).toHaveBeenCalledWith(expect.objectContaining({
      type: "start-run",
      entryId: "main-py",
      entrypoint: "main.py",
    }));
    document.destroy();
  });

  it("stores a bounded test timeout and passes it only to Test runs", async () => {
    const document = new Y.Doc();
    initializeCodeWorkspace(document, "solo-bootstrap");
    const terminal = createTestTerminalBridge();
    addCodeTestCase(document, {
      id: "timed-test",
      name: "Timed",
      timeoutMs: 1_250,
    }, "solo-bootstrap");
    const session: CodeWorkspaceSessionHandle = {
      document,
      origin: Object.freeze({ type: "local" }),
      blobStore: {
        put: vi.fn(async () => {
          throw new Error("not used");
        }),
        get: vi.fn(async () => null),
      },
      flush: vi.fn(async () => undefined),
      terminal: terminal.bridge,
    };
    runnerMocks.startPythonRun.mockReturnValue({
      runId: "timed-run",
      result: Promise.resolve({
        runId: "timed-run",
        status: "ok",
        output: "",
        truncated: false,
      }),
      cancel: vi.fn(),
    });
    container = documentOwner().createElement("div");
    documentOwner().body.append(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(createElement(CodeWorkspace, { session }));
      await Promise.resolve();
    });
    expect(container.querySelector('[aria-label="Лимит теста, мс"]')).toBeNull();
    const testsToggle = container.querySelector<HTMLButtonElement>(
      'button[aria-controls="code-tests-panel"]',
    );
    await act(async () => {
      testsToggle?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });
    const timeout = container.querySelector<HTMLInputElement>(
      'input[aria-label="Лимит теста, мс"]',
    );
    const title = container.querySelector<HTMLInputElement>(
      'input[aria-label="Название теста"]',
    );
    const labels = [...container.querySelectorAll<HTMLLabelElement>(
      ".code-test__meta label",
    )];
    expect(labels.map((label) => label.textContent)).toEqual(["Title:", "Timeout:"]);
    expect(labels[0]?.htmlFor).toBe(title?.id);
    expect(labels[1]?.htmlFor).toBe(timeout?.id);
    expect(title?.closest(".code-test__field--title")).not.toBeNull();
    expect(timeout?.closest(".code-test__field--timeout")).not.toBeNull();
    expect(timeout?.value).toBe("1250");
    expect(timeout?.type).toBe("text");
    expect(timeout?.inputMode).toBe("numeric");
    timeout?.setSelectionRange(1, 3);
    expect(timeout?.selectionStart).toBe(1);
    expect(timeout?.selectionEnd).toBe(3);
    await act(async () => {
      if (timeout) timeout.value = "2000";
      timeout?.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    });
    const testButton = [...container.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent?.includes("Проверить"));
    await act(async () => {
      testButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await vi.waitFor(() => expect(runnerMocks.startPythonRun).toHaveBeenCalled());
    });

    expect(runnerMocks.startPythonRun).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "workspace" }),
      { timeoutMs: 2_000 },
    );
    document.destroy();
  });

  it("shows only a create action before the first test exists", async () => {
    const document = new Y.Doc();
    initializeCodeWorkspace(document, "solo-bootstrap");
    const session: CodeWorkspaceSessionHandle = {
      document,
      origin: Object.freeze({ type: "local" }),
      blobStore: {
        put: vi.fn(async () => {
          throw new Error("not used");
        }),
        get: vi.fn(async () => null),
      },
      flush: vi.fn(async () => undefined),
    };
    container = documentOwner().createElement("div");
    documentOwner().body.append(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(createElement(CodeWorkspace, { session }));
      await Promise.resolve();
    });
    const testsToggle = container.querySelector<HTMLButtonElement>(
      'button[aria-controls="code-tests-panel"]',
    );
    await act(async () => {
      testsToggle?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });

    expect(container.querySelector('[role="tablist"]')).toBeNull();
    expect(container.querySelector('[aria-label="Название теста"]')).toBeNull();
    expect(container.querySelector('[aria-label="Лимит теста, мс"]')).toBeNull();
    const createTest = [...container.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent?.includes("Создать тест"));
    expect(createTest).toBeTruthy();

    await act(async () => {
      createTest?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await vi.waitFor(() => expect(codeWorkspaceTestCases(document).size).toBe(1));
    });
    expect(container.querySelector('[aria-label="Название теста"]')).not.toBeNull();

    const removeTest = container.querySelector<HTMLButtonElement>(
      '[aria-label="Удалить тест"]',
    );
    await act(async () => {
      removeTest?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await vi.waitFor(() => expect(codeWorkspaceTestCases(document).size).toBe(0));
    });
    expect(container.querySelector('[aria-label="Название теста"]')).toBeNull();
    expect([...container.querySelectorAll<HTMLButtonElement>("button")]
      .some((button) => button.textContent?.includes("Создать тест"))).toBe(true);
    document.destroy();
  });

  it("applies a remote character without rerendering the workspace or controlling Monaco", async () => {
    const document = new Y.Doc();
    initializeCodeWorkspace(document, "solo-bootstrap");
    const unrelatedId = addCodeWorkspaceEntry(document, {
      id: "unrelated-py",
      kind: "file",
      name: "unrelated.py",
      text: "print('unrelated')\n",
    }, "solo-bootstrap");
    const testId = addCodeTestCase(document, {
      id: "remote-text-test",
      name: "Remote text",
      stdin: "input",
    }, "solo-bootstrap");
    const unrelatedText = codeWorkspaceText(document, unrelatedId);
    expect(unrelatedText).not.toBeNull();
    const testStdin = codeWorkspaceTestCases(document).get(testId)?.get("stdin");
    expect(testStdin).toBeInstanceOf(Y.Text);
    const unrelatedToString = vi.spyOn(
      unrelatedText as unknown as { toString(): string },
      "toString",
    );
    const session: CodeWorkspaceSessionHandle = {
      document,
      origin: Object.freeze({ type: "local" }),
      blobStore: {
        put: vi.fn(async () => {
          throw new Error("not used");
        }),
        get: vi.fn(async () => null),
      },
      flush: vi.fn(async () => undefined),
    };
    container = documentOwner().createElement("div");
    documentOwner().body.append(container);
    root = createRoot(container);

    await act(async () => {
      root?.render(createElement(CodeWorkspace, { session }));
      await Promise.resolve();
    });
    const mountedEditor = editorMocks.instances[0];
    expect(mountedEditor).toBeDefined();
    const activeText = codeWorkspaceText(document, "main-py");
    expect(activeText).not.toBeNull();
    const initialEditorValue = mountedEditor?.model.getValue() as string;
    unrelatedToString.mockClear();
    editorMocks.props.mockClear();

    await act(async () => {
      document.transact(() => {
        activeText?.insert(activeText.length, "#");
      }, "remote-test-origin");
    });

    expect(unrelatedToString).not.toHaveBeenCalled();
    expect(editorMocks.props).not.toHaveBeenCalled();
    expect(editorMocks.instances).toHaveLength(1);
    expect(mountedEditor?.model.getValue()).toBe(`${initialEditorValue}#`);
    expect(container.querySelector('[data-testid="monaco"]')
      ?.getAttribute("data-controlled-value")).toBeNull();

    editorMocks.props.mockClear();
    await act(async () => {
      document.transact(() => {
        if (testStdin instanceof Y.Text) testStdin.insert(testStdin.length, "!");
      }, "remote-test-origin");
    });
    expect(editorMocks.props).not.toHaveBeenCalled();
    document.destroy();
  });

  it("clears an owned Monaco cursor when the active text disappears remotely", async () => {
    const document = new Y.Doc();
    initializeCodeWorkspace(document, "solo-bootstrap");
    const setAwareness = vi.fn();
    const session: CodeWorkspaceSessionHandle = {
      document,
      origin: Object.freeze({ type: "local" }),
      blobStore: {
        put: vi.fn(async () => {
          throw new Error("not used");
        }),
        get: vi.fn(async () => null),
      },
      flush: vi.fn(async () => undefined),
      awareness: {
        setAwareness,
        subscribeAwareness: () => () => undefined,
      },
    };
    container = documentOwner().createElement("div");
    documentOwner().body.append(container);
    root = createRoot(container);

    await act(async () => {
      root?.render(createElement(CodeWorkspace, { session }));
      await Promise.resolve();
    });
    const mountedEditor = editorMocks.instances[0]?.editor;
    expect(mountedEditor).toBeDefined();
    await act(async () => mountedEditor?.setTextFocus(true));
    expect(setAwareness).toHaveBeenLastCalledWith(expect.objectContaining({
      target: { kind: "file", entryId: "main-py", field: "text" },
    }));

    await act(async () => {
      removeCodeWorkspaceEntry(document, "main-py", "remote-delete");
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    });

    expect(setAwareness).toHaveBeenLastCalledWith(null);
    document.destroy();
  });
});

function documentOwner(): Document {
  return globalThis.document;
}

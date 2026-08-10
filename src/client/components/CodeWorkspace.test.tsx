// @vitest-environment jsdom

import { webcrypto } from "node:crypto";
import { act, createElement } from "react";
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
  replaceCodeWorkspaceText,
} from "../../code/core/index.js";
import type { CodeWorkspaceSessionHandle } from "./CodeWorkspace.js";

if (!globalThis.crypto.subtle) {
  Object.defineProperty(globalThis.crypto, "subtle", {
    configurable: true,
    value: webcrypto.subtle,
  });
}

const runnerMocks = vi.hoisted(() => ({
  startPythonRun: vi.fn(),
}));
const editorMocks = vi.hoisted(() => ({
  props: vi.fn(),
  setTheme: vi.fn(),
}));

vi.mock("@monaco-editor/react", () => ({
  default: (props: {
    value?: string;
    theme?: string;
    onMount?: (editor: unknown, monaco: unknown) => void;
  }) => {
    editorMocks.props(props);
    props.onMount?.({
      addCommand: vi.fn(),
      createDecorationsCollection: () => ({ clear: vi.fn(), set: vi.fn() }),
      getModel: () => null,
      getPosition: () => null,
      getSelection: () => null,
      onDidChangeCursorSelection: () => ({ dispose: vi.fn() }),
    }, {
      editor: { setTheme: editorMocks.setTheme },
      KeyCode: { KeyY: 2, KeyZ: 1 },
      KeyMod: { CtrlCmd: 1, Shift: 2 },
    });
    return createElement("div", {
      "data-testid": "monaco",
      "data-value": props.value,
    });
  },
}));

vi.mock("../pythonRunner", async (importOriginal) => ({
  ...await importOriginal<typeof import("../pythonRunner")>(),
  startPythonRun: runnerMocks.startPythonRun,
}));

import { CodeWorkspace } from "./CodeWorkspace.js";
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
  editorMocks.props.mockReset();
  editorMocks.setTheme.mockReset();
  window.localStorage.clear();
});

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

  it("requests ordinary terminal input only while Python is waiting", async () => {
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
    let resolveRun!: (value: {
      runId: string;
      status: "ok";
      output: string;
      truncated: false;
    }) => void;
    const result = new Promise<Parameters<typeof resolveRun>[0]>((resolve) => {
      resolveRun = resolve;
    });
    const submitInput = vi.fn(() => true);
    runnerMocks.startPythonRun.mockReturnValue({
      runId: "stdin-run",
      result,
      submitInput,
      sendEof: vi.fn(),
      cancel: vi.fn(),
    });
    container = documentOwner().createElement("div");
    documentOwner().body.append(container);
    root = createRoot(container);

    await act(async () => {
      root?.render(createElement(CodeWorkspace, { session }));
      await Promise.resolve();
    });
    expect(container.querySelector('[aria-label="Ввод программы"]')).toBeNull();
    expect(container.querySelector('[aria-label="Ввод в терминал"]')).toBeNull();
    const runButton = [...container.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent?.includes("Запустить"));
    expect(runButton).toBeDefined();
    await act(async () => {
      runButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await vi.waitFor(() => expect(runnerMocks.startPythonRun).toHaveBeenCalled());
    });

    expect(runnerMocks.startPythonRun).toHaveBeenCalledWith(expect.objectContaining({
      kind: "workspace",
      entrypoint: "main.py",
      stdin: null,
    }), expect.objectContaining({
      onOutput: expect.any(Function),
      onInputRequest: expect.any(Function),
    }));
    const options = runnerMocks.startPythonRun.mock.calls[0][1];
    await act(async () => {
      options.onOutput("Name: ");
      options.onInputRequest({ runId: "stdin-run", requestId: "request-1" });
      await Promise.resolve();
    });
    const stdin = container.querySelector<HTMLInputElement>(
      'input[aria-label="Ввод в терминал"]',
    );
    expect(stdin).not.toBeNull();
    await act(async () => {
      const setValue = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )?.set;
      setValue?.call(stdin, "alpha beta");
      stdin?.dispatchEvent(new Event("input", { bubbles: true }));
      await Promise.resolve();
    });
    await act(async () => {
      stdin?.form?.dispatchEvent(new Event("submit", {
        bubbles: true,
        cancelable: true,
      }));
      await Promise.resolve();
    });
    expect(submitInput).toHaveBeenCalledWith("alpha beta");
    expect(container.querySelector('[aria-label="Ввод в терминал"]')).toBeNull();
    await act(async () => {
      resolveRun({
        runId: "stdin-run",
        status: "ok",
        output: "Name: Done\n",
        truncated: false,
      });
      await result;
      await Promise.resolve();
    });
    expect(container.querySelector('[aria-label="Вывод программы"]')?.textContent)
      .toBe("Name: alpha beta\nDone\n");
    document.destroy();
  });

  it("shares a terminal request and submitted line with remote participants", async () => {
    const document = new Y.Doc();
    initializeCodeWorkspace(document, "shared-bootstrap");
    let awarenessListener: ((peers: readonly {
      participant: { participantId: string; displayName: string; color: string };
      state: {
        terminal?:
          | { kind: "host"; runId: string; requestId: string }
          | {
              kind: "input";
              runId: string;
              requestId: string;
              submissionId: string;
              value: string;
            };
      };
    }[]) => void) | null = null;
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
      awareness: {
        setAwareness,
        subscribeAwareness: (listener) => {
          awarenessListener = listener;
          listener([]);
          return () => undefined;
        },
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

    const host = {
      participant: {
        participantId: "host-1",
        displayName: "Host",
        color: "#336699",
      },
      state: {
        terminal: {
          kind: "host" as const,
          runId: "shared-run",
          requestId: "request-1",
        },
      },
    };
    await act(async () => {
      awarenessListener?.([host]);
      await Promise.resolve();
    });
    const input = container.querySelector<HTMLInputElement>(
      'input[aria-label="Ввод в терминал"]',
    );
    expect(input).not.toBeNull();
    expect(container.querySelector('[aria-label="Вывод программы"]')?.textContent)
      .toBe("");
    await act(async () => {
      const setValue = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )?.set;
      setValue?.call(input, "Ada");
      input?.dispatchEvent(new Event("input", { bubbles: true }));
      await Promise.resolve();
    });
    await act(async () => {
      input?.form?.dispatchEvent(new Event("submit", {
        bubbles: true,
        cancelable: true,
      }));
      await Promise.resolve();
    });
    expect(setAwareness).toHaveBeenLastCalledWith({
      terminal: expect.objectContaining({
        kind: "input",
        runId: "shared-run",
        requestId: "request-1",
        value: "Ada",
      }),
    });
    expect(container.querySelector('[aria-label="Вывод программы"]')?.textContent)
      .toBe("Ada\n");

    await act(async () => {
      awarenessListener?.([
        host,
        {
          participant: {
            participantId: "peer-2",
            displayName: "Peer",
            color: "#663399",
          },
          state: {
            terminal: {
              kind: "input" as const,
              runId: "shared-run",
              requestId: "request-1",
              submissionId: "peer-submission",
              value: "Grace",
            },
          },
        },
      ]);
      await Promise.resolve();
    });
    expect(container.querySelector('[aria-label="Вывод программы"]')?.textContent)
      .toBe("Ada\nGrace\n");
    document.destroy();
  });

  it("does not overwrite a concurrent edit and surfaces the file conflict", async () => {
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
    let resolveRun!: (value: {
      runId: string;
      status: "ok";
      output: string;
      truncated: false;
      workspaceDelta: {
        version: 1;
        changes: readonly unknown[];
      };
    }) => void;
    const result = new Promise<Parameters<typeof resolveRun>[0]>((resolve) => {
      resolveRun = resolve;
    });
    runnerMocks.startPythonRun.mockReturnValue({
      runId: "conflict-run",
      result,
      cancel: vi.fn(),
    });
    container = documentOwner().createElement("div");
    documentOwner().body.append(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(createElement(CodeWorkspace, { session }));
      await Promise.resolve();
    });
    const runButton = [...container.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent?.includes("Запустить"));
    await act(async () => {
      runButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await vi.waitFor(() => expect(runnerMocks.startPythonRun).toHaveBeenCalled());
    });
    const payload = runnerMocks.startPythonRun.mock.calls[0][0];
    if (payload.kind !== "workspace") throw new Error("Expected workspace run");
    await act(async () => {
      replaceCodeWorkspaceText(
        document,
        "main-py",
        "# concurrent\n",
        "peer",
      );
      resolveRun({
        runId: "conflict-run",
        status: "ok",
        output: "",
        truncated: false,
        workspaceDelta: {
          version: 1,
          changes: [{
            kind: "write",
            path: "main.py",
            base: payload.files[0].base,
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
      .toContain("main.py");
    document.destroy();
  });

  it("applies runtime-error file writes for Run but never for Test", async () => {
    const document = new Y.Doc();
    initializeCodeWorkspace(document, "solo-bootstrap");
    addCodeTestCase(document, {
      id: "runtime-test",
      name: "Runtime",
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
    };
    runnerMocks.startPythonRun.mockImplementation((payload, options) => {
      if (payload.kind !== "workspace") throw new Error("Expected workspace run");
      const asTest = payload.stdin !== null;
      return {
        runId: asTest ? "test-error-run" : "ordinary-error-run",
        result: Promise.resolve({
          runId: asTest ? "test-error-run" : "ordinary-error-run",
          status: "runtime-error",
          output: "boom",
          truncated: false,
          workspaceDelta: {
            version: 1,
            changes: [{
              kind: "write",
              path: "main.py",
              base: payload.files[0].base,
              bytes: new TextEncoder().encode(
                asTest ? "# test must not persist\n" : "# written before error\n",
              ),
            }],
          },
        }),
        cancel: vi.fn(),
      };
    });
    container = documentOwner().createElement("div");
    documentOwner().body.append(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(createElement(CodeWorkspace, { session }));
      await Promise.resolve();
    });
    const runButton = [...container.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent?.includes("Запустить"));
    await act(async () => {
      runButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await vi.waitFor(() => expect(codeWorkspaceText(document, "main-py")?.toString())
        .toBe("# written before error\n"));
    });
    const testsToggle = container.querySelector<HTMLButtonElement>(
      'button[aria-controls="code-tests-panel"]',
    );
    await act(async () => {
      testsToggle?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });
    const testButton = [...container.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent?.includes("Проверить"));
    await act(async () => {
      testButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await vi.waitFor(() => expect(runnerMocks.startPythonRun).toHaveBeenCalledTimes(2));
    });

    expect(codeWorkspaceText(document, "main-py")?.toString())
      .toBe("# written before error\n");
    document.destroy();
  });

  it("stores a bounded test timeout and passes it only to Test runs", async () => {
    const document = new Y.Doc();
    initializeCodeWorkspace(document, "solo-bootstrap");
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
    expect(timeout?.value).toBe("1250");
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

  it("does not materialize unrelated file text for an active-file edit", async () => {
    const document = new Y.Doc();
    initializeCodeWorkspace(document, "solo-bootstrap");
    const unrelatedId = addCodeWorkspaceEntry(document, {
      id: "unrelated-py",
      kind: "file",
      name: "unrelated.py",
      text: "print('unrelated')\n",
    }, "solo-bootstrap");
    const unrelatedText = codeWorkspaceText(document, unrelatedId);
    expect(unrelatedText).not.toBeNull();
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
    unrelatedToString.mockClear();

    await act(async () => {
      replaceCodeWorkspaceText(
        document,
        "main-py",
        "print('changed')\n",
        session.origin,
      );
    });

    expect(unrelatedToString).not.toHaveBeenCalled();
    expect(container.querySelector<HTMLElement>('[data-testid="monaco"]')
      ?.dataset.value).toBe("print('changed')\n");
    document.destroy();
  });
});

function documentOwner(): Document {
  return globalThis.document;
}

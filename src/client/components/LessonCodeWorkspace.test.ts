// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const editorProps = vi.fn();
const monacoSetTheme = vi.fn();
type EditorMount = (
  editor: unknown,
  monaco: { editor: { setTheme: typeof monacoSetTheme } },
) => void;
let autoMountEditor = true;
let pendingEditorMount: EditorMount | undefined;

vi.mock("@monaco-editor/react", () => ({
  default: (props: {
    language: string;
    value: string;
    theme: string;
    onChange(value: string): void;
    onMount?: EditorMount;
  }) => {
    editorProps(props);
    if (autoMountEditor) {
      props.onMount?.({}, { editor: { setTheme: monacoSetTheme } });
    } else if (!pendingEditorMount) {
      pendingEditorMount = props.onMount;
    }
    return createElement("textarea", {
      "aria-label": "Редактор Python",
      value: props.value,
      onChange: (event: { currentTarget: { value: string } }) =>
        props.onChange(event.currentTarget.value),
    });
  },
}));

import { LessonCodeWorkspace } from "./LessonCodeWorkspace";
import { THEME_STORAGE_KEY, ThemeProvider } from "../theme";
import {
  PYTHON_RUNNER_PROTOCOL_VERSION,
  PYTHON_RUNNER_REQUEST_TYPE,
  PYTHON_RUNNER_RESULT_TYPE,
  PYTHON_RUNNER_WORKER_URL,
  type PythonRunnerRequest,
} from "../pythonRunner";

interface WorkerListener {
  (event: MessageEvent<unknown>): void;
}

class PythonWorker {
  static instances: PythonWorker[] = [];

  readonly url: string;
  readonly listeners = new Set<WorkerListener>();
  readonly postMessage = vi.fn((message: PythonRunnerRequest) => {
    const event = {
      data: {
        type: PYTHON_RUNNER_RESULT_TYPE,
        protocolVersion: PYTHON_RUNNER_PROTOCOL_VERSION,
        runId: message.runId,
        status: "ok",
        output: "42",
        truncated: false,
      },
    } as MessageEvent<unknown>;
    queueMicrotask(() => {
      for (const listener of this.listeners) listener(event);
    });
  });
  readonly terminate = vi.fn();

  constructor(url: string) {
    this.url = url;
    PythonWorker.instances.push(this);
  }

  addEventListener(type: string, listener: WorkerListener) {
    if (type === "message") this.listeners.add(listener);
  }

  removeEventListener(type: string, listener: WorkerListener) {
    if (type === "message") this.listeners.delete(listener);
  }
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
    .IS_REACT_ACT_ENVIRONMENT = true;
  editorProps.mockReset();
  monacoSetTheme.mockReset();
  autoMountEditor = true;
  pendingEditorMount = undefined;
  window.localStorage.clear();
  PythonWorker.instances = [];
  vi.stubGlobal("Worker", PythonWorker);
  vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValue(
    "00000000-0000-4000-8000-000000000601",
  );
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("LessonCodeWorkspace", () => {
  it("renders one Python editor without a JavaScript choice", async () => {
    await act(async () => {
      root.render(createElement(LessonCodeWorkspace, {
        code: "print(42)",
        onCodeChange: vi.fn(),
      }));
    });

    expect(container.textContent).toContain("Python");
    expect(container.textContent).not.toContain("JavaScript");
    expect(editorProps).toHaveBeenLastCalledWith(expect.objectContaining({
      language: "python",
      theme: "vs",
      value: "print(42)",
    }));
  });

  it("switches Monaco to the global dark theme", async () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, "dark");
    await act(async () => {
      root.render(createElement(
        ThemeProvider,
        null,
        createElement(LessonCodeWorkspace, {
          code: "print(42)",
          onCodeChange: vi.fn(),
        }),
      ));
    });

    expect(editorProps).toHaveBeenLastCalledWith(expect.objectContaining({
      language: "python",
      theme: "vs-dark",
      value: "print(42)",
    }));
    expect(monacoSetTheme).toHaveBeenLastCalledWith("vs-dark");
    const workspace = container.querySelector(".lesson-code-workspace");
    const output = container.querySelector(".code-output");
    expect(workspace?.getAttribute("data-code-theme")).toBe("dark");
    expect(output).not.toBeNull();

    window.localStorage.setItem(THEME_STORAGE_KEY, "light");
    await act(async () => {
      window.dispatchEvent(new StorageEvent("storage", {
        key: THEME_STORAGE_KEY,
        newValue: "light",
      }));
    });

    expect(editorProps).toHaveBeenLastCalledWith(expect.objectContaining({
      theme: "vs",
    }));
    expect(monacoSetTheme).toHaveBeenLastCalledWith("vs");
    expect(workspace?.getAttribute("data-code-theme")).toBe("light");
    expect(container.querySelector(".code-output")).toBe(output);
  });

  it("uses the latest theme when Monaco finishes mounting after a theme change", async () => {
    autoMountEditor = false;
    window.localStorage.setItem(THEME_STORAGE_KEY, "light");
    await act(async () => {
      root.render(createElement(
        ThemeProvider,
        null,
        createElement(LessonCodeWorkspace, {
          code: "print(42)",
          onCodeChange: vi.fn(),
        }),
      ));
    });
    expect(pendingEditorMount).toBeTypeOf("function");

    window.localStorage.setItem(THEME_STORAGE_KEY, "dark");
    await act(async () => {
      window.dispatchEvent(new StorageEvent("storage", {
        key: THEME_STORAGE_KEY,
        newValue: "dark",
      }));
    });
    expect(editorProps).toHaveBeenLastCalledWith(expect.objectContaining({
      theme: "vs-dark",
    }));

    await act(async () => {
      pendingEditorMount?.({}, { editor: { setTheme: monacoSetTheme } });
    });
    expect(monacoSetTheme).toHaveBeenCalledOnce();
    expect(monacoSetTheme).toHaveBeenLastCalledWith("vs-dark");
  });

  it("runs source in a fresh disposable Python worker", async () => {
    await act(async () => {
      root.render(createElement(LessonCodeWorkspace, {
        code: "print(40 + 2)",
        onCodeChange: vi.fn(),
      }));
    });
    const runButton = Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("Запустить"));
    expect(runButton).toBeDefined();

    await act(async () => {
      runButton?.click();
      await Promise.resolve();
    });

    expect(PythonWorker.instances).toHaveLength(1);
    expect(PythonWorker.instances[0].url).toBe(PYTHON_RUNNER_WORKER_URL);
    expect(PythonWorker.instances[0].postMessage).toHaveBeenCalledWith({
      type: PYTHON_RUNNER_REQUEST_TYPE,
      protocolVersion: PYTHON_RUNNER_PROTOCOL_VERSION,
      runId: "00000000-0000-4000-8000-000000000601",
      payload: { kind: "script", code: "print(40 + 2)" },
    });
    expect(container.textContent).toContain("42");
    expect(PythonWorker.instances[0].terminate).toHaveBeenCalledTimes(1);
  });
});

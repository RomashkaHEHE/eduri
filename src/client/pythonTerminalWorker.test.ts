import { readFileSync } from "node:fs";
import vm from "node:vm";
import { describe, expect, it, vi } from "vitest";
import {
  PYTHON_TERMINAL_COMMAND_TYPE,
  PYTHON_TERMINAL_FATAL_TYPE,
  PYTHON_TERMINAL_OPEN_TYPE,
  PYTHON_TERMINAL_OUTPUT_TYPE,
  PYTHON_TERMINAL_OUTPUT_TRUNCATION_MARKER,
  PYTHON_TERMINAL_PROTOCOL_VERSION,
  PYTHON_TERMINAL_READY_TYPE,
  PYTHON_TERMINAL_RESULT_TYPE,
  type PythonTerminalCommandRequest,
  type PythonTerminalFatalMessage,
  type PythonTerminalOpenRequest,
  type PythonTerminalOutputMessage,
  type PythonTerminalReadyMessage,
  type PythonTerminalResultMessage,
} from "./pythonTerminal.js";
import {
  PYTHON_RUNTIME_ASSET_MANIFEST,
  PYTHON_RUNTIME_ASSET_PROTOCOL_VERSION,
  type PythonRuntimeAssets,
} from "../pythonRunnerContract.js";

const WORKER_SOURCE = readFileSync(
  new URL("../../public/python-terminal.worker.js", import.meta.url),
  "utf8",
);
const PYODIDE_RUNTIME_BASE_URL = "/vendor/pyodide/0.27.5/";
const MEMORY_RUNTIME_BASE_URL = "https://python-runtime.invalid/0.27.5/";

function hexBytes(value: string): ArrayBuffer {
  return Uint8Array.from(
    value.match(/.{2}/gu) ?? [],
    (pair) => Number.parseInt(pair, 16),
  ).buffer;
}

const RUNTIME_ASSETS: PythonRuntimeAssets = {
  version: PYTHON_RUNTIME_ASSET_PROTOCOL_VERSION,
  pyodideScript: "x".repeat(PYTHON_RUNTIME_ASSET_MANIFEST.pyodideScript.byteLength),
  pyodideAsmScript: "y".repeat(
    PYTHON_RUNTIME_ASSET_MANIFEST.pyodideAsmScript.byteLength,
  ),
  pyodideLock: new ArrayBuffer(PYTHON_RUNTIME_ASSET_MANIFEST.pyodideLock.byteLength),
  pyodideWasm: new ArrayBuffer(PYTHON_RUNTIME_ASSET_MANIFEST.pyodideWasm.byteLength),
  pythonStdlib: new ArrayBuffer(PYTHON_RUNTIME_ASSET_MANIFEST.pythonStdlib.byteLength),
};

function realRuntimeAssets(): PythonRuntimeAssets {
  const assets: Record<string, unknown> = {
    version: PYTHON_RUNTIME_ASSET_PROTOCOL_VERSION,
  };
  for (const [name, descriptor] of Object.entries(PYTHON_RUNTIME_ASSET_MANIFEST)) {
    const bytes = readFileSync(new URL(
      `../../public/vendor/pyodide/0.27.5/${descriptor.fileName}`,
      import.meta.url,
    ));
    assets[name] = descriptor.fileName.endsWith(".js")
      ? bytes.toString("utf8")
      : Uint8Array.from(bytes).buffer;
  }
  return assets as unknown as PythonRuntimeAssets;
}
const PRIVATE_CAPABILITIES = [
  "BroadcastChannel",
  "EventSource",
  "FileSystemDirectoryHandle",
  "FileSystemFileHandle",
  "FileSystemHandle",
  "LockManager",
  "RTCPeerConnection",
  "SharedWorker",
  "StorageManager",
  "WebSocket",
  "WebSocketStream",
  "WebTransport",
  "Worker",
  "XMLHttpRequest",
  "caches",
  "close",
  "cookieStore",
  "fetch",
  "importScripts",
  "indexedDB",
  "loadPyodide",
  "localStorage",
  "navigator",
  "open",
  "postMessage",
  "sessionStorage",
] as const;

type WorkerResponse =
  | PythonTerminalReadyMessage
  | PythonTerminalOutputMessage
  | PythonTerminalResultMessage
  | PythonTerminalFatalMessage;

function memoryFileSystem() {
  const nodes = new Map<string, {
    kind: "directory" | "file" | "link" | "device";
    bytes?: Uint8Array;
  }>([["/workspace", { kind: "directory" }]]);
  const mkdirTree = vi.fn((path: string) => {
    const segments = path.split("/").filter(Boolean);
    let cursor = "";
    for (const segment of segments) {
      cursor += `/${segment}`;
      if (!nodes.has(cursor)) nodes.set(cursor, { kind: "directory" });
    }
  });
  return {
    mkdirTree,
    writeFile: vi.fn((path: string, value: string | Uint8Array) => {
      mkdirTree(path.slice(0, path.lastIndexOf("/")));
      nodes.set(path, {
        kind: "file",
        bytes: typeof value === "string"
          ? new TextEncoder().encode(value)
          : value.slice(),
      });
    }),
    readdir: vi.fn((path: string) => {
      const prefix = path === "/" ? "/" : `${path}/`;
      const children = new Set<string>();
      for (const nodePath of nodes.keys()) {
        if (!nodePath.startsWith(prefix)) continue;
        const remainder = nodePath.slice(prefix.length);
        if (remainder && !remainder.includes("/")) children.add(remainder);
      }
      return [".", "..", ...children];
    }),
    lstat: vi.fn((path: string) => {
      const node = nodes.get(path);
      if (!node) throw new Error(`Missing test node ${path}`);
      return { mode: node.kind };
    }),
    isDir: vi.fn((mode: string) => mode === "directory"),
    isFile: vi.fn((mode: string) => mode === "file"),
    isLink: vi.fn((mode: string) => mode === "link"),
    readFile: vi.fn((path: string) => nodes.get(path)?.bytes?.slice()),
    setNode(path: string, kind: "directory" | "file" | "link" | "device") {
      mkdirTree(path.slice(0, path.lastIndexOf("/")));
      nodes.set(path, { kind, ...(kind === "file" ? { bytes: new Uint8Array() } : {}) });
    },
  };
}

function openRequest(): PythonTerminalOpenRequest {
  const content = "print('ok')\n";
  return {
    type: PYTHON_TERMINAL_OPEN_TYPE,
    protocolVersion: PYTHON_TERMINAL_PROTOCOL_VERSION,
    sessionId: "session-a",
    workspace: {
      files: [{
        path: "main.py",
        base: {
          entryId: "main-py",
          contentKind: "text",
          sha256: "a".repeat(64),
          byteSize: new TextEncoder().encode(content).byteLength,
        },
        content,
      }],
      directories: [],
    },
    runtimeAssets: RUNTIME_ASSETS,
    stdinControl: new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 2),
    stdinData: new SharedArrayBuffer(64 * 1024),
    interruptBuffer: new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT),
  };
}

function command(
  commandId: string,
  details:
    | { readonly action: "execute"; readonly entrypoint: string }
    | { readonly action: "start-repl" | "repl-interrupt" | "repl-eof" }
    | { readonly action: "repl-line"; readonly line: string },
): PythonTerminalCommandRequest {
  return {
    type: PYTHON_TERMINAL_COMMAND_TYPE,
    protocolVersion: PYTHON_TERMINAL_PROTOCOL_VERSION,
    sessionId: "session-a",
    commandId,
    ...details,
  };
}

function terminalWorkerHarness(options: {
  readonly lockedCapability?: string;
  readonly withoutWebCrypto?: boolean;
} = {}) {
  let listener: ((event: { data: unknown }) => void) | undefined;
  let stdout: (bytes: Uint8Array) => number = (bytes) => bytes.byteLength;
  let stderr: (bytes: Uint8Array) => number = (bytes) => bytes.byteLength;
  let replValue = 0;
  let runOutput: readonly string[] = ["ok\n"];
  const postMessage = vi.fn<(message: WorkerResponse) => void>();
  const close = vi.fn();
  const importScripts = vi.fn();
  const nativeFetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
    new Response("public response"),
  );
  let recoveredRuntimeFetch:
    | ((input: string) => Promise<Response>)
    | undefined;
  const fs = memoryFileSystem();
  let workerGlobal: Record<string, unknown>;
  const capabilitySnapshots: Array<Record<string, unknown>> = [];
  const runtime = {
    FS: fs,
    setStdout: vi.fn(({ write }: { write: (bytes: Uint8Array) => number }) => {
      stdout = write;
    }),
    setStderr: vi.fn(({ write }: { write: (bytes: Uint8Array) => number }) => {
      stderr = write;
    }),
    setStdin: vi.fn(),
    setInterruptBuffer: vi.fn(),
    runPythonAsync: vi.fn(async (source: string) => {
      capabilitySnapshots.push(Object.fromEntries(
        PRIVATE_CAPABILITIES.map((name) => [name, workerGlobal[name]]),
      ));
      if (source.includes("runpy.run_path")) {
        for (const chunk of runOutput) {
          stdout(new TextEncoder().encode(chunk));
        }
      } else if (source.trimStart().startsWith("_eduri_repl_push(")) {
        if (source.includes("print(1)")) stdout(new TextEncoder().encode("1\n"));
        return replValue;
      }
      return undefined;
    }),
  };
  const loadPyodide = vi.fn().mockImplementation(async () => {
    recoveredRuntimeFetch = workerGlobal.fetch as (input: string) => Promise<Response>;
    for (const descriptor of Object.values(PYTHON_RUNTIME_ASSET_MANIFEST)
      .filter((candidate) => !candidate.fileName.endsWith(".js"))) {
      const response = await recoveredRuntimeFetch(
        `${MEMORY_RUNTIME_BASE_URL}${descriptor.fileName}`,
      );
      expect((await response.arrayBuffer()).byteLength).toBe(descriptor.byteLength);
    }
    (workerGlobal.importScripts as (url: string) => void)(
      `${MEMORY_RUNTIME_BASE_URL}pyodide.asm.js`,
    );
    return runtime;
  });
  const digest = vi.fn(async (_algorithm: string, value: ArrayBuffer) => {
    const descriptor = Object.values(PYTHON_RUNTIME_ASSET_MANIFEST)
      .find((candidate) => candidate.byteLength === value.byteLength);
    if (!descriptor) throw new Error("Unexpected runtime asset in digest mock");
    return hexBytes(descriptor.sha256);
  });
  workerGlobal = {
    ...Object.fromEntries(PRIVATE_CAPABILITIES.map((name) => [name, { name }])),
    ArrayBuffer,
    Atomics,
    Blob,
    Error,
    Int32Array,
    Map,
    Object,
    Promise,
    Response,
    Set,
    SharedArrayBuffer,
    String,
    TextDecoder,
    TextEncoder,
    Uint8Array,
    URL,
    addEventListener(type: string, next: typeof listener) {
      if (type === "message") listener = next;
    },
    close,
    ...(options.withoutWebCrypto ? {} : { crypto: { subtle: { digest } } }),
    fetch: nativeFetch,
    importScripts,
    loadPyodide,
    location: { href: "https://eduri.test/python-terminal.worker.js?protocol=3" },
    postMessage,
  };
  if (options.lockedCapability) {
    Object.defineProperty(workerGlobal, options.lockedCapability, {
      value: workerGlobal[options.lockedCapability],
      configurable: false,
      writable: false,
    });
  }
  workerGlobal.self = workerGlobal;
  vm.runInNewContext(WORKER_SOURCE, workerGlobal);
  if (!listener) throw new Error("Python terminal worker did not register a listener");
  return {
    capabilitySnapshots,
    close,
    fs,
    importScripts,
    listener,
    loadPyodide,
    nativeFetch,
    postMessage,
    recoveredRuntimeFetch: () => recoveredRuntimeFetch,
    runtime,
    setReplValue(value: number) {
      replValue = value;
    },
    setRunOutput(...chunks: readonly string[]) {
      runOutput = chunks;
    },
    stderr(value: string) {
      stderr(new TextEncoder().encode(value));
    },
    workerGlobal,
  };
}

function messagesOf<T extends WorkerResponse["type"]>(
  harness: ReturnType<typeof terminalWorkerHarness>,
  type: T,
): Array<Extract<WorkerResponse, { readonly type: T }>> {
  return harness.postMessage.mock.calls
    .map(([message]) => message)
    .filter((message): message is Extract<WorkerResponse, { readonly type: T }> => (
      message.type === type
    ));
}

async function initialize(harness: ReturnType<typeof terminalWorkerHarness>): Promise<void> {
  harness.listener({ data: openRequest() });
  await vi.waitFor(() => {
    expect(messagesOf(harness, PYTHON_TERMINAL_READY_TYPE)).toHaveLength(1);
  });
}

describe("persistent Python terminal worker", () => {
  it("verifies pinned assets with pure-JS SHA-256 in an opaque origin", async () => {
    const harness = terminalWorkerHarness({ withoutWebCrypto: true });
    harness.listener({
      data: { ...openRequest(), runtimeAssets: realRuntimeAssets() },
    });
    await vi.waitFor(() => {
      expect(messagesOf(harness, PYTHON_TERMINAL_READY_TYPE)).toHaveLength(1);
    });
  });

  it("rejects changed assets with pure-JS SHA-256 when WebCrypto is absent", async () => {
    const harness = terminalWorkerHarness({ withoutWebCrypto: true });
    harness.listener({ data: openRequest() });
    await vi.waitFor(() => {
      const fatal = messagesOf(harness, PYTHON_TERMINAL_FATAL_TYPE)[0];
      expect(fatal?.message).toContain("integrity check failed");
    });
  });
  it("loads only pinned same-origin Pyodide and removes private browser capabilities", async () => {
    const harness = terminalWorkerHarness();
    await initialize(harness);

    expect(harness.importScripts).toHaveBeenCalledTimes(2);
    expect(harness.importScripts.mock.calls.every(([url]) => (
      typeof url === "string" && url.startsWith("blob:")
    ))).toBe(true);
    const runtimeOptions = harness.loadPyodide.mock.calls[0][0];
    expect(runtimeOptions.indexURL).toBe(MEMORY_RUNTIME_BASE_URL);
    expect(Object.getPrototypeOf(runtimeOptions.jsglobals)).toBeNull();
    expect(Object.isFrozen(runtimeOptions.jsglobals)).toBe(true);
    expect(WORKER_SOURCE).not.toMatch(/https?:\/\/(?:eduri|localhost)/iu);
    expect(harness.capabilitySnapshots.length).toBeGreaterThan(0);
    for (const snapshot of harness.capabilitySnapshots) {
      expect(Object.values(snapshot).every((value) => value === undefined)).toBe(true);
    }
    expect(harness.runtime.setInterruptBuffer).toHaveBeenCalledOnce();
    expect(harness.close).not.toHaveBeenCalled();
    const recoveredFetch = harness.recoveredRuntimeFetch();
    expect(recoveredFetch).toBeTypeOf("function");
    await expect(recoveredFetch!("/api/health")).rejects.toThrow(
      "network access is disabled",
    );
    expect(harness.nativeFetch).not.toHaveBeenCalled();
  });

  it("runs a regular workspace file, streams output, and returns a bounded delta", async () => {
    const harness = terminalWorkerHarness();
    await initialize(harness);
    harness.listener({ data: command("run-main", { action: "execute", entrypoint: "main.py" }) });
    await vi.waitFor(() => {
      expect(messagesOf(harness, PYTHON_TERMINAL_RESULT_TYPE)).toHaveLength(1);
    });

    expect(messagesOf(harness, PYTHON_TERMINAL_OUTPUT_TYPE)).toEqual([
      expect.objectContaining({ commandId: "run-main", chunk: "ok\n" }),
    ]);
    expect(messagesOf(harness, PYTHON_TERMINAL_RESULT_TYPE)[0]).toMatchObject({
      commandId: "run-main",
      status: "ok",
      mode: "shell",
      prompt: null,
      workspaceDelta: { version: 1, changes: [] },
    });
    expect(harness.close).not.toHaveBeenCalled();
  });

  it("keeps exact-boundary output intact and replaces the reserved tail with one marker on overflow", async () => {
    const harness = terminalWorkerHarness();
    const maximum = 256 * 1024;
    await initialize(harness);

    harness.setRunOutput("x".repeat(maximum));
    harness.listener({
      data: command("exact-boundary", { action: "execute", entrypoint: "main.py" }),
    });
    await vi.waitFor(() => {
      expect(messagesOf(harness, PYTHON_TERMINAL_RESULT_TYPE)).toHaveLength(1);
    });
    const exactChunks = messagesOf(harness, PYTHON_TERMINAL_OUTPUT_TYPE)
      .filter((message) => message.commandId === "exact-boundary")
      .map((message) => message.chunk);
    expect(exactChunks.every((chunk) => chunk.length <= 64 * 1024)).toBe(true);
    expect(exactChunks.join("")).toBe("x".repeat(maximum));
    expect(messagesOf(harness, PYTHON_TERMINAL_RESULT_TYPE)[0]?.truncated).toBe(false);

    // The additional byte arrives in a later write. This is the case that used
    // to consume the entire budget before the worker knew it needed a marker.
    harness.setRunOutput("y".repeat(maximum), "!");
    harness.listener({
      data: command("over-boundary", { action: "execute", entrypoint: "main.py" }),
    });
    await vi.waitFor(() => {
      expect(messagesOf(harness, PYTHON_TERMINAL_RESULT_TYPE)).toHaveLength(2);
    });
    const overflowChunks = messagesOf(harness, PYTHON_TERMINAL_OUTPUT_TYPE)
      .filter((message) => message.commandId === "over-boundary")
      .map((message) => message.chunk);
    const overflow = overflowChunks.join("");
    expect(overflowChunks.every((chunk) => chunk.length <= 64 * 1024)).toBe(true);
    expect(overflow).toHaveLength(maximum);
    expect(overflow.endsWith(PYTHON_TERMINAL_OUTPUT_TRUNCATION_MARKER)).toBe(true);
    expect(overflow.split(PYTHON_TERMINAL_OUTPUT_TRUNCATION_MARKER)).toHaveLength(2);
    expect(messagesOf(harness, PYTHON_TERMINAL_RESULT_TYPE)[1]?.truncated).toBe(true);
  });

  it("keeps an InteractiveConsole alive and reports primary and continuation prompts", async () => {
    const harness = terminalWorkerHarness();
    await initialize(harness);
    harness.listener({ data: command("repl-start", { action: "start-repl" }) });
    await vi.waitFor(() => {
      expect(messagesOf(harness, PYTHON_TERMINAL_RESULT_TYPE)).toHaveLength(1);
    });
    expect(messagesOf(harness, PYTHON_TERMINAL_RESULT_TYPE)[0]).toMatchObject({
      mode: "repl",
      prompt: ">>> ",
    });

    harness.setReplValue(1);
    harness.listener({ data: command("repl-block", { action: "repl-line", line: "for x in [1]:" }) });
    await vi.waitFor(() => {
      expect(messagesOf(harness, PYTHON_TERMINAL_RESULT_TYPE)).toHaveLength(2);
    });
    expect(messagesOf(harness, PYTHON_TERMINAL_RESULT_TYPE)[1]).toMatchObject({
      mode: "repl",
      prompt: "... ",
    });

    harness.listener({ data: command("repl-interrupt", { action: "repl-interrupt" }) });
    await vi.waitFor(() => {
      expect(messagesOf(harness, PYTHON_TERMINAL_RESULT_TYPE)).toHaveLength(3);
    });
    expect(messagesOf(harness, PYTHON_TERMINAL_RESULT_TYPE)[2]).toMatchObject({
      mode: "repl",
      prompt: ">>> ",
    });
    expect(harness.runtime.runPythonAsync.mock.calls.some(([source]) => (
      String(source).includes("_eduri_console.resetbuffer()")
    ))).toBe(true);

    harness.setReplValue(0);
    harness.listener({ data: command("repl-print", { action: "repl-line", line: "print(1)" }) });
    await vi.waitFor(() => {
      expect(messagesOf(harness, PYTHON_TERMINAL_RESULT_TYPE)).toHaveLength(4);
    });
    expect(messagesOf(harness, PYTHON_TERMINAL_OUTPUT_TYPE)).toContainEqual(
      expect.objectContaining({ commandId: "repl-print", chunk: "1\n" }),
    );
    expect(messagesOf(harness, PYTHON_TERMINAL_RESULT_TYPE)[3]).toMatchObject({
      status: "ok",
      mode: "repl",
      prompt: ">>> ",
    });
    expect(messagesOf(harness, PYTHON_TERMINAL_OUTPUT_TYPE)).not.toContainEqual(
      expect.objectContaining({
        commandId: "repl-print",
        chunk: expect.stringContaining("invalid state"),
      }),
    );

    harness.listener({ data: command("repl-exit", { action: "repl-eof" }) });
    await vi.waitFor(() => {
      expect(messagesOf(harness, PYTHON_TERMINAL_RESULT_TYPE)).toHaveLength(5);
    });
    expect(messagesOf(harness, PYTHON_TERMINAL_RESULT_TYPE)[4]).toMatchObject({
      mode: "shell",
      prompt: null,
    });
    expect(harness.loadPyodide).toHaveBeenCalledOnce();
  });

  it("fails closed when a private capability cannot be disabled", async () => {
    const harness = terminalWorkerHarness({ lockedCapability: "fetch" });
    harness.listener({ data: openRequest() });
    await vi.waitFor(() => {
      expect(messagesOf(harness, PYTHON_TERMINAL_FATAL_TYPE)).toHaveLength(1);
    });
    expect(messagesOf(harness, PYTHON_TERMINAL_FATAL_TYPE)[0].message).toContain("fetch");
    expect(harness.close).toHaveBeenCalledOnce();
  });

  it("rejects traversal commands without attempting Python execution", async () => {
    const harness = terminalWorkerHarness();
    await initialize(harness);
    const callsBefore = harness.runtime.runPythonAsync.mock.calls.length;
    harness.listener({
      data: command("unsafe", { action: "execute", entrypoint: "../secret.py" }),
    });
    await vi.waitFor(() => {
      expect(messagesOf(harness, PYTHON_TERMINAL_FATAL_TYPE)).toHaveLength(1);
    });
    expect(harness.runtime.runPythonAsync).toHaveBeenCalledTimes(callsBefore);
    expect(harness.close).toHaveBeenCalledOnce();
  });
});

import { readFileSync } from "node:fs";
import vm from "node:vm";
import { describe, expect, it, vi } from "vitest";
import {
  PYTHON_RUNNER_PROTOCOL_VERSION,
  PYTHON_RUNNER_REQUEST_TYPE,
  PYTHON_RUNNER_RESULT_TYPE,
  type PythonRunnerInputRequestMessage,
  type PythonRunnerOutputMessage,
  type PythonRunnerRequest,
  type PythonRunnerResponse,
} from "./pythonRunner";
import {
  PYTHON_RUNTIME_ASSET_MANIFEST,
  PYTHON_RUNTIME_ASSET_PROTOCOL_VERSION,
  type PythonRuntimeAssets,
} from "../pythonRunnerContract.js";

const PYODIDE_RUNTIME_BASE_URL = "/vendor/pyodide/0.27.5/";
const MEMORY_RUNTIME_BASE_URL = "https://python-runtime.invalid/0.27.5/";
const PRIVATE_CAPABILITY_NAMES = [
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
const WORKER_SOURCE = readFileSync(
  new URL("../../public/python-runner.worker.js", import.meta.url),
  "utf8",
);

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

function runtimeAssets(): PythonRuntimeAssets {
  return {
    version: PYTHON_RUNTIME_ASSET_PROTOCOL_VERSION,
    pyodideScript: RUNTIME_ASSETS.pyodideScript,
    pyodideAsmScript: RUNTIME_ASSETS.pyodideAsmScript,
    pyodideLock: RUNTIME_ASSETS.pyodideLock,
    pyodideWasm: RUNTIME_ASSETS.pyodideWasm,
    pythonStdlib: RUNTIME_ASSETS.pythonStdlib,
  };
}

function scriptRequest(runId: string, code: string): PythonRunnerRequest {
  return {
    type: PYTHON_RUNNER_REQUEST_TYPE,
    protocolVersion: PYTHON_RUNNER_PROTOCOL_VERSION,
    runId,
    payload: { kind: "script", code },
    runtimeAssets: runtimeAssets(),
  };
}

function textBase(entryId: string, content: string) {
  return {
    entryId,
    contentKind: "text" as const,
    sha256: "a".repeat(64),
    byteSize: new TextEncoder().encode(content).byteLength,
  };
}

function blobBase(entryId: string, bytes: Uint8Array) {
  return {
    entryId,
    contentKind: "blob" as const,
    sha256: "b".repeat(64),
    byteSize: bytes.byteLength,
  };
}

function workspaceRequest(runId: string, stdin: string): PythonRunnerRequest {
  return {
    type: PYTHON_RUNNER_REQUEST_TYPE,
    protocolVersion: PYTHON_RUNNER_PROTOCOL_VERSION,
    runId,
    payload: {
      kind: "workspace",
      files: [{
        path: "main.py",
        base: textBase("main-py", "pass\n"),
        content: "pass\n",
      }],
      directories: [],
      entrypoint: "main.py",
      stdin,
    },
    runtimeAssets: runtimeAssets(),
  };
}

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
  const writeFile = vi.fn((
    path: string,
    value: string | Uint8Array,
  ) => {
    const slash = path.lastIndexOf("/");
    mkdirTree(path.slice(0, slash));
    nodes.set(path, {
      kind: "file",
      bytes: typeof value === "string"
        ? new TextEncoder().encode(value)
        : value.slice(),
    });
  });
  return {
    mkdirTree,
    writeFile,
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
    remove(path: string) {
      nodes.delete(path);
    },
    setNode(
      path: string,
      kind: "directory" | "file" | "link" | "device",
      bytes = new Uint8Array(),
    ) {
      const slash = path.lastIndexOf("/");
      mkdirTree(path.slice(0, slash));
      nodes.set(path, { kind, ...(kind === "file" ? { bytes } : {}) });
    },
  };
}

function pythonRunnerHarness(
  execute: (
    code: string,
    write: (value: string) => void,
    fs: ReturnType<typeof memoryFileSystem>,
  ) => unknown = () => undefined,
  options: {
    readonly lockedCapability?: string;
    readonly withoutWebCrypto?: boolean;
  } = {},
) {
  let listener:
    | ((event: { data: unknown }) => Promise<void>)
    | undefined;
  let writeOutput: (value: Uint8Array) => number = (value) => value.byteLength;
  const postMessage = vi.fn<(
    message: PythonRunnerResponse
      | PythonRunnerOutputMessage
      | PythonRunnerInputRequestMessage,
  ) => void>();
  const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
    new Response("public response"),
  );
  let recoveredRuntimeFetch:
    | ((input: string) => Promise<Response>)
    | undefined;
  let workerGlobal: Record<string, unknown>;
  const capabilitySnapshots: Array<Record<string, unknown>> = [];
  const fs = memoryFileSystem();
  const runtime = {
    setStdout: vi.fn(({ write }: { write: (value: Uint8Array) => number }) => {
      writeOutput = write;
    }),
    setStderr: vi.fn(({ write }: { write: (value: Uint8Array) => number }) => {
      writeOutput = write;
    }),
    setStdin: vi.fn(),
    FS: fs,
    runPythonAsync: vi.fn((code: string) => {
      capabilitySnapshots.push(Object.fromEntries(
        PRIVATE_CAPABILITY_NAMES.map((name) => [name, workerGlobal[name]]),
      ));
      return Promise.resolve(execute(code, (value) => {
        writeOutput(new TextEncoder().encode(value));
      }, fs));
    }),
  };
  const importScripts = vi.fn();
  const close = vi.fn();
  const loadPyodide = vi.fn().mockImplementation(async () => {
    recoveredRuntimeFetch = workerGlobal.fetch as (input: string) => Promise<Response>;
    for (const descriptor of Object.values(PYTHON_RUNTIME_ASSET_MANIFEST)
      .filter((candidate) => !candidate.fileName.endsWith(".js"))) {
      const response = await recoveredRuntimeFetch(
        `${MEMORY_RUNTIME_BASE_URL}${descriptor.fileName}`,
      );
      expect(response.ok).toBe(true);
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
    ...Object.fromEntries(PRIVATE_CAPABILITY_NAMES.map((name) => [
      name,
      { capability: name },
    ])),
    TextDecoder,
    TextEncoder,
    Blob,
    Response,
    URL,
    addEventListener(type: string, next: typeof listener) {
      if (type === "message") listener = next;
    },
    close,
    ...(options.withoutWebCrypto ? {} : { crypto: { subtle: { digest } } }),
    fetch,
    fs,
    importScripts,
    indexedDB: { private: true },
    loadPyodide,
    location: { href: "https://eduri.test/python-runner.worker.js?protocol=4" },
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
  if (!listener) throw new Error("Python runner did not register a listener");
  return {
    capabilitySnapshots,
    close,
    fetch,
    importScripts,
    listener,
    loadPyodide,
    postMessage,
    recoveredRuntimeFetch: () => recoveredRuntimeFetch,
    runtime,
    workerGlobal,
  };
}

function terminalResult(
  harness: ReturnType<typeof pythonRunnerHarness>,
): PythonRunnerResponse {
  const message = harness.postMessage.mock.calls
    .map(([candidate]) => candidate)
    .find((candidate): candidate is PythonRunnerResponse => (
      candidate.type === PYTHON_RUNNER_RESULT_TYPE
    ));
  if (!message) throw new Error("Python worker did not return a terminal result");
  return message;
}

describe("Python code runner worker", () => {
  it("verifies pinned assets with pure-JS SHA-256 in an opaque origin", async () => {
    const request = scriptRequest("run-pure-sha", "pass");
    const assets = { ...request.runtimeAssets } as Record<string, unknown>;
    for (const [name, descriptor] of Object.entries(PYTHON_RUNTIME_ASSET_MANIFEST)) {
      const bytes = readFileSync(new URL(
        `../../public/vendor/pyodide/0.27.5/${descriptor.fileName}`,
        import.meta.url,
      ));
      assets[name] = descriptor.fileName.endsWith(".js")
        ? bytes.toString("utf8")
        : Uint8Array.from(bytes).buffer;
    }
    const harness = pythonRunnerHarness(() => undefined, { withoutWebCrypto: true });
    await harness.listener({ data: { ...request, runtimeAssets: assets } });
    expect(terminalResult(harness).status).toBe("ok");
  });
  it("loads only the pinned same-origin runtime and closes after the result", async () => {
    const harness = pythonRunnerHarness();

    await harness.listener({
      data: scriptRequest("run-a", "print('hello')"),
    });
    expect(harness.importScripts).toHaveBeenCalledTimes(2);
    expect(harness.importScripts.mock.calls.every(([url]) => (
      typeof url === "string" && url.startsWith("blob:")
    ))).toBe(true);
    expect(harness.loadPyodide).toHaveBeenCalledOnce();
    const runtimeOptions = harness.loadPyodide.mock.calls[0][0];
    expect(runtimeOptions.indexURL).toBe(MEMORY_RUNTIME_BASE_URL);
    expect(Object.getPrototypeOf(runtimeOptions.jsglobals)).toBeNull();
    expect(Object.isFrozen(runtimeOptions.jsglobals)).toBe(true);
    expect(WORKER_SOURCE).not.toMatch(/https?:\/\/(?:eduri|localhost)/iu);
    expect(WORKER_SOURCE).not.toMatch(/(?:jsdelivr|pypi|pythonhosted)/iu);
    expect(harness.runtime.runPythonAsync).toHaveBeenCalledWith(
      "print('hello')",
    );
    expect(harness.postMessage).toHaveBeenCalledWith({
      type: PYTHON_RUNNER_RESULT_TYPE,
      protocolVersion: PYTHON_RUNNER_PROTOCOL_VERSION,
      runId: "run-a",
      status: "ok",
      output: "",
      truncated: false,
    });
    expect(harness.close).toHaveBeenCalledOnce();
    expect(harness.workerGlobal.indexedDB).toBeUndefined();
    expect(harness.workerGlobal.fetch).toBeUndefined();
    expect(harness.workerGlobal.loadPyodide).toBeUndefined();
    expect(harness.fetch).not.toHaveBeenCalled();
    const recoveredFetch = harness.recoveredRuntimeFetch();
    expect(recoveredFetch).toBeTypeOf("function");
    await expect(recoveredFetch!("/api/health")).rejects.toThrow(
      "network access is disabled",
    );
    expect(harness.fetch).not.toHaveBeenCalled();
  });

  it("removes network and storage capabilities before user code executes", async () => {
    const source = "print('private capabilities are unavailable')";
    const harness = pythonRunnerHarness((code) => {
      expect(code).toBe(source);
    });

    await harness.listener({ data: scriptRequest("run-private", source) });

    expect(harness.capabilitySnapshots).toHaveLength(1);
    for (const name of PRIVATE_CAPABILITY_NAMES) {
      expect(harness.capabilitySnapshots[0][name], name).toBeUndefined();
      expect(harness.workerGlobal[name], name).toBeUndefined();
    }
  });

  it("preserves exact trailing newlines and a truly empty stdout", async () => {
    const newlineHarness = pythonRunnerHarness((_code, write) => {
      write("first\nsecond\n");
    });
    await newlineHarness.listener({
      data: scriptRequest("run-exact-newline", "print('first\\nsecond')"),
    });
    expect(newlineHarness.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      runId: "run-exact-newline",
      status: "ok",
      output: "first\nsecond\n",
    }));

    const emptyHarness = pythonRunnerHarness();
    await emptyHarness.listener({
      data: scriptRequest("run-empty-output", "pass"),
    });
    expect(emptyHarness.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      runId: "run-empty-output",
      status: "ok",
      output: "",
    }));
  });

  it("fails closed when a private capability cannot be removed", async () => {
    const harness = pythonRunnerHarness(() => {
      throw new Error("untrusted Python must not execute");
    }, { lockedCapability: "fetch" });

    await harness.listener({
      data: scriptRequest("run-locked-capability", "print('must not run')"),
    });

    expect(harness.runtime.runPythonAsync).not.toHaveBeenCalled();
    expect(harness.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      runId: "run-locked-capability",
      status: "runtime-error",
      output: expect.stringContaining("could not replace fetch"),
    }));
  });

  it("materializes a bounded multi-file workspace and stdin", async () => {
    const harness = pythonRunnerHarness();
    const request: PythonRunnerRequest = {
      type: PYTHON_RUNNER_REQUEST_TYPE,
      protocolVersion: PYTHON_RUNNER_PROTOCOL_VERSION,
      runId: "run-files",
      payload: {
        kind: "workspace",
        files: [
          {
            path: "main.py",
            base: textBase("main-py", "from lib import answer\nprint(answer)"),
            content: "from lib import answer\nprint(answer)",
          },
          {
            path: "lib.py",
            base: textBase("lib-py", "answer = 42"),
            content: "answer = 42",
          },
        ],
        directories: [],
        entrypoint: "main.py",
        stdin: "one\ntwo",
      },
      runtimeAssets: runtimeAssets(),
    };

    await harness.listener({ data: request });

    expect(harness.runtime.FS.writeFile).toHaveBeenCalledWith(
      "/workspace/main.py",
      "from lib import answer\nprint(answer)",
      { encoding: "utf8" },
    );
    expect(harness.runtime.FS.writeFile).toHaveBeenCalledWith(
      "/workspace/lib.py",
      "answer = 42",
      { encoding: "utf8" },
    );
    expect(harness.runtime.setStdin).toHaveBeenCalledOnce();
    const stdin = harness.runtime.setStdin.mock.calls[0][0].stdin;
    expect(stdin()).toBe("one");
    expect(stdin()).toBe("two");
    expect(stdin()).toBeNull();
    expect(harness.runtime.runPythonAsync).toHaveBeenCalledTimes(2);
    expect(harness.runtime.runPythonAsync.mock.calls[1][0]).toContain(
      "runpy.run_path",
    );
    expect(harness.runtime.runPythonAsync.mock.calls[1][0]).toMatch(/None\s*$/u);
  });

  it("treats empty input and a final line ending as EOF, not an extra line", async () => {
    const emptyHarness = pythonRunnerHarness();
    await emptyHarness.listener({
      data: workspaceRequest("run-empty-stdin", ""),
    });
    const emptyStdin = emptyHarness.runtime.setStdin.mock.calls[0][0].stdin;
    expect(emptyStdin()).toBeNull();

    const trailingHarness = pythonRunnerHarness();
    await trailingHarness.listener({
      data: workspaceRequest("run-trailing-stdin", "one\ntwo\n"),
    });
    const trailingStdin = trailingHarness.runtime.setStdin.mock.calls[0][0].stdin;
    expect(trailingStdin()).toBe("one");
    expect(trailingStdin()).toBe("two");
    expect(trailingStdin()).toBeNull();
  });

  it("finishes each interactive callback value as one stdin read", async () => {
    const harness = pythonRunnerHarness();
    await harness.listener({
      data: {
        ...workspaceRequest("run-interactive-stdin", ""),
        payload: {
          ...workspaceRequest("run-interactive-stdin", "").payload,
          stdin: null,
        },
        stdinControl: new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 2),
        stdinData: new SharedArrayBuffer(64 * 1024),
      },
    });

    expect(harness.runtime.setStdin).toHaveBeenCalledWith(expect.objectContaining({
      stdin: expect.any(Function),
      isatty: true,
      autoEOF: true,
    }));
  });

  it("writes binary and Unicode-named data files without text decoding", async () => {
    const harness = pythonRunnerHarness();
    const bytes = new Uint8Array([0, 255, 1, 2]);
    const request: PythonRunnerRequest = {
      type: PYTHON_RUNNER_REQUEST_TYPE,
      protocolVersion: PYTHON_RUNNER_PROTOCOL_VERSION,
      runId: "run-binary",
      payload: {
        kind: "workspace",
        files: [
          {
            path: "main.py",
            base: textBase("main-py", "open('данные.bin', 'rb').read()"),
            content: "open('данные.bin', 'rb').read()",
          },
          { path: "данные.bin", base: blobBase("data-bin", bytes), bytes },
        ],
        directories: [],
        entrypoint: "main.py",
        stdin: "",
      },
      runtimeAssets: runtimeAssets(),
    };

    await harness.listener({ data: request });

    const written = harness.runtime.FS.writeFile.mock.calls.find(
      ([path]) => path === "/workspace/данные.bin",
    )?.[1] as Uint8Array;
    expect([...written]).toEqual([0, 255, 1, 2]);
  });

  it("returns deterministic create, modify, delete, and binary deltas", async () => {
    const originalMain = "print('before')\n";
    const removed = "remove me\n";
    const harness = pythonRunnerHarness((code, _write, fs) => {
      if (!code.includes("runpy.run_path")) return;
      fs.writeFile("/workspace/main.py", "print('after')\n");
      fs.remove("/workspace/old.txt");
      fs.writeFile("/workspace/new.txt", "created\n");
      fs.writeFile("/workspace/data.bin", new Uint8Array([0, 255, 7]));
    });
    await harness.listener({
      data: {
        type: PYTHON_RUNNER_REQUEST_TYPE,
        protocolVersion: PYTHON_RUNNER_PROTOCOL_VERSION,
        runId: "run-delta",
        payload: {
          kind: "workspace",
          files: [
            {
              path: "main.py",
              base: textBase("main-py", originalMain),
              content: originalMain,
            },
            {
              path: "old.txt",
              base: textBase("old-text", removed),
              content: removed,
            },
          ],
          directories: [],
          entrypoint: "main.py",
          stdin: "",
        },
        runtimeAssets: runtimeAssets(),
      },
    });

    const result = terminalResult(harness);
    expect(result.status).toBe("ok");
    expect(result.workspaceDelta?.changes.map((change) => ({
      kind: change.kind,
      path: change.path,
      baseId: change.base?.entryId ?? null,
      bytes: change.kind === "write" ? [...change.bytes] : undefined,
    }))).toEqual([
      { kind: "write", path: "data.bin", baseId: null, bytes: [0, 255, 7] },
      {
        kind: "write",
        path: "main.py",
        baseId: "main-py",
        bytes: [...new TextEncoder().encode("print('after')\n")],
      },
      {
        kind: "write",
        path: "new.txt",
        baseId: null,
        bytes: [...new TextEncoder().encode("created\n")],
      },
      { kind: "delete", path: "old.txt", baseId: "old-text", bytes: undefined },
    ]);
  });

  it("orders delta paths by case-folded UTF-16 code units", async () => {
    const harness = pythonRunnerHarness((code, _write, fs) => {
      if (!code.includes("runpy.run_path")) return;
      for (const path of [
        "_underscore.txt",
        "Zeta.txt",
        "\u00c4pfel.txt",
        "-dash.txt",
        "alpha.txt",
      ]) {
        fs.writeFile(`/workspace/${path}`, path);
      }
    });
    await harness.listener({
      data: workspaceRequest("run-path-order", ""),
    });

    const result = terminalResult(harness);
    expect(result.status).toBe("ok");
    expect(result.workspaceDelta?.changes.map((change) => change.path)).toEqual([
      "-dash.txt",
      "_underscore.txt",
      "alpha.txt",
      "Zeta.txt",
      "\u00c4pfel.txt",
    ]);
  });

  it("snapshots files written before a Python runtime error", async () => {
    const harness = pythonRunnerHarness((code, _write, fs) => {
      if (!code.includes("runpy.run_path")) return;
      fs.writeFile("/workspace/before-error.txt", "kept\n");
      throw new Error("python failed after writing");
    });
    await harness.listener({
      data: workspaceRequest("run-error-delta", ""),
    });

    const result = terminalResult(harness);
    expect(result).toEqual(expect.objectContaining({
      runId: "run-error-delta",
      status: "runtime-error",
      output: expect.stringContaining("python failed after writing"),
    }));
    expect(result.workspaceDelta?.version).toBe(1);
    expect(result.workspaceDelta?.changes.map((change) => ({
      ...change,
      ...(change.kind === "write" ? { bytes: [...change.bytes] } : {}),
    }))).toEqual([
      {
        kind: "write",
        path: "before-error.txt",
        base: null,
        bytes: [...new TextEncoder().encode("kept\n")],
      },
    ]);
  });

  it("rejects unsafe result paths, links, devices, and oversized files", async () => {
    for (const [runId, mutate, expected] of [
      [
        "run-unsafe-result",
        (fs: ReturnType<typeof memoryFileSystem>) => {
          fs.writeFile("/workspace/trailing ", "unsafe");
        },
        "unsafe workspace path",
      ],
      [
        "run-link-result",
        (fs: ReturnType<typeof memoryFileSystem>) => {
          fs.setNode("/workspace/link", "link");
        },
        "symbolic link",
      ],
      [
        "run-device-result",
        (fs: ReturnType<typeof memoryFileSystem>) => {
          fs.setNode("/workspace/device", "device");
        },
        "non-regular file",
      ],
      [
        "run-oversize-result",
        (fs: ReturnType<typeof memoryFileSystem>) => {
          fs.writeFile(
            "/workspace/large.bin",
            new Uint8Array(2 * 1024 * 1024 + 1),
          );
        },
        "file exceeds the size limit",
      ],
      [
        "run-count-result",
        (fs: ReturnType<typeof memoryFileSystem>) => {
          for (let index = 0; index < 512; index += 1) {
            fs.writeFile(`/workspace/generated-${index}.txt`, "");
          }
        },
        "too many entries",
      ],
    ] as const) {
      const harness = pythonRunnerHarness((code, _write, fs) => {
        if (code.includes("runpy.run_path")) mutate(fs);
      });
      await harness.listener({ data: workspaceRequest(runId, "") });
      expect(harness.postMessage).toHaveBeenCalledWith(expect.objectContaining({
        runId,
        status: "runtime-error",
        output: expect.stringContaining(expected),
      }));
      expect(terminalResult(harness).workspaceDelta).toBeUndefined();
    }
  });

  it("rejects an aggregate result bomb", async () => {
    const harness = pythonRunnerHarness((code, _write, fs) => {
      if (!code.includes("runpy.run_path")) return;
      for (let index = 0; index < 5; index += 1) {
        fs.writeFile(
          `/workspace/bomb-${index}.bin`,
          new Uint8Array(2 * 1024 * 1024),
        );
      }
    });
    await harness.listener({ data: workspaceRequest("run-result-bomb", "") });
    expect(harness.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      runId: "run-result-bomb",
      status: "runtime-error",
      output: expect.stringContaining("aggregate size limit"),
    }));
  });

  it("rejects invalid and legacy requests before loading Pyodide", async () => {
    const traversal = pythonRunnerHarness();
    await traversal.listener({
      data: {
        type: PYTHON_RUNNER_REQUEST_TYPE,
        protocolVersion: PYTHON_RUNNER_PROTOCOL_VERSION,
        runId: "run-traversal",
        payload: {
          kind: "workspace",
          files: [{
            path: "../secret.py",
            base: textBase("main-py", "print(1)"),
            content: "print(1)",
          }],
          directories: [],
          entrypoint: "../secret.py",
          stdin: "",
        },
      },
    });
    expect(traversal.runtime.FS.writeFile).not.toHaveBeenCalled();
    expect(traversal.loadPyodide).not.toHaveBeenCalled();
    expect(traversal.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: PYTHON_RUNNER_RESULT_TYPE,
      runId: "run-traversal",
      status: "runtime-error",
      output: expect.stringContaining("invalid"),
    }));

    const legacy = pythonRunnerHarness();
    await legacy.listener({
      data: { id: "legacy", code: "print(1)" },
    });
    expect(legacy.loadPyodide).not.toHaveBeenCalled();
    expect(legacy.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      runId: "invalid",
      status: "runtime-error",
      output: expect.stringContaining("request is invalid"),
    }));
  });

  it("bounds output and reports truncation in the protocol", async () => {
    const harness = pythonRunnerHarness((_code, write) => {
      write("x".repeat(400_000));
    });

    await harness.listener({
      data: scriptRequest("run-b", "print('x' * 400000)"),
    });

    const message = terminalResult(harness);
    expect(message.runId).toBe("run-b");
    expect(message.output.length).toBeLessThanOrEqual(256 * 1024 + 32);
    expect(message.output).toContain("[Вывод сокращён]");
    expect(message.truncated).toBe(true);
  });

  it("does not mark output at the exact limit as truncated", async () => {
    const exactOutput = "x".repeat(256 * 1024);
    const harness = pythonRunnerHarness((_code, write) => {
      write(exactOutput);
    });

    await harness.listener({
      data: scriptRequest("run-exact-output-limit", "print('bounded')"),
    });

    expect(harness.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      runId: "run-exact-output-limit",
      status: "ok",
      output: exactOutput,
      truncated: false,
    }));
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PYTHON_RUNNER_PROTOCOL_VERSION,
  PYTHON_RUNNER_INPUT_REQUEST_TYPE,
  PYTHON_RUNNER_OUTPUT_TYPE,
  PYTHON_RUNNER_REQUEST_TYPE,
  PYTHON_RUNNER_RESULT_TYPE,
  startPythonRun,
  type PythonRunPayload,
} from "./pythonRunner";
import {
  PYTHON_RUNTIME_ASSET_MANIFEST,
  PYTHON_RUNTIME_ASSET_PROTOCOL_VERSION,
  type PythonRuntimeAssets,
} from "../pythonRunnerContract.js";
import type { OpaquePythonWorkerControl } from "./opaquePythonWorker.js";

function runtimeAssets(): PythonRuntimeAssets {
  return {
    version: PYTHON_RUNTIME_ASSET_PROTOCOL_VERSION,
    pyodideScript: "x".repeat(PYTHON_RUNTIME_ASSET_MANIFEST.pyodideScript.byteLength),
    pyodideAsmScript: "y".repeat(
      PYTHON_RUNTIME_ASSET_MANIFEST.pyodideAsmScript.byteLength,
    ),
    pyodideLock: new ArrayBuffer(PYTHON_RUNTIME_ASSET_MANIFEST.pyodideLock.byteLength),
    pyodideWasm: new ArrayBuffer(PYTHON_RUNTIME_ASSET_MANIFEST.pyodideWasm.byteLength),
    pythonStdlib: new ArrayBuffer(PYTHON_RUNTIME_ASSET_MANIFEST.pythonStdlib.byteLength),
  };
}

type WorkerListener = (event: Event | MessageEvent<unknown> | ErrorEvent) => void;

class FakeWorker {
  readonly listeners = new Map<string, Set<WorkerListener>>();
  readonly postMessage = vi.fn<(
    message: unknown,
    transfer?: Transferable[],
  ) => void>();
  readonly terminate = vi.fn();

  addEventListener(type: string, listener: WorkerListener): void {
    const listeners = this.listeners.get(type) ?? new Set<WorkerListener>();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: WorkerListener): void {
    this.listeners.get(type)?.delete(listener);
  }

  emit(type: string, event: Event | MessageEvent<unknown> | ErrorEvent): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

class FakeOpaqueWorker extends FakeWorker implements OpaquePythonWorkerControl {
  readonly isOpaquePythonWorker = true as const;
  readonly submitPythonInput = vi.fn(() => true);
  readonly sendPythonEof = vi.fn(() => true);
  readonly interruptPython = vi.fn(() => true);
}

function response(
  runId: string,
  status: "ok" | "runtime-error" = "ok",
  output = status === "ok" ? "42" : "syntax error",
) {
  return {
    type: PYTHON_RUNNER_RESULT_TYPE,
    protocolVersion: PYTHON_RUNNER_PROTOCOL_VERSION,
    runId,
    status,
    output,
    truncated: false,
  };
}

function workspacePayload(): Extract<PythonRunPayload, { readonly kind: "workspace" }> {
  return {
    kind: "workspace",
    files: [{
      path: "main.py",
      base: {
        entryId: "main-py",
        contentKind: "text",
        sha256: "a".repeat(64),
        byteSize: 5,
      },
      content: "pass\n",
    }],
    directories: [],
    entrypoint: "main.py",
    stdin: "",
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("fresh Python runner client", () => {
  it("uses the tagged protocol and terminates after a successful result", async () => {
    const worker = new FakeWorker();
    const execution = startPythonRun(
      { kind: "script", code: "print(42)" },
      {
        runtimeAssets: runtimeAssets(),
        createWorker: () => worker as unknown as Worker,
        runId: "run-success",
      },
    );

    expect(worker.postMessage.mock.calls[0]?.[0]).toMatchObject({
      type: PYTHON_RUNNER_REQUEST_TYPE,
      protocolVersion: PYTHON_RUNNER_PROTOCOL_VERSION,
      runId: "run-success",
      payload: { kind: "script", code: "print(42)" },
    });
    expect((worker.postMessage.mock.calls[0]?.[0] as {
      runtimeAssets?: PythonRuntimeAssets;
    }).runtimeAssets?.version).toBe(PYTHON_RUNTIME_ASSET_PROTOCOL_VERSION);
    expect(worker.postMessage.mock.calls[0]?.[1]).toHaveLength(3);
    worker.emit("message", {
      data: response("run-success"),
    } as MessageEvent<unknown>);

    await expect(execution.result).resolves.toEqual({
      runId: "run-success",
      status: "ok",
      output: "42",
      truncated: false,
    });
    expect(worker.terminate).toHaveBeenCalledTimes(1);
    expect(worker.listeners.get("message")?.size ?? 0).toBe(0);
  });

  it("streams output and accepts terminal input only for an active request", async () => {
    const worker = new FakeWorker();
    const onOutput = vi.fn();
    const onInputRequest = vi.fn();
    const payload = { ...workspacePayload(), stdin: null } as const;
    const execution = startPythonRun(payload, {
      runtimeAssets: runtimeAssets(),
      createWorker: () => worker as unknown as Worker,
      runId: "run-interactive",
      onOutput,
      onInputRequest,
    });
    const request = worker.postMessage.mock.calls[0][0] as {
      stdinControl: SharedArrayBuffer;
      stdinData: SharedArrayBuffer;
    };
    const control = new Int32Array(request.stdinControl);
    const data = new Uint8Array(request.stdinData);

    expect(request.stdinControl).toBeInstanceOf(SharedArrayBuffer);
    expect(request.stdinData).toBeInstanceOf(SharedArrayBuffer);
    expect(execution.submitInput("too early")).toBe(false);
    worker.emit("message", {
      data: {
        type: PYTHON_RUNNER_OUTPUT_TYPE,
        protocolVersion: PYTHON_RUNNER_PROTOCOL_VERSION,
        runId: "run-interactive",
        chunk: "Name: ",
      },
    } as MessageEvent<unknown>);
    expect(onOutput).toHaveBeenCalledWith("Name: ");

    Atomics.store(control, 0, 1);
    worker.emit("message", {
      data: {
        type: PYTHON_RUNNER_INPUT_REQUEST_TYPE,
        protocolVersion: PYTHON_RUNNER_PROTOCOL_VERSION,
        runId: "run-interactive",
        requestId: "input-1",
      },
    } as MessageEvent<unknown>);
    expect(onInputRequest).toHaveBeenCalledWith({
      runId: "run-interactive",
      requestId: "input-1",
    });
    expect(execution.submitInput("Ada")).toBe(true);
    expect(Atomics.load(control, 0)).toBe(2);
    const byteLength = Atomics.load(control, 1);
    expect(new TextDecoder().decode(data.slice(0, byteLength))).toBe("Ada");
    expect(execution.submitInput("duplicate")).toBe(false);

    Atomics.store(control, 0, 1);
    worker.emit("message", {
      data: {
        type: PYTHON_RUNNER_INPUT_REQUEST_TYPE,
        protocolVersion: PYTHON_RUNNER_PROTOCOL_VERSION,
        runId: "run-interactive",
        requestId: "input-2",
      },
    } as MessageEvent<unknown>);
    expect(execution.sendEof()).toBe(true);
    expect(Atomics.load(control, 0)).toBe(3);

    worker.emit("message", {
      data: {
        ...response("run-interactive", "ok", "Hello, Ada\n"),
        workspaceDelta: { version: 1, changes: [] },
      },
    } as MessageEvent<unknown>);
    await expect(execution.result).resolves.toMatchObject({
      status: "ok",
      output: "Hello, Ada\n",
    });
  });

  it("keeps shared memory inside the opaque-worker boundary", async () => {
    const worker = new FakeOpaqueWorker();
    const execution = startPythonRun(
      { ...workspacePayload(), stdin: null },
      {
        runtimeAssets: runtimeAssets(),
        createWorker: () => worker as unknown as Worker,
        runId: "run-opaque-input",
      },
    );
    const request = worker.postMessage.mock.calls[0][0] as Record<string, unknown>;
    expect(request).not.toHaveProperty("stdinControl");
    expect(request).not.toHaveProperty("stdinData");

    worker.emit("message", {
      data: {
        type: PYTHON_RUNNER_INPUT_REQUEST_TYPE,
        protocolVersion: PYTHON_RUNNER_PROTOCOL_VERSION,
        runId: "run-opaque-input",
        requestId: "stdin-1",
      },
    } as MessageEvent<unknown>);
    expect(execution.submitInput("Ada")).toBe(true);
    expect(worker.submitPythonInput).toHaveBeenCalledWith("Ada");
    expect(execution.submitInput("duplicate")).toBe(false);

    worker.emit("message", {
      data: {
        ...response("run-opaque-input"),
        workspaceDelta: { version: 1, changes: [] },
      },
    } as MessageEvent<unknown>);
    await expect(execution.result).resolves.toMatchObject({ status: "ok" });
  });

  it("accepts only a bounded protocol-v3 workspace delta tied to its baseline", async () => {
    const worker = new FakeWorker();
    const payload = workspacePayload();
    const execution = startPythonRun(payload, {
      runtimeAssets: runtimeAssets(),
      createWorker: () => worker as unknown as Worker,
      runId: "run-workspace-delta",
    });
    const bytes = new TextEncoder().encode("print(42)\n");
    worker.emit("message", {
      data: {
        ...response("run-workspace-delta"),
        workspaceDelta: {
          version: 1,
          changes: [{
            kind: "write",
            path: "main.py",
            base: payload.files[0].base,
            bytes,
          }],
        },
      },
    } as MessageEvent<unknown>);

    await expect(execution.result).resolves.toMatchObject({
      status: "ok",
      workspaceDelta: {
        version: 1,
        changes: [{
          kind: "write",
          path: "main.py",
          base: payload.files[0].base,
          bytes,
        }],
      },
    });

    const runtimeWorker = new FakeWorker();
    const runtime = startPythonRun(payload, {
      runtimeAssets: runtimeAssets(),
      createWorker: () => runtimeWorker as unknown as Worker,
      runId: "run-runtime-delta",
    });
    runtimeWorker.emit("message", {
      data: {
        ...response("run-runtime-delta", "runtime-error", "boom"),
        workspaceDelta: {
          version: 1,
          changes: [{
            kind: "write",
            path: "main.py",
            base: payload.files[0].base,
            bytes,
          }],
        },
      },
    } as MessageEvent<unknown>);
    await expect(runtime.result).resolves.toMatchObject({
      status: "runtime-error",
      output: "boom",
      workspaceDelta: { changes: [expect.objectContaining({ path: "main.py" })] },
    });

    for (const [runId, workspaceDelta] of [
      [
        "run-wrong-base",
        {
          version: 1,
          changes: [{
            kind: "delete",
            path: "main.py",
            base: { ...payload.files[0].base, entryId: "other-file" },
          }],
        },
      ],
      [
        "run-unsafe-delta",
        {
          version: 1,
          changes: [{
            kind: "write",
            path: "../secret",
            base: null,
            bytes: new Uint8Array([1]),
          }],
        },
      ],
      [
        "run-oversize-delta",
        {
          version: 1,
          changes: [{
            kind: "write",
            path: "large.bin",
            base: null,
            bytes: new Uint8Array(2 * 1024 * 1024 + 1),
          }],
        },
      ],
      [
        "run-unsorted-delta",
        {
          version: 1,
          changes: [
            { kind: "write", path: "z.txt", base: null, bytes: new Uint8Array() },
            { kind: "write", path: "a.txt", base: null, bytes: new Uint8Array() },
          ],
        },
      ],
      [
        "run-duplicate-delta",
        {
          version: 1,
          changes: [
            { kind: "write", path: "same.txt", base: null, bytes: new Uint8Array() },
            { kind: "write", path: "same.txt", base: null, bytes: new Uint8Array() },
          ],
        },
      ],
      [
        "run-case-collision-delta",
        {
          version: 1,
          changes: [
            { kind: "write", path: "A.txt", base: null, bytes: new Uint8Array() },
            { kind: "write", path: "a.TXT", base: null, bytes: new Uint8Array() },
          ],
        },
      ],
    ] as const) {
      const invalidWorker = new FakeWorker();
      const invalid = startPythonRun(payload, {
        runtimeAssets: runtimeAssets(),
        createWorker: () => invalidWorker as unknown as Worker,
        runId,
      });
      invalidWorker.emit("message", {
        data: { ...response(runId), workspaceDelta },
      } as MessageEvent<unknown>);
      await expect(invalid.result).resolves.toMatchObject({
        status: "protocol-error",
      });
    }
  });

  it("accepts delta paths ordered by case-folded UTF-16 code units", async () => {
    const worker = new FakeWorker();
    const payload = workspacePayload();
    const execution = startPythonRun(payload, {
      runtimeAssets: runtimeAssets(),
      createWorker: () => worker as unknown as Worker,
      runId: "run-path-order",
    });
    const paths = [
      "-dash.txt",
      "_underscore.txt",
      "alpha.txt",
      "Zeta.txt",
      "\u00c4pfel.txt",
    ];
    worker.emit("message", {
      data: {
        ...response("run-path-order"),
        workspaceDelta: {
          version: 1,
          changes: paths.map((path) => ({
            kind: "write",
            path,
            base: null,
            bytes: new Uint8Array(),
          })),
        },
      },
    } as MessageEvent<unknown>);

    await expect(execution.result).resolves.toMatchObject({
      status: "ok",
      workspaceDelta: {
        changes: paths.map((path) => expect.objectContaining({ path })),
      },
    });
  });

  it("creates and terminates a distinct worker for every run", async () => {
    const workers: FakeWorker[] = [];
    const createWorker = () => {
      const worker = new FakeWorker();
      workers.push(worker);
      return worker as unknown as Worker;
    };
    const first = startPythonRun(
      { kind: "script", code: "print(1)" },
      { createWorker, runId: "run-one", runtimeAssets: runtimeAssets() },
    );
    workers[0].emit("message", {
      data: response("run-one"),
    } as MessageEvent<unknown>);
    await first.result;

    const second = startPythonRun(
      { kind: "script", code: "print(2)" },
      { createWorker, runId: "run-two", runtimeAssets: runtimeAssets() },
    );
    workers[1].emit("message", {
      data: response("run-two"),
    } as MessageEvent<unknown>);
    await second.result;

    expect(workers).toHaveLength(2);
    expect(workers[0]).not.toBe(workers[1]);
    expect(workers.map((worker) => worker.terminate.mock.calls.length))
      .toEqual([1, 1]);
  });

  it("preserves exact trailing newlines and empty output from the worker", async () => {
    for (const [runId, output] of [
      ["run-newline", "42\n"],
      ["run-empty", ""],
    ] as const) {
      const worker = new FakeWorker();
      const execution = startPythonRun(
        { kind: "script", code: output ? "print(42)" : "pass" },
        {
          runtimeAssets: runtimeAssets(),
          createWorker: () => worker as unknown as Worker,
          runId,
        },
      );
      worker.emit("message", {
        data: response(runId, "ok", output),
      } as MessageEvent<unknown>);
      await expect(execution.result).resolves.toMatchObject({ output });
    }
  });

  it("terminates on runtime, worker, and protocol errors", async () => {
    const runtimeWorker = new FakeWorker();
    const runtime = startPythonRun(
      { kind: "script", code: "broken" },
      {
        runtimeAssets: runtimeAssets(),
        createWorker: () => runtimeWorker as unknown as Worker,
        runId: "run-runtime-error",
      },
    );
    runtimeWorker.emit("message", {
      data: response("run-runtime-error", "runtime-error"),
    } as MessageEvent<unknown>);
    await expect(runtime.result).resolves.toMatchObject({
      status: "runtime-error",
      output: "syntax error",
    });

    const failedWorker = new FakeWorker();
    const failed = startPythonRun(
      { kind: "script", code: "print(1)" },
      {
        runtimeAssets: runtimeAssets(),
        createWorker: () => failedWorker as unknown as Worker,
        runId: "run-worker-error",
      },
    );
    failedWorker.emit("error", {
      message: "worker crashed",
    } as ErrorEvent);
    await expect(failed.result).resolves.toMatchObject({
      status: "worker-error",
      output: "worker crashed",
    });

    const protocolWorker = new FakeWorker();
    const invalid = startPythonRun(
      { kind: "script", code: "print(1)" },
      {
        runtimeAssets: runtimeAssets(),
        createWorker: () => protocolWorker as unknown as Worker,
        runId: "run-protocol-error",
      },
    );
    protocolWorker.emit("message", {
      data: { runId: "run-protocol-error", output: "untyped" },
    } as MessageEvent<unknown>);
    await expect(invalid.result).resolves.toMatchObject({
      status: "protocol-error",
    });

    expect(runtimeWorker.terminate).toHaveBeenCalledTimes(1);
    expect(failedWorker.terminate).toHaveBeenCalledTimes(1);
    expect(protocolWorker.terminate).toHaveBeenCalledTimes(1);
  });

  it("terminates on timeout and cancellation exactly once", async () => {
    vi.useFakeTimers();
    const timeoutWorker = new FakeWorker();
    const timed = startPythonRun(
      { kind: "script", code: "while True: pass" },
      {
        runtimeAssets: runtimeAssets(),
        createWorker: () => timeoutWorker as unknown as Worker,
        runId: "run-timeout",
        timeoutMs: 25,
      },
    );
    await vi.advanceTimersByTimeAsync(25);
    await expect(timed.result).resolves.toMatchObject({ status: "timeout" });
    expect(timeoutWorker.terminate).toHaveBeenCalledTimes(1);

    const cancelledWorker = new FakeWorker();
    const cancelled = startPythonRun(
      { kind: "script", code: "while True: pass" },
      {
        runtimeAssets: runtimeAssets(),
        createWorker: () => cancelledWorker as unknown as Worker,
        runId: "run-cancelled",
      },
    );
    cancelled.cancel();
    cancelled.cancel();
    await expect(cancelled.result).resolves.toMatchObject({
      status: "cancelled",
    });
    expect(cancelledWorker.terminate).toHaveBeenCalledTimes(1);
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PYTHON_TERMINAL_COMMAND_TYPE,
  PYTHON_TERMINAL_INPUT_REQUEST_TYPE,
  PYTHON_TERMINAL_OPEN_TYPE,
  PYTHON_TERMINAL_OUTPUT_TYPE,
  PYTHON_TERMINAL_PROTOCOL_VERSION,
  PYTHON_TERMINAL_READY_TYPE,
  PYTHON_TERMINAL_RESULT_TYPE,
  startPythonTerminal,
  type PythonTerminalCommandRequest,
  type PythonTerminalOpenRequest,
  type PythonTerminalWorkspace,
} from "./pythonTerminal.js";
import {
  PYTHON_RUNTIME_ASSET_MANIFEST,
  PYTHON_RUNTIME_ASSET_PROTOCOL_VERSION,
  type PythonRuntimeAssets,
} from "../pythonRunnerContract.js";
import type { OpaquePythonWorkerControl } from "./opaquePythonWorker.js";

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

const workspace: PythonTerminalWorkspace = {
  files: [{
    path: "main.py",
    base: {
      entryId: "main-py",
      contentKind: "text",
      sha256: "a".repeat(64),
      byteSize: 12,
    },
    content: "print('ok')\n",
  }],
  directories: [],
};

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

function ids(...values: string[]): () => string {
  let cursor = 0;
  return () => values[cursor++] ?? `command-${cursor}`;
}

function ready(worker: FakeWorker, sessionId = "session-a"): void {
  worker.emit("message", {
    data: {
      type: PYTHON_TERMINAL_READY_TYPE,
      protocolVersion: PYTHON_TERMINAL_PROTOCOL_VERSION,
      sessionId,
      mode: "shell",
    },
  } as MessageEvent<unknown>);
}

function result(
  worker: FakeWorker,
  commandId: string,
  mode: "shell" | "repl",
  prompt: null | ">>> " | "... " = null,
): void {
  worker.emit("message", {
    data: {
      type: PYTHON_TERMINAL_RESULT_TYPE,
      protocolVersion: PYTHON_TERMINAL_PROTOCOL_VERSION,
      sessionId: "session-a",
      commandId,
      status: "ok",
      mode,
      prompt,
      truncated: false,
      workspaceDelta: { version: 1, changes: [] },
    },
  } as MessageEvent<unknown>);
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("persistent Python terminal client", () => {
  it("opens one isolated worker and executes a safe workspace entry point", async () => {
    const worker = new FakeWorker();
    const onOutput = vi.fn();
    const terminal = startPythonTerminal(workspace, {
      runtimeAssets: runtimeAssets(),
      createWorker: () => worker as unknown as Worker,
      sessionId: "session-a",
      createCommandId: ids("run-main"),
      onOutput,
    });
    const open = worker.postMessage.mock.calls[0][0] as PythonTerminalOpenRequest;

    expect(open).toMatchObject({
      type: PYTHON_TERMINAL_OPEN_TYPE,
      protocolVersion: PYTHON_TERMINAL_PROTOCOL_VERSION,
      sessionId: "session-a",
      workspace,
    });
    expect(open.stdinControl).toBeInstanceOf(SharedArrayBuffer);
    expect(open.stdinData).toBeInstanceOf(SharedArrayBuffer);
    expect(open.interruptBuffer).toBeInstanceOf(SharedArrayBuffer);

    ready(worker);
    await expect(terminal.ready).resolves.toEqual({ status: "ready" });
    const execution = terminal.executeEntrypoint("main.py");
    await vi.waitFor(() => expect(worker.postMessage).toHaveBeenCalledTimes(2));
    expect(worker.postMessage.mock.calls[1][0]).toEqual({
      type: PYTHON_TERMINAL_COMMAND_TYPE,
      protocolVersion: PYTHON_TERMINAL_PROTOCOL_VERSION,
      sessionId: "session-a",
      commandId: "run-main",
      action: "execute",
      entrypoint: "main.py",
    });
    worker.emit("message", {
      data: {
        type: PYTHON_TERMINAL_OUTPUT_TYPE,
        protocolVersion: PYTHON_TERMINAL_PROTOCOL_VERSION,
        sessionId: "session-a",
        commandId: "run-main",
        chunk: "ok\n",
      },
    } as MessageEvent<unknown>);
    result(worker, "run-main", "shell");

    await expect(execution).resolves.toMatchObject({
      commandId: "run-main",
      status: "ok",
      output: "ok\n",
      mode: "shell",
      workspaceDelta: { version: 1, changes: [] },
    });
    expect(onOutput).toHaveBeenCalledWith({
      sessionId: "session-a",
      commandId: "run-main",
      chunk: "ok\n",
    });
    expect(worker.terminate).not.toHaveBeenCalled();
  });

  it("keeps REPL mode across lines and returns to the shell on EOF", async () => {
    const worker = new FakeWorker();
    const terminal = startPythonTerminal(workspace, {
      runtimeAssets: runtimeAssets(),
      createWorker: () => worker as unknown as Worker,
      sessionId: "session-a",
      createCommandId: ids(
        "start-repl", "line-one", "line-two", "repl-interrupt", "repl-eof",
      ),
    });
    ready(worker);
    await terminal.ready;

    const starting = terminal.startRepl();
    await vi.waitFor(() => expect(worker.postMessage).toHaveBeenCalledTimes(2));
    result(worker, "start-repl", "repl", ">>> ");
    await expect(starting).resolves.toMatchObject({ mode: "repl", prompt: ">>> " });

    const firstLine = terminal.submitReplLine("for value in [1]:");
    await vi.waitFor(() => expect(worker.postMessage).toHaveBeenCalledTimes(3));
    result(worker, "line-one", "repl", "... ");
    await expect(firstLine).resolves.toMatchObject({ mode: "repl", prompt: "... " });

    const secondLine = terminal.submitReplLine("    print(value)");
    await vi.waitFor(() => expect(worker.postMessage).toHaveBeenCalledTimes(4));
    result(worker, "line-two", "repl", "... ");
    await secondLine;

    const interrupting = terminal.interruptRepl();
    await vi.waitFor(() => expect(worker.postMessage).toHaveBeenCalledTimes(5));
    const interruptRequest = (
      worker.postMessage.mock.calls[4]![0]
    ) as PythonTerminalCommandRequest;
    expect(interruptRequest.action).toBe("repl-interrupt");
    result(worker, "repl-interrupt", "repl", ">>> ");
    await expect(interrupting).resolves.toMatchObject({ mode: "repl", prompt: ">>> " });

    const exiting = terminal.exitRepl();
    await vi.waitFor(() => expect(worker.postMessage).toHaveBeenCalledTimes(6));
    const exitRequest = worker.postMessage.mock.calls[5][0] as PythonTerminalCommandRequest;
    expect(exitRequest.action).toBe("repl-eof");
    result(worker, "repl-eof", "shell");
    await expect(exiting).resolves.toMatchObject({ mode: "shell", prompt: null });
    expect(terminal.mode()).toBe("shell");
  });

  it("accepts input only while Python is waiting and signals interrupt out of band", async () => {
    const worker = new FakeWorker();
    const onInputRequest = vi.fn();
    const terminal = startPythonTerminal(workspace, {
      runtimeAssets: runtimeAssets(),
      createWorker: () => worker as unknown as Worker,
      sessionId: "session-a",
      createCommandId: ids("run-input"),
      onInputRequest,
    });
    const open = worker.postMessage.mock.calls[0][0] as PythonTerminalOpenRequest;
    const control = new Int32Array(open.stdinControl!);
    const data = new Uint8Array(open.stdinData!);
    const interrupt = new Int32Array(open.interruptBuffer!);
    ready(worker);
    await terminal.ready;

    const execution = terminal.executeEntrypoint("main.py");
    await vi.waitFor(() => expect(worker.postMessage).toHaveBeenCalledTimes(2));
    expect(terminal.submitInput("early")).toBe(false);
    Atomics.store(control, 0, 1);
    worker.emit("message", {
      data: {
        type: PYTHON_TERMINAL_INPUT_REQUEST_TYPE,
        protocolVersion: PYTHON_TERMINAL_PROTOCOL_VERSION,
        sessionId: "session-a",
        commandId: "run-input",
        requestId: "stdin-1",
      },
    } as MessageEvent<unknown>);
    expect(onInputRequest).toHaveBeenCalledWith({
      sessionId: "session-a",
      commandId: "run-input",
      requestId: "stdin-1",
    });
    expect(terminal.submitInput("Ada")).toBe(true);
    expect(Atomics.load(control, 0)).toBe(2);
    const byteLength = Atomics.load(control, 1);
    expect(new TextDecoder().decode(data.slice(0, byteLength))).toBe("Ada");
    expect(terminal.interrupt()).toBe(true);
    expect(terminal.interrupt()).toBe(false);
    expect(Atomics.load(interrupt, 0)).toBe(2);
    result(worker, "run-input", "shell");
    await expect(execution).resolves.toMatchObject({ status: "interrupted" });
  });

  it("uses bounded controls without parent-realm shared buffers", async () => {
    const worker = new FakeOpaqueWorker();
    const terminal = startPythonTerminal(workspace, {
      runtimeAssets: runtimeAssets(),
      createWorker: () => worker as unknown as Worker,
      sessionId: "session-a",
      createCommandId: ids("run-input"),
    });
    const open = worker.postMessage.mock.calls[0][0] as Record<string, unknown>;
    expect(open).not.toHaveProperty("stdinControl");
    expect(open).not.toHaveProperty("stdinData");
    expect(open).not.toHaveProperty("interruptBuffer");
    ready(worker);
    await terminal.ready;

    const execution = terminal.executeEntrypoint("main.py");
    await vi.waitFor(() => expect(worker.postMessage).toHaveBeenCalledTimes(2));
    worker.emit("message", {
      data: {
        type: PYTHON_TERMINAL_INPUT_REQUEST_TYPE,
        protocolVersion: PYTHON_TERMINAL_PROTOCOL_VERSION,
        sessionId: "session-a",
        commandId: "run-input",
        requestId: "stdin-1",
      },
    } as MessageEvent<unknown>);
    expect(terminal.submitInput("Ada")).toBe(true);
    expect(worker.submitPythonInput).toHaveBeenCalledWith("Ada");
    expect(terminal.interrupt()).toBe(true);
    expect(worker.interruptPython).toHaveBeenCalledOnce();
    result(worker, "run-input", "shell");
    await expect(execution).resolves.toMatchObject({ status: "interrupted" });
  });

  it("wakes a worker blocked in input when the shared run is interrupted", async () => {
    const worker = new FakeWorker();
    const terminal = startPythonTerminal(workspace, {
      runtimeAssets: runtimeAssets(),
      createWorker: () => worker as unknown as Worker,
      sessionId: "session-a",
      createCommandId: ids("run-input"),
    });
    const open = worker.postMessage.mock.calls[0][0] as PythonTerminalOpenRequest;
    const control = new Int32Array(open.stdinControl!);
    ready(worker);
    await terminal.ready;

    const execution = terminal.executeEntrypoint("main.py");
    await vi.waitFor(() => expect(worker.postMessage).toHaveBeenCalledTimes(2));
    Atomics.store(control, 0, 1);
    worker.emit("message", {
      data: {
        type: PYTHON_TERMINAL_INPUT_REQUEST_TYPE,
        protocolVersion: PYTHON_TERMINAL_PROTOCOL_VERSION,
        sessionId: "session-a",
        commandId: "run-input",
        requestId: "stdin-1",
      },
    } as MessageEvent<unknown>);

    expect(terminal.interrupt()).toBe(true);
    expect(Atomics.load(control, 0)).toBe(3);
    result(worker, "run-input", "shell");
    await expect(execution).resolves.toMatchObject({ status: "interrupted" });
  });

  it("rejects concurrent and unsafe commands without posting them", async () => {
    const worker = new FakeWorker();
    const terminal = startPythonTerminal(workspace, {
      runtimeAssets: runtimeAssets(),
      createWorker: () => worker as unknown as Worker,
      sessionId: "session-a",
      createCommandId: ids("active", "busy", "unsafe"),
    });
    ready(worker);
    await terminal.ready;
    const active = terminal.executeEntrypoint("main.py");
    await vi.waitFor(() => expect(worker.postMessage).toHaveBeenCalledTimes(2));
    await expect(terminal.startRepl()).resolves.toMatchObject({ status: "busy" });
    result(worker, "active", "shell");
    await active;
    await expect(terminal.executeEntrypoint("../secret.py")).resolves.toMatchObject({
      status: "invalid-state",
    });
    expect(worker.postMessage).toHaveBeenCalledTimes(2);
  });

  it("fails closed on an untrusted delta and on the per-command timeout", async () => {
    const invalidWorker = new FakeWorker();
    const invalid = startPythonTerminal(workspace, {
      runtimeAssets: runtimeAssets(),
      createWorker: () => invalidWorker as unknown as Worker,
      sessionId: "session-a",
      createCommandId: ids("invalid-delta"),
    });
    ready(invalidWorker);
    await invalid.ready;
    const invalidResult = invalid.executeEntrypoint("main.py");
    await vi.waitFor(() => expect(invalidWorker.postMessage).toHaveBeenCalledTimes(2));
    invalidWorker.emit("message", {
      data: {
        type: PYTHON_TERMINAL_RESULT_TYPE,
        protocolVersion: PYTHON_TERMINAL_PROTOCOL_VERSION,
        sessionId: "session-a",
        commandId: "invalid-delta",
        status: "ok",
        mode: "shell",
        prompt: null,
        truncated: false,
        workspaceDelta: {
          version: 1,
          changes: [{ kind: "write", path: "../secret", base: null, bytes: new Uint8Array() }],
        },
      },
    } as MessageEvent<unknown>);
    await expect(invalidResult).resolves.toMatchObject({ status: "protocol-error" });
    expect(invalidWorker.terminate).toHaveBeenCalledOnce();

    vi.useFakeTimers();
    const timeoutWorker = new FakeWorker();
    const timeout = startPythonTerminal(workspace, {
      runtimeAssets: runtimeAssets(),
      createWorker: () => timeoutWorker as unknown as Worker,
      sessionId: "session-timeout",
      createCommandId: ids("slow"),
      commandTimeoutMs: 25,
    });
    ready(timeoutWorker, "session-timeout");
    await timeout.ready;
    const timed = timeout.executeEntrypoint("main.py");
    await vi.advanceTimersByTimeAsync(25);
    await expect(timed).resolves.toMatchObject({ status: "timeout", mode: "closed" });
    expect(timeoutWorker.terminate).toHaveBeenCalledOnce();
  });
});

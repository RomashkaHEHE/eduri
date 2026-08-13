import {
  PYTHON_TERMINAL_PROTOCOL_VERSION,
  PYTHON_TERMINAL_WORKER_URL,
  type PythonRuntimeAssets,
} from "../pythonRunnerContract.js";
import type {
  PythonRunnerDirectory,
  PythonRunnerFile,
  PythonRunnerFileBaseIdentity,
  PythonWorkspaceDelta,
  PythonWorkspaceDeltaChange,
} from "./pythonRunner.js";
import {
  loadPythonRuntimeAssets,
  pythonRuntimeAssetTransferList,
} from "./pythonRuntimeAssets.js";
import {
  createOpaquePythonWorker,
  opaquePythonWorkerControl,
  type OpaquePythonWorkerControl,
} from "./opaquePythonWorker.js";

export {
  PYTHON_TERMINAL_PROTOCOL_VERSION,
  PYTHON_TERMINAL_WORKER_URL,
} from "../pythonRunnerContract.js";

export const PYTHON_TERMINAL_OPEN_TYPE = "eduri.python-terminal.open" as const;
export const PYTHON_TERMINAL_COMMAND_TYPE = "eduri.python-terminal.command" as const;
export const PYTHON_TERMINAL_READY_TYPE = "eduri.python-terminal.ready" as const;
export const PYTHON_TERMINAL_OUTPUT_TYPE = "eduri.python-terminal.output" as const;
export const PYTHON_TERMINAL_INPUT_REQUEST_TYPE =
  "eduri.python-terminal.input-request" as const;
export const PYTHON_TERMINAL_RESULT_TYPE = "eduri.python-terminal.result" as const;
export const PYTHON_TERMINAL_FATAL_TYPE = "eduri.python-terminal.fatal" as const;

export const PYTHON_TERMINAL_COMMAND_TIMEOUT_MS = 45_000;
export const PYTHON_TERMINAL_INITIALIZATION_TIMEOUT_MS = 120_000;
export const PYTHON_TERMINAL_MAX_INPUT_LINE_BYTES = 64 * 1024;
export const PYTHON_TERMINAL_MAX_INPUT_BYTES = 1024 * 1024;
export const PYTHON_TERMINAL_OUTPUT_TRUNCATION_MARKER = "\n[Output truncated]";

const PYTHON_STDIN_CONTROL_BYTES = Int32Array.BYTES_PER_ELEMENT * 2;
const PYTHON_INTERRUPT_BYTES = Int32Array.BYTES_PER_ELEMENT;
const PYTHON_STDIN_WAITING = 1;
const PYTHON_STDIN_VALUE = 2;
const PYTHON_STDIN_EOF = 3;
const MAX_OUTPUT_CHARS = 256 * 1024;
const MAX_OUTPUT_CHUNK_CHARS = 64 * 1024;
const MAX_INPUT_REQUESTS = 4_096;
const ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/u;
const ENTRY_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/u;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const FORBIDDEN_PATH_CHARACTER_PATTERN = /[\\\u0000-\u001f\u007f]/u;

const WORKSPACE_LIMITS = Object.freeze({
  maxEntries: 512,
  maxFileBytes: 2 * 1024 * 1024,
  maxTotalBytes: 8 * 1024 * 1024,
  maxPathCodeUnits: 1024,
  maxDepth: 32,
});

export interface PythonTerminalWorkspace {
  readonly files: readonly PythonRunnerFile[];
  readonly directories: readonly PythonRunnerDirectory[];
}

export interface PythonTerminalOpenRequest {
  readonly type: typeof PYTHON_TERMINAL_OPEN_TYPE;
  readonly protocolVersion: typeof PYTHON_TERMINAL_PROTOCOL_VERSION;
  readonly sessionId: string;
  readonly workspace: PythonTerminalWorkspace;
  readonly runtimeAssets: PythonRuntimeAssets;
  /** Present only for an explicitly injected, non-opaque worker. */
  readonly stdinControl?: SharedArrayBuffer;
  readonly stdinData?: SharedArrayBuffer;
  readonly interruptBuffer?: SharedArrayBuffer;
}

export type PythonTerminalCommandRequest = {
  readonly type: typeof PYTHON_TERMINAL_COMMAND_TYPE;
  readonly protocolVersion: typeof PYTHON_TERMINAL_PROTOCOL_VERSION;
  readonly sessionId: string;
  readonly commandId: string;
} & (
  | { readonly action: "execute"; readonly entrypoint: string }
  | { readonly action: "start-repl" }
  | { readonly action: "repl-line"; readonly line: string }
  | { readonly action: "repl-interrupt" }
  | { readonly action: "repl-eof" }
);

export interface PythonTerminalReadyMessage {
  readonly type: typeof PYTHON_TERMINAL_READY_TYPE;
  readonly protocolVersion: typeof PYTHON_TERMINAL_PROTOCOL_VERSION;
  readonly sessionId: string;
  readonly mode: "shell";
}

export interface PythonTerminalOutputMessage {
  readonly type: typeof PYTHON_TERMINAL_OUTPUT_TYPE;
  readonly protocolVersion: typeof PYTHON_TERMINAL_PROTOCOL_VERSION;
  readonly sessionId: string;
  readonly commandId: string;
  readonly chunk: string;
}

export interface PythonTerminalInputRequestMessage {
  readonly type: typeof PYTHON_TERMINAL_INPUT_REQUEST_TYPE;
  readonly protocolVersion: typeof PYTHON_TERMINAL_PROTOCOL_VERSION;
  readonly sessionId: string;
  readonly commandId: string;
  readonly requestId: string;
}

export interface PythonTerminalResultMessage {
  readonly type: typeof PYTHON_TERMINAL_RESULT_TYPE;
  readonly protocolVersion: typeof PYTHON_TERMINAL_PROTOCOL_VERSION;
  readonly sessionId: string;
  readonly commandId: string;
  readonly status: "ok" | "runtime-error";
  readonly mode: "shell" | "repl";
  readonly prompt: null | ">>> " | "... ";
  readonly truncated: boolean;
  readonly workspaceDelta: PythonWorkspaceDelta;
}

export interface PythonTerminalFatalMessage {
  readonly type: typeof PYTHON_TERMINAL_FATAL_TYPE;
  readonly protocolVersion: typeof PYTHON_TERMINAL_PROTOCOL_VERSION;
  readonly sessionId: string;
  readonly message: string;
}

export type PythonTerminalMode = "starting" | "shell" | "repl" | "closed";
export type PythonTerminalCommandStatus =
  | PythonTerminalResultMessage["status"]
  | "busy"
  | "invalid-state"
  | "worker-error"
  | "protocol-error"
  | "timeout"
  | "cancelled"
  | "interrupted";

export type PythonTerminalReadyResult =
  | { readonly status: "ready" }
  | {
      readonly status: "worker-error" | "protocol-error" | "timeout" | "cancelled";
      readonly message: string;
    };

export interface PythonTerminalCommandResult {
  readonly commandId: string;
  readonly status: PythonTerminalCommandStatus;
  readonly output: string;
  readonly truncated: boolean;
  readonly mode: Exclude<PythonTerminalMode, "starting">;
  readonly prompt: null | ">>> " | "... ";
  readonly workspaceDelta?: PythonWorkspaceDelta;
}

export interface PythonTerminalOptions {
  readonly createWorker?: () => Worker;
  readonly sessionId?: string;
  readonly createCommandId?: () => string;
  readonly commandTimeoutMs?: number;
  readonly initializationTimeoutMs?: number;
  /** Preverified assets for embedding/tests; normal callers use the loader. */
  readonly runtimeAssets?: PythonRuntimeAssets;
  readonly loadRuntimeAssets?: () => Promise<PythonRuntimeAssets>;
  readonly onOutput?: (event: Readonly<{
    sessionId: string;
    commandId: string;
    chunk: string;
  }>) => void;
  readonly onInputRequest?: (event: Readonly<{
    sessionId: string;
    commandId: string;
    requestId: string;
  }>) => void;
  readonly onModeChange?: (mode: PythonTerminalMode) => void;
}

export interface PythonTerminalHandle {
  readonly sessionId: string;
  readonly ready: Promise<PythonTerminalReadyResult>;
  mode(): PythonTerminalMode;
  executeEntrypoint(entrypoint: string): Promise<PythonTerminalCommandResult>;
  startRepl(): Promise<PythonTerminalCommandResult>;
  submitReplLine(line: string): Promise<PythonTerminalCommandResult>;
  interruptRepl(): Promise<PythonTerminalCommandResult>;
  exitRepl(): Promise<PythonTerminalCommandResult>;
  submitInput(value: string): boolean;
  sendEof(): boolean;
  interrupt(): boolean;
  close(): void;
}

interface ActiveCommand {
  readonly commandId: string;
  readonly resolve: (result: PythonTerminalCommandResult) => void;
  output: string;
  outputChars: number;
  interrupted: boolean;
  timer: ReturnType<typeof globalThis.setTimeout> | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function safeWorkspacePath(path: unknown): path is string {
  if (
    typeof path !== "string"
    || path.length < 1
    || path.length > WORKSPACE_LIMITS.maxPathCodeUnits
    || path.startsWith("/")
    || FORBIDDEN_PATH_CHARACTER_PATTERN.test(path)
  ) return false;
  const segments = path.split("/");
  return segments.length <= WORKSPACE_LIMITS.maxDepth + 1
    && segments.every((segment) => (
      segment.length > 0
      && segment !== "."
      && segment !== ".."
      && segment.length <= 128
      && segment === segment.normalize("NFKC").trim()
    ));
}

function comparablePath(path: string): string {
  return path.toLocaleLowerCase("en-US");
}

function byteView(value: unknown): Uint8Array | null {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (!ArrayBuffer.isView(value)) return null;
  return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
}

function sameBaseIdentity(
  value: unknown,
  expected: PythonRunnerFileBaseIdentity,
): boolean {
  if (!isRecord(value)) return false;
  return value.entryId === expected.entryId
    && value.contentKind === expected.contentKind
    && value.sha256 === expected.sha256
    && value.byteSize === expected.byteSize;
}

function parseWorkspaceDelta(
  value: unknown,
  workspace: PythonTerminalWorkspace,
): PythonWorkspaceDelta | null {
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.changes)) {
    return null;
  }
  if (value.changes.length > WORKSPACE_LIMITS.maxEntries * 2) return null;
  const baselineByPath = new Map(workspace.files.map((file) => (
    [comparablePath(file.path), file] as const
  )));
  const changes: PythonWorkspaceDeltaChange[] = [];
  let previousPath: string | null = null;
  let totalBytes = 0;
  for (const candidate of value.changes) {
    if (!isRecord(candidate) || !safeWorkspacePath(candidate.path)) return null;
    const pathKey = comparablePath(candidate.path);
    if (previousPath !== null && pathKey <= previousPath) return null;
    previousPath = pathKey;
    const baseline = baselineByPath.get(pathKey);
    if (candidate.kind === "delete") {
      if (!baseline || !sameBaseIdentity(candidate.base, baseline.base)) return null;
      changes.push({
        kind: "delete",
        path: candidate.path,
        base: { ...baseline.base },
      });
      continue;
    }
    if (candidate.kind !== "write") return null;
    if (
      (baseline && !sameBaseIdentity(candidate.base, baseline.base))
      || (!baseline && candidate.base !== null)
    ) return null;
    const bytes = byteView(candidate.bytes);
    if (!bytes || bytes.byteLength > WORKSPACE_LIMITS.maxFileBytes) return null;
    totalBytes += bytes.byteLength;
    if (totalBytes > WORKSPACE_LIMITS.maxTotalBytes) return null;
    changes.push({
      kind: "write",
      path: candidate.path,
      base: baseline ? { ...baseline.base } : null,
      bytes: bytes.slice(),
    });
  }
  return { version: 1, changes };
}

function localResult(
  commandId: string,
  status: PythonTerminalCommandStatus,
  output: string,
  mode: Exclude<PythonTerminalMode, "starting">,
): PythonTerminalCommandResult {
  return { commandId, status, output, truncated: false, mode, prompt: null };
}

export function startPythonTerminal(
  workspace: PythonTerminalWorkspace,
  options: PythonTerminalOptions = {},
): PythonTerminalHandle {
  const sessionId = options.sessionId ?? crypto.randomUUID();
  if (!ID_PATTERN.test(sessionId)) throw new Error("Python terminal session ID is invalid");
  const createCommandId = options.createCommandId ?? (() => crypto.randomUUID());
  let currentMode: PythonTerminalMode = "starting";
  let active: ActiveCommand | null = null;
  let closed = false;
  let readySettled = false;
  let resolveReady!: (result: PythonTerminalReadyResult) => void;
  const ready = new Promise<PythonTerminalReadyResult>((resolve) => {
    resolveReady = resolve;
  });
  let waitingInputRequestId: string | null = null;
  let inputRequestCount = 0;
  let submittedInputBytes = 0;

  let worker: Worker | null = null;
  let creationError: string | null = null;
  try {
    worker = options.createWorker?.() ?? createOpaquePythonWorker("terminal");
  } catch (error) {
    creationError = error instanceof Error
      ? error.message
      : "Python terminal worker could not start.";
  }
  const opaqueControl: OpaquePythonWorkerControl | null = worker
    ? opaquePythonWorkerControl(worker)
    : null;
  const unavailable = !opaqueControl && typeof SharedArrayBuffer !== "function";
  let stdinControlBuffer: SharedArrayBuffer | null = null;
  let stdinDataBuffer: SharedArrayBuffer | null = null;
  let interruptBuffer: SharedArrayBuffer | null = null;
  if (!creationError && !unavailable && !opaqueControl) {
    stdinControlBuffer = new SharedArrayBuffer(PYTHON_STDIN_CONTROL_BYTES);
    stdinDataBuffer = new SharedArrayBuffer(PYTHON_TERMINAL_MAX_INPUT_LINE_BYTES);
    interruptBuffer = new SharedArrayBuffer(PYTHON_INTERRUPT_BYTES);
  }
  const stdinControl = stdinControlBuffer ? new Int32Array(stdinControlBuffer) : null;
  const stdinData = stdinDataBuffer ? new Uint8Array(stdinDataBuffer) : null;
  const interrupt = interruptBuffer ? new Int32Array(interruptBuffer) : null;

  let initializationTimer: ReturnType<typeof globalThis.setTimeout> | null = null;

  const setMode = (next: PythonTerminalMode): void => {
    if (currentMode === next) return;
    currentMode = next;
    options.onModeChange?.(next);
  };
  const settleReady = (result: PythonTerminalReadyResult): void => {
    if (readySettled) return;
    readySettled = true;
    resolveReady(result);
  };
  const cleanupWorker = (): void => {
    if (initializationTimer !== null) globalThis.clearTimeout(initializationTimer);
    initializationTimer = null;
    if (!worker) return;
    worker.removeEventListener("message", receive);
    worker.removeEventListener("messageerror", messageFailed);
    worker.removeEventListener("error", failed);
    worker.terminate();
    worker = null;
  };
  const finishSession = (
    status: "worker-error" | "protocol-error" | "timeout" | "cancelled",
    message: string,
  ): void => {
    if (closed) return;
    closed = true;
    waitingInputRequestId = null;
    if (stdinControl) {
      Atomics.store(stdinControl, 0, PYTHON_STDIN_EOF);
      Atomics.notify(stdinControl, 0);
    }
    if (active) {
      if (active.timer !== null) globalThis.clearTimeout(active.timer);
      active.resolve(localResult(active.commandId, status, message, "closed"));
      active = null;
    }
    settleReady({ status, message });
    setMode("closed");
    cleanupWorker();
  };

  const receive = (event: MessageEvent<unknown>): void => {
    if (!isRecord(event.data)) {
      finishSession("protocol-error", "Python terminal worker returned invalid data.");
      return;
    }
    const message = event.data;
    if (
      message.protocolVersion !== PYTHON_TERMINAL_PROTOCOL_VERSION
      || message.sessionId !== sessionId
    ) {
      finishSession("protocol-error", "Python terminal worker protocol mismatch.");
      return;
    }
    if (message.type === PYTHON_TERMINAL_READY_TYPE) {
      if (readySettled || currentMode !== "starting" || message.mode !== "shell") {
        finishSession("protocol-error", "Python terminal worker sent an unexpected ready event.");
        return;
      }
      if (initializationTimer !== null) globalThis.clearTimeout(initializationTimer);
      initializationTimer = null;
      setMode("shell");
      settleReady({ status: "ready" });
      return;
    }
    if (message.type === PYTHON_TERMINAL_FATAL_TYPE) {
      if (typeof message.message !== "string" || message.message.length > 4_096) {
        finishSession("protocol-error", "Python terminal worker sent an invalid failure.");
      } else {
        finishSession("worker-error", message.message);
      }
      return;
    }
    if (
      !active
      || message.commandId !== active.commandId
      || typeof message.commandId !== "string"
    ) {
      finishSession("protocol-error", "Python terminal worker sent an event for no active command.");
      return;
    }
    if (message.type === PYTHON_TERMINAL_OUTPUT_TYPE) {
      if (
        typeof message.chunk !== "string"
        || message.chunk.length < 1
        || message.chunk.length > MAX_OUTPUT_CHUNK_CHARS
        || active.outputChars + message.chunk.length > MAX_OUTPUT_CHARS
      ) {
        finishSession("protocol-error", "Python terminal worker streamed too much output.");
        return;
      }
      active.output += message.chunk;
      active.outputChars += message.chunk.length;
      options.onOutput?.({ sessionId, commandId: active.commandId, chunk: message.chunk });
      return;
    }
    if (message.type === PYTHON_TERMINAL_INPUT_REQUEST_TYPE) {
      if (
        typeof message.requestId !== "string"
        || !ID_PATTERN.test(message.requestId)
        || waitingInputRequestId !== null
        || (
          !opaqueControl
          && (
            !stdinControl
            || Atomics.load(stdinControl, 0) !== PYTHON_STDIN_WAITING
          )
        )
      ) {
        finishSession("protocol-error", "Python terminal worker sent an invalid input request.");
        return;
      }
      inputRequestCount += 1;
      if (inputRequestCount > MAX_INPUT_REQUESTS) {
        finishSession("protocol-error", "Python terminal requested too many input lines.");
        return;
      }
      waitingInputRequestId = message.requestId;
      options.onInputRequest?.({
        sessionId,
        commandId: active.commandId,
        requestId: message.requestId,
      });
      return;
    }
    if (message.type !== PYTHON_TERMINAL_RESULT_TYPE) {
      finishSession("protocol-error", "Python terminal worker sent an unknown event.");
      return;
    }
    const validStatus = message.status === "ok" || message.status === "runtime-error";
    const validMode = message.mode === "shell" || message.mode === "repl";
    const validPrompt = message.mode === "shell"
      ? message.prompt === null
      : message.prompt === ">>> " || message.prompt === "... ";
    const delta = parseWorkspaceDelta(message.workspaceDelta, workspace);
    if (!validStatus || !validMode || !validPrompt || typeof message.truncated !== "boolean" || !delta) {
      finishSession("protocol-error", "Python terminal worker returned an invalid command result.");
      return;
    }
    const resultStatus = message.status as "ok" | "runtime-error";
    const resultMode = message.mode as "shell" | "repl";
    const resultPrompt = message.prompt as null | ">>> " | "... ";
    const resultTruncated = message.truncated as boolean;
    const completed = active;
    active = null;
    waitingInputRequestId = null;
    if (completed.timer !== null) globalThis.clearTimeout(completed.timer);
    setMode(resultMode);
    completed.resolve({
      commandId: completed.commandId,
      status: completed.interrupted ? "interrupted" : resultStatus,
      output: completed.output,
      truncated: resultTruncated,
      mode: resultMode,
      prompt: resultPrompt,
      workspaceDelta: delta,
    });
  };
  const failed = (event: ErrorEvent): void => {
    finishSession("worker-error", event.message || "Python terminal worker failed.");
  };
  const messageFailed = (): void => {
    finishSession("protocol-error", "Python terminal worker response could not be decoded.");
  };

  if (creationError) {
    queueMicrotask(() => finishSession("worker-error", creationError!));
  } else if (unavailable) {
    queueMicrotask(() => finishSession(
      "worker-error",
      "Interactive Python is unavailable in this browser context.",
    ));
  } else {
    try {
      if (!worker) throw new Error("Python terminal worker could not start.");
      worker.addEventListener("message", receive);
      worker.addEventListener("messageerror", messageFailed);
      worker.addEventListener("error", failed);
      initializationTimer = globalThis.setTimeout(() => {
        finishSession("timeout", "Python terminal initialization timed out.");
      }, options.initializationTimeoutMs ?? PYTHON_TERMINAL_INITIALIZATION_TIMEOUT_MS);
      const postOpen = (runtimeAssets: PythonRuntimeAssets): void => {
        if (closed || !worker) return;
        const request: PythonTerminalOpenRequest = {
          type: PYTHON_TERMINAL_OPEN_TYPE,
          protocolVersion: PYTHON_TERMINAL_PROTOCOL_VERSION,
          sessionId,
          workspace,
          runtimeAssets,
          ...(stdinControlBuffer && stdinDataBuffer && interruptBuffer
            ? {
                stdinControl: stdinControlBuffer,
                stdinData: stdinDataBuffer,
                interruptBuffer,
              }
            : {}),
        };
        worker.postMessage(
          request,
          [...pythonRuntimeAssetTransferList(runtimeAssets)],
        );
      };
      if (options.runtimeAssets) {
        postOpen(options.runtimeAssets);
      } else {
        const runtimeAssetLoader = options.loadRuntimeAssets ?? loadPythonRuntimeAssets;
        void runtimeAssetLoader().then(postOpen).catch(() => {
          finishSession(
            "worker-error",
            "Pinned Python runtime assets could not be loaded or verified.",
          );
        });
      }
    } catch (error) {
      queueMicrotask(() => finishSession(
        "worker-error",
        error instanceof Error ? error.message : "Python terminal worker could not start.",
      ));
    }
  }

  const issue = async (
    action: "execute" | "start-repl" | "repl-line" | "repl-interrupt" | "repl-eof",
    fields: Readonly<{ entrypoint?: string; line?: string }> = {},
  ): Promise<PythonTerminalCommandResult> => {
    const commandId = createCommandId();
    if (!ID_PATTERN.test(commandId)) {
      throw new Error("Python terminal command ID is invalid");
    }
    const readyResult = await ready;
    if (readyResult.status !== "ready" || closed || currentMode === "closed") {
      return localResult(
        commandId,
        readyResult.status === "ready" ? "cancelled" : readyResult.status,
        readyResult.status === "ready" ? "Python terminal is closed." : readyResult.message,
        "closed",
      );
    }
    if (currentMode === "starting") {
      return localResult(commandId, "invalid-state", "Python terminal is still starting.", "shell");
    }
    const availableMode: "shell" | "repl" = currentMode;
    if (active) {
      return localResult(commandId, "busy", "Python terminal is busy.", availableMode);
    }
    const expectsShell = action === "execute" || action === "start-repl";
    if (
      (expectsShell && currentMode !== "shell")
      || (!expectsShell && currentMode !== "repl")
    ) {
      return localResult(commandId, "invalid-state", "Python terminal mode does not allow this command.", availableMode);
    }
    if (action === "execute" && !safeWorkspacePath(fields.entrypoint)) {
      return localResult(commandId, "invalid-state", "Python entry point is invalid.", availableMode);
    }
    if (
      action === "repl-line"
      && (typeof fields.line !== "string" || new TextEncoder().encode(fields.line).byteLength > PYTHON_TERMINAL_MAX_INPUT_LINE_BYTES)
    ) {
      return localResult(commandId, "invalid-state", "Python input line is too long.", availableMode);
    }
    return new Promise<PythonTerminalCommandResult>((resolve) => {
      const command: ActiveCommand = {
        commandId,
        resolve,
        output: "",
        outputChars: 0,
        interrupted: false,
        timer: null,
      };
      active = command;
      if (interrupt) Atomics.store(interrupt, 0, 0);
      command.timer = globalThis.setTimeout(() => {
        finishSession("timeout", "Python command exceeded the 45 second execution limit.");
      }, options.commandTimeoutMs ?? PYTHON_TERMINAL_COMMAND_TIMEOUT_MS);
      const request: PythonTerminalCommandRequest = {
        type: PYTHON_TERMINAL_COMMAND_TYPE,
        protocolVersion: PYTHON_TERMINAL_PROTOCOL_VERSION,
        sessionId,
        commandId,
        action,
        ...(action === "execute" ? { entrypoint: fields.entrypoint! } : {}),
        ...(action === "repl-line" ? { line: fields.line! } : {}),
      } as PythonTerminalCommandRequest;
      try {
        worker?.postMessage(request);
      } catch (error) {
        finishSession(
          "worker-error",
          error instanceof Error ? error.message : "Python terminal command could not start.",
        );
      }
    });
  };

  return {
    sessionId,
    ready,
    mode: () => currentMode,
    executeEntrypoint: (entrypoint) => issue("execute", { entrypoint }),
    startRepl: () => issue("start-repl"),
    submitReplLine: (line) => issue("repl-line", { line }),
    interruptRepl: () => issue("repl-interrupt"),
    exitRepl: () => issue("repl-eof"),
    submitInput: (value) => {
      if (
        closed
        || !active
        || waitingInputRequestId === null
      ) return false;
      const bytes = new TextEncoder().encode(value);
      if (
        bytes.byteLength > PYTHON_TERMINAL_MAX_INPUT_LINE_BYTES
        || submittedInputBytes + bytes.byteLength > PYTHON_TERMINAL_MAX_INPUT_BYTES
      ) return false;
      if (opaqueControl) {
        if (!opaqueControl.submitPythonInput(value)) return false;
      } else {
        if (
          !stdinControl
          || !stdinData
          || Atomics.load(stdinControl, 0) !== PYTHON_STDIN_WAITING
        ) return false;
        stdinData.fill(0);
        stdinData.set(bytes);
        Atomics.store(stdinControl, 1, bytes.byteLength);
        Atomics.store(stdinControl, 0, PYTHON_STDIN_VALUE);
        Atomics.notify(stdinControl, 0);
      }
      submittedInputBytes += bytes.byteLength;
      waitingInputRequestId = null;
      return true;
    },
    sendEof: () => {
      if (
        closed
        || !active
        || waitingInputRequestId === null
      ) return false;
      if (opaqueControl) {
        if (!opaqueControl.sendPythonEof()) return false;
      } else {
        if (
          !stdinControl
          || Atomics.load(stdinControl, 0) !== PYTHON_STDIN_WAITING
        ) return false;
        Atomics.store(stdinControl, 1, 0);
        Atomics.store(stdinControl, 0, PYTHON_STDIN_EOF);
        Atomics.notify(stdinControl, 0);
      }
      waitingInputRequestId = null;
      return true;
    },
    interrupt: () => {
      if (closed || !active || active.interrupted) return false;
      if (opaqueControl) {
        if (!opaqueControl.interruptPython()) return false;
      } else {
        if (!interrupt) return false;
        Atomics.store(interrupt, 0, 2);
      }
      active.interrupted = true;
      if (
        !opaqueControl
        && stdinControl
        && waitingInputRequestId !== null
        && Atomics.load(stdinControl, 0) === PYTHON_STDIN_WAITING
      ) {
        waitingInputRequestId = null;
        Atomics.store(stdinControl, 1, 0);
        Atomics.store(stdinControl, 0, PYTHON_STDIN_EOF);
        Atomics.notify(stdinControl, 0);
      }
      if (opaqueControl) waitingInputRequestId = null;
      return true;
    },
    close: () => finishSession("cancelled", "Python terminal was closed."),
  };
}

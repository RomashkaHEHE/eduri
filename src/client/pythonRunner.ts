import {
  PYTHON_RUNNER_PROTOCOL_VERSION,
  PYTHON_RUNNER_WORKER_URL,
  type PythonRuntimeAssets,
} from "../pythonRunnerContract.js";
import {
  loadPythonRuntimeAssets,
  pythonRuntimeAssetTransferList,
} from "./pythonRuntimeAssets.js";
import {
  createOpaquePythonWorker,
  opaquePythonWorkerControl,
} from "./opaquePythonWorker.js";

export {
  PYTHON_RUNNER_PROTOCOL_VERSION,
  PYTHON_RUNNER_WORKER_URL,
} from "../pythonRunnerContract.js";
export const PYTHON_WORKSPACE_DELTA_VERSION = 1 as const;
export const PYTHON_RUNNER_REQUEST_TYPE = "eduri.python.run" as const;
export const PYTHON_RUNNER_RESULT_TYPE = "eduri.python.result" as const;
export const PYTHON_RUNNER_OUTPUT_TYPE = "eduri.python.output" as const;
export const PYTHON_RUNNER_INPUT_REQUEST_TYPE = "eduri.python.input-request" as const;
export const PYTHON_RUNNER_TIMEOUT_MS = 45_000;
export const PYTHON_RUNNER_MAX_INPUT_LINE_BYTES = 64 * 1024;
export const PYTHON_RUNNER_MAX_INPUT_BYTES = 1024 * 1024;

const PYTHON_STDIN_CONTROL_BYTES = Int32Array.BYTES_PER_ELEMENT * 2;
const PYTHON_STDIN_IDLE = 0;
const PYTHON_STDIN_WAITING = 1;
const PYTHON_STDIN_VALUE = 2;
const PYTHON_STDIN_EOF = 3;

export const PYTHON_RUNNER_WORKSPACE_LIMITS = Object.freeze({
  maxEntries: 512,
  maxFileBytes: 2 * 1024 * 1024,
  maxTotalBytes: 8 * 1024 * 1024,
  maxPathCodeUnits: 1024,
  maxDepth: 32,
});

export interface PythonRunnerFileBaseIdentity {
  readonly entryId: string;
  readonly contentKind: "text" | "blob";
  readonly sha256: string;
  readonly byteSize: number;
}

export type PythonRunnerFile =
  | {
      readonly path: string;
      readonly base: PythonRunnerFileBaseIdentity;
      readonly content: string;
      readonly bytes?: never;
    }
  | {
      readonly path: string;
      readonly base: PythonRunnerFileBaseIdentity;
      readonly content?: never;
      readonly bytes: Uint8Array;
    };

export interface PythonRunnerDirectory {
  readonly path: string;
  readonly entryId: string;
}

export type PythonRunPayload =
  | {
    readonly kind: "script";
    readonly code: string;
  }
  | {
    readonly kind: "workspace";
    readonly files: readonly PythonRunnerFile[];
      readonly directories: readonly PythonRunnerDirectory[];
      readonly entrypoint: string;
      /** A string is deterministic test input; null enables live terminal input. */
      readonly stdin: string | null;
    };

export type PythonWorkspaceDeltaChange =
  | {
      readonly kind: "write";
      readonly path: string;
      readonly base: PythonRunnerFileBaseIdentity | null;
      readonly bytes: Uint8Array;
    }
  | {
      readonly kind: "delete";
      readonly path: string;
      readonly base: PythonRunnerFileBaseIdentity;
      readonly bytes?: never;
    };

export interface PythonWorkspaceDelta {
  readonly version: typeof PYTHON_WORKSPACE_DELTA_VERSION;
  readonly changes: readonly PythonWorkspaceDeltaChange[];
}

export interface PythonRunnerRequest {
  readonly type: typeof PYTHON_RUNNER_REQUEST_TYPE;
  readonly protocolVersion: typeof PYTHON_RUNNER_PROTOCOL_VERSION;
  readonly runId: string;
  readonly payload: PythonRunPayload;
  readonly runtimeAssets: PythonRuntimeAssets;
  readonly stdinControl?: SharedArrayBuffer;
  readonly stdinData?: SharedArrayBuffer;
}

export interface PythonRunnerOutputMessage {
  readonly type: typeof PYTHON_RUNNER_OUTPUT_TYPE;
  readonly protocolVersion: typeof PYTHON_RUNNER_PROTOCOL_VERSION;
  readonly runId: string;
  readonly chunk: string;
}

export interface PythonRunnerInputRequestMessage {
  readonly type: typeof PYTHON_RUNNER_INPUT_REQUEST_TYPE;
  readonly protocolVersion: typeof PYTHON_RUNNER_PROTOCOL_VERSION;
  readonly runId: string;
  readonly requestId: string;
}

export interface PythonRunnerResponse {
  readonly type: typeof PYTHON_RUNNER_RESULT_TYPE;
  readonly protocolVersion: typeof PYTHON_RUNNER_PROTOCOL_VERSION;
  readonly runId: string;
  readonly status: "ok" | "runtime-error";
  readonly output: string;
  readonly truncated: boolean;
  readonly workspaceDelta?: PythonWorkspaceDelta;
}

export type PythonRunStatus =
  | PythonRunnerResponse["status"]
  | "worker-error"
  | "protocol-error"
  | "timeout"
  | "cancelled";

export interface PythonRunResult {
  readonly runId: string;
  readonly status: PythonRunStatus;
  readonly output: string;
  readonly truncated: boolean;
  readonly workspaceDelta?: PythonWorkspaceDelta;
}

export interface PythonRunHandle {
  readonly runId: string;
  readonly result: Promise<PythonRunResult>;
  submitInput(value: string): boolean;
  sendEof(): boolean;
  cancel(): void;
}

export interface PythonRunnerOptions {
  readonly createWorker?: () => Worker;
  readonly runId?: string;
  readonly timeoutMs?: number;
  /** Preverified assets for embedding/tests; normal callers use the loader. */
  readonly runtimeAssets?: PythonRuntimeAssets;
  readonly loadRuntimeAssets?: () => Promise<PythonRuntimeAssets>;
  readonly onOutput?: (chunk: string) => void;
  readonly onInputRequest?: (
    request: Readonly<{ runId: string; requestId: string }>,
  ) => void;
}

const RUN_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/u;
const ENTRY_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/u;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const FORBIDDEN_PATH_CHARACTER_PATTERN = /[\\\u0000-\u001f\u007f]/u;
const MAX_RESPONSE_CHARS = 256 * 1024 + 128;
const MAX_INPUT_REQUESTS = 4_096;

function responseFor(
  runId: string,
  status: PythonRunStatus,
  output: string,
  truncated = false,
  workspaceDelta?: PythonWorkspaceDelta,
): PythonRunResult {
  return {
    runId,
    status,
    output,
    truncated,
    ...(workspaceDelta ? { workspaceDelta } : {}),
  };
}

function comparablePath(path: string): string {
  return path.toLocaleLowerCase("en-US");
}

function safeWorkspacePath(path: unknown): path is string {
  if (
    typeof path !== "string"
    || path.length < 1
    || path.length > PYTHON_RUNNER_WORKSPACE_LIMITS.maxPathCodeUnits
    || path.startsWith("/")
    || FORBIDDEN_PATH_CHARACTER_PATTERN.test(path)
  ) return false;
  const segments = path.split("/");
  return segments.length <= PYTHON_RUNNER_WORKSPACE_LIMITS.maxDepth + 1
    && segments.every((segment) => (
      segment.length > 0
      && segment !== "."
      && segment !== ".."
      && segment.length <= 128
      && segment === segment.normalize("NFKC").trim()
    ));
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
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<PythonRunnerFileBaseIdentity>;
  return candidate.entryId === expected.entryId
    && candidate.contentKind === expected.contentKind
    && candidate.sha256 === expected.sha256
    && candidate.byteSize === expected.byteSize;
}

function parseWorkspaceDelta(
  value: unknown,
  payload: Extract<PythonRunPayload, { readonly kind: "workspace" }>,
): PythonWorkspaceDelta | null {
  if (typeof value !== "object" || value === null) return null;
  const candidate = value as Partial<PythonWorkspaceDelta>;
  if (
    candidate.version !== PYTHON_WORKSPACE_DELTA_VERSION
    || !Array.isArray(candidate.changes)
    || candidate.changes.length > PYTHON_RUNNER_WORKSPACE_LIMITS.maxEntries * 2
  ) return null;

  const baselineByPath = new Map(payload.files.map((file) => (
    [comparablePath(file.path), file] as const
  )));
  const parsed: PythonWorkspaceDeltaChange[] = [];
  let previousPath: string | null = null;
  let totalBytes = 0;
  for (const valueChange of candidate.changes) {
    if (typeof valueChange !== "object" || valueChange === null) return null;
    const change = valueChange as Partial<PythonWorkspaceDeltaChange>;
    if (!safeWorkspacePath(change.path)) return null;
    const pathKey = comparablePath(change.path);
    if (previousPath !== null && pathKey <= previousPath) return null;
    previousPath = pathKey;
    const baseline = baselineByPath.get(pathKey);
    if (change.kind === "delete") {
      if (!baseline || !sameBaseIdentity(change.base, baseline.base)) return null;
      parsed.push({
        kind: "delete",
        path: change.path,
        base: { ...baseline.base },
      });
      continue;
    }
    if (change.kind !== "write") return null;
    if (
      (baseline && !sameBaseIdentity(change.base, baseline.base))
      || (!baseline && change.base !== null)
    ) return null;
    const bytes = byteView(change.bytes);
    if (
      !bytes
      || bytes.byteLength > PYTHON_RUNNER_WORKSPACE_LIMITS.maxFileBytes
    ) return null;
    totalBytes += bytes.byteLength;
    if (totalBytes > PYTHON_RUNNER_WORKSPACE_LIMITS.maxTotalBytes) return null;
    parsed.push({
      kind: "write",
      path: change.path,
      base: baseline ? { ...baseline.base } : null,
      bytes: bytes.slice(),
    });
  }
  return { version: PYTHON_WORKSPACE_DELTA_VERSION, changes: parsed };
}

function parseResponse(
  value: unknown,
  runId: string,
  payload: PythonRunPayload,
): PythonRunnerResponse | null {
  if (typeof value !== "object" || value === null) return null;
  const candidate = value as Partial<PythonRunnerResponse>;
  if (
    candidate.type !== PYTHON_RUNNER_RESULT_TYPE
    || candidate.protocolVersion !== PYTHON_RUNNER_PROTOCOL_VERSION
    || candidate.runId !== runId
    || (candidate.status !== "ok" && candidate.status !== "runtime-error")
    || typeof candidate.output !== "string"
    || candidate.output.length > MAX_RESPONSE_CHARS
    || typeof candidate.truncated !== "boolean"
  ) return null;
  if (payload.kind === "script") {
    if (candidate.workspaceDelta !== undefined) return null;
    return candidate as PythonRunnerResponse;
  }
  if (candidate.workspaceDelta === undefined) {
    return candidate.status === "runtime-error"
      ? candidate as PythonRunnerResponse
      : null;
  }
  const workspaceDelta = parseWorkspaceDelta(candidate.workspaceDelta, payload);
  if (!workspaceDelta) return null;
  return { ...candidate, workspaceDelta } as PythonRunnerResponse;
}

export function startPythonRun(
  payload: PythonRunPayload,
  options: PythonRunnerOptions = {},
): PythonRunHandle {
  const runId = options.runId ?? crypto.randomUUID();
  if (!RUN_ID_PATTERN.test(runId)) {
    throw new Error("Python run ID is invalid");
  }
  const createWorker = options.createWorker
    ?? (() => createOpaquePythonWorker("runner"));
  const timeoutMs = options.timeoutMs ?? PYTHON_RUNNER_TIMEOUT_MS;
  const interactive = payload.kind === "workspace" && payload.stdin === null;
  let worker: Worker;
  try {
    worker = createWorker();
  } catch (error) {
    const message = error instanceof Error
      ? error.message
      : "Python worker could not be created";
    return {
      runId,
      result: Promise.resolve(responseFor(runId, "worker-error", message)),
      submitInput: () => false,
      sendEof: () => false,
      cancel: () => undefined,
    };
  }
  const opaqueControl = opaquePythonWorkerControl(worker);
  let stdinControlBuffer: SharedArrayBuffer | null = null;
  let stdinDataBuffer: SharedArrayBuffer | null = null;
  let stdinControl: Int32Array | null = null;
  let stdinData: Uint8Array | null = null;
  if (interactive && !opaqueControl) {
    if (typeof SharedArrayBuffer !== "function") {
      worker.terminate();
      return {
        runId,
        result: Promise.resolve(responseFor(
          runId,
          "worker-error",
          "Interactive Python input is unavailable in this browser context.",
        )),
        submitInput: () => false,
        sendEof: () => false,
        cancel: () => undefined,
      };
    }
    stdinControlBuffer = new SharedArrayBuffer(PYTHON_STDIN_CONTROL_BYTES);
    stdinDataBuffer = new SharedArrayBuffer(PYTHON_RUNNER_MAX_INPUT_LINE_BYTES);
    stdinControl = new Int32Array(stdinControlBuffer);
    stdinData = new Uint8Array(stdinDataBuffer);
  }

  let settled = false;
  let resolveResult!: (result: PythonRunResult) => void;
  const result = new Promise<PythonRunResult>((resolve) => {
    resolveResult = resolve;
  });
  let timeout: ReturnType<typeof globalThis.setTimeout> | null = null;
  let waitingRequestId: string | null = null;
  let inputRequestCount = 0;
  let submittedInputBytes = 0;
  let streamedOutputChars = 0;

  const cleanup = (): void => {
    if (timeout !== null) globalThis.clearTimeout(timeout);
    timeout = null;
    worker.removeEventListener("message", receive);
    worker.removeEventListener("messageerror", messageFailed);
    worker.removeEventListener("error", failed);
  };
  const finish = (terminal: PythonRunResult): void => {
    if (settled) return;
    settled = true;
    waitingRequestId = null;
    if (stdinControl) {
      Atomics.store(stdinControl, 0, PYTHON_STDIN_EOF);
      Atomics.notify(stdinControl, 0);
    }
    cleanup();
    worker.terminate();
    resolveResult(terminal);
  };
  const receive = (event: MessageEvent<unknown>): void => {
    if (typeof event.data === "object" && event.data !== null) {
      const streamed = event.data as Partial<PythonRunnerOutputMessage>
        & Partial<PythonRunnerInputRequestMessage>;
      if (
        streamed.type === PYTHON_RUNNER_OUTPUT_TYPE
        && streamed.protocolVersion === PYTHON_RUNNER_PROTOCOL_VERSION
        && streamed.runId === runId
        && typeof streamed.chunk === "string"
        && streamed.chunk.length > 0
      ) {
        streamedOutputChars += streamed.chunk.length;
        if (streamedOutputChars > MAX_RESPONSE_CHARS) {
          finish(responseFor(
            runId,
            "protocol-error",
            "Python worker streamed too much output.",
          ));
          return;
        }
        options.onOutput?.(streamed.chunk);
        return;
      }
      if (
        streamed.type === PYTHON_RUNNER_INPUT_REQUEST_TYPE
        && streamed.protocolVersion === PYTHON_RUNNER_PROTOCOL_VERSION
        && streamed.runId === runId
        && typeof streamed.requestId === "string"
        && RUN_ID_PATTERN.test(streamed.requestId)
        && (
          opaqueControl !== null
          || (
            stdinControl !== null
            && Atomics.load(stdinControl, 0) === PYTHON_STDIN_WAITING
          )
        )
      ) {
        inputRequestCount += 1;
        if (inputRequestCount > MAX_INPUT_REQUESTS) {
          finish(responseFor(
            runId,
            "protocol-error",
            "Python worker requested too many input lines.",
          ));
          return;
        }
        waitingRequestId = streamed.requestId;
        options.onInputRequest?.({ runId, requestId: streamed.requestId });
        return;
      }
    }
    const response = parseResponse(event.data, runId, payload);
    if (!response) {
      finish(responseFor(
        runId,
        "protocol-error",
        "Python worker returned an invalid response.",
      ));
      return;
    }
    finish(responseFor(
      runId,
      response.status,
      response.output,
      response.truncated,
      response.workspaceDelta,
    ));
  };
  const failed = (event: ErrorEvent): void => {
    finish(responseFor(
      runId,
      "worker-error",
      event.message || "Python worker failed.",
    ));
  };
  const messageFailed = (): void => {
    finish(responseFor(
      runId,
      "protocol-error",
      "Python worker response could not be decoded.",
    ));
  };

  worker.addEventListener("message", receive);
  worker.addEventListener("messageerror", messageFailed);
  worker.addEventListener("error", failed);
  timeout = globalThis.setTimeout(() => {
    finish(responseFor(
      runId,
      "timeout",
      "Выполнение остановлено: превышен лимит времени.",
    ));
  }, timeoutMs);

  const postRequest = (runtimeAssets: PythonRuntimeAssets): void => {
    if (settled) return;
    const request: PythonRunnerRequest = {
      type: PYTHON_RUNNER_REQUEST_TYPE,
      protocolVersion: PYTHON_RUNNER_PROTOCOL_VERSION,
      runId,
      payload,
      runtimeAssets,
      ...(stdinControlBuffer && stdinDataBuffer
        ? { stdinControl: stdinControlBuffer, stdinData: stdinDataBuffer }
        : {}),
    };
    try {
      worker.postMessage(
        request,
        [...pythonRuntimeAssetTransferList(runtimeAssets)],
      );
    } catch (error) {
      finish(responseFor(
        runId,
        "worker-error",
        error instanceof Error ? error.message : "Python worker could not start.",
      ));
    }
  };
  if (options.runtimeAssets) {
    postRequest(options.runtimeAssets);
  } else {
    const runtimeAssetLoader = options.loadRuntimeAssets ?? loadPythonRuntimeAssets;
    void runtimeAssetLoader().then(postRequest).catch(() => {
      finish(responseFor(
        runId,
        "worker-error",
        "Pinned Python runtime assets could not be loaded or verified.",
      ));
    });
  }

  return {
    runId,
    result,
    submitInput: (value) => {
      if (settled || waitingRequestId === null) return false;
      const bytes = new TextEncoder().encode(value);
      if (
        bytes.byteLength > PYTHON_RUNNER_MAX_INPUT_LINE_BYTES
        || submittedInputBytes + bytes.byteLength > PYTHON_RUNNER_MAX_INPUT_BYTES
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
        stdinData.set(bytes, 0);
        Atomics.store(stdinControl, 1, bytes.byteLength);
        Atomics.store(stdinControl, 0, PYTHON_STDIN_VALUE);
        Atomics.notify(stdinControl, 0);
      }
      submittedInputBytes += bytes.byteLength;
      waitingRequestId = null;
      return true;
    },
    sendEof: () => {
      if (settled || waitingRequestId === null) return false;
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
      waitingRequestId = null;
      return true;
    },
    cancel: () => finish(responseFor(runId, "cancelled", "")),
  };
}

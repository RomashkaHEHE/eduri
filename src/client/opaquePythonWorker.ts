import {
  PYTHON_OPAQUE_HOST_CONTENT_SECURITY_POLICY,
  PYTHON_RUNNER_PROTOCOL_VERSION,
  PYTHON_RUNNER_WORKER_URL,
  PYTHON_TERMINAL_PROTOCOL_VERSION,
  PYTHON_TERMINAL_WORKER_URL,
} from "../pythonRunnerContract.js";
import opaquePythonHostBootstrapRaw from "./opaquePythonHost.bootstrap.js?raw";

export type OpaquePythonWorkerKind = "runner" | "terminal";

const HOST_INIT = "eduri.opaque-python-host.init";
const HOST_READY = "eduri.opaque-python-host.ready";
const HOST_PARENT_MESSAGE = "eduri.opaque-python-host.parent-message";
const HOST_WORKER_MESSAGE = "eduri.opaque-python-host.worker-message";
const HOST_ERROR = "eduri.opaque-python-host.error";
const HOST_TERMINATE = "eduri.opaque-python-host.terminate";
const HOST_CONTROL = "eduri.opaque-python-host.control";
const HOST_INITIALIZATION_TIMEOUT_MS = 15_000;
const MAX_WORKER_SOURCE_BYTES = 512 * 1024;
const MAX_QUEUED_MESSAGES = 4;

interface QueuedMessage {
  readonly value: unknown;
}

function containsSharedMemory(value: unknown, seen = new WeakSet<object>()): boolean {
  if (typeof SharedArrayBuffer === "function" && value instanceof SharedArrayBuffer) {
    return true;
  }
  if (ArrayBuffer.isView(value)) {
    return typeof SharedArrayBuffer === "function"
      && value.buffer instanceof SharedArrayBuffer;
  }
  if (typeof value !== "object" || value === null || value instanceof ArrayBuffer) {
    return false;
  }
  if (seen.has(value)) return false;
  seen.add(value);
  if (value instanceof Map) {
    for (const [key, candidate] of value) {
      if (containsSharedMemory(key, seen) || containsSharedMemory(candidate, seen)) {
        return true;
      }
    }
    return false;
  }
  if (value instanceof Set) {
    for (const candidate of value) {
      if (containsSharedMemory(candidate, seen)) return true;
    }
    return false;
  }
  if (Array.isArray(value)) {
    return value.some((candidate) => containsSharedMemory(candidate, seen));
  }
  return Object.values(value as Record<string, unknown>)
    .some((candidate) => containsSharedMemory(candidate, seen));
}

function runtimeAssetTransfers(value: unknown): Transferable[] {
  if (typeof value !== "object" || value === null) return [];
  const runtimeAssets = (value as Record<string, unknown>).runtimeAssets;
  if (typeof runtimeAssets !== "object" || runtimeAssets === null) return [];
  const assets = runtimeAssets as Record<string, unknown>;
  return [assets.pyodideLock, assets.pyodideWasm, assets.pythonStdlib]
    .filter((candidate): candidate is ArrayBuffer => candidate instanceof ArrayBuffer);
}

export interface OpaquePythonWorkerControl {
  readonly isOpaquePythonWorker: true;
  submitPythonInput(value: string): boolean;
  sendPythonEof(): boolean;
  interruptPython(): boolean;
}

export function opaquePythonWorkerControl(
  worker: Worker,
): OpaquePythonWorkerControl | null {
  const candidate = worker as unknown as Partial<OpaquePythonWorkerControl>;
  return candidate.isOpaquePythonWorker === true
    && typeof candidate.submitPythonInput === "function"
    && typeof candidate.sendPythonEof === "function"
    && typeof candidate.interruptPython === "function"
    ? candidate as OpaquePythonWorkerControl
    : null;
}

let sourceByKind = new Map<OpaquePythonWorkerKind, Promise<string>>();

function workerUrl(kind: OpaquePythonWorkerKind): string {
  return kind === "runner"
    ? PYTHON_RUNNER_WORKER_URL
    : PYTHON_TERMINAL_WORKER_URL;
}

async function loadWorkerSource(kind: OpaquePythonWorkerKind): Promise<string> {
  const path = workerUrl(kind);
  const response = await fetch(path, {
    cache: "force-cache",
    credentials: "omit",
    redirect: "error",
  });
  if (!response.ok) throw new Error("Python sandbox worker source is unavailable");
  const expected = new URL(path, globalThis.location.href);
  if (response.url && new URL(response.url, expected).href !== expected.href) {
    throw new Error("Python sandbox worker source redirected");
  }
  const source = await response.text();
  const byteLength = new TextEncoder().encode(source).byteLength;
  const protocolMarker = kind === "runner"
    ? `const PROTOCOL_VERSION = ${PYTHON_RUNNER_PROTOCOL_VERSION};`
    : `const PROTOCOL_VERSION = ${PYTHON_TERMINAL_PROTOCOL_VERSION};`;
  if (
    byteLength < 1
    || byteLength > MAX_WORKER_SOURCE_BYTES
    || !source.includes(protocolMarker)
    || !source.startsWith("(() => {")
  ) throw new Error("Python sandbox worker source is invalid");
  return source;
}

function cachedWorkerSource(kind: OpaquePythonWorkerKind): Promise<string> {
  const existing = sourceByKind.get(kind);
  if (existing) return existing;
  const pending = loadWorkerSource(kind);
  sourceByKind.set(kind, pending);
  void pending.catch(() => {
    if (sourceByKind.get(kind) === pending) sourceByKind.delete(kind);
  });
  return pending;
}

export function normalizeOpaquePythonHostBootstrap(source: string): string {
  const normalized = source.replace(/\r\n?/gu, "\n");
  if (normalized.length < 1 || normalized.toLowerCase().includes("</script")) {
    throw new Error("Opaque Python host bootstrap is invalid");
  }
  return normalized;
}

const OPAQUE_PYTHON_HOST_BOOTSTRAP = normalizeOpaquePythonHostBootstrap(
  opaquePythonHostBootstrapRaw,
);

function hostBootstrapSource(): string {
  return OPAQUE_PYTHON_HOST_BOOTSTRAP;
}

function opaqueHostDocument(): string {
  const policy = PYTHON_OPAQUE_HOST_CONTENT_SECURITY_POLICY.replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;");
  return `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${policy}"><script>${hostBootstrapSource()}</script>`;
}

class OpaquePythonWorkerProxy extends EventTarget {
  readonly isOpaquePythonWorker = true as const;
  readonly #kind: OpaquePythonWorkerKind;
  readonly #token: string;
  readonly #iframe: HTMLIFrameElement;
  readonly #queue: QueuedMessage[] = [];
  #port: MessagePort | null = null;
  #ready = false;
  #terminated = false;
  #timer: ReturnType<typeof globalThis.setTimeout> | null = null;

  constructor(kind: OpaquePythonWorkerKind) {
    super();
    if (typeof document === "undefined" || typeof MessageChannel !== "function") {
      throw new Error("Opaque Python sandbox is unavailable");
    }
    this.#kind = kind;
    this.#token = crypto.randomUUID();
    const iframe = document.createElement("iframe");
    this.#iframe = iframe;
    iframe.hidden = true;
    iframe.tabIndex = -1;
    iframe.setAttribute("aria-hidden", "true");
    iframe.setAttribute("sandbox", "allow-scripts");
    iframe.setAttribute("allow", "cross-origin-isolated");
    iframe.srcdoc = opaqueHostDocument();
    iframe.addEventListener("load", () => void this.#initialize(), { once: true });
    document.documentElement.append(iframe);
    this.#timer = globalThis.setTimeout(() => {
      this.#fail("Opaque Python sandbox initialization timed out");
    }, HOST_INITIALIZATION_TIMEOUT_MS);
  }

  postMessage(value: unknown, _transfer: readonly Transferable[] = []): void {
    if (this.#terminated) throw new DOMException("Worker is terminated", "InvalidStateError");
    if (containsSharedMemory(value)) {
      throw new DOMException(
        "Shared memory cannot cross the opaque Python sandbox boundary",
        "DataCloneError",
      );
    }
    const queued = { value };
    if (!this.#ready || !this.#port) {
      if (this.#queue.length >= MAX_QUEUED_MESSAGES) {
        throw new DOMException("Python sandbox request queue is full", "QuotaExceededError");
      }
      this.#queue.push(queued);
      return;
    }
    this.#send(queued);
  }

  submitPythonInput(value: string): boolean {
    if (this.#terminated || typeof value !== "string") return false;
    const bytes = new TextEncoder().encode(value);
    if (bytes.byteLength > 64 * 1024) return false;
    return this.#sendControl({ action: "input", value });
  }

  sendPythonEof(): boolean {
    if (this.#terminated) return false;
    return this.#sendControl({ action: "eof" });
  }

  interruptPython(): boolean {
    if (this.#terminated) return false;
    return this.#sendControl({ action: "interrupt" });
  }

  terminate(): void {
    if (this.#terminated) return;
    this.#terminated = true;
    if (this.#timer !== null) globalThis.clearTimeout(this.#timer);
    this.#timer = null;
    try {
      this.#port?.postMessage({ type: HOST_TERMINATE, token: this.#token });
    } catch {
      // Removing the opaque frame below is the authoritative cleanup.
    }
    this.#port?.close();
    this.#port = null;
    this.#queue.splice(0);
    this.#iframe.remove();
  }

  async #initialize(): Promise<void> {
    try {
      const source = await cachedWorkerSource(this.#kind);
      if (this.#terminated) return;
      const frame = this.#iframe.contentWindow;
      if (!frame) throw new Error("Opaque Python sandbox frame is unavailable");
      const channel = new MessageChannel();
      this.#port = channel.port1;
      channel.port1.onmessage = (event) => this.#receive(event);
      channel.port1.onmessageerror = () => {
        this.#fail("Opaque Python sandbox message could not be decoded");
      };
      channel.port1.start();
      frame.postMessage({
        type: HOST_INIT,
        token: this.#token,
        kind: this.#kind,
        workerSource: source,
      }, "*", [channel.port2]);
    } catch {
      this.#fail("Opaque Python sandbox could not be initialized");
    }
  }

  #receive(event: MessageEvent<unknown>): void {
    if (this.#terminated || typeof event.data !== "object" || event.data === null) return;
    const message = event.data as Record<string, unknown>;
    if (message.token !== this.#token) {
      this.#fail("Opaque Python sandbox protocol mismatch");
      return;
    }
    if (message.type === HOST_READY) {
      if (this.#ready || Object.keys(message).length !== 2) {
        this.#fail("Opaque Python sandbox sent duplicate readiness");
        return;
      }
      this.#ready = true;
      if (this.#timer !== null) globalThis.clearTimeout(this.#timer);
      this.#timer = null;
      for (const queued of this.#queue.splice(0)) this.#send(queued);
      return;
    }
    if (message.type === HOST_WORKER_MESSAGE) {
      if (Object.keys(message).length !== 3 || !("payload" in message)) {
        this.#fail("Opaque Python sandbox returned an invalid worker envelope");
        return;
      }
      this.dispatchEvent(new MessageEvent("message", { data: message.payload }));
      return;
    }
    if (
      message.type === HOST_ERROR
      && Object.keys(message).length === 3
      && typeof message.message === "string"
      && message.message.length <= 512
    ) {
      this.#fail(message.message);
      return;
    }
    this.#fail("Opaque Python sandbox returned an invalid envelope");
  }

  #send(message: QueuedMessage): void {
    try {
      this.#port?.postMessage({
        type: HOST_PARENT_MESSAGE,
        token: this.#token,
        payload: message.value,
      }, runtimeAssetTransfers(message.value));
    } catch {
      this.#fail("Opaque Python sandbox request could not be delivered");
    }
  }

  #sendControl(payload: Readonly<Record<string, unknown>>): boolean {
    if (!this.#ready || !this.#port) return false;
    try {
      this.#port.postMessage({
        type: HOST_CONTROL,
        token: this.#token,
        payload,
      });
      return true;
    } catch {
      this.#fail("Opaque Python sandbox control could not be delivered");
      return false;
    }
  }

  #fail(message: string): void {
    if (this.#terminated) return;
    const failure = typeof ErrorEvent === "function"
      ? new ErrorEvent("error", { message })
      : Object.assign(new Event("error"), { message });
    this.dispatchEvent(failure);
    this.terminate();
  }
}

export function createOpaquePythonWorker(kind: OpaquePythonWorkerKind): Worker {
  return new OpaquePythonWorkerProxy(kind) as unknown as Worker;
}

export const opaquePythonHostDocumentForTest = opaqueHostDocument;
export const opaquePythonHostBootstrapSourceForTest = hostBootstrapSource;

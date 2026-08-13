// @vitest-environment jsdom

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import vm from "node:vm";
import {
  createOpaquePythonWorker,
  opaquePythonWorkerControl,
  opaquePythonHostBootstrapSourceForTest,
  opaquePythonHostDocumentForTest,
  normalizeOpaquePythonHostBootstrap,
} from "./opaquePythonWorker.js";
import {
  PYTHON_OPAQUE_HOST_BOOTSTRAP_SHA256_BASE64,
  PYTHON_OPAQUE_HOST_CONTENT_SECURITY_POLICY,
  PYTHON_RUNNER_PROTOCOL_VERSION,
  PYTHON_RUNTIME_ASSET_MANIFEST,
  PYTHON_RUNTIME_ASSET_PROTOCOL_VERSION,
  PYTHON_TERMINAL_PROTOCOL_VERSION,
} from "../pythonRunnerContract.js";

const bootstrapFileSource = readFileSync(
  resolve(process.cwd(), "src/client/opaquePythonHost.bootstrap.js"),
  "utf8",
);

function sha256Base64(source: string): string {
  return createHash("sha256").update(source, "utf8").digest("base64");
}

type Listener = (event: { readonly data?: unknown; preventDefault(): void }) => void;

class BrokerPort {
  onmessage: ((event: { readonly data: unknown }) => void) | null = null;
  onmessageerror: (() => void) | null = null;
  readonly sent: unknown[] = [];
  closed = false;

  postMessage(value: unknown): void {
    this.sent.push(value);
  }

  receive(value: unknown): void {
    this.onmessage?.({ data: value });
  }

  start(): void {}

  close(): void {
    this.closed = true;
  }
}

class BrokerWorker {
  static latest: BrokerWorker | null = null;
  readonly listeners = new Map<string, Set<Listener>>();
  readonly posted: unknown[] = [];
  terminated = false;

  constructor(readonly url: string) {
    BrokerWorker.latest = this;
  }

  addEventListener(type: string, listener: Listener): void {
    const listeners = this.listeners.get(type) ?? new Set<Listener>();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  postMessage(value: unknown): void {
    this.posted.push(value);
  }

  emitMessage(data: unknown): void {
    for (const listener of this.listeners.get("message") ?? []) {
      listener({ data, preventDefault: () => undefined });
    }
  }

  terminate(): void {
    this.terminated = true;
  }
}

function brokerRuntimeAssets() {
  return {
    version: PYTHON_RUNTIME_ASSET_PROTOCOL_VERSION,
    pyodideScript: "x",
    pyodideAsmScript: "y",
    pyodideLock: new ArrayBuffer(PYTHON_RUNTIME_ASSET_MANIFEST.pyodideLock.byteLength),
    pyodideWasm: new ArrayBuffer(PYTHON_RUNTIME_ASSET_MANIFEST.pyodideWasm.byteLength),
    pythonStdlib: new ArrayBuffer(PYTHON_RUNTIME_ASSET_MANIFEST.pythonStdlib.byteLength),
  };
}

afterEach(() => {
  document.querySelectorAll("iframe").forEach((frame) => frame.remove());
});

describe("opaque Python worker host", () => {
  it("binds the checked-in bootstrap bytes to both the document and CSP", () => {
    const normalized = bootstrapFileSource.replace(/\r\n?/gu, "\n");
    const documentSource = opaquePythonHostDocumentForTest();

    expect(opaquePythonHostBootstrapSourceForTest()).toBe(normalized);
    expect(documentSource).toContain(`<script>${normalized}</script>`);
    expect(sha256Base64(normalized)).toBe(
      PYTHON_OPAQUE_HOST_BOOTSTRAP_SHA256_BASE64,
    );
    expect(PYTHON_OPAQUE_HOST_CONTENT_SECURITY_POLICY).toContain(
      `'sha256-${sha256Base64(normalized)}'`,
    );
    expect(PYTHON_OPAQUE_HOST_CONTENT_SECURITY_POLICY).not.toContain(
      "'unsafe-inline'",
    );
  });

  it("normalizes line endings deterministically and rejects script terminators", () => {
    const normalized = bootstrapFileSource.replace(/\r\n?/gu, "\n");
    const crlf = normalized.replace(/\n/gu, "\r\n");

    expect(normalizeOpaquePythonHostBootstrap(crlf)).toBe(normalized);
    expect(sha256Base64(normalizeOpaquePythonHostBootstrap(crlf))).toBe(
      PYTHON_OPAQUE_HOST_BOOTSTRAP_SHA256_BASE64,
    );
    expect(() => normalizeOpaquePythonHostBootstrap("x</ScRiPt>x"))
      .toThrow(/bootstrap is invalid/u);
  });

  it("uses an opaque sandbox and delegates only cross-origin isolation", () => {
    const worker = createOpaquePythonWorker("runner");
    const frame = document.querySelector("iframe");
    expect(frame).not.toBeNull();
    expect(frame?.getAttribute("sandbox")).toBe("allow-scripts");
    expect(frame?.getAttribute("sandbox")).not.toContain("allow-same-origin");
    expect(frame?.getAttribute("allow")).toBe("cross-origin-isolated");
    expect(frame?.hidden).toBe(true);

    worker.terminate();
    expect(document.querySelector("iframe")).toBeNull();
  });

  it("denies network and app-origin embedding in the opaque host CSP", () => {
    const source = opaquePythonHostDocumentForTest();
    expect(source).toContain("connect-src 'none'");
    expect(source).toContain("worker-src blob:");
    expect(source).toContain("child-src blob:");
    expect(source).toContain("webrtc 'block'");
    expect(source).not.toContain("allow-same-origin");
    expect(source).not.toContain("https://eduri");
  });

  it("contains an allowlisted worker-to-parent relay, not a privileged RPC bridge", () => {
    const source = opaquePythonHostDocumentForTest();
    for (const type of [
      "eduri.python.output",
      "eduri.python.input-request",
      "eduri.python.result",
      "eduri.python-terminal.ready",
      "eduri.python-terminal.output",
      "eduri.python-terminal.input-request",
      "eduri.python-terminal.result",
      "eduri.python-terminal.fatal",
    ]) expect(source).toContain(type);
    expect(source).not.toMatch(/parent\.(?:fetch|indexedDB|caches|localStorage)/u);
    expect(source).toContain("Opaque Python worker returned an invalid message");
    expect(source).toContain("URL.revokeObjectURL(workerUrl)");
    expect(source).toContain("worker?.terminate()");
    expect(source).toContain("port.close()");
  });

  it("rejects shared memory at the privileged parent boundary", () => {
    const worker = createOpaquePythonWorker("runner");
    expect(() => worker.postMessage({
      type: "eduri.python.run",
      protocolVersion: PYTHON_RUNNER_PROTOCOL_VERSION,
      runId: "run-shared-memory",
      payload: { kind: "workspace", stdin: null },
      stdinControl: new SharedArrayBuffer(8),
    })).toThrow(/Shared memory cannot cross/u);
    worker.terminate();
  });

  it("bounds ordinary input before it reaches the opaque broker", () => {
    const worker = createOpaquePythonWorker("terminal");
    const control = opaquePythonWorkerControl(worker);
    expect(control).not.toBeNull();
    expect(control?.submitPythonInput("x".repeat(64 * 1024 + 1))).toBe(false);
    worker.terminate();
  });

  it("allocates terminal shared buffers inside the opaque broker", () => {
    const registered: Array<(event: Record<string, unknown>) => void> = [];
    const parent = {};
    const port = new BrokerPort();
    const revoked: string[] = [];
    const context = {
      ArrayBuffer,
      Atomics,
      Blob,
      Error,
      Int32Array,
      Map,
      MessageEvent,
      Number,
      Object,
      Promise,
      RegExp,
      Set,
      SharedArrayBuffer,
      String,
      TextEncoder,
      Uint8Array,
      URL: {
        createObjectURL: () => "blob:opaque-worker",
        revokeObjectURL: (value: string) => revoked.push(value),
      },
      WeakSet,
      Worker: BrokerWorker,
      addEventListener(type: string, listener: (event: Record<string, unknown>) => void) {
        if (type === "message") registered.push(listener);
      },
      crossOriginIsolated: true,
      parent,
      removeEventListener() {},
    };
    vm.runInNewContext(opaquePythonHostBootstrapSourceForTest(), context);
    const initialize = registered[0];
    if (!initialize) throw new Error("Opaque broker did not register initialization");
    const token = "broker-test";
    initialize({
      data: {
        type: "eduri.opaque-python-host.init",
        token,
        kind: "terminal",
        workerSource: "(() => { const PROTOCOL_VERSION = 3; })();",
      },
      source: parent,
      ports: [port],
    });
    port.receive({
      type: "eduri.opaque-python-host.parent-message",
      token,
      payload: {
        type: "eduri.python-terminal.open",
        protocolVersion: PYTHON_TERMINAL_PROTOCOL_VERSION,
        sessionId: "session-a",
        workspace: { files: [], directories: [] },
        runtimeAssets: brokerRuntimeAssets(),
      },
    });
    const delivered = BrokerWorker.latest?.posted[0] as Record<string, unknown>;
    expect(delivered.stdinControl).toBeInstanceOf(SharedArrayBuffer);
    expect(delivered.stdinData).toBeInstanceOf(SharedArrayBuffer);
    expect(delivered.interruptBuffer).toBeInstanceOf(SharedArrayBuffer);

    port.receive({ type: "eduri.opaque-python-host.terminate", token });
    expect(BrokerWorker.latest?.terminated).toBe(true);
    expect(port.closed).toBe(true);
    expect(revoked).toEqual(["blob:opaque-worker"]);
  });
});

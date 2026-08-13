export const PYTHON_RUNNER_PROTOCOL_VERSION = 4 as const;
export const PYTHON_RUNNER_SOURCE_REVISION = 2 as const;
export const PYTHON_RUNNER_PUBLIC_FILE = "python-runner.worker.js" as const;
export const PYTHON_RUNNER_WORKER_URL =
  `/${PYTHON_RUNNER_PUBLIC_FILE}?protocol=${PYTHON_RUNNER_PROTOCOL_VERSION}&revision=${PYTHON_RUNNER_SOURCE_REVISION}` as const;

export const PYTHON_TERMINAL_PROTOCOL_VERSION = 3 as const;
export const PYTHON_TERMINAL_SOURCE_REVISION = 3 as const;
export const PYTHON_TERMINAL_PUBLIC_FILE = "python-terminal.worker.js" as const;
export const PYTHON_TERMINAL_WORKER_URL =
  `/${PYTHON_TERMINAL_PUBLIC_FILE}?protocol=${PYTHON_TERMINAL_PROTOCOL_VERSION}&revision=${PYTHON_TERMINAL_SOURCE_REVISION}` as const;

export const PYODIDE_RUNTIME_VERSION = "0.27.5" as const;
export const PYODIDE_RUNTIME_BASE_URL =
  `/vendor/pyodide/${PYODIDE_RUNTIME_VERSION}/` as const;

export const PYTHON_RUNTIME_ASSET_PROTOCOL_VERSION = 1 as const;

export const PYTHON_RUNTIME_ASSET_MANIFEST = Object.freeze({
  pyodideScript: Object.freeze({
    fileName: "pyodide.js",
    byteLength: 14_928,
    sha256: "7fdbe66e53f68f6a4e93c295a667371759be093d2bd402bb44545514584039b6",
    contentType: "text/javascript",
  }),
  pyodideAsmScript: Object.freeze({
    fileName: "pyodide.asm.js",
    byteLength: 1_253_804,
    sha256: "3a889f073e628c2196c705b42fa0e955ba2e25c034b1e3dd589c35be675bc01b",
    contentType: "text/javascript",
  }),
  pyodideLock: Object.freeze({
    fileName: "pyodide-lock.json",
    byteLength: 112_205,
    sha256: "be1807745da93daa09d360b109c17a0e526e74d664d1f1b9870aafcce98ce426",
    contentType: "application/json",
  }),
  pyodideWasm: Object.freeze({
    fileName: "pyodide.asm.wasm",
    byteLength: 10_103_326,
    sha256: "f7fefe563134714a17abd65516d94960e8dbd96fe6778a7a842947fc9686b3a1",
    contentType: "application/wasm",
  }),
  pythonStdlib: Object.freeze({
    fileName: "python_stdlib.zip",
    byteLength: 2_358_894,
    sha256: "6030964967e447c887abc46c5f0967c55688644d759496de82a3ef09f49f5cba",
    contentType: "application/zip",
  }),
} as const);

export type PythonRuntimeAssetName = keyof typeof PYTHON_RUNTIME_ASSET_MANIFEST;

export interface PythonRuntimeAssets {
  readonly version: typeof PYTHON_RUNTIME_ASSET_PROTOCOL_VERSION;
  readonly pyodideScript: string;
  readonly pyodideAsmScript: string;
  readonly pyodideLock: ArrayBuffer;
  readonly pyodideWasm: ArrayBuffer;
  readonly pythonStdlib: ArrayBuffer;
}

export const PYTHON_WORKER_CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "base-uri 'none'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'none'",
  `script-src https://eduri.ru${PYODIDE_RUNTIME_BASE_URL}pyodide.js https://eduri.ru${PYODIDE_RUNTIME_BASE_URL}pyodide.asm.js 'wasm-unsafe-eval'`,
  "style-src 'none'",
  "img-src 'none'",
  "font-src 'none'",
  "connect-src 'none'",
  "frame-src 'none'",
  "worker-src 'none'",
  "child-src 'none'",
  "media-src 'none'",
  "manifest-src 'none'",
  "webrtc 'block'",
].join("; ");

export const PYTHON_WORKER_DEVELOPMENT_CONTENT_SECURITY_POLICY = [
  ...PYTHON_WORKER_CONTENT_SECURITY_POLICY.split("; ")
    .filter((directive) => !directive.startsWith("script-src ")),
  "script-src 'self' 'wasm-unsafe-eval'",
].join("; ");

export const PYTHON_OPAQUE_HOST_BOOTSTRAP_SHA256_BASE64 =
  "n1yprbulB/x592q6HD8xxYLtXL36qSEIK7bJBpXymR8=" as const;

export const PYTHON_OPAQUE_HOST_CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "base-uri 'none'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'none'",
  `script-src 'sha256-${PYTHON_OPAQUE_HOST_BOOTSTRAP_SHA256_BASE64}' blob: 'wasm-unsafe-eval'`,
  "style-src 'none'",
  "img-src 'none'",
  "font-src 'none'",
  "connect-src 'none'",
  "frame-src 'none'",
  "worker-src blob:",
  "child-src blob:",
  "media-src 'none'",
  "manifest-src 'none'",
  "webrtc 'block'",
].join("; ");

export function isPythonWorkerRequestTarget(target: string | undefined): boolean {
  if (!target) return false;
  const pathname = target.split(/[?#]/u, 1)[0];
  return pathname === `/${PYTHON_RUNNER_PUBLIC_FILE}`
    || pathname === `/${PYTHON_TERMINAL_PUBLIC_FILE}`;
}

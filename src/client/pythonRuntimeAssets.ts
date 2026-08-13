import {
  PYODIDE_RUNTIME_BASE_URL,
  PYTHON_RUNTIME_ASSET_MANIFEST,
  PYTHON_RUNTIME_ASSET_PROTOCOL_VERSION,
  type PythonRuntimeAssetName,
  type PythonRuntimeAssets,
} from "../pythonRunnerContract.js";

export type { PythonRuntimeAssets } from "../pythonRunnerContract.js";

const BINARY_ASSET_NAMES = Object.freeze([
  "pyodideLock",
  "pyodideWasm",
  "pythonStdlib",
] as const satisfies readonly PythonRuntimeAssetName[]);
const SCRIPT_ASSET_NAMES = Object.freeze([
  "pyodideScript",
  "pyodideAsmScript",
] as const satisfies readonly PythonRuntimeAssetName[]);

let verifiedRuntimeAssets: Promise<PythonRuntimeAssets> | null = null;

function bytesToHex(bytes: Uint8Array): string {
  let result = "";
  for (const byte of bytes) result += byte.toString(16).padStart(2, "0");
  return result;
}

async function fetchVerifiedAsset(
  name: PythonRuntimeAssetName,
): Promise<ArrayBuffer> {
  const descriptor = PYTHON_RUNTIME_ASSET_MANIFEST[name];
  const path = `${PYODIDE_RUNTIME_BASE_URL}${descriptor.fileName}`;
  const response = await fetch(path, {
    cache: "force-cache",
    credentials: "omit",
    redirect: "error",
  });
  if (!response.ok) {
    throw new Error(`Pinned Python runtime asset is unavailable: ${descriptor.fileName}`);
  }
  if (response.url) {
    const expected = new URL(path, globalThis.location?.href ?? "http://localhost/");
    const actual = new URL(response.url, expected);
    if (actual.href !== expected.href) {
      throw new Error(`Pinned Python runtime asset redirected: ${descriptor.fileName}`);
    }
  }
  const bytes = await response.arrayBuffer();
  if (bytes.byteLength !== descriptor.byteLength) {
    throw new Error(`Pinned Python runtime asset has an invalid size: ${descriptor.fileName}`);
  }
  if (!globalThis.crypto?.subtle) {
    throw new Error("SHA-256 verification is unavailable for the Python runtime");
  }
  const digest = bytesToHex(new Uint8Array(
    await globalThis.crypto.subtle.digest("SHA-256", bytes),
  ));
  if (digest !== descriptor.sha256) {
    throw new Error(`Pinned Python runtime asset failed integrity verification: ${descriptor.fileName}`);
  }
  return bytes;
}

async function loadCanonicalAssets(): Promise<PythonRuntimeAssets> {
  const [
    pyodideScriptBytes,
    pyodideAsmScriptBytes,
    pyodideLock,
    pyodideWasm,
    pythonStdlib,
  ] = await Promise.all(
    [...SCRIPT_ASSET_NAMES, ...BINARY_ASSET_NAMES]
      .map((name) => fetchVerifiedAsset(name)),
  );
  const decoder = new TextDecoder("utf-8", { fatal: true });
  return {
    version: PYTHON_RUNTIME_ASSET_PROTOCOL_VERSION,
    pyodideScript: decoder.decode(pyodideScriptBytes),
    pyodideAsmScript: decoder.decode(pyodideAsmScriptBytes),
    pyodideLock,
    pyodideWasm,
    pythonStdlib,
  };
}

function cloneRuntimeAssets(assets: PythonRuntimeAssets): PythonRuntimeAssets {
  return {
    version: PYTHON_RUNTIME_ASSET_PROTOCOL_VERSION,
    pyodideScript: assets.pyodideScript,
    pyodideAsmScript: assets.pyodideAsmScript,
    pyodideLock: assets.pyodideLock.slice(0),
    pyodideWasm: assets.pyodideWasm.slice(0),
    pythonStdlib: assets.pythonStdlib.slice(0),
  };
}

/**
 * Fetches and verifies the pinned binary runtime on the trusted page. Workers
 * receive fresh transferable copies, so their CSP can deny every connection.
 */
export async function loadPythonRuntimeAssets(): Promise<PythonRuntimeAssets> {
  if (!verifiedRuntimeAssets) {
    const pending = loadCanonicalAssets();
    verifiedRuntimeAssets = pending;
    void pending.catch(() => {
      if (verifiedRuntimeAssets === pending) verifiedRuntimeAssets = null;
    });
  }
  return cloneRuntimeAssets(await verifiedRuntimeAssets);
}

export function pythonRuntimeAssetTransferList(
  assets: PythonRuntimeAssets,
): readonly ArrayBuffer[] {
  return BINARY_ASSET_NAMES.map((name) => assets[name]);
}

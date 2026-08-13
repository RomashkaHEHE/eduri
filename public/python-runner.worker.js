(() => {
  const workerGlobal = self;
  const sendResult = workerGlobal.postMessage.bind(workerGlobal);
  const closeWorker = typeof workerGlobal.close === "function"
    ? workerGlobal.close.bind(workerGlobal)
    : () => undefined;
  const loadScript = workerGlobal.importScripts.bind(workerGlobal);
  const PROTOCOL_VERSION = 4;
  const WORKSPACE_DELTA_VERSION = 1;
  const REQUEST_TYPE = "eduri.python.run";
  const RESULT_TYPE = "eduri.python.result";
  const OUTPUT_TYPE = "eduri.python.output";
  const INPUT_REQUEST_TYPE = "eduri.python.input-request";
  const RUN_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/u;
  const MAX_OUTPUT_CHARS = 256 * 1024;
  const MAX_WORKSPACE_ENTRIES = 512;
  const MAX_FILE_BYTES = 2 * 1024 * 1024;
  const MAX_WORKSPACE_BYTES = 8 * 1024 * 1024;
  const MAX_PATH_CODE_UNITS = 1024;
  const MAX_DEPTH = 32;
  const MAX_STDIN_CHARS = 1024 * 1024;
  const MAX_STDIN_LINE_BYTES = 64 * 1024;
  const STDIN_CONTROL_BYTES = Int32Array.BYTES_PER_ELEMENT * 2;
  const STDIN_IDLE = 0;
  const STDIN_WAITING = 1;
  const STDIN_VALUE = 2;
  const STDIN_EOF = 3;
  const MAX_SCRIPT_CHARS = 2 * 1024 * 1024;
  const PYODIDE_RUNTIME_BASE_URL = "/vendor/pyodide/0.27.5/";
  const RUNTIME_ASSET_PROTOCOL_VERSION = 1;
  const RUNTIME_ASSET_MANIFEST = Object.freeze({
    pyodideScript: Object.freeze({
      fileName: "pyodide.js",
      byteLength: 14928,
      sha256: "7fdbe66e53f68f6a4e93c295a667371759be093d2bd402bb44545514584039b6",
      contentType: "text/javascript",
    }),
    pyodideAsmScript: Object.freeze({
      fileName: "pyodide.asm.js",
      byteLength: 1253804,
      sha256: "3a889f073e628c2196c705b42fa0e955ba2e25c034b1e3dd589c35be675bc01b",
      contentType: "text/javascript",
    }),
    pyodideLock: Object.freeze({
      fileName: "pyodide-lock.json",
      byteLength: 112205,
      sha256: "be1807745da93daa09d360b109c17a0e526e74d664d1f1b9870aafcce98ce426",
      contentType: "application/json",
    }),
    pyodideWasm: Object.freeze({
      fileName: "pyodide.asm.wasm",
      byteLength: 10103326,
      sha256: "f7fefe563134714a17abd65516d94960e8dbd96fe6778a7a842947fc9686b3a1",
      contentType: "application/wasm",
    }),
    pythonStdlib: Object.freeze({
      fileName: "python_stdlib.zip",
      byteLength: 2358894,
      sha256: "6030964967e447c887abc46c5f0967c55688644d759496de82a3ef09f49f5cba",
      contentType: "application/zip",
    }),
  });
  const RUNTIME_ASSET_NAMES = Object.freeze([
    "pyodideLock",
    "pyodideWasm",
    "pythonStdlib",
  ]);
  const RUNTIME_SCRIPT_NAMES = Object.freeze([
    "pyodideScript",
    "pyodideAsmScript",
  ]);
  const MEMORY_RUNTIME_BASE_URL = "https://python-runtime.invalid/0.27.5/";
  const BlobConstructor = workerGlobal.Blob;
  const ResponseConstructor = workerGlobal.Response;
  const URLConstructor = workerGlobal.URL;
  const nativeDigest = workerGlobal.crypto?.subtle?.digest?.bind(workerGlobal.crypto.subtle);
  const SHA256_K = Object.freeze([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
    0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
    0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
    0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
    0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
    0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
    0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
    0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
    0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ]);
  const ENTRY_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/u;
  const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
  const FORBIDDEN_PATH_CHARACTER_PATTERN = /[\\\u0000-\u001f\u007f]/u;
  let started = false;

  function comparablePath(path) {
    return path.toLocaleLowerCase("en-US");
  }

  function safeWorkspacePath(path) {
    if (
      typeof path !== "string"
      || path.length < 1
      || path.length > MAX_PATH_CODE_UNITS
      || path.startsWith("/")
      || FORBIDDEN_PATH_CHARACTER_PATTERN.test(path)
    ) return false;
    const segments = path.split("/");
    return segments.length <= MAX_DEPTH + 1
      && segments.every((segment) => (
        segment.length > 0
        && segment !== "."
        && segment !== ".."
        && segment.length <= 128
        && segment === segment.normalize("NFKC").trim()
      ));
  }

  function comparePaths(left, right) {
    const comparableLeft = comparablePath(left);
    const comparableRight = comparablePath(right);
    if (comparableLeft < comparableRight) return -1;
    if (comparableLeft > comparableRight) return 1;
    return 0;
  }

  const disable = (name) => {
    try {
      Object.defineProperty(workerGlobal, name, {
        value: undefined,
        configurable: false,
        writable: false,
      });
    } catch {
      try {
        workerGlobal[name] = undefined;
      } catch {
        // Verification below fails closed if the capability remains reachable.
      }
    }
    if (workerGlobal[name] !== undefined) {
      throw new Error(`Python worker could not disable ${name}`);
    }
  };

  function restrictPrivateCapabilities() {
    for (const name of [
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
    ]) {
      disable(name);
    }
  }

  function isRecord(value) {
    return typeof value === "object" && value !== null;
  }

  function exactKeys(value, keys) {
    const actual = Object.keys(value).sort();
    const expected = [...keys].sort();
    return actual.length === expected.length
      && actual.every((key, index) => key === expected[index]);
  }

  function runtimeAssetBuffer(value, expectedBytes) {
    return value
      && Object.prototype.toString.call(value) === "[object ArrayBuffer]"
      && value.byteLength === expectedBytes
      ? value
      : null;
  }

  function parseRuntimeAssets(value) {
    if (
      !isRecord(value)
      || !exactKeys(value, [
        "version",
        ...RUNTIME_SCRIPT_NAMES,
        ...RUNTIME_ASSET_NAMES,
      ])
      || value.version !== RUNTIME_ASSET_PROTOCOL_VERSION
    ) throw new Error("Python runtime assets are invalid");
    const result = { version: RUNTIME_ASSET_PROTOCOL_VERSION };
    for (const name of RUNTIME_SCRIPT_NAMES) {
      const descriptor = RUNTIME_ASSET_MANIFEST[name];
      if (
        typeof value[name] !== "string"
        || new TextEncoder().encode(value[name]).byteLength !== descriptor.byteLength
      ) throw new Error(`Python runtime asset is invalid: ${descriptor.fileName}`);
      result[name] = value[name];
    }
    for (const name of RUNTIME_ASSET_NAMES) {
      const descriptor = RUNTIME_ASSET_MANIFEST[name];
      const buffer = runtimeAssetBuffer(value[name], descriptor.byteLength);
      if (!buffer) throw new Error(`Python runtime asset is invalid: ${descriptor.fileName}`);
      result[name] = buffer;
    }
    return result;
  }

  function hex(bytes) {
    let value = "";
    for (const byte of bytes) value += byte.toString(16).padStart(2, "0");
    return value;
  }

  function rotateRight(value, shift) {
    return (value >>> shift) | (value << (32 - shift));
  }

  function sha256Fallback(value) {
    const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
    const paddedBytes = Math.ceil((bytes.byteLength + 9) / 64) * 64;
    const bitLength = bytes.byteLength * 8;
    const bitLengthHigh = Math.floor(bitLength / 0x1_0000_0000);
    const bitLengthLow = bitLength >>> 0;
    const words = new Uint32Array(64);
    let h0 = 0x6a09e667;
    let h1 = 0xbb67ae85;
    let h2 = 0x3c6ef372;
    let h3 = 0xa54ff53a;
    let h4 = 0x510e527f;
    let h5 = 0x9b05688c;
    let h6 = 0x1f83d9ab;
    let h7 = 0x5be0cd19;
    for (let blockOffset = 0; blockOffset < paddedBytes; blockOffset += 64) {
      for (let index = 0; index < 16; index += 1) {
        let word = 0;
        for (let byteIndex = 0; byteIndex < 4; byteIndex += 1) {
          const offset = blockOffset + index * 4 + byteIndex;
          let byte = offset < bytes.byteLength
            ? bytes[offset]
            : offset === bytes.byteLength
              ? 0x80
              : 0;
          if (offset >= paddedBytes - 8) {
            const lengthOffset = offset - (paddedBytes - 8);
            const lengthWord = lengthOffset < 4 ? bitLengthHigh : bitLengthLow;
            byte = (lengthWord >>> ((3 - (lengthOffset % 4)) * 8)) & 0xff;
          }
          word = (word << 8) | byte;
        }
        words[index] = word >>> 0;
      }
      for (let index = 16; index < 64; index += 1) {
        const left = words[index - 15];
        const right = words[index - 2];
        const sigma0 = rotateRight(left, 7) ^ rotateRight(left, 18) ^ (left >>> 3);
        const sigma1 = rotateRight(right, 17) ^ rotateRight(right, 19) ^ (right >>> 10);
        words[index] = (words[index - 16] + sigma0 + words[index - 7] + sigma1) >>> 0;
      }
      let a = h0;
      let b = h1;
      let c = h2;
      let d = h3;
      let e = h4;
      let f = h5;
      let g = h6;
      let h = h7;
      for (let index = 0; index < 64; index += 1) {
        const sum1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
        const choice = (e & f) ^ (~e & g);
        const temp1 = (h + sum1 + choice + SHA256_K[index] + words[index]) >>> 0;
        const sum0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
        const majority = (a & b) ^ (a & c) ^ (b & c);
        const temp2 = (sum0 + majority) >>> 0;
        h = g;
        g = f;
        f = e;
        e = (d + temp1) >>> 0;
        d = c;
        c = b;
        b = a;
        a = (temp1 + temp2) >>> 0;
      }
      h0 = (h0 + a) >>> 0;
      h1 = (h1 + b) >>> 0;
      h2 = (h2 + c) >>> 0;
      h3 = (h3 + d) >>> 0;
      h4 = (h4 + e) >>> 0;
      h5 = (h5 + f) >>> 0;
      h6 = (h6 + g) >>> 0;
      h7 = (h7 + h) >>> 0;
    }
    const result = new Uint8Array(32);
    const view = new DataView(result.buffer);
    [h0, h1, h2, h3, h4, h5, h6, h7]
      .forEach((word, index) => view.setUint32(index * 4, word));
    return result;
  }

  async function sha256(value) {
    return typeof nativeDigest === "function"
      ? new Uint8Array(await nativeDigest("SHA-256", value))
      : sha256Fallback(value);
  }

  async function verifyRuntimeAssets(assets) {
    for (const name of [...RUNTIME_SCRIPT_NAMES, ...RUNTIME_ASSET_NAMES]) {
      const descriptor = RUNTIME_ASSET_MANIFEST[name];
      const bytes = typeof assets[name] === "string"
        ? new TextEncoder().encode(assets[name])
        : assets[name];
      const actual = hex(await sha256(bytes));
      if (actual !== descriptor.sha256) {
        throw new Error(`Python runtime integrity check failed: ${descriptor.fileName}`);
      }
    }
  }

  function installRuntimeAssetGateway(assets) {
    if (
      typeof BlobConstructor !== "function"
      || typeof ResponseConstructor !== "function"
      || typeof URLConstructor !== "function"
      || typeof URLConstructor.createObjectURL !== "function"
      || typeof URLConstructor.revokeObjectURL !== "function"
    ) {
      throw new Error("Python runtime response primitives are unavailable");
    }
    const runtimeByUrl = new Map(RUNTIME_ASSET_NAMES.map((name) => {
      const descriptor = RUNTIME_ASSET_MANIFEST[name];
      return [
        `${MEMORY_RUNTIME_BASE_URL}${descriptor.fileName}`,
        { bytes: assets[name], descriptor },
      ];
    }));
    const memoryFetch = async (input, init = undefined) => {
      const rawUrl = typeof input === "string" || input instanceof URLConstructor
        ? String(input)
        : isRecord(input) && typeof input.url === "string"
          ? input.url
          : "";
      const method = String(init?.method ?? input?.method ?? "GET").toUpperCase();
      const url = new URLConstructor(rawUrl, workerGlobal.location.href);
      const asset = method === "GET" ? runtimeByUrl.get(url.href) : undefined;
      if (!asset) throw new TypeError("Python worker network access is disabled");
      return new ResponseConstructor(asset.bytes, {
        status: 200,
        headers: {
          "Content-Length": String(asset.descriptor.byteLength),
          "Content-Type": asset.descriptor.contentType,
        },
      });
    };
    try {
      Object.defineProperty(workerGlobal, "fetch", {
        value: memoryFetch,
        configurable: true,
        writable: false,
      });
    } catch {
      throw new Error("Python worker could not replace fetch");
    }
    if (workerGlobal.fetch !== memoryFetch) {
      throw new Error("Python worker could not replace fetch");
    }
    const asmBlobUrl = URLConstructor.createObjectURL(new BlobConstructor(
      [assets.pyodideAsmScript],
      { type: "text/javascript" },
    ));
    const runtimeImportScripts = (url) => {
      const resolved = new URLConstructor(String(url), MEMORY_RUNTIME_BASE_URL).href;
      if (resolved !== `${MEMORY_RUNTIME_BASE_URL}pyodide.asm.js`) {
        throw new TypeError("Python worker script loading is disabled");
      }
      return loadScript(asmBlobUrl);
    };
    try {
      Object.defineProperty(workerGlobal, "importScripts", {
        value: runtimeImportScripts,
        configurable: true,
        writable: false,
      });
    } catch {
      URLConstructor.revokeObjectURL(asmBlobUrl);
      throw new Error("Python worker could not replace importScripts");
    }
    for (const name of [
      "EventSource",
      "RTCPeerConnection",
      "SharedWorker",
      "WebSocket",
      "WebSocketStream",
      "WebTransport",
      "Worker",
      "XMLHttpRequest",
    ]) disable(name);
    return () => URLConstructor.revokeObjectURL(asmBlobUrl);
  }

  function fileBaseIdentity(value, byteLength, isText) {
    if (
      !isRecord(value)
      || typeof value.entryId !== "string"
      || !ENTRY_ID_PATTERN.test(value.entryId)
      || value.contentKind !== (isText ? "text" : "blob")
      || typeof value.sha256 !== "string"
      || !SHA256_PATTERN.test(value.sha256)
      || value.byteSize !== byteLength
    ) {
      throw new Error("Workspace file baseline identity is invalid");
    }
    return {
      entryId: value.entryId,
      contentKind: value.contentKind,
      sha256: value.sha256,
      byteSize: value.byteSize,
    };
  }

  function sharedBuffer(value, expectedBytes) {
    return value
      && Object.prototype.toString.call(value) === "[object SharedArrayBuffer]"
      && value.byteLength === expectedBytes
      ? value
      : null;
  }

  function workspacePayload(payload, request) {
    if (!Array.isArray(payload.files) || !Array.isArray(payload.directories)) {
      throw new Error("Workspace entries are missing");
    }
    if (
      payload.files.length < 1
      || payload.files.length + payload.directories.length > MAX_WORKSPACE_ENTRIES
    ) {
      throw new Error("Workspace entry count exceeds the execution limit");
    }
    let total = 0;
    const paths = new Set();
    const filePaths = new Set();
    const entryIds = new Set();
    const directories = payload.directories.map((candidate) => {
      if (
        !isRecord(candidate)
        || !safeWorkspacePath(candidate.path)
        || typeof candidate.entryId !== "string"
        || !ENTRY_ID_PATTERN.test(candidate.entryId)
      ) {
        throw new Error("Workspace directory is invalid");
      }
      const pathKey = comparablePath(candidate.path);
      if (paths.has(pathKey) || entryIds.has(candidate.entryId)) {
        throw new Error("Workspace directory is duplicated");
      }
      paths.add(pathKey);
      entryIds.add(candidate.entryId);
      return { path: candidate.path, entryId: candidate.entryId };
    }).sort((left, right) => comparePaths(left.path, right.path));
    const files = payload.files.map((candidate) => {
      if (!isRecord(candidate)) throw new Error("Workspace file is invalid");
      const path = candidate.path;
      const content = candidate.content;
      const byteView = ArrayBuffer.isView(candidate.bytes)
        ? new Uint8Array(
            candidate.bytes.buffer,
            candidate.bytes.byteOffset,
            candidate.bytes.byteLength,
          )
        : candidate.bytes instanceof ArrayBuffer
          ? new Uint8Array(candidate.bytes)
          : null;
      const isText = typeof content === "string";
      const comparablePath = typeof path === "string"
        ? path.toLocaleLowerCase("en-US")
        : "";
      if (
        !safeWorkspacePath(path)
        || (isText === (byteView !== null))
        || (isText
          ? new TextEncoder().encode(content).byteLength
          : byteView.byteLength) > MAX_FILE_BYTES
        || paths.has(comparablePath)
      ) {
        throw new Error("Workspace file is invalid");
      }
      const bytes = isText ? new TextEncoder().encode(content) : byteView.slice();
      const base = fileBaseIdentity(candidate.base, bytes.byteLength, isText);
      if (entryIds.has(base.entryId)) {
        throw new Error("Workspace entry ID is duplicated");
      }
      total += bytes.byteLength;
      if (total > MAX_WORKSPACE_BYTES) {
        throw new Error("Workspace exceeds the execution size limit");
      }
      paths.add(comparablePath);
      filePaths.add(comparablePath);
      entryIds.add(base.entryId);
      return isText
        ? { path, content, bytes, base }
        : { path, bytes, base };
    }).sort((left, right) => comparePaths(left.path, right.path));
    const entrypoint = payload.entrypoint;
    if (
      !safeWorkspacePath(entrypoint)
      || !filePaths.has(entrypoint.toLocaleLowerCase("en-US"))
    ) {
      throw new Error("Python entry point is invalid");
    }
    if (
      payload.stdin !== null
      && (
        typeof payload.stdin !== "string"
        || payload.stdin.length > MAX_STDIN_CHARS
      )
    ) {
      throw new Error("Program input exceeds the execution limit");
    }
    const stdinControlBuffer = payload.stdin === null
      ? sharedBuffer(request.stdinControl, STDIN_CONTROL_BYTES)
      : null;
    const stdinDataBuffer = payload.stdin === null
      ? sharedBuffer(request.stdinData, MAX_STDIN_LINE_BYTES)
      : null;
    if (
      (payload.stdin === null && (!stdinControlBuffer || !stdinDataBuffer))
      || (
        payload.stdin !== null
        && (request.stdinControl !== undefined || request.stdinData !== undefined)
      )
    ) {
      throw new Error("Interactive program input buffers are invalid");
    }
    return {
      kind: "workspace",
      files,
      directories,
      entrypoint,
      stdin: payload.stdin,
      ...(stdinControlBuffer && stdinDataBuffer
        ? {
            stdinControl: new Int32Array(stdinControlBuffer),
            stdinData: new Uint8Array(stdinDataBuffer),
          }
        : {}),
    };
  }

  function parseRequest(data) {
    if (
      !isRecord(data)
      || data.type !== REQUEST_TYPE
      || data.protocolVersion !== PROTOCOL_VERSION
      || typeof data.runId !== "string"
      || !RUN_ID_PATTERN.test(data.runId)
      || !isRecord(data.payload)
    ) {
      throw new Error("Python runner request is invalid");
    }
    const runtimeAssets = parseRuntimeAssets(data.runtimeAssets);
    if (data.payload.kind === "script") {
      if (
        typeof data.payload.code !== "string"
        || data.payload.code.length > MAX_SCRIPT_CHARS
      ) {
        throw new Error("Python source exceeds the execution limit");
      }
      return {
        runId: data.runId,
        payload: { kind: "script", code: data.payload.code },
        runtimeAssets,
      };
    }
    if (data.payload.kind === "workspace") {
      return {
        runId: data.runId,
        payload: workspacePayload(data.payload, data),
        runtimeAssets,
      };
    }
    throw new Error("Python runner payload is invalid");
  }

  async function materializeWorkspace(pyodide, workspace) {
    await pyodide.runPythonAsync(`
import os, shutil
shutil.rmtree("/workspace", ignore_errors=True)
os.makedirs("/workspace", exist_ok=True)
`);
    for (const directory of workspace.directories) {
      pyodide.FS.mkdirTree(`/workspace/${directory.path}`);
    }
    for (const file of workspace.files) {
      const segments = file.path.split("/");
      segments.pop();
      if (segments.length > 0) {
        pyodide.FS.mkdirTree(`/workspace/${segments.join("/")}`);
      }
      if (typeof file.content === "string") {
        pyodide.FS.writeFile(`/workspace/${file.path}`, file.content, {
          encoding: "utf8",
        });
      } else {
        pyodide.FS.writeFile(`/workspace/${file.path}`, file.bytes);
      }
    }
  }

  async function executeWorkspace(pyodide, workspace, runId) {
    if (typeof pyodide.setStdin === "function") {
      if (workspace.stdin === null) {
        const control = workspace.stdinControl;
        const data = workspace.stdinData;
        const decoder = new TextDecoder("utf-8", { fatal: true });
        let requestNumber = 0;
        let totalBytes = 0;
        pyodide.setStdin({
          stdin: () => {
            requestNumber += 1;
            const requestId = `stdin-${requestNumber}`;
            Atomics.store(control, 1, 0);
            Atomics.store(control, 0, STDIN_WAITING);
            sendResult({
              type: INPUT_REQUEST_TYPE,
              protocolVersion: PROTOCOL_VERSION,
              runId,
              requestId,
            });
            while (Atomics.load(control, 0) === STDIN_WAITING) {
              Atomics.wait(control, 0, STDIN_WAITING);
            }
            const state = Atomics.load(control, 0);
            if (state === STDIN_EOF) {
              Atomics.store(control, 0, STDIN_IDLE);
              return null;
            }
            const byteLength = Atomics.load(control, 1);
            if (
              state !== STDIN_VALUE
              || byteLength < 0
              || byteLength > data.byteLength
              || totalBytes + byteLength > MAX_STDIN_CHARS
            ) {
              throw new Error("Interactive program input is invalid");
            }
            totalBytes += byteLength;
            const value = decoder.decode(data.slice(0, byteLength));
            Atomics.store(control, 1, 0);
            Atomics.store(control, 0, STDIN_IDLE);
            return value;
          },
          isatty: true,
          autoEOF: true,
        });
      } else {
        const lines = workspace.stdin === ""
          ? []
          : workspace.stdin.split(/\r\n|\n|\r/u);
        if (lines.at(-1) === "" && /(?:\r\n|\n|\r)$/u.test(workspace.stdin)) {
          lines.pop();
        }
        let cursor = 0;
        pyodide.setStdin({
          stdin: () => cursor < lines.length ? lines[cursor++] : null,
          isatty: false,
        });
      }
    } else if (workspace.stdin === null) {
      throw new Error("Interactive Python input is unavailable");
    }
    const entrypoint = JSON.stringify(`/workspace/${workspace.entrypoint}`);
    await pyodide.runPythonAsync(`
import os, runpy, sys
os.chdir("/workspace")
sys.path.insert(0, "/workspace")
runpy.run_path(${entrypoint}, run_name="__main__")
None
`);
  }

  function equalBytes(left, right) {
    return left.byteLength === right.byteLength
      && left.every((value, index) => value === right[index]);
  }

  function snapshotWorkspace(pyodide) {
    const files = [];
    const seenPaths = new Set();
    let entryCount = 0;
    let totalBytes = 0;
    const visit = (absoluteDirectory, relativeDirectory) => {
      const names = pyodide.FS.readdir(absoluteDirectory)
        .filter((name) => name !== "." && name !== "..")
        .sort(comparePaths);
      for (const name of names) {
        const path = relativeDirectory ? `${relativeDirectory}/${name}` : name;
        if (!safeWorkspacePath(path)) {
          throw new Error("Python created an unsafe workspace path");
        }
        const pathKey = comparablePath(path);
        if (seenPaths.has(pathKey)) {
          throw new Error("Python created case-colliding workspace paths");
        }
        seenPaths.add(pathKey);
        entryCount += 1;
        if (entryCount > MAX_WORKSPACE_ENTRIES) {
          throw new Error("Python workspace result has too many entries");
        }
        const absolutePath = `/workspace/${path}`;
        const stat = pyodide.FS.lstat(absolutePath);
        if (pyodide.FS.isLink(stat.mode)) {
          throw new Error("Python workspace result contains a symbolic link");
        }
        if (pyodide.FS.isDir(stat.mode)) {
          visit(absolutePath, path);
          continue;
        }
        if (!pyodide.FS.isFile(stat.mode)) {
          throw new Error("Python workspace result contains a non-regular file");
        }
        const value = pyodide.FS.readFile(absolutePath, { encoding: "binary" });
        const bytes = ArrayBuffer.isView(value)
          ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength).slice()
          : value instanceof ArrayBuffer
            ? new Uint8Array(value).slice()
            : null;
        if (!bytes || bytes.byteLength > MAX_FILE_BYTES) {
          throw new Error("Python workspace result file exceeds the size limit");
        }
        totalBytes += bytes.byteLength;
        if (totalBytes > MAX_WORKSPACE_BYTES) {
          throw new Error("Python workspace result exceeds the aggregate size limit");
        }
        files.push({ path, bytes });
      }
    };
    visit("/workspace", "");
    return files.sort((left, right) => comparePaths(left.path, right.path));
  }

  function workspaceDelta(workspace, resultFiles) {
    const baselineByPath = new Map(workspace.files.map((file) => (
      [comparablePath(file.path), file]
    )));
    const resultByPath = new Map(resultFiles.map((file) => (
      [comparablePath(file.path), file]
    )));
    const changes = [];
    for (const baseline of workspace.files) {
      const result = resultByPath.get(comparablePath(baseline.path));
      if (!result) {
        changes.push({
          kind: "delete",
          path: baseline.path,
          base: baseline.base,
        });
      } else if (!equalBytes(baseline.bytes, result.bytes)) {
        changes.push({
          kind: "write",
          path: result.path,
          base: baseline.base,
          bytes: result.bytes,
        });
      }
    }
    for (const result of resultFiles) {
      if (!baselineByPath.has(comparablePath(result.path))) {
        changes.push({
          kind: "write",
          path: result.path,
          base: null,
          bytes: result.bytes,
        });
      }
    }
    changes.sort((left, right) => comparePaths(left.path, right.path));
    return { version: WORKSPACE_DELTA_VERSION, changes };
  }

  async function getRuntime(runtimeAssets) {
    await verifyRuntimeAssets(runtimeAssets);
    const releaseRuntimeGateway = installRuntimeAssetGateway(runtimeAssets);
    const loaderBlobUrl = URLConstructor.createObjectURL(new BlobConstructor(
      [runtimeAssets.pyodideScript],
      { type: "text/javascript" },
    ));
    try {
      loadScript(loaderBlobUrl);
    } finally {
      URLConstructor.revokeObjectURL(loaderBlobUrl);
    }
    if (typeof workerGlobal.loadPyodide !== "function") {
      throw new Error("Pyodide loader is unavailable");
    }
    const runtime = await workerGlobal.loadPyodide({
      indexURL: MEMORY_RUNTIME_BASE_URL,
      jsglobals: Object.freeze(Object.create(null)),
    });
    restrictPrivateCapabilities();
    releaseRuntimeGateway();
    return runtime;
  }

  function requestRunId(data) {
    return isRecord(data)
      && typeof data.runId === "string"
      && RUN_ID_PATTERN.test(data.runId)
      ? data.runId
      : "invalid";
  }

  function terminal(runId, status, output, truncated, delta) {
    sendResult({
      type: RESULT_TYPE,
      protocolVersion: PROTOCOL_VERSION,
      runId,
      status,
      output,
      truncated,
      ...(delta ? { workspaceDelta: delta } : {}),
    });
    closeWorker();
  }

  workerGlobal.addEventListener("message", async (event) => {
    if (started) return;
    started = true;
    let runId = requestRunId(event.data);
    const output = [];
    let outputLength = 0;
    let truncated = false;
      const append = (value) => {
      if (truncated) return;
      const text = String(value);
      if (text.length === 0) return;
      const remaining = MAX_OUTPUT_CHARS - outputLength;
      if (remaining <= 0) {
        truncated = true;
        const marker = "[Вывод сокращён]";
        output.push(marker);
        sendResult({
          type: OUTPUT_TYPE,
          protocolVersion: PROTOCOL_VERSION,
          runId,
          chunk: marker,
        });
        return;
      }
      if (text.length > remaining) {
        const chunk = `${text.slice(0, remaining)}\n[Вывод сокращён]`;
        output.push(chunk);
        sendResult({
          type: OUTPUT_TYPE,
          protocolVersion: PROTOCOL_VERSION,
          runId,
          chunk,
        });
        outputLength = MAX_OUTPUT_CHARS;
        truncated = true;
        return;
      }
      output.push(text);
      outputLength += text.length;
      sendResult({
        type: OUTPUT_TYPE,
        protocolVersion: PROTOCOL_VERSION,
        runId,
        chunk: text,
      });
    };
    const stdoutDecoder = new TextDecoder("utf-8");
    const stderrDecoder = new TextDecoder("utf-8");
    const appendBytes = (decoder, buffer) => {
      append(decoder.decode(buffer, { stream: true }));
      return buffer.byteLength;
    };
    const flushOutput = () => {
      append(stdoutDecoder.decode());
      append(stderrDecoder.decode());
    };
    let delta;

    try {
      const request = parseRequest(event.data);
      runId = request.runId;
      const pyodide = await getRuntime(request.runtimeAssets);
      pyodide.setStdout({
        write: (buffer) => appendBytes(stdoutDecoder, buffer),
      });
      pyodide.setStderr({
        write: (buffer) => appendBytes(stderrDecoder, buffer),
      });
      if (request.payload.kind === "workspace") {
        await materializeWorkspace(pyodide, request.payload);
        let executionError = null;
        try {
          await executeWorkspace(pyodide, request.payload, runId);
        } catch (error) {
          executionError = error;
        }
        delta = workspaceDelta(request.payload, snapshotWorkspace(pyodide));
        if (executionError !== null) throw executionError;
      } else {
        const result = await pyodide.runPythonAsync(request.payload.code);
        if (result !== undefined && result !== null) {
          append(String(result));
          if (typeof result.destroy === "function") result.destroy();
        }
      }
      flushOutput();
      terminal(
        runId,
        "ok",
        output.join(""),
        truncated,
        delta,
      );
    } catch (error) {
      flushOutput();
      append(error instanceof Error ? error.message : String(error));
      terminal(runId, "runtime-error", output.join(""), truncated, delta);
    }
  });
})();

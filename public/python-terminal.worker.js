(() => {
  const workerGlobal = self;
  const sendMessage = workerGlobal.postMessage.bind(workerGlobal);
  const closeWorker = typeof workerGlobal.close === "function"
    ? workerGlobal.close.bind(workerGlobal)
    : () => undefined;
  const loadScript = workerGlobal.importScripts.bind(workerGlobal);

  const PROTOCOL_VERSION = 3;
  const WORKSPACE_DELTA_VERSION = 1;
  const OPEN_TYPE = "eduri.python-terminal.open";
  const COMMAND_TYPE = "eduri.python-terminal.command";
  const READY_TYPE = "eduri.python-terminal.ready";
  const OUTPUT_TYPE = "eduri.python-terminal.output";
  const INPUT_REQUEST_TYPE = "eduri.python-terminal.input-request";
  const RESULT_TYPE = "eduri.python-terminal.result";
  const FATAL_TYPE = "eduri.python-terminal.fatal";

  const ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/u;
  const ENTRY_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/u;
  const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
  const FORBIDDEN_PATH_CHARACTER_PATTERN = /[\\\u0000-\u001f\u007f]/u;
  const MAX_OUTPUT_CHARS = 256 * 1024;
  const MAX_OUTPUT_CHUNK_CHARS = 64 * 1024;
  const OUTPUT_TRUNCATION_MARKER = "\n[Output truncated]";
  const MAX_SESSION_OUTPUT_CHARS = 8 * 1024 * 1024;
  const MAX_COMMANDS = 4_096;
  const MAX_WORKSPACE_ENTRIES = 512;
  const MAX_FILE_BYTES = 2 * 1024 * 1024;
  const MAX_WORKSPACE_BYTES = 8 * 1024 * 1024;
  const MAX_PATH_CODE_UNITS = 1024;
  const MAX_DEPTH = 32;
  const MAX_STDIN_BYTES = 1024 * 1024;
  const MAX_STDIN_LINE_BYTES = 64 * 1024;
  const STDIN_CONTROL_BYTES = Int32Array.BYTES_PER_ELEMENT * 2;
  const INTERRUPT_BYTES = Int32Array.BYTES_PER_ELEMENT;
  const STDIN_IDLE = 0;
  const STDIN_WAITING = 1;
  const STDIN_VALUE = 2;
  const STDIN_EOF = 3;
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

  let opened = false;
  let ready = false;
  let fatalSent = false;
  let sessionId = "invalid";
  let runtime = null;
  let workspace = null;
  let stdinControl = null;
  let stdinData = null;
  let interrupt = null;
  let commandCount = 0;
  let inputRequestCount = 0;
  let submittedInputBytes = 0;
  let sessionOutputChars = 0;
  let mode = "shell";
  let activeOutput = null;
  let commandQueue = Promise.resolve();

  function isRecord(value) {
    return typeof value === "object" && value !== null;
  }

  function comparablePath(path) {
    return path.toLocaleLowerCase("en-US");
  }

  function comparePaths(left, right) {
    const comparableLeft = comparablePath(left);
    const comparableRight = comparablePath(right);
    if (comparableLeft < comparableRight) return -1;
    if (comparableLeft > comparableRight) return 1;
    return 0;
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
        // Verification below fails closed when a capability cannot be removed.
      }
    }
    if (workerGlobal[name] !== undefined) {
      throw new Error(`Python terminal could not disable ${name}`);
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

  function fatal(message) {
    if (fatalSent) return;
    fatalSent = true;
    sendMessage({
      type: FATAL_TYPE,
      protocolVersion: PROTOCOL_VERSION,
      sessionId,
      message: String(message).slice(0, 4_096),
    });
    closeWorker();
  }

  function sharedBuffer(value, expectedBytes) {
    return value
      && Object.prototype.toString.call(value) === "[object SharedArrayBuffer]"
      && value.byteLength === expectedBytes
      ? value
      : null;
  }

  function fileBaseIdentity(value, byteLength, isText) {
    if (
      !isRecord(value)
      || !exactKeys(value, ["entryId", "contentKind", "sha256", "byteSize"])
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

  function parseWorkspace(value) {
    if (
      !isRecord(value)
      || !exactKeys(value, ["files", "directories"])
      || !Array.isArray(value.files)
      || !Array.isArray(value.directories)
      || value.files.length < 1
      || value.files.length + value.directories.length > MAX_WORKSPACE_ENTRIES
    ) {
      throw new Error("Workspace entries are invalid");
    }
    let totalBytes = 0;
    const paths = new Set();
    const entryIds = new Set();
    const directories = value.directories.map((candidate) => {
      if (
        !isRecord(candidate)
        || !exactKeys(candidate, ["path", "entryId"])
        || !safeWorkspacePath(candidate.path)
        || typeof candidate.entryId !== "string"
        || !ENTRY_ID_PATTERN.test(candidate.entryId)
      ) throw new Error("Workspace directory is invalid");
      const pathKey = comparablePath(candidate.path);
      if (paths.has(pathKey) || entryIds.has(candidate.entryId)) {
        throw new Error("Workspace directory is duplicated");
      }
      paths.add(pathKey);
      entryIds.add(candidate.entryId);
      return { path: candidate.path, entryId: candidate.entryId };
    }).sort((left, right) => comparePaths(left.path, right.path));
    const files = value.files.map((candidate) => {
      if (!isRecord(candidate)) throw new Error("Workspace file is invalid");
      const isText = typeof candidate.content === "string";
      const byteView = ArrayBuffer.isView(candidate.bytes)
        ? new Uint8Array(
            candidate.bytes.buffer,
            candidate.bytes.byteOffset,
            candidate.bytes.byteLength,
          )
        : candidate.bytes instanceof ArrayBuffer
          ? new Uint8Array(candidate.bytes)
          : null;
      const expectedKeys = isText
        ? ["path", "base", "content"]
        : ["path", "base", "bytes"];
      if (
        !exactKeys(candidate, expectedKeys)
        || !safeWorkspacePath(candidate.path)
        || isText === (byteView !== null)
      ) throw new Error("Workspace file is invalid");
      const bytes = isText
        ? new TextEncoder().encode(candidate.content)
        : byteView.slice();
      if (bytes.byteLength > MAX_FILE_BYTES) {
        throw new Error("Workspace file exceeds the execution size limit");
      }
      const pathKey = comparablePath(candidate.path);
      const base = fileBaseIdentity(candidate.base, bytes.byteLength, isText);
      if (paths.has(pathKey) || entryIds.has(base.entryId)) {
        throw new Error("Workspace file is duplicated");
      }
      totalBytes += bytes.byteLength;
      if (totalBytes > MAX_WORKSPACE_BYTES) {
        throw new Error("Workspace exceeds the execution size limit");
      }
      paths.add(pathKey);
      entryIds.add(base.entryId);
      return isText
        ? { path: candidate.path, content: candidate.content, bytes, base }
        : { path: candidate.path, bytes, base };
    }).sort((left, right) => comparePaths(left.path, right.path));
    return { files, directories };
  }

  function parseOpen(data) {
    if (
      !isRecord(data)
      || !exactKeys(data, [
        "type",
        "protocolVersion",
        "sessionId",
        "workspace",
        "runtimeAssets",
        "stdinControl",
        "stdinData",
        "interruptBuffer",
      ])
      || data.type !== OPEN_TYPE
      || data.protocolVersion !== PROTOCOL_VERSION
      || typeof data.sessionId !== "string"
      || !ID_PATTERN.test(data.sessionId)
    ) throw new Error("Python terminal open request is invalid");
    const controlBuffer = sharedBuffer(data.stdinControl, STDIN_CONTROL_BYTES);
    const dataBuffer = sharedBuffer(data.stdinData, MAX_STDIN_LINE_BYTES);
    const interruptBuffer = sharedBuffer(data.interruptBuffer, INTERRUPT_BYTES);
    if (!controlBuffer || !dataBuffer || !interruptBuffer) {
      throw new Error("Python terminal shared buffers are invalid");
    }
    return {
      sessionId: data.sessionId,
      workspace: parseWorkspace(data.workspace),
      runtimeAssets: parseRuntimeAssets(data.runtimeAssets),
      stdinControl: new Int32Array(controlBuffer),
      stdinData: new Uint8Array(dataBuffer),
      interrupt: new Int32Array(interruptBuffer),
    };
  }

  function parseCommand(data) {
    if (
      !isRecord(data)
      || data.type !== COMMAND_TYPE
      || data.protocolVersion !== PROTOCOL_VERSION
      || data.sessionId !== sessionId
      || typeof data.commandId !== "string"
      || !ID_PATTERN.test(data.commandId)
      || typeof data.action !== "string"
    ) throw new Error("Python terminal command is invalid");
    const baseKeys = ["type", "protocolVersion", "sessionId", "commandId", "action"];
    if (data.action === "execute") {
      if (!exactKeys(data, [...baseKeys, "entrypoint"]) || !safeWorkspacePath(data.entrypoint)) {
        throw new Error("Python entry point is invalid");
      }
      return { commandId: data.commandId, action: data.action, entrypoint: data.entrypoint };
    }
    if (data.action === "repl-line") {
      if (
        !exactKeys(data, [...baseKeys, "line"])
        || typeof data.line !== "string"
        || new TextEncoder().encode(data.line).byteLength > MAX_STDIN_LINE_BYTES
      ) throw new Error("Python REPL line is invalid");
      return { commandId: data.commandId, action: data.action, line: data.line };
    }
    if (
      data.action === "start-repl"
      || data.action === "repl-interrupt"
      || data.action === "repl-eof"
    ) {
      if (!exactKeys(data, baseKeys)) throw new Error("Python terminal command has unknown fields");
      return { commandId: data.commandId, action: data.action };
    }
    throw new Error("Python terminal command action is invalid");
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
    const pyodide = await workerGlobal.loadPyodide({
      indexURL: MEMORY_RUNTIME_BASE_URL,
      jsglobals: Object.freeze(Object.create(null)),
    });
    restrictPrivateCapabilities();
    releaseRuntimeGateway();
    return pyodide;
  }

  async function materializeWorkspace(pyodide, value) {
    await pyodide.runPythonAsync(`
import os, shutil
shutil.rmtree("/workspace", ignore_errors=True)
os.makedirs("/workspace", exist_ok=True)
`);
    for (const directory of value.directories) {
      pyodide.FS.mkdirTree(`/workspace/${directory.path}`);
    }
    for (const file of value.files) {
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

  function installInteractiveInput(pyodide) {
    if (typeof pyodide.setStdin !== "function") {
      throw new Error("Interactive Python input is unavailable");
    }
    if (typeof pyodide.setInterruptBuffer !== "function") {
      throw new Error("Python interrupt support is unavailable");
    }
    const decoder = new TextDecoder("utf-8", { fatal: true });
    pyodide.setInterruptBuffer(interrupt);
    pyodide.setStdin({
      stdin: () => {
        if (!activeOutput) throw new Error("Python requested input outside a command");
        inputRequestCount += 1;
        if (inputRequestCount > MAX_COMMANDS) {
          throw new Error("Python requested too many input lines");
        }
        const requestId = `stdin-${inputRequestCount}`;
        Atomics.store(stdinControl, 1, 0);
        Atomics.store(stdinControl, 0, STDIN_WAITING);
        sendMessage({
          type: INPUT_REQUEST_TYPE,
          protocolVersion: PROTOCOL_VERSION,
          sessionId,
          commandId: activeOutput.commandId,
          requestId,
        });
        while (Atomics.load(stdinControl, 0) === STDIN_WAITING) {
          Atomics.wait(stdinControl, 0, STDIN_WAITING);
        }
        const state = Atomics.load(stdinControl, 0);
        if (state === STDIN_EOF) {
          Atomics.store(stdinControl, 0, STDIN_IDLE);
          return null;
        }
        const byteLength = Atomics.load(stdinControl, 1);
        if (
          state !== STDIN_VALUE
          || byteLength < 0
          || byteLength > stdinData.byteLength
          || submittedInputBytes + byteLength > MAX_STDIN_BYTES
        ) throw new Error("Interactive program input is invalid");
        submittedInputBytes += byteLength;
        const value = decoder.decode(stdinData.slice(0, byteLength));
        Atomics.store(stdinControl, 1, 0);
        Atomics.store(stdinControl, 0, STDIN_IDLE);
        return value;
      },
      isatty: true,
      autoEOF: true,
    });
  }

  function sendOutputChunk(commandId, value) {
    let cursor = 0;
    while (cursor < value.length) {
      const chunk = value.slice(cursor, cursor + MAX_OUTPUT_CHUNK_CHARS);
      cursor += chunk.length;
      sendMessage({
        type: OUTPUT_TYPE,
        protocolVersion: PROTOCOL_VERSION,
        sessionId,
        commandId,
        chunk,
      });
    }
  }

  function streamAcceptedOutput(value) {
    if (!activeOutput || value.length === 0) return;
    activeOutput.outputChars += value.length;
    sessionOutputChars += value.length;
    sendOutputChunk(activeOutput.commandId, value);
  }

  function appendOutput(value) {
    if (!activeOutput || activeOutput.truncated) return;
    const text = String(value);
    if (text.length === 0) return;
    const pending = activeOutput.pendingOutput + text;
    const rawLength = activeOutput.outputChars
      + activeOutput.pendingOutput.length
      + text.length;
    const contentLimit = Math.max(
      0,
      activeOutput.outputLimit - OUTPUT_TRUNCATION_MARKER.length,
    );
    const contentRemaining = Math.max(0, contentLimit - activeOutput.outputChars);

    if (rawLength > activeOutput.outputLimit) {
      streamAcceptedOutput(pending.slice(0, contentRemaining));
      activeOutput.pendingOutput = "";
      activeOutput.truncated = true;
      if (
        activeOutput.outputChars + OUTPUT_TRUNCATION_MARKER.length
        <= activeOutput.outputLimit
      ) {
        streamAcceptedOutput(OUTPUT_TRUNCATION_MARKER);
      }
      return;
    }

    streamAcceptedOutput(pending.slice(0, contentRemaining));
    activeOutput.pendingOutput = pending.slice(contentRemaining);
  }

  function installOutput(pyodide) {
    pyodide.setStdout({
      write: (buffer) => {
        if (activeOutput) {
          appendOutput(activeOutput.stdoutDecoder.decode(buffer, { stream: true }));
        }
        return buffer.byteLength;
      },
    });
    pyodide.setStderr({
      write: (buffer) => {
        if (activeOutput) {
          appendOutput(activeOutput.stderrDecoder.decode(buffer, { stream: true }));
        }
        return buffer.byteLength;
      },
    });
  }

  function flushOutput() {
    if (!activeOutput) return;
    appendOutput(activeOutput.stdoutDecoder.decode());
    appendOutput(activeOutput.stderrDecoder.decode());
  }

  function finishOutput() {
    if (!activeOutput || activeOutput.truncated) return;
    streamAcceptedOutput(activeOutput.pendingOutput);
    activeOutput.pendingOutput = "";
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

  function workspaceDelta(value, resultFiles) {
    const baselineByPath = new Map(value.files.map((file) => (
      [comparablePath(file.path), file]
    )));
    const resultByPath = new Map(resultFiles.map((file) => (
      [comparablePath(file.path), file]
    )));
    const changes = [];
    for (const baseline of value.files) {
      const result = resultByPath.get(comparablePath(baseline.path));
      if (!result) {
        changes.push({ kind: "delete", path: baseline.path, base: baseline.base });
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
        changes.push({ kind: "write", path: result.path, base: null, bytes: result.bytes });
      }
    }
    changes.sort((left, right) => comparePaths(left.path, right.path));
    return { version: WORKSPACE_DELTA_VERSION, changes };
  }

  async function executeEntrypoint(entrypoint) {
    const absolutePath = `/workspace/${entrypoint}`;
    let stat;
    try {
      stat = runtime.FS.lstat(absolutePath);
    } catch {
      throw new Error(`Python file not found: ${entrypoint}`);
    }
    if (runtime.FS.isLink(stat.mode) || !runtime.FS.isFile(stat.mode)) {
      throw new Error("Python entry point must be a regular workspace file");
    }
    const literal = JSON.stringify(absolutePath);
    await runtime.runPythonAsync(`
import os, runpy, sys
os.chdir("/workspace")
if "/workspace" not in sys.path:
    sys.path.insert(0, "/workspace")
_eduri_previous_argv = sys.argv
try:
    sys.argv = [${literal}]
    runpy.run_path(${literal}, run_name="__main__")
finally:
    sys.argv = _eduri_previous_argv
None
`);
  }

  async function startRepl() {
    await runtime.runPythonAsync(`
import code, os, sys
os.chdir("/workspace")
if "/workspace" not in sys.path:
    sys.path.insert(0, "/workspace")
_eduri_console = code.InteractiveConsole({"__name__": "__console__", "__doc__": None})
def _eduri_repl_push(line):
    try:
        return 1 if _eduri_console.push(line) else 0
    except SystemExit:
        _eduri_console.resetbuffer()
        return 2
None
`);
    mode = "repl";
    return ">>> ";
  }

  async function submitReplLine(line) {
    const literal = JSON.stringify(line);
    const result = await runtime.runPythonAsync(`_eduri_repl_push(${literal})`);
    const state = Number(result);
    if (result && typeof result.destroy === "function") result.destroy();
    if (state === 2) {
      await runtime.runPythonAsync("del _eduri_repl_push\ndel _eduri_console\nNone");
      mode = "shell";
      return null;
    }
    if (state !== 0 && state !== 1) throw new Error("Python REPL returned invalid state");
    return state === 1 ? "... " : ">>> ";
  }

  async function exitRepl() {
    await runtime.runPythonAsync(`
_eduri_console.resetbuffer()
del _eduri_repl_push
del _eduri_console
None
`);
    mode = "shell";
  }

  async function interruptRepl() {
    await runtime.runPythonAsync(`
_eduri_console.resetbuffer()
None
`);
    return ">>> ";
  }

  async function handleCommand(data) {
    if (!ready || fatalSent) throw new Error("Python terminal is not ready");
    commandCount += 1;
    if (commandCount > MAX_COMMANDS) throw new Error("Python terminal command limit exceeded");
    const command = parseCommand(data);
    if (
      ((command.action === "execute" || command.action === "start-repl") && mode !== "shell")
      || ((
        command.action === "repl-line"
        || command.action === "repl-interrupt"
        || command.action === "repl-eof"
      ) && mode !== "repl")
    ) throw new Error("Python terminal command is invalid for the current mode");
    Atomics.store(interrupt, 0, 0);
    activeOutput = {
      commandId: command.commandId,
      outputChars: 0,
      outputLimit: Math.min(
        MAX_OUTPUT_CHARS,
        Math.max(0, MAX_SESSION_OUTPUT_CHARS - sessionOutputChars),
      ),
      pendingOutput: "",
      truncated: false,
      stdoutDecoder: new TextDecoder("utf-8"),
      stderrDecoder: new TextDecoder("utf-8"),
    };
    let status = "ok";
    let prompt = null;
    try {
      if (command.action === "execute") {
        await executeEntrypoint(command.entrypoint);
      } else if (command.action === "start-repl") {
        prompt = await startRepl();
      } else if (command.action === "repl-line") {
        prompt = await submitReplLine(command.line);
      } else if (command.action === "repl-interrupt") {
        prompt = await interruptRepl();
      } else {
        await exitRepl();
      }
      flushOutput();
    } catch (error) {
      flushOutput();
      appendOutput(error instanceof Error ? error.message : String(error));
      status = "runtime-error";
      if (mode === "repl") prompt = ">>> ";
    }
    finishOutput();
    let delta;
    try {
      delta = workspaceDelta(workspace, snapshotWorkspace(runtime));
    } catch (error) {
      activeOutput = null;
      throw error;
    }
    const truncated = activeOutput.truncated;
    activeOutput = null;
    sendMessage({
      type: RESULT_TYPE,
      protocolVersion: PROTOCOL_VERSION,
      sessionId,
      commandId: command.commandId,
      status,
      mode,
      prompt: mode === "repl" ? prompt ?? ">>> " : null,
      truncated,
      workspaceDelta: delta,
    });
  }

  async function initialize(data) {
    try {
      const request = parseOpen(data);
      sessionId = request.sessionId;
      workspace = request.workspace;
      stdinControl = request.stdinControl;
      stdinData = request.stdinData;
      interrupt = request.interrupt;
      runtime = await getRuntime(request.runtimeAssets);
      await materializeWorkspace(runtime, workspace);
      installOutput(runtime);
      installInteractiveInput(runtime);
      ready = true;
      sendMessage({
        type: READY_TYPE,
        protocolVersion: PROTOCOL_VERSION,
        sessionId,
        mode: "shell",
      });
    } catch (error) {
      fatal(error instanceof Error ? error.message : String(error));
    }
  }

  workerGlobal.addEventListener("message", (event) => {
    if (!opened) {
      opened = true;
      void initialize(event.data);
      return;
    }
    commandQueue = commandQueue
      .then(() => handleCommand(event.data))
      .catch((error) => {
        fatal(error instanceof Error ? error.message : String(error));
      });
  });
})();

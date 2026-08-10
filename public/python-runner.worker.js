(() => {
  const workerGlobal = self;
  const sendResult = workerGlobal.postMessage.bind(workerGlobal);
  const closeWorker = typeof workerGlobal.close === "function"
    ? workerGlobal.close.bind(workerGlobal)
    : () => undefined;
  const loadScript = workerGlobal.importScripts.bind(workerGlobal);
  const PROTOCOL_VERSION = 3;
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
      };
    }
    if (data.payload.kind === "workspace") {
      return {
        runId: data.runId,
        payload: workspacePayload(data.payload, data),
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

  async function getRuntime() {
    loadScript(`${PYODIDE_RUNTIME_BASE_URL}pyodide.js`);
    if (typeof workerGlobal.loadPyodide !== "function") {
      throw new Error("Pyodide loader is unavailable");
    }
    const runtime = await workerGlobal.loadPyodide({
      indexURL: PYODIDE_RUNTIME_BASE_URL,
      jsglobals: Object.freeze(Object.create(null)),
    });
    restrictPrivateCapabilities();
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
      const pyodide = await getRuntime();
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

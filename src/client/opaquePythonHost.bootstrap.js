(() => {
  const bootstrap = () => {
    const INIT = "eduri.opaque-python-host.init";
    const READY = "eduri.opaque-python-host.ready";
    const PARENT_MESSAGE = "eduri.opaque-python-host.parent-message";
    const WORKER_MESSAGE = "eduri.opaque-python-host.worker-message";
    const ERROR = "eduri.opaque-python-host.error";
    const TERMINATE = "eduri.opaque-python-host.terminate";
    const CONTROL = "eduri.opaque-python-host.control";
    const ID = /^[A-Za-z0-9_-]{1,128}$/u;
    const MAX_OUTPUT = 256 * 1024 + 128;
    const MAX_CHUNK = 64 * 1024;
    const MAX_RUNTIME_SCRIPT = 2 * 1024 * 1024;
    const MAX_STDIN_TOTAL = 1024 * 1024;
    let initialized = false;
    const STDIN_IDLE = 0;
    const STDIN_WAITING = 1;
    const STDIN_VALUE = 2;
    const STDIN_EOF = 3;
    const record = (value) => typeof value === "object" && value !== null;
    const exactKeys = (value, keys) => {
      const actual = Object.keys(value);
      return actual.length === keys.length && keys.every((key) => actual.includes(key));
    };
    const runtimeAssets = (value) => record(value) && exactKeys(value, [
      "version",
      "pyodideScript",
      "pyodideAsmScript",
      "pyodideLock",
      "pyodideWasm",
      "pythonStdlib"
    ]) && value.version === 1 && typeof value.pyodideScript === "string" && value.pyodideScript.length > 0 && value.pyodideScript.length <= MAX_RUNTIME_SCRIPT && typeof value.pyodideAsmScript === "string" && value.pyodideAsmScript.length > 0 && value.pyodideAsmScript.length <= MAX_RUNTIME_SCRIPT && value.pyodideLock instanceof ArrayBuffer && value.pyodideLock.byteLength === 112205 && value.pyodideWasm instanceof ArrayBuffer && value.pyodideWasm.byteLength === 10103326 && value.pythonStdlib instanceof ArrayBuffer && value.pythonStdlib.byteLength === 2358894;
    const validDelta = (value) => {
      if (!record(value) || !exactKeys(value, ["version", "changes"]) || value.version !== 1 || !Array.isArray(value.changes)) {
        return false;
      }
      if (value.changes.length > 1024) return false;
      let bytes = 0;
      for (const change of value.changes) {
        if (!record(change) || typeof change.path !== "string" || change.path.length > 1024) {
          return false;
        }
        const validBase = (base) => record(base) && exactKeys(base, ["entryId", "contentKind", "sha256", "byteSize"]) && typeof base.entryId === "string" && ID.test(base.entryId) && (base.contentKind === "text" || base.contentKind === "blob") && typeof base.sha256 === "string" && /^[0-9a-f]{64}$/u.test(base.sha256) && Number.isSafeInteger(base.byteSize) && Number(base.byteSize) >= 0 && Number(base.byteSize) <= 2 * 1024 * 1024;
        if (change.kind === "delete") {
          if (!exactKeys(change, ["kind", "path", "base"]) || !validBase(change.base)) {
            return false;
          }
          continue;
        }
        if (change.kind !== "write") return false;
        if (!exactKeys(change, ["kind", "path", "base", "bytes"]) || change.base !== null && !validBase(change.base)) return false;
        const payload = change.bytes;
        if (!(payload instanceof Uint8Array) || payload.byteLength > 2 * 1024 * 1024) {
          return false;
        }
        bytes += payload.byteLength;
        if (bytes > 8 * 1024 * 1024) return false;
      }
      return true;
    };
    const validRunnerResponse = (value) => {
      if (!record(value) || value.protocolVersion !== 4 || !ID.test(String(value.runId))) {
        return false;
      }
      if (value.type === "eduri.python.output") {
        return exactKeys(value, ["type", "protocolVersion", "runId", "chunk"]) && typeof value.chunk === "string" && value.chunk.length > 0 && value.chunk.length <= MAX_OUTPUT;
      }
      if (value.type === "eduri.python.input-request") {
        return exactKeys(value, ["type", "protocolVersion", "runId", "requestId"]) && typeof value.requestId === "string" && ID.test(value.requestId);
      }
      return (exactKeys(value, [
        "type",
        "protocolVersion",
        "runId",
        "status",
        "output",
        "truncated"
      ]) || exactKeys(value, [
        "type",
        "protocolVersion",
        "runId",
        "status",
        "output",
        "truncated",
        "workspaceDelta"
      ])) && value.type === "eduri.python.result" && (value.status === "ok" || value.status === "runtime-error") && typeof value.output === "string" && value.output.length <= MAX_OUTPUT && typeof value.truncated === "boolean" && (value.workspaceDelta === void 0 || validDelta(value.workspaceDelta));
    };
    const validTerminalResponse = (value) => {
      if (!record(value) || value.protocolVersion !== 3 || !ID.test(String(value.sessionId))) {
        return false;
      }
      if (value.type === "eduri.python-terminal.ready") {
        return exactKeys(value, ["type", "protocolVersion", "sessionId", "mode"]) && value.mode === "shell";
      }
      if (value.type === "eduri.python-terminal.fatal") {
        return exactKeys(value, ["type", "protocolVersion", "sessionId", "message"]) && typeof value.message === "string" && value.message.length <= 4096;
      }
      if (!ID.test(String(value.commandId))) return false;
      if (value.type === "eduri.python-terminal.output") {
        return exactKeys(value, [
          "type",
          "protocolVersion",
          "sessionId",
          "commandId",
          "chunk"
        ]) && typeof value.chunk === "string" && value.chunk.length > 0 && value.chunk.length <= MAX_CHUNK;
      }
      if (value.type === "eduri.python-terminal.input-request") {
        return exactKeys(value, [
          "type",
          "protocolVersion",
          "sessionId",
          "commandId",
          "requestId"
        ]) && typeof value.requestId === "string" && ID.test(value.requestId);
      }
      return exactKeys(value, [
        "type",
        "protocolVersion",
        "sessionId",
        "commandId",
        "status",
        "mode",
        "prompt",
        "truncated",
        "workspaceDelta"
      ]) && value.type === "eduri.python-terminal.result" && (value.status === "ok" || value.status === "runtime-error") && (value.mode === "shell" || value.mode === "repl") && (value.mode === "shell" ? value.prompt === null : value.prompt === ">>> " || value.prompt === "... ") && typeof value.truncated === "boolean" && validDelta(value.workspaceDelta);
    };
    const validParentMessage = (kind, value) => {
      if (!record(value)) return false;
      if (kind === "runner") {
        return exactKeys(value, [
          "type",
          "protocolVersion",
          "runId",
          "payload",
          "runtimeAssets"
        ]) && value.type === "eduri.python.run" && value.protocolVersion === 4 && typeof value.runId === "string" && ID.test(value.runId) && record(value.payload) && runtimeAssets(value.runtimeAssets);
      }
      if (value.protocolVersion !== 3 || typeof value.sessionId !== "string" || !ID.test(value.sessionId)) {
        return false;
      }
      if (value.type === "eduri.python-terminal.open") {
        return exactKeys(value, [
          "type",
          "protocolVersion",
          "sessionId",
          "workspace",
          "runtimeAssets"
        ]) && record(value.workspace) && runtimeAssets(value.runtimeAssets);
      }
      if (value.type !== "eduri.python-terminal.command" || typeof value.commandId !== "string" || !ID.test(value.commandId) || typeof value.action !== "string") return false;
      const base = ["type", "protocolVersion", "sessionId", "commandId", "action"];
      if (value.action === "execute") {
        return exactKeys(value, [...base, "entrypoint"]) && typeof value.entrypoint === "string" && value.entrypoint.length <= 1024;
      }
      if (value.action === "repl-line") {
        return exactKeys(value, [...base, "line"]) && typeof value.line === "string" && new TextEncoder().encode(value.line).byteLength <= 64 * 1024;
      }
      return (value.action === "start-repl" || value.action === "repl-interrupt" || value.action === "repl-eof") && exactKeys(value, base);
    };
    const transferableBuffers = (value) => {
      if (!record(value) || !record(value.runtimeAssets)) return [];
      return [
        value.runtimeAssets.pyodideLock,
        value.runtimeAssets.pyodideWasm,
        value.runtimeAssets.pythonStdlib
      ].filter((candidate) => candidate instanceof ArrayBuffer);
    };
    const initialize = (event) => {
      const data = event.data;
      if (initialized || event.source !== parent || !record(data) || !exactKeys(data, ["type", "token", "kind", "workerSource"]) || data.type !== INIT || typeof data.token !== "string" || !ID.test(data.token) || data.kind !== "runner" && data.kind !== "terminal" || typeof data.workerSource !== "string" || data.workerSource.length < 1 || data.workerSource.length > 512 * 1024 || event.ports.length !== 1) return;
      initialized = true;
      removeEventListener("message", initialize);
      const kind = data.kind;
      const token = data.token;
      const port = event.ports[0];
      const workerUrl = URL.createObjectURL(new Blob(
        [data.workerSource],
        { type: "text/javascript" }
      ));
      let worker = null;
      let closed = false;
      let stdinControl = null;
      let stdinData = null;
      let interrupt = null;
      let submittedInputBytes = 0;
      let scopeId = null;
      let runnerCompleted = false;
      let terminalReady = false;
      let activeCommandId = null;
      let waitingForInput = false;
      let runnerOutputChars = 0;
      let commandOutputChars = 0;
      let inputRequestCount = 0;
      let commandCount = 0;
      const cleanup = () => {
        if (closed) return;
        closed = true;
        worker?.terminate();
        worker = null;
        stdinControl = null;
        stdinData = null;
        interrupt = null;
        URL.revokeObjectURL(workerUrl);
        port.close();
      };
      const fail = (message) => {
        if (closed) return;
        port.postMessage({
          type: ERROR,
          token,
          message: String(message).slice(0, 512)
        });
        cleanup();
      };
      try {
        worker = new Worker(workerUrl);
      } catch {
        fail("Opaque Python worker could not be created");
        return;
      }
      worker.addEventListener("message", (workerEvent) => {
        const valid = kind === "runner" ? validRunnerResponse(workerEvent.data) : validTerminalResponse(workerEvent.data);
        const payload = workerEvent.data;
        if (!valid || !record(payload) || scopeId === null || (kind === "runner" ? payload.runId !== scopeId : payload.sessionId !== scopeId)) {
          fail("Opaque Python worker returned an invalid message");
          return;
        }
        if (kind === "runner") {
          if (runnerCompleted) {
            fail("Opaque Python worker returned an unexpected message");
            return;
          }
          if (payload.type === "eduri.python.input-request") {
            inputRequestCount += 1;
            if (!stdinControl || Atomics.load(stdinControl, 0) !== STDIN_WAITING || waitingForInput) {
              fail("Opaque Python worker returned an unexpected input request");
              return;
            }
            if (inputRequestCount > 4096) {
              fail("Opaque Python worker returned too many input requests");
              return;
            }
            waitingForInput = true;
          } else if (payload.type === "eduri.python.output") {
            runnerOutputChars += String(payload.chunk).length;
            if (runnerOutputChars > MAX_OUTPUT) {
              fail("Opaque Python worker returned too much output");
              return;
            }
          } else if (payload.type === "eduri.python.result") {
            runnerCompleted = true;
            waitingForInput = false;
          }
        } else if (payload.type === "eduri.python-terminal.ready") {
          if (terminalReady || activeCommandId !== null) {
            fail("Opaque Python worker returned unexpected readiness");
            return;
          }
          terminalReady = true;
        } else if (payload.type === "eduri.python-terminal.fatal") {
          activeCommandId = null;
          waitingForInput = false;
        } else {
          if (activeCommandId === null || payload.commandId !== activeCommandId) {
            fail("Opaque Python worker returned an event for no active command");
            return;
          }
          if (payload.type === "eduri.python-terminal.input-request") {
            inputRequestCount += 1;
            if (!stdinControl || Atomics.load(stdinControl, 0) !== STDIN_WAITING || waitingForInput) {
              fail("Opaque Python worker returned an unexpected input request");
              return;
            }
            if (inputRequestCount > 4096) {
              fail("Opaque Python worker returned too many input requests");
              return;
            }
            waitingForInput = true;
          } else if (payload.type === "eduri.python-terminal.output") {
            commandOutputChars += String(payload.chunk).length;
            if (commandOutputChars > MAX_OUTPUT) {
              fail("Opaque Python worker returned too much command output");
              return;
            }
          } else if (payload.type === "eduri.python-terminal.result") {
            activeCommandId = null;
            waitingForInput = false;
          }
        }
        port.postMessage({ type: WORKER_MESSAGE, token, payload });
      });
      worker.addEventListener("messageerror", () => {
        fail("Opaque Python worker response could not be decoded");
      });
      worker.addEventListener("error", (workerError) => {
        workerError.preventDefault();
        fail(workerError.message || "Opaque Python worker failed");
      });
      port.onmessage = (portEvent) => {
        const message = portEvent.data;
        if (!record(message) || message.token !== token || typeof message.type !== "string") {
          fail("Opaque Python host protocol mismatch");
          return;
        }
        if (message.type === TERMINATE) {
          if (!exactKeys(message, ["type", "token"])) {
            fail("Opaque Python host rejected termination");
            return;
          }
          cleanup();
          return;
        }
        if (message.type === CONTROL) {
          if (!exactKeys(message, ["type", "token", "payload"]) || !record(message.payload) || typeof message.payload.action !== "string") {
            fail("Opaque Python host rejected a control message");
            return;
          }
          if (message.payload.action === "input") {
            if (!exactKeys(message.payload, ["action", "value"]) || typeof message.payload.value !== "string" || !stdinControl || !stdinData || !waitingForInput || Atomics.load(stdinControl, 0) !== STDIN_WAITING) {
              fail("Opaque Python host rejected interactive input");
              return;
            }
            const bytes = new TextEncoder().encode(message.payload.value);
            if (bytes.byteLength > stdinData.byteLength || submittedInputBytes + bytes.byteLength > MAX_STDIN_TOTAL) {
              fail("Opaque Python host rejected oversized input");
              return;
            }
            stdinData.fill(0);
            stdinData.set(bytes);
            submittedInputBytes += bytes.byteLength;
            waitingForInput = false;
            Atomics.store(stdinControl, 1, bytes.byteLength);
            Atomics.store(stdinControl, 0, STDIN_VALUE);
            Atomics.notify(stdinControl, 0);
            return;
          }
          if (message.payload.action === "eof") {
            if (!exactKeys(message.payload, ["action"]) || !stdinControl || !waitingForInput || Atomics.load(stdinControl, 0) !== STDIN_WAITING) {
              fail("Opaque Python host rejected EOF");
              return;
            }
            Atomics.store(stdinControl, 1, 0);
            waitingForInput = false;
            Atomics.store(stdinControl, 0, STDIN_EOF);
            Atomics.notify(stdinControl, 0);
            return;
          }
          if (message.payload.action === "interrupt") {
            const activeExecution = kind === "runner" ? scopeId !== null && !runnerCompleted : activeCommandId !== null;
            if (!exactKeys(message.payload, ["action"]) || !interrupt || !activeExecution) {
              fail("Opaque Python host rejected interrupt");
              return;
            }
            Atomics.store(interrupt, 0, 2);
            Atomics.notify(interrupt, 0);
            if (stdinControl && Atomics.load(stdinControl, 0) === STDIN_WAITING) {
              Atomics.store(stdinControl, 1, 0);
              Atomics.store(stdinControl, 0, STDIN_EOF);
              Atomics.notify(stdinControl, 0);
            }
            waitingForInput = false;
            return;
          }
          fail("Opaque Python host rejected an unknown control action");
          return;
        }
        if (!exactKeys(message, ["type", "token", "payload"]) || message.type !== PARENT_MESSAGE || !validParentMessage(kind, message.payload)) {
          fail("Opaque Python host rejected a parent message");
          return;
        }
        try {
          const payload = message.payload;
          if (!record(payload)) throw new Error("Invalid Python request");
          if (kind === "runner") {
            if (scopeId !== null || runnerCompleted) {
              throw new Error("Python runner request was already delivered");
            }
            scopeId = String(payload.runId);
          } else if (payload.type === "eduri.python-terminal.open") {
            if (scopeId !== null) throw new Error("Python terminal was already opened");
            scopeId = String(payload.sessionId);
          } else {
            if (scopeId === null || payload.sessionId !== scopeId || !terminalReady || activeCommandId !== null) throw new Error("Python terminal command is out of sequence");
            commandCount += 1;
            if (commandCount > 4096) {
              throw new Error("Python terminal command limit exceeded");
            }
            activeCommandId = String(payload.commandId);
            commandOutputChars = 0;
          }
          let workerPayload = payload;
          if (kind === "terminal" && payload.type === "eduri.python-terminal.open") {
            if (!crossOriginIsolated || typeof SharedArrayBuffer !== "function") {
              throw new Error("Opaque Python host is not cross-origin isolated");
            }
            const controlBuffer = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 2);
            const dataBuffer = new SharedArrayBuffer(64 * 1024);
            const interruptBuffer = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
            stdinControl = new Int32Array(controlBuffer);
            stdinData = new Uint8Array(dataBuffer);
            interrupt = new Int32Array(interruptBuffer);
            workerPayload = {
              ...payload,
              stdinControl: controlBuffer,
              stdinData: dataBuffer,
              interruptBuffer
            };
          } else if (kind === "runner" && payload.type === "eduri.python.run" && record(payload.payload) && payload.payload.kind === "workspace" && payload.payload.stdin === null) {
            if (!crossOriginIsolated || typeof SharedArrayBuffer !== "function") {
              throw new Error("Opaque Python host is not cross-origin isolated");
            }
            const controlBuffer = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 2);
            const dataBuffer = new SharedArrayBuffer(64 * 1024);
            stdinControl = new Int32Array(controlBuffer);
            stdinData = new Uint8Array(dataBuffer);
            workerPayload = {
              ...payload,
              stdinControl: controlBuffer,
              stdinData: dataBuffer
            };
          }
          worker?.postMessage(workerPayload, transferableBuffers(workerPayload));
        } catch {
          fail("Opaque Python worker request could not be delivered");
        }
      };
      port.onmessageerror = () => fail("Opaque Python host message could not be decoded");
      port.start();
      port.postMessage({ type: READY, token });
    };
    addEventListener("message", initialize);
  };
  bootstrap();
})();

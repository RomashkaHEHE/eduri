import {
  CODE_SYNC_LIMITS,
  CODE_SYNC_PROTOCOL_VERSION,
  CODE_SYNC_TAGS,
  CODE_SYNC_UPDATE_ENCODING,
} from "./constants.js";
import type {
  CodeAwarenessState,
  CodeCursor,
  CodeSelection,
  CodeSyncClientMessage,
  CodeSyncHandshakeAuth,
} from "./types.js";

const IDENTIFIER_PATTERN = /^[A-Za-z0-9_-]+$/u;
const SHARE_ID_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const textEncoder = new TextEncoder();

export class CodeProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CodeProtocolError";
  }
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new CodeProtocolError(`${label} must be an object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new CodeProtocolError(`${label} must be a plain object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
): void {
  const allowedKeys = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedKeys.has(key)) {
      throw new CodeProtocolError(`${label} contains an unsupported field`);
    }
  }
  for (const key of allowed) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) {
      throw new CodeProtocolError(`${label} is missing '${key}'`);
    }
  }
}

function identifier(value: unknown, label: string): string {
  if (
    typeof value !== "string"
    || value.length < 1
    || value.length > CODE_SYNC_LIMITS.maxIdentifierLength
    || !IDENTIFIER_PATTERN.test(value)
  ) {
    throw new CodeProtocolError(`${label} is invalid`);
  }
  return value;
}

function bytes(value: unknown, maximum: number, label: string): Uint8Array {
  let result: Uint8Array;
  if (value instanceof Uint8Array) {
    result = value.slice();
  } else if (value instanceof ArrayBuffer) {
    result = new Uint8Array(value.slice(0));
  } else if (ArrayBuffer.isView(value)) {
    result = Uint8Array.from(new Uint8Array(
      value.buffer,
      value.byteOffset,
      value.byteLength,
    ));
  } else {
    throw new CodeProtocolError(`${label} must be binary`);
  }
  if (result.byteLength < 1 || result.byteLength > maximum) {
    throw new CodeProtocolError(`${label} exceeds its size limit`);
  }
  return result;
}

function offset(value: unknown, label: string): number {
  if (
    typeof value !== "number"
    || !Number.isSafeInteger(value)
    || value < 0
    || value > CODE_SYNC_LIMITS.maxTextOffset
  ) {
    throw new CodeProtocolError(`${label} is invalid`);
  }
  return value;
}

function cursor(value: unknown): CodeCursor {
  const input = record(value, "cursor");
  exactKeys(input, ["entryId", "offset"], "cursor");
  return {
    entryId: identifier(input.entryId, "cursor entryId"),
    offset: offset(input.offset, "cursor offset"),
  };
}

function selection(value: unknown): CodeSelection {
  const input = record(value, "selection");
  exactKeys(input, ["entryId", "anchor", "head"], "selection");
  return {
    entryId: identifier(input.entryId, "selection entryId"),
    anchor: offset(input.anchor, "selection anchor"),
    head: offset(input.head, "selection head"),
  };
}

function terminal(value: unknown): NonNullable<CodeAwarenessState["terminal"]> {
  const input = record(value, "terminal awareness");
  if (input.kind === "host") {
    exactKeys(input, ["kind", "runId", "requestId"], "terminal host awareness");
    return {
      kind: "host",
      runId: identifier(input.runId, "terminal runId"),
      requestId: identifier(input.requestId, "terminal requestId"),
    };
  }
  if (input.kind === "input") {
    exactKeys(
      input,
      ["kind", "runId", "requestId", "submissionId", "value"],
      "terminal input awareness",
    );
    if (
      typeof input.value !== "string"
      || input.value.length > CODE_SYNC_LIMITS.maxTerminalInputCodeUnits
      || /[\r\n]/u.test(input.value)
    ) {
      throw new CodeProtocolError("terminal input value is invalid");
    }
    return {
      kind: "input",
      runId: identifier(input.runId, "terminal runId"),
      requestId: identifier(input.requestId, "terminal requestId"),
      submissionId: identifier(input.submissionId, "terminal submissionId"),
      value: input.value,
    };
  }
  throw new CodeProtocolError("terminal awareness is invalid");
}

export function parseCodeAwarenessState(value: unknown): CodeAwarenessState {
  const input = record(value, "awareness state");
  const keys = Object.keys(input);
  if (
    keys.length < 1
    || keys.some((key) => (
      key !== "cursor" && key !== "selection" && key !== "terminal"
    ))
  ) {
    throw new CodeProtocolError("awareness state is invalid");
  }
  const state: CodeAwarenessState = {
    ...(input.cursor === undefined ? {} : { cursor: cursor(input.cursor) }),
    ...(input.selection === undefined
      ? {}
      : { selection: selection(input.selection) }),
    ...(input.terminal === undefined
      ? {}
      : { terminal: terminal(input.terminal) }),
  };
  if (
    textEncoder.encode(JSON.stringify(state)).byteLength
    > CODE_SYNC_LIMITS.maxAwarenessBytes
  ) {
    throw new CodeProtocolError("awareness state exceeds its size limit");
  }
  return state;
}

export function parseCodeSyncHandshakeAuth(
  value: unknown,
): CodeSyncHandshakeAuth {
  const input = record(value, "Code sync auth");
  exactKeys(input, ["shareId", "deviceId"], "Code sync auth");
  if (typeof input.shareId !== "string" || !SHARE_ID_PATTERN.test(input.shareId)) {
    throw new CodeProtocolError("shareId is invalid");
  }
  return {
    shareId: input.shareId,
    deviceId: identifier(input.deviceId, "deviceId"),
  };
}

function messageBase(
  value: unknown,
): Record<string, unknown> {
  const input = record(value, "Code sync message");
  if (input.protocolVersion !== CODE_SYNC_PROTOCOL_VERSION) {
    throw new CodeProtocolError("Code sync protocol version is unsupported");
  }
  return input;
}

export function parseCodeSyncClientMessage(
  value: unknown,
): CodeSyncClientMessage {
  const input = messageBase(value);
  if (input.type === CODE_SYNC_TAGS.syncStep1) {
    exactKeys(
      input,
      ["type", "protocolVersion", "requestId", "stateVector"],
      "SYNC_STEP1",
    );
    return {
      type: CODE_SYNC_TAGS.syncStep1,
      protocolVersion: CODE_SYNC_PROTOCOL_VERSION,
      requestId: identifier(input.requestId, "requestId"),
      stateVector: bytes(
        input.stateVector,
        CODE_SYNC_LIMITS.maxStateVectorBytes,
        "stateVector",
      ),
    };
  }
  if (input.type === CODE_SYNC_TAGS.update) {
    exactKeys(
      input,
      [
        "type",
        "protocolVersion",
        "requestId",
        "updateId",
        "updateEncoding",
        "update",
      ],
      "UPDATE",
    );
    if (input.updateEncoding !== CODE_SYNC_UPDATE_ENCODING) {
      throw new CodeProtocolError("UPDATE encoding is unsupported");
    }
    return {
      type: CODE_SYNC_TAGS.update,
      protocolVersion: CODE_SYNC_PROTOCOL_VERSION,
      requestId: identifier(input.requestId, "requestId"),
      updateId: identifier(input.updateId, "updateId"),
      updateEncoding: CODE_SYNC_UPDATE_ENCODING,
      update: bytes(input.update, CODE_SYNC_LIMITS.maxUpdateBytes, "update"),
    };
  }
  if (input.type === CODE_SYNC_TAGS.awareness) {
    exactKeys(
      input,
      ["type", "protocolVersion", "state"],
      "AWARENESS",
    );
    return {
      type: CODE_SYNC_TAGS.awareness,
      protocolVersion: CODE_SYNC_PROTOCOL_VERSION,
      state: input.state === null ? null : parseCodeAwarenessState(input.state),
    };
  }
  throw new CodeProtocolError("Code sync message type is unsupported");
}

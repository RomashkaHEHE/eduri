import {
  decodeRelativePosition,
  encodeRelativePosition,
} from "yjs";
import {
  CODE_SYNC_CAPABILITIES,
  CODE_SYNC_LIMITS,
  CODE_SYNC_PROTOCOL_VERSION,
  CODE_SYNC_TAGS,
  CODE_SYNC_UPDATE_ENCODING,
} from "./constants.js";
import type {
  CodeAbsoluteSelection,
  CodeAwarenessState,
  CodeAwarenessTarget,
  CodeLegacyAwarenessState,
  CodeRelativeSelection,
  CodeScalarAwarenessTarget,
  CodeScalarInputPresence,
  CodeYTextAwarenessTarget,
  CodeSyncClientMessage,
  CodeSyncHandshakeAuth,
} from "./types.js";
import {
  CollaborationProfileValidationError,
  normalizeCollaborationProfile,
} from "../../shared/collaborationProfile.js";

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

function awarenessTarget(value: unknown): CodeAwarenessTarget {
  const input = record(value, "awareness target");
  if (input.kind === "file") {
    exactKeys(input, ["kind", "entryId", "field"], "file awareness target");
    if (input.field !== "text") {
      throw new CodeProtocolError("file awareness target field is invalid");
    }
    return {
      kind: "file",
      entryId: identifier(input.entryId, "file awareness target entryId"),
      field: "text",
    };
  }
  if (input.kind === "test") {
    exactKeys(input, ["kind", "testId", "field"], "test awareness target");
    if (
      input.field !== "stdin"
      && input.field !== "expectedOutput"
      && input.field !== "name"
      && input.field !== "timeout"
    ) {
      throw new CodeProtocolError("test awareness target field is invalid");
    }
    return {
      kind: "test",
      testId: identifier(input.testId, "test awareness target testId"),
      field: input.field,
    };
  }
  if (input.kind === "terminal") {
    exactKeys(input, ["kind", "field"], "terminal awareness target");
    if (input.field !== "input") {
      throw new CodeProtocolError("terminal awareness target field is invalid");
    }
    return { kind: "terminal", field: "input" };
  }
  if (input.kind === "explorer") {
    exactKeys(input, ["kind", "entryId", "field"], "explorer awareness target");
    if (input.field !== "rename") {
      throw new CodeProtocolError("explorer awareness target field is invalid");
    }
    return {
      kind: "explorer",
      entryId: identifier(input.entryId, "explorer awareness target entryId"),
      field: "rename",
    };
  }
  throw new CodeProtocolError("awareness target is invalid");
}

function relativeSelection(value: unknown): CodeRelativeSelection {
  const input = record(value, "awareness selection");
  exactKeys(input, ["anchor", "head"], "awareness selection");
  return {
    anchor: relativePositionBytes(
      input.anchor,
      "awareness selection anchor",
    ),
    head: relativePositionBytes(
      input.head,
      "awareness selection head",
    ),
  };
}

function relativeSelections(value: unknown): readonly CodeRelativeSelection[] {
  if (
    !Array.isArray(value)
    || value.length < 1
    || value.length > CODE_SYNC_LIMITS.maxYTextSelections
  ) {
    throw new CodeProtocolError("awareness selections exceed their count limit");
  }
  const selections: CodeRelativeSelection[] = [];
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.prototype.hasOwnProperty.call(value, index)) {
      throw new CodeProtocolError("awareness selections must be a dense array");
    }
    selections.push(relativeSelection(value[index]));
  }
  return selections;
}

function relativePositionBytes(value: unknown, label: string): Uint8Array {
  const encoded = bytes(
    value,
    CODE_SYNC_LIMITS.maxRelativePositionBytes,
    label,
  );
  try {
    const canonical = encodeRelativePosition(decodeRelativePosition(encoded));
    if (
      canonical.byteLength !== encoded.byteLength
      || canonical.some((byte, index) => byte !== encoded[index])
    ) {
      throw new Error("non-canonical relative position");
    }
  } catch {
    throw new CodeProtocolError(`${label} is not an encoded Yjs relative position`);
  }
  return encoded;
}

function targetSupportsRelativeSelection(
  target: CodeAwarenessTarget,
): target is CodeYTextAwarenessTarget {
  return target.kind === "file"
    || (
      target.kind === "test"
      && (target.field === "stdin" || target.field === "expectedOutput")
    );
}

function targetSupportsScalarInput(
  target: CodeAwarenessTarget,
): target is CodeScalarAwarenessTarget {
  return target.kind === "explorer"
    || (
      target.kind === "test"
      && (target.field === "name" || target.field === "timeout")
    );
}

function absoluteSelection(
  value: unknown,
  draftLength: number,
): CodeAbsoluteSelection {
  const input = record(value, "scalar awareness selection");
  exactKeys(
    input,
    ["anchor", "head"],
    "scalar awareness selection",
  );
  const endpoint = (candidate: unknown, label: string): number => {
    if (
      typeof candidate !== "number"
      || !Number.isSafeInteger(candidate)
      || candidate < 0
      || candidate > draftLength
    ) {
      throw new CodeProtocolError(`${label} is outside the scalar draft`);
    }
    return candidate;
  };
  return {
    anchor: endpoint(input.anchor, "scalar awareness selection anchor"),
    head: endpoint(input.head, "scalar awareness selection head"),
  };
}

function scalarInputPresence(value: unknown): CodeScalarInputPresence {
  const input = record(value, "scalar awareness input");
  exactKeys(input, ["draft", "selection"], "scalar awareness input");
  if (
    typeof input.draft !== "string"
    || input.draft.length > CODE_SYNC_LIMITS.maxScalarDraftLength
  ) {
    throw new CodeProtocolError("scalar awareness draft exceeds its size limit");
  }
  return {
    draft: input.draft,
    selection: absoluteSelection(input.selection, input.draft.length),
  };
}

function awarenessByteLength(state: CodeAwarenessState): number {
  const metadata = {
    target: state.target,
    ...(state.input === undefined ? {} : { input: state.input }),
    ...(state.selections === undefined
      ? {}
      : {
          selections: state.selections.map(() => ({
            anchor: null,
            head: null,
          })),
        }),
  };
  return textEncoder.encode(JSON.stringify(metadata)).byteLength
    + (state.selections?.reduce((total, selection) => (
      total + selection.anchor.byteLength + selection.head.byteLength
    ), 0) ?? 0);
}

export function toLegacyCodeAwarenessState(
  state: CodeAwarenessState,
): CodeLegacyAwarenessState {
  if (!targetSupportsRelativeSelection(state.target)) return state;
  const primary = state.selections?.[0];
  return {
    target: state.target,
    ...(primary
      ? {
          selection: {
            anchor: primary.anchor.slice(),
            head: primary.head.slice(),
          },
        }
      : {}),
  };
}

export function parseCodeAwarenessState(value: unknown): CodeAwarenessState {
  const input = record(value, "awareness state");
  const keys = Object.keys(input);
  if (!Object.prototype.hasOwnProperty.call(input, "target")) {
    throw new CodeProtocolError("awareness state is missing 'target'");
  }
  if (keys.some((key) => (
    key !== "target"
    && key !== "selection"
    && key !== "selections"
    && key !== "input"
  ))) {
    throw new CodeProtocolError("awareness state contains an unsupported field");
  }
  const target = awarenessTarget(input.target);
  const hasSelection = Object.prototype.hasOwnProperty.call(input, "selection");
  const hasSelections = Object.prototype.hasOwnProperty.call(input, "selections");
  const hasScalarInput = Object.prototype.hasOwnProperty.call(input, "input");
  let state: CodeAwarenessState;
  if (targetSupportsRelativeSelection(target)) {
    if (hasScalarInput || (hasSelection && hasSelections)) {
      throw new CodeProtocolError("Y.Text awareness target does not support scalar input");
    }
    state = {
      target,
      ...(hasSelections
        ? { selections: relativeSelections(input.selections) }
        : hasSelection
          ? { selections: [relativeSelection(input.selection)] }
          : {}),
    };
  } else if (targetSupportsScalarInput(target)) {
    if (hasSelection || hasSelections) {
      throw new CodeProtocolError("scalar awareness target does not support relative selection");
    }
    state = {
      target,
      ...(hasScalarInput ? { input: scalarInputPresence(input.input) } : {}),
    };
  } else {
    if (hasSelection || hasSelections || hasScalarInput) {
      throw new CodeProtocolError("terminal awareness target does not support text state");
    }
    state = { target };
  }
  if (awarenessByteLength(state) > CODE_SYNC_LIMITS.maxAwarenessBytes) {
    throw new CodeProtocolError("awareness state exceeds its size limit");
  }
  return state;
}

export function parseCodeSyncHandshakeAuth(
  value: unknown,
): CodeSyncHandshakeAuth {
  const input = record(value, "Code sync auth");
  const keys = Object.keys(input);
  if (
    !Object.prototype.hasOwnProperty.call(input, "shareId")
    || !Object.prototype.hasOwnProperty.call(input, "deviceId")
    || keys.some((key) => key !== "shareId" && key !== "deviceId" && key !== "profile")
  ) {
    throw new CodeProtocolError("Code sync auth fields are invalid");
  }
  if (typeof input.shareId !== "string" || !SHARE_ID_PATTERN.test(input.shareId)) {
    throw new CodeProtocolError("shareId is invalid");
  }
  let profile;
  if (Object.prototype.hasOwnProperty.call(input, "profile")) {
    try {
      profile = normalizeCollaborationProfile(input.profile);
    } catch (error) {
      if (error instanceof CollaborationProfileValidationError) {
        throw new CodeProtocolError(error.message);
      }
      throw error;
    }
  }
  return {
    shareId: input.shareId,
    deviceId: identifier(input.deviceId, "deviceId"),
    ...(profile ? { profile } : {}),
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
  if (input.type === CODE_SYNC_TAGS.capabilities) {
    exactKeys(
      input,
      ["type", "protocolVersion", "capabilities"],
      "CAPABILITIES",
    );
    if (
      !Array.isArray(input.capabilities)
      || input.capabilities.length !== 1
      || input.capabilities[0]
        !== CODE_SYNC_CAPABILITIES.multiSelectionAwareness
    ) {
      throw new CodeProtocolError("Code sync capabilities are invalid");
    }
    return {
      type: CODE_SYNC_TAGS.capabilities,
      protocolVersion: CODE_SYNC_PROTOCOL_VERSION,
      capabilities: [CODE_SYNC_CAPABILITIES.multiSelectionAwareness],
    };
  }
  if (input.type === CODE_SYNC_TAGS.profileUpdate) {
    exactKeys(
      input,
      ["type", "protocolVersion", "profile"],
      "PROFILE_UPDATE",
    );
    try {
      return {
        type: CODE_SYNC_TAGS.profileUpdate,
        protocolVersion: CODE_SYNC_PROTOCOL_VERSION,
        profile: normalizeCollaborationProfile(input.profile),
      };
    } catch (error) {
      if (error instanceof CollaborationProfileValidationError) {
        throw new CodeProtocolError(error.message);
      }
      throw error;
    }
  }
  throw new CodeProtocolError("Code sync message type is unsupported");
}

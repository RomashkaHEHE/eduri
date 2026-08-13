import {
  SHARED_TERMINAL_LIMITS,
  SHARED_TERMINAL_PROTOCOL_VERSION,
  type SharedTerminalAck,
  type SharedTerminalAction,
  type SharedTerminalDelta,
  type SharedTerminalDeltaOperation,
  type SharedTerminalEffect,
  type SharedTerminalInputState,
  type SharedTerminalParticipant,
  type SharedTerminalRun,
  type SharedTerminalState,
  type SharedTerminalTestResult,
} from "./stateMachine.js";

const IDENTIFIER = /^[A-Za-z0-9_-]{1,128}$/u;
const COLOR = /^#[0-9a-f]{6}$/iu;

export interface SharedTerminalActionEnvelope {
  readonly protocolVersion: typeof SHARED_TERMINAL_PROTOCOL_VERSION;
  readonly action: SharedTerminalAction;
}

type WireEffect<T> = T extends SharedTerminalEffect
  ? Omit<T, "targetSocketId"> & {
      readonly protocolVersion: typeof SHARED_TERMINAL_PROTOCOL_VERSION;
    }
  : never;

export type SharedTerminalClientEffect = WireEffect<SharedTerminalEffect>;
export type SharedTerminalSnapshot = SharedTerminalState;

export type SharedTerminalServerMessage =
  | { readonly type: "snapshot"; readonly state: SharedTerminalSnapshot }
  | { readonly type: "delta"; readonly delta: SharedTerminalDelta }
  | { readonly type: "ack"; readonly ack: SharedTerminalAck }
  | { readonly type: "effect"; readonly effect: SharedTerminalClientEffect };

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function exact(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length
    && actual.every((key, index) => key === expected[index]);
}

function identifier(value: unknown): string | null {
  return typeof value === "string" && IDENTIFIER.test(value) ? value : null;
}

function boundedString(value: unknown, maximum: number): string | null {
  return typeof value === "string" && value.length <= maximum ? value : null;
}

function participant(value: unknown): SharedTerminalParticipant | null {
  const input = record(value);
  if (!input || !exact(input, ["participantId", "displayName", "color"])) return null;
  const participantId = identifier(input.participantId);
  const displayName = boundedString(input.displayName, 128);
  const color = typeof input.color === "string" && COLOR.test(input.color)
    ? input.color.toLowerCase()
    : null;
  return participantId && displayName && color
    ? { participantId, displayName, color }
    : null;
}

function inputState(value: unknown): SharedTerminalInputState | null {
  const input = record(value);
  if (!input || !exact(input, ["value", "cursor", "owner"])) return null;
  const text = boundedString(input.value, SHARED_TERMINAL_LIMITS.maxInputCodeUnits);
  const owner = input.owner === null ? null : participant(input.owner);
  if (
    text === null
    || !Number.isSafeInteger(input.cursor)
    || (input.cursor as number) < 0
    || (input.cursor as number) > text.length
    || (input.owner !== null && !owner)
  ) return null;
  return { value: text, cursor: input.cursor as number, owner };
}

function run(value: unknown): SharedTerminalRun | null {
  const input = record(value);
  if (!input || !exact(input, ["runId", "entryId", "entrypoint", "testId"])) return null;
  const runId = identifier(input.runId);
  const entryId = input.entryId === null ? null : identifier(input.entryId);
  const entrypoint = input.entrypoint === null
    ? null
    : boundedString(input.entrypoint, SHARED_TERMINAL_LIMITS.maxCommandCodeUnits);
  const testId = input.testId === null ? null : identifier(input.testId);
  if (
    !runId
    || (input.entryId !== null && !entryId)
    || (input.entrypoint !== null && entrypoint === null)
    || (input.testId !== null && !testId)
  ) return null;
  return { runId, entryId, entrypoint, testId };
}

function testResult(value: unknown): SharedTerminalTestResult | null {
  const input = record(value);
  if (!input || !exact(input, ["testId", "status"])) return null;
  const testId = identifier(input.testId);
  const status = input.status === "passed" || input.status === "failed"
    ? input.status
    : null;
  return testId && status ? { testId, status } : null;
}

export function readSharedTerminalActionId(value: unknown): string | null {
  const envelope = record(value);
  if (!envelope || envelope.protocolVersion !== SHARED_TERMINAL_PROTOCOL_VERSION) {
    return null;
  }
  return identifier(record(envelope.action)?.actionId);
}

export function parseSharedTerminalActionEnvelope(
  value: unknown,
): SharedTerminalActionEnvelope | null {
  const envelope = record(value);
  if (
    !envelope
    || !exact(envelope, ["protocolVersion", "action"])
    || envelope.protocolVersion !== SHARED_TERMINAL_PROTOCOL_VERSION
  ) return null;
  const input = record(envelope.action);
  if (!input || typeof input.type !== "string") return null;
  const actionId = identifier(input.actionId);
  if (!actionId) return null;
  const base = { actionId };
  if (["sync", "claim", "release", "interrupt", "eof"].includes(input.type)) {
    return exact(input, ["type", "actionId"])
      ? {
          protocolVersion: SHARED_TERMINAL_PROTOCOL_VERSION,
          action: { ...base, type: input.type } as SharedTerminalAction,
        }
      : null;
  }
  if (input.type === "edit-input") {
    const text = boundedString(input.value, SHARED_TERMINAL_LIMITS.maxInputCodeUnits);
    return exact(input, ["type", "actionId", "value", "cursor"])
      && text !== null
      && Number.isSafeInteger(input.cursor)
      ? {
          protocolVersion: SHARED_TERMINAL_PROTOCOL_VERSION,
          action: { ...base, type: input.type, value: text, cursor: input.cursor as number },
        }
      : null;
  }
  if (input.type === "submit-line") {
    const text = boundedString(input.value, SHARED_TERMINAL_LIMITS.maxInputCodeUnits);
    return exact(input, ["type", "actionId", "value"]) && text !== null
      ? {
          protocolVersion: SHARED_TERMINAL_PROTOCOL_VERSION,
          action: { ...base, type: input.type, value: text },
        }
      : null;
  }
  if (input.type === "start-run") {
    const hasTest = input.testId !== undefined;
    const entryId = identifier(input.entryId);
    const entrypoint = boundedString(
      input.entrypoint,
      SHARED_TERMINAL_LIMITS.maxCommandCodeUnits,
    );
    const testId = hasTest ? identifier(input.testId) : null;
    return exact(input, hasTest
      ? ["type", "actionId", "entryId", "entrypoint", "testId"]
      : ["type", "actionId", "entryId", "entrypoint"])
      && entryId !== null
      && entrypoint !== null
      && entrypoint.length > 0
      && (!hasTest || testId !== null)
      ? {
          protocolVersion: SHARED_TERMINAL_PROTOCOL_VERSION,
          action: {
            ...base,
            type: input.type,
            entryId,
            entrypoint,
            ...(testId ? { testId } : {}),
          },
        }
      : null;
  }
  if (input.type === "host-output") {
    const runId = identifier(input.runId);
    const chunk = boundedString(
      input.chunk,
      SHARED_TERMINAL_LIMITS.maxOutputChunkCodeUnits,
    );
    return exact(input, ["type", "actionId", "runId", "chunk"])
      && runId !== null && chunk !== null
      ? {
          protocolVersion: SHARED_TERMINAL_PROTOCOL_VERSION,
          action: { ...base, type: input.type, runId, chunk },
        }
      : null;
  }
  if (input.type === "host-input-request") {
    const runId = identifier(input.runId);
    const requestId = identifier(input.requestId);
    return exact(input, ["type", "actionId", "runId", "requestId"])
      && runId !== null && requestId !== null
      ? {
          protocolVersion: SHARED_TERMINAL_PROTOCOL_VERSION,
          action: { ...base, type: input.type, runId, requestId },
        }
      : null;
  }
  if (input.type === "host-ready") {
    const hasPrompt = input.prompt !== undefined;
    const hasTest = input.testResult !== undefined;
    const keys = ["type", "actionId", "runId", "nextMode"];
    if (hasPrompt) keys.push("prompt");
    if (hasTest) keys.push("testResult");
    const runId = identifier(input.runId);
    const nextMode = input.nextMode === "shell" || input.nextMode === "python"
      ? input.nextMode
      : null;
    const prompt = input.prompt === ">>> " || input.prompt === "... "
      ? input.prompt
      : null;
    const result = hasTest ? testResult(input.testResult) : null;
    if (
      !exact(input, keys)
      || !runId
      || !nextMode
      || (hasPrompt && (!prompt || nextMode !== "python"))
      || (hasTest && !result)
    ) return null;
    return {
      protocolVersion: SHARED_TERMINAL_PROTOCOL_VERSION,
      action: {
        ...base,
        type: input.type,
        runId,
        nextMode,
        ...(prompt ? { prompt } : {}),
        ...(result ? { testResult: result } : {}),
      },
    };
  }
  if (input.type === "host-failed") {
    const runId = identifier(input.runId);
    const message = boundedString(input.message, 2_048);
    return exact(input, ["type", "actionId", "runId", "message"])
      && runId !== null && message !== null
      ? {
          protocolVersion: SHARED_TERMINAL_PROTOCOL_VERSION,
          action: { ...base, type: input.type, runId, message },
        }
      : null;
  }
  return null;
}

export function toSharedTerminalClientEffect(
  effect: SharedTerminalEffect,
): SharedTerminalClientEffect {
  const { targetSocketId: _targetSocketId, ...wire } = effect;
  return { protocolVersion: SHARED_TERMINAL_PROTOCOL_VERSION, ...wire };
}

export function parseSharedTerminalClientEffect(
  value: unknown,
): SharedTerminalClientEffect | null {
  const input = record(value);
  if (!input || input.protocolVersion !== SHARED_TERMINAL_PROTOCOL_VERSION) return null;
  const { protocolVersion: _protocolVersion, ...candidate } = input;
  const effect = { ...candidate, targetSocketId: "wire-target" } as SharedTerminalEffect;
  if (!identifier(effect.runId)) return null;
  if (effect.type === "execute-line") {
    return exact(input, ["protocolVersion", "type", "runId", "line", "pythonMode"])
      && boundedString(effect.line, SHARED_TERMINAL_LIMITS.maxCommandCodeUnits) !== null
      && typeof effect.pythonMode === "boolean"
      ? value as SharedTerminalClientEffect
      : null;
  }
  if (effect.type === "start-run") {
    return exact(input, [
      "protocolVersion", "type", "runId", "entryId", "entrypoint", "testId",
    ])
      && identifier(effect.entryId) !== null
      && boundedString(effect.entrypoint, SHARED_TERMINAL_LIMITS.maxCommandCodeUnits) !== null
      && (effect.testId === null || identifier(effect.testId) !== null)
      ? value as SharedTerminalClientEffect
      : null;
  }
  if (effect.type === "interrupt") {
    return exact(input, ["protocolVersion", "type", "runId", "pythonMode"])
      && typeof effect.pythonMode === "boolean"
      ? value as SharedTerminalClientEffect
      : null;
  }
  if (effect.type === "eof") {
    return exact(input, ["protocolVersion", "type", "runId"])
      ? value as SharedTerminalClientEffect
      : null;
  }
  if (effect.type === "submit-input") {
    return exact(input, [
      "protocolVersion", "type", "runId", "requestId", "value",
    ])
      && identifier(effect.requestId) !== null
      && boundedString(effect.value, SHARED_TERMINAL_LIMITS.maxInputCodeUnits) !== null
      ? value as SharedTerminalClientEffect
      : null;
  }
  return null;
}

export function parseSharedTerminalState(value: unknown): SharedTerminalState | null {
  const input = record(value);
  if (!input || !exact(input, [
    "protocolVersion", "generation", "seq", "mode", "prompt", "transcript",
    "input", "host", "activeRun", "inputRequestId", "lastTest",
  ])) return null;
  if (
    input.protocolVersion !== SHARED_TERMINAL_PROTOCOL_VERSION
    || !Number.isSafeInteger(input.generation)
    || (input.generation as number) < 1
    || !Number.isSafeInteger(input.seq)
    || (input.seq as number) < 0
    || !["shell", "busy", "python", "program-input"].includes(input.mode as string)
    || typeof input.prompt !== "string"
    || input.prompt.length > 32
    || typeof input.transcript !== "string"
    || input.transcript.length > SHARED_TERMINAL_LIMITS.maxTranscriptCodeUnits
  ) return null;
  const parsedInput = inputState(input.input);
  const host = input.host === null ? null : participant(input.host);
  const activeRun = input.activeRun === null ? null : run(input.activeRun);
  const requestId = input.inputRequestId === null ? null : identifier(input.inputRequestId);
  const lastTest = input.lastTest === null ? null : testResult(input.lastTest);
  if (
    !parsedInput
    || (input.host !== null && !host)
    || (input.activeRun !== null && !activeRun)
    || (input.inputRequestId !== null && !requestId)
    || (input.lastTest !== null && !lastTest)
  ) return null;
  return {
    protocolVersion: SHARED_TERMINAL_PROTOCOL_VERSION,
    generation: input.generation as number,
    seq: input.seq as number,
    mode: input.mode as SharedTerminalState["mode"],
    prompt: input.prompt,
    transcript: input.transcript,
    input: parsedInput,
    host,
    activeRun,
    inputRequestId: requestId,
    lastTest,
  };
}

function runtimeOperation(input: Record<string, unknown>): SharedTerminalDeltaOperation | null {
  if (!exact(input, [
    "type", "mode", "prompt", "host", "activeRun", "inputRequestId", "lastTest",
  ])) return null;
  const mode = ["shell", "busy", "python", "program-input"].includes(input.mode as string)
    ? input.mode as SharedTerminalState["mode"]
    : null;
  const prompt = boundedString(input.prompt, 32);
  const host = input.host === null ? null : participant(input.host);
  const activeRun = input.activeRun === null ? null : run(input.activeRun);
  const requestId = input.inputRequestId === null ? null : identifier(input.inputRequestId);
  const lastTest = input.lastTest === null ? null : testResult(input.lastTest);
  if (
    !mode || prompt === null
    || (input.host !== null && !host)
    || (input.activeRun !== null && !activeRun)
    || (input.inputRequestId !== null && !requestId)
    || (input.lastTest !== null && !lastTest)
  ) return null;
  return {
    type: "runtime",
    mode,
    prompt,
    host,
    activeRun,
    inputRequestId: requestId,
    lastTest,
  };
}

function deltaOperation(value: unknown): SharedTerminalDeltaOperation | null {
  const input = record(value);
  if (!input || typeof input.type !== "string") return null;
  if (input.type === "transcript-append") {
    const text = boundedString(input.value, SHARED_TERMINAL_LIMITS.maxOutputChunkCodeUnits);
    return exact(input, ["type", "trimStart", "value"])
      && Number.isSafeInteger(input.trimStart)
      && (input.trimStart as number) >= 0
      && (input.trimStart as number) <= SHARED_TERMINAL_LIMITS.maxTranscriptCodeUnits
      && text !== null
      ? { type: input.type, trimStart: input.trimStart as number, value: text }
      : null;
  }
  if (input.type === "transcript-replace") {
    const text = boundedString(input.value, SHARED_TERMINAL_LIMITS.maxTranscriptCodeUnits);
    return exact(input, ["type", "value"]) && text !== null
      ? { type: input.type, value: text }
      : null;
  }
  if (input.type === "input") {
    const parsed = inputState(input.input);
    return exact(input, ["type", "input"]) && parsed
      ? { type: input.type, input: parsed }
      : null;
  }
  return input.type === "runtime" ? runtimeOperation(input) : null;
}

export function parseSharedTerminalDelta(value: unknown): SharedTerminalDelta | null {
  const input = record(value);
  if (!input || !exact(input, [
    "protocolVersion", "generation", "baseSeq", "seq", "operations",
  ])) return null;
  if (
    input.protocolVersion !== SHARED_TERMINAL_PROTOCOL_VERSION
    || !Number.isSafeInteger(input.generation)
    || (input.generation as number) < 1
    || !Number.isSafeInteger(input.baseSeq)
    || (input.baseSeq as number) < 0
    || !Number.isSafeInteger(input.seq)
    || input.seq !== (input.baseSeq as number) + 1
    || !Array.isArray(input.operations)
    || input.operations.length < 1
    || input.operations.length > 8
  ) return null;
  const operations = input.operations.map(deltaOperation);
  if (operations.some((operation) => operation === null)) return null;
  return {
    protocolVersion: SHARED_TERMINAL_PROTOCOL_VERSION,
    generation: input.generation as number,
    baseSeq: input.baseSeq as number,
    seq: input.seq as number,
    operations: operations as SharedTerminalDeltaOperation[],
  };
}

/** Returns null when a snapshot is required. */
export function applySharedTerminalDelta(
  current: SharedTerminalState,
  wireDelta: unknown,
): SharedTerminalState | null {
  const delta = parseSharedTerminalDelta(wireDelta);
  if (
    !delta
    || current.generation !== delta.generation
    || current.seq !== delta.baseSeq
  ) return null;
  let next: SharedTerminalState = {
    ...current,
    input: { ...current.input, owner: current.input.owner ? { ...current.input.owner } : null },
    host: current.host ? { ...current.host } : null,
    activeRun: current.activeRun ? { ...current.activeRun } : null,
    lastTest: current.lastTest ? { ...current.lastTest } : null,
  };
  for (const operation of delta.operations) {
    if (operation.type === "transcript-append") {
      if (operation.trimStart > next.transcript.length) return null;
      const transcript = next.transcript.slice(operation.trimStart) + operation.value;
      if (transcript.length > SHARED_TERMINAL_LIMITS.maxTranscriptCodeUnits) return null;
      next = { ...next, transcript };
    } else if (operation.type === "transcript-replace") {
      next = { ...next, transcript: operation.value };
    } else if (operation.type === "input") {
      next = {
        ...next,
        input: {
          ...operation.input,
          owner: operation.input.owner ? { ...operation.input.owner } : null,
        },
      };
    } else {
      next = {
        ...next,
        mode: operation.mode,
        prompt: operation.prompt,
        host: operation.host ? { ...operation.host } : null,
        activeRun: operation.activeRun ? { ...operation.activeRun } : null,
        inputRequestId: operation.inputRequestId,
        lastTest: operation.lastTest ? { ...operation.lastTest } : null,
      };
    }
  }
  next = { ...next, seq: delta.seq };
  return parseSharedTerminalState(next);
}

export function parseSharedTerminalAck(value: unknown): SharedTerminalAck | null {
  const input = record(value);
  if (!input || !exact(input, [
    "protocolVersion", "actionId", "generation", "seq", "status", "error",
  ])) return null;
  const actionId = identifier(input.actionId);
  const statuses = ["applied", "unchanged", "duplicate", "rejected"];
  const errors = [
    "busy", "input-owned", "invalid-action", "invalid-cursor", "invalid-run",
    "invalid-state", "invalid-test-result", "not-host", "not-running",
    "idempotency-conflict", "rate-limited", "unauthorized",
  ];
  if (
    input.protocolVersion !== SHARED_TERMINAL_PROTOCOL_VERSION
    || !actionId
    || !Number.isSafeInteger(input.generation)
    || (input.generation as number) < 1
    || !Number.isSafeInteger(input.seq)
    || (input.seq as number) < 0
    || !statuses.includes(input.status as string)
    || (input.error !== null && !errors.includes(input.error as string))
    || (input.status === "rejected") !== (input.error !== null)
  ) return null;
  return value as SharedTerminalAck;
}

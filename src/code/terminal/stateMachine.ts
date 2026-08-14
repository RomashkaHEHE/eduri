import * as buffer from "lib0/buffer";
import * as sha256 from "lib0/hash/sha256";
import * as string from "lib0/string";

export const SHARED_TERMINAL_PROTOCOL_VERSION = 1 as const;

export const SHARED_TERMINAL_ACTION_EVENT = "code-terminal:action" as const;
/** Full snapshots. Emitted only for connect, sync, and recovery. */
export const SHARED_TERMINAL_STATE_EVENT = "code-terminal:state" as const;
/** Ordered incremental state changes. */
export const SHARED_TERMINAL_DELTA_EVENT = "code-terminal:delta" as const;
/** Authoritative completion for every well-formed action. */
export const SHARED_TERMINAL_ACK_EVENT = "code-terminal:ack" as const;
export const SHARED_TERMINAL_EFFECT_EVENT = "code-terminal:effect" as const;

export const SHARED_TERMINAL_LIMITS = Object.freeze({
  maxTranscriptCodeUnits: 256 * 1024,
  maxOutputChunkCodeUnits: 64 * 1024,
  maxInputCodeUnits: 1_024,
  maxCommandCodeUnits: 1_024,
  maxIdentifierCodeUnits: 128,
  maxRememberedActions: 4_096,
});

const IDENTIFIER = /^[A-Za-z0-9_-]{1,128}$/u;
const COLOR = /^#[0-9a-f]{6}$/iu;
const ANSI_ESCAPE = /(?:\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?|\u001b[@-_])/gu;
const UNSAFE_CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/gu;
const SAFE_WORKSPACE_PATH = /^(?!\/)(?!.*(?:^|\/)\.{1,2}(?:\/|$))(?!.*[\\\u0000-\u001f\u007f])[^\r\n]{1,1024}$/u;

export type SharedTerminalMode = "shell" | "busy" | "python" | "program-input";

export interface SharedTerminalParticipant {
  readonly participantId: string;
  readonly displayName: string;
  readonly color: string;
}

export interface SharedTerminalActor extends SharedTerminalParticipant {
  readonly socketId: string;
}

export interface SharedTerminalInputState {
  readonly value: string;
  readonly cursor: number;
  readonly owner: SharedTerminalParticipant | null;
}

export interface SharedTerminalRun {
  readonly runId: string;
  readonly entryId: string | null;
  readonly entrypoint: string | null;
  readonly testId: string | null;
}

export interface SharedTerminalTestResult {
  readonly testId: string;
  readonly status: "passed" | "failed";
}

/** A complete volatile terminal snapshot. */
export interface SharedTerminalState {
  readonly protocolVersion: typeof SHARED_TERMINAL_PROTOCOL_VERSION;
  readonly generation: number;
  readonly seq: number;
  readonly mode: SharedTerminalMode;
  readonly prompt: string;
  readonly transcript: string;
  readonly input: SharedTerminalInputState;
  readonly host: SharedTerminalParticipant | null;
  readonly activeRun: SharedTerminalRun | null;
  readonly inputRequestId: string | null;
  readonly lastTest: SharedTerminalTestResult | null;
}

interface ActionBase {
  readonly actionId: string;
}

export type SharedTerminalAction =
  | (ActionBase & { readonly type: "sync" })
  | (ActionBase & { readonly type: "claim" })
  | (ActionBase & { readonly type: "release" })
  | (ActionBase & {
      readonly type: "edit-input";
      readonly value: string;
      readonly cursor: number;
    })
  | (ActionBase & { readonly type: "submit-line"; readonly value: string })
  | (ActionBase & {
      readonly type: "start-run";
      readonly entryId: string;
      readonly entrypoint: string;
      readonly testId?: string;
    })
  | (ActionBase & { readonly type: "interrupt" })
  | (ActionBase & { readonly type: "eof" })
  | (ActionBase & {
      readonly type: "host-output";
      readonly runId: string;
      readonly chunk: string;
    })
  | (ActionBase & {
      readonly type: "host-input-request";
      readonly runId: string;
      readonly requestId: string;
    })
  | (ActionBase & {
      readonly type: "host-ready";
      readonly runId: string;
      readonly nextMode: "shell" | "python";
      readonly prompt?: ">>> " | "... ";
      readonly testResult?: SharedTerminalTestResult;
    })
  | (ActionBase & {
      readonly type: "host-failed";
      readonly runId: string;
      readonly message: string;
    });

export type SharedTerminalEffect =
  | {
      readonly type: "execute-line";
      readonly targetSocketId: string;
      readonly runId: string;
      readonly line: string;
      readonly pythonMode: boolean;
    }
  | {
      readonly type: "start-run";
      readonly targetSocketId: string;
      readonly runId: string;
      readonly entryId: string;
      readonly entrypoint: string;
      readonly testId: string | null;
    }
  | {
      readonly type: "interrupt";
      readonly targetSocketId: string;
      readonly runId: string;
      /** True when Ctrl-C must reset and retain the shared Python REPL. */
      readonly pythonMode: boolean;
    }
  | {
      readonly type: "eof";
      readonly targetSocketId: string;
      readonly runId: string;
    }
  | {
      readonly type: "submit-input";
      readonly targetSocketId: string;
      readonly runId: string;
      readonly requestId: string;
      readonly value: string;
    };

export type SharedTerminalError =
  | "busy"
  | "input-owned"
  | "invalid-action"
  | "invalid-cursor"
  | "invalid-run"
  | "invalid-state"
  | "invalid-test-result"
  | "not-host"
  | "not-running"
  | "idempotency-conflict"
  | "rate-limited"
  | "unauthorized";

export type SharedTerminalAckStatus =
  | "applied"
  | "unchanged"
  | "duplicate"
  | "rejected";

export interface SharedTerminalAck {
  readonly protocolVersion: typeof SHARED_TERMINAL_PROTOCOL_VERSION;
  readonly actionId: string;
  readonly generation: number;
  readonly seq: number;
  readonly status: SharedTerminalAckStatus;
  readonly error: SharedTerminalError | null;
}

export type SharedTerminalDeltaOperation =
  | {
      readonly type: "transcript-append";
      /** Code units removed from the pre-delta transcript to retain the bound. */
      readonly trimStart: number;
      readonly value: string;
    }
  | { readonly type: "transcript-replace"; readonly value: string }
  | { readonly type: "input"; readonly input: SharedTerminalInputState }
  | {
      readonly type: "runtime";
      readonly mode: SharedTerminalMode;
      readonly prompt: string;
      readonly host: SharedTerminalParticipant | null;
      readonly activeRun: SharedTerminalRun | null;
      readonly inputRequestId: string | null;
      readonly lastTest: SharedTerminalTestResult | null;
    };

/**
 * A delta applies iff `generation` matches and `baseSeq` equals the client's
 * current seq. Otherwise the client must request `sync` and await a snapshot.
 */
export interface SharedTerminalDelta {
  readonly protocolVersion: typeof SHARED_TERMINAL_PROTOCOL_VERSION;
  readonly generation: number;
  readonly baseSeq: number;
  readonly seq: number;
  readonly operations: readonly SharedTerminalDeltaOperation[];
}

export interface SharedTerminalDispatchResult {
  /** Retained for local/SSR adapters; transports should publish `delta`. */
  readonly state: SharedTerminalState;
  readonly changed: boolean;
  readonly ack: SharedTerminalAck;
  readonly delta?: SharedTerminalDelta;
  readonly snapshot?: SharedTerminalState;
  readonly effect?: SharedTerminalEffect;
  readonly error?: SharedTerminalError;
}

interface InternalState {
  generation: number;
  seq: number;
  mode: SharedTerminalMode;
  prompt: string;
  transcript: string;
  inputValue: string;
  inputCursor: number;
  inputOwner: SharedTerminalActor | null;
  host: SharedTerminalActor | null;
  activeRun: SharedTerminalRun | null;
  inputRequestId: string | null;
  lastTest: SharedTerminalTestResult | null;
  activeRunPythonMode: boolean;
}

interface MutationOutcome {
  readonly changed: boolean;
  readonly effect?: SharedTerminalEffect;
  readonly error?: SharedTerminalError;
}

interface RememberedAction {
  readonly fingerprint: string;
}

function participant(actor: SharedTerminalActor): SharedTerminalParticipant {
  return {
    participantId: actor.participantId,
    displayName: actor.displayName,
    color: actor.color.toLowerCase(),
  };
}

function cloneParticipant(
  value: SharedTerminalParticipant | null,
): SharedTerminalParticipant | null {
  return value ? { ...value } : null;
}

function safeActor(actor: SharedTerminalActor): boolean {
  return IDENTIFIER.test(actor.socketId)
    && IDENTIFIER.test(actor.participantId)
    && actor.displayName.length > 0
    && actor.displayName.length <= 128
    && COLOR.test(actor.color);
}

function safeIdentifier(value: string): boolean {
  return IDENTIFIER.test(value);
}

function unchanged(error?: SharedTerminalError): MutationOutcome {
  return { changed: false, ...(error ? { error } : {}) };
}

function changed(effect?: SharedTerminalEffect): MutationOutcome {
  return { changed: true, ...(effect ? { effect } : {}) };
}

export function sanitizeSharedTerminalOutput(value: string): string {
  return value
    .slice(0, SHARED_TERMINAL_LIMITS.maxOutputChunkCodeUnits)
    .replace(ANSI_ESCAPE, "")
    .replace(/\r\n|\r/gu, "\n")
    .replace(UNSAFE_CONTROL, "");
}

function safeInput(value: string): string {
  return value
    .replace(/[\r\n]/gu, "")
    .replace(UNSAFE_CONTROL, "")
    .slice(0, SHARED_TERMINAL_LIMITS.maxInputCodeUnits);
}

function publicState(state: InternalState): SharedTerminalState {
  return {
    protocolVersion: SHARED_TERMINAL_PROTOCOL_VERSION,
    generation: state.generation,
    seq: state.seq,
    mode: state.mode,
    prompt: state.prompt,
    transcript: state.transcript,
    input: {
      value: state.inputValue,
      cursor: state.inputCursor,
      owner: state.inputOwner ? participant(state.inputOwner) : null,
    },
    host: state.host ? participant(state.host) : null,
    activeRun: state.activeRun ? { ...state.activeRun } : null,
    inputRequestId: state.inputRequestId,
    lastTest: state.lastTest ? { ...state.lastTest } : null,
  };
}

function sameParticipant(
  left: SharedTerminalParticipant | null,
  right: SharedTerminalParticipant | null,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function sameInput(left: SharedTerminalInputState, right: SharedTerminalInputState): boolean {
  return left.value === right.value
    && left.cursor === right.cursor
    && sameParticipant(left.owner, right.owner);
}

function sameRuntime(left: SharedTerminalState, right: SharedTerminalState): boolean {
  return left.mode === right.mode
    && left.prompt === right.prompt
    && sameParticipant(left.host, right.host)
    && JSON.stringify(left.activeRun) === JSON.stringify(right.activeRun)
    && left.inputRequestId === right.inputRequestId
    && JSON.stringify(left.lastTest) === JSON.stringify(right.lastTest);
}

function stableFingerprint(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableFingerprint).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const input = value as Record<string, unknown>;
    return `{${Object.keys(input).sort().map((key) => (
      `${JSON.stringify(key)}:${stableFingerprint(input[key])}`
    )).join(",")}}`;
  }
  return JSON.stringify(value);
}

/**
 * Compact deterministic identity for action retry/idempotency bookkeeping.
 * The canonical input may contain a 64 KiB output chunk, but the retained
 * digest is always 32 bytes/64 hex characters per remembered action.
 */
export function sharedTerminalActionFingerprint(
  action: SharedTerminalAction,
): string {
  return buffer.toHexString(sha256.digest(
    string.encodeUtf8(stableFingerprint(action)),
  ));
}

function buildDelta(
  before: SharedTerminalState,
  after: SharedTerminalState,
  transcriptOperations: readonly SharedTerminalDeltaOperation[],
): SharedTerminalDelta {
  const operations = [...transcriptOperations];
  if (!sameInput(before.input, after.input)) {
    operations.push({
      type: "input",
      input: {
        value: after.input.value,
        cursor: after.input.cursor,
        owner: cloneParticipant(after.input.owner),
      },
    });
  }
  if (!sameRuntime(before, after)) {
    operations.push({
      type: "runtime",
      mode: after.mode,
      prompt: after.prompt,
      host: cloneParticipant(after.host),
      activeRun: after.activeRun ? { ...after.activeRun } : null,
      inputRequestId: after.inputRequestId,
      lastTest: after.lastTest ? { ...after.lastTest } : null,
    });
  }
  return {
    protocolVersion: SHARED_TERMINAL_PROTOCOL_VERSION,
    generation: after.generation,
    baseSeq: before.seq,
    seq: after.seq,
    operations,
  };
}

export function createSharedTerminalAck(
  actionId: string,
  state: Pick<SharedTerminalState, "generation" | "seq">,
  status: SharedTerminalAckStatus,
  error: SharedTerminalError | null = null,
): SharedTerminalAck {
  return {
    protocolVersion: SHARED_TERMINAL_PROTOCOL_VERSION,
    actionId,
    generation: state.generation,
    seq: state.seq,
    status,
    error,
  };
}

export class SharedTerminalStateMachine {
  private readonly state: InternalState = {
    generation: 1,
    seq: 0,
    mode: "shell",
    prompt: "$ ",
    transcript: "help для списка команд\n",
    inputValue: "",
    inputCursor: 0,
    inputOwner: null,
    host: null,
    activeRun: null,
    inputRequestId: null,
    lastTest: null,
    activeRunPythonMode: false,
  };

  private readonly remembered = new Map<string, RememberedAction>();
  private readonly rememberedQueue: string[] = [];
  private transcriptOperations: SharedTerminalDeltaOperation[] = [];
  private nextRun = 1;
  private readonly runEpoch = crypto.randomUUID();

  snapshot(): SharedTerminalState {
    return publicState(this.state);
  }

  connect(): SharedTerminalState {
    return this.snapshot();
  }

  recover(_generation: number, _seq: number): SharedTerminalState {
    return this.snapshot();
  }

  dispatch(
    actor: SharedTerminalActor,
    action: SharedTerminalAction,
  ): SharedTerminalDispatchResult {
    const current = this.snapshot();
    if (!safeActor(actor) || !safeIdentifier(action.actionId)) {
      return this.packageResult(
        action.actionId,
        current,
        unchanged("invalid-action"),
      );
    }

    // Action IDs are workspace-global so a reconnect/retry cannot execute the
    // same line twice merely because Socket.IO assigned a new socket ID.
    const key = action.actionId;
    const fingerprint = sharedTerminalActionFingerprint(action);
    const previous = this.remembered.get(key);
    if (previous) {
      const state = this.snapshot();
      if (previous.fingerprint !== fingerprint) {
        return {
          state,
          changed: false,
          ack: createSharedTerminalAck(
            action.actionId,
            state,
            "rejected",
            "idempotency-conflict",
          ),
          error: "idempotency-conflict",
        };
      }
      return {
        state,
        changed: false,
        ack: createSharedTerminalAck(action.actionId, state, "duplicate"),
        ...(action.type === "sync" ? { snapshot: state } : {}),
      };
    }
    this.remember(key, fingerprint);

    if (action.type === "sync") {
      const state = this.snapshot();
      return {
        state,
        snapshot: state,
        changed: false,
        ack: createSharedTerminalAck(action.actionId, state, "unchanged"),
      };
    }

    this.transcriptOperations = [];
    const before = this.snapshot();
    const outcome = this.apply(actor, action);
    return this.packageResult(action.actionId, before, outcome);
  }

  disconnect(socketId: string): SharedTerminalDispatchResult {
    const before = this.snapshot();
    this.transcriptOperations = [];
    let didChange = false;
    if (this.state.inputOwner?.socketId === socketId) {
      this.state.inputOwner = null;
      didChange = true;
    }
    if (this.state.host?.socketId === socketId) {
      this.append("\n[Процесс остановлен: исполнитель отключился]\n");
      this.toShell();
      didChange = true;
    }
    return this.packageResult(
      "disconnect",
      before,
      didChange ? changed() : unchanged(),
      false,
    );
  }

  updateActor(actor: SharedTerminalActor): SharedTerminalDispatchResult {
    const before = this.snapshot();
    this.transcriptOperations = [];
    if (!safeActor(actor)) {
      return this.packageResult(
        "profile-update",
        before,
        unchanged("invalid-action"),
        false,
      );
    }
    let didChange = false;
    if (
      this.state.inputOwner?.socketId === actor.socketId
      && !sameParticipant(participant(this.state.inputOwner), participant(actor))
    ) {
      this.state.inputOwner = { ...actor };
      didChange = true;
    }
    if (
      this.state.host?.socketId === actor.socketId
      && !sameParticipant(participant(this.state.host), participant(actor))
    ) {
      this.state.host = { ...actor };
      didChange = true;
    }
    return this.packageResult(
      "profile-update",
      before,
      didChange ? changed() : unchanged(),
      false,
    );
  }

  private apply(
    actor: SharedTerminalActor,
    action: Exclude<SharedTerminalAction, { readonly type: "sync" }>,
  ): MutationOutcome {
    if (action.type === "claim") return this.claim(actor);
    if (action.type === "release") return this.release(actor);
    if (action.type === "edit-input") return this.editInput(actor, action);
    if (action.type === "submit-line") return this.submitLine(actor, action.value);
    if (action.type === "start-run") return this.startRun(actor, action);
    if (action.type === "interrupt" || action.type === "eof") {
      return this.signal(action.type);
    }
    if (action.type === "host-output") return this.hostOutput(actor, action);
    if (action.type === "host-input-request") {
      return this.hostInputRequest(actor, action);
    }
    if (action.type === "host-ready") return this.hostReady(actor, action);
    return this.hostFailed(actor, action);
  }

  private claim(actor: SharedTerminalActor): MutationOutcome {
    if (this.state.mode === "busy") return unchanged("busy");
    if (this.state.inputOwner?.socketId !== undefined
      && this.state.inputOwner.socketId !== actor.socketId) {
      return unchanged("input-owned");
    }
    if (this.state.inputOwner?.socketId === actor.socketId) return unchanged();
    this.state.inputOwner = { ...actor };
    return changed();
  }

  private release(actor: SharedTerminalActor): MutationOutcome {
    if (this.state.inputOwner?.socketId !== actor.socketId) return unchanged();
    this.state.inputOwner = null;
    return changed();
  }

  private editInput(
    actor: SharedTerminalActor,
    action: Extract<SharedTerminalAction, { readonly type: "edit-input" }>,
  ): MutationOutcome {
    if (this.state.mode === "busy") return unchanged("busy");
    if (this.state.inputOwner
      && this.state.inputOwner.socketId !== actor.socketId) {
      return unchanged("input-owned");
    }
    if (!Number.isSafeInteger(action.cursor)) {
      return unchanged("invalid-cursor");
    }
    const value = safeInput(action.value);
    const cursor = Math.max(0, Math.min(value.length, action.cursor));
    if (
      this.state.inputValue === value
      && this.state.inputCursor === cursor
      && this.state.inputOwner?.socketId === actor.socketId
    ) return unchanged();
    this.state.inputOwner = { ...actor };
    this.state.inputValue = value;
    this.state.inputCursor = cursor;
    return changed();
  }

  private submitLine(actor: SharedTerminalActor, rawValue: string): MutationOutcome {
    if (this.state.mode === "busy") return unchanged("busy");
    if (this.state.inputOwner
      && this.state.inputOwner.socketId !== actor.socketId) {
      return unchanged("input-owned");
    }
    const value = safeInput(rawValue);
    if (this.state.mode === "shell" && /^(?:clear|cls)$/iu.test(value.trim())) {
      this.state.generation += 1;
      this.state.transcript = "";
      this.transcriptOperations.push({ type: "transcript-replace", value: "" });
      this.clearInput();
      return changed();
    }

    const prompt = this.state.mode === "program-input" ? "" : this.state.prompt;
    this.append(`${prompt}${value}\n`);
    this.clearInput();

    if (this.state.mode === "program-input") {
      const host = this.state.host;
      const run = this.state.activeRun;
      const requestId = this.state.inputRequestId;
      if (!host || !run || !requestId) {
        this.toShell();
        return { changed: true, error: "invalid-state" };
      }
      this.state.mode = "busy";
      this.state.prompt = "";
      this.state.inputRequestId = null;
      return changed({
        type: "submit-input",
        targetSocketId: host.socketId,
        runId: run.runId,
        requestId,
        value,
      });
    }

    if (this.state.mode === "shell" && value.trim() === "") {
      return changed();
    }
    const pythonMode = this.state.mode === "python";
    const host = pythonMode ? this.state.host : actor;
    if (!host) {
      this.toShell();
      return { changed: true, error: "invalid-state" };
    }
    const runId = this.createRunId();
    this.state.mode = "busy";
    this.state.prompt = "";
    this.state.host = { ...host };
    this.state.activeRun = {
      runId,
      entryId: null,
      entrypoint: null,
      testId: null,
    };
    this.state.activeRunPythonMode = pythonMode;
    this.state.inputRequestId = null;
    return changed({
      type: "execute-line",
      targetSocketId: host.socketId,
      runId,
      line: value,
      pythonMode,
    });
  }

  private startRun(
    actor: SharedTerminalActor,
    action: Extract<SharedTerminalAction, { readonly type: "start-run" }>,
  ): MutationOutcome {
    if (this.state.mode !== "shell") return unchanged("busy");
    if (this.state.inputOwner
      && this.state.inputOwner.socketId !== actor.socketId) {
      return unchanged("input-owned");
    }
    if (
      !safeIdentifier(action.entryId)
      || !action.entrypoint
      || !SAFE_WORKSPACE_PATH.test(action.entrypoint)
      || action.entrypoint.length > SHARED_TERMINAL_LIMITS.maxCommandCodeUnits
      || (action.testId !== undefined && !safeIdentifier(action.testId))
    ) return unchanged("invalid-run");
    const runId = this.createRunId();
    this.append(`${this.state.prompt}py ${action.entrypoint}\n`);
    this.state.mode = "busy";
    this.state.prompt = "";
    this.clearInput();
    this.state.host = { ...actor };
    this.state.activeRun = {
      runId,
      entryId: action.entryId,
      entrypoint: action.entrypoint,
      testId: action.testId ?? null,
    };
    this.state.activeRunPythonMode = false;
    this.state.inputRequestId = null;
    this.state.lastTest = null;
    return changed({
      type: "start-run",
      targetSocketId: actor.socketId,
      runId,
      entryId: action.entryId,
      entrypoint: action.entrypoint,
      testId: action.testId ?? null,
    });
  }

  private signal(type: "interrupt" | "eof"): MutationOutcome {
    if (this.state.mode === "python" && type === "interrupt" && this.state.host) {
      const runId = this.createRunId();
      this.append("^C\nKeyboardInterrupt\n");
      this.state.mode = "busy";
      this.state.prompt = "";
      this.clearInput();
      this.state.activeRun = {
        runId,
        entryId: null,
        entrypoint: null,
        testId: null,
      };
      this.state.activeRunPythonMode = true;
      this.state.inputRequestId = null;
      return changed({
        type: "interrupt",
        targetSocketId: this.state.host.socketId,
        runId,
        pythonMode: true,
      });
    }
    if (this.state.mode === "python" && type === "eof" && this.state.host) {
      const runId = this.createRunId();
      this.state.mode = "busy";
      this.state.prompt = "";
      this.state.activeRun = {
        runId,
        entryId: null,
        entrypoint: null,
        testId: null,
      };
      this.state.activeRunPythonMode = true;
      return changed({
        type: "eof",
        targetSocketId: this.state.host.socketId,
        runId,
      });
    }
    const host = this.state.host;
    const run = this.state.activeRun;
    const pythonMode = this.state.activeRunPythonMode;
    if (!host || !run || this.state.mode === "shell" || this.state.mode === "python") {
      return unchanged("not-running");
    }
    this.state.mode = "busy";
    this.state.prompt = "";
    this.state.inputRequestId = null;
    this.clearInput();
    if (type === "interrupt" && pythonMode) {
      this.append("^C\nKeyboardInterrupt\n");
    }
    return changed(type === "interrupt" ? {
      type,
      targetSocketId: host.socketId,
      runId: run.runId,
      pythonMode,
    } : {
      type,
      targetSocketId: host.socketId,
      runId: run.runId,
    });
  }

  private hostOutput(
    actor: SharedTerminalActor,
    action: Extract<SharedTerminalAction, { readonly type: "host-output" }>,
  ): MutationOutcome {
    if (!this.isCurrentHost(actor, action.runId)) return unchanged("not-host");
    const chunk = sanitizeSharedTerminalOutput(action.chunk);
    if (!chunk) return unchanged();
    this.append(chunk);
    return changed();
  }

  private hostInputRequest(
    actor: SharedTerminalActor,
    action: Extract<SharedTerminalAction, { readonly type: "host-input-request" }>,
  ): MutationOutcome {
    if (!this.isCurrentHost(actor, action.runId)) return unchanged("not-host");
    if (!safeIdentifier(action.requestId) || this.state.mode !== "busy") {
      return unchanged("invalid-state");
    }
    this.state.mode = "program-input";
    this.state.prompt = "";
    this.state.inputRequestId = action.requestId;
    this.clearInput();
    return changed();
  }

  private hostReady(
    actor: SharedTerminalActor,
    action: Extract<SharedTerminalAction, { readonly type: "host-ready" }>,
  ): MutationOutcome {
    if (!this.isCurrentHost(actor, action.runId)) return unchanged("not-host");
    if (action.testResult
      && action.testResult.testId !== this.state.activeRun?.testId) {
      return unchanged("invalid-test-result");
    }
    if (action.testResult) this.state.lastTest = { ...action.testResult };
    this.state.activeRun = null;
    this.state.activeRunPythonMode = false;
    this.state.inputRequestId = null;
    this.clearInput();
    if (this.state.transcript && !this.state.transcript.endsWith("\n")) {
      this.append("\n");
    }
    if (action.nextMode === "python") {
      this.state.mode = "python";
      this.state.prompt = action.prompt ?? ">>> ";
    } else {
      this.state.mode = "shell";
      this.state.prompt = "$ ";
      this.state.host = null;
    }
    return changed();
  }

  private hostFailed(
    actor: SharedTerminalActor,
    action: Extract<SharedTerminalAction, { readonly type: "host-failed" }>,
  ): MutationOutcome {
    if (!this.isCurrentHost(actor, action.runId)) return unchanged("not-host");
    const message = sanitizeSharedTerminalOutput(action.message).slice(0, 2_048);
    if (message) this.append(`${message}${message.endsWith("\n") ? "" : "\n"}`);
    this.toShell();
    return changed();
  }

  private isCurrentHost(actor: SharedTerminalActor, runId: string): boolean {
    return safeIdentifier(runId)
      && this.state.host?.socketId === actor.socketId
      && this.state.activeRun?.runId === runId;
  }

  private clearInput(): void {
    this.state.inputValue = "";
    this.state.inputCursor = 0;
    this.state.inputOwner = null;
  }

  private toShell(): void {
    if (this.state.transcript && !this.state.transcript.endsWith("\n")) {
      this.append("\n");
    }
    this.state.mode = "shell";
    this.state.prompt = "$ ";
    this.clearInput();
    this.state.host = null;
    this.state.activeRun = null;
    this.state.activeRunPythonMode = false;
    this.state.inputRequestId = null;
  }

  private append(value: string): void {
    const beforeLength = this.state.transcript.length;
    this.state.transcript += value;
    const trimStart = Math.max(
      0,
      this.state.transcript.length - SHARED_TERMINAL_LIMITS.maxTranscriptCodeUnits,
    );
    if (trimStart > 0) this.state.transcript = this.state.transcript.slice(trimStart);
    this.transcriptOperations.push({
      type: "transcript-append",
      trimStart: Math.min(trimStart, beforeLength),
      value: trimStart > beforeLength
        ? value.slice(trimStart - beforeLength)
        : value,
    });
  }

  private createRunId(): string {
    const value = `run-${this.runEpoch}-${this.state.generation}-${this.nextRun}`;
    this.nextRun += 1;
    return value;
  }

  private remember(key: string, fingerprint: string): void {
    this.remembered.set(key, { fingerprint });
    this.rememberedQueue.push(key);
    while (this.rememberedQueue.length > SHARED_TERMINAL_LIMITS.maxRememberedActions) {
      const removed = this.rememberedQueue.shift();
      if (removed) this.remembered.delete(removed);
    }
  }

  private packageResult(
    actionId: string,
    before: SharedTerminalState,
    outcome: MutationOutcome,
    includeAck = true,
  ): SharedTerminalDispatchResult {
    if (outcome.changed) this.state.seq += 1;
    const state = this.snapshot();
    const status: SharedTerminalAckStatus = outcome.error
      ? "rejected"
      : outcome.changed ? "applied" : "unchanged";
    const result: SharedTerminalDispatchResult = {
      state,
      changed: outcome.changed,
      ack: createSharedTerminalAck(actionId, state, status, outcome.error ?? null),
      ...(outcome.changed && before.generation !== state.generation
        ? { snapshot: state }
        : outcome.changed
        ? { delta: buildDelta(before, state, this.transcriptOperations) }
        : {}),
      ...(outcome.effect ? { effect: outcome.effect } : {}),
      ...(outcome.error ? { error: outcome.error } : {}),
    };
    if (!includeAck) {
      // Disconnects are not client actions, but retaining a structurally valid
      // ack keeps the result backward compatible for local adapters.
      return result;
    }
    return result;
  }
}

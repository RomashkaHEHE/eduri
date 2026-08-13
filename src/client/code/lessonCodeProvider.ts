import { io } from "socket.io-client";
import * as Y from "yjs";
import { LESSON_CODE_SYNC_NAMESPACE } from "../../code/lessonSync.js";
import {
  CODE_SYNC_LIMITS,
  CODE_SYNC_MESSAGE_EVENT,
  CODE_SYNC_PROTOCOL_VERSION,
  CODE_SYNC_TAGS,
  CODE_SYNC_UPDATE_ENCODING,
  parseCodeAwarenessState,
  type CodeAwarenessState,
  type CodeParticipantIdentity,
  type CodeSyncClientMessage,
  type CodeSyncControlCode,
} from "../../code/protocol/index.js";
import {
  SHARED_TERMINAL_ACK_EVENT,
  SHARED_TERMINAL_ACTION_EVENT,
  SHARED_TERMINAL_DELTA_EVENT,
  SHARED_TERMINAL_EFFECT_EVENT,
  SHARED_TERMINAL_PROTOCOL_VERSION,
  SHARED_TERMINAL_STATE_EVENT,
  applySharedTerminalDelta,
  parseSharedTerminalAck,
  parseSharedTerminalClientEffect,
  parseSharedTerminalState,
  type SharedTerminalAck,
  type SharedTerminalAction,
  type SharedTerminalClientEffect,
  type SharedTerminalState,
} from "../../code/terminal/index.js";
import { validateCodeWorkspaceDocument } from "../../code/core/index.js";
import {
  CODE_SYNC_REMOTE_ORIGIN,
  CodeSyncIndexedDbStore,
  type PendingCodeSyncUpdate,
} from "./codeSyncStore.js";
import {
  createTerminalActionOutbox,
  type TerminalActionOutbox,
} from "./terminalActionOutbox.js";

export type LessonCodeConnection =
  | "loading-local"
  | "offline"
  | "connecting"
  | "syncing"
  | "online"
  | "error";

export type LessonCodeDurability = "ready" | "writing" | "at-risk";

export interface LessonCodeStatus {
  readonly connection: LessonCodeConnection;
  /** Changes on every socket connect/disconnect boundary. */
  readonly terminalConnectionEpoch: number;
  readonly durability: LessonCodeDurability;
  readonly documentReady: boolean;
  readonly pendingUpdates: number;
  readonly participant: CodeParticipantIdentity | null;
  readonly error: string | null;
}

export interface LessonCodePeerAwareness {
  readonly participant: CodeParticipantIdentity;
  readonly state: CodeAwarenessState;
}

export interface LessonCodeSocket {
  readonly connected: boolean;
  on(event: string, listener: (...args: any[]) => void): this;
  off(event: string, listener: (...args: any[]) => void): this;
  emit(event: string, ...args: any[]): this;
  connect(): this;
  disconnect(): this;
}

export interface LessonCodeProviderOptions {
  readonly lessonId: string;
  readonly userId: string;
  readonly deviceId: string;
  readonly databaseName?: string;
  readonly socketFactory?: (
    namespace: string,
    auth: { readonly lessonId: string; readonly deviceId: string },
  ) => LessonCodeSocket;
  readonly createId?: () => string;
  readonly ackTimeoutMs?: number;
  readonly awarenessThrottleMs?: number;
}

interface ParsedReady {
  readonly type: typeof CODE_SYNC_TAGS.ready;
  readonly deviceId: string;
  readonly participant: CodeParticipantIdentity;
}

interface ParsedSyncStep2 {
  readonly type: typeof CODE_SYNC_TAGS.syncStep2;
  readonly requestId: string;
  readonly part: number;
  readonly done: boolean;
  readonly update: Uint8Array;
}

interface ParsedRemoteUpdate {
  readonly type: typeof CODE_SYNC_TAGS.remoteUpdate;
  readonly update: Uint8Array;
}

interface ParsedAck {
  readonly type: typeof CODE_SYNC_TAGS.updateAck;
  readonly requestId: string;
  readonly updateId: string;
}

interface ParsedAwareness {
  readonly type: typeof CODE_SYNC_TAGS.awareness;
  readonly participant: CodeParticipantIdentity;
  readonly state: CodeAwarenessState | null;
}

interface ParsedControl {
  readonly type: typeof CODE_SYNC_TAGS.control;
  readonly code: CodeSyncControlCode;
  readonly message: string;
  readonly terminal: boolean;
  readonly requestId?: string;
}

type ParsedServerMessage =
  | ParsedReady
  | ParsedSyncStep2
  | ParsedRemoteUpdate
  | ParsedAck
  | ParsedAwareness
  | ParsedControl;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const IDENTIFIER = /^[A-Za-z0-9_-]{1,128}$/u;
const PARTICIPANT_COLOR = /^#[0-9a-f]{6}$/iu;

export function lessonCodeDatabaseName(userId: string, lessonId: string): string {
  if (!UUID.test(userId) || !UUID.test(lessonId)) {
    throw new Error("Lesson Code local storage identity is invalid");
  }
  return `eduri-code-lesson-v1:${userId}:${lessonId}`;
}

function object(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function identifier(value: unknown): string | null {
  return typeof value === "string" && IDENTIFIER.test(value) ? value : null;
}

function bytes(value: unknown, maximum: number): Uint8Array | null {
  let result: Uint8Array;
  if (value instanceof Uint8Array) result = value.slice();
  else if (value instanceof ArrayBuffer) result = new Uint8Array(value.slice(0));
  else if (ArrayBuffer.isView(value)) {
    result = Uint8Array.from(new Uint8Array(
      value.buffer,
      value.byteOffset,
      value.byteLength,
    ));
  } else return null;
  return result.byteLength > 0 && result.byteLength <= maximum ? result : null;
}

function participant(value: unknown): CodeParticipantIdentity | null {
  const input = object(value);
  if (!input) return null;
  const participantId = identifier(input.participantId);
  const displayName = typeof input.displayName === "string"
    && input.displayName.length > 0
    && input.displayName.length <= 128
      ? input.displayName
      : null;
  const color = typeof input.color === "string"
    && PARTICIPANT_COLOR.test(input.color)
      ? input.color
      : null;
  return participantId && displayName && color
    ? { participantId, displayName, color }
    : null;
}

function awarenessState(value: unknown): CodeAwarenessState | null | undefined {
  if (value === null) return null;
  try {
    return parseCodeAwarenessState(value);
  } catch {
    return undefined;
  }
}

function parseServerMessage(raw: unknown): ParsedServerMessage | null {
  const input = object(raw);
  if (!input || input.protocolVersion !== CODE_SYNC_PROTOCOL_VERSION) return null;
  if (input.type === CODE_SYNC_TAGS.ready) {
    const deviceId = identifier(input.deviceId);
    const identity = participant(input.participant);
    return deviceId && identity
      ? { type: CODE_SYNC_TAGS.ready, deviceId, participant: identity }
      : null;
  }
  if (input.type === CODE_SYNC_TAGS.syncStep2) {
    const requestId = identifier(input.requestId);
    const update = bytes(input.update, CODE_SYNC_LIMITS.maxUpdateBytes);
    return requestId
      && update
      && Number.isSafeInteger(input.part)
      && (input.part as number) >= 0
      && typeof input.done === "boolean"
      && input.updateEncoding === CODE_SYNC_UPDATE_ENCODING
      ? {
          type: CODE_SYNC_TAGS.syncStep2,
          requestId,
          part: input.part as number,
          done: input.done,
          update,
        }
      : null;
  }
  if (input.type === CODE_SYNC_TAGS.remoteUpdate) {
    const update = bytes(input.update, CODE_SYNC_LIMITS.maxUpdateBytes);
    return update && identifier(input.sourceParticipantId)
      && identifier(input.updateId)
      && input.updateEncoding === CODE_SYNC_UPDATE_ENCODING
      ? { type: CODE_SYNC_TAGS.remoteUpdate, update }
      : null;
  }
  if (input.type === CODE_SYNC_TAGS.updateAck) {
    const requestId = identifier(input.requestId);
    const updateId = identifier(input.updateId);
    return requestId && updateId
      ? { type: CODE_SYNC_TAGS.updateAck, requestId, updateId }
      : null;
  }
  if (input.type === CODE_SYNC_TAGS.awareness) {
    const identity = participant(input.participant);
    const state = awarenessState(input.state);
    return identity && state !== undefined
      ? { type: CODE_SYNC_TAGS.awareness, participant: identity, state }
      : null;
  }
  if (input.type === CODE_SYNC_TAGS.control) {
    const codes: readonly CodeSyncControlCode[] = [
      "expired",
      "not-found",
      "invalid-message",
      "invalid-update",
      "storage-error",
      "rate-limited",
    ];
    const requestId = input.requestId === undefined
      ? undefined
      : identifier(input.requestId) ?? undefined;
    return codes.includes(input.code as CodeSyncControlCode)
      && typeof input.message === "string"
      && typeof input.terminal === "boolean"
      ? {
          type: CODE_SYNC_TAGS.control,
          code: input.code as CodeSyncControlCode,
          message: input.message,
          terminal: input.terminal,
          ...(requestId ? { requestId } : {}),
        }
      : null;
  }
  return null;
}

function defaultSocketFactory(
  namespace: string,
  auth: { readonly lessonId: string; readonly deviceId: string },
): LessonCodeSocket {
  return io(namespace, {
    auth,
    autoConnect: false,
    forceNew: true,
    transports: ["websocket"],
    reconnection: true,
    withCredentials: true,
  }) as unknown as LessonCodeSocket;
}

function cloneStatus(status: LessonCodeStatus): LessonCodeStatus {
  return {
    ...status,
    participant: status.participant ? { ...status.participant } : null,
  };
}

export class LessonCodeProvider {
  readonly document = new Y.Doc();
  readonly origin = Object.freeze({ type: "eduri.code.local-command" });
  readonly store: CodeSyncIndexedDbStore;

  private readonly socket: LessonCodeSocket;
  private readonly terminalActionOutbox: TerminalActionOutbox;
  private readonly createId: () => string;
  private readonly ackTimeoutMs: number;
  private readonly awarenessThrottleMs: number;
  private readonly statusListeners = new Set<(status: LessonCodeStatus) => void>();
  private readonly awarenessListeners = new Set<
    (peers: readonly LessonCodePeerAwareness[]) => void
  >();
  private readonly terminalStateListeners = new Set<
    (state: SharedTerminalState) => void
  >();
  private readonly terminalEffectListeners = new Set<
    (effect: SharedTerminalClientEffect) => void
  >();
  private readonly terminalAckListeners = new Set<
    (ack: SharedTerminalAck) => void
  >();
  private readonly pending = new Map<string, PendingCodeSyncUpdate>();
  private readonly peers = new Map<string, LessonCodePeerAwareness>();
  private readonly synchronizationWaiters = new Set<{
    readonly resolve: () => void;
    readonly reject: (error: Error) => void;
    readonly timer: ReturnType<typeof setTimeout>;
  }>();
  private status: LessonCodeStatus = {
    connection: "loading-local",
    terminalConnectionEpoch: 0,
    durability: "ready",
    documentReady: false,
    pendingUpdates: 0,
    participant: null,
    error: null,
  };
  private syncRequestId: string | null = null;
  private nextSyncPart = 0;
  private inFlight: PendingCodeSyncUpdate | null = null;
  private inFlightRequestId: string | null = null;
  private ackTimer: ReturnType<typeof setTimeout> | null = null;
  private awarenessTimer: ReturnType<typeof setTimeout> | null = null;
  private localAwareness: CodeAwarenessState | null = null;
  private terminalState: SharedTerminalState | null = null;
  private terminalSyncPending = false;
  private terminalInitialSnapshotPending = false;
  private socketReady = false;
  private syncComplete = false;
  private queuedLocalWrites = 0;
  private startPromise: Promise<void> | null = null;
  private stopped = false;

  constructor(private readonly options: LessonCodeProviderOptions) {
    this.createId = options.createId ?? (() => crypto.randomUUID());
    this.ackTimeoutMs = options.ackTimeoutMs ?? 10_000;
    this.awarenessThrottleMs = options.awarenessThrottleMs ?? 120;
    this.store = new CodeSyncIndexedDbStore(
      options.databaseName
        ?? lessonCodeDatabaseName(options.userId, options.lessonId),
      this.document,
      {
        createUpdateId: this.createId,
        onLocalUpdateQueued: () => {
          this.queuedLocalWrites += 1;
          this.patchStatus({ durability: "writing" });
        },
        onDurableLocalUpdate: (update) => {
          this.queuedLocalWrites = Math.max(0, this.queuedLocalWrites - 1);
          this.pending.set(update.updateId, update);
          this.patchStatus({
            durability: this.queuedLocalWrites === 0 ? "ready" : "writing",
            pendingUpdates: this.pending.size,
          });
          this.pumpPendingUpdate();
        },
        onWriteError: (error) => this.patchStatus({
          durability: "at-risk",
          error: error instanceof Error
            ? error.message
            : "Local lesson Code storage failed",
        }),
      },
    );
    this.socket = (options.socketFactory ?? defaultSocketFactory)(
      LESSON_CODE_SYNC_NAMESPACE,
      { lessonId: options.lessonId, deviceId: options.deviceId },
    );
    this.terminalActionOutbox = createTerminalActionOutbox({
      connected: () => this.socket.connected && !this.stopped,
      send: (action) => this.socket.emit(SHARED_TERMINAL_ACTION_EVENT, {
        protocolVersion: SHARED_TERMINAL_PROTOCOL_VERSION,
        action,
      }),
      onDiscard: (action) => this.handleDiscardedTerminalAction(action),
    });
  }

  start(): Promise<void> {
    if (!this.startPromise) this.startPromise = this.initialize();
    return this.startPromise;
  }

  getStatus(): LessonCodeStatus {
    return cloneStatus(this.status);
  }

  getPeers(): readonly LessonCodePeerAwareness[] {
    return [...this.peers.values()]
      .sort((left, right) => left.participant.participantId.localeCompare(
        right.participant.participantId,
      ))
      .map((peer) => ({
        participant: { ...peer.participant },
        state: parseCodeAwarenessState(peer.state),
      }));
  }

  subscribeStatus(listener: (status: LessonCodeStatus) => void): () => void {
    this.statusListeners.add(listener);
    listener(this.getStatus());
    return () => this.statusListeners.delete(listener);
  }

  subscribeAwareness(
    listener: (peers: readonly LessonCodePeerAwareness[]) => void,
  ): () => void {
    this.awarenessListeners.add(listener);
    listener(this.getPeers());
    return () => this.awarenessListeners.delete(listener);
  }

  subscribeTerminalState(listener: (state: SharedTerminalState) => void): () => void {
    this.terminalStateListeners.add(listener);
    if (this.terminalState) listener(this.terminalState);
    return () => this.terminalStateListeners.delete(listener);
  }

  subscribeTerminalEffects(
    listener: (effect: SharedTerminalClientEffect) => void,
  ): () => void {
    this.terminalEffectListeners.add(listener);
    return () => this.terminalEffectListeners.delete(listener);
  }

  subscribeTerminalAcks(listener: (ack: SharedTerminalAck) => void): () => void {
    this.terminalAckListeners.add(listener);
    return () => this.terminalAckListeners.delete(listener);
  }

  dispatchTerminal(action: SharedTerminalAction): void {
    if (this.stopped) return;
    this.terminalActionOutbox.dispatch(action);
  }

  setAwareness(state: CodeAwarenessState | null): void {
    this.localAwareness = state;
    if (!this.socketReady || this.stopped || this.awarenessTimer !== null) return;
    this.awarenessTimer = setTimeout(() => {
      this.awarenessTimer = null;
      this.sendAwareness();
    }, this.awarenessThrottleMs);
  }

  async flush(): Promise<void> {
    await this.store.flush();
  }

  async waitUntilSynchronized(timeoutMs = 30_000): Promise<void> {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
      throw new TypeError("Lesson Code synchronization timeout must be positive");
    }
    await this.start();
    await this.store.flush();
    if (this.isSynchronized()) return;
    if (this.stopped) throw new Error("Lesson Code collaboration is stopped");
    if (this.status.connection === "error") {
      throw new Error(this.status.error ?? "Lesson Code synchronization failed");
    }
    await new Promise<void>((resolve, reject) => {
      const waiter = {
        resolve,
        reject,
        timer: setTimeout(() => {
          this.synchronizationWaiters.delete(waiter);
          reject(new Error("Lesson Code synchronization timed out"));
        }, timeoutMs),
      };
      this.synchronizationWaiters.add(waiter);
    });
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.clearAckTimer();
    if (this.awarenessTimer !== null) clearTimeout(this.awarenessTimer);
    this.awarenessTimer = null;
    if (this.socket.connected && this.socketReady) {
      this.socket.emit(CODE_SYNC_MESSAGE_EVENT, {
        type: CODE_SYNC_TAGS.awareness,
        protocolVersion: CODE_SYNC_PROTOCOL_VERSION,
        state: null,
      } satisfies CodeSyncClientMessage);
    }
    this.removeSocketListeners();
    this.terminalActionOutbox.clear();
    this.socket.disconnect();
    await this.store.close();
    this.document.destroy();
    this.rejectSynchronizationWaiters("Lesson Code collaboration was stopped");
  }

  async clearLocalData(): Promise<void> {
    if (!this.stopped) {
      this.stopped = true;
      this.clearAckTimer();
      if (this.awarenessTimer !== null) clearTimeout(this.awarenessTimer);
      this.awarenessTimer = null;
      this.removeSocketListeners();
      this.terminalActionOutbox.clear();
      this.socket.disconnect();
    }
    await this.store.clearData();
    this.document.destroy();
    this.rejectSynchronizationWaiters("Lesson Code data was cleared");
  }

  private async initialize(): Promise<void> {
    try {
      await this.store.whenReady;
      if (this.stopped) return;
      for (const update of await this.store.listPendingUpdates()) {
        this.pending.set(update.updateId, update);
      }
      const hasLocalDocument = this.document.store.clients.size > 0;
      if (hasLocalDocument) validateCodeWorkspaceDocument(this.document);
      this.status = {
        ...this.status,
        connection: "offline",
        documentReady: hasLocalDocument,
        pendingUpdates: this.pending.size,
      };
      this.emitStatus();
      this.addSocketListeners();
      this.patchStatus({ connection: "connecting" });
      this.socket.connect();
    } catch (error) {
      this.patchStatus({
        connection: "error",
        durability: "at-risk",
        error: error instanceof Error
          ? error.message
          : "Lesson Code collaboration could not start",
      });
      throw error;
    }
  }

  private addSocketListeners(): void {
    this.socket.on("connect", this.handleConnect);
    this.socket.on("disconnect", this.handleDisconnect);
    this.socket.on("connect_error", this.handleConnectError);
    this.socket.on(CODE_SYNC_MESSAGE_EVENT, this.handleMessage);
    this.socket.on(SHARED_TERMINAL_STATE_EVENT, this.handleTerminalState);
    this.socket.on(SHARED_TERMINAL_DELTA_EVENT, this.handleTerminalDelta);
    this.socket.on(SHARED_TERMINAL_ACK_EVENT, this.handleTerminalAck);
    this.socket.on(SHARED_TERMINAL_EFFECT_EVENT, this.handleTerminalEffect);
  }

  private removeSocketListeners(): void {
    this.socket.off("connect", this.handleConnect);
    this.socket.off("disconnect", this.handleDisconnect);
    this.socket.off("connect_error", this.handleConnectError);
    this.socket.off(CODE_SYNC_MESSAGE_EVENT, this.handleMessage);
    this.socket.off(SHARED_TERMINAL_STATE_EVENT, this.handleTerminalState);
    this.socket.off(SHARED_TERMINAL_DELTA_EVENT, this.handleTerminalDelta);
    this.socket.off(SHARED_TERMINAL_ACK_EVENT, this.handleTerminalAck);
    this.socket.off(SHARED_TERMINAL_EFFECT_EVENT, this.handleTerminalEffect);
  }

  private readonly handleTerminalState = (raw: unknown): void => {
    const state = parseSharedTerminalState(raw);
    if (!state || this.stopped) return;
    const current = this.terminalState;
    if (!this.terminalInitialSnapshotPending && current && (
      state.generation < current.generation
      || (state.generation === current.generation && state.seq < current.seq)
    )) return;
    this.terminalInitialSnapshotPending = false;
    this.terminalSyncPending = false;
    this.terminalState = state;
    for (const listener of this.terminalStateListeners) listener(state);
  };

  private readonly handleTerminalDelta = (raw: unknown): void => {
    if (this.stopped) return;
    const next = this.terminalState
      ? applySharedTerminalDelta(this.terminalState, raw)
      : null;
    if (!next) {
      if (!this.terminalSyncPending) {
        this.terminalSyncPending = true;
        this.dispatchTerminal({ type: "sync", actionId: this.createId() });
      }
      return;
    }
    this.terminalState = next;
    for (const listener of this.terminalStateListeners) listener(next);
  };

  private readonly handleTerminalAck = (raw: unknown): void => {
    const ack = parseSharedTerminalAck(raw);
    if (!ack || this.stopped) return;
    this.terminalActionOutbox.acknowledge(ack.actionId);
    for (const listener of this.terminalAckListeners) listener(ack);
  };

  private readonly handleDiscardedTerminalAction = (
    action: SharedTerminalAction,
  ): void => {
    if (this.stopped) return;
    if (action.type === "sync") {
      this.terminalSyncPending = false;
      this.socket.disconnect();
      this.socket.connect();
      return;
    }
    const current = this.terminalState;
    const ack: SharedTerminalAck = {
      protocolVersion: SHARED_TERMINAL_PROTOCOL_VERSION,
      actionId: action.actionId,
      generation: current?.generation ?? 1,
      seq: current?.seq ?? 0,
      status: "rejected",
      error: "rate-limited",
    };
    for (const listener of this.terminalAckListeners) listener(ack);
    if (!this.socket.connected || this.terminalSyncPending) return;
    this.terminalSyncPending = true;
    this.terminalActionOutbox.dispatch({
      type: "sync",
      actionId: this.createId(),
    });
  };

  private readonly handleTerminalEffect = (raw: unknown): void => {
    const effect = parseSharedTerminalClientEffect(raw);
    if (!effect || this.stopped) return;
    for (const listener of this.terminalEffectListeners) listener(effect);
  };

  private readonly handleConnect = (): void => {
    this.terminalSyncPending = false;
    this.terminalInitialSnapshotPending = true;
    if (!this.stopped) this.patchStatus({
      connection: "syncing",
      terminalConnectionEpoch: this.status.terminalConnectionEpoch + 1,
      error: null,
    });
  };

  private readonly handleDisconnect = (): void => {
    if (this.stopped) return;
    const terminalConnectionEpoch = this.status.terminalConnectionEpoch + 1;
    if (this.status.connection === "error") {
      this.patchStatus({ terminalConnectionEpoch });
      return;
    }
    this.socketReady = false;
    this.terminalActionOutbox.clear();
    this.terminalSyncPending = false;
    this.terminalInitialSnapshotPending = true;
    this.syncComplete = false;
    this.syncRequestId = null;
    this.nextSyncPart = 0;
    this.inFlight = null;
    this.inFlightRequestId = null;
    this.clearAckTimer();
    if (this.peers.size > 0) {
      this.peers.clear();
      this.emitAwareness();
    }
    this.patchStatus({ connection: "offline", terminalConnectionEpoch });
  };

  private readonly handleConnectError = (error: unknown): void => {
    if (!this.stopped) this.patchStatus({
      terminalConnectionEpoch: this.status.terminalConnectionEpoch + 1,
    });
    const control = parseServerMessage(object(error)?.data);
    if (control?.type === CODE_SYNC_TAGS.control) {
      this.handleControl(control);
      return;
    }
    if (!this.stopped) this.patchStatus({
      connection: "offline",
      error: typeof object(error)?.message === "string"
        ? object(error)?.message as string
        : "Lesson Code collaboration is offline",
    });
  };

  private readonly handleMessage = (raw: unknown): void => {
    if (this.stopped) return;
    const message = parseServerMessage(raw);
    if (!message) {
      this.patchStatus({ error: "Lesson Code server sent an invalid message" });
      return;
    }
    if (message.type === CODE_SYNC_TAGS.ready) {
      if (message.deviceId !== this.options.deviceId) {
        this.failTerminal("Lesson Code server returned a mismatched device");
        return;
      }
      this.socketReady = true;
      this.syncComplete = false;
      this.status = { ...this.status, participant: message.participant };
      this.sendSyncStep1();
      this.sendAwareness();
      return;
    }
    if (message.type === CODE_SYNC_TAGS.syncStep2) {
      if (message.requestId !== this.syncRequestId) return;
      if (message.part < this.nextSyncPart) return;
      if (message.part !== this.nextSyncPart) {
        this.failTerminal("Lesson Code sync response has a missing part");
        return;
      }
      this.nextSyncPart += 1;
      Y.applyUpdate(this.document, message.update, CODE_SYNC_REMOTE_ORIGIN);
      if (message.done) {
        this.syncRequestId = null;
        void this.finishInitialSync();
      }
      return;
    }
    if (message.type === CODE_SYNC_TAGS.remoteUpdate) {
      Y.applyUpdate(this.document, message.update, CODE_SYNC_REMOTE_ORIGIN);
      return;
    }
    if (message.type === CODE_SYNC_TAGS.updateAck) {
      void this.handleAck(message);
      return;
    }
    if (message.type === CODE_SYNC_TAGS.awareness) {
      if (message.participant.participantId === this.status.participant?.participantId) {
        return;
      }
      if (message.state === null) {
        this.peers.delete(message.participant.participantId);
      } else {
        this.peers.set(message.participant.participantId, {
          participant: message.participant,
          state: message.state,
        });
      }
      this.emitAwareness();
      return;
    }
    this.handleControl(message);
  };

  private sendSyncStep1(): void {
    if (!this.socketReady || !this.socket.connected) return;
    const requestId = this.createId();
    this.syncRequestId = requestId;
    this.nextSyncPart = 0;
    this.patchStatus({ connection: "syncing" });
    this.socket.emit(CODE_SYNC_MESSAGE_EVENT, {
      type: CODE_SYNC_TAGS.syncStep1,
      protocolVersion: CODE_SYNC_PROTOCOL_VERSION,
      requestId,
      stateVector: Y.encodeStateVector(this.document),
    } satisfies CodeSyncClientMessage);
  }

  private async finishInitialSync(): Promise<void> {
    try {
      await this.store.flush();
      validateCodeWorkspaceDocument(this.document);
      if (this.stopped) return;
      this.syncComplete = true;
      this.patchStatus({
        connection: "online",
        documentReady: true,
        error: null,
      });
      this.pumpPendingUpdate();
    } catch (error) {
      this.failTerminal(error instanceof Error
        ? error.message
        : "Lesson Code workspace sync failed");
    }
  }

  private pumpPendingUpdate(): void {
    if (
      this.stopped
      || !this.socket.connected
      || !this.socketReady
      || !this.syncComplete
      || this.inFlight
      || this.status.durability === "at-risk"
    ) return;
    const next = [...this.pending.values()]
      .sort((left, right) => left.queueOrder - right.queueOrder)[0];
    if (!next) return;
    this.inFlight = next;
    this.inFlightRequestId = this.createId();
    this.socket.emit(CODE_SYNC_MESSAGE_EVENT, {
      type: CODE_SYNC_TAGS.update,
      protocolVersion: CODE_SYNC_PROTOCOL_VERSION,
      requestId: this.inFlightRequestId,
      updateId: next.updateId,
      updateEncoding: CODE_SYNC_UPDATE_ENCODING,
      update: next.update.slice(),
    } satisfies CodeSyncClientMessage);
    this.clearAckTimer();
    this.ackTimer = setTimeout(() => {
      this.ackTimer = null;
      this.inFlight = null;
      this.inFlightRequestId = null;
      this.pumpPendingUpdate();
    }, this.ackTimeoutMs);
  }

  private async handleAck(message: ParsedAck): Promise<void> {
    const inFlight = this.inFlight;
    if (
      !inFlight
      || inFlight.updateId !== message.updateId
      || message.requestId !== this.inFlightRequestId
    ) return;
    try {
      await this.store.acknowledge(message.updateId);
      if (this.stopped) return;
      this.pending.delete(message.updateId);
      this.inFlight = null;
      this.inFlightRequestId = null;
      this.clearAckTimer();
      this.patchStatus({ pendingUpdates: this.pending.size, error: null });
      this.pumpPendingUpdate();
    } catch (error) {
      this.inFlight = null;
      this.inFlightRequestId = null;
      this.clearAckTimer();
      this.patchStatus({
        durability: "at-risk",
        error: error instanceof Error ? error.message : "Lesson Code ACK failed",
      });
    }
  }

  private handleControl(message: ParsedControl): void {
    if (!message.terminal) {
      if (
        message.code === "invalid-update"
        && this.inFlight
        && message.requestId === this.inFlightRequestId
      ) {
        this.inFlight = null;
        this.inFlightRequestId = null;
        this.clearAckTimer();
        this.patchStatus({ durability: "at-risk", error: message.message });
        return;
      }
      this.patchStatus({ error: message.message });
      return;
    }
    this.patchStatus({ connection: "error", error: message.message });
    this.socket.disconnect();
  }

  private failTerminal(message: string): void {
    this.patchStatus({ connection: "error", error: message });
    this.socket.disconnect();
  }

  private sendAwareness(): void {
    if (!this.socketReady || !this.socket.connected || this.stopped) return;
    this.socket.emit(CODE_SYNC_MESSAGE_EVENT, {
      type: CODE_SYNC_TAGS.awareness,
      protocolVersion: CODE_SYNC_PROTOCOL_VERSION,
      state: this.localAwareness,
    } satisfies CodeSyncClientMessage);
  }

  private clearAckTimer(): void {
    if (this.ackTimer !== null) clearTimeout(this.ackTimer);
    this.ackTimer = null;
  }

  private patchStatus(patch: Partial<LessonCodeStatus>): void {
    this.status = { ...this.status, ...patch };
    this.emitStatus();
  }

  private emitStatus(): void {
    const status = this.getStatus();
    for (const listener of this.statusListeners) listener(status);
    if (this.isSynchronized()) {
      for (const waiter of this.synchronizationWaiters) {
        clearTimeout(waiter.timer);
        waiter.resolve();
      }
      this.synchronizationWaiters.clear();
    } else if (status.connection === "error") {
      this.rejectSynchronizationWaiters(
        status.error ?? "Lesson Code synchronization failed",
      );
    }
  }

  private emitAwareness(): void {
    const peers = this.getPeers();
    for (const listener of this.awarenessListeners) listener(peers);
  }

  private isSynchronized(): boolean {
    return this.status.connection === "online"
      && this.status.documentReady
      && this.status.durability === "ready"
      && this.pending.size === 0
      && this.queuedLocalWrites === 0
      && this.inFlight === null;
  }

  private rejectSynchronizationWaiters(message: string): void {
    for (const waiter of this.synchronizationWaiters) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error(message));
    }
    this.synchronizationWaiters.clear();
  }
}

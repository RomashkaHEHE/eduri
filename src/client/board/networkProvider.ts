import * as Y from "yjs";
import {
  Awareness,
  applyAwarenessUpdate,
  encodeAwarenessUpdate,
  removeAwarenessStates,
} from "y-protocols/awareness";
import {
  BOARD_CORE_SCHEMA_VERSION,
  applyBoardUpdate,
  encodeBoardStateVector,
  encodeBoardUpdate,
  mergeBoardUpdates,
  mergeBoardUpdatesBounded,
  stateVectorsEqual,
} from "../../board/core/index.js";
import type {
  BoardClientPersistence,
  BoardRecoveryReason,
  BoardRecoverySignal,
  PendingBoardUpdate,
} from "../../board/persistence/index.js";
import {
  BOARD_PROTOCOL_LIMITS,
  BOARD_SUBPROTOCOL,
  BoardCapability,
  BoardControlCode,
  BoardMessageType,
  BoardPermission,
  BoardProtocolError,
  decodeBoardProfileUpdatedPayload,
  decodeBoardFrame,
  encodeBoardProfileUpdatePayload,
  encodeBoardFrame,
  messageIdToHex,
  type AckFrame,
  type AwarenessFrame,
  type BoardFrame,
  type ChunkFrame,
  type ControlFrame,
  type ReadyFrame,
  type SyncStep1Frame,
} from "../../board/protocol/index.js";
import {
  normalizeCollaborationProfile,
  type CollaborationProfile,
} from "../../shared/collaborationProfile.js";
import {
  createBoardDocumentReplayOrigin,
  isBoardDocumentReplayOrigin,
} from "./documentStore.js";
import {
  BoardTicketRequestError,
  type BoardSyncScope,
  type BoardSyncTicket,
  type BoardTicketSource,
} from "./ticketSource.js";
import {
  MAX_BOARD_GESTURE_PREVIEW_POINTS,
  MAX_BOARD_LASER_POINTS,
  MAX_BOARD_LASER_STROKES,
  sanitizeBoardGesturePreviewStyle,
  type BoardGesturePreviewStyle,
  type BoardLaserClearMode,
  type BoardLaserStroke,
} from "./rendering/types.js";

export type BoardConnectionState =
  | "idle"
  | "loading-local"
  | "offline"
  | "connecting"
  | "authenticating"
  | "online"
  | "read-only"
  | "recovery-required"
  | "stopped";

export type BoardLocalDurability = "ready" | "writing" | "at-risk";

export interface BoardProviderStatus {
  readonly connection: BoardConnectionState;
  readonly localDurability: BoardLocalDurability;
  readonly pendingUpdateCount: number;
  readonly pendingUpdateBytes: number;
  readonly permissions: number;
  readonly lastDurableSequence: number | null;
  readonly recovery: BoardRecoverySignal | null;
  readonly lastError: string | null;
}

export interface BoardProviderTimers {
  now(): number;
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface BoardSocketMessageEvent {
  readonly data: unknown;
}

export interface BoardSocketCloseEvent {
  readonly code?: number;
  readonly reason?: string;
}

export interface BoardSocket {
  binaryType: string;
  readonly bufferedAmount?: number;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: BoardSocketMessageEvent) => void) | null;
  onclose: ((event: BoardSocketCloseEvent) => void) | null;
  onerror: ((event: unknown) => void) | null;
  send(data: Uint8Array): void;
  close(code?: number, reason?: string): void;
}

// Browser clients may initiate close with 1000 or private-use 3000-4999 only.
const BOARD_CLIENT_CLOSE_CODE = Object.freeze({
  invalidProtocolFrame: 4002,
  recoveryRequired: 4008,
  sendFailed: 4011,
});

export type BoardSocketFactory = (
  url: string,
  subprotocol: string,
) => BoardSocket;

export interface BoardPoint {
  readonly x: number;
  readonly y: number;
}

export interface BoardViewport extends BoardPoint {
  readonly zoom: number;
}

export interface BoardGesturePreview {
  readonly kind: string;
  readonly points?: readonly BoardPoint[];
  readonly style?: BoardGesturePreviewStyle;
  readonly strokes?: readonly BoardLaserStroke[];
  readonly streamId?: string;
  readonly pointOffset?: number;
  readonly offset?: BoardPoint;
  readonly sessionId?: string;
}

export interface BoardLocalPresence {
  readonly cursor?: BoardPoint | null;
  readonly selection?: readonly string[];
  readonly activeTool?: string | null;
  readonly laserPointer?: BoardPoint | null;
  readonly laserClearMode?: BoardLaserClearMode | null;
  readonly pageId?: string | null;
  readonly viewport?: BoardViewport | null;
  readonly gesturePreview?: BoardGesturePreview | null;
}

export interface BoardNetworkProviderOptions {
  readonly document: Y.Doc;
  readonly scope: BoardSyncScope;
  readonly localStore: BoardClientPersistence;
  readonly ticketSource: BoardTicketSource;
  readonly socketFactory: BoardSocketFactory;
  readonly timers?: BoardProviderTimers;
  readonly random?: () => number;
  readonly randomBytes?: (length: number) => Uint8Array;
  readonly awareness?: Awareness;
  readonly minSchemaVersion?: number;
  readonly maxSchemaVersion?: number;
  readonly capabilities?: number;
  readonly updateCoalesceMs?: number;
  readonly awarenessIntervalMs?: number;
  readonly ackRetryMs?: number;
  readonly reconnectBaseMs?: number;
  readonly reconnectMaxMs?: number;
  readonly onControl?: (frame: ControlFrame) => void;
}

interface ChunkAssembly {
  readonly innerType: BoardMessageType.SYNC_STEP2 | BoardMessageType.UPDATE;
  readonly chunkCount: number;
  readonly totalLength: number;
  readonly chunks: Array<Uint8Array | undefined>;
  receivedBytes: number;
}

interface ConnectionRef {
  readonly epoch: number;
  readonly socket: BoardSocket;
}

interface InitialSyncState {
  readonly connection: ConnectionRef;
  started: boolean;
  responsePending: boolean;
  restartRequested: boolean;
}

interface DeferredServerSync {
  readonly connection: ConnectionRef;
  readonly frame: SyncStep1Frame;
}

interface CausalGapRebase {
  readonly connection: ConnectionRef;
  readonly shadow: Y.Doc;
  readonly allowEmptyOutbox: boolean;
  phase: "collecting" | "preparing" | "persisting";
  cancelled: boolean;
}

interface InFlightBoardUpdate {
  readonly updateBytes: number;
  readonly sentAt: number;
}

interface InFlightProfileUpdate {
  readonly messageId: Uint8Array;
  readonly profile: CollaborationProfile;
}

const NETWORK_UPDATE_ORIGIN = Object.freeze({ type: "eduri.board.network" });
const NETWORK_AWARENESS_ORIGIN = Object.freeze({
  type: "eduri.board.network-awareness",
});
const OUTBOX_REPLAY_ORIGIN = Object.freeze({ type: "eduri.board.outbox-replay" });
const CAUSAL_REBASE_ORIGIN = Object.freeze({ type: "eduri.board.causal-rebase" });

const DEFAULT_CAPABILITIES =
  BoardCapability.CHUNKING |
  BoardCapability.AWARENESS |
  BoardCapability.RECOVERY_FORK |
  BoardCapability.PAGE_SHARDING |
  BoardCapability.PROFILE_UPDATE;
const MAX_CHUNK_ASSEMBLIES = 8;
export const MAX_BOARD_AWARENESS_SELECTION_IDS = 256;
const MAX_SERVER_RETRY_AFTER_MS = 24 * 60 * 60 * 1_000;
const OUTBOX_SEND_INTERVAL_MS = 10;
const OUTBOX_BUFFER_RETRY_MS = 25;
const MAX_OUTBOX_IN_FLIGHT_COUNT = 16;
const MAX_OUTBOX_IN_FLIGHT_BYTES = BOARD_PROTOCOL_LIMITS.maxUpdateBytes;
const MAX_OUTBOX_SOCKET_BUFFERED_BYTES = 4 * 1024 * 1024;
const LOCAL_PRESENCE_KEYS = new Set([
  "cursor",
  "selection",
  "activeTool",
  "laserPointer",
  "laserClearMode",
  "pageId",
  "viewport",
  "gesturePreview",
]);

class BoardUpdateLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BoardUpdateLimitError";
  }
}

function defaultRandomBytes(length: number): Uint8Array {
  const cryptoApi = globalThis.crypto;
  if (!cryptoApi?.getRandomValues) {
    throw new Error("Secure randomness is unavailable for Board message IDs");
  }
  return cryptoApi.getRandomValues(new Uint8Array(length));
}

const defaultTimers: BoardProviderTimers = {
  now: () => Date.now(),
  setTimeout: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
};

function clonePendingUpdate(update: PendingBoardUpdate): PendingBoardUpdate {
  return {
    messageId: update.messageId.slice(),
    generation: update.generation,
    documentKey: update.documentKey,
    update: update.update.slice(),
    createdAt: update.createdAt,
    ...(update.queueOrder === undefined
      ? {}
      : { queueOrder: update.queueOrder }),
  };
}

function comparePendingUpdates(
  left: PendingBoardUpdate,
  right: PendingBoardUpdate,
): number {
  const orderDifference =
    left.queueOrder !== undefined && right.queueOrder !== undefined
      ? left.queueOrder - right.queueOrder
      : 0;
  return orderDifference
    || left.createdAt - right.createdAt
    || messageIdToHex(left.messageId).localeCompare(
      messageIdToHex(right.messageId),
    );
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength &&
    left.every((byte, index) => byte === right[index]);
}

function profilesEqual(
  left: CollaborationProfile,
  right: CollaborationProfile,
): boolean {
  return left.displayName === right.displayName && left.color === right.color;
}

function hasBoardUpdateContent(update: Uint8Array): boolean {
  const decoded = Y.decodeUpdate(update);
  return decoded.structs.length > 0 || decoded.ds.clients.size > 0;
}

function boardDocumentHasUnresolvedDependencies(document: Y.Doc): boolean {
  return Boolean(document.store.pendingStructs || document.store.pendingDs);
}

function controlReason(frame: ControlFrame): string | null {
  try {
    const value = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(frame.payload),
    ) as unknown;
    if (
      typeof value === "object"
      && value !== null
      && "reason" in value
      && typeof value.reason === "string"
    ) {
      return value.reason;
    }
  } catch {
    // Unknown control payloads retain their ordinary protocol behavior.
  }
  return null;
}

function controlRetryAfterMs(frame: ControlFrame): number | null {
  try {
    const value = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(frame.payload),
    ) as unknown;
    if (
      typeof value !== "object"
      || value === null
      || !("retryable" in value)
      || value.retryable !== true
      || !("retryAfterMs" in value)
      || typeof value.retryAfterMs !== "number"
      || !Number.isSafeInteger(value.retryAfterMs)
      || value.retryAfterMs < 0
      || value.retryAfterMs > MAX_SERVER_RETRY_AFTER_MS
    ) {
      return null;
    }
    return value.retryAfterMs;
  } catch {
    return null;
  }
}

function binaryMessage(data: unknown): Uint8Array {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }
  throw new TypeError("Board WebSocket accepted a non-binary message");
}

function finitePoint(value: BoardPoint, field: string): BoardPoint {
  if (!Number.isFinite(value.x) || !Number.isFinite(value.y)) {
    throw new TypeError(`${field} coordinates must be finite`);
  }
  return { x: value.x, y: value.y };
}

function recoveryReasonForTicket(error: BoardTicketRequestError): BoardRecoveryReason {
  if (error.status === 401) return "session-revoked";
  if (error.status === 403) return "permission-revoked";
  if (error.status === 404 || error.status === 410) return "board-gone";
  return "lifecycle-revoked";
}

function sanitizeLocalPresence(
  state: Record<string, unknown> | null,
): Record<string, unknown> | null {
  if (state === null) return null;
  return Object.fromEntries(
    Object.entries(state).filter(([key]) => LOCAL_PRESENCE_KEYS.has(key)),
  );
}

export class BoardNetworkProvider {
  readonly document: Y.Doc;
  readonly scope: BoardSyncScope;
  readonly awareness: Awareness;

  private readonly localStore: BoardClientPersistence;
  private readonly ticketSource: BoardTicketSource;
  private readonly socketFactory: BoardSocketFactory;
  private readonly timers: BoardProviderTimers;
  private readonly random: () => number;
  private readonly randomBytes: (length: number) => Uint8Array;
  private readonly minSchemaVersion: number;
  private readonly maxSchemaVersion: number;
  private readonly requestedCapabilities: number;
  private readonly updateCoalesceMs: number;
  private readonly awarenessIntervalMs: number;
  private readonly ackRetryMs: number;
  private readonly reconnectBaseMs: number;
  private readonly reconnectMaxMs: number;
  private readonly onControl?: (frame: ControlFrame) => void;
  private readonly ownsAwareness: boolean;

  private readonly statusListeners = new Set<(status: BoardProviderStatus) => void>();
  private readonly pending = new Map<string, PendingBoardUpdate>();
  private readonly persistenceQueue: PendingBoardUpdate[] = [];
  private readonly localUpdateBatch: Uint8Array[] = [];
  private readonly chunkAssemblies = new Map<string, ChunkAssembly>();
  private readonly causalGapRetries = new Set<string>();
  private readonly inFlightUpdates = new Map<string, InFlightBoardUpdate>();

  private connection: BoardConnectionState = "idle";
  private localDurability: BoardLocalDurability = "ready";
  private permissions = 0;
  private lastDurableSequence: number | null = null;
  private recovery: BoardRecoverySignal | null = null;
  private lastError: string | null = null;
  private pendingProfile: CollaborationProfile | null = null;
  private profileUpdateInFlight: InFlightProfileUpdate | null = null;
  private negotiatedCapabilities = 0;
  private awarenessClientId: number | null = null;
  private awarenessDirty = false;
  private lastAwarenessSentAt = Number.NEGATIVE_INFINITY;
  private reconnectAttempt = 0;
  private connectionEpoch = 0;
  private localUpdateRevision = 0;
  private lastPendingCreatedAt = Number.NEGATIVE_INFINITY;
  private inFlightUpdateBytes = 0;
  private nextOutboxSendAt = Number.NEGATIVE_INFINITY;
  private serverRetryNotBefore = Number.NEGATIVE_INFINITY;
  private started = false;
  private stopping = false;
  private stopped = false;
  private ready = false;
  private documentSyncStarted = false;
  private persistenceDrain: Promise<void> | null = null;
  private initialSync: InitialSyncState | null = null;
  private deferredServerSync: DeferredServerSync | null = null;
  private causalGapRebase: CausalGapRebase | null = null;
  private causalGapRebaseTask: Promise<void> | null = null;
  private outboxReconcileTask: Promise<void> | null = null;
  private recoveryPersistenceTask: Promise<void> | null = null;
  private outboxReconcileRequested = false;
  private documentLogCursor = 0;
  private queuedOutboxRejection: ControlFrame | null = null;
  private unsubscribePendingChanges: (() => void) | null = null;
  private socket: BoardSocket | null = null;
  private startPromise: Promise<void> | null = null;
  private updateTimer: unknown = null;
  private awarenessTimer: unknown = null;
  private ackTimer: unknown = null;
  private reconnectTimer: unknown = null;
  private persistenceRetryTimer: unknown = null;
  private outboxPumpTimer: unknown = null;

  constructor(options: BoardNetworkProviderOptions) {
    if (!Number.isSafeInteger(options.scope.generation) || options.scope.generation < 1) {
      throw new TypeError("Board generation must be a positive safe integer");
    }
    if (!options.scope.boardId || !options.scope.documentKey) {
      throw new TypeError("Board scope is incomplete");
    }

    this.document = options.document;
    this.scope = Object.freeze({ ...options.scope });
    this.localStore = options.localStore;
    this.ticketSource = options.ticketSource;
    this.socketFactory = options.socketFactory;
    this.timers = options.timers ?? defaultTimers;
    this.random = options.random ?? Math.random;
    this.randomBytes = options.randomBytes ?? defaultRandomBytes;
    this.minSchemaVersion = options.minSchemaVersion ?? BOARD_CORE_SCHEMA_VERSION;
    this.maxSchemaVersion = options.maxSchemaVersion ?? BOARD_CORE_SCHEMA_VERSION;
    this.requestedCapabilities = options.capabilities ?? DEFAULT_CAPABILITIES;
    this.updateCoalesceMs = options.updateCoalesceMs ?? 16;
    this.awarenessIntervalMs = options.awarenessIntervalMs ?? 40;
    this.ackRetryMs = options.ackRetryMs ?? 5_000;
    this.reconnectBaseMs = options.reconnectBaseMs ?? 250;
    this.reconnectMaxMs = options.reconnectMaxMs ?? 15_000;
    this.onControl = options.onControl;
    this.ownsAwareness = options.awareness === undefined;
    this.awareness = options.awareness ?? new Awareness(this.document);

    if (
      !Number.isSafeInteger(this.minSchemaVersion) ||
      !Number.isSafeInteger(this.maxSchemaVersion) ||
      this.minSchemaVersion < 1 ||
      this.minSchemaVersion > this.maxSchemaVersion
    ) {
      throw new TypeError("Board schema range is invalid");
    }
    for (const [value, name] of [
      [this.updateCoalesceMs, "updateCoalesceMs"],
      [this.awarenessIntervalMs, "awarenessIntervalMs"],
      [this.ackRetryMs, "ackRetryMs"],
      [this.reconnectBaseMs, "reconnectBaseMs"],
      [this.reconnectMaxMs, "reconnectMaxMs"],
    ] as const) {
      if (!Number.isFinite(value) || value < 0) {
        throw new TypeError(`${name} must be a non-negative finite number`);
      }
    }
    this.unsubscribePendingChanges =
      this.localStore.subscribeLocalChanges?.(() => {
        this.requestOutboxReconciliation();
      }) ?? null;
  }

  get status(): BoardProviderStatus {
    return {
      connection: this.connection,
      localDurability: this.localDurability,
      pendingUpdateCount:
        this.pending.size + this.persistenceQueue.length + (this.localUpdateBatch.length ? 1 : 0),
      pendingUpdateBytes:
        [...this.pending.values(), ...this.persistenceQueue]
          .reduce((sum, update) => sum + update.update.byteLength, 0) +
        this.localUpdateBatch.reduce((sum, update) => sum + update.byteLength, 0),
      permissions: this.permissions,
      lastDurableSequence: this.lastDurableSequence,
      recovery: this.recovery,
      lastError: this.lastError,
    };
  }

  subscribe(listener: (status: BoardProviderStatus) => void): () => void {
    this.statusListeners.add(listener);
    listener(this.status);
    return () => this.statusListeners.delete(listener);
  }

  start(): Promise<void> {
    if (this.startPromise) return this.startPromise;
    if (this.stopped) throw new Error("A stopped Board provider cannot be restarted");
    this.startPromise = this.initialize();
    return this.startPromise;
  }

  /** Update presentation identity on the current socket without remounting state. */
  updateProfile(profile: CollaborationProfile): void {
    const normalized = normalizeCollaborationProfile(profile);
    if (
      this.pendingProfile
      && profilesEqual(this.pendingProfile, normalized)
    ) {
      return;
    }
    if (
      this.profileUpdateInFlight
      && profilesEqual(this.profileUpdateInFlight.profile, normalized)
    ) {
      this.pendingProfile = null;
      return;
    }
    this.pendingProfile = normalized;
    this.sendPendingProfileUpdate();
  }

  async stop(): Promise<void> {
    if (this.stopped || this.stopping) return;
    this.stopping = true;
    this.connectionEpoch += 1;
    this.initialSync = null;
    this.deferredServerSync = null;
    this.causalGapRetries.clear();
    this.abandonCausalGapRebase();
    this.cancelTimer("reconnect");
    this.cancelTimer("ack");
    this.cancelTimer("awareness");
    this.cancelTimer("persistence-retry");
    this.cancelTimer("outbox-pump");
    this.resetOutboxFlight();
    this.unsubscribePendingChanges?.();
    this.unsubscribePendingChanges = null;
    this.document.off("update", this.handleDocumentUpdate);
    this.flushLocalUpdateBatch();
    await this.awaitPersistenceBarrier();
    await this.causalGapRebaseTask;
    await this.outboxReconcileTask;
    await this.recoveryPersistenceTask;
    if (this.ready && this.awarenessClientId !== null) {
      this.awareness.setLocalState(null);
      this.awarenessDirty = true;
      this.flushAwareness();
    }
    this.awareness.off("update", this.handleAwarenessChange);
    this.stopped = true;
    this.stopping = false;
    this.socket?.close(1000, "Board provider stopped");
    this.socket = null;
    this.ready = false;
    this.connection = "stopped";
    this.emitStatus();
    if (this.ownsAwareness) {
      (this.awareness as Awareness & { destroy(): void }).destroy();
    }
  }

  setPresence(presence: BoardLocalPresence): void {
    const next: Record<string, unknown> = {};
    if (presence.cursor !== undefined) {
      next.cursor = presence.cursor === null ? null : finitePoint(presence.cursor, "cursor");
    }
    if (presence.selection !== undefined) {
      next.selection = [...new Set(presence.selection)]
        .sort()
        .slice(0, MAX_BOARD_AWARENESS_SELECTION_IDS);
    }
    if (presence.activeTool !== undefined) {
      if (
        presence.activeTool !== null &&
        (typeof presence.activeTool !== "string" || !presence.activeTool)
      ) {
        throw new TypeError("activeTool must be a non-empty string or null");
      }
      next.activeTool = presence.activeTool;
    }
    if (presence.laserPointer !== undefined) {
      next.laserPointer = presence.laserPointer === null
        ? null
        : finitePoint(presence.laserPointer, "laserPointer");
    }
    if (presence.laserClearMode !== undefined) {
      if (
        presence.laserClearMode !== null
        && presence.laserClearMode !== "fade"
        && presence.laserClearMode !== "immediate"
      ) {
        throw new TypeError(
          "laserClearMode must be fade, immediate, or null",
        );
      }
      next.laserClearMode = presence.laserClearMode;
    }
    if (presence.pageId !== undefined) {
      next.pageId = presence.pageId;
    }
    if (presence.viewport !== undefined) {
      if (presence.viewport === null) {
        next.viewport = null;
      } else {
        if (!Number.isFinite(presence.viewport.zoom) || presence.viewport.zoom <= 0) {
          throw new TypeError("viewport zoom must be positive and finite");
        }
        next.viewport = {
          ...finitePoint(presence.viewport, "viewport"),
          zoom: presence.viewport.zoom,
        };
      }
    }
    if (presence.gesturePreview !== undefined) {
      if (presence.gesturePreview === null) {
        next.gesturePreview = null;
      } else {
        if (!presence.gesturePreview.kind) {
          throw new TypeError("gesturePreview kind must not be empty");
        }
        if (
          presence.gesturePreview.kind === "laser"
          && presence.gesturePreview.strokes !== undefined
        ) {
          if (
            presence.gesturePreview.points !== undefined
            || presence.gesturePreview.style !== undefined
          ) {
            throw new TypeError(
              "segmented laser gesturePreview cannot include legacy points or style",
            );
          }
          if (presence.gesturePreview.strokes.length === 0) {
            throw new TypeError("laser gesturePreview must include at least one stroke");
          }
          if (presence.gesturePreview.strokes.length > MAX_BOARD_LASER_STROKES) {
            throw new RangeError(
              `laser gesturePreview is limited to ${MAX_BOARD_LASER_STROKES} strokes`,
            );
          }
          let totalPoints = 0;
          const strokes = presence.gesturePreview.strokes.map((stroke, index) => {
            if (
              stroke === null
              || typeof stroke !== "object"
              || Array.isArray(stroke)
              || !("points" in stroke)
              || !Array.isArray(stroke.points)
              || stroke.points.length === 0
            ) {
              throw new TypeError(`laser stroke ${index} must include at least one point`);
            }
            totalPoints += stroke.points.length;
            if (totalPoints > MAX_BOARD_LASER_POINTS) {
              throw new RangeError(
                `laser gesturePreview is limited to ${MAX_BOARD_LASER_POINTS} total points`,
              );
            }
            const style = stroke.style === undefined
              ? undefined
              : sanitizeBoardGesturePreviewStyle(stroke.style);
            if (stroke.style !== undefined && !style) {
              throw new TypeError(`laser stroke ${index} style is invalid`);
            }
            const streamId = stroke.streamId;
            if (
              streamId !== undefined
              && (
                typeof streamId !== "string"
                || streamId.length === 0
                || streamId.length > 96
              )
            ) {
              throw new TypeError(`laser stroke ${index} streamId is invalid`);
            }
            const pointOffset = stroke.pointOffset;
            if (
              pointOffset !== undefined
              && (!Number.isSafeInteger(pointOffset) || pointOffset < 0)
            ) {
              throw new TypeError(`laser stroke ${index} pointOffset is invalid`);
            }
            return {
              points: stroke.points.map((point) =>
                finitePoint(point, `laser stroke ${index}`)),
              ...(style ? { style } : {}),
              ...(streamId !== undefined ? { streamId } : {}),
              ...(pointOffset !== undefined ? { pointOffset } : {}),
            };
          });
          const sessionId = presence.gesturePreview.sessionId;
          if (
            sessionId !== undefined
            && (
              typeof sessionId !== "string"
              || sessionId.length === 0
              || sessionId.length > 96
            )
          ) {
            throw new TypeError("laser gesturePreview sessionId is invalid");
          }
          next.gesturePreview = {
            kind: "laser",
            strokes,
            ...(sessionId !== undefined ? { sessionId } : {}),
          };
        } else {
          const points = presence.gesturePreview.points;
          if (!points) {
            throw new TypeError("gesturePreview points are required");
          }
          if (points.length > MAX_BOARD_GESTURE_PREVIEW_POINTS) {
            throw new RangeError(
              `gesturePreview is limited to ${MAX_BOARD_GESTURE_PREVIEW_POINTS} points`,
            );
          }
          const style = presence.gesturePreview.style === undefined
            ? undefined
            : sanitizeBoardGesturePreviewStyle(presence.gesturePreview.style);
          if (presence.gesturePreview.style !== undefined && !style) {
            throw new TypeError("gesturePreview style is invalid");
          }
          const streamId = presence.gesturePreview.streamId;
          if (
            streamId !== undefined
            && (
              typeof streamId !== "string"
              || streamId.length === 0
              || streamId.length > 96
            )
          ) {
            throw new TypeError("gesturePreview streamId is invalid");
          }
          const pointOffset = presence.gesturePreview.pointOffset;
          if (
            pointOffset !== undefined
            && (!Number.isSafeInteger(pointOffset) || pointOffset < 0)
          ) {
            throw new TypeError("gesturePreview pointOffset is invalid");
          }
          const offset = presence.gesturePreview.offset === undefined
            ? undefined
            : finitePoint(presence.gesturePreview.offset, "gesturePreview offset");
          next.gesturePreview = {
            kind: presence.gesturePreview.kind,
            points: points.map((point) => finitePoint(point, "gesturePreview")),
            ...(style ? { style } : {}),
            ...(streamId !== undefined ? { streamId } : {}),
            ...(pointOffset !== undefined ? { pointOffset } : {}),
            ...(offset ? { offset } : {}),
          };
        }
      }
    }

    const current = sanitizeLocalPresence(this.awareness.getLocalState()) ?? {};
    const merged = { ...current, ...next };
    if (JSON.stringify(current) !== JSON.stringify(merged)) {
      this.awareness.setLocalState(merged);
    }
  }

  setSelection(objectIds: readonly string[]): void {
    const selection = [...new Set(objectIds)]
      .sort()
      .slice(0, MAX_BOARD_AWARENESS_SELECTION_IDS);
    const current = this.awareness.getLocalState()?.selection;
    if (
      Array.isArray(current) &&
      current.length === selection.length &&
      current.every((value, index) => value === selection[index])
    ) {
      return;
    }
    this.awareness.setLocalStateField("selection", selection);
  }

  private async initialize(): Promise<void> {
    this.connection = "loading-local";
    this.emitStatus();
    try {
      await this.localStore.whenReady;
      if (this.stopped || this.stopping) return;
      const [storedPending, recovery] = await Promise.all([
        this.localStore.listPendingUpdates(),
        this.localStore.getRecoverySignal(),
      ]);
      if (this.stopped || this.stopping) return;
      for (const stored of storedPending) {
        this.assertPendingScope(stored);
        const copy = clonePendingUpdate(stored);
        this.lastPendingCreatedAt = Math.max(
          this.lastPendingCreatedAt,
          copy.createdAt,
        );
        this.pending.set(messageIdToHex(copy.messageId), copy);
        applyBoardUpdate(this.document, copy.update, OUTBOX_REPLAY_ORIGIN);
      }
      if (
        recovery &&
        (
          recovery.generation !== this.scope.generation ||
          recovery.documentKey !== this.scope.documentKey
        )
      ) {
        this.started = true;
        this.localDurability = "at-risk";
        this.activateRecovery({
          reason: "generation-mismatch",
          generation: this.scope.generation,
          documentKey: this.scope.documentKey,
          occurredAt: this.timers.now(),
        }, "Stored Board recovery state belongs to another scope");
        this.requestOutboxReconciliation();
        return;
      }
      if (recovery) {
        this.started = true;
        this.activateRecovery(recovery, null);
        this.requestOutboxReconciliation();
        return;
      }
      this.document.on("update", this.handleDocumentUpdate);
      this.awareness.on("update", this.handleAwarenessChange);
      this.started = true;
      this.connection = "offline";
      this.emitStatus();
      this.requestOutboxReconciliation();
      void this.connect();
    } catch (error) {
      if (this.stopped || this.stopping) return;
      this.localDurability = "at-risk";
      this.lastError = error instanceof Error ? error.message : "Local Board storage failed";
      this.connection = "offline";
      this.emitStatus();
      this.schedulePersistenceInitializationRetry();
    }
  }

  private schedulePersistenceInitializationRetry(): void {
    if (this.stopped || this.stopping || this.persistenceRetryTimer !== null) return;
    this.persistenceRetryTimer = this.timers.setTimeout(() => {
      this.persistenceRetryTimer = null;
      if (!this.started && !this.stopped) {
        this.startPromise = this.initialize();
      }
    }, this.reconnectBaseMs);
  }

  private readonly handleDocumentUpdate = (
    update: Uint8Array,
    origin: unknown,
  ): void => {
    if (
      this.stopped ||
      origin === NETWORK_UPDATE_ORIGIN ||
      origin === OUTBOX_REPLAY_ORIGIN ||
      isBoardDocumentReplayOrigin(origin)
    ) {
      return;
    }
    this.localUpdateRevision += 1;
    this.localUpdateBatch.push(update.slice());
    this.localDurability = "writing";
    this.emitStatus();
    if (this.updateTimer === null) {
      this.updateTimer = this.timers.setTimeout(() => {
        this.updateTimer = null;
        this.flushLocalUpdateBatch();
      }, this.updateCoalesceMs);
    }
  };

  private flushLocalUpdateBatch(): void {
    if (this.updateTimer !== null) {
      this.timers.clearTimeout(this.updateTimer);
      this.updateTimer = null;
    }
    if (this.localUpdateBatch.length === 0) return;
    const updates = this.localUpdateBatch.splice(0);
    const segments = mergeBoardUpdatesBounded(
      updates,
      BOARD_PROTOCOL_LIMITS.maxUpdateBytes,
    );
    for (const segment of segments) {
      this.persistenceQueue.push({
        messageId: this.createUniqueMessageId(),
        generation: this.scope.generation,
        documentKey: this.scope.documentKey,
        update: segment,
        createdAt: this.nextPendingCreatedAt(),
      });
    }
    this.ensurePersistenceDrain();
    this.emitStatus();
  }

  private ensurePersistenceDrain(): Promise<void> {
    if (this.persistenceDrain) return this.persistenceDrain;
    this.persistenceDrain = this.drainPersistenceQueue().finally(() => {
      this.persistenceDrain = null;
    });
    return this.persistenceDrain;
  }

  private async drainPersistenceQueue(): Promise<void> {
    while (this.persistenceQueue.length > 0 && !this.stopped) {
      const next = this.persistenceQueue[0];
      try {
        const queueOrder =
          await this.localStore.enqueuePendingUpdate(next);
        if (
          queueOrder !== undefined
          && (!Number.isSafeInteger(queueOrder) || queueOrder < 1)
        ) {
          throw new Error("Local Board store returned an invalid outbox order");
        }
        this.persistenceQueue.shift();
        const durable = queueOrder === undefined
          ? next
          : { ...next, queueOrder };
        this.pending.set(messageIdToHex(durable.messageId), durable);
      } catch (error) {
        this.localDurability = "at-risk";
        this.lastError = error instanceof Error
          ? error.message
          : "Unable to persist a Board update";
        this.emitStatus();
        this.schedulePersistenceQueueRetry();
        return;
      }
      this.localDurability = this.persistenceQueue.length === 0 ? "ready" : "writing";
      this.lastError = null;
      this.pumpPendingUpdates();
      this.emitStatus();
    }
    if (this.persistenceQueue.length === 0 && this.localUpdateBatch.length === 0) {
      this.localDurability = "ready";
      this.flushDeferredSync();
      this.maybeStartInitialSync();
      this.emitStatus();
    }
  }

  private schedulePersistenceQueueRetry(): void {
    if (this.stopped || this.stopping || this.persistenceRetryTimer !== null) return;
    this.persistenceRetryTimer = this.timers.setTimeout(() => {
      this.persistenceRetryTimer = null;
      void this.ensurePersistenceDrain();
    }, this.reconnectBaseMs);
  }

  private async awaitPersistenceBarrier(): Promise<boolean> {
    while (!this.stopped || this.localUpdateBatch.length > 0) {
      this.flushLocalUpdateBatch();
      await this.ensurePersistenceDrain();
      if (this.persistenceQueue.length > 0) return false;
      if (this.localUpdateBatch.length === 0) return true;
    }
    return this.persistenceQueue.length === 0;
  }

  private async awaitOutboxReconciliationBarrier(): Promise<void> {
    while (!this.stopped && !this.stopping) {
      const task = this.outboxReconcileTask;
      if (task) {
        await task;
        continue;
      }
      if (this.outboxReconcileRequested || this.queuedOutboxRejection) {
        this.requestOutboxReconciliation();
        continue;
      }
      return;
    }
  }

  private async connect(): Promise<void> {
    if (
      this.stopped ||
      this.stopping ||
      this.recovery ||
      this.socket !== null ||
      this.connection === "connecting"
    ) {
      return;
    }
    this.cancelTimer("reconnect");
    this.connection = "connecting";
    this.emitStatus();
    const epoch = ++this.connectionEpoch;
    let ticket: BoardSyncTicket;
    try {
      ticket = await this.ticketSource();
    } catch (error) {
      if (epoch !== this.connectionEpoch || this.stopped || this.stopping) return;
      if (error instanceof BoardTicketRequestError && error.terminal) {
        this.enterRecovery(recoveryReasonForTicket(error));
        return;
      }
      this.lastError = error instanceof Error ? error.message : "Board ticket request failed";
      this.connection = "offline";
      this.emitStatus();
      this.scheduleReconnect();
      return;
    }
    if (
      epoch !== this.connectionEpoch ||
      this.stopped ||
      this.stopping ||
      this.recovery
    ) return;

    let socket: BoardSocket;
    try {
      socket = this.socketFactory(ticket.socketUrl, BOARD_SUBPROTOCOL);
    } catch (error) {
      this.lastError = error instanceof Error
        ? error.message
        : "Unable to create Board WebSocket";
      this.connection = "offline";
      this.emitStatus();
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;
    this.documentSyncStarted = false;
    const connection: ConnectionRef = { epoch, socket };
    this.initialSync = null;
    this.deferredServerSync = null;
    socket.binaryType = "arraybuffer";
    socket.onopen = () => {
      if (this.socket !== socket || this.stopped || this.stopping) return;
      this.documentSyncStarted = false;
      this.connection = "authenticating";
      this.emitStatus();
      try {
        this.sendFrame({
          type: BoardMessageType.AUTH,
          ticket: ticket.ticket,
          generation: this.scope.generation,
          minSchemaVersion: this.minSchemaVersion,
          maxSchemaVersion: this.maxSchemaVersion,
          capabilities: this.requestedCapabilities,
        });
      } catch (error) {
        this.failSocket(error);
      }
    };
    socket.onmessage = (event) => {
      if (this.socket !== socket || this.stopped || this.stopping) return;
      try {
        this.handleFrame(decodeBoardFrame(binaryMessage(event.data)), connection);
      } catch (error) {
        this.lastError = error instanceof Error ? error.message : "Invalid Board frame";
        socket.close(
          BOARD_CLIENT_CLOSE_CODE.invalidProtocolFrame,
          "Invalid Board protocol frame",
        );
      }
    };
    socket.onerror = () => {
      if (this.socket === socket) {
        this.lastError = "Board WebSocket error";
        this.emitStatus();
      }
    };
    socket.onclose = (event) => {
      if (this.socket !== socket) return;
      this.resetConnectionState();
      if (this.stopped || this.recovery) return;
      this.lastError = event.reason || this.lastError;
      this.connection = "offline";
      this.emitStatus();
      this.scheduleReconnect();
    };
  }

  private scheduleReconnect(): void {
    if (
      this.stopped ||
      this.stopping ||
      this.recovery ||
      this.reconnectTimer !== null
    ) return;
    const exponential = Math.min(
      this.reconnectMaxMs,
      this.reconnectBaseMs * 2 ** Math.min(this.reconnectAttempt, 16),
    );
    const jitter = 0.75 + Math.max(0, Math.min(1, this.random())) * 0.5;
    const delay = Math.max(
      Math.round(exponential * jitter),
      this.serverRetryDelayMs(),
    );
    this.reconnectAttempt += 1;
    this.reconnectTimer = this.timers.setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect();
    }, delay);
  }

  private handleFrame(frame: BoardFrame, connection: ConnectionRef): void {
    if (frame.type === BoardMessageType.CHUNK) {
      this.handleChunk(frame, connection);
      return;
    }
    if (frame.type === BoardMessageType.READY) {
      this.handleReady(frame, connection);
      return;
    }
    if (!this.ready) throw new Error("Board server sent data before READY");
    if ("generation" in frame && frame.generation !== this.scope.generation) {
      this.enterRecovery("generation-mismatch", undefined, frame.generation);
      return;
    }

    switch (frame.type) {
      case BoardMessageType.SYNC_STEP1:
        this.assertDocumentKey(frame.docKey);
        void this.respondToSyncStep1(frame, connection);
        break;
      case BoardMessageType.SYNC_STEP2:
        this.assertDocumentKey(frame.docKey);
        this.applyNetworkUpdate(frame.update, connection);
        break;
      case BoardMessageType.UPDATE:
        this.assertDocumentKey(frame.docKey);
        // Applying a CRDT update changes data only. It never invokes code runners.
        this.applyNetworkUpdate(frame.update, connection);
        break;
      case BoardMessageType.ACK:
        this.assertDocumentKey(frame.docKey);
        void this.handleAck(frame);
        break;
      case BoardMessageType.AWARENESS:
        this.assertDocumentKey(frame.docKey);
        applyAwarenessUpdate(this.awareness, frame.update, NETWORK_AWARENESS_ORIGIN);
        break;
      case BoardMessageType.CONTROL:
        if (frame.code === BoardControlCode.PROFILE_UPDATED) {
          this.handleProfileUpdated(frame);
        } else {
          this.handleControl(frame, connection);
        }
        break;
      case BoardMessageType.AUTH:
        throw new Error(`Unexpected Board frame ${frame.type}`);
      default: {
        const neverFrame: never = frame;
        throw new Error(`Unsupported Board frame ${String(neverFrame)}`);
      }
    }
  }

  private handleReady(frame: ReadyFrame, connection: ConnectionRef): void {
    if (!this.isCurrentConnection(connection)) return;
    if (frame.generation !== this.scope.generation) {
      this.enterRecovery("generation-mismatch", undefined, frame.generation);
      return;
    }
    if (
      frame.schemaVersion < this.minSchemaVersion ||
      frame.schemaVersion > this.maxSchemaVersion
    ) {
      throw new Error(`Server selected unsupported Board schema ${frame.schemaVersion}`);
    }
    if ((frame.capabilities & ~this.requestedCapabilities) !== 0) {
      throw new Error("Server selected Board capabilities the client did not request");
    }
    this.ready = true;
    this.reconnectAttempt = 0;
    this.lastError = null;
    this.permissions = frame.permissions;
    this.negotiatedCapabilities = frame.capabilities;
    this.adoptAwarenessClientId(frame.awarenessClientId);
    this.connection = (frame.permissions & BoardPermission.EDIT) !== 0
      ? "online"
      : "read-only";
    this.initialSync = {
      connection,
      started: false,
      responsePending: false,
      restartRequested: false,
    };
    this.deferredServerSync = null;
    this.emitStatus();
    this.sendPendingProfileUpdate();
    this.flushLocalUpdateBatch();
    if (
      (frame.permissions & BoardPermission.EDIT) === 0 &&
      this.hasPendingLocalWork()
    ) {
      this.enterRecovery("permission-revoked");
      return;
    }
    this.requestOutboxReconciliation();
    this.pumpPendingUpdates();
    this.maybeStartInitialSync();
  }

  private sendPendingProfileUpdate(): void {
    if (
      !this.pendingProfile
      || this.profileUpdateInFlight
      || !this.ready
      || !this.socket
      || this.stopped
      || this.stopping
      || this.recovery
    ) {
      return;
    }
    if (
      (this.negotiatedCapabilities & BoardCapability.PROFILE_UPDATE) === 0
    ) {
      this.pendingProfile = null;
      this.lastError = "Board server does not support live profile updates";
      this.emitStatus();
      return;
    }

    const profile = this.pendingProfile;
    const messageId = this.createUniqueMessageId();
    this.pendingProfile = null;
    this.profileUpdateInFlight = { messageId, profile };
    try {
      this.sendFrame({
        type: BoardMessageType.CONTROL,
        generation: this.scope.generation,
        code: BoardControlCode.PROFILE_UPDATE,
        messageId,
        payload: encodeBoardProfileUpdatePayload(profile),
      });
    } catch (error) {
      this.pendingProfile = profile;
      this.profileUpdateInFlight = null;
      this.failSocket(error);
    }
  }

  private handleProfileUpdated(frame: ControlFrame): void {
    const inFlight = this.profileUpdateInFlight;
    if (
      !inFlight
      || !frame.messageId
      || frame.docKey !== undefined
      || !bytesEqual(frame.messageId, inFlight.messageId)
    ) {
      throw new Error("Board server sent an uncorrelated profile result");
    }

    const result = decodeBoardProfileUpdatedPayload(frame.payload);
    this.profileUpdateInFlight = null;
    if (result.accepted) {
      if (!profilesEqual(result.profile, inFlight.profile)) {
        throw new Error("Board server acknowledged a different profile");
      }
      this.republishLocalAwarenessAfterProfileUpdate();
      if (this.lastError?.startsWith("Profile update")) {
        this.lastError = null;
        this.emitStatus();
      }
    } else {
      this.lastError = `Profile update rejected: ${result.error}`;
      this.emitStatus();
    }
    this.sendPendingProfileUpdate();
  }

  private republishLocalAwarenessAfterProfileUpdate(): void {
    const current = sanitizeLocalPresence(this.awareness.getLocalState());
    this.awareness.setLocalState(current);
    if (this.awarenessTimer !== null) {
      this.timers.clearTimeout(this.awarenessTimer);
      this.awarenessTimer = null;
    }
    this.awarenessDirty = true;
    this.flushAwareness();
  }

  private maybeStartInitialSync(): void {
    const initialSync = this.initialSync;
    if (
      !initialSync ||
      initialSync.started ||
      this.stopped ||
      this.stopping ||
      !this.ready ||
      this.recovery ||
      this.causalGapRebase !== null ||
      !this.isCurrentConnection(initialSync.connection) ||
      this.hasPendingLocalWork()
    ) {
      return;
    }
    try {
      if (!this.sendDocumentSyncStep1({
        type: BoardMessageType.SYNC_STEP1,
        generation: this.scope.generation,
        docKey: this.scope.documentKey,
        stateVector: encodeBoardStateVector(this.document),
      }, initialSync.connection)) return;
      initialSync.started = true;
      initialSync.responsePending = true;
    } catch (error) {
      this.failSocket(error);
    }
  }

  private completeInitialSyncResponse(connection: ConnectionRef): void {
    const initialSync = this.initialSync;
    if (
      !initialSync
      || !this.isCurrentConnection(connection)
      || initialSync.connection !== connection
    ) {
      return;
    }
    initialSync.responsePending = false;
    if (!initialSync.restartRequested) return;
    initialSync.restartRequested = false;
    initialSync.started = false;
    this.maybeStartInitialSync();
  }

  private hasPendingLocalWork(): boolean {
    return (
      this.localUpdateBatch.length > 0 ||
      this.persistenceQueue.length > 0 ||
      this.pending.size > 0 ||
      this.outboxReconcileTask !== null
    );
  }

  private async respondToSyncStep1(
    frame: SyncStep1Frame,
    connection: ConnectionRef,
  ): Promise<void> {
    if (!this.isCurrentConnection(connection)) return;
    const causalRebase = this.causalGapRebase;
    if (
      causalRebase
      && causalRebase.connection === connection
      && causalRebase.phase === "collecting"
    ) {
      const task = this.completeCausalGapRebase(
        causalRebase,
        frame,
        connection,
      );
      this.causalGapRebaseTask = task;
      try {
        await task;
      } finally {
        if (this.causalGapRebaseTask === task) {
          this.causalGapRebaseTask = null;
        }
      }
      return;
    }
    const persisted = await this.awaitPersistenceBarrier();
    await this.awaitOutboxReconciliationBarrier();
    if (!this.isCurrentConnection(connection)) return;
    if (!persisted || !this.ready || this.recovery) {
      if (this.ready && !this.recovery) {
        this.deferredServerSync = {
          connection,
          frame: {
            ...frame,
            stateVector: frame.stateVector.slice(),
          },
        };
      }
      return;
    }
    try {
      const update = encodeBoardUpdate(this.document, frame.stateVector);
      if (!hasBoardUpdateContent(update)) {
        this.completeInitialSyncResponse(connection);
        return;
      }
      if ((this.permissions & BoardPermission.EDIT) === 0) {
        this.enterRecovery("permission-revoked");
        return;
      }
      if (update.byteLength > BOARD_PROTOCOL_LIMITS.maxUpdateBytes) {
        const initialSync = this.initialSync;
        if (initialSync && this.isCurrentConnection(initialSync.connection)) {
          initialSync.started = false;
          initialSync.responsePending = false;
          initialSync.restartRequested = false;
        }
        this.startCausalGapRebase(connection, true);
        return;
      }
      this.sendFrame({
        type: BoardMessageType.SYNC_STEP2,
        generation: this.scope.generation,
        docKey: this.scope.documentKey,
        update,
      });
      this.completeInitialSyncResponse(connection);
    } catch (error) {
      if (error instanceof BoardProtocolError || error instanceof BoardUpdateLimitError) {
        this.enterRecovery("update-too-large");
      } else {
        this.failSocket(error);
      }
    }
  }

  private flushDeferredSync(): void {
    const deferred = this.deferredServerSync;
    if (!deferred) return;
    if (!this.isCurrentConnection(deferred.connection)) {
      this.deferredServerSync = null;
      return;
    }
    if (!this.ready || this.recovery) return;
    this.deferredServerSync = null;
    void this.respondToSyncStep1(deferred.frame, deferred.connection);
  }

  private async handleAck(frame: AckFrame): Promise<void> {
    const key = messageIdToHex(frame.messageId);
    if (!this.pending.has(key)) return;
    try {
      await this.localStore.acknowledgePendingUpdate(
        frame.messageId,
        frame.durableSequence,
      );
    } catch (error) {
      this.localDurability = "at-risk";
      this.lastError = error instanceof Error
        ? error.message
        : "Unable to persist a Board ACK";
      this.emitStatus();
      this.scheduleAckRetry();
      return;
    }
    this.pending.delete(key);
    this.removeInFlightUpdate(key);
    this.lastDurableSequence = Math.max(
      this.lastDurableSequence ?? 0,
      frame.durableSequence,
    );
    this.localDurability = this.persistenceQueue.length ? "writing" : "ready";
    this.lastError = null;
    this.emitStatus();
    this.maybeStartInitialSync();
    this.retryCausalGapUpdates();
    this.pumpPendingUpdates();
    this.scheduleAckRetry();
  }

  private handleControl(
    frame: ControlFrame,
    connection: ConnectionRef,
  ): void {
    if (frame.docKey !== undefined) this.assertDocumentKey(frame.docKey);
    this.onControl?.(frame);
    switch (frame.code) {
      case BoardControlCode.BOARD_GONE:
        this.enterRecovery("board-gone", frame);
        break;
      case BoardControlCode.SESSION_REVOKED:
        this.enterRecovery("session-revoked", frame);
        break;
      case BoardControlCode.LIFECYCLE_CHANGED:
        this.enterRecovery("lifecycle-revoked", frame);
        break;
      case BoardControlCode.PERMISSION_CHANGED:
        if (this.pending.size > 0 || this.persistenceQueue.length > 0) {
          this.enterRecovery("permission-revoked", frame);
        } else {
          this.permissions &= ~BoardPermission.EDIT;
          this.connection = "read-only";
          this.emitStatus();
        }
        break;
      case BoardControlCode.UPDATE_REJECTED:
        if (frame.messageId && this.pending.has(messageIdToHex(frame.messageId))) {
          this.requestOutboxReconciliation(frame);
        } else {
          this.enterRecovery("update-rejected", frame);
        }
        break;
      case BoardControlCode.RESYNC_REQUIRED:
        if (frame.messageId) {
          const reason = controlReason(frame);
          const key = messageIdToHex(frame.messageId);
          if (this.pending.has(key)) {
            if (reason === "NO_NEW_INFORMATION") {
              this.startCausalGapRebase(connection);
              break;
            }
            if (reason === "CAUSAL_GAP") {
              this.removeInFlightUpdate(key);
              this.causalGapRetries.add(key);
              if (this.hasEarlierPendingUpdate(key)) {
                this.scheduleAckRetry();
              } else {
                this.causalGapRetries.delete(key);
                this.startCausalGapRebase(connection);
              }
              break;
            }
          }
        }
        this.sendDocumentSyncStep1({
          type: BoardMessageType.SYNC_STEP1,
          generation: this.scope.generation,
          docKey: this.scope.documentKey,
          stateVector: encodeBoardStateVector(this.document),
        }, connection);
        break;
      case BoardControlCode.RATE_LIMITED:
      case BoardControlCode.STORAGE_ERROR:
      case BoardControlCode.SERVER_ERROR:
        this.applyServerRetryAfter(frame);
        this.lastError = `Board server control ${frame.code}`;
        this.emitStatus();
        this.scheduleAckRetry();
        this.pumpPendingUpdates();
        break;
      case BoardControlCode.ASSET_READY:
        break;
      case BoardControlCode.PROFILE_UPDATE:
      case BoardControlCode.PROFILE_UPDATED:
        throw new Error(`Unexpected Board profile control ${frame.code}`);
      default: {
        const neverCode: never = frame.code;
        throw new Error(`Unsupported Board control ${String(neverCode)}`);
      }
    }
  }

  private enterRecovery(
    reason: BoardRecoveryReason,
    control?: ControlFrame,
    actualGeneration = this.scope.generation,
  ): void {
    if (this.recovery) return;
    const signal: BoardRecoverySignal = {
      reason,
      generation: this.scope.generation,
      documentKey: this.scope.documentKey,
      occurredAt: this.timers.now(),
      controlCode: control?.code,
      messageId: control?.messageId?.slice(),
      payload: control?.payload.slice(),
    };
    this.activateRecovery(
      signal,
      actualGeneration === this.scope.generation
        ? null
        : `Board generation changed to ${actualGeneration}`,
    );
    const persistence = this.localStore.setRecoverySignal(signal).catch((error) => {
      this.localDurability = "at-risk";
      this.lastError = error instanceof Error
        ? error.message
        : "Unable to persist Board recovery state";
      this.emitStatus();
    });
    this.recoveryPersistenceTask = persistence;
    void persistence.finally(() => {
      if (this.recoveryPersistenceTask === persistence) {
        this.recoveryPersistenceTask = null;
      }
    });
  }

  private activateRecovery(
    signal: BoardRecoverySignal,
    lastError: string | null,
  ): void {
    const alreadyActive = this.recovery !== null;
    this.recovery = {
      ...signal,
      messageId: signal.messageId?.slice(),
      payload: signal.payload?.slice(),
    };
    this.connection = "recovery-required";
    this.lastError = lastError;
    if (alreadyActive) {
      this.emitStatus();
      return;
    }
    this.cancelTimer("reconnect");
    this.cancelTimer("ack");
    this.cancelTimer("outbox-pump");
    this.resetOutboxFlight();
    this.initialSync = null;
    this.deferredServerSync = null;
    this.causalGapRetries.clear();
    this.abandonCausalGapRebase();
    this.socket?.close(
      BOARD_CLIENT_CLOSE_CODE.recoveryRequired,
      "Board recovery fork required",
    );
    this.emitStatus();
  }

  private applyNetworkUpdate(
    update: Uint8Array,
    connection: ConnectionRef,
  ): void {
    const causalRebase = this.causalGapRebase;
    if (
      causalRebase
      && causalRebase.connection === connection
      && (causalRebase.phase === "collecting"
        || causalRebase.phase === "preparing")
    ) {
      applyBoardUpdate(causalRebase.shadow, update, NETWORK_UPDATE_ORIGIN);
    }
    applyBoardUpdate(this.document, update, NETWORK_UPDATE_ORIGIN);
  }

  private requestOutboxReconciliation(frame?: ControlFrame): void {
    if (frame) this.queuedOutboxRejection ??= frame;
    if (!this.started) {
      this.outboxReconcileRequested = true;
      return;
    }
    if (
      this.outboxReconcileTask
      || this.stopped
      || this.stopping
    ) {
      if (this.outboxReconcileTask) this.outboxReconcileRequested = true;
      return;
    }
    const rejection = this.queuedOutboxRejection;
    this.queuedOutboxRejection = null;
    this.outboxReconcileRequested = false;
    const rejectedKey = rejection?.messageId
      ? messageIdToHex(rejection.messageId)
      : null;
    const rejected = rejectedKey ? this.pending.get(rejectedKey) : null;
    if (rejection && (!rejectedKey || !rejected)) {
      this.enterRecovery("update-rejected", rejection);
      return;
    }
    const baselineKeys = new Set(this.pending.keys());
    const operation = (async () => {
      const documentCursor = this.documentLogCursor;
      const documentRead = this.localStore.listDocumentUpdatesAfter
        ? this.localStore.listDocumentUpdatesAfter(documentCursor)
        : this.localStore.listDocumentUpdates().then((updates) => ({
            updates,
            cursor: documentCursor,
          }));
      const [stored, documentBatch, storedRecovery] = await Promise.all([
        this.localStore.listPendingUpdates(),
        documentRead,
        this.localStore.getRecoverySignal(),
      ]);
      if (this.stopped || this.stopping) return;
      const invalidRecoveryScope =
        storedRecovery !== null
        && (
          storedRecovery.generation !== this.scope.generation
          || storedRecovery.documentKey !== this.scope.documentKey
        );
      if (
        !Number.isSafeInteger(documentBatch.cursor)
        || documentBatch.cursor < documentCursor
      ) {
        throw new Error("Local Board document cursor moved backwards");
      }
      const authoritative = new Map<string, PendingBoardUpdate>();
      for (const update of stored) {
        this.assertPendingScope(update);
        const copy = clonePendingUpdate(update);
        authoritative.set(messageIdToHex(copy.messageId), copy);
      }
      const currentRejected = rejectedKey
        ? authoritative.get(rejectedKey)
        : undefined;
      if (
        !this.recovery
        && !storedRecovery
        && rejection
        && rejected
        && currentRejected
        && currentRejected.generation === rejected.generation
        && currentRejected.documentKey === rejected.documentKey
        && currentRejected.createdAt === rejected.createdAt
        && currentRejected.queueOrder === rejected.queueOrder
        && bytesEqual(currentRejected.update, rejected.update)
      ) {
        this.enterRecovery("update-rejected", rejection);
        return;
      }

      let adoptedDocumentHistory = false;
      const observeDocumentReplay = (
        _update: Uint8Array,
        origin: unknown,
      ): void => {
        if (isBoardDocumentReplayOrigin(origin)) {
          adoptedDocumentHistory = true;
        }
      };
      this.document.on("update", observeDocumentReplay);
      try {
        for (const update of documentBatch.updates) {
          applyBoardUpdate(
            this.document,
            update,
            createBoardDocumentReplayOrigin(this.document),
          );
        }
      } finally {
        this.document.off("update", observeDocumentReplay);
      }
      this.documentLogCursor = documentBatch.cursor;
      if (adoptedDocumentHistory) {
        const initialSync = this.initialSync;
        if (
          initialSync
          && this.isCurrentConnection(initialSync.connection)
        ) {
          if (initialSync.responsePending) {
            initialSync.restartRequested = true;
          } else {
            initialSync.started = false;
          }
        }
      }

      for (const key of baselineKeys) {
        if (!authoritative.has(key)) {
          this.pending.delete(key);
          this.causalGapRetries.delete(key);
        }
      }
      for (const [key, update] of authoritative) {
        this.lastPendingCreatedAt = Math.max(
          this.lastPendingCreatedAt,
          update.createdAt,
        );
        this.pending.set(key, update);
        applyBoardUpdate(this.document, update.update, OUTBOX_REPLAY_ORIGIN);
      }
      this.pruneInFlightUpdates();
      if (invalidRecoveryScope) {
        this.localDurability = "at-risk";
        this.activateRecovery({
          reason: "generation-mismatch",
          generation: this.scope.generation,
          documentKey: this.scope.documentKey,
          occurredAt: this.timers.now(),
        }, "Stored Board recovery state belongs to another scope");
        return;
      }
      if (storedRecovery) {
        this.activateRecovery(storedRecovery, null);
        return;
      }
      this.lastError = null;
      this.emitStatus();
    })();
    const task = operation.catch((error) => {
      this.localDurability = "at-risk";
      this.lastError = error instanceof Error
        ? error.message
        : "Unable to reconcile the local Board store";
      this.emitStatus();
      if (rejection) {
        this.enterRecovery("update-rejected", rejection);
      } else {
        this.failSocket(error);
      }
    });
    this.outboxReconcileTask = task;
    void task.finally(() => {
      if (this.outboxReconcileTask !== task) return;
      this.outboxReconcileTask = null;
      if (
        (this.outboxReconcileRequested || this.queuedOutboxRejection)
        && !this.stopped
        && !this.stopping
      ) {
        this.requestOutboxReconciliation();
        return;
      }
      this.pumpPendingUpdates();
      this.maybeStartInitialSync();
      this.emitStatus();
    });
  }

  private startCausalGapRebase(
    connection: ConnectionRef,
    allowEmptyOutbox = false,
  ): void {
    if (
      this.causalGapRebase
      || !this.ready
      || this.recovery
      || !this.isCurrentConnection(connection)
    ) {
      return;
    }
    const shadow = new Y.Doc();
    const rebase: CausalGapRebase = {
      connection,
      shadow,
      allowEmptyOutbox,
      phase: "collecting",
      cancelled: false,
    };
    this.causalGapRebase = rebase;
    this.cancelTimer("ack");
    this.cancelTimer("outbox-pump");
    this.resetOutboxFlight();
    try {
      // An empty vector makes the server replay its complete durable state.
      this.sendDocumentSyncStep1({
        type: BoardMessageType.SYNC_STEP1,
        generation: this.scope.generation,
        docKey: this.scope.documentKey,
        stateVector: encodeBoardStateVector(shadow),
      }, connection);
    } catch (error) {
      this.clearCausalGapRebase(rebase);
      this.failSocket(error);
    }
  }

  private async completeCausalGapRebase(
    rebase: CausalGapRebase,
    frame: SyncStep1Frame,
    connection: ConnectionRef,
  ): Promise<void> {
    rebase.phase = "preparing";
    if (
      !stateVectorsEqual(
        encodeBoardStateVector(rebase.shadow),
        frame.stateVector,
      )
    ) {
      this.clearCausalGapRebase(rebase);
      this.failSocket(
        new Error("Full Board replay does not match the server state vector"),
      );
      return;
    }

    const persisted = await this.awaitPersistenceBarrier();
    if (
      !persisted
      || rebase.cancelled
      || this.stopped
      || this.recovery
      || !this.isCurrentConnection(connection)
      || this.causalGapRebase !== rebase
    ) {
      this.clearCausalGapRebase(rebase);
      this.pumpPendingUpdates();
      this.maybeStartInitialSync();
      this.scheduleAckRetry();
      return;
    }

    const localUpdateRevision = this.localUpdateRevision;
    const pendingBaselineKeys = new Set(this.pending.keys());
    let covered: readonly PendingBoardUpdate[];
    let documentUpdates: readonly Uint8Array[];
    try {
      [covered, documentUpdates] = await Promise.all([
        this.localStore.listPendingUpdates(),
        this.localStore.listDocumentUpdates(),
      ]);
      covered = covered
        .map(clonePendingUpdate)
        .sort(comparePendingUpdates);
    } catch (error) {
      this.localDurability = "at-risk";
      this.lastError = error instanceof Error
        ? error.message
        : "Unable to snapshot the local Board outbox";
      this.emitStatus();
      this.clearCausalGapRebase(rebase);
      this.failSocket(error);
      return;
    }
    if (
      localUpdateRevision !== this.localUpdateRevision
      || rebase.cancelled
      || this.stopped
      || this.recovery
      || !this.isCurrentConnection(connection)
      || this.causalGapRebase !== rebase
    ) {
      this.clearCausalGapRebase(rebase);
      this.pumpPendingUpdates();
      this.maybeStartInitialSync();
      this.scheduleAckRetry();
      return;
    }
    for (const update of covered) this.assertPendingScope(update);
    if (covered.length === 0 && !rebase.allowEmptyOutbox) {
      this.clearCausalGapRebase(rebase);
      this.pumpPendingUpdates();
      this.maybeStartInitialSync();
      return;
    }

    const boundedDeltas: Uint8Array[] = [];
    let indivisibleUpdateTooLarge = false;
    const collectDelta = (
      update: Uint8Array,
      origin: unknown,
    ): void => {
      if (
        origin !== CAUSAL_REBASE_ORIGIN
        || !hasBoardUpdateContent(update)
      ) {
        return;
      }
      if (update.byteLength > BOARD_PROTOCOL_LIMITS.maxUpdateBytes) {
        indivisibleUpdateTooLarge = true;
        return;
      }
      const previous = boundedDeltas.at(-1);
      if (previous) {
        const merged = mergeBoardUpdates([previous, update]);
        if (merged.byteLength <= BOARD_PROTOCOL_LIMITS.maxUpdateBytes) {
          boundedDeltas[boundedDeltas.length - 1] = merged;
          return;
        }
      }
      boundedDeltas.push(update.slice());
    };
    rebase.shadow.on("update", collectDelta);
    try {
      for (const update of documentUpdates) {
        applyBoardUpdate(rebase.shadow, update, CAUSAL_REBASE_ORIGIN);
      }
      for (const update of covered) {
        applyBoardUpdate(rebase.shadow, update.update, CAUSAL_REBASE_ORIGIN);
      }
    } catch (error) {
      this.clearCausalGapRebase(rebase);
      this.failSocket(error);
      return;
    } finally {
      rebase.shadow.off("update", collectDelta);
    }

    if (
      localUpdateRevision !== this.localUpdateRevision
      || rebase.cancelled
      || this.stopped
      || this.recovery
      || !this.isCurrentConnection(connection)
      || this.causalGapRebase !== rebase
    ) {
      this.clearCausalGapRebase(rebase);
      this.pumpPendingUpdates();
      this.maybeStartInitialSync();
      this.scheduleAckRetry();
      return;
    }
    if (boardDocumentHasUnresolvedDependencies(rebase.shadow)) {
      this.clearCausalGapRebase(rebase);
      this.enterRecovery("update-rejected");
      return;
    }
    if (indivisibleUpdateTooLarge) {
      this.clearCausalGapRebase(rebase);
      this.enterRecovery("update-too-large");
      return;
    }

    const reservedMessageIds = new Set<string>();
    const replacements: PendingBoardUpdate[] = boundedDeltas.map((delta) => {
      const messageId = this.createUniqueMessageId(reservedMessageIds);
      reservedMessageIds.add(messageIdToHex(messageId));
      return {
        messageId,
        generation: this.scope.generation,
        documentKey: this.scope.documentKey,
        update: delta,
        createdAt: this.nextPendingCreatedAt(),
      };
    });
    if (covered.length === 0 && replacements.length === 0) {
      this.clearCausalGapRebase(rebase);
      this.pumpPendingUpdates();
      this.maybeStartInitialSync();
      return;
    }

    rebase.phase = "persisting";
    let rebaseResult;
    try {
      rebaseResult = await this.localStore.rebasePendingUpdates(
        replacements,
        covered,
      );
    } catch (error) {
      this.localDurability = "at-risk";
      this.lastError = error instanceof Error
        ? error.message
        : "Unable to rebase the local Board outbox";
      this.emitStatus();
      this.clearCausalGapRebase(rebase);
      this.failSocket(error);
      return;
    }

    for (const key of pendingBaselineKeys) {
      this.pending.delete(key);
      this.causalGapRetries.delete(key);
    }
    for (const update of rebaseResult.currentUpdates) {
      this.assertPendingScope(update);
      const copy = clonePendingUpdate(update);
      this.lastPendingCreatedAt = Math.max(
        this.lastPendingCreatedAt,
        copy.createdAt,
      );
      this.pending.set(messageIdToHex(copy.messageId), copy);
      applyBoardUpdate(this.document, copy.update, OUTBOX_REPLAY_ORIGIN);
    }
    this.localDurability = this.persistenceQueue.length ? "writing" : "ready";
    this.lastError = null;
    this.emitStatus();

    this.clearCausalGapRebase(rebase);
    this.pumpPendingUpdates();
    this.maybeStartInitialSync();
    this.scheduleAckRetry();
  }

  private hasEarlierPendingUpdate(key: string): boolean {
    const ordered = [...this.pending.entries()]
      .sort((left, right) => comparePendingUpdates(left[1], right[1]));
    const index = ordered.findIndex(([candidate]) => candidate === key);
    return index > 0;
  }

  private clearCausalGapRebase(expected: CausalGapRebase): void {
    if (this.causalGapRebase !== expected) return;
    this.causalGapRebase = null;
    expected.cancelled = true;
    expected.shadow.destroy();
  }

  private abandonCausalGapRebase(): void {
    const rebase = this.causalGapRebase;
    if (!rebase) return;
    rebase.cancelled = true;
    if (rebase.phase === "preparing" || rebase.phase === "persisting") return;
    this.clearCausalGapRebase(rebase);
  }

  private retryCausalGapUpdates(): void {
    if (
      !this.ready
      || !this.socket
      || this.stopped
      || this.stopping
      || this.recovery
      || this.causalGapRetries.size === 0
    ) {
      return;
    }
    const keys = [...this.causalGapRetries];
    for (const key of keys) {
      const update = this.pending.get(key);
      if (!update) {
        this.causalGapRetries.delete(key);
        continue;
      }
      if (this.hasEarlierPendingUpdate(key)) continue;
      this.causalGapRetries.delete(key);
    }
    this.pumpPendingUpdates();
    this.scheduleAckRetry();
  }

  private pumpPendingUpdates(): void {
    this.cancelTimer("outbox-pump");
    if (
      !this.ready
      || !this.socket
      || this.stopped
      || this.stopping
      || this.recovery
      || this.causalGapRebase
      || this.outboxReconcileTask
      || this.pending.size === 0
    ) {
      return;
    }
    if ((this.permissions & BoardPermission.EDIT) === 0) {
      this.enterRecovery("permission-revoked");
      return;
    }

    const retryDelay = this.serverRetryDelayMs();
    if (retryDelay > 0) {
      this.scheduleOutboxPump(retryDelay);
      this.scheduleAckRetry();
      return;
    }
    const now = this.timers.now();
    if (!Number.isFinite(now)) {
      this.failSocket(new Error("Board outbox clock returned a non-finite value"));
      return;
    }
    const paceDelay = Math.max(0, Math.ceil(this.nextOutboxSendAt - now));
    if (paceDelay > 0) {
      this.scheduleOutboxPump(paceDelay);
      return;
    }
    const bufferedAmount = this.socket.bufferedAmount;
    if (
      typeof bufferedAmount === "number"
      && Number.isFinite(bufferedAmount)
      && bufferedAmount > MAX_OUTBOX_SOCKET_BUFFERED_BYTES
    ) {
      this.scheduleOutboxPump(OUTBOX_BUFFER_RETRY_MS);
      return;
    }
    if (this.inFlightUpdates.size >= MAX_OUTBOX_IN_FLIGHT_COUNT) {
      this.scheduleAckRetry();
      return;
    }

    const candidate = [...this.pending.values()]
      .sort(comparePendingUpdates)
      .find((update) => {
        const key = messageIdToHex(update.messageId);
        return !this.inFlightUpdates.has(key) && !this.causalGapRetries.has(key);
      });
    if (!candidate) {
      this.scheduleAckRetry();
      return;
    }
    if (
      this.inFlightUpdates.size > 0
      && this.inFlightUpdateBytes + candidate.update.byteLength
        > MAX_OUTBOX_IN_FLIGHT_BYTES
    ) {
      this.scheduleAckRetry();
      return;
    }

    const key = messageIdToHex(candidate.messageId);
    this.inFlightUpdates.set(key, {
      updateBytes: candidate.update.byteLength,
      sentAt: now,
    });
    this.inFlightUpdateBytes += candidate.update.byteLength;
    this.nextOutboxSendAt = now + OUTBOX_SEND_INTERVAL_MS;
    if (!this.sendPendingUpdate(candidate)) {
      this.removeInFlightUpdate(key);
      return;
    }
    this.scheduleAckRetry();
    if (
      this.inFlightUpdates.size < MAX_OUTBOX_IN_FLIGHT_COUNT
      && this.inFlightUpdateBytes < MAX_OUTBOX_IN_FLIGHT_BYTES
    ) {
      this.scheduleOutboxPump(OUTBOX_SEND_INTERVAL_MS);
    }
  }

  private sendPendingUpdate(update: PendingBoardUpdate): boolean {
    if (
      !this.ready
      || !this.socket
      || this.recovery
      || this.causalGapRebase
    ) {
      return false;
    }
    if ((this.permissions & BoardPermission.EDIT) === 0) {
      this.enterRecovery("permission-revoked");
      return false;
    }
    try {
      this.sendFrame({
        type: BoardMessageType.UPDATE,
        generation: this.scope.generation,
        docKey: this.scope.documentKey,
        messageId: update.messageId,
        update: update.update,
      });
      return true;
    } catch (error) {
      if (error instanceof BoardProtocolError || error instanceof BoardUpdateLimitError) {
        this.enterRecovery("update-too-large");
        return false;
      }
      this.failSocket(error);
      return false;
    }
  }

  private scheduleAckRetry(): void {
    this.cancelTimer("ack");
    if (
      !this.ready
      || this.inFlightUpdates.size === 0
      || this.recovery
      || this.stopped
      || this.stopping
    ) {
      return;
    }
    const now = this.timers.now();
    if (!Number.isFinite(now)) return;
    const earliestRetry = Math.min(
      ...[...this.inFlightUpdates.values()].map((inFlight) =>
        Math.max(
          inFlight.sentAt + this.ackRetryMs,
          this.serverRetryNotBefore,
        )),
    );
    this.ackTimer = this.timers.setTimeout(() => {
      this.ackTimer = null;
      const retryNow = this.timers.now();
      if (!Number.isFinite(retryNow)) return;
      for (const [key, inFlight] of this.inFlightUpdates) {
        if (
          retryNow >= Math.max(
            inFlight.sentAt + this.ackRetryMs,
            this.serverRetryNotBefore,
          )
        ) {
          this.removeInFlightUpdate(key);
        }
      }
      this.pumpPendingUpdates();
      this.scheduleAckRetry();
    }, Math.max(0, Math.ceil(earliestRetry - now)));
  }

  private scheduleOutboxPump(delayMs: number): void {
    if (
      this.stopped
      || this.stopping
      || this.recovery
      || !Number.isFinite(delayMs)
    ) {
      return;
    }
    this.cancelTimer("outbox-pump");
    this.outboxPumpTimer = this.timers.setTimeout(() => {
      this.outboxPumpTimer = null;
      this.pumpPendingUpdates();
    }, Math.max(0, Math.ceil(delayMs)));
  }

  private removeInFlightUpdate(key: string): void {
    const inFlight = this.inFlightUpdates.get(key);
    if (!inFlight) return;
    this.inFlightUpdates.delete(key);
    this.inFlightUpdateBytes = Math.max(
      0,
      this.inFlightUpdateBytes - inFlight.updateBytes,
    );
  }

  private resetOutboxFlight(): void {
    this.inFlightUpdates.clear();
    this.inFlightUpdateBytes = 0;
    this.nextOutboxSendAt = Number.NEGATIVE_INFINITY;
  }

  private pruneInFlightUpdates(): void {
    for (const key of this.inFlightUpdates.keys()) {
      if (!this.pending.has(key)) this.removeInFlightUpdate(key);
    }
  }

  private applyServerRetryAfter(frame: ControlFrame): void {
    const retryAfterMs = controlRetryAfterMs(frame);
    if (retryAfterMs === null) return;
    const now = this.timers.now();
    const notBefore = now + retryAfterMs;
    if (!Number.isFinite(now) || !Number.isFinite(notBefore)) return;
    this.serverRetryNotBefore = Math.max(
      this.serverRetryNotBefore,
      notBefore,
    );
  }

  private serverRetryDelayMs(): number {
    const now = this.timers.now();
    if (!Number.isFinite(now)) return 0;
    return Math.max(
      0,
      Math.ceil(this.serverRetryNotBefore - now),
    );
  }

  private sendFrame(frame: BoardFrame): void {
    if (!this.socket) throw new Error("Board WebSocket is not connected");
    const encoded = encodeBoardFrame(frame);
    const chunkable =
      frame.type === BoardMessageType.UPDATE ||
      frame.type === BoardMessageType.SYNC_STEP2;
    if (
      !chunkable ||
      encoded.byteLength <= BOARD_PROTOCOL_LIMITS.maxChunkPayloadBytes
    ) {
      this.socket.send(encoded);
      return;
    }
    if ((this.negotiatedCapabilities & BoardCapability.CHUNKING) === 0) {
      throw new BoardUpdateLimitError(
        "Board server did not negotiate required chunking",
      );
    }

    const chunkCount = Math.ceil(
      encoded.byteLength / BOARD_PROTOCOL_LIMITS.maxChunkPayloadBytes,
    );
    if (chunkCount > BOARD_PROTOCOL_LIMITS.maxChunkCount) {
      throw new BoardUpdateLimitError("Board frame requires too many chunks");
    }
    const reassemblyId = this.createUniqueMessageId();
    for (let chunkIndex = 0; chunkIndex < chunkCount; chunkIndex += 1) {
      const start = chunkIndex * BOARD_PROTOCOL_LIMITS.maxChunkPayloadBytes;
      const payload = encoded.slice(
        start,
        Math.min(encoded.byteLength, start + BOARD_PROTOCOL_LIMITS.maxChunkPayloadBytes),
      );
      this.socket.send(encodeBoardFrame({
        type: BoardMessageType.CHUNK,
        messageId: reassemblyId,
        innerType: frame.type,
        chunkIndex,
        chunkCount,
        totalLength: encoded.byteLength,
        payload,
      }));
    }
  }

  private handleChunk(frame: ChunkFrame, connection: ConnectionRef): void {
    const key = messageIdToHex(frame.messageId);
    let assembly = this.chunkAssemblies.get(key);
    if (!assembly) {
      if (this.chunkAssemblies.size >= MAX_CHUNK_ASSEMBLIES) {
        throw new Error("Too many concurrent Board chunk assemblies");
      }
      assembly = {
        innerType: frame.innerType,
        chunkCount: frame.chunkCount,
        totalLength: frame.totalLength,
        chunks: new Array<Uint8Array | undefined>(frame.chunkCount)
          .fill(undefined),
        receivedBytes: 0,
      };
      this.chunkAssemblies.set(key, assembly);
    } else if (
      assembly.innerType !== frame.innerType ||
      assembly.chunkCount !== frame.chunkCount ||
      assembly.totalLength !== frame.totalLength
    ) {
      throw new Error("Board chunk metadata changed during reassembly");
    }

    const existing = assembly.chunks[frame.chunkIndex];
    if (existing) {
      if (!bytesEqual(existing, frame.payload)) {
        throw new Error("Conflicting duplicate Board chunk");
      }
      return;
    }
    assembly.chunks[frame.chunkIndex] = frame.payload.slice();
    assembly.receivedBytes += frame.payload.byteLength;
    if (assembly.chunks.some((chunk) => chunk === undefined)) return;
    if (assembly.receivedBytes !== assembly.totalLength) {
      throw new Error("Reassembled Board frame has the wrong length");
    }

    const encoded = new Uint8Array(assembly.totalLength);
    let offset = 0;
    for (const chunk of assembly.chunks as Uint8Array[]) {
      encoded.set(chunk, offset);
      offset += chunk.byteLength;
    }
    this.chunkAssemblies.delete(key);
    const inner = decodeBoardFrame(encoded);
    if (inner.type !== assembly.innerType) {
      throw new Error("Reassembled Board frame type does not match CHUNK");
    }
    this.handleFrame(inner, connection);
  }

  private adoptAwarenessClientId(clientId: number): void {
    if (this.awarenessClientId === clientId && this.awareness.clientID === clientId) return;
    const localState = sanitizeLocalPresence(this.awareness.getLocalState());
    if (this.awareness.getLocalState() !== null) this.awareness.setLocalState(null);
    this.awareness.clientID = clientId;
    this.awarenessClientId = clientId;
    if (localState !== null) this.awareness.setLocalState(localState);
  }

  private readonly handleAwarenessChange = (
    changes: { added: number[]; updated: number[]; removed: number[] },
    origin: unknown,
  ): void => {
    if (origin === NETWORK_AWARENESS_ORIGIN || this.awarenessClientId === null) return;
    const ownId = this.awarenessClientId;
    if (
      changes.added.includes(ownId) ||
      changes.updated.includes(ownId) ||
      changes.removed.includes(ownId)
    ) {
      this.awarenessDirty = true;
      this.scheduleAwarenessSend();
    }
  };

  private scheduleAwarenessSend(force = false): void {
    this.awarenessDirty = true;
    if (!this.canSendAwareness()) return;
    if (this.awarenessTimer !== null) return;
    const elapsed = this.timers.now() - this.lastAwarenessSentAt;
    const delay = force ? 0 : Math.max(0, this.awarenessIntervalMs - elapsed);
    this.awarenessTimer = this.timers.setTimeout(() => {
      this.awarenessTimer = null;
      this.flushAwareness();
    }, delay);
  }

  private flushAwareness(): void {
    if (!this.awarenessDirty || !this.canSendAwareness()) return;
    const awarenessClientId = this.awarenessClientId;
    if (awarenessClientId === null) return;
    this.awarenessDirty = false;
    this.lastAwarenessSentAt = this.timers.now();
    const current = this.awareness.getLocalState();
    const sanitized = sanitizeLocalPresence(current);
    if (JSON.stringify(current) !== JSON.stringify(sanitized)) {
      this.awareness.setLocalState(sanitized);
      if (this.awarenessTimer !== null) {
        this.timers.clearTimeout(this.awarenessTimer);
        this.awarenessTimer = null;
      }
      this.awarenessDirty = false;
    }
    const frame: AwarenessFrame = {
      type: BoardMessageType.AWARENESS,
      generation: this.scope.generation,
      docKey: this.scope.documentKey,
      awarenessClientId,
      update: encodeAwarenessUpdate(this.awareness, [awarenessClientId]),
    };
    try {
      this.sendFrame(frame);
    } catch (error) {
      this.failSocket(error);
    }
  }

  private canSendAwareness(): boolean {
    return (
      this.ready
      && this.socket !== null
      && this.documentSyncStarted
      && this.awarenessClientId !== null
      && (this.negotiatedCapabilities & BoardCapability.AWARENESS) !== 0
    );
  }

  private sendDocumentSyncStep1(
    frame: SyncStep1Frame,
    connection: ConnectionRef,
  ): boolean {
    if (!this.isCurrentConnection(connection)) return false;
    this.sendFrame(frame);
    if (!this.isCurrentConnection(connection)) return false;
    if (!this.documentSyncStarted) {
      this.documentSyncStarted = true;
      this.scheduleAwarenessSend(true);
    }
    return true;
  }

  private removeRemoteAwareness(): void {
    const ownId = this.awarenessClientId ?? this.awareness.clientID;
    const remoteIds = [...this.awareness.getStates().keys()]
      .filter((clientId) => clientId !== ownId);
    if (remoteIds.length) {
      removeAwarenessStates(this.awareness, remoteIds, NETWORK_AWARENESS_ORIGIN);
    }
  }

  private createUniqueMessageId(
    reserved: ReadonlySet<string> = new Set(),
  ): Uint8Array {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const messageId = this.randomBytes(16);
      if (!(messageId instanceof Uint8Array) || messageId.byteLength !== 16) {
        throw new Error("randomBytes must return the requested byte length");
      }
      const key = messageIdToHex(messageId);
      if (
        !this.pending.has(key) &&
        !reserved.has(key) &&
        !this.persistenceQueue.some((update) => messageIdToHex(update.messageId) === key)
      ) {
        return messageId.slice();
      }
    }
    throw new Error("Unable to allocate a unique Board message ID");
  }

  private nextPendingCreatedAt(): number {
    const now = this.timers.now();
    if (!Number.isFinite(now)) {
      throw new Error("Board outbox clock returned a non-finite value");
    }
    const createdAt = Math.max(now, this.lastPendingCreatedAt + 1);
    this.lastPendingCreatedAt = createdAt;
    return createdAt;
  }

  private assertPendingScope(update: PendingBoardUpdate): void {
    if (
      update.generation !== this.scope.generation ||
      update.documentKey !== this.scope.documentKey
    ) {
      throw new Error("Stored Board update belongs to another generation or document");
    }
  }

  private assertDocumentKey(documentKey: string): void {
    if (documentKey !== this.scope.documentKey) {
      throw new Error("Board frame targets another document");
    }
  }

  private isCurrentConnection(connection: ConnectionRef): boolean {
    return (
      connection.epoch === this.connectionEpoch &&
      connection.socket === this.socket
    );
  }

  private resetConnectionState(): void {
    if (this.profileUpdateInFlight && !this.pendingProfile) {
      this.pendingProfile = this.profileUpdateInFlight.profile;
    }
    this.profileUpdateInFlight = null;
    this.connectionEpoch += 1;
    this.socket = null;
    this.ready = false;
    this.documentSyncStarted = false;
    this.initialSync = null;
    this.deferredServerSync = null;
    this.causalGapRetries.clear();
    this.abandonCausalGapRebase();
    this.resetOutboxFlight();
    this.permissions = 0;
    this.negotiatedCapabilities = 0;
    this.chunkAssemblies.clear();
    this.cancelTimer("ack");
    this.cancelTimer("awareness");
    this.cancelTimer("outbox-pump");
    this.removeRemoteAwareness();
  }

  private emitStatus(): void {
    const status = this.status;
    for (const listener of this.statusListeners) listener(status);
  }

  private failSocket(error: unknown): void {
    this.lastError = error instanceof Error ? error.message : "Board WebSocket send failed";
    this.emitStatus();
    const socket = this.socket;
    if (socket) {
      socket.close(
        BOARD_CLIENT_CLOSE_CODE.sendFailed,
        "Board WebSocket send failed",
      );
    }
  }

  private cancelTimer(
    timer:
      | "reconnect"
      | "ack"
      | "awareness"
      | "persistence-retry"
      | "outbox-pump",
  ): void {
    const property = {
      reconnect: "reconnectTimer",
      ack: "ackTimer",
      awareness: "awarenessTimer",
      "persistence-retry": "persistenceRetryTimer",
      "outbox-pump": "outboxPumpTimer",
    }[timer] as
      | "reconnectTimer"
      | "ackTimer"
      | "awarenessTimer"
      | "persistenceRetryTimer"
      | "outboxPumpTimer";
    const handle = this[property];
    if (handle !== null) {
      this.timers.clearTimeout(handle);
      this[property] = null;
    }
  }
}

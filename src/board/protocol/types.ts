export enum BoardMessageType {
  AUTH = 1,
  READY = 2,
  SYNC_STEP1 = 3,
  SYNC_STEP2 = 4,
  UPDATE = 5,
  ACK = 6,
  AWARENESS = 7,
  CONTROL = 8,
  CHUNK = 9,
}

/**
 * Capability bits are negotiated by intersection. Unknown bits are preserved
 * by the codec so newer peers can safely negotiate through older relays.
 */
export enum BoardCapability {
  CHUNKING = 1 << 0,
  AWARENESS = 1 << 1,
  ASSET_CONTROL = 1 << 2,
  RECOVERY_FORK = 1 << 3,
  PAGE_SHARDING = 1 << 4,
}

export const KNOWN_BOARD_CAPABILITIES =
  BoardCapability.CHUNKING |
  BoardCapability.AWARENESS |
  BoardCapability.ASSET_CONTROL |
  BoardCapability.RECOVERY_FORK |
  BoardCapability.PAGE_SHARDING;

export enum BoardPermission {
  READ = 1 << 0,
  EDIT = 1 << 1,
}

export enum BoardControlCode {
  PERMISSION_CHANGED = 1,
  ASSET_READY = 2,
  LIFECYCLE_CHANGED = 3,
  UPDATE_REJECTED = 4,
  RESYNC_REQUIRED = 5,
  BOARD_GONE = 6,
  SESSION_REVOKED = 7,
  RATE_LIMITED = 8,
  STORAGE_ERROR = 9,
  SERVER_ERROR = 10,
}

export type BoardMessageId = Uint8Array;

export interface AuthFrame {
  readonly type: BoardMessageType.AUTH;
  /** A single-use, short-lived ticket. It is never sent in a URL. */
  readonly ticket: string;
  readonly generation: number;
  readonly minSchemaVersion: number;
  readonly maxSchemaVersion: number;
  readonly capabilities: number;
}

export interface ReadyFrame {
  readonly type: BoardMessageType.READY;
  readonly generation: number;
  readonly schemaVersion: number;
  /** Intersection of client and server capabilities. */
  readonly capabilities: number;
  /** Server-assigned identity for y-protocols awareness updates. */
  readonly awarenessClientId: number;
  readonly permissions: number;
}

export interface SyncStep1Frame {
  readonly type: BoardMessageType.SYNC_STEP1;
  readonly generation: number;
  readonly docKey: string;
  readonly stateVector: Uint8Array;
}

export interface SyncStep2Frame {
  readonly type: BoardMessageType.SYNC_STEP2;
  readonly generation: number;
  readonly docKey: string;
  readonly update: Uint8Array;
}

export interface UpdateFrame {
  readonly type: BoardMessageType.UPDATE;
  readonly generation: number;
  readonly docKey: string;
  /** Stable across retries so durable inserts are idempotent. */
  readonly messageId: BoardMessageId;
  readonly update: Uint8Array;
}

export interface AckFrame {
  readonly type: BoardMessageType.ACK;
  readonly generation: number;
  readonly docKey: string;
  readonly messageId: BoardMessageId;
  readonly durableSequence: number;
}

export interface AwarenessFrame {
  readonly type: BoardMessageType.AWARENESS;
  readonly generation: number;
  readonly docKey: string;
  /**
   * A client may update only the ID assigned in READY. The server must validate
   * that the opaque y-protocols payload contains no other client IDs.
   */
  readonly awarenessClientId: number;
  readonly update: Uint8Array;
}

export interface ControlFrame {
  readonly type: BoardMessageType.CONTROL;
  readonly generation: number;
  readonly code: BoardControlCode;
  readonly docKey?: string;
  readonly messageId?: BoardMessageId;
  /**
   * Code-specific, versioned binary data. It is deliberately not JSON so the
   * base protocol stays language- and renderer-independent.
   */
  readonly payload: Uint8Array;
}

export interface ChunkFrame {
  readonly type: BoardMessageType.CHUNK;
  /** Reassembly ID, independent from an UPDATE's idempotency message ID. */
  readonly messageId: BoardMessageId;
  readonly innerType: BoardMessageType.SYNC_STEP2 | BoardMessageType.UPDATE;
  readonly chunkIndex: number;
  readonly chunkCount: number;
  readonly totalLength: number;
  readonly payload: Uint8Array;
}

export type BoardFrame =
  | AuthFrame
  | ReadyFrame
  | SyncStep1Frame
  | SyncStep2Frame
  | UpdateFrame
  | AckFrame
  | AwarenessFrame
  | ControlFrame
  | ChunkFrame;

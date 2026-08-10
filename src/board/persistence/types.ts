export interface PendingBoardUpdate {
  readonly messageId: Uint8Array;
  readonly generation: number;
  readonly documentKey: string;
  readonly update: Uint8Array;
  readonly createdAt: number;
  /** Durable per-document outbox order. Older stores may omit it. */
  readonly queueOrder?: number;
}

export type BoardRecoveryReason =
  | "board-gone"
  | "generation-mismatch"
  | "lifecycle-revoked"
  | "permission-revoked"
  | "session-revoked"
  | "update-rejected"
  | "update-too-large";

export interface BoardRecoverySignal {
  readonly reason: BoardRecoveryReason;
  readonly generation: number;
  readonly documentKey: string;
  readonly occurredAt: number;
  readonly controlCode?: number;
  readonly messageId?: Uint8Array;
  readonly payload?: Uint8Array;
}

export interface PendingBoardRebaseResult {
  readonly committed: boolean;
  /** Same-transaction authoritative rows after commit or a lost tab race. */
  readonly currentUpdates: readonly PendingBoardUpdate[];
}

export interface BoardDocumentUpdateBatch {
  readonly updates: readonly Uint8Array[];
  /** Monotonic durable row key through which this batch has been read. */
  readonly cursor: number;
}

/**
 * Durable client state used by the network provider. Implementations may use
 * IndexedDB, SQLite, or another local database, but ACK removal must itself be
 * durable before an update disappears from this interface.
 */
export interface BoardClientPersistence {
  readonly whenReady: Promise<void>;

  enqueuePendingUpdate(update: PendingBoardUpdate): Promise<number | void>;
  /**
   * Atomically replaces the exact complete captured outbox with bounded,
   * causally-ordered updates. An empty covered set may materialize durable
   * document-history-only deltas only when the authoritative outbox is empty.
   */
  rebasePendingUpdates(
    replacements: readonly PendingBoardUpdate[],
    coveredUpdates: readonly PendingBoardUpdate[],
  ): Promise<PendingBoardRebaseResult>;
  listPendingUpdates(): Promise<readonly PendingBoardUpdate[]>;
  /** Hints that another local process/tab changed authoritative durable state. */
  subscribeLocalChanges?(
    listener: () => void,
  ): () => void;
  /** Causal local document log used only for rare crash-window repair. */
  listDocumentUpdates(): Promise<readonly Uint8Array[]>;
  /**
   * Reads authoritative document rows after a monotonic local-store cursor.
   * Adapters without cursors may omit this and fall back to a full reread.
   */
  listDocumentUpdatesAfter?(
    cursor: number,
  ): Promise<BoardDocumentUpdateBatch>;
  acknowledgePendingUpdate(
    messageId: Uint8Array,
    durableSequence: number,
  ): Promise<void>;

  getRecoverySignal(): Promise<BoardRecoverySignal | null>;
  setRecoverySignal(signal: BoardRecoverySignal): Promise<void>;
}

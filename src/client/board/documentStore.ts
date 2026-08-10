import * as Y from "yjs";
import type { BoardDocumentUpdateBatch } from "../../board/persistence/index.js";
import {
  compactBoardDocumentInWorker,
} from "./documentCompactionClient.js";
import {
  BOARD_DOCUMENT_LOG_STATS_KEY,
  boardDocumentLogStatsEqual,
  createBoardDocumentLogStats,
  restoreBoardDocumentLogStats,
  type BoardDocumentLogStats,
} from "./documentCompactionProtocol.js";
import { deleteIndexedDb, openIndexedDb } from "./indexedDbLifecycle.js";

const UPDATES_STORE = "updates";
const UPDATE_SIZES_STORE = "update-sizes";
const CUSTOM_STORE = "custom";
const DOCUMENT_DATABASE_VERSION = 1;
const COMPACTION_ROW_THRESHOLD = 500;
const COMPACTION_BYTE_THRESHOLD = 64 * 1024 * 1024;
const COMPACTION_DELAY_MS = 1_000;
const COMPACTION_STALE_RETRY_MS = 250;
const COMPACTION_STALE_MAX_RETRY_MS = 4_000;
const COMPACTION_FAILURE_RETRY_MS = 30_000;
const COMPACTION_NOOP_RETRY_ROWS = 128;
const COMPACTION_NOOP_RETRY_BYTES = 16 * 1024 * 1024;

export type BoardDocumentCompactionRunner =
  typeof compactBoardDocumentInWorker;

export const BOARD_DOCUMENT_REPLAY_ORIGIN = Object.freeze({
  type: "eduri.board.document-log-replay",
});

interface PendingDocumentState {
  readonly structUpdate: Uint8Array | null;
  readonly missingStructs: readonly (readonly [number, number])[];
  readonly deleteUpdate: Uint8Array | null;
}

const contextualReplayOrigins = new WeakMap<object, PendingDocumentState>();

function capturePendingDocumentState(document: Y.Doc): PendingDocumentState {
  const pendingStructs = document.store.pendingStructs;
  return {
    structUpdate: pendingStructs?.update.slice() ?? null,
    missingStructs: pendingStructs
      ? [...pendingStructs.missing.entries()]
        .sort(([left], [right]) => left - right)
        .map(([clientId, clock]) => [clientId, clock] as const)
      : [],
    deleteUpdate: document.store.pendingDs?.slice() ?? null,
  };
}

function optionalBytesEqual(
  left: Uint8Array | null,
  right: Uint8Array | null,
): boolean {
  if (left === null || right === null) return left === right;
  return bytesEqual(left, right);
}

function pendingDocumentStatesEqual(
  left: PendingDocumentState,
  right: PendingDocumentState,
): boolean {
  return (
    optionalBytesEqual(left.structUpdate, right.structUpdate)
    && optionalBytesEqual(left.deleteUpdate, right.deleteUpdate)
    && left.missingStructs.length === right.missingStructs.length
    && left.missingStructs.every(([clientId, clock], index) => {
      const candidate = right.missingStructs[index];
      return (
        candidate !== undefined
        && candidate[0] === clientId
        && candidate[1] === clock
      );
    })
  );
}

function hasPendingDocumentState(state: PendingDocumentState): boolean {
  return state.structUpdate !== null || state.deleteUpdate !== null;
}

export function createBoardDocumentReplayOrigin(document: Y.Doc): object {
  const origin = Object.freeze({
    type: BOARD_DOCUMENT_REPLAY_ORIGIN.type,
  });
  contextualReplayOrigins.set(origin, capturePendingDocumentState(document));
  return origin;
}

export function isBoardDocumentReplayOrigin(origin: unknown): boolean {
  return (
    origin === BOARD_DOCUMENT_REPLAY_ORIGIN
    || (
      typeof origin === "object"
      && origin !== null
      && contextualReplayOrigins.has(origin)
    )
  );
}

function replayIntegratedPendingDocumentState(
  origin: unknown,
  document: Y.Doc,
): boolean {
  if (typeof origin !== "object" || origin === null) return false;
  const before = contextualReplayOrigins.get(origin);
  return (
    before !== undefined
    && hasPendingDocumentState(before)
    && !pendingDocumentStatesEqual(
      before,
      capturePendingDocumentState(document),
    )
  );
}

export function assertEmptyBoardDocument(document: Y.Doc): void {
  if (
    document.store.clients.size > 0
    || document.store.pendingStructs
    || document.store.pendingDs
  ) {
    throw new Error(
      "Board document storage requires an empty Y.Doc before hydration",
    );
  }
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(
      request.error ?? new Error("IndexedDB request failed"),
    );
  });
}

function transactionComplete(transaction: IDBTransaction): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(
      transaction.error ?? new Error("IndexedDB transaction was aborted"),
    );
    transaction.onerror = () => reject(
      transaction.error ?? new Error("IndexedDB transaction failed"),
    );
  });
}

function openDocumentDatabase(name: string): Promise<IDBDatabase> {
  return openIndexedDb({
    factory: indexedDB,
    name,
    version: DOCUMENT_DATABASE_VERSION,
    errorMessage: "Unable to open Board document storage",
    upgrade: (database) => {
      if (!database.objectStoreNames.contains(UPDATES_STORE)) {
        database.createObjectStore(UPDATES_STORE, { autoIncrement: true });
      }
      if (!database.objectStoreNames.contains(UPDATE_SIZES_STORE)) {
        database.createObjectStore(UPDATE_SIZES_STORE);
      }
      if (!database.objectStoreNames.contains(CUSTOM_STORE)) {
        database.createObjectStore(CUSTOM_STORE);
      }
    },
  });
}

function deleteDocumentDatabase(name: string): Promise<void> {
  return deleteIndexedDb(
    indexedDB,
    name,
    "Unable to delete Board document storage",
  );
}

function restoreDocumentUpdate(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value.slice();
  if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(
      value.buffer.slice(
        value.byteOffset,
        value.byteOffset + value.byteLength,
      ),
    );
  }
  throw new Error("Stored Board document update is not binary");
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength
    && left.every((byte, index) => byte === right[index]);
}

/**
 * Board-specific Yjs persistence. Unlike y-indexeddb's whole-document trim,
 * compaction keeps a causal sequence of standard update-v1 segments bounded by
 * the wire protocol's per-update limit.
 */
export class BoardDocumentIndexedDbStore {
  readonly whenReady: Promise<void>;

  private readonly database: Promise<IDBDatabase>;
  private readonly document: Y.Doc;
  private readonly loadOrigin = Object.freeze({
    type: "eduri.board.indexeddb-load",
  });
  private writeTail: Promise<void>;
  private writeFailure: unknown = null;
  private lastKnownStats: BoardDocumentLogStats | null = null;
  private lastNoopStats: BoardDocumentLogStats | null = null;
  private staleRetryMs = COMPACTION_STALE_RETRY_MS;
  private compactionTimer: ReturnType<typeof setTimeout> | null = null;
  private compactionTask: Promise<void> | null = null;
  private compactionAbort: AbortController | null = null;
  private compactionRerunRequested = false;
  private closed = false;
  private teardownComplete = false;

  constructor(
    readonly name: string,
    document: Y.Doc,
    private readonly onDurableUpdate: (() => void) | null = null,
    private readonly compactDocument: BoardDocumentCompactionRunner =
      compactBoardDocumentInWorker,
  ) {
    assertEmptyBoardDocument(document);
    this.document = document;
    this.database = openDocumentDatabase(name);
    const initialUpdate = Y.encodeStateAsUpdate(document);
    this.whenReady = this.load(initialUpdate);
    this.writeTail = this.whenReady;
    this.document.on("update", this.handleDocumentUpdate);
  }

  async flush(): Promise<void> {
    this.assertOpen();
    this.cancelScheduledCompaction();
    await this.flushPendingWrites();
    await this.ensureCompaction().catch(() => undefined);
    await this.flushPendingWrites();
  }

  async flushPendingWrites(): Promise<void> {
    this.assertOpen();
    await this.awaitWriteBarrier();
    if (this.writeFailure !== null) throw this.writeFailure;
  }

  async listUpdates(): Promise<readonly Uint8Array[]> {
    this.assertOpen();
    await this.awaitWriteBarrier();
    if (this.writeFailure !== null) throw this.writeFailure;
    const database = await this.database;
    const transaction = database.transaction(UPDATES_STORE, "readonly");
    const completed = transactionComplete(transaction);
    const rows = await requestResult(
      transaction.objectStore(UPDATES_STORE).getAll() as IDBRequest<unknown[]>,
    );
    await completed;
    return rows.map(restoreDocumentUpdate);
  }

  async listUpdatesAfter(cursor: number): Promise<BoardDocumentUpdateBatch> {
    this.assertOpen();
    if (!Number.isSafeInteger(cursor) || cursor < 0) {
      throw new TypeError(
        "Board document update cursor must be a non-negative safe integer",
      );
    }
    await this.awaitWriteBarrier();
    if (this.writeFailure !== null) throw this.writeFailure;
    const database = await this.database;
    const transaction = database.transaction(UPDATES_STORE, "readonly");
    const completed = transactionComplete(transaction);
    const store = transaction.objectStore(UPDATES_STORE);
    const range = IDBKeyRange.lowerBound(cursor, true);
    const [rows, keys] = await Promise.all([
      requestResult(store.getAll(range) as IDBRequest<unknown[]>),
      requestResult(store.getAllKeys(range)),
    ]);
    await completed;
    if (rows.length !== keys.length) {
      throw new Error("Board document update cursor read was inconsistent");
    }
    let nextCursor = cursor;
    for (const key of keys) {
      if (
        typeof key !== "number"
        || !Number.isSafeInteger(key)
        || key <= nextCursor
      ) {
        throw new Error("Board document update row key is invalid");
      }
      nextCursor = key;
    }
    return {
      updates: rows.map(restoreDocumentUpdate),
      cursor: nextCursor,
    };
  }

  async destroy(): Promise<void> {
    if (this.teardownComplete) return;
    this.closed = true;
    this.cancelScheduledCompaction();
    this.compactionRerunRequested = false;
    this.compactionAbort?.abort();
    this.document.off("update", this.handleDocumentUpdate);
    const failures: unknown[] = [];
    try {
      await this.awaitWriteBarrier();
    } catch (error) {
      failures.push(error);
    }
    try {
      await this.compactionTask;
    } catch (error) {
      failures.push(error);
    }
    try {
      const database = await this.database;
      database.close();
    } catch (error) {
      failures.push(error);
    }
    this.teardownComplete = true;
    if (failures.length > 0) {
      throw new AggregateError(
        failures,
        "Board document storage could not close cleanly",
      );
    }
  }

  async clearData(): Promise<void> {
    let closeError: unknown;
    if (!this.teardownComplete) {
      try {
        await this.destroy();
      } catch (error) {
        closeError = error;
      }
    }
    try {
      await deleteDocumentDatabase(this.name);
    } catch (deleteError) {
      throw new AggregateError(
        closeError === undefined
          ? [deleteError]
          : [closeError, deleteError],
        "Board document storage could not be cleared",
      );
    }
  }

  private readonly handleDocumentUpdate = (
    update: Uint8Array,
    origin: unknown,
  ): void => {
    if (
      this.closed
      || origin === this.loadOrigin
    ) {
      return;
    }
    if (
      isBoardDocumentReplayOrigin(origin)
      && !replayIntegratedPendingDocumentState(origin, this.document)
    ) return;
    const durableUpdate = update.slice();
    const operation = this.writeTail.then(async () => {
      const database = await this.database;
      const transaction = database.transaction(
        [UPDATES_STORE, UPDATE_SIZES_STORE, CUSTOM_STORE],
        "readwrite",
      );
      const completed = transactionComplete(transaction);
      const metadata = transaction.objectStore(CUSTOM_STORE);
      const sizes = transaction.objectStore(UPDATE_SIZES_STORE);
      const statsRequest = metadata.get(BOARD_DOCUMENT_LOG_STATS_KEY);
      let nextStats: BoardDocumentLogStats | null = null;
      let callbackError: unknown;
      statsRequest.onsuccess = () => {
        try {
          const currentStats = restoreBoardDocumentLogStats(statsRequest.result);
          nextStats = createBoardDocumentLogStats(
            currentStats.rowCount + 1,
            currentStats.rowBytes + durableUpdate.byteLength,
            currentStats.revision + 1,
          );
          const addRequest = transaction
            .objectStore(UPDATES_STORE)
            .add(durableUpdate);
          addRequest.onsuccess = () => {
            try {
              sizes.put(durableUpdate.byteLength, addRequest.result);
            } catch (error) {
              callbackError = error;
              transaction.abort();
            }
          };
          metadata.put(nextStats, BOARD_DOCUMENT_LOG_STATS_KEY);
        } catch (error) {
          callbackError = error;
          transaction.abort();
        }
      };
      try {
        await completed;
      } catch (error) {
        if (callbackError !== undefined) throw callbackError;
        throw error;
      }
      if (!nextStats) {
        throw new Error("Board document log statistics were not updated");
      }
      const currentStats = this.adoptDocumentLogStats(nextStats);
      try {
        this.onDurableUpdate?.();
      } catch {
        // A best-effort process hint cannot turn a committed write into failure.
      }
      if (this.shouldScheduleCompaction(currentStats)) {
        this.scheduleCompaction();
      }
    });
    this.writeTail = operation.catch((error) => {
      if (this.writeFailure === null) this.writeFailure = error;
    });
  };

  private async load(initialUpdate: Uint8Array): Promise<void> {
    const database = await this.database;
    const transaction = database.transaction(
      [UPDATES_STORE, UPDATE_SIZES_STORE, CUSTOM_STORE],
      "readwrite",
    );
    const completed = transactionComplete(transaction);
    const updates = transaction.objectStore(UPDATES_STORE);
    const sizes = transaction.objectStore(UPDATE_SIZES_STORE);
    const metadata = transaction.objectStore(CUSTOM_STORE);
    const valuesRequest = updates.getAll() as IDBRequest<unknown[]>;
    const keysRequest = updates.getAllKeys();
    let restored: Uint8Array[] = [];
    let restoredStats: BoardDocumentLogStats | null = null;
    let callbackError: unknown;
    let initialized = false;
    const initialize = (): void => {
      if (
        initialized
        || valuesRequest.readyState !== "done"
        || keysRequest.readyState !== "done"
      ) {
        return;
      }
      initialized = true;
      try {
        restored = valuesRequest.result.map(restoreDocumentUpdate);
        if (restored.length !== keysRequest.result.length) {
          throw new Error("Board document update keys are inconsistent");
        }
        sizes.clear();
        if (restored.length === 0) {
          const firstUpdate = initialUpdate.slice();
          const addRequest = updates.add(firstUpdate);
          addRequest.onsuccess = () => {
            try {
              sizes.put(firstUpdate.byteLength, addRequest.result);
            } catch (error) {
              callbackError = error;
              transaction.abort();
            }
          };
          restored.push(firstUpdate);
        } else {
          restored.forEach((update, index) => {
            const key = keysRequest.result[index];
            if (
              typeof key !== "number"
              || !Number.isSafeInteger(key)
              || key < 1
            ) {
              throw new Error("Board document update key is invalid");
            }
            sizes.put(update.byteLength, key);
          });
        }
        const rowBytes = restored.reduce(
          (total, update) => total + update.byteLength,
          0,
        );
        const previousRequest = metadata.get(BOARD_DOCUMENT_LOG_STATS_KEY);
        previousRequest.onsuccess = () => {
          try {
            let revision = 1;
            if (previousRequest.result !== undefined) {
              try {
                const previousStats = restoreBoardDocumentLogStats(
                  previousRequest.result,
                );
                if (previousStats.revision < Number.MAX_SAFE_INTEGER) {
                  revision = previousStats.revision + 1;
                }
              } catch {
                // Canonical update rows repair derived metadata during hydration.
              }
            }
            restoredStats = createBoardDocumentLogStats(
              restored.length,
              rowBytes,
              revision,
            );
            metadata.put(restoredStats, BOARD_DOCUMENT_LOG_STATS_KEY);
          } catch (error) {
            callbackError = error;
            transaction.abort();
          }
        };
      } catch (error) {
        callbackError = error;
        transaction.abort();
      }
    };
    valuesRequest.onsuccess = initialize;
    keysRequest.onsuccess = initialize;
    try {
      await completed;
    } catch (error) {
      if (callbackError !== undefined) throw callbackError;
      throw error;
    }
    Y.transact(this.document, () => {
      for (const update of restored) {
        Y.applyUpdate(this.document, update, this.loadOrigin);
      }
    }, this.loadOrigin, false);
    if (!restoredStats) {
      throw new Error("Board document log statistics were not initialized");
    }
    this.adoptDocumentLogStats(restoredStats);
    if (this.shouldScheduleCompaction(restoredStats)) {
      this.scheduleCompaction();
    }
  }

  private scheduleCompaction(delayMs = COMPACTION_DELAY_MS): void {
    if (this.closed || this.compactionTimer !== null) return;
    this.compactionTimer = globalThis.setTimeout(() => {
      this.compactionTimer = null;
      if (this.compactionTask) {
        this.compactionRerunRequested = true;
        return;
      }
      void this.ensureCompaction().catch(() => undefined);
    }, delayMs);
  }

  private cancelScheduledCompaction(): void {
    if (this.compactionTimer === null) return;
    globalThis.clearTimeout(this.compactionTimer);
    this.compactionTimer = null;
  }

  private ensureCompaction(): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (this.compactionTask) return this.compactionTask;
    const task = this.compactNow();
    this.compactionTask = task;
    const finish = (): void => {
      if (this.compactionTask !== task) return;
      this.compactionTask = null;
      if (!this.closed && this.compactionRerunRequested) {
        this.compactionRerunRequested = false;
        this.cancelScheduledCompaction();
        this.scheduleCompaction(0);
      }
    };
    void task.then(finish, finish);
    return task;
  }

  private async compactNow(): Promise<void> {
    await this.awaitWriteBarrier();
    if (this.closed) return;
    const controller = new AbortController();
    this.compactionAbort = controller;
    try {
      const result = await this.compactDocument({
        databaseName: this.name,
        updatesStoreName: UPDATES_STORE,
        sizesStoreName: UPDATE_SIZES_STORE,
        metadataStoreName: CUSTOM_STORE,
      }, {
        signal: controller.signal,
      });
      if (this.closed) return;
      const stats = createBoardDocumentLogStats(
        result.rowCount,
        result.rowBytes,
        result.revision,
      );
      const authoritativeStats = await this.readDocumentLogStats();
      if (
        stats.revision > authoritativeStats.revision
        || (
          stats.revision === authoritativeStats.revision
          && !boardDocumentLogStatsEqual(stats, authoritativeStats)
        )
      ) {
        throw new Error(
          "Board document compaction reported uncommitted log statistics",
        );
      }
      if (this.closed) return;
      const currentStats = this.adoptDocumentLogStats(authoritativeStats);
      if (result.status === "compacted") {
        this.lastNoopStats = null;
        this.staleRetryMs = COMPACTION_STALE_RETRY_MS;
        if (this.isCompactionThresholdExceeded(currentStats)) {
          this.scheduleCompaction();
        }
        return;
      }
      if (result.status === "stale") {
        this.lastNoopStats = null;
        if (this.isCompactionThresholdExceeded(currentStats)) {
          this.scheduleCompaction(this.staleRetryMs);
          this.staleRetryMs = Math.min(
            this.staleRetryMs * 2,
            COMPACTION_STALE_MAX_RETRY_MS,
          );
        }
        return;
      }
      this.staleRetryMs = COMPACTION_STALE_RETRY_MS;
      this.lastNoopStats = this.isCompactionThresholdExceeded(stats)
        ? stats
        : null;
      if (
        currentStats.revision > stats.revision
        && this.shouldScheduleCompaction(currentStats)
      ) {
        this.scheduleCompaction();
      }
    } catch (error) {
      if (
        this.closed
        && error instanceof DOMException
        && error.name === "AbortError"
      ) {
        return;
      }
      if (
        !this.closed
        && this.lastKnownStats !== null
        && this.shouldScheduleCompaction(this.lastKnownStats)
      ) {
        this.scheduleCompaction(COMPACTION_FAILURE_RETRY_MS);
      }
      throw error;
    } finally {
      if (this.compactionAbort === controller) {
        this.compactionAbort = null;
      }
    }
  }

  private isCompactionThresholdExceeded(
    stats: BoardDocumentLogStats,
  ): boolean {
    return (
      stats.rowCount >= COMPACTION_ROW_THRESHOLD
      || stats.rowBytes >= COMPACTION_BYTE_THRESHOLD
    );
  }

  private adoptDocumentLogStats(
    candidate: BoardDocumentLogStats,
  ): BoardDocumentLogStats {
    const current = this.lastKnownStats;
    if (!current || candidate.revision > current.revision) {
      this.lastKnownStats = candidate;
      return candidate;
    }
    if (
      candidate.revision === current.revision
      && !boardDocumentLogStatsEqual(candidate, current)
    ) {
      throw new Error("Board document log revision has conflicting statistics");
    }
    return current;
  }

  private async readDocumentLogStats(): Promise<BoardDocumentLogStats> {
    const database = await this.database;
    const transaction = database.transaction(CUSTOM_STORE, "readonly");
    const completed = transactionComplete(transaction);
    const [stored] = await Promise.all([
      requestResult(
        transaction
          .objectStore(CUSTOM_STORE)
          .get(BOARD_DOCUMENT_LOG_STATS_KEY),
      ),
      completed.then(() => undefined),
    ]);
    return restoreBoardDocumentLogStats(stored);
  }

  private shouldScheduleCompaction(stats: BoardDocumentLogStats): boolean {
    if (!this.isCompactionThresholdExceeded(stats)) return false;
    const baseline = this.lastNoopStats;
    if (!baseline) return true;
    if (
      stats.rowCount < baseline.rowCount
      || stats.rowBytes < baseline.rowBytes
    ) {
      return true;
    }
    return (
      stats.rowCount - baseline.rowCount >= COMPACTION_NOOP_RETRY_ROWS
      || stats.rowBytes - baseline.rowBytes >= COMPACTION_NOOP_RETRY_BYTES
    );
  }

  private async awaitWriteBarrier(): Promise<void> {
    while (true) {
      const barrier = this.writeTail;
      await barrier;
      if (barrier === this.writeTail) return;
    }
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("Board document storage is closed");
  }
}

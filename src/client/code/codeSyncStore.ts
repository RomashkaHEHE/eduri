import * as Y from "yjs";
import {
  deleteIndexedDb,
  openIndexedDb,
} from "../board/indexedDbLifecycle.js";

const UPDATES_STORE = "updates";
const OUTBOX_STORE = "outbox";
const META_STORE = "meta";
const DATABASE_VERSION = 1;
const NEXT_QUEUE_ORDER_KEY = "next-queue-order";
const COMPACTION_ROW_THRESHOLD = 500;
const COMPACTION_BYTE_THRESHOLD = 32 * 1024 * 1024;

export const CODE_SYNC_REPLAY_ORIGIN = Object.freeze({
  type: "eduri.code.indexeddb-replay",
});

export const CODE_SYNC_REMOTE_ORIGIN = Object.freeze({
  type: "eduri.code.remote-update",
});

export interface PendingCodeSyncUpdate {
  readonly updateId: string;
  readonly update: Uint8Array;
  readonly createdAt: number;
  readonly queueOrder: number;
}

interface StoredPendingCodeSyncUpdate {
  readonly updateId: string;
  readonly update: ArrayBuffer;
  readonly createdAt: number;
  readonly queueOrder: number;
}

export interface CodeSyncStoreOptions {
  readonly createUpdateId?: () => string;
  readonly now?: () => number;
  readonly onLocalUpdateQueued?: () => void;
  readonly onDurableLocalUpdate?: (update: PendingCodeSyncUpdate) => void;
  readonly onWriteError?: (error: unknown) => void;
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

function copyBuffer(bytes: Uint8Array): ArrayBuffer {
  return Uint8Array.from(bytes).buffer;
}

function restoreBytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value.slice();
  if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));
  if (ArrayBuffer.isView(value)) {
    return Uint8Array.from(new Uint8Array(
      value.buffer,
      value.byteOffset,
      value.byteLength,
    ));
  }
  throw new Error("Stored Code update is not binary");
}

function restorePending(value: unknown): PendingCodeSyncUpdate {
  if (typeof value !== "object" || value === null) {
    throw new Error("Stored Code outbox row is invalid");
  }
  const stored = value as Partial<StoredPendingCodeSyncUpdate>;
  if (
    typeof stored.updateId !== "string"
    || typeof stored.createdAt !== "number"
    || !Number.isSafeInteger(stored.createdAt)
    || typeof stored.queueOrder !== "number"
    || !Number.isSafeInteger(stored.queueOrder)
    || stored.queueOrder < 1
  ) {
    throw new Error("Stored Code outbox metadata is invalid");
  }
  return {
    updateId: stored.updateId,
    update: restoreBytes(stored.update),
    createdAt: stored.createdAt,
    queueOrder: stored.queueOrder,
  };
}

function openDatabase(name: string): Promise<IDBDatabase> {
  return openIndexedDb({
    factory: indexedDB,
    name,
    version: DATABASE_VERSION,
    errorMessage: "Unable to open Code collaboration storage",
    upgrade: (database) => {
      if (!database.objectStoreNames.contains(UPDATES_STORE)) {
        database.createObjectStore(UPDATES_STORE, { autoIncrement: true });
      }
      if (!database.objectStoreNames.contains(OUTBOX_STORE)) {
        database.createObjectStore(OUTBOX_STORE, { keyPath: "updateId" });
      }
      if (!database.objectStoreNames.contains(META_STORE)) {
        database.createObjectStore(META_STORE);
      }
    },
  });
}

function assertEmptyDocument(document: Y.Doc): void {
  if (
    document.store.clients.size > 0
    || document.store.pendingStructs
    || document.store.pendingDs
  ) {
    throw new Error("Code collaboration storage requires an empty Y.Doc");
  }
}

function clonePending(update: PendingCodeSyncUpdate): PendingCodeSyncUpdate {
  return { ...update, update: update.update.slice() };
}

/**
 * A bounded update-v1 log and ACK-backed outbox. A local update and its
 * outbox row commit in the same IndexedDB transaction before it can be sent.
 */
export class CodeSyncIndexedDbStore {
  readonly whenReady: Promise<void>;

  private readonly database: Promise<IDBDatabase>;
  private readonly createUpdateId: () => string;
  private readonly now: () => number;
  private readonly onLocalUpdateQueued: (() => void) | undefined;
  private readonly onDurableLocalUpdate:
    ((update: PendingCodeSyncUpdate) => void) | undefined;
  private readonly onWriteError: ((error: unknown) => void) | undefined;
  private writeTail: Promise<void>;
  private rowCount = 0;
  private rowBytes = 0;
  private writeFailure: unknown = null;
  private closed = false;

  constructor(
    readonly name: string,
    private readonly document: Y.Doc,
    options: CodeSyncStoreOptions = {},
  ) {
    assertEmptyDocument(document);
    this.createUpdateId = options.createUpdateId
      ?? (() => crypto.randomUUID());
    this.now = options.now ?? Date.now;
    this.onLocalUpdateQueued = options.onLocalUpdateQueued;
    this.onDurableLocalUpdate = options.onDurableLocalUpdate;
    this.onWriteError = options.onWriteError;
    this.database = openDatabase(name);
    this.whenReady = this.load();
    this.writeTail = this.whenReady;
    void this.whenReady.then(() => {
      if (!this.closed) this.document.on("update", this.handleDocumentUpdate);
    });
  }

  async listPendingUpdates(): Promise<readonly PendingCodeSyncUpdate[]> {
    this.assertOpen();
    await this.writeTail;
    if (this.writeFailure !== null) throw this.writeFailure;
    const database = await this.database;
    const transaction = database.transaction(OUTBOX_STORE, "readonly");
    const completed = transactionComplete(transaction);
    const rows = await requestResult(
      transaction.objectStore(OUTBOX_STORE).getAll() as IDBRequest<unknown[]>,
    );
    await completed;
    return rows
      .map(restorePending)
      .sort((left, right) => left.queueOrder - right.queueOrder)
      .map(clonePending);
  }

  async acknowledge(updateId: string): Promise<void> {
    this.assertOpen();
    await this.writeTail;
    if (this.writeFailure !== null) throw this.writeFailure;
    const database = await this.database;
    const transaction = database.transaction(OUTBOX_STORE, "readwrite");
    transaction.objectStore(OUTBOX_STORE).delete(updateId);
    await transactionComplete(transaction);
  }

  async flush(): Promise<void> {
    this.assertOpen();
    await this.writeTail;
    if (this.writeFailure !== null) throw this.writeFailure;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.document.off("update", this.handleDocumentUpdate);
    await this.writeTail;
    const database = await this.database;
    database.close();
  }

  async clearData(): Promise<void> {
    let closeError: unknown;
    try {
      await this.close();
    } catch (error) {
      closeError = error;
    }
    try {
      await deleteIndexedDb(
        indexedDB,
        this.name,
        "Unable to delete Code collaboration storage",
      );
    } catch (deleteError) {
      throw new AggregateError(
        closeError === undefined
          ? [deleteError]
          : [closeError, deleteError],
        "Code collaboration storage could not be cleared",
      );
    }
  }

  private readonly handleDocumentUpdate = (
    update: Uint8Array,
    origin: unknown,
  ): void => {
    if (this.closed || origin === CODE_SYNC_REPLAY_ORIGIN) return;
    const local = origin !== CODE_SYNC_REMOTE_ORIGIN;
    const pending = local
      ? {
          updateId: this.createUpdateId(),
          update: update.slice(),
          createdAt: this.now(),
          queueOrder: 0,
        }
      : null;
    if (local) this.onLocalUpdateQueued?.();
    const operation = this.writeTail.then(async () => {
      const durable = await this.append(update, pending);
      if (durable) this.onDurableLocalUpdate?.(clonePending(durable));
      await this.compactIfNeeded();
    });
    this.writeTail = operation.catch((error) => {
      if (this.writeFailure === null) this.writeFailure = error;
      this.onWriteError?.(error);
    });
  };

  private async load(): Promise<void> {
    const database = await this.database;
    const transaction = database.transaction(UPDATES_STORE, "readonly");
    const completed = transactionComplete(transaction);
    const rows = await requestResult(
      transaction.objectStore(UPDATES_STORE).getAll() as IDBRequest<unknown[]>,
    );
    await completed;
    const updates = rows.map(restoreBytes);
    this.rowCount = updates.length;
    this.rowBytes = updates.reduce(
      (total, update) => total + update.byteLength,
      0,
    );
    Y.transact(this.document, () => {
      for (const update of updates) {
        Y.applyUpdate(this.document, update, CODE_SYNC_REPLAY_ORIGIN);
      }
    }, CODE_SYNC_REPLAY_ORIGIN, false);
  }

  private async append(
    update: Uint8Array,
    pending: PendingCodeSyncUpdate | null,
  ): Promise<PendingCodeSyncUpdate | null> {
    const database = await this.database;
    const stores = pending
      ? [UPDATES_STORE, OUTBOX_STORE, META_STORE]
      : [UPDATES_STORE];
    const transaction = database.transaction(stores, "readwrite");
    const completed = transactionComplete(transaction);
    transaction.objectStore(UPDATES_STORE).add(copyBuffer(update));
    let durable: PendingCodeSyncUpdate | null = null;
    let callbackError: unknown;
    if (pending) {
      const metadata = transaction.objectStore(META_STORE);
      const previousRequest = metadata.get(NEXT_QUEUE_ORDER_KEY);
      previousRequest.onsuccess = () => {
        try {
          const previous = previousRequest.result;
          const queueOrder =
            typeof previous === "number"
            && Number.isSafeInteger(previous)
            && previous >= 0
              ? previous + 1
              : 1;
          durable = { ...pending, queueOrder };
          const stored: StoredPendingCodeSyncUpdate = {
            updateId: pending.updateId,
            update: copyBuffer(pending.update),
            createdAt: pending.createdAt,
            queueOrder,
          };
          transaction.objectStore(OUTBOX_STORE).put(stored);
          metadata.put(queueOrder, NEXT_QUEUE_ORDER_KEY);
        } catch (error) {
          callbackError = error;
          transaction.abort();
        }
      };
    }
    try {
      await completed;
    } catch (error) {
      if (callbackError !== undefined) throw callbackError;
      throw error;
    }
    this.rowCount += 1;
    this.rowBytes += update.byteLength;
    return durable;
  }

  private async compactIfNeeded(): Promise<void> {
    if (
      this.rowCount < COMPACTION_ROW_THRESHOLD
      && this.rowBytes < COMPACTION_BYTE_THRESHOLD
    ) return;
    const database = await this.database;
    const transaction = database.transaction(UPDATES_STORE, "readwrite");
    const completed = transactionComplete(transaction);
    const store = transaction.objectStore(UPDATES_STORE);
    const request = store.getAll() as IDBRequest<unknown[]>;
    let compactedBytes = 0;
    let callbackError: unknown;
    request.onsuccess = () => {
      try {
        const updates = request.result.map(restoreBytes);
        const merged = updates.length === 0
          ? Uint8Array.of(0, 0)
          : Y.mergeUpdates(updates);
        compactedBytes = merged.byteLength;
        store.clear();
        store.add(copyBuffer(merged));
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
    if (compactedBytes > 0) {
      this.rowCount = 1;
      this.rowBytes = compactedBytes;
    }
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("Code collaboration storage is closed");
  }
}

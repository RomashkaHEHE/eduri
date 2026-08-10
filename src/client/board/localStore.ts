import type * as Y from "yjs";
import { messageIdToHex } from "../../board/protocol/index.js";
import type {
  BoardClientPersistence,
  BoardDocumentUpdateBatch,
  BoardRecoverySignal,
  PendingBoardUpdate,
  PendingBoardRebaseResult,
} from "../../board/persistence/index.js";
import { forgetBoardNamespace, registerBoardNamespace } from "./catalog.js";
import {
  BoardDocumentIndexedDbStore,
  assertEmptyBoardDocument,
  type BoardDocumentCompactionRunner,
} from "./documentStore.js";
import { deleteIndexedDb, openIndexedDb } from "./indexedDbLifecycle.js";

export interface BoardLocalStoreIdentity {
  userId: string;
  boardId: string;
  generation: number;
  documentKey: string;
}

export interface BoardIndexedDbStoreOptions {
  readonly compactDocument?: BoardDocumentCompactionRunner;
}

const NAMESPACE_PART_PATTERN = /^[A-Za-z0-9._:-]{1,160}$/u;

function namespacePart(label: string, value: string): string {
  if (!NAMESPACE_PART_PATTERN.test(value)) {
    throw new Error(`${label} contains unsupported characters`);
  }
  return value;
}

export function boardLocalStoreName(identity: BoardLocalStoreIdentity): string {
  if (!Number.isSafeInteger(identity.generation) || identity.generation < 1) {
    throw new Error("Board generation must be a positive safe integer");
  }
  return [
    "eduri-board-v2-store3",
    namespacePart("userId", identity.userId),
    namespacePart("boardId", identity.boardId),
    String(identity.generation),
    namespacePart("documentKey", identity.documentKey),
  ].join(":");
}

const OUTBOX_DATABASE_VERSION = 1;
const PENDING_STORE = "pending-updates";
const META_STORE = "metadata";
const RECOVERY_KEY = "recovery-signal";
const LAST_DURABLE_SEQUENCE_KEY = "last-durable-sequence";
const NEXT_OUTBOX_ORDER_KEY = "next-outbox-order";
const LOCAL_CHANGE_CHANNEL_VERSION = 1;

const localStoreChannels = new Map<string, Set<LocalStoreChangeChannel>>();

class LocalStoreChangeChannel {
  private readonly listeners = new Set<() => void>();
  private readonly broadcast: BroadcastChannel | null;
  private readonly storageKey: string;
  private closed = false;

  constructor(private readonly name: string) {
    this.storageKey = `eduri-board-local-change:${name}`;
    let broadcast: BroadcastChannel | null = null;
    if (
      typeof window !== "undefined"
      && typeof globalThis.BroadcastChannel === "function"
    ) {
      try {
        broadcast = new globalThis.BroadcastChannel(this.storageKey);
        broadcast.onmessage = (event: MessageEvent<unknown>) => {
          if (
            typeof event.data === "object"
            && event.data !== null
            && "version" in event.data
            && event.data.version === LOCAL_CHANGE_CHANNEL_VERSION
          ) {
            this.emit();
          }
        };
      } catch {
        broadcast = null;
      }
    }
    this.broadcast = broadcast;

    let peers = localStoreChannels.get(name);
    if (!peers) {
      peers = new Set();
      localStoreChannels.set(name, peers);
    }
    peers.add(this);
    if (typeof window !== "undefined") {
      window.addEventListener("storage", this.handleStorage);
      window.addEventListener("online", this.handleFallbackRefresh);
      document.addEventListener("visibilitychange", this.handleVisibility);
    }
  }

  subscribe(listener: () => void): () => void {
    if (this.closed) throw new Error("Board outbox change channel is closed");
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  notify(): void {
    if (this.closed) return;
    for (const peer of localStoreChannels.get(this.name) ?? []) {
      if (peer !== this) {
        try {
          peer.emit();
        } catch {
          // Reconnect and visibility rereads remain available.
        }
      }
    }
    try {
      this.broadcast?.postMessage({
        version: LOCAL_CHANGE_CHANNEL_VERSION,
      });
    } catch {
      // localStorage and reconnect/visibility rereads remain available.
    }
    if (typeof window !== "undefined") {
      try {
        window.localStorage.setItem(
          this.storageKey,
          `${Date.now()}:${Math.random()}`,
        );
      } catch {
        // BroadcastChannel and reconnect/visibility rereads remain available.
      }
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.listeners.clear();
    try {
      this.broadcast?.close();
    } finally {
      const peers = localStoreChannels.get(this.name);
      peers?.delete(this);
      if (peers?.size === 0) localStoreChannels.delete(this.name);
      if (typeof window !== "undefined") {
        window.removeEventListener("storage", this.handleStorage);
        window.removeEventListener("online", this.handleFallbackRefresh);
        document.removeEventListener("visibilitychange", this.handleVisibility);
      }
    }
  }

  private readonly handleStorage = (event: StorageEvent): void => {
    if (event.key === this.storageKey) this.emit();
  };

  private readonly handleFallbackRefresh = (): void => {
    this.emit();
  };

  private readonly handleVisibility = (): void => {
    if (document.visibilityState === "visible") this.emit();
  };

  private emit(): void {
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {
        // Hints are best effort; listeners perform authoritative rereads.
      }
    }
  }
}

interface StoredPendingUpdate {
  messageId: string;
  generation: number;
  documentKey: string;
  update: ArrayBuffer;
  createdAt: number;
  queueOrder?: number;
}

interface StoredRecoverySignal {
  reason: BoardRecoverySignal["reason"];
  generation: number;
  documentKey: string;
  occurredAt: number;
  controlCode?: number;
  messageId?: ArrayBuffer;
  payload?: ArrayBuffer;
}

function copyArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return Uint8Array.from(bytes).buffer;
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength
    && left.every((byte, index) => byte === right[index]);
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed"));
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

function openOutboxDatabase(name: string): Promise<IDBDatabase> {
  return openIndexedDb({
    factory: indexedDB,
    name,
    version: OUTBOX_DATABASE_VERSION,
    errorMessage: "Unable to open the Board outbox database",
    upgrade: (database) => {
      if (!database.objectStoreNames.contains(PENDING_STORE)) {
        database.createObjectStore(PENDING_STORE, { keyPath: "messageId" });
      }
      if (!database.objectStoreNames.contains(META_STORE)) {
        database.createObjectStore(META_STORE);
      }
    },
  });
}

function deleteOutboxDatabase(name: string): Promise<void> {
  return deleteIndexedDb(
    indexedDB,
    name,
    "Unable to delete the Board outbox database",
  );
}

function restorePendingUpdate(stored: StoredPendingUpdate): PendingBoardUpdate {
  return {
    messageId: parseStoredMessageId(stored.messageId),
    generation: stored.generation,
    documentKey: stored.documentKey,
    update: new Uint8Array(stored.update.slice(0)),
    createdAt: stored.createdAt,
    ...(Number.isSafeInteger(stored.queueOrder) && stored.queueOrder! > 0
      ? { queueOrder: stored.queueOrder }
      : {}),
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

function parseStoredMessageId(hex: string): Uint8Array {
  if (!/^[0-9a-f]{32}$/u.test(hex)) {
    throw new Error("Stored Board message ID is invalid");
  }
  const result = new Uint8Array(16);
  for (let index = 0; index < result.length; index += 1) {
    result[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return result;
}

function restoreRecoverySignal(stored: StoredRecoverySignal): BoardRecoverySignal {
  return {
    reason: stored.reason,
    generation: stored.generation,
    documentKey: stored.documentKey,
    occurredAt: stored.occurredAt,
    controlCode: stored.controlCode,
    messageId: stored.messageId === undefined
      ? undefined
      : new Uint8Array(stored.messageId.slice(0)),
    payload: stored.payload === undefined
      ? undefined
      : new Uint8Array(stored.payload.slice(0)),
  };
}

export class BoardIndexedDbStore implements BoardClientPersistence {
  readonly name: string;
  readonly identity: Readonly<BoardLocalStoreIdentity>;
  readonly outboxName: string;

  private readonly documentStore: BoardDocumentIndexedDbStore;
  private readonly outboxDatabase: Promise<IDBDatabase>;
  private readonly localChanges: LocalStoreChangeChannel;
  private readonly registration: Promise<void>;
  private closed = false;

  constructor(
    identity: BoardLocalStoreIdentity,
    document: Y.Doc,
    options: BoardIndexedDbStoreOptions = {},
  ) {
    assertEmptyBoardDocument(document);
    this.identity = Object.freeze({ ...identity });
    this.name = boardLocalStoreName(identity);
    this.outboxName = `${this.name}:outbox`;
    this.localChanges = new LocalStoreChangeChannel(this.name);
    this.documentStore = new BoardDocumentIndexedDbStore(
      this.name,
      document,
      () => this.localChanges.notify(),
      options.compactDocument,
    );
    this.outboxDatabase = openOutboxDatabase(this.outboxName);
    this.registration = Promise.all([
      registerBoardNamespace(identity, this.name),
      registerBoardNamespace(identity, this.outboxName),
    ]).then(() => undefined);
  }

  get whenReady(): Promise<void> {
    return Promise.all([
      this.documentStore.whenReady,
      this.outboxDatabase,
      this.registration,
    ]).then(() => undefined);
  }

  async flush(): Promise<void> {
    await this.whenReady;
    await this.documentStore.flush();
  }

  async enqueuePendingUpdate(update: PendingBoardUpdate): Promise<number> {
    this.assertOpen();
    this.assertScopedUpdate(update);
    const database = await this.outboxDatabase;
    const transaction = database.transaction(
      [PENDING_STORE, META_STORE],
      "readwrite",
    );
    const completed = transactionComplete(transaction);
    const pending = transaction.objectStore(PENDING_STORE);
    const metadata = transaction.objectStore(META_STORE);
    const previousRequest = metadata.get(NEXT_OUTBOX_ORDER_KEY);
    let assignedQueueOrder = 0;
    previousRequest.onsuccess = () => {
      const previous = previousRequest.result;
      const queueOrder =
        typeof previous === "number"
        && Number.isSafeInteger(previous)
        && previous >= 0
          ? previous + 1
          : 1;
      assignedQueueOrder = queueOrder;
      const stored: StoredPendingUpdate = {
        messageId: messageIdToHex(update.messageId),
        generation: update.generation,
        documentKey: update.documentKey,
        update: copyArrayBuffer(update.update),
        createdAt: update.createdAt,
        queueOrder,
      };
      pending.put(stored);
      metadata.put(queueOrder, NEXT_OUTBOX_ORDER_KEY);
    };
    await completed;
    this.localChanges.notify();
    return assignedQueueOrder;
  }

  async rebasePendingUpdates(
    replacements: readonly PendingBoardUpdate[],
    coveredUpdates: readonly PendingBoardUpdate[],
  ): Promise<PendingBoardRebaseResult> {
    this.assertOpen();
    for (const update of replacements) this.assertScopedUpdate(update);
    for (const update of coveredUpdates) this.assertScopedUpdate(update);
    if (coveredUpdates.length === 0 && replacements.length === 0) {
      throw new Error(
        "A Board outbox rebase must cover or materialize at least one update",
      );
    }
    const coveredKeys = new Set(
      coveredUpdates.map((update) => messageIdToHex(update.messageId)),
    );
    if (coveredKeys.size !== coveredUpdates.length) {
      throw new Error("A Board outbox rebase cannot contain duplicate message IDs");
    }
    const replacementKeys = new Set(
      replacements.map((update) => messageIdToHex(update.messageId)),
    );
    if (replacementKeys.size !== replacements.length) {
      throw new Error("A Board outbox rebase cannot reuse a replacement message ID");
    }
    if ([...replacementKeys].some((key) => coveredKeys.has(key))) {
      throw new Error("Board outbox rebase replacements need new message IDs");
    }

    const database = await this.outboxDatabase;
    const transaction = database.transaction(
      [PENDING_STORE, META_STORE],
      "readwrite",
    );
    const completed = transactionComplete(transaction);
    const pending = transaction.objectStore(PENDING_STORE);
    const metadata = transaction.objectStore(META_STORE);
    const rowsRequest = pending.getAll() as IDBRequest<StoredPendingUpdate[]>;
    let result: PendingBoardRebaseResult = {
      committed: false,
      currentUpdates: [],
    };
    let callbackError: unknown;
    rowsRequest.onsuccess = () => {
      try {
        const currentUpdates = rowsRequest.result
          .map(restorePendingUpdate)
          .sort(comparePendingUpdates);
        const currentById = new Map(
          currentUpdates.map((update) => [messageIdToHex(update.messageId), update]),
        );
        const unchanged =
          currentUpdates.length === coveredUpdates.length
          && coveredUpdates.every((expected) => {
            const current = currentById.get(messageIdToHex(expected.messageId));
            return (
              current !== undefined
              && current.generation === expected.generation
              && current.documentKey === expected.documentKey
              && current.createdAt === expected.createdAt
              && current.queueOrder === expected.queueOrder
              && bytesEqual(current.update, expected.update)
            );
          });
        if (!unchanged) {
          result = { committed: false, currentUpdates };
          return;
        }

        for (const key of coveredKeys) pending.delete(key);
        if (replacements.length === 0) {
          result = { committed: true, currentUpdates: [] };
          return;
        }
        const previousRequest = metadata.get(NEXT_OUTBOX_ORDER_KEY);
        previousRequest.onsuccess = () => {
          try {
            const previous =
              typeof previousRequest.result === "number"
              && Number.isSafeInteger(previousRequest.result)
              && previousRequest.result >= 0
                ? previousRequest.result
                : 0;
            const existingOrders = currentUpdates
              .map((update) => update.queueOrder)
              .filter((order): order is number =>
                order !== undefined
                && Number.isSafeInteger(order)
                && order > 0);
            const firstOrder =
              currentUpdates.length > 0
              && existingOrders.length === currentUpdates.length
              ? Math.min(...existingOrders)
              : previous + 1;
            const durableReplacements = replacements.map((replacement, index) => {
              const queueOrder = firstOrder + index;
              const stored: StoredPendingUpdate = {
                messageId: messageIdToHex(replacement.messageId),
                generation: replacement.generation,
                documentKey: replacement.documentKey,
                update: copyArrayBuffer(replacement.update),
                createdAt: replacement.createdAt,
                queueOrder,
              };
              pending.put(stored);
              return {
                ...replacement,
                messageId: replacement.messageId.slice(),
                update: replacement.update.slice(),
                queueOrder,
              };
            });
            const lastOrder = firstOrder + replacements.length - 1;
            if (lastOrder > previous) {
              metadata.put(lastOrder, NEXT_OUTBOX_ORDER_KEY);
            }
            result = {
              committed: true,
              currentUpdates: durableReplacements.sort(comparePendingUpdates),
            };
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
    try {
      await completed;
    } catch (error) {
      if (callbackError !== undefined) throw callbackError;
      throw error;
    }
    if (result.committed) this.localChanges.notify();
    return result;
  }

  async listPendingUpdates(): Promise<readonly PendingBoardUpdate[]> {
    this.assertOpen();
    const database = await this.outboxDatabase;
    const transaction = database.transaction(PENDING_STORE, "readonly");
    const completed = transactionComplete(transaction);
    const rows = await requestResult(
      transaction.objectStore(PENDING_STORE).getAll() as IDBRequest<StoredPendingUpdate[]>,
    );
    await completed;
    return rows
      .map(restorePendingUpdate)
      .sort(comparePendingUpdates);
  }

  subscribeLocalChanges(listener: () => void): () => void {
    this.assertOpen();
    return this.localChanges.subscribe(listener);
  }

  async listDocumentUpdates(): Promise<readonly Uint8Array[]> {
    this.assertOpen();
    return this.documentStore.listUpdates();
  }

  async listDocumentUpdatesAfter(
    cursor: number,
  ): Promise<BoardDocumentUpdateBatch> {
    this.assertOpen();
    return this.documentStore.listUpdatesAfter(cursor);
  }

  async acknowledgePendingUpdate(
    messageId: Uint8Array,
    durableSequence: number,
  ): Promise<void> {
    this.assertOpen();
    if (!Number.isSafeInteger(durableSequence) || durableSequence < 1) {
      throw new TypeError("durableSequence must be a positive safe integer");
    }
    await this.documentStore.flushPendingWrites();
    const database = await this.outboxDatabase;
    const transaction = database.transaction(
      [PENDING_STORE, META_STORE],
      "readwrite",
    );
    transaction.objectStore(PENDING_STORE).delete(messageIdToHex(messageId));
    const metadata = transaction.objectStore(META_STORE);
    const previousRequest = metadata.get(LAST_DURABLE_SEQUENCE_KEY);
    previousRequest.onsuccess = () => {
      const previous = previousRequest.result;
      metadata.put(
        typeof previous === "number" && previous > durableSequence
          ? previous
          : durableSequence,
        LAST_DURABLE_SEQUENCE_KEY,
      );
    };
    await transactionComplete(transaction);
    this.localChanges.notify();
  }

  async getRecoverySignal(): Promise<BoardRecoverySignal | null> {
    this.assertOpen();
    const database = await this.outboxDatabase;
    const transaction = database.transaction(META_STORE, "readonly");
    const completed = transactionComplete(transaction);
    const stored = await requestResult(
      transaction.objectStore(META_STORE).get(RECOVERY_KEY),
    ) as StoredRecoverySignal | undefined;
    await completed;
    return stored === undefined ? null : restoreRecoverySignal(stored);
  }

  async setRecoverySignal(signal: BoardRecoverySignal): Promise<void> {
    this.assertOpen();
    if (
      signal.generation !== this.identity.generation ||
      signal.documentKey !== this.identity.documentKey
    ) {
      throw new Error("Recovery signal does not belong to this local store");
    }
    const database = await this.outboxDatabase;
    const transaction = database.transaction(META_STORE, "readwrite");
    const stored: StoredRecoverySignal = {
      reason: signal.reason,
      generation: signal.generation,
      documentKey: signal.documentKey,
      occurredAt: signal.occurredAt,
      controlCode: signal.controlCode,
      messageId: signal.messageId === undefined
        ? undefined
        : copyArrayBuffer(signal.messageId),
      payload: signal.payload === undefined
        ? undefined
        : copyArrayBuffer(signal.payload),
    };
    transaction.objectStore(META_STORE).put(stored, RECOVERY_KEY);
    await transactionComplete(transaction);
    this.localChanges.notify();
  }

  async destroy(): Promise<void> {
    this.closed = true;
    const results = await Promise.allSettled([
      this.documentStore.destroy(),
      this.outboxDatabase.then((database) => database.close()),
      Promise.resolve().then(() => this.localChanges.close()),
    ]);
    const failures = results
      .filter((result): result is PromiseRejectedResult =>
        result.status === "rejected")
      .map((result) => result.reason);
    if (failures.length > 0) {
      throw new AggregateError(
        failures,
        "Board local store could not close cleanly",
      );
    }
  }

  async clear(): Promise<void> {
    this.closed = true;
    const clearOutbox = async (): Promise<void> => {
      let closeError: unknown;
      try {
        const database = await this.outboxDatabase;
        database.close();
      } catch (error) {
        closeError = error;
      }
      try {
        await deleteOutboxDatabase(this.outboxName);
      } catch (deleteError) {
        throw new AggregateError(
          closeError === undefined
            ? [deleteError]
            : [closeError, deleteError],
          "Board outbox database could not be cleared",
        );
      }
    };
    const results = await Promise.allSettled([
      this.documentStore.clearData(),
      clearOutbox(),
      Promise.resolve().then(() => this.localChanges.close()),
    ]);
    await this.registration.catch(() => undefined);
    const namespaceResults = await Promise.allSettled([
      results[0]?.status === "fulfilled"
        ? forgetBoardNamespace(this.name)
        : Promise.resolve(),
      results[1]?.status === "fulfilled"
        ? forgetBoardNamespace(this.outboxName)
        : Promise.resolve(),
    ]);
    const failures = [...results, ...namespaceResults]
      .filter((result): result is PromiseRejectedResult =>
        result.status === "rejected")
      .map((result) => result.reason);
    if (failures.length > 0) {
      throw new AggregateError(
        failures,
        "Board local store could not be cleared completely",
      );
    }
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("Board local store is closed");
  }

  private assertScopedUpdate(update: PendingBoardUpdate): void {
    if (
      update.generation !== this.identity.generation ||
      update.documentKey !== this.identity.documentKey
    ) {
      throw new Error("Pending update does not belong to this local store");
    }
  }
}

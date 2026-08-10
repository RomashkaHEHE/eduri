import "fake-indexeddb/auto";
import * as Y from "yjs";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PendingBoardUpdate } from "../../board/persistence/index.js";
import { BOARD_PROTOCOL_LIMITS } from "../../board/protocol/index.js";
import {
  BOARD_DOCUMENT_LOG_STATS_KEY,
} from "./documentCompactionProtocol.js";
import {
  BOARD_DOCUMENT_REPLAY_ORIGIN,
  BoardDocumentIndexedDbStore,
  createBoardDocumentReplayOrigin,
  type BoardDocumentCompactionRunner,
} from "./documentStore.js";
import {
  openExistingBoardDocumentDatabase,
  runBoardDocumentCompactionPass,
} from "./documentCompaction.js";
import { BoardIndexedDbStore, boardLocalStoreName } from "./localStore";

const stores: BoardIndexedDbStore[] = [];

const compactDocumentInline: BoardDocumentCompactionRunner = async (
  job,
  options = {},
) => {
  if (options.signal?.aborted) {
    throw new DOMException("Board document compaction was aborted", "AbortError");
  }
  const database = await openExistingBoardDocumentDatabase(
    indexedDB,
    job.databaseName,
  );
  try {
    return await runBoardDocumentCompactionPass(database, job);
  } finally {
    database.close();
  }
};

const INLINE_COMPACTION = Object.freeze({
  compactDocument: compactDocumentInline,
});

function installBrowserChangeChannel(
  BroadcastChannelImplementation: new (name: string) => unknown,
) {
  const storageSetItem = vi.fn();
  vi.stubGlobal("window", Object.assign(new EventTarget(), {
    localStorage: { setItem: storageSetItem },
  }));
  vi.stubGlobal("document", Object.assign(new EventTarget(), {
    visibilityState: "visible",
  }));
  vi.stubGlobal("BroadcastChannel", BroadcastChannelImplementation);
  return { storageSetItem };
}

function identity(documentKey = "page:018f7791-d659-7811-a418-b6226ee77be8") {
  return {
    userId: "018f7791-d659-7811-a418-b6226ee77be1",
    boardId: "018f7791-d659-7811-a418-b6226ee77be2",
    generation: 1,
    documentKey,
  };
}

function readAuthoritativeOutboxAfterHint(
  store: BoardIndexedDbStore,
  matches: (updates: readonly PendingBoardUpdate[]) => boolean,
): Promise<readonly PendingBoardUpdate[]> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let readTail = Promise.resolve();
    const unsubscribe = store.subscribeLocalChanges(() => {
      readTail = readTail
        .then(async () => {
          if (settled) return;
          const updates = await store.listPendingUpdates();
          if (!matches(updates)) return;
          settled = true;
          unsubscribe();
          resolve(updates);
        })
        .catch((error: unknown) => {
          if (settled) return;
          settled = true;
          unsubscribe();
          reject(error);
        });
    });
  });
}

function adoptAuthoritativeDocumentAfterHint(
  store: BoardIndexedDbStore,
  document: Y.Doc,
  matches: () => boolean,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let readTail = Promise.resolve();
    const unsubscribe = store.subscribeLocalChanges(() => {
      readTail = readTail
        .then(async () => {
          if (settled) return;
          const updates = await store.listDocumentUpdates();
          for (const update of updates) {
            Y.applyUpdate(document, update, BOARD_DOCUMENT_REPLAY_ORIGIN);
          }
          if (!matches()) return;
          settled = true;
          unsubscribe();
          resolve();
        })
        .catch((error: unknown) => {
          if (settled) return;
          settled = true;
          unsubscribe();
          reject(error);
        });
    });
  });
}

afterEach(async () => {
  for (const store of stores.splice(0)) {
    try {
      await store.clear();
    } catch {
      await store.destroy();
    }
  }
  vi.unstubAllGlobals();
});

describe("BoardIndexedDbStore", () => {
  it("uses a generation-scoped deterministic namespace", () => {
    expect(boardLocalStoreName(identity())).toBe(
      "eduri-board-v2-store3:018f7791-d659-7811-a418-b6226ee77be1:" +
      "018f7791-d659-7811-a418-b6226ee77be2:1:" +
      "page:018f7791-d659-7811-a418-b6226ee77be8",
    );
    expect(() => boardLocalStoreName({ ...identity(), generation: 0 })).toThrow(
      "Board generation must be a positive safe integer",
    );
    expect(() => boardLocalStoreName({ ...identity(), documentKey: "../other" })).toThrow(
      "documentKey contains unsupported characters",
    );
  });

  it("closes the independent outbox when document teardown fails", async () => {
    const store = new BoardIndexedDbStore(identity(), new Y.Doc());
    stores.push(store);
    await store.whenReady;
    const internals = store as unknown as {
      documentStore: BoardDocumentIndexedDbStore;
      outboxDatabase: Promise<IDBDatabase>;
    };
    const outboxDatabase = await internals.outboxDatabase;
    const close = vi.spyOn(outboxDatabase, "close");
    vi.spyOn(internals.documentStore, "destroy")
      .mockRejectedValueOnce(new Error("simulated document close failure"));

    await expect(store.destroy()).rejects.toBeInstanceOf(AggregateError);
    expect(close).toHaveBeenCalledTimes(1);
    expect(() => store.subscribeLocalChanges(() => undefined)).toThrow(
      "Board local store is closed",
    );

    await store.clear();
  });

  it("deletes the independent outbox when document clearing fails", async () => {
    const store = new BoardIndexedDbStore(
      identity("page:018f7791-d659-7811-a418-b6226ee77be9"),
      new Y.Doc(),
    );
    stores.push(store);
    await store.whenReady;
    const internals = store as unknown as {
      documentStore: BoardDocumentIndexedDbStore;
    };
    vi.spyOn(internals.documentStore, "clearData")
      .mockRejectedValueOnce(new Error("simulated document delete failure"));

    await expect(store.clear()).rejects.toBeInstanceOf(AggregateError);
    expect((await indexedDB.databases()).map((entry) => entry.name))
      .not.toContain(store.outboxName);

    await store.clear();
  });

  it("loads locally persisted changes before a network provider exists", async () => {
    const firstDocument = new Y.Doc();
    const firstStore = new BoardIndexedDbStore(identity(), firstDocument);
    stores.push(firstStore);
    await firstStore.whenReady;

    firstDocument.getMap("manifest").set("title", "Offline algebra");
    await firstStore.flush();
    await firstStore.destroy();
    stores.splice(stores.indexOf(firstStore), 1);

    const reloadedDocument = new Y.Doc();
    const reloadedStore = new BoardIndexedDbStore(identity(), reloadedDocument);
    stores.push(reloadedStore);
    await reloadedStore.whenReady;

    expect(reloadedDocument.getMap("manifest").get("title")).toBe("Offline algebra");
  });

  it("repairs malformed derived log statistics from canonical update rows", async () => {
    const firstDocument = new Y.Doc();
    const firstStore = new BoardIndexedDbStore(identity(), firstDocument);
    stores.push(firstStore);
    await firstStore.whenReady;
    firstDocument.getMap("content").set("durable", "canonical");
    const documentStore = (
      firstStore as unknown as {
        documentStore: BoardDocumentIndexedDbStore;
      }
    ).documentStore;
    await documentStore.flushPendingWrites();
    const database = await (
      documentStore as unknown as {
        database: Promise<IDBDatabase>;
      }
    ).database;
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction("custom", "readwrite");
      transaction.objectStore("custom").put(
        { version: 1, revision: "corrupt", rowCount: -1, rowBytes: -1 },
        BOARD_DOCUMENT_LOG_STATS_KEY,
      );
      transaction.oncomplete = () => resolve();
      transaction.onabort = () => reject(transaction.error);
      transaction.onerror = () => reject(transaction.error);
    });
    await firstStore.destroy();
    stores.splice(stores.indexOf(firstStore), 1);

    const restoredDocument = new Y.Doc();
    const restoredStore = new BoardIndexedDbStore(identity(), restoredDocument);
    stores.push(restoredStore);
    await expect(restoredStore.whenReady).resolves.toBeUndefined();
    expect(restoredDocument.getMap("content").get("durable")).toBe("canonical");
  });

  it("never adopts worker statistics that were not committed to IndexedDB", async () => {
    const forgedCompaction: BoardDocumentCompactionRunner = async () => ({
      status: "noop",
      revision: Number.MAX_SAFE_INTEGER,
      rowCount: 1,
      rowBytes: 2,
      selectedRows: 1,
      selectedBytes: 2,
      replacementRows: 1,
      replacementBytes: 2,
    });
    const store = new BoardIndexedDbStore(
      identity("page:forged-compaction-stats"),
      new Y.Doc(),
      { compactDocument: forgedCompaction },
    );
    stores.push(store);
    await store.whenReady;
    const documentStore = (
      store as unknown as {
        documentStore: BoardDocumentIndexedDbStore;
      }
    ).documentStore;
    const stats = () => (
      documentStore as unknown as {
        lastKnownStats: { revision: number } | null;
      }
    ).lastKnownStats;
    const initialRevision = stats()?.revision;

    await expect(store.flush()).resolves.toBeUndefined();
    expect(stats()?.revision).toBe(initialRevision);
    expect(stats()?.revision).not.toBe(Number.MAX_SAFE_INTEGER);
  });

  it("reads only document rows appended after a durable cursor", async () => {
    const document = new Y.Doc();
    const store = new BoardIndexedDbStore(identity(), document);
    stores.push(store);
    await store.whenReady;

    const initial = await store.listDocumentUpdatesAfter(0);
    expect(initial.updates).toHaveLength(1);
    expect(initial.cursor).toBeGreaterThan(0);

    document.getMap("content").set("new-row", "A");
    const appended = await store.listDocumentUpdatesAfter(initial.cursor);
    expect(appended.updates).toHaveLength(1);
    expect(appended.cursor).toBeGreaterThan(initial.cursor);

    const repeated = await store.listDocumentUpdatesAfter(appended.cursor);
    expect(repeated).toEqual({
      updates: [],
      cursor: appended.cursor,
    });
  });

  it("keeps document cursors valid across compaction", async () => {
    const document = new Y.Doc();
    const store = new BoardIndexedDbStore(
      identity(),
      document,
      INLINE_COMPACTION,
    );
    stores.push(store);
    await store.whenReady;

    document.getMap("content").set("before-compaction", "A");
    const beforeCompaction = await store.listDocumentUpdatesAfter(0);
    expect(beforeCompaction.updates).toHaveLength(2);

    await store.flush();
    document.getMap("content").set("after-compaction", "B");
    const afterCompaction = await store.listDocumentUpdatesAfter(
      beforeCompaction.cursor,
    );

    expect(afterCompaction.updates).toHaveLength(2);
    expect(afterCompaction.cursor).toBeGreaterThan(beforeCompaction.cursor);
    const restored = new Y.Doc();
    for (const update of [
      ...beforeCompaction.updates,
      ...afterCompaction.updates,
    ]) {
      Y.applyUpdate(restored, update);
    }
    expect(restored.getMap("content").toJSON()).toEqual({
      "before-compaction": "A",
      "after-compaction": "B",
    });
    expect(Y.decodeStateVector(Y.encodeStateVector(restored))).toEqual(
      Y.decodeStateVector(Y.encodeStateVector(document)),
    );
  });

  it("compacts a large document into bounded causal history segments", async () => {
    const document = new Y.Doc();
    const store = new BoardIndexedDbStore(
      identity(),
      document,
      INLINE_COMPACTION,
    );
    stores.push(store);
    await store.whenReady;
    const content = document.getMap<unknown>("content");
    for (let index = 0; index < 17; index += 1) {
      content.set(
        `blob-${index}`,
        new Uint8Array(1024 * 1024).fill(index + 1),
      );
    }

    await store.flush();
    const updates = await store.listDocumentUpdates();
    expect(updates.length).toBeGreaterThan(1);
    expect(updates.every(
      (update) =>
        update.byteLength <= BOARD_PROTOCOL_LIMITS.maxUpdateBytes,
    )).toBe(true);

    const restored = new Y.Doc();
    for (const update of updates) {
      Y.applyUpdate(restored, update);
      expect(restored.store.pendingStructs).toBeNull();
      expect(restored.store.pendingDs).toBeNull();
    }
    expect(Y.decodeStateVector(Y.encodeStateVector(restored))).toEqual(
      Y.decodeStateVector(Y.encodeStateVector(document)),
    );
  });

  it("preserves concurrent document writes from multiple tabs during compaction", async () => {
    const firstDocument = new Y.Doc();
    const secondDocument = new Y.Doc();
    const firstStore = new BoardIndexedDbStore(
      identity(),
      firstDocument,
      INLINE_COMPACTION,
    );
    const secondStore = new BoardIndexedDbStore(
      identity(),
      secondDocument,
      INLINE_COMPACTION,
    );
    stores.push(firstStore, secondStore);
    await Promise.all([firstStore.whenReady, secondStore.whenReady]);
    firstDocument.getMap("content").set("first-tab", "A");
    secondDocument.getMap("content").set("second-tab", "B");
    await Promise.all([firstStore.flush(), secondStore.flush()]);
    await Promise.all([firstStore.destroy(), secondStore.destroy()]);
    stores.splice(stores.indexOf(firstStore), 1);
    stores.splice(stores.indexOf(secondStore), 1);

    const reloadedDocument = new Y.Doc();
    const reloadedStore = new BoardIndexedDbStore(identity(), reloadedDocument);
    stores.push(reloadedStore);
    await reloadedStore.whenReady;
    expect(reloadedDocument.getMap("content").toJSON()).toEqual({
      "first-tab": "A",
      "second-tab": "B",
    });
  });

  it("uses shared log statistics for threshold scheduling and no-op cooldown", async () => {
    const irreducibleCompaction = vi.fn<BoardDocumentCompactionRunner>(
      async (job, options = {}) => {
        if (options.signal?.aborted) {
          throw new DOMException(
            "Board document compaction was aborted",
            "AbortError",
          );
        }
        const database = await openExistingBoardDocumentDatabase(
          indexedDB,
          job.databaseName,
        );
        try {
          return await runBoardDocumentCompactionPass(database, job, {
            mergeUpdates: (updates) => updates,
          });
        } finally {
          database.close();
        }
      },
    );
    const firstDocument = new Y.Doc();
    const secondDocument = new Y.Doc();
    const firstStore = new BoardIndexedDbStore(
      identity(),
      firstDocument,
      { compactDocument: irreducibleCompaction },
    );
    const secondStore = new BoardIndexedDbStore(
      identity(),
      secondDocument,
      { compactDocument: irreducibleCompaction },
    );
    stores.push(firstStore, secondStore);
    await Promise.all([firstStore.whenReady, secondStore.whenReady]);
    const firstDocumentStore = (
      firstStore as unknown as {
        documentStore: BoardDocumentIndexedDbStore;
      }
    ).documentStore;
    const secondDocumentStore = (
      secondStore as unknown as {
        documentStore: BoardDocumentIndexedDbStore;
      }
    ).documentStore;
    const compactionTimer = (store: BoardDocumentIndexedDbStore) =>
      (
        store as unknown as {
          compactionTimer: ReturnType<typeof setTimeout> | null;
        }
      ).compactionTimer;

    const firstContent = firstDocument.getMap<number>("content");
    for (let index = 0; index < 249; index += 1) {
      firstContent.set(`first-${index}`, index);
    }
    await firstDocumentStore.flushPendingWrites();
    expect(compactionTimer(firstDocumentStore)).toBeNull();

    const secondContent = secondDocument.getMap<number>("content");
    for (let index = 0; index < 250; index += 1) {
      secondContent.set(`second-${index}`, index);
    }
    await secondDocumentStore.flushPendingWrites();
    expect(compactionTimer(secondDocumentStore)).not.toBeNull();

    await secondDocumentStore.flush();
    expect(irreducibleCompaction).toHaveBeenCalledTimes(1);
    secondContent.set("after-noop", 1);
    await secondDocumentStore.flushPendingWrites();
    expect(compactionTimer(secondDocumentStore)).toBeNull();
  });

  it("keeps newer append statistics and reruns after an older worker response", async () => {
    let announceFirstCommit: (() => void) | undefined;
    let releaseFirstResponse: (() => void) | undefined;
    let announceSecondRun: (() => void) | undefined;
    const firstCommitted = new Promise<void>((resolve) => {
      announceFirstCommit = resolve;
    });
    const firstResponseGate = new Promise<void>((resolve) => {
      releaseFirstResponse = resolve;
    });
    const secondRun = new Promise<void>((resolve) => {
      announceSecondRun = resolve;
    });
    let callCount = 0;
    let firstResultRevision = 0;
    const delayedCompaction: BoardDocumentCompactionRunner = async (
      job,
      options = {},
    ) => {
      if (options.signal?.aborted) {
        throw new DOMException(
          "Board document compaction was aborted",
          "AbortError",
        );
      }
      callCount += 1;
      if (callCount === 2) announceSecondRun?.();
      const database = await openExistingBoardDocumentDatabase(
        indexedDB,
        job.databaseName,
      );
      const result = await runBoardDocumentCompactionPass(database, job)
        .finally(() => database.close());
      if (callCount === 1) {
        firstResultRevision = result.revision;
        announceFirstCommit?.();
        await firstResponseGate;
      }
      return result;
    };
    const document = new Y.Doc();
    const store = new BoardIndexedDbStore(
      identity("page:late-compaction-response"),
      document,
      { compactDocument: delayedCompaction },
    );
    stores.push(store);
    await store.whenReady;
    const documentStore = (
      store as unknown as {
        documentStore: BoardDocumentIndexedDbStore;
      }
    ).documentStore;
    document.getMap<number>("content").set("seed", 1);
    const firstFlush = store.flush();

    await firstCommitted;
    const content = document.getMap<number>("content");
    for (let index = 0; index < 499; index += 1) {
      content.set(`late-${index}`, index);
    }
    await documentStore.flushPendingWrites();
    await new Promise((resolve) => setTimeout(resolve, 1_050));
    expect(
      (
        documentStore as unknown as {
          compactionRerunRequested: boolean;
        }
      ).compactionRerunRequested,
    ).toBe(true);

    releaseFirstResponse?.();
    await firstFlush;
    await secondRun;
    const secondTask = (
      documentStore as unknown as {
        compactionTask: Promise<void> | null;
      }
    ).compactionTask;
    await secondTask;
    const lastKnownStats = (
      documentStore as unknown as {
        lastKnownStats: { revision: number; rowCount: number } | null;
      }
    ).lastKnownStats;
    expect(callCount).toBe(2);
    expect(lastKnownStats?.revision).toBeGreaterThan(firstResultRevision);
    expect(lastKnownStats?.rowCount).toBeLessThan(500);
  });

  it("aborts and awaits active document compaction during teardown", async () => {
    let announceStart: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      announceStart = resolve;
    });
    let observedSignal: AbortSignal | undefined;
    const blockingCompaction: BoardDocumentCompactionRunner = (
      _job,
      options = {},
    ) => new Promise((_resolve, reject) => {
      observedSignal = options.signal;
      announceStart?.();
      options.signal?.addEventListener("abort", () => {
        reject(new DOMException(
          "Board document compaction was aborted",
          "AbortError",
        ));
      }, { once: true });
    });
    const store = new BoardIndexedDbStore(
      identity("page:teardown-compaction"),
      new Y.Doc(),
      { compactDocument: blockingCompaction },
    );
    stores.push(store);
    await store.whenReady;
    const flushing = store.flush().then(
      () => null,
      (error: unknown) => error,
    );

    await started;
    await expect(store.destroy()).resolves.toBeUndefined();
    expect(observedSignal?.aborted).toBe(true);
    await expect(flushing).resolves.toBeInstanceOf(Error);
  });

  it("isolates a stale generation from a recreated board", async () => {
    const oldDocument = new Y.Doc();
    const oldStore = new BoardIndexedDbStore(identity(), oldDocument);
    stores.push(oldStore);
    await oldStore.whenReady;
    oldDocument.getMap("manifest").set("value", "stale");
    await oldStore.flush();

    const newDocument = new Y.Doc();
    const newStore = new BoardIndexedDbStore({ ...identity(), generation: 2 }, newDocument);
    stores.push(newStore);
    await newStore.whenReady;

    expect(newDocument.getMap("manifest").has("value")).toBe(false);
  });

  it("keeps pending updates and their message IDs across a restart until durable ACK", async () => {
    const firstStore = new BoardIndexedDbStore(identity(), new Y.Doc());
    stores.push(firstStore);
    await firstStore.whenReady;
    const pending = {
      messageId: new Uint8Array(16).fill(7),
      generation: 1,
      documentKey: identity().documentKey,
      update: new Uint8Array([1, 2, 3, 4]),
      createdAt: 123,
    };
    await expect(firstStore.enqueuePendingUpdate(pending)).resolves.toBe(1);
    await firstStore.destroy();
    stores.splice(stores.indexOf(firstStore), 1);

    const reopened = new BoardIndexedDbStore(identity(), new Y.Doc());
    stores.push(reopened);
    await reopened.whenReady;
    await expect(reopened.listPendingUpdates()).resolves.toEqual([
      { ...pending, queueOrder: 1 },
    ]);

    await reopened.acknowledgePendingUpdate(pending.messageId, 42);
    await expect(reopened.listPendingUpdates()).resolves.toEqual([]);
  });

  it("durably captures a pending successor resolved by document replay before ACK", async () => {
    const documentKey = "page:pending-replay-durability";
    const replayIdentity = identity(documentKey);
    const historyDocument = new Y.Doc();
    const recoveringDocument = new Y.Doc();
    const historyStore = new BoardIndexedDbStore(replayIdentity, historyDocument);
    const recoveringStore = new BoardIndexedDbStore(
      replayIdentity,
      recoveringDocument,
    );
    stores.push(historyStore, recoveringStore);
    await Promise.all([historyStore.whenReady, recoveringStore.whenReady]);

    const source = new Y.Doc();
    const sourceUpdates: Uint8Array[] = [];
    source.on("update", (update: Uint8Array) => {
      sourceUpdates.push(update.slice());
    });
    const sourceText = source.getText("content");
    sourceText.insert(0, "A");
    sourceText.insert(1, "B");
    const [predecessor, successor] = sourceUpdates;
    if (!predecessor || !successor) {
      throw new Error("Expected causally dependent source updates");
    }

    Y.applyUpdate(historyDocument, predecessor);
    const durableHistory = await historyStore.listDocumentUpdates();
    const pending = {
      messageId: new Uint8Array(16).fill(61),
      generation: replayIdentity.generation,
      documentKey,
      update: successor,
      createdAt: 610,
    };
    await recoveringStore.enqueuePendingUpdate(pending);
    Y.applyUpdate(recoveringDocument, successor, { type: "outbox-replay-test" });
    expect(recoveringDocument.store.pendingStructs).not.toBeNull();
    const rowCountBeforeReplay = durableHistory.length;

    for (const update of durableHistory) {
      Y.applyUpdate(
        recoveringDocument,
        update,
        createBoardDocumentReplayOrigin(recoveringDocument),
      );
    }
    expect(recoveringDocument.getText("content").toString()).toBe("AB");
    expect(recoveringDocument.store.pendingStructs).toBeNull();

    await recoveringStore.acknowledgePendingUpdate(pending.messageId, 1);
    await expect(recoveringStore.listPendingUpdates()).resolves.toEqual([]);
    expect(await recoveringStore.listDocumentUpdates()).toHaveLength(
      rowCountBeforeReplay + 1,
    );
    await Promise.all([historyStore.destroy(), recoveringStore.destroy()]);
    stores.splice(stores.indexOf(historyStore), 1);
    stores.splice(stores.indexOf(recoveringStore), 1);

    const reloadedDocument = new Y.Doc();
    const reloadedStore = new BoardIndexedDbStore(
      replayIdentity,
      reloadedDocument,
    );
    stores.push(reloadedStore);
    await reloadedStore.whenReady;
    expect(reloadedDocument.getText("content").toString()).toBe("AB");
    expect(reloadedDocument.store.pendingStructs).toBeNull();
  });

  it("does not append a clean document replay to the durable log", async () => {
    const replayIdentity = identity("page:clean-replay");
    const writerDocument = new Y.Doc();
    const readerDocument = new Y.Doc();
    const writerStore = new BoardIndexedDbStore(replayIdentity, writerDocument);
    const readerStore = new BoardIndexedDbStore(replayIdentity, readerDocument);
    stores.push(writerStore, readerStore);
    await Promise.all([writerStore.whenReady, readerStore.whenReady]);

    writerDocument.getMap("content").set("clean", "durable");
    const durableHistory = await writerStore.listDocumentUpdates();
    for (const update of durableHistory) {
      Y.applyUpdate(
        readerDocument,
        update,
        createBoardDocumentReplayOrigin(readerDocument),
      );
    }

    expect(readerDocument.getMap("content").get("clean")).toBe("durable");
    await expect(readerStore.listDocumentUpdates()).resolves.toHaveLength(
      durableHistory.length,
    );
  });

  it("hints sibling stores to reread authoritative document and outbox state", async () => {
    const firstDocument = new Y.Doc();
    const secondDocument = new Y.Doc();
    const firstStore = new BoardIndexedDbStore(identity(), firstDocument);
    const secondStore = new BoardIndexedDbStore(identity(), secondDocument);
    stores.push(firstStore, secondStore);
    await Promise.all([firstStore.whenReady, secondStore.whenReady]);
    const enqueued = {
      messageId: new Uint8Array(16).fill(41),
      generation: 1,
      documentKey: identity().documentKey,
      update: new Uint8Array([1, 2]),
      createdAt: 400,
    };

    const enqueueReread = readAuthoritativeOutboxAfterHint(
      secondStore,
      (updates) => updates.length === 1 && updates[0].messageId[0] === 41,
    );
    await expect(firstStore.enqueuePendingUpdate(enqueued)).resolves.toBe(1);
    await expect(enqueueReread).resolves.toEqual([
      { ...enqueued, queueOrder: 1 },
    ]);

    const acknowledgeReread = readAuthoritativeOutboxAfterHint(
      firstStore,
      (updates) => updates.length === 0,
    );
    await secondStore.acknowledgePendingUpdate(enqueued.messageId, 10);
    await expect(acknowledgeReread).resolves.toEqual([]);

    const firstCovered = {
      ...enqueued,
      messageId: new Uint8Array(16).fill(42),
      update: new Uint8Array([3]),
      createdAt: 401,
    };
    const secondCovered = {
      ...enqueued,
      messageId: new Uint8Array(16).fill(43),
      update: new Uint8Array([4]),
      createdAt: 402,
    };
    await firstStore.enqueuePendingUpdate(firstCovered);
    await firstStore.enqueuePendingUpdate(secondCovered);
    const covered = await secondStore.listPendingUpdates();
    expect(covered).toEqual([
      { ...firstCovered, queueOrder: 2 },
      { ...secondCovered, queueOrder: 3 },
    ]);
    const replacement = {
      ...enqueued,
      messageId: new Uint8Array(16).fill(44),
      update: new Uint8Array([5, 6]),
      createdAt: 403,
    };
    const durableReplacement = { ...replacement, queueOrder: 2 };

    const rebaseReread = readAuthoritativeOutboxAfterHint(
      firstStore,
      (updates) => updates.length === 1 && updates[0].messageId[0] === 44,
    );
    await expect(secondStore.rebasePendingUpdates(
      [replacement],
      covered,
    )).resolves.toEqual({
      committed: true,
      currentUpdates: [durableReplacement],
    });
    await expect(rebaseReread).resolves.toEqual([durableReplacement]);

    const documentReread = adoptAuthoritativeDocumentAfterHint(
      secondStore,
      secondDocument,
      () => secondDocument.getMap("content").get("history-only") === "durable",
    );
    firstDocument.getMap("content").set("history-only", "durable");
    await firstStore.flush();
    await expect(documentReread).resolves.toBeUndefined();
  });

  it("uses in-process and storage fallbacks when BroadcastChannel construction fails", async () => {
    class ThrowingBroadcastChannel {
      constructor(_name: string) {
        throw new Error("BroadcastChannel is unavailable");
      }
    }
    const { storageSetItem } = installBrowserChangeChannel(
      ThrowingBroadcastChannel,
    );
    const firstStore = new BoardIndexedDbStore(identity(), new Y.Doc());
    const secondStore = new BoardIndexedDbStore(identity(), new Y.Doc());
    stores.push(firstStore, secondStore);
    await Promise.all([firstStore.whenReady, secondStore.whenReady]);
    const listener = vi.fn();
    const unsubscribe = secondStore.subscribeLocalChanges(listener);

    await expect(firstStore.enqueuePendingUpdate({
      messageId: new Uint8Array(16).fill(45),
      generation: 1,
      documentKey: identity().documentKey,
      update: new Uint8Array([7, 8]),
      createdAt: 404,
    })).resolves.toBe(1);

    expect(listener).toHaveBeenCalledTimes(1);
    expect(storageSetItem).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  it("uses in-process and storage fallbacks when BroadcastChannel postMessage fails", async () => {
    class ThrowingPostMessageBroadcastChannel {
      onmessage: ((event: MessageEvent<unknown>) => void) | null = null;

      constructor(readonly name: string) {}

      postMessage(): never {
        throw new Error("BroadcastChannel delivery failed");
      }

      close(): void {}
    }
    const { storageSetItem } = installBrowserChangeChannel(
      ThrowingPostMessageBroadcastChannel,
    );
    const firstStore = new BoardIndexedDbStore(identity(), new Y.Doc());
    const secondStore = new BoardIndexedDbStore(identity(), new Y.Doc());
    stores.push(firstStore, secondStore);
    await Promise.all([firstStore.whenReady, secondStore.whenReady]);
    const listener = vi.fn();
    const unsubscribe = secondStore.subscribeLocalChanges(listener);

    await expect(firstStore.enqueuePendingUpdate({
      messageId: new Uint8Array(16).fill(46),
      generation: 1,
      documentKey: identity().documentKey,
      update: new Uint8Array([9, 10]),
      createdAt: 405,
    })).resolves.toBe(1);

    expect(listener).toHaveBeenCalledTimes(1);
    expect(storageSetItem).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  it("persists and hints a generation-scoped recovery signal without deleting pending work", async () => {
    const store = new BoardIndexedDbStore(identity(), new Y.Doc());
    const peer = new BoardIndexedDbStore(identity(), new Y.Doc());
    stores.push(store, peer);
    await Promise.all([store.whenReady, peer.whenReady]);
    const pending = {
      messageId: new Uint8Array(16).fill(9),
      generation: 1,
      documentKey: identity().documentKey,
      update: new Uint8Array([5, 6, 7]),
      createdAt: 456,
    };
    const recovery = {
      reason: "permission-revoked" as const,
      generation: 1,
      documentKey: identity().documentKey,
      occurredAt: 789,
      controlCode: 1,
      messageId: pending.messageId,
      payload: new Uint8Array([10, 11]),
    };
    const peerRecovery = new Promise<typeof recovery>((resolve, reject) => {
      const unsubscribe = peer.subscribeLocalChanges(() => {
        void peer.getRecoverySignal().then((signal) => {
          if (!signal) return;
          unsubscribe();
          resolve(signal as typeof recovery);
        }, (error: unknown) => {
          unsubscribe();
          reject(error);
        });
      });
    });
    await expect(store.enqueuePendingUpdate(pending)).resolves.toBe(1);
    await store.setRecoverySignal(recovery);

    await expect(store.getRecoverySignal()).resolves.toEqual(recovery);
    await expect(peerRecovery).resolves.toEqual(recovery);
    await expect(store.listPendingUpdates()).resolves.toEqual([
      { ...pending, queueOrder: 1 },
    ]);
  });

  it("allocates a durable causal order when timestamps collide", async () => {
    const store = new BoardIndexedDbStore(identity(), new Y.Doc());
    stores.push(store);
    await store.whenReady;
    const first = {
      messageId: new Uint8Array(16).fill(250),
      generation: 1,
      documentKey: identity().documentKey,
      update: new Uint8Array([1]),
      createdAt: 123,
    };
    const second = {
      ...first,
      messageId: new Uint8Array(16).fill(1),
      update: new Uint8Array([2]),
    };

    await expect(store.enqueuePendingUpdate(first)).resolves.toBe(1);
    await expect(store.enqueuePendingUpdate(second)).resolves.toBe(2);
    const pending = await store.listPendingUpdates();
    expect(pending.map((update) => ({
      messageId: update.messageId[0],
      queueOrder: update.queueOrder,
    }))).toEqual([
      { messageId: 250, queueOrder: 1 },
      { messageId: 1, queueOrder: 2 },
    ]);
  });

  it("atomically rebases covered updates into one restart-safe outbox row", async () => {
    const firstStore = new BoardIndexedDbStore(identity(), new Y.Doc());
    stores.push(firstStore);
    await firstStore.whenReady;
    const first = {
      messageId: new Uint8Array(16).fill(11),
      generation: 1,
      documentKey: identity().documentKey,
      update: new Uint8Array([1]),
      createdAt: 100,
    };
    const second = {
      ...first,
      messageId: new Uint8Array(16).fill(12),
      update: new Uint8Array([2]),
      createdAt: 101,
    };
    await firstStore.enqueuePendingUpdate(first);
    await firstStore.enqueuePendingUpdate(second);
    const replacement = {
      ...first,
      messageId: new Uint8Array(16).fill(13),
      update: new Uint8Array([3, 4]),
      queueOrder: 1,
    };

    await expect(firstStore.rebasePendingUpdates(
      [replacement],
      [
        { ...first, queueOrder: 1 },
        { ...second, queueOrder: 2 },
      ],
    )).resolves.toEqual({
      committed: true,
      currentUpdates: [replacement],
    });
    await firstStore.destroy();
    stores.splice(stores.indexOf(firstStore), 1);

    const reopened = new BoardIndexedDbStore(identity(), new Y.Doc());
    stores.push(reopened);
    await reopened.whenReady;
    await expect(reopened.listPendingUpdates()).resolves.toEqual([replacement]);

    const later = {
      ...first,
      messageId: new Uint8Array(16).fill(14),
      update: new Uint8Array([5]),
      createdAt: 102,
    };
    await expect(reopened.enqueuePendingUpdate(later)).resolves.toBe(3);
    await expect(reopened.listPendingUpdates()).resolves.toEqual([
      replacement,
      { ...later, queueOrder: 3 },
    ]);
  });

  it("atomically materializes document-history deltas into an empty outbox", async () => {
    const store = new BoardIndexedDbStore(identity(), new Y.Doc());
    stores.push(store);
    await store.whenReady;
    const replacement = {
      messageId: new Uint8Array(16).fill(15),
      generation: 1,
      documentKey: identity().documentKey,
      update: new Uint8Array([6, 7]),
      createdAt: 150,
    };

    await expect(store.rebasePendingUpdates(
      [replacement],
      [],
    )).resolves.toEqual({
      committed: true,
      currentUpdates: [{ ...replacement, queueOrder: 1 }],
    });
    await expect(store.listPendingUpdates()).resolves.toEqual([
      { ...replacement, queueOrder: 1 },
    ]);
  });

  it("rejects a stale cross-tab rebase without overwriting the winner", async () => {
    const firstStore = new BoardIndexedDbStore(identity(), new Y.Doc());
    const secondStore = new BoardIndexedDbStore(identity(), new Y.Doc());
    stores.push(firstStore, secondStore);
    await Promise.all([firstStore.whenReady, secondStore.whenReady]);
    const original = {
      messageId: new Uint8Array(16).fill(21),
      generation: 1,
      documentKey: identity().documentKey,
      update: new Uint8Array([1, 2]),
      createdAt: 200,
      queueOrder: 1,
    };
    await firstStore.enqueuePendingUpdate(original);
    const covered = await secondStore.listPendingUpdates();
    const winner = {
      ...original,
      messageId: new Uint8Array(16).fill(22),
      update: new Uint8Array([3]),
    };
    const stale = {
      ...original,
      messageId: new Uint8Array(16).fill(23),
      update: new Uint8Array([4]),
    };

    await expect(firstStore.rebasePendingUpdates(
      [winner],
      covered,
    )).resolves.toEqual({
      committed: true,
      currentUpdates: [winner],
    });
    const staleResult = await secondStore.rebasePendingUpdates([stale], covered);
    expect(staleResult).toEqual({
      committed: false,
      currentUpdates: [winner],
    });
    await expect(secondStore.listPendingUpdates()).resolves.toEqual([winner]);
  });

  it("rejects a rebase when a concurrent row appears after its snapshot", async () => {
    const store = new BoardIndexedDbStore(identity(), new Y.Doc());
    stores.push(store);
    await store.whenReady;
    const original = {
      messageId: new Uint8Array(16).fill(31),
      generation: 1,
      documentKey: identity().documentKey,
      update: new Uint8Array([1]),
      createdAt: 300,
    };
    const concurrent = {
      ...original,
      messageId: new Uint8Array(16).fill(32),
      update: new Uint8Array([2]),
      createdAt: 301,
    };
    await store.enqueuePendingUpdate(original);
    const [covered] = await store.listPendingUpdates();
    await store.enqueuePendingUpdate(concurrent);
    const replacement = {
      ...covered,
      messageId: new Uint8Array(16).fill(33),
      update: new Uint8Array([3]),
    };

    await expect(store.rebasePendingUpdates(
      [replacement],
      [covered],
    )).resolves.toEqual({
      committed: false,
      currentUpdates: [
        covered,
        { ...concurrent, queueOrder: 2 },
      ],
    });
  });
});

describe("BoardDocumentIndexedDbStore", () => {
  it("rejects a nonempty Y.Doc before opening persistence", () => {
    const document = new Y.Doc();
    document.getMap("content").set("existing", "local state");

    expect(() => new BoardDocumentIndexedDbStore(
      "nonempty-document-must-not-open",
      document,
    )).toThrow("Board document storage requires an empty Y.Doc before hydration");
    expect(() => new BoardIndexedDbStore(
      identity("page:nonempty-local-store"),
      document,
    )).toThrow("Board document storage requires an empty Y.Doc before hydration");
  });
});

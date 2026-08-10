import "fake-indexeddb/auto";
import { randomUUID } from "node:crypto";
import * as Y from "yjs";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  runBoardDocumentCompactionPass,
} from "./documentCompaction.js";
import {
  compactBoardDocumentInWorker,
} from "./documentCompactionClient.js";
import {
  BOARD_DOCUMENT_COMPACTION_WORKER_PROTOCOL,
  BOARD_DOCUMENT_LOG_STATS_KEY,
  createBoardDocumentLogStats,
  restoreBoardDocumentLogStats,
} from "./documentCompactionProtocol.js";

const UPDATES_STORE = "updates";
const SIZES_STORE = "update-sizes";
const METADATA_STORE = "metadata";
const databases: IDBDatabase[] = [];
const databaseNames = new Set<string>();

interface StoredRow {
  readonly key: number;
  readonly update: Uint8Array;
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
      transaction.error ?? new Error("IndexedDB transaction aborted"),
    );
    transaction.onerror = () => reject(
      transaction.error ?? new Error("IndexedDB transaction failed"),
    );
  });
}

function restoreUpdate(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value.slice();
  if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));
  throw new Error("Unexpected test update value");
}

async function createDatabase(
  updates: readonly Uint8Array[],
): Promise<IDBDatabase> {
  const name = `board-document-compaction:${randomUUID()}`;
  databaseNames.add(name);
  const database = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(name, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore(UPDATES_STORE, { autoIncrement: true });
      request.result.createObjectStore(SIZES_STORE);
      request.result.createObjectStore(METADATA_STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  databases.push(database);
  const transaction = database.transaction(
    [UPDATES_STORE, SIZES_STORE, METADATA_STORE],
    "readwrite",
  );
  const updateStore = transaction.objectStore(UPDATES_STORE);
  const sizeStore = transaction.objectStore(SIZES_STORE);
  for (const update of updates) {
    const request = updateStore.add(update);
    request.onsuccess = () => {
      sizeStore.put(update.byteLength, request.result);
    };
  }
  transaction.objectStore(METADATA_STORE).put(
    createBoardDocumentLogStats(
      updates.length,
      updates.reduce((total, update) => total + update.byteLength, 0),
    ),
    BOARD_DOCUMENT_LOG_STATS_KEY,
  );
  await transactionComplete(transaction);
  return database;
}

async function appendUpdate(
  database: IDBDatabase,
  update: Uint8Array,
): Promise<number> {
  const transaction = database.transaction(
    [UPDATES_STORE, SIZES_STORE, METADATA_STORE],
    "readwrite",
  );
  const completed = transactionComplete(transaction);
  const metadata = transaction.objectStore(METADATA_STORE);
  const statsRequest = metadata.get(BOARD_DOCUMENT_LOG_STATS_KEY);
  let key: IDBValidKey | undefined;
  let callbackError: unknown;
  statsRequest.onsuccess = () => {
    try {
      const stats = restoreBoardDocumentLogStats(statsRequest.result);
      const addRequest = transaction.objectStore(UPDATES_STORE).add(update);
      addRequest.onsuccess = () => {
        key = addRequest.result;
        transaction
          .objectStore(SIZES_STORE)
          .put(update.byteLength, addRequest.result);
      };
      metadata.put(
        createBoardDocumentLogStats(
          stats.rowCount + 1,
          stats.rowBytes + update.byteLength,
          stats.revision + 1,
        ),
        BOARD_DOCUMENT_LOG_STATS_KEY,
      );
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
  if (typeof key !== "number") throw new Error("Expected a numeric test key");
  return key;
}

async function readRows(database: IDBDatabase): Promise<readonly StoredRow[]> {
  const transaction = database.transaction(UPDATES_STORE, "readonly");
  const completed = transactionComplete(transaction);
  const store = transaction.objectStore(UPDATES_STORE);
  const [keys, values] = await Promise.all([
    requestResult(store.getAllKeys()),
    requestResult(store.getAll() as IDBRequest<unknown[]>),
  ]);
  await completed;
  return values.map((value, index) => {
    const key = keys[index];
    if (typeof key !== "number") throw new Error("Expected a numeric test key");
    return { key, update: restoreUpdate(value) };
  });
}

async function readStoredSizes(
  database: IDBDatabase,
): Promise<readonly (readonly [number, number])[]> {
  const transaction = database.transaction(SIZES_STORE, "readonly");
  const completed = transactionComplete(transaction);
  const store = transaction.objectStore(SIZES_STORE);
  const [keys, values] = await Promise.all([
    requestResult(store.getAllKeys()),
    requestResult(store.getAll() as IDBRequest<unknown[]>),
  ]);
  await completed;
  return values.map((value, index) => {
    const key = keys[index];
    if (
      typeof key !== "number"
      || typeof value !== "number"
    ) {
      throw new Error("Expected numeric update-size metadata");
    }
    return [key, value] as const;
  });
}

function captureUpdates(
  count: number,
  payloadBytes = 128,
): {
  readonly document: Y.Doc;
  readonly updates: readonly Uint8Array[];
} {
  const document = new Y.Doc();
  const updates: Uint8Array[] = [];
  document.on("update", (update: Uint8Array) => updates.push(update.slice()));
  const content = document.getMap<string>("content");
  for (let index = 0; index < count; index += 1) {
    content.set(
      `entry-${index}`,
      `${String(index).padStart(4, "0")}:${String.fromCharCode(65 + index % 26)}`
        .repeat(payloadBytes),
    );
  }
  return { document, updates };
}

function restoreDocument(rows: readonly StoredRow[]): Y.Doc {
  const restored = new Y.Doc();
  for (const row of rows) {
    Y.applyUpdate(restored, row.update);
    expect(restored.store.pendingStructs).toBeNull();
    expect(restored.store.pendingDs).toBeNull();
  }
  return restored;
}

function expectSameState(left: Y.Doc, right: Y.Doc): void {
  expect(Y.decodeStateVector(Y.encodeStateVector(left))).toEqual(
    Y.decodeStateVector(Y.encodeStateVector(right)),
  );
}

afterEach(async () => {
  for (const database of databases.splice(0)) database.close();
  for (const name of databaseNames) {
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.deleteDatabase(name);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }
  databaseNames.clear();
  vi.restoreAllMocks();
});

describe("worker-side Board document suffix compaction", () => {
  it("reads the newest bounded suffix in reverse and appends replacements with newer keys", async () => {
    const source = captureUpdates(6);
    const database = await createDatabase(source.updates);
    const getAll = vi.spyOn(IDBObjectStore.prototype, "getAll");
    const getAllKeys = vi.spyOn(IDBObjectStore.prototype, "getAllKeys");

    const result = await runBoardDocumentCompactionPass(database, {
      updatesStoreName: UPDATES_STORE,
      sizesStoreName: SIZES_STORE,
      metadataStoreName: METADATA_STORE,
      limits: {
        maxRows: 3,
        maxBytes: 1024 * 1024,
        maxUpdateBytes: 1024 * 1024,
      },
    });

    expect(result).toMatchObject({
      status: "compacted",
      rowCount: 4,
      selectedRows: 3,
      replacementRows: 1,
    });
    expect(getAll).not.toHaveBeenCalled();
    expect(getAllKeys).not.toHaveBeenCalled();
    const rows = await readRows(database);
    expect(rows.map((row) => row.key)).toEqual([1, 2, 3, 7]);
    expect(await readStoredSizes(database)).toEqual(
      rows.map((row) => [row.key, row.update.byteLength]),
    );
    expect(rows.slice(0, 3).map((row) => row.update)).toEqual(
      source.updates.slice(0, 3),
    );
    expectSameState(restoreDocument(rows), source.document);
  });

  it("stops the reverse scan at the byte budget", async () => {
    const source = captureUpdates(5, 256);
    const database = await createDatabase(source.updates);
    const lastTwo = source.updates.slice(-2);
    const byteBudget = lastTwo.reduce(
      (total, update) => total + update.byteLength,
      0,
    );

    const result = await runBoardDocumentCompactionPass(database, {
      updatesStoreName: UPDATES_STORE,
      sizesStoreName: SIZES_STORE,
      metadataStoreName: METADATA_STORE,
      limits: {
        maxRows: 10,
        maxBytes: byteBudget,
        maxUpdateBytes: byteBudget,
      },
    });

    expect(result).toMatchObject({
      status: "compacted",
      rowCount: 4,
      selectedRows: 2,
      selectedBytes: byteBudget,
      replacementRows: 1,
    });
    const rows = await readRows(database);
    expect(rows.map((row) => row.key)).toEqual([1, 2, 3, 6]);
    expectSameState(restoreDocument(rows), source.document);
  });

  it("checks the size index before materializing an out-of-budget lookahead", async () => {
    const source = new Y.Doc();
    const sourceUpdates: Uint8Array[] = [];
    source.on("update", (update: Uint8Array) => {
      sourceUpdates.push(update.slice());
    });
    const content = source.getMap<string>("content");
    content.set("large", "L".repeat(1024 * 1024));
    content.set("small", "S");
    const newest = sourceUpdates[1]!;
    const database = await createDatabase(sourceUpdates);
    const get = vi.spyOn(IDBObjectStore.prototype, "get");

    const result = await runBoardDocumentCompactionPass(database, {
      updatesStoreName: UPDATES_STORE,
      sizesStoreName: SIZES_STORE,
      metadataStoreName: METADATA_STORE,
      limits: {
        maxRows: 8,
        maxBytes: newest.byteLength,
        maxUpdateBytes: newest.byteLength,
      },
    });

    expect(result).toMatchObject({
      status: "noop",
      selectedRows: 1,
      selectedBytes: newest.byteLength,
    });
    const updateKeys = get.mock.calls.flatMap((call, index) => {
      const store = get.mock.contexts[index] as IDBObjectStore;
      return store.name === UPDATES_STORE ? [call[0]] : [];
    });
    expect(updateKeys).toEqual([2]);
  });

  it("releases the update store between suffix rows so appends stay durable", async () => {
    const source = captureUpdates(6);
    const concurrent = captureUpdates(1).updates[0]!;
    const database = await createDatabase(source.updates);
    let announceFirstRow: (() => void) | undefined;
    let releaseScan: (() => void) | undefined;
    const firstRowRead = new Promise<void>((resolve) => {
      announceFirstRow = resolve;
    });
    const scanGate = new Promise<void>((resolve) => {
      releaseScan = resolve;
    });

    const pass = runBoardDocumentCompactionPass(
      database,
      {
        updatesStoreName: UPDATES_STORE,
        sizesStoreName: SIZES_STORE,
        metadataStoreName: METADATA_STORE,
        limits: {
          maxRows: 8,
          maxBytes: 1024 * 1024,
          maxUpdateBytes: 1024 * 1024,
        },
      },
      {
        afterReadRow: async (selectedRows) => {
          if (selectedRows !== 1) return;
          announceFirstRow?.();
          await scanGate;
        },
      },
    );

    await firstRowRead;
    await expect(appendUpdate(database, concurrent)).resolves.toBe(7);
    releaseScan?.();
    await expect(pass).resolves.toMatchObject({
      status: "stale",
      rowCount: 7,
    });
    expect((await readRows(database)).map((row) => row.key))
      .toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it("keeps causal order while producing protocol-bounded Yjs segments", async () => {
    const source = captureUpdates(10, 512);
    const database = await createDatabase(source.updates);
    const largestSource = Math.max(
      ...source.updates.map((update) => update.byteLength),
    );
    const maxUpdateBytes = largestSource * 2 + 32;
    const maxBytes = source.updates.reduce(
      (total, update) => total + update.byteLength,
      0,
    );

    const result = await runBoardDocumentCompactionPass(database, {
      updatesStoreName: UPDATES_STORE,
      sizesStoreName: SIZES_STORE,
      metadataStoreName: METADATA_STORE,
      limits: {
        maxRows: 16,
        maxBytes,
        maxUpdateBytes,
      },
    });

    expect(result.status).toBe("compacted");
    expect(result.replacementRows).toBeGreaterThan(1);
    expect(result.replacementRows).toBeLessThan(source.updates.length);
    const rows = await readRows(database);
    expect(rows.every(
      (row) => row.update.byteLength <= maxUpdateBytes,
    )).toBe(true);
    expectSameState(restoreDocument(rows), source.document);
  });

  it("loses the suffix CAS without deleting a concurrent append", async () => {
    const source = captureUpdates(4);
    const concurrent = captureUpdates(1).updates[0]!;
    const database = await createDatabase(source.updates);

    const result = await runBoardDocumentCompactionPass(
      database,
      {
        updatesStoreName: UPDATES_STORE,
        sizesStoreName: SIZES_STORE,
        metadataStoreName: METADATA_STORE,
        limits: {
          maxRows: 8,
          maxBytes: 1024 * 1024,
          maxUpdateBytes: 1024 * 1024,
        },
      },
      {
        beforeCommit: async () => {
          await appendUpdate(database, concurrent);
        },
      },
    );

    expect(result).toMatchObject({
      status: "stale",
      rowCount: 5,
      selectedRows: 4,
    });
    const rows = await readRows(database);
    expect(rows.map((row) => row.key)).toEqual([1, 2, 3, 4, 5]);
    expect(rows.map((row) => row.update)).toEqual([
      ...source.updates,
      concurrent,
    ]);
  });

  it("loses the suffix CAS after another compactor wins and preserves the winner", async () => {
    const source = captureUpdates(4);
    const database = await createDatabase(source.updates);
    let winningResult:
      | Awaited<ReturnType<typeof runBoardDocumentCompactionPass>>
      | undefined;

    const staleResult = await runBoardDocumentCompactionPass(
      database,
      {
        updatesStoreName: UPDATES_STORE,
        sizesStoreName: SIZES_STORE,
        metadataStoreName: METADATA_STORE,
        limits: {
          maxRows: 8,
          maxBytes: 1024 * 1024,
          maxUpdateBytes: 1024 * 1024,
        },
      },
      {
        beforeCommit: async () => {
          winningResult = await runBoardDocumentCompactionPass(database, {
            updatesStoreName: UPDATES_STORE,
            sizesStoreName: SIZES_STORE,
            metadataStoreName: METADATA_STORE,
            limits: {
              maxRows: 8,
              maxBytes: 1024 * 1024,
              maxUpdateBytes: 1024 * 1024,
            },
          });
        },
      },
    );

    expect(winningResult?.status).toBe("compacted");
    expect(staleResult).toMatchObject({ status: "stale", rowCount: 1 });
    const rows = await readRows(database);
    expect(rows.map((row) => row.key)).toEqual([5]);
    expectSameState(restoreDocument(rows), source.document);
  });

  it("does not rewrite the suffix when bounded merging cannot reduce its row count", async () => {
    const source = captureUpdates(2);
    const database = await createDatabase(source.updates);
    const maxUpdateBytes = Math.min(
      ...source.updates.map((update) => update.byteLength),
    ) - 1;
    const maxBytes = source.updates.reduce(
      (total, update) => total + update.byteLength,
      0,
    );

    const result = await runBoardDocumentCompactionPass(database, {
      updatesStoreName: UPDATES_STORE,
      sizesStoreName: SIZES_STORE,
      metadataStoreName: METADATA_STORE,
      limits: {
        maxRows: 4,
        maxBytes,
        maxUpdateBytes,
      },
    });

    expect(result).toMatchObject({
      status: "noop",
      rowCount: 2,
      selectedRows: 2,
      replacementRows: 2,
    });
    const rows = await readRows(database);
    expect(rows.map((row) => row.key)).toEqual([1, 2]);
    expect(rows.map((row) => row.update)).toEqual(source.updates);
  });

  it("leaves every original row intact when worker-side merging fails", async () => {
    const source = captureUpdates(4);
    const database = await createDatabase(source.updates);

    await expect(runBoardDocumentCompactionPass(
      database,
      {
        updatesStoreName: UPDATES_STORE,
        sizesStoreName: SIZES_STORE,
        metadataStoreName: METADATA_STORE,
        limits: {
          maxRows: 8,
          maxBytes: 1024 * 1024,
          maxUpdateBytes: 1024 * 1024,
        },
      },
      {
        mergeUpdates: () => {
          throw new Error("injected worker merge failure");
        },
      },
    )).rejects.toThrow("injected worker merge failure");

    const rows = await readRows(database);
    expect(rows.map((row) => row.key)).toEqual([1, 2, 3, 4]);
    expect(rows.map((row) => row.update)).toEqual(source.updates);
  });

  it("atomically restores the suffix when replacement writes fail", async () => {
    const source = captureUpdates(4);
    const database = await createDatabase(source.updates);
    const originalAdd = IDBObjectStore.prototype.add;
    vi.spyOn(IDBObjectStore.prototype, "add").mockImplementation(function (
      this: IDBObjectStore,
      _value: unknown,
      _key?: IDBValidKey,
    ): IDBRequest<IDBValidKey> {
      if (this.transaction.db === database) {
        throw new Error("injected replacement write failure");
      }
      return originalAdd.apply(this, arguments as unknown as [
        value: unknown,
        key?: IDBValidKey,
      ]);
    });

    await expect(runBoardDocumentCompactionPass(database, {
      updatesStoreName: UPDATES_STORE,
      sizesStoreName: SIZES_STORE,
      metadataStoreName: METADATA_STORE,
      limits: {
        maxRows: 8,
        maxBytes: 1024 * 1024,
        maxUpdateBytes: 1024 * 1024,
      },
    })).rejects.toThrow("injected replacement write failure");

    const rows = await readRows(database);
    expect(rows.map((row) => row.key)).toEqual([1, 2, 3, 4]);
    expect(rows.map((row) => row.update)).toEqual(source.updates);
  });

  it("rejects a worker crash without running compaction on the caller thread", async () => {
    const source = captureUpdates(3);
    const database = await createDatabase(source.updates);
    const terminate = vi.fn();
    const postMessage = vi.fn();
    const worker = {
      onerror: null as ((event: ErrorEvent) => void) | null,
      onmessage: null as ((event: MessageEvent<unknown>) => void) | null,
      onmessageerror: null as ((event: MessageEvent<unknown>) => void) | null,
      postMessage,
      terminate,
    };
    postMessage.mockImplementation(() => {
      queueMicrotask(() => worker.onerror?.({
        message: "worker crashed",
        preventDefault: vi.fn(),
      } as unknown as ErrorEvent));
    });

    await expect(compactBoardDocumentInWorker(
      {
        databaseName: database.name,
        updatesStoreName: UPDATES_STORE,
        sizesStoreName: SIZES_STORE,
        metadataStoreName: METADATA_STORE,
      },
      { workerFactory: () => worker },
    )).rejects.toThrow("worker crashed");

    expect(postMessage).toHaveBeenCalledTimes(1);
    expect(terminate).toHaveBeenCalledTimes(1);
    const rows = await readRows(database);
    expect(rows.map((row) => row.key)).toEqual([1, 2, 3]);
    expect(rows.map((row) => row.update)).toEqual(source.updates);
  });

  it("accepts a validated worker result and terminates the worker", async () => {
    const terminate = vi.fn();
    const postMessage = vi.fn();
    const worker = {
      onerror: null as ((event: ErrorEvent) => void) | null,
      onmessage: null as ((event: MessageEvent<unknown>) => void) | null,
      onmessageerror: null as ((event: MessageEvent<unknown>) => void) | null,
      postMessage,
      terminate,
    };
    const result = {
      status: "noop" as const,
      revision: 2,
      rowCount: 1,
      rowBytes: 2,
      selectedRows: 1,
      selectedBytes: 2,
      replacementRows: 1,
      replacementBytes: 2,
    };
    postMessage.mockImplementation(() => {
      queueMicrotask(() => worker.onmessage?.({
        data: {
          protocolVersion: BOARD_DOCUMENT_COMPACTION_WORKER_PROTOCOL,
          type: "board-document-compaction-result",
          result,
        },
      } as MessageEvent<unknown>));
    });

    await expect(compactBoardDocumentInWorker(
      {
        databaseName: "validated-result",
        updatesStoreName: UPDATES_STORE,
        sizesStoreName: SIZES_STORE,
        metadataStoreName: METADATA_STORE,
      },
      { workerFactory: () => worker },
    )).resolves.toEqual(result);
    expect(terminate).toHaveBeenCalledTimes(1);
  });

  it("rejects malformed success payloads before they reach store accounting", async () => {
    const terminate = vi.fn();
    const worker = {
      onerror: null as ((event: ErrorEvent) => void) | null,
      onmessage: null as ((event: MessageEvent<unknown>) => void) | null,
      onmessageerror: null as ((event: MessageEvent<unknown>) => void) | null,
      postMessage: vi.fn(),
      terminate,
    };
    worker.postMessage.mockImplementation(() => {
      queueMicrotask(() => worker.onmessage?.({
        data: {
          protocolVersion: BOARD_DOCUMENT_COMPACTION_WORKER_PROTOCOL,
          type: "board-document-compaction-result",
          result: {
            status: "compacted",
            revision: 2,
            rowCount: Number.NaN,
          },
        },
      } as MessageEvent<unknown>));
    });

    await expect(compactBoardDocumentInWorker(
      {
        databaseName: "invalid-result",
        updatesStoreName: UPDATES_STORE,
        sizesStoreName: SIZES_STORE,
        metadataStoreName: METADATA_STORE,
      },
      { workerFactory: () => worker },
    )).rejects.toThrow("invalid response");
    expect(terminate).toHaveBeenCalledTimes(1);
  });

  it("rejects coherent-looking worker statistics that violate compaction invariants", async () => {
    const terminate = vi.fn();
    const worker = {
      onerror: null as ((event: ErrorEvent) => void) | null,
      onmessage: null as ((event: MessageEvent<unknown>) => void) | null,
      onmessageerror: null as ((event: MessageEvent<unknown>) => void) | null,
      postMessage: vi.fn(),
      terminate,
    };
    worker.postMessage.mockImplementation(() => {
      queueMicrotask(() => worker.onmessage?.({
        data: {
          protocolVersion: BOARD_DOCUMENT_COMPACTION_WORKER_PROTOCOL,
          type: "board-document-compaction-result",
          result: {
            status: "compacted",
            revision: Number.MAX_SAFE_INTEGER,
            rowCount: 1,
            rowBytes: 0,
            selectedRows: 2,
            selectedBytes: 100,
            replacementRows: 1,
            replacementBytes: 100,
          },
        },
      } as MessageEvent<unknown>));
    });

    await expect(compactBoardDocumentInWorker(
      {
        databaseName: "impossible-result",
        updatesStoreName: UPDATES_STORE,
        sizesStoreName: SIZES_STORE,
        metadataStoreName: METADATA_STORE,
      },
      { workerFactory: () => worker },
    )).rejects.toThrow("invalid response");
    expect(terminate).toHaveBeenCalledTimes(1);
  });

  it("aborts and terminates an active worker without waiting for a response", async () => {
    const controller = new AbortController();
    const terminate = vi.fn();
    const worker = {
      onerror: null as ((event: ErrorEvent) => void) | null,
      onmessage: null as ((event: MessageEvent<unknown>) => void) | null,
      onmessageerror: null as ((event: MessageEvent<unknown>) => void) | null,
      postMessage: vi.fn(),
      terminate,
    };
    const compaction = compactBoardDocumentInWorker(
      {
        databaseName: "aborted-result",
        updatesStoreName: UPDATES_STORE,
        sizesStoreName: SIZES_STORE,
        metadataStoreName: METADATA_STORE,
      },
      {
        signal: controller.signal,
        workerFactory: () => worker,
      },
    );
    controller.abort();

    await expect(compaction).rejects.toMatchObject({ name: "AbortError" });
    expect(terminate).toHaveBeenCalledTimes(1);
  });
});

import "fake-indexeddb/auto";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { memoryUsage } from "node:process";
import * as Y from "yjs";
import {
  runBoardDocumentCompactionPass,
} from "../src/client/board/documentCompaction.js";
import {
  BOARD_DOCUMENT_LOG_STATS_KEY,
  createBoardDocumentLogStats,
} from "../src/client/board/documentCompactionProtocol.js";

const UPDATES_STORE = "updates";
const SIZES_STORE = "update-sizes";
const METADATA_STORE = "metadata";

function numericOption(name: string, fallback: number): number {
  const prefix = `--${name}=`;
  const raw = process.argv.find((argument) => argument.startsWith(prefix))
    ?.slice(prefix.length);
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${name} must be a positive integer`);
  }
  return value;
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

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(
      request.error ?? new Error("IndexedDB request failed"),
    );
  });
}

function megabytes(bytes: number): number {
  return Math.round(bytes / (1024 * 1024) * 100) / 100;
}

async function createDatabase(
  name: string,
  updates: readonly Uint8Array[],
): Promise<IDBDatabase> {
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
  const transaction = database.transaction(
    [UPDATES_STORE, SIZES_STORE, METADATA_STORE],
    "readwrite",
  );
  const rowBytes = updates.reduce(
    (total, update) => total + update.byteLength,
    0,
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
    createBoardDocumentLogStats(updates.length, rowBytes),
    BOARD_DOCUMENT_LOG_STATS_KEY,
  );
  await transactionComplete(transaction);
  return database;
}

async function deleteDatabase(name: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase(name);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

async function main(): Promise<void> {
  const targetMiB = numericOption("mib", 64);
  const payloadKiB = numericOption("payload-kib", 256);
  const targetBytes = targetMiB * 1024 * 1024;
  const payloadBytes = payloadKiB * 1024;
  const updateCount = Math.ceil(targetBytes / payloadBytes);
  const source = new Y.Doc();
  const updates: Uint8Array[] = [];
  source.on("update", (update: Uint8Array) => updates.push(update.slice()));
  const content = source.getMap<Uint8Array>("content");
  for (let index = 0; index < updateCount; index += 1) {
    content.set(
      `payload-${String(index).padStart(4, "0")}`,
      new Uint8Array(payloadBytes).fill(index % 251),
    );
  }

  const databaseName = `eduri-board-compaction-benchmark:${randomUUID()}`;
  const database = await createDatabase(databaseName, updates);
  try {
    const before = memoryUsage();
    const startedAt = performance.now();
    const result = await runBoardDocumentCompactionPass(database, {
      updatesStoreName: UPDATES_STORE,
      sizesStoreName: SIZES_STORE,
      metadataStoreName: METADATA_STORE,
    });
    const elapsedMs = performance.now() - startedAt;
    const after = memoryUsage();
    if (result.status !== "compacted") {
      throw new Error(`Expected compaction, received ${result.status}`);
    }

    const transaction = database.transaction(UPDATES_STORE, "readonly");
    const completed = transactionComplete(transaction);
    const rows = await requestResult(
      transaction.objectStore(UPDATES_STORE).getAll() as IDBRequest<unknown[]>,
    );
    await completed;
    const restored = new Y.Doc();
    for (const row of rows) {
      if (!(row instanceof Uint8Array)) {
        throw new Error("Benchmark storage returned a non-binary update");
      }
      Y.applyUpdate(restored, row);
    }
    const sourceVector = Y.encodeStateVector(source);
    const restoredVector = Y.encodeStateVector(restored);
    if (
      sourceVector.byteLength !== restoredVector.byteLength
      || !sourceVector.every((byte, index) => byte === restoredVector[index])
    ) {
      throw new Error("Compaction benchmark did not preserve Yjs state");
    }

    console.log(JSON.stringify({
      backend: "fake-indexeddb inline worker-side pass",
      elapsedMs: Math.round(elapsedMs * 100) / 100,
      inputRows: updates.length,
      inputMiB: megabytes(updates.reduce(
        (total, update) => total + update.byteLength,
        0,
      )),
      selectedRows: result.selectedRows,
      selectedMiB: megabytes(result.selectedBytes),
      replacementRows: result.replacementRows,
      replacementMiB: megabytes(result.replacementBytes),
      finalRows: result.rowCount,
      rssDeltaMiB: megabytes(after.rss - before.rss),
      heapDeltaMiB: megabytes(after.heapUsed - before.heapUsed),
      externalDeltaMiB: megabytes(after.external - before.external),
      arrayBuffersDeltaMiB: megabytes(
        after.arrayBuffers - before.arrayBuffers,
      ),
      note: "Endpoint deltas are not peak memory; this does not measure browser UI responsiveness.",
    }, null, 2));
  } finally {
    database.close();
    await deleteDatabase(databaseName);
  }
}

await main();

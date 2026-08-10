import { mergeBoardUpdatesBounded } from "../../board/core/index.js";
import {
  BOARD_DOCUMENT_LOG_STATS_KEY,
  boardDocumentLogStatsEqual,
  createBoardDocumentLogStats,
  restoreBoardDocumentLogStats,
  type BoardDocumentCompactionJob,
  type BoardDocumentCompactionLimits,
  type BoardDocumentCompactionResult,
  type BoardDocumentLogStats,
  resolveBoardDocumentCompactionLimits,
} from "./documentCompactionProtocol.js";

interface StoredUpdate {
  readonly key: number;
  readonly update: Uint8Array;
}

interface CompactionSnapshot {
  readonly stats: BoardDocumentLogStats;
  readonly newestFirst: readonly StoredUpdate[];
  readonly selectedBytes: number;
}

interface SuffixCommitResult {
  readonly committed: boolean;
  readonly stats: BoardDocumentLogStats;
}

export interface BoardDocumentCompactionTestHooks {
  readonly mergeUpdates?: (
    updates: readonly Uint8Array[],
    maxUpdateBytes: number,
  ) => readonly Uint8Array[];
  readonly afterReadRow?: (selectedRows: number) => void | Promise<void>;
  readonly beforeCommit?: () => void | Promise<void>;
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

function restoreUpdate(value: unknown): Uint8Array {
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

function restoreAutoIncrementKey(value: IDBValidKey): number {
  if (
    typeof value !== "number"
    || !Number.isSafeInteger(value)
    || value < 1
  ) {
    throw new Error("Board document update key is not a positive safe integer");
  }
  return value;
}

function restoreUpdateSize(value: unknown): number {
  if (
    typeof value !== "number"
    || !Number.isSafeInteger(value)
    || value < 1
  ) {
    throw new Error("Stored Board document update size is invalid");
  }
  return value;
}

function checkedByteTotal(updates: readonly Uint8Array[]): number {
  let total = 0;
  for (const update of updates) {
    total += update.byteLength;
    if (!Number.isSafeInteger(total)) {
      throw new Error("Board document compaction byte count is unsafe");
    }
  }
  return total;
}

function assertUpdatesStore(store: IDBObjectStore): void {
  if (!store.autoIncrement || store.keyPath !== null) {
    throw new Error(
      "Board document compaction requires an out-of-line autoIncrement store",
    );
  }
}

async function readBoundedNewestSuffix(
  database: IDBDatabase,
  updatesStoreName: string,
  sizesStoreName: string,
  metadataStoreName: string,
  limits: BoardDocumentCompactionLimits,
  hooks: Pick<BoardDocumentCompactionTestHooks, "afterReadRow">,
): Promise<CompactionSnapshot> {
  const statsTransaction = database.transaction(metadataStoreName, "readonly");
  const statsCompleted = transactionComplete(statsTransaction);
  const [storedStats] = await Promise.all([
    requestResult(
      statsTransaction
        .objectStore(metadataStoreName)
        .get(BOARD_DOCUMENT_LOG_STATS_KEY),
    ),
    statsCompleted.then(() => undefined),
  ]);
  const stats = restoreBoardDocumentLogStats(storedStats);

  const selected: StoredUpdate[] = [];
  let selectedBytes = 0;
  let upperExclusive: number | null = null;
  while (selected.length < limits.maxRows) {
    const transaction = database.transaction(
      [updatesStoreName, sizesStoreName],
      "readonly",
    );
    const completed = transactionComplete(transaction);
    const updates = transaction.objectStore(updatesStoreName);
    const sizes = transaction.objectStore(sizesStoreName);
    assertUpdatesStore(updates);
    const range = upperExclusive === null
      ? null
      : IDBKeyRange.upperBound(upperExclusive, true);
    const rowRequest = new Promise<StoredUpdate | "limit" | null>(
      (resolve, reject) => {
      const request = sizes.openCursor(range, "prev");
      request.onerror = () => reject(
        request.error ?? new Error("Unable to read Board document update size"),
      );
      request.onsuccess = () => {
        try {
          const cursor = request.result;
          if (!cursor) {
            resolve(null);
            return;
          }
          const key = restoreAutoIncrementKey(cursor.key);
          const byteLength = restoreUpdateSize(cursor.value);
          if (
            selected.length > 0
            && selectedBytes + byteLength > limits.maxBytes
          ) {
            resolve("limit");
            return;
          }
          const updateRequest = updates.get(key);
          updateRequest.onerror = () => reject(
            updateRequest.error
            ?? new Error("Unable to read Board document update"),
          );
          updateRequest.onsuccess = () => {
            try {
              const update = restoreUpdate(updateRequest.result);
              if (update.byteLength !== byteLength) {
                throw new Error(
                  "Board document update size metadata is inconsistent",
                );
              }
              resolve({ key, update });
            } catch (error) {
              reject(error);
              try {
                transaction.abort();
              } catch {
                // The transaction may already be completing after the request.
              }
            }
          };
        } catch (error) {
          reject(error);
          try {
            transaction.abort();
          } catch {
            // The transaction may already be completing after the cursor stopped.
          }
        }
      };
      },
    );
    const [row] = await Promise.all([rowRequest, completed]);
    if (!row || row === "limit") break;
    selected.push(row);
    selectedBytes += row.update.byteLength;
    if (!Number.isSafeInteger(selectedBytes)) {
      throw new Error("Board document compaction byte count is unsafe");
    }
    upperExclusive = row.key;
    await hooks.afterReadRow?.(selected.length);
    if (selectedBytes >= limits.maxBytes) break;
  }
  return {
    stats,
    newestFirst: selected,
    selectedBytes,
  };
}

async function replaceExactSuffix(
  database: IDBDatabase,
  updatesStoreName: string,
  sizesStoreName: string,
  metadataStoreName: string,
  snapshot: CompactionSnapshot,
  replacements: readonly Uint8Array[],
): Promise<SuffixCommitResult> {
  const transaction = database.transaction(
    [updatesStoreName, sizesStoreName, metadataStoreName],
    "readwrite",
  );
  const completed = transactionComplete(transaction);
  const store = transaction.objectStore(updatesStoreName);
  const sizes = transaction.objectStore(sizesStoreName);
  const metadata = transaction.objectStore(metadataStoreName);
  assertUpdatesStore(store);
  const countRequest = store.count();
  const statsRequest = metadata.get(BOARD_DOCUMENT_LOG_STATS_KEY);
  const cursorRequest = store.openKeyCursor(null, "prev");
  const expected = snapshot.newestFirst;
  const replacementKeys: Array<number | undefined> =
    Array.from({ length: replacements.length });
  let currentStats = snapshot.stats;
  let currentRowCount = snapshot.stats.rowCount;
  let compared = 0;
  let committed = false;
  let stale = false;
  let callbackError: unknown;

  countRequest.onsuccess = () => {
    currentRowCount = countRequest.result;
    if (currentRowCount !== snapshot.stats.rowCount) stale = true;
  };
  statsRequest.onsuccess = () => {
    try {
      currentStats = restoreBoardDocumentLogStats(statsRequest.result);
      if (!boardDocumentLogStatsEqual(currentStats, snapshot.stats)) stale = true;
    } catch (error) {
      callbackError = error;
      transaction.abort();
    }
  };
  cursorRequest.onsuccess = () => {
    if (stale) return;
    try {
      if (currentRowCount !== currentStats.rowCount) {
        throw new Error("Board document log row statistics are inconsistent");
      }
      const cursor = cursorRequest.result;
      const entry = expected[compared];
      if (
        !cursor
        || !entry
        || restoreAutoIncrementKey(cursor.key) !== entry.key
      ) {
        stale = true;
        return;
      }
      compared += 1;
      if (compared < expected.length) {
        cursor.continue();
        return;
      }

      for (const selected of expected) {
        store.delete(selected.key);
        sizes.delete(selected.key);
      }
      replacements.forEach((update, index) => {
        const request = store.add(update);
        request.onsuccess = () => {
          try {
            const key = restoreAutoIncrementKey(request.result);
            replacementKeys[index] = key;
            sizes.put(update.byteLength, key);
          } catch (error) {
            callbackError = error;
            transaction.abort();
          }
        };
      });
      currentStats = createBoardDocumentLogStats(
        snapshot.stats.rowCount - expected.length + replacements.length,
        snapshot.stats.rowBytes - snapshot.selectedBytes
          + checkedByteTotal(replacements),
        snapshot.stats.revision + 1,
      );
      metadata.put(currentStats, BOARD_DOCUMENT_LOG_STATS_KEY);
      committed = true;
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
  if (!committed && currentRowCount !== currentStats.rowCount) {
    throw new Error("Board document log row statistics are inconsistent");
  }
  if (!committed) {
    return { committed: false, stats: currentStats };
  }

  const previousNewestKey = expected[0]!.key;
  if (
    replacementKeys.some(
      (key) => key === undefined || key <= previousNewestKey,
    )
  ) {
    throw new Error(
      "Board document compaction replacements did not receive newer keys",
    );
  }
  return {
    committed: true,
    stats: currentStats,
  };
}

async function verifyExactSuffix(
  database: IDBDatabase,
  updatesStoreName: string,
  metadataStoreName: string,
  snapshot: CompactionSnapshot,
): Promise<SuffixCommitResult> {
  const transaction = database.transaction(
    [updatesStoreName, metadataStoreName],
    "readonly",
  );
  const completed = transactionComplete(transaction);
  const store = transaction.objectStore(updatesStoreName);
  assertUpdatesStore(store);
  const countRequest = store.count();
  const statsRequest = transaction
    .objectStore(metadataStoreName)
    .get(BOARD_DOCUMENT_LOG_STATS_KEY);
  const expected = snapshot.newestFirst;
  const cursorRequest = expected.length > 0
    ? store.openKeyCursor(null, "prev")
    : null;
  let currentStats = snapshot.stats;
  let currentRowCount = snapshot.stats.rowCount;
  let compared = 0;
  let matches = expected.length === 0;
  let stale = false;
  let callbackError: unknown;

  countRequest.onsuccess = () => {
    currentRowCount = countRequest.result;
    if (currentRowCount !== snapshot.stats.rowCount) stale = true;
  };
  statsRequest.onsuccess = () => {
    try {
      currentStats = restoreBoardDocumentLogStats(statsRequest.result);
      if (!boardDocumentLogStatsEqual(currentStats, snapshot.stats)) stale = true;
    } catch (error) {
      callbackError = error;
      transaction.abort();
    }
  };
  if (cursorRequest) {
    cursorRequest.onsuccess = () => {
      if (stale) return;
      try {
        const cursor = cursorRequest.result;
        const entry = expected[compared];
        if (
          !cursor
          || !entry
          || restoreAutoIncrementKey(cursor.key) !== entry.key
        ) {
          stale = true;
          return;
        }
        compared += 1;
        if (compared < expected.length) {
          cursor.continue();
          return;
        }
        matches = true;
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
  if (currentRowCount !== currentStats.rowCount) {
    throw new Error("Board document log row statistics are inconsistent");
  }
  return {
    committed: matches && !stale,
    stats: currentStats,
  };
}

export async function runBoardDocumentCompactionPass(
  database: IDBDatabase,
  job: Pick<
    BoardDocumentCompactionJob,
    "updatesStoreName" | "sizesStoreName" | "metadataStoreName" | "limits"
  >,
  hooks: BoardDocumentCompactionTestHooks = {},
): Promise<BoardDocumentCompactionResult> {
  const limits = resolveBoardDocumentCompactionLimits(job.limits);
  const snapshot = await readBoundedNewestSuffix(
    database,
    job.updatesStoreName,
    job.sizesStoreName,
    job.metadataStoreName,
    limits,
    hooks,
  );
  const causalUpdates = [...snapshot.newestFirst]
    .reverse()
    .map((entry) => entry.update);
  if (causalUpdates.length < 2) {
    const verified = await verifyExactSuffix(
      database,
      job.updatesStoreName,
      job.metadataStoreName,
      snapshot,
    );
    return {
      status: verified.committed ? "noop" : "stale",
      revision: verified.stats.revision,
      rowCount: verified.stats.rowCount,
      rowBytes: verified.stats.rowBytes,
      selectedRows: causalUpdates.length,
      selectedBytes: snapshot.selectedBytes,
      replacementRows: causalUpdates.length,
      replacementBytes: snapshot.selectedBytes,
    };
  }

  const mergeUpdates = hooks.mergeUpdates ?? mergeBoardUpdatesBounded;
  const replacements = mergeUpdates(
    causalUpdates,
    limits.maxUpdateBytes,
  ).map((update) => update.slice());
  const replacementBytes = checkedByteTotal(replacements);
  if (replacements.length >= causalUpdates.length) {
    const verified = await verifyExactSuffix(
      database,
      job.updatesStoreName,
      job.metadataStoreName,
      snapshot,
    );
    return {
      status: verified.committed ? "noop" : "stale",
      revision: verified.stats.revision,
      rowCount: verified.stats.rowCount,
      rowBytes: verified.stats.rowBytes,
      selectedRows: causalUpdates.length,
      selectedBytes: snapshot.selectedBytes,
      replacementRows: causalUpdates.length,
      replacementBytes: snapshot.selectedBytes,
    };
  }
  if (replacements.length === 0) {
    throw new Error("Board document compaction cannot discard a nonempty suffix");
  }

  await hooks.beforeCommit?.();
  const commit = await replaceExactSuffix(
    database,
    job.updatesStoreName,
    job.sizesStoreName,
    job.metadataStoreName,
    snapshot,
    replacements,
  );
  return {
    status: commit.committed ? "compacted" : "stale",
    revision: commit.stats.revision,
    rowCount: commit.stats.rowCount,
    rowBytes: commit.stats.rowBytes,
    selectedRows: causalUpdates.length,
    selectedBytes: snapshot.selectedBytes,
    replacementRows: replacements.length,
    replacementBytes,
  };
}

export function openExistingBoardDocumentDatabase(
  factory: IDBFactory,
  name: string,
): Promise<IDBDatabase> {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = factory.open(name);
    let refusedCreation = false;
    request.onupgradeneeded = () => {
      refusedCreation = true;
      request.transaction?.abort();
    };
    request.onsuccess = () => {
      const database = request.result;
      if (refusedCreation) {
        database.close();
        reject(new Error("Board document compaction cannot create a database"));
        return;
      }
      database.onversionchange = () => database.close();
      resolve(database);
    };
    request.onerror = () => reject(
      request.error ?? new Error("Unable to open Board document compaction storage"),
    );
    request.onblocked = () => {
      // Blocked is nonterminal; the request may still succeed after another tab closes.
    };
  });
}

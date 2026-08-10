import { Worker } from "node:worker_threads";

import * as Y from "yjs";

import { BOARD_PROTOCOL_LIMITS } from "../../board/protocol/index.js";
import {
  BoardRepository,
  BoardRepositoryError,
  type BoardDocumentMetrics,
  type CompactBoardDocumentResult,
  type LoadedBoardDocument,
} from "./repository.js";

export const DEFAULT_BOARD_COMPACTION_POLICY = Object.freeze({
  minUpdateCount: 256,
  minUpdateBytes: 4 * 1024 * 1024,
  scheduleDelayMs: 1_500,
  oversizedRetryDelayMs: 5 * 60_000,
});

export const BOARD_COMPACTION_WORKER_RESOURCE_LIMITS = Object.freeze({
  maxOldGenerationSizeMb: 512,
  maxYoungGenerationSizeMb: 64,
  stackSizeMb: 8,
});

export interface BoardCompactionPolicy {
  minUpdateCount: number;
  minUpdateBytes: number;
  scheduleDelayMs: number;
  oversizedRetryDelayMs: number;
}

export interface BoardDocumentIdentity {
  boardId: string;
  documentKey: string;
  generation: number;
}

export interface BoardCompactionFailure {
  identity: BoardDocumentIdentity;
  error: unknown;
}

export interface BoardCompactionCoordinatorOptions {
  policy?: Partial<BoardCompactionPolicy>;
  onError?: (failure: BoardCompactionFailure) => void;
  reconstructInBackground?: (
    loaded: LoadedBoardDocument,
  ) => Promise<ReconstructedBoardDocument>;
}

export interface ReconstructedBoardDocument {
  snapshot: Uint8Array;
  stateVector: Uint8Array;
}

interface CompactionCandidate extends ReconstructedBoardDocument {
  highWaterSeq: number;
  sourceSnapshotSeq: number;
  updateLogBytes: number;
}

interface PendingCompaction {
  identity: BoardDocumentIdentity;
  timer: ReturnType<typeof setTimeout>;
}

interface OversizedCompaction {
  highWaterSeq: number;
  updateLogBytes: number;
  retryAfter: number;
}

function validateThreshold(value: number, label: string, allowZero = false): number {
  if (
    !Number.isSafeInteger(value)
    || value < (allowZero ? 0 : 1)
  ) {
    throw new TypeError(
      `${label} must be ${allowZero ? "a non-negative" : "a positive"} safe integer`,
    );
  }
  return value;
}

function identityKey(identity: BoardDocumentIdentity): string {
  return `${identity.boardId}\0${identity.generation}\0${identity.documentKey}`;
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength
    && left.every((byte, index) => byte === right[index]);
}

function loadedUpdateBytes(loaded: LoadedBoardDocument): number {
  return loaded.updates.reduce((total, update) => {
    const next = total + update.updateBytes;
    if (!Number.isSafeInteger(next)) {
      throw new BoardRepositoryError(
        "CORRUPT_LOG",
        "Board compaction update bytes exceed safe range",
      );
    }
    return next;
  }, 0);
}

function reconstructDocument(loaded: LoadedBoardDocument): Y.Doc {
  const doc = new Y.Doc();
  try {
    if (loaded.document.snapshot.byteLength > 0) {
      Y.applyUpdate(doc, loaded.document.snapshot);
    }
    if (
      loaded.document.stateVector.byteLength > 0
      && !bytesEqual(
        Y.encodeStateVector(doc),
        loaded.document.stateVector,
      )
    ) {
      throw new BoardRepositoryError(
        "CORRUPT_LOG",
        `stored state vector does not match the snapshot for '${loaded.document.documentKey}'`,
      );
    }
    for (const update of loaded.updates) {
      Y.applyUpdate(doc, update.update);
    }
    return doc;
  } catch (error) {
    doc.destroy();
    throw error;
  }
}

const COMPACTION_WORKER_SOURCE = String.raw`
"use strict";
const { parentPort, workerData } = require("node:worker_threads");
const Database = require("better-sqlite3");
const Y = require("yjs");

function bytesEqual(left, right) {
  return left.byteLength === right.byteLength
    && left.every((byte, index) => byte === right[index]);
}

function reconstruct(snapshot, stateVector, updates, metadata) {
  const doc = new Y.Doc();
  try {
    if (snapshot.byteLength > 0) {
      Y.applyUpdate(doc, snapshot);
    }
    if (
      stateVector.byteLength > 0
      && !bytesEqual(Y.encodeStateVector(doc), stateVector)
    ) {
      throw new Error("stored state vector does not match the compaction snapshot");
    }
    for (const update of updates) {
      Y.applyUpdate(doc, update);
    }
    return {
      snapshot: Y.encodeStateAsUpdate(doc),
      stateVector: Y.encodeStateVector(doc),
      ...metadata,
    };
  } finally {
    doc.destroy();
  }
}

function reconstructSqlite(data) {
  const database = new Database(data.databasePath, {
    readonly: true,
    fileMustExist: true,
    timeout: 5_000,
  });
  try {
    database.pragma("query_only = ON");
    return database.transaction(() => {
      const document = database.prepare(
        "SELECT snapshot_blob, state_vector, snapshot_seq, last_seq "
          + "FROM board_documents "
          + "WHERE board_id = ? AND document_key = ? AND generation = ?"
      ).get(
        data.identity.boardId,
        data.identity.documentKey,
        data.identity.generation,
      );
      if (!document) {
        throw new Error(
          "Board document does not exist for background compaction",
        );
      }
      if (
        !Number.isSafeInteger(document.snapshot_seq)
        || !Number.isSafeInteger(document.last_seq)
        || document.snapshot_seq < 0
        || document.last_seq < document.snapshot_seq
      ) {
        throw new Error("Board document has an invalid compaction sequence");
      }

      const doc = new Y.Doc();
      try {
        if (document.snapshot_blob.byteLength > 0) {
          Y.applyUpdate(doc, document.snapshot_blob);
        }
        if (
          document.state_vector.byteLength > 0
          && !bytesEqual(
            Y.encodeStateVector(doc),
            document.state_vector,
          )
        ) {
          throw new Error(
            "stored state vector does not match the compaction snapshot",
          );
        }

        let expectedSeq = document.snapshot_seq + 1;
        let updateLogBytes = 0;
        const updates = database.prepare(
          "SELECT seq, update_blob FROM board_updates "
            + "WHERE board_id = ? AND document_key = ? AND generation = ? "
            + "AND seq > ? AND seq <= ? ORDER BY seq ASC"
        ).iterate(
          data.identity.boardId,
          data.identity.documentKey,
          data.identity.generation,
          document.snapshot_seq,
          document.last_seq,
        );
        for (const update of updates) {
          if (update.seq !== expectedSeq) {
            throw new Error("Board compaction update range is incomplete");
          }
          Y.applyUpdate(doc, update.update_blob);
          updateLogBytes += update.update_blob.byteLength;
          if (!Number.isSafeInteger(updateLogBytes)) {
            throw new Error("Board compaction update bytes exceed safe range");
          }
          expectedSeq += 1;
        }
        if (expectedSeq !== document.last_seq + 1) {
          throw new Error("Board compaction update range is incomplete");
        }

        return {
          snapshot: Y.encodeStateAsUpdate(doc),
          stateVector: Y.encodeStateVector(doc),
          highWaterSeq: document.last_seq,
          sourceSnapshotSeq: document.snapshot_seq,
          updateLogBytes,
        };
      } finally {
        doc.destroy();
      }
    })();
  } finally {
    database.close();
  }
}

try {
  const rebuilt = workerData.kind === "sqlite"
    ? reconstructSqlite(workerData)
    : reconstruct(
      workerData.snapshot,
      workerData.stateVector,
      workerData.updates,
      {
        highWaterSeq: workerData.highWaterSeq,
        sourceSnapshotSeq: workerData.sourceSnapshotSeq,
        updateLogBytes: workerData.updateLogBytes,
      },
    );
  parentPort.postMessage(
    { ok: true, ...rebuilt },
    [rebuilt.snapshot.buffer, rebuilt.stateVector.buffer],
  );
} catch (error) {
  parentPort.postMessage({
    ok: false,
    message: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined,
  });
}
`;

interface CompactionWorkerSuccess extends CompactionCandidate {
  ok: true;
}

interface CompactionWorkerFailure {
  ok: false;
  message: string;
  stack?: string;
}

type WorkerStateListener = (worker: Worker, active: boolean) => void;

function runCompactionWorker(
  workerData: Record<string, unknown>,
  transferList: ArrayBuffer[],
  onWorker: WorkerStateListener,
): Promise<CompactionCandidate> {
  const worker = new Worker(COMPACTION_WORKER_SOURCE, {
    eval: true,
    workerData,
    transferList,
    resourceLimits: BOARD_COMPACTION_WORKER_RESOURCE_LIMITS,
  });
  onWorker(worker, true);

  return new Promise<CompactionCandidate>((resolve, reject) => {
    let settled = false;
    const finish = (): void => {
      onWorker(worker, false);
      worker.removeAllListeners();
    };
    worker.once("message", (
      result: CompactionWorkerSuccess | CompactionWorkerFailure,
    ) => {
      settled = true;
      finish();
      if (!result.ok) {
        const error = new BoardRepositoryError(
          "CORRUPT_LOG",
          `background compaction failed: ${result.message}`,
        );
        if (result.stack) error.stack = result.stack;
        reject(error);
        return;
      }
      if (
        !Number.isSafeInteger(result.highWaterSeq)
        || !Number.isSafeInteger(result.sourceSnapshotSeq)
        || !Number.isSafeInteger(result.updateLogBytes)
        || result.highWaterSeq < result.sourceSnapshotSeq
        || result.sourceSnapshotSeq < 0
        || result.updateLogBytes < 0
      ) {
        reject(new BoardRepositoryError(
          "CORRUPT_LOG",
          "background compaction returned invalid source metadata",
        ));
        return;
      }
      resolve({
        snapshot: result.snapshot,
        stateVector: result.stateVector,
        highWaterSeq: result.highWaterSeq,
        sourceSnapshotSeq: result.sourceSnapshotSeq,
        updateLogBytes: result.updateLogBytes,
      });
    });
    worker.once("error", (error) => {
      if (settled) return;
      settled = true;
      finish();
      reject(error);
    });
    worker.once("exit", (code) => {
      if (settled) return;
      settled = true;
      finish();
      reject(new Error(`Board compaction worker exited with code ${code}`));
    });
  });
}

function reconstructLoadedDocumentInWorker(
  loaded: LoadedBoardDocument,
  onWorker: WorkerStateListener,
): Promise<CompactionCandidate> {
  const snapshot = loaded.document.snapshot.slice();
  const stateVector = loaded.document.stateVector.slice();
  const updates = loaded.updates.map((record) => record.update.slice());
  const transferList = [
    snapshot.buffer,
    stateVector.buffer,
    ...updates.map((update) => update.buffer),
  ];
  return runCompactionWorker({
    kind: "loaded",
    snapshot,
    stateVector,
    updates,
    highWaterSeq: loaded.highWaterSeq,
    sourceSnapshotSeq: loaded.document.snapshotSeq,
    updateLogBytes: loadedUpdateBytes(loaded),
  }, transferList, onWorker);
}

function reconstructSqliteDocumentInWorker(
  databasePath: string,
  identity: BoardDocumentIdentity,
  onWorker: WorkerStateListener,
): Promise<CompactionCandidate> {
  return runCompactionWorker({
    kind: "sqlite",
    databasePath,
    identity: { ...identity },
  }, [], onWorker);
}

/**
 * Debounces durable-log compaction away from the update/ACK path.
 *
 * A compaction always rebuilds from the repository through one committed
 * high-water sequence. It never snapshots the live cache, which could contain
 * a newer update than the sequence being compacted.
 */
export class BoardCompactionCoordinator {
  readonly policy: BoardCompactionPolicy;
  private readonly pending = new Map<string, PendingCompaction>();
  private readonly queued = new Set<string>();
  private readonly inFlight = new Set<string>();
  private readonly rerunRequested = new Map<string, BoardDocumentIdentity>();
  private readonly oversized = new Map<string, OversizedCompaction>();
  private readonly activeWorkers = new Set<Worker>();
  private readonly onError: (failure: BoardCompactionFailure) => void;
  private readonly reconstructInBackground?: (
    loaded: LoadedBoardDocument,
  ) => Promise<ReconstructedBoardDocument>;
  private backgroundTail: Promise<void> = Promise.resolve();
  private closed = false;

  constructor(
    private readonly repository: BoardRepository,
    options: BoardCompactionCoordinatorOptions = {},
  ) {
    this.policy = {
      minUpdateCount: validateThreshold(
        options.policy?.minUpdateCount
          ?? DEFAULT_BOARD_COMPACTION_POLICY.minUpdateCount,
        "minUpdateCount",
      ),
      minUpdateBytes: validateThreshold(
        options.policy?.minUpdateBytes
          ?? DEFAULT_BOARD_COMPACTION_POLICY.minUpdateBytes,
        "minUpdateBytes",
      ),
      scheduleDelayMs: validateThreshold(
        options.policy?.scheduleDelayMs
          ?? DEFAULT_BOARD_COMPACTION_POLICY.scheduleDelayMs,
        "scheduleDelayMs",
        true,
      ),
      oversizedRetryDelayMs: validateThreshold(
        options.policy?.oversizedRetryDelayMs
          ?? DEFAULT_BOARD_COMPACTION_POLICY.oversizedRetryDelayMs,
        "oversizedRetryDelayMs",
        true,
      ),
    };
    this.onError = options.onError ?? ((failure) => {
      console.error("[board-v2] background compaction failed", {
        boardId: failure.identity.boardId,
        documentKey: failure.identity.documentKey,
        generation: failure.identity.generation,
        error: failure.error,
      });
    });
    this.reconstructInBackground = options.reconstructInBackground;
  }

  schedule(identity: BoardDocumentIdentity): void {
    if (this.closed) return;
    const key = identityKey(identity);
    if (this.pending.has(key) || this.queued.has(key)) return;
    const stableIdentity = { ...identity };
    if (this.inFlight.has(key)) {
      this.rerunRequested.set(key, stableIdentity);
      return;
    }

    const timer = setTimeout(() => {
      this.pending.delete(key);
      if (this.closed) return;
      this.queued.add(key);
      this.backgroundTail = this.backgroundTail.then(async () => {
        this.queued.delete(key);
        if (this.closed) return;
        this.inFlight.add(key);
        try {
          await this.compactIfNeededInBackground(stableIdentity);
        } catch (error) {
          if (!this.closed) {
            this.onError({ identity: stableIdentity, error });
          }
        } finally {
          this.inFlight.delete(key);
          const rerun = this.rerunRequested.get(key);
          this.rerunRequested.delete(key);
          if (rerun && !this.closed) this.schedule(rerun);
        }
      });
    }, this.policy.scheduleDelayMs);
    timer.unref?.();
    this.pending.set(key, { identity: stableIdentity, timer });
  }

  compactIfNeeded(
    identity: BoardDocumentIdentity,
    force = false,
  ): CompactBoardDocumentResult | null {
    if (this.closed) return null;
    const key = identityKey(identity);
    const document = this.documentMetrics(identity);
    if (document.updateLogCount === 0) return null;
    if (
      !force
      && document.updateLogCount < this.policy.minUpdateCount
      && document.updateLogBytes < this.policy.minUpdateBytes
    ) {
      return null;
    }
    if (this.shouldDeferOversized(key, document, force)) return null;

    const loaded = this.repository.loadDocument(identity);
    if (loaded.highWaterSeq === loaded.document.snapshotSeq) return null;
    const reconstructed = reconstructDocument(loaded);
    try {
      const snapshot = Y.encodeStateAsUpdate(reconstructed);
      if (snapshot.byteLength > BOARD_PROTOCOL_LIMITS.maxUpdateBytes) {
        this.rememberOversized(key, {
          snapshot,
          stateVector: Y.encodeStateVector(reconstructed),
          highWaterSeq: loaded.highWaterSeq,
          sourceSnapshotSeq: loaded.document.snapshotSeq,
          updateLogBytes: loadedUpdateBytes(loaded),
        });
        return null;
      }
      const result = this.repository.compactDocument({
        ...identity,
        highWaterSeq: loaded.highWaterSeq,
        snapshot,
        stateVector: Y.encodeStateVector(reconstructed),
      });
      this.oversized.delete(key);
      return result;
    } finally {
      reconstructed.destroy();
    }
  }

  async compactIfNeededInBackground(
    identity: BoardDocumentIdentity,
    force = false,
  ): Promise<CompactBoardDocumentResult | null> {
    if (this.closed) return null;
    const key = identityKey(identity);
    const document = this.documentMetrics(identity);
    if (document.updateLogCount === 0) return null;
    if (
      !force
      && document.updateLogCount < this.policy.minUpdateCount
      && document.updateLogBytes < this.policy.minUpdateBytes
    ) {
      return null;
    }
    if (this.shouldDeferOversized(key, document, force)) return null;

    let reconstructed: CompactionCandidate;
    if (this.reconstructInBackground) {
      const loaded = this.repository.loadDocument(identity);
      if (loaded.highWaterSeq === loaded.document.snapshotSeq) return null;
      const injected = await this.reconstructInBackground(loaded);
      reconstructed = {
        ...injected,
        highWaterSeq: loaded.highWaterSeq,
        sourceSnapshotSeq: loaded.document.snapshotSeq,
        updateLogBytes: loadedUpdateBytes(loaded),
      };
    } else {
      const databasePath = this.repository.compactionDatabasePath();
      if (databasePath) {
        reconstructed = await reconstructSqliteDocumentInWorker(
          databasePath,
          identity,
          this.observeWorker,
        );
      } else {
        const loaded = this.repository.loadDocument(identity);
        if (loaded.highWaterSeq === loaded.document.snapshotSeq) return null;
        reconstructed = await reconstructLoadedDocumentInWorker(
          loaded,
          this.observeWorker,
        );
      }
    }

    if (this.closed) return null;
    if (reconstructed.highWaterSeq === reconstructed.sourceSnapshotSeq) {
      return null;
    }
    if (reconstructed.snapshot.byteLength > BOARD_PROTOCOL_LIMITS.maxUpdateBytes) {
      this.rememberOversized(key, reconstructed);
      return null;
    }
    const result = this.repository.compactDocument({
      ...identity,
      highWaterSeq: reconstructed.highWaterSeq,
      snapshot: reconstructed.snapshot,
      stateVector: reconstructed.stateVector,
    });
    this.oversized.delete(key);
    return result;
  }

  whenIdle(): Promise<void> {
    return this.backgroundTail;
  }

  cancel(identity: BoardDocumentIdentity): void {
    const key = identityKey(identity);
    const scheduled = this.pending.get(key);
    if (scheduled) {
      clearTimeout(scheduled.timer);
      this.pending.delete(key);
    }
    this.rerunRequested.delete(key);
    this.oversized.delete(key);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const scheduled of this.pending.values()) {
      clearTimeout(scheduled.timer);
    }
    this.pending.clear();
    this.queued.clear();
    this.rerunRequested.clear();
    this.oversized.clear();
    const workers = [...this.activeWorkers];
    this.activeWorkers.clear();
    for (const worker of workers) {
      void worker.terminate().catch(() => undefined);
    }
  }

  private readonly observeWorker: WorkerStateListener = (worker, active) => {
    if (active) {
      this.activeWorkers.add(worker);
    } else {
      this.activeWorkers.delete(worker);
    }
  };

  private documentMetrics(identity: BoardDocumentIdentity): BoardDocumentMetrics {
    const metrics = this.repository.getBoardMetrics({
      boardId: identity.boardId,
      generation: identity.generation,
    });
    const document = metrics.documents.find(
      (candidate) => candidate.documentKey === identity.documentKey,
    );
    if (!document) {
      throw new BoardRepositoryError(
        "NOT_FOUND",
        `document '${identity.documentKey}' does not exist`,
      );
    }
    const key = identityKey(identity);
    const blocked = this.oversized.get(key);
    if (blocked && document.snapshotSeq >= blocked.highWaterSeq) {
      this.oversized.delete(key);
    }
    return document;
  }

  private shouldDeferOversized(
    key: string,
    document: BoardDocumentMetrics,
    force: boolean,
  ): boolean {
    if (force) return false;
    const blocked = this.oversized.get(key);
    if (!blocked) return false;
    const additionalUpdates = Math.max(
      0,
      document.lastSeq - blocked.highWaterSeq,
    );
    const additionalBytes = Math.max(
      0,
      document.updateLogBytes - blocked.updateLogBytes,
    );
    return Date.now() < blocked.retryAfter
      || (
        additionalUpdates < this.policy.minUpdateCount
        && additionalBytes < this.policy.minUpdateBytes
      );
  }

  private rememberOversized(
    key: string,
    candidate: CompactionCandidate,
  ): void {
    this.oversized.set(key, {
      highWaterSeq: candidate.highWaterSeq,
      updateLogBytes: candidate.updateLogBytes,
      retryAfter: Math.min(
        Number.MAX_SAFE_INTEGER,
        Date.now() + this.policy.oversizedRetryDelayMs,
      ),
    });
  }
}

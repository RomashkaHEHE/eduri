import { createHash, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import * as Y from "yjs";
import { CODE_SYNC_LIMITS } from "../../code/protocol/index.js";
import {
  CODE_WORKSPACE_SCHEMA_VERSION,
  initializeCodeWorkspace,
  validateCodeWorkspaceDocument,
} from "../../code/core/index.js";

interface WorkspaceRow {
  workspace_id: string;
  room_resource_id: string;
  document_id: string;
  schema_version: number;
}

interface DocumentRow {
  document_id: string;
  snapshot_update: Buffer;
  snapshot_bytes: number;
  state_vector: Buffer;
  state_vector_bytes: number;
  snapshot_sequence: number;
  last_sequence: number;
  update_log_count: number;
  update_log_bytes: number;
  receipt_count: number;
  compacted_at: string | null;
}

interface UpdateRow {
  sequence: number;
  update_digest: string;
  update_blob: Buffer;
  update_bytes: number;
}

interface ReceiptRow {
  update_digest: string;
  sequence: number;
}

interface LoadedCodeDocument {
  readonly row: DocumentRow;
  readonly updates: readonly UpdateRow[];
  readonly document: Y.Doc;
}

export const DEFAULT_CODE_SYNC_STORAGE_POLICY = Object.freeze({
  compactAfterUpdateCount: 64,
  compactAfterUpdateBytes: 2 * 1024 * 1024,
  maxUpdateLogCount: 127,
  maxWorkspaceBytes: 64 * 1024 * 1024,
  maxGuestStorageBytes: 512 * 1024 * 1024,
  maxReceiptCount: 32_768,
  maxColdSyncParts: 128,
});

export interface CodeSyncStoragePolicy {
  readonly compactAfterUpdateCount: number;
  readonly compactAfterUpdateBytes: number;
  readonly maxUpdateLogCount: number;
  readonly maxWorkspaceBytes: number;
  readonly maxGuestStorageBytes: number;
  readonly maxReceiptCount: number;
  readonly maxColdSyncParts: number;
}

export interface CodeWorkspaceRecord {
  readonly id: string;
  readonly roomResourceId: string;
  readonly documentId: string;
  readonly schemaVersion: number;
}

export interface CodeDocumentState {
  readonly update: Uint8Array;
  readonly stateVector: Uint8Array;
  readonly sequence: number;
}

export interface CodeDocumentSync {
  readonly updates: readonly Uint8Array[];
  readonly stateVector: Uint8Array;
  readonly sequence: number;
}

export interface AppendCodeUpdateInput {
  readonly workspaceId: string;
  readonly deviceId: string;
  readonly updateId: string;
  readonly update: Uint8Array;
  /** Runs inside a new update's SQLite transaction; false aborts the commit. */
  readonly commitActivity?: () => boolean;
}

export interface AppendCodeUpdateResult {
  readonly status: "committed" | "duplicate";
  readonly sequence: number;
}

export class CodeSyncRepositoryError extends Error {
  constructor(
    public readonly code:
      | "INVALID_ARGUMENT"
      | "NOT_FOUND"
      | "INVALID_UPDATE"
      | "IDEMPOTENCY_CONFLICT"
      | "RESOURCE_INACTIVE"
      | "STORAGE_ERROR",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "CodeSyncRepositoryError";
  }
}

function iso(timestamp: number): string {
  return new Date(timestamp).toISOString();
}

function copyBytes(value: Uint8Array, label: string): Uint8Array {
  if (!(value instanceof Uint8Array)) {
    throw new CodeSyncRepositoryError(
      "INVALID_ARGUMENT",
      `${label} must be a Uint8Array`,
    );
  }
  return value.slice();
}

function digest(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength
    && left.every((value, index) => value === right[index]);
}

function hasUpdateContent(update: Uint8Array): boolean {
  const decoded = Y.decodeUpdate(update);
  return decoded.structs.length > 0 || decoded.ds.clients.size > 0;
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${label} must be a positive safe integer`);
  }
  return value;
}

function hasPendingDependencies(document: Y.Doc): boolean {
  return document.store.pendingStructs !== null
    || document.store.pendingDs !== null;
}

function workspaceRecord(row: WorkspaceRow): CodeWorkspaceRecord {
  return {
    id: row.workspace_id,
    roomResourceId: row.room_resource_id,
    documentId: row.document_id,
    schemaVersion: row.schema_version,
  };
}

export class CodeSyncRepository {
  readonly storagePolicy: CodeSyncStoragePolicy;

  constructor(
    private readonly db: Database.Database,
    private readonly now: () => number = Date.now,
    policy: Partial<CodeSyncStoragePolicy> = {},
  ) {
    this.storagePolicy = {
      compactAfterUpdateCount: positiveInteger(
        policy.compactAfterUpdateCount
          ?? DEFAULT_CODE_SYNC_STORAGE_POLICY.compactAfterUpdateCount,
        "compactAfterUpdateCount",
      ),
      compactAfterUpdateBytes: positiveInteger(
        policy.compactAfterUpdateBytes
          ?? DEFAULT_CODE_SYNC_STORAGE_POLICY.compactAfterUpdateBytes,
        "compactAfterUpdateBytes",
      ),
      maxUpdateLogCount: positiveInteger(
        policy.maxUpdateLogCount
          ?? DEFAULT_CODE_SYNC_STORAGE_POLICY.maxUpdateLogCount,
        "maxUpdateLogCount",
      ),
      maxWorkspaceBytes: positiveInteger(
        policy.maxWorkspaceBytes
          ?? DEFAULT_CODE_SYNC_STORAGE_POLICY.maxWorkspaceBytes,
        "maxWorkspaceBytes",
      ),
      maxGuestStorageBytes: positiveInteger(
        policy.maxGuestStorageBytes
          ?? DEFAULT_CODE_SYNC_STORAGE_POLICY.maxGuestStorageBytes,
        "maxGuestStorageBytes",
      ),
      maxReceiptCount: positiveInteger(
        policy.maxReceiptCount
          ?? DEFAULT_CODE_SYNC_STORAGE_POLICY.maxReceiptCount,
        "maxReceiptCount",
      ),
      maxColdSyncParts: positiveInteger(
        policy.maxColdSyncParts
          ?? DEFAULT_CODE_SYNC_STORAGE_POLICY.maxColdSyncParts,
        "maxColdSyncParts",
      ),
    };
    if (
      this.storagePolicy.compactAfterUpdateCount
        > this.storagePolicy.maxUpdateLogCount
      || this.storagePolicy.maxUpdateLogCount + 1
        > this.storagePolicy.maxColdSyncParts
    ) {
      throw new TypeError("Code sync storage count thresholds are inconsistent");
    }
    if (
      this.storagePolicy.compactAfterUpdateBytes
        > this.storagePolicy.maxWorkspaceBytes
    ) {
      throw new TypeError("Code sync storage byte thresholds are inconsistent");
    }
  }

  ensureWorkspace(roomResourceId: string): CodeWorkspaceRecord {
    if (!roomResourceId) {
      throw new CodeSyncRepositoryError(
        "INVALID_ARGUMENT",
        "roomResourceId is required",
      );
    }
    const existing = this.workspaceForResource(roomResourceId);
    if (existing) return existing;

    const document = new Y.Doc();
    try {
      initializeCodeWorkspace(document, "server-bootstrap");
      validateCodeWorkspaceDocument(document);
      const snapshot = Y.encodeStateAsUpdate(document);
      const stateVector = Y.encodeStateVector(document);
      const timestamp = iso(this.now());
      const workspaceId = randomUUID();
      const documentId = randomUUID();
      try {
        return this.db.transaction(() => {
          const guestStorageBefore = this.guestStorageBytes();
          const resource = this.db.prepare(`
            SELECT kind FROM guest_room_resources WHERE id = ?
          `).get(roomResourceId) as { kind: string } | undefined;
          if (!resource || resource.kind !== "code") {
            throw new CodeSyncRepositoryError(
              "NOT_FOUND",
              "Guest room Code resource was not found",
            );
          }
          const raced = this.workspaceForResource(roomResourceId);
          if (raced) return raced;
          this.db.prepare(`
            INSERT INTO code_workspaces (
              id, room_resource_id, schema_version, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?)
          `).run(
            workspaceId,
            roomResourceId,
            CODE_WORKSPACE_SCHEMA_VERSION,
            timestamp,
            timestamp,
          );
          this.db.prepare(`
            INSERT INTO code_documents (
              id, workspace_id, snapshot_update, snapshot_bytes,
              state_vector, state_vector_bytes, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          `).run(
            documentId,
            workspaceId,
            Buffer.from(snapshot),
            snapshot.byteLength,
            Buffer.from(stateVector),
            stateVector.byteLength,
            timestamp,
            timestamp,
          );
          this.assertGuestStorageCapacity(guestStorageBefore);
          return {
            id: workspaceId,
            roomResourceId,
            documentId,
            schemaVersion: CODE_WORKSPACE_SCHEMA_VERSION,
          };
        }).immediate();
      } catch (error) {
        if (error instanceof CodeSyncRepositoryError) throw error;
        throw new CodeSyncRepositoryError(
          "STORAGE_ERROR",
          "Code workspace could not be initialized",
          { cause: error },
        );
      }
    } finally {
      document.destroy();
    }
  }

  workspaceForResource(roomResourceId: string): CodeWorkspaceRecord | null {
    const row = this.db.prepare(`
      SELECT
        workspace.id AS workspace_id,
        workspace.room_resource_id,
        workspace.schema_version,
        document.id AS document_id
      FROM code_workspaces workspace
      JOIN code_documents document ON document.workspace_id = workspace.id
      WHERE workspace.room_resource_id = ?
    `).get(roomResourceId) as WorkspaceRow | undefined;
    return row ? workspaceRecord(row) : null;
  }

  readDocumentState(workspaceId: string): CodeDocumentState {
    const loaded = this.loadDocument(workspaceId);
    try {
      return {
        update: Y.encodeStateAsUpdate(loaded.document),
        stateVector: Y.encodeStateVector(loaded.document),
        sequence: loaded.row.last_sequence,
      };
    } finally {
      loaded.document.destroy();
    }
  }

  missingUpdates(
    workspaceId: string,
    stateVector: Uint8Array,
  ): CodeDocumentSync {
    const vector = copyBytes(stateVector, "stateVector");
    if (
      vector.byteLength < 1
      || vector.byteLength > CODE_SYNC_LIMITS.maxStateVectorBytes
    ) {
      throw new CodeSyncRepositoryError(
        "INVALID_ARGUMENT",
        "State vector exceeds its size limit",
      );
    }
    const loaded = this.loadDocument(workspaceId);
    try {
      try {
        const persisted = [
          Uint8Array.from(loaded.row.snapshot_update),
          ...loaded.updates.map((update) => Uint8Array.from(update.update_blob)),
        ];
        if (persisted.length > this.storagePolicy.maxColdSyncParts) {
          throw new CodeSyncRepositoryError(
            "STORAGE_ERROR",
            "Code workspace cold sync exceeds its durable part limit",
          );
        }
        const missing = persisted
          .map((source) => Y.diffUpdate(source, vector))
          .filter((candidate) => hasUpdateContent(candidate));
        if (missing.some((candidate) => (
          candidate.byteLength > CODE_SYNC_LIMITS.maxUpdateBytes
        ))) {
          throw new CodeSyncRepositoryError(
            "INVALID_UPDATE",
            "A Code sync part exceeds its protocol limit",
          );
        }
        return {
          // Keeping persisted diffs separate prevents a large workspace from
          // becoming one oversized cold-sync frame. It also preserves pending
          // updates whose dependencies arrived out of order.
          updates: missing.length === 0 ? [Uint8Array.of(0, 0)] : missing,
          stateVector: Y.encodeStateVector(loaded.document),
          sequence: loaded.row.last_sequence,
        };
      } catch (error) {
        if (error instanceof CodeSyncRepositoryError) throw error;
        throw new CodeSyncRepositoryError(
          "INVALID_UPDATE",
          "State vector is invalid",
          { cause: error },
        );
      }
    } finally {
      loaded.document.destroy();
    }
  }

  appendUpdate(input: AppendCodeUpdateInput): AppendCodeUpdateResult {
    if (!input.workspaceId || !input.deviceId || !input.updateId) {
      throw new CodeSyncRepositoryError(
        "INVALID_ARGUMENT",
        "Workspace, device, and update IDs are required",
      );
    }
    const update = copyBytes(input.update, "update");
    if (
      update.byteLength < 1
      || update.byteLength > CODE_SYNC_LIMITS.maxUpdateBytes
    ) {
      throw new CodeSyncRepositoryError(
        "INVALID_ARGUMENT",
        "Update exceeds its size limit",
      );
    }
    const updateDigest = digest(update);
    try {
      return this.db.transaction(() => this.appendTransaction(
        input.workspaceId,
        input.deviceId,
        input.updateId,
        update,
        updateDigest,
        input.commitActivity,
      )).immediate();
    } catch (error) {
      if (error instanceof CodeSyncRepositoryError) throw error;
      throw new CodeSyncRepositoryError(
        "STORAGE_ERROR",
        "Code update could not be committed",
        { cause: error },
      );
    }
  }

  private appendTransaction(
    workspaceId: string,
    deviceId: string,
    updateId: string,
    update: Uint8Array,
    updateDigest: string,
    commitActivity: (() => boolean) | undefined,
  ): AppendCodeUpdateResult {
    const row = this.documentRow(workspaceId);
    const receipt = this.db.prepare(`
      SELECT update_digest, sequence
      FROM code_update_receipts
      WHERE document_id = ? AND device_id = ? AND update_id = ?
    `).get(row.document_id, deviceId, updateId) as ReceiptRow | undefined;
    if (receipt) {
      if (receipt.update_digest !== updateDigest) {
        throw new CodeSyncRepositoryError(
          "IDEMPOTENCY_CONFLICT",
          "updateId was already used for a different update",
        );
      }
      return { status: "duplicate", sequence: receipt.sequence };
    }

    const guestStorageBefore = this.guestStorageBytes();

    this.assertReceiptCapacity(row);

    const compactedReceipt = this.db.prepare(`
      SELECT update_digest, sequence
      FROM code_update_receipts
      WHERE document_id = ? AND update_digest = ?
      ORDER BY sequence LIMIT 1
    `).get(row.document_id, updateDigest) as ReceiptRow | undefined;
    if (compactedReceipt) {
      this.recordDuplicateReceipt(
        row,
        deviceId,
        updateId,
        updateDigest,
        compactedReceipt.sequence,
      );
      this.assertGuestStorageCapacity(guestStorageBefore);
      return { status: "duplicate", sequence: compactedReceipt.sequence };
    }

    const existing = this.db.prepare(`
      SELECT sequence, update_digest, update_blob
      FROM code_updates
      WHERE document_id = ? AND update_digest = ?
    `).get(row.document_id, updateDigest) as UpdateRow | undefined;
    if (existing) {
      if (!bytesEqual(existing.update_blob, update)) {
        throw new CodeSyncRepositoryError(
          "STORAGE_ERROR",
          "Code update digest collision detected",
        );
      }
      this.recordDuplicateReceipt(
        row,
        deviceId,
        updateId,
        updateDigest,
        existing.sequence,
      );
      this.assertGuestStorageCapacity(guestStorageBefore);
      return { status: "duplicate", sequence: existing.sequence };
    }

    let hasContent: boolean;
    try {
      hasContent = hasUpdateContent(update);
    } catch (error) {
      throw new CodeSyncRepositoryError(
        "INVALID_UPDATE",
        "Code update is not valid Yjs update-v1 data",
        { cause: error },
      );
    }
    if (!hasContent) {
      const sequence = row.last_sequence;
      this.recordDuplicateReceipt(
        row,
        deviceId,
        updateId,
        updateDigest,
        sequence,
      );
      this.assertGuestStorageCapacity(guestStorageBefore);
      return { status: "duplicate", sequence };
    }

    const reconstructed = this.loadDocument(workspaceId);
    try {
      try {
        Y.applyUpdate(reconstructed.document, update, "remote-code-sync");
        validateCodeWorkspaceDocument(reconstructed.document);
      } catch (error) {
        throw new CodeSyncRepositoryError(
          "INVALID_UPDATE",
          "Code update would create an invalid workspace document",
          { cause: error },
        );
      }
      const timestamp = iso(this.now());
      const sequence = row.last_sequence + 1;
      if (!Number.isSafeInteger(sequence)) {
        throw new CodeSyncRepositoryError(
          "STORAGE_ERROR",
          "Code update sequence exceeded the safe integer range",
        );
      }
      const stateVector = Y.encodeStateVector(reconstructed.document);
      const nextLogCount = row.update_log_count + 1;
      const nextLogBytes = row.update_log_bytes + update.byteLength;
      const shouldCompact =
        nextLogCount >= this.storagePolicy.compactAfterUpdateCount
        || nextLogBytes >= this.storagePolicy.compactAfterUpdateBytes;
      const snapshot = shouldCompact
        && !hasPendingDependencies(reconstructed.document)
        ? Y.encodeStateAsUpdate(reconstructed.document)
        : null;
      const canCompact = snapshot !== null
        && snapshot.byteLength <= CODE_SYNC_LIMITS.maxUpdateBytes
        && snapshot.byteLength + stateVector.byteLength
          <= this.storagePolicy.maxWorkspaceBytes;

      this.insertReceipt(
        row.document_id,
        deviceId,
        updateId,
        updateDigest,
        sequence,
        timestamp,
      );

      if (canCompact) {
        const deletion = this.db.prepare(`
          DELETE FROM code_updates WHERE document_id = ?
        `).run(row.document_id);
        if (deletion.changes !== row.update_log_count) {
          throw new CodeSyncRepositoryError(
            "STORAGE_ERROR",
            "Code compaction update count changed unexpectedly",
          );
        }
        const changed = this.db.prepare(`
          UPDATE code_documents
          SET snapshot_update = ?, snapshot_bytes = ?,
              state_vector = ?, state_vector_bytes = ?,
              snapshot_sequence = ?, last_sequence = ?,
              update_log_count = 0, update_log_bytes = 0,
              receipt_count = receipt_count + 1,
              updated_at = ?, compacted_at = ?
          WHERE id = ?
            AND snapshot_sequence = ?
            AND last_sequence = ?
            AND update_log_count = ?
            AND update_log_bytes = ?
            AND receipt_count = ?
        `).run(
          Buffer.from(snapshot),
          snapshot.byteLength,
          Buffer.from(stateVector),
          stateVector.byteLength,
          sequence,
          sequence,
          timestamp,
          timestamp,
          row.document_id,
          row.snapshot_sequence,
          row.last_sequence,
          row.update_log_count,
          row.update_log_bytes,
          row.receipt_count,
        );
        if (changed.changes !== 1) {
          throw new CodeSyncRepositoryError(
            "STORAGE_ERROR",
            "Code compaction lost its document compare-and-swap",
          );
        }
        this.assertGuestStorageCapacity(guestStorageBefore);
        this.touchWorkspace(workspaceId, timestamp);
        if (commitActivity && !commitActivity()) {
          throw new CodeSyncRepositoryError(
            "RESOURCE_INACTIVE",
            "Guest Code resource is no longer active",
          );
        }
        return { status: "committed", sequence };
      }

      this.assertUpdateLogCapacity(row, nextLogCount, nextLogBytes, stateVector);
      const inserted = this.db.prepare(`
        INSERT INTO code_updates (
          document_id, sequence, update_digest, update_blob, update_bytes, created_at
        ) VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        row.document_id,
        sequence,
        updateDigest,
        Buffer.from(update),
        update.byteLength,
        timestamp,
      );
      if (inserted.changes !== 1) {
        throw new CodeSyncRepositoryError(
          "STORAGE_ERROR",
          "Code update was not inserted",
        );
      }
      const changed = this.db.prepare(`
        UPDATE code_documents
        SET state_vector = ?, state_vector_bytes = ?,
            last_sequence = ?, update_log_count = ?, update_log_bytes = ?,
            receipt_count = receipt_count + 1, updated_at = ?
        WHERE id = ?
          AND snapshot_sequence = ?
          AND last_sequence = ?
          AND update_log_count = ?
          AND update_log_bytes = ?
          AND receipt_count = ?
      `).run(
        Buffer.from(stateVector),
        stateVector.byteLength,
        sequence,
        nextLogCount,
        nextLogBytes,
        timestamp,
        row.document_id,
        row.snapshot_sequence,
        row.last_sequence,
        row.update_log_count,
        row.update_log_bytes,
        row.receipt_count,
      );
      if (changed.changes !== 1) {
        throw new CodeSyncRepositoryError(
          "STORAGE_ERROR",
          "Code document changed during update commit",
        );
      }
      this.assertGuestStorageCapacity(guestStorageBefore);
      this.touchWorkspace(workspaceId, timestamp);
      if (commitActivity && !commitActivity()) {
        throw new CodeSyncRepositoryError(
          "RESOURCE_INACTIVE",
          "Guest Code resource is no longer active",
        );
      }
      return { status: "committed", sequence };
    } finally {
      reconstructed.document.destroy();
    }
  }

  private assertReceiptCapacity(row: DocumentRow): void {
    if (row.receipt_count >= this.storagePolicy.maxReceiptCount) {
      throw new CodeSyncRepositoryError(
        "INVALID_UPDATE",
        "Code workspace receipt quota has been reached",
      );
    }
  }

  private guestStorageBytes(): number {
    const row = this.db.prepare(`
      SELECT accounted_bytes
      FROM code_guest_storage_usage
      WHERE singleton = 1
    `).get() as { accounted_bytes: number } | undefined;
    if (
      !row
      || !Number.isSafeInteger(row.accounted_bytes)
      || row.accounted_bytes < 0
    ) {
      throw new CodeSyncRepositoryError(
        "STORAGE_ERROR",
        "Global guest Code storage counters are invalid",
      );
    }
    return row.accounted_bytes;
  }

  private assertGuestStorageCapacity(previousBytes: number): void {
    const currentBytes = this.guestStorageBytes();
    if (
      currentBytes > this.storagePolicy.maxGuestStorageBytes
      && currentBytes > previousBytes
    ) {
      throw new CodeSyncRepositoryError(
        "INVALID_UPDATE",
        "Global guest Code durable storage quota would be exceeded",
      );
    }
  }

  private assertUpdateLogCapacity(
    row: DocumentRow,
    nextLogCount: number,
    nextLogBytes: number,
    stateVector: Uint8Array,
  ): void {
    if (nextLogCount > this.storagePolicy.maxUpdateLogCount) {
      throw new CodeSyncRepositoryError(
        "INVALID_UPDATE",
        "Code workspace update-log count quota would be exceeded",
      );
    }
    if (
      row.snapshot_bytes + nextLogBytes + stateVector.byteLength
        > this.storagePolicy.maxWorkspaceBytes
    ) {
      throw new CodeSyncRepositoryError(
        "INVALID_UPDATE",
        "Code workspace durable byte quota would be exceeded",
      );
    }
  }

  private recordDuplicateReceipt(
    row: DocumentRow,
    deviceId: string,
    updateId: string,
    updateDigest: string,
    sequence: number,
  ): void {
    const timestamp = iso(this.now());
    this.insertReceipt(
      row.document_id,
      deviceId,
      updateId,
      updateDigest,
      sequence,
      timestamp,
    );
    const changed = this.db.prepare(`
      UPDATE code_documents
      SET receipt_count = receipt_count + 1
      WHERE id = ? AND receipt_count = ?
    `).run(row.document_id, row.receipt_count);
    if (changed.changes !== 1) {
      throw new CodeSyncRepositoryError(
        "STORAGE_ERROR",
        "Code receipt count changed during duplicate commit",
      );
    }
  }

  private touchWorkspace(workspaceId: string, timestamp: string): void {
    this.db.prepare(`
      UPDATE code_workspaces SET updated_at = ? WHERE id = ?
    `).run(timestamp, workspaceId);
  }

  private insertReceipt(
    documentId: string,
    deviceId: string,
    updateId: string,
    updateDigest: string,
    sequence: number,
    timestamp = iso(this.now()),
  ): void {
    this.db.prepare(`
      INSERT INTO code_update_receipts (
        document_id, device_id, update_id, update_digest, sequence, created_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      documentId,
      deviceId,
      updateId,
      updateDigest,
      sequence,
      timestamp,
    );
  }

  private documentRow(workspaceId: string): DocumentRow {
    const row = this.db.prepare(`
      SELECT
        document.id AS document_id,
        document.snapshot_update,
        document.snapshot_bytes,
        document.state_vector,
        document.state_vector_bytes,
        document.snapshot_sequence,
        document.last_sequence,
        document.update_log_count,
        document.update_log_bytes,
        document.receipt_count,
        document.compacted_at
      FROM code_workspaces workspace
      JOIN code_documents document ON document.workspace_id = workspace.id
      WHERE workspace.id = ?
    `).get(workspaceId) as DocumentRow | undefined;
    if (!row) {
      throw new CodeSyncRepositoryError(
        "NOT_FOUND",
        "Code workspace document was not found",
      );
    }
    return row;
  }

  private loadDocument(workspaceId: string): LoadedCodeDocument {
    const row = this.documentRow(workspaceId);
    const updates = this.db.prepare(`
      SELECT sequence, update_digest, update_blob, update_bytes
      FROM code_updates
      WHERE document_id = ? AND sequence > ? AND sequence <= ?
      ORDER BY sequence
    `).all(
      row.document_id,
      row.snapshot_sequence,
      row.last_sequence,
    ) as UpdateRow[];
    const document = new Y.Doc();
    try {
      if (
        !Number.isSafeInteger(row.snapshot_sequence)
        || !Number.isSafeInteger(row.last_sequence)
        || row.snapshot_sequence < 0
        || row.last_sequence < row.snapshot_sequence
        || !Number.isSafeInteger(row.update_log_count)
        || row.update_log_count < 0
        || !Number.isSafeInteger(row.update_log_bytes)
        || row.update_log_bytes < 0
        || !Number.isSafeInteger(row.receipt_count)
        || row.receipt_count < 0
      ) {
        throw new CodeSyncRepositoryError(
          "STORAGE_ERROR",
          "Stored Code workspace counters are invalid",
        );
      }
      const updateBytes = updates.reduce((total, update) => {
        const next = total + update.update_bytes;
        if (!Number.isSafeInteger(next)) {
          throw new CodeSyncRepositoryError(
            "STORAGE_ERROR",
            "Stored Code update bytes exceed the safe integer range",
          );
        }
        return next;
      }, 0);
      if (
        updates.length !== row.update_log_count
        || updateBytes !== row.update_log_bytes
        || (
          updates.length > 0
          && updates.at(-1)?.sequence !== row.last_sequence
        )
        || (
          updates.length === 0
          && row.last_sequence !== row.snapshot_sequence
        )
      ) {
        throw new CodeSyncRepositoryError(
          "STORAGE_ERROR",
          "Stored Code workspace update-log counters are inconsistent",
        );
      }
      Y.applyUpdate(document, Uint8Array.from(row.snapshot_update));
      for (const update of updates) {
        Y.applyUpdate(document, Uint8Array.from(update.update_blob));
      }
      validateCodeWorkspaceDocument(document);
      const storedVector = Uint8Array.from(row.state_vector);
      const actualVector = Y.encodeStateVector(document);
      if (!bytesEqual(storedVector, actualVector)) {
        throw new CodeSyncRepositoryError(
          "STORAGE_ERROR",
          "Stored Code workspace state vector is inconsistent",
        );
      }
      return {
        row,
        updates,
        document,
      };
    } catch (error) {
      document.destroy();
      if (error instanceof CodeSyncRepositoryError) throw error;
      throw new CodeSyncRepositoryError(
        "STORAGE_ERROR",
        "Stored Code workspace document is invalid",
        { cause: error },
      );
    }
  }
}

import { createHash, randomUUID } from "node:crypto";
import { statfsSync } from "node:fs";
import type Database from "better-sqlite3";
import {
  BOARD_BASE_METADATA_RESERVE_BYTES,
  BOARD_DOCUMENT_METADATA_RESERVE_BYTES,
  BOARD_LEGACY_IMPORT_METADATA_RESERVE_BYTES,
  BOARD_RECEIPT_METADATA_RESERVE_BYTES,
  BOARD_UPDATE_METADATA_RESERVE_BYTES,
  boardReceiptLogicalBytes,
} from "./storageUsageSchema.js";

export const DEFAULT_BOARD_REPOSITORY_LIMITS = Object.freeze({
  maxUpdateBytes: 16 * 1024 * 1024,
  maxSnapshotBytes: 128 * 1024 * 1024,
  maxStateVectorBytes: 4 * 1024 * 1024,
  maxLegacySourceBytes: 256 * 1024 * 1024,
});
const GUEST_BOARD_SOFT_QUOTA_BYTES = 512 * 1024 * 1024;
export const GUEST_BOARD_GLOBAL_SOFT_QUOTA_BYTES = 2 * 1024 * 1024 * 1024;

export interface BoardRepositoryLimits {
  maxUpdateBytes: number;
  maxSnapshotBytes: number;
  maxStateVectorBytes: number;
  maxLegacySourceBytes: number;
}

export interface BoardStorageCapacityProbe {
  freeDiskBytes(storageRoot: string): number;
}

export class NodeBoardStorageCapacityProbe
implements BoardStorageCapacityProbe {
  freeDiskBytes(storageRoot: string): number {
    const info = statfsSync(storageRoot);
    return Number(info.bavail) * Number(info.bsize);
  }
}

export interface BoardUpdateAdmissionPolicy {
  tenantSoftQuotaBytes: number;
  minFreeDiskBytes: number;
  storageRoot: string;
  capacityProbe?: BoardStorageCapacityProbe;
}

export type BoardEngine = "legacy" | "v2";
export type BoardLifecycle = "active" | "tombstoned";

export interface BoardRecord {
  id: string;
  lessonId: string | null;
  roomResourceId: string | null;
  engine: BoardEngine;
  lifecycle: BoardLifecycle;
  generation: number;
  protocolVersion: number;
  schemaVersion: number;
  createdAt: string;
  updatedAt: string;
}

export interface BoardDocumentRecord {
  boardId: string;
  documentKey: string;
  generation: number;
  snapshot: Uint8Array;
  stateVector: Uint8Array;
  snapshotSeq: number;
  lastSeq: number;
  snapshotBytes: number;
  stateVectorBytes: number;
  createdAt: string;
  updatedAt: string;
  compactedAt: string | null;
}

export interface BoardUpdateRecord {
  boardId: string;
  documentKey: string;
  generation: number;
  seq: number;
  messageId: string;
  actorId: string;
  clientId: string;
  update: Uint8Array;
  updateBytes: number;
  createdAt: string;
}

export interface LoadedBoardDocument {
  document: BoardDocumentRecord;
  updates: BoardUpdateRecord[];
  highWaterSeq: number;
}

export interface AppendBoardUpdateInput {
  boardId: string;
  documentKey: string;
  generation: number;
  messageId: string;
  actorId: string;
  clientId: string;
  update: Uint8Array;
  /** Runs inside a new update's SQLite transaction; false aborts the commit. */
  commitActivity?: () => boolean;
}

export interface AppendBoardUpdateResult {
  seq: number;
  duplicate: boolean;
  updateBytes: number;
  createdAt: string;
}

export interface CompactBoardDocumentInput {
  boardId: string;
  documentKey: string;
  generation: number;
  highWaterSeq: number;
  snapshot: Uint8Array;
  stateVector: Uint8Array;
}

export interface CompactBoardDocumentResult {
  document: BoardDocumentRecord;
  deletedUpdateCount: number;
  remainingUpdateCount: number;
}

export interface BoardDocumentMetrics {
  documentKey: string;
  snapshotSeq: number;
  lastSeq: number;
  snapshotBytes: number;
  stateVectorBytes: number;
  updateLogCount: number;
  updateLogBytes: number;
  totalBytes: number;
  compactedAt: string | null;
}

export interface BoardMetrics {
  boardId: string;
  generation: number;
  documentCount: number;
  snapshotBytes: number;
  stateVectorBytes: number;
  updateLogCount: number;
  updateLogBytes: number;
  idempotencyReceiptCount: number;
  idempotencyReceiptBytes: number;
  storageMetadataBytes: number;
  legacySourceBytes: number;
  quotaBytes: number;
  totalBytes: number;
  documents: BoardDocumentMetrics[];
}

export interface LegacyImportRecord {
  boardId: string;
  generation: number;
  sourceRevision: number;
  sourceJson: string;
  sourceSha256: string;
  sourceBytes: number;
  importedAt: string;
}

export type BoardRepositoryErrorCode =
  | "INVALID_ARGUMENT"
  | "SIZE_LIMIT"
  | "NOT_FOUND"
  | "BOARD_GONE"
  | "GENERATION_MISMATCH"
  | "IDEMPOTENCY_CONFLICT"
  | "RESOURCE_INACTIVE"
  | "DOCUMENT_CONFLICT"
  | "HIGH_WATER_INVALID"
  | "CORRUPT_LOG"
  | "TENANT_QUOTA"
  | "DISK_PRESSURE"
  | "STORAGE_ERROR";

export class BoardRepositoryError extends Error {
  constructor(
    public readonly code: BoardRepositoryErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "BoardRepositoryError";
  }
}

interface BoardRow {
  id: string;
  lesson_id: string | null;
  room_resource_id: string | null;
  engine: BoardEngine;
  lifecycle: BoardLifecycle;
  generation: number;
  protocol_version: number;
  schema_version: number;
  created_at: string;
  updated_at: string;
}

interface BoardDocumentRow {
  board_id: string;
  document_key: string;
  generation: number;
  snapshot_blob: Buffer;
  state_vector: Buffer;
  snapshot_seq: number;
  last_seq: number;
  snapshot_bytes: number;
  state_vector_bytes: number;
  created_at: string;
  updated_at: string;
  compacted_at: string | null;
}

interface BoardUpdateRow {
  board_id: string;
  document_key: string;
  generation: number;
  seq: number;
  message_id: string;
  actor_id: string;
  client_id: string;
  update_blob: Buffer;
  update_bytes: number;
  created_at: string;
}

interface BoardUpdateReceiptRow {
  seq: number;
  actor_id: string;
  client_id: string;
  update_sha256: string;
  update_bytes: number;
  created_at: string;
}

interface LegacyImportRow {
  board_id: string;
  generation: number;
  source_revision: number;
  source_json: string;
  source_sha256: string;
  source_bytes: number;
  imported_at: string;
}

interface BoardStorageUsageRow {
  board_id: string;
  generation: number;
  is_guest: 0 | 1;
  document_count: number;
  snapshot_bytes: number;
  state_vector_bytes: number;
  update_count: number;
  update_bytes: number;
  receipt_count: number;
  receipt_bytes: number;
  legacy_source_bytes: number;
  metadata_bytes: number;
  accounted_bytes: number;
}

export interface CreateBoardOptions {
  boardId?: string;
  engine?: BoardEngine;
  generation?: number;
  protocolVersion?: number;
  schemaVersion?: number;
}

export interface EnsureDocumentInput {
  boardId: string;
  documentKey: string;
  generation: number;
  snapshot?: Uint8Array;
  stateVector?: Uint8Array;
}

export interface InitializeDocumentInput {
  boardId: string;
  documentKey: string;
  generation: number;
  snapshot: Uint8Array;
  stateVector: Uint8Array;
}

export interface LoadDocumentInput {
  boardId: string;
  documentKey: string;
  generation: number;
}

export interface BoardGenerationInput {
  boardId: string;
  generation: number;
}

export interface RecordLegacyImportInput extends BoardGenerationInput {
  sourceRevision: number;
  sourceJson: string;
  expectedSha256?: string;
}

const OPAQUE_ID_PATTERN = /^[A-Za-z0-9_-]+$/u;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const MAX_OPAQUE_ID_LENGTH = 128;

function invalid(message: string): never {
  throw new BoardRepositoryError("INVALID_ARGUMENT", message);
}

function validateOpaqueId(value: string, label: string): string {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > MAX_OPAQUE_ID_LENGTH
    || !OPAQUE_ID_PATTERN.test(value)
  ) {
    invalid(`${label} must be a 1-${MAX_OPAQUE_ID_LENGTH} character opaque ID`);
  }
  return value;
}

export function validateBoardDocumentKey(value: string): string {
  if (value === "manifest") return value;
  if (value.startsWith("page:") && UUID_PATTERN.test(value.slice(5))) return value;
  return invalid("documentKey must be 'manifest' or 'page:<uuid>'");
}

function validatePositiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) invalid(`${label} must be a positive safe integer`);
  return value;
}

function validateNonNegativeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) invalid(`${label} must be a non-negative safe integer`);
  return value;
}

function validateLimit(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) invalid(`${label} must be a positive safe integer`);
  return value;
}

function copyBytes(
  value: Uint8Array,
  label: string,
  maxBytes: number,
  allowEmpty: boolean,
): Buffer {
  if (!(value instanceof Uint8Array)) invalid(`${label} must be a Uint8Array`);
  if (!allowEmpty && value.byteLength === 0) invalid(`${label} must not be empty`);
  if (value.byteLength > maxBytes) {
    throw new BoardRepositoryError(
      "SIZE_LIMIT",
      `${label} is ${value.byteLength} bytes; the per-value limit is ${maxBytes} bytes`,
    );
  }
  return Buffer.from(value);
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && Buffer.from(left).equals(Buffer.from(right));
}

function hashBytes(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function toBoardRecord(row: BoardRow): BoardRecord {
  return {
    id: row.id,
    lessonId: row.lesson_id,
    roomResourceId: row.room_resource_id,
    engine: row.engine,
    lifecycle: row.lifecycle,
    generation: row.generation,
    protocolVersion: row.protocol_version,
    schemaVersion: row.schema_version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toDocumentRecord(row: BoardDocumentRow): BoardDocumentRecord {
  return {
    boardId: row.board_id,
    documentKey: row.document_key,
    generation: row.generation,
    snapshot: Uint8Array.from(row.snapshot_blob),
    stateVector: Uint8Array.from(row.state_vector),
    snapshotSeq: row.snapshot_seq,
    lastSeq: row.last_seq,
    snapshotBytes: row.snapshot_bytes,
    stateVectorBytes: row.state_vector_bytes,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    compactedAt: row.compacted_at,
  };
}

function toUpdateRecord(row: BoardUpdateRow): BoardUpdateRecord {
  return {
    boardId: row.board_id,
    documentKey: row.document_key,
    generation: row.generation,
    seq: row.seq,
    messageId: row.message_id,
    actorId: row.actor_id,
    clientId: row.client_id,
    update: Uint8Array.from(row.update_blob),
    updateBytes: row.update_bytes,
    createdAt: row.created_at,
  };
}

function toLegacyImportRecord(row: LegacyImportRow): LegacyImportRecord {
  return {
    boardId: row.board_id,
    generation: row.generation,
    sourceRevision: row.source_revision,
    sourceJson: row.source_json,
    sourceSha256: row.source_sha256,
    sourceBytes: row.source_bytes,
    importedAt: row.imported_at,
  };
}

export class BoardRepository {
  readonly limits: BoardRepositoryLimits;
  private readonly updateAdmission?: Readonly<{
    tenantSoftQuotaBytes: number;
    minFreeDiskBytes: number;
    storageRoot: string;
    capacityProbe: BoardStorageCapacityProbe;
  }>;

  constructor(
    private readonly db: Database.Database,
    limits: Partial<BoardRepositoryLimits> = {},
    updateAdmission?: BoardUpdateAdmissionPolicy,
  ) {
    this.limits = {
      maxUpdateBytes: validateLimit(
        limits.maxUpdateBytes ?? DEFAULT_BOARD_REPOSITORY_LIMITS.maxUpdateBytes,
        "maxUpdateBytes",
      ),
      maxSnapshotBytes: validateLimit(
        limits.maxSnapshotBytes ?? DEFAULT_BOARD_REPOSITORY_LIMITS.maxSnapshotBytes,
        "maxSnapshotBytes",
      ),
      maxStateVectorBytes: validateLimit(
        limits.maxStateVectorBytes ?? DEFAULT_BOARD_REPOSITORY_LIMITS.maxStateVectorBytes,
        "maxStateVectorBytes",
      ),
      maxLegacySourceBytes: validateLimit(
        limits.maxLegacySourceBytes ?? DEFAULT_BOARD_REPOSITORY_LIMITS.maxLegacySourceBytes,
        "maxLegacySourceBytes",
      ),
    };
    if (updateAdmission) {
      if (!updateAdmission.storageRoot.trim()) {
        invalid("storageRoot must not be empty");
      }
      this.updateAdmission = {
        tenantSoftQuotaBytes: validateLimit(
          updateAdmission.tenantSoftQuotaBytes,
          "tenantSoftQuotaBytes",
        ),
        minFreeDiskBytes: validateLimit(
          updateAdmission.minFreeDiskBytes,
          "minFreeDiskBytes",
        ),
        storageRoot: updateAdmission.storageRoot,
        capacityProbe:
          updateAdmission.capacityProbe
          ?? new NodeBoardStorageCapacityProbe(),
      };
    }
    this.db.pragma("foreign_keys = ON");
  }

  /**
   * File-backed repositories can be reconstructed by a read-only worker
   * connection without copying the durable update log through the main thread.
   * In-memory databases deliberately return null because they are connection
   * local; compaction keeps a transfer-based fallback for tests.
   */
  compactionDatabasePath(): string | null {
    return this.db.memory ? null : this.db.name;
  }

  createBoardForLesson(lessonId: string, options: CreateBoardOptions = {}): BoardRecord {
    validateOpaqueId(lessonId, "lessonId");
    const boardId = validateOpaqueId(options.boardId ?? randomUUID(), "boardId");
    const generation = validatePositiveInteger(options.generation ?? 1, "generation");
    const protocolVersion = validatePositiveInteger(options.protocolVersion ?? 1, "protocolVersion");
    const schemaVersion = validatePositiveInteger(options.schemaVersion ?? 1, "schemaVersion");
    const engine = options.engine ?? "v2";
    if (engine !== "legacy" && engine !== "v2") invalid("engine must be 'legacy' or 'v2'");

    return this.db.transaction(() => {
      const lesson = this.db.prepare(`
        SELECT id, tutor_id FROM lessons WHERE id = ?
      `).get(lessonId) as
        | { id: string; tutor_id: string }
        | undefined;
      if (!lesson) throw new BoardRepositoryError("NOT_FOUND", `lesson '${lessonId}' does not exist`);

      const now = new Date().toISOString();
      const existingBoard = this.db.prepare(`
        SELECT * FROM boards WHERE lesson_id = ?
      `).get(lessonId) as BoardRow | undefined;
      if (!existingBoard) {
        const initialBytes = BOARD_BASE_METADATA_RESERVE_BYTES
          + BOARD_DOCUMENT_METADATA_RESERVE_BYTES;
        this.assertTenantStorageAdmission({
          tutorId: lesson.tutor_id,
          guestBoardId: null,
          quotaDeltaBytes: initialBytes,
          diskWriteBytes: initialBytes,
        });
      }
      this.db.prepare(`
        INSERT INTO boards (
          id, lesson_id, engine, lifecycle, generation, protocol_version,
          schema_version, created_at, updated_at
        ) VALUES (?, ?, ?, 'active', ?, ?, ?, ?, ?)
        ON CONFLICT(lesson_id) DO NOTHING
      `).run(
        boardId,
        lessonId,
        engine,
        generation,
        protocolVersion,
        schemaVersion,
        now,
        now,
      );

      const row = this.db.prepare("SELECT * FROM boards WHERE lesson_id = ?").get(lessonId) as BoardRow;
      const existingManifest = this.db.prepare(`
        SELECT 1
        FROM board_documents
        WHERE board_id = ? AND document_key = 'manifest' AND generation = ?
      `).get(row.id, row.generation);
      if (existingBoard && !existingManifest) {
        this.assertStorageAdmission(
          row.id,
          BOARD_DOCUMENT_METADATA_RESERVE_BYTES,
          BOARD_DOCUMENT_METADATA_RESERVE_BYTES,
        );
      }
      this.db.prepare(`
        INSERT INTO board_documents (
          board_id, document_key, generation, snapshot_blob, state_vector,
          snapshot_seq, last_seq, snapshot_bytes, state_vector_bytes,
          created_at, updated_at
        ) VALUES (?, 'manifest', ?, X'', X'', 0, 0, 0, 0, ?, ?)
        ON CONFLICT(board_id, document_key, generation) DO NOTHING
      `).run(row.id, row.generation, now, now);
      return toBoardRecord(row);
    }).immediate();
  }

  createBoardForRoomResource(
    roomResourceId: string,
    options: CreateBoardOptions = {},
  ): BoardRecord {
    validateOpaqueId(roomResourceId, "roomResourceId");
    const boardId = validateOpaqueId(options.boardId ?? randomUUID(), "boardId");
    const generation = validatePositiveInteger(options.generation ?? 1, "generation");
    const protocolVersion = validatePositiveInteger(options.protocolVersion ?? 1, "protocolVersion");
    const schemaVersion = validatePositiveInteger(options.schemaVersion ?? 1, "schemaVersion");
    const engine = options.engine ?? "v2";
    if (engine !== "legacy" && engine !== "v2") invalid("engine must be 'legacy' or 'v2'");

    return this.db.transaction(() => {
      const resource = this.db.prepare(`
        SELECT id FROM guest_room_resources WHERE id = ? AND kind = 'board'
      `).get(roomResourceId) as { id: string } | undefined;
      if (!resource) {
        throw new BoardRepositoryError(
          "NOT_FOUND",
          `Board room resource '${roomResourceId}' does not exist`,
        );
      }
      const now = new Date().toISOString();
      const existingBoard = this.db.prepare(`
        SELECT * FROM boards WHERE room_resource_id = ?
      `).get(roomResourceId) as BoardRow | undefined;
      if (!existingBoard) {
        const initialBytes = BOARD_BASE_METADATA_RESERVE_BYTES
          + BOARD_DOCUMENT_METADATA_RESERVE_BYTES;
        this.assertTenantStorageAdmission({
          tutorId: null,
          guestBoardId: null,
          quotaDeltaBytes: initialBytes,
          diskWriteBytes: initialBytes,
        });
      }
      this.db.prepare(`
        INSERT INTO boards (
          id, lesson_id, room_resource_id, engine, lifecycle, generation,
          protocol_version, schema_version, created_at, updated_at
        ) VALUES (?, NULL, ?, ?, 'active', ?, ?, ?, ?, ?)
        ON CONFLICT(room_resource_id) DO NOTHING
      `).run(
        boardId,
        roomResourceId,
        engine,
        generation,
        protocolVersion,
        schemaVersion,
        now,
        now,
      );
      const row = this.db.prepare(`
        SELECT * FROM boards WHERE room_resource_id = ?
      `).get(roomResourceId) as BoardRow;
      const existingManifest = this.db.prepare(`
        SELECT 1
        FROM board_documents
        WHERE board_id = ? AND document_key = 'manifest' AND generation = ?
      `).get(row.id, row.generation);
      if (existingBoard && !existingManifest) {
        this.assertStorageAdmission(
          row.id,
          BOARD_DOCUMENT_METADATA_RESERVE_BYTES,
          BOARD_DOCUMENT_METADATA_RESERVE_BYTES,
        );
      }
      this.db.prepare(`
        INSERT INTO board_documents (
          board_id, document_key, generation, snapshot_blob, state_vector,
          snapshot_seq, last_seq, snapshot_bytes, state_vector_bytes,
          created_at, updated_at
        ) VALUES (?, 'manifest', ?, X'', X'', 0, 0, 0, 0, ?, ?)
        ON CONFLICT(board_id, document_key, generation) DO NOTHING
      `).run(row.id, row.generation, now, now);
      return toBoardRecord(row);
    }).immediate();
  }

  getBoardForLesson(lessonId: string): BoardRecord | null {
    validateOpaqueId(lessonId, "lessonId");
    const row = this.db.prepare("SELECT * FROM boards WHERE lesson_id = ?").get(lessonId) as BoardRow | undefined;
    return row ? toBoardRecord(row) : null;
  }

  getBoardForRoomResource(roomResourceId: string): BoardRecord | null {
    validateOpaqueId(roomResourceId, "roomResourceId");
    const row = this.db.prepare(`
      SELECT * FROM boards WHERE room_resource_id = ?
    `).get(roomResourceId) as BoardRow | undefined;
    return row ? toBoardRecord(row) : null;
  }

  getBoard(boardId: string): BoardRecord | null {
    validateOpaqueId(boardId, "boardId");
    const row = this.db.prepare("SELECT * FROM boards WHERE id = ?").get(boardId) as BoardRow | undefined;
    return row ? toBoardRecord(row) : null;
  }

  ensureDocument(input: EnsureDocumentInput): BoardDocumentRecord {
    const { boardId, documentKey, generation } = this.validateDocumentIdentity(input);
    const snapshotProvided = input.snapshot !== undefined;
    const stateVectorProvided = input.stateVector !== undefined;
    const snapshot = copyBytes(
      input.snapshot ?? new Uint8Array(),
      "snapshot",
      this.limits.maxSnapshotBytes,
      true,
    );
    const stateVector = copyBytes(
      input.stateVector ?? new Uint8Array(),
      "stateVector",
      this.limits.maxStateVectorBytes,
      true,
    );

    return this.db.transaction(() => {
      this.requireCurrentBoard(boardId, generation);
      const now = new Date().toISOString();
      const existing = this.db.prepare(`
        SELECT 1 FROM board_documents
        WHERE board_id = ? AND document_key = ? AND generation = ?
      `).get(boardId, documentKey, generation);
      if (!existing) {
        const requestedBytes = snapshot.byteLength + stateVector.byteLength
          + BOARD_DOCUMENT_METADATA_RESERVE_BYTES;
        this.assertStorageAdmission(
          boardId,
          requestedBytes,
          requestedBytes,
        );
      }
      this.db.prepare(`
        INSERT INTO board_documents (
          board_id, document_key, generation, snapshot_blob, state_vector,
          snapshot_seq, last_seq, snapshot_bytes, state_vector_bytes,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 0, 0, ?, ?, ?, ?)
        ON CONFLICT(board_id, document_key, generation) DO NOTHING
      `).run(
        boardId,
        documentKey,
        generation,
        snapshot,
        stateVector,
        snapshot.byteLength,
        stateVector.byteLength,
        now,
        now,
      );
      const row = this.requireDocumentRow(boardId, documentKey, generation);
      if (
        (snapshotProvided && !bytesEqual(row.snapshot_blob, snapshot))
        || (stateVectorProvided && !bytesEqual(row.state_vector, stateVector))
      ) {
        throw new BoardRepositoryError(
          "DOCUMENT_CONFLICT",
          `document '${documentKey}' already exists with different initial state`,
        );
      }
      return toDocumentRecord(row);
    }).immediate();
  }

  initializeEmptyDocument(input: InitializeDocumentInput): BoardDocumentRecord {
    const { boardId, documentKey, generation } = this.validateDocumentIdentity(input);
    const snapshot = copyBytes(input.snapshot, "snapshot", this.limits.maxSnapshotBytes, true);
    const stateVector = copyBytes(
      input.stateVector,
      "stateVector",
      this.limits.maxStateVectorBytes,
      true,
    );

    return this.db.transaction(() => {
      this.requireCurrentBoard(boardId, generation);
      const current = this.requireDocumentRow(boardId, documentKey, generation);
      if (bytesEqual(current.snapshot_blob, snapshot) && bytesEqual(current.state_vector, stateVector)) {
        return toDocumentRecord(current);
      }
      if (
        current.snapshot_seq !== 0
        || current.last_seq !== 0
        || current.snapshot_bytes !== 0
        || current.state_vector_bytes !== 0
      ) {
        throw new BoardRepositoryError(
          "DOCUMENT_CONFLICT",
          `document '${documentKey}' is no longer an uninitialized empty document`,
        );
      }

      const now = new Date().toISOString();
      const requestedBytes = snapshot.byteLength + stateVector.byteLength;
      this.assertStorageAdmission(
        boardId,
        requestedBytes,
        requestedBytes,
      );
      const update = this.db.prepare(`
        UPDATE board_documents
        SET snapshot_blob = ?, state_vector = ?, snapshot_bytes = ?,
            state_vector_bytes = ?, updated_at = ?
        WHERE board_id = ? AND document_key = ? AND generation = ?
          AND snapshot_seq = 0 AND last_seq = 0
          AND snapshot_bytes = 0 AND state_vector_bytes = 0
      `).run(
        snapshot,
        stateVector,
        snapshot.byteLength,
        stateVector.byteLength,
        now,
        boardId,
        documentKey,
        generation,
      );
      if (update.changes !== 1) {
        throw new BoardRepositoryError(
          "DOCUMENT_CONFLICT",
          `document '${documentKey}' changed before initialization completed`,
        );
      }
      this.db.prepare("UPDATE boards SET updated_at = ? WHERE id = ?").run(now, boardId);
      return toDocumentRecord(this.requireDocumentRow(boardId, documentKey, generation));
    }).immediate();
  }

  appendUpdate(input: AppendBoardUpdateInput): AppendBoardUpdateResult {
    const { boardId, documentKey, generation } = this.validateDocumentIdentity(input);
    const messageId = validateOpaqueId(input.messageId, "messageId");
    const actorId = validateOpaqueId(input.actorId, "actorId");
    const clientId = validateOpaqueId(input.clientId, "clientId");
    const update = copyBytes(input.update, "update", this.limits.maxUpdateBytes, false);
    const updateSha256 = hashBytes(update);

    return this.db.transaction(() => {
      this.requireCurrentBoard(boardId, generation);
      this.requireDocumentRow(boardId, documentKey, generation);

      const duplicate = this.matchUpdateReceipt({
        boardId,
        documentKey,
        generation,
        messageId,
        actorId,
        clientId,
        updateSha256,
        updateBytes: update.byteLength,
      });
      if (duplicate) return duplicate;

      const now = new Date().toISOString();
      const receiptBytes = boardReceiptLogicalBytes({
        boardId,
        documentKey,
        messageId,
        actorId,
        clientId,
        updateSha256,
        createdAt: now,
      });
      const requestedBytes = update.byteLength
        + BOARD_UPDATE_METADATA_RESERVE_BYTES
        + receiptBytes
        + BOARD_RECEIPT_METADATA_RESERVE_BYTES;
      this.assertStorageAdmission(
        boardId,
        requestedBytes,
        requestedBytes,
      );
      const increment = this.db.prepare(`
        UPDATE board_documents
        SET last_seq = last_seq + 1, updated_at = ?
        WHERE board_id = ? AND document_key = ? AND generation = ?
      `).run(now, boardId, documentKey, generation);
      if (increment.changes !== 1) {
        throw new BoardRepositoryError("NOT_FOUND", `document '${documentKey}' does not exist`);
      }
      const sequence = this.db.prepare(`
        SELECT last_seq
        FROM board_documents
        WHERE board_id = ? AND document_key = ? AND generation = ?
      `).get(boardId, documentKey, generation) as { last_seq: number };

      this.db.prepare(`
        INSERT INTO board_updates (
          board_id, document_key, generation, seq, message_id, actor_id,
          client_id, update_blob, update_bytes, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        boardId,
        documentKey,
        generation,
        sequence.last_seq,
        messageId,
        actorId,
        clientId,
        update,
        update.byteLength,
        now,
      );
      this.db.prepare(`
        INSERT INTO board_update_receipts (
          board_id, document_key, generation, message_id, seq, actor_id,
          client_id, update_sha256, update_bytes, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        boardId,
        documentKey,
        generation,
        messageId,
        sequence.last_seq,
        actorId,
        clientId,
        updateSha256,
        update.byteLength,
        now,
      );
      this.db.prepare("UPDATE boards SET updated_at = ? WHERE id = ?").run(now, boardId);
      if (input.commitActivity && !input.commitActivity()) {
        throw new BoardRepositoryError(
          "RESOURCE_INACTIVE",
          "Guest Board resource is no longer active",
        );
      }
      return {
        seq: sequence.last_seq,
        duplicate: false,
        updateBytes: update.byteLength,
        createdAt: now,
      };
    }).immediate();
  }

  findUpdateReceipt(
    input: AppendBoardUpdateInput,
  ): AppendBoardUpdateResult | null {
    const { boardId, documentKey, generation } =
      this.validateDocumentIdentity(input);
    const messageId = validateOpaqueId(input.messageId, "messageId");
    const actorId = validateOpaqueId(input.actorId, "actorId");
    const clientId = validateOpaqueId(input.clientId, "clientId");
    const update = copyBytes(
      input.update,
      "update",
      this.limits.maxUpdateBytes,
      false,
    );

    this.requireCurrentBoard(boardId, generation);
    this.requireDocumentRow(boardId, documentKey, generation);
    return this.matchUpdateReceipt({
      boardId,
      documentKey,
      generation,
      messageId,
      actorId,
      clientId,
      updateSha256: hashBytes(update),
      updateBytes: update.byteLength,
    });
  }

  private matchUpdateReceipt(input: {
    boardId: string;
    documentKey: string;
    generation: number;
    messageId: string;
    actorId: string;
    clientId: string;
    updateSha256: string;
    updateBytes: number;
  }): AppendBoardUpdateResult | null {
    const receipt = this.db.prepare(`
      SELECT seq, actor_id, client_id, update_sha256, update_bytes, created_at
      FROM board_update_receipts
      WHERE board_id = ? AND document_key = ? AND generation = ? AND message_id = ?
    `).get(
      input.boardId,
      input.documentKey,
      input.generation,
      input.messageId,
    ) as BoardUpdateReceiptRow | undefined;
    if (!receipt) return null;
    if (
      receipt.actor_id !== input.actorId
      || receipt.client_id !== input.clientId
      || receipt.update_sha256 !== input.updateSha256
      || receipt.update_bytes !== input.updateBytes
    ) {
      throw new BoardRepositoryError(
        "IDEMPOTENCY_CONFLICT",
        `messageId '${input.messageId}' was already used with different update data`,
      );
    }
    return {
      seq: receipt.seq,
      duplicate: true,
      updateBytes: receipt.update_bytes,
      createdAt: receipt.created_at,
    };
  }

  private assertStorageAdmission(
    boardId: string,
    quotaDeltaBytes: number,
    diskWriteBytes: number,
  ): void {
    if (!this.updateAdmission) return;
    const tenant = this.db.prepare(`
      SELECT lesson.tutor_id, board.room_resource_id
      FROM boards board
      LEFT JOIN lessons lesson ON lesson.id = board.lesson_id
      WHERE board.id = ?
    `).get(boardId) as {
      tutor_id: string | null;
      room_resource_id: string | null;
    } | undefined;
    if (!tenant) {
      throw new BoardRepositoryError(
        "NOT_FOUND",
        `board '${boardId}' has no storage tenant`,
      );
    }
    this.assertTenantStorageAdmission({
      tutorId: tenant.tutor_id,
      guestBoardId: tenant.tutor_id ? null : boardId,
      quotaDeltaBytes,
      diskWriteBytes,
    });
  }

  private assertTenantStorageAdmission(input: {
    tutorId: string | null;
    guestBoardId: string | null;
    quotaDeltaBytes: number;
    diskWriteBytes: number;
  }): void {
    const policy = this.updateAdmission;
    if (!policy) return;

    const quotaDeltaBytes = Math.max(0, input.quotaDeltaBytes);
    if (quotaDeltaBytes > 0 && input.tutorId) {
      const usage = this.db.prepare(`
        SELECT COALESCE(SUM(usage.accounted_bytes), 0) AS used_bytes
        FROM board_storage_usage usage
        JOIN boards board ON board.id = usage.board_id
        JOIN lessons lesson ON lesson.id = board.lesson_id
        WHERE lesson.tutor_id = ?
      `).get(input.tutorId) as { used_bytes: number };
      if (usage.used_bytes > policy.tenantSoftQuotaBytes - quotaDeltaBytes) {
        throw new BoardRepositoryError(
          "TENANT_QUOTA",
          "tutor Board durable storage soft quota would be exceeded",
        );
      }
    } else if (quotaDeltaBytes > 0) {
      const boardUsage = input.guestBoardId
        ? this.db.prepare(`
            SELECT COALESCE(SUM(accounted_bytes), 0) AS used_bytes
            FROM board_storage_usage WHERE board_id = ?
          `).get(input.guestBoardId) as { used_bytes: number }
        : { used_bytes: 0 };
      const boardSoftQuotaBytes = Math.min(
        policy.tenantSoftQuotaBytes,
        GUEST_BOARD_SOFT_QUOTA_BYTES,
      );
      if (boardUsage.used_bytes > boardSoftQuotaBytes - quotaDeltaBytes) {
        throw new BoardRepositoryError(
          "TENANT_QUOTA",
          "guest Board durable storage soft quota would be exceeded",
        );
      }

      const aggregateGuestUsage = this.db.prepare(`
        SELECT accounted_bytes AS used_bytes
        FROM board_guest_storage_usage WHERE singleton = 1
      `).get() as { used_bytes: number };
      const globalSoftQuotaBytes = Math.min(
        policy.tenantSoftQuotaBytes,
        GUEST_BOARD_GLOBAL_SOFT_QUOTA_BYTES,
      );
      if (
        aggregateGuestUsage.used_bytes
        > globalSoftQuotaBytes - quotaDeltaBytes
      ) {
        throw new BoardRepositoryError(
          "TENANT_QUOTA",
          "aggregate guest Board durable storage soft quota would be exceeded",
        );
      }
    }

    let freeBytes: number;
    try {
      freeBytes = policy.capacityProbe.freeDiskBytes(policy.storageRoot);
    } catch (error) {
      throw new BoardRepositoryError(
        "STORAGE_ERROR",
        `could not inspect Board storage capacity: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    if (!Number.isFinite(freeBytes) || freeBytes < 0) {
      throw new BoardRepositoryError(
        "STORAGE_ERROR",
        "Board storage capacity probe returned invalid free bytes",
      );
    }
    if (freeBytes - Math.max(0, input.diskWriteBytes) < policy.minFreeDiskBytes) {
      throw new BoardRepositoryError(
        "DISK_PRESSURE",
        "server free-disk floor would be crossed by this Board write",
      );
    }
  }

  loadDocument(input: LoadDocumentInput): LoadedBoardDocument {
    const { boardId, documentKey, generation } = this.validateDocumentIdentity(input);
    return this.db.transaction(() => {
      this.requireCurrentBoard(boardId, generation);
      const documentRow = this.requireDocumentRow(boardId, documentKey, generation);
      const updateRows = this.db.prepare(`
        SELECT *
        FROM board_updates
        WHERE board_id = ? AND document_key = ? AND generation = ?
          AND seq > ? AND seq <= ?
        ORDER BY seq ASC
      `).all(
        boardId,
        documentKey,
        generation,
        documentRow.snapshot_seq,
        documentRow.last_seq,
      ) as BoardUpdateRow[];

      const expectedUpdates = documentRow.last_seq - documentRow.snapshot_seq;
      if (updateRows.length !== expectedUpdates) {
        throw new BoardRepositoryError(
          "CORRUPT_LOG",
          `document '${documentKey}' is missing durable updates between sequences `
            + `${documentRow.snapshot_seq + 1} and ${documentRow.last_seq}`,
        );
      }
      return {
        document: toDocumentRecord(documentRow),
        updates: updateRows.map(toUpdateRecord),
        highWaterSeq: documentRow.last_seq,
      };
    })();
  }

  compactDocument(input: CompactBoardDocumentInput): CompactBoardDocumentResult {
    const { boardId, documentKey, generation } = this.validateDocumentIdentity(input);
    const highWaterSeq = validateNonNegativeInteger(input.highWaterSeq, "highWaterSeq");
    const snapshot = copyBytes(input.snapshot, "snapshot", this.limits.maxSnapshotBytes, true);
    const stateVector = copyBytes(
      input.stateVector,
      "stateVector",
      this.limits.maxStateVectorBytes,
      true,
    );

    return this.db.transaction(() => {
      this.requireCurrentBoard(boardId, generation);
      const current = this.requireDocumentRow(boardId, documentKey, generation);
      if (highWaterSeq < current.snapshot_seq || highWaterSeq > current.last_seq) {
        throw new BoardRepositoryError(
          "HIGH_WATER_INVALID",
          `highWaterSeq ${highWaterSeq} is outside the committed range `
            + `${current.snapshot_seq}-${current.last_seq}`,
        );
      }
      if (highWaterSeq === current.snapshot_seq) {
        if (
          !bytesEqual(current.snapshot_blob, snapshot)
          || !bytesEqual(current.state_vector, stateVector)
        ) {
          throw new BoardRepositoryError(
            "HIGH_WATER_INVALID",
            "a snapshot at this high-water sequence already exists with different bytes",
          );
        }
        return {
          document: toDocumentRecord(current),
          deletedUpdateCount: 0,
          remainingUpdateCount: current.last_seq - current.snapshot_seq,
        };
      }

      const range = this.db.prepare(`
        SELECT
          COUNT(*) AS update_count,
          COALESCE(SUM(update_bytes), 0) AS update_bytes
        FROM board_updates
        WHERE board_id = ? AND document_key = ? AND generation = ?
          AND seq > ? AND seq <= ?
      `).get(
        boardId,
        documentKey,
        generation,
        current.snapshot_seq,
        highWaterSeq,
      ) as { update_count: number; update_bytes: number };
      const expectedUpdates = highWaterSeq - current.snapshot_seq;
      if (range.update_count !== expectedUpdates) {
        throw new BoardRepositoryError(
          "CORRUPT_LOG",
          `cannot compact document '${documentKey}': its update range is incomplete`,
        );
      }

      const quotaDeltaBytes = snapshot.byteLength + stateVector.byteLength
        - current.snapshot_bytes - current.state_vector_bytes
        - range.update_bytes
        - expectedUpdates * BOARD_UPDATE_METADATA_RESERVE_BYTES;
      this.assertStorageAdmission(
        boardId,
        quotaDeltaBytes,
        snapshot.byteLength + stateVector.byteLength,
      );

      const now = new Date().toISOString();
      this.db.prepare(`
        UPDATE board_documents
        SET snapshot_blob = ?, state_vector = ?, snapshot_seq = ?,
            snapshot_bytes = ?, state_vector_bytes = ?,
            updated_at = ?, compacted_at = ?
        WHERE board_id = ? AND document_key = ? AND generation = ?
      `).run(
        snapshot,
        stateVector,
        highWaterSeq,
        snapshot.byteLength,
        stateVector.byteLength,
        now,
        now,
        boardId,
        documentKey,
        generation,
      );
      const deletion = this.db.prepare(`
        DELETE FROM board_updates
        WHERE board_id = ? AND document_key = ? AND generation = ? AND seq <= ?
      `).run(boardId, documentKey, generation, highWaterSeq);
      if (deletion.changes !== expectedUpdates) {
        throw new BoardRepositoryError(
          "CORRUPT_LOG",
          `compaction deleted ${deletion.changes} updates; expected ${expectedUpdates}`,
        );
      }
      this.db.prepare("UPDATE boards SET updated_at = ? WHERE id = ?").run(now, boardId);
      const compacted = this.requireDocumentRow(boardId, documentKey, generation);
      return {
        document: toDocumentRecord(compacted),
        deletedUpdateCount: deletion.changes,
        remainingUpdateCount: compacted.last_seq - compacted.snapshot_seq,
      };
    }).immediate();
  }

  writeSnapshotThrough(input: CompactBoardDocumentInput): CompactBoardDocumentResult {
    return this.compactDocument(input);
  }

  getBoardMetrics(input: BoardGenerationInput): BoardMetrics {
    const boardId = validateOpaqueId(input.boardId, "boardId");
    const generation = validatePositiveInteger(input.generation, "generation");
    return this.db.transaction(() => {
      this.requireCurrentBoard(boardId, generation);
      const rows = this.db.prepare(`
        SELECT
          d.document_key,
          d.snapshot_seq,
          d.last_seq,
          d.snapshot_bytes,
          d.state_vector_bytes,
          d.compacted_at,
          COUNT(u.seq) AS update_count,
          COALESCE(SUM(u.update_bytes), 0) AS update_bytes
        FROM board_documents d
        LEFT JOIN board_updates u
          ON u.board_id = d.board_id
          AND u.document_key = d.document_key
          AND u.generation = d.generation
        WHERE d.board_id = ? AND d.generation = ?
        GROUP BY
          d.board_id, d.document_key, d.generation, d.snapshot_seq, d.last_seq,
          d.snapshot_bytes, d.state_vector_bytes, d.compacted_at
        ORDER BY d.document_key
      `).all(boardId, generation) as Array<{
        document_key: string;
        snapshot_seq: number;
        last_seq: number;
        snapshot_bytes: number;
        state_vector_bytes: number;
        compacted_at: string | null;
        update_count: number;
        update_bytes: number;
      }>;
      const usage = this.db.prepare(`
        SELECT * FROM board_storage_usage
        WHERE board_id = ? AND generation = ?
      `).get(boardId, generation) as BoardStorageUsageRow | undefined;
      if (!usage) {
        throw new BoardRepositoryError(
          "STORAGE_ERROR",
          `board '${boardId}' has no durable storage usage counter`,
        );
      }

      const documents = rows.map((row): BoardDocumentMetrics => ({
        documentKey: row.document_key,
        snapshotSeq: row.snapshot_seq,
        lastSeq: row.last_seq,
        snapshotBytes: row.snapshot_bytes,
        stateVectorBytes: row.state_vector_bytes,
        updateLogCount: row.update_count,
        updateLogBytes: row.update_bytes,
        totalBytes: row.snapshot_bytes + row.state_vector_bytes + row.update_bytes,
        compactedAt: row.compacted_at,
      }));
      const snapshotBytes = documents.reduce((total, document) => total + document.snapshotBytes, 0);
      const stateVectorBytes = documents.reduce((total, document) => total + document.stateVectorBytes, 0);
      const updateLogCount = documents.reduce((total, document) => total + document.updateLogCount, 0);
      const updateLogBytes = documents.reduce((total, document) => total + document.updateLogBytes, 0);
      return {
        boardId,
        generation,
        documentCount: documents.length,
        snapshotBytes,
        stateVectorBytes,
        updateLogCount,
        updateLogBytes,
        idempotencyReceiptCount: usage.receipt_count,
        idempotencyReceiptBytes: usage.receipt_bytes,
        storageMetadataBytes: usage.metadata_bytes,
        legacySourceBytes: usage.legacy_source_bytes,
        quotaBytes: usage.accounted_bytes,
        totalBytes: usage.accounted_bytes,
        documents,
      };
    })();
  }

  recordLegacyImport(input: RecordLegacyImportInput): LegacyImportRecord {
    const boardId = validateOpaqueId(input.boardId, "boardId");
    const generation = validatePositiveInteger(input.generation, "generation");
    const sourceRevision = validateNonNegativeInteger(input.sourceRevision, "sourceRevision");
    if (typeof input.sourceJson !== "string") invalid("sourceJson must be a string");
    const sourceBytes = Buffer.byteLength(input.sourceJson, "utf8");
    if (sourceBytes > this.limits.maxLegacySourceBytes) {
      throw new BoardRepositoryError(
        "SIZE_LIMIT",
        `sourceJson is ${sourceBytes} bytes; the per-source limit is ${this.limits.maxLegacySourceBytes} bytes`,
      );
    }
    try {
      JSON.parse(input.sourceJson);
    } catch {
      invalid("sourceJson must contain valid JSON");
    }
    const sourceSha256 = createHash("sha256").update(input.sourceJson, "utf8").digest("hex");
    if (input.expectedSha256 !== undefined) {
      if (!SHA256_PATTERN.test(input.expectedSha256)) invalid("expectedSha256 must be a lowercase SHA-256 hex digest");
      if (input.expectedSha256 !== sourceSha256) {
        throw new BoardRepositoryError("INVALID_ARGUMENT", "sourceJson does not match expectedSha256");
      }
    }

    return this.db.transaction(() => {
      this.requireCurrentBoard(boardId, generation);
      const existing = this.getLegacyImportRow(boardId, generation);
      if (existing) {
        if (
          existing.source_revision !== sourceRevision
          || existing.source_json !== input.sourceJson
          || existing.source_sha256 !== sourceSha256
        ) {
          throw new BoardRepositoryError(
            "IDEMPOTENCY_CONFLICT",
            "a different immutable legacy source is already recorded for this board generation",
          );
        }
        return toLegacyImportRecord(existing);
      }

      const requestedBytes = sourceBytes
        + BOARD_LEGACY_IMPORT_METADATA_RESERVE_BYTES;
      this.assertStorageAdmission(
        boardId,
        requestedBytes,
        requestedBytes,
      );
      const importedAt = new Date().toISOString();
      this.db.prepare(`
        INSERT INTO board_legacy_imports (
          board_id, generation, source_revision, source_json, source_sha256,
          source_bytes, imported_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        boardId,
        generation,
        sourceRevision,
        input.sourceJson,
        sourceSha256,
        sourceBytes,
        importedAt,
      );
      return toLegacyImportRecord(this.getLegacyImportRow(boardId, generation)!);
    }).immediate();
  }

  getLegacyImport(input: BoardGenerationInput): LegacyImportRecord | null {
    const boardId = validateOpaqueId(input.boardId, "boardId");
    const generation = validatePositiveInteger(input.generation, "generation");
    this.requireCurrentBoard(boardId, generation);
    const row = this.getLegacyImportRow(boardId, generation);
    return row ? toLegacyImportRecord(row) : null;
  }

  private validateDocumentIdentity(input: LoadDocumentInput): LoadDocumentInput {
    return {
      boardId: validateOpaqueId(input.boardId, "boardId"),
      documentKey: validateBoardDocumentKey(input.documentKey),
      generation: validatePositiveInteger(input.generation, "generation"),
    };
  }

  private requireCurrentBoard(boardId: string, generation: number): BoardRow {
    const board = this.db.prepare("SELECT * FROM boards WHERE id = ?").get(boardId) as BoardRow | undefined;
    if (!board) throw new BoardRepositoryError("NOT_FOUND", `board '${boardId}' does not exist`);
    if (board.lifecycle === "tombstoned") {
      throw new BoardRepositoryError("BOARD_GONE", `board '${boardId}' is tombstoned`);
    }
    if (board.generation !== generation) {
      throw new BoardRepositoryError(
        "GENERATION_MISMATCH",
        `board '${boardId}' is generation ${board.generation}, not ${generation}`,
      );
    }
    return board;
  }

  private requireDocumentRow(
    boardId: string,
    documentKey: string,
    generation: number,
  ): BoardDocumentRow {
    const row = this.db.prepare(`
      SELECT *
      FROM board_documents
      WHERE board_id = ? AND document_key = ? AND generation = ?
    `).get(boardId, documentKey, generation) as BoardDocumentRow | undefined;
    if (!row) {
      throw new BoardRepositoryError(
        "NOT_FOUND",
        `document '${documentKey}' does not exist for board generation ${generation}`,
      );
    }
    return row;
  }

  private getLegacyImportRow(boardId: string, generation: number): LegacyImportRow | undefined {
    return this.db.prepare(`
      SELECT *
      FROM board_legacy_imports
      WHERE board_id = ? AND generation = ?
    `).get(boardId, generation) as LegacyImportRow | undefined;
  }
}

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import * as Y from "yjs";
import { afterEach, describe, expect, it } from "vitest";
import {
  addCodeWorkspaceEntry,
  codeWorkspaceText,
  listCodeWorkspaceEntries,
  moveCodeWorkspaceEntry,
  removeCodeWorkspaceEntry,
  validateCodeWorkspaceDocument,
} from "../../code/core/index.js";
import { migrate } from "../db.js";
import { GuestRoomService } from "../guestRooms.js";
import {
  CodeSyncRepository,
  type CodeSyncStoragePolicy,
} from "./repository.js";
import {
  CODE_DOCUMENT_METADATA_RESERVE_BYTES,
  CODE_RECEIPT_METADATA_RESERVE_BYTES,
  CODE_UPDATE_METADATA_RESERVE_BYTES,
  CODE_WORKSPACE_METADATA_RESERVE_BYTES,
  codeReceiptLogicalBytes,
} from "./storageUsageSchema.js";

interface RepositoryHarness {
  readonly db: Database.Database;
  readonly repository: CodeSyncRepository;
  readonly workspaceId: string;
  readonly document: Y.Doc;
}

interface DocumentMetrics {
  snapshot_sequence: number;
  last_sequence: number;
  update_log_count: number;
  update_log_bytes: number;
  receipt_count: number;
  compacted_at: string | null;
}

interface GuestStorageUsage {
  workspace_count: number;
  document_count: number;
  snapshot_bytes: number;
  state_vector_bytes: number;
  update_count: number;
  update_bytes: number;
  receipt_count: number;
  receipt_bytes: number;
  metadata_bytes: number;
  accounted_bytes: number;
}

const NOW = Date.parse("2026-08-09T08:00:00.000Z");
const openDatabases = new Set<Database.Database>();

function createDatabase(filename = ":memory:"): Database.Database {
  const db = new Database(filename);
  db.pragma("foreign_keys = ON");
  migrate(db);
  openDatabases.add(db);
  return db;
}

function closeDatabase(db: Database.Database): void {
  if (db.open) db.close();
  openDatabases.delete(db);
}

function createHarness(
  policy: Partial<CodeSyncStoragePolicy> = {},
): RepositoryHarness {
  const db = createDatabase();
  const room = new GuestRoomService(db, () => NOW).create("code");
  const resource = room.resources.find((candidate) => candidate.kind === "code");
  if (!resource) throw new Error("Code resource was not created");
  const repository = new CodeSyncRepository(db, () => NOW, policy);
  const workspace = repository.ensureWorkspace(resource.id);
  const document = new Y.Doc();
  Y.applyUpdate(document, repository.readDocumentState(workspace.id).update);
  return { db, repository, workspaceId: workspace.id, document };
}

function seedLesson(db: Database.Database, codeState: string, revision = 0): {
  lessonId: string;
  tutorId: string;
  studentId: string;
} {
  const tutorId = crypto.randomUUID();
  const studentId = crypto.randomUUID();
  const lessonId = crypto.randomUUID();
  const timestamp = new Date(NOW).toISOString();
  db.prepare(`
    INSERT INTO users (
      id, role, status, display_name, created_at, updated_at
    ) VALUES (?, 'tutor', 'active', 'Tutor', ?, ?)
  `).run(tutorId, timestamp, timestamp);
  db.prepare(`
    INSERT INTO users (
      id, role, status, display_name, tutor_id, created_at, updated_at
    ) VALUES (?, 'student', 'active', 'Student', ?, ?, ?)
  `).run(studentId, tutorId, timestamp, timestamp);
  db.prepare(`
    INSERT INTO lessons (
      id, tutor_id, student_id, title, meeting_key, scheduled_at,
      duration_minutes, status, code_state, code_revision,
      created_at, updated_at
    ) VALUES (?, ?, ?, 'Lesson', ?, ?, 60, 'active', ?, ?, ?, ?)
  `).run(
    lessonId,
    tutorId,
    studentId,
    "m".repeat(32),
    timestamp,
    codeState,
    revision,
    timestamp,
    timestamp,
  );
  return { lessonId, tutorId, studentId };
}

function insertTextUpdate(document: Y.Doc, value: string): Uint8Array {
  const before = Y.encodeStateVector(document);
  const text = codeWorkspaceText(document, "main-py");
  if (!text) throw new Error("main.py was not initialized");
  text.insert(text.length, value);
  return Y.encodeStateAsUpdate(document, before);
}

function append(
  harness: RepositoryHarness,
  updateId: string,
  update: Uint8Array,
) {
  return harness.repository.appendUpdate({
    workspaceId: harness.workspaceId,
    deviceId: "repository-test-device",
    updateId,
    update,
  });
}

function metrics(harness: RepositoryHarness): DocumentMetrics {
  return harness.db.prepare(`
    SELECT
      snapshot_sequence, last_sequence, update_log_count, update_log_bytes,
      receipt_count, compacted_at
    FROM code_documents
    WHERE workspace_id = ?
  `).get(harness.workspaceId) as DocumentMetrics;
}

function guestStorageUsage(db: Database.Database): GuestStorageUsage {
  return db.prepare(`
    SELECT
      workspace_count, document_count, snapshot_bytes, state_vector_bytes,
      update_count, update_bytes, receipt_count, receipt_bytes,
      metadata_bytes, accounted_bytes
    FROM code_guest_storage_usage WHERE singleton = 1
  `).get() as GuestStorageUsage;
}

function expectGuestStorageUsageConsistent(db: Database.Database): void {
  const mismatch = db.prepare(`
    SELECT usage.workspace_id
    FROM code_storage_usage usage
    WHERE usage.document_count != (
            SELECT COUNT(*) FROM code_documents document
            WHERE document.workspace_id = usage.workspace_id
          )
       OR usage.snapshot_bytes != COALESCE((
            SELECT SUM(document.snapshot_bytes) FROM code_documents document
            WHERE document.workspace_id = usage.workspace_id
          ), 0)
       OR usage.state_vector_bytes != COALESCE((
            SELECT SUM(document.state_vector_bytes) FROM code_documents document
            WHERE document.workspace_id = usage.workspace_id
          ), 0)
       OR usage.update_count != (
            SELECT COUNT(*)
            FROM code_updates update_row
            JOIN code_documents document ON document.id = update_row.document_id
            WHERE document.workspace_id = usage.workspace_id
          )
       OR usage.update_bytes != COALESCE((
            SELECT SUM(update_row.update_bytes)
            FROM code_updates update_row
            JOIN code_documents document ON document.id = update_row.document_id
            WHERE document.workspace_id = usage.workspace_id
          ), 0)
       OR usage.receipt_count != (
            SELECT COUNT(*)
            FROM code_update_receipts receipt
            JOIN code_documents document ON document.id = receipt.document_id
            WHERE document.workspace_id = usage.workspace_id
          )
       OR usage.receipt_bytes != COALESCE((
            SELECT SUM(
              length(CAST(receipt.document_id AS BLOB))
              + length(CAST(receipt.device_id AS BLOB))
              + length(CAST(receipt.update_id AS BLOB))
              + length(CAST(receipt.update_digest AS BLOB))
              + length(CAST(receipt.created_at AS BLOB))
              + 8
            )
            FROM code_update_receipts receipt
            JOIN code_documents document ON document.id = receipt.document_id
            WHERE document.workspace_id = usage.workspace_id
          ), 0)
       OR usage.metadata_bytes != ${CODE_WORKSPACE_METADATA_RESERVE_BYTES}
          + usage.document_count * ${CODE_DOCUMENT_METADATA_RESERVE_BYTES}
          + usage.update_count * ${CODE_UPDATE_METADATA_RESERVE_BYTES}
          + usage.receipt_count * ${CODE_RECEIPT_METADATA_RESERVE_BYTES}
       OR usage.accounted_bytes != usage.snapshot_bytes
          + usage.state_vector_bytes + usage.update_bytes
          + usage.receipt_bytes + usage.metadata_bytes
    LIMIT 1
  `).get();
  expect(mismatch).toBeUndefined();
  const expected = db.prepare(`
    SELECT
      COUNT(*) AS workspace_count,
      COALESCE(SUM(document_count), 0) AS document_count,
      COALESCE(SUM(snapshot_bytes), 0) AS snapshot_bytes,
      COALESCE(SUM(state_vector_bytes), 0) AS state_vector_bytes,
      COALESCE(SUM(update_count), 0) AS update_count,
      COALESCE(SUM(update_bytes), 0) AS update_bytes,
      COALESCE(SUM(receipt_count), 0) AS receipt_count,
      COALESCE(SUM(receipt_bytes), 0) AS receipt_bytes,
      COALESCE(SUM(metadata_bytes), 0) AS metadata_bytes,
      COALESCE(SUM(accounted_bytes), 0) AS accounted_bytes
    FROM code_storage_usage
  `).get();
  expect(guestStorageUsage(db)).toEqual(expected);
}

afterEach(() => {
  for (const db of openDatabases) closeDatabase(db);
});

describe("CodeSyncRepository lesson ownership", () => {
  it("imports a lesson legacy source exactly once without changing rollback data", () => {
    const db = createDatabase();
    const legacyJson = JSON.stringify({
      language: "python",
      value: "print('legacy lesson')\n",
    });
    const { lessonId } = seedLesson(db, legacyJson, 7);
    const repository = new CodeSyncRepository(db, () => NOW);
    try {
      const beforeGuest = guestStorageUsage(db);
      const workspace = repository.ensureLessonWorkspace(lessonId);
      expect(workspace).toMatchObject({ roomResourceId: null, lessonId });
      expect(repository.ensureLessonWorkspace(lessonId)).toEqual(workspace);

      const document = new Y.Doc();
      Y.applyUpdate(document, repository.readDocumentState(workspace.id).update);
      expect(codeWorkspaceText(document, "main-py")?.toString())
        .toBe("print('legacy lesson')\n");
      document.destroy();

      expect(db.prepare(`
        SELECT code_state, code_revision FROM lessons WHERE id = ?
      `).get(lessonId)).toEqual({ code_state: legacyJson, code_revision: 7 });
      const audit = db.prepare(`
        SELECT source_revision, source_json, source_sha256
        FROM lesson_code_legacy_imports WHERE lesson_id = ?
      `).get(lessonId) as Record<string, unknown>;
      expect(audit).toMatchObject({
        source_revision: 7,
        source_json: legacyJson,
      });
      expect(audit.source_sha256).toMatch(/^[0-9a-f]{64}$/u);
      expect(db.prepare(`
        SELECT is_guest FROM code_storage_usage WHERE workspace_id = ?
      `).get(workspace.id)).toEqual({ is_guest: 0 });
      expect(guestStorageUsage(db)).toEqual(beforeGuest);
      expect(() => db.prepare(`
        UPDATE lesson_code_legacy_imports SET source_revision = 8
        WHERE lesson_id = ?
      `).run(lessonId)).toThrow();
    } finally {
      closeDatabase(db);
    }
  });

  it("keeps lesson updates outside the aggregate guest quota", () => {
    const db = createDatabase();
    const { lessonId } = seedLesson(db, "{}", 0);
    const repository = new CodeSyncRepository(db, () => NOW, {
      maxGuestStorageBytes: 1,
    });
    const workspace = repository.ensureLessonWorkspace(lessonId);
    const document = new Y.Doc();
    try {
      Y.applyUpdate(document, repository.readDocumentState(workspace.id).update);
      const beforeGuest = guestStorageUsage(db);
      const update = insertTextUpdate(document, "# lesson edit\n");
      expect(repository.appendUpdate({
        workspaceId: workspace.id,
        deviceId: "lesson-device",
        updateId: "lesson-update",
        update,
      })).toEqual({ status: "committed", sequence: 1 });
      expect(guestStorageUsage(db)).toEqual(beforeGuest);
    } finally {
      document.destroy();
      closeDatabase(db);
    }
  });
});

describe("CodeSyncRepository bounded compaction", () => {
  it("compacts a full update-v1 snapshot and deduplicates through retained receipts", () => {
    const harness = createHarness({
      compactAfterUpdateCount: 2,
      maxUpdateLogCount: 3,
      maxColdSyncParts: 4,
    });
    try {
      const first = insertTextUpdate(harness.document, "A");
      const second = insertTextUpdate(harness.document, "B");
      expect(append(harness, "first", first))
        .toEqual({ status: "committed", sequence: 1 });
      expect(metrics(harness)).toMatchObject({
        snapshot_sequence: 0,
        last_sequence: 1,
        update_log_count: 1,
        receipt_count: 1,
        compacted_at: null,
      });

      expect(append(harness, "second", second))
        .toEqual({ status: "committed", sequence: 2 });
      expect(metrics(harness)).toMatchObject({
        snapshot_sequence: 2,
        last_sequence: 2,
        update_log_count: 0,
        update_log_bytes: 0,
        receipt_count: 2,
        compacted_at: new Date(NOW).toISOString(),
      });
      expect(harness.db.prepare("SELECT COUNT(*) AS count FROM code_updates").get())
        .toEqual({ count: 0 });
      expect(harness.db.prepare(`
        SELECT update_count, receipt_count, metadata_bytes
        FROM code_storage_usage WHERE workspace_id = ?
      `).get(harness.workspaceId)).toEqual({
        update_count: 0,
        receipt_count: 2,
        metadata_bytes: CODE_WORKSPACE_METADATA_RESERVE_BYTES
          + CODE_DOCUMENT_METADATA_RESERVE_BYTES
          + 2 * CODE_RECEIPT_METADATA_RESERVE_BYTES,
      });

      expect(append(harness, "first-retry-new-id", first))
        .toEqual({ status: "duplicate", sequence: 1 });
      expect(metrics(harness)).toMatchObject({
        snapshot_sequence: 2,
        last_sequence: 2,
        update_log_count: 0,
        receipt_count: 3,
      });
      expect(harness.db.prepare("SELECT COUNT(*) AS count FROM code_updates").get())
        .toEqual({ count: 0 });
      expect(harness.db.prepare(`
        SELECT update_count, receipt_count, metadata_bytes
        FROM code_storage_usage WHERE workspace_id = ?
      `).get(harness.workspaceId)).toEqual({
        update_count: 0,
        receipt_count: 3,
        metadata_bytes: CODE_WORKSPACE_METADATA_RESERVE_BYTES
          + CODE_DOCUMENT_METADATA_RESERVE_BYTES
          + 3 * CODE_RECEIPT_METADATA_RESERVE_BYTES,
      });
      expectGuestStorageUsageConsistent(harness.db);
    } finally {
      harness.document.destroy();
      closeDatabase(harness.db);
    }
  });

  it("retains a reverse-order dependency until its predecessor enables compaction", () => {
    const harness = createHarness({
      compactAfterUpdateCount: 1,
      maxUpdateLogCount: 1,
      maxColdSyncParts: 2,
    });
    try {
      const first = insertTextUpdate(harness.document, "A");
      const second = insertTextUpdate(harness.document, "B");

      expect(append(harness, "second-first", second))
        .toEqual({ status: "committed", sequence: 1 });
      expect(metrics(harness)).toMatchObject({
        snapshot_sequence: 0,
        last_sequence: 1,
        update_log_count: 1,
      });

      expect(append(harness, "predecessor", first))
        .toEqual({ status: "committed", sequence: 2 });
      expect(metrics(harness)).toMatchObject({
        snapshot_sequence: 2,
        last_sequence: 2,
        update_log_count: 0,
        update_log_bytes: 0,
      });

      const restored = new Y.Doc();
      try {
        Y.applyUpdate(
          restored,
          harness.repository.readDocumentState(harness.workspaceId).update,
        );
        expect(codeWorkspaceText(restored, "main-py")?.toString())
          .toMatch(/AB$/u);
      } finally {
        restored.destroy();
      }
    } finally {
      harness.document.destroy();
      closeDatabase(harness.db);
    }
  });

  it("never exposes more cold-sync parts than the configured durable bound", () => {
    const harness = createHarness({
      compactAfterUpdateCount: 3,
      maxUpdateLogCount: 3,
      maxColdSyncParts: 4,
    });
    const empty = new Y.Doc();
    try {
      for (let index = 0; index < 10; index += 1) {
        const update = insertTextUpdate(harness.document, String(index));
        expect(append(harness, `bounded-${index}`, update).status)
          .toBe("committed");
        const sync = harness.repository.missingUpdates(
          harness.workspaceId,
          Y.encodeStateVector(empty),
        );
        expect(sync.updates.length).toBeLessThanOrEqual(4);
        expect(metrics(harness).update_log_count).toBeLessThanOrEqual(3);
      }
    } finally {
      empty.destroy();
      harness.document.destroy();
      closeDatabase(harness.db);
    }
  });

  it("rolls back receipts and counters when the hard update-log bound rejects", () => {
    const harness = createHarness({
      compactAfterUpdateCount: 1,
      maxUpdateLogCount: 1,
      maxColdSyncParts: 2,
    });
    try {
      insertTextUpdate(harness.document, "A");
      const second = insertTextUpdate(harness.document, "B");
      const third = insertTextUpdate(harness.document, "C");
      expect(append(harness, "pending-second", second).status).toBe("committed");

      expect(() => append(harness, "pending-third", third))
        .toThrowError(expect.objectContaining({
          code: "INVALID_UPDATE",
          message: expect.stringContaining("count quota"),
        }));
      expect(metrics(harness)).toMatchObject({
        snapshot_sequence: 0,
        last_sequence: 1,
        update_log_count: 1,
        receipt_count: 1,
      });
      expect(harness.db.prepare(`
        SELECT COUNT(*) AS count FROM code_update_receipts
        WHERE update_id = 'pending-third'
      `).get()).toEqual({ count: 0 });
    } finally {
      harness.document.destroy();
      closeDatabase(harness.db);
    }
  });

  it("rolls back an append that would exceed aggregate workspace bytes", () => {
    const harness = createHarness();
    try {
      const baseline = harness.db.prepare(`
        SELECT snapshot_bytes + state_vector_bytes AS bytes
        FROM code_documents WHERE workspace_id = ?
      `).get(harness.workspaceId) as { bytes: number };
      const quotaRepository = new CodeSyncRepository(harness.db, () => NOW, {
        compactAfterUpdateCount: 2,
        compactAfterUpdateBytes: baseline.bytes,
        maxUpdateLogCount: 2,
        maxWorkspaceBytes: baseline.bytes,
        maxColdSyncParts: 3,
      });
      const update = insertTextUpdate(harness.document, "over quota");
      const aggregateBefore = guestStorageUsage(harness.db);
      const workspaceUsageBefore = harness.db.prepare(`
        SELECT * FROM code_storage_usage WHERE workspace_id = ?
      `).get(harness.workspaceId);

      expect(() => quotaRepository.appendUpdate({
        workspaceId: harness.workspaceId,
        deviceId: "quota-device",
        updateId: "byte-quota",
        update,
      })).toThrowError(expect.objectContaining({
        code: "INVALID_UPDATE",
        message: expect.stringContaining("byte quota"),
      }));
      expect(metrics(harness)).toMatchObject({
        snapshot_sequence: 0,
        last_sequence: 0,
        update_log_count: 0,
        update_log_bytes: 0,
        receipt_count: 0,
      });
      expect(harness.db.prepare("SELECT COUNT(*) AS count FROM code_updates").get())
        .toEqual({ count: 0 });
      expect(harness.db.prepare("SELECT COUNT(*) AS count FROM code_update_receipts").get())
        .toEqual({ count: 0 });
      expect(guestStorageUsage(harness.db)).toEqual(aggregateBefore);
      expect(harness.db.prepare(`
        SELECT * FROM code_storage_usage WHERE workspace_id = ?
      `).get(harness.workspaceId)).toEqual(workspaceUsageBefore);
      expectGuestStorageUsageConsistent(harness.db);
    } finally {
      harness.document.destroy();
      closeDatabase(harness.db);
    }
  });

  it("persists one aggregate guest quota across distinct room resources", () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "eduri-code-usage-"));
    const databasePath = path.join(tempRoot, "code.sqlite");
    let firstDb: Database.Database | undefined;
    let reopenedDb: Database.Database | undefined;
    const documents: Y.Doc[] = [];
    try {
      firstDb = createDatabase(databasePath);
      const rooms = new GuestRoomService(firstDb, () => NOW);
      const firstRoom = rooms.create("code");
      const secondRoom = rooms.create("code");
      const firstResource = firstRoom.resources.find((resource) => (
        resource.kind === "code"
      ));
      const secondResource = secondRoom.resources.find((resource) => (
        resource.kind === "code"
      ));
      if (!firstResource || !secondResource) {
        throw new Error("Code resources were not created");
      }
      const firstRepository = new CodeSyncRepository(firstDb, () => NOW);
      const firstWorkspace = firstRepository.ensureWorkspace(firstResource.id);
      const secondWorkspace = firstRepository.ensureWorkspace(secondResource.id);
      const firstDocument = new Y.Doc();
      const secondDocument = new Y.Doc();
      documents.push(firstDocument, secondDocument);
      Y.applyUpdate(
        firstDocument,
        firstRepository.readDocumentState(firstWorkspace.id).update,
      );
      Y.applyUpdate(
        secondDocument,
        firstRepository.readDocumentState(secondWorkspace.id).update,
      );
      const firstUpdate = insertTextUpdate(firstDocument, "first room\n");
      const secondUpdate = insertTextUpdate(secondDocument, "second room\n");
      expect(firstRepository.appendUpdate({
        workspaceId: firstWorkspace.id,
        deviceId: "restart-device",
        updateId: "restart-first",
        update: firstUpdate,
      })).toMatchObject({ status: "committed" });
      const persisted = guestStorageUsage(firstDb);
      const secondBefore = firstDb.prepare(`
        SELECT * FROM code_storage_usage WHERE workspace_id = ?
      `).get(secondWorkspace.id);
      closeDatabase(firstDb);
      firstDb = undefined;

      reopenedDb = createDatabase(databasePath);
      const restarted = new CodeSyncRepository(reopenedDb, () => NOW, {
        maxGuestStorageBytes: persisted.accounted_bytes,
      });
      expect(guestStorageUsage(reopenedDb)).toEqual(persisted);
      expect(() => restarted.appendUpdate({
        workspaceId: secondWorkspace.id,
        deviceId: "restart-device",
        updateId: "restart-second",
        update: secondUpdate,
      })).toThrowError(expect.objectContaining({
        code: "INVALID_UPDATE",
        message: expect.stringContaining("Global guest Code"),
      }));
      expect(guestStorageUsage(reopenedDb)).toEqual(persisted);
      expect(reopenedDb.prepare(`
        SELECT * FROM code_storage_usage WHERE workspace_id = ?
      `).get(secondWorkspace.id)).toEqual(secondBefore);
      expect(reopenedDb.prepare(`
        SELECT COUNT(*) AS count FROM code_update_receipts
        WHERE document_id = ?
      `).get(secondWorkspace.documentId)).toEqual({ count: 0 });
      expectGuestStorageUsageConsistent(reopenedDb);
    } finally {
      for (const document of documents) document.destroy();
      if (firstDb?.open) closeDatabase(firstDb);
      if (reopenedDb?.open) closeDatabase(reopenedDb);
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("charges workspace bootstrap state before another room can initialize", () => {
    const db = createDatabase();
    const rooms = new GuestRoomService(db, () => NOW);
    const firstRoom = rooms.create("code");
    const secondRoom = rooms.create("code");
    const firstResource = firstRoom.resources.find((resource) => (
      resource.kind === "code"
    ));
    const secondResource = secondRoom.resources.find((resource) => (
      resource.kind === "code"
    ));
    if (!firstResource || !secondResource) {
      throw new Error("Code resources were not created");
    }
    try {
      const bootstrap = new CodeSyncRepository(db, () => NOW);
      const firstWorkspace = bootstrap.ensureWorkspace(firstResource.id);
      const afterFirst = guestStorageUsage(db);
      expect(afterFirst).toMatchObject({
        workspace_count: 1,
        document_count: 1,
        update_count: 0,
        receipt_count: 0,
      });
      expect(afterFirst.snapshot_bytes + afterFirst.state_vector_bytes)
        .toBeGreaterThan(0);
      expect(afterFirst.metadata_bytes).toBeGreaterThanOrEqual(2_048);

      const constrained = new CodeSyncRepository(db, () => NOW, {
        maxGuestStorageBytes: afterFirst.accounted_bytes,
      });
      expect(constrained.ensureWorkspace(firstResource.id)).toEqual(firstWorkspace);
      expect(() => constrained.ensureWorkspace(secondResource.id))
        .toThrowError(expect.objectContaining({
          code: "INVALID_UPDATE",
          message: expect.stringContaining("Global guest Code"),
        }));
      expect(guestStorageUsage(db)).toEqual(afterFirst);
      expect(db.prepare("SELECT COUNT(*) AS count FROM code_workspaces").get())
        .toEqual({ count: 1 });
      expectGuestStorageUsageConsistent(db);
    } finally {
      closeDatabase(db);
    }
  });

  it("serializes aggregate quota contenders and rolls the loser back", async () => {
    const db = createDatabase();
    const rooms = new GuestRoomService(db, () => NOW);
    const firstRoom = rooms.create("code");
    const secondRoom = rooms.create("code");
    const firstResource = firstRoom.resources.find((resource) => (
      resource.kind === "code"
    ));
    const secondResource = secondRoom.resources.find((resource) => (
      resource.kind === "code"
    ));
    if (!firstResource || !secondResource) {
      throw new Error("Code resources were not created");
    }
    const bootstrap = new CodeSyncRepository(db, () => NOW);
    const firstWorkspace = bootstrap.ensureWorkspace(firstResource.id);
    const secondWorkspace = bootstrap.ensureWorkspace(secondResource.id);
    const firstDocument = new Y.Doc();
    const secondDocument = new Y.Doc();
    try {
      Y.applyUpdate(
        firstDocument,
        bootstrap.readDocumentState(firstWorkspace.id).update,
      );
      Y.applyUpdate(
        secondDocument,
        bootstrap.readDocumentState(secondWorkspace.id).update,
      );
      const firstUpdate = insertTextUpdate(firstDocument, "A");
      const secondUpdate = insertTextUpdate(secondDocument, "B");
      const deviceIds = ["quota-contender-a", "quota-contender-b"] as const;
      const updateIds = ["quota-update-a", "quota-update-b"] as const;
      const workspaces = [firstWorkspace, secondWorkspace] as const;
      const documentsForCandidate = [firstDocument, secondDocument] as const;
      const updates = [firstUpdate, secondUpdate] as const;
      const candidateBytes = workspaces.map((workspace, index) => {
        const stored = db.prepare(`
          SELECT state_vector_bytes FROM code_documents WHERE workspace_id = ?
        `).get(workspace.id) as { state_vector_bytes: number };
        const nextStateVectorBytes = Y.encodeStateVector(
          documentsForCandidate[index],
        ).byteLength;
        return updates[index].byteLength
          + CODE_UPDATE_METADATA_RESERVE_BYTES
          + CODE_RECEIPT_METADATA_RESERVE_BYTES
          + codeReceiptLogicalBytes({
            documentId: workspace.documentId,
            deviceId: deviceIds[index],
            updateId: updateIds[index],
            updateDigest: "0".repeat(64),
            createdAt: new Date(NOW).toISOString(),
          })
          + nextStateVectorBytes - stored.state_vector_bytes;
      });
      const before = guestStorageUsage(db);
      const policy = {
        maxGuestStorageBytes:
          before.accounted_bytes + Math.max(...candidateBytes),
      };
      const repositories = [
        new CodeSyncRepository(db, () => NOW, policy),
        new CodeSyncRepository(db, () => NOW, policy),
      ] as const;
      const results = await Promise.allSettled(repositories.map(
        (repository, index) => Promise.resolve().then(() => (
          repository.appendUpdate({
            workspaceId: workspaces[index].id,
            deviceId: deviceIds[index],
            updateId: updateIds[index],
            update: updates[index],
          })
        )),
      ));
      expect(results.filter((result) => result.status === "fulfilled"))
        .toHaveLength(1);
      expect(results.filter((result) => result.status === "rejected"))
        .toHaveLength(1);
      expect(results.find((result) => result.status === "rejected"))
        .toMatchObject({
          reason: expect.objectContaining({
            code: "INVALID_UPDATE",
            message: expect.stringContaining("Global guest Code"),
          }),
        });
      const winner = results.findIndex((result) => result.status === "fulfilled");
      expect(guestStorageUsage(db).accounted_bytes)
        .toBe(before.accounted_bytes + candidateBytes[winner]);
      expect(db.prepare("SELECT COUNT(*) AS count FROM code_updates").get())
        .toEqual({ count: 1 });
      expect(db.prepare("SELECT COUNT(*) AS count FROM code_update_receipts").get())
        .toEqual({ count: 1 });
      const loser = winner === 0 ? 1 : 0;
      expect(db.prepare(`
        SELECT update_log_count, receipt_count
        FROM code_documents WHERE workspace_id = ?
      `).get(workspaces[loser].id)).toEqual({
        update_log_count: 0,
        receipt_count: 0,
      });
      expectGuestStorageUsageConsistent(db);
    } finally {
      firstDocument.destroy();
      secondDocument.destroy();
      closeDatabase(db);
    }
  });

  it("accepts an exact idempotent replay after the receipt quota is full", () => {
    const harness = createHarness({
      compactAfterUpdateCount: 1,
      maxUpdateLogCount: 1,
      maxReceiptCount: 1,
      maxColdSyncParts: 2,
    });
    try {
      const update = insertTextUpdate(harness.document, "once");
      expect(append(harness, "only-receipt", update))
        .toEqual({ status: "committed", sequence: 1 });
      expect(append(harness, "only-receipt", update))
        .toEqual({ status: "duplicate", sequence: 1 });
      expect(metrics(harness).receipt_count).toBe(1);

      expect(() => append(harness, "new-receipt", update))
        .toThrowError(expect.objectContaining({
          code: "INVALID_UPDATE",
          message: expect.stringContaining("receipt quota"),
        }));
      expect(metrics(harness).receipt_count).toBe(1);
    } finally {
      harness.document.destroy();
      closeDatabase(harness.db);
    }
  });
});

describe("CodeSyncRepository compacted restart durability", () => {
  it("reconstructs and deduplicates from a compacted snapshot after reopening SQLite", () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "eduri-code-compact-"));
    const databasePath = path.join(tempRoot, "code.sqlite");
    let document: Y.Doc | undefined;
    try {
      const firstDb = createDatabase(databasePath);
      const room = new GuestRoomService(firstDb, () => NOW).create("code");
      const resource = room.resources.find((candidate) => candidate.kind === "code");
      if (!resource) throw new Error("Code resource was not created");
      const firstRepository = new CodeSyncRepository(firstDb, () => NOW, {
        compactAfterUpdateCount: 1,
        maxUpdateLogCount: 1,
        maxColdSyncParts: 2,
      });
      const workspace = firstRepository.ensureWorkspace(resource.id);
      document = new Y.Doc();
      Y.applyUpdate(document, firstRepository.readDocumentState(workspace.id).update);
      const update = insertTextUpdate(document, "# compacted restart\n");
      expect(firstRepository.appendUpdate({
        workspaceId: workspace.id,
        deviceId: "restart-device",
        updateId: "restart-update",
        update,
      })).toEqual({ status: "committed", sequence: 1 });
      expect(firstDb.prepare("SELECT COUNT(*) AS count FROM code_updates").get())
        .toEqual({ count: 0 });
      closeDatabase(firstDb);

      const reopenedDb = createDatabase(databasePath);
      const reopenedRepository = new CodeSyncRepository(reopenedDb, () => NOW, {
        compactAfterUpdateCount: 1,
        maxUpdateLogCount: 1,
        maxColdSyncParts: 2,
      });
      const restored = new Y.Doc();
      try {
        Y.applyUpdate(
          restored,
          reopenedRepository.readDocumentState(workspace.id).update,
        );
        expect(codeWorkspaceText(restored, "main-py")?.toString())
          .toContain("# compacted restart");
        expect(reopenedRepository.appendUpdate({
          workspaceId: workspace.id,
          deviceId: "restart-device",
          updateId: "restart-update",
          update,
        })).toEqual({ status: "duplicate", sequence: 1 });
      } finally {
        restored.destroy();
        closeDatabase(reopenedDb);
      }
    } finally {
      document?.destroy();
      for (const db of openDatabases) closeDatabase(db);
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});

describe("CodeSyncRepository structural convergence", () => {
  it("accepts concurrent cross-moves and persists their deterministic tree", () => {
    const harness = createHarness();
    try {
      const beforeSeed = Y.encodeStateVector(harness.document);
      addCodeWorkspaceEntry(harness.document, {
        id: "a-folder",
        kind: "folder",
        name: "a",
      }, "seed");
      addCodeWorkspaceEntry(harness.document, {
        id: "b-folder",
        kind: "folder",
        name: "b",
      }, "seed");
      expect(append(
        harness,
        "tree-seed",
        Y.encodeStateAsUpdate(harness.document, beforeSeed),
      )).toEqual({ status: "committed", sequence: 1 });

      const seedUpdate = Y.encodeStateAsUpdate(harness.document);
      const baseline = Y.encodeStateVector(harness.document);
      const left = new Y.Doc();
      const right = new Y.Doc();
      Y.applyUpdate(left, seedUpdate);
      Y.applyUpdate(right, seedUpdate);
      moveCodeWorkspaceEntry(left, "a-folder", "b-folder", "left");
      moveCodeWorkspaceEntry(right, "b-folder", "a-folder", "right");

      expect(append(
        harness,
        "cross-left",
        Y.encodeStateAsUpdate(left, baseline),
      )).toEqual({ status: "committed", sequence: 2 });
      expect(append(
        harness,
        "cross-right",
        Y.encodeStateAsUpdate(right, baseline),
      )).toEqual({ status: "committed", sequence: 3 });

      const restored = new Y.Doc();
      try {
        Y.applyUpdate(
          restored,
          harness.repository.readDocumentState(harness.workspaceId).update,
        );
        expect(new Map(listCodeWorkspaceEntries(restored)
          .map((entry) => [entry.id, entry.parentId])))
          .toEqual(new Map([
            ["a-folder", null],
            ["b-folder", "a-folder"],
            ["main-py", null],
          ]));
        expect(() => validateCodeWorkspaceDocument(restored)).not.toThrow();
      } finally {
        restored.destroy();
        left.destroy();
        right.destroy();
      }
    } finally {
      harness.document.destroy();
      closeDatabase(harness.db);
    }
  });

  it("accepts a move whose concurrently selected parent was deleted", () => {
    const harness = createHarness();
    try {
      const beforeSeed = Y.encodeStateVector(harness.document);
      addCodeWorkspaceEntry(harness.document, {
        id: "doomed-folder",
        kind: "folder",
        name: "doomed",
      }, "seed");
      addCodeWorkspaceEntry(harness.document, {
        id: "survivor",
        kind: "file",
        name: "survivor.py",
      }, "seed");
      expect(append(
        harness,
        "delete-seed",
        Y.encodeStateAsUpdate(harness.document, beforeSeed),
      )).toEqual({ status: "committed", sequence: 1 });

      const seedUpdate = Y.encodeStateAsUpdate(harness.document);
      const baseline = Y.encodeStateVector(harness.document);
      const movingPeer = new Y.Doc();
      const deletingPeer = new Y.Doc();
      Y.applyUpdate(movingPeer, seedUpdate);
      Y.applyUpdate(deletingPeer, seedUpdate);
      moveCodeWorkspaceEntry(
        movingPeer,
        "survivor",
        "doomed-folder",
        "move",
      );
      removeCodeWorkspaceEntry(deletingPeer, "doomed-folder", "delete");

      expect(append(
        harness,
        "delete-first",
        Y.encodeStateAsUpdate(deletingPeer, baseline),
      )).toEqual({ status: "committed", sequence: 2 });
      expect(append(
        harness,
        "move-second",
        Y.encodeStateAsUpdate(movingPeer, baseline),
      )).toEqual({ status: "committed", sequence: 3 });

      const restored = new Y.Doc();
      try {
        Y.applyUpdate(
          restored,
          harness.repository.readDocumentState(harness.workspaceId).update,
        );
        expect(listCodeWorkspaceEntries(restored)
          .find((entry) => entry.id === "survivor")?.parentId)
          .toBeNull();
        expect(listCodeWorkspaceEntries(restored)
          .some((entry) => entry.id === "doomed-folder"))
          .toBe(false);
        expect(() => validateCodeWorkspaceDocument(restored)).not.toThrow();
      } finally {
        restored.destroy();
        movingPeer.destroy();
        deletingPeer.destroy();
      }
    } finally {
      harness.document.destroy();
      closeDatabase(harness.db);
    }
  });
});

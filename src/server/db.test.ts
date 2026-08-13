import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { migrate } from "./db.js";
import { BoardRepository } from "./board-v2/repository.js";
import {
  BOARD_BASE_METADATA_RESERVE_BYTES,
  BOARD_DOCUMENT_METADATA_RESERVE_BYTES,
  BOARD_LEGACY_IMPORT_METADATA_RESERVE_BYTES,
  BOARD_RECEIPT_METADATA_RESERVE_BYTES,
  BOARD_UPDATE_METADATA_RESERVE_BYTES,
  boardReceiptLogicalBytes,
} from "./board-v2/storageUsageSchema.js";
import {
  CODE_DOCUMENT_METADATA_RESERVE_BYTES,
  CODE_RECEIPT_METADATA_RESERVE_BYTES,
  CODE_UPDATE_METADATA_RESERVE_BYTES,
  CODE_WORKSPACE_METADATA_RESERVE_BYTES,
  codeReceiptLogicalBytes,
} from "./code-sync/storageUsageSchema.js";

const NOW = "2026-08-09T08:00:00.000Z";
const CHILD_TABLES = [
  "board_documents",
  "board_updates",
  "board_update_receipts",
  "board_legacy_imports",
  "board_assets",
  "board_asset_uploads",
  "board_asset_blobs",
] as const;

interface BoardFixture {
  boardId: string;
  lessonId: string;
}

function insertBoardFixture(db: Database.Database): BoardFixture {
  const tutorId = randomUUID();
  const studentId = randomUUID();
  const lessonId = randomUUID();
  const boardId = randomUUID();
  const assetId = randomUUID();
  const uploadId = randomUUID();
  const blobSha256 = "b".repeat(64);
  db.prepare(`
    INSERT INTO users (
      id, role, status, display_name, created_at, updated_at
    ) VALUES (?, 'tutor', 'active', 'Tutor', ?, ?)
  `).run(tutorId, NOW, NOW);
  db.prepare(`
    INSERT INTO users (
      id, role, status, display_name, tutor_id, created_at, updated_at
    ) VALUES (?, 'student', 'active', 'Student', ?, ?, ?)
  `).run(studentId, tutorId, NOW, NOW);
  db.prepare(`
    INSERT INTO lessons (
      id, tutor_id, student_id, title, meeting_key, scheduled_at,
      duration_minutes, status, created_at, updated_at
    ) VALUES (?, ?, ?, 'Migration test', ?, ?, 60, 'scheduled', ?, ?)
  `).run(lessonId, tutorId, studentId, randomUUID(), NOW, NOW, NOW);
  db.prepare(`
    INSERT INTO boards (
      id, lesson_id, engine, lifecycle, generation, protocol_version,
      schema_version, created_at, updated_at
    ) VALUES (?, ?, 'v2', 'active', 1, 1, 1, ?, ?)
  `).run(boardId, lessonId, NOW, NOW);
  db.prepare(`
    INSERT INTO board_documents (
      board_id, document_key, generation, snapshot_blob, state_vector,
      snapshot_seq, last_seq, snapshot_bytes, state_vector_bytes,
      created_at, updated_at
    ) VALUES (?, 'manifest', 1, X'0102', X'03', 0, 1, 2, 1, ?, ?)
  `).run(boardId, NOW, NOW);
  db.prepare(`
    INSERT INTO board_updates (
      board_id, document_key, generation, seq, message_id, actor_id,
      client_id, update_blob, update_bytes, created_at
    ) VALUES (?, 'manifest', 1, 1, ?, ?, ?, X'0405', 2, ?)
  `).run(boardId, randomUUID(), tutorId, randomUUID(), NOW);
  db.prepare(`
    INSERT INTO board_update_receipts (
      board_id, document_key, generation, message_id, seq, actor_id,
      client_id, update_sha256, update_bytes, created_at
    ) SELECT
      board_id, document_key, generation, message_id, seq, actor_id,
      client_id, ?, update_bytes, created_at
    FROM board_updates WHERE board_id = ?
  `).run("a".repeat(64), boardId);
  db.prepare(`
    INSERT INTO board_legacy_imports (
      board_id, generation, source_revision, source_json, source_sha256,
      source_bytes, imported_at
    ) VALUES (?, 1, 7, '{}', ?, 2, ?)
  `).run(boardId, "c".repeat(64), NOW);
  db.prepare(`
    INSERT INTO board_asset_blobs (
      tenant_id, sha256, storage_key, mime_type, byte_size, width, height,
      frame_count, decoded_pixels, created_at
    ) VALUES (?, ?, ?, 'image/png', 3, 1, 1, 1, 1, ?)
  `).run(tutorId, blobSha256, `blobs/${blobSha256}`, NOW);
  db.prepare(`
    INSERT INTO board_assets (
      board_id, generation, asset_id, tenant_id, status, expected_sha256,
      blob_sha256, byte_size, declared_mime, detected_mime,
      original_file_name, width, height, frame_count, decoded_pixels,
      created_by, created_at, updated_at, published_at
    ) VALUES (
      ?, 1, ?, ?, 'ready', ?, ?, 3, 'image/png', 'image/png',
      'fixture.png', 1, 1, 1, 1, ?, ?, ?, ?
    )
  `).run(
    boardId,
    assetId,
    tutorId,
    blobSha256,
    blobSha256,
    tutorId,
    NOW,
    NOW,
    NOW,
  );
  db.prepare(`
    INSERT INTO board_asset_uploads (
      upload_id, board_id, generation, asset_id, tenant_id, expected_sha256,
      expected_bytes, chunk_bytes, next_offset, staging_key, status,
      created_at, updated_at, expires_at, completed_at
    ) VALUES (?, ?, 1, ?, ?, ?, 3, 3, 3, ?, 'completed', ?, ?, ?, ?)
  `).run(
    uploadId,
    boardId,
    assetId,
    tutorId,
    blobSha256,
    `staging/${uploadId}`,
    NOW,
    NOW,
    "2026-08-10T08:00:00.000Z",
    NOW,
  );
  return { boardId, lessonId };
}

function tableRows(
  db: Database.Database,
  table: typeof CHILD_TABLES[number],
): unknown[] {
  return db.prepare(`SELECT * FROM ${table}`).all();
}

describe("database migrations", () => {
  let db: Database.Database | undefined;

  afterEach(() => {
    if (db?.open) db.close();
    db = undefined;
  });

  it("preserves every Board child row while rebuilding boards from v8 to v9", () => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    migrate(db, { targetVersion: 8 });
    const fixture = insertBoardFixture(db);
    const before = Object.fromEntries(
      CHILD_TABLES.map((table) => [table, tableRows(db!, table)]),
    );

    migrate(db, { targetVersion: 9 });

    expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
    expect(db.pragma("foreign_key_check")).toEqual([]);
    expect(db.prepare("SELECT * FROM boards WHERE id = ?").get(fixture.boardId))
      .toEqual({
        id: fixture.boardId,
        lesson_id: fixture.lessonId,
        room_resource_id: null,
        engine: "v2",
        lifecycle: "active",
        generation: 1,
        protocol_version: 1,
        schema_version: 1,
        created_at: NOW,
        updated_at: NOW,
      });
    for (const table of CHILD_TABLES) {
      expect(tableRows(db, table), table).toEqual(before[table]);
    }
    expect(db.prepare(`
      SELECT MAX(version) AS version FROM schema_migrations
    `).get()).toEqual({ version: 9 });
  });

  it("rolls back v9 and restores foreign keys when the rebuilt graph is invalid", () => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    migrate(db, { targetVersion: 8 });
    db.pragma("foreign_keys = OFF");
    db.prepare(`
      INSERT INTO board_documents (
        board_id, document_key, generation, snapshot_blob, state_vector,
        snapshot_seq, last_seq, snapshot_bytes, state_vector_bytes,
        created_at, updated_at
      ) VALUES (?, 'manifest', 1, X'', X'', 0, 0, 0, 0, ?, ?)
    `).run(randomUUID(), NOW, NOW);
    db.pragma("foreign_keys = ON");

    expect(() => migrate(db!, { targetVersion: 9 }))
      .toThrow(/migration 9 violated foreign keys/u);

    expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
    expect((db.prepare(`
      SELECT MAX(version) AS version FROM schema_migrations
    `).get() as { version: number }).version).toBe(8);
    expect((db.prepare("PRAGMA table_info(boards)").all() as Array<{ name: string }>)
      .map((column) => column.name)).not.toContain("room_resource_id");
  });

  it("upgrades an existing v9 database through Code and room lease schemas", () => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    migrate(db, { targetVersion: 9 });
    const roomId = randomUUID();
    const resourceId = randomUUID();
    db.prepare(`
      INSERT INTO guest_rooms (
        id, share_key, created_at, updated_at, last_activity_at, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(roomId, "a".repeat(43), NOW, NOW, NOW, "2026-08-12T08:00:00.000Z");
    db.prepare(`
      INSERT INTO guest_room_resources (
        id, room_id, kind, ordinal, resource_key, created_at, last_activity_at
      ) VALUES (?, ?, 'code', 1, ?, ?, ?)
    `).run(resourceId, roomId, "b".repeat(32), NOW, NOW);

    migrate(db, { targetVersion: 12 });

    expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
    expect(db.pragma("foreign_key_check")).toEqual([]);
    expect(db.prepare(`
      SELECT MAX(version) AS version FROM schema_migrations
    `).get()).toEqual({ version: 12 });
    for (const table of [
      "code_workspaces",
      "code_documents",
      "code_updates",
      "code_update_receipts",
      "code_blobs",
      "code_blob_uploads",
      "code_blob_gc_queue",
    ]) {
      expect(db.prepare(`
        SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?
      `).get(table), table).toEqual({ name: table });
    }
    expect(db.prepare("SELECT * FROM guest_room_resources WHERE id = ?")
      .get(resourceId)).toMatchObject({
        id: resourceId,
        room_id: roomId,
        kind: "code",
      });
    expect((db.prepare("PRAGMA table_info(guest_rooms)").all() as Array<{
      name: string;
    }>).map((column) => column.name)).toEqual(expect.arrayContaining([
      "initialization_token_hash",
      "initialization_expires_at",
      "initialized_at",
    ]));
  });

  it("rebuilds guest-only Code ownership for lessons without changing guest rows", () => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    migrate(db, { targetVersion: 21 });
    const roomId = randomUUID();
    const resourceId = randomUUID();
    const workspaceId = randomUUID();
    const documentId = randomUUID();
    db.prepare(`
      INSERT INTO guest_rooms (
        id, share_key, created_at, updated_at, last_activity_at, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(roomId, "g".repeat(43), NOW, NOW, NOW, "2026-08-12T08:00:00.000Z");
    db.prepare(`
      INSERT INTO guest_room_resources (
        id, room_id, kind, ordinal, resource_key, created_at, last_activity_at
      ) VALUES (?, ?, 'code', 1, ?, ?, ?)
    `).run(resourceId, roomId, "h".repeat(32), NOW, NOW);
    db.prepare(`
      INSERT INTO code_workspaces (
        id, room_resource_id, schema_version, created_at, updated_at
      ) VALUES (?, ?, 1, ?, ?)
    `).run(workspaceId, resourceId, NOW, NOW);
    db.prepare(`
      INSERT INTO code_documents (
        id, workspace_id, snapshot_update, snapshot_bytes,
        state_vector, state_vector_bytes, created_at, updated_at
      ) VALUES (?, ?, X'0000', 2, X'00', 1, ?, ?)
    `).run(documentId, workspaceId, NOW, NOW);
    const beforeUsage = db.prepare(`
      SELECT * FROM code_guest_storage_usage WHERE singleton = 1
    `).get();

    migrate(db);

    expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
    expect(db.pragma("foreign_key_check")).toEqual([]);
    expect(db.prepare(`
      SELECT id, room_resource_id, lesson_id, schema_version,
        created_at, updated_at
      FROM code_workspaces WHERE id = ?
    `).get(workspaceId)).toEqual({
      id: workspaceId,
      room_resource_id: resourceId,
      lesson_id: null,
      schema_version: 1,
      created_at: NOW,
      updated_at: NOW,
    });
    expect(db.prepare(`
      SELECT is_guest FROM code_storage_usage WHERE workspace_id = ?
    `).get(workspaceId)).toEqual({ is_guest: 1 });
    expect(db.prepare(`
      SELECT * FROM code_guest_storage_usage WHERE singleton = 1
    `).get()).toEqual(beforeUsage);
    expect(() => db!.prepare(`
      INSERT INTO code_workspaces (
        id, room_resource_id, lesson_id, schema_version, created_at, updated_at
      ) VALUES (?, NULL, NULL, 1, ?, ?)
    `).run(randomUUID(), NOW, NOW)).toThrow();
    expect(db.prepare(`
      SELECT MAX(version) AS version FROM schema_migrations
    `).get()).toEqual({ version: 23 });
  });

  it("repairs a historical v21 schema that was recorded without call generation", () => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    migrate(db, { targetVersion: 20 });
    const roomId = randomUUID();
    const resourceId = randomUUID();
    db.prepare(`
      INSERT INTO guest_rooms (
        id, share_key, created_at, updated_at, last_activity_at, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(roomId, "r".repeat(43), NOW, NOW, NOW, "2026-08-12T08:00:00.000Z");
    db.prepare(`
      INSERT INTO guest_room_resources (
        id, room_id, kind, ordinal, resource_key, created_at, last_activity_at
      ) VALUES (?, ?, 'call', 1, ?, ?, ?)
    `).run(resourceId, roomId, "s".repeat(32), NOW, NOW);
    db.exec(`
      CREATE TABLE livekit_room_revocation_outbox (
        room_name TEXT PRIMARY KEY CHECK (length(room_name) BETWEEN 1 AND 255),
        generation INTEGER NOT NULL DEFAULT 1 CHECK (generation >= 1),
        enqueued_at TEXT NOT NULL,
        next_attempt_at TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 30),
        last_error_code TEXT
          CHECK (last_error_code IS NULL OR last_error_code = 'room_delete_failed')
      );
      CREATE INDEX livekit_room_revocation_retry_idx
        ON livekit_room_revocation_outbox(next_attempt_at, enqueued_at, room_name);
    `);
    db.prepare(`
      INSERT INTO schema_migrations (version, name, applied_at)
      VALUES (21, 'historical durable LiveKit room revocation outbox', ?)
    `).run(NOW);

    migrate(db);

    expect((db.prepare("PRAGMA table_info(guest_room_resources)").all() as Array<{
      name: string;
    }>).map((column) => column.name)).toContain("call_room_generation");
    expect(db.prepare(`
      SELECT call_room_generation FROM guest_room_resources WHERE id = ?
    `).get(resourceId)).toEqual({ call_room_generation: 1 });
    expect(db.prepare(`
      SELECT MAX(version) AS version FROM schema_migrations
    `).get()).toEqual({ version: 23 });
    expect(() => migrate(db!)).not.toThrow();
  });

  it("backfills bounded Code sync counters when upgrading from v12 to v13", () => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    migrate(db, { targetVersion: 12 });
    const roomId = randomUUID();
    const resourceId = randomUUID();
    const workspaceId = randomUUID();
    const documentId = randomUUID();
    const digest = "f".repeat(64);
    db.prepare(`
      INSERT INTO guest_rooms (
        id, share_key, created_at, updated_at, last_activity_at, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(roomId, "e".repeat(43), NOW, NOW, NOW, "2026-08-12T08:00:00.000Z");
    db.prepare(`
      INSERT INTO guest_room_resources (
        id, room_id, kind, ordinal, resource_key, created_at, last_activity_at
      ) VALUES (?, ?, 'code', 1, ?, ?, ?)
    `).run(resourceId, roomId, "f".repeat(32), NOW, NOW);
    db.prepare(`
      INSERT INTO code_workspaces (
        id, room_resource_id, schema_version, created_at, updated_at
      ) VALUES (?, ?, 1, ?, ?)
    `).run(workspaceId, resourceId, NOW, NOW);
    db.prepare(`
      INSERT INTO code_documents (
        id, workspace_id, snapshot_update, snapshot_bytes,
        state_vector, state_vector_bytes, created_at, updated_at
      ) VALUES (?, ?, X'', 0, X'00', 1, ?, ?)
    `).run(documentId, workspaceId, NOW, NOW);
    db.prepare(`
      INSERT INTO code_updates (
        document_id, sequence, update_digest, update_blob, update_bytes, created_at
      ) VALUES (?, 7, ?, X'0102', 2, ?)
    `).run(documentId, digest, NOW);
    db.prepare(`
      INSERT INTO code_update_receipts (
        document_id, device_id, update_id, update_digest, sequence, created_at
      ) VALUES (?, 'migration-device', 'migration-update', ?, 7, ?)
    `).run(documentId, digest, NOW);
    expect((db.prepare("PRAGMA table_info(code_documents)").all() as Array<{
      name: string;
    }>).map((column) => column.name)).not.toContain("last_sequence");

    migrate(db, { targetVersion: 13 });

    expect(db.prepare(`
      SELECT
        snapshot_sequence, last_sequence, update_log_count,
        update_log_bytes, receipt_count, compacted_at
      FROM code_documents WHERE id = ?
    `).get(documentId)).toEqual({
      snapshot_sequence: 0,
      last_sequence: 7,
      update_log_count: 1,
      update_log_bytes: 2,
      receipt_count: 1,
      compacted_at: null,
    });
    expect((db.prepare("PRAGMA index_list(code_update_receipts)").all() as Array<{
      name: string;
    }>).map((index) => index.name))
      .toContain("code_update_receipts_digest_idx");
    expect(db.prepare(`
      SELECT MAX(version) AS version FROM schema_migrations
    `).get()).toEqual({ version: 13 });
  });

  it("keeps pre-scan Code blobs unverified until the service attests them", () => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    migrate(db, { targetVersion: 11 });
    const roomId = randomUUID();
    const resourceId = randomUUID();
    db.prepare(`
      INSERT INTO guest_rooms (
        id, share_key, created_at, updated_at, last_activity_at, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(roomId, "c".repeat(43), NOW, NOW, NOW, "2026-08-12T08:00:00.000Z");
    db.prepare(`
      INSERT INTO guest_room_resources (
        id, room_id, kind, ordinal, resource_key, created_at, last_activity_at
      ) VALUES (?, ?, 'code', 1, ?, ?, ?)
    `).run(resourceId, roomId, "d".repeat(32), NOW, NOW);
    db.prepare(`
      INSERT INTO code_blobs (
        room_resource_id, sha256, byte_size, mime_type, storage_key, created_at
      ) VALUES (?, ?, 4, 'application/octet-stream', ?, ?)
    `).run(resourceId, "e".repeat(64), `blobs/${resourceId}/${"e".repeat(64)}`, NOW);

    migrate(db);

    expect(db.prepare(`
      SELECT scan_provider, scanned_at FROM code_blobs
      WHERE room_resource_id = ?
    `).get(resourceId)).toEqual({ scan_provider: null, scanned_at: null });
    expect((db.prepare("PRAGMA table_info(code_blobs)").all() as Array<{
      name: string;
    }>).map((column) => column.name)).toEqual(expect.arrayContaining([
      "scan_provider",
      "scanned_at",
    ]));
    expect(() => db!.prepare(`
      INSERT INTO code_blobs (
        room_resource_id, sha256, byte_size, mime_type, storage_key, created_at
      ) VALUES (?, ?, 4, 'application/octet-stream', ?, ?)
    `).run(resourceId, "f".repeat(64), `blobs/${resourceId}/${"f".repeat(64)}`, NOW))
      .toThrow(/requires a clean malware scan attestation/u);
  });

  it("migrates legacy material files into a fail-closed scan and cleanup schema", () => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    migrate(db, { targetVersion: 16 });
    const tutorId = randomUUID();
    const legacyMaterialId = randomUUID();
    db.prepare(`
      INSERT INTO users (
        id, role, status, display_name, created_at, updated_at
      ) VALUES (?, 'tutor', 'active', 'Material migration tutor', ?, ?)
    `).run(tutorId, NOW, NOW);
    db.prepare(`
      INSERT INTO materials (
        id, tutor_id, title, kind, storage_key, original_file_name,
        mime_type, file_size, created_at, updated_at
      ) VALUES (?, ?, 'Legacy file', 'file', 'files/legacy', 'legacy.bin',
        'application/octet-stream', 4, ?, ?)
    `).run(legacyMaterialId, tutorId, NOW, NOW);

    migrate(db, { targetVersion: 17 });

    expect(db.prepare(`
      SELECT file_sha256, scan_provider, scanned_at
      FROM materials WHERE id = ?
    `).get(legacyMaterialId)).toEqual({
      file_sha256: null,
      scan_provider: null,
      scanned_at: null,
    });
    for (const table of [
      "material_upload_reservations",
      "material_upload_rate_events",
      "material_file_gc_queue",
    ]) {
      expect(db.prepare(`
        SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?
      `).get(table), table).toEqual({ name: table });
    }

    const insertFile = db.prepare(`
      INSERT INTO materials (
        id, tutor_id, title, kind, storage_key, original_file_name,
        mime_type, file_size, created_at, updated_at,
        file_sha256, scan_provider, scanned_at
      ) VALUES (?, ?, 'Scanned file', 'file', ?, 'scan.bin',
        'application/octet-stream', 4, ?, ?, ?, ?, ?)
    `);
    expect(() => insertFile.run(
      randomUUID(), tutorId, "files/partial", NOW, NOW,
      "a".repeat(64), null, NOW,
    )).toThrow(/material file scan attestation is invalid/u);
    expect(() => insertFile.run(
      randomUUID(), tutorId, "files/uppercase", NOW, NOW,
      "A".repeat(64), "clamd", NOW,
    )).toThrow(/material file scan attestation is invalid/u);

    const scannedMaterialId = randomUUID();
    expect(insertFile.run(
      scannedMaterialId, tutorId, "files/scanned", NOW, NOW,
      "b".repeat(64), "clamd-instream-v1", NOW,
    ).changes).toBe(1);
    expect(() => db!.prepare(`
      UPDATE materials SET scan_provider = NULL WHERE id = ?
    `).run(scannedMaterialId)).toThrow(/material file scan attestation is invalid/u);
  });

  it("reconciles existing Board payload, receipt, and metadata usage in v19", () => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    migrate(db, { targetVersion: 18 });
    const fixture = insertBoardFixture(db);
    const guestRoomId = randomUUID();
    const guestResourceId = randomUUID();
    db.prepare(`
      INSERT INTO guest_rooms (
        id, share_key, created_at, updated_at, last_activity_at, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      guestRoomId,
      "g".repeat(43),
      NOW,
      NOW,
      NOW,
      "2026-08-12T08:00:00.000Z",
    );
    db.prepare(`
      INSERT INTO guest_room_resources (
        id, room_id, kind, ordinal, resource_key, created_at, last_activity_at
      ) VALUES (?, ?, 'board', 1, ?, ?, ?)
    `).run(guestResourceId, guestRoomId, "h".repeat(32), NOW, NOW);
    const guestRepository = new BoardRepository(db);
    const guestBoard = guestRepository.createBoardForRoomResource(guestResourceId);
    const guestMessageId = randomUUID();
    const guestClientId = randomUUID();
    guestRepository.appendUpdate({
      boardId: guestBoard.id,
      documentKey: "manifest",
      generation: guestBoard.generation,
      messageId: guestMessageId,
      actorId: "guest_migration_actor",
      clientId: guestClientId,
      update: Uint8Array.of(9),
    });

    migrate(db, { targetVersion: 19 });

    const receipt = db.prepare(`
      SELECT message_id, actor_id, client_id, update_sha256, created_at
      FROM board_update_receipts WHERE board_id = ?
    `).get(fixture.boardId) as {
      message_id: string;
      actor_id: string;
      client_id: string;
      update_sha256: string;
      created_at: string;
    };
    const receiptBytes = boardReceiptLogicalBytes({
      boardId: fixture.boardId,
      documentKey: "manifest",
      messageId: receipt.message_id,
      actorId: receipt.actor_id,
      clientId: receipt.client_id,
      updateSha256: receipt.update_sha256,
      createdAt: receipt.created_at,
    });
    const metadataBytes = BOARD_BASE_METADATA_RESERVE_BYTES
      + BOARD_DOCUMENT_METADATA_RESERVE_BYTES
      + BOARD_UPDATE_METADATA_RESERVE_BYTES
      + BOARD_RECEIPT_METADATA_RESERVE_BYTES
      + BOARD_LEGACY_IMPORT_METADATA_RESERVE_BYTES;
    expect(db.prepare(`
      SELECT
        document_count, snapshot_bytes, state_vector_bytes,
        update_count, update_bytes, receipt_count, receipt_bytes,
        legacy_source_bytes, metadata_bytes, accounted_bytes
      FROM board_storage_usage WHERE board_id = ? AND generation = 1
    `).get(fixture.boardId)).toEqual({
      document_count: 1,
      snapshot_bytes: 2,
      state_vector_bytes: 1,
      update_count: 1,
      update_bytes: 2,
      receipt_count: 1,
      receipt_bytes: receiptBytes,
      legacy_source_bytes: 2,
      metadata_bytes: metadataBytes,
      accounted_bytes: 2 + 1 + 2 + receiptBytes + 2 + metadataBytes,
    });
    const guestUsage = db.prepare(`
      SELECT * FROM board_storage_usage WHERE board_id = ? AND generation = 1
    `).get(guestBoard.id) as { accounted_bytes: number };
    expect(db.prepare(`
      SELECT generation_count, accounted_bytes
      FROM board_guest_storage_usage WHERE singleton = 1
    `).get()).toEqual({
      generation_count: 1,
      accounted_bytes: guestUsage.accounted_bytes,
    });
    expect(db.prepare(`
      SELECT MAX(version) AS version FROM schema_migrations
    `).get()).toEqual({ version: 19 });
  });

  it("reconciles existing guest Code payload, receipts, and metadata in v20", () => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    migrate(db, { targetVersion: 19 });
    const roomId = randomUUID();
    const resourceId = randomUUID();
    const workspaceId = randomUUID();
    const documentId = randomUUID();
    const updateDigest = "d".repeat(64);
    const deviceId = "migration-device";
    const updateId = "migration-update";
    db.prepare(`
      INSERT INTO guest_rooms (
        id, share_key, created_at, updated_at, last_activity_at, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(roomId, "g".repeat(43), NOW, NOW, NOW, "2026-08-12T08:00:00.000Z");
    db.prepare(`
      INSERT INTO guest_room_resources (
        id, room_id, kind, ordinal, resource_key, created_at, last_activity_at
      ) VALUES (?, ?, 'code', 1, ?, ?, ?)
    `).run(resourceId, roomId, "h".repeat(32), NOW, NOW);
    db.prepare(`
      INSERT INTO code_workspaces (
        id, room_resource_id, schema_version, created_at, updated_at
      ) VALUES (?, ?, 1, ?, ?)
    `).run(workspaceId, resourceId, NOW, NOW);
    db.prepare(`
      INSERT INTO code_documents (
        id, workspace_id, snapshot_update, snapshot_bytes,
        state_vector, state_vector_bytes, created_at, updated_at
      ) VALUES (?, ?, X'0102', 2, X'03', 1, ?, ?)
    `).run(documentId, workspaceId, NOW, NOW);
    db.prepare(`
      INSERT INTO code_updates (
        document_id, sequence, update_digest, update_blob, update_bytes,
        created_at
      ) VALUES (?, 1, ?, X'0405', 2, ?)
    `).run(documentId, updateDigest, NOW);
    db.prepare(`
      INSERT INTO code_update_receipts (
        document_id, device_id, update_id, update_digest, sequence, created_at
      ) VALUES (?, ?, ?, ?, 1, ?)
    `).run(documentId, deviceId, updateId, updateDigest, NOW);

    migrate(db, { targetVersion: 20 });

    const receiptBytes = codeReceiptLogicalBytes({
      documentId,
      deviceId,
      updateId,
      updateDigest,
      createdAt: NOW,
    });
    const metadataBytes = CODE_WORKSPACE_METADATA_RESERVE_BYTES
      + CODE_DOCUMENT_METADATA_RESERVE_BYTES
      + CODE_UPDATE_METADATA_RESERVE_BYTES
      + CODE_RECEIPT_METADATA_RESERVE_BYTES;
    const accountedBytes = 2 + 1 + 2 + receiptBytes + metadataBytes;
    expect(db.prepare(`
      SELECT
        document_count, snapshot_bytes, state_vector_bytes,
        update_count, update_bytes, receipt_count, receipt_bytes,
        metadata_bytes, accounted_bytes
      FROM code_storage_usage WHERE workspace_id = ?
    `).get(workspaceId)).toEqual({
      document_count: 1,
      snapshot_bytes: 2,
      state_vector_bytes: 1,
      update_count: 1,
      update_bytes: 2,
      receipt_count: 1,
      receipt_bytes: receiptBytes,
      metadata_bytes: metadataBytes,
      accounted_bytes: accountedBytes,
    });
    expect(db.prepare(`
      SELECT
        workspace_count, document_count, update_count, receipt_count,
        accounted_bytes
      FROM code_guest_storage_usage WHERE singleton = 1
    `).get()).toEqual({
      workspace_count: 1,
      document_count: 1,
      update_count: 1,
      receipt_count: 1,
      accounted_bytes: accountedBytes,
    });
    expect(db.prepare(`
      SELECT MAX(version) AS version FROM schema_migrations
    `).get()).toEqual({ version: 20 });

    db.prepare("DELETE FROM guest_rooms WHERE id = ?").run(roomId);
    expect(db.prepare(`
      SELECT workspace_count, accounted_bytes
      FROM code_guest_storage_usage WHERE singleton = 1
    `).get()).toEqual({ workspace_count: 0, accounted_bytes: 0 });
  });
});

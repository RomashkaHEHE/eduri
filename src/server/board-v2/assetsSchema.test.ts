import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { migrate } from "../db.js";
import { installBoardAssetSchema } from "./assetsSchema.js";
import { BoardRepository } from "./repository.js";

describe("Board v2 asset schema migration", () => {
  let db: Database.Database | undefined;
  let dataDir: string | undefined;

  afterEach(() => {
    if (db?.open) db.close();
    db = undefined;
    if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
    dataDir = undefined;
  });

  it("installs the additive private asset schema as migration v7", () => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    migrate(db, { targetVersion: 7 });
    installBoardAssetSchema(db);

    expect(
      db.prepare(
        "SELECT version, name FROM schema_migrations ORDER BY version DESC LIMIT 1",
      ).get(),
    ).toEqual({
      version: 7,
      name: "board v2 private content-addressed assets",
    });
    const tables = new Set(
      (db.prepare(`
        SELECT name FROM sqlite_master
        WHERE type = 'table' AND name LIKE 'board_asset%'
      `).all() as Array<{ name: string }>).map((row) => row.name),
    );
    expect(tables).toEqual(new Set([
      "board_asset_blobs",
      "board_assets",
      "board_asset_uploads",
    ]));
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  it("upgrades an existing schema with durable blob and staging-file garbage collection", () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "eduri-asset-schema-"));
    const databasePath = path.join(dataDir, "test.sqlite");
    db = new Database(databasePath);
    db.pragma("foreign_keys = ON");
    migrate(db, { targetVersion: 14 });
    expect(db.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'table' AND name = 'board_asset_gc_queue'
    `).get()).toBeUndefined();

    migrate(db, { targetVersion: 15 });

    expect(db.prepare(`
      SELECT MAX(version) AS version FROM schema_migrations
    `).get()).toEqual({ version: 15 });
    expect(db.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'table' AND name = 'board_asset_gc_queue'
    `).get()).toEqual({ name: "board_asset_gc_queue" });
    const triggers = new Set((db.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'trigger' AND name LIKE 'board_asset_%_enqueue_gc'
    `).all() as Array<{ name: string }>).map((row) => row.name));
    expect(triggers).toEqual(new Set([
      "board_asset_blobs_enqueue_gc",
      "board_asset_uploads_enqueue_gc",
    ]));

    const tutorId = randomUUID();
    const studentId = randomUUID();
    const lessonId = randomUUID();
    const timestamp = "2026-08-09T08:00:00.000Z";
    db.prepare(`
      INSERT INTO users (
        id, role, status, display_name, login_name, login_name_normalized,
        created_at, updated_at
      ) VALUES (?, 'tutor', 'active', 'Tutor', ?, ?, ?, ?)
    `).run(tutorId, `tutor-${tutorId}`, `tutor-${tutorId}`, timestamp, timestamp);
    db.prepare(`
      INSERT INTO users (
        id, role, status, display_name, tutor_id, created_at, updated_at
      ) VALUES (?, 'student', 'active', 'Student', ?, ?, ?)
    `).run(studentId, tutorId, timestamp, timestamp);
    db.prepare(`
      INSERT INTO lessons (
        id, tutor_id, student_id, title, meeting_key, scheduled_at,
        duration_minutes, status, created_at, updated_at
      ) VALUES (?, ?, ?, 'Recovery', ?, ?, 60, 'scheduled', ?, ?)
    `).run(
      lessonId,
      tutorId,
      studentId,
      `meeting-${randomUUID()}`,
      timestamp,
      timestamp,
      timestamp,
    );
    const board = new BoardRepository(db).createBoardForLesson(lessonId, {
      engine: "v2",
    });
    const assetId = randomUUID();
    const uploadId = randomUUID();
    const stagingKey = `staging/test/${uploadId}.part`;
    db.prepare(`
      INSERT INTO board_assets (
        board_id, generation, asset_id, tenant_id, status, expected_sha256,
        byte_size, declared_mime, created_by, created_at, updated_at,
        last_error_code
      ) VALUES (?, 1, ?, ?, 'rejected', ?, 1, 'image/png', ?, ?, ?, 'DECODE_FAILED')
    `).run(
      board.id,
      assetId,
      tutorId,
      "a".repeat(64),
      tutorId,
      timestamp,
      timestamp,
    );
    db.prepare(`
      INSERT INTO board_asset_uploads (
        upload_id, board_id, generation, asset_id, tenant_id, expected_sha256,
        expected_bytes, chunk_bytes, next_offset, staging_key, status,
        failure_code, created_at, updated_at, expires_at
      ) VALUES (?, ?, 1, ?, ?, ?, 1, 1, 0, ?, 'rejected',
        'DECODE_FAILED', ?, ?, ?)
    `).run(
      uploadId,
      board.id,
      assetId,
      tutorId,
      "a".repeat(64),
      stagingKey,
      timestamp,
      timestamp,
      timestamp,
    );
    const stagingPath = path.join(dataDir, ...stagingKey.split("/"));
    fs.mkdirSync(path.dirname(stagingPath), { recursive: true });
    fs.writeFileSync(stagingPath, "x");
    const activeAssetId = randomUUID();
    const activeUploadId = randomUUID();
    const activeHash = "b".repeat(64);
    const activeStagingKey = `staging/test/${activeUploadId}.part`;
    db.prepare(`
      INSERT INTO board_assets (
        board_id, generation, asset_id, tenant_id, status, expected_sha256,
        byte_size, declared_mime, created_by, created_at, updated_at
      ) VALUES (?, 1, ?, ?, 'pending', ?, 1, 'image/png', ?, ?, ?)
    `).run(
      board.id,
      activeAssetId,
      tutorId,
      activeHash,
      tutorId,
      timestamp,
      timestamp,
    );
    db.prepare(`
      INSERT INTO board_asset_uploads (
        upload_id, board_id, generation, asset_id, tenant_id, expected_sha256,
        expected_bytes, chunk_bytes, next_offset, staging_key, status,
        created_at, updated_at, expires_at
      ) VALUES (?, ?, 1, ?, ?, ?, 1, 1, 1, ?, 'active', ?, ?, ?)
    `).run(
      activeUploadId,
      board.id,
      activeAssetId,
      tutorId,
      activeHash,
      activeStagingKey,
      timestamp,
      timestamp,
      timestamp,
    );
    const activeStagingPath = path.join(dataDir, ...activeStagingKey.split("/"));
    fs.mkdirSync(path.dirname(activeStagingPath), { recursive: true });
    fs.writeFileSync(activeStagingPath, "y");
    const tenantDigest = createHash("sha256").update(tutorId).digest("hex");
    const activeFinalKey = `blobs/${tenantDigest}/${activeHash.slice(0, 2)}/${activeHash}`;
    const activeFinalPath = path.join(dataDir, ...activeFinalKey.split("/"));
    fs.mkdirSync(path.dirname(activeFinalPath), { recursive: true });
    fs.linkSync(activeStagingPath, activeFinalPath);

    db.close();
    db = new Database(databasePath);
    db.pragma("foreign_keys = ON");
    migrate(db);

    expect(db.prepare(`
      SELECT MAX(version) AS version FROM schema_migrations
    `).get()).toEqual({ version: 21 });
    expect((db.prepare("PRAGMA table_info(board_asset_uploads)").all() as Array<{
      name: string;
    }>).map((column) => column.name)).toContain("final_storage_key");
    expect(db.prepare(`
      SELECT storage_key FROM board_asset_gc_queue WHERE storage_key = ?
    `).get(stagingKey)).toEqual({ storage_key: stagingKey });
    expect(db.prepare(`
      SELECT final_storage_key FROM board_asset_uploads WHERE upload_id = ?
    `).get(activeUploadId)).toEqual({ final_storage_key: activeFinalKey });
    expect(db.prepare(`
      SELECT storage_key FROM board_asset_gc_queue WHERE storage_key = ?
    `).get(activeFinalKey)).toEqual({ storage_key: activeFinalKey });
    expect(fs.existsSync(stagingPath)).toBe(true);
    expect(fs.existsSync(activeFinalPath)).toBe(true);
  });
});

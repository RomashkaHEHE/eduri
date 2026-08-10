import { createHash } from "node:crypto";
import type Database from "better-sqlite3";

/**
 * Standalone additive installer. Call it from the application's next numbered
 * migration while that migration is already inside its transaction.
 */
export function installBoardAssetSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS board_asset_blobs (
      tenant_id TEXT NOT NULL,
      sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
      storage_key TEXT NOT NULL UNIQUE,
      mime_type TEXT NOT NULL,
      byte_size INTEGER NOT NULL CHECK (byte_size > 0),
      width INTEGER NOT NULL CHECK (width > 0),
      height INTEGER NOT NULL CHECK (height > 0),
      frame_count INTEGER NOT NULL DEFAULT 1 CHECK (frame_count >= 1),
      decoded_pixels INTEGER NOT NULL CHECK (decoded_pixels >= width * height),
      created_at TEXT NOT NULL,
      PRIMARY KEY (tenant_id, sha256)
    );

    CREATE TRIGGER IF NOT EXISTS board_asset_blobs_immutable
    BEFORE UPDATE ON board_asset_blobs
    BEGIN
      SELECT RAISE(ABORT, 'published board asset blobs are immutable');
    END;

    CREATE TABLE IF NOT EXISTS board_assets (
      board_id TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
      generation INTEGER NOT NULL CHECK (generation >= 1),
      asset_id TEXT NOT NULL,
      tenant_id TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending', 'ready', 'rejected')),
      expected_sha256 TEXT NOT NULL CHECK (length(expected_sha256) = 64),
      blob_sha256 TEXT,
      byte_size INTEGER NOT NULL CHECK (byte_size > 0),
      declared_mime TEXT NOT NULL,
      detected_mime TEXT,
      original_file_name TEXT,
      width INTEGER,
      height INTEGER,
      frame_count INTEGER,
      decoded_pixels INTEGER,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      published_at TEXT,
      last_error_code TEXT,
      PRIMARY KEY (board_id, generation, asset_id),
      FOREIGN KEY (tenant_id, blob_sha256)
        REFERENCES board_asset_blobs(tenant_id, sha256),
      CHECK (
        (status = 'ready'
          AND blob_sha256 IS NOT NULL
          AND detected_mime IS NOT NULL
          AND width IS NOT NULL
          AND height IS NOT NULL
          AND frame_count IS NOT NULL
          AND decoded_pixels IS NOT NULL
          AND published_at IS NOT NULL)
        OR
        (status IN ('pending', 'rejected') AND blob_sha256 IS NULL)
      )
    );
    CREATE INDEX IF NOT EXISTS board_assets_tenant_status_idx
      ON board_assets(tenant_id, status, updated_at);
    CREATE INDEX IF NOT EXISTS board_assets_blob_idx
      ON board_assets(tenant_id, blob_sha256) WHERE blob_sha256 IS NOT NULL;

    CREATE TRIGGER IF NOT EXISTS board_assets_identity_immutable
    BEFORE UPDATE OF
      board_id, generation, asset_id, tenant_id, expected_sha256, byte_size,
      declared_mime, original_file_name, created_by, created_at
    ON board_assets
    BEGIN
      SELECT RAISE(ABORT, 'board asset identity is immutable');
    END;

    CREATE TABLE IF NOT EXISTS board_asset_uploads (
      upload_id TEXT PRIMARY KEY,
      board_id TEXT NOT NULL,
      generation INTEGER NOT NULL CHECK (generation >= 1),
      asset_id TEXT NOT NULL,
      tenant_id TEXT NOT NULL,
      expected_sha256 TEXT NOT NULL CHECK (length(expected_sha256) = 64),
      expected_bytes INTEGER NOT NULL CHECK (expected_bytes > 0),
      chunk_bytes INTEGER NOT NULL CHECK (chunk_bytes > 0),
      next_offset INTEGER NOT NULL DEFAULT 0
        CHECK (next_offset >= 0 AND next_offset <= expected_bytes),
      staging_key TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL CHECK (status IN ('active', 'completed', 'rejected')),
      failure_code TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      completed_at TEXT,
      FOREIGN KEY (board_id, generation, asset_id)
        REFERENCES board_assets(board_id, generation, asset_id) ON DELETE CASCADE
    );
    CREATE UNIQUE INDEX IF NOT EXISTS board_asset_uploads_active_asset_idx
      ON board_asset_uploads(board_id, generation, asset_id)
      WHERE status = 'active';
    CREATE INDEX IF NOT EXISTS board_asset_uploads_tenant_status_idx
      ON board_asset_uploads(tenant_id, status, expires_at);

    CREATE TRIGGER IF NOT EXISTS board_asset_uploads_identity_immutable
    BEFORE UPDATE OF
      upload_id, board_id, generation, asset_id, tenant_id, expected_sha256,
      expected_bytes, chunk_bytes, staging_key, created_at
    ON board_asset_uploads
    BEGIN
      SELECT RAISE(ABORT, 'board asset upload identity is immutable');
    END;
  `);
}

/**
 * Durable filesystem garbage collection added after the original asset schema.
 * Queue insertion is transactional with metadata deletion; physical unlinking
 * can therefore be retried safely after a crash.
 */
export function installBoardAssetGarbageCollectionSchema(
  db: Database.Database,
): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS board_asset_gc_queue (
      storage_key TEXT PRIMARY KEY,
      enqueued_at TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
      last_error TEXT
    );

    CREATE TRIGGER IF NOT EXISTS board_asset_blobs_enqueue_gc
    AFTER DELETE ON board_asset_blobs
    BEGIN
      INSERT OR IGNORE INTO board_asset_gc_queue (storage_key, enqueued_at)
      VALUES (OLD.storage_key, datetime('now'));
    END;

    CREATE TRIGGER IF NOT EXISTS board_asset_uploads_enqueue_gc
    AFTER DELETE ON board_asset_uploads
    BEGIN
      INSERT OR IGNORE INTO board_asset_gc_queue (storage_key, enqueued_at)
      VALUES (OLD.staging_key, datetime('now'));
    END;
  `);
}

/**
 * Adds crash recovery for upload staging creation and final hardlink
 * publication without rewriting the shipped v15 garbage-collection schema.
 */
export function installBoardAssetUploadRecoverySchema(
  db: Database.Database,
): void {
  const columns = db.prepare("PRAGMA table_info(board_asset_uploads)").all() as Array<{
    name: string;
  }>;
  if (!columns.some((column) => column.name === "final_storage_key")) {
    db.exec("ALTER TABLE board_asset_uploads ADD COLUMN final_storage_key TEXT");
  }
  const activeUploads = db.prepare(`
    SELECT upload_id, tenant_id, expected_sha256
    FROM board_asset_uploads
    WHERE status = 'active' AND final_storage_key IS NULL
  `).all() as Array<{
    upload_id: string;
    tenant_id: string;
    expected_sha256: string;
  }>;
  const setFinalKey = db.prepare(`
    UPDATE board_asset_uploads SET final_storage_key = ?
    WHERE upload_id = ? AND status = 'active' AND final_storage_key IS NULL
  `);
  const enqueueFinalKey = db.prepare(`
    INSERT OR IGNORE INTO board_asset_gc_queue (storage_key, enqueued_at)
    VALUES (?, datetime('now'))
  `);
  for (const upload of activeUploads) {
    const tenantDigest = createHash("sha256").update(upload.tenant_id).digest("hex");
    const storageKey = `blobs/${tenantDigest}/${upload.expected_sha256.slice(0, 2)}/${upload.expected_sha256}`;
    setFinalKey.run(storageKey, upload.upload_id);
    enqueueFinalKey.run(storageKey);
  }
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS board_asset_uploads_final_key_once
    BEFORE UPDATE OF final_storage_key ON board_asset_uploads
    WHEN OLD.final_storage_key IS NOT NULL
      AND NEW.final_storage_key IS NOT OLD.final_storage_key
    BEGIN
      SELECT RAISE(ABORT, 'board asset upload final storage key is immutable');
    END;

    CREATE TRIGGER IF NOT EXISTS board_asset_uploads_terminal_enqueue_gc
    AFTER UPDATE OF status ON board_asset_uploads
    WHEN OLD.status = 'active' AND NEW.status IN ('completed', 'rejected')
    BEGIN
      INSERT OR IGNORE INTO board_asset_gc_queue (storage_key, enqueued_at)
      VALUES (NEW.staging_key, datetime('now'));
      INSERT OR IGNORE INTO board_asset_gc_queue (storage_key, enqueued_at)
      SELECT NEW.final_storage_key, datetime('now')
      WHERE NEW.final_storage_key IS NOT NULL;
    END;

    CREATE TRIGGER IF NOT EXISTS board_asset_uploads_final_enqueue_gc
    AFTER DELETE ON board_asset_uploads
    WHEN OLD.final_storage_key IS NOT NULL
    BEGIN
      INSERT OR IGNORE INTO board_asset_gc_queue (storage_key, enqueued_at)
      VALUES (OLD.final_storage_key, datetime('now'));
    END;

    INSERT OR IGNORE INTO board_asset_gc_queue (storage_key, enqueued_at)
    SELECT staging_key, datetime('now')
    FROM board_asset_uploads
    WHERE status IN ('completed', 'rejected');
  `);
}

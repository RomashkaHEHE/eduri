import type Database from "better-sqlite3";

export function installCodeBlobSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS code_blobs (
      room_resource_id TEXT NOT NULL
        REFERENCES guest_room_resources(id) ON DELETE CASCADE,
      sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
      byte_size INTEGER NOT NULL CHECK (byte_size BETWEEN 1 AND 33554432),
      mime_type TEXT NOT NULL CHECK (length(mime_type) BETWEEN 3 AND 255),
      storage_key TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL,
      PRIMARY KEY (room_resource_id, sha256)
    );

    CREATE TABLE IF NOT EXISTS code_blob_uploads (
      upload_id TEXT PRIMARY KEY CHECK (length(upload_id) = 36),
      room_resource_id TEXT NOT NULL
        REFERENCES guest_room_resources(id) ON DELETE CASCADE,
      sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
      byte_size INTEGER NOT NULL CHECK (byte_size BETWEEN 1 AND 33554432),
      mime_type TEXT NOT NULL CHECK (length(mime_type) BETWEEN 3 AND 255),
      chunk_bytes INTEGER NOT NULL CHECK (chunk_bytes BETWEEN 1 AND 1048576),
      next_offset INTEGER NOT NULL DEFAULT 0
        CHECK (next_offset BETWEEN 0 AND byte_size),
      staging_key TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      UNIQUE (room_resource_id, sha256)
    );
    CREATE INDEX IF NOT EXISTS code_blob_uploads_expiry_idx
      ON code_blob_uploads(expires_at);

    -- This queue intentionally has no foreign key. Cascading room deletion
    -- removes metadata while retaining the exact private paths to unlink.
    CREATE TABLE IF NOT EXISTS code_blob_gc_queue (
      storage_key TEXT PRIMARY KEY,
      enqueued_at TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
      last_error TEXT
    );

    CREATE TRIGGER IF NOT EXISTS code_blobs_enqueue_gc
    BEFORE DELETE ON code_blobs
    BEGIN
      INSERT OR IGNORE INTO code_blob_gc_queue (storage_key, enqueued_at)
      VALUES (OLD.storage_key, datetime('now'));
    END;

    CREATE TRIGGER IF NOT EXISTS code_blob_uploads_enqueue_gc
    BEFORE DELETE ON code_blob_uploads
    BEGIN
      INSERT OR IGNORE INTO code_blob_gc_queue (storage_key, enqueued_at)
      VALUES (OLD.staging_key, datetime('now'));
    END;

    CREATE TRIGGER IF NOT EXISTS code_blobs_identity_immutable
    BEFORE UPDATE OF room_resource_id, sha256, byte_size, mime_type, storage_key
    ON code_blobs
    BEGIN SELECT RAISE(ABORT, 'code blob identity is immutable'); END;
  `);
}

export function installCodeBlobScanSchema(db: Database.Database): void {
  const columns = db.prepare("PRAGMA table_info(code_blobs)").all() as Array<{
    name: string;
  }>;
  if (!columns.some((column) => column.name === "scan_provider")) {
    db.exec("ALTER TABLE code_blobs ADD COLUMN scan_provider TEXT");
  }
  if (!columns.some((column) => column.name === "scanned_at")) {
    db.exec("ALTER TABLE code_blobs ADD COLUMN scanned_at TEXT");
  }
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS code_blobs_scan_attestation_required
    BEFORE INSERT ON code_blobs
    WHEN NEW.scan_provider IS NULL
      OR length(NEW.scan_provider) NOT BETWEEN 1 AND 255
      OR NEW.scanned_at IS NULL
      OR length(NEW.scanned_at) < 20
    BEGIN SELECT RAISE(ABORT, 'code blob requires a clean malware scan attestation'); END;

    -- A v11-v13 row may receive exactly one attestation after a successful
    -- scan. Published attestations cannot be replaced or cleared later.
    CREATE TRIGGER IF NOT EXISTS code_blobs_scan_attestation_immutable
    BEFORE UPDATE OF scan_provider, scanned_at ON code_blobs
    WHEN NOT (
      OLD.scan_provider IS NULL
      AND OLD.scanned_at IS NULL
      AND NEW.scan_provider IS NOT NULL
      AND length(NEW.scan_provider) BETWEEN 1 AND 255
      AND NEW.scanned_at IS NOT NULL
      AND length(NEW.scanned_at) >= 20
    )
    BEGIN SELECT RAISE(ABORT, 'code blob malware scan attestation is immutable'); END;
  `);
}

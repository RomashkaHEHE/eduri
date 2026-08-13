import type Database from "better-sqlite3";
import {
  installCodeStorageUsageSchema,
  installLessonCodeStorageUsageSchema,
} from "./storageUsageSchema.js";

export function installCodeSyncBaseSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS code_workspaces (
      id TEXT PRIMARY KEY CHECK (length(id) = 36),
      room_resource_id TEXT NOT NULL UNIQUE
        REFERENCES guest_room_resources(id) ON DELETE CASCADE,
      schema_version INTEGER NOT NULL CHECK (schema_version = 1),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS code_documents (
      id TEXT PRIMARY KEY CHECK (length(id) = 36),
      workspace_id TEXT NOT NULL UNIQUE
        REFERENCES code_workspaces(id) ON DELETE CASCADE,
      snapshot_update BLOB NOT NULL,
      snapshot_bytes INTEGER NOT NULL
        CHECK (snapshot_bytes >= 0 AND snapshot_bytes = length(snapshot_update)),
      state_vector BLOB NOT NULL,
      state_vector_bytes INTEGER NOT NULL
        CHECK (
          state_vector_bytes BETWEEN 1 AND 65536
          AND state_vector_bytes = length(state_vector)
        ),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS code_updates (
      document_id TEXT NOT NULL
        REFERENCES code_documents(id) ON DELETE CASCADE,
      sequence INTEGER NOT NULL CHECK (sequence >= 1),
      update_digest TEXT NOT NULL CHECK (length(update_digest) = 64),
      update_blob BLOB NOT NULL,
      update_bytes INTEGER NOT NULL
        CHECK (
          update_bytes BETWEEN 1 AND 4194304
          AND update_bytes = length(update_blob)
        ),
      created_at TEXT NOT NULL,
      PRIMARY KEY (document_id, sequence),
      UNIQUE (document_id, update_digest)
    );
    CREATE INDEX IF NOT EXISTS code_updates_document_sequence_idx
      ON code_updates(document_id, sequence);

    CREATE TABLE IF NOT EXISTS code_update_receipts (
      document_id TEXT NOT NULL
        REFERENCES code_documents(id) ON DELETE CASCADE,
      device_id TEXT NOT NULL CHECK (length(device_id) BETWEEN 1 AND 128),
      update_id TEXT NOT NULL CHECK (length(update_id) BETWEEN 1 AND 128),
      update_digest TEXT NOT NULL CHECK (length(update_digest) = 64),
      sequence INTEGER NOT NULL CHECK (sequence >= 0),
      created_at TEXT NOT NULL,
      PRIMARY KEY (document_id, device_id, update_id)
    );
    CREATE INDEX IF NOT EXISTS code_update_receipts_created_idx
      ON code_update_receipts(document_id, created_at);

    CREATE TRIGGER IF NOT EXISTS code_updates_payload_immutable
    BEFORE UPDATE OF document_id, update_digest, update_blob, update_bytes
    ON code_updates
    BEGIN SELECT RAISE(ABORT, 'code update payload is immutable'); END;

    CREATE TRIGGER IF NOT EXISTS code_update_receipts_identity_immutable
    BEFORE UPDATE OF document_id, device_id, update_id, update_digest, sequence
    ON code_update_receipts
    BEGIN SELECT RAISE(ABORT, 'code update receipt is immutable'); END;

  `);
}

/**
 * Migration-v22 installer. Existing guest workspaces keep their identifiers
 * and payload rows; lesson ownership is additive and the retained lesson
 * whole-state columns remain untouched as rollback history.
 *
 * This function must run with SQLite foreign keys disabled because SQLite
 * cannot make the historical room_resource_id column nullable in place.
 */
export function installLessonCodeWorkspaceSchema(
  db: Database.Database,
): void {
  const workspaceColumns = columnNames(db, "code_workspaces");
  if (!workspaceColumns.has("lesson_id")) {
    db.exec(`
      DROP TRIGGER IF EXISTS code_workspaces_storage_identity_immutable;
      DROP TRIGGER IF EXISTS code_workspaces_storage_insert;

      CREATE TABLE code_workspaces_v22 (
        id TEXT PRIMARY KEY CHECK (length(id) = 36),
        room_resource_id TEXT UNIQUE
          REFERENCES guest_room_resources(id) ON DELETE CASCADE,
        lesson_id TEXT UNIQUE REFERENCES lessons(id) ON DELETE CASCADE,
        schema_version INTEGER NOT NULL CHECK (schema_version = 1),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        CHECK ((room_resource_id IS NOT NULL) != (lesson_id IS NOT NULL))
      );
      INSERT INTO code_workspaces_v22 (
        id, room_resource_id, lesson_id, schema_version, created_at, updated_at
      )
      SELECT id, room_resource_id, NULL, schema_version, created_at, updated_at
      FROM code_workspaces;
      DROP TABLE code_workspaces;
      ALTER TABLE code_workspaces_v22 RENAME TO code_workspaces;
      CREATE INDEX code_workspaces_lesson_idx ON code_workspaces(lesson_id);
    `);
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS lesson_code_legacy_imports (
      workspace_id TEXT PRIMARY KEY
        REFERENCES code_workspaces(id) ON DELETE CASCADE,
      lesson_id TEXT NOT NULL UNIQUE REFERENCES lessons(id) ON DELETE CASCADE,
      source_revision INTEGER NOT NULL CHECK (source_revision >= 0),
      source_json TEXT NOT NULL,
      source_sha256 TEXT NOT NULL CHECK (
        length(source_sha256) = 64
        AND source_sha256 NOT GLOB '*[^0-9a-f]*'
      ),
      imported_at TEXT NOT NULL
    );

    CREATE TRIGGER IF NOT EXISTS lesson_code_legacy_imports_source_immutable
    BEFORE UPDATE OF workspace_id, lesson_id, source_revision, source_json,
      source_sha256, imported_at
    ON lesson_code_legacy_imports
    BEGIN SELECT RAISE(ABORT, 'lesson Code legacy import is immutable'); END;
  `);
}

function columnNames(db: Database.Database, table: string): Set<string> {
  return new Set((db.prepare(`PRAGMA table_info(${table})`).all() as Array<{
    name: string;
  }>).map((column) => column.name));
}

export function installCodeSyncCompactionSchema(db: Database.Database): void {
  const columns = columnNames(db, "code_documents");
  const additions = [
    [
      "snapshot_sequence",
      "INTEGER NOT NULL DEFAULT 0 CHECK (snapshot_sequence >= 0)",
    ],
    [
      "last_sequence",
      "INTEGER NOT NULL DEFAULT 0 CHECK (last_sequence >= 0)",
    ],
    [
      "update_log_count",
      "INTEGER NOT NULL DEFAULT 0 CHECK (update_log_count >= 0)",
    ],
    [
      "update_log_bytes",
      "INTEGER NOT NULL DEFAULT 0 CHECK (update_log_bytes >= 0)",
    ],
    [
      "receipt_count",
      "INTEGER NOT NULL DEFAULT 0 CHECK (receipt_count >= 0)",
    ],
    ["compacted_at", "TEXT"],
  ] as const;
  for (const [name, definition] of additions) {
    if (!columns.has(name)) {
      db.exec(`ALTER TABLE code_documents ADD COLUMN ${name} ${definition}`);
    }
  }

  db.exec(`
    CREATE INDEX IF NOT EXISTS code_update_receipts_digest_idx
      ON code_update_receipts(document_id, update_digest);

    UPDATE code_documents
    SET
      last_sequence = COALESCE((
        SELECT MAX(update_row.sequence)
        FROM code_updates update_row
        WHERE update_row.document_id = code_documents.id
      ), snapshot_sequence),
      update_log_count = (
        SELECT COUNT(*)
        FROM code_updates update_row
        WHERE update_row.document_id = code_documents.id
      ),
      update_log_bytes = COALESCE((
        SELECT SUM(update_row.update_bytes)
        FROM code_updates update_row
        WHERE update_row.document_id = code_documents.id
      ), 0),
      receipt_count = (
        SELECT COUNT(*)
        FROM code_update_receipts receipt
        WHERE receipt.document_id = code_documents.id
      );
  `);
}

/** Installs the current standalone schema used by focused repositories/tests. */
export function installCodeSyncSchema(db: Database.Database): void {
  installCodeSyncBaseSchema(db);
  installCodeSyncCompactionSchema(db);
  const usageTable = db.prepare(`
    SELECT 1 FROM sqlite_master
    WHERE type = 'table' AND name = 'code_storage_usage'
  `).get();
  if (!usageTable) installCodeStorageUsageSchema(db);
  const foreignKeys = db.pragma("foreign_keys", { simple: true }) === 1;
  if (foreignKeys) db.pragma("foreign_keys = OFF");
  try {
    installLessonCodeWorkspaceSchema(db);
    installLessonCodeStorageUsageSchema(db);
    const violations = db.pragma("foreign_key_check") as unknown[];
    if (violations.length > 0) {
      throw new Error("Code sync schema installation violated foreign keys");
    }
  } finally {
    if (foreignKeys) db.pragma("foreign_keys = ON");
  }
}

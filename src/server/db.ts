import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { hashPassword, newId, normalizeLogin, nowIso, randomToken } from "./security.js";
import type { AppConfig } from "./config.js";
import type { AppContext, StoredUserRow } from "./types.js";
import {
  installBoardAssetGarbageCollectionSchema,
  installBoardAssetSchema,
  installBoardAssetUploadRecoverySchema,
} from "./board-v2/assetsSchema.js";
import {
  installCodeSyncBaseSchema,
  installCodeSyncCompactionSchema,
} from "./code-sync/schema.js";
import { installCodeStorageUsageSchema } from "./code-sync/storageUsageSchema.js";
import {
  installCodeBlobScanSchema,
  installCodeBlobSchema,
} from "./code-blobs/schema.js";
import { installAuthRateLimitSchema } from "./authRateLimit.js";
import { installBoardStorageUsageSchema } from "./board-v2/storageUsageSchema.js";

interface Migration {
  version: number;
  name: string;
  sql?: string;
  up?: (db: Database.Database) => void;
  foreignKeysOff?: boolean;
}

export interface MigrateOptions {
  targetVersion?: number;
}

const migrations: Migration[] = [
  {
    version: 1,
    name: "initial private tutoring platform schema",
    sql: `
      CREATE TABLE users (
        id TEXT PRIMARY KEY,
        role TEXT NOT NULL CHECK (role IN ('admin', 'tutor', 'student')),
        status TEXT NOT NULL CHECK (status IN ('pending', 'active', 'suspended')),
        display_name TEXT NOT NULL,
        login_name TEXT,
        login_name_normalized TEXT,
        credential_lookup TEXT,
        password_hash TEXT,
        tutor_id TEXT REFERENCES users(id) ON DELETE CASCADE,
        note TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_login_at TEXT,
        CHECK ((role = 'student' AND tutor_id IS NOT NULL) OR (role != 'student' AND tutor_id IS NULL))
      );
      CREATE UNIQUE INDEX users_staff_login_unique
        ON users(login_name_normalized) WHERE role IN ('admin', 'tutor');
      CREATE UNIQUE INDEX users_student_lookup_unique
        ON users(credential_lookup) WHERE credential_lookup IS NOT NULL;
      CREATE INDEX users_tutor_id_idx ON users(tutor_id);

      CREATE TABLE sessions (
        session_hash TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        ip_address TEXT,
        user_agent TEXT
      );
      CREATE INDEX sessions_user_idx ON sessions(user_id);
      CREATE INDEX sessions_expiry_idx ON sessions(expires_at);

      CREATE TABLE invites (
        id TEXT PRIMARY KEY,
        target_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        purpose TEXT NOT NULL CHECK (purpose IN ('student_activation', 'tutor_activation', 'password_reset')),
        token_hash TEXT NOT NULL UNIQUE,
        expires_at TEXT NOT NULL,
        consumed_at TEXT,
        revoked_at TEXT,
        created_by TEXT NOT NULL REFERENCES users(id),
        created_at TEXT NOT NULL
      );
      CREATE INDEX invites_target_idx ON invites(target_user_id);
      CREATE INDEX invites_expiry_idx ON invites(expires_at);

      CREATE TABLE lessons (
        id TEXT PRIMARY KEY,
        tutor_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        student_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        meeting_key TEXT NOT NULL,
        scheduled_at TEXT NOT NULL,
        duration_minutes INTEGER NOT NULL CHECK (duration_minutes BETWEEN 15 AND 480),
        status TEXT NOT NULL CHECK (status IN ('scheduled', 'active', 'completed', 'cancelled')),
        notes TEXT NOT NULL DEFAULT '',
        started_at TEXT,
        ended_at TEXT,
        board_state TEXT NOT NULL DEFAULT '{}',
        code_state TEXT NOT NULL DEFAULT '{}',
        board_revision INTEGER NOT NULL DEFAULT 0,
        code_revision INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX lessons_tutor_schedule_idx ON lessons(tutor_id, scheduled_at);
      CREATE INDEX lessons_student_schedule_idx ON lessons(student_id, scheduled_at);

      CREATE TABLE materials (
        id TEXT PRIMARY KEY,
        tutor_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('note', 'link', 'file', 'task')),
        body TEXT,
        url TEXT,
        tags_json TEXT NOT NULL DEFAULT '[]',
        storage_key TEXT,
        original_file_name TEXT,
        mime_type TEXT,
        file_size INTEGER,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        CHECK (
          (kind = 'note' AND body IS NOT NULL) OR
          (kind = 'link' AND url IS NOT NULL) OR
          (kind = 'file' AND storage_key IS NOT NULL) OR
          (kind = 'task' AND body IS NOT NULL)
        )
      );
      CREATE INDEX materials_tutor_created_idx ON materials(tutor_id, created_at DESC);

      CREATE TABLE material_access (
        material_id TEXT NOT NULL REFERENCES materials(id) ON DELETE CASCADE,
        student_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        granted_at TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('assigned', 'covered', 'completed')),
        updated_at TEXT NOT NULL,
        lesson_id TEXT REFERENCES lessons(id) ON DELETE SET NULL,
        PRIMARY KEY (material_id, student_id)
      );
      CREATE INDEX material_access_student_idx ON material_access(student_id);

      CREATE TABLE lesson_materials (
        lesson_id TEXT NOT NULL REFERENCES lessons(id) ON DELETE CASCADE,
        material_id TEXT NOT NULL REFERENCES materials(id) ON DELETE CASCADE,
        position INTEGER NOT NULL DEFAULT 0,
        added_at TEXT NOT NULL,
        PRIMARY KEY (lesson_id, material_id)
      );
      CREATE INDEX lesson_materials_material_idx ON lesson_materials(material_id);

      CREATE TABLE assignments (
        id TEXT PRIMARY KEY,
        tutor_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        student_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        due_at TEXT,
        status TEXT NOT NULL CHECK (status IN ('assigned', 'submitted', 'reviewed', 'returned')),
        answer TEXT,
        feedback TEXT,
        submitted_at TEXT,
        reviewed_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX assignments_tutor_idx ON assignments(tutor_id, created_at DESC);
      CREATE INDEX assignments_student_idx ON assignments(student_id, created_at DESC);

      CREATE TABLE assignment_materials (
        assignment_id TEXT NOT NULL REFERENCES assignments(id) ON DELETE CASCADE,
        material_id TEXT NOT NULL REFERENCES materials(id) ON DELETE CASCADE,
        position INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (assignment_id, material_id)
      );

      CREATE TABLE audit_log (
        id TEXT PRIMARY KEY,
        actor_id TEXT REFERENCES users(id) ON DELETE SET NULL,
        action TEXT NOT NULL,
        target_type TEXT NOT NULL,
        target_id TEXT,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        ip_address TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX audit_created_idx ON audit_log(created_at DESC);
      CREATE INDEX audit_actor_idx ON audit_log(actor_id, created_at DESC);
    `,
  },
  {
    version: 2,
    name: "unguessable lesson meeting keys",
    up: (db) => {
      const columns = db.prepare("PRAGMA table_info(lessons)").all() as Array<{ name: string }>;
      if (!columns.some((column) => column.name === "meeting_key")) {
        db.exec("ALTER TABLE lessons ADD COLUMN meeting_key TEXT");
        const lessons = db.prepare("SELECT id FROM lessons").all() as Array<{ id: string }>;
        const update = db.prepare("UPDATE lessons SET meeting_key = ? WHERE id = ?");
        for (const lesson of lessons) update.run(randomToken(24), lesson.id);
      }
      db.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS lessons_meeting_key_unique ON lessons(meeting_key);
        CREATE TRIGGER IF NOT EXISTS lessons_meeting_key_required_insert
        BEFORE INSERT ON lessons WHEN NEW.meeting_key IS NULL OR length(NEW.meeting_key) < 24
        BEGIN SELECT RAISE(ABORT, 'meeting_key is required'); END;
      `);
    },
  },
  {
    version: 3,
    name: "per-student material progress",
    up: (db) => {
      const columns = db.prepare("PRAGMA table_info(material_access)").all() as Array<{ name: string }>;
      if (!columns.some((column) => column.name === "status")) {
        db.exec("ALTER TABLE material_access ADD COLUMN status TEXT NOT NULL DEFAULT 'assigned'");
      }
      if (!columns.some((column) => column.name === "updated_at")) {
        db.exec("ALTER TABLE material_access ADD COLUMN updated_at TEXT NOT NULL DEFAULT ''");
        db.prepare("UPDATE material_access SET updated_at = granted_at WHERE updated_at = ''").run();
      }
      if (!columns.some((column) => column.name === "lesson_id")) {
        db.exec("ALTER TABLE material_access ADD COLUMN lesson_id TEXT");
      }
      db.exec("CREATE INDEX IF NOT EXISTS material_access_progress_idx ON material_access(student_id, status, updated_at DESC)");
    },
  },
  {
    version: 4,
    name: "persistent lesson material plan",
    sql: `
      CREATE TABLE IF NOT EXISTS lesson_materials (
        lesson_id TEXT NOT NULL REFERENCES lessons(id) ON DELETE CASCADE,
        material_id TEXT NOT NULL REFERENCES materials(id) ON DELETE CASCADE,
        position INTEGER NOT NULL DEFAULT 0,
        added_at TEXT NOT NULL,
        PRIMARY KEY (lesson_id, material_id)
      );
      CREATE INDEX IF NOT EXISTS lesson_materials_material_idx ON lesson_materials(material_id);
    `,
  },
  {
    version: 5,
    name: "restore lesson foreign key on legacy material progress",
    up: (db) => {
      const foreignKeys = db.prepare("PRAGMA foreign_key_list(material_access)").all() as Array<{
        table: string;
        from: string;
        to: string;
        on_delete: string;
      }>;
      const hasLessonForeignKey = foreignKeys.some((foreignKey) =>
        foreignKey.table === "lessons" &&
        foreignKey.from === "lesson_id" &&
        foreignKey.to === "id" &&
        foreignKey.on_delete.toUpperCase() === "SET NULL",
      );
      if (hasLessonForeignKey) return;

      db.exec(`
        DROP TABLE IF EXISTS material_access_v5;
        CREATE TABLE material_access_v5 (
          material_id TEXT NOT NULL REFERENCES materials(id) ON DELETE CASCADE,
          student_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          granted_at TEXT NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('assigned', 'covered', 'completed')),
          updated_at TEXT NOT NULL,
          lesson_id TEXT REFERENCES lessons(id) ON DELETE SET NULL,
          PRIMARY KEY (material_id, student_id)
        );
        INSERT INTO material_access_v5 (
          material_id, student_id, granted_at, status, updated_at, lesson_id
        )
        SELECT
          material_id,
          student_id,
          granted_at,
          CASE WHEN status IN ('assigned', 'covered', 'completed') THEN status ELSE 'assigned' END,
          CASE WHEN updated_at IS NULL OR updated_at = '' THEN granted_at ELSE updated_at END,
          CASE WHEN lesson_id IS NULL OR EXISTS (SELECT 1 FROM lessons WHERE id = lesson_id)
            THEN lesson_id ELSE NULL END
        FROM material_access;
        DROP TABLE material_access;
        ALTER TABLE material_access_v5 RENAME TO material_access;
        CREATE INDEX material_access_student_idx ON material_access(student_id);
        CREATE INDEX material_access_progress_idx ON material_access(student_id, status, updated_at DESC);
      `);
    },
  },
  {
    version: 6,
    name: "board v2 durable document and update log foundation",
    sql: `
      CREATE TABLE boards (
        id TEXT PRIMARY KEY,
        lesson_id TEXT NOT NULL UNIQUE REFERENCES lessons(id) ON DELETE CASCADE,
        engine TEXT NOT NULL DEFAULT 'v2' CHECK (engine IN ('legacy', 'v2')),
        lifecycle TEXT NOT NULL DEFAULT 'active' CHECK (lifecycle IN ('active', 'tombstoned')),
        generation INTEGER NOT NULL DEFAULT 1 CHECK (generation >= 1),
        protocol_version INTEGER NOT NULL DEFAULT 1 CHECK (protocol_version >= 1),
        schema_version INTEGER NOT NULL DEFAULT 1 CHECK (schema_version >= 1),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX boards_lesson_idx ON boards(lesson_id);

      CREATE TABLE board_documents (
        board_id TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
        document_key TEXT NOT NULL,
        generation INTEGER NOT NULL CHECK (generation >= 1),
        snapshot_blob BLOB NOT NULL DEFAULT X'',
        state_vector BLOB NOT NULL DEFAULT X'',
        snapshot_seq INTEGER NOT NULL DEFAULT 0 CHECK (snapshot_seq >= 0),
        last_seq INTEGER NOT NULL DEFAULT 0 CHECK (last_seq >= snapshot_seq),
        snapshot_bytes INTEGER NOT NULL DEFAULT 0
          CHECK (snapshot_bytes >= 0 AND snapshot_bytes = length(snapshot_blob)),
        state_vector_bytes INTEGER NOT NULL DEFAULT 0
          CHECK (state_vector_bytes >= 0 AND state_vector_bytes = length(state_vector)),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        compacted_at TEXT,
        PRIMARY KEY (board_id, document_key, generation)
      );
      CREATE INDEX board_documents_board_generation_idx
        ON board_documents(board_id, generation, document_key);

      CREATE TABLE board_updates (
        board_id TEXT NOT NULL,
        document_key TEXT NOT NULL,
        generation INTEGER NOT NULL CHECK (generation >= 1),
        seq INTEGER NOT NULL CHECK (seq >= 1),
        message_id TEXT NOT NULL,
        actor_id TEXT NOT NULL,
        client_id TEXT NOT NULL,
        update_blob BLOB NOT NULL,
        update_bytes INTEGER NOT NULL
          CHECK (update_bytes > 0 AND update_bytes = length(update_blob)),
        created_at TEXT NOT NULL,
        PRIMARY KEY (board_id, document_key, generation, seq),
        UNIQUE (board_id, document_key, generation, message_id),
        FOREIGN KEY (board_id, document_key, generation)
          REFERENCES board_documents(board_id, document_key, generation) ON DELETE CASCADE
      );
      CREATE INDEX board_updates_document_message_idx
        ON board_updates(board_id, document_key, generation, message_id);

      -- Payload rows are removed by compaction. Receipts retain message-id
      -- idempotence for the lifetime of a document without retaining old CRDT
      -- update bytes.
      CREATE TABLE board_update_receipts (
        board_id TEXT NOT NULL,
        document_key TEXT NOT NULL,
        generation INTEGER NOT NULL CHECK (generation >= 1),
        message_id TEXT NOT NULL,
        seq INTEGER NOT NULL CHECK (seq >= 1),
        actor_id TEXT NOT NULL,
        client_id TEXT NOT NULL,
        update_sha256 TEXT NOT NULL CHECK (length(update_sha256) = 64),
        update_bytes INTEGER NOT NULL CHECK (update_bytes > 0),
        created_at TEXT NOT NULL,
        PRIMARY KEY (board_id, document_key, generation, message_id),
        UNIQUE (board_id, document_key, generation, seq),
        FOREIGN KEY (board_id, document_key, generation)
          REFERENCES board_documents(board_id, document_key, generation) ON DELETE CASCADE
      );

      CREATE TABLE board_legacy_imports (
        board_id TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
        generation INTEGER NOT NULL CHECK (generation >= 1),
        source_revision INTEGER NOT NULL CHECK (source_revision >= 0),
        source_json TEXT NOT NULL,
        source_sha256 TEXT NOT NULL CHECK (length(source_sha256) = 64),
        source_bytes INTEGER NOT NULL
          CHECK (source_bytes >= 0 AND source_bytes = length(CAST(source_json AS BLOB))),
        imported_at TEXT NOT NULL,
        PRIMARY KEY (board_id, generation)
      );

      CREATE TRIGGER board_legacy_imports_source_immutable
      BEFORE UPDATE OF source_revision, source_json, source_sha256, source_bytes
      ON board_legacy_imports
      BEGIN
        SELECT RAISE(ABORT, 'board legacy import source is immutable');
      END;
    `,
  },
  {
    version: 7,
    name: "board v2 private content-addressed assets",
    up: installBoardAssetSchema,
  },
  {
    version: 8,
    name: "guest rooms and expiring public resources",
    sql: `
      CREATE TABLE guest_rooms (
        id TEXT PRIMARY KEY,
        share_key TEXT NOT NULL UNIQUE CHECK (length(share_key) = 43),
        owner_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_activity_at TEXT NOT NULL,
        expires_at TEXT NOT NULL
      );
      CREATE INDEX guest_rooms_expiry_idx ON guest_rooms(expires_at);
      CREATE INDEX guest_rooms_owner_idx ON guest_rooms(owner_user_id, created_at DESC);

      CREATE TABLE guest_room_resources (
        id TEXT PRIMARY KEY,
        room_id TEXT NOT NULL REFERENCES guest_rooms(id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK (kind IN ('board', 'code', 'call')),
        ordinal INTEGER NOT NULL DEFAULT 1 CHECK (ordinal >= 1),
        resource_key TEXT NOT NULL UNIQUE CHECK (length(resource_key) = 32),
        created_at TEXT NOT NULL,
        last_activity_at TEXT NOT NULL,
        UNIQUE (room_id, kind, ordinal)
      );
      CREATE INDEX guest_room_resources_room_idx
        ON guest_room_resources(room_id, kind, ordinal);

      -- Only a one-way identifier remains after content deletion so a stale
      -- share link can receive the terminal "session ended" state.
      CREATE TABLE guest_room_tombstones (
        share_key_hash TEXT PRIMARY KEY CHECK (length(share_key_hash) = 64),
        expired_at TEXT NOT NULL,
        purge_at TEXT NOT NULL
      );
      CREATE INDEX guest_room_tombstones_purge_idx
        ON guest_room_tombstones(purge_at);

      CREATE TRIGGER guest_rooms_share_key_immutable
      BEFORE UPDATE OF share_key ON guest_rooms
      BEGIN SELECT RAISE(ABORT, 'guest room share key is immutable'); END;

      CREATE TRIGGER guest_room_resources_identity_immutable
      BEFORE UPDATE OF room_id, kind, ordinal, resource_key
      ON guest_room_resources
      BEGIN SELECT RAISE(ABORT, 'guest room resource identity is immutable'); END;
    `,
  },
  {
    version: 9,
    name: "boards can belong to lessons or room resources",
    foreignKeysOff: true,
    up: (db) => {
      db.exec(`
        CREATE TABLE boards_v9 (
          id TEXT PRIMARY KEY,
          lesson_id TEXT UNIQUE REFERENCES lessons(id) ON DELETE CASCADE,
          room_resource_id TEXT UNIQUE
            REFERENCES guest_room_resources(id) ON DELETE CASCADE,
          engine TEXT NOT NULL DEFAULT 'v2' CHECK (engine IN ('legacy', 'v2')),
          lifecycle TEXT NOT NULL DEFAULT 'active'
            CHECK (lifecycle IN ('active', 'tombstoned')),
          generation INTEGER NOT NULL DEFAULT 1 CHECK (generation >= 1),
          protocol_version INTEGER NOT NULL DEFAULT 1
            CHECK (protocol_version >= 1),
          schema_version INTEGER NOT NULL DEFAULT 1 CHECK (schema_version >= 1),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          CHECK ((lesson_id IS NOT NULL) != (room_resource_id IS NOT NULL))
        );
        INSERT INTO boards_v9 (
          id, lesson_id, room_resource_id, engine, lifecycle, generation,
          protocol_version, schema_version, created_at, updated_at
        )
        SELECT
          id, lesson_id, NULL, engine, lifecycle, generation,
          protocol_version, schema_version, created_at, updated_at
        FROM boards;
        DROP TABLE boards;
        ALTER TABLE boards_v9 RENAME TO boards;
        CREATE INDEX boards_lesson_idx ON boards(lesson_id);
        CREATE INDEX boards_room_resource_idx ON boards(room_resource_id);
      `);
    },
  },
  {
    version: 10,
    name: "guest code workspace CRDT sync",
    up: installCodeSyncBaseSchema,
  },
  {
    version: 11,
    name: "guest code content-addressed blobs",
    up: installCodeBlobSchema,
  },
  {
    version: 12,
    name: "guest room promotion initialization leases",
    sql: `
      ALTER TABLE guest_rooms ADD COLUMN initialization_token_hash TEXT
        CHECK (
          initialization_token_hash IS NULL
          OR length(initialization_token_hash) = 64
        );
      ALTER TABLE guest_rooms ADD COLUMN initialization_expires_at TEXT;
      ALTER TABLE guest_rooms ADD COLUMN initialized_at TEXT;

      CREATE INDEX guest_rooms_initialization_expiry_idx
        ON guest_rooms(initialization_expires_at)
        WHERE initialized_at IS NULL;

      CREATE TRIGGER guest_rooms_initialization_identity_immutable
      BEFORE UPDATE OF initialization_token_hash, initialization_expires_at
      ON guest_rooms
      BEGIN
        SELECT RAISE(ABORT, 'guest room initialization identity is immutable');
      END;

      CREATE TRIGGER guest_rooms_initialized_once
      BEFORE UPDATE OF initialized_at ON guest_rooms
      WHEN NEW.initialized_at IS NULL OR OLD.initialized_at IS NOT NULL
      BEGIN
        SELECT RAISE(ABORT, 'guest room initialization can only be finalized once');
      END;
    `,
  },
  {
    version: 13,
    name: "guest code workspace bounded compaction",
    up: installCodeSyncCompactionSchema,
  },
  {
    version: 14,
    name: "guest code blob malware scan attestations",
    up: installCodeBlobScanSchema,
  },
  {
    version: 15,
    name: "board asset durable garbage collection",
    up: installBoardAssetGarbageCollectionSchema,
  },
  {
    version: 16,
    name: "asset upload crash recovery",
    up: installBoardAssetUploadRecoverySchema,
  },
  {
    version: 17,
    name: "material file quarantine, scan attestations, and durable cleanup",
    sql: `
      ALTER TABLE materials ADD COLUMN file_sha256 TEXT;
      ALTER TABLE materials ADD COLUMN scan_provider TEXT;
      ALTER TABLE materials ADD COLUMN scanned_at TEXT;

      CREATE TRIGGER materials_scan_attestation_insert
      BEFORE INSERT ON materials
      WHEN NOT (
        (
          NEW.file_sha256 IS NULL
          AND NEW.scan_provider IS NULL
          AND NEW.scanned_at IS NULL
        )
        OR (
          NEW.kind = 'file'
          AND NEW.file_sha256 IS NOT NULL
          AND NEW.scan_provider IS NOT NULL
          AND NEW.scanned_at IS NOT NULL
          AND length(NEW.file_sha256) = 64
          AND NEW.file_sha256 NOT GLOB '*[^0-9a-f]*'
          AND length(NEW.scan_provider) BETWEEN 1 AND 255
          AND length(NEW.scanned_at) BETWEEN 20 AND 40
        )
      )
      BEGIN
        SELECT RAISE(ABORT, 'material file scan attestation is invalid');
      END;

      CREATE TRIGGER materials_scan_attestation_update
      BEFORE UPDATE OF kind, file_sha256, scan_provider, scanned_at ON materials
      WHEN NOT (
        (
          NEW.file_sha256 IS NULL
          AND NEW.scan_provider IS NULL
          AND NEW.scanned_at IS NULL
        )
        OR (
          NEW.kind = 'file'
          AND NEW.file_sha256 IS NOT NULL
          AND NEW.scan_provider IS NOT NULL
          AND NEW.scanned_at IS NOT NULL
          AND length(NEW.file_sha256) = 64
          AND NEW.file_sha256 NOT GLOB '*[^0-9a-f]*'
          AND length(NEW.scan_provider) BETWEEN 1 AND 255
          AND length(NEW.scanned_at) BETWEEN 20 AND 40
        )
      )
      BEGIN
        SELECT RAISE(ABORT, 'material file scan attestation is invalid');
      END;

      CREATE TABLE material_upload_reservations (
        upload_id TEXT PRIMARY KEY,
        tutor_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        reserved_bytes INTEGER NOT NULL CHECK (reserved_bytes BETWEEN 1 AND 26214400),
        quarantine_key TEXT NOT NULL UNIQUE,
        final_key TEXT UNIQUE,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL
      );
      CREATE INDEX material_upload_reservations_tutor_idx
        ON material_upload_reservations(tutor_id, created_at);
      CREATE INDEX material_upload_reservations_expiry_idx
        ON material_upload_reservations(expires_at);

      CREATE TABLE material_upload_rate_events (
        upload_id TEXT PRIMARY KEY,
        tutor_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        byte_size INTEGER NOT NULL CHECK (byte_size BETWEEN 1 AND 26214400),
        created_at TEXT NOT NULL
      );
      CREATE INDEX material_upload_rate_events_tutor_idx
        ON material_upload_rate_events(tutor_id, created_at);
      CREATE INDEX material_upload_rate_events_created_idx
        ON material_upload_rate_events(created_at);

      CREATE TABLE material_file_gc_queue (
        storage_key TEXT PRIMARY KEY,
        enqueued_at TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
        last_error TEXT
      );
      CREATE INDEX material_file_gc_queue_retry_idx
        ON material_file_gc_queue(attempts, enqueued_at);
    `,
  },
  {
    version: 18,
    name: "durable composite authentication rate limits",
    up: installAuthRateLimitSchema,
  },
  {
    version: 19,
    name: "board durable storage usage accounting",
    up: installBoardStorageUsageSchema,
  },
  {
    version: 20,
    name: "guest code durable storage usage accounting",
    up: installCodeStorageUsageSchema,
  },
  {
    version: 21,
    name: "durable LiveKit room revocation outbox",
    sql: `
      ALTER TABLE guest_room_resources
        ADD COLUMN call_room_generation INTEGER NOT NULL DEFAULT 1
          CHECK (call_room_generation >= 1);

      CREATE TABLE livekit_room_revocation_outbox (
        room_name TEXT PRIMARY KEY CHECK (length(room_name) BETWEEN 1 AND 255),
        generation INTEGER NOT NULL DEFAULT 1 CHECK (generation >= 1),
        enqueued_at TEXT NOT NULL,
        next_attempt_at TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 30),
        last_error_code TEXT
          CHECK (
            last_error_code IS NULL
            OR last_error_code IN ('room_delete_failed')
          )
      );
      CREATE INDEX livekit_room_revocation_retry_idx
        ON livekit_room_revocation_outbox(next_attempt_at, enqueued_at, room_name);
    `,
  },
];

export function openDatabase(config: AppConfig): Database.Database {
  fs.mkdirSync(path.dirname(config.databasePath), { recursive: true });
  fs.mkdirSync(config.uploadDir, { recursive: true });
  const db = new Database(config.databasePath);
  db.pragma("foreign_keys = ON");
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  db.pragma("synchronous = NORMAL");
  migrate(db);
  return db;
}

function foreignKeysEnabled(db: Database.Database): boolean {
  return db.pragma("foreign_keys", { simple: true }) === 1;
}

function setForeignKeys(
  db: Database.Database,
  enabled: boolean,
): void {
  db.pragma(`foreign_keys = ${enabled ? "ON" : "OFF"}`);
  if (foreignKeysEnabled(db) !== enabled) {
    throw new Error(
      `could not ${enabled ? "enable" : "disable"} SQLite foreign keys`,
    );
  }
}

export function migrate(
  db: Database.Database,
  options: MigrateOptions = {},
): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    )
  `);
  const latestVersion = migrations.at(-1)?.version ?? 0;
  const targetVersion = options.targetVersion ?? latestVersion;
  if (
    !Number.isSafeInteger(targetVersion)
    || targetVersion < 0
    || targetVersion > latestVersion
  ) {
    throw new Error(
      `target migration version must be between 0 and ${latestVersion}`,
    );
  }
  const appliedRows = db.prepare(
    "SELECT version FROM schema_migrations ORDER BY version",
  ).all() as Array<{ version: number }>;
  const newerApplied = appliedRows.find((row) => row.version > targetVersion);
  if (newerApplied) {
    throw new Error(
      `database is already at migration ${newerApplied.version}; migrations cannot run backwards to ${targetVersion}`,
    );
  }
  const applied = new Set(appliedRows.map((row) => row.version));
  const apply = db.transaction((migration: Migration) => {
    if (migration.sql) db.exec(migration.sql);
    migration.up?.(db);
    if (migration.foreignKeysOff) {
      const violations = db.pragma("foreign_key_check") as unknown[];
      if (violations.length > 0) {
        throw new Error(
          `migration ${migration.version} violated foreign keys`,
        );
      }
    }
    db.prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)")
      .run(migration.version, migration.name, nowIso());
  });
  for (const migration of migrations) {
    if (migration.version > targetVersion || applied.has(migration.version)) {
      continue;
    }
    if (!migration.foreignKeysOff) {
      apply.immediate(migration);
      continue;
    }
    if (db.inTransaction) {
      throw new Error(
        `migration ${migration.version} must disable foreign keys outside a transaction`,
      );
    }
    const restoreForeignKeys = foreignKeysEnabled(db);
    setForeignKeys(db, false);
    let migrationError: unknown;
    try {
      apply.immediate(migration);
    } catch (error) {
      migrationError = error;
    }
    try {
      setForeignKeys(db, restoreForeignKeys);
    } catch (restoreError) {
      if (migrationError !== undefined) {
        throw new AggregateError(
          [migrationError, restoreError],
          `migration ${migration.version} failed and SQLite foreign-key mode could not be restored`,
        );
      }
      throw restoreError;
    }
    if (migrationError !== undefined) throw migrationError;
  }
}

export function bootstrapAdmin(context: AppContext): StoredUserRow | null {
  const existing = context.db.prepare("SELECT * FROM users WHERE role = 'admin' ORDER BY created_at LIMIT 1")
    .get() as StoredUserRow | undefined;
  if (existing) return existing;
  if (!context.config.adminPassword) return null;

  const now = nowIso();
  const id = newId();
  const login = context.config.adminLogin.trim();
  context.db.prepare(`
    INSERT INTO users (
      id, role, status, display_name, login_name, login_name_normalized,
      password_hash, created_at, updated_at
    ) VALUES (?, 'admin', 'active', ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    "Администратор",
    login,
    normalizeLogin(login),
    hashPassword(context.config.adminPassword, context.config.bcryptRounds),
    now,
    now,
  );
  return context.db.prepare("SELECT * FROM users WHERE id = ?").get(id) as StoredUserRow;
}

export function cleanupExpiredSecurityRecords(context: AppContext): void {
  const now = nowIso();
  context.db.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(now);
  context.db.prepare("DELETE FROM invites WHERE expires_at <= ? AND consumed_at IS NOT NULL").run(now);
  context.db.prepare("DELETE FROM auth_rate_limit_buckets WHERE expires_at <= ?")
    .run(Date.now());
}

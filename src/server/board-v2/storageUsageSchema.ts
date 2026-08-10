import type Database from "better-sqlite3";

/**
 * These reserves deliberately exceed the ordinary SQLite row and index-key
 * footprint. They turn tiny-update amplification into bounded quota usage
 * without pretending that payload length is the complete durable cost.
 */
export const BOARD_BASE_METADATA_RESERVE_BYTES = 1_024;
export const BOARD_DOCUMENT_METADATA_RESERVE_BYTES = 1_024;
export const BOARD_UPDATE_METADATA_RESERVE_BYTES = 2_048;
export const BOARD_RECEIPT_METADATA_RESERVE_BYTES = 2_048;
export const BOARD_LEGACY_IMPORT_METADATA_RESERVE_BYTES = 1_024;
export const BOARD_RECEIPT_SCALAR_BYTES = 3 * 8;

export interface BoardReceiptStorageIdentity {
  readonly boardId: string;
  readonly documentKey: string;
  readonly messageId: string;
  readonly actorId: string;
  readonly clientId: string;
  readonly updateSha256: string;
  readonly createdAt: string;
}

export function boardReceiptLogicalBytes(
  receipt: BoardReceiptStorageIdentity,
): number {
  return BOARD_RECEIPT_SCALAR_BYTES + Buffer.byteLength(
    receipt.boardId
      + receipt.documentKey
      + receipt.messageId
      + receipt.actorId
      + receipt.clientId
      + receipt.updateSha256
      + receipt.createdAt,
    "utf8",
  );
}

const receiptBytes = (prefix: "NEW" | "OLD"): string => `(
  length(CAST(${prefix}.board_id AS BLOB))
  + length(CAST(${prefix}.document_key AS BLOB))
  + length(CAST(${prefix}.message_id AS BLOB))
  + length(CAST(${prefix}.actor_id AS BLOB))
  + length(CAST(${prefix}.client_id AS BLOB))
  + length(CAST(${prefix}.update_sha256 AS BLOB))
  + length(CAST(${prefix}.created_at AS BLOB))
  + ${BOARD_RECEIPT_SCALAR_BYTES}
)`;

/**
 * Migration-v19 installer. The one-time aggregate scans reconcile every
 * existing generation before triggers take over transactional maintenance.
 */
export function installBoardStorageUsageSchema(db: Database.Database): void {
  const receiptNewBytes = receiptBytes("NEW");
  const receiptOldBytes = receiptBytes("OLD");
  db.exec(`
    CREATE TABLE board_storage_usage (
      board_id TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
      generation INTEGER NOT NULL CHECK (generation >= 1),
      is_guest INTEGER NOT NULL CHECK (is_guest IN (0, 1)),
      document_count INTEGER NOT NULL CHECK (document_count >= 0),
      snapshot_bytes INTEGER NOT NULL CHECK (snapshot_bytes >= 0),
      state_vector_bytes INTEGER NOT NULL CHECK (state_vector_bytes >= 0),
      update_count INTEGER NOT NULL CHECK (update_count >= 0),
      update_bytes INTEGER NOT NULL CHECK (update_bytes >= 0),
      receipt_count INTEGER NOT NULL CHECK (receipt_count >= 0),
      receipt_bytes INTEGER NOT NULL CHECK (receipt_bytes >= 0),
      legacy_source_bytes INTEGER NOT NULL CHECK (legacy_source_bytes >= 0),
      metadata_bytes INTEGER NOT NULL CHECK (metadata_bytes >= 0),
      accounted_bytes INTEGER NOT NULL CHECK (
        accounted_bytes = snapshot_bytes + state_vector_bytes + update_bytes
          + receipt_bytes + legacy_source_bytes + metadata_bytes
      ),
      PRIMARY KEY (board_id, generation)
    );
    CREATE INDEX board_storage_usage_guest_idx
      ON board_storage_usage(is_guest, accounted_bytes);

    CREATE TABLE board_guest_storage_usage (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      generation_count INTEGER NOT NULL CHECK (generation_count >= 0),
      document_count INTEGER NOT NULL CHECK (document_count >= 0),
      snapshot_bytes INTEGER NOT NULL CHECK (snapshot_bytes >= 0),
      state_vector_bytes INTEGER NOT NULL CHECK (state_vector_bytes >= 0),
      update_count INTEGER NOT NULL CHECK (update_count >= 0),
      update_bytes INTEGER NOT NULL CHECK (update_bytes >= 0),
      receipt_count INTEGER NOT NULL CHECK (receipt_count >= 0),
      receipt_bytes INTEGER NOT NULL CHECK (receipt_bytes >= 0),
      legacy_source_bytes INTEGER NOT NULL CHECK (legacy_source_bytes >= 0),
      metadata_bytes INTEGER NOT NULL CHECK (metadata_bytes >= 0),
      accounted_bytes INTEGER NOT NULL CHECK (
        accounted_bytes = snapshot_bytes + state_vector_bytes + update_bytes
          + receipt_bytes + legacy_source_bytes + metadata_bytes
      )
    );
    INSERT INTO board_guest_storage_usage (
      singleton, generation_count, document_count, snapshot_bytes,
      state_vector_bytes, update_count, update_bytes, receipt_count,
      receipt_bytes, legacy_source_bytes, metadata_bytes, accounted_bytes
    ) VALUES (1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0);

    WITH generations(board_id, generation) AS (
      SELECT id, generation FROM boards
      UNION SELECT board_id, generation FROM board_documents
      UNION SELECT board_id, generation FROM board_updates
      UNION SELECT board_id, generation FROM board_update_receipts
      UNION SELECT board_id, generation FROM board_legacy_imports
    ),
    document_usage AS (
      SELECT
        board_id,
        generation,
        COUNT(*) AS row_count,
        COALESCE(SUM(snapshot_bytes), 0) AS snapshot_bytes,
        COALESCE(SUM(state_vector_bytes), 0) AS state_vector_bytes
      FROM board_documents
      GROUP BY board_id, generation
    ),
    update_usage AS (
      SELECT
        board_id,
        generation,
        COUNT(*) AS row_count,
        COALESCE(SUM(update_bytes), 0) AS update_bytes
      FROM board_updates
      GROUP BY board_id, generation
    ),
    receipt_usage AS (
      SELECT
        board_id,
        generation,
        COUNT(*) AS row_count,
        COALESCE(SUM(
          length(CAST(board_id AS BLOB))
          + length(CAST(document_key AS BLOB))
          + length(CAST(message_id AS BLOB))
          + length(CAST(actor_id AS BLOB))
          + length(CAST(client_id AS BLOB))
          + length(CAST(update_sha256 AS BLOB))
          + length(CAST(created_at AS BLOB))
          + ${BOARD_RECEIPT_SCALAR_BYTES}
        ), 0) AS receipt_bytes
      FROM board_update_receipts
      GROUP BY board_id, generation
    ),
    legacy_usage AS (
      SELECT
        board_id,
        generation,
        COUNT(*) AS row_count,
        COALESCE(SUM(source_bytes), 0) AS source_bytes
      FROM board_legacy_imports
      GROUP BY board_id, generation
    ),
    reconciled AS (
      SELECT
        generation_row.board_id,
        generation_row.generation,
        CASE WHEN board.room_resource_id IS NULL THEN 0 ELSE 1 END AS is_guest,
        COALESCE(document_usage.row_count, 0) AS document_count,
        COALESCE(document_usage.snapshot_bytes, 0) AS snapshot_bytes,
        COALESCE(document_usage.state_vector_bytes, 0) AS state_vector_bytes,
        COALESCE(update_usage.row_count, 0) AS update_count,
        COALESCE(update_usage.update_bytes, 0) AS update_bytes,
        COALESCE(receipt_usage.row_count, 0) AS receipt_count,
        COALESCE(receipt_usage.receipt_bytes, 0) AS receipt_bytes,
        COALESCE(legacy_usage.source_bytes, 0) AS legacy_source_bytes,
        ${BOARD_BASE_METADATA_RESERVE_BYTES}
          + COALESCE(document_usage.row_count, 0)
            * ${BOARD_DOCUMENT_METADATA_RESERVE_BYTES}
          + COALESCE(update_usage.row_count, 0)
            * ${BOARD_UPDATE_METADATA_RESERVE_BYTES}
          + COALESCE(receipt_usage.row_count, 0)
            * ${BOARD_RECEIPT_METADATA_RESERVE_BYTES}
          + COALESCE(legacy_usage.row_count, 0)
            * ${BOARD_LEGACY_IMPORT_METADATA_RESERVE_BYTES} AS metadata_bytes
      FROM generations generation_row
      JOIN boards board ON board.id = generation_row.board_id
      LEFT JOIN document_usage
        ON document_usage.board_id = generation_row.board_id
        AND document_usage.generation = generation_row.generation
      LEFT JOIN update_usage
        ON update_usage.board_id = generation_row.board_id
        AND update_usage.generation = generation_row.generation
      LEFT JOIN receipt_usage
        ON receipt_usage.board_id = generation_row.board_id
        AND receipt_usage.generation = generation_row.generation
      LEFT JOIN legacy_usage
        ON legacy_usage.board_id = generation_row.board_id
        AND legacy_usage.generation = generation_row.generation
    )
    INSERT INTO board_storage_usage (
      board_id, generation, is_guest, document_count, snapshot_bytes,
      state_vector_bytes, update_count, update_bytes, receipt_count,
      receipt_bytes, legacy_source_bytes, metadata_bytes, accounted_bytes
    )
    SELECT
      board_id, generation, is_guest, document_count, snapshot_bytes,
      state_vector_bytes, update_count, update_bytes, receipt_count,
      receipt_bytes, legacy_source_bytes, metadata_bytes,
      snapshot_bytes + state_vector_bytes + update_bytes + receipt_bytes
        + legacy_source_bytes + metadata_bytes
    FROM reconciled;

    UPDATE board_guest_storage_usage
    SET
      generation_count = (
        SELECT COUNT(*) FROM board_storage_usage WHERE is_guest = 1
      ),
      document_count = COALESCE((
        SELECT SUM(document_count) FROM board_storage_usage WHERE is_guest = 1
      ), 0),
      snapshot_bytes = COALESCE((
        SELECT SUM(snapshot_bytes) FROM board_storage_usage WHERE is_guest = 1
      ), 0),
      state_vector_bytes = COALESCE((
        SELECT SUM(state_vector_bytes) FROM board_storage_usage WHERE is_guest = 1
      ), 0),
      update_count = COALESCE((
        SELECT SUM(update_count) FROM board_storage_usage WHERE is_guest = 1
      ), 0),
      update_bytes = COALESCE((
        SELECT SUM(update_bytes) FROM board_storage_usage WHERE is_guest = 1
      ), 0),
      receipt_count = COALESCE((
        SELECT SUM(receipt_count) FROM board_storage_usage WHERE is_guest = 1
      ), 0),
      receipt_bytes = COALESCE((
        SELECT SUM(receipt_bytes) FROM board_storage_usage WHERE is_guest = 1
      ), 0),
      legacy_source_bytes = COALESCE((
        SELECT SUM(legacy_source_bytes) FROM board_storage_usage WHERE is_guest = 1
      ), 0),
      metadata_bytes = COALESCE((
        SELECT SUM(metadata_bytes) FROM board_storage_usage WHERE is_guest = 1
      ), 0),
      accounted_bytes = COALESCE((
        SELECT SUM(accounted_bytes) FROM board_storage_usage WHERE is_guest = 1
      ), 0)
    WHERE singleton = 1;

    CREATE TRIGGER board_storage_usage_guest_insert
    AFTER INSERT ON board_storage_usage
    WHEN NEW.is_guest = 1
    BEGIN
      UPDATE board_guest_storage_usage SET
        generation_count = generation_count + 1,
        document_count = document_count + NEW.document_count,
        snapshot_bytes = snapshot_bytes + NEW.snapshot_bytes,
        state_vector_bytes = state_vector_bytes + NEW.state_vector_bytes,
        update_count = update_count + NEW.update_count,
        update_bytes = update_bytes + NEW.update_bytes,
        receipt_count = receipt_count + NEW.receipt_count,
        receipt_bytes = receipt_bytes + NEW.receipt_bytes,
        legacy_source_bytes = legacy_source_bytes + NEW.legacy_source_bytes,
        metadata_bytes = metadata_bytes + NEW.metadata_bytes,
        accounted_bytes = accounted_bytes + NEW.accounted_bytes
      WHERE singleton = 1;
    END;

    CREATE TRIGGER board_storage_usage_guest_update
    AFTER UPDATE OF
      is_guest, document_count, snapshot_bytes, state_vector_bytes,
      update_count, update_bytes, receipt_count, receipt_bytes,
      legacy_source_bytes, metadata_bytes, accounted_bytes
    ON board_storage_usage
    BEGIN
      UPDATE board_guest_storage_usage SET
        generation_count = generation_count
          + CASE WHEN NEW.is_guest = 1 THEN 1 ELSE 0 END
          - CASE WHEN OLD.is_guest = 1 THEN 1 ELSE 0 END,
        document_count = document_count
          + CASE WHEN NEW.is_guest = 1 THEN NEW.document_count ELSE 0 END
          - CASE WHEN OLD.is_guest = 1 THEN OLD.document_count ELSE 0 END,
        snapshot_bytes = snapshot_bytes
          + CASE WHEN NEW.is_guest = 1 THEN NEW.snapshot_bytes ELSE 0 END
          - CASE WHEN OLD.is_guest = 1 THEN OLD.snapshot_bytes ELSE 0 END,
        state_vector_bytes = state_vector_bytes
          + CASE WHEN NEW.is_guest = 1 THEN NEW.state_vector_bytes ELSE 0 END
          - CASE WHEN OLD.is_guest = 1 THEN OLD.state_vector_bytes ELSE 0 END,
        update_count = update_count
          + CASE WHEN NEW.is_guest = 1 THEN NEW.update_count ELSE 0 END
          - CASE WHEN OLD.is_guest = 1 THEN OLD.update_count ELSE 0 END,
        update_bytes = update_bytes
          + CASE WHEN NEW.is_guest = 1 THEN NEW.update_bytes ELSE 0 END
          - CASE WHEN OLD.is_guest = 1 THEN OLD.update_bytes ELSE 0 END,
        receipt_count = receipt_count
          + CASE WHEN NEW.is_guest = 1 THEN NEW.receipt_count ELSE 0 END
          - CASE WHEN OLD.is_guest = 1 THEN OLD.receipt_count ELSE 0 END,
        receipt_bytes = receipt_bytes
          + CASE WHEN NEW.is_guest = 1 THEN NEW.receipt_bytes ELSE 0 END
          - CASE WHEN OLD.is_guest = 1 THEN OLD.receipt_bytes ELSE 0 END,
        legacy_source_bytes = legacy_source_bytes
          + CASE WHEN NEW.is_guest = 1 THEN NEW.legacy_source_bytes ELSE 0 END
          - CASE WHEN OLD.is_guest = 1 THEN OLD.legacy_source_bytes ELSE 0 END,
        metadata_bytes = metadata_bytes
          + CASE WHEN NEW.is_guest = 1 THEN NEW.metadata_bytes ELSE 0 END
          - CASE WHEN OLD.is_guest = 1 THEN OLD.metadata_bytes ELSE 0 END,
        accounted_bytes = accounted_bytes
          + CASE WHEN NEW.is_guest = 1 THEN NEW.accounted_bytes ELSE 0 END
          - CASE WHEN OLD.is_guest = 1 THEN OLD.accounted_bytes ELSE 0 END
      WHERE singleton = 1;
    END;

    CREATE TRIGGER board_storage_usage_guest_delete
    AFTER DELETE ON board_storage_usage
    WHEN OLD.is_guest = 1
    BEGIN
      UPDATE board_guest_storage_usage SET
        generation_count = generation_count - 1,
        document_count = document_count - OLD.document_count,
        snapshot_bytes = snapshot_bytes - OLD.snapshot_bytes,
        state_vector_bytes = state_vector_bytes - OLD.state_vector_bytes,
        update_count = update_count - OLD.update_count,
        update_bytes = update_bytes - OLD.update_bytes,
        receipt_count = receipt_count - OLD.receipt_count,
        receipt_bytes = receipt_bytes - OLD.receipt_bytes,
        legacy_source_bytes = legacy_source_bytes - OLD.legacy_source_bytes,
        metadata_bytes = metadata_bytes - OLD.metadata_bytes,
        accounted_bytes = accounted_bytes - OLD.accounted_bytes
      WHERE singleton = 1;
    END;

    CREATE TRIGGER boards_storage_usage_insert
    AFTER INSERT ON boards
    BEGIN
      INSERT INTO board_storage_usage (
        board_id, generation, is_guest, document_count, snapshot_bytes,
        state_vector_bytes, update_count, update_bytes, receipt_count,
        receipt_bytes, legacy_source_bytes, metadata_bytes, accounted_bytes
      ) VALUES (
        NEW.id, NEW.generation,
        CASE WHEN NEW.room_resource_id IS NULL THEN 0 ELSE 1 END,
        0, 0, 0, 0, 0, 0, 0, 0,
        ${BOARD_BASE_METADATA_RESERVE_BYTES},
        ${BOARD_BASE_METADATA_RESERVE_BYTES}
      ) ON CONFLICT(board_id, generation) DO NOTHING;
    END;

    CREATE TRIGGER boards_storage_usage_generation_update
    AFTER UPDATE OF generation, room_resource_id ON boards
    BEGIN
      INSERT INTO board_storage_usage (
        board_id, generation, is_guest, document_count, snapshot_bytes,
        state_vector_bytes, update_count, update_bytes, receipt_count,
        receipt_bytes, legacy_source_bytes, metadata_bytes, accounted_bytes
      ) VALUES (
        NEW.id, NEW.generation,
        CASE WHEN NEW.room_resource_id IS NULL THEN 0 ELSE 1 END,
        0, 0, 0, 0, 0, 0, 0, 0,
        ${BOARD_BASE_METADATA_RESERVE_BYTES},
        ${BOARD_BASE_METADATA_RESERVE_BYTES}
      ) ON CONFLICT(board_id, generation) DO UPDATE SET
        is_guest = excluded.is_guest;
      UPDATE board_storage_usage
      SET is_guest = CASE WHEN NEW.room_resource_id IS NULL THEN 0 ELSE 1 END
      WHERE board_id = NEW.id;
    END;

    CREATE TRIGGER board_documents_storage_identity_immutable
    BEFORE UPDATE OF board_id, document_key, generation ON board_documents
    BEGIN SELECT RAISE(ABORT, 'board document identity is immutable'); END;

    CREATE TRIGGER board_documents_storage_insert
    AFTER INSERT ON board_documents
    BEGIN
      UPDATE board_storage_usage SET
        document_count = document_count + 1,
        snapshot_bytes = snapshot_bytes + NEW.snapshot_bytes,
        state_vector_bytes = state_vector_bytes + NEW.state_vector_bytes,
        metadata_bytes = metadata_bytes
          + ${BOARD_DOCUMENT_METADATA_RESERVE_BYTES},
        accounted_bytes = accounted_bytes + NEW.snapshot_bytes
          + NEW.state_vector_bytes + ${BOARD_DOCUMENT_METADATA_RESERVE_BYTES}
      WHERE board_id = NEW.board_id AND generation = NEW.generation;
    END;

    CREATE TRIGGER board_documents_storage_update
    AFTER UPDATE OF snapshot_bytes, state_vector_bytes ON board_documents
    BEGIN
      UPDATE board_storage_usage SET
        snapshot_bytes = snapshot_bytes + NEW.snapshot_bytes - OLD.snapshot_bytes,
        state_vector_bytes = state_vector_bytes
          + NEW.state_vector_bytes - OLD.state_vector_bytes,
        accounted_bytes = accounted_bytes
          + NEW.snapshot_bytes - OLD.snapshot_bytes
          + NEW.state_vector_bytes - OLD.state_vector_bytes
      WHERE board_id = NEW.board_id AND generation = NEW.generation;
    END;

    CREATE TRIGGER board_documents_storage_delete
    AFTER DELETE ON board_documents
    BEGIN
      UPDATE board_storage_usage SET
        document_count = document_count - 1,
        snapshot_bytes = snapshot_bytes - OLD.snapshot_bytes,
        state_vector_bytes = state_vector_bytes - OLD.state_vector_bytes,
        metadata_bytes = metadata_bytes
          - ${BOARD_DOCUMENT_METADATA_RESERVE_BYTES},
        accounted_bytes = accounted_bytes - OLD.snapshot_bytes
          - OLD.state_vector_bytes - ${BOARD_DOCUMENT_METADATA_RESERVE_BYTES}
      WHERE board_id = OLD.board_id AND generation = OLD.generation;
    END;

    CREATE TRIGGER board_updates_storage_immutable
    BEFORE UPDATE ON board_updates
    BEGIN SELECT RAISE(ABORT, 'board update row is immutable'); END;

    CREATE TRIGGER board_updates_storage_insert
    AFTER INSERT ON board_updates
    BEGIN
      UPDATE board_storage_usage SET
        update_count = update_count + 1,
        update_bytes = update_bytes + NEW.update_bytes,
        metadata_bytes = metadata_bytes + ${BOARD_UPDATE_METADATA_RESERVE_BYTES},
        accounted_bytes = accounted_bytes + NEW.update_bytes
          + ${BOARD_UPDATE_METADATA_RESERVE_BYTES}
      WHERE board_id = NEW.board_id AND generation = NEW.generation;
    END;

    CREATE TRIGGER board_updates_storage_delete
    AFTER DELETE ON board_updates
    BEGIN
      UPDATE board_storage_usage SET
        update_count = update_count - 1,
        update_bytes = update_bytes - OLD.update_bytes,
        metadata_bytes = metadata_bytes - ${BOARD_UPDATE_METADATA_RESERVE_BYTES},
        accounted_bytes = accounted_bytes - OLD.update_bytes
          - ${BOARD_UPDATE_METADATA_RESERVE_BYTES}
      WHERE board_id = OLD.board_id AND generation = OLD.generation;
    END;

    CREATE TRIGGER board_update_receipts_storage_immutable
    BEFORE UPDATE ON board_update_receipts
    BEGIN SELECT RAISE(ABORT, 'board update receipt is immutable'); END;

    CREATE TRIGGER board_update_receipts_storage_insert
    AFTER INSERT ON board_update_receipts
    BEGIN
      UPDATE board_storage_usage SET
        receipt_count = receipt_count + 1,
        receipt_bytes = receipt_bytes + ${receiptNewBytes},
        metadata_bytes = metadata_bytes
          + ${BOARD_RECEIPT_METADATA_RESERVE_BYTES},
        accounted_bytes = accounted_bytes + ${receiptNewBytes}
          + ${BOARD_RECEIPT_METADATA_RESERVE_BYTES}
      WHERE board_id = NEW.board_id AND generation = NEW.generation;
    END;

    CREATE TRIGGER board_update_receipts_storage_delete
    AFTER DELETE ON board_update_receipts
    BEGIN
      UPDATE board_storage_usage SET
        receipt_count = receipt_count - 1,
        receipt_bytes = receipt_bytes - ${receiptOldBytes},
        metadata_bytes = metadata_bytes
          - ${BOARD_RECEIPT_METADATA_RESERVE_BYTES},
        accounted_bytes = accounted_bytes - ${receiptOldBytes}
          - ${BOARD_RECEIPT_METADATA_RESERVE_BYTES}
      WHERE board_id = OLD.board_id AND generation = OLD.generation;
    END;

    CREATE TRIGGER board_legacy_imports_storage_identity_immutable
    BEFORE UPDATE OF board_id, generation ON board_legacy_imports
    BEGIN SELECT RAISE(ABORT, 'board legacy import identity is immutable'); END;

    CREATE TRIGGER board_legacy_imports_storage_insert
    AFTER INSERT ON board_legacy_imports
    BEGIN
      UPDATE board_storage_usage SET
        legacy_source_bytes = legacy_source_bytes + NEW.source_bytes,
        metadata_bytes = metadata_bytes
          + ${BOARD_LEGACY_IMPORT_METADATA_RESERVE_BYTES},
        accounted_bytes = accounted_bytes + NEW.source_bytes
          + ${BOARD_LEGACY_IMPORT_METADATA_RESERVE_BYTES}
      WHERE board_id = NEW.board_id AND generation = NEW.generation;
    END;

    CREATE TRIGGER board_legacy_imports_storage_delete
    AFTER DELETE ON board_legacy_imports
    BEGIN
      UPDATE board_storage_usage SET
        legacy_source_bytes = legacy_source_bytes - OLD.source_bytes,
        metadata_bytes = metadata_bytes
          - ${BOARD_LEGACY_IMPORT_METADATA_RESERVE_BYTES},
        accounted_bytes = accounted_bytes - OLD.source_bytes
          - ${BOARD_LEGACY_IMPORT_METADATA_RESERVE_BYTES}
      WHERE board_id = OLD.board_id AND generation = OLD.generation;
    END;
  `);

  const mismatch = db.prepare(`
    SELECT board_id, generation
    FROM board_storage_usage
    WHERE accounted_bytes != snapshot_bytes + state_vector_bytes + update_bytes
      + receipt_bytes + legacy_source_bytes + metadata_bytes
    LIMIT 1
  `).get();
  if (mismatch) {
    throw new Error("Board storage usage reconciliation produced inconsistent counters");
  }
  const guestUsage = db.prepare(`
    SELECT
      generation_count, document_count, snapshot_bytes, state_vector_bytes,
      update_count, update_bytes, receipt_count, receipt_bytes,
      legacy_source_bytes, metadata_bytes, accounted_bytes
    FROM board_guest_storage_usage WHERE singleton = 1
  `).get() as Record<string, number>;
  const guestExpected = db.prepare(`
    SELECT
      COUNT(*) AS generation_count,
      COALESCE(SUM(document_count), 0) AS document_count,
      COALESCE(SUM(snapshot_bytes), 0) AS snapshot_bytes,
      COALESCE(SUM(state_vector_bytes), 0) AS state_vector_bytes,
      COALESCE(SUM(update_count), 0) AS update_count,
      COALESCE(SUM(update_bytes), 0) AS update_bytes,
      COALESCE(SUM(receipt_count), 0) AS receipt_count,
      COALESCE(SUM(receipt_bytes), 0) AS receipt_bytes,
      COALESCE(SUM(legacy_source_bytes), 0) AS legacy_source_bytes,
      COALESCE(SUM(metadata_bytes), 0) AS metadata_bytes,
      COALESCE(SUM(accounted_bytes), 0) AS accounted_bytes
    FROM board_storage_usage WHERE is_guest = 1
  `).get() as Record<string, number>;
  if (Object.keys(guestExpected).some(
    (column) => guestUsage[column] !== guestExpected[column],
  )) {
    throw new Error("Board guest storage usage reconciliation produced inconsistent counters");
  }
}

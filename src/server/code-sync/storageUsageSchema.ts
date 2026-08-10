import type Database from "better-sqlite3";

/**
 * Conservative reserves for SQLite rows and their indexes. Payload lengths
 * alone do not bound an attacker who writes many tiny updates or receipts.
 */
export const CODE_WORKSPACE_METADATA_RESERVE_BYTES = 1_024;
export const CODE_DOCUMENT_METADATA_RESERVE_BYTES = 1_024;
export const CODE_UPDATE_METADATA_RESERVE_BYTES = 2_048;
export const CODE_RECEIPT_METADATA_RESERVE_BYTES = 2_048;
export const CODE_RECEIPT_SCALAR_BYTES = 8;

export interface CodeReceiptStorageIdentity {
  readonly documentId: string;
  readonly deviceId: string;
  readonly updateId: string;
  readonly updateDigest: string;
  readonly createdAt: string;
}

export function codeReceiptLogicalBytes(
  receipt: CodeReceiptStorageIdentity,
): number {
  return CODE_RECEIPT_SCALAR_BYTES + Buffer.byteLength(
    receipt.documentId
      + receipt.deviceId
      + receipt.updateId
      + receipt.updateDigest
      + receipt.createdAt,
    "utf8",
  );
}

const receiptBytes = (prefix: "NEW" | "OLD"): string => `(
  length(CAST(${prefix}.document_id AS BLOB))
  + length(CAST(${prefix}.device_id AS BLOB))
  + length(CAST(${prefix}.update_id AS BLOB))
  + length(CAST(${prefix}.update_digest AS BLOB))
  + length(CAST(${prefix}.created_at AS BLOB))
  + ${CODE_RECEIPT_SCALAR_BYTES}
)`;

/**
 * Migration-v20 installer. Existing workspaces are reconciled once; triggers
 * then maintain both per-workspace and global guest counters transactionally.
 */
export function installCodeStorageUsageSchema(db: Database.Database): void {
  const receiptNewBytes = receiptBytes("NEW");
  const receiptOldBytes = receiptBytes("OLD");
  db.exec(`
    CREATE TABLE code_storage_usage (
      workspace_id TEXT PRIMARY KEY
        REFERENCES code_workspaces(id) ON DELETE CASCADE,
      document_count INTEGER NOT NULL CHECK (document_count BETWEEN 0 AND 1),
      snapshot_bytes INTEGER NOT NULL CHECK (snapshot_bytes >= 0),
      state_vector_bytes INTEGER NOT NULL CHECK (state_vector_bytes >= 0),
      update_count INTEGER NOT NULL CHECK (update_count >= 0),
      update_bytes INTEGER NOT NULL CHECK (update_bytes >= 0),
      receipt_count INTEGER NOT NULL CHECK (receipt_count >= 0),
      receipt_bytes INTEGER NOT NULL CHECK (receipt_bytes >= 0),
      metadata_bytes INTEGER NOT NULL CHECK (metadata_bytes >= 0),
      accounted_bytes INTEGER NOT NULL CHECK (
        accounted_bytes = snapshot_bytes + state_vector_bytes + update_bytes
          + receipt_bytes + metadata_bytes
      )
    );

    CREATE TABLE code_guest_storage_usage (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      workspace_count INTEGER NOT NULL CHECK (workspace_count >= 0),
      document_count INTEGER NOT NULL CHECK (document_count >= 0),
      snapshot_bytes INTEGER NOT NULL CHECK (snapshot_bytes >= 0),
      state_vector_bytes INTEGER NOT NULL CHECK (state_vector_bytes >= 0),
      update_count INTEGER NOT NULL CHECK (update_count >= 0),
      update_bytes INTEGER NOT NULL CHECK (update_bytes >= 0),
      receipt_count INTEGER NOT NULL CHECK (receipt_count >= 0),
      receipt_bytes INTEGER NOT NULL CHECK (receipt_bytes >= 0),
      metadata_bytes INTEGER NOT NULL CHECK (metadata_bytes >= 0),
      accounted_bytes INTEGER NOT NULL CHECK (
        accounted_bytes = snapshot_bytes + state_vector_bytes + update_bytes
          + receipt_bytes + metadata_bytes
      )
    );
    INSERT INTO code_guest_storage_usage (
      singleton, workspace_count, document_count, snapshot_bytes,
      state_vector_bytes, update_count, update_bytes, receipt_count,
      receipt_bytes, metadata_bytes, accounted_bytes
    ) VALUES (1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0);

    WITH document_usage AS (
      SELECT
        workspace_id,
        COUNT(*) AS row_count,
        COALESCE(SUM(snapshot_bytes), 0) AS snapshot_bytes,
        COALESCE(SUM(state_vector_bytes), 0) AS state_vector_bytes
      FROM code_documents
      GROUP BY workspace_id
    ),
    update_usage AS (
      SELECT
        document.workspace_id,
        COUNT(*) AS row_count,
        COALESCE(SUM(update_row.update_bytes), 0) AS update_bytes
      FROM code_updates update_row
      JOIN code_documents document ON document.id = update_row.document_id
      GROUP BY document.workspace_id
    ),
    receipt_usage AS (
      SELECT
        document.workspace_id,
        COUNT(*) AS row_count,
        COALESCE(SUM(
          length(CAST(receipt.document_id AS BLOB))
          + length(CAST(receipt.device_id AS BLOB))
          + length(CAST(receipt.update_id AS BLOB))
          + length(CAST(receipt.update_digest AS BLOB))
          + length(CAST(receipt.created_at AS BLOB))
          + ${CODE_RECEIPT_SCALAR_BYTES}
        ), 0) AS receipt_bytes
      FROM code_update_receipts receipt
      JOIN code_documents document ON document.id = receipt.document_id
      GROUP BY document.workspace_id
    ),
    reconciled AS (
      SELECT
        workspace.id AS workspace_id,
        COALESCE(document_usage.row_count, 0) AS document_count,
        COALESCE(document_usage.snapshot_bytes, 0) AS snapshot_bytes,
        COALESCE(document_usage.state_vector_bytes, 0) AS state_vector_bytes,
        COALESCE(update_usage.row_count, 0) AS update_count,
        COALESCE(update_usage.update_bytes, 0) AS update_bytes,
        COALESCE(receipt_usage.row_count, 0) AS receipt_count,
        COALESCE(receipt_usage.receipt_bytes, 0) AS receipt_bytes,
        ${CODE_WORKSPACE_METADATA_RESERVE_BYTES}
          + COALESCE(document_usage.row_count, 0)
            * ${CODE_DOCUMENT_METADATA_RESERVE_BYTES}
          + COALESCE(update_usage.row_count, 0)
            * ${CODE_UPDATE_METADATA_RESERVE_BYTES}
          + COALESCE(receipt_usage.row_count, 0)
            * ${CODE_RECEIPT_METADATA_RESERVE_BYTES} AS metadata_bytes
      FROM code_workspaces workspace
      LEFT JOIN document_usage ON document_usage.workspace_id = workspace.id
      LEFT JOIN update_usage ON update_usage.workspace_id = workspace.id
      LEFT JOIN receipt_usage ON receipt_usage.workspace_id = workspace.id
    )
    INSERT INTO code_storage_usage (
      workspace_id, document_count, snapshot_bytes, state_vector_bytes,
      update_count, update_bytes, receipt_count, receipt_bytes,
      metadata_bytes, accounted_bytes
    )
    SELECT
      workspace_id, document_count, snapshot_bytes, state_vector_bytes,
      update_count, update_bytes, receipt_count, receipt_bytes,
      metadata_bytes,
      snapshot_bytes + state_vector_bytes + update_bytes + receipt_bytes
        + metadata_bytes
    FROM reconciled;

    UPDATE code_guest_storage_usage SET
      workspace_count = (SELECT COUNT(*) FROM code_storage_usage),
      document_count = COALESCE((
        SELECT SUM(document_count) FROM code_storage_usage
      ), 0),
      snapshot_bytes = COALESCE((
        SELECT SUM(snapshot_bytes) FROM code_storage_usage
      ), 0),
      state_vector_bytes = COALESCE((
        SELECT SUM(state_vector_bytes) FROM code_storage_usage
      ), 0),
      update_count = COALESCE((
        SELECT SUM(update_count) FROM code_storage_usage
      ), 0),
      update_bytes = COALESCE((
        SELECT SUM(update_bytes) FROM code_storage_usage
      ), 0),
      receipt_count = COALESCE((
        SELECT SUM(receipt_count) FROM code_storage_usage
      ), 0),
      receipt_bytes = COALESCE((
        SELECT SUM(receipt_bytes) FROM code_storage_usage
      ), 0),
      metadata_bytes = COALESCE((
        SELECT SUM(metadata_bytes) FROM code_storage_usage
      ), 0),
      accounted_bytes = COALESCE((
        SELECT SUM(accounted_bytes) FROM code_storage_usage
      ), 0)
    WHERE singleton = 1;

    CREATE TRIGGER code_storage_usage_guest_insert
    AFTER INSERT ON code_storage_usage
    BEGIN
      UPDATE code_guest_storage_usage SET
        workspace_count = workspace_count + 1,
        document_count = document_count + NEW.document_count,
        snapshot_bytes = snapshot_bytes + NEW.snapshot_bytes,
        state_vector_bytes = state_vector_bytes + NEW.state_vector_bytes,
        update_count = update_count + NEW.update_count,
        update_bytes = update_bytes + NEW.update_bytes,
        receipt_count = receipt_count + NEW.receipt_count,
        receipt_bytes = receipt_bytes + NEW.receipt_bytes,
        metadata_bytes = metadata_bytes + NEW.metadata_bytes,
        accounted_bytes = accounted_bytes + NEW.accounted_bytes
      WHERE singleton = 1;
    END;

    CREATE TRIGGER code_storage_usage_guest_update
    AFTER UPDATE OF
      document_count, snapshot_bytes, state_vector_bytes,
      update_count, update_bytes, receipt_count, receipt_bytes,
      metadata_bytes, accounted_bytes
    ON code_storage_usage
    BEGIN
      UPDATE code_guest_storage_usage SET
        document_count = document_count + NEW.document_count - OLD.document_count,
        snapshot_bytes = snapshot_bytes + NEW.snapshot_bytes - OLD.snapshot_bytes,
        state_vector_bytes = state_vector_bytes
          + NEW.state_vector_bytes - OLD.state_vector_bytes,
        update_count = update_count + NEW.update_count - OLD.update_count,
        update_bytes = update_bytes + NEW.update_bytes - OLD.update_bytes,
        receipt_count = receipt_count + NEW.receipt_count - OLD.receipt_count,
        receipt_bytes = receipt_bytes + NEW.receipt_bytes - OLD.receipt_bytes,
        metadata_bytes = metadata_bytes + NEW.metadata_bytes - OLD.metadata_bytes,
        accounted_bytes = accounted_bytes
          + NEW.accounted_bytes - OLD.accounted_bytes
      WHERE singleton = 1;
    END;

    CREATE TRIGGER code_storage_usage_guest_delete
    AFTER DELETE ON code_storage_usage
    BEGIN
      UPDATE code_guest_storage_usage SET
        workspace_count = workspace_count - 1,
        document_count = document_count - OLD.document_count,
        snapshot_bytes = snapshot_bytes - OLD.snapshot_bytes,
        state_vector_bytes = state_vector_bytes - OLD.state_vector_bytes,
        update_count = update_count - OLD.update_count,
        update_bytes = update_bytes - OLD.update_bytes,
        receipt_count = receipt_count - OLD.receipt_count,
        receipt_bytes = receipt_bytes - OLD.receipt_bytes,
        metadata_bytes = metadata_bytes - OLD.metadata_bytes,
        accounted_bytes = accounted_bytes - OLD.accounted_bytes
      WHERE singleton = 1;
    END;

    CREATE TRIGGER code_workspaces_storage_identity_immutable
    BEFORE UPDATE OF id, room_resource_id ON code_workspaces
    BEGIN SELECT RAISE(ABORT, 'code workspace identity is immutable'); END;

    CREATE TRIGGER code_workspaces_storage_insert
    AFTER INSERT ON code_workspaces
    BEGIN
      INSERT INTO code_storage_usage (
        workspace_id, document_count, snapshot_bytes, state_vector_bytes,
        update_count, update_bytes, receipt_count, receipt_bytes,
        metadata_bytes, accounted_bytes
      ) VALUES (
        NEW.id, 0, 0, 0, 0, 0, 0, 0,
        ${CODE_WORKSPACE_METADATA_RESERVE_BYTES},
        ${CODE_WORKSPACE_METADATA_RESERVE_BYTES}
      );
    END;

    CREATE TRIGGER code_documents_storage_identity_immutable
    BEFORE UPDATE OF id, workspace_id ON code_documents
    BEGIN SELECT RAISE(ABORT, 'code document identity is immutable'); END;

    CREATE TRIGGER code_documents_storage_insert
    AFTER INSERT ON code_documents
    BEGIN
      UPDATE code_storage_usage SET
        document_count = document_count + 1,
        snapshot_bytes = snapshot_bytes + NEW.snapshot_bytes,
        state_vector_bytes = state_vector_bytes + NEW.state_vector_bytes,
        metadata_bytes = metadata_bytes
          + ${CODE_DOCUMENT_METADATA_RESERVE_BYTES},
        accounted_bytes = accounted_bytes + NEW.snapshot_bytes
          + NEW.state_vector_bytes + ${CODE_DOCUMENT_METADATA_RESERVE_BYTES}
      WHERE workspace_id = NEW.workspace_id;
    END;

    CREATE TRIGGER code_documents_storage_update
    AFTER UPDATE OF snapshot_bytes, state_vector_bytes ON code_documents
    BEGIN
      UPDATE code_storage_usage SET
        snapshot_bytes = snapshot_bytes + NEW.snapshot_bytes - OLD.snapshot_bytes,
        state_vector_bytes = state_vector_bytes
          + NEW.state_vector_bytes - OLD.state_vector_bytes,
        accounted_bytes = accounted_bytes
          + NEW.snapshot_bytes - OLD.snapshot_bytes
          + NEW.state_vector_bytes - OLD.state_vector_bytes
      WHERE workspace_id = NEW.workspace_id;
    END;

    CREATE TRIGGER code_documents_storage_delete
    AFTER DELETE ON code_documents
    BEGIN
      UPDATE code_storage_usage SET
        document_count = document_count - 1,
        snapshot_bytes = snapshot_bytes - OLD.snapshot_bytes,
        state_vector_bytes = state_vector_bytes - OLD.state_vector_bytes,
        metadata_bytes = metadata_bytes
          - ${CODE_DOCUMENT_METADATA_RESERVE_BYTES},
        accounted_bytes = accounted_bytes - OLD.snapshot_bytes
          - OLD.state_vector_bytes - ${CODE_DOCUMENT_METADATA_RESERVE_BYTES}
      WHERE workspace_id = OLD.workspace_id;
    END;

    CREATE TRIGGER code_updates_storage_insert
    AFTER INSERT ON code_updates
    BEGIN
      UPDATE code_storage_usage SET
        update_count = update_count + 1,
        update_bytes = update_bytes + NEW.update_bytes,
        metadata_bytes = metadata_bytes + ${CODE_UPDATE_METADATA_RESERVE_BYTES},
        accounted_bytes = accounted_bytes + NEW.update_bytes
          + ${CODE_UPDATE_METADATA_RESERVE_BYTES}
      WHERE workspace_id = (
        SELECT workspace_id FROM code_documents WHERE id = NEW.document_id
      );
    END;

    CREATE TRIGGER code_updates_storage_delete
    AFTER DELETE ON code_updates
    BEGIN
      UPDATE code_storage_usage SET
        update_count = update_count - 1,
        update_bytes = update_bytes - OLD.update_bytes,
        metadata_bytes = metadata_bytes - ${CODE_UPDATE_METADATA_RESERVE_BYTES},
        accounted_bytes = accounted_bytes - OLD.update_bytes
          - ${CODE_UPDATE_METADATA_RESERVE_BYTES}
      WHERE workspace_id = (
        SELECT workspace_id FROM code_documents WHERE id = OLD.document_id
      );
    END;

    CREATE TRIGGER code_update_receipts_storage_immutable
    BEFORE UPDATE ON code_update_receipts
    BEGIN SELECT RAISE(ABORT, 'code update receipt is immutable'); END;

    CREATE TRIGGER code_update_receipts_storage_insert
    AFTER INSERT ON code_update_receipts
    BEGIN
      UPDATE code_storage_usage SET
        receipt_count = receipt_count + 1,
        receipt_bytes = receipt_bytes + ${receiptNewBytes},
        metadata_bytes = metadata_bytes + ${CODE_RECEIPT_METADATA_RESERVE_BYTES},
        accounted_bytes = accounted_bytes + ${receiptNewBytes}
          + ${CODE_RECEIPT_METADATA_RESERVE_BYTES}
      WHERE workspace_id = (
        SELECT workspace_id FROM code_documents WHERE id = NEW.document_id
      );
    END;

    CREATE TRIGGER code_update_receipts_storage_delete
    AFTER DELETE ON code_update_receipts
    BEGIN
      UPDATE code_storage_usage SET
        receipt_count = receipt_count - 1,
        receipt_bytes = receipt_bytes - ${receiptOldBytes},
        metadata_bytes = metadata_bytes - ${CODE_RECEIPT_METADATA_RESERVE_BYTES},
        accounted_bytes = accounted_bytes - ${receiptOldBytes}
          - ${CODE_RECEIPT_METADATA_RESERVE_BYTES}
      WHERE workspace_id = (
        SELECT workspace_id FROM code_documents WHERE id = OLD.document_id
      );
    END;
  `);

  const mismatch = db.prepare(`
    SELECT workspace_id FROM code_storage_usage
    WHERE accounted_bytes != snapshot_bytes + state_vector_bytes + update_bytes
      + receipt_bytes + metadata_bytes
    LIMIT 1
  `).get();
  if (mismatch) {
    throw new Error(
      "Code storage usage reconciliation produced inconsistent counters",
    );
  }
  const aggregate = db.prepare(`
    SELECT
      workspace_count, document_count, snapshot_bytes, state_vector_bytes,
      update_count, update_bytes, receipt_count, receipt_bytes,
      metadata_bytes, accounted_bytes
    FROM code_guest_storage_usage WHERE singleton = 1
  `).get() as Record<string, number>;
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
  `).get() as Record<string, number>;
  if (Object.keys(expected).some((column) => aggregate[column] !== expected[column])) {
    throw new Error(
      "Code guest storage usage reconciliation produced inconsistent counters",
    );
  }
}

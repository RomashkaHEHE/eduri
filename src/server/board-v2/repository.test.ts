import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { migrate } from "../db.js";
import { GuestRoomService } from "../guestRooms.js";
import {
  BoardRepository,
  BoardRepositoryError,
  type BoardRecord,
} from "./repository.js";
import {
  BOARD_BASE_METADATA_RESERVE_BYTES,
  BOARD_DOCUMENT_METADATA_RESERVE_BYTES,
  BOARD_RECEIPT_METADATA_RESERVE_BYTES,
  BOARD_UPDATE_METADATA_RESERVE_BYTES,
  boardReceiptLogicalBytes,
} from "./storageUsageSchema.js";

interface Fixture {
  tutorId: string;
  studentId: string;
  lessonId: string;
}

function bytes(...values: number[]): Uint8Array {
  return Uint8Array.from(values);
}

function insertFixture(db: Database.Database): Fixture {
  const tutorId = randomUUID();
  const studentId = randomUUID();
  const lessonId = randomUUID();
  const now = "2026-07-28T00:00:00.000Z";
  db.prepare(`
    INSERT INTO users (
      id, role, status, display_name, login_name, login_name_normalized,
      created_at, updated_at
    ) VALUES (?, 'tutor', 'active', 'Tutor', 'tutor', ?, ?, ?)
  `).run(tutorId, `tutor-${tutorId}`, now, now);
  db.prepare(`
    INSERT INTO users (
      id, role, status, display_name, tutor_id, created_at, updated_at
    ) VALUES (?, 'student', 'active', 'Student', ?, ?, ?)
  `).run(studentId, tutorId, now, now);
  db.prepare(`
    INSERT INTO lessons (
      id, tutor_id, student_id, title, meeting_key, scheduled_at,
      duration_minutes, status, created_at, updated_at
    ) VALUES (?, ?, ?, 'Board repository test', ?, ?, 60, 'scheduled', ?, ?)
  `).run(lessonId, tutorId, studentId, `meeting-${randomUUID()}`, now, now, now);
  return { tutorId, studentId, lessonId };
}

function append(
  repository: BoardRepository,
  board: BoardRecord,
  actorId: string,
  update: Uint8Array,
  messageId = randomUUID(),
) {
  return repository.appendUpdate({
    boardId: board.id,
    documentKey: "manifest",
    generation: board.generation,
    messageId,
    actorId,
    clientId: randomUUID(),
    update,
  });
}

describe("BoardRepository", () => {
  let db: Database.Database;
  let repository: BoardRepository;
  let fixture: Fixture;
  let board: BoardRecord;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    migrate(db);
    fixture = insertFixture(db);
    repository = new BoardRepository(db);
    board = repository.createBoardForLesson(fixture.lessonId, { engine: "v2" });
  });

  afterEach(() => {
    db.close();
  });

  it("creates one board per lesson and reloads ordered durable updates", () => {
    const sameBoard = repository.createBoardForLesson(fixture.lessonId, { engine: "v2" });
    expect(sameBoard.id).toBe(board.id);

    const first = append(repository, board, fixture.tutorId, bytes(1, 2));
    const second = append(repository, board, fixture.studentId, bytes(3));
    expect([first.seq, second.seq]).toEqual([1, 2]);

    const restartedRepository = new BoardRepository(db);
    const loaded = restartedRepository.loadDocument({
      boardId: board.id,
      documentKey: "manifest",
      generation: board.generation,
    });
    expect(loaded.highWaterSeq).toBe(2);
    expect(loaded.document.snapshotSeq).toBe(0);
    expect(loaded.updates.map((update) => update.seq)).toEqual([1, 2]);
    expect(loaded.updates.map((update) => [...update.update])).toEqual([[1, 2], [3]]);
  });

  it("uses v2 when a caller creates a board without an engine override", () => {
    const anotherLesson = insertFixture(db);

    expect(repository.createBoardForLesson(anotherLesson.lessonId).engine).toBe("v2");
  });

  it("admits or rejects board/document creation with one atomic accounted budget", () => {
    const another = insertFixture(db);
    const initialBytes = BOARD_BASE_METADATA_RESERVE_BYTES
      + BOARD_DOCUMENT_METADATA_RESERVE_BYTES;
    const rejected = new BoardRepository(
      db,
      {},
      {
        tenantSoftQuotaBytes: initialBytes - 1,
        minFreeDiskBytes: 1,
        storageRoot: "unused-by-test-probe",
        capacityProbe: { freeDiskBytes: () => 1_000_000 },
      },
    );
    expect(() => rejected.createBoardForLesson(another.lessonId))
      .toThrowError(expect.objectContaining({ code: "TENANT_QUOTA" }));
    expect(db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM boards WHERE lesson_id = ?) AS boards,
        (SELECT COUNT(*) FROM board_storage_usage usage
          JOIN boards board ON board.id = usage.board_id
          WHERE board.lesson_id = ?) AS usage_rows
    `).get(another.lessonId, another.lessonId)).toEqual({
      boards: 0,
      usage_rows: 0,
    });

    const admitted = new BoardRepository(
      db,
      {},
      {
        tenantSoftQuotaBytes: initialBytes,
        minFreeDiskBytes: 1,
        storageRoot: "unused-by-test-probe",
        capacityProbe: { freeDiskBytes: () => 1_000_000 },
      },
    );
    const created = admitted.createBoardForLesson(another.lessonId);
    expect(admitted.getBoardMetrics({
      boardId: created.id,
      generation: created.generation,
    })).toMatchObject({
      documentCount: 1,
      quotaBytes: initialBytes,
      storageMetadataBytes: initialBytes,
    });
  });

  it("initializes an empty manifest exactly once before its first update", () => {
    expect(repository.initializeEmptyDocument({
      boardId: board.id,
      documentKey: "manifest",
      generation: board.generation,
      snapshot: bytes(1, 2),
      stateVector: bytes(3),
    })).toMatchObject({
      snapshotSeq: 0,
      lastSeq: 0,
      snapshotBytes: 2,
      stateVectorBytes: 1,
    });
    expect(() => repository.initializeEmptyDocument({
      boardId: board.id,
      documentKey: "manifest",
      generation: board.generation,
      snapshot: bytes(4),
      stateVector: bytes(5),
    })).toThrowError(expect.objectContaining({ code: "DOCUMENT_CONFLICT" }));
  });

  it("keeps message IDs idempotent before and after compaction", () => {
    const messageId = randomUUID();
    const clientId = randomUUID();
    const input = {
      boardId: board.id,
      documentKey: "manifest",
      generation: board.generation,
      messageId,
      actorId: fixture.tutorId,
      clientId,
      update: bytes(9, 8, 7),
    };
    expect(repository.findUpdateReceipt(input)).toBeNull();
    const inserted = repository.appendUpdate(input);
    expect(repository.findUpdateReceipt(input)).toMatchObject({
      seq: 1,
      duplicate: true,
    });
    const duplicate = repository.appendUpdate(input);
    expect(inserted).toMatchObject({ seq: 1, duplicate: false });
    expect(duplicate).toMatchObject({ seq: 1, duplicate: true });

    repository.compactDocument({
      boardId: board.id,
      documentKey: "manifest",
      generation: board.generation,
      highWaterSeq: 1,
      snapshot: bytes(42),
      stateVector: bytes(1),
    });
    expect(repository.appendUpdate(input)).toMatchObject({ seq: 1, duplicate: true });
    expect(() => repository.findUpdateReceipt({ ...input, update: bytes(9, 8, 6) }))
      .toThrowError(expect.objectContaining({ code: "IDEMPOTENCY_CONFLICT" }));
    expect(repository.getBoardMetrics({
      boardId: board.id,
      generation: board.generation,
    })).toMatchObject({
      updateLogCount: 0,
      idempotencyReceiptCount: 1,
    });
  });

  it("charges tiny updates, durable receipts, and row/index reserves across compaction", () => {
    for (let index = 0; index < 16; index += 1) {
      append(repository, board, fixture.tutorId, bytes(index));
    }
    const before = repository.getBoardMetrics({
      boardId: board.id,
      generation: board.generation,
    });
    expect(before).toMatchObject({
      updateLogCount: 16,
      updateLogBytes: 16,
      idempotencyReceiptCount: 16,
    });
    expect(before.idempotencyReceiptBytes).toBeGreaterThan(16);
    expect(before.storageMetadataBytes).toBeGreaterThanOrEqual(
      BOARD_BASE_METADATA_RESERVE_BYTES
        + BOARD_DOCUMENT_METADATA_RESERVE_BYTES
        + 16 * (
          BOARD_UPDATE_METADATA_RESERVE_BYTES
          + BOARD_RECEIPT_METADATA_RESERVE_BYTES
        ),
    );

    repository.compactDocument({
      boardId: board.id,
      documentKey: "manifest",
      generation: board.generation,
      highWaterSeq: 16,
      snapshot: bytes(1),
      stateVector: bytes(0),
    });
    const after = repository.getBoardMetrics({
      boardId: board.id,
      generation: board.generation,
    });
    expect(after).toMatchObject({
      updateLogCount: 0,
      updateLogBytes: 0,
      idempotencyReceiptCount: 16,
      idempotencyReceiptBytes: before.idempotencyReceiptBytes,
      storageMetadataBytes:
        before.storageMetadataBytes
        - 16 * BOARD_UPDATE_METADATA_RESERVE_BYTES,
    });
    expect(after.quotaBytes).toBe(
      after.snapshotBytes
        + after.stateVectorBytes
        + after.updateLogBytes
        + after.idempotencyReceiptBytes
        + after.legacySourceBytes
        + after.storageMetadataBytes,
    );
    expect(new BoardRepository(db).getBoardMetrics({
      boardId: board.id,
      generation: board.generation,
    })).toEqual(after);
  });

  it("allows a shrinking compaction when reconciled usage already exceeds quota", () => {
    append(repository, board, fixture.tutorId, bytes(1));
    append(repository, board, fixture.tutorId, bytes(2));
    const before = repository.getBoardMetrics({
      boardId: board.id,
      generation: board.generation,
    });
    const constrained = new BoardRepository(
      db,
      {},
      {
        tenantSoftQuotaBytes: before.quotaBytes - 1,
        minFreeDiskBytes: 1,
        storageRoot: "unused-by-test-probe",
        capacityProbe: { freeDiskBytes: () => 1_000_000 },
      },
    );
    constrained.compactDocument({
      boardId: board.id,
      documentKey: "manifest",
      generation: board.generation,
      highWaterSeq: 2,
      snapshot: bytes(3),
      stateVector: bytes(4),
    });
    const after = constrained.getBoardMetrics({
      boardId: board.id,
      generation: board.generation,
    });
    expect(after.quotaBytes).toBeLessThan(before.quotaBytes);
    expect(after).toMatchObject({
      updateLogCount: 0,
      idempotencyReceiptCount: 2,
    });
  });

  it("rolls back a quota-expanding compaction and its usage deltas", () => {
    append(repository, board, fixture.tutorId, bytes(1));
    const before = repository.getBoardMetrics({
      boardId: board.id,
      generation: board.generation,
    });
    const constrained = new BoardRepository(
      db,
      {},
      {
        tenantSoftQuotaBytes: before.quotaBytes + 100,
        minFreeDiskBytes: 1,
        storageRoot: "unused-by-test-probe",
        capacityProbe: { freeDiskBytes: () => 1_000_000 },
      },
    );
    expect(() => constrained.compactDocument({
      boardId: board.id,
      documentKey: "manifest",
      generation: board.generation,
      highWaterSeq: 1,
      snapshot: new Uint8Array(16_384),
      stateVector: bytes(1),
    })).toThrowError(expect.objectContaining({ code: "TENANT_QUOTA" }));
    expect(constrained.getBoardMetrics({
      boardId: board.id,
      generation: board.generation,
    })).toEqual(before);
    expect(constrained.loadDocument({
      boardId: board.id,
      documentKey: "manifest",
      generation: board.generation,
    })).toMatchObject({
      document: { snapshotSeq: 0, lastSeq: 1 },
      updates: [{ seq: 1 }],
    });
  });

  it("rolls back sequence allocation when a durable append fails", () => {
    db.exec(`
      CREATE TRIGGER reject_board_update_receipt
      BEFORE INSERT ON board_update_receipts
      BEGIN
        SELECT RAISE(ABORT, 'injected receipt failure');
      END;
    `);
    expect(() => append(repository, board, fixture.tutorId, bytes(1)))
      .toThrow(/injected receipt failure/u);
    db.exec("DROP TRIGGER reject_board_update_receipt");

    expect(append(repository, board, fixture.tutorId, bytes(2))).toMatchObject({ seq: 1 });
    const loaded = repository.loadDocument({
      boardId: board.id,
      documentKey: "manifest",
      generation: board.generation,
    });
    expect(loaded.document.lastSeq).toBe(1);
    expect(loaded.updates.map((update) => [...update.update])).toEqual([[2]]);
  });

  it("compacts transactionally through a high-water sequence and preserves later rows", () => {
    append(repository, board, fixture.tutorId, bytes(1));
    append(repository, board, fixture.tutorId, bytes(2));
    const candidate = repository.loadDocument({
      boardId: board.id,
      documentKey: "manifest",
      generation: board.generation,
    });

    append(repository, board, fixture.studentId, bytes(3));
    const compacted = repository.compactDocument({
      boardId: board.id,
      documentKey: "manifest",
      generation: board.generation,
      highWaterSeq: candidate.highWaterSeq,
      snapshot: bytes(20, 21),
      stateVector: bytes(22),
    });
    expect(compacted).toMatchObject({
      deletedUpdateCount: 2,
      remainingUpdateCount: 1,
      document: { snapshotSeq: 2, lastSeq: 3 },
    });

    const reloaded = repository.loadDocument({
      boardId: board.id,
      documentKey: "manifest",
      generation: board.generation,
    });
    expect([...reloaded.document.snapshot]).toEqual([20, 21]);
    expect(reloaded.updates.map((update) => ({
      seq: update.seq,
      value: [...update.update],
    }))).toEqual([{ seq: 3, value: [3] }]);
  });

  it("rolls back the snapshot replacement when compaction deletion fails", () => {
    append(repository, board, fixture.tutorId, bytes(1));
    db.exec(`
      CREATE TRIGGER reject_board_update_delete
      BEFORE DELETE ON board_updates
      BEGIN
        SELECT RAISE(ABORT, 'injected compaction failure');
      END;
    `);
    expect(() => repository.compactDocument({
      boardId: board.id,
      documentKey: "manifest",
      generation: board.generation,
      highWaterSeq: 1,
      snapshot: bytes(10),
      stateVector: bytes(11),
    })).toThrow(/injected compaction failure/u);

    const loaded = repository.loadDocument({
      boardId: board.id,
      documentKey: "manifest",
      generation: board.generation,
    });
    expect(loaded.document).toMatchObject({ snapshotSeq: 0, lastSeq: 1 });
    expect([...loaded.document.snapshot]).toEqual([]);
    expect(loaded.updates).toHaveLength(1);
  });

  it("rejects a stale compactor instead of regressing an existing snapshot", () => {
    append(repository, board, fixture.tutorId, bytes(1));
    append(repository, board, fixture.tutorId, bytes(2));
    repository.compactDocument({
      boardId: board.id,
      documentKey: "manifest",
      generation: board.generation,
      highWaterSeq: 2,
      snapshot: bytes(2),
      stateVector: bytes(2),
    });

    expect(() => repository.compactDocument({
      boardId: board.id,
      documentKey: "manifest",
      generation: board.generation,
      highWaterSeq: 1,
      snapshot: bytes(1),
      stateVector: bytes(1),
    })).toThrowError(expect.objectContaining({ code: "HIGH_WATER_INVALID" }));
    expect([...repository.loadDocument({
      boardId: board.id,
      documentKey: "manifest",
      generation: board.generation,
    }).document.snapshot]).toEqual([2]);
  });

  it("uses per-update guards without imposing a small total-board cap", () => {
    const limitedRepository = new BoardRepository(db, { maxUpdateBytes: 4 });
    for (let index = 0; index < 20; index += 1) {
      append(limitedRepository, board, fixture.tutorId, bytes(1, 2, 3, 4));
    }
    expect(limitedRepository.getBoardMetrics({
      boardId: board.id,
      generation: board.generation,
    })).toMatchObject({
      updateLogCount: 20,
      updateLogBytes: 80,
    });
    expect(limitedRepository.getBoardMetrics({
      boardId: board.id,
      generation: board.generation,
    }).totalBytes).toBeGreaterThan(80);
    expect(() => append(limitedRepository, board, fixture.tutorId, bytes(1, 2, 3, 4, 5)))
      .toThrowError(expect.objectContaining({ code: "SIZE_LIMIT" }));
  });

  it("rejects tenant quota and disk pressure before mutating durable rows", () => {
    const quotaRepository = new BoardRepository(
      db,
      {},
      {
        tenantSoftQuotaBytes: 8_000,
        minFreeDiskBytes: 1,
        storageRoot: "unused-by-test-probe",
        capacityProbe: { freeDiskBytes: () => 1_000_000 },
      },
    );
    append(quotaRepository, board, fixture.tutorId, bytes(1, 2));
    const beforeQuota = quotaRepository.getBoardMetrics({
      boardId: board.id,
      generation: board.generation,
    });
    expect(() =>
      append(quotaRepository, board, fixture.tutorId, bytes(3, 4)),
    ).toThrowError(expect.objectContaining({ code: "TENANT_QUOTA" }));
    expect(quotaRepository.getBoardMetrics({
      boardId: board.id,
      generation: board.generation,
    })).toEqual(beforeQuota);

    const diskRepository = new BoardRepository(
      db,
      {},
      {
        tenantSoftQuotaBytes: 1_000_000,
        minFreeDiskBytes: 100,
        storageRoot: "unused-by-test-probe",
        capacityProbe: { freeDiskBytes: () => 101 },
      },
    );
    const beforeDisk = diskRepository.getBoardMetrics({
      boardId: board.id,
      generation: board.generation,
    });
    expect(() =>
      append(diskRepository, board, fixture.tutorId, bytes(5, 6)),
    ).toThrowError(expect.objectContaining({ code: "DISK_PRESSURE" }));
    expect(diskRepository.getBoardMetrics({
      boardId: board.id,
      generation: board.generation,
    })).toEqual(beforeDisk);
  });

  it("bounds persistent receipt amplification and rolls back the rejected sequence", () => {
    const initial = repository.getBoardMetrics({
      boardId: board.id,
      generation: board.generation,
    });
    append(repository, board, fixture.tutorId, bytes(1));
    const seeded = repository.getBoardMetrics({
      boardId: board.id,
      generation: board.generation,
    });
    const oneTinyAppendBytes = seeded.quotaBytes - initial.quotaBytes;
    const limited = new BoardRepository(
      db,
      {},
      {
        tenantSoftQuotaBytes: seeded.quotaBytes + 2 * oneTinyAppendBytes,
        minFreeDiskBytes: 1,
        storageRoot: "unused-by-test-probe",
        capacityProbe: { freeDiskBytes: () => 1_000_000 },
      },
    );

    append(limited, board, fixture.tutorId, bytes(2));
    append(limited, board, fixture.tutorId, bytes(3));
    const beforeRejected = limited.getBoardMetrics({
      boardId: board.id,
      generation: board.generation,
    });
    expect(() => append(limited, board, fixture.tutorId, bytes(4)))
      .toThrowError(expect.objectContaining({ code: "TENANT_QUOTA" }));
    expect(limited.getBoardMetrics({
      boardId: board.id,
      generation: board.generation,
    })).toEqual(beforeRejected);
    expect(repository.loadDocument({
      boardId: board.id,
      documentKey: "manifest",
      generation: board.generation,
    }).document.lastSeq).toBe(3);
  });

  it("enforces one durable aggregate quota across guest boards", () => {
    const guestRooms = new GuestRoomService(db);
    const firstRoom = guestRooms.create("board");
    const secondRoom = guestRooms.create("board");
    const firstResource = firstRoom.resources.find((resource) => resource.kind === "board")!;
    const secondResource = secondRoom.resources.find((resource) => resource.kind === "board")!;
    const firstBoard = repository.createBoardForRoomResource(firstResource.id);
    const secondBoard = repository.createBoardForRoomResource(secondResource.id);
    const quotaRepository = new BoardRepository(
      db,
      {},
      {
        tenantSoftQuotaBytes: 12_000,
        minFreeDiskBytes: 1,
        storageRoot: "unused-by-test-probe",
        capacityProbe: { freeDiskBytes: () => 1_000_000 },
      },
    );

    append(quotaRepository, firstBoard, fixture.tutorId, bytes(1, 2));
    const beforeRejectedAppend = quotaRepository.getBoardMetrics({
      boardId: secondBoard.id,
      generation: secondBoard.generation,
    });

    expect(() =>
      append(quotaRepository, secondBoard, fixture.tutorId, bytes(3, 4)),
    ).toThrowError(expect.objectContaining({ code: "TENANT_QUOTA" }));
    expect(quotaRepository.getBoardMetrics({
      boardId: secondBoard.id,
      generation: secondBoard.generation,
    })).toEqual(beforeRejectedAppend);

    const restartedRepository = new BoardRepository(
      db,
      {},
      {
        tenantSoftQuotaBytes: 12_000,
        minFreeDiskBytes: 1,
        storageRoot: "unused-by-test-probe",
        capacityProbe: { freeDiskBytes: () => 1_000_000 },
      },
    );
    expect(() =>
      append(restartedRepository, secondBoard, fixture.tutorId, bytes(5, 6)),
    ).toThrowError(expect.objectContaining({ code: "TENANT_QUOTA" }));
  });

  it("serializes guest quota contenders through the durable aggregate counter", async () => {
    const guestRooms = new GuestRoomService(db);
    const firstRoom = guestRooms.create("board");
    const secondRoom = guestRooms.create("board");
    const firstBoard = repository.createBoardForRoomResource(
      firstRoom.resources.find((resource) => resource.kind === "board")!.id,
    );
    const secondBoard = repository.createBoardForRoomResource(
      secondRoom.resources.find((resource) => resource.kind === "board")!.id,
    );
    const firstMessageId = randomUUID();
    const secondMessageId = randomUUID();
    const firstClientId = randomUUID();
    const secondClientId = randomUUID();
    const update = bytes(1);
    const updateSha256 = createHash("sha256").update(update).digest("hex");
    const appendBytes = update.byteLength
      + BOARD_UPDATE_METADATA_RESERVE_BYTES
      + BOARD_RECEIPT_METADATA_RESERVE_BYTES
      + boardReceiptLogicalBytes({
        boardId: firstBoard.id,
        documentKey: "manifest",
        messageId: firstMessageId,
        actorId: fixture.tutorId,
        clientId: firstClientId,
        updateSha256,
        createdAt: "2026-08-09T08:00:00.000Z",
      });
    const aggregateBefore = db.prepare(`
      SELECT accounted_bytes FROM board_guest_storage_usage WHERE singleton = 1
    `).get() as { accounted_bytes: number };
    const policy = {
      tenantSoftQuotaBytes: aggregateBefore.accounted_bytes + appendBytes,
      minFreeDiskBytes: 1,
      storageRoot: "unused-by-test-probe",
      capacityProbe: { freeDiskBytes: () => 1_000_000 },
    };
    const firstRepository = new BoardRepository(db, {}, policy);
    const secondRepository = new BoardRepository(db, {}, policy);
    const results = await Promise.allSettled([
      Promise.resolve().then(() => firstRepository.appendUpdate({
        boardId: firstBoard.id,
        documentKey: "manifest",
        generation: firstBoard.generation,
        messageId: firstMessageId,
        actorId: fixture.tutorId,
        clientId: firstClientId,
        update,
      })),
      Promise.resolve().then(() => secondRepository.appendUpdate({
        boardId: secondBoard.id,
        documentKey: "manifest",
        generation: secondBoard.generation,
        messageId: secondMessageId,
        actorId: fixture.tutorId,
        clientId: secondClientId,
        update,
      })),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(results.find((result) => result.status === "rejected"))
      .toMatchObject({ reason: expect.objectContaining({ code: "TENANT_QUOTA" }) });
    expect(db.prepare(`
      SELECT accounted_bytes FROM board_guest_storage_usage WHERE singleton = 1
    `).get()).toEqual({
      accounted_bytes: aggregateBefore.accounted_bytes + appendBytes,
    });

    db.prepare("DELETE FROM guest_rooms WHERE id IN (?, ?)")
      .run(firstRoom.id, secondRoom.id);
    expect(db.prepare(`
      SELECT generation_count, accounted_bytes
      FROM board_guest_storage_usage WHERE singleton = 1
    `).get()).toEqual({ generation_count: 0, accounted_bytes: 0 });
  });

  it("persists accounted usage across a database restart", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "eduri-board-usage-"));
    const databasePath = path.join(directory, "board.sqlite");
    let fileDb: Database.Database | undefined;
    try {
      fileDb = new Database(databasePath);
      fileDb.pragma("foreign_keys = ON");
      migrate(fileDb);
      const fileFixture = insertFixture(fileDb);
      const fileRepository = new BoardRepository(fileDb);
      const fileBoard = fileRepository.createBoardForLesson(fileFixture.lessonId);
      append(fileRepository, fileBoard, fileFixture.tutorId, bytes(1));
      const beforeRestart = fileRepository.getBoardMetrics({
        boardId: fileBoard.id,
        generation: fileBoard.generation,
      });
      fileDb.close();

      fileDb = new Database(databasePath);
      fileDb.pragma("foreign_keys = ON");
      migrate(fileDb);
      const restarted = new BoardRepository(
        fileDb,
        {},
        {
          tenantSoftQuotaBytes: beforeRestart.quotaBytes + 100,
          minFreeDiskBytes: 1,
          storageRoot: "unused-by-test-probe",
          capacityProbe: { freeDiskBytes: () => 1_000_000 },
        },
      );
      expect(restarted.getBoardMetrics({
        boardId: fileBoard.id,
        generation: fileBoard.generation,
      })).toEqual(beforeRestart);
      expect(() => append(restarted, fileBoard, fileFixture.tutorId, bytes(2)))
        .toThrowError(expect.objectContaining({ code: "TENANT_QUOTA" }));
    } finally {
      if (fileDb?.open) fileDb.close();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("ACKs an idempotent retry without requiring new storage admission", () => {
    let freeDiskBytes = 1_000_000;
    const capacityRepository = new BoardRepository(
      db,
      {},
      {
        tenantSoftQuotaBytes: 1_000_000,
        minFreeDiskBytes: 100,
        storageRoot: "unused-by-test-probe",
        capacityProbe: { freeDiskBytes: () => freeDiskBytes },
      },
    );
    const input = {
      boardId: board.id,
      documentKey: "manifest",
      generation: board.generation,
      messageId: randomUUID(),
      actorId: fixture.tutorId,
      clientId: randomUUID(),
      update: bytes(1, 2, 3),
    };
    const inserted = capacityRepository.appendUpdate(input);
    freeDiskBytes = 0;
    expect(capacityRepository.appendUpdate(input)).toEqual({
      ...inserted,
      duplicate: true,
    });
  });

  it("retains an immutable, hash-verified legacy source and the legacy lesson columns", () => {
    const sourceJson = '{"elements":[{"id":"legacy"}]}';
    const imported = repository.recordLegacyImport({
      boardId: board.id,
      generation: board.generation,
      sourceRevision: 7,
      sourceJson,
    });
    expect(imported.sourceJson).toBe(sourceJson);
    expect(imported.sourceSha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(repository.recordLegacyImport({
      boardId: board.id,
      generation: board.generation,
      sourceRevision: 7,
      sourceJson,
      expectedSha256: imported.sourceSha256,
    })).toEqual(imported);
    expect(() => db.prepare(`
      UPDATE board_legacy_imports SET source_json = '{}' WHERE board_id = ?
    `).run(board.id)).toThrow(/immutable/u);

    const lessonColumns = db.prepare("PRAGMA table_info(lessons)").all() as Array<{ name: string }>;
    expect(lessonColumns.map((column) => column.name)).toEqual(
      expect.arrayContaining(["board_state", "board_revision"]),
    );
  });

  it("cascades every board-v2 row when its lesson is deleted", () => {
    const pageKey = `page:${randomUUID()}`;
    repository.ensureDocument({
      boardId: board.id,
      documentKey: pageKey,
      generation: board.generation,
    });
    repository.appendUpdate({
      boardId: board.id,
      documentKey: pageKey,
      generation: board.generation,
      messageId: randomUUID(),
      actorId: fixture.tutorId,
      clientId: randomUUID(),
      update: bytes(1),
    });
    repository.recordLegacyImport({
      boardId: board.id,
      generation: board.generation,
      sourceRevision: 0,
      sourceJson: "{}",
    });

    db.prepare("DELETE FROM lessons WHERE id = ?").run(fixture.lessonId);
    for (const table of [
      "boards",
      "board_documents",
      "board_updates",
      "board_update_receipts",
      "board_legacy_imports",
    ]) {
      expect((db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count)
        .toBe(0);
    }
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  it("rejects malformed document keys and stale generations at the repository boundary", () => {
    expect(() => repository.ensureDocument({
      boardId: board.id,
      documentKey: "page:not-a-uuid",
      generation: board.generation,
    })).toThrowError(BoardRepositoryError);
    expect(() => repository.loadDocument({
      boardId: board.id,
      documentKey: "manifest",
      generation: board.generation + 1,
    })).toThrowError(expect.objectContaining({ code: "GENERATION_MISMATCH" }));
  });
});

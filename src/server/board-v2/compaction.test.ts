import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import Database from "better-sqlite3";
import * as Y from "yjs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BOARD_PROTOCOL_LIMITS } from "../../board/protocol/index.js";
import { migrate } from "../db.js";
import { BoardCompactionCoordinator } from "./compaction.js";
import {
  BoardRepository,
  type BoardRecord,
  type LoadedBoardDocument,
} from "./repository.js";

interface Fixture {
  tutorId: string;
  lessonId: string;
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
    ) VALUES (?, ?, ?, 'Compaction test', ?, ?, 60, 'scheduled', ?, ?)
  `).run(
    lessonId,
    tutorId,
    studentId,
    `meeting-${randomUUID()}`,
    now,
    now,
    now,
  );
  return { tutorId, lessonId };
}

function appendMapChange(
  repository: BoardRepository,
  board: BoardRecord,
  actorId: string,
  doc: Y.Doc,
  key: string,
  value: string,
): void {
  let emitted: Uint8Array | undefined;
  const capture = (update: Uint8Array) => {
    emitted = Uint8Array.from(update);
  };
  doc.once("update", capture);
  doc.getMap<string>("content").set(key, value);
  expect(emitted).toBeDefined();
  repository.appendUpdate({
    boardId: board.id,
    documentKey: "manifest",
    generation: board.generation,
    messageId: randomUUID(),
    actorId,
    clientId: randomUUID(),
    update: emitted!,
  });
}

function reconstructLoaded(
  loaded: LoadedBoardDocument,
): { snapshot: Uint8Array; stateVector: Uint8Array } {
  const doc = new Y.Doc();
  try {
    if (loaded.document.snapshot.byteLength > 0) {
      Y.applyUpdate(doc, loaded.document.snapshot);
    }
    for (const update of loaded.updates) {
      Y.applyUpdate(doc, update.update);
    }
    return {
      snapshot: Y.encodeStateAsUpdate(doc),
      stateVector: Y.encodeStateVector(doc),
    };
  } finally {
    doc.destroy();
  }
}

describe("BoardCompactionCoordinator", () => {
  let db: Database.Database;
  let repository: BoardRepository;
  let board: BoardRecord;
  let fixture: Fixture;
  let source: Y.Doc;
  let coordinator: BoardCompactionCoordinator;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    migrate(db);
    fixture = insertFixture(db);
    repository = new BoardRepository(db);
    board = repository.createBoardForLesson(fixture.lessonId, { engine: "v2" });
    source = new Y.Doc();
    repository.initializeEmptyDocument({
      boardId: board.id,
      documentKey: "manifest",
      generation: board.generation,
      snapshot: Y.encodeStateAsUpdate(source),
      stateVector: Y.encodeStateVector(source),
    });
    coordinator = new BoardCompactionCoordinator(repository, {
      policy: {
        minUpdateCount: 2,
        minUpdateBytes: 1024 * 1024,
        scheduleDelayMs: 5,
      },
    });
  });

  afterEach(() => {
    coordinator.close();
    source.destroy();
    vi.useRealTimers();
    db.close();
  });

  it("leaves a small durable log untouched", () => {
    appendMapChange(repository, board, fixture.tutorId, source, "a", "1");
    expect(coordinator.compactIfNeeded({
      boardId: board.id,
      documentKey: "manifest",
      generation: board.generation,
    })).toBeNull();
    expect(repository.getBoardMetrics({
      boardId: board.id,
      generation: board.generation,
    }).updateLogCount).toBe(1);
  });

  it("rebuilds and compacts through the durable high-water sequence", () => {
    appendMapChange(repository, board, fixture.tutorId, source, "a", "1");
    appendMapChange(repository, board, fixture.tutorId, source, "b", "2");

    const result = coordinator.compactIfNeeded({
      boardId: board.id,
      documentKey: "manifest",
      generation: board.generation,
    });

    expect(result).toMatchObject({
      deletedUpdateCount: 2,
      remainingUpdateCount: 0,
    });
    const loaded = repository.loadDocument({
      boardId: board.id,
      documentKey: "manifest",
      generation: board.generation,
    });
    const restored = new Y.Doc();
    Y.applyUpdate(restored, loaded.document.snapshot);
    expect(restored.getMap<string>("content").toJSON()).toEqual({
      a: "1",
      b: "2",
    });
    expect(Y.encodeStateVector(restored)).toEqual(
      loaded.document.stateVector,
    );
    restored.destroy();
  });

  it("runs scheduled compaction outside the caller path", async () => {
    vi.useFakeTimers();
    appendMapChange(repository, board, fixture.tutorId, source, "a", "1");
    appendMapChange(repository, board, fixture.tutorId, source, "b", "2");
    const identity = {
      boardId: board.id,
      documentKey: "manifest",
      generation: board.generation,
    };

    coordinator.schedule(identity);
    expect(repository.getBoardMetrics(identity).updateLogCount).toBe(2);
    vi.advanceTimersByTime(5);
    expect(repository.getBoardMetrics(identity).updateLogCount).toBe(2);
    await coordinator.whenIdle();
    expect(repository.getBoardMetrics(identity).updateLogCount).toBe(0);
  });

  it("retains incremental updates instead of creating an unsyncable snapshot", async () => {
    appendMapChange(repository, board, fixture.tutorId, source, "a", "1");
    appendMapChange(repository, board, fixture.tutorId, source, "b", "2");
    coordinator.close();
    coordinator = new BoardCompactionCoordinator(repository, {
      reconstructInBackground: async () => ({
        snapshot: new Uint8Array(
          BOARD_PROTOCOL_LIMITS.maxUpdateBytes + 1,
        ),
        stateVector: Y.encodeStateVector(source),
      }),
    });

    const result = await coordinator.compactIfNeededInBackground({
      boardId: board.id,
      documentKey: "manifest",
      generation: board.generation,
    }, true);

    expect(result).toBeNull();
    expect(repository.getBoardMetrics({
      boardId: board.id,
      generation: board.generation,
    }).updateLogCount).toBe(2);
  });

  it("reads a file-backed durable log inside the worker", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "eduri-compaction-"));
    const databasePath = path.join(directory, "worker.sqlite");
    const fileDb = new Database(databasePath);
    let fileCoordinator: BoardCompactionCoordinator | undefined;
    let fileSource: Y.Doc | undefined;
    try {
      fileDb.pragma("foreign_keys = ON");
      fileDb.pragma("journal_mode = WAL");
      migrate(fileDb);
      const fileFixture = insertFixture(fileDb);
      const fileRepository = new BoardRepository(fileDb);
      const fileBoard = fileRepository.createBoardForLesson(
        fileFixture.lessonId,
        { engine: "v2" },
      );
      fileSource = new Y.Doc();
      fileRepository.initializeEmptyDocument({
        boardId: fileBoard.id,
        documentKey: "manifest",
        generation: fileBoard.generation,
        snapshot: Y.encodeStateAsUpdate(fileSource),
        stateVector: Y.encodeStateVector(fileSource),
      });
      appendMapChange(
        fileRepository,
        fileBoard,
        fileFixture.tutorId,
        fileSource,
        "a",
        "1",
      );
      appendMapChange(
        fileRepository,
        fileBoard,
        fileFixture.tutorId,
        fileSource,
        "b",
        "2",
      );
      fileCoordinator = new BoardCompactionCoordinator(fileRepository);
      const load = vi.spyOn(fileRepository, "loadDocument")
        .mockImplementation(() => {
          throw new Error("main-thread loadDocument must not run");
        });

      const result = await fileCoordinator.compactIfNeededInBackground({
        boardId: fileBoard.id,
        documentKey: "manifest",
        generation: fileBoard.generation,
      }, true);

      expect(result).toMatchObject({
        deletedUpdateCount: 2,
        remainingUpdateCount: 0,
      });
      expect(load).not.toHaveBeenCalled();
      load.mockRestore();
      const restored = new Y.Doc();
      const loaded = fileRepository.loadDocument({
        boardId: fileBoard.id,
        documentKey: "manifest",
        generation: fileBoard.generation,
      });
      Y.applyUpdate(restored, loaded.document.snapshot);
      expect(restored.getMap<string>("content").toJSON()).toEqual({
        a: "1",
        b: "2",
      });
      restored.destroy();
    } finally {
      fileCoordinator?.close();
      fileSource?.destroy();
      fileDb.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("backs off an oversized high-water until enough later data and time exist", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-28T00:00:00.000Z"));
    appendMapChange(repository, board, fixture.tutorId, source, "a", "1");
    appendMapChange(repository, board, fixture.tutorId, source, "b", "2");
    coordinator.close();
    const oversized = new Uint8Array(
      BOARD_PROTOCOL_LIMITS.maxUpdateBytes + 1,
    );
    const reconstruct = vi.fn(async () => ({
      snapshot: oversized,
      stateVector: Y.encodeStateVector(source),
    }));
    coordinator = new BoardCompactionCoordinator(repository, {
      policy: {
        minUpdateCount: 2,
        minUpdateBytes: 1024 * 1024,
        oversizedRetryDelayMs: 1_000,
      },
      reconstructInBackground: reconstruct,
    });
    const identity = {
      boardId: board.id,
      documentKey: "manifest",
      generation: board.generation,
    };

    await coordinator.compactIfNeededInBackground(identity);
    appendMapChange(repository, board, fixture.tutorId, source, "c", "3");
    appendMapChange(repository, board, fixture.tutorId, source, "d", "4");
    await coordinator.compactIfNeededInBackground(identity);
    expect(reconstruct).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(1_000);
    await coordinator.compactIfNeededInBackground(identity);
    expect(reconstruct).toHaveBeenCalledTimes(2);
    expect(repository.getBoardMetrics(identity).updateLogCount).toBe(4);
  });

  it("coalesces schedules received while oversized reconstruction is in flight", async () => {
    vi.useFakeTimers();
    appendMapChange(repository, board, fixture.tutorId, source, "a", "1");
    appendMapChange(repository, board, fixture.tutorId, source, "b", "2");
    coordinator.close();
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const oversized = new Uint8Array(
      BOARD_PROTOCOL_LIMITS.maxUpdateBytes + 1,
    );
    const reconstruct = vi.fn(async () => {
      await firstGate;
      return {
        snapshot: oversized,
        stateVector: Y.encodeStateVector(source),
      };
    });
    coordinator = new BoardCompactionCoordinator(repository, {
      policy: {
        minUpdateCount: 2,
        minUpdateBytes: 1024 * 1024,
        scheduleDelayMs: 5,
        oversizedRetryDelayMs: 60_000,
      },
      reconstructInBackground: reconstruct,
    });
    const identity = {
      boardId: board.id,
      documentKey: "manifest",
      generation: board.generation,
    };

    coordinator.schedule(identity);
    await vi.advanceTimersByTimeAsync(5);
    expect(reconstruct).toHaveBeenCalledTimes(1);
    appendMapChange(repository, board, fixture.tutorId, source, "c", "3");
    coordinator.schedule(identity);
    await vi.advanceTimersByTimeAsync(5);
    appendMapChange(repository, board, fixture.tutorId, source, "d", "4");
    coordinator.schedule(identity);
    await vi.advanceTimersByTimeAsync(5);

    releaseFirst();
    await coordinator.whenIdle();
    await vi.advanceTimersByTimeAsync(5);
    await coordinator.whenIdle();

    expect(reconstruct).toHaveBeenCalledTimes(1);
    expect(repository.getBoardMetrics(identity).updateLogCount).toBe(4);
  });

  it("does not commit a reconstruction that resolves after close", async () => {
    appendMapChange(repository, board, fixture.tutorId, source, "a", "1");
    appendMapChange(repository, board, fixture.tutorId, source, "b", "2");
    coordinator.close();
    let release!: (
      reconstructed: { snapshot: Uint8Array; stateVector: Uint8Array },
    ) => void;
    let captured: LoadedBoardDocument | undefined;
    coordinator = new BoardCompactionCoordinator(repository, {
      reconstructInBackground: (loaded) => {
        captured = loaded;
        return new Promise((resolve) => {
          release = resolve;
        });
      },
    });
    const identity = {
      boardId: board.id,
      documentKey: "manifest",
      generation: board.generation,
    };

    const pending = coordinator.compactIfNeededInBackground(identity, true);
    expect(captured).toBeDefined();
    coordinator.close();
    release(reconstructLoaded(captured!));

    await expect(pending).resolves.toBeNull();
    expect(repository.getBoardMetrics(identity).updateLogCount).toBe(2);
  });
});

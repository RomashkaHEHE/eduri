import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp, getAppContext } from "./app.js";
import { migrate } from "./db.js";
import {
  LIVEKIT_REVOCATION_MAX_ATTEMPTS,
  LIVEKIT_REVOCATION_MAX_BACKOFF_MS,
  enqueueLiveKitRoomRevocation,
  processLiveKitRoomRevocations,
  type LiveKitRevocationClient,
} from "./livekit-revocation.js";
import { persistUserAccessRevocation } from "./security.js";
import type { AppContext } from "./types.js";

const NOW = Date.parse("2026-08-09T12:00:00.000Z");
const roots: string[] = [];
const appContexts: AppContext[] = [];

function openMemoryDatabase(targetVersion?: number): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  migrate(db, targetVersion === undefined ? {} : { targetVersion });
  return db;
}

function client(
  overrides: Partial<LiveKitRevocationClient> = {},
): LiveKitRevocationClient {
  return {
    deleteRoom: async () => undefined,
    ...overrides,
  };
}

function appHarness(service: LiveKitRevocationClient): AppContext {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "eduri-livekit-outbox-"));
  roots.push(dataDir);
  const app = createApp({
    config: {
      nodeEnv: "test",
      appOrigins: ["http://eduri.test"],
      dataDir,
      databasePath: path.join(dataDir, "test.sqlite"),
      uploadDir: path.join(dataDir, "uploads"),
      authLookupKey: "livekit-outbox-test-key-at-least-32-bytes",
      livekitUrl: "ws://127.0.0.1:7880",
      livekitApiKey: "test-api-key",
      livekitApiSecret: "test-api-secret-at-least-32-bytes",
    },
    livekitRoomService: {
      ...service,
      createRoom: async () => undefined,
      listRooms: async () => [],
      removeParticipant: async () => undefined,
    },
  });
  const context = getAppContext(app);
  appContexts.push(context);
  return context;
}

afterEach(() => {
  for (const context of appContexts.splice(0)) {
    context.stopBoardAssetMaintenance?.();
    context.stopGuestRoomMaintenance?.();
    context.stopMaterialFileMaintenance?.();
    if (context.db.open) context.db.close();
  }
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("durable LiveKit revocation outbox", () => {
  it("installs the v21 outbox and guest call generation additively", () => {
    const db = openMemoryDatabase(20);
    try {
      expect(db.prepare(`
        SELECT name FROM sqlite_master
        WHERE type = 'table' AND name = 'livekit_room_revocation_outbox'
      `).get()).toBeUndefined();
      expect((db.prepare("PRAGMA table_info(guest_room_resources)").all() as Array<{
        name: string;
      }>).map((column) => column.name)).not.toContain("call_room_generation");

      migrate(db, { targetVersion: 21 });

      expect(db.prepare(`
        SELECT name FROM sqlite_master
        WHERE type = 'table' AND name = 'livekit_room_revocation_outbox'
      `).get()).toEqual({ name: "livekit_room_revocation_outbox" });
      expect((db.prepare(`
        PRAGMA table_info(livekit_room_revocation_outbox)
      `).all() as Array<{ name: string }>).map((column) => column.name))
        .toEqual([
          "room_name",
          "generation",
          "enqueued_at",
          "next_attempt_at",
          "attempts",
          "last_error_code",
        ]);
      expect((db.prepare("PRAGMA table_info(guest_room_resources)").all() as Array<{
        name: string;
      }>).map((column) => column.name)).toContain("call_room_generation");
    } finally {
      db.close();
    }
  });

  it("acknowledges an idempotent 404", async () => {
    const db = openMemoryDatabase();
    try {
      enqueueLiveKitRoomRevocation(db, {
        roomName: "eduri-room-not-found",
      }, new Date(NOW).toISOString());
      const result = await processLiveKitRoomRevocations(db, client({
        deleteRoom: async () => Promise.reject({ status: 404 }),
      }), { now: NOW });

      expect(result).toEqual({ selected: 1, acknowledged: 1, deferred: 0 });
      expect(db.prepare(
        "SELECT count(*) AS count FROM livekit_room_revocation_outbox",
      ).get()).toEqual({ count: 0 });
    } finally {
      db.close();
    }
  });

  it("retains permanent failures after attempt 30 with capped backoff and no raw error", async () => {
    const db = openMemoryDatabase();
    let clock = NOW;
    try {
      enqueueLiveKitRoomRevocation(db, {
        roomName: "eduri-room-permanent-failure",
      }, new Date(NOW).toISOString());
      db.prepare(`
        UPDATE livekit_room_revocation_outbox
        SET attempts = ?, next_attempt_at = ?
      `).run(
        LIVEKIT_REVOCATION_MAX_ATTEMPTS,
        new Date(NOW).toISOString(),
      );
      const failingClient = client({
        deleteRoom: async () => {
          clock += 30_000;
          throw new Error("private credential and JWT must never be stored");
        },
      });

      const first = await processLiveKitRoomRevocations(db, failingClient, {
        now: NOW,
        clock: () => clock,
      });
      expect(first).toEqual({ selected: 1, acknowledged: 0, deferred: 1 });
      const row = db.prepare(`
        SELECT attempts, next_attempt_at, last_error_code
        FROM livekit_room_revocation_outbox
      `).get() as {
        attempts: number;
        next_attempt_at: string;
        last_error_code: string;
      };
      expect(row).toEqual({
        attempts: LIVEKIT_REVOCATION_MAX_ATTEMPTS,
        next_attempt_at: new Date(
          clock + LIVEKIT_REVOCATION_MAX_BACKOFF_MS,
        ).toISOString(),
        last_error_code: "room_delete_failed",
      });
      expect(JSON.stringify(row)).not.toMatch(/credential|JWT|request details/u);

      expect(await processLiveKitRoomRevocations(db, failingClient, {
        now: Date.parse(row.next_attempt_at) - 1,
      })).toEqual({ selected: 0, acknowledged: 0, deferred: 0 });

      clock = Date.parse(row.next_attempt_at);
      expect((await processLiveKitRoomRevocations(db, failingClient, {
        now: clock,
        clock: () => clock,
      })).deferred).toBe(1);
      expect(db.prepare(`
        SELECT attempts FROM livekit_room_revocation_outbox
      `).get()).toEqual({ attempts: LIVEKIT_REVOCATION_MAX_ATTEMPTS });
    } finally {
      db.close();
    }
  });

  it("keeps a concurrently re-enqueued generation while DeleteRoom is in flight", async () => {
    const db = openMemoryDatabase();
    let releaseDelete!: () => void;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
      releaseDelete = resolve;
    });
    try {
      enqueueLiveKitRoomRevocation(db, {
        roomName: "eduri-room-generation-race",
      }, new Date(NOW).toISOString());
      const running = processLiveKitRoomRevocations(db, client({
        deleteRoom: async () => {
          markStarted();
          await blocked;
        },
      }), { now: NOW });
      await started;

      enqueueLiveKitRoomRevocation(db, {
        roomName: "eduri-room-generation-race",
      }, new Date(NOW + 1).toISOString());
      releaseDelete();
      expect(await running).toEqual({
        selected: 1,
        acknowledged: 0,
        deferred: 0,
      });
      expect(db.prepare(`
        SELECT generation
        FROM livekit_room_revocation_outbox
      `).get()).toEqual({
        generation: 2,
      });

      expect(await processLiveKitRoomRevocations(db, client(), {
        now: NOW + 1,
      })).toEqual({ selected: 1, acknowledged: 1, deferred: 0 });
    } finally {
      db.close();
    }
  });

  it("survives restart after an RPC failure and acknowledges the retry", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "eduri-livekit-restart-"));
    roots.push(root);
    const databasePath = path.join(root, "restart.sqlite");
    let db = new Database(databasePath);
    db.pragma("foreign_keys = ON");
    migrate(db);
    enqueueLiveKitRoomRevocation(db, {
      roomName: "eduri-room-restart",
    }, new Date(NOW).toISOString());
    const first = await processLiveKitRoomRevocations(db, client({
      deleteRoom: async () => Promise.reject(new Error("management offline")),
    }), { now: NOW });
    expect(first.deferred).toBe(1);
    const retryAt = (db.prepare(`
      SELECT next_attempt_at FROM livekit_room_revocation_outbox
    `).get() as { next_attempt_at: string }).next_attempt_at;
    db.close();

    db = new Database(databasePath);
    db.pragma("foreign_keys = ON");
    migrate(db);
    try {
      expect(await processLiveKitRoomRevocations(db, client(), {
        now: Date.parse(retryAt) - 1,
      })).toEqual({ selected: 0, acknowledged: 0, deferred: 0 });
      expect(await processLiveKitRoomRevocations(db, client(), {
        now: Date.parse(retryAt),
      })).toEqual({ selected: 1, acknowledged: 1, deferred: 0 });
    } finally {
      db.close();
    }
  });

  it("rolls back the room target, capability rotation, and sessions together", async () => {
    const db = openMemoryDatabase();
    const tutorId = "11111111-1111-4111-8111-111111111111";
    const studentId = "22222222-2222-4222-8222-222222222222";
    const lessonId = "33333333-3333-4333-8333-333333333333";
    const meetingKey = "a".repeat(32);
    const timestamp = new Date(NOW).toISOString();
    try {
      db.prepare(`
        INSERT INTO users (
          id, role, status, display_name, created_at, updated_at
        ) VALUES (?, 'tutor', 'active', 'Tutor', ?, ?)
      `).run(tutorId, timestamp, timestamp);
      db.prepare(`
        INSERT INTO users (
          id, role, status, display_name, tutor_id, created_at, updated_at
        ) VALUES (?, 'student', 'active', 'Student', ?, ?, ?)
      `).run(studentId, tutorId, timestamp, timestamp);
      db.prepare(`
        INSERT INTO lessons (
          id, tutor_id, student_id, title, meeting_key, scheduled_at,
          duration_minutes, status, created_at, updated_at
        ) VALUES (?, ?, ?, 'Lesson', ?, ?, 60, 'active', ?, ?)
      `).run(
        lessonId,
        tutorId,
        studentId,
        meetingKey,
        timestamp,
        timestamp,
        timestamp,
      );
      db.prepare(`
        INSERT INTO sessions (
          session_hash, user_id, expires_at, created_at, last_seen_at
        ) VALUES ('session-hash', ?, ?, ?, ?)
      `).run(tutorId, new Date(NOW + 60_000).toISOString(), timestamp, timestamp);
      const context = { db } as AppContext;

      expect(() => db.transaction(() => {
        persistUserAccessRevocation(context, tutorId, { timestamp });
        throw new Error("abort mutation");
      }).immediate()).toThrow("abort mutation");
      expect(db.prepare("SELECT meeting_key FROM lessons WHERE id = ?")
        .get(lessonId)).toEqual({ meeting_key: meetingKey });
      expect(db.prepare("SELECT count(*) AS count FROM sessions").get())
        .toEqual({ count: 1 });
      expect(db.prepare(`
        SELECT count(*) AS count FROM livekit_room_revocation_outbox
      `).get()).toEqual({ count: 0 });

      db.transaction(() => {
        persistUserAccessRevocation(context, tutorId, { timestamp });
      }).immediate();
      expect((db.prepare("SELECT meeting_key FROM lessons WHERE id = ?")
        .get(lessonId) as { meeting_key: string }).meeting_key)
        .not.toBe(meetingKey);
      expect(db.prepare("SELECT count(*) AS count FROM sessions").get())
        .toEqual({ count: 0 });
      expect(db.prepare(`
        SELECT room_name FROM livekit_room_revocation_outbox
      `).get()).toEqual({ room_name: `eduri-${meetingKey}` });
    } finally {
      db.close();
    }
  });
});

describe("LiveKit revocation worker scheduling", () => {
  it("does not miss a trigger enqueued while a prior delete is in flight", async () => {
    let releaseFirst!: () => void;
    let markFirstStarted!: () => void;
    const firstStarted = new Promise<void>((resolve) => {
      markFirstStarted = resolve;
    });
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const deleted: string[] = [];
    const context = appHarness(client({
      deleteRoom: async (roomName) => {
        deleted.push(roomName);
        if (roomName === "eduri-worker-first") {
          markFirstStarted();
          await firstBlocked;
        }
      },
    }));
    await context.runLiveKitRevocationMaintenance?.();
    enqueueLiveKitRoomRevocation(context.db, {
      roomName: "eduri-worker-first",
    });
    const firstRun = context.runLiveKitRevocationMaintenance!();
    await firstStarted;
    enqueueLiveKitRoomRevocation(context.db, {
      roomName: "eduri-worker-second",
    });
    const secondRun = context.runLiveKitRevocationMaintenance!();
    releaseFirst();

    await Promise.all([firstRun, secondRun]);
    expect(deleted).toEqual([
      "eduri-worker-first",
      "eduri-worker-second",
    ]);
    expect(context.db.prepare(`
      SELECT count(*) AS count FROM livekit_room_revocation_outbox
    `).get()).toEqual({ count: 0 });
  });

  it("drains more than one 16-row batch from a single trigger", async () => {
    const deleted: string[] = [];
    const context = appHarness(client({
      deleteRoom: async (roomName) => {
        deleted.push(roomName);
      },
    }));
    await context.runLiveKitRevocationMaintenance?.();
    for (let index = 0; index < 20; index += 1) {
      enqueueLiveKitRoomRevocation(context.db, {
        roomName: `eduri-worker-backlog-${index.toString().padStart(2, "0")}`,
      });
    }

    await context.runLiveKitRevocationMaintenance?.();

    expect(deleted).toHaveLength(20);
    expect(context.db.prepare(`
      SELECT count(*) AS count FROM livekit_room_revocation_outbox
    `).get()).toEqual({ count: 0 });
  });
});

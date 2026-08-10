import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createApp, getAppContext } from "./app.js";
import type { MalwareScanner } from "./code-blobs/malwareScanner.js";
import { lessonCallRoomName, type LiveKitRoomService } from "./livekit.js";
import { MaterialFileService } from "./material-files/service.js";
import {
  csrfForSession,
  randomToken,
  sessionCookieName,
  sha256,
} from "./security.js";
import type { AppContext } from "./types.js";

const AUTH_KEY = "account-deletion-auth-key-at-least-32-bytes";
const NOW = "2026-08-09T08:00:00.000Z";
const FUTURE = "2036-08-09T08:00:00.000Z";
const cleanScanner: MalwareScanner = {
  id: "test-clean-scanner-v1",
  scan: async () => ({ status: "clean" }),
};

interface Harness {
  app: ReturnType<typeof createApp>;
  context: AppContext;
  root: string;
}

interface AuthHeaders {
  cookie: string;
  csrf: string;
}

const harnesses: Harness[] = [];

function roomService(overrides: Partial<LiveKitRoomService> = {}): LiveKitRoomService {
  return {
    createRoom: async () => undefined,
    listRooms: async () => [],
    removeParticipant: async () => undefined,
    deleteRoom: async () => undefined,
    ...overrides,
  };
}

function createHarness(service = roomService()): Harness {
  const root = mkdtempSync(path.join(os.tmpdir(), "eduri-account-delete-"));
  const app = createApp({
    config: {
      nodeEnv: "test",
      appOrigins: ["http://eduri.test"],
      dataDir: root,
      databasePath: path.join(root, "account.sqlite"),
      uploadDir: path.join(root, "materials"),
      authLookupKey: AUTH_KEY,
      adminLogin: "delete-admin",
      adminPassword: "delete-admin-password",
      bcryptRounds: 4,
      livekitUrl: "ws://livekit.eduri.test",
      livekitApiKey: "delete-livekit-key",
      livekitApiSecret: "delete-livekit-secret-at-least-32-bytes",
    },
    codeBlobScanner: cleanScanner,
    livekitRoomService: service,
  });
  const context = getAppContext(app);
  context.stopMaterialFileMaintenance?.();
  context.stopGuestRoomMaintenance?.();
  context.stopBoardAssetMaintenance?.();
  const harness = { app, context, root };
  harnesses.push(harness);
  return harness;
}

function insertTutor(context: AppContext, displayName = "Deletion tutor"): string {
  const id = randomUUID();
  context.db.prepare(`
    INSERT INTO users (
      id, role, status, display_name, login_name, login_name_normalized,
      password_hash, created_at, updated_at
    ) VALUES (?, 'tutor', 'active', ?, ?, ?, 'test-password-hash', ?, ?)
  `).run(id, displayName, id, id, NOW, NOW);
  return id;
}

function insertStudent(context: AppContext, tutorId: string): string {
  const id = randomUUID();
  context.db.prepare(`
    INSERT INTO users (
      id, role, status, display_name, login_name, login_name_normalized,
      password_hash, tutor_id, created_at, updated_at
    ) VALUES (?, 'student', 'active', 'Deletion student', ?, ?,
      'test-password-hash', ?, ?, ?)
  `).run(id, id, id, tutorId, NOW, NOW);
  return id;
}

function insertLesson(context: AppContext, tutorId: string, studentId: string): {
  lessonId: string;
  meetingKey: string;
} {
  const lessonId = randomUUID();
  const meetingKey = randomToken(24);
  context.db.prepare(`
    INSERT INTO lessons (
      id, tutor_id, student_id, title, meeting_key, scheduled_at,
      duration_minutes, status, created_at, updated_at
    ) VALUES (?, ?, ?, 'Deletion lesson', ?, ?, 60, 'active', ?, ?)
  `).run(lessonId, tutorId, studentId, meetingKey, FUTURE, NOW, NOW);
  return { lessonId, meetingKey };
}

function authenticate(context: AppContext, userId: string): AuthHeaders {
  const token = randomToken();
  const timestamp = new Date().toISOString();
  context.db.prepare(`
    INSERT INTO sessions (
      session_hash, user_id, expires_at, created_at, last_seen_at
    ) VALUES (?, ?, ?, ?, ?)
  `).run(sha256(token), userId, FUTURE, timestamp, timestamp);
  return {
    cookie: `${sessionCookieName(context)}=${token}`,
    csrf: csrfForSession(AUTH_KEY, token),
  };
}

function mutation(
  harness: Harness,
  auth: AuthHeaders,
  method: "delete" | "patch",
  url: string,
) {
  return request(harness.app)[method](url)
    .set("Cookie", auth.cookie)
    .set("x-csrf-token", auth.csrf);
}

afterEach(() => {
  for (const harness of harnesses.splice(0)) {
    if (harness.context.db.open) harness.context.db.close();
    rmSync(harness.root, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
});

describe("student deletion revocation boundary", () => {
  it("revokes sessions and realtime, closes LiveKit, then cascades the account", async () => {
    const removed: Array<{ room: string; identity: string; revokeTokenTs?: bigint }> = [];
    const deleted: string[] = [];
    const liveRooms = new Set<string>();
    let harness!: Harness;
    const service = roomService({
      createRoom: async ({ name }) => {
        liveRooms.add(name);
      },
      removeParticipant: async (room, identity, options) => {
        const studentSession = harness.context.db.prepare(`
          SELECT 1 FROM sessions s JOIN users u ON u.id = s.user_id
          WHERE u.role = 'student'
        `).get();
        expect(studentSession).toBeUndefined();
        expect(harness.context.db.prepare(`
          SELECT status FROM users WHERE role = 'student'
        `).get()).toEqual({ status: "suspended" });
        expect(harness.context.db.prepare("SELECT 1 FROM lessons LIMIT 1").get())
          .toEqual({ 1: 1 });
        removed.push({ room, identity, revokeTokenTs: options?.revokeTokenTs });
      },
      deleteRoom: async (room) => {
        expect(harness.context.db.prepare("SELECT 1 FROM lessons LIMIT 1").get())
          .toEqual({ 1: 1 });
        liveRooms.delete(room);
        deleted.push(room);
      },
    });
    harness = createHarness(service);
    const tutorId = insertTutor(harness.context);
    const studentId = insertStudent(harness.context, tutorId);
    const lesson = insertLesson(harness.context, tutorId, studentId);
    const tutorAuth = authenticate(harness.context, tutorId);
    const studentAuth = authenticate(harness.context, studentId);
    const disconnect = vi.fn();
    harness.context.disconnectUserSockets = disconnect;

    const issued = await request(harness.app)
      .post(`/api/lessons/${lesson.lessonId}/call-token`)
      .set("Cookie", studentAuth.cookie)
      .set("x-csrf-token", studentAuth.csrf)
      .expect(200);
    expect(issued.body.token).toEqual(expect.any(String));
    expect(liveRooms.has(lessonCallRoomName(lesson.meetingKey))).toBe(true);

    await mutation(harness, tutorAuth, "delete", `/api/students/${studentId}`)
      .expect(204);

    const expectedRoom = lessonCallRoomName(lesson.meetingKey);
    expect(removed).toEqual([{
      room: expectedRoom,
      identity: `student:${studentId}`,
      revokeTokenTs: expect.any(BigInt),
    }]);
    expect(deleted).toEqual([expectedRoom, expectedRoom]);
    expect(liveRooms.has(expectedRoom)).toBe(false);
    expect(disconnect).toHaveBeenCalledWith(studentId);
    expect(harness.context.db.prepare("SELECT 1 FROM users WHERE id = ?").get(studentId))
      .toBeUndefined();
    expect(harness.context.db.prepare("SELECT 1 FROM lessons WHERE id = ?").get(lesson.lessonId))
      .toBeUndefined();
    expect(harness.context.db.prepare(`
      SELECT action, target_id FROM audit_log
      WHERE action = 'student.deleted' AND target_id = ?
    `).get(studentId)).toEqual({ action: "student.deleted", target_id: studentId });
    await request(harness.app)
      .get("/api/auth/me")
      .set("Cookie", studentAuth.cookie)
      .expect(401);
  });

  it("fails closed when LiveKit cannot delete the room and succeeds on retry", async () => {
    const deleteRoom = vi.fn(async () => { throw new Error("LiveKit unavailable"); });
    const harness = createHarness(roomService({ deleteRoom }));
    const tutorId = insertTutor(harness.context);
    const studentId = insertStudent(harness.context, tutorId);
    const lesson = insertLesson(harness.context, tutorId, studentId);
    const tutorAuth = authenticate(harness.context, tutorId);
    authenticate(harness.context, studentId);
    const disconnect = vi.fn();
    harness.context.disconnectUserSockets = disconnect;

    await mutation(harness, tutorAuth, "delete", `/api/students/${studentId}`)
      .expect(503);
    expect(harness.context.db.prepare("SELECT status FROM users WHERE id = ?").get(studentId))
      .toEqual({ status: "suspended" });
    expect(harness.context.db.prepare("SELECT 1 FROM lessons WHERE id = ?").get(lesson.lessonId))
      .toEqual({ 1: 1 });
    expect(harness.context.db.prepare("SELECT 1 FROM sessions WHERE user_id = ?").get(studentId))
      .toBeUndefined();
    expect(harness.context.db.prepare(`
      SELECT room_name
      FROM livekit_room_revocation_outbox
    `).get()).toEqual({
      room_name: lessonCallRoomName(lesson.meetingKey),
    });
    expect(harness.context.db.prepare(`
      SELECT 1 FROM audit_log WHERE action = 'student.deleted' AND target_id = ?
    `).get(studentId)).toBeUndefined();
    expect(disconnect).toHaveBeenCalledWith(studentId);

    harness.context.livekitRoomService = roomService();
    await mutation(harness, tutorAuth, "delete", `/api/students/${studentId}`)
      .expect(204);
    expect(harness.context.db.prepare("SELECT 1 FROM users WHERE id = ?").get(studentId))
      .toBeUndefined();
  });

  it("restores the durable room target when the post-rotation delete fails", async () => {
    let deleteAttempt = 0;
    const harness = createHarness(roomService({
      deleteRoom: async () => {
        deleteAttempt += 1;
        if (deleteAttempt === 2) throw new Error("second delete unavailable");
      },
    }));
    const tutorId = insertTutor(harness.context);
    const studentId = insertStudent(harness.context, tutorId);
    const lesson = insertLesson(harness.context, tutorId, studentId);
    const tutorAuth = authenticate(harness.context, tutorId);

    await mutation(harness, tutorAuth, "delete", `/api/students/${studentId}`)
      .expect(503);
    expect(deleteAttempt).toBe(2);
    expect(harness.context.db.prepare(`
      SELECT meeting_key FROM lessons WHERE id = ?
    `).get(lesson.lessonId)).toEqual({ meeting_key: lesson.meetingKey });
    expect(harness.context.db.prepare(
      "SELECT status FROM users WHERE id = ?",
    ).get(studentId)).toEqual({ status: "suspended" });

    harness.context.livekitRoomService = roomService();
    await mutation(harness, tutorAuth, "delete", `/api/students/${studentId}`)
      .expect(204);
  });

  it("rolls back audit and cascade on a database abort after LiveKit revocation", async () => {
    const service = roomService({
      removeParticipant: vi.fn(async () => undefined),
      deleteRoom: vi.fn(async () => undefined),
    });
    const harness = createHarness(service);
    const tutorId = insertTutor(harness.context);
    const studentId = insertStudent(harness.context, tutorId);
    insertLesson(harness.context, tutorId, studentId);
    const tutorAuth = authenticate(harness.context, tutorId);
    authenticate(harness.context, studentId);
    harness.context.db.exec(`
      CREATE TRIGGER test_abort_student_delete
      BEFORE DELETE ON users WHEN OLD.id = '${studentId}'
      BEGIN
        SELECT RAISE(ABORT, 'simulated student delete abort');
      END;
    `);

    await mutation(harness, tutorAuth, "delete", `/api/students/${studentId}`)
      .expect(409);
    expect(harness.context.db.prepare("SELECT status FROM users WHERE id = ?").get(studentId))
      .toEqual({ status: "suspended" });
    expect(harness.context.db.prepare("SELECT 1 FROM sessions WHERE user_id = ?").get(studentId))
      .toBeUndefined();
    expect(harness.context.db.prepare(`
      SELECT 1 FROM audit_log WHERE action = 'student.deleted' AND target_id = ?
    `).get(studentId)).toBeUndefined();
    expect(service.deleteRoom).toHaveBeenCalledTimes(2);
  });

  it("does not cascade an account reactivated while LiveKit cleanup is in flight", async () => {
    let release!: () => void;
    const entered = new Promise<void>((resolve) => {
      release = resolve;
    });
    let markEntered!: () => void;
    const called = new Promise<void>((resolve) => { markEntered = resolve; });
    const harness = createHarness(roomService({
      removeParticipant: async () => {
        markEntered();
        await entered;
      },
    }));
    const tutorId = insertTutor(harness.context);
    const studentId = insertStudent(harness.context, tutorId);
    const lesson = insertLesson(harness.context, tutorId, studentId);
    const tutorAuth = authenticate(harness.context, tutorId);

    const deletion = Promise.resolve(mutation(
      harness,
      tutorAuth,
      "delete",
      `/api/students/${studentId}`,
    ).expect(409));
    await called;
    harness.context.db.prepare(`
      UPDATE users SET status = 'active' WHERE id = ?
    `).run(studentId);
    release();
    await deletion;

    expect(harness.context.db.prepare("SELECT status FROM users WHERE id = ?").get(studentId))
      .toEqual({ status: "active" });
    expect(harness.context.db.prepare("SELECT 1 FROM lessons WHERE student_id = ?").get(studentId))
      .toEqual({ 1: 1 });
    expect(harness.context.db.prepare(`
      SELECT meeting_key FROM lessons WHERE id = ?
    `).get(lesson.lessonId)).not.toEqual({ meeting_key: lesson.meetingKey });
  });

  it("does not provision a lesson room while either participant is suspended", async () => {
    const createRoom = vi.fn(async () => undefined);
    const harness = createHarness(roomService({
      createRoom,
      deleteRoom: async () => {
        throw new Error("LiveKit unavailable");
      },
    }));
    const tutorId = insertTutor(harness.context);
    const studentId = insertStudent(harness.context, tutorId);
    const lesson = insertLesson(harness.context, tutorId, studentId);
    const tutorAuth = authenticate(harness.context, tutorId);

    await mutation(harness, tutorAuth, "delete", `/api/students/${studentId}`)
      .expect(503);
    expect(harness.context.db.prepare(
      "SELECT status FROM users WHERE id = ?",
    ).get(studentId)).toEqual({ status: "suspended" });

    await request(harness.app)
      .post(`/api/lessons/${lesson.lessonId}/call-token`)
      .set("Cookie", tutorAuth.cookie)
      .set("x-csrf-token", tutorAuth.csrf)
      .expect(403);
    expect(createRoom).not.toHaveBeenCalled();
  });

  it("deletes a room provisioned after revocation won the race", async () => {
    let releaseProvisioning!: () => void;
    const provisioningGate = new Promise<void>((resolve) => {
      releaseProvisioning = resolve;
    });
    let markProvisioning!: () => void;
    const provisioningStarted = new Promise<void>((resolve) => {
      markProvisioning = resolve;
    });
    const liveRooms = new Set<string>();
    const deleteRoom = vi.fn(async (room: string) => {
      liveRooms.delete(room);
    });
    const harness = createHarness(roomService({
      createRoom: async ({ name }) => {
        markProvisioning();
        await provisioningGate;
        liveRooms.add(name);
      },
      deleteRoom,
    }));
    const tutorId = insertTutor(harness.context);
    const studentId = insertStudent(harness.context, tutorId);
    const lesson = insertLesson(harness.context, tutorId, studentId);
    const tutorAuth = authenticate(harness.context, tutorId);
    const studentAuth = authenticate(harness.context, studentId);

    const tokenRequest = Promise.resolve(request(harness.app)
      .post(`/api/lessons/${lesson.lessonId}/call-token`)
      .set("Cookie", studentAuth.cookie)
      .set("x-csrf-token", studentAuth.csrf)
      .expect(403));
    await provisioningStarted;

    await mutation(harness, tutorAuth, "delete", `/api/students/${studentId}`)
      .expect(204);
    releaseProvisioning();
    await tokenRequest;

    const roomName = lessonCallRoomName(lesson.meetingKey);
    expect(deleteRoom).toHaveBeenCalledTimes(3);
    expect(deleteRoom).toHaveBeenNthCalledWith(1, roomName);
    expect(deleteRoom).toHaveBeenNthCalledWith(2, roomName);
    expect(deleteRoom).toHaveBeenNthCalledWith(3, roomName);
    expect(liveRooms.has(roomName)).toBe(false);
  });

  it("does not revoke or delete a foreign tutor's student", async () => {
    const removeParticipant = vi.fn(async () => undefined);
    const harness = createHarness(roomService({ removeParticipant }));
    const ownerId = insertTutor(harness.context, "Owner");
    const attackerId = insertTutor(harness.context, "Other tutor");
    const studentId = insertStudent(harness.context, ownerId);
    insertLesson(harness.context, ownerId, studentId);
    const attackerAuth = authenticate(harness.context, attackerId);
    const disconnect = vi.fn();
    harness.context.disconnectUserSockets = disconnect;

    await mutation(harness, attackerAuth, "delete", `/api/students/${studentId}`)
      .expect(404);
    expect(removeParticipant).not.toHaveBeenCalled();
    expect(disconnect).not.toHaveBeenCalled();
    expect(harness.context.db.prepare("SELECT status FROM users WHERE id = ?").get(studentId))
      .toEqual({ status: "active" });
  });
});

describe("tutor deletion revocation boundary", () => {
  function adminAuth(harness: Harness): AuthHeaders {
    const admin = harness.context.db.prepare(`
      SELECT id FROM users WHERE role = 'admin'
    `).get() as { id: string };
    return authenticate(harness.context, admin.id);
  }

  it("invalidates a previously issued JWT after fail-closed room deletion", async () => {
    const liveRooms = new Set<string>();
    const created: string[] = [];
    const removed: Array<{ room: string; identity: string }> = [];
    const durableTargetPresentAtDelete: boolean[] = [];
    let harness!: Harness;
    const service = roomService({
      createRoom: async ({ name }) => {
        created.push(name);
        liveRooms.add(name);
      },
      removeParticipant: async (room, identity) => {
        expect(harness.context.db.prepare(`
          SELECT status FROM users WHERE role = 'tutor' AND id = ?
        `).get(identity.slice("tutor:".length))).toEqual({
          status: "suspended",
        });
        expect(harness.context.db.prepare(`
          SELECT 1 FROM sessions WHERE user_id = ?
        `).get(identity.slice("tutor:".length))).toBeUndefined();
        removed.push({ room, identity });
      },
      deleteRoom: async (room) => {
        durableTargetPresentAtDelete.push(Boolean(harness.context.db.prepare(`
          SELECT 1 FROM lessons WHERE meeting_key = ?
        `).get(room.slice("eduri-".length))));
        liveRooms.delete(room);
      },
    });
    harness = createHarness(service);
    const deletingTutorId = insertTutor(harness.context, "Deleting tutor");
    const studentOwnerId = insertTutor(harness.context, "Student owner");
    const foreignStudentId = insertStudent(harness.context, studentOwnerId);
    const lesson = insertLesson(
      harness.context,
      deletingTutorId,
      foreignStudentId,
    );
    const tutorAuth = authenticate(harness.context, deletingTutorId);
    const admin = adminAuth(harness);
    const disconnect = vi.fn();
    harness.context.disconnectUserSockets = disconnect;

    const issued = await request(harness.app)
      .post(`/api/lessons/${lesson.lessonId}/call-token`)
      .set("Cookie", tutorAuth.cookie)
      .set("x-csrf-token", tutorAuth.csrf)
      .expect(200);
    const roomName = lessonCallRoomName(lesson.meetingKey);
    expect(issued.body.token).toEqual(expect.any(String));
    expect(liveRooms.has(roomName)).toBe(true);

    await mutation(
      harness,
      admin,
      "delete",
      `/api/tutors/${deletingTutorId}`,
    ).expect(204);

    expect(created).toEqual([roomName]);
    expect(removed).toEqual([{
      room: roomName,
      identity: `tutor:${deletingTutorId}`,
    }]);
    expect(durableTargetPresentAtDelete).toEqual([true, false]);
    expect(liveRooms.has(roomName)).toBe(false);
    // The old JWT has no room-create grant, and production auto_create is
    // disabled. A room absent after revocation therefore cannot be recreated
    // by presenting this still-unexpired bearer token.
    expect(created).toHaveLength(1);
    expect(disconnect).toHaveBeenCalledWith(deletingTutorId);
    expect(harness.context.db.prepare(
      "SELECT 1 FROM users WHERE id = ?",
    ).get(deletingTutorId)).toBeUndefined();
    expect(harness.context.db.prepare(
      "SELECT 1 FROM lessons WHERE id = ?",
    ).get(lesson.lessonId)).toBeUndefined();
    expect(harness.context.db.prepare(
      "SELECT 1 FROM users WHERE id = ?",
    ).get(foreignStudentId)).toEqual({ 1: 1 });
    await request(harness.app)
      .get("/api/auth/me")
      .set("Cookie", tutorAuth.cookie)
      .expect(401);
  });

  it("keeps a tutor suspended and retries after a LiveKit outage", async () => {
    const deleteRoom = vi.fn(async () => {
      throw new Error("LiveKit unavailable");
    });
    const harness = createHarness(roomService({ deleteRoom }));
    const deletingTutorId = insertTutor(harness.context, "Retry tutor");
    const studentOwnerId = insertTutor(harness.context, "Retry student owner");
    const foreignStudentId = insertStudent(harness.context, studentOwnerId);
    const lesson = insertLesson(
      harness.context,
      deletingTutorId,
      foreignStudentId,
    );
    const tutorAuth = authenticate(harness.context, deletingTutorId);
    const admin = adminAuth(harness);
    const disconnect = vi.fn();
    harness.context.disconnectUserSockets = disconnect;

    await mutation(
      harness,
      admin,
      "delete",
      `/api/tutors/${deletingTutorId}`,
    ).expect(503);
    expect(harness.context.db.prepare(
      "SELECT status FROM users WHERE id = ?",
    ).get(deletingTutorId)).toEqual({ status: "suspended" });
    expect(harness.context.db.prepare(
      "SELECT 1 FROM sessions WHERE user_id = ?",
    ).get(deletingTutorId)).toBeUndefined();
    expect(harness.context.db.prepare(
      "SELECT 1 FROM lessons WHERE id = ?",
    ).get(lesson.lessonId)).toEqual({ 1: 1 });
    expect(harness.context.db.prepare(`
      SELECT 1 FROM audit_log
      WHERE action = 'tutor.deleted' AND target_id = ?
    `).get(deletingTutorId)).toBeUndefined();
    expect(disconnect).toHaveBeenCalledWith(deletingTutorId);

    harness.context.livekitRoomService = roomService();
    await mutation(
      harness,
      admin,
      "delete",
      `/api/tutors/${deletingTutorId}`,
    ).expect(204);
    expect(harness.context.db.prepare(
      "SELECT 1 FROM users WHERE id = ?",
    ).get(deletingTutorId)).toBeUndefined();
    expect(harness.context.db.prepare(
      "SELECT 1 FROM users WHERE id = ?",
    ).get(foreignStudentId)).toEqual({ 1: 1 });
    expect(tutorAuth.cookie).toEqual(expect.any(String));
  });
});

describe("tutor material cleanup boundary", () => {
  function insertMaterialFile(harness: Harness, tutorId: string): {
    materialId: string;
    storageKey: string;
    filePath: string;
  } {
    const contents = Buffer.from("durable tutor material");
    const materialId = randomUUID();
    const storageKey = `files/${randomUUID()}`;
    const filePath = path.join(harness.context.materialFiles.storageRoot, storageKey);
    writeFileSync(filePath, contents);
    harness.context.db.prepare(`
      INSERT INTO materials (
        id, tutor_id, title, kind, storage_key, original_file_name,
        mime_type, file_size, created_at, updated_at,
        file_sha256, scan_provider, scanned_at
      ) VALUES (?, ?, 'Tutor file', 'file', ?, 'tutor.bin',
        'application/octet-stream', ?, ?, ?, ?, 'test-clean-scanner-v1', ?)
    `).run(
      materialId,
      tutorId,
      storageKey,
      contents.byteLength,
      NOW,
      NOW,
      createHash("sha256").update(contents).digest("hex"),
      NOW,
    );
    return { materialId, storageKey, filePath };
  }

  function adminAuth(harness: Harness): AuthHeaders {
    const admin = harness.context.db.prepare(`
      SELECT id FROM users WHERE role = 'admin'
    `).get() as { id: string };
    return authenticate(harness.context, admin.id);
  }

  it("queues the file transactionally and removes it after tutor cascade", async () => {
    const harness = createHarness();
    const tutorId = insertTutor(harness.context);
    const file = insertMaterialFile(harness, tutorId);
    const auth = adminAuth(harness);

    await mutation(harness, auth, "delete", `/api/tutors/${tutorId}`).expect(204);

    expect(harness.context.db.prepare("SELECT 1 FROM users WHERE id = ?").get(tutorId))
      .toBeUndefined();
    expect(harness.context.db.prepare("SELECT 1 FROM materials WHERE id = ?").get(file.materialId))
      .toBeUndefined();
    expect(existsSync(file.filePath)).toBe(false);
    expect(harness.context.db.prepare(`
      SELECT COUNT(*) AS count FROM material_file_gc_queue
    `).get()).toEqual({ count: 0 });
    expect(harness.context.db.prepare(`
      SELECT action, target_id FROM audit_log
      WHERE action = 'tutor.deleted' AND target_id = ?
    `).get(tutorId)).toEqual({ action: "tutor.deleted", target_id: tutorId });
  });

  it("rolls back the cleanup outbox when tutor deletion aborts", async () => {
    const harness = createHarness();
    const tutorId = insertTutor(harness.context);
    const file = insertMaterialFile(harness, tutorId);
    const auth = adminAuth(harness);
    harness.context.db.exec(`
      CREATE TRIGGER test_abort_tutor_delete
      BEFORE DELETE ON users WHEN OLD.id = '${tutorId}'
      BEGIN
        SELECT RAISE(ABORT, 'simulated tutor delete abort');
      END;
    `);

    await mutation(harness, auth, "delete", `/api/tutors/${tutorId}`).expect(409);
    expect(harness.context.db.prepare("SELECT 1 FROM users WHERE id = ?").get(tutorId))
      .toEqual({ 1: 1 });
    expect(harness.context.db.prepare("SELECT 1 FROM materials WHERE id = ?").get(file.materialId))
      .toEqual({ 1: 1 });
    expect(existsSync(file.filePath)).toBe(true);
    expect(harness.context.db.prepare(`
      SELECT 1 FROM material_file_gc_queue WHERE storage_key = ?
    `).get(file.storageKey)).toBeUndefined();
    expect(harness.context.db.prepare(`
      SELECT 1 FROM audit_log WHERE action = 'tutor.deleted' AND target_id = ?
    `).get(tutorId)).toBeUndefined();
  });

  it("keeps failed filesystem cleanup durable and succeeds on a later retry", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const harness = createHarness();
    const tutorId = insertTutor(harness.context);
    const file = insertMaterialFile(harness, tutorId);
    const auth = adminAuth(harness);
    harness.context.materialFiles = new MaterialFileService({
      db: harness.context.db,
      scanner: cleanScanner,
      storageRoot: harness.context.config.uploadDir,
      limits: { minFreeDiskBytes: 1 },
      diskFreeBytes: async () => 1_000_000,
      unlinkFileSync: () => { throw new Error("simulated unlink outage"); },
    });

    await mutation(harness, auth, "delete", `/api/tutors/${tutorId}`).expect(204);
    expect(existsSync(file.filePath)).toBe(true);
    expect(harness.context.db.prepare(`
      SELECT attempts FROM material_file_gc_queue WHERE storage_key = ?
    `).get(file.storageKey)).toEqual({ attempts: 1 });

    const restarted = new MaterialFileService({
      db: harness.context.db,
      scanner: cleanScanner,
      storageRoot: harness.context.config.uploadDir,
      limits: { minFreeDiskBytes: 1 },
      diskFreeBytes: async () => 1_000_000,
    });
    await expect(restarted.cleanupGarbage()).resolves.toEqual({ deleted: 1, failed: 0 });
    expect(existsSync(file.filePath)).toBe(false);
    expect(harness.context.db.prepare(`
      SELECT 1 FROM material_file_gc_queue WHERE storage_key = ?
    `).get(file.storageKey)).toBeUndefined();
    log.mockRestore();
  });
});

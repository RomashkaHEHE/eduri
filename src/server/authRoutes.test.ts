import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp, getAppContext } from "./app.js";
import { createInvite } from "./invites.js";
import {
  hashPassword,
  nowIso,
  studentCredentialLookup,
} from "./security.js";

const AUTH_LOOKUP_KEY = "auth-routes-test-lookup-key-at-least-32-bytes";
const ADMIN_LOGIN = "auth-routes-admin";
const ADMIN_PASSWORD = "auth-routes-admin-password";

type Harness = ReturnType<typeof makeHarness>;
const harnesses = new Set<Harness>();

function makeHarness(label: string) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), `eduri-auth-${label}-`));
  const app = createApp({
    config: {
      nodeEnv: "test",
      appOrigins: ["http://eduri.test"],
      dataDir,
      databasePath: path.join(dataDir, "auth.sqlite"),
      uploadDir: path.join(dataDir, "uploads"),
      authLookupKey: AUTH_LOOKUP_KEY,
      adminLogin: ADMIN_LOGIN,
      adminPassword: ADMIN_PASSWORD,
      bcryptRounds: 4,
      trustProxy: 1,
    },
  });
  const harness = { app, context: getAppContext(app), dataDir };
  harnesses.add(harness);
  return harness;
}

function sourceIp(index: number): string {
  const thirdOctet = Math.floor(index / 250);
  const fourthOctet = index % 250 + 1;
  return `198.51.${thirdOctet}.${fourthOctet}`;
}

afterEach(() => {
  for (const harness of harnesses) {
    harness.context.stopBoardAssetMaintenance?.();
    harness.context.stopGuestRoomMaintenance?.();
    harness.context.stopMaterialFileMaintenance?.();
    if (harness.context.db.open) harness.context.db.close();
    fs.rmSync(harness.dataDir, { recursive: true, force: true });
  }
  harnesses.clear();
});

describe("authentication route abuse controls", () => {
  it("limits malformed login traffic by trusted source IP", async () => {
    const harness = makeHarness("ip-limit");
    for (let attempt = 0; attempt < 30; attempt += 1) {
      await request(harness.app)
        .post("/api/auth/login/staff")
        .set("x-forwarded-for", "198.51.100.10")
        .send({})
        .expect(400);
    }

    const limited = await request(harness.app)
      .post("/api/auth/login/staff")
      .set("x-forwarded-for", "198.51.100.10")
      .send({})
      .expect(429)
      .expect("Cache-Control", "no-store");
    expect(limited.headers["retry-after"]).toMatch(/^\d+$/u);
    expect(limited.body).toEqual({
      error: "Слишком много попыток. Попробуйте позже",
    });
  });

  it("shares an account-fingerprint budget across source IPs", async () => {
    const harness = makeHarness("account-limit");
    const knownFailure = await request(harness.app)
      .post("/api/auth/login/staff")
      .set("x-forwarded-for", sourceIp(100))
      .send({ loginName: ADMIN_LOGIN, password: "incorrect-secret" })
      .expect(401);
    const unknownFailure = await request(harness.app)
      .post("/api/auth/login/staff")
      .set("x-forwarded-for", sourceIp(101))
      .send({ loginName: "missing-account", password: "incorrect-secret" })
      .expect(401);
    expect(knownFailure.body).toEqual(unknownFailure.body);

    for (let attempt = 0; attempt < 15; attempt += 1) {
      await request(harness.app)
        .post("/api/auth/login/staff")
        .set("x-forwarded-for", sourceIp(attempt))
        .send({ loginName: "distributed-target", password: "incorrect-secret" })
        .expect(401);
    }

    const limited = await request(harness.app)
      .post("/api/auth/login/staff")
      .set("x-forwarded-for", sourceIp(20))
      .send({ loginName: "distributed-target", password: "incorrect-secret" })
      .expect(429);
    expect(limited.body).toEqual({
      error: "Слишком много попыток. Попробуйте позже",
    });

    await request(harness.app)
      .post("/api/auth/login/staff")
      .set("x-forwarded-for", sourceIp(21))
      .send({ loginName: ADMIN_LOGIN, password: ADMIN_PASSWORD })
      .expect(200);
  });

  it("rate-limits repeated activation-token probing independently of IP", async () => {
    const harness = makeHarness("activation-limit");
    const token = "x".repeat(32);
    for (let attempt = 0; attempt < 10; attempt += 1) {
      await request(harness.app)
        .post("/api/auth/activate/preview")
        .set("x-forwarded-for", sourceIp(attempt))
        .send({ token })
        .expect(410);
    }

    const limited = await request(harness.app)
      .post("/api/auth/activate/preview")
      .set("x-forwarded-for", sourceIp(20))
      .send({ token })
      .expect(429);
    expect(limited.body).toEqual({
      error: "Слишком много попыток. Попробуйте позже",
    });
  });
});

describe("login session transaction", () => {
  it.each(["staff", "student"] as const)(
    "rolls back the %s audit and session when login commit aborts",
    async (role) => {
      const harness = makeHarness(`atomic-${role}-login`);
      const now = nowIso();
      let userId: string;
      let endpoint: string;
      let body: Record<string, string>;

      if (role === "staff") {
        userId = (harness.context.db.prepare(`
          SELECT id FROM users WHERE role = 'admin' AND login_name_normalized = ?
        `).get(ADMIN_LOGIN) as { id: string }).id;
        endpoint = "/api/auth/login/staff";
        body = { loginName: ADMIN_LOGIN, password: ADMIN_PASSWORD };
      } else {
        const tutorId = randomUUID();
        userId = randomUUID();
        const loginName = "atomic-student";
        const codeWord = "existing-student-code";
        harness.context.db.prepare(`
          INSERT INTO users (
            id, role, status, display_name, login_name, login_name_normalized,
            password_hash, created_at, updated_at
          ) VALUES (?, 'tutor', 'active', 'Atomic tutor', 'atomic-tutor',
            'atomic-tutor', ?, ?, ?)
        `).run(
          tutorId,
          hashPassword("atomic-tutor-password", harness.context.config.bcryptRounds),
          now,
          now,
        );
        harness.context.db.prepare(`
          INSERT INTO users (
            id, role, status, display_name, login_name, login_name_normalized,
            credential_lookup, password_hash, tutor_id, created_at, updated_at
          ) VALUES (?, 'student', 'active', 'Atomic student', ?, ?, ?, ?, ?, ?, ?)
        `).run(
          userId,
          loginName,
          loginName,
          studentCredentialLookup(AUTH_LOOKUP_KEY, loginName, codeWord),
          hashPassword(codeWord, harness.context.config.bcryptRounds),
          tutorId,
          now,
          now,
        );
        endpoint = "/api/auth/login/student";
        body = { loginName, codeWord };
      }

      harness.context.db.exec(`
        CREATE TRIGGER test_abort_${role}_login_commit
        BEFORE UPDATE OF last_login_at ON users WHEN OLD.id = '${userId}'
        BEGIN
          SELECT RAISE(ABORT, 'simulated login commit abort');
        END;
      `);

      await request(harness.app)
        .post(endpoint)
        .send(body)
        .expect(409);

      expect(harness.context.db.prepare(`
        SELECT 1 FROM sessions WHERE user_id = ?
      `).get(userId)).toBeUndefined();
      expect(harness.context.db.prepare(`
        SELECT 1 FROM audit_log
        WHERE actor_id = ? AND action = 'auth.login' AND target_id = ?
      `).get(userId, userId)).toBeUndefined();
      expect(harness.context.db.prepare(`
        SELECT last_login_at FROM users WHERE id = ?
      `).get(userId)).toEqual({ last_login_at: null });
    },
  );
});

describe("student credential upgrades", () => {
  it("rejects a common new code without consuming the invitation", async () => {
    const harness = makeHarness("weak-student-code");
    const now = nowIso();
    const tutorId = randomUUID();
    const studentId = randomUUID();
    harness.context.db.prepare(`
      INSERT INTO users (
        id, role, status, display_name, login_name, login_name_normalized,
        password_hash, created_at, updated_at
      ) VALUES (?, 'tutor', 'active', 'Tutor', 'tutor', 'tutor', ?, ?, ?)
    `).run(
      tutorId,
      hashPassword("tutor-password", harness.context.config.bcryptRounds),
      now,
      now,
    );
    harness.context.db.prepare(`
      INSERT INTO users (
        id, role, status, display_name, login_name, login_name_normalized,
        tutor_id, created_at, updated_at
      ) VALUES (?, 'student', 'pending', 'Мария', 'maria', 'maria', ?, ?, ?)
    `).run(studentId, tutorId, now, now);
    const invite = createInvite(
      harness.context,
      studentId,
      "student_activation",
      tutorId,
    );

    const weak = await request(harness.app)
      .post("/api/auth/activate")
      .set("x-forwarded-for", sourceIp(1))
      .send({ token: invite.token, codeWord: "password123" })
      .expect(400);
    expect(weak.body.details.codeWord).toEqual(expect.any(Array));

    await request(harness.app)
      .post("/api/auth/activate/preview")
      .set("x-forwarded-for", sourceIp(2))
      .send({ token: invite.token })
      .expect(200);
    await request(harness.app)
      .post("/api/auth/activate")
      .set("x-forwarded-for", sourceIp(3))
      .send({ token: invite.token, codeWord: "Лиловый кит 47" })
      .expect(200);
  });

  it("continues to authenticate an existing short hashed student code", async () => {
    const harness = makeHarness("legacy-student-code");
    const now = nowIso();
    const tutorId = randomUUID();
    const studentId = randomUUID();
    const loginName = "Legacy Student";
    const legacyCode = "old123";
    harness.context.db.prepare(`
      INSERT INTO users (
        id, role, status, display_name, login_name, login_name_normalized,
        password_hash, created_at, updated_at
      ) VALUES (?, 'tutor', 'active', 'Tutor', 'legacy-tutor', 'legacy-tutor', ?, ?, ?)
    `).run(
      tutorId,
      hashPassword("tutor-password", harness.context.config.bcryptRounds),
      now,
      now,
    );
    harness.context.db.prepare(`
      INSERT INTO users (
        id, role, status, display_name, login_name, login_name_normalized,
        credential_lookup, password_hash, tutor_id, created_at, updated_at
      ) VALUES (?, 'student', 'active', ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      studentId,
      loginName,
      loginName,
      "legacy student",
      studentCredentialLookup(AUTH_LOOKUP_KEY, loginName, legacyCode),
      hashPassword(legacyCode, harness.context.config.bcryptRounds),
      tutorId,
      now,
      now,
    );

    const response = await request(harness.app)
      .post("/api/auth/login/student")
      .set("x-forwarded-for", sourceIp(1))
      .send({ loginName, codeWord: legacyCode })
      .expect(200);
    expect(response.body.user).toMatchObject({ id: studentId, role: "student" });
  });
});

describe("credential-change media revocation", () => {
  it("rotates lesson capabilities and durably queues the old room with the session change", async () => {
    const harness = makeHarness("change-secret-livekit");
    const tutorId = randomUUID();
    const studentId = randomUUID();
    const lessonId = randomUUID();
    const meetingKey = "b".repeat(32);
    const timestamp = nowIso();
    const currentPassword = "current-password-strong";
    harness.context.db.prepare(`
      INSERT INTO users (
        id, role, status, display_name, login_name, login_name_normalized,
        password_hash, created_at, updated_at
      ) VALUES (?, 'tutor', 'active', 'Secret tutor', 'secret-tutor',
        'secret-tutor', ?, ?, ?)
    `).run(
      tutorId,
      hashPassword(currentPassword, harness.context.config.bcryptRounds),
      timestamp,
      timestamp,
    );
    harness.context.db.prepare(`
      INSERT INTO users (
        id, role, status, display_name, tutor_id, created_at, updated_at
      ) VALUES (?, 'student', 'active', 'Secret student', ?, ?, ?)
    `).run(studentId, tutorId, timestamp, timestamp);
    harness.context.db.prepare(`
      INSERT INTO lessons (
        id, tutor_id, student_id, title, meeting_key, scheduled_at,
        duration_minutes, status, created_at, updated_at
      ) VALUES (?, ?, ?, 'Secret rotation', ?, ?, 60, 'active', ?, ?)
    `).run(
      lessonId,
      tutorId,
      studentId,
      meetingKey,
      timestamp,
      timestamp,
      timestamp,
    );
    const deleted: string[] = [];
    harness.context.livekitRoomService = {
      createRoom: async () => undefined,
      listRooms: async () => [],
      removeParticipant: async () => undefined,
      deleteRoom: async (roomName) => {
        deleted.push(roomName);
        throw new Error("management unavailable with private request details");
      },
    };
    const agent = request.agent(harness.app);
    const login = await agent
      .post("/api/auth/login/staff")
      .send({ loginName: "secret-tutor", password: currentPassword })
      .expect(200);

    await agent
      .post("/api/auth/change-secret")
      .set("x-csrf-token", login.body.csrfToken as string)
      .send({
        currentSecret: currentPassword,
        newSecret: "replacement-password-strong",
      })
      .expect(200);

    expect((harness.context.db.prepare(`
      SELECT meeting_key FROM lessons WHERE id = ?
    `).get(lessonId) as { meeting_key: string }).meeting_key).not.toBe(meetingKey);
    expect(harness.context.db.prepare(`
      SELECT count(*) AS count FROM sessions WHERE user_id = ?
    `).get(tutorId)).toEqual({ count: 1 });
    await vi.waitFor(() => expect(deleted).toEqual([`eduri-${meetingKey}`]));
    expect(harness.context.db.prepare(`
      SELECT room_name, attempts, last_error_code
      FROM livekit_room_revocation_outbox
    `).get()).toEqual({
      room_name: `eduri-${meetingKey}`,
      attempts: 1,
      last_error_code: "room_delete_failed",
    });
  });
});

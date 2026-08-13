import fs from "node:fs";
import http, { type Server as HttpServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { io as createSocketClient, type Socket } from "socket.io-client";
import { TokenVerifier } from "livekit-server-sdk";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { createApp, getAppContext } from "./app.js";
import { migrate } from "./db.js";
import { attachRealtime } from "./realtime.js";
import { verifyPassword } from "./security.js";
import {
  LIVEKIT_CALL_ROOM_OPTIONS,
  lessonCallRoomName,
} from "./livekit.js";
import { BoardRepository } from "./board-v2/repository.js";

const ADMIN_LOGIN = "integration-admin";
const ADMIN_PASSWORD = "integration-admin-password";
const TUTOR_PASSWORD = "integration-tutor-password";
const LIVEKIT_API_KEY = "integration-livekit-key";
const LIVEKIT_API_SECRET = "integration-livekit-secret-at-least-32-bytes";

type TestAgent = ReturnType<typeof request.agent>;

interface Harness {
  app: ReturnType<typeof createApp>;
  context: ReturnType<typeof getAppContext>;
  dataDir: string;
}

interface Session {
  agent: TestAgent;
  cookie: string;
  csrf: string;
  user: {
    id: string;
    role: "admin" | "tutor" | "student";
    displayName: string;
  };
}

interface StudentFixture {
  id: string;
  displayName: string;
  codeWord: string;
  inviteToken: string;
  session: Session;
}

interface ResourceFixture {
  lessonId: string;
  materialId: string;
  assignmentId: string;
}

function makeHarness(label: string): Harness {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), `eduri-${label}-`));
  const app = createApp({
    config: {
      nodeEnv: "test",
      appOrigins: ["http://eduri.test"],
      dataDir,
      databasePath: path.join(dataDir, "integration.sqlite"),
      uploadDir: path.join(dataDir, "uploads"),
      authLookupKey: "integration-auth-lookup-key-at-least-32-bytes",
      adminLogin: ADMIN_LOGIN,
      adminPassword: ADMIN_PASSWORD,
      bcryptRounds: 4,
      livekitUrl: "ws://livekit.eduri.test",
      livekitApiKey: LIVEKIT_API_KEY,
      livekitApiSecret: LIVEKIT_API_SECRET,
    },
  });
  const context = getAppContext(app);
  context.livekitRoomService = {
    createRoom: async () => undefined,
    listRooms: async () => [],
    deleteRoom: async () => undefined,
    removeParticipant: async () => undefined,
  };
  return { app, context, dataDir };
}

function disposeHarness(harness: Harness | undefined): void {
  if (!harness) return;
  if (harness.context.db.open) harness.context.db.close();
  fs.rmSync(harness.dataDir, { recursive: true, force: true });
}

async function loginStaff(harness: Harness, loginName: string, password: string): Promise<Session> {
  const agent = request.agent(harness.app);
  const response = await agent
    .post("/api/auth/login/staff")
    .send({ loginName, password })
    .expect(200)
    .expect("Cache-Control", "no-store");

  expect(response.headers["set-cookie"]?.[0]).toContain("eduri_session=");
  expect(response.body.csrfToken).toEqual(expect.any(String));
  return {
    agent,
    cookie: response.headers["set-cookie"]![0].split(";", 1)[0],
    csrf: response.body.csrfToken,
    user: response.body.user,
  };
}

describe("password verification", () => {
  it("yields the event loop while bcrypt compares a production-cost hash", async () => {
    const hash = "$2b$12$RVDkF7BCIAKxxwJ6n9WgdufTiNnY4teiINAek5lROuuYZtrYtzaoS";
    let settled = false;
    const verification = verifyPassword("non-blocking-secret", hash).then((valid) => {
      settled = true;
      return valid;
    });

    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);
    await expect(verification).resolves.toBe(true);
  });
});

async function createTutorWithHarness(
  harness: Harness,
  admin: Session,
  suffix: string,
): Promise<{ id: string; loginName: string; session: Session }> {
  const loginName = `tutor-${suffix}`;
  const response = await admin.agent
    .post("/api/tutors")
    .set("x-csrf-token", admin.csrf)
    .send({ displayName: `Tutor ${suffix}`, loginName, password: TUTOR_PASSWORD })
    .expect(201);
  return {
    id: response.body.tutor.id,
    loginName,
    session: await loginStaff(harness, loginName, TUTOR_PASSWORD),
  };
}

async function createAndActivateStudent(
  harness: Harness,
  tutor: Session,
  displayName: string,
  codeWord: string,
): Promise<StudentFixture> {
  const created = await tutor.agent
    .post("/api/students")
    .set("x-csrf-token", tutor.csrf)
    .send({ displayName })
    .expect(201);
  expect(created.body.student).toMatchObject({ displayName, status: "pending" });
  expect(created.body.invite.token).toEqual(expect.any(String));

  const agent = request.agent(harness.app);
  const activated = await agent
    .post("/api/auth/activate")
    .send({ token: created.body.invite.token, codeWord })
    .expect(200);
  expect(activated.body.user).toMatchObject({
    id: created.body.student.id,
    displayName,
    role: "student",
    status: "active",
  });

  return {
    id: created.body.student.id,
    displayName,
    codeWord,
    inviteToken: created.body.invite.token,
    session: {
      agent,
      cookie: activated.headers["set-cookie"]![0].split(";", 1)[0],
      csrf: activated.body.csrfToken,
      user: activated.body.user,
    },
  };
}

async function createResources(tutor: Session, student: StudentFixture, suffix: string): Promise<ResourceFixture> {
  const lesson = await tutor.agent
    .post("/api/lessons")
    .set("x-csrf-token", tutor.csrf)
    .send({
      studentId: student.id,
      title: `Lesson ${suffix}`,
      scheduledAt: "2030-01-02T10:00:00.000Z",
      durationMinutes: 60,
    })
    .expect(201);

  const material = await tutor.agent
    .post("/api/materials")
    .set("x-csrf-token", tutor.csrf)
    .field("title", `Material ${suffix}`)
    .field("kind", "note")
    .field("body", `Body ${suffix}`)
    .field("studentIds", JSON.stringify([student.id]))
    .expect(201);

  const assignment = await tutor.agent
    .post("/api/assignments")
    .set("x-csrf-token", tutor.csrf)
    .send({
      studentId: student.id,
      title: `Assignment ${suffix}`,
      description: `Description ${suffix}`,
      materialIds: [material.body.material.id],
    })
    .expect(201);

  return {
    lessonId: lesson.body.lesson.id,
    materialId: material.body.material.id,
    assignmentId: assignment.body.assignment.id,
  };
}

describe("authentication, administration, and CSRF", () => {
  let harness: Harness;
  let admin: Session;

  beforeAll(async () => {
    harness = makeHarness("auth");
    admin = await loginStaff(harness, ADMIN_LOGIN, ADMIN_PASSWORD);
  });

  afterAll(() => disposeHarness(harness));

  it("logs the bootstrapped admin in and exposes the same CSRF token through /me", async () => {
    expect(admin.user).toMatchObject({ role: "admin" });
    const me = await admin.agent.get("/api/auth/me").expect(200).expect("Cache-Control", "no-store");
    expect(me.body).toMatchObject({ user: { id: admin.user.id, role: "admin" }, csrfToken: admin.csrf });
  });

  it("requires a valid session-bound CSRF token before the admin can create a tutor", async () => {
    const body = {
      displayName: "CSRF Tutor",
      loginName: "csrf-tutor",
      password: TUTOR_PASSWORD,
    };
    await admin.agent.post("/api/tutors").send(body).expect(403);
    await admin.agent.post("/api/tutors").set("x-csrf-token", "not-the-session-token").send(body).expect(403);

    const created = await admin.agent
      .post("/api/tutors")
      .set("x-csrf-token", admin.csrf)
      .send(body)
      .expect(201);
    expect(created.body.tutor).toMatchObject({ loginName: body.loginName, status: "active" });
  });

  it("rejects failed authentication and exposes no public registration route", async () => {
    await request(harness.app)
      .post("/api/auth/login/staff")
      .send({ loginName: ADMIN_LOGIN, password: "wrong-password" })
      .expect(401);
    await request(harness.app)
      .post("/api/auth/login/student")
      .send({ name: "Unknown", codeWord: "unknown-code" })
      .expect(401);
    await request(harness.app).get("/api/students").expect(401);
    await request(harness.app).post("/api/tutors").send({}).expect(401);
    await request(harness.app).post("/api/auth/signup").send({}).expect(404);
    await request(harness.app).post("/api/auth/register").send({}).expect(404);
  });
});

describe("student invitation and ambiguous display names", () => {
  let harness: Harness;
  let tutor: Session;

  beforeAll(async () => {
    harness = makeHarness("invites");
    const admin = await loginStaff(harness, ADMIN_LOGIN, ADMIN_PASSWORD);
    tutor = (await createTutorWithHarness(harness, admin, "invites")).session;
  });

  afterAll(() => disposeHarness(harness));

  it("lets a tutor create and activate same-named students with different code words", async () => {
    const first = await createAndActivateStudent(harness, tutor, "Artem", "first-code");
    const second = await createAndActivateStudent(harness, tutor, "Artem", "second-code");
    expect(first.id).not.toBe(second.id);

    await request(harness.app)
      .post("/api/auth/activate/preview")
      .send({ token: first.inviteToken })
      .expect(410);
    await request(harness.app)
      .post("/api/auth/activate")
      .send({ token: first.inviteToken, codeWord: "another-code" })
      .expect(410);

    const firstLogin = await request(harness.app)
      .post("/api/auth/login/student")
      .send({ name: "Artem", codeWord: "first-code" })
      .expect(200);
    const secondLogin = await request(harness.app)
      .post("/api/auth/login/student")
      .send({ name: "Artem", codeWord: "second-code" })
      .expect(200);
    expect(firstLogin.body.user.id).toBe(first.id);
    expect(secondLogin.body.user.id).toBe(second.id);

    await request(harness.app)
      .post("/api/auth/login/student")
      .send({ name: "Artem", codeWord: "incorrect-code" })
      .expect(401);
  });

  it("rejects a whitespace-only code word after normalization without consuming the invite", async () => {
    const created = await tutor.agent
      .post("/api/students")
      .set("x-csrf-token", tutor.csrf)
      .send({ displayName: "Whitespace Student" })
      .expect(201);

    await request(harness.app)
      .post("/api/auth/activate")
      .send({ token: created.body.invite.token, codeWord: "      " })
      .expect(400);
    await request(harness.app)
      .post("/api/auth/activate/preview")
      .send({ token: created.body.invite.token })
      .expect(200);
    await request(harness.app)
      .post("/api/auth/activate")
      .send({ token: created.body.invite.token, codeWord: "valid-code" })
      .expect(200);
  });
});

describe("tenant isolation and learning workflows", () => {
  let harness: Harness;
  let tutorA: Session;
  let tutorB: Session;
  let studentA1: StudentFixture;
  let studentA2: StudentFixture;
  let studentB: StudentFixture;
  let resourcesA1: ResourceFixture;
  let resourcesA2: ResourceFixture;
  let resourcesB: ResourceFixture;

  beforeAll(async () => {
    harness = makeHarness("isolation");
    const admin = await loginStaff(harness, ADMIN_LOGIN, ADMIN_PASSWORD);
    tutorA = (await createTutorWithHarness(harness, admin, "a")).session;
    tutorB = (await createTutorWithHarness(harness, admin, "b")).session;
    studentA1 = await createAndActivateStudent(harness, tutorA, "Alex", "alex-code-one");
    studentA2 = await createAndActivateStudent(harness, tutorA, "Alex", "alex-code-two");
    studentB = await createAndActivateStudent(harness, tutorB, "Blake", "blake-code");
    resourcesA1 = await createResources(tutorA, studentA1, "A1");
    resourcesA2 = await createResources(tutorA, studentA2, "A2");
    resourcesB = await createResources(tutorB, studentB, "B");
  });

  afterAll(() => disposeHarness(harness));

  it("accepts only HTTP(S) material links", async () => {
    for (const url of ["javascript:alert(1)", "data:text/html,unsafe", "file:///tmp/private"]) {
      await tutorA.agent
        .post("/api/materials")
        .set("x-csrf-token", tutorA.csrf)
        .field("title", "Unsafe link")
        .field("kind", "link")
        .field("url", url)
        .expect(400);
    }

    await tutorA.agent
      .post("/api/materials")
      .set("x-csrf-token", tutorA.csrf)
      .field("title", "Web link")
      .field("kind", "link")
      .field("url", "https://example.com/task")
      .expect(201);
  });

  it("blocks tutor-to-tutor IDOR for students, lessons, materials, and assignments", async () => {
    const cases = [
      {
        actor: tutorA,
        ownStudent: studentA1,
        foreignStudent: studentB,
        foreign: resourcesB,
      },
      {
        actor: tutorB,
        ownStudent: studentB,
        foreignStudent: studentA1,
        foreign: resourcesA1,
      },
    ];

    for (const testCase of cases) {
      const { actor, ownStudent, foreignStudent, foreign } = testCase;
      await actor.agent.get(`/api/students/${foreignStudent.id}`).expect(404);
      await actor.agent
        .patch(`/api/students/${foreignStudent.id}`)
        .set("x-csrf-token", actor.csrf)
        .send({ note: "cross-tenant edit" })
        .expect(404);

      await actor.agent
        .post("/api/lessons")
        .set("x-csrf-token", actor.csrf)
        .send({ studentId: foreignStudent.id, scheduledAt: "2031-01-01T10:00:00.000Z" })
        .expect(404);
      await actor.agent.get(`/api/lessons/${foreign.lessonId}`).expect(404);
      await actor.agent
        .patch(`/api/lessons/${foreign.lessonId}`)
        .set("x-csrf-token", actor.csrf)
        .send({ title: "cross-tenant edit" })
        .expect(404);

      await actor.agent.get(`/api/materials/${foreign.materialId}`).expect(404);
      await actor.agent
        .patch(`/api/materials/${foreign.materialId}`)
        .set("x-csrf-token", actor.csrf)
        .field("title", "cross-tenant edit")
        .expect(404);
      await actor.agent
        .patch(`/api/materials/${foreign.materialId}/progress`)
        .set("x-csrf-token", actor.csrf)
        .send({ studentId: ownStudent.id, status: "completed" })
        .expect(404);

      await actor.agent
        .post("/api/assignments")
        .set("x-csrf-token", actor.csrf)
        .send({ studentId: foreignStudent.id, title: "Cross-tenant assignment" })
        .expect(404);
      await actor.agent
        .post("/api/assignments")
        .set("x-csrf-token", actor.csrf)
        .send({ studentId: ownStudent.id, title: "Foreign material", materialIds: [foreign.materialId] })
        .expect(404);
      await actor.agent.get(`/api/assignments/${foreign.assignmentId}`).expect(404);
      await actor.agent
        .patch(`/api/assignments/${foreign.assignmentId}`)
        .set("x-csrf-token", actor.csrf)
        .send({ title: "cross-tenant edit" })
        .expect(404);
    }

    const ownerChecks = await Promise.all([
      tutorA.agent.get(`/api/lessons/${resourcesA1.lessonId}`).expect(200),
      tutorA.agent.get(`/api/materials/${resourcesA1.materialId}`).expect(200),
      tutorA.agent.get(`/api/assignments/${resourcesA1.assignmentId}`).expect(200),
      tutorB.agent.get(`/api/lessons/${resourcesB.lessonId}`).expect(200),
      tutorB.agent.get(`/api/materials/${resourcesB.materialId}`).expect(200),
      tutorB.agent.get(`/api/assignments/${resourcesB.assignmentId}`).expect(200),
    ]);
    expect(ownerChecks.map((response) => response.status)).toEqual([200, 200, 200, 200, 200, 200]);
  });

  it("issues a short-lived room-scoped LiveKit token only to lesson participants", async () => {
    const createRoom = vi.fn(async () => undefined);
    harness.context.livekitRoomService!.createRoom = createRoom;
    await tutorA.agent
      .post(`/api/lessons/${resourcesA1.lessonId}/call-token`)
      .expect(403);
    await request(harness.app)
      .post(`/api/lessons/${resourcesA1.lessonId}/call-token`)
      .expect(401);
    await tutorB.agent
      .post(`/api/lessons/${resourcesA1.lessonId}/call-token`)
      .set("x-csrf-token", tutorB.csrf)
      .expect(404);
    await studentA2.session.agent
      .post(`/api/lessons/${resourcesA1.lessonId}/call-token`)
      .set("x-csrf-token", studentA2.session.csrf)
      .expect(404);

    const tutorResponse = await tutorA.agent
      .post(`/api/lessons/${resourcesA1.lessonId}/call-token`)
      .set("x-csrf-token", tutorA.csrf)
      .expect(200)
      .expect("Cache-Control", "no-store");
    const studentResponse = await studentA1.session.agent
      .post(`/api/lessons/${resourcesA1.lessonId}/call-token`)
      .set("x-csrf-token", studentA1.session.csrf)
      .expect(200);

    expect(tutorResponse.body).toMatchObject({
      url: "ws://livekit.eduri.test",
      roomName: expect.stringMatching(/^eduri-[A-Za-z0-9_-]{32}$/u),
      token: expect.any(String),
      expiresAt: expect.any(String),
    });
    expect(studentResponse.body.roomName).toBe(tutorResponse.body.roomName);
    expect(createRoom).toHaveBeenCalledTimes(2);
    expect(createRoom).toHaveBeenNthCalledWith(1, {
      name: tutorResponse.body.roomName,
      ...LIVEKIT_CALL_ROOM_OPTIONS,
    });
    expect(createRoom).toHaveBeenNthCalledWith(2, {
      name: tutorResponse.body.roomName,
      ...LIVEKIT_CALL_ROOM_OPTIONS,
    });
    expect(tutorResponse.body).not.toHaveProperty("apiKey");
    expect(tutorResponse.body).not.toHaveProperty("apiSecret");

    const verifier = new TokenVerifier(LIVEKIT_API_KEY, LIVEKIT_API_SECRET);
    const tutorClaims = await verifier.verify(tutorResponse.body.token);
    const studentClaims = await verifier.verify(studentResponse.body.token);
    expect(tutorClaims).toMatchObject({
      iss: LIVEKIT_API_KEY,
      sub: `tutor:${tutorA.user.id}`,
      name: tutorA.user.displayName,
      attributes: {
        "eduri.role": "tutor",
        "eduri.lessonId": resourcesA1.lessonId,
      },
      video: {
        room: tutorResponse.body.roomName,
        roomJoin: true,
        canPublish: true,
        canSubscribe: true,
        canPublishData: false,
        canPublishSources: [
          "camera",
          "microphone",
          "screen_share",
          "screen_share_audio",
        ],
        canUpdateOwnMetadata: false,
      },
    });
    expect(studentClaims).toMatchObject({
      sub: `student:${studentA1.id}`,
      name: studentA1.displayName,
      video: { room: tutorResponse.body.roomName, roomJoin: true },
    });
    expect(Number(tutorClaims.exp) - Number(tutorClaims.nbf)).toBe(15 * 60);
    expect(tutorClaims.video).not.toHaveProperty("roomAdmin");
    expect(tutorClaims.video).not.toHaveProperty("roomCreate");
  });

  it("shows a student only lessons, materials, and assignments assigned to that account", async () => {
    const lessons = await studentA1.session.agent.get("/api/lessons").expect(200);
    const materials = await studentA1.session.agent.get("/api/materials").expect(200);
    const assignments = await studentA1.session.agent.get("/api/assignments").expect(200);
    expect(lessons.body.lessons.map((item: { id: string }) => item.id)).toEqual([resourcesA1.lessonId]);
    expect(materials.body.materials.map((item: { id: string }) => item.id)).toEqual([resourcesA1.materialId]);
    expect(materials.body.materials[0]).not.toHaveProperty("studentIds");
    expect(assignments.body.assignments.map((item: { id: string }) => item.id)).toEqual([resourcesA1.assignmentId]);

    await studentA1.session.agent.get(`/api/lessons/${resourcesA2.lessonId}`).expect(404);
    await studentA1.session.agent.get(`/api/lessons/${resourcesB.lessonId}`).expect(404);
    await studentA1.session.agent.get(`/api/materials/${resourcesA2.materialId}`).expect(404);
    await studentA1.session.agent.get(`/api/materials/${resourcesB.materialId}`).expect(404);
    await studentA1.session.agent.get(`/api/assignments/${resourcesA2.assignmentId}`).expect(404);
    await studentA1.session.agent.get(`/api/assignments/${resourcesB.assignmentId}`).expect(404);

    await studentA1.session.agent
      .post("/api/lessons")
      .set("x-csrf-token", studentA1.session.csrf)
      .send({ studentId: studentA1.id, scheduledAt: "2031-01-01T10:00:00.000Z" })
      .expect(403);
    await studentA1.session.agent
      .post("/api/assignments")
      .set("x-csrf-token", studentA1.session.csrf)
      .send({ studentId: studentA1.id, title: "Self-assigned" })
      .expect(403);
    await studentA1.session.agent.get("/api/students").expect(403);
  });

  it("supports answer submission, return, resubmission, and final tutor review", async () => {
    const submitted = await studentA1.session.agent
      .post(`/api/assignments/${resourcesA1.assignmentId}/submit`)
      .set("x-csrf-token", studentA1.session.csrf)
      .send({ answer: "First solution" })
      .expect(200);
    expect(submitted.body.assignment).toMatchObject({ status: "submitted", answer: "First solution" });

    await studentA2.session.agent
      .post(`/api/assignments/${resourcesA1.assignmentId}/submit`)
      .set("x-csrf-token", studentA2.session.csrf)
      .send({ answer: "Not mine" })
      .expect(404);
    await tutorB.agent
      .post(`/api/assignments/${resourcesA1.assignmentId}/review`)
      .set("x-csrf-token", tutorB.csrf)
      .send({ status: "reviewed", feedback: "Not my student" })
      .expect(404);

    const returned = await tutorA.agent
      .post(`/api/assignments/${resourcesA1.assignmentId}/review`)
      .set("x-csrf-token", tutorA.csrf)
      .send({ status: "returned", feedback: "Please add the proof" })
      .expect(200);
    expect(returned.body.assignment).toMatchObject({ status: "returned", feedback: "Please add the proof" });

    await studentA1.session.agent
      .patch(`/api/assignments/${resourcesA1.assignmentId}/answer`)
      .set("x-csrf-token", studentA1.session.csrf)
      .send({ answer: "Solution with proof" })
      .expect(200);
    await studentA1.session.agent
      .post(`/api/assignments/${resourcesA1.assignmentId}/submit`)
      .set("x-csrf-token", studentA1.session.csrf)
      .send({})
      .expect(200);

    const reviewed = await tutorA.agent
      .post(`/api/assignments/${resourcesA1.assignmentId}/review`)
      .set("x-csrf-token", tutorA.csrf)
      .send({ status: "reviewed", feedback: "Accepted" })
      .expect(200);
    expect(reviewed.body.assignment).toMatchObject({
      status: "reviewed",
      answer: "Solution with proof",
      feedback: "Accepted",
    });
    expect(reviewed.body.assignment.submittedAt).toEqual(expect.any(String));
    expect(reviewed.body.assignment.reviewedAt).toEqual(expect.any(String));

    await studentA1.session.agent
      .post(`/api/assignments/${resourcesA1.assignmentId}/submit`)
      .set("x-csrf-token", studentA1.session.csrf)
      .send({ answer: "Third attempt" })
      .expect(409);
  });

  it("tracks material progress for the owning tutor and exposes it to only the assigned student", async () => {
    await tutorB.agent
      .patch(`/api/materials/${resourcesA1.materialId}/progress`)
      .set("x-csrf-token", tutorB.csrf)
      .send({ studentId: studentB.id, status: "completed" })
      .expect(404);

    const progress = await tutorA.agent
      .patch(`/api/materials/${resourcesA1.materialId}/progress`)
      .set("x-csrf-token", tutorA.csrf)
      .send({
        studentId: studentA1.id,
        status: "completed",
        lessonId: resourcesA1.lessonId,
      })
      .expect(200);
    expect(progress.body).toMatchObject({
      materialId: resourcesA1.materialId,
      studentId: studentA1.id,
      progressStatus: "completed",
      lessonId: resourcesA1.lessonId,
    });

    const studentMaterials = await studentA1.session.agent.get("/api/materials").expect(200);
    expect(studentMaterials.body.materials).toEqual([
      expect.objectContaining({
        id: resourcesA1.materialId,
        progressStatus: "completed",
        progressLessonId: resourcesA1.lessonId,
      }),
    ]);
    expect(studentMaterials.body.materials[0]).not.toHaveProperty("studentIds");

    const materialDetail = await studentA1.session.agent
      .get(`/api/materials/${resourcesA1.materialId}`)
      .expect(200);
    expect(materialDetail.body.material).toMatchObject({
      id: resourcesA1.materialId,
      progressStatus: "completed",
      progressLessonId: resourcesA1.lessonId,
    });
    expect(materialDetail.body.material).not.toHaveProperty("studentIds");
    await studentA2.session.agent.get(`/api/materials/${resourcesA1.materialId}`).expect(404);
    await studentB.session.agent.get(`/api/materials/${resourcesA1.materialId}`).expect(404);
  });

  it("filters stale lesson-plan materials from the student while preserving the tutor plan", async () => {
    harness.context.db.prepare(`
      INSERT INTO lesson_materials (lesson_id, material_id, position, added_at) VALUES (?, ?, 0, ?)
    `).run(resourcesA1.lessonId, resourcesA2.materialId, new Date().toISOString());

    const tutorLesson = await tutorA.agent.get(`/api/lessons/${resourcesA1.lessonId}`).expect(200);
    expect(tutorLesson.body.lesson.materials.map((material: { id: string }) => material.id))
      .toContain(resourcesA2.materialId);

    const studentLesson = await studentA1.session.agent.get(`/api/lessons/${resourcesA1.lessonId}`).expect(200);
    expect(studentLesson.body.lesson.materials.map((material: { id: string }) => material.id))
      .not.toContain(resourcesA2.materialId);
  });
});

describe("LiveKit access revocation", () => {
  let harness: Harness;
  let admin: Session;
  let tutor: Session;
  let tutorId: string;
  let originalStudent: StudentFixture;
  let replacementStudent: StudentFixture;
  let lessonId: string;

  const meetingKey = (): string => (harness.context.db.prepare("SELECT meeting_key FROM lessons WHERE id = ?")
    .get(lessonId) as { meeting_key: string }).meeting_key;

  beforeAll(async () => {
    harness = makeHarness("livekit-revocation");
    admin = await loginStaff(harness, ADMIN_LOGIN, ADMIN_PASSWORD);
    const tutorFixture = await createTutorWithHarness(harness, admin, "livekit-revocation");
    tutor = tutorFixture.session;
    tutorId = tutorFixture.id;
    originalStudent = await createAndActivateStudent(harness, tutor, "Original call student", "original-call-code");
    replacementStudent = await createAndActivateStudent(harness, tutor, "Replacement call student", "replacement-call-code");
    const lesson = await tutor.agent
      .post("/api/lessons")
      .set("x-csrf-token", tutor.csrf)
      .send({
        studentId: originalStudent.id,
        title: "LiveKit revocation lesson",
        scheduledAt: "2030-01-02T10:00:00.000Z",
      })
      .expect(201);
    lessonId = lesson.body.lesson.id;
  });

  afterAll(() => disposeHarness(harness));

  it("rotates the room and removes the previous student on reassignment", async () => {
    const oldRoomName = lessonCallRoomName(meetingKey());
    const removed: Array<{ room: string; identity: string; revokeTokenTs?: bigint }> = [];
    const deleted: string[] = [];
    harness.context.livekitRoomService = {
      createRoom: async () => undefined,
      listRooms: async () => [],
      removeParticipant: async (room, identity, options) => {
        removed.push({ room, identity, revokeTokenTs: options?.revokeTokenTs });
      },
      deleteRoom: async (room) => { deleted.push(room); },
    };

    await tutor.agent
      .patch(`/api/lessons/${lessonId}`)
      .set("x-csrf-token", tutor.csrf)
      .send({ studentId: replacementStudent.id })
      .expect(200);

    expect(meetingKey()).not.toBe(oldRoomName.slice("eduri-".length));
    expect(removed).toEqual([]);
    expect(deleted).toEqual([oldRoomName]);
  });

  it("rotates active lesson rooms on suspension and keeps the account change when LiveKit fails", async () => {
    const oldRoomName = lessonCallRoomName(meetingKey());
    const listed: string[][] = [];
    const removed: Array<{ room: string; identity: string }> = [];
    const deleted: string[] = [];
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    harness.context.livekitRoomService = {
      createRoom: async () => undefined,
      listRooms: async (names = []) => {
        listed.push(names);
        return names.map((name) => ({ name }));
      },
      removeParticipant: async (room, identity) => {
        removed.push({ room, identity });
        throw new Error("participant cleanup unavailable");
      },
      deleteRoom: async (room) => {
        deleted.push(room);
        throw new Error("room cleanup unavailable");
      },
    };

    try {
      const response = await tutor.agent
        .patch(`/api/students/${replacementStudent.id}`)
        .set("x-csrf-token", tutor.csrf)
        .send({ status: "suspended" })
        .expect(200);
      expect(response.body.student.status).toBe("suspended");
      expect(meetingKey()).not.toBe(oldRoomName.slice("eduri-".length));

      await vi.waitFor(() => {
        expect(listed).toEqual([]);
        expect(removed).toEqual([]);
        expect(deleted).toEqual([oldRoomName]);
        expect(log).not.toHaveBeenCalled();
      });
      expect(harness.context.db.prepare(`
        SELECT attempts, last_error_code
        FROM livekit_room_revocation_outbox WHERE room_name = ?
      `).get(oldRoomName)).toEqual({
        attempts: 1,
        last_error_code: "room_delete_failed",
      });
      harness.context.livekitRoomService = {
        createRoom: async () => undefined,
        listRooms: async () => [],
        removeParticipant: async () => undefined,
        deleteRoom: async () => undefined,
      };
      harness.context.db.prepare(`
        UPDATE livekit_room_revocation_outbox SET next_attempt_at = ?
        WHERE room_name = ?
      `).run(new Date().toISOString(), oldRoomName);
      await harness.context.runLiveKitRevocationMaintenance?.();
    } finally {
      log.mockRestore();
    }
  });

  it("finishes and deletes lessons even when room cleanup fails", async () => {
    const roomBeforeFinish = lessonCallRoomName(meetingKey());
    const deleted: string[] = [];
    const removed: Array<{ room: string; identity: string }> = [];
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    harness.context.livekitRoomService = {
      createRoom: async () => undefined,
      listRooms: async () => [],
      removeParticipant: async (room, identity) => { removed.push({ room, identity }); },
      deleteRoom: async (room) => {
        deleted.push(room);
        throw new Error("LiveKit unavailable");
      },
    };

    try {
      const response = await tutor.agent
        .post(`/api/lessons/${lessonId}/finish`)
        .set("x-csrf-token", tutor.csrf)
        .expect(200);
      expect(response.body.lesson.status).toBe("completed");
      expect(meetingKey()).not.toBe(roomBeforeFinish.slice("eduri-".length));
      await vi.waitFor(() => {
        expect(removed).toEqual([]);
        expect(deleted).toEqual([roomBeforeFinish]);
      });
      expect(log).not.toHaveBeenCalled();
      expect(harness.context.db.prepare(`
        SELECT attempts, last_error_code
        FROM livekit_room_revocation_outbox WHERE room_name = ?
      `).get(roomBeforeFinish)).toEqual({
        attempts: 1,
        last_error_code: "room_delete_failed",
      });
    } finally {
      log.mockRestore();
    }

    harness.context.livekitRoomService = {
      createRoom: async () => undefined,
      listRooms: async () => [],
      removeParticipant: async () => undefined,
      deleteRoom: async () => undefined,
    };
    harness.context.db.prepare(`
      UPDATE livekit_room_revocation_outbox SET next_attempt_at = ?
      WHERE room_name = ?
    `).run(new Date().toISOString(), roomBeforeFinish);
    await harness.context.runLiveKitRevocationMaintenance?.();

    const roomBeforeDelete = lessonCallRoomName(meetingKey());
    const deletedAfterRecovery: string[] = [];
    const removedAfterRecovery: Array<{ room: string; identity: string }> = [];
    harness.context.livekitRoomService = {
      createRoom: async () => undefined,
      listRooms: async () => [],
      removeParticipant: async (room, identity) => { removedAfterRecovery.push({ room, identity }); },
      deleteRoom: async (room) => { deletedAfterRecovery.push(room); },
    };
    await tutor.agent
      .delete(`/api/lessons/${lessonId}`)
      .set("x-csrf-token", tutor.csrf)
      .expect(204);
    await vi.waitFor(() => expect(deletedAfterRecovery).toEqual([roomBeforeDelete]));
    expect(removedAfterRecovery).toEqual([]);
    expect(harness.context.db.prepare("SELECT id FROM lessons WHERE id = ?").get(lessonId)).toBeUndefined();
  });

  it("rotates and closes the room when a lesson is cancelled through PATCH", async () => {
    const lesson = await tutor.agent
      .post("/api/lessons")
      .set("x-csrf-token", tutor.csrf)
      .send({ studentId: originalStudent.id, scheduledAt: "2030-01-03T09:00:00.000Z" })
      .expect(201);
    const cancelledLessonId = lesson.body.lesson.id as string;
    const before = harness.context.db.prepare("SELECT meeting_key FROM lessons WHERE id = ?")
      .get(cancelledLessonId) as { meeting_key: string };
    const oldRoomName = lessonCallRoomName(before.meeting_key);
    const deleted: string[] = [];
    const removed: Array<{ room: string; identity: string }> = [];
    harness.context.livekitRoomService = {
      createRoom: async () => undefined,
      listRooms: async () => [],
      removeParticipant: async (room, identity) => { removed.push({ room, identity }); },
      deleteRoom: async (room) => { deleted.push(room); },
    };

    const response = await tutor.agent
      .patch(`/api/lessons/${cancelledLessonId}`)
      .set("x-csrf-token", tutor.csrf)
      .send({ status: "cancelled" })
      .expect(200);
    const after = harness.context.db.prepare("SELECT meeting_key FROM lessons WHERE id = ?")
      .get(cancelledLessonId) as { meeting_key: string };
    expect(response.body.lesson.status).toBe("cancelled");
    expect(after.meeting_key).not.toBe(before.meeting_key);
    await vi.waitFor(() => expect(deleted).toEqual([oldRoomName]));
    expect(removed).toEqual([]);
  });

  it("rotates student lesson rooms when a password-reset invite is issued", async () => {
    const lesson = await tutor.agent
      .post("/api/lessons")
      .set("x-csrf-token", tutor.csrf)
      .send({
        studentId: originalStudent.id,
        scheduledAt: "2030-01-03T09:30:00.000Z",
      })
      .expect(201);
    const resetLessonId = lesson.body.lesson.id as string;
    const before = harness.context.db.prepare(`
      SELECT meeting_key FROM lessons WHERE id = ?
    `).get(resetLessonId) as { meeting_key: string };
    const oldRoomName = lessonCallRoomName(before.meeting_key);
    const deleted: string[] = [];
    harness.context.livekitRoomService = {
      createRoom: async () => undefined,
      listRooms: async () => [],
      removeParticipant: async () => undefined,
      deleteRoom: async (roomName) => {
        deleted.push(roomName);
      },
    };

    await tutor.agent
      .post(`/api/students/${originalStudent.id}/invite`)
      .set("x-csrf-token", tutor.csrf)
      .expect(201);

    expect(harness.context.db.prepare(`
      SELECT status, password_hash, credential_lookup FROM users WHERE id = ?
    `).get(originalStudent.id)).toEqual({
      status: "pending",
      password_hash: null,
      credential_lookup: null,
    });
    expect((harness.context.db.prepare(`
      SELECT meeting_key FROM lessons WHERE id = ?
    `).get(resetLessonId) as { meeting_key: string }).meeting_key)
      .not.toBe(before.meeting_key);
    await vi.waitFor(() => expect(deleted).toEqual([oldRoomName]));
  });

  it("rotates tutor rooms through the shared session revocation path", async () => {
    const activeStudent = await createAndActivateStudent(harness, tutor, "Tutor suspension student", "tutor-suspend-code");
    const lesson = await tutor.agent
      .post("/api/lessons")
      .set("x-csrf-token", tutor.csrf)
      .send({ studentId: activeStudent.id, scheduledAt: "2030-01-03T10:00:00.000Z" })
      .expect(201);
    const tutorLessonId = lesson.body.lesson.id as string;
    const before = harness.context.db.prepare("SELECT meeting_key FROM lessons WHERE id = ?")
      .get(tutorLessonId) as { meeting_key: string };
    const oldRoomName = lessonCallRoomName(before.meeting_key);
    const removed: Array<{ room: string; identity: string }> = [];
    harness.context.livekitRoomService = {
      createRoom: async () => undefined,
      listRooms: async (names = []) => names.map((name) => ({ name })),
      removeParticipant: async (room, identity) => { removed.push({ room, identity }); },
      deleteRoom: async () => undefined,
    };

    await admin.agent
      .patch(`/api/tutors/${tutorId}/status`)
      .set("x-csrf-token", admin.csrf)
      .send({ status: "suspended" })
      .expect(200);

    const after = harness.context.db.prepare("SELECT meeting_key FROM lessons WHERE id = ?")
      .get(tutorLessonId) as { meeting_key: string };
    expect(after.meeting_key).not.toBe(before.meeting_key);
    await vi.waitFor(() => expect(
      harness.context.db.prepare(`
        SELECT count(*) AS count FROM livekit_room_revocation_outbox
      `).get(),
    ).toEqual({ count: 0 }));
    expect(removed).toEqual([]);

    const roomsBeforePasswordReset = (harness.context.db.prepare(`
      SELECT id, meeting_key FROM lessons
      WHERE tutor_id = ? AND status IN ('scheduled', 'active')
      ORDER BY id
    `).all(tutorId) as Array<{ id: string; meeting_key: string }>);
    const passwordResetRooms = roomsBeforePasswordReset
      .map((row) => lessonCallRoomName(row.meeting_key))
      .sort();
    const passwordResetDeleted: string[] = [];
    harness.context.livekitRoomService = {
      createRoom: async () => undefined,
      listRooms: async () => [],
      removeParticipant: async () => undefined,
      deleteRoom: async (roomName) => {
        passwordResetDeleted.push(roomName);
      },
    };
    const resetResponse = await admin.agent
      .post(`/api/tutors/${tutorId}/password-reset`)
      .set("x-csrf-token", admin.csrf)
      .send({ password: "replacement-tutor-password" })
      .expect(200);
    expect(resetResponse.body.tutor.status).toBe("suspended");
    for (const before of roomsBeforePasswordReset) {
      expect((harness.context.db.prepare(`
        SELECT meeting_key FROM lessons WHERE id = ?
      `).get(before.id) as { meeting_key: string }).meeting_key)
        .not.toBe(before.meeting_key);
    }
    await vi.waitFor(() => expect(passwordResetDeleted)
      .toHaveLength(passwordResetRooms.length));
    expect([...passwordResetDeleted].sort()).toEqual(passwordResetRooms);
  });
});

describe("realtime session revocation", () => {
  let harness: Harness;
  let httpServer: HttpServer;
  let realtime: ReturnType<typeof attachRealtime>;
  let tutor: Session;
  let student: StudentFixture;
  let lessonId: string;
  let materialId: string;
  let socket: Socket;
  let baseUrl: string;

  beforeAll(async () => {
    harness = makeHarness("realtime");
    const admin = await loginStaff(harness, ADMIN_LOGIN, ADMIN_PASSWORD);
    tutor = (await createTutorWithHarness(harness, admin, "realtime")).session;
    student = await createAndActivateStudent(harness, tutor, "Realtime Student", "realtime-code");
    const lesson = await tutor.agent
      .post("/api/lessons")
      .set("x-csrf-token", tutor.csrf)
      .send({
        studentId: student.id,
        title: "Realtime lesson",
        scheduledAt: "2030-01-02T10:00:00.000Z",
      })
      .expect(201);
    lessonId = lesson.body.lesson.id;
    const material = await tutor.agent
      .post("/api/materials")
      .set("x-csrf-token", tutor.csrf)
      .send({
        title: "Realtime material",
        kind: "note",
        body: "Read-only history",
        studentIds: [student.id],
      })
      .expect(201);
    materialId = material.body.material.id;

    httpServer = http.createServer(harness.app);
    realtime = attachRealtime(httpServer, harness.context);
    await new Promise<void>((resolve, reject) => {
      httpServer.once("error", reject);
      httpServer.listen(0, "127.0.0.1", () => {
        httpServer.off("error", reject);
        resolve();
      });
    });
    const address = httpServer.address();
    if (!address || typeof address === "string") throw new Error("Test server did not expose a TCP address");
    baseUrl = `http://127.0.0.1:${address.port}`;

    socket = createSocketClient(baseUrl, {
      transports: ["websocket"],
      forceNew: true,
      reconnection: false,
      extraHeaders: { Cookie: student.session.cookie },
    });
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("connect_error", reject);
    });
  });

  it("keeps completed lesson history joinable but rejects workspace mutations", async () => {
    await tutor.agent
      .post(`/api/lessons/${lessonId}/finish`)
      .set("x-csrf-token", tutor.csrf)
      .expect(200);

    const joined = await socket.timeout(2_000).emitWithAck("lesson:join", { lessonId }) as { ok: boolean };
    expect(joined.ok).toBe(true);
    const revisionBefore = harness.context.db.prepare(`
      SELECT board_revision, code_revision FROM lessons WHERE id = ?
    `).get(lessonId) as { board_revision: number; code_revision: number };

    const scene = await socket.timeout(2_000).emitWithAck("lesson:scene", {
      lessonId,
      scene: { elements: [{ id: "completed-scene" }] },
    }) as { ok: boolean };
    const code = await socket.timeout(2_000).emitWithAck("lesson:code", {
      lessonId,
      code: { language: "python", value: "print('completed')" },
    }) as { ok: boolean };
    const material = await socket.timeout(2_000).emitWithAck("lesson:material", {
      lessonId,
      material: { id: materialId },
    }) as { ok: boolean };
    expect([scene.ok, code.ok, material.ok]).toEqual([false, false, false]);

    const revisionAfter = harness.context.db.prepare(`
      SELECT board_revision, code_revision FROM lessons WHERE id = ?
    `).get(lessonId) as { board_revision: number; code_revision: number };
    expect(revisionAfter).toEqual(revisionBefore);
  });

  afterAll(async () => {
    socket?.close();
    if (realtime) {
      await new Promise<void>((resolve) => realtime.close(() => resolve()));
    } else if (httpServer?.listening) {
      await new Promise<void>((resolve, reject) => httpServer.close((error) => error ? reject(error) : resolve()));
    }
    disposeHarness(harness);
  });

  it("stops an already-connected student socket from mutating a lesson after suspension", async () => {
    const joined = await socket.timeout(2_000).emitWithAck("lesson:join", { lessonId }) as { ok: boolean };
    expect(joined.ok).toBe(true);
    const revisionBefore = (harness.context.db.prepare("SELECT board_revision FROM lessons WHERE id = ?")
      .get(lessonId) as { board_revision: number }).board_revision;
    const disconnected = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Student socket was not disconnected")), 2_000);
      socket.once("disconnect", () => {
        clearTimeout(timer);
        resolve();
      });
    });

    await tutor.agent
      .patch(`/api/students/${student.id}`)
      .set("x-csrf-token", tutor.csrf)
      .send({ status: "suspended" })
      .expect(200);
    await disconnected;
    expect(socket.connected).toBe(false);
    await student.session.agent.get("/api/auth/me").expect(401);

    const revisionAfter = (harness.context.db.prepare("SELECT board_revision FROM lessons WHERE id = ?")
      .get(lessonId) as { board_revision: number }).board_revision;
    expect(revisionAfter).toBe(revisionBefore);
  });
});

describe("realtime board engine isolation", () => {
  let harness: Harness;
  let httpServer: HttpServer;
  let realtime: ReturnType<typeof attachRealtime>;
  let tutor: Session;
  let student: StudentFixture;
  let legacyLessonId: string;
  let switchedLessonId: string;
  let baseUrl: string;
  let tutorSocket: Socket;
  let studentSocket: Socket;

  const connect = async (cookie: string): Promise<Socket> => {
    const connected = createSocketClient(baseUrl, {
      transports: ["websocket"],
      forceNew: true,
      reconnection: false,
      extraHeaders: { Cookie: cookie },
    });
    await new Promise<void>((resolve, reject) => {
      connected.once("connect", resolve);
      connected.once("connect_error", reject);
    });
    return connected;
  };

  beforeAll(async () => {
    harness = makeHarness("realtime-board-engine");
    const admin = await loginStaff(harness, ADMIN_LOGIN, ADMIN_PASSWORD);
    tutor = (await createTutorWithHarness(harness, admin, "realtime-board-engine")).session;
    student = await createAndActivateStudent(
      harness,
      tutor,
      "Board engine student",
      "board-engine-code",
    );
    const legacyLesson = await tutor.agent
      .post("/api/lessons")
      .set("x-csrf-token", tutor.csrf)
      .send({
        studentId: student.id,
        title: "Legacy board lesson",
        scheduledAt: "2030-01-02T10:00:00.000Z",
      })
      .expect(201);
    const switchedLesson = await tutor.agent
      .post("/api/lessons")
      .set("x-csrf-token", tutor.csrf)
      .send({
        studentId: student.id,
        title: "Switched board lesson",
        scheduledAt: "2030-01-03T10:00:00.000Z",
      })
      .expect(201);
    legacyLessonId = legacyLesson.body.lesson.id;
    switchedLessonId = switchedLesson.body.lesson.id;
    new BoardRepository(harness.context.db).createBoardForLesson(
      legacyLessonId,
      { engine: "legacy" },
    );

    httpServer = http.createServer(harness.app);
    realtime = attachRealtime(httpServer, harness.context);
    await new Promise<void>((resolve, reject) => {
      httpServer.once("error", reject);
      httpServer.listen(0, "127.0.0.1", () => {
        httpServer.off("error", reject);
        resolve();
      });
    });
    const address = httpServer.address();
    if (!address || typeof address === "string") throw new Error("Test server did not expose a TCP address");
    baseUrl = `http://127.0.0.1:${address.port}`;
    tutorSocket = await connect(tutor.cookie);
    studentSocket = await connect(student.session.cookie);
  });

  afterAll(async () => {
    tutorSocket?.close();
    studentSocket?.close();
    if (realtime) {
      await new Promise<void>((resolve) => realtime.close(() => resolve()));
    } else if (httpServer?.listening) {
      await new Promise<void>((resolve, reject) => httpServer.close((error) => error ? reject(error) : resolve()));
    }
    disposeHarness(harness);
  });

  it("rejects legacy scene writes even for an explicit legacy descriptor", async () => {
    const tutorJoin = await tutorSocket.timeout(2_000)
      .emitWithAck("lesson:join", { lessonId: legacyLessonId }) as { ok: boolean };
    const studentJoin = await studentSocket.timeout(2_000)
      .emitWithAck("lesson:join", { lessonId: legacyLessonId }) as { ok: boolean };
    expect([tutorJoin.ok, studentJoin.ok]).toEqual([true, true]);

    const before = harness.context.db.prepare(`
      SELECT board_state, board_revision, updated_at FROM lessons WHERE id = ?
    `).get(legacyLessonId);
    const leakedEvents: unknown[] = [];
    const listener = (payload: unknown) => leakedEvents.push(payload);
    studentSocket.on("lesson:scene", listener);
    const acknowledgement = await tutorSocket.timeout(2_000).emitWithAck("lesson:scene", {
      lessonId: legacyLessonId,
      scene: { elements: [{ id: "legacy-scene" }] },
    }) as { ok: boolean; code?: string };
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
    studentSocket.off("lesson:scene", listener);

    expect(acknowledgement).toMatchObject({
      ok: false,
      code: "BOARD_ENGINE_MISMATCH",
    });
    expect(harness.context.db.prepare(`
      SELECT board_state, board_revision, updated_at FROM lessons WHERE id = ?
    `).get(legacyLessonId)).toEqual(before);
    expect(leakedEvents).toEqual([]);
  });

  it("rejects concurrent legacy tabs before a Board v2 descriptor exists", async () => {
    const tutorJoin = await tutorSocket.timeout(2_000)
      .emitWithAck("lesson:join", { lessonId: switchedLessonId }) as { ok: boolean };
    const studentJoin = await studentSocket.timeout(2_000)
      .emitWithAck("lesson:join", { lessonId: switchedLessonId }) as { ok: boolean };
    expect([tutorJoin.ok, studentJoin.ok]).toEqual([true, true]);
    expect(new BoardRepository(harness.context.db)
      .getBoardForLesson(switchedLessonId)).toBeNull();
    const before = harness.context.db.prepare(`
      SELECT board_state, board_revision, updated_at FROM lessons WHERE id = ?
    `).get(switchedLessonId);
    const leakedEvents: unknown[] = [];
    const tutorListener = (payload: unknown) => leakedEvents.push(payload);
    const studentListener = (payload: unknown) => leakedEvents.push(payload);
    tutorSocket.on("lesson:scene", tutorListener);
    studentSocket.on("lesson:scene", studentListener);

    const [tutorWrite, studentWrite] = await Promise.all([
      tutorSocket.timeout(2_000).emitWithAck("lesson:scene", {
        lessonId: switchedLessonId,
        scene: { elements: [{ id: "stale-tutor" }] },
      }),
      studentSocket.timeout(2_000).emitWithAck("lesson:scene", {
        lessonId: switchedLessonId,
        scene: { elements: [{ id: "stale-student" }] },
      }),
    ]) as Array<{ ok: boolean; code?: string }>;
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
    tutorSocket.off("lesson:scene", tutorListener);
    studentSocket.off("lesson:scene", studentListener);

    expect([tutorWrite, studentWrite]).toEqual([
      expect.objectContaining({ ok: false, code: "BOARD_ENGINE_MISMATCH" }),
      expect.objectContaining({ ok: false, code: "BOARD_ENGINE_MISMATCH" }),
    ]);
    expect(harness.context.db.prepare(`
      SELECT board_state, board_revision, updated_at FROM lessons WHERE id = ?
    `).get(switchedLessonId)).toEqual(before);
    expect(new BoardRepository(harness.context.db)
      .getBoardForLesson(switchedLessonId)).toBeNull();
    expect(leakedEvents).toEqual([]);
  });
});

describe("realtime lesson membership revocation", () => {
  let harness: Harness;
  let httpServer: HttpServer;
  let realtime: ReturnType<typeof attachRealtime>;
  let tutor: Session;
  let originalStudent: StudentFixture;
  let replacementStudent: StudentFixture;
  let lessonId: string;
  let baseUrl: string;
  let tutorSocket: Socket;
  let originalStudentSocket: Socket;
  let replacementStudentSocket: Socket | undefined;

  const connect = async (cookie: string): Promise<Socket> => {
    const socket = createSocketClient(baseUrl, {
      transports: ["websocket"],
      forceNew: true,
      reconnection: false,
      extraHeaders: { Cookie: cookie },
    });
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("connect_error", reject);
    });
    return socket;
  };

  beforeAll(async () => {
    harness = makeHarness("lesson-membership");
    const admin = await loginStaff(harness, ADMIN_LOGIN, ADMIN_PASSWORD);
    tutor = (await createTutorWithHarness(harness, admin, "lesson-membership")).session;
    originalStudent = await createAndActivateStudent(harness, tutor, "Original Student", "original-code");
    replacementStudent = await createAndActivateStudent(harness, tutor, "Replacement Student", "replacement-code");
    const lesson = await tutor.agent
      .post("/api/lessons")
      .set("x-csrf-token", tutor.csrf)
      .send({
        studentId: originalStudent.id,
        title: "Membership lesson",
        scheduledAt: "2030-01-02T10:00:00.000Z",
      })
      .expect(201);
    lessonId = lesson.body.lesson.id;

    httpServer = http.createServer(harness.app);
    realtime = attachRealtime(httpServer, harness.context);
    await new Promise<void>((resolve, reject) => {
      httpServer.once("error", reject);
      httpServer.listen(0, "127.0.0.1", () => {
        httpServer.off("error", reject);
        resolve();
      });
    });
    const address = httpServer.address();
    if (!address || typeof address === "string") throw new Error("Test server did not expose a TCP address");
    baseUrl = `http://127.0.0.1:${address.port}`;
    tutorSocket = await connect(tutor.cookie);
    originalStudentSocket = await connect(originalStudent.session.cookie);
  });

  afterAll(async () => {
    tutorSocket?.close();
    originalStudentSocket?.close();
    replacementStudentSocket?.close();
    if (realtime) {
      await new Promise<void>((resolve) => realtime.close(() => resolve()));
    } else if (httpServer?.listening) {
      await new Promise<void>((resolve, reject) => httpServer.close((error) => error ? reject(error) : resolve()));
    }
    disposeHarness(harness);
  });

  it("removes stale members on reassignment and clears the room on deletion", async () => {
    const tutorJoin = await tutorSocket.timeout(2_000).emitWithAck("lesson:join", { lessonId }) as { ok: boolean };
    const originalJoin = await originalStudentSocket.timeout(2_000).emitWithAck("lesson:join", { lessonId }) as {
      ok: boolean;
      lesson?: { status?: string };
    };
    expect([tutorJoin.ok, originalJoin.ok]).toEqual([true, true]);
    expect(originalJoin.lesson?.status).toBe("scheduled");
    const room = `lesson:${lessonId}`;
    expect(realtime.sockets.adapter.rooms.get(room)?.has(originalStudentSocket.id!)).toBe(true);
    const codeRevisionBefore = (harness.context.db.prepare(
      "SELECT code_revision FROM lessons WHERE id = ?",
    ).get(lessonId) as { code_revision: number }).code_revision;
    const javascript = await tutorSocket.timeout(2_000).emitWithAck(
      "lesson:code",
      {
        lessonId,
        code: { language: "javascript", value: "console.log('blocked')" },
      },
    ) as { ok: boolean };
    expect(javascript.ok).toBe(false);
    expect((harness.context.db.prepare(
      "SELECT code_revision FROM lessons WHERE id = ?",
    ).get(lessonId) as { code_revision: number }).code_revision)
      .toBe(codeRevisionBefore);

    await tutor.agent
      .patch(`/api/lessons/${lessonId}`)
      .set("x-csrf-token", tutor.csrf)
      .send({ studentId: replacementStudent.id })
      .expect(200);

    expect(originalStudentSocket.connected).toBe(true);
    expect(realtime.sockets.adapter.rooms.get(room)?.has(originalStudentSocket.id!)).toBe(false);
    expect(realtime.sockets.adapter.rooms.get(room)?.has(tutorSocket.id!)).toBe(true);

    replacementStudentSocket = await connect(replacementStudent.session.cookie);
    const replacementJoin = await replacementStudentSocket.timeout(2_000)
      .emitWithAck("lesson:join", { lessonId }) as { ok: boolean };
    expect(replacementJoin.ok).toBe(true);

    const staleEvent = new Promise<boolean>((resolve) => {
      const received = () => resolve(true);
      originalStudentSocket.once("lesson:code", received);
      setTimeout(() => {
        originalStudentSocket.off("lesson:code", received);
        resolve(false);
      }, 150);
    });
    const replacementEvent = new Promise<boolean>((resolve) => {
      const received = () => resolve(true);
      replacementStudentSocket!.once("lesson:code", received);
      setTimeout(() => {
        replacementStudentSocket!.off("lesson:code", received);
        resolve(false);
      }, 150);
    });
    const code = await tutorSocket.timeout(2_000).emitWithAck("lesson:code", {
      lessonId,
      code: { language: "python", value: "print('after reassignment')" },
    }) as { ok: boolean; code?: string };
    expect(code).toMatchObject({
      ok: false,
      code: "CODE_ENGINE_MISMATCH",
    });
    expect(await replacementEvent).toBe(false);
    expect(await staleEvent).toBe(false);

    const completedEvent = new Promise<{ lessonId: string; status: string }>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Replacement student did not receive lesson status")), 2_000);
      replacementStudentSocket!.once("lesson:status", (payload) => {
        clearTimeout(timer);
        resolve(payload);
      });
    });
    await tutor.agent
      .post(`/api/lessons/${lessonId}/finish`)
      .set("x-csrf-token", tutor.csrf)
      .expect(200);
    await expect(completedEvent).resolves.toEqual({ lessonId, status: "completed" });

    await tutor.agent
      .delete(`/api/lessons/${lessonId}`)
      .set("x-csrf-token", tutor.csrf)
      .expect(204);
    expect(realtime.sockets.adapter.rooms.has(room)).toBe(false);
    expect(tutorSocket.connected).toBe(true);
    expect(replacementStudentSocket.connected).toBe(true);
  });
});

describe("legacy material progress migration", () => {
  it("rebuilds material_access with the lesson foreign key and preserves valid data", () => {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    db.exec(`
      CREATE TABLE schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL
      );
      INSERT INTO schema_migrations (version, name, applied_at) VALUES
        (1, 'legacy-1', '2026-01-01T00:00:00.000Z'),
        (2, 'legacy-2', '2026-01-01T00:00:00.000Z'),
        (3, 'legacy-3', '2026-01-01T00:00:00.000Z'),
        (4, 'legacy-4', '2026-01-01T00:00:00.000Z');
      CREATE TABLE users (id TEXT PRIMARY KEY);
      CREATE TABLE lessons (id TEXT PRIMARY KEY);
      CREATE TABLE materials (id TEXT PRIMARY KEY);
      CREATE TABLE material_access (
        material_id TEXT NOT NULL REFERENCES materials(id) ON DELETE CASCADE,
        student_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        granted_at TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'assigned',
        updated_at TEXT NOT NULL DEFAULT '',
        lesson_id TEXT,
        PRIMARY KEY (material_id, student_id)
      );
      CREATE INDEX material_access_student_idx ON material_access(student_id);
      CREATE INDEX material_access_progress_idx ON material_access(student_id, status, updated_at DESC);
      INSERT INTO users (id) VALUES ('student-1');
      INSERT INTO lessons (id) VALUES ('lesson-1');
      INSERT INTO materials (id) VALUES ('material-1');
      INSERT INTO material_access (
        material_id, student_id, granted_at, status, updated_at, lesson_id
      ) VALUES (
        'material-1', 'student-1', '2026-01-01T00:00:00.000Z', 'covered', '', 'lesson-1'
      );
    `);

    migrate(db, { targetVersion: 7 });
    const foreignKeys = db.prepare("PRAGMA foreign_key_list(material_access)").all() as Array<{
      table: string;
      from: string;
      on_delete: string;
    }>;
    expect(foreignKeys).toContainEqual(expect.objectContaining({
      table: "lessons",
      from: "lesson_id",
      on_delete: "SET NULL",
    }));
    expect(db.prepare("SELECT * FROM material_access").get()).toMatchObject({
      material_id: "material-1",
      student_id: "student-1",
      status: "covered",
      updated_at: "2026-01-01T00:00:00.000Z",
      lesson_id: "lesson-1",
    });
    db.prepare("DELETE FROM lessons WHERE id = 'lesson-1'").run();
    expect((db.prepare("SELECT lesson_id FROM material_access").get() as { lesson_id: string | null }).lesson_id)
      .toBeNull();
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect((db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get() as { version: number }).version)
      .toBe(7);
    db.close();
  });
});

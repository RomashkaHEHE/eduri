import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { io as createSocketClient, type Socket } from "socket.io-client";
import { Server as SocketIOServer } from "socket.io";
import * as Y from "yjs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CODE_SYNC_MESSAGE_EVENT,
  CODE_SYNC_PROTOCOL_VERSION,
  CODE_SYNC_TAGS,
  CODE_SYNC_UPDATE_ENCODING,
  type CodeSyncServerMessage,
} from "../../code/protocol/index.js";
import { LESSON_CODE_SYNC_NAMESPACE } from "../../code/lessonSync.js";
import { codeWorkspaceText } from "../../code/core/index.js";
import {
  SHARED_TERMINAL_ACK_EVENT,
  SHARED_TERMINAL_ACTION_EVENT,
  SHARED_TERMINAL_DELTA_EVENT,
  SHARED_TERMINAL_EFFECT_EVENT,
  SHARED_TERMINAL_PROTOCOL_VERSION,
  SHARED_TERMINAL_STATE_EVENT,
  type SharedTerminalAck,
  type SharedTerminalClientEffect,
  type SharedTerminalDelta,
  type SharedTerminalState,
} from "../../code/terminal/index.js";
import { sessionCookieName, sha256 } from "../security.js";
import { createServer, type EduriServer } from "../server.js";
import { attachLessonCodeSyncNamespace } from "./transport.js";

const ORIGIN = "http://eduri.test";
const TUTOR_ID = "30000000-0000-4000-8000-000000000001";
const STUDENT_ID = "30000000-0000-4000-8000-000000000002";
const OUTSIDER_ID = "30000000-0000-4000-8000-000000000003";
const LESSON_ID = "30000000-0000-4000-8000-000000000101";
const TUTOR_TOKEN = `lesson-code-tutor-${"a".repeat(32)}`;
const STUDENT_TOKEN = `lesson-code-student-${"b".repeat(32)}`;
const OUTSIDER_TOKEN = `lesson-code-outsider-${"c".repeat(32)}`;

function nextMessage(
  socket: Socket,
  predicate: (message: CodeSyncServerMessage) => boolean,
): Promise<CodeSyncServerMessage> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(CODE_SYNC_MESSAGE_EVENT, handler);
      reject(new Error("Timed out waiting for lesson Code sync message"));
    }, 2_000);
    const handler = (message: CodeSyncServerMessage) => {
      if (!predicate(message)) return;
      clearTimeout(timer);
      socket.off(CODE_SYNC_MESSAGE_EVENT, handler);
      resolve(message);
    };
    socket.on(CODE_SYNC_MESSAGE_EVENT, handler);
  });
}

function nextSocketEvent<T>(
  socket: Socket,
  event: string,
  predicate: (value: T) => boolean = () => true,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(event, handler);
      reject(new Error(`Timed out waiting for ${event}`));
    }, 2_000);
    const handler = (value: T) => {
      if (!predicate(value)) return;
      clearTimeout(timer);
      socket.off(event, handler);
      resolve(value);
    };
    socket.on(event, handler);
  });
}

describe("lesson Code sync namespace", () => {
  let dataDir: string;
  let server: EduriServer;
  let baseUrl: string;
  const sockets: Socket[] = [];

  beforeEach(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "eduri-lesson-code-"));
    server = createServer({
      config: {
        nodeEnv: "test",
        appOrigins: [ORIGIN],
        dataDir,
        databasePath: path.join(dataDir, "test.sqlite"),
        uploadDir: path.join(dataDir, "uploads"),
        authLookupKey: "lesson-code-test-key-at-least-32-bytes",
        adminPassword: "lesson-code-admin-password",
        bcryptRounds: 4,
      },
    });
    const db = server.eduriContext.db;
    const createdAt = "2026-08-12T12:00:00.000Z";
    db.prepare(`
      INSERT INTO users (
        id, role, status, display_name, created_at, updated_at
      ) VALUES (?, 'tutor', 'active', 'Tutor One', ?, ?)
    `).run(TUTOR_ID, createdAt, createdAt);
    db.prepare(`
      INSERT INTO users (
        id, role, status, display_name, tutor_id, created_at, updated_at
      ) VALUES (?, 'student', 'active', 'Student One', ?, ?, ?)
    `).run(STUDENT_ID, TUTOR_ID, createdAt, createdAt);
    db.prepare(`
      INSERT INTO users (
        id, role, status, display_name, tutor_id, created_at, updated_at
      ) VALUES (?, 'student', 'active', 'Outsider', ?, ?, ?)
    `).run(OUTSIDER_ID, TUTOR_ID, createdAt, createdAt);
    const insertSession = db.prepare(`
      INSERT INTO sessions (
        session_hash, user_id, expires_at, created_at, last_seen_at
      ) VALUES (?, ?, '2100-01-01T00:00:00.000Z', ?, ?)
    `);
    insertSession.run(sha256(TUTOR_TOKEN), TUTOR_ID, createdAt, createdAt);
    insertSession.run(sha256(STUDENT_TOKEN), STUDENT_ID, createdAt, createdAt);
    insertSession.run(sha256(OUTSIDER_TOKEN), OUTSIDER_ID, createdAt, createdAt);
    db.prepare(`
      INSERT INTO lessons (
        id, tutor_id, student_id, title, meeting_key, scheduled_at,
        duration_minutes, status, code_state, code_revision,
        created_at, updated_at
      ) VALUES (?, ?, ?, 'Code lesson', ?, ?, 60, 'active', ?, 4, ?, ?)
    `).run(
      LESSON_ID,
      TUTOR_ID,
      STUDENT_ID,
      "lesson-code-meeting-key-00000000",
      createdAt,
      JSON.stringify({ language: "python", value: "print('legacy')\n" }),
      createdAt,
      createdAt,
    );
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("missing port");
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    for (const socket of sockets) socket.close();
    server.eduriBoardV2.close();
    await new Promise<void>((resolve) => server.eduriIo.close(() => resolve()));
    server.eduriContext.stopGuestRoomMaintenance?.();
    server.eduriContext.stopBoardAssetMaintenance?.();
    server.eduriContext.stopMaterialFileMaintenance?.();
    if (server.eduriContext.db.open) server.eduriContext.db.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  function client(token: string, deviceId: string, lessonId = LESSON_ID): Socket {
    const socket = createSocketClient(`${baseUrl}${LESSON_CODE_SYNC_NAMESPACE}`, {
      auth: { lessonId, deviceId },
      autoConnect: false,
      forceNew: true,
      reconnection: false,
      transports: ["websocket"],
      extraHeaders: {
        Origin: ORIGIN,
        Cookie: `${sessionCookieName(server.eduriContext)}=${token}`,
      },
    });
    sockets.push(socket);
    return socket;
  }

  async function connect(token: string, deviceId: string): Promise<Socket> {
    const socket = client(token, deviceId);
    const ready = nextMessage(socket, (message) => (
      message.type === CODE_SYNC_TAGS.ready
    ));
    const connected = new Promise<void>((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("connect_error", reject);
    });
    socket.connect();
    await connected;
    await ready;
    return socket;
  }

  async function synchronize(socket: Socket, document: Y.Doc): Promise<void> {
    const requestId = crypto.randomUUID();
    const parts: Uint8Array[] = [];
    const done = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("sync timeout")), 2_000);
      const handler = (message: CodeSyncServerMessage) => {
        if (
          message.type !== CODE_SYNC_TAGS.syncStep2
          || message.requestId !== requestId
        ) return;
        parts.push(message.update);
        if (!message.done) return;
        clearTimeout(timer);
        socket.off(CODE_SYNC_MESSAGE_EVENT, handler);
        for (const update of parts) Y.applyUpdate(document, update);
        resolve();
      };
      socket.on(CODE_SYNC_MESSAGE_EVENT, handler);
    });
    socket.emit(CODE_SYNC_MESSAGE_EVENT, {
      type: CODE_SYNC_TAGS.syncStep1,
      protocolVersion: CODE_SYNC_PROTOCOL_VERSION,
      requestId,
      stateVector: Y.encodeStateVector(document),
    });
    await done;
  }

  it("enforces tutor/student ACL and exact handshake auth", async () => {
    await expect(connect(TUTOR_TOKEN, "tutor-device")).resolves.toBeDefined();
    await expect(connect(STUDENT_TOKEN, "student-device")).resolves.toBeDefined();

    const outsider = client(OUTSIDER_TOKEN, "outsider-device");
    const error = new Promise<Error & { data?: CodeSyncServerMessage }>((resolve) => {
      outsider.once("connect_error", resolve);
    });
    outsider.connect();
    await expect(error).resolves.toMatchObject({
      data: { type: CODE_SYNC_TAGS.control, code: "not-found", terminal: true },
    });

    const extended = createSocketClient(`${baseUrl}${LESSON_CODE_SYNC_NAMESPACE}`, {
      auth: { lessonId: LESSON_ID, deviceId: "bad", extra: true },
      autoConnect: false,
      forceNew: true,
      reconnection: false,
      transports: ["websocket"],
      extraHeaders: {
        Origin: ORIGIN,
        Cookie: `${sessionCookieName(server.eduriContext)}=${TUTOR_TOKEN}`,
      },
    });
    sockets.push(extended);
    const extendedError = new Promise((resolve) => (
      extended.once("connect_error", resolve)
    ));
    extended.connect();
    await expect(extendedError)
      .resolves.toMatchObject({ data: { code: "invalid-message" } });
  });

  it("charges malformed near-5 MiB namespace auth before auth parsing", async () => {
    const ingressServer = http.createServer();
    const ingressIo = new SocketIOServer(ingressServer, {
      maxHttpBufferSize: 5 * 1024 * 1024,
    });
    attachLessonCodeSyncNamespace(
      ingressIo,
      server.eduriContext,
      server.eduriContext.lessonCodeSync,
      {
        allowedOrigins: [ORIGIN],
        ingressBytesPerIpPerMinute: 4 * 1024 * 1024,
        ingressBytesGlobalPerMinute: 256 * 1024 * 1024,
      },
    );
    try {
      await new Promise<void>((resolve, reject) => {
        ingressServer.once("error", reject);
        ingressServer.listen(0, "127.0.0.1", () => {
          ingressServer.off("error", reject);
          resolve();
        });
      });
      const address = ingressServer.address();
      if (!address || typeof address === "string") throw new Error("missing port");
      const oversized = createSocketClient(
        `http://127.0.0.1:${address.port}${LESSON_CODE_SYNC_NAMESPACE}`,
        {
          auth: {
            lessonId: LESSON_ID,
            deviceId: "oversized-auth-device",
            filler: "x".repeat(5 * 1024 * 1024 - 8 * 1024),
          },
          autoConnect: false,
          forceNew: true,
          reconnection: false,
          transports: ["websocket"],
          extraHeaders: {
            Origin: ORIGIN,
            Cookie: `${sessionCookieName(server.eduriContext)}=${TUTOR_TOKEN}`,
          },
        },
      );
      const error = new Promise<Error & { data?: CodeSyncServerMessage }>((resolve) => {
        oversized.once("connect_error", resolve);
      });
      oversized.connect();
      await expect(error).resolves.toMatchObject({
        data: {
          type: CODE_SYNC_TAGS.control,
          code: "rate-limited",
        },
      });
      oversized.close();
    } finally {
      await new Promise<void>((resolve) => ingressIo.close(() => resolve()));
    }
  });

  it("imports once, converges, acknowledges duplicates, and reconnects by state vector", async () => {
    const tutor = await connect(TUTOR_TOKEN, "tutor-device");
    const tutorDocument = new Y.Doc();
    await synchronize(tutor, tutorDocument);
    expect(codeWorkspaceText(tutorDocument, "main-py")?.toString())
      .toBe("print('legacy')\n");

    const before = Y.encodeStateVector(tutorDocument);
    codeWorkspaceText(tutorDocument, "main-py")?.insert(
      codeWorkspaceText(tutorDocument, "main-py")?.length ?? 0,
      "print('shared')\n",
    );
    const update = Y.encodeStateAsUpdate(tutorDocument, before);
    const requestId = crypto.randomUUID();
    const firstAck = nextMessage(tutor, (message) => (
      message.type === CODE_SYNC_TAGS.updateAck
      && message.requestId === requestId
    ));
    tutor.emit(CODE_SYNC_MESSAGE_EVENT, {
      type: CODE_SYNC_TAGS.update,
      protocolVersion: CODE_SYNC_PROTOCOL_VERSION,
      requestId,
      updateId: "durable-update",
      updateEncoding: CODE_SYNC_UPDATE_ENCODING,
      update,
    });
    await expect(firstAck).resolves.toMatchObject({ status: "committed", sequence: 1 });

    const duplicateRequest = crypto.randomUUID();
    const duplicateAck = nextMessage(tutor, (message) => (
      message.type === CODE_SYNC_TAGS.updateAck
      && message.requestId === duplicateRequest
    ));
    tutor.emit(CODE_SYNC_MESSAGE_EVENT, {
      type: CODE_SYNC_TAGS.update,
      protocolVersion: CODE_SYNC_PROTOCOL_VERSION,
      requestId: duplicateRequest,
      updateId: "durable-update",
      updateEncoding: CODE_SYNC_UPDATE_ENCODING,
      update,
    });
    await expect(duplicateAck).resolves.toMatchObject({ status: "duplicate", sequence: 1 });

    tutor.close();
    const student = await connect(STUDENT_TOKEN, "student-reconnect");
    const studentDocument = new Y.Doc();
    await synchronize(student, studentDocument);
    expect(codeWorkspaceText(studentDocument, "main-py")?.toString())
      .toBe("print('legacy')\nprint('shared')\n");
    expect(server.eduriContext.db.prepare(`
      SELECT code_revision FROM lessons WHERE id = ?
    `).get(LESSON_ID)).toEqual({ code_revision: 4 });
  });

  it("rejects writes after completion but still allows a read-only cold sync", async () => {
    const tutor = await connect(TUTOR_TOKEN, "tutor-before-complete");
    const document = new Y.Doc();
    await synchronize(tutor, document);
    server.eduriContext.db.prepare(`
      UPDATE lessons SET status = 'completed' WHERE id = ?
    `).run(LESSON_ID);
    tutor.close();

    const student = await connect(STUDENT_TOKEN, "student-read-only");
    const replica = new Y.Doc();
    await synchronize(student, replica);
    const before = Y.encodeStateVector(replica);
    codeWorkspaceText(replica, "main-py")?.insert(0, "# forbidden\n");
    const rejected = nextMessage(student, (message) => (
      message.type === CODE_SYNC_TAGS.control
      && message.code === "invalid-update"
    ));
    student.emit(CODE_SYNC_MESSAGE_EVENT, {
      type: CODE_SYNC_TAGS.update,
      protocolVersion: CODE_SYNC_PROTOCOL_VERSION,
      requestId: crypto.randomUUID(),
      updateId: "read-only-update",
      updateEncoding: CODE_SYNC_UPDATE_ENCODING,
      update: Y.encodeStateAsUpdate(replica, before),
    });
    await expect(rejected).resolves.toMatchObject({ terminal: false });
    expect(student.connected).toBe(true);
  });

  it("broadcasts clear generation snapshots and keeps read-only viewers connected", async () => {
    const tutor = await connect(TUTOR_TOKEN, "tutor-terminal");
    const student = await connect(STUDENT_TOKEN, "student-terminal");
    const clearedForTutor = new Promise<SharedTerminalState>((resolve) => {
      tutor.on(SHARED_TERMINAL_STATE_EVENT, (state: SharedTerminalState) => {
        if (state.generation === 2) resolve(state);
      });
    });
    const clearedForStudent = new Promise<SharedTerminalState>((resolve) => {
      student.on(SHARED_TERMINAL_STATE_EVENT, (state: SharedTerminalState) => {
        if (state.generation === 2) resolve(state);
      });
    });
    tutor.emit(SHARED_TERMINAL_ACTION_EVENT, {
      protocolVersion: SHARED_TERMINAL_PROTOCOL_VERSION,
      action: {
        type: "submit-line",
        actionId: "clear-shared-generation",
        value: "clear",
      },
    });
    await expect(Promise.all([clearedForTutor, clearedForStudent]))
      .resolves.toEqual([
        expect.objectContaining({ generation: 2, transcript: "" }),
        expect.objectContaining({ generation: 2, transcript: "" }),
      ]);

    server.eduriContext.db.prepare(`
      UPDATE lessons SET status = 'completed' WHERE id = ?
    `).run(LESSON_ID);
    const rejected = new Promise<SharedTerminalAck>((resolve) => {
      student.once(SHARED_TERMINAL_ACK_EVENT, resolve);
    });
    student.emit(SHARED_TERMINAL_ACTION_EVENT, {
      protocolVersion: SHARED_TERMINAL_PROTOCOL_VERSION,
      action: {
        type: "submit-line",
        actionId: "read-only-terminal-action",
        value: "pwd",
      },
    });
    await expect(rejected).resolves.toMatchObject({
      actionId: "read-only-terminal-action",
      status: "rejected",
      error: "unauthorized",
    });
    expect(student.connected).toBe(true);
  });

  it("emits the current terminal delta before disconnecting a revoked host", async () => {
    // Room insertion order is intentional: the revoked host precedes the
    // authorized observer, reproducing the nested-disconnect ordering hazard.
    const revokedHost = await connect(STUDENT_TOKEN, "student-ordered-host");
    const observer = await connect(TUTOR_TOKEN, "tutor-ordered-observer");
    const startedEffect = nextSocketEvent<SharedTerminalClientEffect>(
      revokedHost,
      SHARED_TERMINAL_EFFECT_EVENT,
      (effect) => effect.type === "start-run",
    );
    const startedDelta = nextSocketEvent<SharedTerminalDelta>(
      observer,
      SHARED_TERMINAL_DELTA_EVENT,
    );
    const startedAck = nextSocketEvent<SharedTerminalAck>(
      revokedHost,
      SHARED_TERMINAL_ACK_EVENT,
      (ack) => ack.actionId === "ordered-start",
    );
    revokedHost.emit(SHARED_TERMINAL_ACTION_EVENT, {
      protocolVersion: SHARED_TERMINAL_PROTOCOL_VERSION,
      action: {
        type: "start-run",
        actionId: "ordered-start",
        entryId: "main-py",
        entrypoint: "main.py",
      },
    });
    const [effect] = await Promise.all([
      startedEffect,
      startedDelta,
      startedAck,
    ]);
    if (effect.type !== "start-run") throw new Error("missing start-run effect");

    const requestedDelta = nextSocketEvent<SharedTerminalDelta>(
      observer,
      SHARED_TERMINAL_DELTA_EVENT,
    );
    const requestedAck = nextSocketEvent<SharedTerminalAck>(
      revokedHost,
      SHARED_TERMINAL_ACK_EVENT,
      (ack) => ack.actionId === "ordered-input-request",
    );
    revokedHost.emit(SHARED_TERMINAL_ACTION_EVENT, {
      protocolVersion: SHARED_TERMINAL_PROTOCOL_VERSION,
      action: {
        type: "host-input-request",
        actionId: "ordered-input-request",
        runId: effect.runId,
        requestId: "ordered-stdin",
      },
    });
    await Promise.all([requestedDelta, requestedAck]);

    server.eduriContext.db.prepare(`
      DELETE FROM sessions WHERE session_hash = ?
    `).run(sha256(STUDENT_TOKEN));
    const disconnected = new Promise<void>((resolve) => {
      revokedHost.once("disconnect", () => resolve());
    });
    const ordered = new Promise<readonly SharedTerminalDelta[]>((resolve, reject) => {
      const deltas: SharedTerminalDelta[] = [];
      const timer = setTimeout(() => {
        observer.off(SHARED_TERMINAL_DELTA_EVENT, handler);
        reject(new Error("Timed out waiting for ordered terminal deltas"));
      }, 2_000);
      const handler = (delta: SharedTerminalDelta) => {
        deltas.push(delta);
        if (deltas.length !== 2) return;
        clearTimeout(timer);
        observer.off(SHARED_TERMINAL_DELTA_EVENT, handler);
        resolve(deltas);
      };
      observer.on(SHARED_TERMINAL_DELTA_EVENT, handler);
    });
    observer.emit(SHARED_TERMINAL_ACTION_EVENT, {
      protocolVersion: SHARED_TERMINAL_PROTOCOL_VERSION,
      action: { type: "interrupt", actionId: "ordered-interrupt" },
    });

    const deltas = await ordered;
    await disconnected;
    expect(deltas[0]?.seq).toBe(deltas[0]!.baseSeq + 1);
    expect(deltas[1]?.baseSeq).toBe(deltas[0]?.seq);
    expect(deltas[1]?.seq).toBe(deltas[0]!.seq + 1);
  });

  it("disconnects terminal sockets when their authenticated session is revoked", async () => {
    const student = await connect(STUDENT_TOKEN, "student-revoked-terminal");
    const leakedStates: SharedTerminalState[] = [];
    student.on(SHARED_TERMINAL_STATE_EVENT, (state: SharedTerminalState) => {
      leakedStates.push(state);
    });
    server.eduriContext.db.prepare(`
      DELETE FROM sessions WHERE session_hash = ?
    `).run(sha256(STUDENT_TOKEN));
    const disconnected = new Promise<void>((resolve) => {
      student.once("disconnect", () => resolve());
    });
    student.emit(SHARED_TERMINAL_ACTION_EVENT, {
      protocolVersion: SHARED_TERMINAL_PROTOCOL_VERSION,
      action: {
        type: "submit-line",
        actionId: "revoked-terminal-action",
        value: "pwd",
      },
    });
    await disconnected;
    expect(student.connected).toBe(false);
    expect(leakedStates).toEqual([]);
  });

  it("disconnects only the revoked lesson member through the shared hook chain", async () => {
    const tutor = await connect(TUTOR_TOKEN, "tutor-hook");
    const student = await connect(STUDENT_TOKEN, "student-hook");
    const disconnected = new Promise<void>((resolve) => student.once("disconnect", () => resolve()));
    server.eduriContext.removeLessonSocketMembership?.(LESSON_ID, STUDENT_ID);
    await disconnected;
    expect(student.connected).toBe(false);
    expect(tutor.connected).toBe(true);
  });
});

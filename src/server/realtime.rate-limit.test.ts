import fs from "node:fs";
import http, { type Server as HttpServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { io as createSocketClient, type Socket } from "socket.io-client";
import { afterEach, describe, expect, it } from "vitest";
import { createApp, getAppContext } from "./app.js";
import { attachRealtime, type RealtimeOptions } from "./realtime.js";
import { sessionCookieName, sha256 } from "./security.js";

const ORIGIN = "http://eduri.test";
const TUTOR_ID = "10000000-0000-4000-8000-000000000001";
const STUDENT_ID = "10000000-0000-4000-8000-000000000002";
const LESSON_ONE_ID = "10000000-0000-4000-8000-000000000101";
const LESSON_TWO_ID = "10000000-0000-4000-8000-000000000102";
const PRIMARY_TOKEN = `primary-rate-session-${"a".repeat(32)}`;
const SECONDARY_TOKEN = `secondary-rate-session-${"b".repeat(32)}`;

interface Harness {
  readonly context: ReturnType<typeof getAppContext>;
  readonly dataDir: string;
  readonly httpServer: HttpServer;
  readonly realtime: ReturnType<typeof attachRealtime>;
  readonly baseUrl: string;
  readonly sockets: Socket[];
}

const harnesses: Harness[] = [];

async function startHarness(options: RealtimeOptions): Promise<Harness> {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "eduri-realtime-rate-"));
  const app = createApp({
    config: {
      nodeEnv: "test",
      appOrigins: [ORIGIN],
      dataDir,
      databasePath: path.join(dataDir, "realtime-rate.sqlite"),
      uploadDir: path.join(dataDir, "uploads"),
      authLookupKey: "realtime-rate-auth-lookup-key-at-least-32-bytes",
      adminLogin: "realtime-rate-admin",
      adminPassword: "realtime-rate-admin-password",
      bcryptRounds: 4,
      trustProxy: "127.0.0.1",
    },
  });
  const context = getAppContext(app);
  const createdAt = "2026-08-09T12:00:00.000Z";
  context.db.prepare(`
    INSERT INTO users (
      id, role, status, display_name, tutor_id, created_at, updated_at
    ) VALUES (?, 'tutor', 'active', 'Rate Tutor', NULL, ?, ?)
  `).run(TUTOR_ID, createdAt, createdAt);
  context.db.prepare(`
    INSERT INTO users (
      id, role, status, display_name, tutor_id, created_at, updated_at
    ) VALUES (?, 'student', 'active', 'Rate Student', ?, ?, ?)
  `).run(STUDENT_ID, TUTOR_ID, createdAt, createdAt);
  const insertSession = context.db.prepare(`
    INSERT INTO sessions (
      session_hash, user_id, expires_at, created_at, last_seen_at
    ) VALUES (?, ?, '2100-01-01T00:00:00.000Z', ?, ?)
  `);
  insertSession.run(sha256(PRIMARY_TOKEN), TUTOR_ID, createdAt, createdAt);
  insertSession.run(sha256(SECONDARY_TOKEN), TUTOR_ID, createdAt, createdAt);
  const insertLesson = context.db.prepare(`
    INSERT INTO lessons (
      id, tutor_id, student_id, title, meeting_key, scheduled_at,
      duration_minutes, status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, '2030-01-02T10:00:00.000Z', 60, 'scheduled', ?, ?)
  `);
  insertLesson.run(
    LESSON_ONE_ID,
    TUTOR_ID,
    STUDENT_ID,
    "Rate lesson one",
    "rate-meeting-one-0000000000000000",
    createdAt,
    createdAt,
  );
  insertLesson.run(
    LESSON_TWO_ID,
    TUTOR_ID,
    STUDENT_ID,
    "Rate lesson two",
    "rate-meeting-two-0000000000000000",
    createdAt,
    createdAt,
  );

  const httpServer = http.createServer(app);
  const realtime = attachRealtime(httpServer, context, options);
  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(0, "127.0.0.1", () => {
      httpServer.off("error", reject);
      resolve();
    });
  });
  const address = httpServer.address();
  if (!address || typeof address === "string") {
    throw new Error("Test server did not expose an address");
  }
  const harness = {
    context,
    dataDir,
    httpServer,
    realtime,
    baseUrl: `http://127.0.0.1:${address.port}`,
    sockets: [],
  } satisfies Harness;
  harnesses.push(harness);
  return harness;
}

async function connect(
  harness: Harness,
  token: string,
  sourceIp?: string,
): Promise<Socket> {
  const socket = createSocketClient(harness.baseUrl, {
    transports: ["websocket"],
    forceNew: true,
    reconnection: false,
    extraHeaders: {
      Cookie: `${sessionCookieName(harness.context)}=${token}`,
      Origin: ORIGIN,
      ...(sourceIp ? { "X-Real-IP": sourceIp } : {}),
    },
  });
  harness.sockets.push(socket);
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("connect_error", reject);
  });
  return socket;
}

async function waitForEngineConnections(
  harness: Harness,
  expected: number,
): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (harness.realtime.engine.clientsCount !== expected) {
    if (Date.now() >= deadline) {
      throw new Error(
        `expected ${expected} Engine.IO connections, got ${harness.realtime.engine.clientsCount}`,
      );
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}

async function join(socket: Socket, lessonId: string): Promise<void> {
  await expect(socket.timeout(2_000).emitWithAck("lesson:join", { lessonId }))
    .resolves.toMatchObject({ ok: true });
}

async function writeCode(
  socket: Socket,
  lessonId: string,
  value: string,
): Promise<Record<string, unknown>> {
  return await socket.timeout(2_000).emitWithAck("lesson:code", {
    lessonId,
    code: { language: "python", value },
  }) as Record<string, unknown>;
}

afterEach(async () => {
  for (const harness of harnesses.splice(0)) {
    for (const socket of harness.sockets) socket.close();
    await new Promise<void>((resolve) => harness.realtime.close(() => resolve()));
    harness.context.stopGuestRoomMaintenance?.();
    harness.context.stopBoardAssetMaintenance?.();
    harness.context.stopMaterialFileMaintenance?.();
    if (harness.context.db.open) harness.context.db.close();
    fs.rmSync(harness.dataDir, { recursive: true, force: true });
  }
});

describe("legacy lesson Code aggregate rate limits", () => {
  it("shares the event budget across sessions, sockets, and reconnects without a rejected SQLite write", async () => {
    let rateNow = Date.parse("2026-08-09T12:00:00.000Z");
    const harness = await startHarness({
      lessonCodeEventsPerMinute: 2,
      lessonCodeBytesPerMinute: 10_000,
      maxLessonCodeRateScopes: 8,
      lessonCodeRateScopeIdleMs: 60_000,
      now: () => rateNow,
    });
    const first = await connect(harness, PRIMARY_TOKEN);
    const second = await connect(harness, SECONDARY_TOKEN);
    await join(first, LESSON_ONE_ID);
    await join(second, LESSON_ONE_ID);

    await expect(writeCode(first, LESSON_ONE_ID, "print('first')"))
      .resolves.toMatchObject({ ok: true, revision: 1 });
    await expect(writeCode(second, LESSON_ONE_ID, "print('second')"))
      .resolves.toMatchObject({ ok: true, revision: 2 });

    first.close();
    second.close();
    const reconnected = await connect(harness, SECONDARY_TOKEN);
    await join(reconnected, LESSON_ONE_ID);
    const changesBefore = (harness.context.db.prepare(
      "SELECT total_changes() AS count",
    ).get() as { count: number }).count;
    await expect(writeCode(reconnected, LESSON_ONE_ID, "print('blocked')"))
      .resolves.toMatchObject({
        ok: false,
        code: "RATE_LIMITED",
        retryAfterMs: 60_000,
      });
    expect((harness.context.db.prepare(
      "SELECT total_changes() AS count",
    ).get() as { count: number }).count).toBe(changesBefore);
    expect(harness.context.db.prepare(`
      SELECT code_revision, code_state FROM lessons WHERE id = ?
    `).get(LESSON_ONE_ID)).toEqual({
      code_revision: 2,
      code_state: JSON.stringify({
        language: "python",
        value: "print('second')",
      }),
    });

    rateNow += 60_000;
    await expect(writeCode(reconnected, LESSON_ONE_ID, "print('after-window')"))
      .resolves.toMatchObject({ ok: true, revision: 3 });
  });

  it("shares the byte budget across a reconnect", async () => {
    const firstCode = { language: "python", value: "a".repeat(20) } as const;
    const secondCode = { language: "python", value: "b".repeat(20) } as const;
    const firstBytes = Buffer.byteLength(JSON.stringify(firstCode));
    const secondBytes = Buffer.byteLength(JSON.stringify(secondCode));
    const harness = await startHarness({
      lessonCodeEventsPerMinute: 10,
      lessonCodeBytesPerMinute: firstBytes + secondBytes - 1,
      maxLessonCodeRateScopes: 8,
    });
    const first = await connect(harness, PRIMARY_TOKEN);
    await join(first, LESSON_ONE_ID);
    await expect(writeCode(first, LESSON_ONE_ID, firstCode.value))
      .resolves.toMatchObject({ ok: true, revision: 1 });

    first.close();
    const reconnected = await connect(harness, SECONDARY_TOKEN);
    await join(reconnected, LESSON_ONE_ID);
    await expect(writeCode(reconnected, LESSON_ONE_ID, secondCode.value))
      .resolves.toMatchObject({
        ok: false,
        code: "RATE_LIMITED",
      });
    expect(harness.context.db.prepare(
      "SELECT code_revision FROM lessons WHERE id = ?",
    ).get(LESSON_ONE_ID)).toEqual({ code_revision: 1 });
  });

  it("fails closed at the scope bound and reclaims an idle scope", async () => {
    let rateNow = Date.parse("2026-08-09T12:00:00.000Z");
    const harness = await startHarness({
      lessonCodeEventsPerMinute: 10,
      lessonCodeBytesPerMinute: 10_000,
      maxLessonCodeRateScopes: 1,
      lessonCodeRateScopeIdleMs: 60_000,
      now: () => rateNow,
    });
    const socket = await connect(harness, PRIMARY_TOKEN);
    await join(socket, LESSON_ONE_ID);
    await join(socket, LESSON_TWO_ID);
    await expect(writeCode(socket, LESSON_ONE_ID, "print('one')"))
      .resolves.toMatchObject({ ok: true });
    await expect(writeCode(socket, LESSON_TWO_ID, "print('full')"))
      .resolves.toMatchObject({ ok: false, code: "RATE_LIMITED" });

    rateNow += 60_000;
    await expect(writeCode(socket, LESSON_TWO_ID, "print('reclaimed')"))
      .resolves.toMatchObject({ ok: true, revision: 1 });
    expect(harness.context.db.prepare(`
      SELECT id, code_revision FROM lessons ORDER BY id
    `).all()).toEqual([
      { id: LESSON_ONE_ID, code_revision: 1 },
      { id: LESSON_TWO_ID, code_revision: 1 },
    ]);
  });
});

describe("app-wide Socket.IO admission and ingress limits", () => {
  it("caps total/per-IP Engine.IO connections and releases admission on disconnect", async () => {
    const harness = await startHarness({
      maxConnections: 3,
      maxConnectionsPerIp: 2,
      connectionAttemptsPerMinute: 100,
      connectionAttemptsPerIpPerMinute: 100,
    });
    const first = await connect(harness, PRIMARY_TOKEN, "192.0.2.1");
    await connect(harness, SECONDARY_TOKEN, "192.0.2.1");
    await waitForEngineConnections(harness, 2);

    const perIpOverflow = createSocketClient(harness.baseUrl, {
      transports: ["websocket"],
      forceNew: true,
      reconnection: false,
      extraHeaders: {
        Cookie: `${sessionCookieName(harness.context)}=${PRIMARY_TOKEN}`,
        Origin: ORIGIN,
        "X-Real-IP": "192.0.2.1",
      },
    });
    harness.sockets.push(perIpOverflow);
    const perIpRejected = new Promise<Error>((resolve) => {
      perIpOverflow.once("connect_error", resolve);
    });
    await expect(perIpRejected).resolves.toBeInstanceOf(Error);
    expect(perIpOverflow.connected).toBe(false);

    await connect(harness, PRIMARY_TOKEN, "192.0.2.2");
    await waitForEngineConnections(harness, 3);
    const totalOverflow = createSocketClient(harness.baseUrl, {
      transports: ["websocket"],
      forceNew: true,
      reconnection: false,
      extraHeaders: {
        Cookie: `${sessionCookieName(harness.context)}=${PRIMARY_TOKEN}`,
        Origin: ORIGIN,
        "X-Real-IP": "192.0.2.3",
      },
    });
    harness.sockets.push(totalOverflow);
    const totalRejected = new Promise<Error>((resolve) => {
      totalOverflow.once("connect_error", resolve);
    });
    await expect(totalRejected).resolves.toBeInstanceOf(Error);
    expect(totalOverflow.connected).toBe(false);

    first.close();
    await waitForEngineConnections(harness, 2);
    const replacement = await connect(harness, PRIMARY_TOKEN, "192.0.2.1");
    expect(replacement.connected).toBe(true);
    await waitForEngineConnections(harness, 3);
  });

  it("charges malformed near-5 MiB events before validation across parallel sockets and reconnects", async () => {
    let rateNow = Date.parse("2026-08-09T12:00:00.000Z");
    const harness = await startHarness({
      maxConnections: 10,
      maxConnectionsPerIp: 10,
      connectionAttemptsPerMinute: 100,
      connectionAttemptsPerIpPerMinute: 100,
      socketIngressEventsPerUserPerMinute: 100,
      socketIngressBytesPerUserPerMinute: 4 * 1024 * 1024,
      socketIngressEventsPerIpPerMinute: 1_000,
      socketIngressBytesPerIpPerMinute: 64 * 1024 * 1024,
      socketIngressEventsGlobalPerMinute: 10_000,
      socketIngressBytesGlobalPerMinute: 256 * 1024 * 1024,
      now: () => rateNow,
    });
    const first = await connect(harness, PRIMARY_TOKEN);
    const parallel = await connect(harness, SECONDARY_TOKEN);
    await join(first, LESSON_ONE_ID);
    await join(parallel, LESSON_ONE_ID);

    const firstDisconnected = new Promise<string>((resolve) => {
      first.once("disconnect", resolve);
    });
    const malformed = "x".repeat(5 * 1024 * 1024 - 8 * 1024);
    await expect(first.timeout(5_000).emitWithAck("malformed:event", malformed))
      .resolves.toMatchObject({
        ok: false,
        code: "RATE_LIMITED",
        retryAfterMs: 60_000,
      });
    await expect(firstDisconnected).resolves.toBe("io server disconnect");

    const parallelDisconnected = new Promise<string>((resolve) => {
      parallel.once("disconnect", resolve);
    });
    await expect(writeCode(parallel, LESSON_ONE_ID, "print('must-not-write')"))
      .resolves.toMatchObject({ ok: false, code: "RATE_LIMITED" });
    await expect(parallelDisconnected).resolves.toBe("io server disconnect");
    expect(harness.context.db.prepare(`
      SELECT code_revision FROM lessons WHERE id = ?
    `).get(LESSON_ONE_ID)).toEqual({ code_revision: 0 });

    rateNow += 60_000;
    const reconnected = await connect(harness, SECONDARY_TOKEN);
    await join(reconnected, LESSON_ONE_ID);
    await expect(writeCode(reconnected, LESSON_ONE_ID, "print('after-window')"))
      .resolves.toMatchObject({ ok: true, revision: 1 });
  });

  it("charges unknown namespaces before Socket.IO routing and holds the trusted IP window", async () => {
    const harness = await startHarness({
      maxConnections: 10,
      maxConnectionsPerIp: 10,
      connectionAttemptsPerMinute: 100,
      connectionAttemptsPerIpPerMinute: 100,
      socketIngressEventsPerIpPerMinute: 2,
      socketIngressBytesPerIpPerMinute: 64 * 1024 * 1024,
      socketIngressEventsGlobalPerMinute: 100,
      socketIngressBytesGlobalPerMinute: 256 * 1024 * 1024,
    });
    const socket = await connect(harness, PRIMARY_TOKEN, "192.0.2.40");
    const disconnected = new Promise<string>((resolve) => {
      socket.once("disconnect", resolve);
    });

    // These packets never create a namespace Socket, so namespace middleware
    // cannot account for them. The Engine.IO wire guard must see both before
    // Socket.IO parses/routes them and close on the second one.
    socket.io.engine.write("0/unknown-first,{}");
    socket.io.engine.write("0/unknown-second,{}");
    await expect(disconnected).resolves.toBe("transport close");

    const sameIp = createSocketClient(harness.baseUrl, {
      transports: ["websocket"],
      forceNew: true,
      reconnection: false,
      extraHeaders: {
        Cookie: `${sessionCookieName(harness.context)}=${PRIMARY_TOKEN}`,
        Origin: ORIGIN,
        "X-Real-IP": "192.0.2.40",
      },
    });
    harness.sockets.push(sameIp);
    const sameIpError = new Promise<Error>((resolve) => {
      sameIp.once("connect_error", resolve);
    });
    await expect(sameIpError).resolves.toBeInstanceOf(Error);

    await expect(connect(harness, PRIMARY_TOKEN, "192.0.2.41"))
      .resolves.toBeDefined();
  });
});

import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";

import request from "supertest";
import sharp from "sharp";
import WebSocket, { type RawData } from "ws";
import { afterEach, describe, expect, it } from "vitest";

import {
  BOARD_SUBPROTOCOL,
  BoardControlCode,
  BoardMessageType,
  decodeBoardFrame,
  encodeBoardFrame,
  type BoardFrame,
} from "../../board/protocol/index.js";
import { createServer, type EduriServer } from "../server.js";
import {
  csrfForSession,
  nowIso,
  randomToken,
  readAuthFromToken,
  sha256 as hashSession,
} from "../security.js";
import { BoardRepository } from "./repository.js";
import {
  BOARD_SYNC_SERVER_CAPABILITIES,
  type BoardSyncTicketResponse,
} from "./sync-service.js";

const ORIGIN = "http://eduri.test";
const AUTH_KEY = "board-assets-router-auth-key-at-least-32-bytes";

interface Session {
  userId: string;
  rawToken: string;
  cookie: string;
  csrf: string;
}

interface LessonFixture {
  lessonId: string;
  boardId: string;
  generation: number;
  tutor: Session;
  student: Session;
}

interface Harness {
  server: EduriServer;
  dataDir: string;
  baseUrl: string;
  wsUrl: string;
  sockets: Set<WebSocket>;
}

const harnesses = new Set<Harness>();

function hash(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

async function createHarness(
  boardV2FoundationEnabled = true,
): Promise<Harness> {
  const dataDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "eduri-board-assets-router-"),
  );
  const server = createServer({
    config: {
      nodeEnv: "test",
      appOrigins: [ORIGIN],
      dataDir,
      databasePath: path.join(dataDir, "assets.sqlite"),
      uploadDir: path.join(dataDir, "uploads"),
      boardAssetDir: path.join(dataDir, "private-board-assets"),
      boardAssetMaxBytes: 1024 * 1024,
      boardAssetMaxChunkBytes: 1024,
      boardAssetTenantQuotaBytes: 16 * 1024 * 1024,
      boardAssetMinFreeDiskBytes: 1,
      authLookupKey: AUTH_KEY,
      adminLogin: `admin-${randomUUID()}`,
      adminPassword: "board-assets-router-admin-password",
      bcryptRounds: 4,
      boardV2FoundationEnabled,
    },
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address() as AddressInfo;
  const harness = {
    server,
    dataDir,
    baseUrl: `http://127.0.0.1:${address.port}`,
    wsUrl: `ws://127.0.0.1:${address.port}/api/board-v2/sync`,
    sockets: new Set<WebSocket>(),
  };
  harnesses.add(harness);
  return harness;
}

async function disposeHarness(harness: Harness): Promise<void> {
  if (!harnesses.delete(harness)) return;
  for (const socket of harness.sockets) socket.terminate();
  harness.server.eduriBoardV2.close();
  await new Promise<void>((resolve) => {
    harness.server.eduriIo.close(() => resolve());
  });
  if (harness.server.listening) {
    await new Promise<void>((resolve) => harness.server.close(() => resolve()));
  }
  if (harness.server.eduriContext.db.open) {
    harness.server.eduriContext.db.close();
  }
  fs.rmSync(harness.dataDir, { recursive: true, force: true });
}

afterEach(async () => {
  for (const harness of [...harnesses]) await disposeHarness(harness);
});

function createSession(harness: Harness, userId: string): Session {
  const rawToken = randomToken();
  const sessionHash = hashSession(rawToken);
  const now = nowIso();
  harness.server.eduriContext.db.prepare(`
    INSERT INTO sessions (
      session_hash, user_id, expires_at, created_at, last_seen_at,
      ip_address, user_agent
    ) VALUES (?, ?, ?, ?, ?, NULL, 'board-assets-router-test')
  `).run(
    sessionHash,
    userId,
    new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    now,
    now,
  );
  return {
    userId,
    rawToken,
    cookie: `eduri_session=${rawToken}`,
    csrf: csrfForSession(AUTH_KEY, rawToken),
  };
}

function createLessonFixture(
  harness: Harness,
  status: "scheduled" | "active" | "completed" = "scheduled",
): LessonFixture {
  const db = harness.server.eduriContext.db;
  const tutorId = randomUUID();
  const studentId = randomUUID();
  const lessonId = randomUUID();
  const now = nowIso();
  db.prepare(`
    INSERT INTO users (
      id, role, status, display_name, tutor_id, created_at, updated_at
    ) VALUES (?, 'tutor', 'active', 'Tutor', NULL, ?, ?)
  `).run(tutorId, now, now);
  db.prepare(`
    INSERT INTO users (
      id, role, status, display_name, tutor_id, created_at, updated_at
    ) VALUES (?, 'student', 'active', 'Student', ?, ?, ?)
  `).run(studentId, tutorId, now, now);
  db.prepare(`
    INSERT INTO lessons (
      id, tutor_id, student_id, title, meeting_key, scheduled_at,
      duration_minutes, status, created_at, updated_at
    ) VALUES (?, ?, ?, 'Asset route test', ?, ?, 60, ?, ?, ?)
  `).run(
    lessonId,
    tutorId,
    studentId,
    randomToken(24),
    new Date(Date.now() + 60_000).toISOString(),
    status,
    now,
    now,
  );
  const tutor = createSession(harness, tutorId);
  const student = createSession(harness, studentId);
  const enabledService = harness.server.eduriContext.boardV2Sync;
  const board = enabledService
    ? enabledService.issueTicket(
        readAuthFromToken(
          harness.server.eduriContext,
          tutor.rawToken,
        )!,
        {
          lessonId,
          minSchemaVersion: 1,
          maxSchemaVersion: 1,
          capabilities: BOARD_SYNC_SERVER_CAPABILITIES,
        },
      )
    : new BoardRepository(db).createBoardForLesson(
        lessonId,
        { engine: "v2" },
      );
  return {
    lessonId,
    boardId: "boardId" in board ? board.boardId : board.id,
    generation: board.generation,
    tutor,
    student,
  };
}

function beginBody(
  fixture: LessonFixture,
  value: Uint8Array,
  assetId = randomUUID(),
) {
  return {
    boardId: fixture.boardId,
    generation: fixture.generation,
    assetId,
    sha256: hash(value),
    byteSize: value.byteLength,
    declaredMime: "image/png",
    originalFileName: "plot.png",
  };
}

async function beginUpload(
  harness: Harness,
  session: Session,
  body: ReturnType<typeof beginBody>,
) {
  return request(harness.baseUrl)
    .post("/api/board-v2/assets/begin")
    .set("Origin", ORIGIN)
    .set("Cookie", session.cookie)
    .set("x-csrf-token", session.csrf)
    .send(body);
}

async function putChunk(
  harness: Harness,
  session: Session,
  fixture: LessonFixture,
  assetId: string,
  uploadId: string,
  chunk: Uint8Array,
  offset = 0,
  chunkHash = hash(chunk),
) {
  return request(harness.baseUrl)
    .put(
      `/api/board-v2/assets/${assetId}/uploads/${uploadId}/chunks`
      + `?boardId=${fixture.boardId}&generation=${fixture.generation}`,
    )
    .set("Origin", ORIGIN)
    .set("Cookie", session.cookie)
    .set("x-csrf-token", session.csrf)
    .set("content-type", "application/octet-stream")
    .set("x-upload-offset", String(offset))
    .set("x-asset-chunk-sha256", chunkHash)
    .send(Buffer.from(chunk));
}

async function finalizeUpload(
  harness: Harness,
  session: Session,
  fixture: LessonFixture,
  assetId: string,
  uploadId: string,
) {
  return request(harness.baseUrl)
    .post(
      `/api/board-v2/assets/${assetId}/uploads/${uploadId}/finalize`,
    )
    .set("Origin", ORIGIN)
    .set("Cookie", session.cookie)
    .set("x-csrf-token", session.csrf)
    .send({
      boardId: fixture.boardId,
      generation: fixture.generation,
    });
}

function frameFromRaw(data: RawData): BoardFrame {
  const bytes = Array.isArray(data)
    ? Uint8Array.from(Buffer.concat(data))
    : data instanceof ArrayBuffer
      ? new Uint8Array(data)
      : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  return decodeBoardFrame(bytes);
}

function nextFrame<T extends BoardFrame>(
  socket: WebSocket,
  predicate: (frame: BoardFrame) => frame is T,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("Timed out waiting for Board frame"));
    }, 3_000);
    const onMessage = (data: RawData, isBinary: boolean) => {
      if (!isBinary) return;
      const frame = frameFromRaw(data);
      if (!predicate(frame)) return;
      cleanup();
      resolve(frame);
    };
    const onClose = (code: number) => {
      cleanup();
      reject(new Error(`WebSocket closed with ${code}`));
    };
    const cleanup = () => {
      clearTimeout(timeout);
      socket.off("message", onMessage);
      socket.off("close", onClose);
    };
    socket.on("message", onMessage);
    socket.on("close", onClose);
  });
}

async function authenticatedSocket(
  harness: Harness,
  fixture: LessonFixture,
  session: Session,
): Promise<WebSocket> {
  const ticketResponse = await request(harness.baseUrl)
    .post("/api/board-v2/sync-ticket")
    .set("Origin", ORIGIN)
    .set("Cookie", session.cookie)
    .set("x-csrf-token", session.csrf)
    .send({
      lessonId: fixture.lessonId,
      minSchemaVersion: 1,
      maxSchemaVersion: 1,
      capabilities: BOARD_SYNC_SERVER_CAPABILITIES,
    })
    .expect(200);
  const ticket = ticketResponse.body as BoardSyncTicketResponse;
  const socket = await new Promise<WebSocket>((resolve, reject) => {
    const created = new WebSocket(
      harness.wsUrl,
      BOARD_SUBPROTOCOL,
      { origin: ORIGIN },
    );
    created.once("error", reject);
    created.once("open", () => resolve(created));
  });
  harness.sockets.add(socket);
  socket.once("close", () => harness.sockets.delete(socket));
  const ready = nextFrame(
    socket,
    (
      frame,
    ): frame is Extract<BoardFrame, { type: BoardMessageType.READY }> =>
      frame.type === BoardMessageType.READY,
  );
  socket.send(encodeBoardFrame({
    type: BoardMessageType.AUTH,
    ticket: ticket.ticket,
    generation: ticket.generation,
    minSchemaVersion: 1,
    maxSchemaVersion: 1,
    capabilities: ticket.capabilities,
  }));
  await ready;
  return socket;
}

describe("Board v2 asset HTTP integration", () => {
  it("allows Board v2 chunk headers in an authenticated-origin preflight", async () => {
    const harness = await createHarness();
    const response = await request(harness.baseUrl)
      .options("/api/board-v2/assets/example/uploads/example/chunks")
      .set("Origin", ORIGIN)
      .set("Access-Control-Request-Method", "PUT")
      .set(
        "Access-Control-Request-Headers",
        "content-type,x-csrf-token,x-upload-offset,x-asset-chunk-sha256",
      )
      .expect(204);
    const allowed = String(
      response.headers["access-control-allow-headers"] ?? "",
    ).toLowerCase();
    expect(allowed).toContain("x-upload-offset");
    expect(allowed).toContain("x-asset-chunk-sha256");
  });

  it("is absent when the Board v2 feature flag is disabled", async () => {
    const harness = await createHarness(false);
    const fixture = createLessonFixture(harness);
    const value = Uint8Array.of(1, 2, 3);
    await beginUpload(
      harness,
      fixture.tutor,
      beginBody(fixture, value),
    ).then((response) => {
      expect(response.status).toBe(404);
    });
    expect(harness.server.eduriContext.boardAssets).toBeUndefined();
  });

  it("enforces auth, CSRF, binary chunk integrity, and tenant non-disclosure", async () => {
    const harness = await createHarness();
    const fixture = createLessonFixture(harness);
    const other = createLessonFixture(harness);
    const value = await sharp({
      create: {
        width: 3,
        height: 2,
        channels: 4,
        background: { r: 20, g: 40, b: 60, alpha: 1 },
      },
    }).png().toBuffer();
    const body = beginBody(fixture, value);

    await request(harness.baseUrl)
      .post("/api/board-v2/assets/begin")
      .set("Origin", ORIGIN)
      .send(body)
      .expect(401);
    await request(harness.baseUrl)
      .post("/api/board-v2/assets/begin")
      .set("Origin", ORIGIN)
      .set("Cookie", fixture.tutor.cookie)
      .send(body)
      .expect(403);

    const started = await beginUpload(harness, fixture.tutor, body);
    expect(started.status).toBe(200);
    expect(started.headers["ratelimit-policy"]).toContain("10000;w=600");
    expect(started.body).toMatchObject({
      status: "upload",
      nextOffset: 0,
    });
    const pendingStatus = await request(harness.baseUrl)
      .get(
        `/api/board-v2/assets/${body.assetId}/status`
        + `?boardId=${fixture.boardId}&generation=${fixture.generation}`,
      )
      .set("Origin", ORIGIN)
      .set("Cookie", fixture.student.cookie)
      .expect(200);
    expect(pendingStatus.body).toMatchObject({
      status: "pending",
      assetId: body.assetId,
    });
    expect(pendingStatus.body).not.toHaveProperty("uploadId");

    await request(harness.baseUrl)
      .put(
        `/api/board-v2/assets/${body.assetId}/uploads/${started.body.uploadId}/chunks`
        + `?boardId=${fixture.boardId}&generation=${fixture.generation}`,
      )
      .set("Origin", ORIGIN)
      .set("Cookie", fixture.tutor.cookie)
      .set("x-csrf-token", fixture.tutor.csrf)
      .set("content-type", "text/plain")
      .send("wrong type")
      .expect(415);

    const wrongOffset = await putChunk(
      harness,
      fixture.tutor,
      fixture,
      body.assetId,
      started.body.uploadId,
      value,
      1,
    );
    expect(wrongOffset.status).toBe(409);
    expect(wrongOffset.body.code).toBe("OFFSET_MISMATCH");

    const wrongHash = await putChunk(
      harness,
      fixture.tutor,
      fixture,
      body.assetId,
      started.body.uploadId,
      value,
      0,
      "b".repeat(64),
    );
    expect(wrongHash.status).toBe(409);
    expect(wrongHash.body.code).toBe("CHUNK_HASH_MISMATCH");

    await putChunk(
      harness,
      fixture.tutor,
      fixture,
      body.assetId,
      started.body.uploadId,
      new Uint8Array(1025),
    ).then((response) => {
      expect(response.status).toBe(413);
      expect(response.body.code).toBe("CHUNK_TOO_LARGE");
    });

    await request(harness.baseUrl)
      .get(
        `/api/board-v2/assets/${body.assetId}/status`
        + `?boardId=${fixture.boardId}&generation=${fixture.generation}`,
      )
      .set("Origin", ORIGIN)
      .set("Cookie", other.tutor.cookie)
      .expect(404);
  });

  it("publishes a valid image, broadcasts readiness, serves ranges, and locks writes on completion", async () => {
    const harness = await createHarness();
    const fixture = createLessonFixture(harness);
    const value = await sharp({
      create: {
        width: 4,
        height: 3,
        channels: 4,
        background: { r: 200, g: 100, b: 10, alpha: 1 },
      },
    }).png().toBuffer();
    const body = beginBody(fixture, value);
    const started = await beginUpload(harness, fixture.tutor, body);
    expect(started.status).toBe(200);
    const studentSocket = await authenticatedSocket(
      harness,
      fixture,
      fixture.student,
    );
    const assetReady = nextFrame(
      studentSocket,
      (
        frame,
      ): frame is Extract<BoardFrame, { type: BoardMessageType.CONTROL }> =>
        frame.type === BoardMessageType.CONTROL
        && frame.code === BoardControlCode.ASSET_READY,
    );

    await putChunk(
      harness,
      fixture.tutor,
      fixture,
      body.assetId,
      started.body.uploadId,
      value,
    ).then((response) => {
      expect(response.status).toBe(200);
      expect(response.body.complete).toBe(true);
    });
    const finalized = await finalizeUpload(
      harness,
      fixture.tutor,
      fixture,
      body.assetId,
      started.body.uploadId,
    );
    expect(finalized.status).toBe(200);
    expect(finalized.body).toMatchObject({
      status: "ready",
      assetId: body.assetId,
      sha256: body.sha256,
      mimeType: "image/png",
      byteSize: value.byteLength,
      width: 4,
      height: 3,
      frameCount: 1,
      totalDecodedPixels: 12,
    });

    const readyFrame = await assetReady;
    expect(readyFrame.generation).toBe(fixture.generation);
    expect(
      JSON.parse(new TextDecoder().decode(readyFrame.payload)),
    ).toMatchObject({
      assetId: body.assetId,
      sha256: body.sha256,
      width: 4,
      height: 3,
      frameCount: 1,
      totalDecodedPixels: 12,
    });

    const ranged = await request(harness.baseUrl)
      .get(
        `/api/board-v2/assets/${body.assetId}/content`
        + `?boardId=${fixture.boardId}&generation=${fixture.generation}`,
      )
      .set("Origin", ORIGIN)
      .set("Cookie", fixture.student.cookie)
      .set("Range", "bytes=1-5")
      .expect(206)
      .expect("Accept-Ranges", "bytes")
      .expect("Content-Range", `bytes 1-5/${value.byteLength}`)
      .expect("Cache-Control", "private, max-age=31536000, immutable");
    expect(Buffer.from(ranged.body)).toEqual(Buffer.from(value.slice(1, 6)));
    await request(harness.baseUrl)
      .get(
        `/api/board-v2/assets/${body.assetId}/content`
        + `?boardId=${fixture.boardId}&generation=${fixture.generation}`,
      )
      .set("Origin", ORIGIN)
      .set("Cookie", fixture.student.cookie)
      .set("Range", `bytes=${value.byteLength}-`)
      .expect(416);
    const metrics = await request(harness.baseUrl)
      .get(
        "/api/board-v2/assets/metrics"
        + `?boardId=${fixture.boardId}&generation=${fixture.generation}`,
      )
      .set("Origin", ORIGIN)
      .set("Cookie", fixture.tutor.cookie)
      .expect(200);
    expect(metrics.body).toEqual({
      assetCount: 1,
      logicalBytes: value.byteLength,
      readyCount: 1,
      readyBytes: value.byteLength,
      physicalBlobCount: 1,
      physicalBlobBytes: value.byteLength,
      pendingCount: 0,
    });

    const pendingBody = beginBody(fixture, value, randomUUID());
    const pending = await beginUpload(harness, fixture.tutor, pendingBody);
    expect(pending.status).toBe(200);
    harness.server.eduriContext.db.prepare(`
      UPDATE lessons SET status = 'completed', updated_at = ? WHERE id = ?
    `).run(nowIso(), fixture.lessonId);

    await request(harness.baseUrl)
      .get(
        `/api/board-v2/assets/${body.assetId}/status`
        + `?boardId=${fixture.boardId}&generation=${fixture.generation}`,
      )
      .set("Origin", ORIGIN)
      .set("Cookie", fixture.student.cookie)
      .expect(200);
    await putChunk(
      harness,
      fixture.tutor,
      fixture,
      pendingBody.assetId,
      pending.body.uploadId,
      value,
    ).then((response) => {
      expect(response.status).toBe(403);
    });
    await beginUpload(
      harness,
      fixture.tutor,
      beginBody(fixture, value, randomUUID()),
    ).then((response) => {
      expect(response.status).toBe(403);
    });
  });

  it("stops the cleanup timer before closing the owned database", async () => {
    const harness = await createHarness();
    expect(harness.server.eduriContext.stopBoardAssetMaintenance)
      .toBeTypeOf("function");
    const context = harness.server.eduriContext;
    await disposeHarness(harness);
    expect(context.stopBoardAssetMaintenance).toBeUndefined();
    expect(context.db.open).toBe(false);
  });
});

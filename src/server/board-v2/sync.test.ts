import { randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs";
import { connect, type AddressInfo, type Socket } from "node:net";
import os from "node:os";
import path from "node:path";

import request from "supertest";
import WebSocket, { type RawData } from "ws";
import * as Y from "yjs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
  createBoardObject,
  createCodeProps,
  getManifestPages,
  getPageObjects,
} from "../../board/core/index.js";
import type {
  BoardClientPersistence,
  BoardRecoverySignal,
  PendingBoardUpdate,
} from "../../board/persistence/index.js";
import {
  BOARD_PROTOCOL_LIMITS,
  BOARD_SUBPROTOCOL,
  BoardCapability,
  BoardControlCode,
  BoardMessageType,
  BoardPermission,
  decodeBoardProfileUpdatedPayload,
  decodeBoardFrame,
  encodeBoardProfileUpdatePayload,
  encodeBoardFrame,
  messageIdToHex,
  type BoardFrame,
} from "../../board/protocol/index.js";
import {
  BoardNetworkProvider,
  type BoardSocket,
  type BoardSocketCloseEvent,
} from "../../client/board/networkProvider.js";
import { createServer, type EduriServer } from "../server.js";
import {
  csrfForSession,
  nowIso,
  randomToken,
  readAuthFromToken,
  sha256,
} from "../security.js";
import {
  GUEST_ROOM_INITIALIZATION_TTL_MS,
  GuestRoomService,
} from "../guestRooms.js";
import {
  authorizeAwarenessUpdate,
  BoardAwarenessRegistry,
  encodeAwarenessState,
  parseAwarenessUpdate,
} from "./sync-awareness.js";
import {
  BOARD_SYNC_SERVER_CAPABILITIES,
  BOARD_SYNC_WEBSOCKET_PATH,
  BoardSyncService,
  type BoardSyncTicketResponse,
} from "./sync-service.js";
import {
  BOARD_SYNC_TICKET_TTL_MS,
  MAX_ACTIVE_BOARD_TICKETS_PER_SESSION,
  MAX_ACTIVE_BOARD_TICKETS_PER_USER,
  BoardSyncTicketStore,
} from "./sync-ticket.js";
import {
  BOARD_SYNC_ADMISSION_LIMITS,
  resolveBoardSyncSourceIp,
} from "./sync-transport.js";

const ORIGIN = "http://eduri.test";
const AUTH_KEY = "board-sync-test-auth-lookup-key-at-least-32-bytes";

interface TestSession {
  userId: string;
  rawToken: string;
  sessionHash: string;
  cookie: string;
  csrf: string;
}

interface LessonFixture {
  lessonId: string;
  tutorId: string;
  studentId: string;
  tutor: TestSession;
  student: TestSession;
}

interface SyncHarness {
  server: EduriServer;
  dataDir: string;
  httpUrl: string;
  wsUrl: string;
  sockets: Set<WebSocket>;
}

interface AuthenticatedSocket {
  ws: WebSocket;
  ready: Extract<BoardFrame, { type: BoardMessageType.READY }>;
  ticket: BoardSyncTicketResponse;
}

function clonePendingUpdate(update: PendingBoardUpdate): PendingBoardUpdate {
  return {
    ...update,
    messageId: update.messageId.slice(),
    update: update.update.slice(),
  };
}

class MemoryClientPersistence implements BoardClientPersistence {
  readonly whenReady = Promise.resolve();
  readonly pending = new Map<string, PendingBoardUpdate>();
  private recovery: BoardRecoverySignal | null = null;

  constructor(updates: readonly PendingBoardUpdate[] = []) {
    for (const update of updates) {
      this.pending.set(messageIdToHex(update.messageId), clonePendingUpdate(update));
    }
  }

  async enqueuePendingUpdate(update: PendingBoardUpdate): Promise<void> {
    this.pending.set(messageIdToHex(update.messageId), clonePendingUpdate(update));
  }

  async listPendingUpdates(): Promise<readonly PendingBoardUpdate[]> {
    return [...this.pending.values()].map(clonePendingUpdate);
  }

  async rebasePendingUpdates(
    replacements: readonly PendingBoardUpdate[],
    coveredUpdates: readonly PendingBoardUpdate[],
  ): Promise<{ committed: true; currentUpdates: readonly PendingBoardUpdate[] }> {
    for (const update of coveredUpdates) {
      this.pending.delete(messageIdToHex(update.messageId));
    }
    for (const replacement of replacements) {
      this.pending.set(
        messageIdToHex(replacement.messageId),
        clonePendingUpdate(replacement),
      );
    }
    return {
      committed: true,
      currentUpdates: [...this.pending.values()].map(clonePendingUpdate),
    };
  }

  async acknowledgePendingUpdate(
    messageId: Uint8Array,
    _durableSequence: number,
  ): Promise<void> {
    this.pending.delete(messageIdToHex(messageId));
  }

  async listDocumentUpdates(): Promise<readonly Uint8Array[]> {
    return [];
  }

  async getRecoverySignal(): Promise<BoardRecoverySignal | null> {
    return this.recovery
      ? {
          ...this.recovery,
          messageId: this.recovery.messageId?.slice(),
          payload: this.recovery.payload?.slice(),
        }
      : null;
  }

  async setRecoverySignal(signal: BoardRecoverySignal): Promise<void> {
    this.recovery = {
      ...signal,
      messageId: signal.messageId?.slice(),
      payload: signal.payload?.slice(),
    };
  }
}

class RecordingBoardSocket implements BoardSocket {
  binaryType = "arraybuffer";
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: BoardSocketCloseEvent) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;

  private readonly ws: WebSocket;

  constructor(
    url: string,
    subprotocol: string,
    private readonly outbound: BoardFrame[],
    sockets: Set<WebSocket>,
  ) {
    this.ws = new WebSocket(url, subprotocol, { origin: ORIGIN });
    sockets.add(this.ws);
    this.ws.on("open", () => this.onopen?.({}));
    this.ws.on("message", (data, isBinary) => {
      this.onmessage?.({
        data: isBinary ? bytesFromRaw(data) : data.toString(),
      });
    });
    this.ws.on("close", (code, reason) => {
      sockets.delete(this.ws);
      this.onclose?.({ code, reason: reason.toString() });
    });
    this.ws.on("error", (error) => this.onerror?.(error));
  }

  send(data: Uint8Array): void {
    this.outbound.push(decodeBoardFrame(data));
    this.ws.send(data);
  }

  close(code?: number, reason?: string): void {
    this.ws.close(code, reason);
  }
}

async function waitForCondition(
  predicate: () => boolean,
  description: string,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for ${description}`);
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}

async function createHarness(
  boardV2FoundationEnabled = true,
  overrides: {
    readonly boardV2ActiveDocumentCacheBytes?: number;
    readonly boardV2TenantQuotaBytes?: number;
    readonly boardV2MinFreeDiskBytes?: number;
    readonly boardV2SessionAuditIntervalMs?: number;
  } = {},
): Promise<SyncHarness> {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "eduri-board-sync-"));
  const server = createServer({
    config: {
      nodeEnv: "test",
      appOrigins: [ORIGIN],
      dataDir,
      databasePath: path.join(dataDir, "sync.sqlite"),
      uploadDir: path.join(dataDir, "uploads"),
      authLookupKey: AUTH_KEY,
      adminLogin: `admin-${randomUUID()}`,
      adminPassword: "board-sync-test-admin-password",
      bcryptRounds: 4,
      boardV2FoundationEnabled,
      ...overrides,
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
  return {
    server,
    dataDir,
    httpUrl: `http://127.0.0.1:${address.port}`,
    wsUrl: `ws://127.0.0.1:${address.port}/api/board-v2/sync`,
    sockets: new Set(),
  };
}

async function disposeHarness(harness: SyncHarness): Promise<void> {
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

function createSession(
  harness: SyncHarness,
  userId: string,
): TestSession {
  const rawToken = randomToken();
  const sessionHash = sha256(rawToken);
  const now = nowIso();
  harness.server.eduriContext.db.prepare(`
    INSERT INTO sessions (
      session_hash, user_id, expires_at, created_at, last_seen_at,
      ip_address, user_agent
    ) VALUES (?, ?, ?, ?, ?, NULL, 'board-sync-test')
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
    sessionHash,
    cookie: `eduri_session=${rawToken}`,
    csrf: csrfForSession(AUTH_KEY, rawToken),
  };
}

function createLessonFixture(
  harness: SyncHarness,
  status: "scheduled" | "active" | "completed" | "cancelled" = "scheduled",
): LessonFixture {
  const db = harness.server.eduriContext.db;
  const tutorId = randomUUID();
  const studentId = randomUUID();
  const lessonId = randomUUID();
  const now = nowIso();
  db.prepare(`
    INSERT INTO users (
      id, role, status, display_name, tutor_id, created_at, updated_at
    ) VALUES (?, 'tutor', 'active', ?, NULL, ?, ?)
  `).run(tutorId, `Tutor ${tutorId.slice(0, 6)}`, now, now);
  db.prepare(`
    INSERT INTO users (
      id, role, status, display_name, tutor_id, created_at, updated_at
    ) VALUES (?, 'student', 'active', ?, ?, ?, ?)
  `).run(
    studentId,
    `Student ${studentId.slice(0, 6)}`,
    tutorId,
    now,
    now,
  );
  db.prepare(`
    INSERT INTO lessons (
      id, tutor_id, student_id, title, meeting_key, scheduled_at,
      duration_minutes, status, created_at, updated_at
    ) VALUES (?, ?, ?, 'Board sync test', ?, ?, 60, ?, ?, ?)
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
  return {
    lessonId,
    tutorId,
    studentId,
    tutor: createSession(harness, tutorId),
    student: createSession(harness, studentId),
  };
}

async function requestTicket(
  harness: SyncHarness,
  session: TestSession,
  lessonId: string,
  profile?: { readonly displayName: string; readonly color: `#${string}` },
): Promise<BoardSyncTicketResponse> {
  const response = await request(harness.httpUrl)
    .post("/api/board-v2/sync-ticket")
    .set("Origin", ORIGIN)
    .set("Cookie", session.cookie)
    .set("x-csrf-token", session.csrf)
    .send({
      lessonId,
      minSchemaVersion: 1,
      maxSchemaVersion: 1,
      capabilities: BOARD_SYNC_SERVER_CAPABILITIES,
      ...(profile ? { profile } : {}),
    })
    .expect(200)
    .expect("Cache-Control", "no-store");
  return response.body as BoardSyncTicketResponse;
}

function openSocket(
  harness: SyncHarness,
  origin = ORIGIN,
  subprotocol: string | undefined = BOARD_SUBPROTOCOL,
): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = subprotocol === undefined
      ? new WebSocket(harness.wsUrl, { origin })
      : new WebSocket(harness.wsUrl, subprotocol, { origin });
    const onError = (error: Error) => reject(error);
    socket.once("error", onError);
    socket.once("open", () => {
      socket.off("error", onError);
      harness.sockets.add(socket);
      socket.once("close", () => harness.sockets.delete(socket));
      resolve(socket);
    });
  });
}

async function openRawSocketIgnoringWebSocketClose(
  harness: SyncHarness,
): Promise<Socket> {
  const url = new URL(harness.httpUrl);
  const socket = connect({
    host: url.hostname,
    port: Number(url.port),
  });
  socket.setNoDelay(true);
  const key = randomBytes(16).toString("base64");
  const upgraded = new Promise<void>((resolve, reject) => {
    let response = "";
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("Timed out waiting for raw WebSocket upgrade"));
    }, 2_000);
    const onData = (chunk: Buffer) => {
      response += chunk.toString("latin1");
      if (!response.includes("\r\n\r\n")) return;
      cleanup();
      if (!response.startsWith("HTTP/1.1 101")) {
        reject(new Error(`Raw WebSocket upgrade failed: ${response}`));
        return;
      }
      resolve();
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      clearTimeout(timeout);
      socket.off("data", onData);
      socket.off("error", onError);
    };
    socket.on("data", onData);
    socket.on("error", onError);
  });
  socket.once("connect", () => {
    socket.write([
      `GET ${BOARD_SYNC_WEBSOCKET_PATH} HTTP/1.1`,
      `Host: ${url.host}`,
      "Connection: Upgrade",
      "Upgrade: websocket",
      "Sec-WebSocket-Version: 13",
      `Sec-WebSocket-Key: ${key}`,
      `Sec-WebSocket-Protocol: ${BOARD_SUBPROTOCOL}`,
      `Origin: ${ORIGIN}`,
      "",
      "",
    ].join("\r\n"));
  });
  await upgraded;
  return socket;
}

function rejectedUpgrade(
  harness: SyncHarness,
  origin: string,
  subprotocol: string | undefined,
): Promise<number> {
  return new Promise((resolve, reject) => {
    const socket = subprotocol === undefined
      ? new WebSocket(harness.wsUrl, { origin })
      : new WebSocket(harness.wsUrl, subprotocol, { origin });
    socket.once("unexpected-response", (_request, response) => {
      response.resume();
      resolve(response.statusCode ?? 0);
    });
    socket.once("open", () => {
      socket.terminate();
      reject(new Error("Expected the WebSocket upgrade to be rejected"));
    });
    socket.once("error", () => {
      // ws may also emit an error after unexpected-response; the HTTP status is
      // the assertion source.
    });
  });
}

function bytesFromRaw(data: RawData): Uint8Array {
  const bytes = Array.isArray(data)
    ? Uint8Array.from(Buffer.concat(data))
    : data instanceof ArrayBuffer
      ? new Uint8Array(data)
      : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  return bytes;
}

function frameFromRaw(data: RawData): BoardFrame {
  return decodeBoardFrame(bytesFromRaw(data));
}

function nextFrame<T extends BoardFrame>(
  socket: WebSocket,
  predicate: (frame: BoardFrame) => frame is T,
  timeoutMs = 2_000,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("Timed out waiting for Board frame"));
    }, timeoutMs);
    const onMessage = (data: RawData, isBinary: boolean) => {
      if (!isBinary) return;
      const frame = frameFromRaw(data);
      if (!predicate(frame)) return;
      cleanup();
      resolve(frame);
    };
    const onClose = (code: number) => {
      cleanup();
      reject(new Error(`WebSocket closed with ${code} before expected frame`));
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

function nextLogicalFrame<T extends BoardFrame>(
  socket: WebSocket,
  predicate: (frame: BoardFrame) => frame is T,
  timeoutMs = 3_000,
): Promise<T> {
  const chunks = new Map<string, {
    count: number;
    totalLength: number;
    values: Array<Uint8Array | undefined>;
  }>();
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("Timed out waiting for logical Board frame"));
    }, timeoutMs);
    const onMessage = (data: RawData, isBinary: boolean) => {
      if (!isBinary) return;
      let frame = frameFromRaw(data);
      if (frame.type === BoardMessageType.CHUNK) {
        const key = Buffer.from(frame.messageId).toString("hex");
        const assembly = chunks.get(key) ?? {
          count: frame.chunkCount,
          totalLength: frame.totalLength,
          values: new Array<Uint8Array | undefined>(frame.chunkCount)
            .fill(undefined),
        };
        assembly.values[frame.chunkIndex] = frame.payload.slice();
        chunks.set(key, assembly);
        if (assembly.values.some((value) => value === undefined)) return;
        const encoded = new Uint8Array(assembly.totalLength);
        let offset = 0;
        for (const value of assembly.values) {
          encoded.set(value!, offset);
          offset += value!.byteLength;
        }
        frame = decodeBoardFrame(encoded);
      }
      if (!predicate(frame)) return;
      cleanup();
      resolve(frame);
    };
    const onClose = (code: number) => {
      cleanup();
      reject(new Error(`WebSocket closed with ${code} before logical frame`));
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

function sendLogicalFrame(socket: WebSocket, frame: BoardFrame): void {
  const encoded = encodeBoardFrame(frame);
  if (encoded.byteLength <= BOARD_PROTOCOL_LIMITS.maxChunkPayloadBytes) {
    socket.send(encoded);
    return;
  }
  if (
    frame.type !== BoardMessageType.SYNC_STEP2
    && frame.type !== BoardMessageType.UPDATE
  ) {
    throw new Error("Test helper cannot chunk this Board frame type");
  }
  const chunkCount = Math.ceil(
    encoded.byteLength / BOARD_PROTOCOL_LIMITS.maxChunkPayloadBytes,
  );
  if (chunkCount > BOARD_PROTOCOL_LIMITS.maxChunkCount) {
    throw new Error("Test Board frame exceeds the protocol chunk count");
  }
  const reassemblyId = new Uint8Array(randomBytes(16));
  for (let chunkIndex = 0; chunkIndex < chunkCount; chunkIndex += 1) {
    const start = chunkIndex * BOARD_PROTOCOL_LIMITS.maxChunkPayloadBytes;
    socket.send(encodeBoardFrame({
      type: BoardMessageType.CHUNK,
      messageId: reassemblyId,
      innerType: frame.type,
      chunkIndex,
      chunkCount,
      totalLength: encoded.byteLength,
      payload: encoded.subarray(
        start,
        Math.min(
          encoded.byteLength,
          start + BOARD_PROTOCOL_LIMITS.maxChunkPayloadBytes,
        ),
      ),
    }));
  }
}

function nextClose(socket: WebSocket): Promise<number> {
  return new Promise((resolve) => {
    socket.once("close", (code) => resolve(code));
  });
}

function expectNoFrame(
  socket: WebSocket,
  predicate: (frame: BoardFrame) => boolean,
  durationMs = 150,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const onMessage = (data: RawData, isBinary: boolean) => {
      if (!isBinary) return;
      if (predicate(frameFromRaw(data))) {
        cleanup();
        reject(new Error("Received a frame that should not have been sent"));
      }
    };
    const timeout = setTimeout(() => {
      cleanup();
      resolve();
    }, durationMs);
    const cleanup = () => {
      clearTimeout(timeout);
      socket.off("message", onMessage);
    };
    socket.on("message", onMessage);
  });
}

async function authenticateSocket(
  harness: SyncHarness,
  session: TestSession,
  lessonId: string,
  profile?: { readonly displayName: string; readonly color: `#${string}` },
): Promise<AuthenticatedSocket> {
  const ticket = await requestTicket(harness, session, lessonId, profile);
  const ws = await openSocket(harness);
  const readyPromise = nextFrame(
    ws,
    (frame): frame is Extract<BoardFrame, { type: BoardMessageType.READY }> =>
      frame.type === BoardMessageType.READY,
  );
  ws.send(encodeBoardFrame({
    type: BoardMessageType.AUTH,
    ticket: ticket.ticket,
    generation: ticket.generation,
    minSchemaVersion: 1,
    maxSchemaVersion: 1,
    capabilities: ticket.capabilities,
  }));
  return { ws, ready: await readyPromise, ticket };
}

async function syncDocument(
  authenticated: AuthenticatedSocket,
  docKey: string,
  initialDocument = new Y.Doc(),
  timeoutMs = 5_000,
): Promise<Y.Doc> {
  const chunks = new Map<string, {
    count: number;
    totalLength: number;
    values: Array<Uint8Array | undefined>;
  }>();
  return new Promise<Y.Doc>((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("Timed out completing Board state-vector sync"));
    }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timeout);
      authenticated.ws.off("message", onMessage);
      authenticated.ws.off("close", onClose);
    };
    const onClose = (code: number) => {
      cleanup();
      reject(new Error(`WebSocket closed with ${code} during document sync`));
    };
    const onMessage = (data: RawData, isBinary: boolean) => {
      if (!isBinary) return;
      let frame = frameFromRaw(data);
      if (frame.type === BoardMessageType.CHUNK) {
        const key = Buffer.from(frame.messageId).toString("hex");
        const assembly = chunks.get(key) ?? {
          count: frame.chunkCount,
          totalLength: frame.totalLength,
          values: new Array<Uint8Array | undefined>(frame.chunkCount)
            .fill(undefined),
        };
        assembly.values[frame.chunkIndex] = frame.payload.slice();
        chunks.set(key, assembly);
        if (assembly.values.some((value) => value === undefined)) return;
        const encoded = new Uint8Array(assembly.totalLength);
        let offset = 0;
        for (const value of assembly.values) {
          encoded.set(value!, offset);
          offset += value!.byteLength;
        }
        chunks.delete(key);
        frame = decodeBoardFrame(encoded);
      }
      if (
        frame.type === BoardMessageType.SYNC_STEP2
        && frame.docKey === docKey
      ) {
        Y.applyUpdate(initialDocument, frame.update);
        return;
      }
      if (
        frame.type !== BoardMessageType.SYNC_STEP1
        || frame.docKey !== docKey
      ) {
        return;
      }
      const localDiff = Y.encodeStateAsUpdate(
        initialDocument,
        frame.stateVector,
      );
      const decoded = Y.decodeUpdate(localDiff);
      if (decoded.structs.length > 0 || decoded.ds.clients.size > 0) {
        sendLogicalFrame(authenticated.ws, {
          type: BoardMessageType.SYNC_STEP2,
          generation: authenticated.ticket.generation,
          docKey,
          update: localDiff,
        });
      }
      cleanup();
      resolve(initialDocument);
    };

    authenticated.ws.on("message", onMessage);
    authenticated.ws.on("close", onClose);
    authenticated.ws.send(encodeBoardFrame({
      type: BoardMessageType.SYNC_STEP1,
      generation: authenticated.ticket.generation,
      docKey,
      stateVector: Y.encodeStateVector(initialDocument),
    }));
  });
}

function captureUpdate(doc: Y.Doc, mutate: () => void): Uint8Array {
  let captured: Uint8Array | undefined;
  const listener = (update: Uint8Array) => {
    captured = update;
  };
  doc.on("update", listener);
  mutate();
  doc.off("update", listener);
  if (!captured) throw new Error("Mutation did not emit a Yjs update");
  return captured;
}

describe("Board sync ticket store", () => {
  it("issues signed opaque, one-time, expiring tickets", () => {
    let now = 10_000;
    const store = new BoardSyncTicketStore(AUTH_KEY, () => now);
    const scope = {
      boardId: randomUUID(),
      lessonId: randomUUID(),
      userId: randomUUID(),
      sessionHash: "a".repeat(64),
      generation: 1,
      minSchemaVersion: 1,
      maxSchemaVersion: 1,
      capabilities: 3,
    };
    const issued = store.issue(scope);
    expect(issued.ticket).toMatch(/^[A-Za-z0-9_-]{43}\.[A-Za-z0-9_-]{43}$/u);
    expect(store.consume(issued.ticket)).toEqual(scope);
    expect(() => store.consume(issued.ticket)).toThrow(/invalid or expired/iu);

    const expiring = store.issue(scope);
    now += BOARD_SYNC_TICKET_TTL_MS + 1;
    expect(() => store.consume(expiring.ticket)).toThrow(/invalid or expired/iu);
    const replacement = expiring.ticket.endsWith("A") ? "B" : "A";
    expect(() =>
      store.consume(`${expiring.ticket.slice(0, -1)}${replacement}`),
    ).toThrow(/invalid or expired/iu);
  });

  it("bounds active tickets per session and user across reconnect attempts", () => {
    let now = 20_000;
    const store = new BoardSyncTicketStore(AUTH_KEY, () => now);
    const baseScope = {
      boardId: randomUUID(),
      lessonId: randomUUID(),
      userId: randomUUID(),
      sessionHash: "b".repeat(64),
      generation: 1,
      minSchemaVersion: 1,
      maxSchemaVersion: 1,
      capabilities: 3,
    };
    const sessionTickets = Array.from(
      { length: MAX_ACTIVE_BOARD_TICKETS_PER_SESSION },
      () => store.issue(baseScope),
    );
    expect(() => store.issue(baseScope)).toThrow(/for this session/iu);

    expect(store.consume(sessionTickets[0]!.ticket)).toEqual(baseScope);
    expect(() => store.issue(baseScope)).not.toThrow();

    store.clear();
    for (let index = 0; index < MAX_ACTIVE_BOARD_TICKETS_PER_USER; index += 1) {
      store.issue({
        ...baseScope,
        sessionHash: `${index.toString(16).padStart(63, "0")}c`,
      });
    }
    expect(() => store.issue({
      ...baseScope,
      sessionHash: "d".repeat(64),
    })).toThrow(/for this user/iu);

    now += BOARD_SYNC_TICKET_TTL_MS + 1;
    expect(() => store.issue({
      ...baseScope,
      sessionHash: "e".repeat(64),
    })).not.toThrow();
  });
});

describe("Board source-IP attribution", () => {
  it("accepts X-Real-IP only from the exact configured nginx peer", () => {
    expect(resolveBoardSyncSourceIp(
      "10.253.0.1",
      "203.0.113.8",
      "10.253.0.1",
    )).toBe("203.0.113.8");
    expect(resolveBoardSyncSourceIp(
      "10.253.0.3",
      "203.0.113.8",
      "10.253.0.1",
    )).toBe("10.253.0.3");
    expect(resolveBoardSyncSourceIp(
      "::ffff:10.253.0.1",
      "not-an-ip",
      "10.253.0.1",
    )).toBe("10.253.0.1");
    expect(resolveBoardSyncSourceIp(
      "127.0.0.1",
      "203.0.113.8",
      false,
    )).toBe("127.0.0.1");
  });
});

describe("authoritative Board awareness", () => {
  it("overwrites identity fields and rejects another awareness client ID", () => {
    const incoming = encodeAwarenessState(42, 1, {
      userId: "spoofed",
      displayName: "Spoofed",
      role: "admin",
      color: "#000",
      cursor: { x: 10, y: 20 },
    });
    const authorized = authorizeAwarenessUpdate(incoming, 42, {
      userId: "real-user",
      displayName: "Real user",
      role: "tutor",
      color: "#2563eb",
    });
    expect(parseAwarenessUpdate(authorized.update).state).toEqual({
      cursor: { x: 10, y: 20 },
      userId: "real-user",
      displayName: "Real user",
      role: "tutor",
      color: "#2563eb",
    });
    expect(() =>
      authorizeAwarenessUpdate(incoming, 43, {
        userId: "real-user",
        displayName: "Real user",
        role: "tutor",
        color: "#2563eb",
      }),
    ).toThrow(/another awareness client/iu);
  });

  it("accepts maximum selection and segmented laser presence within one update", () => {
    const selection = Array.from(
      { length: 256 },
      (_, index) => `board-object-${index.toString().padStart(3, "0")}`,
    );
    const strokes = Array.from({ length: 16 }, (_, strokeIndex) => ({
      points: Array.from({ length: 10 }, (_, pointIndex) => ({
        x: strokeIndex * 10 + pointIndex,
        y: strokeIndex - pointIndex / 10,
      })),
      style: {
        stroke: strokeIndex % 2 === 0 ? "#2563eb" : "rgba(211,63,73,0.8)",
        strokeWidth: 0.5 + strokeIndex,
        opacity: 0.5 + strokeIndex / 32,
      },
    }));
    const state = {
      cursor: { x: 160, y: 90 },
      selection,
      activeTool: "pen",
      gesturePreview: { kind: "laser", strokes },
      laserPointer: { x: 159, y: 14.1 },
    };
    const identity = {
      userId: "real-user",
      displayName: "Real user",
      role: "tutor" as const,
      color: "#2563eb",
    };

    const authorized = authorizeAwarenessUpdate(
      encodeAwarenessState(44, 1, state),
      44,
      identity,
    );
    expect(authorized.state).toMatchObject(state);
    expect(parseAwarenessUpdate(authorized.update).state).toMatchObject({
      ...state,
      ...identity,
    });

    expect(() => authorizeAwarenessUpdate(
      encodeAwarenessState(44, 2, {
        ...state,
        budgetProbe: Array.from({ length: 180 }, () => true),
      }),
      44,
      identity,
    )).toThrow(/too many values/iu);
  });

  it("preflights every document before committing profile identity updates", () => {
    const registry = new BoardAwarenessRegistry();
    const clientId = 45;
    const previousIdentity = {
      userId: "real-user",
      displayName: "Before",
      role: "tutor" as const,
      color: "#2563eb",
    };
    for (const [documentIdentity, clock] of [
      ["board:1:manifest", 1],
      ["board:1:page:default", 0xffff_fffd],
    ] as const) {
      registry.accept(
        documentIdentity,
        authorizeAwarenessUpdate(
          encodeAwarenessState(clientId, clock, {
            cursor: { x: clock === 1 ? 1 : 2, y: 3 },
          }),
          clientId,
          previousIdentity,
        ),
      );
    }
    const before = new Map([
      ["board:1:manifest", registry.current("board:1:manifest")],
      ["board:1:page:default", registry.current("board:1:page:default")],
    ]);

    expect(() => registry.updateIdentitiesAtomically(
      ["board:1:manifest", "board:1:page:default"],
      clientId,
      { ...previousIdentity, displayName: "After", color: "#d33f49" },
    )).toThrow(/clock cannot advance/iu);
    expect(registry.current("board:1:manifest"))
      .toEqual(before.get("board:1:manifest"));
    expect(registry.current("board:1:page:default"))
      .toEqual(before.get("board:1:page:default"));
  });

  it("commits a prepared profile identity to every document together", () => {
    const registry = new BoardAwarenessRegistry();
    const clientId = 46;
    const previousIdentity = {
      userId: "real-user",
      displayName: "Before",
      role: "tutor" as const,
      color: "#2563eb",
    };
    for (const [documentIdentity, clock] of [
      ["board:2:manifest", 3],
      ["board:2:page:default", 8],
    ] as const) {
      registry.accept(
        documentIdentity,
        authorizeAwarenessUpdate(
          encodeAwarenessState(clientId, clock, {
            cursor: { x: clock, y: clock + 1 },
            selection: [documentIdentity],
          }),
          clientId,
          previousIdentity,
        ),
      );
    }

    const updates = registry.updateIdentitiesAtomically(
      ["board:2:manifest", "board:2:page:default"],
      clientId,
      { ...previousIdentity, displayName: "After", color: "#d33f49" },
    );
    for (const [documentIdentity, expectedClock] of [
      ["board:2:manifest", 4],
      ["board:2:page:default", 9],
    ] as const) {
      const parsed = parseAwarenessUpdate(updates.get(documentIdentity)!);
      expect(parsed).toMatchObject({
        clientId,
        clock: expectedClock,
        state: {
          displayName: "After",
          color: "#d33f49",
          cursor: { x: expectedClock - 1, y: expectedClock },
          selection: [documentIdentity],
        },
      });
      expect(registry.current(documentIdentity)).toEqual([
        updates.get(documentIdentity),
      ]);
    }
  });
});

describe("Board active-document cache", () => {
  it("evicts an oversized document by byte budget without limiting the board", async () => {
    const isolated = await createHarness(true, {
      boardV2ActiveDocumentCacheBytes: 1,
    });
    try {
      const fixture = createLessonFixture(isolated);
      const ticket = await requestTicket(
        isolated,
        fixture.tutor,
        fixture.lessonId,
      );
      const service = isolated.server.eduriContext.boardV2Sync!;
      const authenticated = service.authenticate({
        type: BoardMessageType.AUTH,
        ticket: ticket.ticket,
        generation: ticket.generation,
        minSchemaVersion: 1,
        maxSchemaVersion: 1,
        capabilities: ticket.capabilities,
      });
      const empty = new Y.Doc();
      const stateVector = Y.encodeStateVector(empty);
      empty.destroy();

      const first = service.missingUpdate(
        authenticated.access,
        ticket.defaultPageDocKey,
        stateVector,
      );
      expect(first.byteLength).toBeGreaterThan(1);
      expect(service.cacheMetrics()).toEqual({
        documentCount: 0,
        estimatedBytes: 0,
        maximumBytes: 1,
      });

      const second = service.missingUpdate(
        authenticated.access,
        ticket.defaultPageDocKey,
        stateVector,
      );
      expect(second).toEqual(first);
      expect(service.cacheMetrics().estimatedBytes).toBe(0);
    } finally {
      await disposeHarness(isolated);
    }
  });
});

describe("Board v2 ticket and raw WebSocket transport", () => {
  let harness: SyncHarness;

  beforeAll(async () => {
    harness = await createHarness(true);
  });

  afterAll(async () => {
    await disposeHarness(harness);
  });

  it("bootstraps the v2 manifest/default page and protects ticket issuance", async () => {
    const fixture = createLessonFixture(harness);
    await request(harness.httpUrl)
      .post("/api/board-v2/sync-ticket")
      .set("Origin", ORIGIN)
      .set("Cookie", fixture.tutor.cookie)
      .send({ lessonId: fixture.lessonId })
      .expect(403);

    const response = await request(harness.httpUrl)
      .post("/api/board-v2/sync-ticket")
      .set("Origin", ORIGIN)
      .set("Cookie", fixture.tutor.cookie)
      .set("x-csrf-token", fixture.tutor.csrf)
      .send({ lessonId: fixture.lessonId })
      .expect(200);
    const ticket = response.body as BoardSyncTicketResponse;
    expect(ticket).toMatchObject({
      generation: 1,
      protocolVersion: 1,
      schemaVersion: 1,
      manifestDocKey: "manifest",
      websocketPath: "/api/board-v2/sync",
      permissions: BoardPermission.READ | BoardPermission.EDIT,
    });
    expect(ticket.defaultPageDocKey).toBe(`page:${ticket.defaultPageId}`);

    const repository = harness.server.eduriContext.boardV2Sync!.repository;
    const board = repository.getBoardForLesson(fixture.lessonId)!;
    expect(board).toMatchObject({ id: ticket.boardId, engine: "v2" });
    expect(repository.loadDocument({
      boardId: board.id,
      documentKey: "manifest",
      generation: board.generation,
    }).document.snapshotBytes).toBeGreaterThan(0);
    expect(repository.loadDocument({
      boardId: board.id,
      documentKey: ticket.defaultPageDocKey,
      generation: board.generation,
    }).document.snapshotBytes).toBeGreaterThan(0);

    const repeated = await requestTicket(
      harness,
      fixture.student,
      fixture.lessonId,
    );
    expect(repeated.boardId).toBe(ticket.boardId);
    expect(repeated.defaultPageId).toBe(ticket.defaultPageId);

    const outsider = createLessonFixture(harness);
    await request(harness.httpUrl)
      .post("/api/board-v2/sync-ticket")
      .set("Origin", ORIGIN)
      .set("Cookie", outsider.tutor.cookie)
      .set("x-csrf-token", outsider.tutor.csrf)
      .send({ lessonId: fixture.lessonId })
      .expect(404);

    const legacy = createLessonFixture(harness);
    repository.createBoardForLesson(legacy.lessonId, { engine: "legacy" });
    await request(harness.httpUrl)
      .post("/api/board-v2/sync-ticket")
      .set("Origin", ORIGIN)
      .set("Cookie", legacy.tutor.cookie)
      .set("x-csrf-token", legacy.tutor.csrf)
      .send({ lessonId: legacy.lessonId })
      .expect(409)
      .expect(({ body }) => {
        expect(body).toMatchObject({
          code: "BOARD_NOT_V2",
          error: expect.any(String),
        });
      });
    expect(repository.getBoardForLesson(legacy.lessonId)?.engine).toBe("legacy");

    const legacyData = createLessonFixture(harness);
    harness.server.eduriContext.db.prepare(`
      UPDATE lessons
      SET board_state = '{"elements":[{"id":"legacy"}]}', board_revision = 1
      WHERE id = ?
    `).run(legacyData.lessonId);
    await request(harness.httpUrl)
      .post("/api/board-v2/sync-ticket")
      .set("Origin", ORIGIN)
      .set("Cookie", legacyData.tutor.cookie)
      .set("x-csrf-token", legacyData.tutor.csrf)
      .send({ lessonId: legacyData.lessonId })
      .expect(200);
    expect(repository.getBoardForLesson(legacyData.lessonId)?.engine).toBe("v2");
    expect(harness.server.eduriContext.db.prepare(`
      SELECT board_state, board_revision FROM lessons WHERE id = ?
    `).get(legacyData.lessonId)).toEqual({
      board_state: '{"elements":[{"id":"legacy"}]}',
      board_revision: 1,
    });
  });

  it("returns distinct structured errors for incompatible board clients", async () => {
    const repository = harness.server.eduriContext.boardV2Sync!.repository;
    const protocolFixture = createLessonFixture(harness);
    repository.createBoardForLesson(protocolFixture.lessonId, {
      engine: "v2",
      protocolVersion: 2,
      schemaVersion: 1,
    });
    await request(harness.httpUrl)
      .post("/api/board-v2/sync-ticket")
      .set("Origin", ORIGIN)
      .set("Cookie", protocolFixture.tutor.cookie)
      .set("x-csrf-token", protocolFixture.tutor.csrf)
      .send({
        lessonId: protocolFixture.lessonId,
        minSchemaVersion: 1,
        maxSchemaVersion: 1,
      })
      .expect(426)
      .expect(({ body }) => {
        expect(body).toMatchObject({
          code: "PROTOCOL_MISMATCH",
          error: expect.any(String),
        });
      });

    const schemaFixture = createLessonFixture(harness);
    repository.createBoardForLesson(schemaFixture.lessonId, {
      engine: "v2",
      protocolVersion: 1,
      schemaVersion: 2,
    });
    await request(harness.httpUrl)
      .post("/api/board-v2/sync-ticket")
      .set("Origin", ORIGIN)
      .set("Cookie", schemaFixture.student.cookie)
      .set("x-csrf-token", schemaFixture.student.csrf)
      .send({
        lessonId: schemaFixture.lessonId,
        minSchemaVersion: 1,
        maxSchemaVersion: 1,
      })
      .expect(422)
      .expect(({ body }) => {
        expect(body).toMatchObject({
          code: "SCHEMA_MISMATCH",
          error: expect.any(String),
        });
      });
  });

  it("carries a normalized collaboration profile through ticket authentication", async () => {
    const fixture = createLessonFixture(harness);
    await request(harness.httpUrl)
      .post("/api/board-v2/sync-ticket")
      .set("Origin", ORIGIN)
      .set("Cookie", fixture.tutor.cookie)
      .set("x-csrf-token", fixture.tutor.csrf)
      .send({
        lessonId: fixture.lessonId,
        profile: { displayName: "Tutor\u202eAdmin", color: "#abcdef" },
      })
      .expect(400);

    const response = await request(harness.httpUrl)
      .post("/api/board-v2/sync-ticket")
      .set("Origin", ORIGIN)
      .set("Cookie", fixture.tutor.cookie)
      .set("x-csrf-token", fixture.tutor.csrf)
      .send({
        lessonId: fixture.lessonId,
        profile: { displayName: "  Tutor   Alias ", color: "#ABCDEF" },
      })
      .expect(200);
    const ticket = response.body as BoardSyncTicketResponse;
    const service = harness.server.eduriContext.boardV2Sync!;
    const authenticated = service.authenticate({
      type: BoardMessageType.AUTH,
      ticket: ticket.ticket,
      generation: ticket.generation,
      minSchemaVersion: 1,
      maxSchemaVersion: 1,
      capabilities: ticket.capabilities,
    });
    expect(authenticated.access).toMatchObject({
      displayName: "Tutor Alias",
      color: "#abcdef",
    });
    expect(service.reauthorize({
      boardId: authenticated.access.boardId,
      generation: authenticated.access.generation,
      userId: authenticated.access.userId,
      sessionHash: authenticated.access.sessionHash,
      profile: {
        displayName: authenticated.access.displayName,
        color: authenticated.access.color,
      },
    })).toMatchObject({
      displayName: "Tutor Alias",
      color: "#abcdef",
    });
  });

  it("returns retryable 429 responses when active ticket caps are reached", async () => {
    const isolated = await createHarness(true);
    try {
      const fixture = createLessonFixture(isolated);
      for (let index = 0; index < MAX_ACTIVE_BOARD_TICKETS_PER_SESSION; index += 1) {
        await requestTicket(isolated, fixture.tutor, fixture.lessonId);
      }
      await request(isolated.httpUrl)
        .post("/api/board-v2/sync-ticket")
        .set("Origin", ORIGIN)
        .set("Cookie", fixture.tutor.cookie)
        .set("x-csrf-token", fixture.tutor.csrf)
        .send({ lessonId: fixture.lessonId })
        .expect(429)
        .expect("Cache-Control", "no-store")
        .expect("Retry-After", "60")
        .expect(({ body }) => {
          expect(body).toMatchObject({
            code: "RATE_LIMITED",
            retryAfterMs: BOARD_SYNC_TICKET_TTL_MS,
          });
        });

      const room = isolated.server.eduriContext.guestRooms.create("board");
      const deviceId = "guest-ticket-cap-device-0000000000";
      for (let index = 0; index < MAX_ACTIVE_BOARD_TICKETS_PER_SESSION; index += 1) {
        await request(isolated.httpUrl)
          .post(`/api/guest/rooms/${room.shareKey}/board-ticket`)
          .set("Origin", ORIGIN)
          .send({ deviceId })
          .expect(200);
      }
      await request(isolated.httpUrl)
        .post(`/api/guest/rooms/${room.shareKey}/board-ticket`)
        .set("Origin", ORIGIN)
        .send({ deviceId })
        .expect(429)
        .expect("Cache-Control", "no-store")
        .expect("Retry-After", "60")
        .expect(({ body }) => {
          expect(body).toMatchObject({
            code: "RATE_LIMITED",
            retryAfterMs: BOARD_SYNC_TICKET_TTL_MS,
          });
        });
    } finally {
      await disposeHarness(isolated);
    }
  });

  it("reports private board storage metrics only to current lesson members", async () => {
    const fixture = createLessonFixture(harness);
    const ticket = await requestTicket(
      harness,
      fixture.tutor,
      fixture.lessonId,
    );

    const response = await request(harness.httpUrl)
      .get("/api/board-v2/metrics")
      .query({ lessonId: fixture.lessonId })
      .set("Origin", ORIGIN)
      .set("Cookie", fixture.student.cookie)
      .expect(200)
      .expect("Cache-Control", "no-store");

    expect(response.body).toMatchObject({
      boardId: ticket.boardId,
      generation: ticket.generation,
      documentCount: 2,
      updateLogCount: 0,
      updateLogBytes: 0,
      idempotencyReceiptBytes: 0,
      storageMetadataBytes: 3 * 1024,
      quotaBytes: expect.any(Number),
      assetCount: 0,
      assetBytes: 0,
      pendingAssetCount: 0,
      physicalAssetCount: 0,
    });
    expect(response.body.snapshotBytes).toBeGreaterThan(0);
    expect(response.body.logicalBytes).toBeGreaterThan(0);
    expect(response.body.physicalBytes).toBeGreaterThan(0);
    expect(response.body.measuredAt).toEqual(expect.any(String));

    const outsider = createLessonFixture(harness);
    await request(harness.httpUrl)
      .get("/api/board-v2/metrics")
      .query({ lessonId: fixture.lessonId })
      .set("Origin", ORIGIN)
      .set("Cookie", outsider.tutor.cookie)
      .expect(404);
  });

  it("requires exact Origin/subprotocol and AUTH as the first one-time-ticket frame", async () => {
    const fixture = createLessonFixture(harness);
    const ticket = await requestTicket(harness, fixture.tutor, fixture.lessonId);
    await expect(
      rejectedUpgrade(harness, "http://evil.test", BOARD_SUBPROTOCOL),
    ).resolves.toBe(403);
    await expect(
      rejectedUpgrade(harness, ORIGIN, undefined),
    ).resolves.toBe(426);

    const unauthenticated = await openSocket(harness);
    const unauthenticatedClose = nextClose(unauthenticated);
    unauthenticated.send(encodeBoardFrame({
      type: BoardMessageType.SYNC_STEP1,
      generation: ticket.generation,
      docKey: "manifest",
      stateVector: Y.encodeStateVector(new Y.Doc()),
    }));
    await expect(unauthenticatedClose).resolves.toBe(4400);

    const socket = await openSocket(harness);
    const auth = {
      type: BoardMessageType.AUTH as const,
      ticket: ticket.ticket,
      generation: ticket.generation,
      minSchemaVersion: 1,
      maxSchemaVersion: 1,
      capabilities: ticket.capabilities,
    };
    const ready = nextFrame(
      socket,
      (frame): frame is Extract<BoardFrame, { type: BoardMessageType.READY }> =>
        frame.type === BoardMessageType.READY,
    );
    socket.send(encodeBoardFrame(auth));
    await expect(ready).resolves.toMatchObject({
      generation: ticket.generation,
      schemaVersion: 1,
    });

    const replay = await openSocket(harness);
    const replayClose = nextClose(replay);
    replay.send(encodeBoardFrame(auth));
    await expect(replayClose).resolves.toBe(4401);
    socket.close();
  });

  it("rejects excess pending-AUTH sockets from one client before allocating more state", async () => {
    const pending = await Promise.all(Array.from(
      { length: BOARD_SYNC_ADMISSION_LIMITS.maxPendingAuthConnectionsPerIp },
      () => openSocket(harness),
    ));
    await expect(
      rejectedUpgrade(harness, ORIGIN, BOARD_SUBPROTOCOL),
    ).resolves.toBe(429);
    for (const socket of pending) socket.terminate();
  });

  it("forcibly releases an AUTH slot when a raw peer ignores CLOSE", async () => {
    const isolated = await createHarness(true);
    let rawSocket: Socket | undefined;
    try {
      rawSocket = await openRawSocketIgnoringWebSocketClose(isolated);
      const closed = new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error("Pending AUTH socket retained its admission slot"));
        }, 6_000);
        rawSocket!.once("close", () => {
          clearTimeout(timeout);
          resolve();
        });
      });
      await closed;

      const replacement = await openSocket(isolated);
      replacement.terminate();
    } finally {
      rawSocket?.destroy();
      await disposeHarness(isolated);
    }
  }, 8_000);

  it("tells rate-limited clients when a reconnect can safely retry", async () => {
    const fixture = createLessonFixture(harness);
    const tutor = await authenticateSocket(
      harness,
      fixture.tutor,
      fixture.lessonId,
    );
    const document = await syncDocument(tutor, tutor.ticket.defaultPageDocKey);
    const control = nextFrame(
      tutor.ws,
      (
        frame,
      ): frame is Extract<BoardFrame, { type: BoardMessageType.CONTROL }> =>
        frame.type === BoardMessageType.CONTROL
        && frame.code === BoardControlCode.RATE_LIMITED,
    );
    const closed = nextClose(tutor.ws);

    for (let clock = 1; clock <= 601; clock += 1) {
      tutor.ws.send(encodeBoardFrame({
        type: BoardMessageType.AWARENESS,
        generation: tutor.ticket.generation,
        docKey: tutor.ticket.defaultPageDocKey,
        awarenessClientId: tutor.ready.awarenessClientId,
        update: encodeAwarenessState(
          tutor.ready.awarenessClientId,
          clock,
          { cursor: { x: clock, y: clock } },
        ),
      }));
    }

    const limited = await control;
    expect(JSON.parse(new TextDecoder().decode(limited.payload))).toMatchObject({
      reason: "RATE_LIMITED",
      retryable: true,
      retryAfterMs: expect.any(Number),
    });
    const retryAfterMs = (JSON.parse(
      new TextDecoder().decode(limited.payload),
    ) as { retryAfterMs: number }).retryAfterMs;
    expect(retryAfterMs).toBeGreaterThan(0);
    expect(retryAfterMs).toBeLessThanOrEqual(10_000);
    await expect(closed).resolves.toBe(4429);
    document.destroy();
  });

  it("releases authoritative awareness IDs after every disconnect", async () => {
    const isolated = await createHarness(true);
    try {
      const fixture = createLessonFixture(isolated);
      const issuedIds = (
        isolated.server.eduriBoardV2 as unknown as {
          issuedAwarenessIds: Set<number>;
        }
      ).issuedAwarenessIds;
      for (let attempt = 0; attempt < 20; attempt += 1) {
        const socket = await authenticateSocket(
          isolated,
          fixture.tutor,
          fixture.lessonId,
        );
        expect(issuedIds.size).toBe(1);
        const closed = nextClose(socket.ws);
        socket.ws.close();
        await closed;
        await vi.waitFor(() => expect(issuedIds.size).toBe(0));
      }
    } finally {
      await disposeHarness(isolated);
    }
  });

  it("durably ACKs guest Board updates with repository-safe actor IDs", async () => {
    const created = await request(harness.httpUrl)
      .post("/api/guest/rooms")
      .set("Origin", ORIGIN)
      .send({ initialResource: "board" })
      .expect(201);
    const shareId = created.body.room.shareId as string;
    const ticketResponse = await request(harness.httpUrl)
      .post(`/api/guest/rooms/${shareId}/board-ticket`)
      .set("Origin", ORIGIN)
      .send({
        deviceId: "guest-board-websocket-regression-device",
        minSchemaVersion: 1,
        maxSchemaVersion: 1,
        capabilities: BOARD_SYNC_SERVER_CAPABILITIES,
      })
      .expect(200)
      .expect("Cache-Control", "no-store");
    const ticket = ticketResponse.body as BoardSyncTicketResponse;

    const ws = await openSocket(harness);
    const ready = nextFrame(
      ws,
      (frame): frame is Extract<BoardFrame, { type: BoardMessageType.READY }> =>
        frame.type === BoardMessageType.READY,
    );
    ws.send(encodeBoardFrame({
      type: BoardMessageType.AUTH,
      ticket: ticket.ticket,
      generation: ticket.generation,
      minSchemaVersion: 1,
      maxSchemaVersion: 1,
      capabilities: ticket.capabilities,
    }));
    const authenticated: AuthenticatedSocket = {
      ws,
      ready: await ready,
      ticket,
    };
    const page = await syncDocument(
      authenticated,
      ticket.defaultPageDocKey,
    );

    const objectId = randomUUID();
    const update = captureUpdate(page, () => {
      getPageObjects(page).set(objectId, createBoardObject({
        id: objectId,
        kind: "eduri/rectangle",
        version: 1,
        transform: [20, 20, 160, 100, 0],
        zRank: "guest-update",
        style: {},
        props: {},
      }));
    });
    const messageId = new Uint8Array(randomBytes(16));
    const ack = nextFrame(
      ws,
      (frame): frame is Extract<BoardFrame, { type: BoardMessageType.ACK }> =>
        frame.type === BoardMessageType.ACK
        && Buffer.from(frame.messageId).equals(Buffer.from(messageId)),
    );
    ws.send(encodeBoardFrame({
      type: BoardMessageType.UPDATE,
      generation: ticket.generation,
      docKey: ticket.defaultPageDocKey,
      messageId,
      update,
    }));

    await expect(ack).resolves.toMatchObject({ durableSequence: 1 });
    expect(ws.readyState).toBe(WebSocket.OPEN);
    const persisted = harness.server.eduriContext.db.prepare(`
      SELECT seq, actor_id, client_id
      FROM board_updates
      WHERE board_id = ? AND document_key = ? AND generation = ?
    `).get(
      ticket.boardId,
      ticket.defaultPageDocKey,
      ticket.generation,
    ) as { seq: number; actor_id: string; client_id: string };
    expect(persisted).toMatchObject({ seq: 1 });
    expect(persisted.actor_id).toMatch(/^guest_[A-Za-z0-9_-]{43}$/u);
    expect(persisted.client_id).toBe(persisted.actor_id);
    expect(persisted.client_id).toMatch(/^guest_[A-Za-z0-9_-]{43}$/u);

    page.destroy();
    ws.close();
  });

  it("extends guest activity only for a newly committed Board update", () => {
    const context = harness.server.eduriContext;
    const service = context.boardV2Sync!;
    const room = context.guestRooms.create("board");
    const ticket = service.issueGuestTicket({
      shareKey: room.shareKey,
      deviceId: "guest-board-activity-device",
      minSchemaVersion: 1,
      maxSchemaVersion: 1,
      capabilities: BOARD_SYNC_SERVER_CAPABILITIES,
    });
    const authenticated = service.authenticate({
      type: BoardMessageType.AUTH,
      ticket: ticket.ticket,
      generation: ticket.generation,
      minSchemaVersion: 1,
      maxSchemaVersion: 1,
      capabilities: ticket.capabilities,
    });
    const page = new Y.Doc();
    const activity = vi.spyOn(context.guestRooms, "recordResourceMutation");
    let restarted: BoardSyncService | undefined;
    try {
      Y.applyUpdate(page, service.missingUpdate(
        authenticated.access,
        ticket.defaultPageDocKey,
        Y.encodeStateVector(page),
      ));
      const objectId = randomUUID();
      const update = captureUpdate(page, () => {
        getPageObjects(page).set(objectId, createBoardObject({
          id: objectId,
          kind: "eduri/rectangle",
          version: 1,
          transform: [40, 40, 120, 80, 0],
          zRank: "guest-activity",
          style: {},
          props: {},
        }));
      });
      const messageId = Buffer.from(randomBytes(16)).toString("hex");

      expect(service.appendUpdate(
        authenticated.access,
        authenticated.access.userId,
        ticket.defaultPageDocKey,
        messageId,
        update,
      )).toMatchObject({ seq: 1, duplicate: false });
      expect(activity).toHaveBeenCalledTimes(1);

      activity.mockClear();
      expect(service.appendUpdate(
        authenticated.access,
        authenticated.access.userId,
        ticket.defaultPageDocKey,
        messageId,
        update,
      )).toMatchObject({ seq: 1, duplicate: true });
      expect(activity).not.toHaveBeenCalled();

      restarted = new BoardSyncService(context);
      const replayTicket = restarted.issueGuestTicket({
        shareKey: room.shareKey,
        deviceId: "guest-board-activity-device",
        minSchemaVersion: 1,
        maxSchemaVersion: 1,
        capabilities: BOARD_SYNC_SERVER_CAPABILITIES,
      });
      const replayAuth = restarted.authenticate({
        type: BoardMessageType.AUTH,
        ticket: replayTicket.ticket,
        generation: replayTicket.generation,
        minSchemaVersion: 1,
        maxSchemaVersion: 1,
        capabilities: replayTicket.capabilities,
      });
      expect(restarted.appendUpdate(
        replayAuth.access,
        replayAuth.access.userId,
        replayTicket.defaultPageDocKey,
        messageId,
        update,
      )).toMatchObject({ seq: 1, duplicate: true });
      expect(activity).not.toHaveBeenCalled();
      expect(context.db.prepare(`
        SELECT count(*) AS count FROM board_updates WHERE board_id = ?
      `).get(ticket.boardId)).toEqual({ count: 1 });
    } finally {
      restarted?.close();
      activity.mockRestore();
      page.destroy();
    }
  });

  it("revokes an authenticated Board draft when its initialization lease expires", () => {
    const context = harness.server.eduriContext;
    const service = context.boardV2Sync!;
    const draft = context.guestRooms.createDraft("board");
    const ticket = service.issueGuestTicket({
      shareKey: draft.room.shareKey,
      deviceId: "expired-board-draft-device",
      minSchemaVersion: 1,
      maxSchemaVersion: 1,
      capabilities: BOARD_SYNC_SERVER_CAPABILITIES,
    });
    const authenticated = service.authenticate({
      type: BoardMessageType.AUTH,
      ticket: ticket.ticket,
      generation: ticket.generation,
      minSchemaVersion: 1,
      maxSchemaVersion: 1,
      capabilities: ticket.capabilities,
    });
    const originalGuestRooms = context.guestRooms;
    const draftExpiry = Date.parse(draft.room.createdAt)
      + GUEST_ROOM_INITIALIZATION_TTL_MS;
    context.guestRooms = new GuestRoomService(context.db, () => draftExpiry);
    try {
      expect(() => service.reauthorize({
        boardId: authenticated.access.boardId,
        generation: authenticated.access.generation,
        userId: authenticated.access.userId,
        sessionHash: authenticated.access.sessionHash,
      })).toThrowError(expect.objectContaining({ code: "BOARD_GONE" }));
      expect(context.db.prepare(`
        SELECT count(*) AS count FROM guest_rooms WHERE id = ?
      `).get(draft.room.id)).toEqual({ count: 0 });
      expect(context.db.prepare(`
        SELECT count(*) AS count FROM boards WHERE id = ?
      `).get(ticket.boardId)).toEqual({ count: 0 });
    } finally {
      context.guestRooms = originalGuestRooms;
    }
  });

  it("rolls a guest Board update back when commit activity is rejected", () => {
    const context = harness.server.eduriContext;
    const service = context.boardV2Sync!;
    const room = context.guestRooms.create("board");
    const ticket = service.issueGuestTicket({
      shareKey: room.shareKey,
      deviceId: "guest-board-expiry-race-device",
      minSchemaVersion: 1,
      maxSchemaVersion: 1,
      capabilities: BOARD_SYNC_SERVER_CAPABILITIES,
    });
    const authenticated = service.authenticate({
      type: BoardMessageType.AUTH,
      ticket: ticket.ticket,
      generation: ticket.generation,
      minSchemaVersion: 1,
      maxSchemaVersion: 1,
      capabilities: ticket.capabilities,
    });
    const page = new Y.Doc();
    const activity = vi.spyOn(context.guestRooms, "recordResourceMutation")
      .mockReturnValueOnce(false);
    try {
      Y.applyUpdate(page, service.missingUpdate(
        authenticated.access,
        ticket.defaultPageDocKey,
        Y.encodeStateVector(page),
      ));
      const objectId = randomUUID();
      const update = captureUpdate(page, () => {
        getPageObjects(page).set(objectId, createBoardObject({
          id: objectId,
          kind: "eduri/rectangle",
          version: 1,
          transform: [60, 60, 140, 90, 0],
          zRank: "guest-expiry-race",
          style: {},
          props: {},
        }));
      });

      expect(() => service.appendUpdate(
        authenticated.access,
        authenticated.access.userId,
        ticket.defaultPageDocKey,
        Buffer.from(randomBytes(16)).toString("hex"),
        update,
      )).toThrowError(expect.objectContaining({ code: "BOARD_GONE" }));
      expect(activity).toHaveBeenCalledTimes(1);
      expect(context.db.prepare(`
        SELECT count(*) AS count FROM board_updates WHERE board_id = ?
      `).get(ticket.boardId)).toEqual({ count: 0 });
      expect(context.db.prepare(`
        SELECT count(*) AS count FROM board_update_receipts WHERE board_id = ?
      `).get(ticket.boardId)).toEqual({ count: 0 });
      expect(context.db.prepare(`
        SELECT last_seq FROM board_documents
        WHERE board_id = ? AND document_key = ? AND generation = ?
      `).get(
        ticket.boardId,
        ticket.defaultPageDocKey,
        ticket.generation,
      )).toEqual({ last_seq: 0 });
    } finally {
      activity.mockRestore();
      page.destroy();
    }
  });

  it("syncs only a state-vector diff and ACKs idempotent updates after durability", async () => {
    const fixture = createLessonFixture(harness);
    const tutor = await authenticateSocket(
      harness,
      fixture.tutor,
      fixture.lessonId,
    );
    const student = await authenticateSocket(
      harness,
      fixture.student,
      fixture.lessonId,
    );
    const tutorManifest = await syncDocument(tutor, "manifest");
    expect(getManifestPages(tutorManifest).size).toBe(1);
    const tutorPage = await syncDocument(tutor, tutor.ticket.defaultPageDocKey);
    const studentPage = await syncDocument(
      student,
      student.ticket.defaultPageDocKey,
    );

    const update = captureUpdate(tutorPage, () => {
      getPageObjects(tutorPage).set(randomUUID(), new Y.Map());
    });
    const messageId = new Uint8Array(randomBytes(16));
    const peerUpdate = nextFrame(
      student.ws,
      (frame): frame is Extract<BoardFrame, { type: BoardMessageType.UPDATE }> =>
        frame.type === BoardMessageType.UPDATE,
    );
    const ack = nextFrame(
      tutor.ws,
      (frame): frame is Extract<BoardFrame, { type: BoardMessageType.ACK }> =>
        frame.type === BoardMessageType.ACK,
    );
    const updateFrame = {
      type: BoardMessageType.UPDATE as const,
      generation: tutor.ticket.generation,
      docKey: tutor.ticket.defaultPageDocKey,
      messageId,
      update,
    };
    tutor.ws.send(encodeBoardFrame(updateFrame));
    const firstAck = await ack;
    expect(firstAck.durableSequence).toBe(1);
    Y.applyUpdate(studentPage, (await peerUpdate).update);
    expect(Y.encodeStateVector(studentPage)).toEqual(
      Y.encodeStateVector(tutorPage),
    );

    const duplicateAck = nextFrame(
      tutor.ws,
      (frame): frame is Extract<BoardFrame, { type: BoardMessageType.ACK }> =>
        frame.type === BoardMessageType.ACK,
    );
    tutor.ws.send(encodeBoardFrame(updateFrame));
    expect((await duplicateAck).durableSequence).toBe(firstAck.durableSequence);

    const tutorClosed = nextClose(tutor.ws);
    tutor.ws.close();
    await tutorClosed;
    const reconnected = await authenticateSocket(
      harness,
      fixture.tutor,
      fixture.lessonId,
    );
    const reconnectAck = nextFrame(
      reconnected.ws,
      (frame): frame is Extract<BoardFrame, { type: BoardMessageType.ACK }> =>
        frame.type === BoardMessageType.ACK,
    );
    reconnected.ws.send(encodeBoardFrame(updateFrame));
    expect((await reconnectAck).durableSequence).toBe(firstAck.durableSequence);

    const count = harness.server.eduriContext.db.prepare(`
      SELECT COUNT(*) AS count FROM board_updates WHERE board_id = ?
    `).get(tutor.ticket.boardId) as { count: number };
    expect(count.count).toBe(1);

    tutorManifest.destroy();
    tutorPage.destroy();
    studentPage.destroy();
    reconnected.ws.close();
    student.ws.close();
  });

  it("samples the final server state vector after sync backpressure clears", async () => {
    const fixture = createLessonFixture(harness);
    const tutor = await authenticateSocket(
      harness,
      fixture.tutor,
      fixture.lessonId,
    );
    const student = await authenticateSocket(
      harness,
      fixture.student,
      fixture.lessonId,
    );
    const documentKey = tutor.ticket.defaultPageDocKey;
    const tutorPage = await syncDocument(tutor, documentKey);
    const studentPage = await syncDocument(student, documentKey);

    interface TestableSyncTransport {
      waitForSocketCapacity(connection: unknown): Promise<boolean>;
    }

    const transport = harness.server.eduriBoardV2 as unknown as
      TestableSyncTransport;
    const waitForSocketCapacity =
      transport.waitForSocketCapacity.bind(transport);
    let releaseCapacity!: () => void;
    let reportCapacityWait!: () => void;
    const capacityReleased = new Promise<void>((resolve) => {
      releaseCapacity = resolve;
    });
    const capacityWaitStarted = new Promise<void>((resolve) => {
      reportCapacityWait = resolve;
    });
    let held = false;
    const capacitySpy = vi.spyOn(transport, "waitForSocketCapacity")
      .mockImplementation(async (connection) => {
        if (!held) {
          held = true;
          reportCapacityWait();
          await capacityReleased;
        }
        return waitForSocketCapacity(connection);
      });

    try {
      const finalStateVector = nextFrame(
        tutor.ws,
        (
          frame,
        ): frame is Extract<BoardFrame, { type: BoardMessageType.SYNC_STEP1 }> =>
          frame.type === BoardMessageType.SYNC_STEP1
          && frame.docKey === documentKey,
      );
      tutor.ws.send(encodeBoardFrame({
        type: BoardMessageType.SYNC_STEP1,
        generation: tutor.ticket.generation,
        docKey: documentKey,
        stateVector: Y.encodeStateVector(tutorPage),
      }));
      await capacityWaitStarted;

      const update = captureUpdate(studentPage, () => {
        getPageObjects(studentPage).set(randomUUID(), new Y.Map());
      });
      const messageId = new Uint8Array(randomBytes(16));
      const acknowledged = nextFrame(
        student.ws,
        (frame): frame is Extract<BoardFrame, { type: BoardMessageType.ACK }> =>
          frame.type === BoardMessageType.ACK
          && Buffer.from(frame.messageId).equals(Buffer.from(messageId)),
      );
      student.ws.send(encodeBoardFrame({
        type: BoardMessageType.UPDATE,
        generation: student.ticket.generation,
        docKey: documentKey,
        messageId,
        update,
      }));
      await acknowledged;

      releaseCapacity();
      const finalStep = await finalStateVector;
      const missingFromAdvertisedServer = Y.decodeUpdate(
        Y.encodeStateAsUpdate(studentPage, finalStep.stateVector),
      );
      expect(missingFromAdvertisedServer.structs).toHaveLength(0);
      expect(missingFromAdvertisedServer.ds.clients.size).toBe(0);
    } finally {
      releaseCapacity();
      capacitySpy.mockRestore();
      tutorPage.destroy();
      studentPage.destroy();
      tutor.ws.close();
      student.ws.close();
    }
  });

  it("keeps a semantic no-op recoverable without allocating a sequence or receipt", async () => {
    const fixture = createLessonFixture(harness);
    const tutor = await authenticateSocket(
      harness,
      fixture.tutor,
      fixture.lessonId,
    );
    const tutorPage = await syncDocument(
      tutor,
      tutor.ticket.defaultPageDocKey,
    );
    const noOp = Y.encodeStateAsUpdate(
      tutorPage,
      Y.encodeStateVector(tutorPage),
    );
    expect(Y.decodeUpdate(noOp)).toMatchObject({
      structs: [],
    });
    const messageId = new Uint8Array(randomBytes(16));
    const noAck = expectNoFrame(
      tutor.ws,
      (frame) =>
        frame.type === BoardMessageType.ACK
        && Buffer.from(frame.messageId).equals(Buffer.from(messageId)),
    );
    const control = nextFrame(
      tutor.ws,
      (
        frame,
      ): frame is Extract<BoardFrame, { type: BoardMessageType.CONTROL }> =>
        frame.type === BoardMessageType.CONTROL,
    );
    tutor.ws.send(encodeBoardFrame({
      type: BoardMessageType.UPDATE,
      generation: tutor.ticket.generation,
      docKey: tutor.ticket.defaultPageDocKey,
      messageId,
      update: noOp,
    }));

    await expect(control).resolves.toMatchObject({
      code: BoardControlCode.RESYNC_REQUIRED,
      messageId,
    });
    const controlFrame = await control;
    expect(JSON.parse(new TextDecoder().decode(controlFrame.payload)))
      .toMatchObject({
        reason: "NO_NEW_INFORMATION",
        retryable: true,
      });
    await noAck;
    expect(tutor.ws.readyState).toBe(WebSocket.OPEN);
    expect(harness.server.eduriContext.db.prepare(`
      SELECT
        document.last_seq,
        (SELECT COUNT(*) FROM board_updates WHERE board_id = document.board_id)
          AS updates,
        (SELECT COUNT(*) FROM board_update_receipts
          WHERE board_id = document.board_id) AS receipts
      FROM board_documents document
      WHERE document.board_id = ?
        AND document.document_key = ?
        AND document.generation = ?
    `).get(
      tutor.ticket.boardId,
      tutor.ticket.defaultPageDocKey,
      tutor.ticket.generation,
    )).toEqual({ last_seq: 0, updates: 0, receipts: 0 });

    tutorPage.destroy();
    tutor.ws.close();
  });

  it("keeps a causal gap retryable and accepts it after its predecessor", async () => {
    const fixture = createLessonFixture(harness);
    const tutor = await authenticateSocket(
      harness,
      fixture.tutor,
      fixture.lessonId,
    );
    const tutorPage = await syncDocument(
      tutor,
      tutor.ticket.defaultPageDocKey,
    );
    const firstId = randomUUID();
    const first = captureUpdate(tutorPage, () => {
      getPageObjects(tutorPage).set(firstId, createBoardObject({
        id: firstId,
        kind: "eduri/rectangle",
        version: 1,
        transform: [10, 10, 80, 60, 0],
        zRank: "causal-a",
        style: {},
        props: {},
      }));
    });
    const secondId = randomUUID();
    const second = captureUpdate(tutorPage, () => {
      getPageObjects(tutorPage).set(secondId, createBoardObject({
        id: secondId,
        kind: "eduri/ellipse",
        version: 1,
        transform: [120, 10, 80, 60, 0],
        zRank: "causal-b",
        style: {},
        props: {},
      }));
    });
    const firstMessageId = new Uint8Array(randomBytes(16));
    const secondMessageId = new Uint8Array(randomBytes(16));
    const causalGap = nextFrame(
      tutor.ws,
      (
        frame,
      ): frame is Extract<BoardFrame, { type: BoardMessageType.CONTROL }> =>
        frame.type === BoardMessageType.CONTROL,
    );
    tutor.ws.send(encodeBoardFrame({
      type: BoardMessageType.UPDATE,
      generation: tutor.ticket.generation,
      docKey: tutor.ticket.defaultPageDocKey,
      messageId: secondMessageId,
      update: second,
    }));
    await expect(causalGap).resolves.toMatchObject({
      code: BoardControlCode.RESYNC_REQUIRED,
      messageId: secondMessageId,
    });
    expect(tutor.ws.readyState).toBe(WebSocket.OPEN);
    expect((harness.server.eduriContext.db.prepare(`
      SELECT COUNT(*) AS count FROM board_updates WHERE board_id = ?
    `).get(tutor.ticket.boardId) as { count: number }).count).toBe(0);

    const firstAck = nextFrame(
      tutor.ws,
      (frame): frame is Extract<BoardFrame, { type: BoardMessageType.ACK }> =>
        frame.type === BoardMessageType.ACK
        && Buffer.from(frame.messageId).equals(Buffer.from(firstMessageId)),
    );
    tutor.ws.send(encodeBoardFrame({
      type: BoardMessageType.UPDATE,
      generation: tutor.ticket.generation,
      docKey: tutor.ticket.defaultPageDocKey,
      messageId: firstMessageId,
      update: first,
    }));
    await expect(firstAck).resolves.toMatchObject({ durableSequence: 1 });

    const secondAck = nextFrame(
      tutor.ws,
      (frame): frame is Extract<BoardFrame, { type: BoardMessageType.ACK }> =>
        frame.type === BoardMessageType.ACK
        && Buffer.from(frame.messageId).equals(Buffer.from(secondMessageId)),
    );
    tutor.ws.send(encodeBoardFrame({
      type: BoardMessageType.UPDATE,
      generation: tutor.ticket.generation,
      docKey: tutor.ticket.defaultPageDocKey,
      messageId: secondMessageId,
      update: second,
    }));
    await expect(secondAck).resolves.toMatchObject({ durableSequence: 2 });
    expect((harness.server.eduriContext.db.prepare(`
      SELECT COUNT(*) AS count FROM board_updates WHERE board_id = ?
    `).get(tutor.ticket.boardId) as { count: number }).count).toBe(2);

    tutorPage.destroy();
    tutor.ws.close();
  });

  it("never persists a deferred schema poison before its dependency", async () => {
    const fixture = createLessonFixture(harness);
    const tutor = await authenticateSocket(
      harness,
      fixture.tutor,
      fixture.lessonId,
    );
    const tutorPage = await syncDocument(
      tutor,
      tutor.ticket.defaultPageDocKey,
    );
    const dependency = captureUpdate(tutorPage, () => {
      tutorPage.getMap("causal-schema-test").set("ready", true);
    });
    const poisonedObjectId = randomUUID();
    const poison = captureUpdate(tutorPage, () => {
      (getPageObjects(tutorPage) as Y.Map<unknown>).set(poisonedObjectId, 42);
    });
    const dependencyMessageId = new Uint8Array(randomBytes(16));
    const poisonMessageId = new Uint8Array(randomBytes(16));
    const causalGap = nextFrame(
      tutor.ws,
      (
        frame,
      ): frame is Extract<BoardFrame, { type: BoardMessageType.CONTROL }> =>
        frame.type === BoardMessageType.CONTROL,
    );
    tutor.ws.send(encodeBoardFrame({
      type: BoardMessageType.UPDATE,
      generation: tutor.ticket.generation,
      docKey: tutor.ticket.defaultPageDocKey,
      messageId: poisonMessageId,
      update: poison,
    }));
    await expect(causalGap).resolves.toMatchObject({
      code: BoardControlCode.RESYNC_REQUIRED,
      messageId: poisonMessageId,
    });
    expect((harness.server.eduriContext.db.prepare(`
      SELECT COUNT(*) AS count FROM board_updates WHERE board_id = ?
    `).get(tutor.ticket.boardId) as { count: number }).count).toBe(0);

    const dependencyAck = nextFrame(
      tutor.ws,
      (frame): frame is Extract<BoardFrame, { type: BoardMessageType.ACK }> =>
        frame.type === BoardMessageType.ACK
        && Buffer.from(frame.messageId).equals(
          Buffer.from(dependencyMessageId),
        ),
    );
    tutor.ws.send(encodeBoardFrame({
      type: BoardMessageType.UPDATE,
      generation: tutor.ticket.generation,
      docKey: tutor.ticket.defaultPageDocKey,
      messageId: dependencyMessageId,
      update: dependency,
    }));
    await expect(dependencyAck).resolves.toMatchObject({
      durableSequence: 1,
    });

    const rejected = nextFrame(
      tutor.ws,
      (
        frame,
      ): frame is Extract<BoardFrame, { type: BoardMessageType.CONTROL }> =>
        frame.type === BoardMessageType.CONTROL
        && frame.code === BoardControlCode.UPDATE_REJECTED,
    );
    const closed = nextClose(tutor.ws);
    tutor.ws.send(encodeBoardFrame({
      type: BoardMessageType.UPDATE,
      generation: tutor.ticket.generation,
      docKey: tutor.ticket.defaultPageDocKey,
      messageId: poisonMessageId,
      update: poison,
    }));
    await expect(rejected).resolves.toMatchObject({
      messageId: poisonMessageId,
    });
    await expect(closed).resolves.toBe(4400);
    expect(harness.server.eduriContext.db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM board_updates WHERE board_id = ?) AS updates,
        (SELECT COUNT(*) FROM board_update_receipts WHERE board_id = ?)
          AS receipts
    `).get(
      tutor.ticket.boardId,
      tutor.ticket.boardId,
    )).toEqual({ updates: 1, receipts: 1 });

    tutorPage.destroy();
  });

  it("persists a replayed provider outbox update exactly once before bidirectional sync", async () => {
    const fixture = createLessonFixture(harness);
    const ticket = await requestTicket(
      harness,
      fixture.tutor,
      fixture.lessonId,
    );
    const sourceDocument = new Y.Doc();
    const objectId = randomUUID();
    const localUpdate = captureUpdate(sourceDocument, () => {
      getPageObjects(sourceDocument).set(objectId, createBoardObject({
        id: objectId,
        kind: "eduri/rectangle",
        version: 1,
        transform: [40, 60, 180, 120, 0],
        zRank: "outbox-first",
        style: {},
        props: {},
      }));
    });
    const persistence = new MemoryClientPersistence([{
      messageId: new Uint8Array(randomBytes(16)),
      generation: ticket.generation,
      documentKey: ticket.defaultPageDocKey,
      update: localUpdate,
      createdAt: Date.now(),
    }]);
    const providerDocument = new Y.Doc();
    const outbound: BoardFrame[] = [];
    const provider = new BoardNetworkProvider({
      document: providerDocument,
      scope: {
        boardId: ticket.boardId,
        generation: ticket.generation,
        documentKey: ticket.defaultPageDocKey,
      },
      localStore: persistence,
      ticketSource: async () => ({
        ticket: ticket.ticket,
        socketUrl: harness.wsUrl,
      }),
      socketFactory: (url, subprotocol) =>
        new RecordingBoardSocket(
          url,
          subprotocol,
          outbound,
          harness.sockets,
        ),
      capabilities: ticket.capabilities,
      ackRetryMs: 10_000,
    });

    try {
      await provider.start();
      await waitForCondition(
        () =>
          persistence.pending.size === 0 &&
          outbound.some((frame) => frame.type === BoardMessageType.SYNC_STEP1),
        "the durable outbox ACK and initial state-vector sync",
      );
      await new Promise<void>((resolve) => setTimeout(resolve, 150));

      const updateIndex = outbound.findIndex(
        (frame) => frame.type === BoardMessageType.UPDATE,
      );
      const syncIndex = outbound.findIndex(
        (frame) => frame.type === BoardMessageType.SYNC_STEP1,
      );
      expect(updateIndex).toBeGreaterThan(0);
      expect(syncIndex).toBeGreaterThan(updateIndex);
      expect(outbound.some(
        (frame) => frame.type === BoardMessageType.SYNC_STEP2,
      )).toBe(false);
      expect(getPageObjects(providerDocument).has(objectId)).toBe(true);

      const durableRows = harness.server.eduriContext.db.prepare(`
        SELECT COUNT(*) AS count
        FROM board_updates
        WHERE board_id = ? AND document_key = ?
      `).get(
        ticket.boardId,
        ticket.defaultPageDocKey,
      ) as { count: number };
      expect(durableRows.count).toBe(1);
    } finally {
      await provider.stop();
      sourceDocument.destroy();
      providerDocument.destroy();
    }
  });

  it("uploads IndexedDB-only edits during bidirectional reconnect sync", async () => {
    const fixture = createLessonFixture(harness);
    const tutor = await authenticateSocket(
      harness,
      fixture.tutor,
      fixture.lessonId,
    );
    const student = await authenticateSocket(
      harness,
      fixture.student,
      fixture.lessonId,
    );
    const studentPage = await syncDocument(
      student,
      student.ticket.defaultPageDocKey,
    );

    const cachedPage = new Y.Doc();
    const offlineObjectId = randomUUID();
    getPageObjects(cachedPage).set(offlineObjectId, new Y.Map());
    const peerUpdate = nextLogicalFrame(
      student.ws,
      (frame): frame is Extract<BoardFrame, { type: BoardMessageType.UPDATE }> =>
        frame.type === BoardMessageType.UPDATE
        && frame.docKey === tutor.ticket.defaultPageDocKey,
    );
    const mergedPage = await syncDocument(
      tutor,
      tutor.ticket.defaultPageDocKey,
      cachedPage,
    );
    Y.applyUpdate(studentPage, (await peerUpdate).update);
    expect(getPageObjects(studentPage).has(offlineObjectId)).toBe(true);

    const durableRows = harness.server.eduriContext.db.prepare(`
      SELECT COUNT(*) AS count FROM board_updates WHERE board_id = ?
    `).get(tutor.ticket.boardId) as { count: number };
    expect(durableRows.count).toBe(1);

    const tutorClosed = nextClose(tutor.ws);
    tutor.ws.close();
    await tutorClosed;
    const reconnected = await authenticateSocket(
      harness,
      fixture.tutor,
      fixture.lessonId,
    );
    const restored = await syncDocument(
      reconnected,
      reconnected.ticket.defaultPageDocKey,
    );
    expect(getPageObjects(restored).has(offlineObjectId)).toBe(true);
    expect(Y.encodeStateVector(restored)).toEqual(
      Y.encodeStateVector(mergedPage),
    );

    mergedPage.destroy();
    studentPage.destroy();
    restored.destroy();
    reconnected.ws.close();
    student.ws.close();
  });

  it("cold-syncs aggregate Board state larger than one logical frame", async () => {
    const fixture = createLessonFixture(harness);
    const tutor = await authenticateSocket(
      harness,
      fixture.tutor,
      fixture.lessonId,
    );
    const tutorPage = await syncDocument(
      tutor,
      tutor.ticket.defaultPageDocKey,
    );
    const sourceBytes = 9 * 1024 * 1024;
    for (const [index, character] of ["a", "b", "c", "d"].entries()) {
      const objectId = randomUUID();
      const update = captureUpdate(tutorPage, () => {
        getPageObjects(tutorPage).set(objectId, createBoardObject({
          id: objectId,
          kind: "eduri/code",
          version: 1,
          transform: [index * 640, 0, 600, 420, 0],
          zRank: `a${index}`,
          style: {},
          props: createCodeProps(
            character.repeat(sourceBytes),
            "plaintext",
            null,
          ),
        }));
      });
      expect(update.byteLength).toBeLessThan(
        BOARD_PROTOCOL_LIMITS.maxUpdateBytes,
      );
      const ack = nextFrame(
        tutor.ws,
        (frame): frame is Extract<BoardFrame, { type: BoardMessageType.ACK }> =>
          frame.type === BoardMessageType.ACK,
        10_000,
      );
      sendLogicalFrame(tutor.ws, {
        type: BoardMessageType.UPDATE,
        generation: tutor.ticket.generation,
        docKey: tutor.ticket.defaultPageDocKey,
        messageId: new Uint8Array(randomBytes(16)),
        update,
      });
      await ack;
    }
    expect(Y.encodeStateAsUpdate(tutorPage).byteLength).toBeGreaterThan(
      BOARD_PROTOCOL_LIMITS.maxReassembledBytes,
    );

    const coldClient = await authenticateSocket(
      harness,
      fixture.student,
      fixture.lessonId,
    );
    const coldPage = await syncDocument(
      coldClient,
      coldClient.ticket.defaultPageDocKey,
      new Y.Doc(),
      20_000,
    );
    expect(getPageObjects(coldPage).size).toBe(4);
    expect(Y.encodeStateVector(coldPage)).toEqual(
      Y.encodeStateVector(tutorPage),
    );

    tutorPage.destroy();
    coldPage.destroy();
    tutor.ws.close();
    coldClient.ws.close();
  }, 30_000);

  it("rejects schema-poisoning Yjs updates before durable append or broadcast", async () => {
    const fixture = createLessonFixture(harness);
    const tutor = await authenticateSocket(
      harness,
      fixture.tutor,
      fixture.lessonId,
    );
    const student = await authenticateSocket(
      harness,
      fixture.student,
      fixture.lessonId,
    );
    const tutorPage = await syncDocument(tutor, tutor.ticket.defaultPageDocKey);
    await syncDocument(student, student.ticket.defaultPageDocKey);
    const poisonedObjectId = randomUUID();
    const poison = captureUpdate(tutorPage, () => {
      (getPageObjects(tutorPage) as Y.Map<unknown>).set(poisonedObjectId, 42);
    });
    const messageId = new Uint8Array(randomBytes(16));
    expect(() => Y.decodeUpdate(poison)).not.toThrow();

    const noBroadcast = expectNoFrame(
      student.ws,
      (frame) =>
        frame.type === BoardMessageType.UPDATE
        && Buffer.from(frame.messageId).equals(Buffer.from(messageId)),
    );
    const control = nextFrame(
      tutor.ws,
      (frame): frame is Extract<BoardFrame, { type: BoardMessageType.CONTROL }> =>
        frame.type === BoardMessageType.CONTROL,
    );
    const close = nextClose(tutor.ws);
    tutor.ws.send(encodeBoardFrame({
      type: BoardMessageType.UPDATE,
      generation: tutor.ticket.generation,
      docKey: tutor.ticket.defaultPageDocKey,
      messageId,
      update: poison,
    }));

    const rejected = await control;
    expect(rejected.code).toBe(BoardControlCode.UPDATE_REJECTED);
    expect(rejected.messageId).toEqual(messageId);
    await expect(close).resolves.toBe(4400);
    await noBroadcast;
    expect((harness.server.eduriContext.db.prepare(`
      SELECT COUNT(*) AS count FROM board_updates WHERE board_id = ?
    `).get(tutor.ticket.boardId) as { count: number }).count).toBe(0);

    const reconnected = await authenticateSocket(
      harness,
      fixture.tutor,
      fixture.lessonId,
    );
    const cleanPage = await syncDocument(
      reconnected,
      reconnected.ticket.defaultPageDocKey,
    );
    expect(getPageObjects(cleanPage).has(poisonedObjectId)).toBe(false);

    const validObjectId = randomUUID();
    const validUpdate = captureUpdate(cleanPage, () => {
      const record = new Y.Map<unknown>();
      record.set("id", validObjectId);
      record.set("kind", "eduri/rectangle");
      record.set("version", 1);
      record.set("transform", [0, 0, 120, 80, 0]);
      record.set("zRank", "after-rejection");
      record.set("parentId", null);
      record.set("style", new Y.Map<unknown>());
      record.set("props", new Y.Map<unknown>());
      getPageObjects(cleanPage).set(validObjectId, record);
    });
    const validMessageId = new Uint8Array(randomBytes(16));
    const ack = nextFrame(
      reconnected.ws,
      (frame): frame is Extract<BoardFrame, { type: BoardMessageType.ACK }> =>
        frame.type === BoardMessageType.ACK,
    );
    reconnected.ws.send(encodeBoardFrame({
      type: BoardMessageType.UPDATE,
      generation: reconnected.ticket.generation,
      docKey: reconnected.ticket.defaultPageDocKey,
      messageId: validMessageId,
      update: validUpdate,
    }));
    expect((await ack).durableSequence).toBe(1);

    tutorPage.destroy();
    cleanPage.destroy();
    reconnected.ws.close();
    student.ws.close();
  });

  it("never broadcasts or ACKs a SQLite update that rolled back", async () => {
    const fixture = createLessonFixture(harness);
    const tutor = await authenticateSocket(
      harness,
      fixture.tutor,
      fixture.lessonId,
    );
    const student = await authenticateSocket(
      harness,
      fixture.student,
      fixture.lessonId,
    );
    const tutorPage = await syncDocument(tutor, tutor.ticket.defaultPageDocKey);
    await syncDocument(student, student.ticket.defaultPageDocKey);
    const failedUpdate = captureUpdate(tutorPage, () => {
      tutorPage.getMap("fault-test").set("mustNotPersist", true);
    });
    const failedMessageId = new Uint8Array(randomBytes(16));
    harness.server.eduriContext.db.exec(`
      CREATE TRIGGER reject_sync_receipt
      BEFORE INSERT ON board_update_receipts
      BEGIN SELECT RAISE(ABORT, 'injected sync storage failure'); END
    `);

    const noBroadcast = expectNoFrame(
      student.ws,
      (frame) =>
        frame.type === BoardMessageType.UPDATE
        && Buffer.from(frame.messageId).equals(Buffer.from(failedMessageId)),
    );
    const control = nextFrame(
      tutor.ws,
      (frame): frame is Extract<BoardFrame, { type: BoardMessageType.CONTROL }> =>
        frame.type === BoardMessageType.CONTROL,
    );
    tutor.ws.send(encodeBoardFrame({
      type: BoardMessageType.UPDATE,
      generation: tutor.ticket.generation,
      docKey: tutor.ticket.defaultPageDocKey,
      messageId: failedMessageId,
      update: failedUpdate,
    }));
    expect((await control).code).toBe(BoardControlCode.STORAGE_ERROR);
    await noBroadcast;
    const countAfterFailure = harness.server.eduriContext.db.prepare(`
      SELECT COUNT(*) AS count FROM board_updates WHERE board_id = ?
    `).get(tutor.ticket.boardId) as { count: number };
    expect(countAfterFailure.count).toBe(0);
    harness.server.eduriContext.db.exec("DROP TRIGGER reject_sync_receipt");

    const retry = await authenticateSocket(
      harness,
      fixture.tutor,
      fixture.lessonId,
    );
    const retryPage = await syncDocument(retry, retry.ticket.defaultPageDocKey);
    expect(retryPage.getMap("fault-test").has("mustNotPersist")).toBe(false);
    const ack = nextFrame(
      retry.ws,
      (frame): frame is Extract<BoardFrame, { type: BoardMessageType.ACK }> =>
        frame.type === BoardMessageType.ACK,
    );
    retry.ws.send(encodeBoardFrame({
      type: BoardMessageType.UPDATE,
      generation: retry.ticket.generation,
      docKey: retry.ticket.defaultPageDocKey,
      messageId: failedMessageId,
      update: failedUpdate,
    }));
    expect((await ack).durableSequence).toBe(1);
    const countAfterRetry = harness.server.eduriContext.db.prepare(`
      SELECT COUNT(*) AS count FROM board_updates WHERE board_id = ?
    `).get(retry.ticket.boardId) as { count: number };
    expect(countAfterRetry.count).toBe(1);

    tutorPage.destroy();
    retryPage.destroy();
    tutor.ws.terminate();
    student.ws.close();
    retry.ws.close();
  });

  it.each([
    {
      label: "tenant quota",
      reason: "TENANT_QUOTA",
    },
    {
      label: "free-disk floor",
      reason: "DISK_PRESSURE",
    },
  ])(
    "rejects a Board update atomically under $label pressure",
    async ({ reason }) => {
      const isolated = await createHarness(true);
      try {
        const fixture = createLessonFixture(isolated);
        const tutor = await authenticateSocket(
          isolated,
          fixture.tutor,
          fixture.lessonId,
        );
        const student = await authenticateSocket(
          isolated,
          fixture.student,
          fixture.lessonId,
        );
        const tutorPage = await syncDocument(
          tutor,
          tutor.ticket.defaultPageDocKey,
        );
        await syncDocument(student, student.ticket.defaultPageDocKey);
        const repository = isolated.server.eduriContext.boardV2Sync!
          .repository as unknown as {
            updateAdmission: {
              tenantSoftQuotaBytes: number;
              capacityProbe: { freeDiskBytes(storageRoot: string): number };
            };
          };
        if (reason === "TENANT_QUOTA") {
          repository.updateAdmission.tenantSoftQuotaBytes =
            isolated.server.eduriContext.boardV2Sync!.repository
              .getBoardMetrics({
                boardId: tutor.ticket.boardId,
                generation: tutor.ticket.generation,
              }).quotaBytes;
        } else {
          repository.updateAdmission.capacityProbe = { freeDiskBytes: () => 0 };
        }
        const update = captureUpdate(tutorPage, () => {
          tutorPage.getMap("capacity").set(reason, true);
        });
        const messageId = new Uint8Array(randomBytes(16));
        const db = isolated.server.eduriContext.db;
        const before = db.prepare(`
          SELECT
            document.last_seq,
            document.updated_at AS document_updated_at,
            board.updated_at AS board_updated_at
          FROM board_documents document
          JOIN boards board ON board.id = document.board_id
          WHERE document.board_id = ?
            AND document.document_key = ?
            AND document.generation = ?
        `).get(
          tutor.ticket.boardId,
          tutor.ticket.defaultPageDocKey,
          tutor.ticket.generation,
        );
        const noBroadcast = expectNoFrame(
          student.ws,
          (frame) =>
            frame.type === BoardMessageType.UPDATE
            && Buffer.from(frame.messageId).equals(Buffer.from(messageId)),
        );
        const noAck = expectNoFrame(
          tutor.ws,
          (frame) =>
            frame.type === BoardMessageType.ACK
            && Buffer.from(frame.messageId).equals(Buffer.from(messageId)),
        );
        const control = nextFrame(
          tutor.ws,
          (
            frame,
          ): frame is Extract<BoardFrame, { type: BoardMessageType.CONTROL }> =>
            frame.type === BoardMessageType.CONTROL,
        );
        const close = nextClose(tutor.ws);
        tutor.ws.send(encodeBoardFrame({
          type: BoardMessageType.UPDATE,
          generation: tutor.ticket.generation,
          docKey: tutor.ticket.defaultPageDocKey,
          messageId,
          update,
        }));

        const rejected = await control;
        expect(rejected).toMatchObject({
          code: BoardControlCode.STORAGE_ERROR,
          messageId,
        });
        expect(
          JSON.parse(new TextDecoder().decode(rejected.payload)),
        ).toMatchObject({
          reason,
          retryable: true,
          retryAfterMs: 60_000,
        });
        await expect(close).resolves.toBe(1013);
        await noBroadcast;
        await noAck;

        expect(db.prepare(`
          SELECT
            document.last_seq,
            document.updated_at AS document_updated_at,
            board.updated_at AS board_updated_at
          FROM board_documents document
          JOIN boards board ON board.id = document.board_id
          WHERE document.board_id = ?
            AND document.document_key = ?
            AND document.generation = ?
        `).get(
          tutor.ticket.boardId,
          tutor.ticket.defaultPageDocKey,
          tutor.ticket.generation,
        )).toEqual(before);
        expect(db.prepare(`
          SELECT
            (SELECT COUNT(*) FROM board_updates WHERE board_id = ?) AS updates,
            (SELECT COUNT(*) FROM board_update_receipts WHERE board_id = ?) AS receipts
        `).get(
          tutor.ticket.boardId,
          tutor.ticket.boardId,
        )).toEqual({ updates: 0, receipts: 0 });

        tutorPage.destroy();
        student.ws.close();
      } finally {
        await disposeHarness(isolated);
      }
    },
  );

  it("reassembles out-of-order client chunks and chunks large broadcasts", async () => {
    const fixture = createLessonFixture(harness);
    const tutor = await authenticateSocket(
      harness,
      fixture.tutor,
      fixture.lessonId,
    );
    const student = await authenticateSocket(
      harness,
      fixture.student,
      fixture.lessonId,
    );
    const tutorPage = await syncDocument(tutor, tutor.ticket.defaultPageDocKey);
    await syncDocument(student, student.ticket.defaultPageDocKey);
    const update = captureUpdate(tutorPage, () => {
      tutorPage.getText("chunk-test").insert(0, "x".repeat(350_000));
    });
    const messageId = new Uint8Array(randomBytes(16));
    const logical = encodeBoardFrame({
      type: BoardMessageType.UPDATE,
      generation: tutor.ticket.generation,
      docKey: tutor.ticket.defaultPageDocKey,
      messageId,
      update,
    });
    expect(logical.byteLength).toBeGreaterThan(256 * 1024);
    const chunkSize = 128 * 1024;
    const chunkCount = Math.ceil(logical.byteLength / chunkSize);
    const chunkMessageId = new Uint8Array(randomBytes(16));
    const peerUpdate = nextLogicalFrame(
      student.ws,
      (frame): frame is Extract<BoardFrame, { type: BoardMessageType.UPDATE }> =>
        frame.type === BoardMessageType.UPDATE,
    );
    const ack = nextFrame(
      tutor.ws,
      (frame): frame is Extract<BoardFrame, { type: BoardMessageType.ACK }> =>
        frame.type === BoardMessageType.ACK,
    );
    for (let index = chunkCount - 1; index >= 0; index -= 1) {
      const start = index * chunkSize;
      tutor.ws.send(encodeBoardFrame({
        type: BoardMessageType.CHUNK,
        messageId: chunkMessageId,
        innerType: BoardMessageType.UPDATE,
        chunkIndex: index,
        chunkCount,
        totalLength: logical.byteLength,
        payload: logical.subarray(
          start,
          Math.min(logical.byteLength, start + chunkSize),
        ),
      }));
    }
    expect((await ack).durableSequence).toBe(1);
    const broadcast = await peerUpdate;
    expect(broadcast.messageId).toEqual(messageId);
    expect(broadcast.update).toEqual(update);

    tutorPage.destroy();
    tutor.ws.close();
    student.ws.close();
  });

  it("reconstructs an unacknowledged durable update after a service restart", async () => {
    const isolated = await createHarness(true);
    let restarted: BoardSyncService | undefined;
    try {
      const fixture = createLessonFixture(isolated);
      const ticket = await requestTicket(
        isolated,
        fixture.tutor,
        fixture.lessonId,
      );
      const service = isolated.server.eduriContext.boardV2Sync!;
      const auth = service.authenticate({
        type: BoardMessageType.AUTH,
        ticket: ticket.ticket,
        generation: ticket.generation,
        minSchemaVersion: 1,
        maxSchemaVersion: 1,
        capabilities: ticket.capabilities,
      });
      const offline = new Y.Doc();
      const update = captureUpdate(offline, () => {
        offline.getMap("restart").set("durable", true);
      });
      const messageId = Buffer.from(randomBytes(16)).toString("hex");
      expect(service.appendUpdate(
        auth.access,
        auth.access.userId,
        ticket.defaultPageDocKey,
        messageId,
        update,
      )).toMatchObject({ seq: 1, duplicate: false });

      // Simulate a process loss after the SQLite commit and before an ACK.
      service.close();
      restarted = new BoardSyncService(isolated.server.eduriContext);
      const currentAuth = readAuthFromToken(
        isolated.server.eduriContext,
        fixture.tutor.rawToken,
      )!;
      const restartedTicket = restarted.issueTicket(currentAuth, {
        lessonId: fixture.lessonId,
        minSchemaVersion: 1,
        maxSchemaVersion: 1,
        capabilities: BOARD_SYNC_SERVER_CAPABILITIES,
      });
      const restartedAuth = restarted.authenticate({
        type: BoardMessageType.AUTH,
        ticket: restartedTicket.ticket,
        generation: restartedTicket.generation,
        minSchemaVersion: 1,
        maxSchemaVersion: 1,
        capabilities: restartedTicket.capabilities,
      });
      const restored = new Y.Doc();
      Y.applyUpdate(restored, restarted.missingUpdate(
        restartedAuth.access,
        restartedTicket.defaultPageDocKey,
        Y.encodeStateVector(restored),
      ));
      expect(restored.getMap("restart").get("durable")).toBe(true);
      expect(restarted.appendUpdate(
        restartedAuth.access,
        restartedAuth.access.userId,
        restartedTicket.defaultPageDocKey,
        messageId,
        update,
      )).toMatchObject({ seq: 1, duplicate: true });

      offline.destroy();
      restored.destroy();
    } finally {
      restarted?.close();
      await disposeHarness(isolated);
    }
  });

  it("authoritatively stamps awareness and rejects spoofed client IDs", async () => {
    const fixture = createLessonFixture(harness);
    const tutor = await authenticateSocket(
      harness,
      fixture.tutor,
      fixture.lessonId,
      { displayName: "Tutor Cursor", color: "#a1b2c3" },
    );
    const student = await authenticateSocket(
      harness,
      fixture.student,
      fixture.lessonId,
    );
    await syncDocument(tutor, "manifest");
    await syncDocument(student, "manifest");

    const received = nextFrame(
      student.ws,
      (
        frame,
      ): frame is Extract<BoardFrame, { type: BoardMessageType.AWARENESS }> =>
        frame.type === BoardMessageType.AWARENESS,
    );
    tutor.ws.send(encodeBoardFrame({
      type: BoardMessageType.AWARENESS,
      generation: tutor.ticket.generation,
      docKey: "manifest",
      awarenessClientId: tutor.ready.awarenessClientId,
      update: encodeAwarenessState(tutor.ready.awarenessClientId, 1, {
        userId: "spoofed",
        displayName: "Spoofed",
        role: "admin",
        cursor: { x: 11, y: 22 },
      }),
    }));
    const state = parseAwarenessUpdate((await received).update).state;
    expect(state).toMatchObject({
      userId: fixture.tutorId,
      displayName: "Tutor Cursor",
      color: "#a1b2c3",
      role: "tutor",
      cursor: { x: 11, y: 22 },
    });
    expect(state?.displayName).not.toBe("Spoofed");

    const control = nextFrame(
      tutor.ws,
      (frame): frame is Extract<BoardFrame, { type: BoardMessageType.CONTROL }> =>
        frame.type === BoardMessageType.CONTROL,
    );
    const close = nextClose(tutor.ws);
    tutor.ws.send(encodeBoardFrame({
      type: BoardMessageType.AWARENESS,
      generation: tutor.ticket.generation,
      docKey: "manifest",
      awarenessClientId: tutor.ready.awarenessClientId,
      update: encodeAwarenessState(
        (tutor.ready.awarenessClientId + 1) >>> 0,
        2,
        { cursor: { x: 0, y: 0 } },
      ),
    }));
    expect((await control).code).toBe(BoardControlCode.SERVER_ERROR);
    await expect(close).resolves.toBe(4400);
    student.ws.close();
  });

  it("updates a lesson profile and awareness in place, rejects bad input, and rechecks the session", async () => {
    const fixture = createLessonFixture(harness);
    const tutor = await authenticateSocket(
      harness,
      fixture.tutor,
      fixture.lessonId,
      { displayName: "Tutor Before", color: "#2563eb" },
    );
    const student = await authenticateSocket(
      harness,
      fixture.student,
      fixture.lessonId,
    );
    await syncDocument(tutor, "manifest");
    await syncDocument(student, "manifest");

    const initialPresence = nextFrame(
      student.ws,
      (frame): frame is Extract<BoardFrame, { type: BoardMessageType.AWARENESS }> =>
        frame.type === BoardMessageType.AWARENESS
        && frame.awarenessClientId === tutor.ready.awarenessClientId,
    );
    tutor.ws.send(encodeBoardFrame({
      type: BoardMessageType.AWARENESS,
      generation: tutor.ticket.generation,
      docKey: "manifest",
      awarenessClientId: tutor.ready.awarenessClientId,
      update: encodeAwarenessState(tutor.ready.awarenessClientId, 1, {
        cursor: { x: 11, y: 22 },
        selection: ["shape-a"],
      }),
    }));
    expect(parseAwarenessUpdate((await initialPresence).update).state)
      .toMatchObject({
        userId: fixture.tutorId,
        displayName: "Tutor Before",
        color: "#2563eb",
        cursor: { x: 11, y: 22 },
      });

    const profile = {
      displayName: "Tutor After",
      color: "#d33f49" as const,
    };
    const messageId = new Uint8Array(randomBytes(16));
    const result = nextFrame(
      tutor.ws,
      (frame): frame is Extract<BoardFrame, { type: BoardMessageType.CONTROL }> =>
        frame.type === BoardMessageType.CONTROL
        && frame.code === BoardControlCode.PROFILE_UPDATED,
    );
    const selfPresence = nextFrame(
      tutor.ws,
      (frame): frame is Extract<BoardFrame, { type: BoardMessageType.AWARENESS }> =>
        frame.type === BoardMessageType.AWARENESS
        && frame.awarenessClientId === tutor.ready.awarenessClientId,
    );
    const peerPresence = nextFrame(
      student.ws,
      (frame): frame is Extract<BoardFrame, { type: BoardMessageType.AWARENESS }> =>
        frame.type === BoardMessageType.AWARENESS
        && frame.awarenessClientId === tutor.ready.awarenessClientId,
    );
    tutor.ws.send(encodeBoardFrame({
      type: BoardMessageType.CONTROL,
      generation: tutor.ticket.generation,
      code: BoardControlCode.PROFILE_UPDATE,
      messageId,
      payload: encodeBoardProfileUpdatePayload(profile),
    }));

    const acknowledged = await result;
    expect(messageIdToHex(acknowledged.messageId!)).toBe(messageIdToHex(messageId));
    expect(decodeBoardProfileUpdatedPayload(acknowledged.payload)).toEqual({
      accepted: true,
      profile,
    });
    for (const presence of [await selfPresence, await peerPresence]) {
      expect(presence.awarenessClientId).toBe(tutor.ready.awarenessClientId);
      expect(parseAwarenessUpdate(presence.update)).toMatchObject({
        clientId: tutor.ready.awarenessClientId,
        clock: 2,
        state: {
          userId: fixture.tutorId,
          displayName: "Tutor After",
          color: "#d33f49",
          role: "tutor",
          cursor: { x: 11, y: 22 },
          selection: ["shape-a"],
        },
      });
    }
    expect(tutor.ws.readyState).toBe(WebSocket.OPEN);
    expect(student.ws.readyState).toBe(WebSocket.OPEN);

    const malformedId = new Uint8Array(randomBytes(16));
    const malformedResult = nextFrame(
      tutor.ws,
      (frame): frame is Extract<BoardFrame, { type: BoardMessageType.CONTROL }> =>
        frame.type === BoardMessageType.CONTROL
        && frame.code === BoardControlCode.PROFILE_UPDATED,
    );
    tutor.ws.send(encodeBoardFrame({
      type: BoardMessageType.CONTROL,
      generation: tutor.ticket.generation,
      code: BoardControlCode.PROFILE_UPDATE,
      messageId: malformedId,
      payload: Uint8Array.of(
        1, 0, 1, 65,
        35, 122, 122, 122, 122, 122, 122,
      ),
    }));
    expect(decodeBoardProfileUpdatedPayload((await malformedResult).payload))
      .toEqual({ accepted: false, error: "Profile is invalid" });
    expect(tutor.ws.readyState).toBe(WebSocket.OPEN);

    const oversizedResult = nextFrame(
      tutor.ws,
      (frame): frame is Extract<BoardFrame, { type: BoardMessageType.CONTROL }> =>
        frame.type === BoardMessageType.CONTROL
        && frame.code === BoardControlCode.PROFILE_UPDATED,
    );
    tutor.ws.send(encodeBoardFrame({
      type: BoardMessageType.CONTROL,
      generation: tutor.ticket.generation,
      code: BoardControlCode.PROFILE_UPDATE,
      messageId: new Uint8Array(randomBytes(16)),
      payload: new Uint8Array(251).fill(1),
    }));
    expect(decodeBoardProfileUpdatedPayload((await oversizedResult).payload))
      .toEqual({ accepted: false, error: "Profile is invalid" });
    expect(tutor.ws.readyState).toBe(WebSocket.OPEN);

    harness.server.eduriContext.db.prepare(
      "DELETE FROM sessions WHERE session_hash = ?",
    ).run(fixture.tutor.sessionHash);
    const revoked = nextFrame(
      tutor.ws,
      (frame): frame is Extract<BoardFrame, { type: BoardMessageType.CONTROL }> =>
        frame.type === BoardMessageType.CONTROL
        && frame.code === BoardControlCode.SESSION_REVOKED,
    );
    const closed = nextClose(tutor.ws);
    tutor.ws.send(encodeBoardFrame({
      type: BoardMessageType.CONTROL,
      generation: tutor.ticket.generation,
      code: BoardControlCode.PROFILE_UPDATE,
      messageId: new Uint8Array(randomBytes(16)),
      payload: Uint8Array.of(1, 0),
    }));
    expect((await revoked).code).toBe(BoardControlCode.SESSION_REVOKED);
    await expect(closed).resolves.toBe(4401);
    student.ws.close();
  });

  it("rejects a profile atomically when one of multiple awareness clocks is exhausted", async () => {
    const fixture = createLessonFixture(harness);
    const previousProfile = {
      displayName: "Tutor Before",
      color: "#2563eb" as const,
    };
    const tutor = await authenticateSocket(
      harness,
      fixture.tutor,
      fixture.lessonId,
      previousProfile,
    );
    const student = await authenticateSocket(
      harness,
      fixture.student,
      fixture.lessonId,
    );
    const docKeys = ["manifest", tutor.ticket.defaultPageDocKey] as const;
    for (const docKey of docKeys) {
      (await syncDocument(tutor, docKey)).destroy();
      (await syncDocument(student, docKey)).destroy();
    }

    const clocks = [1, 0xffff_fffe] as const;
    for (const [index, docKey] of docKeys.entries()) {
      const received = nextFrame(
        student.ws,
        (frame): frame is Extract<BoardFrame, { type: BoardMessageType.AWARENESS }> =>
          frame.type === BoardMessageType.AWARENESS
          && frame.docKey === docKey
          && frame.awarenessClientId === tutor.ready.awarenessClientId,
      );
      tutor.ws.send(encodeBoardFrame({
        type: BoardMessageType.AWARENESS,
        generation: tutor.ticket.generation,
        docKey,
        awarenessClientId: tutor.ready.awarenessClientId,
        update: encodeAwarenessState(
          tutor.ready.awarenessClientId,
          clocks[index]!,
          { cursor: { x: index + 1, y: index + 2 } },
        ),
      }));
      expect(parseAwarenessUpdate((await received).update).state).toMatchObject({
        userId: fixture.tutorId,
        displayName: previousProfile.displayName,
        color: previousProfile.color,
      });
    }

    const messageId = new Uint8Array(randomBytes(16));
    const result = nextFrame(
      tutor.ws,
      (frame): frame is Extract<BoardFrame, { type: BoardMessageType.CONTROL }> =>
        frame.type === BoardMessageType.CONTROL
        && frame.code === BoardControlCode.PROFILE_UPDATED,
    );
    const noPartialBroadcast = expectNoFrame(
      student.ws,
      (frame) =>
        frame.type === BoardMessageType.AWARENESS
        && frame.awarenessClientId === tutor.ready.awarenessClientId
        && parseAwarenessUpdate(frame.update).state?.displayName === "Tutor After",
      200,
    );
    tutor.ws.send(encodeBoardFrame({
      type: BoardMessageType.CONTROL,
      generation: tutor.ticket.generation,
      code: BoardControlCode.PROFILE_UPDATE,
      messageId,
      payload: encodeBoardProfileUpdatePayload({
        displayName: "Tutor After",
        color: "#d33f49",
      }),
    }));

    expect(decodeBoardProfileUpdatedPayload((await result).payload)).toEqual({
      accepted: false,
      error: "Profile awareness could not be updated",
    });
    await noPartialBroadcast;
    expect(tutor.ws.readyState).toBe(WebSocket.OPEN);

    const connectionIdentity = nextFrame(
      student.ws,
      (frame): frame is Extract<BoardFrame, { type: BoardMessageType.AWARENESS }> =>
        frame.type === BoardMessageType.AWARENESS
        && frame.docKey === docKeys[0]
        && frame.awarenessClientId === tutor.ready.awarenessClientId,
    );
    tutor.ws.send(encodeBoardFrame({
      type: BoardMessageType.AWARENESS,
      generation: tutor.ticket.generation,
      docKey: docKeys[0],
      awarenessClientId: tutor.ready.awarenessClientId,
      update: encodeAwarenessState(tutor.ready.awarenessClientId, 2, {
        cursor: { x: 10, y: 20 },
      }),
    }));
    expect(parseAwarenessUpdate((await connectionIdentity).update).state)
      .toMatchObject({
        userId: fixture.tutorId,
        displayName: previousProfile.displayName,
        color: previousProfile.color,
        cursor: { x: 10, y: 20 },
      });

    const observer = await authenticateSocket(
      harness,
      fixture.student,
      fixture.lessonId,
    );
    for (const [index, docKey] of docKeys.entries()) {
      const snapshot = nextFrame(
        observer.ws,
        (frame): frame is Extract<BoardFrame, { type: BoardMessageType.AWARENESS }> =>
          frame.type === BoardMessageType.AWARENESS
          && frame.docKey === docKey
          && frame.awarenessClientId === tutor.ready.awarenessClientId,
      );
      (await syncDocument(observer, docKey)).destroy();
      const parsed = parseAwarenessUpdate((await snapshot).update);
      expect(parsed.clock).toBe(index === 0 ? 2 : clocks[index]);
      expect(parsed.state).toMatchObject({
        userId: fixture.tutorId,
        displayName: previousProfile.displayName,
        color: previousProfile.color,
      });
    }
    observer.ws.close();
    tutor.ws.close();
    student.ws.close();
  });

  it("treats PROFILE_UPDATE without its negotiated capability as a protocol failure", async () => {
    const fixture = createLessonFixture(harness);
    const capabilities =
      BOARD_SYNC_SERVER_CAPABILITIES & ~BoardCapability.PROFILE_UPDATE;
    const ticketResponse = await request(harness.httpUrl)
      .post("/api/board-v2/sync-ticket")
      .set("Origin", ORIGIN)
      .set("Cookie", fixture.tutor.cookie)
      .set("x-csrf-token", fixture.tutor.csrf)
      .send({
        lessonId: fixture.lessonId,
        minSchemaVersion: 1,
        maxSchemaVersion: 1,
        capabilities,
      })
      .expect(200);
    const ticket = ticketResponse.body as BoardSyncTicketResponse;
    const ws = await openSocket(harness);
    const ready = nextFrame(
      ws,
      (frame): frame is Extract<BoardFrame, { type: BoardMessageType.READY }> =>
        frame.type === BoardMessageType.READY,
    );
    ws.send(encodeBoardFrame({
      type: BoardMessageType.AUTH,
      ticket: ticket.ticket,
      generation: ticket.generation,
      minSchemaVersion: 1,
      maxSchemaVersion: 1,
      capabilities,
    }));
    expect((await ready).capabilities & BoardCapability.PROFILE_UPDATE).toBe(0);

    const control = nextFrame(
      ws,
      (frame): frame is Extract<BoardFrame, { type: BoardMessageType.CONTROL }> =>
        frame.type === BoardMessageType.CONTROL
        && frame.code === BoardControlCode.SERVER_ERROR,
    );
    const closed = nextClose(ws);
    ws.send(encodeBoardFrame({
      type: BoardMessageType.CONTROL,
      generation: ticket.generation,
      code: BoardControlCode.PROFILE_UPDATE,
      messageId: new Uint8Array(randomBytes(16)),
      payload: encodeBoardProfileUpdatePayload({
        displayName: "Capability Probe",
        color: "#0891b2",
      }),
    }));

    const failure = await control;
    expect(failure.messageId).toBeUndefined();
    expect(JSON.parse(new TextDecoder().decode(failure.payload))).toMatchObject({
      error: "Profile updates were not negotiated",
    });
    await expect(closed).resolves.toBe(4400);
  });

  it("closes a connection after its profile update rate limit is exceeded", async () => {
    const fixture = createLessonFixture(harness);
    const tutor = await authenticateSocket(
      harness,
      fixture.tutor,
      fixture.lessonId,
    );
    const profile = {
      displayName: "Rate Profile",
      color: "#16825d" as const,
    };

    for (let index = 0; index < 30; index += 1) {
      const messageId = new Uint8Array(randomBytes(16));
      const result = nextFrame(
        tutor.ws,
        (frame): frame is Extract<BoardFrame, { type: BoardMessageType.CONTROL }> =>
          frame.type === BoardMessageType.CONTROL
          && frame.code === BoardControlCode.PROFILE_UPDATED
          && frame.messageId !== undefined
          && messageIdToHex(frame.messageId) === messageIdToHex(messageId),
      );
      tutor.ws.send(encodeBoardFrame({
        type: BoardMessageType.CONTROL,
        generation: tutor.ticket.generation,
        code: BoardControlCode.PROFILE_UPDATE,
        messageId,
        payload: encodeBoardProfileUpdatePayload(profile),
      }));
      expect(decodeBoardProfileUpdatedPayload((await result).payload)).toEqual({
        accepted: true,
        profile,
      });
    }

    const limitedId = new Uint8Array(randomBytes(16));
    const control = nextFrame(
      tutor.ws,
      (frame): frame is Extract<BoardFrame, { type: BoardMessageType.CONTROL }> =>
        frame.type === BoardMessageType.CONTROL
        && frame.code === BoardControlCode.RATE_LIMITED,
    );
    const closed = nextClose(tutor.ws);
    tutor.ws.send(encodeBoardFrame({
      type: BoardMessageType.CONTROL,
      generation: tutor.ticket.generation,
      code: BoardControlCode.PROFILE_UPDATE,
      messageId: limitedId,
      payload: encodeBoardProfileUpdatePayload(profile),
    }));

    const limited = await control;
    expect(messageIdToHex(limited.messageId!)).toBe(messageIdToHex(limitedId));
    const payload = JSON.parse(new TextDecoder().decode(limited.payload)) as {
      retryAfterMs: number;
    };
    expect(payload).toMatchObject({
      error: "Profile update rate exceeded",
      reason: "RATE_LIMITED",
      retryable: true,
      retryAfterMs: expect.any(Number),
    });
    expect(payload.retryAfterMs).toBeGreaterThan(0);
    expect(payload.retryAfterMs).toBeLessThanOrEqual(10_000);
    await expect(closed).resolves.toBe(4429);
  });

  it("updates a guest Board profile on the authenticated socket", async () => {
    const created = await request(harness.httpUrl)
      .post("/api/guest/rooms")
      .set("Origin", ORIGIN)
      .send({ initialResource: "board" })
      .expect(201);
    const shareId = created.body.room.shareId as string;
    const ticketResponse = await request(harness.httpUrl)
      .post(`/api/guest/rooms/${shareId}/board-ticket`)
      .set("Origin", ORIGIN)
      .send({
        deviceId: "guest-profile-update-device-0000000000",
        minSchemaVersion: 1,
        maxSchemaVersion: 1,
        capabilities: BOARD_SYNC_SERVER_CAPABILITIES,
        profile: { displayName: "Guest Before", color: "#2563eb" },
      })
      .expect(200);
    const ticket = ticketResponse.body as BoardSyncTicketResponse;
    const ws = await openSocket(harness);
    const readyPromise = nextFrame(
      ws,
      (frame): frame is Extract<BoardFrame, { type: BoardMessageType.READY }> =>
        frame.type === BoardMessageType.READY,
    );
    ws.send(encodeBoardFrame({
      type: BoardMessageType.AUTH,
      ticket: ticket.ticket,
      generation: ticket.generation,
      minSchemaVersion: 1,
      maxSchemaVersion: 1,
      capabilities: ticket.capabilities,
    }));
    const ready = await readyPromise;
    const authenticated = { ws, ready, ticket };
    await syncDocument(authenticated, ticket.defaultPageDocKey);
    ws.send(encodeBoardFrame({
      type: BoardMessageType.AWARENESS,
      generation: ticket.generation,
      docKey: ticket.defaultPageDocKey,
      awarenessClientId: ready.awarenessClientId,
      update: encodeAwarenessState(ready.awarenessClientId, 1, {
        cursor: { x: 4, y: 8 },
      }),
    }));

    const profile = {
      displayName: "Guest After",
      color: "#0891b2" as const,
    };
    const result = nextFrame(
      ws,
      (frame): frame is Extract<BoardFrame, { type: BoardMessageType.CONTROL }> =>
        frame.type === BoardMessageType.CONTROL
        && frame.code === BoardControlCode.PROFILE_UPDATED,
    );
    const presence = nextFrame(
      ws,
      (frame): frame is Extract<BoardFrame, { type: BoardMessageType.AWARENESS }> =>
        frame.type === BoardMessageType.AWARENESS
        && frame.awarenessClientId === ready.awarenessClientId,
    );
    ws.send(encodeBoardFrame({
      type: BoardMessageType.CONTROL,
      generation: ticket.generation,
      code: BoardControlCode.PROFILE_UPDATE,
      messageId: new Uint8Array(randomBytes(16)),
      payload: encodeBoardProfileUpdatePayload(profile),
    }));

    expect(decodeBoardProfileUpdatedPayload((await result).payload)).toEqual({
      accepted: true,
      profile,
    });
    expect(parseAwarenessUpdate((await presence).update)).toMatchObject({
      clientId: ready.awarenessClientId,
      clock: 2,
      state: {
        displayName: "Guest After",
        color: "#0891b2",
        role: "guest",
        cursor: { x: 4, y: 8 },
      },
    });
    expect(ws.readyState).toBe(WebSocket.OPEN);
    ws.close();
  });

  it("rechecks the session on every UPDATE and reconnects completed lessons read-only", async () => {
    const revokedFixture = createLessonFixture(harness);
    const revoked = await authenticateSocket(
      harness,
      revokedFixture.student,
      revokedFixture.lessonId,
    );
    const revokedPage = await syncDocument(
      revoked,
      revoked.ticket.defaultPageDocKey,
    );
    const update = captureUpdate(revokedPage, () => {
      revokedPage.getMap("acl").set("blocked", true);
    });
    harness.server.eduriContext.db.prepare(
      "DELETE FROM sessions WHERE session_hash = ?",
    ).run(revokedFixture.student.sessionHash);
    const revokedControl = nextFrame(
      revoked.ws,
      (frame): frame is Extract<BoardFrame, { type: BoardMessageType.CONTROL }> =>
        frame.type === BoardMessageType.CONTROL,
    );
    revoked.ws.send(encodeBoardFrame({
      type: BoardMessageType.UPDATE,
      generation: revoked.ticket.generation,
      docKey: revoked.ticket.defaultPageDocKey,
      messageId: new Uint8Array(randomBytes(16)),
      update,
    }));
    expect((await revokedControl).code).toBe(
      BoardControlCode.SESSION_REVOKED,
    );
    expect((harness.server.eduriContext.db.prepare(`
      SELECT COUNT(*) AS count FROM board_updates WHERE board_id = ?
    `).get(revoked.ticket.boardId) as { count: number }).count).toBe(0);

    const completedFixture = createLessonFixture(harness);
    const tutorSocket = await authenticateSocket(
      harness,
      completedFixture.tutor,
      completedFixture.lessonId,
    );
    const studentSocket = await authenticateSocket(
      harness,
      completedFixture.student,
      completedFixture.lessonId,
    );
    const tutorControl = nextFrame(
      tutorSocket.ws,
      (
        frame,
      ): frame is Extract<BoardFrame, { type: BoardMessageType.CONTROL }> =>
        frame.type === BoardMessageType.CONTROL,
    );
    const studentControl = nextFrame(
      studentSocket.ws,
      (
        frame,
      ): frame is Extract<BoardFrame, { type: BoardMessageType.CONTROL }> =>
        frame.type === BoardMessageType.CONTROL,
    );
    await request(harness.httpUrl)
      .post(`/api/lessons/${completedFixture.lessonId}/finish`)
      .set("Origin", ORIGIN)
      .set("Cookie", completedFixture.tutor.cookie)
      .set("x-csrf-token", completedFixture.tutor.csrf)
      .send({})
      .expect(200);
    expect((await tutorControl).code).toBe(
      BoardControlCode.PERMISSION_CHANGED,
    );
    expect((await studentControl).code).toBe(
      BoardControlCode.PERMISSION_CHANGED,
    );

    const readOnly = await authenticateSocket(
      harness,
      completedFixture.tutor,
      completedFixture.lessonId,
    );
    expect(readOnly.ready.permissions).toBe(BoardPermission.READ);
    const readOnlyPage = await syncDocument(
      readOnly,
      readOnly.ticket.defaultPageDocKey,
    );
    const rejected = captureUpdate(readOnlyPage, () => {
      readOnlyPage.getMap("acl").set("readOnly", false);
    });
    const readOnlyControl = nextFrame(
      readOnly.ws,
      (
        frame,
      ): frame is Extract<BoardFrame, { type: BoardMessageType.CONTROL }> =>
        frame.type === BoardMessageType.CONTROL,
    );
    readOnly.ws.send(encodeBoardFrame({
      type: BoardMessageType.UPDATE,
      generation: readOnly.ticket.generation,
      docKey: readOnly.ticket.defaultPageDocKey,
      messageId: new Uint8Array(randomBytes(16)),
      update: rejected,
    }));
    expect((await readOnlyControl).code).toBe(
      BoardControlCode.PERMISSION_CHANGED,
    );

    revokedPage.destroy();
    readOnlyPage.destroy();
    revoked.ws.terminate();
    tutorSocket.ws.terminate();
    studentSocket.ws.terminate();
    readOnly.ws.terminate();
  });

  it("revokes passive recipients before UPDATE and asset-ready delivery", async () => {
    const fixture = createLessonFixture(harness);
    const tutor = await authenticateSocket(
      harness,
      fixture.tutor,
      fixture.lessonId,
    );
    const updateRecipient = await authenticateSocket(
      harness,
      fixture.student,
      fixture.lessonId,
    );
    const assetSession = createSession(harness, fixture.studentId);
    const assetRecipient = await authenticateSocket(
      harness,
      assetSession,
      fixture.lessonId,
    );
    const tutorPage = await syncDocument(
      tutor,
      tutor.ticket.defaultPageDocKey,
    );
    await syncDocument(
      updateRecipient,
      updateRecipient.ticket.defaultPageDocKey,
    );
    const update = captureUpdate(tutorPage, () => {
      tutorPage.getMap("acl").set("outbound-reauthorization", true);
    });
    const messageId = new Uint8Array(randomBytes(16));
    harness.server.eduriContext.db.prepare(
      "DELETE FROM sessions WHERE session_hash IN (?, ?)",
    ).run(fixture.student.sessionHash, assetSession.sessionHash);

    const noRevokedUpdate = expectNoFrame(
      updateRecipient.ws,
      (frame) =>
        frame.type === BoardMessageType.UPDATE
        && Buffer.from(frame.messageId).equals(Buffer.from(messageId)),
    );
    const updateControl = nextFrame(
      updateRecipient.ws,
      (
        frame,
      ): frame is Extract<BoardFrame, { type: BoardMessageType.CONTROL }> =>
        frame.type === BoardMessageType.CONTROL,
    );
    const updateClose = nextClose(updateRecipient.ws);
    const tutorAck = nextFrame(
      tutor.ws,
      (frame): frame is Extract<BoardFrame, { type: BoardMessageType.ACK }> =>
        frame.type === BoardMessageType.ACK,
    );
    tutor.ws.send(encodeBoardFrame({
      type: BoardMessageType.UPDATE,
      generation: tutor.ticket.generation,
      docKey: tutor.ticket.defaultPageDocKey,
      messageId,
      update,
    }));
    expect((await tutorAck).durableSequence).toBe(1);
    expect((await updateControl).code).toBe(
      BoardControlCode.SESSION_REVOKED,
    );
    await expect(updateClose).resolves.toBe(4401);
    await noRevokedUpdate;

    const noAssetReady = expectNoFrame(
      assetRecipient.ws,
      (frame) =>
        frame.type === BoardMessageType.CONTROL
        && frame.code === BoardControlCode.ASSET_READY,
    );
    const assetControl = nextFrame(
      assetRecipient.ws,
      (
        frame,
      ): frame is Extract<BoardFrame, { type: BoardMessageType.CONTROL }> =>
        frame.type === BoardMessageType.CONTROL
        && frame.code === BoardControlCode.SESSION_REVOKED,
    );
    const assetClose = nextClose(assetRecipient.ws);
    await harness.server.eduriContext.emitBoardAssetReady?.({
      type: "asset-ready",
      boardId: tutor.ticket.boardId,
      generation: tutor.ticket.generation,
      assetId: randomUUID(),
      sha256: "a".repeat(64),
      mimeType: "image/png",
      byteSize: 1,
      width: 1,
      height: 1,
      frameCount: 1,
      totalDecodedPixels: 1,
      publishedAt: nowIso(),
    });
    expect((await assetControl).code).toBe(
      BoardControlCode.SESSION_REVOKED,
    );
    await expect(assetClose).resolves.toBe(4401);
    await noAssetReady;

    tutorPage.destroy();
    tutor.ws.close();
  });

  it("expires an idle authenticated socket without an inbound frame", async () => {
    const isolated = await createHarness(true, {
      boardV2SessionAuditIntervalMs: 20,
    });
    try {
      const fixture = createLessonFixture(isolated);
      const passive = await authenticateSocket(
        isolated,
        fixture.student,
        fixture.lessonId,
      );
      const control = nextFrame(
        passive.ws,
        (
          frame,
        ): frame is Extract<BoardFrame, { type: BoardMessageType.CONTROL }> =>
          frame.type === BoardMessageType.CONTROL,
      );
      const close = nextClose(passive.ws);
      isolated.server.eduriContext.db.prepare(`
        UPDATE sessions SET expires_at = ? WHERE session_hash = ?
      `).run(
        new Date(Date.now() - 1_000).toISOString(),
        fixture.student.sessionHash,
      );

      expect((await control).code).toBe(
        BoardControlCode.SESSION_REVOKED,
      );
      await expect(close).resolves.toBe(4401);
    } finally {
      await disposeHarness(isolated);
    }
  });

  it("uses the global flag only as a v2 kill switch without legacy fallback", async () => {
    const disabled = await createHarness(false);
    let temporarilyEnabled: BoardSyncService | undefined;
    try {
      const fixture = createLessonFixture(disabled);
      await request(disabled.httpUrl)
        .post("/api/board-v2/sync-ticket")
        .set("Origin", ORIGIN)
        .set("Cookie", fixture.tutor.cookie)
        .set("x-csrf-token", fixture.tutor.csrf)
        .send({ lessonId: fixture.lessonId })
        .expect(503)
        .expect({
          code: "BOARD_V2_DISABLED",
          error: "Board is temporarily unavailable",
        });
      expect(disabled.server.eduriContext.db.prepare(`
        SELECT COUNT(*) AS count FROM boards WHERE lesson_id = ?
      `).get(fixture.lessonId)).toEqual({ count: 0 });

      temporarilyEnabled = new BoardSyncService(
        disabled.server.eduriContext,
      );
      disabled.server.eduriContext.boardV2Sync = temporarilyEnabled;
      const ticket = await requestTicket(
        disabled,
        fixture.tutor,
        fixture.lessonId,
      );
      expect(
        temporarilyEnabled.repository.getBoardForLesson(fixture.lessonId),
      ).toMatchObject({
        id: ticket.boardId,
        engine: "v2",
      });

      disabled.server.eduriContext.boardV2Sync = undefined;
      temporarilyEnabled.close();
      temporarilyEnabled = undefined;
      await request(disabled.httpUrl)
        .post("/api/board-v2/sync-ticket")
        .set("Origin", ORIGIN)
        .set("Cookie", fixture.student.cookie)
        .set("x-csrf-token", fixture.student.csrf)
        .send({ lessonId: fixture.lessonId })
        .expect(503)
        .expect({
          code: "BOARD_V2_DISABLED",
          error: "Board is temporarily unavailable",
        });
      await request(disabled.httpUrl)
        .get("/api/board-v2/metrics")
        .query({ lessonId: fixture.lessonId })
        .set("Origin", ORIGIN)
        .set("Cookie", fixture.tutor.cookie)
        .expect(503)
        .expect({
          code: "BOARD_V2_DISABLED",
          error: "Board is temporarily unavailable",
        });
      await expect(
        rejectedUpgrade(disabled, ORIGIN, BOARD_SUBPROTOCOL),
      ).resolves.toBe(404);
    } finally {
      temporarilyEnabled?.close();
      disabled.server.eduriContext.boardV2Sync = undefined;
      await disposeHarness(disabled);
    }
  });
});

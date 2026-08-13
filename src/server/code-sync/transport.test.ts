import http, { type Server as HttpServer } from "node:http";
import Database from "better-sqlite3";
import { Server as SocketIOServer } from "socket.io";
import {
  io as createSocketClient,
  type Socket as ClientSocket,
} from "socket.io-client";
import * as Y from "yjs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CODE_SYNC_CAPABILITIES,
  CODE_SYNC_MESSAGE_EVENT,
  CODE_SYNC_NAMESPACE,
  CODE_SYNC_PROTOCOL_VERSION,
  CODE_SYNC_TAGS,
  CODE_SYNC_UPDATE_ENCODING,
  type CodeSyncServerMessage,
} from "../../code/protocol/index.js";
import {
  SHARED_TERMINAL_ACK_EVENT,
  SHARED_TERMINAL_ACTION_EVENT,
  SHARED_TERMINAL_DELTA_EVENT,
  SHARED_TERMINAL_EFFECT_EVENT,
  SHARED_TERMINAL_PROTOCOL_VERSION,
  SHARED_TERMINAL_STATE_EVENT,
  applySharedTerminalDelta,
  type SharedTerminalAck,
  type SharedTerminalClientEffect,
  type SharedTerminalDelta,
  type SharedTerminalState,
} from "../../code/terminal/index.js";
import { codeWorkspaceText } from "../../code/core/index.js";
import { migrate } from "../db.js";
import {
  GUEST_ROOM_IDLE_TTL_MS,
  GuestRoomService,
} from "../guestRooms.js";
import { CodeSyncRepository } from "./repository.js";
import { installCodeSyncSchema } from "./schema.js";
import { CodeSyncService, CodeSyncServiceError } from "./service.js";
import { attachCodeSyncNamespace } from "./transport.js";

function nextMessage(
  socket: ClientSocket,
  predicate: (message: CodeSyncServerMessage) => boolean,
): Promise<CodeSyncServerMessage> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(CODE_SYNC_MESSAGE_EVENT, handler);
      reject(new Error("Timed out waiting for Code sync message"));
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

function encodedCaret(offset = 0): Uint8Array {
  const document = new Y.Doc();
  const text = document.getText("presence");
  text.insert(0, "cursor");
  const encoded = Y.encodeRelativePosition(
    Y.createRelativePositionFromTypeIndex(text, offset),
  );
  document.destroy();
  return encoded;
}

function nextSocketEvent<T>(
  socket: ClientSocket,
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

describe("Code sync Socket.IO namespace", () => {
  let db: Database.Database;
  let httpServer: HttpServer;
  let io: SocketIOServer;
  let baseUrl: string;
  let shareId: string;
  let now: number;
  let guestRooms: GuestRoomService;
  let service: CodeSyncService;
  const clients: ClientSocket[] = [];

  beforeEach(async () => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    migrate(db);
    installCodeSyncSchema(db);
    now = Date.parse("2026-08-09T08:00:00.000Z");
    guestRooms = new GuestRoomService(db, () => now);
    shareId = guestRooms.create("code").shareKey;
    service = new CodeSyncService(
      new CodeSyncRepository(db, () => now),
      guestRooms,
    );
    httpServer = http.createServer();
    io = new SocketIOServer(httpServer, {
      maxHttpBufferSize: 5 * 1024 * 1024,
    });
    attachCodeSyncNamespace(io, service, {
      awarenessPerMinute: 1,
      syncPerMinute: 2,
      updatesPerMinute: 2,
      updateBytesPerMinute: 100,
      maxRateScopes: 1,
      rateScopeIdleMs: 60_000,
      ingressEventsPerMinute: 32,
      ingressBytesPerMinute: 4 * 1024 * 1024,
      ingressEventsPerIpPerMinute: 1_000,
      ingressBytesPerIpPerMinute: 4 * 1024 * 1024,
      ingressEventsGlobalPerMinute: 10_000,
      ingressBytesGlobalPerMinute: 256 * 1024 * 1024,
      maxIngressIpScopes: 8,
      maxIngressPrincipalScopes: 8,
      ingressScopeIdleMs: 60_000,
      trustedProxy: "127.0.0.1",
      now: () => now,
      allowedOrigins: ["http://eduri.test"],
    });
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
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    for (const client of clients) client.close();
    await new Promise<void>((resolve) => io.close(() => resolve()));
    db.close();
  });

  function client(
    auth: Record<string, unknown>,
    sourceIp?: string,
  ): ClientSocket {
    const socket = createSocketClient(`${baseUrl}${CODE_SYNC_NAMESPACE}`, {
      auth,
      autoConnect: false,
      forceNew: true,
      reconnection: false,
      transports: ["websocket"],
      extraHeaders: {
        Origin: "http://eduri.test",
        ...(sourceIp ? { "X-Real-IP": sourceIp } : {}),
      },
    });
    clients.push(socket);
    return socket;
  }

  async function connect(
    deviceId: string,
    targetShareId = shareId,
    sourceIp?: string,
  ): Promise<ClientSocket> {
    const socket = client({ shareId: targetShareId, deviceId }, sourceIp);
    const connected = new Promise<void>((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("connect_error", reject);
    });
    const ready = nextMessage(
      socket,
      (message) => message.type === CODE_SYNC_TAGS.ready,
    );
    socket.connect();
    await connected;
    await ready;
    return socket;
  }

  it("uses fixed auth-only capability and rejects extra handshake fields", async () => {
    expect(CODE_SYNC_NAMESPACE).toBe("/code-sync");
    const socket = client({
      shareId,
      deviceId: "bad-device",
      capability: "must-not-be-in-auth-or-url",
    });
    const error = new Promise<Error & { data?: CodeSyncServerMessage }>((resolve) => {
      socket.once("connect_error", resolve);
    });
    socket.connect();
    const failure = await error;
    expect(failure.data).toMatchObject({
      type: CODE_SYNC_TAGS.control,
      code: "invalid-message",
    });
  });

  it("charges malformed near-5 MiB namespace auth before auth parsing", async () => {
    const oversizedAuth = client({
      shareId,
      deviceId: "oversized-auth-device",
      filler: "x".repeat(5 * 1024 * 1024 - 8 * 1024),
    });
    const oversizedError = new Promise<Error & { data?: CodeSyncServerMessage }>((resolve) => {
      oversizedAuth.once("connect_error", resolve);
    });
    oversizedAuth.connect();
    await expect(oversizedError).resolves.toMatchObject({
      data: {
        type: CODE_SYNC_TAGS.control,
        code: "rate-limited",
      },
    });

    const retry = client({ shareId, deviceId: "oversized-auth-retry" });
    const retryError = new Promise<Error & { data?: CodeSyncServerMessage }>((resolve) => {
      retry.once("connect_error", resolve);
    });
    retry.connect();
    await expect(retryError).resolves.toMatchObject({
      data: {
        type: CODE_SYNC_TAGS.control,
        code: "rate-limited",
      },
    });

    now += 60_000;
    await expect(connect("oversized-auth-after-window")).resolves.toBeDefined();
  });

  it("rejects a WebSocket handshake from a missing or untrusted Origin", async () => {
    const socket = createSocketClient(`${baseUrl}${CODE_SYNC_NAMESPACE}`, {
      auth: { shareId, deviceId: "cross-origin-device" },
      autoConnect: false,
      forceNew: true,
      reconnection: false,
      transports: ["websocket"],
      extraHeaders: { Origin: "https://attacker.example" },
    });
    clients.push(socket);
    const error = new Promise<Error & { data?: CodeSyncServerMessage }>((resolve) => {
      socket.once("connect_error", resolve);
    });
    socket.connect();
    await expect(error).resolves.toMatchObject({
      data: {
        type: CODE_SYNC_TAGS.control,
        code: "invalid-message",
        terminal: false,
      },
    });
    expect(socket.connected).toBe(false);
  });

  it("fails closed when the allowed-origin set is empty", async () => {
    await new Promise<void>((resolve) => io.close(() => resolve()));
    httpServer = http.createServer();
    io = new SocketIOServer(httpServer);
    attachCodeSyncNamespace(io, service, { allowedOrigins: [] });
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
    baseUrl = `http://127.0.0.1:${address.port}`;
    const socket = createSocketClient(`${baseUrl}${CODE_SYNC_NAMESPACE}`, {
      auth: { shareId, deviceId: "empty-origin-set-device" },
      autoConnect: false,
      forceNew: true,
      reconnection: false,
      transports: ["websocket"],
      extraHeaders: { Origin: "http://eduri.test" },
    });
    clients.push(socket);
    const error = new Promise<Error & { data?: CodeSyncServerMessage }>((resolve) => {
      socket.once("connect_error", resolve);
    });
    socket.connect();

    await expect(error).resolves.toMatchObject({
      data: {
        type: CODE_SYNC_TAGS.control,
        code: "invalid-message",
        terminal: false,
      },
    });
    expect(socket.connected).toBe(false);
  });

  it("acks committed updates, broadcasts them, and bounds awareness", async () => {
    const leftReady = nextMessage(
      client({ shareId, deviceId: "left-device" }),
      (message) => message.type === CODE_SYNC_TAGS.ready,
    );
    const left = clients.at(-1)!;
    const leftConnected = new Promise<void>((resolve, reject) => {
      left.once("connect", resolve);
      left.once("connect_error", reject);
    });
    left.connect();
    await leftConnected;
    const ready = await leftReady;
    expect(ready.type).toBe(CODE_SYNC_TAGS.ready);
    if (ready.type !== CODE_SYNC_TAGS.ready) return;
    expect(ready.participant).toMatchObject({
      participantId: expect.any(String),
      displayName: expect.stringMatching(/^Гость /u),
      color: expect.stringMatching(/^#[0-9a-f]{6}$/u),
    });
    expect(ready.participant.participantId).not.toBe("left-device");
    const right = await connect("right-device");
    const leftDocument = new Y.Doc();
    const rightDocument = new Y.Doc();
    try {
      const initial = await left.timeout(2_000).emitWithAck(
        CODE_SYNC_MESSAGE_EVENT,
        {
          type: CODE_SYNC_TAGS.syncStep1,
          protocolVersion: CODE_SYNC_PROTOCOL_VERSION,
          requestId: "initial-left",
          stateVector: Y.encodeStateVector(leftDocument),
        },
      ) as CodeSyncServerMessage;
      expect(initial.type).toBe(CODE_SYNC_TAGS.syncStep2);
      if (initial.type !== CODE_SYNC_TAGS.syncStep2) return;
      expect(initial.done).toBe(true);
      Y.applyUpdate(leftDocument, initial.update);

      const rightInitial = await right.timeout(2_000).emitWithAck(
        CODE_SYNC_MESSAGE_EVENT,
        {
          type: CODE_SYNC_TAGS.syncStep1,
          protocolVersion: CODE_SYNC_PROTOCOL_VERSION,
          requestId: "initial-right",
          stateVector: Y.encodeStateVector(rightDocument),
        },
      ) as CodeSyncServerMessage;
      if (rightInitial.type !== CODE_SYNC_TAGS.syncStep2) return;
      Y.applyUpdate(rightDocument, rightInitial.update);

      const before = Y.encodeStateVector(leftDocument);
      codeWorkspaceText(leftDocument, "main-py")?.insert(0, "# socket\n");
      const update = Y.encodeStateAsUpdate(leftDocument, before);
      const remotePromise = nextMessage(
        right,
        (message) => message.type === CODE_SYNC_TAGS.remoteUpdate,
      );
      const ack = await left.timeout(2_000).emitWithAck(
        CODE_SYNC_MESSAGE_EVENT,
        {
          type: CODE_SYNC_TAGS.update,
          protocolVersion: CODE_SYNC_PROTOCOL_VERSION,
          requestId: "socket-request",
          updateId: "socket-update",
          updateEncoding: CODE_SYNC_UPDATE_ENCODING,
          update,
        },
      ) as CodeSyncServerMessage;
      expect(ack).toMatchObject({
        type: CODE_SYNC_TAGS.updateAck,
        status: "committed",
        updateId: "socket-update",
      });
      const remote = await remotePromise;
      expect(remote.type).toBe(CODE_SYNC_TAGS.remoteUpdate);
      if (remote.type !== CODE_SYNC_TAGS.remoteUpdate) return;
      Y.applyUpdate(rightDocument, remote.update);
      expect(codeWorkspaceText(rightDocument, "main-py")?.toString())
        .toContain("# socket");

      const awarenessPromise = nextMessage(
        right,
        (message) => (
          message.type === CODE_SYNC_TAGS.awareness
          && "participant" in message
          && message.participant.participantId === ready.participant.participantId
          && message.state !== null
        ),
      );
      const caret = encodedCaret(4);
      left.emit(CODE_SYNC_MESSAGE_EVENT, {
        type: CODE_SYNC_TAGS.awareness,
        protocolVersion: CODE_SYNC_PROTOCOL_VERSION,
        state: {
          target: { kind: "file", entryId: "main-py", field: "text" },
          selection: { anchor: caret, head: caret },
        },
      });
      const awarenessMessage = await awarenessPromise;
      expect(awarenessMessage).toMatchObject({
        participant: ready.participant,
        state: {
          target: { kind: "file", entryId: "main-py", field: "text" },
          selection: {
            anchor: expect.any(Uint8Array),
            head: expect.any(Uint8Array),
          },
        },
      });
      if (
        awarenessMessage.type !== CODE_SYNC_TAGS.awareness
        || awarenessMessage.state === null
        || !("selection" in awarenessMessage.state)
        || !awarenessMessage.state.selection
      ) throw new Error("Expected awareness selection");
      expect(Uint8Array.from(awarenessMessage.state.selection.anchor))
        .toEqual(caret);
      expect(Uint8Array.from(awarenessMessage.state.selection.head))
        .toEqual(caret);

      const limitedCaret = encodedCaret(5);
      const limited = await left.timeout(2_000).emitWithAck(
        CODE_SYNC_MESSAGE_EVENT,
        {
          type: CODE_SYNC_TAGS.awareness,
          protocolVersion: CODE_SYNC_PROTOCOL_VERSION,
          state: {
            target: { kind: "file", entryId: "main-py", field: "text" },
            selection: {
              anchor: limitedCaret,
              head: limitedCaret,
            },
          },
        },
      ) as CodeSyncServerMessage;
      expect(limited).toMatchObject({
        type: CODE_SYNC_TAGS.control,
        code: "rate-limited",
        terminal: false,
      });
    } finally {
      leftDocument.destroy();
      rightDocument.destroy();
    }
  });

  it("broadcasts plural awareness to capable peers and primary-only awareness to legacy peers", async () => {
    const sender = await connect("mixed-awareness-sender");
    const legacy = await connect("mixed-awareness-legacy");
    const capable = await connect("mixed-awareness-capable");

    await legacy.timeout(2_000).emitWithAck(CODE_SYNC_MESSAGE_EVENT, {
      type: CODE_SYNC_TAGS.syncStep1,
      protocolVersion: CODE_SYNC_PROTOCOL_VERSION,
      requestId: "mixed-awareness-legacy-sync",
      stateVector: Uint8Array.of(0),
    });
    capable.emit(CODE_SYNC_MESSAGE_EVENT, {
      type: CODE_SYNC_TAGS.capabilities,
      protocolVersion: CODE_SYNC_PROTOCOL_VERSION,
      capabilities: [CODE_SYNC_CAPABILITIES.multiSelectionAwareness],
    });
    await capable.timeout(2_000).emitWithAck(CODE_SYNC_MESSAGE_EVENT, {
      type: CODE_SYNC_TAGS.syncStep1,
      protocolVersion: CODE_SYNC_PROTOCOL_VERSION,
      requestId: "mixed-awareness-capable-sync",
      stateVector: Uint8Array.of(0),
    });

    const legacyMessage = nextMessage(
      legacy,
      (message) => message.type === CODE_SYNC_TAGS.awareness
        && message.state !== null,
    );
    const capableMessage = nextMessage(
      capable,
      (message) => message.type === CODE_SYNC_TAGS.awareness
        && message.state !== null,
    );
    const primary = encodedCaret(1);
    const secondary = encodedCaret(5);
    sender.emit(CODE_SYNC_MESSAGE_EVENT, {
      type: CODE_SYNC_TAGS.awareness,
      protocolVersion: CODE_SYNC_PROTOCOL_VERSION,
      state: {
        target: { kind: "file", entryId: "main-py", field: "text" },
        selections: [
          { anchor: primary, head: primary },
          { anchor: secondary, head: secondary },
        ],
      },
    });

    const legacyAwareness = await legacyMessage;
    const capableAwareness = await capableMessage;
    expect(legacyAwareness).toMatchObject({
      state: { target: { kind: "file", entryId: "main-py", field: "text" } },
    });
    if (
      legacyAwareness.type !== CODE_SYNC_TAGS.awareness
      || legacyAwareness.state === null
      || !("selection" in legacyAwareness.state)
      || !legacyAwareness.state.selection
    ) throw new Error("Expected legacy awareness selection");
    expect(legacyAwareness.state).not.toHaveProperty("selections");
    expect(Uint8Array.from(legacyAwareness.state.selection.anchor)).toEqual(primary);
    expect(Uint8Array.from(legacyAwareness.state.selection.head)).toEqual(primary);

    expect(capableAwareness).toMatchObject({
      state: { target: { kind: "file", entryId: "main-py", field: "text" } },
    });
    if (
      capableAwareness.type !== CODE_SYNC_TAGS.awareness
      || capableAwareness.state === null
      || !("selections" in capableAwareness.state)
      || !capableAwareness.state.selections
    ) throw new Error("Expected plural awareness selections");
    expect(capableAwareness.state).not.toHaveProperty("selection");
    expect(capableAwareness.state.selections.map((selection) => ({
      anchor: Uint8Array.from(selection.anchor),
      head: Uint8Array.from(selection.head),
    }))).toEqual([
      { anchor: primary, head: primary },
      { anchor: secondary, head: secondary },
    ]);
  });

  it("orders one shared terminal state and routes execution to its selected host", async () => {
    const host = await connect("terminal-host");
    const observer = await connect("terminal-observer");
    const hostInitialEvent = nextSocketEvent<SharedTerminalState>(
      host,
      SHARED_TERMINAL_STATE_EVENT,
    );
    host.emit(SHARED_TERMINAL_ACTION_EVENT, {
      protocolVersion: SHARED_TERMINAL_PROTOCOL_VERSION,
      action: { type: "sync", actionId: "host-initial-sync" },
    });
    const hostInitial = await hostInitialEvent;
    const observerInitialEvent = nextSocketEvent<SharedTerminalState>(
      observer,
      SHARED_TERMINAL_STATE_EVENT,
    );
    observer.emit(SHARED_TERMINAL_ACTION_EVENT, {
      protocolVersion: SHARED_TERMINAL_PROTOCOL_VERSION,
      action: { type: "sync", actionId: "observer-initial-sync" },
    });
    const observerInitial = await observerInitialEvent;
    const hostDelta = nextSocketEvent<SharedTerminalDelta>(
      host,
      SHARED_TERMINAL_DELTA_EVENT,
    );
    const observerDelta = nextSocketEvent<SharedTerminalDelta>(
      observer,
      SHARED_TERMINAL_DELTA_EVENT,
    );
    const hostAck = nextSocketEvent<SharedTerminalAck>(
      host,
      SHARED_TERMINAL_ACK_EVENT,
      (ack) => ack.actionId === "terminal-submit-1",
    );
    const hostEffect = nextSocketEvent<SharedTerminalClientEffect>(
      host,
      SHARED_TERMINAL_EFFECT_EVENT,
      (effect) => effect.type === "execute-line",
    );

    host.emit(SHARED_TERMINAL_ACTION_EVENT, {
      protocolVersion: SHARED_TERMINAL_PROTOCOL_VERSION,
      action: {
        type: "submit-line",
        actionId: "terminal-submit-1",
        value: "pwd",
      },
    });

    const [hostUpdate, observerUpdate, ack, effect] = await Promise.all([
      hostDelta,
      observerDelta,
      hostAck,
      hostEffect,
    ]);
    expect(observerUpdate).toEqual(hostUpdate);
    const hostSnapshot = applySharedTerminalDelta(hostInitial, hostUpdate);
    const observerSnapshot = applySharedTerminalDelta(observerInitial, observerUpdate);
    expect(observerSnapshot).toEqual(hostSnapshot);
    expect(ack).toMatchObject({ status: "applied", seq: hostSnapshot?.seq });
    expect(hostSnapshot).toMatchObject({
      mode: "busy",
      transcript: expect.stringContaining("$ pwd\n"),
      activeRun: { runId: expect.any(String) },
    });
    if (!hostSnapshot) throw new Error("Shared terminal snapshot is missing");
    expect(effect).toMatchObject({
      protocolVersion: SHARED_TERMINAL_PROTOCOL_VERSION,
      type: "execute-line",
      runId: hostSnapshot.activeRun?.runId,
      line: "pwd",
      pythonMode: false,
    });
    const runId = hostSnapshot.activeRun?.runId;
    if (!runId) throw new Error("Shared terminal did not create a run");

    const completed = nextSocketEvent<SharedTerminalDelta>(
      observer,
      SHARED_TERMINAL_DELTA_EVENT,
    );
    host.emit(SHARED_TERMINAL_ACTION_EVENT, {
      protocolVersion: SHARED_TERMINAL_PROTOCOL_VERSION,
      action: {
        type: "host-ready",
        actionId: "terminal-ready-1",
        runId,
        nextMode: "shell",
      },
    });
    const completedDelta = await completed;
    expect(applySharedTerminalDelta(observerSnapshot!, completedDelta)).toMatchObject({
      mode: "shell",
      activeRun: null,
    });
  });

  it("streams a cold sync as ordered bounded parts", async () => {
    const writer = await connect("multipart-writer");
    const writerDocument = new Y.Doc();
    const readerDocument = new Y.Doc();
    try {
      const initial = await writer.timeout(2_000).emitWithAck(
        CODE_SYNC_MESSAGE_EVENT,
        {
          type: CODE_SYNC_TAGS.syncStep1,
          protocolVersion: CODE_SYNC_PROTOCOL_VERSION,
          requestId: "multipart-writer-initial",
          stateVector: Y.encodeStateVector(writerDocument),
        },
      ) as CodeSyncServerMessage;
      expect(initial.type).toBe(CODE_SYNC_TAGS.syncStep2);
      if (initial.type !== CODE_SYNC_TAGS.syncStep2) return;
      Y.applyUpdate(writerDocument, initial.update);

      for (const [index, text] of ["first\n", "second\n"].entries()) {
        const before = Y.encodeStateVector(writerDocument);
        codeWorkspaceText(writerDocument, "main-py")?.insert(
          codeWorkspaceText(writerDocument, "main-py")?.length ?? 0,
          text,
        );
        const response = await writer.timeout(2_000).emitWithAck(
          CODE_SYNC_MESSAGE_EVENT,
          {
            type: CODE_SYNC_TAGS.update,
            protocolVersion: CODE_SYNC_PROTOCOL_VERSION,
            requestId: `multipart-write-request-${index}`,
            updateId: `multipart-write-${index}`,
            updateEncoding: CODE_SYNC_UPDATE_ENCODING,
            update: Y.encodeStateAsUpdate(writerDocument, before),
          },
        ) as CodeSyncServerMessage;
        expect(response).toMatchObject({
          type: CODE_SYNC_TAGS.updateAck,
          status: "committed",
        });
      }

      const reader = await connect("multipart-reader");
      const parts: Extract<CodeSyncServerMessage, {
        type: typeof CODE_SYNC_TAGS.syncStep2;
      }>[] = [];
      const complete = new Promise<void>((resolve) => {
        reader.on(CODE_SYNC_MESSAGE_EVENT, (message: CodeSyncServerMessage) => {
          if (
            message.type !== CODE_SYNC_TAGS.syncStep2
            || message.requestId !== "multipart-reader-cold"
          ) return;
          parts.push(message);
          if (message.done) resolve();
        });
      });
      reader.emit(CODE_SYNC_MESSAGE_EVENT, {
        type: CODE_SYNC_TAGS.syncStep1,
        protocolVersion: CODE_SYNC_PROTOCOL_VERSION,
        requestId: "multipart-reader-cold",
        stateVector: Y.encodeStateVector(readerDocument),
      });
      await complete;

      expect(parts.length).toBeGreaterThan(1);
      expect(parts.map((part) => part.part)).toEqual(
        parts.map((_, index) => index),
      );
      expect(parts.filter((part) => part.done)).toHaveLength(1);
      expect(parts.at(-1)?.done).toBe(true);
      for (const part of parts) Y.applyUpdate(readerDocument, part.update);
      expect(codeWorkspaceText(readerDocument, "main-py")?.toString())
        .toContain("first\nsecond\n");
      expect(Y.encodeStateVector(readerDocument))
        .toEqual(Y.encodeStateVector(writerDocument));
    } finally {
      writerDocument.destroy();
      readerDocument.destroy();
    }
  });

  it("rate-limits update count", async () => {
    const countLimited = await connect("count-limited");
    const countDocument = new Y.Doc();
    try {
      const initial = await countLimited.timeout(2_000).emitWithAck(
        CODE_SYNC_MESSAGE_EVENT,
        {
          type: CODE_SYNC_TAGS.syncStep1,
          protocolVersion: CODE_SYNC_PROTOCOL_VERSION,
          requestId: "count-initial",
          stateVector: Y.encodeStateVector(countDocument),
        },
      ) as CodeSyncServerMessage;
      if (initial.type !== CODE_SYNC_TAGS.syncStep2) return;
      Y.applyUpdate(countDocument, initial.update);
      for (let index = 0; index < 3; index += 1) {
        const before = Y.encodeStateVector(countDocument);
        codeWorkspaceText(countDocument, "main-py")?.insert(0, String(index));
        const response = await countLimited.timeout(2_000).emitWithAck(
          CODE_SYNC_MESSAGE_EVENT,
          {
            type: CODE_SYNC_TAGS.update,
            protocolVersion: CODE_SYNC_PROTOCOL_VERSION,
            requestId: `count-request-${index}`,
            updateId: `count-update-${index}`,
            updateEncoding: CODE_SYNC_UPDATE_ENCODING,
            update: Y.encodeStateAsUpdate(countDocument, before),
          },
        ) as CodeSyncServerMessage;
        expect(response).toMatchObject(index < 2 ? {
          type: CODE_SYNC_TAGS.updateAck,
          status: "committed",
        } : {
          type: CODE_SYNC_TAGS.control,
          code: "rate-limited",
          terminal: false,
        });
      }
    } finally {
      countDocument.destroy();
    }
  });

  it("shares sync and awareness budgets across sockets and reconnects", async () => {
    const observer = await connect("aggregate-observer");
    const sender = await connect("aggregate-awareness-sender");
    await observer.timeout(2_000).emitWithAck(
      CODE_SYNC_MESSAGE_EVENT,
      {
        type: CODE_SYNC_TAGS.syncStep1,
        protocolVersion: CODE_SYNC_PROTOCOL_VERSION,
        requestId: "aggregate-observer-replay",
        stateVector: Uint8Array.of(0),
      },
    );
    const firstAwareness = nextMessage(
      observer,
      (message) => message.type === CODE_SYNC_TAGS.awareness
        && message.state !== null,
    );
    sender.emit(CODE_SYNC_MESSAGE_EVENT, {
      type: CODE_SYNC_TAGS.awareness,
      protocolVersion: CODE_SYNC_PROTOCOL_VERSION,
      state: {
        target: { kind: "file", entryId: "main-py", field: "text" },
        selection: {
          anchor: encodedCaret(1),
          head: encodedCaret(1),
        },
      },
    });
    await firstAwareness;
    sender.close();

    const rotated = await connect("aggregate-awareness-rotated");
    const awarenessBlocked = await rotated.timeout(2_000).emitWithAck(
      CODE_SYNC_MESSAGE_EVENT,
      {
        type: CODE_SYNC_TAGS.awareness,
        protocolVersion: CODE_SYNC_PROTOCOL_VERSION,
        state: {
          target: { kind: "file", entryId: "main-py", field: "text" },
          selection: {
            anchor: encodedCaret(2),
            head: encodedCaret(2),
          },
        },
      },
    ) as CodeSyncServerMessage;
    expect(awarenessBlocked).toMatchObject({
      type: CODE_SYNC_TAGS.control,
      code: "rate-limited",
      terminal: false,
    });

    const firstSync = await rotated.timeout(2_000).emitWithAck(
      CODE_SYNC_MESSAGE_EVENT,
      {
        type: CODE_SYNC_TAGS.syncStep1,
        protocolVersion: CODE_SYNC_PROTOCOL_VERSION,
        requestId: "aggregate-sync-0",
        stateVector: Uint8Array.of(0),
      },
    ) as CodeSyncServerMessage;
    expect(firstSync.type).toBe(CODE_SYNC_TAGS.syncStep2);
    const observerSync = await observer.timeout(2_000).emitWithAck(
        CODE_SYNC_MESSAGE_EVENT,
        {
          type: CODE_SYNC_TAGS.syncStep1,
          protocolVersion: CODE_SYNC_PROTOCOL_VERSION,
          requestId: "aggregate-sync-observer-limit",
          stateVector: Uint8Array.of(0),
        },
      ) as CodeSyncServerMessage;
    expect(observerSync).toMatchObject({
      type: CODE_SYNC_TAGS.control,
      code: "rate-limited",
    });
    observer.close();
    rotated.close();
    const reconnected = await connect("aggregate-sync-rotated");
    const syncBlocked = await reconnected.timeout(2_000).emitWithAck(
      CODE_SYNC_MESSAGE_EVENT,
      {
        type: CODE_SYNC_TAGS.syncStep1,
        protocolVersion: CODE_SYNC_PROTOCOL_VERSION,
        requestId: "aggregate-sync-blocked",
        stateVector: Uint8Array.of(0),
      },
    ) as CodeSyncServerMessage;
    expect(syncBlocked).toMatchObject({
      type: CODE_SYNC_TAGS.control,
      code: "rate-limited",
      terminal: false,
      requestId: "aggregate-sync-blocked",
    });
  });

  it("shares the update-event budget across sockets, device rotation, and reconnect", async () => {
    const first = await connect("aggregate-first");
    const second = await connect("aggregate-second");
    const local = new Y.Doc();
    const cold = new Y.Doc();
    try {
      const initial = await first.timeout(2_000).emitWithAck(
        CODE_SYNC_MESSAGE_EVENT,
        {
          type: CODE_SYNC_TAGS.syncStep1,
          protocolVersion: CODE_SYNC_PROTOCOL_VERSION,
          requestId: "aggregate-initial",
          stateVector: Y.encodeStateVector(local),
        },
      ) as CodeSyncServerMessage;
      if (initial.type !== CODE_SYNC_TAGS.syncStep2) return;
      Y.applyUpdate(local, initial.update);

      const updates: Uint8Array[] = [];
      for (const value of ["first", "second", "blocked-after-reconnect"]) {
        const before = Y.encodeStateVector(local);
        codeWorkspaceText(local, "main-py")?.insert(
          codeWorkspaceText(local, "main-py")?.length ?? 0,
          `${value}\n`,
        );
        updates.push(Y.encodeStateAsUpdate(local, before));
      }
      expect(updates[0].byteLength + updates[1].byteLength)
        .toBeLessThanOrEqual(100);

      for (const [index, socket] of [first, second].entries()) {
        const response = await socket.timeout(2_000).emitWithAck(
          CODE_SYNC_MESSAGE_EVENT,
          {
            type: CODE_SYNC_TAGS.update,
            protocolVersion: CODE_SYNC_PROTOCOL_VERSION,
            requestId: `aggregate-request-${index}`,
            updateId: `aggregate-update-${index}`,
            updateEncoding: CODE_SYNC_UPDATE_ENCODING,
            update: updates[index],
          },
        ) as CodeSyncServerMessage;
        expect(response).toMatchObject({
          type: CODE_SYNC_TAGS.updateAck,
          status: "committed",
        });
      }

      first.close();
      second.close();
      const reconnected = await connect("aggregate-rotated-device");
      const blocked = await reconnected.timeout(2_000).emitWithAck(
        CODE_SYNC_MESSAGE_EVENT,
        {
          type: CODE_SYNC_TAGS.update,
          protocolVersion: CODE_SYNC_PROTOCOL_VERSION,
          requestId: "aggregate-request-blocked",
          updateId: "aggregate-update-blocked",
          updateEncoding: CODE_SYNC_UPDATE_ENCODING,
          update: updates[2],
        },
      ) as CodeSyncServerMessage;
      expect(blocked).toMatchObject({
        type: CODE_SYNC_TAGS.control,
        code: "rate-limited",
        terminal: false,
        requestId: "aggregate-request-blocked",
      });

      const parts: Extract<CodeSyncServerMessage, {
        type: typeof CODE_SYNC_TAGS.syncStep2;
      }>[] = [];
      const complete = new Promise<void>((resolve) => {
        reconnected.on(CODE_SYNC_MESSAGE_EVENT, (message: CodeSyncServerMessage) => {
          if (
            message.type !== CODE_SYNC_TAGS.syncStep2
            || message.requestId !== "aggregate-cold-sync"
          ) return;
          parts.push(message);
          if (message.done) resolve();
        });
      });
      reconnected.emit(CODE_SYNC_MESSAGE_EVENT, {
        type: CODE_SYNC_TAGS.syncStep1,
        protocolVersion: CODE_SYNC_PROTOCOL_VERSION,
        requestId: "aggregate-cold-sync",
        stateVector: Y.encodeStateVector(cold),
      });
      await complete;
      for (const part of parts) Y.applyUpdate(cold, part.update);
      expect(codeWorkspaceText(cold, "main-py")?.toString())
        .toContain("first\nsecond\n");
      expect(codeWorkspaceText(cold, "main-py")?.toString())
        .not.toContain("blocked-after-reconnect");
    } finally {
      local.destroy();
      cold.destroy();
    }
  });

  it("shares the byte budget across a reconnect", async () => {
    const first = await connect("byte-aggregate-first");
    const local = new Y.Doc();
    try {
      const initial = await first.timeout(2_000).emitWithAck(
        CODE_SYNC_MESSAGE_EVENT,
        {
          type: CODE_SYNC_TAGS.syncStep1,
          protocolVersion: CODE_SYNC_PROTOCOL_VERSION,
          requestId: "byte-aggregate-initial",
          stateVector: Y.encodeStateVector(local),
        },
      ) as CodeSyncServerMessage;
      if (initial.type !== CODE_SYNC_TAGS.syncStep2) return;
      Y.applyUpdate(local, initial.update);

      const makeUpdate = (value: string): Uint8Array => {
        const before = Y.encodeStateVector(local);
        codeWorkspaceText(local, "main-py")?.insert(
          codeWorkspaceText(local, "main-py")?.length ?? 0,
          value,
        );
        return Y.encodeStateAsUpdate(local, before);
      };
      const firstUpdate = makeUpdate("a".repeat(50));
      const secondUpdate = makeUpdate("b".repeat(50));
      expect(firstUpdate.byteLength).toBeLessThanOrEqual(100);
      expect(secondUpdate.byteLength).toBeLessThanOrEqual(100);
      expect(firstUpdate.byteLength + secondUpdate.byteLength).toBeGreaterThan(100);

      const accepted = await first.timeout(2_000).emitWithAck(
        CODE_SYNC_MESSAGE_EVENT,
        {
          type: CODE_SYNC_TAGS.update,
          protocolVersion: CODE_SYNC_PROTOCOL_VERSION,
          requestId: "byte-aggregate-first-request",
          updateId: "byte-aggregate-first-update",
          updateEncoding: CODE_SYNC_UPDATE_ENCODING,
          update: firstUpdate,
        },
      ) as CodeSyncServerMessage;
      expect(accepted).toMatchObject({
        type: CODE_SYNC_TAGS.updateAck,
        status: "committed",
      });

      first.close();
      const reconnected = await connect("byte-aggregate-rotated-device");
      const blocked = await reconnected.timeout(2_000).emitWithAck(
        CODE_SYNC_MESSAGE_EVENT,
        {
          type: CODE_SYNC_TAGS.update,
          protocolVersion: CODE_SYNC_PROTOCOL_VERSION,
          requestId: "byte-aggregate-second-request",
          updateId: "byte-aggregate-second-update",
          updateEncoding: CODE_SYNC_UPDATE_ENCODING,
          update: secondUpdate,
        },
      ) as CodeSyncServerMessage;
      expect(blocked).toMatchObject({
        type: CODE_SYNC_TAGS.control,
        code: "rate-limited",
        terminal: false,
      });
    } finally {
      local.destroy();
    }
  });

  it("bounds and expires aggregate workspace rate scopes", async () => {
    const first = await connect("scope-first");
    const firstSync = await first.timeout(2_000).emitWithAck(
      CODE_SYNC_MESSAGE_EVENT,
      {
        type: CODE_SYNC_TAGS.syncStep1,
        protocolVersion: CODE_SYNC_PROTOCOL_VERSION,
        requestId: "scope-first-sync",
        stateVector: Uint8Array.of(0),
      },
    ) as CodeSyncServerMessage;
    expect(firstSync.type).toBe(CODE_SYNC_TAGS.syncStep2);

    const secondShareId = guestRooms.create("code").shareKey;
    const second = await connect("scope-second", secondShareId);
    const full = await second.timeout(2_000).emitWithAck(
      CODE_SYNC_MESSAGE_EVENT,
      {
        type: CODE_SYNC_TAGS.syncStep1,
        protocolVersion: CODE_SYNC_PROTOCOL_VERSION,
        requestId: "scope-second-full",
        stateVector: Uint8Array.of(0),
      },
    ) as CodeSyncServerMessage;
    expect(full).toMatchObject({
      type: CODE_SYNC_TAGS.control,
      code: "rate-limited",
      requestId: "scope-second-full",
    });

    now += 60_000;
    const afterCleanup = await second.timeout(2_000).emitWithAck(
      CODE_SYNC_MESSAGE_EVENT,
      {
        type: CODE_SYNC_TAGS.syncStep1,
        protocolVersion: CODE_SYNC_PROTOCOL_VERSION,
        requestId: "scope-second-after-cleanup",
        stateVector: Uint8Array.of(0),
      },
    ) as CodeSyncServerMessage;
    expect(afterCleanup.type).toBe(CODE_SYNC_TAGS.syncStep2);
  });

  it("rate-limits aggregate update bytes", async () => {
    const byteLimited = await connect("byte-limited");
    const byteDocument = new Y.Doc();
    try {
      const initial = await byteLimited.timeout(2_000).emitWithAck(
        CODE_SYNC_MESSAGE_EVENT,
        {
          type: CODE_SYNC_TAGS.syncStep1,
          protocolVersion: CODE_SYNC_PROTOCOL_VERSION,
          requestId: "bytes-initial",
          stateVector: Y.encodeStateVector(byteDocument),
        },
      ) as CodeSyncServerMessage;
      if (initial.type !== CODE_SYNC_TAGS.syncStep2) return;
      Y.applyUpdate(byteDocument, initial.update);
      const before = Y.encodeStateVector(byteDocument);
      codeWorkspaceText(byteDocument, "main-py")?.insert(0, "x".repeat(2_000));
      const oversizedUpdate = Y.encodeStateAsUpdate(byteDocument, before);
      expect(oversizedUpdate.byteLength).toBeGreaterThan(100);
      const response = await byteLimited.timeout(2_000).emitWithAck(
        CODE_SYNC_MESSAGE_EVENT,
        {
          type: CODE_SYNC_TAGS.update,
          protocolVersion: CODE_SYNC_PROTOCOL_VERSION,
          requestId: "bytes-request",
          updateId: "bytes-update",
          updateEncoding: CODE_SYNC_UPDATE_ENCODING,
          update: oversizedUpdate,
        },
      ) as CodeSyncServerMessage;
      expect(response).toMatchObject({
        type: CODE_SYNC_TAGS.control,
        code: "rate-limited",
        terminal: false,
      });
    } finally {
      byteDocument.destroy();
    }
  });

  it("charges a malformed near-5 MiB packet before protocol parsing and across reconnects", async () => {
    const first = await connect(
      "malformed-large-first",
      shareId,
      "198.51.100.1",
    );
    const disconnected = new Promise<string>((resolve) => {
      first.once("disconnect", resolve);
    });
    const malformed = "x".repeat(5 * 1024 * 1024 - 8 * 1024);
    const limited = await first.timeout(5_000).emitWithAck(
      CODE_SYNC_MESSAGE_EVENT,
      malformed,
    ) as CodeSyncServerMessage;
    expect(limited).toMatchObject({
      type: CODE_SYNC_TAGS.control,
      code: "rate-limited",
      terminal: false,
    });
    await expect(disconnected).resolves.toBe("io server disconnect");

    const rotated = await connect(
      "malformed-large-rotated",
      shareId,
      "198.51.100.2",
    );
    const stillLimited = await rotated.timeout(2_000).emitWithAck(
      CODE_SYNC_MESSAGE_EVENT,
      {
        type: CODE_SYNC_TAGS.syncStep1,
        protocolVersion: CODE_SYNC_PROTOCOL_VERSION,
        requestId: "malformed-large-still-limited",
        stateVector: Uint8Array.of(0),
      },
    ) as CodeSyncServerMessage;
    expect(stillLimited).toMatchObject({
      type: CODE_SYNC_TAGS.control,
      code: "rate-limited",
    });

    now += 60_000;
    const afterWindow = await connect(
      "malformed-large-after-window",
      shareId,
      "198.51.100.3",
    );
    const recovered = await afterWindow.timeout(2_000).emitWithAck(
      CODE_SYNC_MESSAGE_EVENT,
      {
        type: CODE_SYNC_TAGS.syncStep1,
        protocolVersion: CODE_SYNC_PROTOCOL_VERSION,
        requestId: "malformed-large-recovered",
        stateVector: Uint8Array.of(0),
      },
    ) as CodeSyncServerMessage;
    expect(recovered.type).toBe(CODE_SYNC_TAGS.syncStep2);
  });

  it("shares malformed packet-count accounting across parallel sockets and reconnects", async () => {
    const first = await connect("malformed-count-first");
    const second = await connect("malformed-count-second");
    for (let index = 0; index < 32; index += 1) {
      const response = await (index % 2 === 0 ? first : second)
        .timeout(2_000)
        .emitWithAck(CODE_SYNC_MESSAGE_EVENT, { malformed: index }) as CodeSyncServerMessage;
      expect(response).toMatchObject({
        type: CODE_SYNC_TAGS.control,
        code: "invalid-message",
      });
    }

    const blocked = await first.timeout(2_000).emitWithAck(
      CODE_SYNC_MESSAGE_EVENT,
      { malformed: "parallel-overflow" },
    ) as CodeSyncServerMessage;
    expect(blocked).toMatchObject({
      type: CODE_SYNC_TAGS.control,
      code: "rate-limited",
    });
    const parallelBlocked = await second.timeout(2_000).emitWithAck(
      CODE_SYNC_MESSAGE_EVENT,
      { malformed: "parallel-still-blocked" },
    ) as CodeSyncServerMessage;
    expect(parallelBlocked).toMatchObject({
      type: CODE_SYNC_TAGS.control,
      code: "rate-limited",
    });

    const reconnected = await connect("malformed-count-reconnected");
    const reconnectBlocked = await reconnected.timeout(2_000).emitWithAck(
      CODE_SYNC_MESSAGE_EVENT,
      { malformed: "reconnect-still-blocked" },
    ) as CodeSyncServerMessage;
    expect(reconnectBlocked).toMatchObject({
      type: CODE_SYNC_TAGS.control,
      code: "rate-limited",
    });
  });

  it("revokes an already-connected socket when the room expires", async () => {
    const socket = await connect("expiring-device");
    now += GUEST_ROOM_IDLE_TTL_MS;
    const control = nextMessage(
      socket,
      (message) => (
        message.type === CODE_SYNC_TAGS.control
        && message.code === "expired"
      ),
    );
    const disconnected = new Promise<string>((resolve) => {
      socket.once("disconnect", resolve);
    });
    socket.emit(CODE_SYNC_MESSAGE_EVENT, {
      type: CODE_SYNC_TAGS.syncStep1,
      protocolVersion: CODE_SYNC_PROTOCOL_VERSION,
      requestId: "expired-sync",
      stateVector: Uint8Array.of(0),
    });
    await expect(control).resolves.toMatchObject({
      type: CODE_SYNC_TAGS.control,
      code: "expired",
      terminal: true,
      requestId: "expired-sync",
    });
    await expect(disconnected).resolves.toBe("io server disconnect");
    expect(db.prepare("SELECT count(*) AS count FROM code_workspaces").get())
      .toEqual({ count: 0 });
  });

  it("does not disclose terminal history when terminal reauthorization fails", async () => {
    const socket = await connect("expiring-terminal-device");
    const leakedStates: SharedTerminalState[] = [];
    socket.on(SHARED_TERMINAL_STATE_EVENT, (state: SharedTerminalState) => {
      leakedStates.push(state);
    });
    now += GUEST_ROOM_IDLE_TTL_MS;
    const rejected = nextSocketEvent<SharedTerminalAck>(
      socket,
      SHARED_TERMINAL_ACK_EVENT,
      (ack) => ack.actionId === "expired-terminal-action",
    );
    const disconnected = new Promise<string>((resolve) => {
      socket.once("disconnect", resolve);
    });
    socket.emit(SHARED_TERMINAL_ACTION_EVENT, {
      protocolVersion: SHARED_TERMINAL_PROTOCOL_VERSION,
      action: {
        type: "submit-line",
        actionId: "expired-terminal-action",
        value: "pwd",
      },
    });

    await expect(rejected).resolves.toMatchObject({
      status: "rejected",
      error: "unauthorized",
    });
    await expect(disconnected).resolves.toBe("io server disconnect");
    expect(leakedStates).toEqual([]);
  });

  it("reauthorizes a silent recipient before sending a remote Yjs update", async () => {
    const sender = await connect("outbound-update-sender");
    const recipient = await connect("outbound-update-recipient");
    const originalReauthorize = service.reauthorize.bind(service);
    const reauthorize = vi.spyOn(service, "reauthorize").mockImplementation((session) => {
      if (session.deviceId === "outbound-update-recipient") {
        throw new CodeSyncServiceError("EXPIRED", "Guest room has expired");
      }
      originalReauthorize(session);
    });
    const leaked: CodeSyncServerMessage[] = [];
    recipient.on(CODE_SYNC_MESSAGE_EVENT, (message: CodeSyncServerMessage) => {
      if (message.type === CODE_SYNC_TAGS.remoteUpdate) leaked.push(message);
    });
    const control = nextMessage(
      recipient,
      (message) => message.type === CODE_SYNC_TAGS.control,
    );
    const disconnected = new Promise<string>((resolve) => {
      recipient.once("disconnect", resolve);
    });
    const document = new Y.Doc();
    try {
      const initial = await sender.timeout(2_000).emitWithAck(
        CODE_SYNC_MESSAGE_EVENT,
        {
          type: CODE_SYNC_TAGS.syncStep1,
          protocolVersion: CODE_SYNC_PROTOCOL_VERSION,
          requestId: "outbound-update-sync",
          stateVector: Y.encodeStateVector(document),
        },
      ) as CodeSyncServerMessage;
      if (initial.type !== CODE_SYNC_TAGS.syncStep2) {
        throw new Error("Expected initial Code sync state");
      }
      Y.applyUpdate(document, initial.update);
      const before = Y.encodeStateVector(document);
      codeWorkspaceText(document, "main-py")?.insert(0, "# outbound auth\n");
      const update = Y.encodeStateAsUpdate(document, before);

      const ack = await sender.timeout(2_000).emitWithAck(
        CODE_SYNC_MESSAGE_EVENT,
        {
          type: CODE_SYNC_TAGS.update,
          protocolVersion: CODE_SYNC_PROTOCOL_VERSION,
          requestId: "outbound-update-request",
          updateId: "outbound-update-id",
          updateEncoding: CODE_SYNC_UPDATE_ENCODING,
          update,
        },
      ) as CodeSyncServerMessage;

      expect(ack).toMatchObject({
        type: CODE_SYNC_TAGS.updateAck,
        status: "committed",
      });
      await expect(control).resolves.toMatchObject({
        type: CODE_SYNC_TAGS.control,
        code: "expired",
        terminal: true,
      });
      await expect(disconnected).resolves.toBe("io server disconnect");
      expect(leaked).toEqual([]);
    } finally {
      document.destroy();
      reauthorize.mockRestore();
    }
  });

  it("reauthorizes a silent recipient before sending awareness", async () => {
    const sender = await connect("outbound-awareness-sender");
    const recipient = await connect("outbound-awareness-recipient");
    const originalReauthorize = service.reauthorize.bind(service);
    const reauthorize = vi.spyOn(service, "reauthorize").mockImplementation((session) => {
      if (session.deviceId === "outbound-awareness-recipient") {
        throw new CodeSyncServiceError("EXPIRED", "Guest room has expired");
      }
      originalReauthorize(session);
    });
    const leaked: CodeSyncServerMessage[] = [];
    recipient.on(CODE_SYNC_MESSAGE_EVENT, (message: CodeSyncServerMessage) => {
      if (message.type === CODE_SYNC_TAGS.awareness) leaked.push(message);
    });
    const control = nextMessage(
      recipient,
      (message) => message.type === CODE_SYNC_TAGS.control,
    );
    const disconnected = new Promise<string>((resolve) => {
      recipient.once("disconnect", resolve);
    });

    sender.emit(CODE_SYNC_MESSAGE_EVENT, {
      type: CODE_SYNC_TAGS.awareness,
      protocolVersion: CODE_SYNC_PROTOCOL_VERSION,
      state: {
        target: { kind: "file", entryId: "main-py", field: "text" },
        selection: {
          anchor: encodedCaret(2),
          head: encodedCaret(2),
        },
      },
    });

    await expect(control).resolves.toMatchObject({
      type: CODE_SYNC_TAGS.control,
      code: "expired",
      terminal: true,
    });
    await expect(disconnected).resolves.toBe("io server disconnect");
    expect(leaked).toEqual([]);
    reauthorize.mockRestore();
  });

  it("reauthorizes a silent recipient before shared terminal broadcasts", async () => {
    const recipient = await connect("outbound-terminal-recipient");
    // Keep the revoked socket first in the room iteration order. Disconnecting
    // it during a broadcast must not put a lease-release delta ahead of the
    // action delta that caused the authorization check.
    const sender = await connect("outbound-terminal-sender");
    const originalReauthorize = service.reauthorize.bind(service);
    const reauthorize = vi.spyOn(service, "reauthorize").mockImplementation((session) => {
      if (session.deviceId === "outbound-terminal-recipient") {
        throw new CodeSyncServiceError("EXPIRED", "Guest room has expired");
      }
      originalReauthorize(session);
    });
    const leaked: unknown[] = [];
    for (const event of [
      SHARED_TERMINAL_STATE_EVENT,
      SHARED_TERMINAL_DELTA_EVENT,
      SHARED_TERMINAL_EFFECT_EVENT,
    ]) {
      recipient.on(event, (payload: unknown) => leaked.push({ event, payload }));
    }
    const control = nextMessage(
      recipient,
      (message) => message.type === CODE_SYNC_TAGS.control,
    );
    const disconnected = new Promise<string>((resolve) => {
      recipient.once("disconnect", resolve);
    });
    const senderAck = nextSocketEvent<SharedTerminalAck>(
      sender,
      SHARED_TERMINAL_ACK_EVENT,
      (ack) => ack.actionId === "outbound-terminal-submit",
    );

    sender.emit(SHARED_TERMINAL_ACTION_EVENT, {
      protocolVersion: SHARED_TERMINAL_PROTOCOL_VERSION,
      action: {
        type: "submit-line",
        actionId: "outbound-terminal-submit",
        value: "pwd",
      },
    });

    await expect(senderAck).resolves.toMatchObject({ status: "applied" });
    await expect(control).resolves.toMatchObject({
      type: CODE_SYNC_TAGS.control,
      code: "expired",
      terminal: true,
    });
    await expect(disconnected).resolves.toBe("io server disconnect");
    expect(leaked).toEqual([]);
    reauthorize.mockRestore();
  });
});

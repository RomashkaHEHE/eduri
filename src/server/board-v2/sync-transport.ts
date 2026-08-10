import { createHash, randomBytes } from "node:crypto";
import type { IncomingMessage, Server as HttpServer } from "node:http";
import { isIP } from "node:net";
import type { Duplex } from "node:stream";

import WebSocket, {
  WebSocketServer,
  type RawData,
} from "ws";

import {
  BOARD_PROTOCOL_LIMITS,
  BOARD_SUBPROTOCOL,
  BoardCapability,
  BoardControlCode,
  BoardMessageType,
  BoardProtocolError,
  decodeBoardFrame,
  encodeBoardFrame,
  messageIdToHex,
  type AwarenessFrame,
  type BoardFrame,
  type BoardMessageId,
  type ChunkFrame,
  type ControlFrame,
  type UpdateFrame,
} from "../../board/protocol/index.js";
import type { LessonStatus } from "../types.js";
import type { AppContext } from "../types.js";
import type { AssetReadyEvent } from "./assets.js";
import {
  authorizeAwarenessUpdate,
  BoardAwarenessError,
  BoardAwarenessRegistry,
  parseAwarenessUpdate,
  type BoardAwarenessIdentity,
} from "./sync-awareness.js";
import {
  BOARD_SYNC_WEBSOCKET_PATH,
  BoardSyncServiceError,
  type AuthenticatedBoardSync,
  type BoardSyncAccess,
  type BoardSyncService,
} from "./sync-service.js";

const AUTH_TIMEOUT_MS = 5_000;
const CHUNK_TIMEOUT_MS = 10_000;
const CHUNK_THRESHOLD_BYTES = BOARD_PROTOCOL_LIMITS.maxChunkPayloadBytes;
const MAX_ACTIVE_ASSEMBLIES = 2;
const MAX_BUFFERED_CHUNK_BYTES =
  BOARD_PROTOCOL_LIMITS.maxReassembledBytes * MAX_ACTIVE_ASSEMBLIES;
const MAX_SOCKET_BUFFERED_BYTES = 32 * 1024 * 1024;
const SYNC_SOCKET_RESUME_BYTES = 4 * 1024 * 1024;
const SYNC_SOCKET_DRAIN_TIMEOUT_MS = 30_000;
const SYNC_SOCKET_DRAIN_POLL_MS = 4;
const RATE_WINDOW_MS = 10_000;
const STORAGE_PRESSURE_RETRY_AFTER_MS = 60_000;

export const BOARD_SYNC_ADMISSION_LIMITS = Object.freeze({
  maxConnections: 512,
  maxConnectionsPerIp: 24,
  maxPendingAuthConnections: 128,
  maxPendingAuthConnectionsPerIp: 8,
});

export const BOARD_SYNC_AGGREGATE_RATE_LIMITS = Object.freeze({
  maxTrackedKeys: 4_096,
  inboundFramesPerIp: 4_000,
  inboundBytesPerIp: 128 * 1024 * 1024,
  updatesPerPrincipal: 2_400,
  updateBytesPerPrincipal: 128 * 1024 * 1024,
  awarenessPerPrincipal: 1_200,
  awarenessBytesPerPrincipal: 4 * 1024 * 1024,
});

const CLOSE_PROTOCOL = 4400;
const CLOSE_UNAUTHORIZED = 4401;
const CLOSE_FORBIDDEN = 4403;
const CLOSE_GONE = 4410;
const CLOSE_RATE_LIMITED = 4429;

const IDENTITY_COLORS = [
  "#2563eb",
  "#dc2626",
  "#059669",
  "#7c3aed",
  "#c2410c",
  "#0e7490",
] as const;

interface ChunkAssembly {
  innerType: BoardMessageType.SYNC_STEP2 | BoardMessageType.UPDATE;
  chunkCount: number;
  totalLength: number;
  chunks: Array<Uint8Array | undefined>;
  receivedBytes: number;
  timer: NodeJS.Timeout;
}

interface BoardSocketConnection {
  ws: WebSocket;
  ipKey: string;
  pendingAuth: boolean;
  authTimer: NodeJS.Timeout;
  authenticated?: AuthenticatedBoardSync;
  awarenessClientId?: number;
  subscribedDocs: Set<string>;
  awaitingClientSyncDocs: Set<string>;
  syncingDocs: Set<string>;
  awarenessDocs: Set<string>;
  chunks: ChunkReassembler;
  frameRate: FixedWindowRate;
  updateRate: FixedWindowRate;
  awarenessRate: FixedWindowRate;
}

class FixedWindowRate {
  private startedAt = Date.now();
  private count = 0;

  constructor(private readonly maximum: number) {}

  consume(amount = 1): boolean {
    if (!Number.isSafeInteger(amount) || amount < 1) return false;
    const now = Date.now();
    if (now - this.startedAt >= RATE_WINDOW_MS) {
      this.startedAt = now;
      this.count = 0;
    }
    this.count += amount;
    return this.count <= this.maximum;
  }

  expired(now = Date.now()): boolean {
    return now - this.startedAt >= RATE_WINDOW_MS;
  }

  retryAfterMs(now = Date.now()): number {
    return Math.max(1, this.startedAt + RATE_WINDOW_MS - now);
  }
}

function normalizeRemoteAddress(value: string | undefined): string {
  if (!value) return "unknown";
  return value.startsWith("::ffff:") ? value.slice("::ffff:".length) : value;
}

export function resolveBoardSyncSourceIp(
  remoteAddressValue: string | undefined,
  realIpHeader: string | string[] | undefined,
  trustProxy: AppContext["config"]["trustProxy"],
): string {
  const remoteAddress = normalizeRemoteAddress(remoteAddressValue);
  const trustedProxy = typeof trustProxy === "string"
    ? normalizeRemoteAddress(trustProxy.trim())
    : "";
  if (
    isIP(remoteAddress) !== 0
    && isIP(trustedProxy) !== 0
    && remoteAddress === trustedProxy
    && typeof realIpHeader === "string"
  ) {
    const candidate = normalizeRemoteAddress(realIpHeader.trim());
    if (isIP(candidate) !== 0) return candidate;
  }
  return isIP(remoteAddress) === 0 ? "unknown" : remoteAddress;
}

function requestIpKey(
  request: IncomingMessage,
  trustProxy: AppContext["config"]["trustProxy"],
): string {
  return resolveBoardSyncSourceIp(
    request.socket.remoteAddress,
    request.headers["x-real-ip"],
    trustProxy,
  );
}

function incrementCount(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

function decrementCount(map: Map<string, number>, key: string): void {
  const next = (map.get(key) ?? 0) - 1;
  if (next > 0) map.set(key, next);
  else map.delete(key);
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength
    && left.every((byte, index) => byte === right[index]);
}

class ChunkReassembler {
  private readonly assemblies = new Map<string, ChunkAssembly>();
  private bufferedBytes = 0;

  push(frame: ChunkFrame): Uint8Array | null {
    const key = messageIdToHex(frame.messageId);
    let assembly = this.assemblies.get(key);
    if (!assembly) {
      if (this.assemblies.size >= MAX_ACTIVE_ASSEMBLIES) {
        throw new Error("Too many active chunk assemblies");
      }
      const timer = setTimeout(() => {
        const expired = this.assemblies.get(key);
        if (!expired) return;
        this.bufferedBytes -= expired.receivedBytes;
        this.assemblies.delete(key);
      }, CHUNK_TIMEOUT_MS);
      timer.unref();
      assembly = {
        innerType: frame.innerType,
        chunkCount: frame.chunkCount,
        totalLength: frame.totalLength,
        chunks: new Array<Uint8Array | undefined>(frame.chunkCount)
          .fill(undefined),
        receivedBytes: 0,
        timer,
      };
      this.assemblies.set(key, assembly);
    } else if (
      assembly.innerType !== frame.innerType
      || assembly.chunkCount !== frame.chunkCount
      || assembly.totalLength !== frame.totalLength
    ) {
      throw new Error("Chunk metadata changed during reassembly");
    }

    const existing = assembly.chunks[frame.chunkIndex];
    if (existing) {
      if (!bytesEqual(existing, frame.payload)) {
        throw new Error("Duplicate chunk index contains different bytes");
      }
      return null;
    }

    const payload = frame.payload.slice();
    assembly.chunks[frame.chunkIndex] = payload;
    assembly.receivedBytes += payload.byteLength;
    this.bufferedBytes += payload.byteLength;
    if (
      assembly.receivedBytes > assembly.totalLength
      || this.bufferedBytes > MAX_BUFFERED_CHUNK_BYTES
    ) {
      throw new Error("Chunk assembly exceeds its declared resource limits");
    }
    if (assembly.chunks.some((chunk) => chunk === undefined)) return null;
    if (assembly.receivedBytes !== assembly.totalLength) {
      throw new Error("Reassembled frame length does not match totalLength");
    }

    clearTimeout(assembly.timer);
    this.assemblies.delete(key);
    this.bufferedBytes -= assembly.receivedBytes;
    const result = new Uint8Array(assembly.totalLength);
    let offset = 0;
    for (const chunk of assembly.chunks) {
      result.set(chunk!, offset);
      offset += chunk!.byteLength;
    }
    const decoded = decodeBoardFrame(result);
    if (decoded.type !== assembly.innerType) {
      throw new Error("Reassembled frame type does not match CHUNK innerType");
    }
    return result;
  }

  clear(): void {
    for (const assembly of this.assemblies.values()) {
      clearTimeout(assembly.timer);
    }
    this.assemblies.clear();
    this.bufferedBytes = 0;
  }
}

function rawDataBytes(data: RawData): Uint8Array {
  if (Array.isArray(data)) return Uint8Array.from(Buffer.concat(data));
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}

function rejectUpgrade(
  socket: Duplex,
  status: number,
  reason: string,
): void {
  if (!socket.writable) {
    socket.destroy();
    return;
  }
  const body = `${reason}\n`;
  socket.end(
    `HTTP/1.1 ${status} ${reason}\r\n`
    + "Connection: close\r\n"
    + "Content-Type: text/plain; charset=utf-8\r\n"
    + "Cache-Control: no-store\r\n"
    + `Content-Length: ${Buffer.byteLength(body)}\r\n`
    + "\r\n"
    + body,
  );
}

function requestPath(request: IncomingMessage): URL | null {
  try {
    return new URL(request.url ?? "/", "http://eduri.invalid");
  } catch {
    return null;
  }
}

function controlPayload(value: Record<string, unknown>): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value));
}

function identityColor(userId: string): string {
  const index = createHash("sha256").update(userId).digest()[0]
    % IDENTITY_COLORS.length;
  return IDENTITY_COLORS[index];
}

function syncUpdateMessageId(
  access: BoardSyncAccess,
  documentKey: string,
  update: Uint8Array,
): Uint8Array {
  const digest = createHash("sha256")
    .update("eduri-board-v2-sync-step2\0")
    .update(access.boardId)
    .update("\0")
    .update(String(access.generation))
    .update("\0")
    .update(documentKey)
    .update("\0")
    .update(access.userId)
    .update("\0")
    .update(update)
    .digest();
  return Uint8Array.from(digest.subarray(0, 16));
}

function closeReason(error: BoardSyncServiceError): {
  code: BoardControlCode;
  closeCode: number;
  reason: string;
} {
  switch (error.code) {
    case "SESSION_REVOKED":
      return {
        code: BoardControlCode.SESSION_REVOKED,
        closeCode: CLOSE_UNAUTHORIZED,
        reason: "Session revoked",
      };
    case "READ_ONLY":
      return {
        code: BoardControlCode.PERMISSION_CHANGED,
        closeCode: CLOSE_FORBIDDEN,
        reason: "Board is read-only",
      };
    case "BOARD_GONE":
      return {
        code: BoardControlCode.BOARD_GONE,
        closeCode: CLOSE_GONE,
        reason: "Board gone",
      };
    case "STORAGE_ERROR":
      return {
        code: BoardControlCode.STORAGE_ERROR,
        closeCode: 1011,
        reason: "Storage unavailable",
      };
    case "TENANT_QUOTA":
    case "DISK_PRESSURE":
      return {
        code: BoardControlCode.STORAGE_ERROR,
        closeCode: 1013,
        reason: "Storage pressure",
      };
    case "INVALID_UPDATE":
      return {
        code: BoardControlCode.UPDATE_REJECTED,
        closeCode: CLOSE_PROTOCOL,
        reason: "Invalid update",
      };
    default:
      return {
        code: BoardControlCode.LIFECYCLE_CHANGED,
        closeCode: CLOSE_FORBIDDEN,
        reason: "Board access revoked",
      };
  }
}

export class BoardSyncTransport {
  private readonly wss: WebSocketServer;
  private readonly connections = new Set<BoardSocketConnection>();
  private readonly boardConnections = new Map<string, Set<BoardSocketConnection>>();
  private readonly ipConnectionCounts = new Map<string, number>();
  private readonly ipPendingAuthCounts = new Map<string, number>();
  private pendingAuthConnectionCount = 0;
  private readonly inboundFrameRatesByIp = new Map<string, FixedWindowRate>();
  private readonly inboundByteRatesByIp = new Map<string, FixedWindowRate>();
  private readonly updateRatesByPrincipal = new Map<string, FixedWindowRate>();
  private readonly updateByteRatesByPrincipal = new Map<string, FixedWindowRate>();
  private readonly awarenessRatesByPrincipal = new Map<string, FixedWindowRate>();
  private readonly awarenessByteRatesByPrincipal = new Map<string, FixedWindowRate>();
  private readonly issuedAwarenessIds = new Set<number>();
  private readonly awareness = new BoardAwarenessRegistry();
  private readonly previousDisconnectUserSockets: AppContext["disconnectUserSockets"];
  private readonly previousDisconnectSessionSockets: AppContext["disconnectSessionSockets"];
  private readonly previousRemoveLessonSocketMembership: AppContext["removeLessonSocketMembership"];
  private readonly previousEmitLessonStatus: AppContext["emitLessonStatus"];
  private readonly previousEmitBoardAssetReady: AppContext["emitBoardAssetReady"];
  private readonly sessionAuditTimer?: NodeJS.Timeout;
  private closed = false;

  private readonly upgradeHandler = (
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ): void => {
    const url = requestPath(request);
    if (!url || url.pathname !== BOARD_SYNC_WEBSOCKET_PATH) return;
    if (url.search) {
      rejectUpgrade(socket, 400, "Bad Request");
      return;
    }
    if (!this.service) {
      rejectUpgrade(socket, 404, "Not Found");
      return;
    }
    const origin = request.headers.origin;
    if (
      typeof origin !== "string"
      || !this.context.config.appOrigins.includes(origin)
    ) {
      rejectUpgrade(socket, 403, "Forbidden");
      return;
    }
    if (request.headers["sec-websocket-protocol"] !== BOARD_SUBPROTOCOL) {
      rejectUpgrade(socket, 426, "Upgrade Required");
      return;
    }
    const ipKey = requestIpKey(request, this.context.config.trustProxy);
    if (!this.canAdmitConnection(ipKey)) {
      rejectUpgrade(socket, 429, "Too Many Requests");
      return;
    }
    this.wss.handleUpgrade(request, socket, head, (ws) => {
      this.onConnection(ws, ipKey);
    });
  };

  constructor(
    private readonly httpServer: HttpServer,
    private readonly context: AppContext,
    private readonly service: BoardSyncService | undefined,
  ) {
    this.wss = new WebSocketServer({
      noServer: true,
      perMessageDeflate: false,
      maxPayload: BOARD_PROTOCOL_LIMITS.maxEncodedFrameBytes,
      clientTracking: false,
    });
    this.httpServer.on("upgrade", this.upgradeHandler);

    this.previousDisconnectUserSockets = context.disconnectUserSockets;
    this.previousDisconnectSessionSockets = context.disconnectSessionSockets;
    this.previousRemoveLessonSocketMembership =
      context.removeLessonSocketMembership;
    this.previousEmitLessonStatus = context.emitLessonStatus;
    this.previousEmitBoardAssetReady = context.emitBoardAssetReady;

    if (service) {
      this.installRevocationHooks();
      this.sessionAuditTimer = setInterval(
        () => this.auditConnections(),
        context.config.boardV2SessionAuditIntervalMs,
      );
      this.sessionAuditTimer.unref();
    }
  }

  private canAdmitConnection(ipKey: string): boolean {
    return !this.closed
      && this.connections.size < BOARD_SYNC_ADMISSION_LIMITS.maxConnections
      && (this.ipConnectionCounts.get(ipKey) ?? 0)
        < BOARD_SYNC_ADMISSION_LIMITS.maxConnectionsPerIp
      && this.pendingAuthConnectionCount
        < BOARD_SYNC_ADMISSION_LIMITS.maxPendingAuthConnections
      && (this.ipPendingAuthCounts.get(ipKey) ?? 0)
        < BOARD_SYNC_ADMISSION_LIMITS.maxPendingAuthConnectionsPerIp;
  }

  private releasePendingAdmission(connection: BoardSocketConnection): void {
    if (!connection.pendingAuth) return;
    connection.pendingAuth = false;
    decrementCount(this.ipPendingAuthCounts, connection.ipKey);
    this.pendingAuthConnectionCount = Math.max(
      0,
      this.pendingAuthConnectionCount - 1,
    );
  }

  private releaseConnectionAdmission(connection: BoardSocketConnection): void {
    this.releasePendingAdmission(connection);
    decrementCount(this.ipConnectionCounts, connection.ipKey);
  }

  private consumeKeyedRate(
    rates: Map<string, FixedWindowRate>,
    key: string,
    maximum: number,
    amount = 1,
  ): boolean {
    let rate = rates.get(key);
    if (!rate) {
      if (rates.size >= BOARD_SYNC_AGGREGATE_RATE_LIMITS.maxTrackedKeys) {
        const now = Date.now();
        for (const [candidateKey, candidateRate] of rates) {
          if (candidateRate.expired(now)) rates.delete(candidateKey);
        }
      }
      if (rates.size >= BOARD_SYNC_AGGREGATE_RATE_LIMITS.maxTrackedKeys) {
        return false;
      }
      rate = new FixedWindowRate(maximum);
      rates.set(key, rate);
    }
    return rate.consume(amount);
  }

  private rateLimitRetryAfterMs(connection: BoardSocketConnection): number {
    return Math.max(
      connection.frameRate.retryAfterMs(),
      connection.updateRate.retryAfterMs(),
      connection.awarenessRate.retryAfterMs(),
    );
  }

  private closeForRateLimit(
    connection: BoardSocketConnection,
    reason: string,
    messageId?: BoardMessageId,
  ): void {
    this.closeWithControl(
      connection,
      BoardControlCode.RATE_LIMITED,
      CLOSE_RATE_LIMITED,
      reason,
      messageId,
      reason,
      {
        reason: "RATE_LIMITED",
        retryable: true,
        retryAfterMs: this.rateLimitRetryAfterMs(connection),
      },
    );
  }

  private principalRateKey(connection: BoardSocketConnection): string {
    const access = connection.authenticated!.access;
    return access.role === "guest"
      ? `guest-board:${access.boardId}`
      : `user:${access.userId}`;
  }

  private consumeUpdateBudget(
    connection: BoardSocketConnection,
    updateBytes: number,
  ): boolean {
    const key = this.principalRateKey(connection);
    return this.consumeKeyedRate(
      this.updateRatesByPrincipal,
      key,
      BOARD_SYNC_AGGREGATE_RATE_LIMITS.updatesPerPrincipal,
    ) && this.consumeKeyedRate(
      this.updateByteRatesByPrincipal,
      key,
      BOARD_SYNC_AGGREGATE_RATE_LIMITS.updateBytesPerPrincipal,
      updateBytes,
    );
  }

  private consumeAwarenessBudget(
    connection: BoardSocketConnection,
    awarenessBytes: number,
  ): boolean {
    const key = this.principalRateKey(connection);
    return this.consumeKeyedRate(
      this.awarenessRatesByPrincipal,
      key,
      BOARD_SYNC_AGGREGATE_RATE_LIMITS.awarenessPerPrincipal,
    ) && this.consumeKeyedRate(
      this.awarenessByteRatesByPrincipal,
      key,
      BOARD_SYNC_AGGREGATE_RATE_LIMITS.awarenessBytesPerPrincipal,
      awarenessBytes,
    );
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.httpServer.off("upgrade", this.upgradeHandler);
    if (this.sessionAuditTimer) clearInterval(this.sessionAuditTimer);
    for (const connection of [...this.connections]) {
      connection.chunks.clear();
      clearTimeout(connection.authTimer);
      connection.ws.terminate();
    }
    this.connections.clear();
    this.boardConnections.clear();
    this.ipConnectionCounts.clear();
    this.ipPendingAuthCounts.clear();
    this.pendingAuthConnectionCount = 0;
    this.inboundFrameRatesByIp.clear();
    this.inboundByteRatesByIp.clear();
    this.updateRatesByPrincipal.clear();
    this.updateByteRatesByPrincipal.clear();
    this.awarenessRatesByPrincipal.clear();
    this.awarenessByteRatesByPrincipal.clear();
    this.awareness.clear();
    this.wss.close();
    this.restoreRevocationHooks();
    this.service?.close();
  }

  private onConnection(ws: WebSocket, ipKey: string): void {
    const connection: BoardSocketConnection = {
      ws,
      ipKey,
      pendingAuth: true,
      authTimer: setTimeout(() => {
        // An unauthenticated peer has not earned a graceful close handshake.
        // terminate() releases admission even if a raw peer deliberately never
        // acknowledges a WebSocket CLOSE frame.
        ws.terminate();
      }, AUTH_TIMEOUT_MS),
      subscribedDocs: new Set(),
      awaitingClientSyncDocs: new Set(),
      syncingDocs: new Set(),
      awarenessDocs: new Set(),
      chunks: new ChunkReassembler(),
      frameRate: new FixedWindowRate(2_000),
      updateRate: new FixedWindowRate(1_200),
      awarenessRate: new FixedWindowRate(600),
    };
    connection.authTimer.unref();
    this.connections.add(connection);
    incrementCount(this.ipConnectionCounts, ipKey);
    incrementCount(this.ipPendingAuthCounts, ipKey);
    this.pendingAuthConnectionCount += 1;

    ws.on("message", (data, isBinary) => {
      this.onMessage(connection, data, isBinary);
    });
    ws.on("close", () => this.onClose(connection));
    ws.on("error", () => {
      // The close handler performs all cleanup. Socket errors are not retried
      // server-side because clients retain their durable local outbox.
    });
  }

  private onMessage(
    connection: BoardSocketConnection,
    data: RawData,
    isBinary: boolean,
  ): void {
    if (!isBinary) {
      this.protocolFailure(connection, "Board sync accepts binary frames only");
      return;
    }
    let bytes: Uint8Array;
    try {
      bytes = rawDataBytes(data);
    } catch (error) {
      this.protocolFailure(
        connection,
        error instanceof Error ? error.message : "Invalid binary frame",
      );
      return;
    }
    if (
      !connection.frameRate.consume()
      || !this.consumeKeyedRate(
        this.inboundFrameRatesByIp,
        connection.ipKey,
        BOARD_SYNC_AGGREGATE_RATE_LIMITS.inboundFramesPerIp,
      )
      || !this.consumeKeyedRate(
        this.inboundByteRatesByIp,
        connection.ipKey,
        BOARD_SYNC_AGGREGATE_RATE_LIMITS.inboundBytesPerIp,
        bytes.byteLength,
      )
    ) {
      this.closeForRateLimit(
        connection,
        "Inbound Board sync budget exceeded",
      );
      return;
    }
    let frame: BoardFrame;
    try {
      frame = decodeBoardFrame(bytes);
    } catch (error) {
      this.protocolFailure(
        connection,
        error instanceof BoardProtocolError
          ? error.message
          : "Malformed binary frame",
      );
      return;
    }

    if (!connection.authenticated) {
      if (frame.type !== BoardMessageType.AUTH) {
        this.protocolFailure(connection, "AUTH must be the first frame");
        return;
      }
      this.authenticate(connection, frame);
      return;
    }
    if (frame.type === BoardMessageType.AUTH) {
      this.protocolFailure(connection, "AUTH cannot be repeated");
      return;
    }
    if (
      frame.type === BoardMessageType.UPDATE
      && bytes.byteLength > CHUNK_THRESHOLD_BYTES
    ) {
      this.protocolFailure(connection, "Large UPDATE frames must use CHUNK");
      return;
    }
    if (frame.type === BoardMessageType.CHUNK) {
      if (
        (connection.authenticated.capabilities & BoardCapability.CHUNKING) === 0
      ) {
        this.protocolFailure(connection, "CHUNK was not negotiated");
        return;
      }
      try {
        const reassembled = connection.chunks.push(frame);
        if (!reassembled) return;
        this.dispatchAuthenticated(
          connection,
          decodeBoardFrame(reassembled),
        );
      } catch (error) {
        this.protocolFailure(
          connection,
          error instanceof Error ? error.message : "Invalid CHUNK sequence",
        );
      }
      return;
    }
    this.dispatchAuthenticated(connection, frame);
  }

  private authenticate(
    connection: BoardSocketConnection,
    frame: Extract<BoardFrame, { type: BoardMessageType.AUTH }>,
  ): void {
    if (!this.service) {
      connection.ws.close(CLOSE_UNAUTHORIZED, "Board v2 disabled");
      return;
    }
    try {
      const authenticated = this.service.authenticate(frame);
      connection.authenticated = authenticated;
      connection.awarenessClientId = this.allocateAwarenessClientId();
      clearTimeout(connection.authTimer);
      this.releasePendingAdmission(connection);
      const boardSet = this.boardConnections.get(authenticated.access.boardId)
        ?? new Set();
      boardSet.add(connection);
      this.boardConnections.set(authenticated.access.boardId, boardSet);
      this.sendFrame(connection, {
        type: BoardMessageType.READY,
        generation: authenticated.access.generation,
        schemaVersion: authenticated.access.schemaVersion,
        capabilities: authenticated.capabilities,
        awarenessClientId: connection.awarenessClientId,
        permissions: authenticated.access.permissions,
      });
    } catch (error) {
      connection.ws.close(
        error instanceof BoardSyncServiceError
          && error.code === "INVALID_TICKET"
          ? CLOSE_UNAUTHORIZED
          : CLOSE_FORBIDDEN,
        "AUTH rejected",
      );
    }
  }

  private dispatchAuthenticated(
    connection: BoardSocketConnection,
    frame: BoardFrame,
  ): void {
    switch (frame.type) {
      case BoardMessageType.SYNC_STEP1:
        this.handleSyncStep1(connection, frame);
        return;
      case BoardMessageType.SYNC_STEP2:
        this.handleSyncStep2(connection, frame);
        return;
      case BoardMessageType.UPDATE:
        this.handleUpdate(connection, frame);
        return;
      case BoardMessageType.AWARENESS:
        this.handleAwareness(connection, frame);
        return;
      case BoardMessageType.CHUNK:
        this.protocolFailure(connection, "Nested CHUNK is not allowed");
        return;
      default:
        this.protocolFailure(
          connection,
          `${BoardMessageType[frame.type]} is not accepted from a client`,
        );
    }
  }

  private handleSyncStep1(
    connection: BoardSocketConnection,
    frame: Extract<BoardFrame, { type: BoardMessageType.SYNC_STEP1 }>,
  ): void {
    if (connection.syncingDocs.has(frame.docKey)) {
      this.protocolFailure(connection, "A document sync is already in progress");
      return;
    }
    // A fresh STEP1 restarts the document handshake. This is also how a
    // client switches from an oversized aggregate diff to durable history
    // materialization without leaving an old STEP2 authorization behind.
    connection.awaitingClientSyncDocs.delete(frame.docKey);
    connection.syncingDocs.add(frame.docKey);
    void this.performSyncStep1(connection, frame).finally(() => {
      connection.syncingDocs.delete(frame.docKey);
    });
  }

  private async performSyncStep1(
    connection: BoardSocketConnection,
    frame: Extract<BoardFrame, { type: BoardMessageType.SYNC_STEP1 }>,
  ): Promise<void> {
    try {
      const access = this.reauthorizeFrame(connection, frame.generation);
      const updates = this.service!.missingUpdates(
        access,
        frame.docKey,
        frame.stateVector,
      );
      connection.subscribedDocs.add(frame.docKey);
      for (const update of updates) {
        const sent = await this.sendFrameFlowControlled(connection, {
          type: BoardMessageType.SYNC_STEP2,
          generation: access.generation,
          docKey: frame.docKey,
          update,
        });
        if (!sent) return;
      }

      if (!await this.waitForSocketCapacity(connection)) return;
      const stateVector = this.service!.documentStateVector(
        access,
        frame.docKey,
      );
      connection.awaitingClientSyncDocs.add(frame.docKey);
      this.sendFrame(connection, {
        type: BoardMessageType.SYNC_STEP1,
        generation: access.generation,
        docKey: frame.docKey,
        stateVector,
      });
      if (connection.ws.readyState !== WebSocket.OPEN) return;

      const identity = this.service!.documentIdentity(
        access.boardId,
        access.generation,
        frame.docKey,
      );
      for (const awarenessUpdate of this.awareness.current(identity)) {
        const parsed = parseAwarenessUpdate(awarenessUpdate);
        this.sendFrame(connection, {
          type: BoardMessageType.AWARENESS,
          generation: access.generation,
          docKey: frame.docKey,
          awarenessClientId: parsed.clientId,
          update: awarenessUpdate,
        });
      }
    } catch (error) {
      this.serviceFailure(connection, error);
    }
  }

  private handleSyncStep2(
    connection: BoardSocketConnection,
    frame: Extract<BoardFrame, { type: BoardMessageType.SYNC_STEP2 }>,
  ): void {
    if (!connection.awaitingClientSyncDocs.delete(frame.docKey)) {
      this.protocolFailure(
        connection,
        "SYNC_STEP2 requires a preceding server SYNC_STEP1",
      );
      return;
    }
    if (
      !connection.updateRate.consume()
      || !this.consumeUpdateBudget(connection, frame.update.byteLength)
    ) {
      this.closeForRateLimit(connection, "Update rate exceeded");
      return;
    }

    const authenticated = connection.authenticated!;
    const messageId = syncUpdateMessageId(
      authenticated.access,
      frame.docKey,
      frame.update,
    );
    try {
      const access = this.reauthorizeFrame(
        connection,
        frame.generation,
        true,
      );
      const appended = this.service!.appendUpdate(
        access,
        access.userId,
        frame.docKey,
        messageIdToHex(messageId),
        frame.update,
      );
      if (!appended.duplicate) {
        this.broadcastDocument(connection, frame.docKey, {
          type: BoardMessageType.UPDATE,
          generation: access.generation,
          docKey: frame.docKey,
          messageId,
          update: frame.update,
        });
      }
    } catch (error) {
      if (
        error instanceof BoardSyncServiceError
        && error.code === "NO_NEW_INFORMATION"
      ) {
        return;
      }
      this.serviceFailure(connection, error, messageId);
    }
  }

  private handleUpdate(
    connection: BoardSocketConnection,
    frame: UpdateFrame,
  ): void {
    if (
      !connection.updateRate.consume()
      || !this.consumeUpdateBudget(connection, frame.update.byteLength)
    ) {
      this.closeForRateLimit(
        connection,
        "Update rate exceeded",
        frame.messageId,
      );
      return;
    }
    try {
      const access = this.reauthorizeFrame(
        connection,
        frame.generation,
        true,
      );
      const appended = this.service!.appendUpdate(
        access,
        // UPDATE has no client-controlled device identity. The authenticated
        // user ID is stable across reconnects, preserving message-id retries;
        // simultaneous devices remain distinct in ephemeral awareness.
        access.userId,
        frame.docKey,
        messageIdToHex(frame.messageId),
        frame.update,
      );
      connection.subscribedDocs.add(frame.docKey);

      // appendUpdate has committed and applied before either network action.
      this.broadcastDocument(connection, frame.docKey, frame);
      this.sendFrame(connection, {
        type: BoardMessageType.ACK,
        generation: access.generation,
        docKey: frame.docKey,
        messageId: frame.messageId,
        durableSequence: appended.seq,
      });
    } catch (error) {
      this.serviceFailure(connection, error, frame.messageId);
    }
  }

  private handleAwareness(
    connection: BoardSocketConnection,
    frame: AwarenessFrame,
  ): void {
    if (
      !connection.awarenessRate.consume()
      || !this.consumeAwarenessBudget(connection, frame.update.byteLength)
      || (connection.authenticated!.capabilities & BoardCapability.AWARENESS) === 0
    ) {
      this.closeForRateLimit(
        connection,
        "Awareness rate exceeded or capability missing",
      );
      return;
    }
    try {
      const access = this.reauthorizeFrame(connection, frame.generation);
      if (!connection.subscribedDocs.has(frame.docKey)) {
        throw new BoardAwarenessError(
          "SYNC_STEP1 is required before awareness for a document",
        );
      }
      if (frame.awarenessClientId !== connection.awarenessClientId) {
        throw new BoardAwarenessError(
          "Outer awareness client ID does not match READY",
        );
      }
      const identity: BoardAwarenessIdentity = {
        userId: access.userId,
        displayName: access.displayName,
        role: access.role,
        color: identityColor(access.userId),
      };
      const authorized = authorizeAwarenessUpdate(
        frame.update,
        connection.awarenessClientId!,
        identity,
      );
      const documentIdentity = this.service!.documentIdentity(
        access.boardId,
        access.generation,
        frame.docKey,
      );
      const accepted = this.awareness.accept(documentIdentity, authorized);
      if (!accepted) return;
      if (authorized.state === null) {
        connection.awarenessDocs.delete(frame.docKey);
      } else {
        connection.awarenessDocs.add(frame.docKey);
      }
      this.broadcastDocument(connection, frame.docKey, {
        ...frame,
        update: accepted,
      });
    } catch (error) {
      if (error instanceof BoardAwarenessError) {
        this.protocolFailure(connection, error.message);
        return;
      }
      this.serviceFailure(connection, error);
    }
  }

  private reauthorizeFrame(
    connection: BoardSocketConnection,
    generation: number,
    requireEdit = false,
  ): BoardSyncAccess {
    const authenticated = connection.authenticated!;
    if (generation !== authenticated.access.generation) {
      throw new BoardSyncServiceError(
        "ACCESS_REVOKED",
        "Frame generation does not match authenticated Board generation",
      );
    }
    const access = this.reauthorizeConnection(connection, requireEdit);
    return access;
  }

  private reauthorizeConnection(
    connection: BoardSocketConnection,
    requireEdit = false,
  ): BoardSyncAccess {
    const authenticated = connection.authenticated!;
    const access = this.service!.reauthorize({
      boardId: authenticated.access.boardId,
      generation: authenticated.access.generation,
      userId: authenticated.access.userId,
      sessionHash: authenticated.access.sessionHash,
    }, requireEdit);
    connection.authenticated = {
      ...authenticated,
      access,
    };
    return access;
  }

  private sendFrame(connection: BoardSocketConnection, frame: BoardFrame): void {
    if (connection.ws.readyState !== WebSocket.OPEN) return;
    const encoded = encodeBoardFrame(frame);
    if (
      encoded.byteLength <= CHUNK_THRESHOLD_BYTES
      || frame.type === BoardMessageType.CHUNK
    ) {
      this.sendEncoded(connection, encoded);
      return;
    }
    if (
      frame.type !== BoardMessageType.SYNC_STEP2
      && frame.type !== BoardMessageType.UPDATE
    ) {
      this.protocolFailure(connection, "Oversized frame cannot be chunked");
      return;
    }
    if (
      !connection.authenticated
      || (connection.authenticated.capabilities & BoardCapability.CHUNKING) === 0
    ) {
      this.protocolFailure(connection, "Peer did not negotiate CHUNKING");
      return;
    }

    const chunkCount = Math.ceil(
      encoded.byteLength / BOARD_PROTOCOL_LIMITS.maxChunkPayloadBytes,
    );
    if (chunkCount > BOARD_PROTOCOL_LIMITS.maxChunkCount) {
      this.protocolFailure(connection, "Logical frame requires too many chunks");
      return;
    }
    const chunkMessageId = new Uint8Array(randomBytes(16));
    for (let chunkIndex = 0; chunkIndex < chunkCount; chunkIndex += 1) {
      const start = chunkIndex * BOARD_PROTOCOL_LIMITS.maxChunkPayloadBytes;
      const end = Math.min(
        encoded.byteLength,
        start + BOARD_PROTOCOL_LIMITS.maxChunkPayloadBytes,
      );
      this.sendEncoded(
        connection,
        encodeBoardFrame({
          type: BoardMessageType.CHUNK,
          messageId: chunkMessageId,
          innerType: frame.type,
          chunkIndex,
          chunkCount,
          totalLength: encoded.byteLength,
          payload: encoded.subarray(start, end),
        }),
      );
    }
  }

  private async sendFrameFlowControlled(
    connection: BoardSocketConnection,
    frame: BoardFrame,
  ): Promise<boolean> {
    if (connection.ws.readyState !== WebSocket.OPEN) return false;
    const encoded = encodeBoardFrame(frame);
    if (
      encoded.byteLength <= CHUNK_THRESHOLD_BYTES
      || frame.type === BoardMessageType.CHUNK
    ) {
      if (!await this.waitForSocketCapacity(connection)) return false;
      this.sendEncodedWithoutLimit(connection, encoded);
      return connection.ws.readyState === WebSocket.OPEN;
    }
    if (
      frame.type !== BoardMessageType.SYNC_STEP2
      && frame.type !== BoardMessageType.UPDATE
    ) {
      this.protocolFailure(connection, "Oversized frame cannot be chunked");
      return false;
    }
    if (
      !connection.authenticated
      || (connection.authenticated.capabilities & BoardCapability.CHUNKING) === 0
    ) {
      this.protocolFailure(connection, "Peer did not negotiate CHUNKING");
      return false;
    }

    const chunkCount = Math.ceil(
      encoded.byteLength / BOARD_PROTOCOL_LIMITS.maxChunkPayloadBytes,
    );
    if (chunkCount > BOARD_PROTOCOL_LIMITS.maxChunkCount) {
      this.protocolFailure(connection, "Logical frame requires too many chunks");
      return false;
    }
    const chunkMessageId = new Uint8Array(randomBytes(16));
    for (let chunkIndex = 0; chunkIndex < chunkCount; chunkIndex += 1) {
      if (!await this.waitForSocketCapacity(connection)) return false;
      const start = chunkIndex * BOARD_PROTOCOL_LIMITS.maxChunkPayloadBytes;
      const end = Math.min(
        encoded.byteLength,
        start + BOARD_PROTOCOL_LIMITS.maxChunkPayloadBytes,
      );
      this.sendEncodedWithoutLimit(
        connection,
        encodeBoardFrame({
          type: BoardMessageType.CHUNK,
          messageId: chunkMessageId,
          innerType: frame.type,
          chunkIndex,
          chunkCount,
          totalLength: encoded.byteLength,
          payload: encoded.subarray(start, end),
        }),
      );
    }
    return connection.ws.readyState === WebSocket.OPEN;
  }

  private async waitForSocketCapacity(
    connection: BoardSocketConnection,
  ): Promise<boolean> {
    const startedAt = Date.now();
    while (
      connection.ws.readyState === WebSocket.OPEN
      && connection.ws.bufferedAmount > SYNC_SOCKET_RESUME_BYTES
    ) {
      if (Date.now() - startedAt >= SYNC_SOCKET_DRAIN_TIMEOUT_MS) {
        connection.ws.close(1013, "Peer is not consuming Board sync");
        return false;
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, SYNC_SOCKET_DRAIN_POLL_MS);
        timer.unref?.();
      });
    }
    return connection.ws.readyState === WebSocket.OPEN;
  }

  private sendEncoded(
    connection: BoardSocketConnection,
    encoded: Uint8Array,
  ): void {
    if (connection.ws.readyState !== WebSocket.OPEN) return;
    if (connection.ws.bufferedAmount > MAX_SOCKET_BUFFERED_BYTES) {
      connection.ws.close(1013, "Peer is not consuming Board updates");
      return;
    }
    this.sendEncodedWithoutLimit(connection, encoded);
  }

  private sendEncodedWithoutLimit(
    connection: BoardSocketConnection,
    encoded: Uint8Array,
  ): void {
    if (connection.ws.readyState !== WebSocket.OPEN) return;
    connection.ws.send(encoded, { binary: true });
  }

  private broadcastDocument(
    sender: BoardSocketConnection,
    docKey: string,
    frame: UpdateFrame | AwarenessFrame,
  ): void {
    const boardId = sender.authenticated!.access.boardId;
    for (const peer of this.boardConnections.get(boardId) ?? []) {
      if (
        peer === sender
        || !peer.subscribedDocs.has(docKey)
        || peer.ws.readyState !== WebSocket.OPEN
      ) {
        continue;
      }
      if (!this.authorizeOutbound(peer)) continue;
      this.sendFrame(peer, frame);
    }
  }

  private serviceFailure(
    connection: BoardSocketConnection,
    error: unknown,
    messageId?: BoardMessageId,
  ): void {
    if (!(error instanceof BoardSyncServiceError)) {
      this.closeWithControl(
        connection,
        BoardControlCode.SERVER_ERROR,
        1011,
        "Board sync failed",
        messageId,
      );
      return;
    }
    if (
      (
        error.code === "CAUSAL_GAP"
        || error.code === "NO_NEW_INFORMATION"
      )
      && connection.authenticated
      && connection.ws.readyState === WebSocket.OPEN
    ) {
      this.sendFrame(connection, {
        type: BoardMessageType.CONTROL,
        generation: connection.authenticated.access.generation,
        code: BoardControlCode.RESYNC_REQUIRED,
        ...(messageId ? { messageId } : {}),
        payload: controlPayload({
          error: error.message,
          reason: error.code,
          retryable: true,
        }),
      });
      return;
    }
    const mapped = closeReason(error);
    const retryableStoragePressure =
      error.code === "TENANT_QUOTA"
      || error.code === "DISK_PRESSURE";
    this.closeWithControl(
      connection,
      mapped.code,
      mapped.closeCode,
      mapped.reason,
      messageId,
      error.message,
      {
        reason: error.code,
        retryable: retryableStoragePressure,
        ...(retryableStoragePressure
          ? { retryAfterMs: STORAGE_PRESSURE_RETRY_AFTER_MS }
          : {}),
      },
    );
  }

  private protocolFailure(
    connection: BoardSocketConnection,
    detail: string,
  ): void {
    if (connection.authenticated) {
      this.closeWithControl(
        connection,
        BoardControlCode.SERVER_ERROR,
        CLOSE_PROTOCOL,
        "Protocol error",
        undefined,
        detail,
      );
    } else {
      connection.ws.close(CLOSE_PROTOCOL, "Protocol error");
    }
  }

  private closeWithControl(
    connection: BoardSocketConnection,
    code: BoardControlCode,
    closeCode: number,
    reason: string,
    messageId?: BoardMessageId,
    detail = reason,
    metadata: Record<string, unknown> = {},
  ): void {
    if (
      connection.authenticated
      && connection.ws.readyState === WebSocket.OPEN
    ) {
      const frame: ControlFrame = {
        type: BoardMessageType.CONTROL,
        generation: connection.authenticated.access.generation,
        code,
        ...(messageId ? { messageId } : {}),
        payload: controlPayload({ error: detail, ...metadata }),
      };
      this.sendFrame(connection, frame);
    }
    if (
      connection.ws.readyState === WebSocket.OPEN
      || connection.ws.readyState === WebSocket.CONNECTING
    ) {
      connection.ws.close(closeCode, reason.slice(0, 120));
    }
  }

  private onClose(connection: BoardSocketConnection): void {
    if (!this.connections.delete(connection)) return;
    this.releaseConnectionAdmission(connection);
    clearTimeout(connection.authTimer);
    connection.chunks.clear();
    const authenticated = connection.authenticated;
    if (connection.awarenessClientId !== undefined) {
      this.issuedAwarenessIds.delete(connection.awarenessClientId);
    }
    if (!authenticated) return;
    const boardSet = this.boardConnections.get(authenticated.access.boardId);
    boardSet?.delete(connection);
    if (boardSet?.size === 0) {
      this.boardConnections.delete(authenticated.access.boardId);
    }
    for (const docKey of connection.awarenessDocs) {
      const identity = this.service!.documentIdentity(
        authenticated.access.boardId,
        authenticated.access.generation,
        docKey,
      );
      const removal = this.awareness.remove(
        identity,
        connection.awarenessClientId!,
      );
      if (!removal) continue;
      const removalFrame: AwarenessFrame = {
        type: BoardMessageType.AWARENESS,
        generation: authenticated.access.generation,
        docKey,
        awarenessClientId: connection.awarenessClientId!,
        update: removal,
      };
      for (const peer of boardSet ?? []) {
        if (
          peer.subscribedDocs.has(docKey)
          && this.authorizeOutbound(peer)
        ) {
          this.sendFrame(peer, removalFrame);
        }
      }
    }
  }

  private allocateAwarenessClientId(): number {
    for (;;) {
      const id = randomBytes(4).readUInt32BE(0);
      if (id === 0 || this.issuedAwarenessIds.has(id)) continue;
      this.issuedAwarenessIds.add(id);
      return id;
    }
  }

  private installRevocationHooks(): void {
    this.context.emitBoardAssetReady = async (event) => {
      try {
        await this.previousEmitBoardAssetReady?.(event);
      } finally {
        this.broadcastAssetReady(event);
      }
    };
    this.context.disconnectUserSockets = (userId) => {
      this.previousDisconnectUserSockets?.(userId);
      this.disconnectMatching(
        (connection) =>
          connection.authenticated?.access.userId === userId,
        BoardControlCode.SESSION_REVOKED,
        "User access revoked",
      );
    };
    this.context.disconnectSessionSockets = (sessionHash) => {
      this.previousDisconnectSessionSockets?.(sessionHash);
      this.disconnectMatching(
        (connection) =>
          connection.authenticated?.access.sessionHash === sessionHash,
        BoardControlCode.SESSION_REVOKED,
        "Session revoked",
      );
    };
    this.context.removeLessonSocketMembership = (lessonId, userId) => {
      this.previousRemoveLessonSocketMembership?.(lessonId, userId);
      this.disconnectMatching(
        (connection) => {
          const access = connection.authenticated?.access;
          return access?.lessonId === lessonId
            && (!userId || access.userId === userId);
        },
        BoardControlCode.LIFECYCLE_CHANGED,
        "Lesson membership changed",
      );
    };
    this.context.emitLessonStatus = (
      lessonId: string,
      status: LessonStatus,
    ) => {
      this.previousEmitLessonStatus?.(lessonId, status);
      if (status !== "completed" && status !== "cancelled") return;
      this.disconnectMatching(
        (connection) =>
          connection.authenticated?.access.lessonId === lessonId,
        BoardControlCode.PERMISSION_CHANGED,
        "Lesson became read-only",
      );
    };
  }

  private broadcastAssetReady(event: AssetReadyEvent): void {
    const payload = controlPayload({
      assetId: event.assetId,
      sha256: event.sha256,
      mimeType: event.mimeType,
      byteSize: event.byteSize,
      width: event.width,
      height: event.height,
      frameCount: event.frameCount,
      totalDecodedPixels: event.totalDecodedPixels,
      publishedAt: event.publishedAt,
    });
    for (const connection of this.boardConnections.get(event.boardId) ?? []) {
      if (
        connection.authenticated?.access.generation !== event.generation
        || connection.ws.readyState !== WebSocket.OPEN
      ) {
        continue;
      }
      if (!this.authorizeOutbound(connection)) continue;
      this.sendFrame(connection, {
        type: BoardMessageType.CONTROL,
        generation: event.generation,
        code: BoardControlCode.ASSET_READY,
        payload,
      });
    }
  }

  private restoreRevocationHooks(): void {
    this.context.disconnectUserSockets = this.previousDisconnectUserSockets;
    this.context.disconnectSessionSockets =
      this.previousDisconnectSessionSockets;
    this.context.removeLessonSocketMembership =
      this.previousRemoveLessonSocketMembership;
    this.context.emitLessonStatus = this.previousEmitLessonStatus;
    this.context.emitBoardAssetReady = this.previousEmitBoardAssetReady;
  }

  private disconnectMatching(
    predicate: (connection: BoardSocketConnection) => boolean,
    code: BoardControlCode,
    reason: string,
  ): void {
    for (const connection of this.connections) {
      if (!predicate(connection)) continue;
      this.closeWithControl(
        connection,
        code,
        CLOSE_FORBIDDEN,
        reason,
      );
    }
  }

  private authorizeOutbound(
    connection: BoardSocketConnection,
  ): boolean {
    try {
      this.reauthorizeConnection(connection);
      return true;
    } catch (error) {
      this.serviceFailure(connection, error);
      return false;
    }
  }

  private auditConnections(): void {
    for (const connection of this.connections) {
      if (
        !connection.authenticated
        || connection.ws.readyState !== WebSocket.OPEN
      ) {
        continue;
      }
      const previousPermissions =
        connection.authenticated.access.permissions;
      if (!this.authorizeOutbound(connection)) continue;
      if (
        previousPermissions !== connection.authenticated.access.permissions
      ) {
        this.closeWithControl(
          connection,
          BoardControlCode.PERMISSION_CHANGED,
          CLOSE_FORBIDDEN,
          "Board permissions changed",
        );
      }
    }
  }
}

export function attachBoardV2Sync(
  httpServer: HttpServer,
  context: AppContext,
): BoardSyncTransport {
  return new BoardSyncTransport(
    httpServer,
    context,
    context.boardV2Sync,
  );
}

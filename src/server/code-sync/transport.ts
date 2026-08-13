import type { Namespace, Server as SocketIOServer, Socket } from "socket.io";
import {
  CODE_SYNC_CAPABILITIES,
  CODE_SYNC_MESSAGE_EVENT,
  CODE_SYNC_NAMESPACE,
  CODE_SYNC_PROTOCOL_VERSION,
  CODE_SYNC_TAGS,
  CODE_SYNC_UPDATE_ENCODING,
  CodeProtocolError,
  parseCodeSyncClientMessage,
  parseCodeSyncHandshakeAuth,
  toLegacyCodeAwarenessState,
  type CodeAwarenessState,
  type CodeParticipantIdentity,
  type CodeSyncControlCode,
  type CodeSyncControlMessage,
  type CodeSyncServerMessage,
} from "../../code/protocol/index.js";
import {
  CodeSyncService,
  CodeSyncServiceError,
  type AuthenticatedCodeSync,
} from "./service.js";
import {
  attachSocketWireIngress,
  getOrCreateSocketIngressGuard,
  type SocketTrafficLimits,
} from "../socketAbuse.js";
import { attachCodeTerminalTransport } from "./terminalTransport.js";

type MessageAck = (message: CodeSyncServerMessage) => void;

interface AwarenessEntry {
  readonly participant: CodeParticipantIdentity;
  readonly state: CodeAwarenessState;
}

interface ConnectionData {
  session: AuthenticatedCodeSync;
  multiSelectionAwareness: boolean;
  awarenessReplaySent: boolean;
}

export interface CodeSyncTransportOptions {
  readonly awarenessPerMinute?: number;
  readonly syncPerMinute?: number;
  readonly updatesPerMinute?: number;
  readonly updateBytesPerMinute?: number;
  readonly maxAwarenessPeers?: number;
  readonly maxRateScopes?: number;
  readonly rateScopeIdleMs?: number;
  readonly ingressEventsPerMinute?: number;
  readonly ingressBytesPerMinute?: number;
  readonly ingressEventsPerIpPerMinute?: number;
  readonly ingressBytesPerIpPerMinute?: number;
  readonly ingressEventsGlobalPerMinute?: number;
  readonly ingressBytesGlobalPerMinute?: number;
  readonly maxIngressIpScopes?: number;
  readonly maxIngressPrincipalScopes?: number;
  readonly ingressScopeIdleMs?: number;
  readonly trustedProxy?: boolean | number | string;
  readonly now?: () => number;
  readonly allowedOrigins?: readonly string[];
}

class FixedWindowRate {
  private count = 0;

  constructor(
    private readonly maximum: number,
    private windowStartedAt: number,
  ) {}

  consume(amount: number, now: number): boolean {
    if (now < this.windowStartedAt || now - this.windowStartedAt >= 60_000) {
      this.windowStartedAt = now;
      this.count = 0;
    }
    const allowed = amount <= this.maximum - this.count;
    this.count = Math.min(this.maximum, this.count + amount);
    return allowed;
  }
}

type EventRateName = "awareness" | "sync";

interface CodeRateScope {
  readonly awareness: FixedWindowRate;
  readonly sync: FixedWindowRate;
  readonly updates: FixedWindowRate;
  readonly updateBytes: FixedWindowRate;
  lastSeenAt: number;
}

class AggregateCodeRateScopes {
  private readonly scopes = new Map<string, CodeRateScope>();
  private nextSweepAt: number;

  constructor(
    private readonly limits: {
      readonly awareness: number;
      readonly sync: number;
      readonly updates: number;
      readonly updateBytes: number;
    },
    private readonly maximumScopes: number,
    private readonly idleMs: number,
    private readonly now: () => number,
  ) {
    this.nextSweepAt = now() + 60_000;
  }

  consumeEvent(scopeId: string, rateName: EventRateName): boolean {
    const now = this.now();
    const scope = this.scope(scopeId, now);
    return scope?.[rateName].consume(1, now) ?? false;
  }

  consumeUpdate(scopeId: string, bytes: number): boolean {
    const now = this.now();
    const scope = this.scope(scopeId, now);
    if (!scope) return false;
    // Count both dimensions even when one has already reached its boundary.
    // The server has already received the frame, so rejected traffic must not
    // become free traffic in the other dimension.
    const eventAllowed = scope.updates.consume(1, now);
    const bytesAllowed = scope.updateBytes.consume(bytes, now);
    return eventAllowed && bytesAllowed;
  }

  private scope(scopeId: string, now: number): CodeRateScope | undefined {
    this.sweep(now, false);
    const current = this.scopes.get(scopeId);
    if (current) {
      current.lastSeenAt = now;
      return current;
    }
    if (this.scopes.size >= this.maximumScopes) {
      this.sweep(now, true);
      if (this.scopes.size >= this.maximumScopes) return undefined;
    }
    const created: CodeRateScope = {
      awareness: new FixedWindowRate(this.limits.awareness, now),
      sync: new FixedWindowRate(this.limits.sync, now),
      updates: new FixedWindowRate(this.limits.updates, now),
      updateBytes: new FixedWindowRate(this.limits.updateBytes, now),
      lastSeenAt: now,
    };
    this.scopes.set(scopeId, created);
    return created;
  }

  private sweep(now: number, force: boolean): void {
    if (!force && now < this.nextSweepAt) return;
    for (const [scopeId, scope] of this.scopes) {
      if (now < scope.lastSeenAt || now - scope.lastSeenAt >= this.idleMs) {
        this.scopes.delete(scopeId);
      }
    }
    this.nextSweepAt = now + 60_000;
  }
}

function roomName(workspaceId: string): string {
  return `code-sync:${workspaceId}`;
}

function controlFor(error: unknown, requestId?: string): CodeSyncControlMessage {
  let code: CodeSyncControlCode = "storage-error";
  let message = "Code sync failed";
  let terminal = true;
  if (error instanceof CodeProtocolError) {
    code = "invalid-message";
    message = error.message;
    terminal = false;
  } else if (error instanceof CodeSyncServiceError) {
    if (error.code === "EXPIRED") code = "expired";
    else if (error.code === "NOT_FOUND") code = "not-found";
    else if (error.code === "INVALID_UPDATE") code = "invalid-update";
    else code = "storage-error";
    message = error.message;
    terminal = error.code === "EXPIRED"
      || error.code === "NOT_FOUND"
      || error.code === "STORAGE_ERROR";
  }
  return {
    type: CODE_SYNC_TAGS.control,
    protocolVersion: CODE_SYNC_PROTOCOL_VERSION,
    code,
    message,
    terminal,
    ...(requestId ? { requestId } : {}),
  };
}

function send(
  socket: Socket,
  message: CodeSyncServerMessage,
  ack?: MessageAck,
): void {
  socket.emit(CODE_SYNC_MESSAGE_EVENT, message);
  if (typeof ack === "function") ack(message);
}

function connectionData(socket: Socket): ConnectionData {
  return socket.data.codeSync as ConnectionData;
}

export function attachCodeSyncNamespace(
  io: SocketIOServer,
  service: CodeSyncService,
  options: CodeSyncTransportOptions = {},
): Namespace {
  // Two ordinary collaborators can each emit at the client's 120 ms cadence
  // without exhausting the shared workspace budget.
  const awarenessPerMinute = options.awarenessPerMinute ?? 1_200;
  const syncPerMinute = options.syncPerMinute ?? 120;
  const updatesPerMinute = options.updatesPerMinute ?? 1_200;
  const updateBytesPerMinute = options.updateBytesPerMinute ?? 16 * 1024 * 1024;
  const maxAwarenessPeers = options.maxAwarenessPeers ?? 128;
  const now = options.now ?? (() => Date.now());
  const rateScopes = new AggregateCodeRateScopes(
    {
      awareness: awarenessPerMinute,
      sync: syncPerMinute,
      updates: updatesPerMinute,
      updateBytes: updateBytesPerMinute,
    },
    Math.max(1, Math.trunc(options.maxRateScopes ?? 10_000)),
    Math.max(60_000, options.rateScopeIdleMs ?? 120_000),
    now,
  );
  const ingress = getOrCreateSocketIngressGuard(io, {
    global: {
      eventsPerMinute: Math.max(
        1,
        Math.trunc(options.ingressEventsGlobalPerMinute ?? 100_000),
      ),
      bytesPerMinute: Math.max(
        1,
        Math.trunc(options.ingressBytesGlobalPerMinute ?? 1024 * 1024 * 1024),
      ),
    },
    ip: {
      eventsPerMinute: Math.max(
        1,
        Math.trunc(options.ingressEventsPerIpPerMinute ?? 10_000),
      ),
      bytesPerMinute: Math.max(
        1,
        Math.trunc(options.ingressBytesPerIpPerMinute ?? 256 * 1024 * 1024),
      ),
    },
    maxIpScopes: Math.max(1, Math.trunc(options.maxIngressIpScopes ?? 4_096)),
    maxPrincipalScopes: Math.max(
      1,
      Math.trunc(options.maxIngressPrincipalScopes ?? 10_000),
    ),
    scopeIdleMs: Math.max(60_000, options.ingressScopeIdleMs ?? 120_000),
    now,
  });
  const codeIngressLimits: SocketTrafficLimits = {
    eventsPerMinute: Math.max(
      1,
      Math.trunc(options.ingressEventsPerMinute ?? 4_000),
    ),
    bytesPerMinute: Math.max(
      1,
      Math.trunc(options.ingressBytesPerMinute ?? 64 * 1024 * 1024),
    ),
  };
  const allowedOrigins = new Set((options.allowedOrigins ?? []).map((origin) => (
    origin.replace(/\/$/u, "")
  )));
  const awareness = new Map<string, Map<string, AwarenessEntry>>();
  const namespace = io.of(CODE_SYNC_NAMESPACE);
  const isWireIngressBlocked = attachSocketWireIngress(
    io,
    ingress,
    options.trustedProxy,
  );

  const reauthorizeSocket = (
    socket: Socket,
    disconnectOnFailure = true,
  ): boolean => {
    try {
      service.reauthorize(connectionData(socket).session);
      return true;
    } catch (error) {
      send(socket, controlFor(error));
      if (disconnectOnFailure) socket.disconnect(true);
      return false;
    }
  };

  const emitAuthorized = (
    socketId: string,
    event: string,
    payload: unknown,
  ): boolean => {
    const target = namespace.sockets.get(socketId);
    if (!target || !reauthorizeSocket(target)) return false;
    target.emit(event, payload);
    return true;
  };

  const broadcastAuthorized = (
    workspaceId: string,
    event: string,
    payload: unknown,
    excludeSocketId?: string,
  ): void => {
    // Copy the room before reauthorization: rejecting one target disconnects
    // it synchronously and mutates the adapter membership set.
    const socketIds = [
      ...(namespace.adapter.rooms.get(roomName(workspaceId)) ?? []),
    ];
    const authorized: Socket[] = [];
    const revoked: Socket[] = [];
    for (const socketId of socketIds) {
      if (socketId === excludeSocketId) continue;
      const target = namespace.sockets.get(socketId);
      if (!target) continue;
      if (reauthorizeSocket(target, false)) authorized.push(target);
      else revoked.push(target);
    }
    // Emit the older state transition before disconnecting a revoked terminal
    // host. Its disconnect may synchronously produce a newer lease-release
    // delta, and reversing those two packets would create a sequence gap.
    for (const target of authorized) target.emit(event, payload);
    for (const target of revoked) target.disconnect(true);
  };

  const awarenessStateFor = (
    socket: Socket,
    state: CodeAwarenessState | null,
  ) => state === null || connectionData(socket).multiSelectionAwareness
    ? state
    : toLegacyCodeAwarenessState(state);

  const sendAwareness = (
    socket: Socket,
    participant: CodeParticipantIdentity,
    state: CodeAwarenessState | null,
  ): void => {
    send(socket, {
      type: CODE_SYNC_TAGS.awareness,
      protocolVersion: CODE_SYNC_PROTOCOL_VERSION,
      participant,
      state: awarenessStateFor(socket, state),
    });
  };

  const replayAwarenessOnce = (socket: Socket): void => {
    const data = connectionData(socket);
    if (data.awarenessReplaySent) return;
    data.awarenessReplaySent = true;
    const currentAwareness = awareness.get(data.session.workspaceId);
    if (!currentAwareness || currentAwareness.size === 0) return;
    if (!reauthorizeSocket(socket)) return;
    for (const current of currentAwareness.values()) {
      sendAwareness(socket, current.participant, current.state);
    }
  };

  const broadcastAwareness = (
    workspaceId: string,
    participant: CodeParticipantIdentity,
    state: CodeAwarenessState | null,
    excludeSocketId?: string,
  ): void => {
    for (const socketId of namespace.adapter.rooms.get(roomName(workspaceId)) ?? []) {
      if (socketId === excludeSocketId) continue;
      const target = namespace.sockets.get(socketId);
      if (!target || !reauthorizeSocket(target)) continue;
      if (connectionData(target).awarenessReplaySent) {
        sendAwareness(target, participant, state);
      }
    }
  };

  namespace.use((socket, next) => {
    if (isWireIngressBlocked(socket)) {
      const failure = new Error("Code sync ingress rate limit reached") as Error & {
        data?: CodeSyncControlMessage;
      };
      failure.data = {
        type: CODE_SYNC_TAGS.control,
        protocolVersion: CODE_SYNC_PROTOCOL_VERSION,
        code: "rate-limited",
        message: "Code sync ingress rate limit exceeded",
        terminal: false,
      };
      next(failure);
      return;
    }
    try {
      const origin = socket.handshake.headers.origin?.replace(/\/$/u, "");
      if (!origin || !allowedOrigins.has(origin)) {
        throw new CodeProtocolError("Code sync Origin is not allowed");
      }
      const auth = parseCodeSyncHandshakeAuth(socket.handshake.auth);
      const session = service.authenticate(auth);
      socket.data.codeSync = {
        session,
        multiSelectionAwareness: false,
        awarenessReplaySent: false,
      } satisfies ConnectionData;
      next();
    } catch (error) {
      const failure = new Error("Code sync authorization failed") as Error & {
        data?: CodeSyncControlMessage;
      };
      failure.data = controlFor(error);
      next(failure);
    }
  });

  namespace.on("connection", (socket) => {
    const data = connectionData(socket);
    const { session } = data;
    const workspaceRoom = roomName(session.workspaceId);
    socket.use((packet, next) => {
      const principalDecision = ingress.consumePrincipal(
        `code-workspace:${session.workspaceId}`,
        codeIngressLimits,
        packet,
      );
      const decision = isWireIngressBlocked(socket)
        ? {
          allowed: false,
          retryAfterMs: Math.max(60_000, principalDecision.retryAfterMs),
        }
        : principalDecision;
      if (decision.allowed) {
        next();
        return;
      }
      const ack = typeof packet.at(-1) === "function"
        ? packet.at(-1) as MessageAck
        : undefined;
      send(socket, {
        type: CODE_SYNC_TAGS.control,
        protocolVersion: CODE_SYNC_PROTOCOL_VERSION,
        code: "rate-limited",
        message: "Code sync ingress rate limit exceeded",
        terminal: false,
      }, ack);
      if (!socket.data.codeIngressDisconnectScheduled) {
        socket.data.codeIngressDisconnectScheduled = true;
        const timer = setTimeout(() => socket.disconnect(true), 0);
        timer.unref();
      }
    });
    void socket.join(workspaceRoom);
    send(socket, {
      type: CODE_SYNC_TAGS.ready,
      protocolVersion: CODE_SYNC_PROTOCOL_VERSION,
      workspaceId: session.workspaceId,
      documentId: session.documentId,
      deviceId: session.deviceId,
      participant: session.participant,
      updateEncoding: CODE_SYNC_UPDATE_ENCODING,
      capabilities: [CODE_SYNC_CAPABILITIES.multiSelectionAwareness],
    });

    socket.on(CODE_SYNC_MESSAGE_EVENT, (
      raw: unknown,
      ack?: MessageAck,
    ) => {
      let requestId: string | undefined;
      try {
        const message = parseCodeSyncClientMessage(raw);
        if (message.type === CODE_SYNC_TAGS.capabilities) {
          data.multiSelectionAwareness = true;
          replayAwarenessOnce(socket);
          return;
        }
        replayAwarenessOnce(socket);
        if (message.type === CODE_SYNC_TAGS.syncStep1) {
          requestId = message.requestId;
          if (!rateScopes.consumeEvent(session.workspaceId, "sync")) {
            send(socket, {
              type: CODE_SYNC_TAGS.control,
              protocolVersion: CODE_SYNC_PROTOCOL_VERSION,
              code: "rate-limited",
              message: "Code sync request rate limit exceeded",
              terminal: false,
              requestId,
            }, ack);
            return;
          }
          const state = service.syncStep1(session, message.stateVector);
          state.updates.forEach((update, part) => {
            const done = part === state.updates.length - 1;
            send(socket, {
              type: CODE_SYNC_TAGS.syncStep2,
              protocolVersion: CODE_SYNC_PROTOCOL_VERSION,
              requestId: message.requestId,
              part,
              done,
              updateEncoding: CODE_SYNC_UPDATE_ENCODING,
              update,
              stateVector: state.stateVector,
              sequence: state.sequence,
            }, done ? ack : undefined);
          });
          return;
        }
        if (message.type === CODE_SYNC_TAGS.update) {
          requestId = message.requestId;
          if (!rateScopes.consumeUpdate(
            session.workspaceId,
            message.update.byteLength,
          )) {
            send(socket, {
              type: CODE_SYNC_TAGS.control,
              protocolVersion: CODE_SYNC_PROTOCOL_VERSION,
              code: "rate-limited",
              message: "Code update rate limit exceeded",
              terminal: false,
              requestId,
            }, ack);
            return;
          }
          const result = service.appendUpdate(
            session,
            message.updateId,
            message.update,
          );
          send(socket, {
            type: CODE_SYNC_TAGS.updateAck,
            protocolVersion: CODE_SYNC_PROTOCOL_VERSION,
            requestId: message.requestId,
            updateId: message.updateId,
            status: result.status,
            sequence: result.sequence,
          }, ack);
          if (result.status === "committed") {
            broadcastAuthorized(session.workspaceId, CODE_SYNC_MESSAGE_EVENT, {
              type: CODE_SYNC_TAGS.remoteUpdate,
              protocolVersion: CODE_SYNC_PROTOCOL_VERSION,
              sourceParticipantId: session.participant.participantId,
              updateId: message.updateId,
              updateEncoding: CODE_SYNC_UPDATE_ENCODING,
              update: message.update,
              sequence: result.sequence,
            } satisfies CodeSyncServerMessage, socket.id);
          }
          return;
        }

        if (!rateScopes.consumeEvent(session.workspaceId, "awareness")) {
          send(socket, {
            type: CODE_SYNC_TAGS.control,
            protocolVersion: CODE_SYNC_PROTOCOL_VERSION,
            code: "rate-limited",
            message: "Code awareness rate limit exceeded",
            terminal: false,
          }, ack);
          return;
        }
        service.authorizeAwareness(session);
        let peers = awareness.get(session.workspaceId);
        if (!peers) {
          peers = new Map();
          awareness.set(session.workspaceId, peers);
        }
        if (
          message.state !== null
          && !peers.has(socket.id)
          && peers.size >= maxAwarenessPeers
        ) {
          send(socket, {
            type: CODE_SYNC_TAGS.control,
            protocolVersion: CODE_SYNC_PROTOCOL_VERSION,
            code: "rate-limited",
            message: "Code awareness peer limit reached",
            terminal: false,
          }, ack);
          return;
        }
        if (message.state === null) peers.delete(socket.id);
        else peers.set(socket.id, {
          participant: session.participant,
          state: message.state,
        });
        if (peers.size === 0) awareness.delete(session.workspaceId);
        broadcastAwareness(
          session.workspaceId,
          session.participant,
          message.state,
          socket.id,
        );
      } catch (error) {
        const control = controlFor(error, requestId);
        send(socket, control, ack);
        if (control.terminal) socket.disconnect(true);
      }
    });

    socket.on("disconnect", () => {
      const peers = awareness.get(session.workspaceId);
      const hadAwareness = peers?.delete(socket.id) ?? false;
      if (peers?.size === 0) awareness.delete(session.workspaceId);
      if (hadAwareness) {
        broadcastAwareness(
          session.workspaceId,
          session.participant,
          null,
          socket.id,
        );
      }
    });
  });

  attachCodeTerminalTransport(namespace, {
    reauthorize: (session) => service.reauthorize(session),
    broadcastAuthorized,
    emitAuthorized,
  });

  return namespace;
}

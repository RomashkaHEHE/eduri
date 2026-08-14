import { parse as parseCookie } from "cookie";
import type { Namespace, Server as SocketIOServer, Socket } from "socket.io";
import {
  CODE_SYNC_CAPABILITIES,
  CODE_SYNC_MESSAGE_EVENT,
  CODE_SYNC_PROTOCOL_VERSION,
  CODE_SYNC_TAGS,
  CODE_SYNC_UPDATE_ENCODING,
  CodeProtocolError,
  parseCodeSyncClientMessage,
  toLegacyCodeAwarenessState,
  type CodeAwarenessState,
  type CodeParticipantIdentity,
  type CodeSyncControlCode,
  type CodeSyncControlMessage,
  type CodeSyncServerMessage,
} from "../../code/protocol/index.js";
import {
  LESSON_CODE_SYNC_NAMESPACE,
  parseLessonCodeSyncHandshakeAuth,
} from "../../code/lessonSync.js";
import { readAuthFromToken, sessionCookieName } from "../security.js";
import {
  attachSocketWireIngress,
  getOrCreateSocketIngressGuard,
  type SocketTrafficLimits,
} from "../socketAbuse.js";
import type { AppContext } from "../types.js";
import {
  LessonCodeSyncService,
  LessonCodeSyncServiceError,
  type AuthenticatedLessonCodeSync,
} from "./service.js";
import { attachLessonCodeTerminalTransport } from "./terminalTransport.js";

type MessageAck = (message: CodeSyncServerMessage) => void;

interface AwarenessEntry {
  readonly participant: CodeParticipantIdentity;
  readonly state: CodeAwarenessState;
}

interface ConnectionData {
  readonly session: AuthenticatedLessonCodeSync;
  multiSelectionAwareness: boolean;
  awarenessReplaySent: boolean;
}

export interface LessonCodeSyncTransportOptions {
  readonly allowedOrigins?: readonly string[];
  readonly maxEventsPerMinute?: number;
  readonly maxUpdateBytesPerMinute?: number;
  readonly maxAwarenessPeers?: number;
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
}

function roomName(workspaceId: string): string {
  return `lesson-code-sync:${workspaceId}`;
}

function controlFor(error: unknown, requestId?: string): CodeSyncControlMessage {
  let code: CodeSyncControlCode = "storage-error";
  let message = "Lesson Code sync failed";
  let terminal = true;
  if (error instanceof CodeProtocolError) {
    code = "invalid-message";
    message = error.message;
    terminal = false;
  } else if (error instanceof LessonCodeSyncServiceError) {
    if (error.code === "INVALID_UPDATE" || error.code === "READ_ONLY") {
      code = "invalid-update";
      terminal = false;
    } else if (error.code === "UNAUTHORIZED" || error.code === "NOT_FOUND") {
      code = "not-found";
    }
    message = error.message;
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

function send(socket: Socket, message: CodeSyncServerMessage, ack?: MessageAck) {
  socket.emit(CODE_SYNC_MESSAGE_EVENT, message);
  ack?.(message);
}

function dataFor(socket: Socket): ConnectionData {
  return socket.data.lessonCodeSync as ConnectionData;
}

export function attachLessonCodeSyncNamespace(
  io: SocketIOServer,
  context: AppContext,
  service: LessonCodeSyncService,
  options: LessonCodeSyncTransportOptions = {},
): Namespace {
  const namespace = io.of(LESSON_CODE_SYNC_NAMESPACE);
  const now = options.now ?? Date.now;
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
  const lessonIngressLimits: SocketTrafficLimits = {
    eventsPerMinute: Math.max(
      1,
      Math.trunc(options.ingressEventsPerMinute ?? 4_000),
    ),
    bytesPerMinute: Math.max(
      1,
      Math.trunc(options.ingressBytesPerMinute ?? 64 * 1024 * 1024),
    ),
  };
  const isWireIngressBlocked = attachSocketWireIngress(
    io,
    ingress,
    options.trustedProxy ?? context.config.trustProxy,
  );
  const allowedOrigins = new Set((options.allowedOrigins ?? []).map((origin) => (
    origin.replace(/\/$/u, "")
  )));
  const awareness = new Map<string, Map<string, AwarenessEntry>>();
  const rates = new Map<string, {
    window: number;
    events: number;
    updateBytes: number;
  }>();
  const maxEvents = Math.max(60, Math.trunc(options.maxEventsPerMinute ?? 4_000));
  const maxUpdateBytes = Math.max(
    1024,
    Math.trunc(options.maxUpdateBytesPerMinute ?? 16 * 1024 * 1024),
  );
  const maxAwarenessPeers = Math.max(
    2,
    Math.trunc(options.maxAwarenessPeers ?? 128),
  );
  let terminalTransport:
    ReturnType<typeof attachLessonCodeTerminalTransport> | undefined;
  const consume = (workspaceId: string, updateBytes = 0): boolean => {
    const time = now();
    let rate = rates.get(workspaceId);
    if (!rate || time < rate.window || time - rate.window >= 60_000) {
      rate = { window: time, events: 0, updateBytes: 0 };
      rates.set(workspaceId, rate);
    }
    const allowed = rate.events < maxEvents
      && updateBytes <= maxUpdateBytes - rate.updateBytes;
    rate.events = Math.min(maxEvents, rate.events + 1);
    rate.updateBytes = Math.min(maxUpdateBytes, rate.updateBytes + updateBytes);
    return allowed;
  };

  const reauthorizeSocket = (socket: Socket): boolean => {
    try {
      service.reauthorize(dataFor(socket).session);
      return true;
    } catch (error) {
      send(socket, controlFor(error));
      socket.disconnect(true);
      return false;
    }
  };

  const broadcast = (
    workspaceId: string,
    message: CodeSyncServerMessage,
    excludeSocketId?: string,
  ): void => {
    for (const socketId of namespace.adapter.rooms.get(roomName(workspaceId)) ?? []) {
      if (socketId === excludeSocketId) continue;
      const target = namespace.sockets.get(socketId);
      if (target && reauthorizeSocket(target)) send(target, message);
    }
  };

  const awarenessStateFor = (
    socket: Socket,
    state: CodeAwarenessState | null,
  ) => state === null || dataFor(socket).multiSelectionAwareness
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
    const data = dataFor(socket);
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
      if (dataFor(target).awarenessReplaySent) {
        sendAwareness(target, participant, state);
      }
    }
  };

  namespace.use((socket, next) => {
    if (isWireIngressBlocked(socket)) {
      const failure = new Error("Lesson Code sync ingress rate limit reached") as Error & {
        data?: CodeSyncControlMessage;
      };
      failure.data = {
        type: CODE_SYNC_TAGS.control,
        protocolVersion: CODE_SYNC_PROTOCOL_VERSION,
        code: "rate-limited",
        message: "Lesson Code sync ingress rate limit exceeded",
        terminal: false,
      };
      next(failure);
      return;
    }
    try {
      const origin = socket.handshake.headers.origin?.replace(/\/$/u, "");
      if (!origin || !allowedOrigins.has(origin)) {
        throw new CodeProtocolError("Lesson Code sync Origin is not allowed");
      }
      const cookies = parseCookie(socket.handshake.headers.cookie ?? "");
      const auth = readAuthFromToken(
        context,
        cookies[sessionCookieName(context)],
      );
      if (!auth) {
        throw new LessonCodeSyncServiceError(
          "UNAUTHORIZED",
          "Lesson Code authentication failed",
        );
      }
      const handshake = parseLessonCodeSyncHandshakeAuth(socket.handshake.auth);
      socket.data.lessonCodeSync = {
        session: service.authenticate(auth, handshake),
        multiSelectionAwareness: false,
        awarenessReplaySent: false,
      } satisfies ConnectionData;
      next();
    } catch (error) {
      const failure = new Error("Lesson Code sync authorization failed") as Error & {
        data?: CodeSyncControlMessage;
      };
      failure.data = controlFor(error);
      next(failure);
    }
  });

  namespace.on("connection", (socket) => {
    const { session } = dataFor(socket);
    const workspaceRoom = roomName(session.workspaceId);
    socket.use((packet, next) => {
      const principalDecision = ingress.consumePrincipal(
        `lesson-code-workspace:${session.workspaceId}`,
        lessonIngressLimits,
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
        message: "Lesson Code sync ingress rate limit exceeded",
        terminal: false,
      }, ack);
      if (!socket.data.lessonCodeIngressDisconnectScheduled) {
        socket.data.lessonCodeIngressDisconnectScheduled = true;
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

    socket.on(CODE_SYNC_MESSAGE_EVENT, (raw: unknown, ack?: MessageAck) => {
      let requestId: string | undefined;
      try {
        const message = parseCodeSyncClientMessage(raw);
        if (message.type === CODE_SYNC_TAGS.capabilities) {
          dataFor(socket).multiSelectionAwareness = true;
          replayAwarenessOnce(socket);
          return;
        }
        replayAwarenessOnce(socket);
        requestId = "requestId" in message ? message.requestId : undefined;
        const updateBytes = message.type === CODE_SYNC_TAGS.update
          ? message.update.byteLength
          : 0;
        if (!consume(session.workspaceId, updateBytes)) {
          send(socket, {
            type: CODE_SYNC_TAGS.control,
            protocolVersion: CODE_SYNC_PROTOCOL_VERSION,
            code: "rate-limited",
            message: "Lesson Code sync rate limit exceeded",
            terminal: false,
            ...(requestId ? { requestId } : {}),
          }, ack);
          return;
        }

        if (message.type === CODE_SYNC_TAGS.profileUpdate) {
          const identity = service.updateProfile(session, message.profile);
          const current = awareness.get(session.workspaceId)?.get(socket.id);
          if (current) {
            awareness.get(session.workspaceId)?.set(socket.id, {
              participant: identity,
              state: current.state,
            });
          }
          terminalTransport?.updateParticipant(socket);
          const updated = {
            type: CODE_SYNC_TAGS.profileUpdated,
            protocolVersion: CODE_SYNC_PROTOCOL_VERSION,
            participant: identity,
          } satisfies CodeSyncServerMessage;
          send(socket, updated, ack);
          if (current) {
            broadcastAwareness(
              session.workspaceId,
              identity,
              current.state,
              socket.id,
            );
          }
          return;
        }

        if (message.type === CODE_SYNC_TAGS.syncStep1) {
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
            broadcast(session.workspaceId, {
              type: CODE_SYNC_TAGS.remoteUpdate,
              protocolVersion: CODE_SYNC_PROTOCOL_VERSION,
              sourceParticipantId: session.participant.participantId,
              updateId: message.updateId,
              updateEncoding: CODE_SYNC_UPDATE_ENCODING,
              update: message.update,
              sequence: result.sequence,
            }, socket.id);
          }
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
            message: "Lesson Code awareness peer limit reached",
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

  terminalTransport = attachLessonCodeTerminalTransport(namespace, service, { now });

  const disconnectMatching = (
    predicate: (session: AuthenticatedLessonCodeSync) => boolean,
  ) => {
    for (const socket of namespace.sockets.values()) {
      if (predicate(dataFor(socket).session)) socket.disconnect(true);
    }
  };
  const previousDisconnectUser = context.disconnectUserSockets;
  context.disconnectUserSockets = (userId) => {
    previousDisconnectUser?.(userId);
    disconnectMatching((session) => session.userId === userId);
  };
  const previousDisconnectSession = context.disconnectSessionSockets;
  context.disconnectSessionSockets = (sessionHash) => {
    previousDisconnectSession?.(sessionHash);
    disconnectMatching((session) => session.sessionHash === sessionHash);
  };
  const previousRemoveMembership = context.removeLessonSocketMembership;
  context.removeLessonSocketMembership = (lessonId, userId) => {
    previousRemoveMembership?.(lessonId, userId);
    disconnectMatching((session) => session.lessonId === lessonId
      && (!userId || session.userId === userId));
  };
  const previousEmitLessonStatus = context.emitLessonStatus;
  context.emitLessonStatus = (lessonId, status) => {
    previousEmitLessonStatus?.(lessonId, status);
    if (status === "completed" || status === "cancelled") {
      disconnectMatching((session) => session.lessonId === lessonId);
    }
  };

  return namespace;
}

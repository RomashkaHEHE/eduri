import type { Namespace, Socket } from "socket.io";
import {
  SHARED_TERMINAL_ACK_EVENT,
  SHARED_TERMINAL_ACTION_EVENT,
  SHARED_TERMINAL_DELTA_EVENT,
  SHARED_TERMINAL_EFFECT_EVENT,
  SHARED_TERMINAL_STATE_EVENT,
  SharedTerminalStateMachine,
  createSharedTerminalAck,
  parseSharedTerminalActionEnvelope,
  readSharedTerminalActionId,
  toSharedTerminalClientEffect,
  type SharedTerminalActor,
} from "../../code/terminal/index.js";
import type {
  AuthenticatedLessonCodeSync,
} from "./service.js";
import {
  LessonCodeSyncService,
  LessonCodeSyncServiceError,
} from "./service.js";
import {
  consumeTerminalActionRate,
  type TerminalActionRateScope,
} from "../code-sync/terminalActionRate.js";

interface LessonCodeConnectionData {
  readonly session: AuthenticatedLessonCodeSync;
}

export interface LessonCodeTerminalTransportController {
  readonly updateParticipant: (socket: Socket) => void;
}

function roomName(workspaceId: string): string {
  return `lesson-code-sync:${workspaceId}`;
}

function actor(socket: Socket): SharedTerminalActor {
  const session = (socket.data.lessonCodeSync as LessonCodeConnectionData).session;
  return {
    socketId: socket.id,
    participantId: session.participant.participantId,
    displayName: session.participant.displayName,
    color: session.participant.color,
  };
}

function reauthorizeSocket(
  service: LessonCodeSyncService,
  target: Socket,
): boolean {
  const data = target.data.lessonCodeSync as LessonCodeConnectionData | undefined;
  try {
    if (!data) throw new Error("missing lesson Code session");
    service.reauthorize(data.session);
    return true;
  } catch {
    return false;
  }
}

export function attachLessonCodeTerminalTransport(
  namespace: Namespace,
  service: LessonCodeSyncService,
  options: {
    readonly maxActionsPerMinute?: number;
    readonly now?: () => number;
  } = {},
): LessonCodeTerminalTransportController {
  const machines = new Map<string, SharedTerminalStateMachine>();
  const connections = new Map<string, number>();
  const rates = new Map<string, TerminalActionRateScope>();
  const maximum = Math.max(60, Math.trunc(options.maxActionsPerMinute ?? 3_000));
  const now = options.now ?? Date.now;

  const emitAuthorized = (
    socketId: string,
    event: string,
    payload: unknown,
  ): boolean => {
    const target = namespace.sockets.get(socketId);
    if (!target) return false;
    if (!reauthorizeSocket(service, target)) {
      target.disconnect(true);
      return false;
    }
    target.emit(event, payload);
    return true;
  };

  const broadcastAuthorized = (
    workspaceId: string,
    event: string,
    payload: unknown,
  ): void => {
    // Reauthorize the complete recipient set before emitting. Disconnecting a
    // revoked terminal host produces a newer lease-release delta synchronously;
    // every authorized observer must receive this older payload first.
    const socketIds = [
      ...(namespace.adapter.rooms.get(roomName(workspaceId)) ?? []),
    ];
    const authorized: Socket[] = [];
    const revoked: Socket[] = [];
    for (const socketId of socketIds) {
      const target = namespace.sockets.get(socketId);
      if (!target) continue;
      if (reauthorizeSocket(service, target)) authorized.push(target);
      else revoked.push(target);
    }
    for (const target of authorized) target.emit(event, payload);
    for (const target of revoked) target.disconnect(true);
  };

  const broadcastDelta = (
    workspaceId: string,
    delta: NonNullable<ReturnType<SharedTerminalStateMachine["disconnect"]>["delta"]>,
  ): void => {
    broadcastAuthorized(workspaceId, SHARED_TERMINAL_DELTA_EVENT, delta);
  };

  const broadcastSnapshot = (
    workspaceId: string,
    snapshot: ReturnType<SharedTerminalStateMachine["snapshot"]>,
  ): void => {
    broadcastAuthorized(workspaceId, SHARED_TERMINAL_STATE_EVENT, snapshot);
  };

  namespace.on("connection", (socket) => {
    const data = socket.data.lessonCodeSync as LessonCodeConnectionData;
    const { session } = data;
    const workspaceId = session.workspaceId;
    const machine = machines.get(workspaceId) ?? new SharedTerminalStateMachine();
    machines.set(workspaceId, machine);
    connections.set(workspaceId, (connections.get(workspaceId) ?? 0) + 1);
    socket.emit(SHARED_TERMINAL_STATE_EVENT, machine.snapshot());

    socket.on(SHARED_TERMINAL_ACTION_EVENT, (raw: unknown) => {
      const recoverableActionId = readSharedTerminalActionId(raw);
      try {
        service.requireMutable(session);
        const parsed = parseSharedTerminalActionEnvelope(raw);
        if (!parsed) {
          if (recoverableActionId) {
            socket.emit(
              SHARED_TERMINAL_ACK_EVENT,
              createSharedTerminalAck(
                recoverableActionId,
                machine.snapshot(),
                "rejected",
                "invalid-action",
              ),
            );
          }
          return;
        }
        const rate = consumeTerminalActionRate(
          rates.get(socket.id), parsed.action, now(), maximum,
        );
        rates.set(socket.id, rate.scope);
        if (!rate.allowed) {
          socket.emit(
            SHARED_TERMINAL_ACK_EVENT,
            createSharedTerminalAck(
              parsed.action.actionId,
              machine.snapshot(),
              "rejected",
              "rate-limited",
            ),
          );
          return;
        }
        const result = machine.dispatch(actor(socket), parsed.action);
        socket.emit(SHARED_TERMINAL_ACK_EVENT, result.ack);
        if (result.delta) broadcastDelta(workspaceId, result.delta);
        if (result.snapshot) {
          if (parsed.action.type === "sync") {
            socket.emit(SHARED_TERMINAL_STATE_EVENT, result.snapshot);
          } else {
            // clear/cls advances the shared generation, so every observer must
            // replace its terminal state instead of waiting for a delta.
            broadcastSnapshot(workspaceId, result.snapshot);
          }
        }
        if (result.effect) {
          emitAuthorized(
            result.effect.targetSocketId,
            SHARED_TERMINAL_EFFECT_EVENT,
            toSharedTerminalClientEffect(result.effect),
          );
        }
      } catch (error) {
        if (recoverableActionId) {
          socket.emit(
            SHARED_TERMINAL_ACK_EVENT,
            createSharedTerminalAck(
              recoverableActionId,
              machine.snapshot(),
              "rejected",
              "unauthorized",
            ),
          );
        }
        if (
          error instanceof LessonCodeSyncServiceError
          && error.code === "READ_ONLY"
        ) {
          // A lesson status transition revokes any terminal host/input lease,
          // but a completed lesson remains available to this viewer for cold
          // sync and read-only inspection.
          const released = machine.disconnect(socket.id);
          if (released.delta) broadcastDelta(workspaceId, released.delta);
          socket.emit(SHARED_TERMINAL_STATE_EVENT, machine.snapshot());
          return;
        }
        // Missing/revoked account, session, or membership is terminal. The
        // disconnect handler performs the shared lease cleanup exactly once.
        socket.disconnect(true);
      }
    });

    socket.on("disconnect", () => {
      rates.delete(socket.id);
      const result = machine.disconnect(socket.id);
      if (result.delta) broadcastDelta(workspaceId, result.delta);
      const remaining = Math.max(0, (connections.get(workspaceId) ?? 1) - 1);
      if (remaining === 0) {
        connections.delete(workspaceId);
        machines.delete(workspaceId);
      } else {
        connections.set(workspaceId, remaining);
      }
    });
  });

  return {
    updateParticipant(socket): void {
      const data = socket.data.lessonCodeSync as LessonCodeConnectionData | undefined;
      if (!data) return;
      const machine = machines.get(data.session.workspaceId);
      if (!machine) return;
      const result = machine.updateActor(actor(socket));
      if (result.delta) broadcastDelta(data.session.workspaceId, result.delta);
    },
  };
}

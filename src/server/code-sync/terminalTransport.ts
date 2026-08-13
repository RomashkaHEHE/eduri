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
import type { AuthenticatedCodeSync } from "./service.js";
import {
  consumeTerminalActionRate,
  type TerminalActionRateScope,
} from "./terminalActionRate.js";

export interface CodeTerminalConnectionData {
  readonly session: AuthenticatedCodeSync;
}

export interface AttachCodeTerminalOptions {
  readonly reauthorize: (session: AuthenticatedCodeSync) => void;
  /**
   * Emits only after the parent transport has reauthorized every recipient.
   * Guest capabilities can expire while a socket is silent, so ordinary
   * Socket.IO room broadcasts are not safe for workspace data.
   */
  readonly broadcastAuthorized: (
    workspaceId: string,
    event: string,
    payload: unknown,
    excludeSocketId?: string,
  ) => void;
  readonly emitAuthorized: (
    socketId: string,
    event: string,
    payload: unknown,
  ) => boolean;
  readonly maxActionsPerMinute?: number;
  readonly now?: () => number;
}

function roomName(workspaceId: string): string {
  return `code-sync:${workspaceId}`;
}

function actor(socket: Socket): SharedTerminalActor {
  const session = (socket.data.codeSync as CodeTerminalConnectionData).session;
  return {
    socketId: socket.id,
    participantId: session.participant.participantId,
    displayName: session.participant.displayName,
    color: session.participant.color,
  };
}

/**
 * Adds one ordered, bounded in-memory terminal per Code workspace. The server
 * owns ordering and leases; the elected browser host receives only explicit
 * execution effects, never a process/OS shell handle.
 */
export function attachCodeTerminalTransport(
  namespace: Namespace,
  options: AttachCodeTerminalOptions,
): void {
  const machines = new Map<string, SharedTerminalStateMachine>();
  const connections = new Map<string, number>();
  const rates = new Map<string, TerminalActionRateScope>();
  const maximum = Math.max(60, Math.trunc(options.maxActionsPerMinute ?? 3_000));
  const now = options.now ?? (() => Date.now());

  namespace.on("connection", (socket) => {
    const session = (socket.data.codeSync as CodeTerminalConnectionData).session;
    const workspaceId = session.workspaceId;
    const machine = machines.get(workspaceId) ?? new SharedTerminalStateMachine();
    machines.set(workspaceId, machine);
    connections.set(workspaceId, (connections.get(workspaceId) ?? 0) + 1);
    socket.emit(SHARED_TERMINAL_STATE_EVENT, machine.snapshot());

    socket.on(SHARED_TERMINAL_ACTION_EVENT, (raw: unknown) => {
      const recoverableActionId = readSharedTerminalActionId(raw);
      try {
        options.reauthorize(session);
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
        if (result.delta) {
          options.broadcastAuthorized(
            workspaceId,
            SHARED_TERMINAL_DELTA_EVENT,
            result.delta,
          );
        }
        if (result.snapshot) {
          if (result.changed) {
            options.broadcastAuthorized(
              workspaceId,
              SHARED_TERMINAL_STATE_EVENT,
              result.snapshot,
            );
          } else {
            socket.emit(SHARED_TERMINAL_STATE_EVENT, result.snapshot);
          }
        }
        if (result.effect) {
          options.emitAuthorized(
            result.effect.targetSocketId,
            SHARED_TERMINAL_EFFECT_EVENT,
            toSharedTerminalClientEffect(result.effect),
          );
        }
      } catch {
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
        socket.leave(roomName(workspaceId));
        socket.disconnect(true);
      }
    });

    socket.on("disconnect", () => {
      rates.delete(socket.id);
      const result = machine.disconnect(socket.id);
      if (result.delta) {
        options.broadcastAuthorized(
          workspaceId,
          SHARED_TERMINAL_DELTA_EVENT,
          result.delta,
          socket.id,
        );
      }
      const remaining = Math.max(0, (connections.get(workspaceId) ?? 1) - 1);
      if (remaining === 0) {
        connections.delete(workspaceId);
        // Ephemeral terminal history exists only while the room is active.
        machines.delete(workspaceId);
      } else {
        connections.set(workspaceId, remaining);
      }
    });
  });
}

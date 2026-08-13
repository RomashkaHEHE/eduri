import type { SharedTerminalAction } from "../../code/terminal/index.js";

const RETRY_DELAY_MS = 600;
const MAX_ATTEMPTS = 3;
const MAX_PENDING_ACTIONS = 256;

interface PendingAction {
  readonly action: SharedTerminalAction;
  attempts: number;
  timer: ReturnType<typeof globalThis.setTimeout> | null;
}

export interface TerminalActionOutbox {
  dispatch(action: SharedTerminalAction): boolean;
  acknowledge(actionId: string): void;
  clear(): void;
}

export type TerminalActionDiscardReason =
  | "disconnected"
  | "capacity"
  | "attempts-exhausted";

/**
 * Retries terminal actions with their original actionId. The server state
 * machine fingerprints and deduplicates that ID, so a lost ACK cannot execute
 * a command twice. Pending work is deliberately cleared on disconnect: a new
 * ephemeral terminal generation must never replay an old command.
 */
export function createTerminalActionOutbox(options: {
  readonly connected: () => boolean;
  readonly send: (action: SharedTerminalAction) => void;
  readonly onDiscard?: (
    action: SharedTerminalAction,
    reason: TerminalActionDiscardReason,
  ) => void;
  readonly retryDelayMs?: number;
}): TerminalActionOutbox {
  const pending = new Map<string, PendingAction>();
  const retryDelayMs = Math.max(10, Math.trunc(
    options.retryDelayMs ?? RETRY_DELAY_MS,
  ));

  const remove = (actionId: string): void => {
    const current = pending.get(actionId);
    if (!current) return;
    if (current.timer !== null) globalThis.clearTimeout(current.timer);
    pending.delete(actionId);
  };

  const discard = (
    action: SharedTerminalAction,
    reason: TerminalActionDiscardReason,
  ): void => {
    remove(action.actionId);
    // Let the dispatching component register the action ID before a local
    // rejection is delivered. This mirrors the asynchronous server ACK path.
    queueMicrotask(() => options.onDiscard?.(action, reason));
  };

  const send = (current: PendingAction): void => {
    if (!options.connected()) {
      discard(current.action, "disconnected");
      return;
    }
    current.attempts += 1;
    options.send(current.action);
    current.timer = globalThis.setTimeout(() => {
      current.timer = null;
      if (!pending.has(current.action.actionId)) return;
      if (current.attempts >= MAX_ATTEMPTS) {
        discard(current.action, "attempts-exhausted");
        return;
      }
      send(current);
    }, retryDelayMs);
  };

  return {
    dispatch(action) {
      if (!options.connected()) {
        queueMicrotask(() => options.onDiscard?.(action, "disconnected"));
        return false;
      }
      if (pending.has(action.actionId)) return true;
      if (action.type === "edit-input") {
        for (const [actionId, current] of pending) {
          if (current.action.type === "edit-input") remove(actionId);
        }
      }
      if (pending.size >= MAX_PENDING_ACTIONS) {
        queueMicrotask(() => options.onDiscard?.(action, "capacity"));
        return false;
      }
      const current: PendingAction = { action, attempts: 0, timer: null };
      pending.set(action.actionId, current);
      send(current);
      return true;
    },
    acknowledge: remove,
    clear() {
      for (const actionId of [...pending.keys()]) remove(actionId);
    },
  };
}

import {
  sharedTerminalActionFingerprint,
  type SharedTerminalAction,
} from "../../code/terminal/index.js";

export interface TerminalActionRateScope {
  window: number;
  count: number;
  readonly seen: Set<string>;
}

/**
 * Charges each distinct action payload once per fixed window. A retry with the
 * same actionId and payload is free because the state machine will return its
 * idempotent duplicate ACK; this prevents ordinary delayed ACKs from doubling
 * output traffic against the rate budget.
 */
export function consumeTerminalActionRate(
  current: TerminalActionRateScope | undefined,
  action: SharedTerminalAction,
  time: number,
  maximum: number,
): { readonly allowed: boolean; readonly scope: TerminalActionRateScope } {
  const scope = !current || time < current.window || time - current.window >= 60_000
    ? { window: time, count: 0, seen: new Set<string>() }
    : current;
  const fingerprint = `${action.actionId}:${sharedTerminalActionFingerprint(action)}`;
  if (scope.seen.has(fingerprint)) return { allowed: true, scope };
  if (scope.count >= maximum) return { allowed: false, scope };
  scope.count += 1;
  scope.seen.add(fingerprint);
  return { allowed: true, scope };
}

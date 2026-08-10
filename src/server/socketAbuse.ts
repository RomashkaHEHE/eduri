import type { IncomingHttpHeaders, IncomingMessage } from "node:http";
import { isIP } from "node:net";
import type { Socket as EngineSocket } from "engine.io";
import type {
  Server as SocketIOServer,
  Socket as SocketIOSocket,
} from "socket.io";

const RATE_WINDOW_MS = 60_000;
const PACKET_MAX_DEPTH = 64;
const PACKET_MAX_NODES = 100_000;
const SOCKET_PACKET_ENVELOPE_OVERHEAD_BYTES = 64;
const BINARY_ATTACHMENT_OVERHEAD_BYTES = 64;
const ACK_CALLBACK_OVERHEAD_BYTES = 16;
const WIRE_REJECTION_CLOSE_DELAY_MS = 25;
// attachRealtime configures the same 5 MiB Engine.IO ceiling. Keeping the
// structural-accounting cutoff here prevents a tiny but excessively wide
// packet from being converted into a synthetic 1 GiB process-global charge.
const SOCKET_PACKET_HARD_ACCOUNTING_BYTES = 5 * 1024 * 1024;
const SOCKET_WIRE_HARD_ACCOUNTING_BYTES = SOCKET_PACKET_HARD_ACCOUNTING_BYTES
  + SOCKET_PACKET_ENVELOPE_OVERHEAD_BYTES;

export interface SocketTrafficLimits {
  readonly eventsPerMinute: number;
  readonly bytesPerMinute: number;
}

export interface SocketIngressGuardOptions {
  readonly global: SocketTrafficLimits;
  readonly ip: SocketTrafficLimits;
  readonly maxIpScopes: number;
  readonly maxPrincipalScopes: number;
  readonly scopeIdleMs: number;
  readonly now?: () => number;
}

export interface SocketIngressDecision {
  readonly allowed: boolean;
  readonly retryAfterMs: number;
  readonly packetBytes: number;
}

interface RateDecision {
  readonly allowed: boolean;
  readonly retryAfterMs: number;
}

class TrafficBucket {
  private windowStartedAt: number;
  private events = 0;
  private bytes = 0;
  lastSeenAt: number;

  constructor(now: number) {
    this.windowStartedAt = now;
    this.lastSeenAt = now;
  }

  consume(limits: SocketTrafficLimits, bytes: number, now: number): RateDecision {
    if (now < this.windowStartedAt || now - this.windowStartedAt >= RATE_WINDOW_MS) {
      this.windowStartedAt = now;
      this.events = 0;
      this.bytes = 0;
    }
    this.lastSeenAt = now;
    const allowed = this.events < limits.eventsPerMinute
      && bytes <= limits.bytesPerMinute - this.bytes;
    this.events = Math.min(limits.eventsPerMinute, this.events + 1);
    this.bytes = Math.min(limits.bytesPerMinute, this.bytes + bytes);
    return {
      allowed,
      retryAfterMs: Math.max(1, this.windowStartedAt + RATE_WINDOW_MS - now),
    };
  }
}

class BoundedTrafficScopes {
  private readonly scopes = new Map<string, TrafficBucket>();
  private nextSweepAt: number;

  constructor(
    private readonly maximumScopes: number,
    private readonly idleMs: number,
    private readonly now: () => number,
  ) {
    this.nextSweepAt = now() + RATE_WINDOW_MS;
  }

  consume(
    scopeId: string,
    limits: SocketTrafficLimits,
    bytes: number,
    now = this.now(),
  ): RateDecision {
    this.sweep(now, false);
    let scope = this.scopes.get(scopeId);
    if (!scope) {
      if (this.scopes.size >= this.maximumScopes) {
        this.sweep(now, true);
        if (this.scopes.size >= this.maximumScopes) {
          return { allowed: false, retryAfterMs: RATE_WINDOW_MS };
        }
      }
      scope = new TrafficBucket(now);
      this.scopes.set(scopeId, scope);
    }
    return scope.consume(limits, bytes, now);
  }

  private sweep(now: number, force: boolean): void {
    if (!force && now < this.nextSweepAt) return;
    for (const [scopeId, scope] of this.scopes) {
      if (now < scope.lastSeenAt || now - scope.lastSeenAt >= this.idleMs) {
        this.scopes.delete(scopeId);
      }
    }
    this.nextSweepAt = now + RATE_WINDOW_MS;
  }
}

function positiveInteger(name: string, value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive safe integer`);
  }
  return value;
}

function validatedLimits(name: string, limits: SocketTrafficLimits): SocketTrafficLimits {
  return {
    eventsPerMinute: positiveInteger(`${name} event limit`, limits.eventsPerMinute),
    bytesPerMinute: positiveInteger(`${name} byte limit`, limits.bytesPerMinute),
  };
}

function jsonStringBytes(value: string): number {
  let bytes = Buffer.byteLength(value);
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code === 0x22 || code === 0x5c || code === 0x08 || code === 0x09
      || code === 0x0a || code === 0x0c || code === 0x0d) {
      bytes += 1;
    } else if (code < 0x20) {
      bytes += 5;
    } else if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) index += 1;
      else bytes += 3;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      bytes += 3;
    }
  }
  return bytes + 2;
}

export function boundedSocketPacketBytes(
  packet: readonly unknown[],
  cutoff: number,
): number {
  positiveInteger("socket packet byte cutoff", cutoff);
  const stack: Array<{ value: unknown; depth: number }> = [{ value: packet, depth: 0 }];
  const seen = new WeakSet<object>();
  let bytes = SOCKET_PACKET_ENVELOPE_OVERHEAD_BYTES;
  let nodes = 0;
  const add = (amount: number): boolean => {
    bytes += amount;
    return bytes > cutoff;
  };

  while (stack.length > 0) {
    const current = stack.pop()!;
    nodes += 1;
    if (nodes > PACKET_MAX_NODES || current.depth > PACKET_MAX_DEPTH) {
      return cutoff + 1;
    }
    const value = current.value;
    if (value === null) {
      if (add(4)) return cutoff + 1;
      continue;
    }
    if (typeof value === "string") {
      if (add(jsonStringBytes(value))) return cutoff + 1;
      continue;
    }
    if (typeof value === "number") {
      if (add(Number.isFinite(value) ? String(value).length : 4)) return cutoff + 1;
      continue;
    }
    if (typeof value === "boolean") {
      if (add(value ? 4 : 5)) return cutoff + 1;
      continue;
    }
    if (typeof value === "undefined") {
      if (add(4)) return cutoff + 1;
      continue;
    }
    if (typeof value === "function") {
      if (add(ACK_CALLBACK_OVERHEAD_BYTES)) return cutoff + 1;
      continue;
    }
    if (typeof value === "bigint" || typeof value === "symbol") return cutoff + 1;
    if (Buffer.isBuffer(value)) {
      if (add(value.byteLength + BINARY_ATTACHMENT_OVERHEAD_BYTES)) return cutoff + 1;
      continue;
    }
    if (value instanceof ArrayBuffer) {
      if (add(value.byteLength + BINARY_ATTACHMENT_OVERHEAD_BYTES)) return cutoff + 1;
      continue;
    }
    if (ArrayBuffer.isView(value)) {
      if (add(value.byteLength + BINARY_ATTACHMENT_OVERHEAD_BYTES)) return cutoff + 1;
      continue;
    }
    if (seen.has(value)) return cutoff + 1;
    seen.add(value);
    if (Array.isArray(value)) {
      // Do not materialize an attacker-controlled number of traversal frames
      // only to discover the node limit later. A near-5 MiB array can contain
      // millions of tiny values, which would otherwise turn this guard into
      // the source of an allocation spike before application validation runs.
      if (value.length > PACKET_MAX_NODES - nodes - stack.length) {
        return cutoff + 1;
      }
      if (add(2 + Math.max(0, value.length - 1))) return cutoff + 1;
      for (let index = value.length - 1; index >= 0; index -= 1) {
        stack.push({ value: value[index], depth: current.depth + 1 });
      }
      continue;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return cutoff + 1;
    const keys = Object.keys(value);
    if (keys.length > PACKET_MAX_NODES - nodes - stack.length) {
      return cutoff + 1;
    }
    if (add(2 + Math.max(0, keys.length - 1))) return cutoff + 1;
    for (let index = keys.length - 1; index >= 0; index -= 1) {
      const key = keys[index];
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !("value" in descriptor)) return cutoff + 1;
      if (add(jsonStringBytes(key) + 1)) return cutoff + 1;
      stack.push({ value: descriptor.value, depth: current.depth + 1 });
    }
  }
  return bytes;
}

export class SocketIngressGuard {
  private readonly globalLimits: SocketTrafficLimits;
  private readonly ipLimits: SocketTrafficLimits;
  private readonly global: TrafficBucket;
  private readonly ipScopes: BoundedTrafficScopes;
  private readonly principalScopes: BoundedTrafficScopes;
  private readonly now: () => number;

  constructor(options: SocketIngressGuardOptions) {
    this.now = options.now ?? Date.now;
    const initialNow = this.now();
    this.globalLimits = validatedLimits("global socket ingress", options.global);
    this.ipLimits = validatedLimits("IP socket ingress", options.ip);
    this.global = new TrafficBucket(initialNow);
    const idleMs = Math.max(
      RATE_WINDOW_MS,
      positiveInteger("socket ingress scope idle time", options.scopeIdleMs),
    );
    this.ipScopes = new BoundedTrafficScopes(
      positiveInteger("socket ingress IP scopes", options.maxIpScopes),
      idleMs,
      this.now,
    );
    this.principalScopes = new BoundedTrafficScopes(
      positiveInteger("socket ingress principal scopes", options.maxPrincipalScopes),
      idleMs,
      this.now,
    );
  }

  consume(
    sourceIp: string,
    principalScope: string,
    principalLimitsInput: SocketTrafficLimits,
    packet: readonly unknown[],
  ): SocketIngressDecision {
    const principalLimits = validatedLimits("principal socket ingress", principalLimitsInput);
    const cutoff = Math.max(
      this.globalLimits.bytesPerMinute,
      this.ipLimits.bytesPerMinute,
      principalLimits.bytesPerMinute,
    );
    const accountingCutoff = Math.min(cutoff, SOCKET_PACKET_HARD_ACCOUNTING_BYTES);
    const packetBytes = boundedSocketPacketBytes(packet, accountingCutoff);
    const hardRejected = packetBytes > accountingCutoff;
    const aggregateCharge = Math.min(packetBytes, accountingCutoff);
    const now = this.now();
    const global = this.global.consume(this.globalLimits, aggregateCharge, now);
    const ip = this.ipScopes.consume(sourceIp, this.ipLimits, aggregateCharge, now);
    const principal = this.principalScopes.consume(
      principalScope,
      principalLimits,
      hardRejected ? principalLimits.bytesPerMinute : packetBytes,
      now,
    );
    return {
      allowed: !hardRejected && global.allowed && ip.allowed && principal.allowed,
      retryAfterMs: Math.max(
        global.allowed ? 0 : global.retryAfterMs,
        ip.allowed ? 0 : ip.retryAfterMs,
        principal.allowed ? 0 : principal.retryAfterMs,
        hardRejected ? principal.retryAfterMs : 0,
        1,
      ),
      packetBytes,
    };
  }

  consumeUnattributed(
    sourceIp: string,
    packet: readonly unknown[],
  ): SocketIngressDecision {
    const cutoff = Math.max(
      this.globalLimits.bytesPerMinute,
      this.ipLimits.bytesPerMinute,
    );
    const accountingCutoff = Math.min(cutoff, SOCKET_PACKET_HARD_ACCOUNTING_BYTES);
    const packetBytes = boundedSocketPacketBytes(packet, accountingCutoff);
    const hardRejected = packetBytes > accountingCutoff;
    const aggregateCharge = Math.min(packetBytes, accountingCutoff);
    const now = this.now();
    const global = this.global.consume(this.globalLimits, aggregateCharge, now);
    const ip = this.ipScopes.consume(
      sourceIp,
      this.ipLimits,
      hardRejected ? this.ipLimits.bytesPerMinute : packetBytes,
      now,
    );
    return {
      allowed: !hardRejected && global.allowed && ip.allowed,
      retryAfterMs: Math.max(
        global.allowed ? 0 : global.retryAfterMs,
        ip.allowed ? 0 : ip.retryAfterMs,
        hardRejected ? ip.retryAfterMs : 0,
        1,
      ),
      packetBytes,
    };
  }

  consumePrincipal(
    principalScope: string,
    principalLimitsInput: SocketTrafficLimits,
    packet: readonly unknown[],
  ): SocketIngressDecision {
    const principalLimits = validatedLimits("principal socket ingress", principalLimitsInput);
    const accountingCutoff = Math.min(
      principalLimits.bytesPerMinute,
      SOCKET_PACKET_HARD_ACCOUNTING_BYTES,
    );
    const packetBytes = boundedSocketPacketBytes(packet, accountingCutoff);
    const hardRejected = packetBytes > accountingCutoff;
    const now = this.now();
    const principal = this.principalScopes.consume(
      principalScope,
      principalLimits,
      hardRejected ? principalLimits.bytesPerMinute : packetBytes,
      now,
    );
    return {
      allowed: !hardRejected && principal.allowed,
      retryAfterMs: Math.max(
        principal.allowed ? 0 : principal.retryAfterMs,
        hardRejected ? principal.retryAfterMs : 0,
        1,
      ),
      packetBytes,
    };
  }

  consumeWire(sourceIp: string, data: unknown): SocketIngressDecision {
    let payloadBytes: number;
    if (typeof data === "string") payloadBytes = Buffer.byteLength(data);
    else if (Buffer.isBuffer(data)) payloadBytes = data.byteLength;
    else if (data instanceof ArrayBuffer) payloadBytes = data.byteLength;
    else if (ArrayBuffer.isView(data)) payloadBytes = data.byteLength;
    else payloadBytes = SOCKET_WIRE_HARD_ACCOUNTING_BYTES + 1;

    const measuredBytes = payloadBytes + SOCKET_PACKET_ENVELOPE_OVERHEAD_BYTES;
    const hardRejected = measuredBytes > SOCKET_WIRE_HARD_ACCOUNTING_BYTES;
    const packetBytes = hardRejected
      ? SOCKET_WIRE_HARD_ACCOUNTING_BYTES + 1
      : measuredBytes;
    const now = this.now();
    const global = this.global.consume(
      this.globalLimits,
      Math.min(packetBytes, SOCKET_WIRE_HARD_ACCOUNTING_BYTES),
      now,
    );
    const ip = this.ipScopes.consume(
      sourceIp,
      this.ipLimits,
      hardRejected ? this.ipLimits.bytesPerMinute : packetBytes,
      now,
    );
    return {
      allowed: !hardRejected && global.allowed && ip.allowed,
      retryAfterMs: Math.max(
        global.allowed ? 0 : global.retryAfterMs,
        ip.allowed ? 0 : ip.retryAfterMs,
        hardRejected ? ip.retryAfterMs : 0,
        1,
      ),
      packetBytes,
    };
  }
}

const socketIngressGuards = new WeakMap<object, SocketIngressGuard>();

export function getOrCreateSocketIngressGuard(
  owner: object,
  options: SocketIngressGuardOptions,
): SocketIngressGuard {
  const existing = socketIngressGuards.get(owner);
  if (existing) return existing;
  const created = new SocketIngressGuard(options);
  socketIngressGuards.set(owner, created);
  return created;
}

interface SocketWireIngressState {
  readonly guard: SocketIngressGuard;
  readonly trustedProxy: boolean | number | string;
  readonly blocked: WeakSet<EngineSocket>;
}

const socketWireIngressStates = new WeakMap<SocketIOServer, SocketWireIngressState>();

/**
 * Charges each incoming Engine.IO message before Socket.IO's JSON/binary
 * decoder sees it. This covers malformed frames and unknown namespaces which
 * never reach namespace or application middleware.
 */
export function attachSocketWireIngress(
  io: SocketIOServer,
  guard: SocketIngressGuard,
  trustedProxy: boolean | number | string = false,
): (socket: SocketIOSocket) => boolean {
  const existing = socketWireIngressStates.get(io);
  if (existing) {
    if (existing.guard !== guard || existing.trustedProxy !== trustedProxy) {
      throw new Error("Socket.IO wire ingress was attached with different security options");
    }
    return (socket) => existing.blocked.has(socket.conn);
  }

  const state: SocketWireIngressState = {
    guard,
    trustedProxy,
    blocked: new WeakSet<EngineSocket>(),
  };
  socketWireIngressStates.set(io, state);
  io.engine.prependListener("connection", (connection) => {
    const sourceIp = socketSourceIp(
      connection.request.socket.remoteAddress,
      connection.request.headers,
      trustedProxy,
    );
    connection.prependListener("data", (data: unknown) => {
      if (state.blocked.has(connection)) {
        connection.close(true);
        return;
      }
      const decision = guard.consumeWire(sourceIp, data);
      if (decision.allowed) return;
      state.blocked.add(connection);
      // Socket.IO's listener for this same EventEmitter turn may still run.
      // Namespace/event middleware checks the marker before any application
      // parser or handler, while this timer closes unknown/malformed packets
      // which never create a namespace Socket at all.
      const timer = setTimeout(
        () => connection.close(true),
        WIRE_REJECTION_CLOSE_DELAY_MS,
      );
      timer.unref();
    });
  });
  return (socket) => state.blocked.has(socket.conn);
}

function headerValue(headers: IncomingHttpHeaders, name: string): string | undefined {
  const value = headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function normalizedIp(value: string | undefined): string | undefined {
  const candidate = value?.trim();
  if (!candidate) return undefined;
  const withoutMappedPrefix = candidate.toLowerCase().startsWith("::ffff:")
    ? candidate.slice(7)
    : candidate;
  return isIP(withoutMappedPrefix) ? withoutMappedPrefix.toLowerCase() : undefined;
}

export function socketSourceIp(
  remoteAddress: string | undefined,
  headers: IncomingHttpHeaders,
  trustedProxy: boolean | number | string = false,
): string {
  const remote = normalizedIp(remoteAddress) ?? "unknown";
  const trusted = typeof trustedProxy === "string"
    ? normalizedIp(trustedProxy)
    : undefined;
  if (!trusted || remote !== trusted) return remote;
  return normalizedIp(headerValue(headers, "x-real-ip")) ?? remote;
}

export interface SocketAdmissionOptions {
  readonly maxConnections: number;
  readonly maxConnectionsPerIp: number;
  readonly connectionAttemptsPerMinute: number;
  readonly connectionAttemptsPerIpPerMinute: number;
  readonly maxIpScopes: number;
  readonly scopeIdleMs: number;
  readonly reservationTtlMs?: number;
  readonly trustedProxy?: boolean | number | string;
  readonly now?: () => number;
}

interface AdmissionReservation {
  readonly sourceIp: string;
  activated: boolean;
  released: boolean;
  readonly timer: NodeJS.Timeout;
}

export class SocketAdmissionController {
  private readonly maximumConnections: number;
  private readonly maximumConnectionsPerIp: number;
  private readonly globalAttemptLimits: SocketTrafficLimits;
  private readonly ipAttemptLimits: SocketTrafficLimits;
  private readonly globalAttempts: TrafficBucket;
  private readonly ipAttempts: BoundedTrafficScopes;
  private readonly activeByIp = new Map<string, number>();
  private readonly reservations = new WeakMap<IncomingMessage, AdmissionReservation>();
  private readonly reservationTtlMs: number;
  private readonly trustedProxy: boolean | number | string;
  private readonly now: () => number;
  private active = 0;

  constructor(options: SocketAdmissionOptions) {
    this.now = options.now ?? Date.now;
    this.maximumConnections = positiveInteger(
      "maximum Socket.IO connections",
      options.maxConnections,
    );
    this.maximumConnectionsPerIp = positiveInteger(
      "maximum Socket.IO connections per IP",
      options.maxConnectionsPerIp,
    );
    this.globalAttemptLimits = {
      eventsPerMinute: positiveInteger(
        "Socket.IO global connection attempts",
        options.connectionAttemptsPerMinute,
      ),
      bytesPerMinute: 1,
    };
    this.ipAttemptLimits = {
      eventsPerMinute: positiveInteger(
        "Socket.IO IP connection attempts",
        options.connectionAttemptsPerIpPerMinute,
      ),
      bytesPerMinute: 1,
    };
    const now = this.now();
    this.globalAttempts = new TrafficBucket(now);
    this.ipAttempts = new BoundedTrafficScopes(
      positiveInteger("Socket.IO admission IP scopes", options.maxIpScopes),
      Math.max(
        RATE_WINDOW_MS,
        positiveInteger("Socket.IO admission scope idle time", options.scopeIdleMs),
      ),
      this.now,
    );
    this.reservationTtlMs = positiveInteger(
      "Socket.IO admission reservation TTL",
      options.reservationTtlMs ?? 10_000,
    );
    this.trustedProxy = options.trustedProxy ?? false;
  }

  reserve(request: IncomingMessage): boolean {
    if (this.reservations.has(request)) return false;
    const sourceIp = socketSourceIp(
      request.socket.remoteAddress,
      request.headers,
      this.trustedProxy,
    );
    const now = this.now();
    const globalAttempt = this.globalAttempts.consume(this.globalAttemptLimits, 0, now);
    const ipAttempt = this.ipAttempts.consume(sourceIp, this.ipAttemptLimits, 0, now);
    if (!globalAttempt.allowed || !ipAttempt.allowed) return false;
    if (
      this.active >= this.maximumConnections
      || (this.activeByIp.get(sourceIp) ?? 0) >= this.maximumConnectionsPerIp
    ) {
      return false;
    }
    this.active += 1;
    this.activeByIp.set(sourceIp, (this.activeByIp.get(sourceIp) ?? 0) + 1);
    const timer = setTimeout(() => this.release(request), this.reservationTtlMs);
    timer.unref();
    this.reservations.set(request, {
      sourceIp,
      activated: false,
      released: false,
      timer,
    });
    return true;
  }

  activate(request: IncomingMessage): (() => void) | undefined {
    const reservation = this.reservations.get(request);
    if (!reservation || reservation.activated || reservation.released) return undefined;
    reservation.activated = true;
    clearTimeout(reservation.timer);
    return () => this.release(request);
  }

  counts(): { total: number; byIp: ReadonlyMap<string, number> } {
    return { total: this.active, byIp: new Map(this.activeByIp) };
  }

  private release(request: IncomingMessage): void {
    const reservation = this.reservations.get(request);
    if (!reservation || reservation.released) return;
    reservation.released = true;
    clearTimeout(reservation.timer);
    this.reservations.delete(request);
    this.active = Math.max(0, this.active - 1);
    const remaining = (this.activeByIp.get(reservation.sourceIp) ?? 1) - 1;
    if (remaining <= 0) this.activeByIp.delete(reservation.sourceIp);
    else this.activeByIp.set(reservation.sourceIp, remaining);
  }
}

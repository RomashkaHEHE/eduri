import type { IncomingMessage } from "node:http";
import { describe, expect, it } from "vitest";
import {
  SocketAdmissionController,
  SocketIngressGuard,
  boundedSocketPacketBytes,
  socketSourceIp,
  type SocketIngressGuardOptions,
} from "./socketAbuse.js";

function guardOptions(
  now: () => number,
  overrides: Partial<SocketIngressGuardOptions> = {},
): SocketIngressGuardOptions {
  return {
    global: { eventsPerMinute: 100, bytesPerMinute: 1_000_000 },
    ip: { eventsPerMinute: 100, bytesPerMinute: 1_000_000 },
    maxIpScopes: 10,
    maxPrincipalScopes: 10,
    scopeIdleMs: 60_000,
    now,
    ...overrides,
  };
}

function requestFrom(sourceIp: string): IncomingMessage {
  return {
    socket: { remoteAddress: sourceIp },
    headers: {},
  } as IncomingMessage;
}

describe("Socket.IO pre-validation byte accounting", () => {
  it("counts UTF-8, JSON escapes, binary attachments, and malformed near-5 MiB strings", () => {
    expect(boundedSocketPacketBytes(["event", "a\"\n"], 1_000)).toBe(81);
    expect(boundedSocketPacketBytes(["binary", Uint8Array.of(1, 2, 3)], 1_000))
      .toBeGreaterThanOrEqual(13);
    const loneSurrogatePacket = ["event", "\ud800"];
    expect(boundedSocketPacketBytes(loneSurrogatePacket, 1_000))
      .toBeGreaterThanOrEqual(Buffer.byteLength(JSON.stringify(loneSurrogatePacket)));
    expect(boundedSocketPacketBytes(["event", undefined], 1_000)).toBe(78);
    const malformed = "x".repeat(5 * 1024 * 1024 - 8 * 1024);
    expect(boundedSocketPacketBytes(["event", malformed], 4 * 1024 * 1024))
      .toBe(4 * 1024 * 1024 + 1);
  });

  it("fails closed on cyclic, excessively deep, or excessively wide packets", () => {
    const cyclic: unknown[] = [];
    cyclic.push(cyclic);
    expect(boundedSocketPacketBytes(["event", cyclic], 10_000)).toBe(10_001);
    let deep: unknown = "leaf";
    for (let index = 0; index < 70; index += 1) deep = [deep];
    expect(boundedSocketPacketBytes(["event", deep], 10_000)).toBe(10_001);
    const wide = new Array<unknown>(100_001).fill(null);
    expect(boundedSocketPacketBytes(["event", wide], 1_000_000)).toBe(1_000_001);
  });
});

describe("stable composite Socket.IO ingress budgets", () => {
  it("shares a principal budget across IPs/reconnects and resets only after the window", () => {
    let now = 1_000;
    const guard = new SocketIngressGuard(guardOptions(() => now));
    const principal = { eventsPerMinute: 1, bytesPerMinute: 1_000 };
    expect(guard.consume("192.0.2.1", "user:one", principal, ["event", "one"]).allowed)
      .toBe(true);
    expect(guard.consume("192.0.2.2", "user:one", principal, ["event", "two"]).allowed)
      .toBe(false);
    now += 60_000;
    expect(guard.consume("192.0.2.3", "user:one", principal, ["event", "three"]).allowed)
      .toBe(true);
  });

  it("shares an IP budget across principals and a global budget across all scopes", () => {
    let now = 1_000;
    const ipGuard = new SocketIngressGuard(guardOptions(() => now, {
      ip: { eventsPerMinute: 1, bytesPerMinute: 1_000_000 },
    }));
    const principal = { eventsPerMinute: 10, bytesPerMinute: 1_000 };
    expect(ipGuard.consume("192.0.2.1", "user:one", principal, ["event", 1]).allowed)
      .toBe(true);
    expect(ipGuard.consume("192.0.2.1", "user:two", principal, ["event", 2]).allowed)
      .toBe(false);

    const globalGuard = new SocketIngressGuard(guardOptions(() => now, {
      global: { eventsPerMinute: 2, bytesPerMinute: 1_000_000 },
    }));
    expect(globalGuard.consume("192.0.2.1", "user:one", principal, ["event", 1]).allowed)
      .toBe(true);
    expect(globalGuard.consume("192.0.2.2", "user:two", principal, ["event", 2]).allowed)
      .toBe(true);
    expect(globalGuard.consume("192.0.2.3", "user:three", principal, ["event", 3]).allowed)
      .toBe(false);
  });

  it("charges unauthenticated namespace packets to stable IP and global scopes", () => {
    let now = 1_000;
    const guard = new SocketIngressGuard(guardOptions(() => now, {
      global: { eventsPerMinute: 2, bytesPerMinute: 1_000_000 },
      ip: { eventsPerMinute: 1, bytesPerMinute: 1_000_000 },
    }));
    expect(guard.consumeUnattributed("192.0.2.1", ["connect", { auth: 1 }]).allowed)
      .toBe(true);
    expect(guard.consumeUnattributed("192.0.2.1", ["connect", { auth: 2 }]).allowed)
      .toBe(false);
    expect(guard.consumeUnattributed("192.0.2.2", ["connect", { auth: 3 }]).allowed)
      .toBe(false);
    now += 60_000;
    expect(guard.consumeUnattributed("192.0.2.2", ["connect", { auth: 4 }]).allowed)
      .toBe(true);
  });

  it("bounds scope registries and reclaims only idle entries", () => {
    let now = 1_000;
    const guard = new SocketIngressGuard(guardOptions(() => now, {
      maxIpScopes: 1,
      maxPrincipalScopes: 1,
    }));
    const principal = { eventsPerMinute: 10, bytesPerMinute: 1_000 };
    expect(guard.consume("192.0.2.1", "user:one", principal, ["event"]).allowed)
      .toBe(true);
    expect(guard.consume("192.0.2.2", "user:two", principal, ["event"]).allowed)
      .toBe(false);
    now += 60_000;
    expect(guard.consume("192.0.2.2", "user:two", principal, ["event"]).allowed)
      .toBe(true);
  });

  it("contains a structurally rejected packet to its stable abuse scope", () => {
    let now = 1_000;
    const guard = new SocketIngressGuard(guardOptions(() => now, {
      global: { eventsPerMinute: 100, bytesPerMinute: 100 * 1024 * 1024 },
      ip: { eventsPerMinute: 100, bytesPerMinute: 100 * 1024 * 1024 },
    }));
    const principal = { eventsPerMinute: 100, bytesPerMinute: 10 * 1024 * 1024 };
    const wide = new Array<unknown>(100_001).fill(null);

    expect(guard.consume("192.0.2.1", "user:one", principal, ["event", wide]))
      .toMatchObject({ allowed: false, retryAfterMs: 60_000 });
    // The malformed packet holds the offending stable principal window, but
    // does not turn its structural sentinel into a process-global outage.
    expect(guard.consume("192.0.2.2", "user:one", principal, ["event"]).allowed)
      .toBe(false);
    expect(guard.consume("192.0.2.1", "user:two", principal, ["event"]).allowed)
      .toBe(true);

    now += 60_000;
    expect(guard.consume("192.0.2.3", "user:one", principal, ["event"]).allowed)
      .toBe(true);
  });

  it("holds an unattributed structural violation to its trusted IP window", () => {
    const guard = new SocketIngressGuard(guardOptions(() => 1_000, {
      global: { eventsPerMinute: 100, bytesPerMinute: 100 * 1024 * 1024 },
      ip: { eventsPerMinute: 100, bytesPerMinute: 10 * 1024 * 1024 },
    }));
    const wide = new Array<unknown>(100_001).fill(null);
    expect(guard.consumeUnattributed("192.0.2.1", ["connect", wide]).allowed)
      .toBe(false);
    expect(guard.consumeUnattributed("192.0.2.1", ["connect"]).allowed)
      .toBe(false);
    expect(guard.consumeUnattributed("192.0.2.2", ["connect"]).allowed)
      .toBe(true);
  });
});

describe("Socket.IO connection admission", () => {
  it("enforces total/per-IP caps and releases capacity exactly once", () => {
    const admission = new SocketAdmissionController({
      maxConnections: 2,
      maxConnectionsPerIp: 1,
      connectionAttemptsPerMinute: 100,
      connectionAttemptsPerIpPerMinute: 100,
      maxIpScopes: 10,
      scopeIdleMs: 60_000,
      reservationTtlMs: 10_000,
    });
    const first = requestFrom("192.0.2.1");
    const sameIp = requestFrom("192.0.2.1");
    const second = requestFrom("192.0.2.2");
    const overflow = requestFrom("192.0.2.3");
    expect(admission.reserve(first)).toBe(true);
    expect(admission.reserve(first)).toBe(false);
    expect(admission.counts().total).toBe(1);
    expect(admission.reserve(sameIp)).toBe(false);
    expect(admission.reserve(second)).toBe(true);
    expect(admission.reserve(overflow)).toBe(false);
    expect(admission.counts().total).toBe(2);

    const releaseFirst = admission.activate(first)!;
    expect(admission.activate(first)).toBeUndefined();
    releaseFirst();
    releaseFirst();
    expect(admission.counts().total).toBe(1);
    expect(admission.reserve(overflow)).toBe(true);
    admission.activate(second)!();
    admission.activate(overflow)!();
    expect(admission.counts().total).toBe(0);
  });

  it("does not reset per-IP connection-attempt budgets on disconnect", () => {
    let now = 1_000;
    const admission = new SocketAdmissionController({
      maxConnections: 10,
      maxConnectionsPerIp: 10,
      connectionAttemptsPerMinute: 100,
      connectionAttemptsPerIpPerMinute: 2,
      maxIpScopes: 10,
      scopeIdleMs: 60_000,
      reservationTtlMs: 10_000,
      now: () => now,
    });
    for (let index = 0; index < 2; index += 1) {
      const request = requestFrom("192.0.2.1");
      expect(admission.reserve(request)).toBe(true);
      admission.activate(request)!();
    }
    expect(admission.reserve(requestFrom("192.0.2.1"))).toBe(false);
    now += 60_000;
    const afterWindow = requestFrom("192.0.2.1");
    expect(admission.reserve(afterWindow)).toBe(true);
    admission.activate(afterWindow)!();
  });

  it("bounds admission IP accounting and reclaims an idle scope", () => {
    let now = 1_000;
    const admission = new SocketAdmissionController({
      maxConnections: 10,
      maxConnectionsPerIp: 10,
      connectionAttemptsPerMinute: 100,
      connectionAttemptsPerIpPerMinute: 100,
      maxIpScopes: 1,
      scopeIdleMs: 60_000,
      reservationTtlMs: 10_000,
      now: () => now,
    });
    const first = requestFrom("192.0.2.1");
    expect(admission.reserve(first)).toBe(true);
    admission.activate(first)!();
    expect(admission.reserve(requestFrom("192.0.2.2"))).toBe(false);
    now += 60_000;
    const reclaimed = requestFrom("192.0.2.2");
    expect(admission.reserve(reclaimed)).toBe(true);
    admission.activate(reclaimed)!();
  });

  it("releases an abandoned pending handshake reservation", async () => {
    const admission = new SocketAdmissionController({
      maxConnections: 1,
      maxConnectionsPerIp: 1,
      connectionAttemptsPerMinute: 100,
      connectionAttemptsPerIpPerMinute: 100,
      maxIpScopes: 10,
      scopeIdleMs: 60_000,
      reservationTtlMs: 5,
    });
    expect(admission.reserve(requestFrom("192.0.2.1"))).toBe(true);
    expect(admission.counts().total).toBe(1);
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    expect(admission.counts().total).toBe(0);
  });

  it("trusts X-Real-IP only from the exact configured reverse-proxy peer", () => {
    expect(socketSourceIp(
      "10.253.0.1",
      { "x-real-ip": "198.51.100.4" },
      "10.253.0.1",
    ))
      .toBe("198.51.100.4");
    expect(socketSourceIp(
      "203.0.113.7",
      { "x-real-ip": "198.51.100.4" },
      "10.253.0.1",
    ))
      .toBe("203.0.113.7");
    expect(socketSourceIp(
      "::ffff:10.253.0.1",
      { "x-real-ip": "not-an-ip" },
      "10.253.0.1",
    ))
      .toBe("10.253.0.1");
    expect(socketSourceIp("127.0.0.1", { "x-real-ip": "198.51.100.4" }))
      .toBe("127.0.0.1");
  });
});
